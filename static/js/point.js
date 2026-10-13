// Created by Sunny Chase (https://github.com/sunnychase) in collaboration with Claude (Anthropic).
// Lion Satellite Studio — point lookup ("What sees this spot?"): type coordinates or a place, right-click / long-press
// the globe, or use your location; a Point report lists the satellites over the point now, the next passes (and whether
// the point falls inside the instrument swath), the imagery and products that already exist for that exact point,
// nearby events, and the geostationary views. Every row flies to the item and switches its layer on.
import { App, $, el, getJSON, store, toast, fmtAgo, fmtUTC, fmtNum, requestRender, FAMILY, skeleton, emptyState, ymd } from './util.js';
import * as SAT from './sats.js';
import * as IM from './imagery.js';
import * as D from './data.js';
import * as RD from './radar.js';
import { ecfToLookAngles, degreesToRadians, radiansToDegrees } from '../vendor/satellite/transforms.js';

const C = window.Cesium;
const RE = 6371.0;
const GOLD = '#d9b25f';
const P = App.data.point = { cur: null, pin: null, report: null, overlay: null, overlayInfo: null, extra: null, timer: null };
const OPT = {
  'sentinel-2-l2a': { title: 'Sentinel-2 L2A', minZ: 9, credit: 'Contains modified Copernicus Sentinel data; Sentinel-2 L2A via Microsoft Planetary Computer', short: 'S2' },
  'landsat-c2-l2': { title: 'Landsat Collection 2 L2', minZ: 8, credit: 'Landsat imagery courtesy of the U.S. Geological Survey, via Microsoft Planetary Computer', short: 'Landsat' },
  'hls2-l30': { title: 'HLS Landsat (L30)', minZ: 8, credit: 'HLS L30: NASA LP DAAC (Landsat, USGS) via Microsoft Planetary Computer', short: 'HLS L30' },
  'hls2-s30': { title: 'HLS Sentinel-2 (S30)', minZ: 8, credit: 'HLS S30: NASA LP DAAC; contains modified Copernicus Sentinel data, via Microsoft Planetary Computer', short: 'HLS S30' },
};
const GIBS_WMTS = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best';
const TMS_MAX = { '16km': 2, '8km': 3, '4km': 4, '2km': 5, '1km': 6, '500m': 7, '250m': 8, '31.25m': 11, '15.625m': 12 };
const GIBS_TEST = ['MODIS_Terra_CorrectedReflectance_TrueColor', 'MODIS_Aqua_CorrectedReflectance_TrueColor',
  'VIIRS_SNPP_CorrectedReflectance_TrueColor', 'VIIRS_NOAA20_CorrectedReflectance_TrueColor', 'VIIRS_NOAA21_CorrectedReflectance_TrueColor'];
const GEO = [
  { name: 'GOES-East', sat: 'GOES-19', norad: 60133, lon: -75.2, layer: 'GOES-East_ABI_GeoColor', region: 'goes_east' },
  { name: 'GOES-West', sat: 'GOES-18', norad: 51850, lon: -137.0, layer: 'GOES-West_ABI_GeoColor', region: 'goes_west' },
  { name: 'Himawari', sat: 'Himawari-9', norad: null, lon: 140.7, layer: 'Himawari_AHI_Band3_Red_Visible_1km', region: 'himawari' },
];

