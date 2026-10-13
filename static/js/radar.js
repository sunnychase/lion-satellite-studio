// Lion Satellite Studio — Sentinel-1 radar (Planetary Computer sentinel-1-rtc): scenes in view, VV/VH
// rendering, before/after swipe, draw-a-box analysis (flood, change, ships, time series).
import { App, $, el, getJSON, chip, tick, fmtAgo, fmtUTC, fmtNum, store, toast, skeleton, emptyState, requestRender, FAMILY } from './util.js';
import { toggle, raiseRefLayers } from './imagery.js';

const C = window.Cesium;
const PC_TILES = 'https://planetarycomputer.microsoft.com/api/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x.png';
const enc = encodeURIComponent;
// Planetary Computer's documented sentinel-1-rtc render options (mosaic/info renderOptions)
const FC_EXPR = '0.03 + log (10e-4 - log (0.05 / (0.02 + 2 * vv)));0.05 + exp (0.25 * (log (0.01 + 2 * vv) + log (0.02 + 5 * vh)));1 - log (0.05 / (0.045 - 0.9 * vv))';
const RENDER = {
  fc: { title: 'False colour', q: `assets=vv&assets=vh&expression=${enc(FC_EXPR)}&rescale=0,.8000&rescale=0,1.000&rescale=0,1.000&asset_as_band=True` },
  vv: { title: 'VV dB', q: `assets=vv&expression=${enc('10*log10(vv)')}&asset_as_band=True&rescale=-25,0&colormap_name=gray`, range: [-25, 0] },
  vh: { title: 'VH dB', q: `assets=vh&expression=${enc('10*log10(vh)')}&asset_as_band=True&rescale=-30,-5&colormap_name=gray`, range: [-30, -5] },
};
const MAX_H = 900e3;          // load radar imagery only at region scale or closer
const RCOL = '#c4b5fd';
const R = App.data.radar = {
  on: false, mode: store.get('s1mode', 'fc'), passes: [], sel: null, cmp: null, split: false, date: '', days: 30,
  layers: { a: [], b: [] }, ds: null, search: null, aoi: null, job: null, result: null, resultLayer: null, shipPts: null,
};

// ---------------------------------------------------------------- search + passes
function groupPasses(scenes) {
  const m = new Map();
  for (const s of scenes) {
    const k = `${s.platform}_${s.abs}`;
    let p = m.get(k);
    if (!p) { p = { key: k, ids: [], dt: s.dt, dir: s.dir, rel: s.rel, platform: s.platform, rings: [], bboxes: [], timeliness: s.timeliness }; m.set(k, p); }
    p.ids.push(s.id); p.rings.push(s.ring); p.bboxes.push(s.bbox);
    if (s.dt < p.dt) p.dt = s.dt;
  }
  const out = [...m.values()];
  for (const p of out) {
    // keep ids, footprints and bboxes aligned when sorting the slices
    const z = p.ids.map((id, i) => [id, p.rings[i], p.bboxes[i]]).sort((a, b) => a[0].localeCompare(b[0]));
    p.ids = z.map(x => x[0]); p.rings = z.map(x => x[1]); p.bboxes = z.map(x => x[2]);
    p.pid = p.ids.join('+');
  }
  return out.sort((a, b) => b.dt.localeCompare(a.dt));
}
function inRing(lon, lat, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
export function coverageOf(p, b) {
  let n = 0, hit = 0;
  for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
    const lon = b[0] + (b[2] - b[0]) * (i + 0.5) / 7, lat = b[1] + (b[3] - b[1]) * (j + 0.5) / 7;
    n++; if (p.rings.some(r => inRing(lon, lat, r))) hit++;
  }
  return hit / n;
}
function viewBox() {
  const r = App.viewer.camera.computeViewRectangle();
  const c = App.viewer.camera.positionCartographic;
  const lon = C.Math.toDegrees(c.longitude), lat = C.Math.toDegrees(c.latitude);
  let b = r ? [C.Math.toDegrees(r.west), C.Math.toDegrees(r.south), C.Math.toDegrees(r.east), C.Math.toDegrees(r.north)] : null;
  // wide, antimeridian-crossing or horizon views: fall back to a 4 deg box under the camera
  if (!b || b[2] <= b[0] || b[2] - b[0] > 8 || b[3] - b[1] > 8) b = [lon - 2, lat - 2, lon + 2, lat + 2];
  return [Math.max(-180, b[0]), Math.max(-84.9, b[1]), Math.min(180, b[2]), Math.min(84.9, b[3])];
}
async function search(force = false) {
  if (!R.on) return;
  const h = App.viewer.camera.positionCartographic.height;
  const info = $('#s1-info');
  if (h > MAX_H && !force) {
    chip('radar', 'S1 · zoom in', 'idle', 'Zoom in to region scale to load Sentinel-1 radar');
    if (info) info.replaceChildren(el('div', { class: 'empty' }, 'Zoom in to region scale (below ~900 km altitude) to load Sentinel-1 radar. Footprints of the last search stay on the map.'));
    hideLayers();
    return;
  }
  const b = viewBox();
  if (!b) return;
  const days = R.date ? null : R.days;
  let qs = `bbox=${b.map(x => x.toFixed(3)).join(',')}`;
  if (R.date) qs += `&from=${R.date}&to=${R.date}`;
  else if (days) qs += `&from=${new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)}`;
  if (R.lastQs === qs && !force) { showSelected(); return; }
  R.lastQs = qs;
  if (info) skeleton(info, 3);
  try {
    const { body, fetched, cache } = await getJSON(`/api/s1/search?${qs}`);
    R.search = body;
    R.passes = groupPasses(body.scenes || []);
    const age = Date.now() - Date.parse(fetched);
    chip('radar', `S1 search ${fmtAgo(age)} ago`, age > 2 * 3600e3 ? 'warn' : 'ok', `Planetary Computer STAC search, cached 1 h (${cache})`);
    // default: the newest pass that covers the view centre (or keep the user's pick if still listed)
    const c = App.viewer.camera.positionCartographic;
    const lon = C.Math.toDegrees(c.longitude), lat = C.Math.toDegrees(c.latitude);
    if (!R.sel || !R.passes.some(p => p.pid === R.sel)) {
      const p = R.passes.find(p => p.rings.some(r => inRing(lon, lat, r))) || R.passes[0];
      R.sel = p ? p.pid : null;
      R.cmp = null;
    }
    drawFootprints();
    showSelected();
    renderList();
    if (R.passes[0]) tick('s1', `Newest Sentinel-1 pass in view: ${passLabel(R.passes[0], true)}`, 'radar');
  } catch (e) {
    chip('radar', 'S1 unavailable', 'bad', e.message);
    if (info) emptyState(info, `Sentinel-1 search is unavailable right now (${e.message})`, e.retry || 300);
  }
}
const pass = pid => R.passes.find(p => p.pid === pid);

