// Created by Sunny Chase (https://github.com/sunnychase) in collaboration with Claude (Anthropic).
// Lion Satellite Studio — event and product layers: USGS earthquakes, NISAR footprints (ASF),
// SWOT water heights (PO.DAAC Hydrocron), ships (aisstream.io) and GFW SAR dark vessels.
import { App, $, el, getJSON, chip, tick, fmtAgo, fmtUTC, fmtNum, fmtBytes, store, toast, sparkline, drawSeries, requestRender, FAMILY, skeleton, emptyState } from './util.js';
import { toggle } from './imagery.js';

const C = window.Cesium;

// =================================================================== EARTHQUAKES
const Q = App.data.quakes = { on: store.get('quakes', true), feed: 'all_day', features: [], prim: null, timer: null, pulses: [], seenIds: new Set(store.get('quakeSeen', [])) };

function quakeColor(ageH, mag) {
  const a = Math.max(0.35, 1 - ageH / 48);
  return C.Color.fromCssColorString(FAMILY.quake).withAlpha(a);
}
async function loadQuakes() {
  const box = $('#quake-info');
  try {
    const { body, fetched } = await getJSON(`/api/quakes?feed=${Q.feed}`);
    Q.features = body.features || [];
    Q.fetched = fetched;
    drawQuakes();
    const upd = body.metadata && body.metadata.generated;
    const ageMs = Date.now() - (upd || Date.parse(fetched));
    chip('quake', `quakes ${fmtAgo(ageMs)} ago`, ageMs > 30 * 60e3 ? 'warn' : 'ok', `USGS feed generated ${fmtUTC(upd)}; server cache 5 min`);
    const strongest = [...Q.features].sort((a, b) => (b.properties.mag ?? -9) - (a.properties.mag ?? -9))[0];
    if (strongest) tick('quake', `M${strongest.properties.mag?.toFixed(1)} · ${strongest.properties.place || 'unknown place'} · ${fmtAgo(Date.now() - strongest.properties.time)} ago`, 'quake');
    if (box) renderQuakeInfo(box);
  } catch (e) {
    chip('quake', 'quakes unavailable', 'bad', e.message);
    if (box) emptyState(box, `USGS earthquake feed is unavailable right now (${e.message})`, 300);
  }
}
function drawQuakes() {
  const scene = App.scene;
  if (Q.prim) { scene.primitives.remove(Q.prim); Q.prim = null; }
  Q.pulses.forEach(p => App.viewer.entities.remove(p)); Q.pulses = [];
  if (!Q.on) { requestRender(); return; }
  Q.prim = scene.primitives.add(new C.PointPrimitiveCollection());
  const now = Date.now();
  const fresh = [];
  for (const f of Q.features) {
    const [lon, lat, depth] = f.geometry.coordinates;
    const mag = f.properties.mag ?? 0;
    const ageH = (now - f.properties.time) / 3600e3;
    Q.prim.add({
      position: C.Cartesian3.fromDegrees(lon, lat, 1500), pixelSize: Math.max(4, 3 + Math.max(0, mag) * 3.2),
      color: quakeColor(ageH, mag).withAlpha(0.55), outlineColor: C.Color.fromCssColorString('#ffd1d6').withAlpha(0.9), outlineWidth: 1.2,
      scaleByDistance: new C.NearFarScalar(1e6, 1.4, 3e7, 0.8), id: { kind: 'quake', id: f.id }, disableDepthTestDistance: 2e6,
    });
    if (ageH < 1 && !Q.seenIds.has(f.id)) fresh.push(f);
  }
  // pulse ring on quakes newer than one hour that this browser hasn't seen yet
  for (const f of fresh.slice(0, 6)) {
    const [lon, lat] = f.geometry.coordinates;
    const t0 = performance.now();
    const rad = new C.CallbackProperty(() => 20000 + ((performance.now() - t0) % 2000) / 2000 * 220000, false);
    const col = new C.CallbackProperty(() => C.Color.fromCssColorString(FAMILY.quake).withAlpha(0.6 * (1 - ((performance.now() - t0) % 2000) / 2000)), false);
    Q.pulses.push(App.viewer.entities.add({ position: C.Cartesian3.fromDegrees(lon, lat), ellipse: { semiMajorAxis: rad, semiMinorAxis: rad, material: new C.ColorMaterialProperty(col), height: 0 } }));
    Q.seenIds.add(f.id);
  }
  if (fresh.length) {
    App.pulse(8000);
    setTimeout(() => { Q.pulses.forEach(p => App.viewer.entities.remove(p)); Q.pulses = []; requestRender(); }, 8000);
    store.set('quakeSeen', [...Q.seenIds].slice(-400));
  }
  requestRender();
}
function renderQuakeInfo(box) {
  const now = Date.now();
  const hours = Array(24).fill(0);
  for (const f of Q.features) { const h = Math.floor((now - f.properties.time) / 3600e3); if (h >= 0 && h < 24) hours[23 - h]++; }
  const max = [...Q.features].sort((a, b) => (b.properties.mag ?? -9) - (a.properties.mag ?? -9))[0];
  box.replaceChildren(
    el('div', { class: 'stat-row' }, el('div', { class: 'stat' }, el('span', { class: 'big mono' }, fmtNum(Q.features.length)), el('span', { class: 'muted small' }, Q.feed === 'all_day' ? 'quakes, last 24 h (all M)' : 'M2.5+, last 7 days')),
      el('div', { class: 'stat' }, sparkline(hours, { bars: true, w: 120, h: 30, color: FAMILY.quake }), el('span', { class: 'muted small' }, 'per hour, last 24 h'))),
    max ? el('div', { class: 'small' }, 'Strongest: ', el('b', {}, `M${max.properties.mag?.toFixed(1)}`), ` · ${max.properties.place || ''} · ${fmtAgo(now - max.properties.time)} ago`) : '',
  );
}
export function quakeCard(card, id) {
  const f = Q.features.find(x => x.id === id);
  if (!f) { card.replaceChildren(el('div', { class: 'muted' }, 'This quake is no longer in the feed.')); return; }
  const p = f.properties, [lon, lat, depth] = f.geometry.coordinates;
  card.replaceChildren(
    el('div', { class: 'card-sub' }, p.place || 'Earthquake'),
    el('div', { class: 'kv' }, [
      ['Magnitude', `${p.mag?.toFixed(1)} ${p.magType || ''}`], ['Time', fmtUTC(p.time, true)], ['Age', fmtAgo(Date.now() - p.time)],
      ['Depth', `${depth?.toFixed(1)} km`], ['Location', `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`],
      ['Status', p.status || '—'], ['Tsunami flag', p.tsunami ? 'yes (see NOAA/NTWC)' : 'no'], ['Felt reports', p.felt ?? '—'],
    ].map(([k, v]) => [el('span', { class: 'k' }, k), el('span', { class: 'v mono' }, v)])),
    el('div', { class: 'links small' }, el('a', { href: p.url, target: '_blank', rel: 'noopener' }, 'USGS event page ↗')),
  );
}
export function selectQuake(id) {
  const f = Q.features.find(x => x.id === id);
  if (!f) return;
  const [lon, lat] = f.geometry.coordinates;
  App.selectItem({ kind: 'quake', id, title: `M${f.properties.mag?.toFixed(1)} earthquake`, family: 'quake', layer: 'Earthquakes', render: c => quakeCard(c, id) });
  App.flyTo({ type: 'region', lon, lat, h: 2.2e6, reason: 'quake' });
}
export function fitQuakes(strongest = false) {
  if (!Q.features.length) return;
  if (strongest) {
    const f = [...Q.features].sort((a, b) => (b.properties.mag ?? -9) - (a.properties.mag ?? -9))[0];
    selectQuake(f.id);
    return;
  }
  const pts = Q.features.map(f => C.Cartesian3.fromDegrees(f.geometry.coordinates[0], f.geometry.coordinates[1]));
  const bs = C.BoundingSphere.fromPoints(pts);
  App.flyTo({ type: 'sphere', center: bs.center, radius: bs.radius, reason: 'earthquakes', force: true });
}
export function buildQuakeUI(box) {
  const info = el('div', { id: 'quake-info' });
  skeleton(info, 2);
  const feed = el('select', { class: 'input small', 'aria-label': 'earthquake feed' }, el('option', { value: 'all_day' }, 'All, last 24 h'), el('option', { value: '2.5_week' }, 'M2.5+, last 7 days'));
  feed.value = Q.feed;
  feed.addEventListener('change', () => { Q.feed = feed.value; loadQuakes(); });
  box.replaceChildren(
    toggle('Show earthquakes (USGS, refreshed every 5 min)', Q.on, v => { Q.on = v; store.set('quakes', v); drawQuakes(); }, 'quake'),
    el('div', { class: 'row' }, feed, el('button', { class: 'btn small', onclick: () => fitQuakes(true) }, 'Strongest'), el('button', { class: 'btn small', onclick: () => fitQuakes(false) }, 'Fit all')),
    info);
}
export function initQuakes() { loadQuakes(); Q.timer = setInterval(loadQuakes, 5 * 60e3); }

