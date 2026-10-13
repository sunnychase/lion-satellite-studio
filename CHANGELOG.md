# Changelog

Updates to Lion Satellite Studio, newest first. The project has no version numbers; each entry is dated.

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
- Repository: README with the satellites table generated from the app's data (`scripts/gen_satellites_table.py`), screenshots,
  NOTICE, CONTRIBUTING, SECURITY, AGENTS, issue forms, pull-request template, CI running `scripts/check.sh`.
