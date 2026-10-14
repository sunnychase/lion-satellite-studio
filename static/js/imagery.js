// Created by Sunny Chase (https://github.com/sunnychase) in collaboration with Claude (Anthropic).
// Lion Satellite Studio — imagery: NASA GIBS (WMTS/WMS, EPSG:4326 "best"), EOX Sentinel-2 cloudless
// high-resolution backdrop, AWS Terrain Tiles (Terrarium) terrain, Natural Earth borders.
import { App, $, el, getJSON, chip, tick, ymd, fmtAgo, store, toast, requestRender, FAMILY } from './util.js';

const C = window.Cesium;
const GIBS_WMTS = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best';
const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
// highest zoom level of each GIBS EPSG:4326 TileMatrixSet (from GetCapabilities: level 0 = 2x1 tiles, 512 px, 288 deg)
const TMS_MAX = { '16km': 2, '8km': 3, '4km': 4, '2km': 5, '1km': 6, '500m': 7, '250m': 8, '31.25m': 11, '15.625m': 12 };
const EOX_YEAR = 2025;
const EOX_URL = `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${EOX_YEAR}/default/WGS84/{z}/{y}/{x}.jpg`;
const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const CREDITS = {
  gibs: 'Imagery: NASA GIBS / EOSDIS',
  eox: `EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data ${EOX_YEAR})`,
  terrain: 'Terrain: Mapzen / AWS Terrain Tiles (USGS SRTM, GMTED2010, 3DEP; NOAA ETOPO1; and others)',
  ne: 'Borders: Natural Earth',
};
export const REGIONS = {
  goes_east: { lon: -75.2, lat: 4, h: 2.15e7, label: 'Americas (GOES-East, 75.2°W)' },
  goes_west: { lon: -137, lat: 12, h: 2.15e7, label: 'Pacific / West Coast (GOES-West, 137°W)' },
  himawari: { lon: 140.7, lat: 6, h: 2.15e7, label: 'East Asia / West Pacific (Himawari, 140.7°E)' },
  tempo: { lon: -96, lat: 38, h: 8.5e6, label: 'North America (TEMPO field of regard)' },
};

const S = App.layers = {
  catalog: [], byId: {}, ok: false,
  date: null,               // YYYY-MM-DD picked for daily layers
  base: store.get('base', 'BlueMarble_ShadedRelief_Bathymetry'),
  science: null, scienceOpacity: 0.85,
  nrt: null, nrtTimes: [], nrtIdx: -1, nrtAuto: true,
  overlays: new Set(store.get('overlays', ['Reference_Labels', 'VIIRS_Black_Marble', 'borders'])),
  firesDay: false, firesToday: false,
  hires: store.get('hires', true),
  terrain: store.get('terrain', true), exaggeration: store.get('exag', 1.5),
  lighting: store.get('lighting', true),
  il: {},                    // live ImageryLayer objects by slot
};
let gibsScheme = null;
let bordersDS = null;
let nrtTimer = null;

function scheme() {
  // GIBS EPSG:4326 matrices start at the top-left (-180, 90) with 512 px tiles spanning 288 deg at
  // level 0 (2x1). That is a geographic scheme over a 576 x 288 deg extent.
  if (!gibsScheme) gibsScheme = new C.GeographicTilingScheme({
    rectangle: C.Rectangle.fromDegrees(-180, -198, 396, 90), numberOfLevelZeroTilesX: 2, numberOfLevelZeroTilesY: 1,
  });
  return gibsScheme;
}

export function latestDaily(L) {
  if (!L) return null;
  if (L.time === 'fixed') return L.fixed;
  if (L.time !== 'daily') return null;
  const yesterday = ymd(new Date(Date.now() - 86400e3));
  const latest = L.latest && L.latest.length >= 10 ? L.latest.slice(0, 10) : yesterday;
  return latest;
}
// date actually used for a daily layer: the picked date, clamped to what the layer has
export function layerDate(L) {
  if (!L) return null;
  if (L.time === 'fixed') return L.fixed;
  if (L.time !== 'daily') return null;
  const latest = latestDaily(L);
  if (!S.date) return latest;
  return S.date > latest ? latest : S.date;
}