// =================================================================== NISAR
const TYPE_COLORS = { GCOV: '#a78bfa', GUNW: '#f472b6', GSLC: '#818cf8', RSLC: '#6366f1', RIFG: '#e879f9', RUNW: '#c084fc', ROFF: '#94a3b8', GOFF: '#cbd5e1', SME2: '#2dd4bf' };
const N = App.data.nisar = { on: false, days: '7', types: new Set(store.get('nisarTypes', ['GCOV', 'GUNW'])), rows: [], prim: null, outline: null, timer: null, browse: null, sel: null };

async function loadNisar(force = false) {
  const box = $('#nisar-info');
  if (!N.on && !force) return;
  try {
    const qs = `days=${N.days}&types=${[...N.types].join(',')}`;
    const { body } = await getJSON(`/api/nisar?${qs}`);
    N.body = body;
    N.rows = body.rows || [];
    drawNisar();
    renderNisarInfo(box);
    pulseNewNisar();
    if (!body.last_poll) { clearTimeout(N.retry); N.retry = setTimeout(() => loadNisar(), 60e3); }
  } catch (e) {
    if (box) emptyState(box, `NISAR search is unavailable right now (${e.message})`, 300);
    chip('nisar', 'NISAR unavailable', 'bad', e.message);
    clearTimeout(N.retry); N.retry = setTimeout(() => loadNisar(), 300e3);
  }
}
function drawNisar() {
  const scene = App.scene;
  if (N.prim) { scene.primitives.remove(N.prim); N.prim = null; }
  if (N.outline) { scene.primitives.remove(N.outline); N.outline = null; }
  if (!N.on || !N.rows.length) { requestRender(); return; }
  const types = N.body.types;
  const now = Date.now() / 60000;
  const win = N.days === 'all' ? (now - Date.parse('2026-06-17') / 60000) : (+N.days * 1440);
  const fills = [], outs = [];
  const cap = App.isPhone() ? 6000 : 20000;
  for (const r of N.rows.slice(0, cap)) {
    const [gn, ti, stMin, path, frame, dir, seen, flat] = r;
    const pt = types[ti];
    const age = Math.max(0, now - stMin);
    const a = Math.max(0.10, 0.55 * (1 - age / win));
    const col = C.Color.fromCssColorString(TYPE_COLORS[pt] || '#a78bfa');
    let pos;
    try { pos = C.Cartesian3.fromDegreesArray(flat); } catch (e) { continue; }
    if (pos.length < 3) continue;
    fills.push(new C.GeometryInstance({ id: { kind: 'nisar', id: gn }, geometry: new C.PolygonGeometry({ polygonHierarchy: new C.PolygonHierarchy(pos), height: 1500, arcType: C.ArcType.GEODESIC, granularity: C.Math.RADIANS_PER_DEGREE * 2 }),
      attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(col.withAlpha(a * 0.55)) } }));
    outs.push(new C.GeometryInstance({ id: { kind: 'nisar', id: gn }, geometry: new C.PolygonOutlineGeometry({ polygonHierarchy: new C.PolygonHierarchy(pos), height: 1500, granularity: C.Math.RADIANS_PER_DEGREE * 2 }),
      attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(col.withAlpha(Math.min(1, a + 0.25))) } }));
  }
  const app = new C.PerInstanceColorAppearance({ translucent: true, closed: false, flat: true });
  N.prim = scene.primitives.add(new C.Primitive({ geometryInstances: fills, appearance: app, asynchronous: true, releaseGeometryInstances: true }));
  const oapp = new C.PerInstanceColorAppearance({ translucent: true, flat: true, renderState: { lineWidth: 1 } });
  N.outline = scene.primitives.add(new C.Primitive({ geometryInstances: outs, appearance: oapp, asynchronous: true, releaseGeometryInstances: true }));
  requestRender();
}
// pulse ring on the newest granule that arrived since the last visit (once per session)
function pulseNewNisar() {
  const last = store.get('nisarLastVisit', 0);
  if (!last || N.pulsed || !N.on) return;
  const r = N.rows.find(x => x[6] && x[6] * 60000 > last);
  if (!r) return;
  N.pulsed = true;
  const flat = r[7], n = flat.length / 2;
  let lon = 0, lat = 0; for (let i = 0; i < n; i++) { lon += flat[2 * i]; lat += flat[2 * i + 1]; }
  const t0 = performance.now();
  const rad = new C.CallbackProperty(() => 60000 + ((performance.now() - t0) % 2200) / 2200 * 380000, false);
  const col = new C.CallbackProperty(() => C.Color.fromCssColorString(FAMILY.radar).withAlpha(0.7 * (1 - ((performance.now() - t0) % 2200) / 2200)), false);
  const e = App.viewer.entities.add({ position: C.Cartesian3.fromDegrees(lon / n, lat / n), ellipse: { semiMajorAxis: rad, semiMinorAxis: rad, material: new C.ColorMaterialProperty(col), height: 2000 } });
  App.pulse(9000);
  setTimeout(() => { App.viewer.entities.remove(e); requestRender(); }, 9000);
}
function renderNisarInfo(box) {
  if (!box) return;
  const b = N.body || {};
  const last = store.get('nisarLastVisit', 0);
  const newCount = last ? N.rows.filter(r => r[6] && r[6] * 60000 > last).length : 0;
  chip('nisar', last ? `NISAR +${newCount} new` : `NISAR ${fmtNum(N.rows.length)}`, 'ok', 'granules first seen by this server since your last visit');
  const counts = Object.entries(b.db_counts || {}).sort((a, c) => c[1] - a[1]);
  const newest = N.rows[0];
  if (newest) {
    const ageMs = Date.now() - newest[2] * 60000;
    const flat = newest[7];
    const lat = flat.filter((_, i) => i % 2).reduce((a, c) => a + c, 0) / (flat.length / 2), lon = flat.filter((_, i) => !(i % 2)).reduce((a, c) => a + c, 0) / (flat.length / 2);
    tick('nisar', `Newest NISAR ${b.types[newest[1]]} pass · ${App.describePlace(lat, lon)} · acquired ${fmtAgo(ageMs)} ago`, 'radar');
  }
  const kids = [
    el('div', { class: 'stat-row' },
      el('div', { class: 'stat' }, el('span', { class: 'big mono' }, fmtNum(N.rows.length)), el('span', { class: 'muted small' }, `footprints shown${b.capped ? ' (capped)' : ''}`)),
      el('div', { class: 'stat' }, el('span', { class: 'big mono', style: { color: FAMILY.radar } }, last ? `+${fmtNum(newCount)}` : '—'), el('span', { class: 'muted small' }, last ? `new since your last visit (${fmtAgo(Date.now() - last)} ago)` : 'first visit — new passes are counted from now'))),
    el('div', { class: 'small muted' }, b.last_poll ? `ASF polled hourly · last ${fmtAgo(Date.now() - Date.parse(b.last_poll))} ago · catalogue covers acquisitions back to ${b.coverage_from ? b.coverage_from.slice(0, 10) : '…'} (building back to 2026-06-17 slowly, to be polite)` : 'Building the NISAR catalogue from the ASF search API — first poll in progress, this refreshes in a minute.'),
  ];
  if (counts.length) kids.push(el('div', { class: 'small mono muted' }, 'in catalogue: ' + counts.map(([k, v]) => `${k} ${fmtNum(v)}`).join(' · ')));
  box.replaceChildren(...kids);
}
export async function nisarCard(card, gn) {
  skeleton(card, 4);
  try {
    const { body: g } = await getJSON(`/api/nisar/granule?id=${encodeURIComponent(gn)}`);
    const pol = (g.pol || '').replace(/A:/g, 'main ').replace(/B:/g, 'side ');
    const kids = [
      el('div', { class: 'card-sub' }, el('span', { class: 'tag', style: { '--c': TYPE_COLORS[g.pt] || FAMILY.radar } }, g.pt), ' NISAR L-SAR · ', g.coll || ''),
      el('div', { class: 'kv' }, [
        ['Acquired', `${g.start.replace('T', ' ').slice(0, 19)} UTC`], ['Age', fmtAgo(Date.now() - Date.parse(g.start))],
        ['Track / frame', `${g.path} / ${g.frame} (${g.dir === 'A' ? 'ascending' : g.dir === 'D' ? 'descending' : g.dir})`],
        ['Orbit', g.orbit ?? '—'], ['Polarisation', pol || '—'], ['Frame coverage', g.cov || '—'], ['File size', fmtBytes(g.bytes)],
        ['Processing id (CRID)', g.crid || '—'],
      ].map(([k, v]) => [el('span', { class: 'k' }, k), el('span', { class: 'v mono' }, v)])),
      el('div', { class: 'small mono wrap muted' }, g.gn),
      el('div', { class: 'actions' },
        el('a', { class: 'btn', href: g.vertex_url, target: '_blank', rel: 'noopener' }, 'ASF Vertex ↗'),
        g.download_url ? el('a', { class: 'btn gold', href: g.download_url, target: '_blank', rel: 'noopener', title: g.download_note }, 'Download .h5 ↗') : ''),
      el('div', { class: 'note' }, '🔒 ', g.download_note, ' Products are provisional (NASA/JPL, ISRO).'),
    ];
    if (g.browse_url) {
      const tog = toggle('Drape the ASF browse image on the footprint', true, v => drapeBrowse(v ? g : null), 'radar');
      kids.push(tog);
      drapeBrowse(g);
    } else kids.push(el('div', { class: 'small muted' }, 'No browse image is published for this granule.'));
    card.replaceChildren(...kids);
  } catch (e) { emptyState(card, `Granule details unavailable (${e.message})`); }
}
async function drapeBrowse(g) {
  const v = App.viewer;
  if (N.browse) { v.imageryLayers.remove(N.browse, true); N.browse = null; }
  if (!g) { requestRender(); return; }
  const lons = g.geom[0].map(p => p[0]), lats = g.geom[0].map(p => p[1]);
  const rect = C.Rectangle.fromDegrees(Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats));
  try {
    const prov = await C.SingleTileImageryProvider.fromUrl(g.browse_url, { rectangle: rect, credit: 'NISAR browse: NASA/JPL-Caltech, ISRO; ASF DAAC' });
    const layer = new C.ImageryLayer(prov, { alpha: 0.92 });
    layer.colorToAlpha = C.Color.BLACK; layer.colorToAlphaThreshold = 0.02;
    if (N.sel !== g.gn) return;
    N.browse = v.imageryLayers.add(layer);
    requestRender();
  } catch (e) { toast('Browse image could not be loaded'); }
}
export function selectNisar(gn) {
  N.sel = gn;
  const r = N.rows.find(x => x[0] === gn);
  App.selectItem({ kind: 'nisar', id: gn, title: 'NISAR granule', family: 'radar', layer: 'NISAR', render: c => nisarCard(c, gn), onClear: () => { N.sel = null; drapeBrowse(null); } });
  if (r) {
    const pos = C.Cartesian3.fromDegreesArray(r[7]);
    const bs = C.BoundingSphere.fromPoints(pos);
    App.flyTo({ type: 'sphere', center: bs.center, radius: bs.radius * 1.6, reason: 'NISAR footprint', force: true });
  }
}
export function setNisarOn(on) {
  N.on = on;
  if (on) { loadNisar(); clearInterval(N.timer); N.timer = setInterval(loadNisar, 10 * 60e3); App.events.dispatchEvent(new CustomEvent('flyhint', { detail: { type: 'global', onlyIfGlobal: true, reason: 'NISAR' } })); }
  else { clearInterval(N.timer); drawNisar(); }
  syncNisarUI();
}
let nisarUI = {};
function syncNisarUI() { if (nisarUI.tog) nisarUI.tog.querySelector('input').checked = N.on; }
export function buildNisarUI(box) {
  const info = el('div', { id: 'nisar-info', class: 'info' });
  emptyState(info, 'Turn on footprints to load the ASF catalogue.');
  nisarUI.tog = toggle('Show NISAR granule footprints (ASF, polled hourly)', N.on, v => { setNisarOn(v); }, 'radar');
  const win = el('div', { class: 'seg' }, [['7', '7 days'], ['30', '30 days'], ['all', 'All since 06-17']].map(([v, t]) => {
    const b = el('button', { class: 'seg-b' + (N.days === v ? ' on' : ''), onclick: () => { N.days = v; win.querySelectorAll('.seg-b').forEach(x => x.classList.toggle('on', x === b)); loadNisar(); } }, t);
    return b;
  }));
  const typeBox = el('div', { class: 'chips-row' }, Object.entries(TYPE_COLORS).map(([t, c]) => {
    const b = el('button', { class: 'pill' + (N.types.has(t) ? ' on' : ''), style: { '--c': c }, title: TYPE_DESC[t] || t, onclick: () => { N.types.has(t) ? N.types.delete(t) : N.types.add(t); b.classList.toggle('on', N.types.has(t)); store.set('nisarTypes', [...N.types]); loadNisar(); } }, t);
    return b;
  }));
  box.replaceChildren(
    nisarUI.tog, win, typeBox, info,
    el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => App.sats.select(65053) }, 'Follow NISAR'), el('button', { class: 'btn ghost small', onclick: () => { store.set('nisarLastVisit', Date.now()); renderNisarInfo(info); toast('Marked all NISAR passes as seen'); } }, 'Mark all seen')),
    el('details', { class: 'stub' }, el('summary', {}, 'Radar backscatter tiles (GCOV) — coming later'),
      el('p', { class: 'small' }, 'Turning GCOV backscatter into map tiles means downloading the HDF5 products (hundreds of MB each), which needs your own free NASA Earthdata login. This app does not download products or handle Earthdata credentials; footprints, metadata and ASF browse images need no login.')),
  );
  // remember the visit time once the section has been looked at
  window.addEventListener('beforeunload', () => { if (N.body) store.set('nisarLastVisit', Date.now()); });
}
const TYPE_DESC = { RSLC: 'Range-Doppler single-look complex (L1)', GSLC: 'Geocoded single-look complex (L2)', GCOV: 'Geocoded polarimetric covariance / backscatter (L2)', RIFG: 'Range-Doppler interferogram (L1)', RUNW: 'Range-Doppler unwrapped interferogram (L1)', ROFF: 'Range-Doppler pixel offsets (L1)', GUNW: 'Geocoded unwrapped interferogram (L2)', GOFF: 'Geocoded pixel offsets (L2)', SME2: 'Soil moisture (L3)' };

