# TechMids Conf talk picker

A mobile-first page for TechMids Conf 2026 attendees: pick one talk per slot and get your own itinerary for the day.

- **Pick talks**: every slot with its three screens, speaker photo, and the talk abstract.
- **My day**: your itinerary with room-change callouts, plus a live NOW / NEXT banner on the day (Europe/London time).
- Picks are saved in `localStorage` on your device only. "Share my picks" makes a link (`#picks=...`) someone else can load.
- Works offline after the first visit (service worker caches the page, agenda and photos), for patchy venue Wi-Fi.
- If a talk is removed or moved on the main site, anyone who picked it gets a notice next time the agenda refreshes.

## Where the agenda comes from

The content comes from the source of [conf.techmids.org](https://conf.techmids.org): `schedule.js` and `speakers.js` in [techmids/conf.techmids.org](https://github.com/techmids/conf.techmids.org).

`scripts/build-agenda.mjs` bundles those files with esbuild, flattens them into `agenda.json`, and makes small speaker thumbnails in `img/`. The **Update agenda** workflow runs it hourly (and on demand from the Actions tab) and commits only when something changed, so GitHub Pages redeploys with the new agenda.

Why not fetch conf.techmids.org from the browser? It would work (GitHub Pages sends `Access-Control-Allow-Origin: *`), but every phone would then have to parse the conference site's rendered HTML, which breaks the moment its layout changes, and it would not have the abstracts without fetching 22 more pages. Building one small JSON file keeps the page fast and easy to cache offline.

## Run it locally

```sh
npm ci
git clone --depth 1 https://github.com/techmids/conf.techmids.org .conf-src
npm run build    # writes agenda.json, img/, and bumps the cache version in sw.js
npm run serve    # http://localhost:8080
```

## Hosting

GitHub Pages, deploying from the `main` branch root. `.nojekyll` keeps files served as-is.