// ---------------------------------------------------------------- footprints
function drawFootprints() {
  const v = App.viewer;
  if (!R.ds) { R.ds = new C.CustomDataSource('s1'); v.dataSources.add(R.ds); }
  R.ds.entities.removeAll();
  R.ds.show = R.on;
  const base = C.Color.fromCssColorString(RCOL);
  R.passes.slice(0, 24).forEach(p => {
    const sel = p.pid === R.sel, cmp = p.pid === R.cmp;
    const col = sel ? C.Color.fromCssColorString('#ffffff') : cmp ? C.Color.fromCssColorString(FAMILY.gold) : base.withAlpha(R.aoi ? 0.15 : 0.35);
    p.rings.forEach((ring, i) => {
      if (!ring || ring.length < 3) return;
      R.ds.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArray(ring.flat()), width: sel || cmp ? 2.2 : 1.1, material: col, arcType: C.ArcType.GEODESIC, clampToGround: false },
        properties: { pick: { kind: 's1pass', id: p.pid } } });
      if (i === 0 && (sel || cmp)) {
        const n = ring.length;
        const cx = ring.reduce((a, q) => a + q[0], 0) / n, cy = ring.reduce((a, q) => a + q[1], 0) / n;
        R.ds.entities.add({ position: C.Cartesian3.fromDegrees(cx, cy, 2000), label: { text: passLabel(p, true), font: '500 12px Inter, sans-serif', fillColor: col, outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: 5e6, distanceDisplayCondition: new C.DistanceDisplayCondition(0, 4e6) }, properties: { pick: { kind: 's1pass', id: p.pid } } });
      }
    });
  });
  requestRender();
}
const passLabel = (p, short) => `${p.dt.slice(5, 16).replace('T', ' ')} UTC · ${p.platform.replace('sentinel-', 'S')} · ${p.dir === 'ascending' ? 'asc' : 'desc'} · rel ${p.rel}${short ? '' : ` · ${p.ids.length} slice${p.ids.length > 1 ? 's' : ''}`}`;

// ---------------------------------------------------------------- imagery
// tiles go through the server's fixed-URL tile endpoint (cached; empty tiles outside the footprint
// come back transparent instead of 404). PC_TILES/RENDER above document the upstream request.
function tileUrl(id, mode) { return `/api/s1/tile?item=${enc(id)}&mode=${mode}&z={z}&x={x}&y={y}`; }
function makeLayers(p) {
  return p.ids.map((id, i) => {
    const b = p.bboxes[i];
    const prov = new C.UrlTemplateImageryProvider({
      url: tileUrl(id, R.mode), tilingScheme: new C.WebMercatorTilingScheme(), minimumLevel: 7, maximumLevel: 14,
      rectangle: C.Rectangle.fromDegrees(b[0], b[1], b[2], b[3]),
      credit: new C.Credit('Contains modified Copernicus Sentinel data; Sentinel-1 RTC (Catalyst) via Microsoft Planetary Computer'),
    });
    prov.errorEvent.addEventListener(() => { });
    return new C.ImageryLayer(prov, { alpha: 1.0 });
  });
}
function hideLayers() {
  const coll = App.viewer.imageryLayers;
  for (const k of ['a', 'b']) { R.layers[k].forEach(l => { try { coll.remove(l, true); } catch (e) { /* gone */ } }); R.layers[k] = []; }
  setSplitUI(false);
  legend();
  requestRender();
}
export function showSelected() {
  const coll = App.viewer.imageryLayers;
  const old = [...R.layers.a, ...R.layers.b];
  R.layers = { a: [], b: [] };
  const pa = R.on && R.sel && pass(R.sel);
  const pb = R.on && R.split && R.cmp && pass(R.cmp);
  if (pa) { R.layers.a = makeLayers(pa); R.layers.a.forEach(l => coll.add(l)); }
  if (pb) { R.layers.b = makeLayers(pb); R.layers.b.forEach(l => coll.add(l)); }
  const splitOn = !!(pa && pb) || (!!pa && R.tourSplit);
  R.layers.a.forEach(l => { l.splitDirection = R.tourSplit ? C.SplitDirection.RIGHT : splitOn ? C.SplitDirection.LEFT : C.SplitDirection.NONE; });
  if (App.layers.il.base) App.layers.il.base.splitDirection = R.tourSplit ? C.SplitDirection.LEFT : C.SplitDirection.NONE;
  R.layers.b.forEach(l => { l.splitDirection = C.SplitDirection.RIGHT; });
  if (R.resultLayer && coll.contains(R.resultLayer)) coll.raiseToTop(R.resultLayer);
  raiseRefLayers();
  setTimeout(() => old.forEach(l => { try { coll.remove(l, true); } catch (e) { /* gone */ } }), 700);
  setSplitUI(splitOn);
  legend();
  App.events.dispatchEvent(new Event('layers'));
  requestRender();
}
function legend() {
  let box = $('#rlegend');
  if (!box) { box = el('div', { id: 'rlegend', class: 'glass legend rlegend hidden' }); document.body.append(box); }
  const pa = R.on && R.sel && pass(R.sel);
  box.classList.toggle('hidden', !pa || !R.layers.a.length);
  if (!pa) return;
  const kids = [el('div', { class: 'lg-title' }, el('span', { class: 'dot', style: { background: FAMILY.radar, color: FAMILY.radar } }), `Sentinel-1 · ${RENDER[R.mode].title}`),
    el('div', { class: 'lg-when mono' }, (R.split && R.cmp ? 'A (left): ' : '') + passLabel(pa, true))];
  if (R.split && R.cmp && pass(R.cmp)) kids.push(el('div', { class: 'lg-when mono', style: { color: FAMILY.gold } }, 'B (right): ' + passLabel(pass(R.cmp), true)));
  if (RENDER[R.mode].range) {
    const [a, b] = RENDER[R.mode].range;
    kids.push(el('div', { class: 'grad' }), el('div', { class: 'grad-l mono small' }, el('span', {}, `${a} dB`), el('span', {}, 'γ⁰ (RTC)'), el('span', {}, `${b} dB`)));
  } else {
    kids.push(el('div', { class: 'small muted' }, 'R = VV, G = VV·VH mix, B = VV ratio term (PC’s Sentinel Hub–derived composite). Blue/dark: water & smooth surfaces · green/yellow: vegetation · bright: built-up, ships, metal.'));
  }
  kids.push(el('div', { class: 'small muted' }, 'Tiles render at zoom ≥ 7 (region scale).'));
  box.replaceChildren(...kids);
}

