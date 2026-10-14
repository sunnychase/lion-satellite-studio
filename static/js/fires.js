// Lion Satellite Studio — Created by Sunny Chase (https://github.com/sunnychase) in collaboration with Claude (Anthropic)
// NASA FIRMS active fires as points: every VIIRS 375 m hotspot of the last 24 hours (Suomi NPP, NOAA-20, NOAA-21) from
// FIRMS's public, keyless 24 h CSV files, fetched and cached by the server (/api/fires). One PointPrimitiveCollection,
// built in slices so tens of thousands of points never block the page; colour = time since detection, size = FRP.
// Idea from gods-eye-view (Bilawal Sidhu, Sameh Khamis / Halfpixel, MIT), written anew for this app.
import { App, $, el, getJSON, store, fmtAgo, fmtUTC, fmtNum, requestRender, FAMILY, skeleton, emptyState, chip, tick } from './util.js';
import { toggle } from './imagery.js';

const C = window.Cesium;
const F = App.data.fires = { on: store.get('firms', false), body: null, rows: [], prim: null, timer: null, gen: 0, shown: 0 };
const CONF = ['low', 'nominal', 'high'];
const SLICE = 6000;                                   // points added per slice (one slice per macrotask)
export const firesCap = () => App.lowMem || App.isPhone() ? 20000 : 60000;   // the server serves 20000, 60000 or 150000

// colour by age: newest bright yellow-white, then orange, red, and dim dark red after a day
const STOPS = [[0, '#fff6b0', 1.0], [3, '#ffd23f', 0.95], [8, '#ff8a1f', 0.85], [16, '#e0461f', 0.7], [24, '#8f2a17', 0.5], [30, '#5e1c10', 0.4]];
const PALETTE = [];
for (let h = 0; h <= 30; h++) {
  let i = 0; while (i < STOPS.length - 2 && h > STOPS[i + 1][0]) i++;
  const [h0, c0, a0] = STOPS[i], [h1, c1, a1] = STOPS[i + 1], f = Math.max(0, Math.min(1, (h - h0) / (h1 - h0)));
  PALETTE.push(C.Color.lerp(C.Color.fromCssColorString(c0), C.Color.fromCssColorString(c1), f, new C.Color()).withAlpha(a0 + (a1 - a0) * f));
}
const ageColor = ageH => PALETTE[Math.max(0, Math.min(30, Math.floor(ageH)))];
const frpSize = frp => Math.max(3, Math.min(11, 3 + 2.4 * Math.log10(1 + Math.max(0, frp))));

async function load() {
  const box = $('#fires-info');
  if (!F.on) return;
  if (box && !F.body) skeleton(box, 2);
  try {
    const { body, fetched } = await getJSON(`/api/fires?limit=${firesCap()}`);
    if (!F.on) return;
    F.body = body; F.rows = body.rows || []; F.fetched = fetched;
    draw();
    renderInfo();
  } catch (e) {
    if (box) emptyState(box, `NASA FIRMS is unavailable right now (${e.message})`, e.retry || 900);
    chip('fires', 'fires unavailable', 'bad', e.message);
    clearTimeout(F.retry); F.retry = setTimeout(load, Math.max(60, e.retry || 900) * 1000);
  }
}

function clearPrim() { if (F.prim) { App.scene.primitives.remove(F.prim); F.prim = null; } F.shown = 0; }
function draw() {
  const gen = ++F.gen;
  clearPrim();
  if (!F.on || !F.rows.length) { requestRender(); return; }
  const prim = F.prim = App.scene.primitives.add(new C.PointPrimitiveCollection({ blendOption: C.BlendOption.TRANSLUCENT }));
  const rows = F.rows, nowMin = Date.now() / 60000, sbd = new C.NearFarScalar(1.5e5, 1.4, 1.2e7, 0.45);
  const outline = C.Color.BLACK.withAlpha(0.35);
  let i = 0;
  const slice = () => {
    if (gen !== F.gen) return;                       // a newer draw (or off) took over
    const end = Math.min(rows.length, i + SLICE);
    for (; i < end; i++) {
      const r = rows[i];
      prim.add({ position: C.Cartesian3.fromDegrees(r[1], r[0], 300), pixelSize: frpSize(r[3]), color: ageColor((nowMin - r[2]) / 60),
        outlineColor: outline, outlineWidth: 0.5, scaleByDistance: sbd, disableDepthTestDistance: 2e6, id: { kind: 'fire', id: i } });
    }
    F.shown = i;
    requestRender();
    if (i < rows.length) setTimeout(slice, 0);
  };
  slice();
}