export const tileErrors = { n: 0 };
function quiet(p) { p.errorEvent.addEventListener(() => { tileErrors.n++; }); return p; } // missing tiles are expected at disk edges; keep the console clean
function provider(L, time) { return quiet(rawProvider(L, time)); }
function rawProvider(L, time) {
  const credit = new C.Credit(CREDITS.gibs);
  if (L.service === 'wms') {
    return new C.WebMapServiceImageryProvider({
      url: GIBS_WMS, layers: L.wmsLayers || L.id, tileWidth: 256, tileHeight: 256, maximumLevel: 10,
      parameters: { transparent: 'true', format: 'image/png', time: time || undefined, version: '1.1.1' },
      tilingScheme: new C.GeographicTilingScheme(), credit,
    });
  }
  const ext = (L.format || '').includes('png') ? 'png' : 'jpeg';
  const seg = time ? `${time}/` : '';
  return new C.WebMapTileServiceImageryProvider({
    url: `${GIBS_WMTS}/${L.id}/default/${seg}{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.${ext}`,
    layer: L.id, style: 'default', format: L.format || 'image/jpeg', tileMatrixSetID: L.tms || '250m',
    tilingScheme: scheme(), rectangle: C.Rectangle.fromDegrees(-180, -90, 180, 90), // explicit: the scheme's 396 deg east edge would otherwise be wrapped to 36 deg
    tileWidth: 512, tileHeight: 512, maximumLevel: TMS_MAX[L.tms] ?? 5, credit,
  });
}

function terrainLevelCap(L) {
  // stop drawing a GIBS layer a little past its native resolution so the 10 m EOX
  // backdrop takes over instead of blurry upsampling
  const n = TMS_MAX[L.tms] ?? 6;
  return n + (S.terrain ? 2 : 1);
}

function place(slot, layer) {
  const v = App.viewer;
  const old = S.il[slot];
  S.il[slot] = layer;
  if (layer) v.imageryLayers.add(layer);
  orderLayers();
  if (old) setTimeout(() => { try { v.imageryLayers.remove(old, true); } catch (e) { /* gone */ } requestRender(); }, layer ? 900 : 0);
  requestRender();
}
export function raiseRefLayers() {
  const coll = App.viewer.imageryLayers;
  for (const slot of ['coast', 'features', 'labels']) { const l = S.il[slot]; if (l && coll.contains(l)) coll.raiseToTop(l); }
}
const ORDER = ['eox', 'base', 'science', 'nrt', 'clouds', 'firesDay', 'firesToday', 'night', 'coast', 'features', 'labels'];
function orderLayers() {
  const coll = App.viewer.imageryLayers;
  for (const slot of ORDER) {
    const l = S.il[slot];
    if (l && coll.contains(l)) coll.raiseToTop(l);
  }
}

// ---------------------------------------------------------------- slots
function setEox() {
  if (!S.hires) { place('eox', null); return; }
  const p = quiet(new C.UrlTemplateImageryProvider({
    url: EOX_URL, tilingScheme: new C.GeographicTilingScheme(), maximumLevel: 15, tileWidth: 256, tileHeight: 256,
    credit: new C.Credit(CREDITS.eox),
  }));
  const l = new C.ImageryLayer(p, { minimumTerrainLevel: 6 });
  place('eox', l);
}

function setBaseLayer() {
  const L = S.byId[S.base] || S.byId.BlueMarble_ShadedRelief_Bathymetry;
  if (!L || !L.available) return;
  const t = L.time === 'daily' ? layerDate(L) : (L.time === 'fixed' ? L.fixed : null);
  const l = new C.ImageryLayer(provider(L, t), { maximumTerrainLevel: S.hires ? terrainLevelCap(L) : undefined });
  place('base', l);
  chip('imagery', `${L.time === 'daily' ? t : 'static'} · ${short(L)}`, 'ok', L.title);
}
const short = L => L.title.split('·')[0].trim();