// ---------------------------------------------------------------- parsing
const HEMI = { N: 1, S: -1, E: 1, W: -1 };
function dmsToDeg(tok) {
  const m = tok.trim().toUpperCase().match(/^([NSEW])?\s*(-?\d+(?:\.\d+)?)\s*(?:[°ºD:\s]\s*(\d+(?:\.\d+)?)\s*(?:['′M:\s]\s*(?:(\d+(?:\.\d+)?)\s*(?:["″]|'')?)?)?)?\s*([NSEW])?$/);
  if (!m) return null;
  const h = m[1] || m[5] || null;
  let v = Math.abs(+m[2]) + (m[3] ? +m[3] / 60 : 0) + (m[4] ? +m[4] / 3600 : 0);
  if (m[3] && +m[3] >= 60 || m[4] && +m[4] >= 60) return null;
  if (+m[2] < 0 || (h && HEMI[h] < 0)) v = -v;
  return { v, h };
}
export function parseCoord(text) {
  const t = String(text || '').trim().replace(/[,;]+\s*$/, '');
  if (!t || t.length > 80) return null;
  // two parts: split on a comma, or after a hemisphere letter, or on whitespace for plain decimals
  let parts = t.split(/\s*[,;]\s*/);
  if (parts.length !== 2) {
    const m = t.toUpperCase().match(/^(.+?[NS])\s*(.+?[EW])$/) || t.toUpperCase().match(/^([NS].+?)\s+([EW].+)$/);
    if (m) parts = [m[1], m[2]];
    else { const s = t.split(/\s+/); if (s.length === 2) parts = s; }
  }
  if (parts.length !== 2) return null;
  let a = dmsToDeg(parts[0]), b = dmsToDeg(parts[1]);
  if (!a || !b) return null;
  let lat = a.v, lon = b.v;
  if ((a.h === 'E' || a.h === 'W') && (b.h === 'N' || b.h === 'S')) { lat = b.v; lon = a.v; }
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
  return { lat: +lat.toFixed(5), lon: +lon.toFixed(5) };
}
export function resolveInput(text) {
  const c = parseCoord(text);
  if (c) return { ...c, name: null };
  const p = App.findPlace(text);
  if (p) return { lat: p.lat, lon: p.lon, name: p.name };
  return null;
}
const dms = (v, pos, neg) => { const a = Math.abs(v), d = Math.floor(a), mf = (a - d) * 60, m = Math.floor(mf), s = (mf - m) * 60; return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″${v >= 0 ? pos : neg}`; };
const fmtLL = (lat, lon) => `${lat.toFixed(4)}, ${lon.toFixed(4)}`;

// ---------------------------------------------------------------- geometry
const rad = Math.PI / 180;
function hav(la1, lo1, la2, lo2) { const x = Math.sin((la2 - la1) * rad / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin((lo2 - lo1) * rad / 2) ** 2; return 2 * RE * Math.asin(Math.min(1, Math.sqrt(x))); }
function brg(la1, lo1, la2, lo2) { const f1 = la1 * rad, f2 = la2 * rad, dl = (lo2 - lo1) * rad; return Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) / rad; }
// cross-track and along-track distance (km) of point p from the ground track through s0 (heading towards s1)
function trackOffsets(s0, s1, p) {
  const d13 = hav(s0[0], s0[1], p[0], p[1]) / RE;
  const t = (brg(s0[0], s0[1], p[0], p[1]) - brg(s0[0], s0[1], s1[0], s1[1])) * rad;
  const xt = Math.asin(Math.max(-1, Math.min(1, Math.sin(d13) * Math.sin(t))));
  const at = Math.acos(Math.max(-1, Math.min(1, Math.cos(d13) / Math.cos(xt)))) * Math.sign(Math.cos(t) || 1);
  return { xt: xt * RE, at: at * RE };
}
const obsOf = (lat, lon) => ({ latitude: degreesToRadians(lat), longitude: degreesToRadians(lon), height: 0 });
function elev(og, ecf) { return radiansToDegrees(ecfToLookAngles(og, ecf).elevation); }
function swathHit(m, xt) {
  for (const w of (m && m.swaths) || []) {
    const half = w.width_km / 2, gap = (w.nadir_gap_km || 0) / 2;
    if (Math.abs(xt) <= half && Math.abs(xt) >= gap) return w;
  }
  return null;
}
function sunElev(og, t) { const s = SAT.sunEcf(t); return elev(og, s); }

// ---------------------------------------------------------------- pin + overlays
function setPin(lat, lon, label) {
  const v = App.viewer;
  if (P.pin) v.entities.remove(P.pin);
  P.pin = v.entities.add({
    position: C.Cartesian3.fromDegrees(lon, lat),
    point: { pixelSize: 13, color: C.Color.fromCssColorString(GOLD), outlineColor: C.Color.BLACK, outlineWidth: 2, heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: 5e7 },
    label: { text: label, font: '600 13px Inter, sans-serif', fillColor: C.Color.fromCssColorString('#f3d58a'), outlineColor: C.Color.BLACK, outlineWidth: 3,
      style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(12, -12), horizontalOrigin: C.HorizontalOrigin.LEFT, heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: 5e7 },
    properties: { pick: { kind: 'point', id: `${lat},${lon}` } },
  });
  requestRender();
}
function clearExtra() {
  const v = App.viewer;
  if (P.extra) { for (const e of P.extra.ents || []) v.entities.remove(e); if (P.extra.layer) v.imageryLayers.remove(P.extra.layer, true); P.extra = null; App.events.dispatchEvent(new Event('layers')); }
  requestRender();
}
function clearOptical() {
  if (P.overlay) { App.viewer.imageryLayers.remove(P.overlay, true); P.overlay = null; P.overlayInfo = null; App.events.dispatchEvent(new Event('layers')); requestRender(); }
}
export function clearPoint() {
  clearExtra(); clearOptical();
  if (P.pin) { App.viewer.entities.remove(P.pin); P.pin = null; }
  clearInterval(P.timer); P.cur = null; requestRender();
}
function flyPoint(h = 1.6e6) { const c = P.cur; if (c) App.flyTo({ type: 'region', lon: c.lon, lat: c.lat, h, force: true, reason: 'point' }); }

// ---------------------------------------------------------------- lookup
export function lookup(lat, lon, opts = {}) {
  lat = +(+lat).toFixed(4); lon = +(+lon).toFixed(4);
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) { toast('Coordinates out of range'); return; }
  clearExtra(); clearOptical(); clearInterval(P.timer);
  const name = opts.name || App.describePlace(lat, lon);
  P.cur = { lat, lon, name, label: opts.name || fmtLL(lat, lon), t: SAT.now() };
  P.report = { lat, lon, name, generated: new Date().toISOString(), sections: {} };
  setPin(lat, lon, opts.name || fmtLL(lat, lon));
  SAT.unfollow();
  if (opts.fly !== false) flyPoint(opts.h || 1.6e6);
  App.selectItem({ kind: 'point', id: `${lat},${lon}`, title: opts.name || fmtLL(lat, lon), family: 'gold', layer: 'Point report', render: renderReport, onClear: () => { clearInterval(P.timer); } });
}
App.pointLookup = lookup;

// ---------------------------------------------------------------- report card
function sec(id, title, sub) {
  const body = el('div', { class: 'pt-body' });
  const box = el('div', { class: 'pt-sec', id: `pt-${id}` }, el('div', { class: 'pt-h' }, el('span', {}, title), sub ? el('span', { class: 'pt-sub' }, sub) : ''), body);
  skeleton(body, 2);
  return { box, body };
}
const row = (cells, onclick, title) => el('button', { class: 'pt-row', onclick, title: title || '' }, cells);
const note = t => el('div', { class: 'small muted' }, t);
function fail(body, id, e) { P.report.sections[id] = { error: e.message }; emptyState(body, `Unavailable right now (${e.message})`, e.status === 429 ? e.retry : null); }

function renderReport(card) {
  const c = P.cur;
  if (!c) { card.replaceChildren(note('No point selected.')); return; }
  const head = el('div', { class: 'pt-head' },
    el('div', { class: 'card-sub' }, c.name),
    el('div', { class: 'mono small' }, `${fmtLL(c.lat, c.lon)} · ${dms(c.lat, 'N', 'S')} ${dms(c.lon, 'E', 'W')}`),
    el('div', { class: 'row pt-actions' },
      el('button', { class: 'btn small', onclick: copyReport }, 'Copy report'),
      el('button', { class: 'btn small', onclick: downloadGeoJSON }, 'Download GeoJSON'),
      el('button', { class: 'btn small', onclick: shareLink }, 'Share link'),
      el('button', { class: 'btn small ghost', onclick: () => flyPoint() }, 'Fly to point'),
      el('button', { class: 'btn small ghost', onclick: () => { clearPoint(); $('#card-close').click(); } }, 'Remove pin')));
  const S = {
    now: sec('now', 'Satellites over it now', 'fleet · elevation from the point'),
    passes: sec('passes', 'Next passes · 24 h', 'inside the instrument swath?'),
    gibs: sec('gibs', 'Daily imagery at this pixel', 'NASA GIBS'),
    s1: sec('s1', 'Sentinel-1 radar scenes', 'Planetary Computer'),
    opt: sec('opt', 'Optical scenes', 'Sentinel-2 · Landsat · HLS'),
    nisar: sec('nisar', 'NISAR granules', 'ASF DAAC'),
    swot: sec('swot', 'SWOT rivers nearby', 'NASA Earthdata'),
    events: sec('events', 'Earthquakes and ships nearby', 'USGS · AIS'),
    geo: sec('geo', 'Geostationary views', 'view zenith angle'),
  };
  card.replaceChildren(head, ...Object.values(S).map(s => s.box),
    el('div', { class: 'note small' }, 'Swath and pass geometry are computed in your browser from CelesTrak elements and the swath widths in the satellite facts; data listings come from the providers through the server (cached 1 h). Automatic, not validated.'));
  const key = `${c.lat},${c.lon}`;
  const still = () => P.cur && `${P.cur.lat},${P.cur.lon}` === key;
  setTimeout(() => { if (still()) { nowSection(S.now.body); P.timer = setInterval(() => { if (still() && S.now.body.isConnected) nowSection(S.now.body); else clearInterval(P.timer); }, 5000); } }, 20);
  setTimeout(() => still() && passSection(S.passes.body), 60);
  gibsSection(S.gibs.body);
  s1Section(S.s1.body);
  optSection(S.opt.body);
  nisarSection(S.nisar.body);
  swotSection(S.swot.body);
  eventsSection(S.events.body);
  geoSection(S.geo.body);
}

// 1. satellites over the point now
function nowSection(body) {
  const c = P.cur, og = obsOf(c.lat, c.lon), t = SAT.now();
  const rows = [], rep = [];
  for (const s of App.sats.sats.filter(x => x.fleet)) {
    const ss = SAT.satState(s, t); if (!ss) continue;
    const e = elev(og, ss.ecf);
    if (e <= 0) continue;
    const m = App.sats.missions[s.norad];
    let state = 'above the horizon', imaging = false, inst = null;
    if (s.cls === 'LEO' && m && m.swaths && m.swaths.length) {
      const s1 = SAT.satState(s, t + 10e3);
      const o = trackOffsets([ss.lat, ss.lon], [s1.lat, s1.lon], [c.lat, c.lon]);
      const w = swathHit(m, o.xt);
      if (w && Math.abs(o.at) <= 100) { imaging = true; inst = w.instrument; state = `imaging now (${w.instrument})`; }
      else state = `above the horizon · ${fmtNum(Math.abs(o.xt))} km off its track`;
    }
    rows.push({ s, e, state, imaging });
    rep.push({ norad: s.norad, name: s.short || s.name, elevation_deg: +e.toFixed(1), imaging_now: imaging, instrument: inst });
  }
  rows.sort((a, b) => (b.imaging - a.imaging) || (b.e - a.e));
  const kids = rows.length ? rows.map(r => row([el('span', { class: 'dot', style: { background: r.s.color } }), el('b', {}, r.s.short || r.s.name),
    el('span', { class: 'mono' }, `${r.e.toFixed(0)}°`), el('span', { class: r.imaging ? 'pt-ok' : 'muted' }, r.state)], () => SAT.select(r.s.norad), 'Select and follow')) : [note('No fleet satellite is above the horizon of this point right now.')];
  // all loaded satellites (e.g. "All active") above the horizon, capped
  const st = App.sats;
  if (st.sats.length > 60 && st.lastPos) {
    const p = C.Cartesian3.fromDegrees(c.lon, c.lat), up = C.Cartesian3.normalize(p, new C.Cartesian3());
    let n = 0; const top = [];
    for (let i = 0; i < st.sats.length; i++) {
      const x = st.lastPos[i * 3]; if (isNaN(x)) continue;
      const dx = x - p.x, dy = st.lastPos[i * 3 + 1] - p.y, dz = st.lastPos[i * 3 + 2] - p.z, dd = Math.hypot(dx, dy, dz);
      const e = Math.asin((dx * up.x + dy * up.y + dz * up.z) / dd) / rad;
      if (e > 0) { n++; if (e > 30) top.push([e, st.sats[i]]); }
    }
    top.sort((a, b) => b[0] - a[0]);
    kids.push(note(`All ${fmtNum(st.sats.length)} loaded satellites: ${fmtNum(n)} above the horizon now, ${fmtNum(top.length)} higher than 30°${top.length ? ' (highest 8 below)' : ''}.`));
    top.slice(0, 8).forEach(([e, s]) => kids.push(row([el('span', { class: 'dot', style: { background: s.color } }), el('span', {}, s.name), el('span', { class: 'mono' }, `${e.toFixed(0)}°`)], () => SAT.select(s.norad))));
    P.report.sections.now_all = { loaded: st.sats.length, above_horizon: n, above_30deg: top.length };
  }
  P.report.sections.now = { t: new Date(t).toISOString(), satellites: rep };
  body.replaceChildren(...kids);
}

// 2. next passes in 24 h, with the swath test at closest approach
function passSection(body) {
  const c = P.cur, og = obsOf(c.lat, c.lon), t0 = SAT.now(), end = t0 + 86400e3, step = 20e3;
  const sats = App.sats.sats.filter(s => s.fleet && s.cls === 'LEO');
  const out = [];
  let k = 0;
  const one = () => {
    if (!P.cur || P.cur.lat !== c.lat || P.cur.lon !== c.lon) return;
    const s = sats[k++];
    if (s) {
      const m = App.sats.missions[s.norad];
      let cur = null;
      for (let t = t0; t < end; t += step) {
        const ss = SAT.satState(s, t); if (!ss) break;
        const e = elev(og, ss.ecf);
        if (e > 0) { if (!cur) cur = { s, rise: t, max: e, peak: t }; if (e > cur.max) { cur.max = e; cur.peak = t; } }
        else if (cur) { cur.set = t; out.push(finish(cur, m, og, c)); cur = null; }
      }
      if (cur) { cur.set = null; out.push(finish(cur, m, og, c)); }
      setTimeout(one, 0);
      return;
    }
    out.sort((a, b) => a.rise - b.rise);
    const hits = out.filter(p => p.inside);
    P.report.sections.passes = out.map(p => ({ norad: p.s.norad, name: p.s.short || p.s.name, rise: iso(p.rise), peak: iso(p.peak), set: p.set ? iso(p.set) : null,
      max_elevation_deg: +p.max.toFixed(1), cross_track_km: Math.round(Math.abs(p.xt)), inside_swath: p.inside ? p.inside.instrument : null, sun_elevation_deg: +p.sun.toFixed(0) }));
    if (!out.length) { body.replaceChildren(note('No fleet satellite in low orbit rises above this point in the next 24 h.')); return; }
    const filt = el('label', { class: 'chk small' }, el('input', { type: 'checkbox', checked: store.get('ptInside', true), onchange: e => { store.set('ptInside', e.target.checked); draw(); } }), ' only passes that image this point');
    const tbl = el('div', { class: 'pt-list' });
    const draw = () => {
      const only = store.get('ptInside', true);
      const list = (only ? hits : out).slice(0, 40);
      tbl.replaceChildren(...(list.length ? list.map(p => row([el('span', { class: 'dot', style: { background: p.s.color } }), el('b', {}, p.s.short || p.s.name),
        el('span', { class: 'mono' }, `${hm(p.rise)}–${p.set ? hm(p.set) : '…'}`), el('span', { class: 'mono' }, `${p.max.toFixed(0)}°`),
        p.inside ? el('span', { class: 'pt-ok' }, `in swath · ${p.inside.instrument}${p.sun > 0 ? ' · day' : ' · night'}`) : el('span', { class: 'muted' }, `${fmtNum(Math.abs(p.xt))} km off track`)],
        () => { SAT.select(p.s.norad); }, `Peak ${fmtUTC(p.peak)} · closest approach ${fmtNum(Math.abs(p.xt))} km from the ground track`)) : [note('None in the next 24 h. Untick to see every pass above the horizon.')]));
    };
    draw();
    body.replaceChildren(note(`${hits.length} of ${out.length} passes in the next 24 h put this point inside an instrument swath (times UTC: rise–set, max elevation).`), filt, tbl);
  };
  setTimeout(one, 0);
}
const hm = t => new Date(t).toISOString().slice(11, 16);
const iso = t => new Date(t).toISOString().slice(0, 19) + 'Z';
function finish(p, m, og, c) {
  // closest approach to the point near the peak (ternary search on the ground distance), then the swath test
  let a = p.peak - 20e3, b = p.peak + 20e3;
  const dist = t => { const ss = SAT.satState(p.s, t); return ss ? hav(ss.lat, ss.lon, c.lat, c.lon) : 1e9; };
  for (let i = 0; i < 24; i++) { const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3; if (dist(m1) < dist(m2)) b = m2; else a = m1; }
  const tc = (a + b) / 2;
  const s0 = SAT.satState(p.s, tc), s1 = SAT.satState(p.s, tc + 10e3);
  const o = trackOffsets([s0.lat, s0.lon], [s1.lat, s1.lon], [c.lat, c.lon]);
  p.xt = o.xt; p.inside = swathHit(m, o.xt); p.tc = tc; p.sun = sunElev(og, tc);
  return p;
}

// 3a. GIBS daily layers: read the pixel under the point from one tile at a moderate zoom
function gibsSection(body) {
  const S = App.layers;
  // default: yesterday (UTC) — today's polar-orbiter swaths are still arriving; the picker changes it
  const today = ymd(new Date()), date = S.date && S.date < today ? S.date : ymd(new Date(Date.now() - 864e5));
  const ids = [...GIBS_TEST, ...(S.science ? [S.science] : [])].filter((x, i, a) => a.indexOf(x) === i).map(id => S.byId[id]).filter(L => L && L.available && L.tms);
  if (!ids.length) { emptyState(body, 'The GIBS layer catalogue is not loaded yet.'); return; }
  const dateIn = el('input', { type: 'date', class: 'input small', value: date, max: ymd(new Date()), min: '2000-03-01', 'aria-label': 'date' });
  const list = el('div', { class: 'pt-list' });
  const run = () => {
    const d = dateIn.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    skeleton(list, ids.length);
    Promise.all(ids.map(L => pixel(L, d).then(r => ({ L, ...r })).catch(e => ({ L, err: e.message })))).then(res => {
      P.report.sections.gibs = { date: d, layers: res.map(r => ({ id: r.L.id, title: r.L.title, has_data: r.err ? null : r.has, rgba: r.rgba || null })) };
      list.replaceChildren(...res.map(r => row([el('span', { class: 'dot', style: { background: r.err ? 'var(--muted)' : r.has ? 'var(--ok)' : '#5a5f68' } }), el('span', {}, r.L.title),
        el('span', { class: r.has ? 'pt-ok' : 'muted' }, r.err ? 'unavailable' : r.has ? 'data at this pixel' : 'no data (outside the swath or not processed)')],
        () => { IM.setDate(d); App.showLayerFor(r.L.id); setTimeout(() => flyPoint(1.2e6), 50); }, 'Show this layer for that date')));
    });
  };
  dateIn.addEventListener('change', run);
  body.replaceChildren(el('div', { class: 'row small' }, el('span', { class: 'muted' }, 'Date (UTC)'), dateIn), list,
    note('One GIBS tile at ~1 km per pixel is read in your browser; black or transparent = no data.'));
  run();
}
function pixel(L, date) {
  const c = P.cur;
  const z = Math.min(TMS_MAX[L.tms] ?? 5, 6);
  const span = 288 / 2 ** z;
  const col = Math.floor((c.lon + 180) / span), rw = Math.floor((90 - c.lat) / span);
  const px = Math.min(511, Math.floor(((c.lon + 180) - col * span) / span * 512)), py = Math.min(511, Math.floor(((90 - c.lat) - rw * span) / span * 512));
  const ext = (L.format || '').includes('png') ? 'png' : 'jpg';
  const t = L.time === 'none' ? 'default' : L.time === 'fixed' ? L.fixed : date;
  const url = `${GIBS_WMTS}/${L.id}/default/${t}/${L.tms}/${z}/${rw}/${col}.${ext}`;
  return new Promise((res, rej) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => rej(new Error('timeout')), 20000);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const cv = document.createElement('canvas'); cv.width = 5; cv.height = 5;
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, px - 2, py - 2, 5, 5, 0, 0, 5, 5);
        const d = g.getImageData(0, 0, 5, 5).data;
        let has = 0, rgba = null;
        for (let i = 0; i < d.length; i += 4) { const ok = d[i + 3] > 8 && (d[i] + d[i + 1] + d[i + 2]) > 12; if (ok) { has++; if (i === 48) rgba = [d[i], d[i + 1], d[i + 2], d[i + 3]]; } }
        res({ has: has >= 13, rgba });
      } catch (e) { rej(new Error('pixel read blocked')); }
    };
    img.onerror = () => { clearTimeout(timer); res({ has: false }); }; // GIBS answers 400/404 outside a layer's domain
    img.src = url;
  });
}

// 3b. Sentinel-1 RTC scenes over the point
async function s1Section(body) {
  const c = P.cur;
  try {
    const { body: d } = await getJSON(`/api/point/stac?collection=sentinel-1-rtc&lat=${c.lat}&lon=${c.lon}`);
    P.report.sections.sentinel1 = d.scenes.map(s => ({ id: s.id, datetime: s.dt, platform: s.platform, orbit: s.dir, relative_orbit: s.rel }));
    if (!d.scenes.length) { body.replaceChildren(note(`No Sentinel-1 RTC scene covers this point since ${d.from.slice(0, 10)}.`)); return; }
    body.replaceChildren(note(`Newest ${d.scenes.length} scenes covering the point since ${d.from.slice(0, 10)} (tap to show the radar scene):`),
      el('div', { class: 'pt-list' }, d.scenes.map(s => row([el('span', { class: 'dot', style: { background: FAMILY.radar } }), el('span', { class: 'mono' }, fmtUTC(s.dt)),
        el('span', {}, `${(s.platform || '').replace('sentinel-', 'S')} · ${s.dir === 'ascending' ? 'asc' : 'desc'} · rel ${s.rel}`)],
        () => RD.showScene(s, c.lat, c.lon), s.id))));
  } catch (e) { fail(body, 'sentinel1', e); }
}

// 3c. optical scenes (Sentinel-2 L2A, Landsat C2 L2, HLS) over the point
async function optSection(body) {
  const c = P.cur;
  const parts = Object.entries(OPT).map(([coll, o]) => { const b = el('div', { class: 'pt-list' }); skeleton(b, 1); return { coll, o, b }; });
  body.replaceChildren(...parts.flatMap(p => [el('div', { class: 'pt-h2' }, p.o.title), p.b]), note('Cloud cover is the scene’s own estimate. Tap a scene to show it (Planetary Computer “Natural color” render); tap again to hide.'));
  P.report.sections.optical = {};
  for (const p of parts) {
    try {
      const { body: d } = await getJSON(`/api/point/stac?collection=${p.coll}&lat=${c.lat}&lon=${c.lon}`);
      P.report.sections.optical[p.coll] = d.scenes.map(s => ({ id: s.id, datetime: s.dt, platform: s.platform, cloud_cover: s.cloud }));
      if (!d.scenes.length) { p.b.replaceChildren(note(`none since ${d.from.slice(0, 10)}`)); continue; }
      p.b.replaceChildren(...d.scenes.slice(0, 8).map(s => row([el('span', { class: 'dot', style: { background: (s.cloud ?? 100) < 20 ? 'var(--ok)' : (s.cloud ?? 100) < 60 ? GOLD : '#5a5f68' } }),
        el('span', { class: 'mono' }, s.dt.slice(0, 10)), el('span', {}, `${(s.platform || '').replace('sentinel-', 'S').replace('landsat-', 'L')}`),
        el('span', { class: 'mono muted' }, s.cloud === null || s.cloud === undefined ? 'cloud ?' : `${Math.round(s.cloud)}% cloud`)], () => showOptical(p.coll, s), s.id)));
    } catch (e) { p.b.replaceChildren(note(`unavailable (${e.message})`)); P.report.sections.optical[p.coll] = { error: e.message }; }
  }
}
function showOptical(coll, s) {
  if (P.overlayInfo && P.overlayInfo.id === s.id) { clearOptical(); toast('Scene hidden'); return; }
  clearOptical();
  const o = OPT[coll], b = s.bbox;
  const prov = new C.UrlTemplateImageryProvider({
    url: `/api/point/tile?collection=${coll}&item=${encodeURIComponent(s.id)}&z={z}&x={x}&y={y}`, tilingScheme: new C.WebMercatorTilingScheme(),
    minimumLevel: o.minZ, maximumLevel: 14, rectangle: b && b.length === 4 ? C.Rectangle.fromDegrees(b[0], b[1], b[2], b[3]) : undefined, credit: new C.Credit(o.credit),
  });
  prov.errorEvent.addEventListener(() => { });
  P.overlay = App.viewer.imageryLayers.add(new C.ImageryLayer(prov));
  P.overlayInfo = { id: s.id, coll, dt: s.dt, credit: o.credit };
  IM.raiseRefLayers && IM.raiseRefLayers();
  App.events.dispatchEvent(new Event('layers'));
  flyPoint(60e3);
  toast(`${o.title} · ${s.dt.slice(0, 10)} (zoom in below ~${o.minZ === 9 ? 600 : 1200} km to load it)`, 5000);
}

// 3d. NISAR granules whose footprint contains the point (ASF SearchAPI)
async function nisarSection(body) {
  const c = P.cur;
  try {
    const { body: d } = await getJSON(`/api/point/nisar?lat=${c.lat}&lon=${c.lon}`);
    P.report.sections.nisar = { total: d.total, by_type: d.by_type, granules: d.granules.map(g => ({ id: g.gn, type: g.pt, start: g.st, track: g.path, frame: g.frame, direction: g.dir, footprint: g.geom && g.geom[0] })) };
    if (!d.total) { body.replaceChildren(note(`No NISAR granule covers this point since ${d.from.slice(0, 10)}.`)); return; }
    const types = Object.entries(d.by_type).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(' · ');
    body.replaceChildren(note(`${d.total} granules since ${d.from.slice(0, 10)}: ${types}. Newest:`),
      el('div', { class: 'pt-list' }, d.granules.slice(0, 12).map(g => row([el('span', { class: 'tag', style: { '--c': FAMILY.radar } }, g.pt), el('span', { class: 'mono' }, fmtUTC(g.st)),
        el('span', { class: 'muted' }, `track ${g.path} · frame ${g.frame} · ${g.dir === 'A' ? 'asc' : 'desc'}`)], () => showNisar(g), g.gn))),
      note('Footprints and browse images need no login; downloads need a free NASA Earthdata account.'));
  } catch (e) { fail(body, 'nisar', e); }
}
async function showNisar(g) {
  clearExtra();
  const v = App.viewer, ents = [];
  P.extra = { ents };
  if (g.geom && g.geom[0]) ents.push(v.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArray(g.geom[0].flat()), width: 2, material: C.Color.fromCssColorString(FAMILY.radar), arcType: C.ArcType.GEODESIC } }));
  if (g.browse && g.geom && g.geom[0]) {
    const lons = g.geom[0].map(p => p[0]), lats = g.geom[0].map(p => p[1]);
    try {
      const prov = await C.SingleTileImageryProvider.fromUrl(g.browse, { rectangle: C.Rectangle.fromDegrees(Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)), credit: 'NISAR browse: NASA/JPL-Caltech, ISRO; ASF DAAC' });
      const layer = new C.ImageryLayer(prov, { alpha: 0.92 }); layer.colorToAlpha = C.Color.BLACK; layer.colorToAlphaThreshold = 0.02;
      if (P.extra && P.extra.ents === ents) { P.extra.layer = v.imageryLayers.add(layer); P.extra.credit = 'NISAR browse: NASA/JPL-Caltech, ISRO via ASF DAAC'; App.events.dispatchEvent(new Event('layers')); }
    } catch (e) { toast('Browse image could not be loaded'); }
  }
  const pts = g.geom && g.geom[0] ? C.Cartesian3.fromDegreesArray(g.geom[0].flat()) : null;
  if (pts) { const bs = C.BoundingSphere.fromPoints(pts); App.flyTo({ type: 'sphere', center: bs.center, radius: bs.radius * 1.4, force: true, reason: 'NISAR' }); }
  toast(`NISAR ${g.pt} · ${fmtUTC(g.st)} · track ${g.path} frame ${g.frame}`, 5000);
  requestRender();
}

// 3e. SWOT: reaches near the point (NASA Earthdata GIS, keyless) + the nearest curated reach or lake
async function swotSection(body) {
  const c = P.cur;
  const kids = [];
  const cur = (App.data.swot.list || []).map(f => {
    const g = f.geometry; const pts = g ? (g.type === 'LineString' ? g.coordinates : g.type === 'Polygon' ? g.coordinates[0] : g.type === 'Point' ? [g.coordinates] : []) : [];
    let d = 1e9; for (const p of pts) d = Math.min(d, hav(c.lat, c.lon, p[1], p[0]));
    if (!pts.length && f.hydrocron_p_latlon) d = hav(c.lat, c.lon, f.hydrocron_p_latlon[0], f.hydrocron_p_latlon[1]);
    return { f, d };
  }).sort((a, b) => a.d - b.d)[0];
  try {
    const { body: d } = await getJSON(`/api/point/swot?lat=${c.lat}&lon=${c.lon}&km=10`);
    P.report.sections.swot = { within_km: d.km, reaches: d.reaches, nearest_curated: cur ? { name: cur.f.name, id: cur.f.id, km: Math.round(cur.d) } : null };
    if (d.reaches.length) {
      kids.push(note(`SWOT river reaches within ${d.km} km (SWORD reach id, last valid pass, water-surface elevation):`),
        el('div', { class: 'pt-list' }, d.reaches.map(r => row([el('span', { class: 'dot', style: { background: FAMILY.water } }), el('span', {}, r.name && r.name !== 'no_data' ? r.name : 'unnamed reach'),
          el('span', { class: 'mono muted' }, r.id), el('span', { class: 'mono' }, `${r.dist_km ?? '?'} km`),
          el('span', { class: 'mono' }, r.latest ? `${r.latest.slice(0, 10)}${r.latest_wse !== null ? ` · ${r.latest_wse.toFixed(2)} m` : ''}` : 'no valid pass')],
          () => { const k = `Reach:${r.id}`; if (D.swotFeature(k)) D.selectSwot(k); else { flyPoint(80e3); toast('Not in the curated list: the 12-month series is shown only for curated reaches'); } }))));
    } else kids.push(note(`No SWOT river reach within ${d.km} km in NASA's RiverSP feature service (lakes are not searched).`));
  } catch (e) { kids.push(note(`SWOT reach search unavailable (${e.message}).`)); P.report.sections.swot = { error: e.message }; }
  if (cur) kids.push(row([el('span', { class: 'dot', style: { background: FAMILY.water } }), el('span', {}, `Nearest curated: ${cur.f.name}`), el('span', { class: 'mono' }, `${fmtNum(cur.d)} km`)],
    () => D.selectSwot(`${cur.f.type}:${cur.f.id}`), 'Open its 12-month water-height chart'));
  body.replaceChildren(...kids);
}

// 3f. earthquakes within 300 km (7 days, M2.5+) and ships within 50 km (with an aisstream key)
async function eventsSection(body) {
  const c = P.cur;
  const kids = [];
  try {
    const { body: d } = await getJSON('/api/quakes?feed=2.5_week');
    const since = Date.now() - 7 * 864e5;
    const q = (d.features || []).map(f => ({ f, km: hav(c.lat, c.lon, f.geometry.coordinates[1], f.geometry.coordinates[0]) })).filter(x => x.km <= 300 && x.f.properties.time >= since).sort((a, b) => b.f.properties.time - a.f.properties.time);
    P.report.sections.quakes = q.map(x => ({ id: x.f.id, mag: x.f.properties.mag, place: x.f.properties.place, time: new Date(x.f.properties.time).toISOString(), km: Math.round(x.km), lon: x.f.geometry.coordinates[0], lat: x.f.geometry.coordinates[1] }));
    kids.push(el('div', { class: 'pt-h2' }, `Earthquakes M2.5+ within 300 km, last 7 days: ${q.length}`));
    q.slice(0, 8).forEach(x => kids.push(row([el('span', { class: 'dot', style: { background: FAMILY.quake } }), el('b', {}, `M${x.f.properties.mag?.toFixed(1)}`), el('span', {}, x.f.properties.place || ''),
      el('span', { class: 'mono muted' }, `${fmtNum(x.km)} km · ${fmtAgo(Date.now() - x.f.properties.time)} ago`)], () => {
      const [lon, lat] = x.f.geometry.coordinates;
      if (App.data.quakes.features.some(f => f.id === x.f.id)) D.selectQuake(x.f.id); else App.flyTo({ type: 'region', lon, lat, h: 1.2e6, force: true, reason: 'quake' });
    })));
  } catch (e) { kids.push(note(`Earthquakes unavailable (${e.message}).`)); }
  try {
    const dl = 0.5, dn = 0.5 / Math.max(0.1, Math.cos(c.lat * rad));
    const bb = [Math.max(-180, c.lon - dn), Math.max(-90, c.lat - dl), Math.min(180, c.lon + dn), Math.min(90, c.lat + dl)].map(x => x.toFixed(4)).join(',');
    const { body: d } = await getJSON(`/api/ships?bbox=${bb}`);
    if (d.enabled === false) kids.push(note('Ships: off (add an aisstream.io key to the server’s keys file to list ships within 50 km).'));
    else {
      const sh = (d.ships || []).map(s => ({ s, km: hav(c.lat, c.lon, s[1], s[2]) })).filter(x => x.km <= 50).sort((a, b) => a.km - b.km);
      P.report.sections.ships = { within_km: 50, count: sh.length };
      kids.push(el('div', { class: 'pt-h2' }, `AIS ships within 50 km, last 30 min: ${sh.length}`));
      sh.slice(0, 6).forEach(x => kids.push(row([el('span', { class: 'dot', style: { background: FAMILY.ship } }), el('span', { class: 'mono' }, `MMSI ${x.s[0]}`), el('span', {}, x.s[6]), el('span', { class: 'mono muted' }, `${x.km.toFixed(1)} km`)], () => D.selectShip(x.s[0]))));
    }
  } catch (e) { kids.push(note(`Ships unavailable (${e.message}).`)); }
  body.replaceChildren(...kids);
}

// 3g. geostationary disks: inside or not, and the view zenith angle
function geoSection(body) {
  const c = P.cur, og = obsOf(c.lat, c.lon);
  const rows = GEO.map(g => {
    let lon = g.lon;
    const s = g.norad && SAT.findSat(g.norad);
    if (s) { const ss = SAT.satState(s, SAT.now()); if (ss && Math.abs(ss.lat) < 2) lon = ss.lon; }
    const ecf = { x: 42164 * Math.cos(lon * rad), y: 42164 * Math.sin(lon * rad), z: 0 };
    const e = elev(og, ecf), vza = 90 - e;
    const q = e <= 0 ? 'outside the disk' : vza > 70 ? 'poor (limb)' : vza > 60 ? 'fair' : 'good';
    return { g, lon, e, vza, q };
  });
  P.report.sections.geostationary = rows.map(r => ({ name: r.g.name, satellite: r.g.sat, sub_lon: +r.lon.toFixed(2), inside_disk: r.e > 0, view_zenith_deg: r.e > 0 ? +r.vza.toFixed(1) : null, quality: r.q, gibs_layer: r.g.layer }));
  body.replaceChildren(...rows.map(r => row([el('span', { class: 'dot', style: { background: r.e > 0 ? (r.vza > 70 ? GOLD : 'var(--ok)') : '#5a5f68' } }), el('b', {}, r.g.name),
    el('span', { class: 'muted' }, `${r.g.sat} · ${Math.abs(r.lon).toFixed(1)}°${r.lon < 0 ? 'W' : 'E'}`),
    el('span', { class: 'mono' }, r.e > 0 ? `VZA ${r.vza.toFixed(0)}° · ${r.q}` : 'outside the disk')],
    () => { if (r.e > 0) App.showLayerFor(r.g.layer); else toast(`${r.g.name} cannot see this point`); }, 'Show its near-real-time imagery')),
    note('Meteosat (Europe, Africa, Indian Ocean) has no NASA GIBS layer, so it is not listed. View zenith above 70° gives strongly distorted pixels.'));
}

// ---------------------------------------------------------------- export
function markdown() {
  const r = P.report, s = r.sections, L = [];
  L.push(`# Point report — ${r.name}`, '', `- Point: ${fmtLL(r.lat, r.lon)} (${dms(r.lat, 'N', 'S')} ${dms(r.lon, 'E', 'W')})`, `- Generated: ${r.generated} by Lion Satellite Studio`, '');
  if (s.now) { L.push('## Satellites over it now', ''); s.now.satellites.forEach(x => L.push(`- ${x.name} (NORAD ${x.norad}): elevation ${x.elevation_deg}°${x.imaging_now ? `, imaging now (${x.instrument})` : ''}`)); if (!s.now.satellites.length) L.push('- none above the horizon'); L.push(''); }
  if (s.passes) { L.push('## Next passes (24 h, UTC)', '', '| Satellite | Rise | Set | Max el | Inside swath |', '|---|---|---|---|---|'); s.passes.forEach(p => L.push(`| ${p.name} | ${p.rise.slice(5, 16).replace('T', ' ')} | ${p.set ? p.set.slice(11, 16) : '—'} | ${p.max_elevation_deg}° | ${p.inside_swath ? `yes (${p.inside_swath}), ${p.sun_elevation_deg > 0 ? 'day' : 'night'}` : `no (${p.cross_track_km} km off track)`} |`)); L.push(''); }
  if (s.gibs) { L.push(`## NASA GIBS imagery at this pixel (${s.gibs.date})`, ''); s.gibs.layers.forEach(x => L.push(`- ${x.title}: ${x.has_data === null ? 'unavailable' : x.has_data ? 'data' : 'no data'}`)); L.push(''); }
  if (s.sentinel1) { L.push('## Sentinel-1 RTC scenes', ''); s.sentinel1.forEach(x => L.push(`- ${x.datetime.slice(0, 16)} ${x.platform} ${x.orbit} rel ${x.relative_orbit} — ${x.id}`)); L.push(''); }
  if (s.optical) { L.push('## Optical scenes', ''); for (const [k, v] of Object.entries(s.optical)) { L.push(`### ${OPT[k].title}`); (Array.isArray(v) ? v : []).forEach(x => L.push(`- ${x.datetime.slice(0, 10)} ${x.platform} ${x.cloud_cover === null || x.cloud_cover === undefined ? '' : Math.round(x.cloud_cover) + '% cloud'} — ${x.id}`)); } L.push(''); }
  if (s.nisar) { L.push(`## NISAR granules (${s.nisar.total})`, ''); s.nisar.granules.slice(0, 12).forEach(x => L.push(`- ${x.start} ${x.type} track ${x.track} frame ${x.frame} — ${x.id}`)); L.push(''); }
  if (s.swot && !s.swot.error) { L.push('## SWOT', ''); s.swot.reaches.forEach(x => L.push(`- reach ${x.id} ${x.name || ''}: ${x.dist_km} km, last pass ${x.latest || '—'}`)); if (s.swot.nearest_curated) L.push(`- nearest curated: ${s.swot.nearest_curated.name} (${s.swot.nearest_curated.km} km)`); L.push(''); }
  if (s.quakes) { L.push('## Earthquakes M2.5+ within 300 km, 7 days', ''); s.quakes.forEach(x => L.push(`- M${x.mag} ${x.place} ${x.time} (${x.km} km)`)); if (!s.quakes.length) L.push('- none'); L.push(''); }
  if (s.geostationary) { L.push('## Geostationary views', ''); s.geostationary.forEach(x => L.push(`- ${x.name} (${x.satellite}): ${x.inside_disk ? `view zenith ${x.view_zenith_deg}°, ${x.quality}` : 'outside the disk'}`)); L.push(''); }
  L.push('Sources: CelesTrak, NASA GIBS, Microsoft Planetary Computer (Copernicus Sentinel-1/-2, USGS Landsat, NASA HLS), ASF DAAC (NISAR), NASA Earthdata GIS / PO.DAAC (SWOT), USGS. Automatic, not validated.');
  return L.join('\n');
}
async function copyReport() {
  const md = markdown();
  try { await navigator.clipboard.writeText(md); toast('Report copied as Markdown'); }
  catch (e) { const ta = el('textarea', { style: { position: 'fixed', left: '-9999px' } }); ta.value = md; document.body.append(ta); ta.select(); try { document.execCommand('copy'); toast('Report copied as Markdown'); } catch (e2) { toast('Copy is blocked here — use Download GeoJSON'); } ta.remove(); }
}
function downloadGeoJSON() {
  const r = P.report, s = r.sections, feats = [{ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: { name: r.name, generated: r.generated, report: s } }];
  for (const q of s.quakes || []) feats.push({ type: 'Feature', geometry: q.lon !== undefined ? { type: 'Point', coordinates: [q.lon, q.lat] } : null, properties: { kind: 'earthquake', ...q } });
  for (const g of (s.nisar && s.nisar.granules) || []) feats.push({ type: 'Feature', geometry: g.footprint ? { type: 'Polygon', coordinates: [g.footprint] } : null, properties: { kind: 'nisar', ...g, footprint: undefined } });
  const blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features: feats }, null, 1)], { type: 'application/geo+json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `point-report-${r.lat}_${r.lon}.geojson` });
  document.body.append(a); a.click(); a.remove();
}
async function shareLink() {
  const c = P.cur, url = `${location.origin}${location.pathname}#pt=${c.lat},${c.lon}`;
  try { await navigator.clipboard.writeText(url); toast('Share link copied'); } catch (e) { toast(url, 8000); }
}

// ---------------------------------------------------------------- inputs: panel box, right-click / long-press, my location
export function buildPointUI(box) {
  const inp = el('input', { class: 'input', placeholder: '37.8199, -122.4783 · 40°26′46″N 79°58′56″W · a city', list: 'place-list', 'aria-label': 'coordinates or place' });
  const go = () => {
    const r = resolveInput(inp.value);
    if (!r) { toast('Type “lat, lon” (decimal or degrees-minutes-seconds) or a place from the built-in gazetteer'); return; }
    lookup(r.lat, r.lon, { name: r.name });
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  const me = el('button', { class: 'btn small', onclick: () => {
    if (!navigator.geolocation) { toast('Geolocation is not available here'); return; }
    navigator.geolocation.getCurrentPosition(p => lookup(p.coords.latitude, p.coords.longitude, { name: 'your location' }),
      () => toast('Location not shared (browsers allow it only on https:// or localhost)'), { timeout: 10000, maximumAge: 600000 });
  } }, 'My location');
  box.replaceChildren(el('div', { class: 'row' }, inp, el('button', { class: 'btn gold small', onclick: go }, 'Look up')), el('div', { class: 'row' }, me),
    el('div', { class: 'hint' }, App.isPhone() ? 'Or long-press the globe. ' : 'Or right-click the globe. ', 'The Point report lists the satellites over the point now, the next passes that image it, and the imagery and products that already exist for that exact spot.'));
}
export function setupPointPicking() {
  const v = App.viewer, s = App.scene, canvas = s.canvas;
  const at = pos => { const ray = v.camera.getPickRay(pos); const p = ray && s.globe.pick(ray, s); if (!p) return null; const g = C.Cartographic.fromCartesian(p); return { lat: C.Math.toDegrees(g.latitude), lon: C.Math.toDegrees(g.longitude) }; };
  const h = new C.ScreenSpaceEventHandler(canvas);
  h.setInputAction(e => { if (App.drawing) return; const p = at(e.position); if (p) lookup(p.lat, p.lon, { fly: false }); }, C.ScreenSpaceEventType.RIGHT_CLICK);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  let t = null, x0 = 0, y0 = 0;
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || App.drawing) return;
    x0 = e.clientX; y0 = e.clientY; clearTimeout(t);
    t = setTimeout(() => { const r = canvas.getBoundingClientRect(); const p = at(new C.Cartesian2(x0 - r.left, y0 - r.top)); if (p) { navigator.vibrate?.(15); lookup(p.lat, p.lon, { fly: false }); } }, 650);
  }, { passive: true });
  const cancel = e => { if (t && (!e || e.type !== 'pointermove' || Math.hypot(e.clientX - x0, e.clientY - y0) > 10)) { clearTimeout(t); t = null; } };
  canvas.addEventListener('pointermove', cancel, { passive: true });
  canvas.addEventListener('pointerup', () => cancel(), { passive: true });
  canvas.addEventListener('pointercancel', () => cancel(), { passive: true });
  App.pickHandlers = App.pickHandlers || {};
  App.pickHandlers.point = () => { if (P.cur) App.selectItem({ kind: 'point', id: `${P.cur.lat},${P.cur.lon}`, title: P.cur.label, family: 'gold', layer: 'Point report', render: renderReport, onClear: () => clearInterval(P.timer) }); };
  App.tipHandlers = App.tipHandlers || {};
  App.tipHandlers.point = () => P.cur ? `<b>Point report</b> <span class="sub">${fmtLL(P.cur.lat, P.cur.lon)} · tap to reopen</span>` : null;
}
// credits for what the Point report put on the globe (an optical scene, a NISAR browse image)
export function opticalCredit() { return [P.overlayInfo && P.overlayInfo.credit, P.extra && P.extra.credit].filter(Boolean).join(' · ') || null; }