function renderInfo() {
  const box = $('#fires-info'), b = F.body;
  if (!box || !b) return;
  const nowMin = Date.now() / 60000, rows = F.rows;
  const per = {}; let newest = null, top = null;
  for (const r of rows) { per[r[6]] = (per[r[6]] || 0) + 1; if (newest === null || r[2] > newest) newest = r[2]; if (!top || r[3] > top[3]) top = r; }
  const last6 = rows.filter(r => nowMin - r[2] <= 360).length;
  chip('fires', `fires ${fmtNum(rows.length)}`, 'ok', `NASA FIRMS VIIRS detections, last 24 h (newest ${newest ? fmtAgo((nowMin - newest) * 60000) : '—'} ago)`);
  if (top) tick('fires', `Strongest fire in 24 h: ${fmtNum(top[3], 0)} MW near ${App.describePlace(top[0], top[1])} · ${b.sats[top[6]]}`, 'fire');
  const srcs = Object.values(b.sources || {});
  const bad = srcs.filter(s => s.error);
  box.replaceChildren(
    el('div', { class: 'stat-row' },
      el('div', { class: 'stat' }, el('span', { class: 'big mono', style: { color: FAMILY.fire } }, fmtNum(rows.length)), el('span', { class: 'muted small' }, `detections shown${b.total > rows.length ? ` (newest, of ${fmtNum(b.total)})` : ''}`)),
      el('div', { class: 'stat' }, el('span', { class: 'big mono' }, newest ? fmtAgo((nowMin - newest) * 60000) : '—'), el('span', { class: 'muted small' }, `since the newest detection · ${fmtNum(last6)} in the last 6 h`))),
    el('div', { class: 'small mono muted' }, b.sats.map((s, i) => `${s} ${fmtNum(per[i] || 0)}`).join(' · ')),
    el('div', { class: 'fire-legend small' },
      el('span', { class: 'muted' }, 'age'), el('span', { class: 'fire-ramp' }), el('span', { class: 'muted mono' }, 'now → 24 h'),
      el('span', { class: 'muted', style: { marginLeft: '10px' } }, 'size = FRP'), el('i', { class: 'fd', style: { width: '4px', height: '4px' } }), el('i', { class: 'fd', style: { width: '7px', height: '7px' } }), el('i', { class: 'fd', style: { width: '10px', height: '10px' } })),
    el('div', { class: 'small muted' }, `Server copy fetched ${F.fetched ? fmtAgo(Date.now() - Date.parse(F.fetched)) + ' ago' : '—'} (refreshed every 45 min)${bad.length ? ` · unavailable now: ${bad.map(s => s.satellite).join(', ')}` : ''}.`),
    top ? el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => select(rows.indexOf(top), true) }, `Strongest: ${fmtNum(top[3], 0)} MW`), el('button', { class: 'btn small ghost', onclick: () => App.flyTo({ type: 'global', daylight: false, force: true, reason: 'fires' }) }, 'Whole globe')) : '');
}