// ---------------------------------------------------------------- before/after swipe
function setSplitUI(on) {
  let d = $('#split-divider');
  if (!d) {
    d = el('div', { id: 'split-divider', class: 'split-divider hidden' }, el('div', { class: 'split-handle' }, '⟷'), el('span', { class: 'split-l' }, 'A'), el('span', { class: 'split-r' }, 'B'));
    document.body.append(d);
    let drag = false;
    const move = x => { const f = Math.min(0.95, Math.max(0.05, x / window.innerWidth)); App.scene.splitPosition = f; d.style.left = (f * 100) + '%'; requestRender(); };
    d.addEventListener('pointerdown', e => { drag = true; d.setPointerCapture(e.pointerId); e.stopPropagation(); });
    d.addEventListener('pointermove', e => { if (drag) move(e.clientX); });
    d.addEventListener('pointerup', () => { drag = false; });
  }
  d.classList.toggle('hidden', !on);
  d.querySelector('.split-l').textContent = R.tourSplit ? 'True colour' : 'A';
  d.querySelector('.split-r').textContent = R.tourSplit ? 'Radar' : 'B';
  if (on) { App.scene.splitPosition = App.scene.splitPosition || 0.5; d.style.left = (App.scene.splitPosition * 100) + '%'; }
}
function suggestB(pa) {
  return R.passes.find(p => p.pid !== pa.pid && p.rel === pa.rel && p.dir === pa.dir && p.dt < pa.dt) || null;
}

