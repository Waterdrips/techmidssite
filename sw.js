// Offline support: keep the page, the agenda and speaker photos on the device.
// The build script rewrites AGENDA_VERSION whenever the agenda changes.
const AGENDA_VERSION = "e72982b83a5b";
const CACHE = `tmconf-${AGENDA_VERSION}`;
const CORE = ["./", "index.html", "agenda.json", "manifest.webmanifest", "icon.svg"];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    try {
      const agenda = await (await cache.match("agenda.json")).json();
      const imgs = Object.values(agenda.speakers || {}).map(s => s.img).filter(Boolean);
      await Promise.allSettled(imgs.map(u => cache.add(u)));
    } catch (e) {}
    self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("tmconf-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Network first (with a short timeout) for the page and agenda, so updates show up;
// cache first for everything else.
async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req, { cache: "no-cache" }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000)),
    ]);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(req, { ignoreSearch: true })) || (await cache.match("index.html")) || Response.error();
  }
}
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  const url = new URL(req.url);
  const fresh = req.mode === "navigate" || url.pathname.endsWith("/agenda.json") || url.pathname.endsWith("/index.html");
  event.respondWith(fresh ? networkFirst(req) : cacheFirst(req));
});
