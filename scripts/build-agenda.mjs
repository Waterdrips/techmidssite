// Builds agenda.json (and speaker thumbnails) from the source of conf.techmids.org.
// Usage: node scripts/build-agenda.mjs <path to techmids/conf.techmids.org checkout> <site dir>
//
// The conference site keeps its schedule in schedule.js and talk details in speakers.js
// (JSX). We bundle those two files with esbuild, using a tiny JSX factory that turns the
// markup into plain text paragraphs, then normalise everything into one JSON file that the
// picker page loads.
import { build } from "esbuild";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const [srcArg, outArg] = process.argv.slice(2);
if (!srcArg || !outArg) {
  console.error("Usage: node scripts/build-agenda.mjs <conf.techmids.org checkout> <site dir>");
  process.exit(1);
}
const SRC = path.resolve(srcArg);
const OUT = path.resolve(outArg);
const IMG_DIR = path.join(OUT, "img");

// ---------- 1. Load schedule.js + speakers.js ----------
const entry = `
  export { Schedule } from ${JSON.stringify(path.join(SRC, "schedule.js"))};
  export { Sessions } from ${JSON.stringify(path.join(SRC, "speakers.js"))};
  export { EVENT } from ${JSON.stringify(path.join(SRC, "event.js"))};
`;
// Images are imported as modules; we only want their file path.
const imagePlugin = {
  name: "image-path",
  setup(b) {
    b.onResolve({ filter: /\.(jpe?g|png|webp|gif|svg)$/i }, a => ({ path: path.resolve(a.resolveDir, a.path), namespace: "img" }));
    b.onLoad({ filter: /.*/, namespace: "img" }, a => ({ contents: `export default ${JSON.stringify(a.path)};`, loader: "js" }));
    // event.js imports from "schedule" (a jsconfig path alias).
    b.onResolve({ filter: /^schedule$/ }, () => ({ path: path.join(SRC, "schedule.js") }));
    // Anything else bare (react, next/*) is not needed to read the data.
    b.onResolve({ filter: /^[^./]/ }, a => (a.path === "schedule" ? undefined : { path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default {};", loader: "js" }));
  },
};
const bundled = await build({
  stdin: { contents: entry, resolveDir: SRC, loader: "js" },
  bundle: true, write: false, format: "esm", platform: "node",
  loader: { ".js": "jsx", ".jsx": "jsx" },
  jsxFactory: "__h", jsxFragment: "__F",
  banner: { js: "const __F = Symbol('fragment'); const __h = (t, p, ...c) => ({ t, p: p || {}, c });" },
  plugins: [imagePlugin], logLevel: "error",
});
const mod = await import("data:text/javascript;base64," + Buffer.from(bundled.outputFiles[0].text).toString("base64"));
const { Schedule, Sessions, EVENT } = mod;

// ---------- 2. Helpers ----------
const BLOCK = new Set(["p", "li", "div", "h1", "h2", "h3", "h4", "blockquote"]);
function toParagraphs(node) {
  const paras = []; let cur = "";
  const flush = () => { const s = cur.replace(/\s+/g, " ").trim(); if (s) paras.push(s); cur = ""; };
  (function walk(n) {
    if (n == null || n === false || n === true) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n === "string" || typeof n === "number") { cur += String(n); return; }
    if (typeof n === "object" && "c" in n) {
      if (n.t === "br") { cur += " "; return; }
      const block = BLOCK.has(n.t);
      if (block) flush();
      if (n.t === "li") cur += "• ";
      walk(n.c);
      if (block) flush();
    }
  })(node);
  flush();
  return paras;
}
// "09:45 AM", "13:00 PM", "12:00PM" -> "09:45" (24h; the site mostly writes 24h with a suffix).
function hhmm(t) {
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) throw new Error(`Unrecognised time: ${t}`);
  let h = Number(m[1]); const ap = (m[3] || "").toUpperCase();
  if (ap === "PM" && h < 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}
const slug = s => String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// "The Mailbox, 116 Commercial St" + "Mailbox, Birmingham" -> drop the repeated "Mailbox".
function dedupeParts(list) {
  const parts = [];
  for (const p of list.filter(Boolean).join(", ").split(",").map(x => x.trim()).filter(Boolean))
    if (!parts.some(q => q.toLowerCase().includes(p.toLowerCase()))) parts.push(p);
  return parts.join(", ");
}

// ---------- 3. Normalise ----------
const rooms = Object.entries(Schedule)
  .filter(([k]) => k !== "conferenceSchedule")
  .map(([, v]) => v.day1)
  .sort((a, b) => a.room.localeCompare(b.room, "en", { numeric: true }));

const speakers = {};
const imageJobs = [];
function speakerInfo(key) {
  const s = Sessions[key];
  if (!s) return { key, name: key };
  if (!speakers[key]) {
    const info = { key, name: s.name, role: s.jobTitle || "" };
    if (s.image && existsSync(s.image)) { info.img = `img/${key}.webp`; imageJobs.push([s.image, path.join(IMG_DIR, `${key}.webp`)]); }
    speakers[key] = info;
  }
  return speakers[key];
}

// An item with no speaker keys that is identical in every room (welcome, lunch, break) is a
// shared slot. Anything else (a sponsor keynote in one room) is a choosable talk.
const byTime = new Map();
for (const r of rooms) for (const ts of r.timeSlots) {
  const start = hhmm(ts.start), end = hhmm(ts.end), id = `${start}-${end}`;
  if (!byTime.has(id)) byTime.set(id, []);
  byTime.get(id).push({ r, ts, start, end });
}
const slotMap = new Map();
const fixed = new Map();
for (const [id, items] of byTime) {
  const shared = items.length === rooms.length && items.every(x => !(x.ts.session || []).length && x.ts.name === items[0].ts.name);
  if (shared) {
    const { ts, start, end } = items[0];
    fixed.set(id, { id, start, end, kind: "fixed", title: ts.name, note: ts.description || "" });
    continue;
  }
  for (const { r, ts, start, end } of items) {
    const keys = ts.session || [];
    const first = Sessions[keys[0]];
    const talk = {
      id: keys.length ? keys.join("+") : `${slug(ts.name)}-${slug(r.room)}-${start.replace(":", "")}`,
      room: r.room,
      title: keys.length ? (first?.talkTitle || ts.description || ts.name) : (ts.description || ts.name),
      speakers: keys.map(speakerInfo).map(s => s.key),
      by: keys.length ? "" : ts.name,
      abstract: keys.length ? toParagraphs(first?.description) : [],
      type: first?.sessionType || "Talk",
      url: keys.length ? `https://conf.techmids.org/speakers/${keys[0]}` : "",
    };
    if (!slotMap.has(id)) slotMap.set(id, { id, start, end, kind: "talks", talks: [] });
    slotMap.get(id).talks.push(talk);
  }
}

const overall = Schedule.conferenceSchedule?.day1?.timeSlots || [];
const reg = overall.find(s => /registration/i.test(s.name));
if (reg) { const start = hhmm(reg.start), end = hhmm(reg.end); fixed.set(`${start}-${end}`, { id: `${start}-${end}`, start, end, kind: "fixed", title: reg.name, note: reg.description || "" }); }

const slots = [...fixed.values(), ...slotMap.values()].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
for (const s of slots) if (s.talks) s.talks.sort((a, b) => a.room.localeCompare(b.room, "en", { numeric: true }));

const data = {
  event: {
    title: EVENT.edition || `${EVENT.title} ${EVENT.year}`,
    date: EVENT.isoDate,
    venue: EVENT.venue,
    address: dedupeParts([EVENT.streetAddress, EVENT.address, EVENT.postalCode]),
    start: hhmm(EVENT.startTime), end: hhmm(EVENT.endTime),
    timezone: "Europe/London",
    url: "https://conf.techmids.org",
  },
  rooms: rooms.map(r => r.room),
  speakers,
  slots,
};

// ---------- 4. Write ----------
await mkdir(IMG_DIR, { recursive: true });
for (const [from, to] of imageJobs) {
  await sharp(from).resize(160, 160, { fit: "cover", position: "attention" }).webp({ quality: 70 }).toFile(to);
}
// Remove thumbnails for speakers no longer on the agenda.
const keep = new Set(imageJobs.map(([, to]) => path.basename(to)));
for (const f of await readdir(IMG_DIR)) if (f.endsWith(".webp") && !keep.has(f)) await unlink(path.join(IMG_DIR, f));

// version only changes when the agenda content changes, so scheduled runs that find
// nothing new leave the file byte-for-byte identical (and the workflow commits nothing).
const out = path.join(OUT, "agenda.json");
const prevData = existsSync(out) ? JSON.parse(await readFile(out, "utf8")) : null;
data.version = createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 12);
data.generated = prevData && prevData.version === data.version ? prevData.generated : new Date().toISOString();
const json = JSON.stringify(data, null, 1) + "\n";
const prev = prevData ? await readFile(out, "utf8") : "";
await writeFile(out, json);

// Bump the service worker cache name so returning visitors pick up the new agenda.
const swPath = path.join(OUT, "sw.js");
if (existsSync(swPath)) {
  const sw = await readFile(swPath, "utf8");
  await writeFile(swPath, sw.replace(/const AGENDA_VERSION = "[^"]*";/, `const AGENDA_VERSION = "${data.version}";`));
}
const talks = slots.reduce((n, s) => n + (s.talks?.length || 0), 0);
console.log(`agenda.json: ${slots.length} slots, ${talks} talks, ${Object.keys(speakers).length} speakers, version ${data.version}${prev === json ? " (unchanged)" : ""}`);
