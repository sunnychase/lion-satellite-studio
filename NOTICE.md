# Third-party notices

The MIT licence in [LICENSE](LICENSE) covers the code written for this repository (`server.py`, `analysis.py`, `scripts/`,
and `static/` except `static/vendor/`, `static/fonts/` and `static/models/*.glb`). Everything below keeps its own terms.

## Included software and fonts

- **CesiumJS 1.146.0** (`static/vendor/cesium/`), Apache License 2.0, © 2011-2026 CesiumJS Contributors.
  [cesium.com/platform/cesiumjs](https://cesium.com/platform/cesiumjs/). Its licence and the notices of the third-party code it
  bundles are in `static/vendor/cesium/LICENSE.md` (the CesiumJS distribution has no separate NOTICE file; its LICENSE.md
  carries the third-party notices). The built files are redistributed unmodified from the npm package `cesium@1.146.0`
  (`VERSION.txt` records its checksum); the unused `index.js` / `index.cjs` bundles are left out. No Cesium ion services are used.
- **satellite.js 7.1.0** (`static/vendor/satellite/`), MIT, © 2013 Shashwat Kandadai, UCSC Jack Baskin School of Engineering.
  [github.com/shashwatak/satellite-js](https://github.com/shashwatak/satellite-js). Licence in `static/vendor/satellite/LICENSE.md`.
- **Inter** and **JetBrains Mono** fonts (`static/fonts/`), SIL Open Font License 1.1. Licences in
  `static/fonts/LICENSE-Inter-OFL.txt` and `static/fonts/LICENSE-JetBrainsMono-OFL.txt`.
- **Optional Python packages** for the radar worker (not included; installed by you): numpy, scipy, rasterio (with GDAL),
  pystac, pystac-client, planetary-computer, each under its own licence.

## Included data

- **Natural Earth** (public domain; "Made with Natural Earth", [naturalearthdata.com](https://www.naturalearthdata.com)):
  `data/ne_10m_land.geojson` and `data/ne_10m_minor_islands.geojson` (10 m land), `static/data/borders.geojson`
  (`ne_50m_admin_0_boundary_lines_land`), and the coordinates in `static/data/gazetteer.json` (from `ne_50m_admin_0_countries`
  and `ne_10m_populated_places_simple`; a few places added by hand; the largest-city tier marks agglomerations over 10 million
  in the UN World Urbanization Prospects 2018).
- `static/data/missions.json`: facts about each satellite, written for this project from the official pages listed in each
  entry's `sources` (NASA, NOAA/NESDIS/OSPO, USGS, NSSDCA, CNES, eoPortal).
- `static/data/swot_features.json`: 44 SWOT river reaches and lakes picked for this project; ids, names and centre lines from
  NASA's SWOT products (PO.DAAC Hydrocron and the SWOT RiverSP feature service; SWORD river database). NASA data, free and open.

## 3D models (NASA 3D Resources)

From [NASA 3D Resources](https://science.nasa.gov/3d-resources/): "All of these assets are free to download and use." Use
follows the [NASA Images and Media Usage Guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/): NASA content is
generally not subject to copyright in the United States; NASA should be acknowledged as the source; it may not be used to
state or imply NASA's endorsement; and the NASA insignia, logotype and seal are protected by law. Where a model shows an
agency emblem as it appears on the real spacecraft, it is part of that depiction only and implies no endorsement of this
project. Models were converted to GLB and trimmed (details in `static/models/manifest.json`).

| File | Model | Credit | Source |
|---|---|---|---|
| `iss.glb` | International Space Station (ISS) (B) | NASA/Michael D. Carbajal | [page](https://science.nasa.gov/3d-resources/international-space-station-iss-b/) |
| `terra.glb` | Terra | NASA/Christian A. Lopez | [page](https://science.nasa.gov/3d-resources/terra/) |
| `aqua.glb` | Aqua (C) | NASA/Christopher R. Meaney | [page](https://science.nasa.gov/3d-resources/aqua-c/) |
| `landsat8.glb`, `landsat9.glb` | Landsat 8 (also the stand-in for Landsat 9) | NASA/Christopher R. Meaney | [page](https://science.nasa.gov/3d-resources/landsat-8/) |
| `gpm.glb` | Global Precipitation Measurement | NASA/Christopher R. Meaney | [page](https://science.nasa.gov/3d-resources/global-precipitation-measurement/) |
| `icesat2.glb` | ICESat-2 (A) | NASA/Christopher R. Meaney | [page](https://science.nasa.gov/3d-resources/ice-clouds-and-land-elevation-satellite-2-icesat-2-a/) |
| `oco2.glb` | Orbiting Carbon Observatory (OCO-2) | NASA/Christopher R. Meaney | [page](https://science.nasa.gov/3d-resources/orbiting-carbon-observatory-oco-2/) |
| `goes.glb` | Geostationary Operational Environmental Satellites | NASA/Christopher R. Meaney | [page](https://science.nasa.gov/3d-resources/geostationary-operational-environmental-satellites/) |
| `jpss.glb` | Suomi NPP (also used for NOAA-20 and NOAA-21) | NASA/Brian E. Kumanchik; NASA/Christian A. Lopez | [page](https://science.nasa.gov/3d-resources/suomi-national-polar-orbiting-partnership-suomi-npp/) |
| `gracefo.glb` | GRACE (B) (stand-in for GRACE-FO) | NASA/Christopher M. Garcia | [page](https://science.nasa.gov/3d-resources/gravity-recovery-and-climate-experiment-grace-b/) |
| `generic.glb` | generic satellite (SMAP, SWOT, PACE, NISAR, Intelsat 40e) | made procedurally for this project; no third-party content | — |

## Data shown at run time (not included)

The app fetches data from CelesTrak, NASA GIBS/EOSDIS, USGS, ASF DAAC, PO.DAAC, Microsoft Planetary Computer (Copernicus
Sentinel-1, ESA WorldCover), EOX (EOxCloudless 2025, CC BY-NC-SA 4.0, non-commercial), AWS Terrain Tiles, and, with your own
keys, aisstream.io and Global Fishing Watch (CC BY-NC 4.0, non-commercial). Their terms and required attributions are listed
in the README's [Data sources and licences](README.md#data-sources-and-licences) and in the page's About box.

## Layout

- **README and repository-template layout** adapted from [morluto/rea](https://github.com/morluto/rea) (MIT): the structure
  only; the wording is this project's own.
