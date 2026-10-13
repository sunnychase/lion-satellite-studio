# Notes for coding agents

Guidance for AI coding agents (and people) changing this repository. Read [CONTRIBUTING.md](CONTRIBUTING.md) too.

## What this is

A 3D globe of open satellite data: a static page (CesiumJS + ES modules) and one small Python server that serves it and
fetches, caches and validates every upstream source. An optional worker analyses Sentinel-1 radar. See
[How it works](README.md#how-it-works).

## Layout

| path | what it is |
|---|---|
| `server.py` | the whole server: settings (`LSS_*`), keys file, disk cache, one section per upstream, the HTTP handler; standard library only |
| `analysis.py` | the radar worker (numpy, scipy, rasterio, pystac, planetary-computer); started by the server as a niced subprocess, one job at a time, results as files |
| `static/index.html`, `static/css/app.css` | the page shell and styles |
| `static/js/app.js` | viewer, camera, HUD, panel, search, tours, share, capture, About |
| `static/js/sats.js`, `satworker.js` | satellites: CelesTrak groups, SGP4 in a Web Worker, models, orbits, swaths, cards, passes |
| `static/js/imagery.js` | GIBS / EOX / terrain layers, near-real-time frames, legends |
| `static/js/data.js` | earthquakes, NISAR, SWOT, ships, Global Fishing Watch |
| `static/js/radar.js` | Sentinel-1: search, tiles, swipe, analysis UI |
| `static/js/point.js` | Point report: coordinate parsing, right-click / long-press, passes and swath test, data lookups, export |
| `static/js/util.js` | shared helpers and app state (`App`, exposed as `window.LE`) |
| `static/data/` | `missions.json` (sourced facts per satellite), `swot_features.json` (whitelist), gazetteer, borders |
| `static/models/` | NASA 3D models and `manifest.json` (credits, scale) |
| `static/vendor/` | CesiumJS and satellite.js, unmodified; do not edit |
| `data/` | Natural Earth land polygons for the ship detector |
| `scripts/` | `check.sh`, `precompress.py`, `setup_radar.sh`, `gen_satellites_table.py` |

## Rules

1. **Config indirection.** Ports, addresses and paths come from `LSS_*` variables (optionally `satellite.env`). Add a new key
   with a safe default and a commented line in `satellite.env.example`. Never hard-code a machine's values.
2. **Nothing machine-specific or personal** in code, comments, docs, screenshots or commit messages: no home-directory paths,
   host names, private addresses, user names, e-mail addresses or keys.
3. **The server stays standard-library only.** Anything that needs packages belongs in `analysis.py` (its own venv).
4. **Not an open proxy.** New upstreams get a fixed URL template, a whitelist or strict pattern for every browser parameter,
   a disk cache with a TTL that respects the provider's rules, an error back-off, and a `set_status` source name.
5. **Keys stay on the server**: read via `load_keys()`, never logged, never in a response; pass errors through `redact()`.
6. **Honest data.** Facts in `missions.json` need sources; analyses say "automatic estimate, not validated" and report their
   method and thresholds; attribution strings stay intact (About box, credits line, PNG capture).
7. **Match the existing style**: compact functions, short comments that say why, plain words in the UI. Element ids in
   `index.html` are used by the scripts; do not rename them casually.
8. **Document changes**: a dated [CHANGELOG.md](CHANGELOG.md) entry; README updates when behaviour, settings, data sources or
   requirements change; re-run `scripts/gen_satellites_table.py` after editing `missions.json`.

## Checks

```bash
bash scripts/check.sh      # py_compile, node --check on the modules, the README table, hygiene grep
```

CI runs the same script. Importing `server.py` creates the cache folder and the NISAR SQLite file under `LSS_CACHE_DIR`, so
point that at a throw-away folder when experimenting.

## Do not

- Commit `satellite.env`, `keys.env*`, `cache/`, `venv/`, `.gz` files or `__pycache__/`.
- Make the server listen beyond `127.0.0.1` by default, or send keys to the browser.
- Poll a provider more often than its rules allow, or remove a cache to "get fresher data".
- Start, stop or restart services, or download large data, as a side effect of a code change.