// ---------------------------------------------------------------- panel
function renderList() {
  const box = $('#s1-list');
  const info = $('#s1-info');
  if (!box) return;
  const dates = [...new Set(R.passes.map(p => p.dt.slice(0, 10)))];
  if (info) {
    info.replaceChildren(el('div', { class: 'small' }, `${fmtNum(R.passes.length)} passes in view (${R.date ? R.date : `last ${R.days} days`}) · ${dates.length} dates`),
      R.search ? el('div', { class: 'small muted' }, `search fetched ${fmtAgo(Date.now() - Date.parse(R.search.fetched))} ago · cached 1 h per area`) : '');
  }
  const pa = R.sel && pass(R.sel);
  const sug = pa ? suggestB(pa) : null;
  box.replaceChildren(...R.passes.slice(0, 30).map(p => {
    const isA = p.pid === R.sel, isB = p.pid === R.cmp;
    return el('div', { class: 's1row' + (isA ? ' a' : '') + (isB ? ' b' : '') },
      el('button', { class: 'li', title: p.ids.join('\n'), onclick: () => selectPass(p.pid, true) }, el('span', { class: 'dot', style: { background: isA ? '#fff' : isB ? FAMILY.gold : RCOL } }), el('span', { class: 'mono small' }, passLabel(p))),
      el('button', { class: 'pill' + (isB ? ' on' : ''), style: { '--c': FAMILY.gold }, title: 'Compare: set as B (right side)', onclick: () => setCompare(isB ? null : p.pid) }, sug && sug.pid === p.pid && !isB ? 'B ★' : 'B'));
  }));
  const cmpBox = $('#s1-cmp');
  if (cmpBox) {
    cmpBox.replaceChildren(
      el('div', { class: 'small muted' }, pa ? (sug ? `Suggested B: ${passLabel(sug, true)} — same relative orbit and direction, best for comparison.` : 'No earlier pass of the same orbit in this window — widen the date range.') : 'Pick a pass first.'),
      el('div', { class: 'row' },
        el('button', { class: 'btn small' + (R.split ? ' on' : ''), disabled: !pa, onclick: () => { if (!R.cmp && sug) R.cmp = sug.pid; R.split = !R.split && !!R.cmp; drawFootprints(); showSelected(); renderList(); } }, R.split ? 'Swipe on' : 'Before / after swipe'),
        pa ? el('button', { class: 'btn small ghost', onclick: () => fitPass(pa) }, 'Fit A') : ''));
  }
}
function selectPass(pid, fit = false) {
  R.sel = pid;
  if (R.cmp === pid) R.cmp = null;
  drawFootprints(); showSelected(); renderList();
  const p = pass(pid);
  if (fit && p) fitPass(p);
  App.events.dispatchEvent(new Event('s1sel'));
}
function setCompare(pid) {
  R.cmp = pid; R.split = !!pid;
  drawFootprints(); showSelected(); renderList();
}
function fitPass(p) {
  const bs = p.bboxes;
  const r = C.Rectangle.fromDegrees(Math.min(...bs.map(b => b[0])), Math.min(...bs.map(b => b[1])), Math.max(...bs.map(b => b[2])), Math.max(...bs.map(b => b[3])));
  App.lastUserInput = 0;
  App.viewer.camera.flyTo({ destination: r, duration: App.reducedMotion ? 0 : 2, easingFunction: C.EasingFunction.QUADRATIC_IN_OUT });
  App.pulse(2600);
}
export function setWindow(days) { R.days = days; R.date = ''; return search(true); }
export function setRadarOn(on) {
  R.on = on;
  if (R.ds) R.ds.show = on;
  if (on) { R.lastQs = null; search(); }
  else { hideLayers(); chip('radar', '', 'hide'); }
  const t = $('#s1-toggle input'); if (t) t.checked = on;
  App.events.dispatchEvent(new Event('layers'));
}
export function buildRadarUI(box) {
  const tog = toggle('Show Sentinel-1 radar (C-band, day & night, through cloud)', R.on, v => setRadarOn(v), 'radar');
  tog.id = 's1-toggle';
  const seg = el('div', { class: 'seg' }, Object.entries(RENDER).map(([k, r]) => el('button', { class: 'seg-b' + (R.mode === k ? ' on' : ''), onclick: e => { R.mode = k; store.set('s1mode', k); seg.querySelectorAll('.seg-b').forEach(b => b.classList.toggle('on', b === e.currentTarget)); showSelected(); } }, r.title)));
  const dateIn = el('input', { type: 'date', class: 'input mono small', max: new Date().toISOString().slice(0, 10), min: '2014-10-01', 'aria-label': 'radar date' });
  dateIn.addEventListener('change', () => { R.date = dateIn.value; R.sel = null; search(true); });
  const winSel = el('select', { class: 'input small', 'aria-label': 'search window' }, [30, 90, 180, 365].map(d => el('option', { value: d, selected: d === R.days }, `${d} days`)));
  winSel.addEventListener('change', () => { R.days = +winSel.value; R.date = ''; dateIn.value = ''; search(true); });
  box.replaceChildren(tog,
    el('div', { class: 'hint' }, 'Sentinel-1 RTC γ⁰ from Microsoft Planetary Computer. Zoom to a region: the newest pass in view loads; tap a footprint or a row to switch. Before/after uses the same relative orbit by default.'),
    seg,
    el('div', { class: 'row' }, el('span', { class: 'lbl' }, 'Window'), winSel, el('span', { class: 'lbl' }, 'or day'), dateIn, el('button', { class: 'btn ghost small', onclick: () => { dateIn.value = ''; R.date = ''; R.sel = null; search(true); } }, 'Newest'), el('button', { class: 'btn small', onclick: () => search(true) }, 'Search here')),
    el('div', { id: 's1-info', class: 'info' }, el('div', { class: 'empty' }, 'Turn radar on to search the view.')),
    el('div', { id: 's1-cmp' }),
    el('div', { id: 's1-list', class: 'swot-list' }),
    el('div', { class: 'h small' }, 'Analysis'),
    el('div', { class: 'row' }, el('button', { class: 'btn gold', onclick: () => startDraw() }, '▭ Draw analysis box'), el('span', { class: 'hint' }, `max ${fmtNum(2500)} km², one job at a time`)),
    el('details', { class: 'stub' }, el('summary', {}, 'NISAR GCOV/GUNW & InSAR (ASF HyP3) — coming later'),
      el('p', { class: 'small' }, 'With a free NASA Earthdata login, ASF HyP3 can produce on-demand InSAR (interferograms and ground deformation in mm, from Sentinel-1 pairs) and Lion Satellite Studio could tile NISAR GCOV L-band backscatter (sees through vegetation better than C-band) and NISAR GUNW interferograms. Not built: it needs that login, and this app never asks for or stores Earthdata credentials.')),
  );
  App.viewer.camera.moveEnd.addEventListener(() => { if (R.on && !App.drawing) search(); });
}