// =================================================================== SWOT
const W = App.data.swot = { on: store.get('swot', false), list: [], ds: null, meta: null };
export async function initSwot() {
  try { W.meta = await (await fetch('data/swot_features.json')).json(); W.list = W.meta.features || []; } catch (e) { W.list = []; }
  if (W.on) drawSwot();
}
function drawSwot() {
  const v = App.viewer;
  if (!W.ds) { W.ds = new C.CustomDataSource('swot'); v.dataSources.add(W.ds); }
  W.ds.entities.removeAll();
  W.ds.show = W.on;
  if (!W.on) { requestRender(); return; }
  const blue = C.Color.fromCssColorString(FAMILY.water);
  for (const f of W.list) {
    const g = f.geometry;
    if (!g) continue;
    const id = { kind: 'swot', id: `${f.type}:${f.id}` };
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map(p => p[0]) : g.type === 'Point' ? [] : [];
    for (const ln of lines) {
      if (ln.length < 2) continue;
      W.ds.entities.add({ id: undefined, polyline: { positions: C.Cartesian3.fromDegreesArray(ln.flatMap(p => [p[0], p[1]])), width: f.type === 'Reach' ? 4 : 2.5, clampToGround: true,
        material: new C.PolylineGlowMaterialProperty({ glowPower: 0.25, color: blue.withAlpha(0.95) }) }, properties: { pick: id } });
    }
    const c = centroid(g);
    if (c && f.type === 'PriorLake') W.ds.entities.add({ position: C.Cartesian3.fromDegrees(c[0], c[1]), ellipse: { semiMajorAxis: 25000, semiMinorAxis: 25000, height: 0, fill: false, outline: true, outlineColor: blue.withAlpha(0.9), outlineWidth: 2 }, properties: { pick: id } });
    if (c) W.ds.entities.add({ position: C.Cartesian3.fromDegrees(c[0], c[1], 500), point: { pixelSize: 7, color: blue, outlineColor: C.Color.WHITE.withAlpha(0.8), outlineWidth: 1.5, disableDepthTestDistance: 5e6 },
      label: { text: f.name, font: '500 12px Inter, sans-serif', fillColor: C.Color.fromCssColorString('#cfe6ff'), outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(8, -8), horizontalOrigin: C.HorizontalOrigin.LEFT, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 9e6), disableDepthTestDistance: 5e6 },
      properties: { pick: id } });
  }
  requestRender();
}
function centroid(g) {
  const pts = g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiLineString' ? g.coordinates.flat() : g.type === 'MultiPolygon' ? g.coordinates.map(p => p[0]).flat() : [];
  if (!pts.length) return null;
  if (g.type === 'LineString' || g.type === 'MultiLineString') return pts[Math.floor(pts.length / 2)];
  return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
}
export function swotFeature(key) { return W.list.find(f => `${f.type}:${f.id}` === key); }
export function selectSwot(key) {
  const f = swotFeature(key);
  if (!f) return;
  if (!W.on) setSwotOn(true);
  App.selectItem({ kind: 'swot', id: key, title: f.name, family: 'water', layer: 'SWOT water', render: c => swotCard(c, f) });
  const pts = geomPoints(f.geometry);
  if (pts.length) {
    const bs = C.BoundingSphere.fromPoints(pts.map(p => C.Cartesian3.fromDegrees(p[0], p[1])));
    App.flyTo({ type: 'sphere', center: bs.center, radius: Math.max(bs.radius * 2.2, 40000), reason: f.name, force: true });
  }
}
function geomPoints(g) {
  if (!g) return [];
  if (g.type === 'Point') return [g.coordinates];
  if (g.type === 'LineString') return g.coordinates;
  if (g.type === 'Polygon') return g.coordinates[0];
  if (g.type === 'MultiLineString') return g.coordinates.flat();
  if (g.type === 'MultiPolygon') return g.coordinates.map(p => p[0]).flat();
  return [];
}
async function swotCard(card, f) {
  card.replaceChildren(el('div', { class: 'card-sub' }, `${f.type === 'Reach' ? 'SWORD river reach' : 'PLD prior lake'} ${f.id}`, f.region ? el('span', { class: 'muted' }, ` · ${f.region}`) : ''), el('div', { class: 'skel' }), el('div', { class: 'skel', style: { width: '60%' } }));
  try {
    const { body, fetched, cache } = await getJSON(`/api/swot?feature=${f.type}&id=${f.id}`);
    const all = (body.rows || []).filter(r => r.time_str && r.time_str !== 'no_data');
    const num = v => { const x = parseFloat(v); return isFinite(x) && x > -9e11 ? x : NaN; };
    // quality filter: rivers reach_q 0-1 (good/suspect), lakes quality_f 0 (good); fall back to all valid if too few
    const qk = f.type === 'Reach' ? 'reach_q' : 'quality_f', qmax = f.type === 'Reach' ? 1 : 0;
    let rows = all.filter(r => isFinite(num(r.wse)) && (r[qk] === undefined || r[qk] === '' || +r[qk] <= qmax));
    const qualityNote = rows.length >= 3 ? `${qk} ≤ ${qmax}` : 'all valid passes (few passed the quality flag)';
    if (rows.length < 3) rows = all;
    const series = k => rows.map(r => ({ x: new Date(r.time_str), y: num(r[k]) })).filter(p => isFinite(p.y));
    const wse = series('wse');
    const latest = rows.map(r => r.time_str).sort().pop();
    const versions = [...new Set(rows.map(r => r.crid).filter(Boolean))];
    const cv = el('canvas', { class: 'chart', 'aria-label': 'water surface elevation chart' });
    const kids = [
      el('div', { class: 'card-sub' }, `${f.type === 'Reach' ? 'SWORD river reach' : 'PLD prior lake'} ${f.id}`, f.region ? el('span', { class: 'muted' }, ` · ${f.region}`) : ''),
      el('div', { class: 'stat-row' },
        el('div', { class: 'stat' }, el('span', { class: 'big mono', style: { color: FAMILY.water } }, wse.length ? `${wse[wse.length - 1].y.toFixed(2)} m` : '—'), el('span', { class: 'muted small' }, 'latest water-surface elevation')),
        el('div', { class: 'stat' }, el('span', { class: 'big mono' }, fmtNum(wse.length)), el('span', { class: 'muted small' }, `passes shown, 12 months (${qualityNote})`))),
      el('div', { class: 'h small' }, 'Water surface elevation (m)'), cv,
    ];
    const extra = f.type === 'Reach' ? [['width', 'Width (m)'], ['dschg_c', 'Discharge (m³/s)'], ['slope', 'Slope (m/m)']] : [['area_total', 'Water area (km²)']];
    for (const [k, t] of extra) {
      const s = series(k);
      if (s.length >= 2) kids.push(el('div', { class: 'row small' }, el('span', { class: 'lbl' }, t), sparkline(s.map(p => p.y), { w: 160, h: 26, color: FAMILY.water }), el('span', { class: 'mono' }, s[s.length - 1].y.toPrecision(4))));
    }
    kids.push(el('div', { class: 'kv' }, [
      ['Latest pass', latest ? latest.replace('T', ' ').replace('Z', ' UTC') : '—'], ['Product version (CRID)', versions.join(', ') || 'not returned'],
      ['Collection version', [...new Set(rows.map(r => r.collection_version).filter(Boolean))].join(', ') || '—'],
      ['Data fetched', `${fmtAgo(Date.now() - Date.parse(fetched))} ago (server cache 12 h)`],
    ].map(([k, v]) => [el('span', { class: 'k' }, k), el('span', { class: 'v mono' }, v)])));
    kids.push(el('div', { class: 'note' }, 'Provisional values: SWOT products are reprocessed under new version letters (CRID), so numbers can change. Source: PO.DAAC Hydrocron.'));
    const srcUrl = (f.source || '').match(/https?:\/\/[^\s)]+/);
    if (srcUrl) kids.push(el('div', { class: 'links small' }, 'id source: ', el('a', { href: srcUrl[0], target: '_blank', rel: 'noopener' }, new URL(srcUrl[0]).hostname)));
    card.replaceChildren(...kids);
    requestAnimationFrame(() => drawSeries(cv, wse, { color: FAMILY.water, yLabel: 'WSE m' }));
    App.swotSpark = wse.map(p => p.y);
  } catch (e) { emptyState(card, `Hydrocron is unavailable right now (${e.message})`, 600); }
}
export function setSwotOn(on) { W.on = on; store.set('swot', on); drawSwot(); if (swotUI.tog) swotUI.tog.querySelector('input').checked = on; }
let swotUI = {};
export function buildSwotUI(box) {
  swotUI.tog = toggle('Show curated SWOT rivers & lakes', W.on, v => setSwotOn(v), 'water');
  const list = el('div', { class: 'swot-list' }, W.list.length ? W.list.map(f => el('button', { class: 'li', onclick: () => selectSwot(`${f.type}:${f.id}`) }, el('span', { class: 'dot', style: { background: FAMILY.water } }), el('span', {}, f.name), el('span', { class: 'muted small' }, f.type === 'Reach' ? 'reach' : 'lake'))) : el('div', { class: 'empty' }, 'Curated list not available.'));
  box.replaceChildren(swotUI.tog, el('div', { class: 'hint' }, 'Tap a river or lake for its SWOT water-surface-elevation time series (last 12 months). Values are provisional and get reprocessed under new version letters.'), list,
    el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => App.sats.select(54754) }, 'Follow SWOT')));
}

