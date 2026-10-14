# Changelog

Updates to Lion Satellite Studio, newest first. The project has no version numbers; each entry is dated.

## 2026-10-14 — Smooth motion, sensor looks, FIRMS fires, next passes

Four ideas borrowed from [gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view) (Bilawal Sidhu and Sameh Khamis,
Halfpixel, MIT), written anew for this app; credited in NOTICE.md, the README and the About box.

- **Smooth motion + horizon culling** (`static/js/motion.js`). Satellites and AIS ships are dead-reckoned between data
  updates: satellites from the worker's position plus its new Earth-fixed velocity, ships along their last course at their
  last speed from the time of the fix, never more than one update interval past the newest data (ship fixes older than
  2 minutes are not extrapolated). One pass before a frame moves only what is in view, hides what is behind the Earth (once
  the camera rests: while it moves, the depth test hides them already), rewrites a point only once it has moved about half a
  pixel, and asks for frames only as often as the fastest visible object moves about a pixel. Writes are grouped so Cesium
  re-uploads a whole buffer once instead of hundreds of single points; ships are updated in place by MMSI and their
  billboards reused (no rebuild of the collection every 12 s). While a finger or mouse is down there are no passes, as
  before (the drag throttle); low-memory mode is unchanged.
- **Sensor looks** (`static/js/looks.js`): Normal / Night vision / Thermal (ironbow on brightness) / CRT / Noir, each a single
  cheap post-process shader with no lens warp, so picking is unchanged. Eye button in the top bar and a row under
  *Imagery & terrain*; off by default; kept in the browser.
- **NASA FIRMS active fires** (keyless): `/api/fires?limit=20000|60000|150000` merges FIRMS's public 24-hour VIIRS 375 m CSVs
  (Suomi NPP, NOAA-20, NOAA-21), each a fixed URL cached 45 min with a 40 MB cap, newest first; a satellite whose file fails
  is left out and named. The page draws them as one point collection built in slices (60,000 points, 20,000 on phones and
  in low-memory mode): colour = age, size = fire radiative power; tap for time, satellite, confidence, FRP, brightness and
  pixel size. New panel section *Active fires (FIRMS)*.
- **Next passes** in the Point report (`static/js/passworker.js`): rise / peak / set in your time zone and UTC, maximum
  elevation and *visible to the eye* (satellite sunlit, sun below −6° at the point) for up to 30 satellites over 24 or 48 h,
  computed with SGP4 in a Web Worker. The satellites come from a new derived group `/api/sats?group=passes` (the fleet plus
  Sentinel-1A/1C/1D, Sentinel-2A/2B/2C, Sentinel-3A/3B, Tiangong and Hubble, cut from the cached CelesTrak *active* list; no
  extra CelesTrak requests). The swath section is renamed *Imaging passes*; both are in the Markdown and GeoJSON exports.

**Measured** (GPU Chromium, 1600×900, ~16,700 satellites + live AIS ships, the same server and data for both versions;
render CPU per frame, mean / 95th percentile):

| view | before | after |
|---|---|---|
| whole globe, spinning | 6.8 / 8.4 ms, 56 fps | 6.8 / 8.8 ms, 57 fps |
| North Sea, 900 km | 5.6 / 6.9 ms, 55 fps | 6.0 / 7.3 ms, 59 fps |
| harbour, 40 km | 7.5 / 8.8 ms, 59 fps | 7.6 / 9.1 ms, 59 fps |
| main-thread update per satellite batch (North Sea / harbour) | 3.5 / 6.7 ms | 1.9 / 2.5 ms |
| render on demand, North Sea, nobody touching it | 2 frames/s | 15 frames/s (satellites in view glide) |

## 2026-10-13 — NAIP aerial photos up close (US)

- Below about 3 km over the United States (lower 48, Hawaii, Puerto Rico), the newest USDA NAIP aerial photograph under the
  centre of the view (~0.6 m) loads on top of the globe; the status bar shows *NAIP aerial · state · date* and the attribution
  line "USDA NAIP via Microsoft Planetary Computer". It is freed when the camera goes above about 4.5 km; outside the US the
  status bar says *no aerial here*. One photo at a time; on/off under *Imagery & terrain* (on by default).
- Server: `/api/naip?lat=&lon=` (newest item from Planetary Computer STAC, cached 1 h, US only, no upstream request elsewhere,
  one new lookup per client every 3 s); NAIP tiles (zoom 12–18) through the existing tile endpoint with Planetary Computer's
  NAIP render (`assets=image`, bands 1, 2, 3).