// ---------------------------------------------------------------- draw a box
export function startDraw() {
  if (App.drawing) return;
  if (!R.on) setRadarOn(true);
  App.drawing = true;
  const sc = App.scene, ssc = sc.screenSpaceCameraController;
  ssc.enableInputs = false;
  App.forceContinuous = true; App.api.SAT.updateRenderMode();
  toast('Drag a box on the map — or tap two opposite corners', 5000);
  document.body.classList.add('drawing');
  const h = new C.ScreenSpaceEventHandler(sc.canvas);
  let p0 = null, p1 = null, downPos = null, taps = 0;
  const pick = pos => { const ray = App.viewer.camera.getPickRay(pos); const c = sc.globe.pick(ray, sc) || App.viewer.camera.pickEllipsoid(pos); return c ? C.Cartographic.fromCartesian(c) : null; };
  const rect = () => p0 && p1 ? C.Rectangle.fromCartographicArray([p0, p1]) : undefined;
  const ent = App.viewer.entities.add({
    rectangle: { coordinates: new C.CallbackProperty(() => rect(), false), material: C.Color.fromCssColorString(FAMILY.radar).withAlpha(0.18) },
    polyline: { positions: new C.CallbackProperty(() => { const r = rect(); if (!r) return []; const d = C.Math.toDegrees; return C.Cartesian3.fromDegreesArray([d(r.west), d(r.south), d(r.east), d(r.south), d(r.east), d(r.north), d(r.west), d(r.north), d(r.west), d(r.south)]); }, false), width: 2, material: C.Color.fromCssColorString(FAMILY.radar), clampToGround: true },
  });
  const finish = (ok) => {
    h.destroy();
    ssc.enableInputs = true;
    document.body.classList.remove('drawing');
    setTimeout(() => { App.drawing = false; }, 50);
    App.forceContinuous = false; App.api.SAT.updateRenderMode();
    App.viewer.entities.remove(ent);
    const r = rect();
    if (!ok || !r) return;
    const d = C.Math.toDegrees;
    setAoi([d(r.west), d(r.south), d(r.east), d(r.north)]);
  };
  h.setInputAction(e => { downPos = e.position; const c = pick(e.position); if (!c) return; if (!p0) { p0 = c; p1 = c; } }, C.ScreenSpaceEventType.LEFT_DOWN);
  h.setInputAction(e => { if (p0 && (downPos || taps)) { const c = pick(e.endPosition); if (c) p1 = c; requestRender(); } }, C.ScreenSpaceEventType.MOUSE_MOVE);
  h.setInputAction(e => {
    const c = pick(e.position);
    if (!p0 || !c) return;
    const moved = downPos && C.Cartesian2.distance(downPos, e.position) > 8;
    downPos = null;
    if (moved || taps >= 1) { p1 = c; finish(true); }
    else { taps = 1; toast('Now tap the opposite corner', 4000); }
  }, C.ScreenSpaceEventType.LEFT_UP);
  h.setInputAction(() => finish(false), C.ScreenSpaceEventType.RIGHT_CLICK);
  const esc = ev => { if (ev.key === 'Escape') { window.removeEventListener('keydown', esc); finish(false); } };
  window.addEventListener('keydown', esc);
}
function km2(b) { return (b[2] - b[0]) * 111.32 * Math.cos((b[1] + b[3]) / 2 * Math.PI / 180) * (b[3] - b[1]) * 110.57; }
export function setAoi(b) {
  R.aoi = b.map(x => +x.toFixed(4));
  drawAoi();
  App.selectItem({ kind: 'aoi', id: R.aoi.join(','), title: 'Radar analysis', family: 'radar', layer: 'Sentinel-1', render: aoiCard, onClear: () => { R.aoi = null; drawAoi(); clearResult(); } });
  const center = C.Cartesian3.fromDegrees((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
  const rad = Math.max(C.Cartesian3.distance(C.Cartesian3.fromDegrees(b[0], b[1]), C.Cartesian3.fromDegrees(b[2], b[3])) / 2, 3000);
  App.flyTo({ type: 'sphere', center, radius: rad * 1.25, force: true, reason: 'AOI' });
}
function drawAoi() {
  const v = App.viewer;
  if (R.aoiEnt) { v.entities.remove(R.aoiEnt); R.aoiEnt = null; }
  if (!R.aoi) { requestRender(); return; }
  const b = R.aoi;
  R.aoiEnt = v.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArray([b[0], b[1], b[2], b[1], b[2], b[3], b[0], b[3], b[0], b[1]]), width: 2.5, clampToGround: true,
    material: new C.PolylineDashMaterialProperty({ color: C.Color.fromCssColorString(FAMILY.radar), dashLength: 12 }) } });
  requestRender();
}

