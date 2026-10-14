# Changelog

Updates to Lion Satellite Studio, newest first. The project has no version numbers; each entry is dated.

## 2026-10-13 (video)

- The product video carries the repository link (github.com/sunnychase/lion-satellite-studio) in the lower-right corner for its whole length,
  not only on the end card.

## 2026-10-13 — Golden Gate gallery

- README: a *Golden Gate gallery* of seven app screenshots of the Golden Gate Bridge (37.8199, −122.4783), with date, sensor,
  resolution and the provider's credit under each: the Point report, Sentinel-2 L2A (2026-10-10) and Landsat 9 (2026-10-05) scenes in 3D,
  Sentinel-1 radar with a ships analysis over the strait, a NISAR GCOV footprint with its browse image, the Bay at golden hour, and the
  Point report on a phone.
- Fix: a NISAR browse image draped from the Point report is now credited in the attribution line at the bottom of the page (and in PNG captures).

## 2026-10-13 — Point report: what sees this spot?

- **New: Point report.** Type coordinates (decimal or degrees-minutes-seconds) or a place in the new *What sees this spot?* section or the
  search bar, right-click the globe (long-press on a phone) or use *My location*. The report lists the fleet satellites over the point now
  (elevation, *imaging now* when the point is inside the current swath), the next 24 h of passes with rise/set, maximum elevation and whether
  the point falls inside the instrument swath, NASA GIBS daily imagery at that pixel (read client-side), the newest Sentinel-1 RTC,
  Sentinel-2 L2A, Landsat C2 L2 and HLS scenes over the point, NISAR granules containing it, SWOT reaches within 10 km, earthquakes within
  300 km (7 days, M2.5+), AIS ships within 50 km (with a key) and the geostationary views with their view zenith angle. Every row flies to
  the item and turns its layer on; Copy report (Markdown), Download GeoJSON and a `#pt=lat,lon` share link. New Explore tour.
- **New endpoints** (fixed upstream URLs, validated lat −90..90 / lon −180..180, rounded to 4 dp, cached 1 h on disk, one new point per
  client every 3 s): `/api/point/stac` (Planetary Computer STAC point search, whitelisted collections), `/api/point/nisar` (ASF SearchAPI
  `intersectsWith=POINT`), `/api/point/swot` (NASA Earthdata GIS SWOT RiverSP reaches, 1–25 km), `/api/point/tile` (Planetary Computer
  tiler for Sentinel-2 / Landsat / HLS items: collection whitelist, item-id pattern per collection, z 8–16).
- MODIS Aqua true colour is a new base layer; the GIBS catalogue is fetched again when the layer whitelist changes.

## 2026-10-13 (review follow-ups)

- Requests that carry credentials (Global Fishing Watch) no longer follow HTTP redirects, so the token can never be re-sent to another host.
- CelesTrak errors back off for 2 hours, the same as successful fetches (CelesTrak blocks on request count).
- Server tracebacks go through the same key scrub as every other log line.
- `scripts/check.sh` also fails on e-mail addresses in first-party files.

## 2026-10-13 — First public release

- **The globe**: CesiumJS 1.146 without Cesium ion; the NASA/NOAA Earth fleet (21 satellites) or any CelesTrak group up to all
  ~16,700 active objects, propagated with SGP4 (satellite.js) in a Web Worker; NASA 3D models, orbits, sensor cones and swaths;
  passes over a place; time controls; search by satellite, NORAD id, place or river; share links and PNG capture with credits.
- **Imagery**: NASA GIBS base layers, overlays and Earth-science layers (ids checked against GetCapabilities at run time);
  GOES-East/West and Himawari frames every 10 minutes with a time slider; fires today; EOX Sentinel-2 cloudless backdrop
  when zoomed in; AWS terrain.
- **Events and products**: USGS earthquakes; NISAR footprints from ASF (hourly poll, polite backfill into SQLite) with browse
  images; SWOT river and lake heights for 44 curated places from PO.DAAC Hydrocron.
- **Sentinel-1 radar** from Microsoft Planetary Computer: scenes in view, VV/VH/false-colour tiles, before/after swipe, and an
  optional analysis worker (open water, change, bright targets at sea with CFAR, 12-month time series), every result marked
  "automatic estimate, not validated".
- **Optional keys**: live AIS ships (aisstream.io) over the server's own WebSocket client, and Global Fishing Watch SAR vessel
  detections, both off until you add a key to the keys file.
- **Server**: one standard-library Python file with fixed-URL cached proxies; every setting in `satellite.env`
  (`LSS_HOST` default `127.0.0.1`, `LSS_PORT`, `LSS_CACHE_DIR`, `LSS_DATA_DIR`, `LSS_KEYS_FILE`, `LSS_VENV_PYTHON`,
  `LSS_CONTACT`, `LSS_DISABLE_AIS`); a generic User-Agent `LionSatelliteStudio/1.0 (+repository URL)` with an optional contact.
- Created by Sunny Chase (https://github.com/sunnychase) in collaboration with Claude (Anthropic); credited in LICENSE, the
  code headers, the README, the page's About box and a small link at the bottom right of the page.
- **Product video** (`docs/media/lion-satellite-studio.mp4`, 81 s, 1080p30, H.264, silent) and an 8 s README preview loop
  (`docs/media/preview.webp`), rendered offline frame by frame from the app in headless Chromium.
- Repository: README with the satellites table generated from the app's data (`scripts/gen_satellites_table.py`), screenshots,
  NOTICE, CONTRIBUTING, SECURITY, AGENTS, issue forms, pull-request template, CI running `scripts/check.sh`.