export function select(i, fly = false) {
  const r = F.rows[i];
  if (!r) return;
  const sat = F.body.sats[r[6]] || 'VIIRS';
  App.selectItem({ kind: 'fire', id: i, title: `Active fire · ${sat}`, family: 'fire', layer: 'Active fires (FIRMS)', render: c => card(c, r) });
  if (fly) App.flyTo({ type: 'region', lon: r[1], lat: r[0], h: 250e3, force: true, reason: 'fire' });
}
function card(c, r) {
  const t = r[2] * 60000, sat = F.body.sats[r[6]] || '?';
  const local = new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  c.replaceChildren(
    el('div', { class: 'card-sub' }, `${App.describePlace(r[0], r[1])} · VIIRS 375 m`),
    el('div', { class: 'kv' }, [
      ['Detected', `${fmtUTC(t)} (${local})`], ['Age', fmtAgo(Date.now() - t)], ['Satellite', `${sat} (VIIRS)`],
      ['Confidence', CONF[r[4]] || '—'], ['Fire radiative power', `${fmtNum(r[3], 1)} MW`], ['Day / night pass', r[5] ? 'day' : 'night'],
      ['Brightness (I-4)', r[9] ? `${fmtNum(r[9], 1)} K` : '—'], ['Pixel size', r[7] ? `${r[7].toFixed(2)} × ${r[8].toFixed(2)} km` : '—'], ['Location', `${r[0].toFixed(4)}°, ${r[1].toFixed(4)}°`],
    ].map(([k, v]) => [el('span', { class: 'k' }, k), el('span', { class: 'v mono' }, v)])),
    el('div', { class: 'note' }, 'A thermal anomaly in one ~375 m pixel: usually a vegetation fire, sometimes a gas flare, volcano or industrial heat source. Clouds and small or brief fires are missed. Near-real-time data, not validated.'),
    el('div', { class: 'links small' }, el('a', { href: `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${r[1].toFixed(3)},${r[0].toFixed(3)},10.0z`, target: '_blank', rel: 'noopener' }, 'NASA FIRMS map ↗')));
}

export function setFiresOn(on) {
  F.on = !!on; store.set('firms', F.on);
  clearInterval(F.timer); clearTimeout(F.retry);
  if (F.on) { load(); F.timer = setInterval(load, 15 * 60e3); }
  else { F.gen++; clearPrim(); requestRender(); chip('fires', '', 'hide'); const box = $('#fires-info'); if (box) emptyState(box, 'Turn on to load the last 24 hours of detections.'); }
  if (ui.tog) ui.tog.querySelector('input').checked = F.on;
  App.events.dispatchEvent(new Event('layers'));
}
// low-memory mode changed: fetch the other size
export function redraw() { if (F.on) load(); }
export const credit = () => F.on ? 'Fires: NASA FIRMS (VIIRS 375 m)' : null;

const ui = {};
export function buildFiresUI(box) {
  const info = el('div', { id: 'fires-info', class: 'info' });
  ui.tog = toggle('Show active fires, last 24 h (NASA FIRMS, VIIRS 375 m)', F.on, v => setFiresOn(v), 'fire');
  box.replaceChildren(ui.tog,
    el('div', { class: 'hint' }, 'What this is: every heat “hotspot” the VIIRS instruments on Suomi NPP, NOAA-20 and NOAA-21 detected in the last 24 hours, from NASA FIRMS (Fire Information for Resource Management System). Colour shows how long ago (bright = newest), size shows fire radiative power — how much heat the fire gives off. Tap a dot for its time, satellite, confidence and power.'),
    info);
  if (F.on) setFiresOn(true); else emptyState(info, 'Turn on to load the last 24 hours of detections.');
  App.pickHandlers = App.pickHandlers || {};
  App.pickHandlers.fire = p => select(p.id);
  App.tipHandlers = App.tipHandlers || {};
  App.tipHandlers.fire = p => {
    const r = F.rows[p.id]; if (!r) return null;
    return `<b>Fire · ${fmtNum(r[3], 1)} MW</b> <span class="sub">${F.body.sats[r[6]] || ''} · ${CONF[r[4]] || ''} confidence · ${fmtAgo(Date.now() - r[2] * 60000)} ago</span>`;
  };
}