- Point report: a *NAIP aerial* list in the optical section (US points), with state, resolution and date; tapping one shows it.
- Fix: a Sentinel-2 / Landsat / HLS scene shown from the Point report, a NISAR browse image, and a radar analysis overlay could not
  be removed again (Cesium's `imageryLayers.add()` returns nothing, so the app kept `undefined` instead of the layer); *tap again
  to hide* and closing the card now remove them and free their tiles.
- README: a NAIP picture of the Golden Gate Bridge (acquired 2022-05-18), a data-source row and a caveat on the photo's age.

## 2026-10-13 — Performance, a panel that stays painted, address search

**Performance** (measured in GPU Chromium on a DGX Spark, phone emulation 390×844 with a 4× CPU slowdown, against the running
app with live AIS; a scripted 10-minute session: home → Explore tour → NISAR 7 days and "all" → ships → All active satellites →
Sentinel-1 radar → Point report → home, twice):

| | before | after |
|---|---|---|
| Ships on: longest main-thread task | 4,982 ms (16 s of long tasks) | 71 ms |
| All active satellites (~16,700) on top: longest task | 6,485 ms, then the page stopped responding to input for > 3 minutes | 148–160 ms |
| Rotate / zoom / hover with All active, phone emulation | not reachable (page hung) | 59 fps, 95th-percentile frame 20 ms |
| NISAR "all" (16,835 footprints): longest task | 101 ms | 87 ms (newest 6,000 drawn) |
| JS heap after warm-up, cycle 1 → cycle 2 | not reachable | 79.1 → 83.9 MB (+6 %) |
| Renderer memory with NISAR "all" on (desktop) | 1,108 MB, JS heap 43 MB | 866 MB, JS heap 34 MB |
| Console errors over the session | — | 0 |

- **The hang:** every ship billboard was given a canvas image, and Cesium files a canvas under a *new* atlas id every time, so
  each ship re-packed the texture atlas (quadratic `_findNode`) and the atlas grew on every 12 s refresh. Ship, dark-vessel and
  radar-detection symbols are now data-URL strings: one atlas entry per symbol.
- Ships reload once the camera has settled, not on every move; hover picking (a pick render pass) is skipped while the user drags
  or the camera moves; the 1 Hz satellite update waits while the user drags; the "All active" load is split across tasks.
- **Memory:** NISAR draws the newest 6,000 footprints (outlines for the newest 2,000) with coarser tessellation; smaller tile cache
  (160, phone 100) and a slightly larger terrain tile error (2.0).
- **Low-memory mode** (toggle in *Imagery & terrain*; switches on by itself after a graphics reset, when frames stay slow, or when
  the browser draws WebGL in software): 2,000 footprints and ships, no 3D models, no terrain or hi-res backdrop, a 60-tile cache,
  a lower resolution scale.
- **Graphics resets:** a lost WebGL context reloads the view in low-memory mode with a short note; a render error resumes the
  globe instead of leaving Cesium's error panel; a browser without WebGL gets a clear notice instead of an empty page.
- Remaining: the first 3D model on screen compiles its shaders once (about 0.65 s on the desktop run); the first Cesium start-up
  task is 226 ms with the 4× slowdown.

**A panel that stays painted:** in a desktop browser on a DGX Spark (Firefox), the left panel sometimes went blank
(an empty bordered box) after a switch was used. Its DOM, opacity and position were always intact and nothing covered it (checked
with elementFromPoint over all 70 controls), so the browser dropped the panel's painted content. The panel is now a plain layer:
no backdrop-filter blur, no transition, no rounded overflow clip over the scroller, no fade animation, no infinite glow animation,
no containment, a solid background; switch work starts in the next task; and the panel is repainted after every change. An open
tab offers *Reload* when the page files change on the server. The first-visit tips no longer cover the panel or block clicks.

**Tested in:** Chromium with GPU WebGL and WebKit, each at 1440×900 and 390×844, and Chromium with SwiftShader software WebGL
at 1440×900, clicking all 70 panel controls plus address search and the Point report: the panel stayed visible after every
click, with 0 console errors in Chromium.
A software-WebGL browser is detected (by its renderer name) and starts in low-memory mode with a one-line notice. Headless Firefox
on this machine has no WebGL at all; it gets the "no 3D graphics" notice with the panel still working.

**Address search:** type a street address, landmark or city in the search bar or the Point report box and press Enter. It goes
through the server to OpenStreetMap Nominatim within its usage policy (on Enter only, never autocomplete; at most one request per
second for the whole server; identifying User-Agent; 30-day cache keyed on the normalised query; "© OpenStreetMap contributors,
ODbL" with the results). Coordinates, degrees-minutes-seconds and the built-in gazetteer are tried first, locally. New settings
`LSS_GEOCODER` and `LSS_GEOCODER_URL`.

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