// Sun lighting darkens the night side. Data layers (near-real-time frames, science maps) are
// shown unlit so they stay readable; city lights need lighting (they use the night-side alpha).
export function applyLightingPolicy() {
  const g = App.viewer.scene.globe;
  const lit = S.lighting && !S.nrt && !S.science;
  g.enableLighting = lit;
  const nightOn = S.overlays.has('VIIRS_Black_Marble');
  // city lights are a globe-scale effect: hide them below ~2,500 km so close-ups never get a night tint
  if (S.il.night) S.il.night.show = lit && App.viewer.camera.positionCartographic.height > 2.5e6;
  App.scene.requestRender();
}
function setScienceLayer() {
  const L = S.science && S.byId[S.science];
  applyLightingPolicy();
  if (!L) { place('science', null); legend(); return; }
  if (L.time === 'subdaily') {
    loadTimes(L).then(times => {
      const t = times[times.length - 1];
      const l = new C.ImageryLayer(provider(L, t), { alpha: S.scienceOpacity });
      place('science', l);
      S.scienceTime = t;
      legend();
    }).catch(e => toast(`${L.title}: ${e.message}`));
    return;
  }
  const t = layerDate(L);
  const l = new C.ImageryLayer(provider(L, t), { alpha: S.scienceOpacity });
  if (L.family === 'night') { l.dayAlpha = 0.0; l.nightAlpha = 1.0; }
  place('science', l);
  S.scienceTime = t;
  legend();
}

async function loadTimes(L) {
  const { body } = await getJSON(`/api/gibs/times?layer=${encodeURIComponent(L.id)}`);
  return body.times || [];
}

function setNrtLayer(fromTimer = false) {
  const L = S.nrt && S.byId[S.nrt];
  clearInterval(nrtTimer);
  applyLightingPolicy();
  if (!L) { place('nrt', null); S.nrtTimes = []; legend(); chip('goes', '', 'hide'); return; }
  loadTimes(L).then(times => {
    S.nrtTimes = times;
    if (!times.length) { toast(`${L.title}: no frames in the last 26 h`); return; }
    if (S.nrtAuto || S.nrtIdx < 0 || S.nrtIdx >= times.length) S.nrtIdx = times.length - 1;
    showNrtFrame();
    const ageMin = (Date.now() - Date.parse(times[times.length - 1])) / 60000;
    tick('nrt', `${short(L)} frame ${times[times.length - 1].slice(11, 16)} UTC`, 'sat');
    chip('goes', `${short(L)} ${times[times.length - 1].slice(11, 16)}Z`, ageMin > 90 ? 'warn' : 'ok', 'newest frame time');
  }).catch(e => {
    chip('goes', 'unavailable', 'bad', e.message);
    toast(`Near-real-time times unavailable — retrying in 5 min`);
  });
  nrtTimer = setInterval(() => { if (S.nrt) setNrtLayer(true); }, 10 * 60 * 1000);
}

export function showNrtFrame() {
  const L = S.nrt && S.byId[S.nrt];
  if (!L || !S.nrtTimes.length) return;
  const t = S.nrtTimes[S.nrtIdx];
  const l = new C.ImageryLayer(provider(L, t), { alpha: 1.0 });
  place('nrt', l);
  legend();
  App.events.dispatchEvent(new Event('layers'));
}