// ---------------------------------------------------------------- AOI card + jobs
let cardBox = null;
function aoiCard(card) {
  cardBox = card;
  const b = R.aoi;
  if (!b) return;
  const area = km2(b);
  const cands = R.passes.map(p => ({ p, cov: coverageOf(p, b) })).filter(x => x.cov > 0).sort((x, y) => y.p.dt.localeCompare(x.p.dt));
  const good = cands.filter(x => x.cov >= 0.6);
  const A0 = (R.sel && good.find(x => x.p.pid === R.sel)) || good[0] || cands[0];
  const B0 = A0 ? (good.find(x => x.p.pid !== A0.p.pid && x.p.rel === A0.p.rel && x.p.dir === A0.p.dir && x.p.dt < A0.p.dt) || null) : null;
  const opt = (x, sel) => el('option', { value: x.p.pid, selected: sel }, `${passLabel(x.p, true)} · ${Math.round(x.cov * 100)}% of box`);
  const selA = el('select', { class: 'input small', 'aria-label': 'scene A' }, cands.map(x => opt(x, A0 && x.p.pid === A0.p.pid)));
  const selB = el('select', { class: 'input small', 'aria-label': 'scene B (before / reference)' }, el('option', { value: '' }, '— none —'), cands.map(x => opt(x, B0 && x.p.pid === B0.p.pid)));
  const tSlider = el('input', { type: 'range', class: 'range', min: 1, max: 6, step: 0.5, value: 3 });
  const tVal = el('span', { class: 'mono small' }, '±3 dB');
  tSlider.addEventListener('input', () => { tVal.textContent = `±${tSlider.value} dB`; });
  const fThr = el('input', { type: 'range', class: 'range', min: -26, max: -12, step: 0.5, value: -18, disabled: true });
  const fAuto = el('input', { type: 'checkbox', checked: true });
  const fVal = el('span', { class: 'mono small' }, 'Otsu');
  fAuto.addEventListener('change', () => { fThr.disabled = fAuto.checked; fVal.textContent = fAuto.checked ? 'Otsu' : `${fThr.value} dB`; });
  fThr.addEventListener('input', () => { fVal.textContent = `${fThr.value} dB`; });
  const kSl = el('input', { type: 'range', class: 'range', min: 3, max: 9, step: 0.5, value: 5 });
  const kVal = el('span', { class: 'mono small' }, 'z > 5');
  kSl.addEventListener('input', () => { kVal.textContent = `z > ${kSl.value}`; });
  const over = area > 2500;
  const run = (type) => {
    const a = selA.value, bb = selB.value;
    const q = new URLSearchParams({ type, bbox: b.join(',') });
    if (!a) { toast('Pick pass A first'); return; }
    if (type === 'flood') { q.set('scenes', a); if (bb) q.set('ref', bb); if (!fAuto.checked) q.set('threshold', fThr.value); }
    if (type === 'change') { if (!bb) { toast('Pick B (the earlier "before" pass) for change detection'); return; } q.set('scenes', `${bb},${a}`); q.set('t', tSlider.value); }
    if (type === 'ships') { q.set('scenes', a); q.set('k', kSl.value); }
    if (type === 'timeseries') { const p = pass(a); if (!p) { toast('Pick a pass A to set the orbit'); return; } q.set('rel', p.rel); q.set('dir', p.dir); }
    if (type !== 'timeseries' && a && R.sel !== a) selectPass(a, false); // map shows the analysed scene
    runJob(q, type);
  };
  card.replaceChildren(
    el('div', { class: 'card-sub' }, `Box ${b.map(x => x.toFixed(3)).join(', ')}`),
    el('div', { class: 'stat-row' }, el('div', { class: 'stat' }, el('span', { class: 'big mono', style: { color: over ? 'var(--bad)' : FAMILY.radar } }, `${fmtNum(area, area < 10 ? 1 : 0)} km²`), el('span', { class: 'muted small' }, over ? 'too large — the limit is 2,500 km²; draw a smaller box' : 'area of interest'))),
    cands.length ? '' : el('div', { class: 'empty' }, 'No Sentinel-1 pass in the current search covers this box — zoom out a little, pick another date in the Radar section, then draw again.'),
    el('div', { class: 'kv' }, el('span', { class: 'k' }, 'A (after / scene)'), selA, el('span', { class: 'k' }, 'B (before / reference)'), selB),
    el('div', { class: 'small muted' }, 'Default B = an earlier pass of the same relative orbit and direction (same viewing geometry).'),
    el('div', { class: 'ana' },
      el('div', { class: 'ana-row' }, el('button', { class: 'btn', disabled: over || !cands.length, onclick: () => run('flood') }, '💧 Water / flood'), el('label', { class: 'chk small' }, fAuto, 'auto'), fThr, fVal),
      el('div', { class: 'ana-row' }, el('button', { class: 'btn', disabled: over || !cands.length, onclick: () => run('change') }, '⇄ Change B→A'), tSlider, tVal),
      el('div', { class: 'ana-row' }, el('button', { class: 'btn', disabled: over || !cands.length, onclick: () => run('ships') }, '⛴ Ships (sea)'), kSl, kVal),
      el('div', { class: 'ana-row' }, el('button', { class: 'btn', disabled: over || !cands.length, onclick: () => run('timeseries') }, '📈 Time series (12 mo, A’s orbit)'))),
    el('div', { id: 's1-job', class: 'jobbox' }),
    el('div', { id: 's1-result' }),
  );
  if (R.result && R.result.bboxKey === b.join(',')) renderResult(R.result);
}
async function runJob(q, type) {
  const box = $('#s1-job');
  const res = $('#s1-result');
  if (res) res.replaceChildren();
  clearResult();
  const bar = el('div', { class: 'bar' }, el('i', { style: { width: '2%' } }));
  const msg = el('div', { class: 'small mono' }, 'submitting …');
  if (box) box.replaceChildren(bar, msg);
  let key;
  try {
    const { body } = await getJSON(`/api/s1/analyze?${q.toString()}`);
    key = body.key;
  } catch (e) {
    if (box) box.replaceChildren(el('div', { class: 'empty' }, e.message, e.status === 503 ? el('button', { class: 'btn small', style: { marginLeft: '8px' }, onclick: () => runJob(q, type) }, 'Retry') : ''));
    return;
  }
  R.job = key;
  const t0 = Date.now();
  while (R.job === key) {
    let d;
    try { d = (await getJSON(`/api/s1/job?key=${key}`)).body; } catch (e) { msg.textContent = `status unavailable (${e.message}) — retrying`; await sleep(3000); continue; }
    if (d.state === 'done') {
      bar.firstChild.style.width = '100%';
      msg.textContent = `done in ${Math.round(d.result.runtime_s)} s${(Date.now() - t0) < 1500 ? ' (cached result)' : ''}`;
      d.result.key = key; d.result.bboxKey = R.aoi ? R.aoi.join(',') : '';
      R.result = d.result;
      renderResult(d.result);
      return;
    }
    if (d.state === 'error' || d.state === 'stalled') { box.replaceChildren(el('div', { class: 'empty' }, `Analysis failed: ${d.error || 'worker stopped'}`)); return; }
    const p = d.progress || {};
    bar.firstChild.style.width = `${Math.max(3, p.pct || 3)}%`;
    msg.textContent = `${p.msg || 'queued …'}${p.elapsed_s ? ` · ${Math.round(p.elapsed_s)} s` : ''}`;
    await sleep(1500);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function clearResult() {
  const coll = App.viewer.imageryLayers;
  if (R.resultLayer) { try { coll.remove(R.resultLayer, true); } catch (e) { /* gone */ } R.resultLayer = null; }
  if (R.shipPts) { App.scene.primitives.remove(R.shipPts); R.shipPts = null; }
  requestRender();
}
async function renderResult(r) {
  const box = $('#s1-result');
  clearResult();
  const b = r.bbox;
  if (r.has_overlay) {
    try {
      const prov = await C.SingleTileImageryProvider.fromUrl(`/api/s1/file?key=${r.key}&name=overlay.png`, { rectangle: C.Rectangle.fromDegrees(b[0], b[1], b[2], b[3]) });
      R.resultLayer = App.viewer.imageryLayers.add(new C.ImageryLayer(prov, { alpha: 0.95 }));
      raiseRefLayers();
    } catch (e) { toast('Result overlay could not be loaded'); }
  }
  const x = r.result;
  const kv = rows => el('div', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => [el('span', { class: 'k' }, k), el('span', { class: 'v mono' }, v)]));
  const kids = [];
  if (r.type === 'flood') {
    kids.push(el('div', { class: 'stat-row' }, el('div', { class: 'stat' }, el('span', { class: 'big mono', style: { color: FAMILY.water } }, `${fmtNum(x.water_km2, 1)} km²`), el('span', { class: 'muted small' }, 'open water in A')),
      x.new_water_km2 !== undefined ? el('div', { class: 'stat' }, el('span', { class: 'big mono', style: { color: '#ff7a28' } }, `${fmtNum(x.new_water_km2, 1)} km²`), el('span', { class: 'muted small' }, 'new water vs B (orange)')) : ''));
    kids.push(kv([['Threshold', `${x.threshold_db} dB (${x.threshold_method})`], x.otsu_raw_db !== null ? ['Otsu (raw)', `${x.otsu_raw_db} dB`] : null,
      x.reference_water_km2 !== undefined ? ['Water in B', `${x.reference_water_km2} km²`] : null, x.receded_water_km2 !== undefined ? ['Receded (grey)', `${x.receded_water_km2} km²`] : null,
      ['AOI covered', `${Math.round(x.coverage * 100)}%`]]));
  } else if (r.type === 'change') {
    kids.push(el('div', { class: 'stat-row' }, el('div', { class: 'stat' }, el('span', { class: 'big mono', style: { color: '#ff5a5a' } }, `${fmtNum(x.increase_km2, 2)} km²`), el('span', { class: 'muted small' }, 'VV increase (red)')),
      el('div', { class: 'stat' }, el('span', { class: 'big mono', style: { color: '#28e6ff' } }, `${fmtNum(x.decrease_km2, 2)} km²`), el('span', { class: 'muted small' }, 'VV decrease (cyan)'))));
    kids.push(kv([['Threshold', `±${x.threshold_db} dB`], ['VH increase / decrease', `${x.vh_increase_km2} / ${x.vh_decrease_km2} km²`], ['Median VV log-ratio', `${x.vv_logratio_median_db} dB`], ['AOI covered', `${Math.round(x.coverage * 100)}%`]]));
  } else if (r.type === 'ships') {
    const ais = r.ais || {};
    kids.push(el('div', { class: 'stat-row' }, el('div', { class: 'stat' }, el('span', { class: 'big mono', style: { color: FAMILY.ship } }, fmtNum(x.detections)), el('span', { class: 'muted small' }, `bright targets on ${fmtNum(x.sea_km2)} km² of sea`))));
    kids.push(kv([['Lengths', x.points.length ? `${Math.min(...x.points.map(p => p.length_m))}–${Math.max(...x.points.map(p => p.length_m))} m (pixel extent)` : '—'], ['AIS cross-match', ais.state === 'matched' ? `${ais.matched} matched · ${ais.unmatched} no AIS at scene time` : (ais.state || '—')], ['AOI covered', `${Math.round(x.coverage * 100)}%`]]));
    if (ais.note) kids.push(el('div', { class: 'note' }, ais.note));
    drawShips(x.points);
  } else if (r.type === 'timeseries') {
    const s = x.series.filter(p => p.vv_db !== undefined);
    const cv = el('canvas', { class: 'chart', 'aria-label': 'radar time series' });
    kids.push(el('div', { class: 'small' }, `${s.length} passes · relative orbit ${x.relative_orbit} (${x.orbit_state}) · ${x.passes_found_12mo} found in 12 months`), cv,
      el('div', { class: 'legend-row small' }, el('span', {}, el('span', { class: 'dot', style: { background: FAMILY.radar } }), 'VV dB'), el('span', {}, el('span', { class: 'dot', style: { background: FAMILY.ship } }), 'VH dB')),
      el('div', { class: 'small muted' }, 'Crops: VH rises as canopies grow and drops at harvest · wetlands: VV drops when flooded (or rises with flooded vegetation) · construction: step changes.'));
    requestAnimationFrame(() => drawMulti(cv, [{ pts: s.map(p => ({ x: new Date(p.date), y: p.vv_db })), color: FAMILY.radar }, { pts: s.map(p => ({ x: new Date(p.date), y: p.vh_db })), color: FAMILY.ship }]));
  }
  kids.push(el('div', { class: 'note' }, '⚠ ', r.caveat, ' ', r.method));
  kids.push(kv([['Pixel size', `${r.pixel_m} m (${r.grid[0]} × ${r.grid[1]} px, ${r.crs})`], ['Parameters', JSON.stringify(r.params)], ['Runtime', `${r.runtime_s} s · peak ${r.peak_rss_mb} MB`]]));
  kids.push(el('details', { class: 'stub' }, el('summary', {}, `Scenes (${r.scenes.length})`), r.scenes.map(sc => el('div', { class: 'small mono wrap' }, `${sc.id} · ${sc.datetime.slice(0, 19)}Z · ${sc.orbit_state} rel ${sc.relative_orbit}`))));
  kids.push(el('div', { class: 'actions' },
    el('a', { class: 'btn', href: `/api/s1/file?key=${r.key}&name=result.geojson&dl=1` }, '⬇ GeoJSON'),
    r.has_overlay ? el('a', { class: 'btn', href: `/api/s1/file?key=${r.key}&name=overlay.png&dl=1` }, '⬇ PNG overlay') : '',
    el('a', { class: 'btn ghost', href: `/api/s1/file?key=${r.key}&name=result.json&dl=1` }, 'result.json')));
  kids.push(el('div', { class: 'small muted' }, r.data));
  if (box) box.replaceChildren(...kids);
  requestRender();
}
function ringImg(col) {
  const c = document.createElement('canvas'); c.width = c.height = 22;
  const g = c.getContext('2d'); g.strokeStyle = col; g.lineWidth = 2.4;
  g.beginPath(); g.moveTo(11, 2); g.lineTo(20, 11); g.lineTo(11, 20); g.lineTo(2, 11); g.closePath(); g.stroke();
  return c;
}
function drawShips(pts) {
  R.shipPts = App.scene.primitives.add(new C.BillboardCollection({ scene: App.scene }));
  const imgs = { m: ringImg(FAMILY.ship), u: ringImg('#ffb547'), n: ringImg('#e8e1cf') };
  pts.forEach((p, i) => {
    const k = p.ais === 'AIS-matched' ? 'm' : p.ais && p.ais.startsWith('no AIS') ? 'u' : 'n';
    R.shipPts.add({ position: C.Cartesian3.fromDegrees(p.lon, p.lat), image: imgs[k], width: 14 + Math.min(10, p.length_m / 30), height: 14 + Math.min(10, p.length_m / 30), id: { kind: 's1ship', id: i }, disableDepthTestDistance: 1e6, scaleByDistance: new C.NearFarScalar(5e3, 1.4, 4e5, 0.6) });
  });
}
App.pickHandlers = App.pickHandlers || {};
App.pickHandlers.s1pass = p => selectPass(p.id, true);
App.pickHandlers.s1ship = p => {
  const pt = R.result && R.result.result.points[p.id];
  if (!pt) return;
  toast(`Radar target · ~${pt.length_m} m · peak ${pt.peak_db} dB · CFAR z ${pt.cfar_z} · confidence ${pt.confidence} · ${pt.ais || ''}`, 7000);
};
App.tipHandlers = App.tipHandlers || {};
App.tipHandlers.s1pass = p => { const q = pass(p.id); return q ? `<b>Sentinel-1</b> <span class="sub">${passLabel(q)}</span>` : null; };
App.tipHandlers.s1ship = p => { const pt = R.result && R.result.result.points[p.id]; return pt ? `<b>Radar target ~${pt.length_m} m</b> <span class="sub">${pt.ais || ''} · conf ${pt.confidence}</span>` : null; };

function drawMulti(canvas, series) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 320, H = canvas.clientHeight || 150;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d'); g.scale(dpr, dpr);
  const all = series.flatMap(s => s.pts).filter(p => isFinite(p.y));
  g.font = '10px "JetBrains Mono", monospace'; g.fillStyle = 'rgba(235,228,210,0.55)';
  if (all.length < 1) { g.fillText('no passes with enough coverage', 10, H / 2); return; }
  const pad = { l: 40, r: 10, t: 10, b: 22 };
  let x0 = Math.min(...all.map(p => +p.x)), x1 = Math.max(...all.map(p => +p.x)); if (x1 === x0) { x0 -= 864e5; x1 += 864e5; }
  let y0 = Math.min(...all.map(p => p.y)), y1 = Math.max(...all.map(p => p.y)); const yp = (y1 - y0) * 0.1 || 1; y0 -= yp; y1 += yp;
  const X = x => pad.l + (x - x0) / (x1 - x0) * (W - pad.l - pad.r), Y = y => H - pad.b - (y - y0) / (y1 - y0) * (H - pad.t - pad.b);
  g.strokeStyle = 'rgba(217,178,95,0.14)';
  for (let i = 0; i <= 3; i++) { const yy = y0 + (y1 - y0) * i / 3; g.beginPath(); g.moveTo(pad.l, Y(yy)); g.lineTo(W - pad.r, Y(yy)); g.stroke(); g.fillText(yy.toFixed(1), 2, Y(yy) + 3); }
  for (let i = 0; i <= 3; i++) { const xx = x0 + (x1 - x0) * i / 3; g.fillText(new Date(xx).toISOString().slice(2, 7), X(xx) - 14, H - 6); }
  for (const s of series) {
    const p = s.pts.filter(q => isFinite(q.y)).sort((a, b) => a.x - b.x);
    g.strokeStyle = s.color; g.lineWidth = 1.6; g.beginPath(); p.forEach((q, i) => i ? g.lineTo(X(+q.x), Y(q.y)) : g.moveTo(X(+q.x), Y(q.y))); g.stroke();
    g.fillStyle = s.color; p.forEach(q => { g.beginPath(); g.arc(X(+q.x), Y(q.y), 2.3, 0, 7); g.fill(); });
  }
}