// =================================================================== SHIPS (aisstream.io) + GFW SAR
const SH = App.data.ships = { on: false, gfwOn: false, bb: null, timer: null, enabled: null, gfwEnabled: null, img: {} };
const SHIP_COL = { cargo: '#3ddc84', tanker: '#f59e0b', passenger: '#60a5fa', fishing: '#f472b6', other: '#a3e635' };
function arrowImage() {
  if (SH.arrow) return SH.arrow;
  const c = document.createElement('canvas'); c.width = c.height = 24;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(12, 2); g.lineTo(19, 21); g.lineTo(12, 16); g.lineTo(5, 21); g.closePath(); g.fill(); g.stroke();
  return (SH.arrow = c);
}
function dotImage() {
  if (SH.dot) return SH.dot;
  const c = document.createElement('canvas'); c.width = c.height = 16;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 1.5;
  g.beginPath(); g.arc(8, 8, 5, 0, Math.PI * 2); g.fill(); g.stroke();
  return (SH.dot = c);
}
function ringImage() {
  if (SH.ring) return SH.ring;
  const c = document.createElement('canvas'); c.width = c.height = 22;
  const g = c.getContext('2d'); g.strokeStyle = '#fff'; g.lineWidth = 2.2;
  g.beginPath(); g.arc(11, 11, 7.5, 0, Math.PI * 2); g.stroke();
  return (SH.ring = c);
}
async function loadShips() {
  if (!SH.on) return;
  const v = App.viewer;
  let r = v.camera.computeViewRectangle();
  let bb = r ? [C.Math.toDegrees(r.west), C.Math.toDegrees(r.south), C.Math.toDegrees(r.east), C.Math.toDegrees(r.north)] : [-180, -90, 180, 90];
  bb = bb.map(x => +x.toFixed(3));
  try {
    const { body } = await getJSON(`/api/ships?bbox=${bb.join(',')}`);
    if (!body.enabled) { SH.enabled = false; renderShipInfo(body.hint); return; }
    SH.enabled = true;
    drawShips(body);
    renderShipInfo(null, body);
  } catch (e) { renderShipInfo(`Ships unavailable right now (${e.message}) — retrying`); }
}
function drawShips(body) {
  const scene = App.scene;
  if (!SH.bbc) SH.bbc = scene.primitives.add(new C.BillboardCollection({ scene }));
  SH.bbc.removeAll();
  const cap = App.isPhone() ? 5000 : 20000;
  const sbd = new C.NearFarScalar(2e5, 1.0, 8e6, 0.35);
  for (const s of body.ships.slice(0, cap)) {
    const [mmsi, lat, lon, cog, hdg, sog, cls, age] = s;
    const dir = hdg >= 0 ? hdg : (cog >= 0 && sog > 0.5 ? cog : -1);
    SH.bbc.add({ position: C.Cartesian3.fromDegrees(lon, lat, 0), image: dir >= 0 ? arrowImage() : dotImage(), width: dir >= 0 ? 14 : 9, height: dir >= 0 ? 14 : 9,
      color: C.Color.fromCssColorString(SHIP_COL[cls] || SHIP_COL.other).withAlpha(age > 900 ? 0.55 : 1), rotation: dir >= 0 ? -C.Math.toRadians(dir) : 0, alignedAxis: dir >= 0 ? C.Cartesian3.UNIT_Z : C.Cartesian3.ZERO,
      scaleByDistance: sbd, id: { kind: 'ship', id: mmsi }, disableDepthTestDistance: 1e6 });
  }
  requestRender();
}
function renderShipInfo(msg, body) {
  const box = $('#ship-info');
  if (!box) return;
  if (msg) { box.replaceChildren(el('div', { class: 'empty' }, msg)); return; }
  box.replaceChildren(el('div', { class: 'stat-row' }, el('div', { class: 'stat' }, el('span', { class: 'big mono', style: { color: FAMILY.ship } }, fmtNum(body.returned)), el('span', { class: 'muted small' }, `ships in view${body.total > body.returned ? ` of ${fmtNum(body.total)}` : ''} · heard in last 30 min`))),
    el('div', { class: 'legend-row small' }, Object.entries(SHIP_COL).map(([k, c]) => el('span', {}, el('span', { class: 'dot', style: { background: c } }), k))));
}
export async function shipCard(card, mmsi) {
  skeleton(card, 4);
  try {
    const { body: s } = await getJSON(`/api/ship/${mmsi}`);
    card.replaceChildren(el('div', { class: 'card-sub' }, el('span', { class: 'tag', style: { '--c': SHIP_COL[s.type_class] || FAMILY.ship } }, s.type_class), ` AIS class ${s.class}`),
      el('div', { class: 'kv' }, [
        ['Name', s.name || '—'], ['MMSI', s.mmsi], ['Call sign', s.callsign || '—'], ['IMO', s.imo || '—'], ['Type code', s.type ?? '—'],
        ['Speed', s.sog_kn !== null && s.sog_kn !== undefined ? `${s.sog_kn.toFixed(1)} kn` : '—'], ['Course', s.cog !== null && s.cog !== undefined ? `${s.cog.toFixed(0)}°` : '—'], ['Heading', s.heading ?? '—'],
        ['Destination', s.dest || '—'], ['ETA', s.eta || '—'], ['Length', s.length ? `${s.length} m` : '—'], ['Last report', `${fmtAgo(s.age_s * 1000)} ago`],
        ['Position', `${s.lat.toFixed(4)}°, ${s.lon.toFixed(4)}°`],
      ].map(([k, v]) => [el('span', { class: 'k' }, k), el('span', { class: 'v mono' }, v)])),
      el('div', { class: 'note' }, 'Live AIS via aisstream.io terrestrial receivers: good near coasts, weak mid-ocean.'));
  } catch (e) { emptyState(card, `Ship not heard recently (${e.message})`); }
}
export function selectShip(mmsi) {
  App.selectItem({ kind: 'ship', id: mmsi, title: `Vessel ${mmsi}`, family: 'ship', layer: 'Ships', render: c => shipCard(c, mmsi) });
  getJSON(`/api/ship/${mmsi}`).then(({ body }) => App.flyTo({ type: 'region', lon: body.lon, lat: body.lat, h: 200e3, reason: 'ship', force: true })).catch(() => { });
}
async function loadGfw() {
  const box = $('#gfw-info');
  if (!SH.gfwOn) { if (SH.gfwPts) SH.gfwPts.show = false; requestRender(); return; }
  try {
    const { body, fetched } = await getJSON('/api/gfw/sar');
    if (!body.enabled && body.enabled !== undefined) { SH.gfwEnabled = false; if (box) box.replaceChildren(el('div', { class: 'empty' }, body.hint)); return; }
    const scene = App.scene;
    if (SH.gfwPts) scene.primitives.remove(SH.gfwPts);
    SH.gfwPts = scene.primitives.add(new C.BillboardCollection({ scene }));
    SH.gfwCells = body.cells;
    body.cells.forEach((c, i) => SH.gfwPts.add({ position: C.Cartesian3.fromDegrees(c[1], c[0]), image: ringImage(), width: 12 + Math.min(10, c[2]), height: 12 + Math.min(10, c[2]),
      color: C.Color.fromCssColorString('#3ddc84'), scaleByDistance: new C.NearFarScalar(2e5, 1.2, 1e7, 0.4), id: { kind: 'gfw', id: i }, disableDepthTestDistance: 1e6 }));
    if (box) box.replaceChildren(el('div', { class: 'small' }, `${fmtNum(body.cells.length)} grid cells with radar-detected vessels that broadcast no AIS (${body.date_range.join(' → ')}; Sentinel-1 data lags ~5 days).`),
      el('div', { class: 'small muted' }, 'Powered by Global Fishing Watch — non-commercial use only.'));
    requestRender();
  } catch (e) { if (box) emptyState(box, `Global Fishing Watch unavailable (${e.message})`, 3600); }
}
export function gfwCard(card, i) {
  const c = SH.gfwCells && SH.gfwCells[i];
  if (!c) return;
  card.replaceChildren(el('div', { class: 'card-sub' }, 'radar-detected (no AIS)'),
    el('div', { class: 'kv' }, [['Cell centre', `${c[0].toFixed(2)}°, ${c[1].toFixed(2)}°`], ['Detections', c[2]], ['Grid', '0.1° cells (not exact positions)']].map(([k, v]) => [el('span', { class: 'k' }, k), el('span', { class: 'v mono' }, v)])),
    el('div', { class: 'note' }, 'Sentinel-1 SAR vessel detections that were not matched to any AIS broadcast. Powered by Global Fishing Watch (globalfishingwatch.org) — non-commercial use only.'));
}
export function buildShipUI(box, status) {
  const ais = status?.sources?.aisstream?.state;
  const gfw = status?.sources?.gfw?.state;
  SH.enabled = ais && ais !== 'missing key';
  SH.gfwEnabled = gfw && gfw !== 'missing key';
  const info = el('div', { id: 'ship-info' });
  const ginfo = el('div', { id: 'gfw-info' });
  const t1 = toggle(SH.enabled ? 'Live ships (AIS, refresh every 12 s)' : 'Ships: add a free aisstream.io key (see About)', SH.on, v => {
    SH.on = v; clearInterval(SH.timer);
    if (v) { loadShips(); SH.timer = setInterval(loadShips, 12e3); }
    else if (SH.bbc) { SH.bbc.removeAll(); requestRender(); }
  }, 'ship', !SH.enabled);
  const t2 = toggle(SH.gfwEnabled ? 'Dark vessels: radar detections with no AIS (Global Fishing Watch)' : 'Dark vessels: add a free Global Fishing Watch token', SH.gfwOn, v => { SH.gfwOn = v; loadGfw(); }, 'ship', !SH.gfwEnabled);
  if (!SH.enabled) info.replaceChildren(el('div', { class: 'empty' }, ais === 'disabled' ? 'Ships are switched off for this server run.' : 'Ships stay off until AISSTREAM_API_KEY is added to the server’s keys file (keys.env) and the server is restarted.'));
  else if (ais === 'error') info.replaceChildren(el('div', { class: 'empty' }, `aisstream.io connection problem — the server retries with backoff (${status.sources.aisstream.error || ''}).`));
  if (!SH.gfwEnabled) ginfo.replaceChildren(el('div', { class: 'empty' }, 'Dark-vessel detections stay off until GFW_API_TOKEN is added to the server’s keys file (keys.env) and the server is restarted.'));
  box.replaceChildren(t1, info, t2, ginfo);
  // the view changed: refresh ships soon (debounced by the 12 s timer otherwise)
  App.viewer.camera.moveEnd.addEventListener(() => { if (SH.on) loadShips(); });
}