function setOverlayLayers() {
  const want = S.overlays;
  // clouds (daily)
  const mk = (slot, id, opts = {}) => {
    const L = S.byId[id];
    if (!L || !L.available) { place(slot, null); return; }
    const t = L.time === 'none' ? null : layerDate(L);
    const l = new C.ImageryLayer(provider(L, t), opts.layer || {});
    if (opts.night) { l.dayAlpha = 0.0; l.nightAlpha = 1.0; l.brightness = 2.2; }
    place(slot, l);
  };
  want.has('MODIS_Terra_Cloud_Fraction_Day') ? mk('clouds', 'MODIS_Terra_Cloud_Fraction_Day', { layer: { alpha: 0.7 } }) : place('clouds', null);
  // 500 m city lights: shown at globe scale only, so close-ups switch to the sharp backdrop
  want.has('VIIRS_Black_Marble') ? mk('night', 'VIIRS_Black_Marble', { night: true, layer: { maximumTerrainLevel: 7 } }) : place('night', null);
  want.has('Coastlines') ? mk('coast', 'Coastlines') : place('coast', null);
  want.has('Reference_Features') ? mk('features', 'Reference_Features') : place('features', null);
  want.has('Reference_Labels') ? mk('labels', 'Reference_Labels') : place('labels', null);
  setBorders(want.has('borders'));
  setFires();
  applyLightingPolicy();
  store.set('overlays', [...want]);
}

function fireLayerDef(date) {
  const ids = ['VIIRS_SNPP_Thermal_Anomalies_375m_All', 'VIIRS_NOAA20_Thermal_Anomalies_375m_All',
    'VIIRS_NOAA21_Thermal_Anomalies_375m_All', 'MODIS_Combined_Thermal_Anomalies_All'].filter(i => S.byId[i] && S.byId[i].available);
  return { id: ids[0], wmsLayers: ids.join(','), service: 'wms', title: 'Fires', time: 'daily', ids, date };
}
let firesTimer = null;
function setFires() {
  if (S.overlays.has('fires')) {
    const L = S.byId.VIIRS_SNPP_Thermal_Anomalies_375m_All;
    const d = layerDate(L);
    place('firesDay', new C.ImageryLayer(provider(fireLayerDef(d), d)));
  } else place('firesDay', null);
  clearInterval(firesTimer);
  if (S.firesToday) {
    const today = ymd(new Date());
    place('firesToday', new C.ImageryLayer(provider(fireLayerDef(today), today)));
    tick('fires', `Fires today: VIIRS 375 m + MODIS detections for ${today} (refreshing every 10 min)`, 'fire');
    firesTimer = setInterval(() => {
      const d = ymd(new Date());
      place('firesToday', new C.ImageryLayer(provider(fireLayerDef(d), d)));
    }, 10 * 60 * 1000);
  } else place('firesToday', null);
}

async function setBorders(on) {
  const v = App.viewer;
  if (!on) { if (bordersDS) bordersDS.show = false; requestRender(); return; }
  if (bordersDS) { bordersDS.show = true; requestRender(); return; }
  try {
    const gj = await (await fetch('data/borders.geojson')).json();
    bordersDS = new C.CustomDataSource('borders');
    // one batched primitive keeps this cheap: ~390 lines
    const instances = [];
    for (const f of gj.features) {
      const g = f.geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      const disputed = /Disputed|Line of control|Indefinite|Indeterminant/.test(f.properties?.class || '');
      for (const ln of lines) {
        if (ln.length < 2) continue;
        instances.push(new C.GeometryInstance({
          geometry: new C.GroundPolylineGeometry({ positions: C.Cartesian3.fromDegreesArray(ln.flat()), width: disputed ? 1.0 : 1.4 }),
          attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(disputed ? C.Color.fromCssColorString('#d9b25f').withAlpha(0.45) : C.Color.fromCssColorString('#f1e6c8').withAlpha(0.55)) },
        }));
      }
    }
    const prim = new C.GroundPolylinePrimitive({ geometryInstances: instances, appearance: new C.PolylineColorAppearance(), asynchronous: true });
    bordersDS.primitive = v.scene.groundPrimitives.add(prim);
    Object.defineProperty(bordersDS, 'show', { get() { return prim.show; }, set(x) { prim.show = x; } });
    requestRender();
  } catch (e) { toast('Borders could not be loaded'); }
}