// ---------------------------------------------------------------- tour: radar sees through clouds
export async function tourClouds(show, wait) {
  const IM = App.api.IM;
  // yesterday (UTC): today's MODIS swaths may not have been acquired yet
  IM.setDate(new Date(Date.now() - 864e5).toISOString().slice(0, 10));
  IM.setBase('MODIS_Terra_CorrectedReflectance_TrueColor');
  const L = App.layers.byId.MODIS_Terra_CorrectedReflectance_TrueColor;
  R.mode = 'vv'; store.set('s1mode', 'vv');
  R.split = false; R.cmp = null;
  App.lastUserInput = 0;
  const landed = new Promise(res => App.viewer.camera.flyTo({ destination: C.Cartesian3.fromDegrees(4.5, 52.05, 330e3), orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 }, duration: App.reducedMotion ? 0 : 2.5, complete: res, cancel: res }));
  show(1, 3, 'Flying to the North Sea coast of the Netherlands and searching Sentinel-1 passes …');
  await Promise.race([landed, wait(15000)]);
  R.on = true; if (R.ds) R.ds.show = true;
  const t = $('#s1-toggle input'); if (t) t.checked = true;
  R.sel = null;
  await search(true);
  const pa = R.sel && pass(R.sel);
  if (!pa) { show(2, 3, 'No Sentinel-1 pass found here in the last 30 days.'); await wait(5000); return; }
  // left: MODIS true colour (base), right: radar — kept through camera moves until the tour ends
  R.tourSplit = true;
  App.scene.splitPosition = 0.5;
  showSelected();
  await wait(5000);
  show(2, 3, `Left: MODIS Terra true colour for ${IM.layerDate(L)} — white is cloud. Right: Sentinel-1 VV radar, ${passLabel(pa, true)}. C-band microwaves pass through cloud, day or night.`);
  await wait(11000);
  show(3, 3, 'Drag the divider to compare. Radar shows water as dark (smooth), towns and ships as bright; draw a box in the Radar section to analyse it. Tap Done to end the swipe.');
  await wait(600000); // the swipe stays until the user taps Done
}
export function endTourClouds() {
  R.tourSplit = false;
  if (App.layers.il.base) App.layers.il.base.splitDirection = C.SplitDirection.NONE;
  showSelected();
}