// ---------------------------------------------------------------- terrain
export function terrariumProvider() {
  const N = 65, MAXL = 12;
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = 256;
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  const flat = () => new Float32Array(N * N);
  const p = new C.CustomHeightmapTerrainProvider({
    width: N, height: N, tilingScheme: new C.WebMercatorTilingScheme(),
    credit: new C.Credit(CREDITS.terrain),
    callback: (x, y, level) => {
      if (level < 2 || level > MAXL) return flat();
      const url = TERRARIUM.replace('{z}', level).replace('{x}', x).replace('{y}', y);
      return fetch(url, { mode: 'cors' }).then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then(b => createImageBitmap(b)).then(bmp => {
          ctx.drawImage(bmp, 0, 0);
          bmp.close && bmp.close();
          const d = ctx.getImageData(0, 0, 256, 256).data;
          const out = new Float32Array(N * N);
          for (let j = 0; j < N; j++) {
            const py = Math.min(255, Math.round(j * 255 / (N - 1)));
            for (let i = 0; i < N; i++) {
              const px = Math.min(255, Math.round(i * 255 / (N - 1)));
              const k = (py * 256 + px) * 4;
              const h = d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768;
              out[j * N + i] = h > 0 ? h : 0; // sea surface stays at 0: no bathymetry pits under the oceans
            }
          }
          return out;
        }).catch(() => flat());
    },
  });
  p.getTileDataAvailable = (x, y, l) => l <= MAXL;
  return p;
}

export function applyTerrain() {
  const v = App.viewer;
  v.scene.terrainProvider = S.terrain ? terrariumProvider() : new C.EllipsoidTerrainProvider();
  v.scene.verticalExaggeration = S.terrain ? S.exaggeration : 1.0;
  store.set('terrain', S.terrain); store.set('exag', S.exaggeration);
  // re-cap GIBS layers for the terrain tiling
  setBaseLayer();
  requestRender();
}

// ---------------------------------------------------------------- legend card
export function legend() {
  const box = $('#legend');
  if (!box) return;
  const parts = [];
  const sci = S.science && S.byId[S.science];
  const nrt = S.nrt && S.byId[S.nrt];
  const L = nrt || sci;
  box.classList.toggle('hidden', !L);
  if (!L) { App.events.dispatchEvent(new Event('layers')); return; }
  const title = el('div', { class: 'lg-title' }, el('span', { class: 'dot', style: { background: nrt ? FAMILY.sat : FAMILY.gold } }), L.title);
  parts.push(title);
  let when = '';
  if (nrt && S.nrtTimes.length) when = `${S.nrtTimes[S.nrtIdx].replace('T', ' ').slice(0, 16)} UTC`;
  else if (L.time === 'subdaily') when = (S.scienceTime || '').replace('T', ' ').slice(0, 16) + ' UTC';
  else if (L.time !== 'none') when = layerDate(L);
  if (when) parts.push(el('div', { class: 'lg-when mono' }, when, S.date && layerDate(L) && S.date > layerDate(L) && !nrt ? ' (latest available)' : ''));
  if (L.legend) parts.push(el('img', { class: 'lg-img', src: L.legend, alt: `${L.title} colour scale`, loading: 'lazy' }));
  if (nrt && S.nrtTimes.length > 1) {
    const r = el('input', { type: 'range', min: 0, max: S.nrtTimes.length - 1, value: S.nrtIdx, class: 'range', 'aria-label': 'frame time' });
    r.addEventListener('input', () => { S.nrtIdx = +r.value; S.nrtAuto = S.nrtIdx === S.nrtTimes.length - 1; $('#lg-time').textContent = S.nrtTimes[S.nrtIdx].slice(11, 16) + ' UTC'; });
    r.addEventListener('change', () => showNrtFrame());
    parts.push(el('div', { class: 'lg-row' }, el('span', { class: 'mono muted' }, S.nrtTimes[0].slice(11, 16)), r, el('span', { class: 'mono', id: 'lg-time' }, S.nrtTimes[S.nrtIdx].slice(11, 16) + ' UTC')));
    parts.push(el('label', { class: 'chk small' }, el('input', { type: 'checkbox', checked: S.nrtAuto, onchange: e => { S.nrtAuto = e.target.checked; if (S.nrtAuto) { S.nrtIdx = S.nrtTimes.length - 1; showNrtFrame(); } } }), 'auto-advance to the newest frame (checks every 10 min)'));
  }
  if (sci && !nrt) {
    const r = el('input', { type: 'range', min: 0, max: 100, value: Math.round(S.scienceOpacity * 100), class: 'range', 'aria-label': 'opacity' });
    r.addEventListener('input', () => { S.scienceOpacity = r.value / 100; if (S.il.science) S.il.science.alpha = S.scienceOpacity; requestRender(); });
    parts.push(el('div', { class: 'lg-row' }, el('span', { class: 'muted small' }, 'opacity'), r));
  } else if (nrt) {
    const r = el('input', { type: 'range', min: 0, max: 100, value: Math.round((S.il.nrt?.alpha ?? 1) * 100), class: 'range', 'aria-label': 'opacity' });
    r.addEventListener('input', () => { if (S.il.nrt) S.il.nrt.alpha = r.value / 100; requestRender(); });
    parts.push(el('div', { class: 'lg-row' }, el('span', { class: 'muted small' }, 'opacity'), r));
  }
  box.replaceChildren(...parts);
  App.events.dispatchEvent(new Event('layers'));
}

// ---------------------------------------------------------------- public setters
export function setBase(id) { S.base = id; store.set('base', id); setBaseLayer(); hintGlobal(S.byId[id]); syncUI(); }
export function setScience(id) { S.science = id || null; setScienceLayer(); const L = S.byId[id]; if (L) hint(L); syncUI(); }
export function setNrt(id) { S.nrt = id || null; S.nrtAuto = true; S.nrtIdx = -1; setNrtLayer(); const L = S.byId[id]; if (L) hint(L); syncUI(); }
export function setOverlay(id, on) { on ? S.overlays.add(id) : S.overlays.delete(id); setOverlayLayers(); syncUI(); }
export function setFiresToday(on) { S.firesToday = !!on; setFires(); if (on) App.events.dispatchEvent(new CustomEvent('flyhint', { detail: { type: 'global', reason: 'Fires today' } })); syncUI(); }
export function setDate(d) {
  S.date = d || null;
  setBaseLayer(); if (S.science) setScienceLayer(); setOverlayLayers();
  syncUI();
}
export function setHires(on) { S.hires = !!on; store.set('hires', S.hires); setEox(); setBaseLayer(); syncUI(); }
export function setLighting(on) {
  S.lighting = !!on; store.set('lighting', S.lighting);
  const g = App.viewer.scene.globe;
  g.dynamicAtmosphereLighting = S.lighting;
  g.dynamicAtmosphereLightingFromSun = S.lighting;
  if (S.il && App.layers.catalog.length) applyLightingPolicy(); else g.enableLighting = S.lighting;
  requestRender(); syncUI();
}

function hint(L) {
  if (L.region && REGIONS[L.region]) {
    App.events.dispatchEvent(new CustomEvent('flyhint', { detail: { type: 'region', ...REGIONS[L.region], reason: L.title } }));
  } else hintGlobal(L);
}
function hintGlobal(L) {
  if (!L) return;
  App.events.dispatchEvent(new CustomEvent('flyhint', { detail: { type: 'global', daylight: !!L.truecolor || L.group === 'science', onlyIfGlobal: true, reason: L.title } }));
}

// ---------------------------------------------------------------- panel UI
let ui = {};
export function buildUI(sections) {
  const { imagery, nrt, science, overlays } = sections;
  // Base imagery
  const bases = S.catalog.filter(l => l.group === 'base');
  const dateIn = el('input', { type: 'date', class: 'input mono', max: ymd(new Date()), min: '2000-02-24', 'aria-label': 'imagery date' });
  dateIn.addEventListener('change', () => setDate(dateIn.value));
  const latestBtn = el('button', { class: 'btn ghost small', onclick: () => { dateIn.value = ''; setDate(null); } }, 'Latest');
  ui.date = dateIn;
  ui.baseList = el('div', { class: 'radio-list' }, bases.map(L => radio('base', L, () => setBase(L.id))));
  const hires = toggle('Hi-res backdrop when zoomed in (EOX Sentinel-2 cloudless 10 m)', S.hires, v => setHires(v));
  const terr = toggle('3D terrain (AWS Terrain Tiles)', S.terrain, v => { S.terrain = v; applyTerrain(); syncUI(); });
  const exag = el('input', { type: 'range', min: 1, max: 3, step: 0.1, value: S.exaggeration, class: 'range', 'aria-label': 'vertical exaggeration' });
  const exagVal = el('span', { class: 'mono small' }, `${S.exaggeration.toFixed(1)}×`);
  exag.addEventListener('input', () => { S.exaggeration = +exag.value; exagVal.textContent = `${S.exaggeration.toFixed(1)}×`; App.viewer.scene.verticalExaggeration = S.terrain ? S.exaggeration : 1; store.set('exag', S.exaggeration); requestRender(); });
  const light = toggle('Day/night lighting & atmosphere (data layers are shown unlit)', S.lighting, v => setLighting(v));
  imagery.replaceChildren(
    el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Date (UTC)'), dateIn, latestBtn),
    el('div', { class: 'hint' }, 'Daily layers default to their newest day; GIBS lags a few hours, so today is often partial.'),
    ui.baseList, hires, terr,
    el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Vertical exaggeration'), exag, exagVal), light,
  );
  // Near real time
  const nrts = S.catalog.filter(l => l.group === 'nrt');
  ui.nrtList = el('div', { class: 'radio-list' }, radioNone('nrt', 'Off', () => setNrt(null)), nrts.map(L => radio('nrt', L, () => setNrt(L.id))));
  ui.firesToday = toggle('Fires today — VIIRS 375 m (S-NPP, NOAA-20, NOAA-21) + MODIS, refresh every 10 min', S.firesToday, v => setFiresToday(v), 'fire');
  nrt.replaceChildren(el('div', { class: 'hint' }, 'Geostationary frames every 10 minutes (GIBS publishes them ~30–60 min after capture). Use the slider on the map to scrub the last 26 hours.'), ui.firesToday, ui.nrtList);
  // Science
  const sci = S.catalog.filter(l => l.group === 'science');
  ui.sciList = el('div', { class: 'radio-list' }, radioNone('sci', 'Off', () => setScience(null)), sci.map(L => radio('sci', L, () => setScience(L.id))));
  science.replaceChildren(el('div', { class: 'hint' }, 'One layer at a time, with its GIBS colour scale and an opacity slider on the map. Uses the imagery date.'), ui.sciList);
  // Overlays
  const ov = [
    ['VIIRS_Black_Marble', 'City lights on the night side (VIIRS Black Marble)', 'night'],
    ['fires', 'Active fires on the imagery date (VIIRS 375 m + MODIS)', 'fire'],
    ['MODIS_Terra_Cloud_Fraction_Day', 'Clouds (MODIS Terra cloud fraction)', 'cloud'],
    ['borders', 'Country borders (Natural Earth)', 'gold'],
    ['Coastlines', 'Coastlines (GIBS)', 'gold'],
    ['Reference_Labels', 'Place labels (GIBS)', 'gold'],
    ['Reference_Features', 'Roads & features (GIBS)', 'gold'],
  ];
  ui.ov = {};
  overlays.replaceChildren(...ov.map(([id, t, fam]) => {
    const L = S.byId[id];
    const disabled = id !== 'fires' && id !== 'borders' && (!L || !L.available);
    const tg = toggle(t + (disabled ? ' — unavailable' : ''), S.overlays.has(id), v => setOverlay(id, v), fam, disabled);
    ui.ov[id] = tg;
    return tg;
  }));
  syncUI();
}

function radio(name, L, onpick) {
  const id = `r-${name}-${L.id}`;
  const lab = el('label', { class: 'radio' + (L.available ? '' : ' disabled'), for: id, title: L.available ? L.id : `${L.id}: ${L.why || 'unavailable'}` },
    el('input', { type: 'radio', name, id, value: L.id, disabled: !L.available }),
    el('span', { class: 'r-t' }, L.title), el('span', { class: 'r-meta mono' }, L.time === 'subdaily' ? (L.latest ? 'sub-daily' : '') : L.time === 'daily' ? (latestDaily(L) || '') : L.time === 'fixed' ? L.fixed.slice(0, 4) : ''));
  lab.querySelector('input').addEventListener('change', onpick);
  return lab;
}
function radioNone(name, text, onpick) {
  const id = `r-${name}-none`;
  const lab = el('label', { class: 'radio', for: id }, el('input', { type: 'radio', name, id, value: '' }), el('span', { class: 'r-t' }, text));
  lab.querySelector('input').addEventListener('change', onpick);
  return lab;
}
export function toggle(text, on, onchange, fam = 'gold', disabled = false) {
  const inp = el('input', { type: 'checkbox', checked: on, disabled });
  inp.addEventListener('change', () => setTimeout(() => onchange(inp.checked), 0));
  return el('label', { class: 'switch' + (disabled ? ' disabled' : ''), 'data-fam': fam }, inp, el('span', { class: 'knob' }), el('span', { class: 'sw-t' }, text));
}

function syncUI() {
  const setR = (name, val) => document.querySelectorAll(`input[name="${name}"]`).forEach(i => { i.checked = (i.value || '') === (val || ''); i.closest('label')?.classList.toggle('active', i.checked && !!val); });
  setR('base', S.base); setR('nrt', S.nrt); setR('sci', S.science);
  if (ui.date) ui.date.value = S.date || '';
  for (const [id, tg] of Object.entries(ui.ov || {})) tg.querySelector('input').checked = S.overlays.has(id);
  if (ui.firesToday) ui.firesToday.querySelector('input').checked = S.firesToday;
  App.events.dispatchEvent(new Event('layers'));
}

export function activeSummary() {
  const out = [];
  const b = S.byId[S.base]; if (b) out.push(short(b));
  if (S.science && S.byId[S.science]) out.push(short(S.byId[S.science]));
  if (S.nrt && S.byId[S.nrt]) out.push(short(S.byId[S.nrt]));
  return out;
}

// ---------------------------------------------------------------- init
export async function initImagery(viewer) {
  viewer.camera.changed.addEventListener(() => { if (S.il.night) { const want = S.lighting && !S.nrt && !S.science && viewer.camera.positionCartographic.height > 2.5e6; if (S.il.night.show !== want) { S.il.night.show = want; requestRender(); } } });
  setLighting(S.lighting);
  setEox();
  try {
    const { body } = await getJSON('/api/gibs/layers');
    S.catalog = body.layers;
    for (const L of S.catalog) if (!S.byId[L.id]) S.byId[L.id] = L;
    S.ok = true;
    S.capsFetched = body.capabilities_fetched;
    const bad = S.catalog.filter(l => !l.available);
    if (bad.length) console.info('GIBS layers unavailable:', bad.map(b => `${b.id} (${b.why})`).join(', '));
  } catch (e) {
    S.ok = false;
    chip('imagery', 'GIBS catalogue unavailable', 'bad', e.message);
    // fall back to a known-good static base so the globe is never blank
    S.catalog = [{ id: 'BlueMarble_ShadedRelief_Bathymetry', group: 'base', title: 'Blue Marble · relief & bathymetry', time: 'none', tms: '500m', format: 'image/jpeg', available: true }];
    S.byId = { BlueMarble_ShadedRelief_Bathymetry: S.catalog[0] };
    S.base = 'BlueMarble_ShadedRelief_Bathymetry';
  }
  if (!S.byId[S.base] || !S.byId[S.base].available) S.base = 'BlueMarble_ShadedRelief_Bathymetry';
  setBaseLayer();
  setOverlayLayers();
  if (S.terrain) applyTerrain();
}
