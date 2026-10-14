// Created by Sunny Chase (https://github.com/sunnychase) in collaboration with Claude (Anthropic).
// Lion Satellite Studio — main: viewer, camera manager, HUD, panel, search, tours, share, capture.
import { App, $, $$, el, getJSON, store, toast, fmtAgo, fmtUTC, fmtNum, requestRender, FAMILY, debounce, tick, chip, ymd } from './util.js';
import * as IM from './imagery.js';
import * as SAT from './sats.js';
import * as D from './data.js';
import * as RD from './radar.js';
import * as PT from './point.js';

const C = window.Cesium;
C.Ion.defaultAccessToken = 'unused-no-ion'; // Cesium ion is never used: no ion imagery, terrain or geocoder.

// ================================================================ viewer
function makeViewer() {
  const phone = App.isPhone();
  const v = new C.Viewer('globe', {
    baseLayer: false, baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
    navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false, infoBox: false,
    selectionIndicator: false, vrButton: false, projectionPicker: false,
    terrainProvider: new C.EllipsoidTerrainProvider(), requestRenderMode: true, maximumRenderTimeChange: Infinity,
    shouldAnimate: false, msaaSamples: phone ? 1 : 4,
    contextOptions: { webgl: { alpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' } },
  });
  const s = v.scene;
  App.viewer = v; App.scene = s;
  window.LE = App; // handy for debugging & headless checks
  App.api = { SAT, IM, D, RD, PT };
  s.globe.baseColor = C.Color.fromCssColorString('#0a1424');
  s.globe.showGroundAtmosphere = true;
  s.globe.enableLighting = true;
  s.globe.dynamicAtmosphereLighting = true;
  s.globe.dynamicAtmosphereLightingFromSun = true;
  s.globe.atmosphereLightIntensity = 12.0;
  // Cesium defaults: below ~10,000 km everything is lit (readable close-ups); the night side darkens from 20,000 km out
  s.globe.lightingFadeOutDistance = 1.0e7; s.globe.lightingFadeInDistance = 2.0e7;
  s.globe.nightFadeOutDistance = 1.0e7; s.globe.nightFadeInDistance = 5.0e7;
  s.globe.maximumScreenSpaceError = phone ? 2.5 : 2.0;
  s.globe.tileCacheSize = phone ? 100 : 160;
  // graphics problems: our own note instead of Cesium's error panel; a lost WebGL context reloads in low-memory mode
  v.showRenderLoopErrors = false;
  s.renderError.addEventListener((sc, err) => { console.error('render error', err); graphicsReset('error'); });
  s.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); graphicsReset('lost'); }, false);
  s.skyAtmosphere.show = true;
  s.fog.enabled = true;
  s.highDynamicRange = false;
  s.postProcessStages.fxaa.enabled = !phone;
  if (s.sun) s.sun.show = true;
  if (s.moon) s.moon.show = true;
  s.debugShowFramesPerSecond = false;
  // camera controls: drag rotate, wheel/pinch zoom, right-drag or two-finger tilt, inertia, no zooming inside the Earth
  const ssc = s.screenSpaceCameraController;
  ssc.inertiaSpin = 0.92; ssc.inertiaTranslate = 0.9; ssc.inertiaZoom = 0.82;
  ssc.minimumZoomDistance = 120; ssc.maximumZoomDistance = 1.6e8;
  ssc.enableCollisionDetection = true;
  ssc.zoomEventTypes = [C.CameraEventType.WHEEL, C.CameraEventType.PINCH];
  ssc.tiltEventTypes = [C.CameraEventType.RIGHT_DRAG, C.CameraEventType.MIDDLE_DRAG, C.CameraEventType.PINCH, { eventType: C.CameraEventType.LEFT_DRAG, modifier: C.KeyboardEventModifier.CTRL }];
  v.cesiumWidget.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  v.clock.shouldAnimate = false;
  globalView(daylightLon(), 10, 0);
  return v;
}

function subsolar(t = Date.now()) {
  const d = new Date(t);
  const doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5;
  const decl = 23.44 * Math.sin(2 * Math.PI * (284 + doy) / 365);
  const hrs = d.getUTCHours() + d.getUTCMinutes() / 60;
  let lon = (12 - hrs) * 15;
  lon = ((lon + 540) % 360) - 180;
  return { lat: decl, lon };
}
const daylightLon = () => subsolar(SAT.now ? SAT.now() : Date.now()).lon;
// whole-globe view, tilted slightly: look at a surface point from ~20,000 km at -80 deg pitch
function globalView(lon, lat, duration, extra = {}) {
  const cam = App.viewer.camera;
  const target = new C.BoundingSphere(C.Cartesian3.fromDegrees(lon, lat), 1);
  const offset = new C.HeadingPitchRange(0, C.Math.toRadians(-80), App.isPhone() ? 2.55e7 : 1.95e7);
  if (!duration) { cam.flyToBoundingSphere(target, { offset, duration: 0 }); return; }
  cam.flyToBoundingSphere(target, { offset, duration, easingFunction: C.EasingFunction.QUADRATIC_IN_OUT, ...extra });
}

// ================================================================ software WebGL (any browser, no settings needed)
// A context that must not have a "major performance caveat" cannot be created when the browser draws WebGL in software
// (blocklisted driver, no GPU, remote desktop). Then the app starts in low-memory mode and says so once.
function softwareWebGL() {
  try {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2', { failIfMajorPerformanceCaveat: true }) || cv.getContext('webgl', { failIfMajorPerformanceCaveat: true });
    if (!gl) return true;
    // a software rasteriser named in the renderer string (SwiftShader, llvmpipe, softpipe, Microsoft Basic Render)
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    const x = gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch (e) { return false; }
}

// ================================================================ memory: low-memory mode + graphics resets
// Low-memory mode is for busy or small GPUs (or a machine whose memory is shared with other big jobs): fewer footprints and
// ships, no 3D models, no 3D terrain or hi-res backdrop, larger tile error and a small tile cache. It switches on by
// itself after a graphics reset or when frames stay slow, and from the toggle in Imagery & terrain.
App.lowMem = store.get('lowmem', false);
App.softGL = softwareWebGL();
if (App.softGL && !App.lowMem) { App.lowMem = true; store.set('lowmem', true); App.softNotice = true; }
function applyMemMode() {
  const s = App.scene, phone = App.isPhone(), on = App.lowMem;
  s.globe.maximumScreenSpaceError = on ? (App.softGL ? 4 : 3) : phone ? 2.5 : 2.0;
  s.globe.tileCacheSize = on ? 60 : phone ? 100 : 160;
  App.viewer.resolutionScale = on ? (App.softGL ? 0.6 : 0.85) : 1;   // software WebGL: far fewer pixels to draw
  if (on) { if (App.layers.hires) IM.setHires(false); if (App.layers.terrain) { App.layers.terrain = false; IM.applyTerrain(); } }
  D.redrawHeavy();
  requestRender();
}
App.setLowMem = function (on, why) {
  if (App.lowMem === !!on) return;
  App.lowMem = !!on; store.set('lowmem', App.lowMem);
  applyMemMode();
  const t = $('#lowmem-toggle input'); if (t) t.checked = App.lowMem;
  if (on && why) toast(`Low-memory mode on (${why}). Turn it off under Imagery & terrain.`, 6000);
};
let resets = 0;
function graphicsReset(kind) {
  resets++;
  let n = $('#gfx-note');
  if (!n) { n = el('div', { id: 'gfx-note', class: 'glass gfx-note' }); document.body.append(n); }
  if (!App.lowMem) { App.lowMem = true; store.set('lowmem', true); }
  if (kind === 'lost') {
    n.replaceChildren(el('b', {}, 'Graphics reset'), el('span', {}, ' — the browser dropped the 3D view (short of graphics memory). Reloading the layers in low-memory mode …'));
    n.classList.remove('hidden');
    setTimeout(() => location.reload(), 2500);   // the view is in the URL, so the reload comes back to it
    return;
  }
  n.replaceChildren(el('b', {}, 'Graphics hiccup'), el('span', {}, ' — the 3D view stopped on an error; resuming in low-memory mode. '),
    el('button', { class: 'btn small', onclick: () => location.reload() }, 'Reload'), el('button', { class: 'btn small ghost', onclick: () => n.classList.add('hidden') }, 'Hide'));
  n.classList.remove('hidden');
  applyMemMode();
  if (resets <= 3) setTimeout(() => { App.viewer.useDefaultRenderLoop = true; requestRender(); }, 1000);
}

// ================================================================ camera manager
let pendingHint = null;
function isGlobalView() { return App.viewer.camera.positionCartographic.height > 7.0e6; }
App.flyTo = function (h) {
  const recent = Date.now() - App.lastUserInput < 10000;
  if (App.restoring) return;
  if (h.onlyIfGlobal && !isGlobalView() && !h.force) return;
  if (recent && !h.force) { showPill(h); return; }
  doFly(h);
};
App.events.addEventListener('flyhint', e => App.flyTo(e.detail));
function doFly(h) {
  hidePill();
  const v = App.viewer, cam = v.camera;
  if (h.type !== 'entity' && v.trackedEntity) { SAT.unfollow(); }
  const opt = { duration: App.reducedMotion ? 0 : 2.0, easingFunction: C.EasingFunction.QUADRATIC_IN_OUT };
  if (h.type === 'region') {
    cam.flyTo({ destination: C.Cartesian3.fromDegrees(h.lon, h.lat, h.h || 8e6), orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 }, ...opt });
  } else if (h.type === 'global') {
    const ss = subsolar(SAT.now());
    const lon = h.daylight ? ss.lon : C.Math.toDegrees(cam.positionCartographic.longitude);
    const lat = h.daylight ? C.Math.clamp(ss.lat * 0.6, -25, 25) : 12;
    globalView(lon, lat, opt.duration);
  } else if (h.type === 'night') {
    const ss = subsolar(SAT.now());
    cam.flyTo({ destination: C.Cartesian3.fromDegrees(((ss.lon + 360) % 360) - 180, 20, 1.6e7), ...opt });
  } else if (h.type === 'sphere') {
    const r = Math.max(h.radius || 1e5, 2.0e4);
    cam.flyToBoundingSphere(new C.BoundingSphere(h.center, r), { offset: new C.HeadingPitchRange(0, C.Math.toRadians(-62), r * 2.4), ...opt });
  }
  App.pulse(2600);
}
function showPill(h) {
  pendingHint = h;
  const p = $('#flypill');
  p.querySelector('span').textContent = h.reason ? `· ${h.reason}` : '';
  p.classList.remove('hidden');
  clearTimeout(showPill.t);
  showPill.t = setTimeout(hidePill, 15000);
}
function hidePill() { $('#flypill').classList.add('hidden'); }

// continuous rendering for a while (fly-tos, pulses, intro)
let pulseUntil = 0;
App.pulse = (ms) => {
  pulseUntil = Math.max(pulseUntil, performance.now() + ms);
  App.forceContinuous = true;
  SAT.updateRenderMode();
  clearTimeout(App.pulse.t);
  App.pulse.t = setTimeout(() => { if (performance.now() >= pulseUntil - 5 && !App.spinning && !App.introRunning) { App.forceContinuous = false; SAT.updateRenderMode(); requestRender(); } }, ms + 50);
};

// track manual camera input (drag, wheel, pinch) — taps don't count
function watchInput(canvas) {
  let down = null;
  const mark = () => { App.lastUserInput = Date.now(); stopIdle(); };
  canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; App.pointerDown = true; App.lastAny = Date.now(); stopIdle(); }, { passive: true });
  canvas.addEventListener('pointermove', e => { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) mark(); }, { passive: true });
  window.addEventListener('pointerup', () => { down = null; App.pointerDown = false; }, { passive: true });
  window.addEventListener('pointercancel', () => { down = null; App.pointerDown = false; }, { passive: true });
  canvas.addEventListener('wheel', mark, { passive: true });
  canvas.addEventListener('touchmove', e => { if (e.touches.length > 1) mark(); }, { passive: true });
  ['keydown', 'pointerdown', 'wheel', 'touchstart'].forEach(ev => window.addEventListener(ev, () => { App.lastAny = Date.now(); stopIdle(); }, { passive: true }));
}

// ================================================================ idle beauty spin
App.lastAny = Date.now();
function stopIdle() { if (App.spinning) { App.spinning = false; App.forceContinuous = false; SAT.updateRenderMode(); } }
function idleLoop() {
  setInterval(() => {
    const idle = Date.now() - App.lastAny > 30000;
    const ok = idle && !App.reducedMotion && !App.introRunning && !App.viewer.trackedEntity && !App.tourRunning && isGlobalView();
    if (ok && !App.spinning) { App.spinning = true; App.forceContinuous = true; SAT.updateRenderMode(); }
    if (!ok && App.spinning) stopIdle();
  }, 2000);
  App.viewer.clock.onTick.addEventListener(() => {
    if (App.spinning) App.viewer.camera.rotate(C.Cartesian3.UNIT_Z, -0.0009);
  });
}

// ================================================================ selection + card
App.selectItem = function (item) {
  if (App.selected && App.selected.onClear && (App.selected.kind !== item.kind || App.selected.id !== item.id)) {
    const prev = App.selected; App.selected = null; prev.onClear();
  }
  App.selected = item;
  $('#card').classList.remove('hidden');
  document.body.classList.add('card-open');
  $('#card-title').textContent = item.title;
  $('#card-dot').style.background = FAMILY[item.family] || FAMILY.gold;
  $('#card-dot').style.color = FAMILY[item.family] || FAMILY.gold;
  const body = $('#card-body');
  body.replaceChildren();
  item.render(body);
  crumb();
  saveHash();
};
function closeCard() {
  const it = App.selected;
  App.selected = null;
  $('#card').classList.add('hidden');
  document.body.classList.remove('card-open');
  if (it && it.onClear) it.onClear();
  crumb(); saveHash();
}
function crumb() {
  const c = $('#crumb');
  const it = App.selected;
  if (!it) { c.classList.add('hidden'); return; }
  c.classList.remove('hidden');
  c.replaceChildren(el('span', { class: 'dot', style: { background: FAMILY[it.family] || FAMILY.gold, color: FAMILY[it.family] } }), el('span', {}, it.layer), el('span', { class: 'sep' }, '›'), el('b', {}, it.title));
}

App.showLayerFor = function (layerId, sat) {
  const L = App.layers.byId[layerId];
  if (!L || !L.available) { toast('That layer is not available in GIBS right now'); return; }
  SAT.unfollow();
  App.lastUserInput = 0;
  if (L.group === 'base') IM.setBase(layerId);
  else if (L.group === 'science') IM.setScience(layerId);
  else if (L.group === 'nrt') IM.setNrt(layerId);
  else if (L.group === 'fire') IM.setFiresToday(true);
  if (!L.region) App.flyTo({ type: 'global', daylight: true, force: true, reason: L.title });
  toast(`Showing ${L.title}`);
  openSection(L.group === 'nrt' ? 'nrt' : L.group === 'science' ? 'science' : 'imagery', true);
};

// ================================================================ picking + tooltip
function setupPicking() {
  const v = App.viewer, s = App.scene;
  const handler = new C.ScreenSpaceEventHandler(s.canvas);
  const resolve = picked => {
    if (!picked) return null;
    let id = picked.id;
    if (id instanceof C.Entity) { const p = id.properties && id.properties.pick; return p ? p.getValue() : null; }
    return id && id.kind ? id : null;
  };
  handler.setInputAction(e => {
    if (App.drawing) return;
    const p = resolve(s.pick(e.position, 6, 6));
    if (!p) return;
    if (App.pickHandlers && App.pickHandlers[p.kind]) { App.pickHandlers[p.kind](p); return; }
    if (p.kind === 'sat') SAT.select(p.norad);
    else if (p.kind === 'quake') D.selectQuake(p.id);
    else if (p.kind === 'nisar') D.selectNisar(p.id);
    else if (p.kind === 'swot') D.selectSwot(p.id);
    else if (p.kind === 'ship') D.selectShip(p.id);
    else if (p.kind === 'gfw') App.selectItem({ kind: 'gfw', id: p.id, title: 'Dark vessel detection', family: 'ship', layer: 'Global Fishing Watch', render: c => D.gfwCard(c, p.id) });
  }, C.ScreenSpaceEventType.LEFT_CLICK);
  handler.setInputAction(e => {
    // double-tap / double-click: zoom into that point
    if (App.drawing) return;
    const ray = v.camera.getPickRay(e.position);
    const target = s.globe.pick(ray, s);
    if (!target) return;
    const camPos = v.camera.positionWC;
    const dist = C.Cartesian3.distance(camPos, target);
    const dest = C.Cartesian3.lerp(camPos, target, 0.55, new C.Cartesian3());
    if (dist < 400) return;
    SAT.unfollow();
    v.camera.flyTo({ destination: dest, orientation: { direction: C.Cartesian3.normalize(C.Cartesian3.subtract(target, camPos, new C.Cartesian3()), new C.Cartesian3()), up: v.camera.up }, duration: 0.8 });
    App.lastUserInput = Date.now();
  }, C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  const tip = $('#tooltip');
  let last = 0, lastKey = null;
  // hover picking renders a pick pass (readPixels): skip it while the user drags or the camera moves, and at most ~8 per second
  v.camera.moveStart.addEventListener(() => { App.camMoving = true; });
  v.camera.moveEnd.addEventListener(() => { App.camMoving = false; });
  handler.setInputAction(e => {
    const now = performance.now();
    if (App.pointerDown || App.camMoving || now - last < 120) return;
    last = now;
    const p = resolve(s.pick(e.endPosition, 5, 5));
    const key = p ? p.kind + ':' + (p.norad ?? p.id) : null;
    if (key !== lastKey) {
      lastKey = key;
      SAT.hover(p && p.kind === 'sat' ? p.norad : null);
      s.canvas.style.cursor = p ? 'pointer' : '';
    }
    if (!p) { tip.classList.add('hidden'); return; }
    const t = tipText(p);
    if (!t) { tip.classList.add('hidden'); return; }
    tip.innerHTML = t;
    tip.style.left = e.endPosition.x + 'px'; tip.style.top = e.endPosition.y + 'px';
    tip.classList.remove('hidden');
  }, C.ScreenSpaceEventType.MOUSE_MOVE);
}
function tipText(p) {
  const e = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  if (p.kind === 'sat') { const s = SAT.findSat(p.norad); return s ? `<b>${e(s.short || s.name)}</b> <span class="sub">NORAD ${s.norad} · ${s.cls}</span>` : null; }
  if (p.kind === 'quake') { const f = App.data.quakes.features.find(x => x.id === p.id); return f ? `<b>M${f.properties.mag?.toFixed(1)}</b> ${e(f.properties.place || '')} <span class="sub">${fmtAgo(Date.now() - f.properties.time)} ago</span>` : null; }
  if (p.kind === 'nisar') { const r = App.data.nisar.rows.find(x => x[0] === p.id); return r ? `<b>NISAR ${App.data.nisar.body.types[r[1]]}</b> <span class="sub">track ${r[3]} frame ${r[4]} · ${fmtAgo(Date.now() - r[2] * 60000)} ago</span>` : null; }
  if (p.kind === 'swot') { const f = D.swotFeature(p.id); return f ? `<b>${e(f.name)}</b> <span class="sub">SWOT ${f.type === 'Reach' ? 'river reach' : 'lake'} · tap for water heights</span>` : null; }
  if (p.kind === 'ship') return `<b>Vessel</b> <span class="sub">MMSI ${p.id} · tap for details</span>`;
  if (p.kind === 'gfw') return `<b>radar-detected (no AIS)</b> <span class="sub">Global Fishing Watch</span>`;
  if (App.tipHandlers && App.tipHandlers[p.kind]) return App.tipHandlers[p.kind](p);
  return null;
}

// ================================================================ gazetteer
let GAZ = { countries: [], cities: [] };
async function loadGazetteer() {
  try { GAZ = await (await fetch('data/gazetteer.json')).json(); } catch (e) { /* search still works for satellites */ }
  const dl = $('#place-list');
  dl.replaceChildren(...GAZ.cities.filter(c => c[4] <= 2).map(c => el('option', { value: c[0] })));
}
App.findPlace = function (q) {
  q = (q || '').trim().toLowerCase();
  if (!q) return null;
  const m = (name, alts) => name.toLowerCase() === q || (alts || []).some(a => a.toLowerCase() === q);
  const city = GAZ.cities.find(c => m(c[0], c[5]));
  if (city) return { name: city[0], lat: city[2], lon: city[3], kind: 'city', cc: city[1] };
  const ctry = GAZ.countries.find(c => m(c[0], c[5]) || c[1].toLowerCase() === q);
  if (ctry) return { name: ctry[0], lat: ctry[2], lon: ctry[3], bbox: ctry[4], kind: 'country' };
  return null;
};
function hav(a, b, c, d) { const R = 6371, r = Math.PI / 180; const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
App.describePlace = function (lat, lon) {
  let best = null, bd = 1e9;
  for (const c of GAZ.cities) { const d = hav(lat, lon, c[2], c[3]); if (d < bd) { bd = d; best = c; } }
  if (best && bd < 350) return `${bd < 40 ? '' : 'near '}${best[0]}`;
  let box = null, area = 1e9;
  for (const c of GAZ.countries) { const b = c[4]; if (lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]) { const a = (b[2] - b[0]) * (b[3] - b[1]); if (a < area) { area = a; box = c; } } }
  if (box && area < 9000) return box[0];
  if (lat > 66) return 'the Arctic Ocean';
  if (lat < -58) return 'the Southern Ocean';
  if (lon > -70 && lon < 20 && !(lat > 8 && lon < -60)) return lat > 0 ? 'the North Atlantic' : 'the South Atlantic';
  if (lon >= 20 && lon < 120 && lat < 25) return 'the Indian Ocean';
  return lat > 0 ? 'the North Pacific' : 'the South Pacific';
};

// ================================================================ search
function setupSearch() {
  const inp = $('#search'), box = $('#search-results');
  let items = [], focus = -1;
  const run = debounce(() => {
    const q = inp.value.trim();
    if (!q) { box.hidden = true; return; }
    const ql = q.toLowerCase();
    items = [];
    SAT.search(q).forEach(r => items.push({ k: 'sat', t: r.title, s: r.sub, go: () => SAT.select(r.id) }));
    (App.data.swot.list || []).filter(f => f.name.toLowerCase().includes(ql)).slice(0, 4).forEach(f => items.push({ k: 'water', t: f.name, s: `SWOT ${f.type === 'Reach' ? 'reach' : 'lake'}`, go: () => D.selectSwot(`${f.type}:${f.id}`) }));
    const pm = (n, alts) => n.toLowerCase().includes(ql) || (alts || []).some(a => a.toLowerCase().includes(ql));
    GAZ.countries.filter(c => pm(c[0], c[5])).slice(0, 4).forEach(c => items.push({ k: 'country', t: c[0], s: c[1], go: () => flyBox(c[4], c[0]) }));
    GAZ.cities.filter(c => pm(c[0], c[5])).sort((a, b) => a[4] - b[4]).slice(0, 5).forEach(c => items.push({ k: 'city', t: c[0], s: c[1], go: () => App.flyTo({ type: 'region', lon: c[3], lat: c[2], h: 350e3, force: true, reason: c[0] }) }));
    const pc = PT.parseCoord(q);
    if (pc) items.unshift({ k: 'point', t: `Point report · ${pc.lat.toFixed(4)}, ${pc.lon.toFixed(4)}`, s: 'what sees this spot?', go: () => PT.lookup(pc.lat, pc.lon) });
    const c0 = !pc && App.findPlace(q);
    if (c0) items.push({ k: 'point', t: `What sees ${c0.name}?`, s: 'point report', go: () => PT.lookup(c0.lat, c0.lon, { name: c0.name }) });
    items = items.slice(0, 14);
    if (!pc && q.length >= 3) items.push({ k: 'address', t: `Search “${q}” as an address`, s: 'OpenStreetMap · Enter', go: () => PT.addressSearch(q) });
    focus = -1;
    box.replaceChildren(...(items.length ? items.map((it, i) => el('button', { class: 'res', role: 'option', onclick: () => pick(i) }, el('span', { class: 'k' }, it.k), el('span', {}, it.t), el('span', { class: 's' }, it.s))) : [el('div', { class: 'empty' }, 'No match in loaded satellites, SWOT list or the built-in gazetteer.')]));
    box.hidden = false;
  }, 120);
  const pick = i => { const it = items[i]; if (!it) return; box.hidden = true; inp.value = ''; inp.blur(); it.go(); if (App.isPhone()) setSheet('peek'); };
  inp.addEventListener('input', run);
  inp.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { focus = (focus + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; $$('.res', box).forEach((b, i) => b.classList.toggle('focus', i === focus)); e.preventDefault(); }
    if (e.key === 'Enter') pick(focus >= 0 ? focus : 0);
    if (e.key === 'Escape') { box.hidden = true; inp.blur(); }
  });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.search')) box.hidden = true; });
}
function flyBox(b, name) {
  const r = C.Rectangle.fromDegrees(b[0], b[1], b[2], b[3]);
  SAT.unfollow();
  App.viewer.camera.flyTo({ destination: r, duration: App.reducedMotion ? 0 : 2, easingFunction: C.EasingFunction.QUADRATIC_IN_OUT });
  App.pulse(2600);
}

// ================================================================ panel
const SECTIONS = [
  ['explore', 'Explore', 'gold'], ['point', 'What sees this spot?', 'gold'], ['sats', 'Satellites', 'sat'], ['time', 'Time', 'gold'], ['imagery', 'Imagery & terrain', 'gold'],
  ['nrt', 'Near real time', 'sat'], ['science', 'Earth science layers', 'gold'], ['overlays', 'Overlays', 'gold'],
  ['radar', 'Radar (Sentinel-1)', 'radar'], ['nisar', 'NISAR radar', 'radar'], ['swot', 'SWOT water', 'water'], ['quakes', 'Earthquakes', 'quake'], ['ships', 'Ships', 'ship'], ['about', 'About & credits', 'gold'],
];
const secBodies = {};
function buildPanel() {
  const pb = $('#panel-body');
  const open = new Set(store.get('openSecs', ['explore', 'sats']));
  for (const [id, title, fam] of SECTIONS) {
    const body = el('div', { class: 'sec-body', id: `sec-${id}` });
    const d = el('details', { class: 'sec', 'data-sec': id, open: open.has(id) }, el('summary', {}, el('span', { class: 'fam', style: { background: FAMILY[fam], color: FAMILY[fam] } }), title, el('span', { class: 'badge', id: `badge-${id}` })), body);
    d.addEventListener('toggle', () => { const o = new Set(store.get('openSecs', [])); d.open ? o.add(id) : o.delete(id); store.set('openSecs', [...o]); if (id === 'nisar' && d.open && !App.data.nisar.on) D.setNisarOn(true); });
    pb.append(d);
    secBodies[id] = body;
  }
}
function openSection(id, scroll) {
  const d = document.querySelector(`details[data-sec="${id}"]`);
  if (!d) return;
  d.open = true;
  if (App.isPhone()) setSheet('half');
  else if ($('#panel').classList.contains('collapsed')) togglePanel(false);
  if (scroll) d.scrollIntoView({ behavior: App.reducedMotion ? 'auto' : 'smooth', block: 'start' });
}
App.openSection = openSection;
function togglePanel(collapse) {
  const p = $('#panel');
  const c = collapse ?? !p.classList.contains('collapsed');
  p.classList.toggle('collapsed', c);
  document.body.classList.toggle('panel-collapsed', c);
  $('#panel-open').classList.toggle('hidden', !c);
}
function highlightActive() {
  const S = App.layers;
  const act = {
    sats: true, imagery: !!S.base, nrt: !!S.nrt || S.firesToday, science: !!S.science, overlays: S.overlays && S.overlays.size > 0,
    nisar: App.data.nisar.on, radar: App.data.radar && App.data.radar.on, swot: App.data.swot.on, quakes: App.data.quakes.on, ships: App.data.ships.on || App.data.ships.gfwOn,
  };
  for (const [id, on] of Object.entries(act)) document.querySelector(`details[data-sec="${id}"]`)?.classList.toggle('active-src', !!on);
  const b = $('#badge-sats'); if (b) b.textContent = fmtNum(App.sats.sats.length);
  const bn = $('#badge-nrt'); if (bn) bn.textContent = S.nrt ? 'on' : '';
  const bs = $('#badge-science'); if (bs) bs.textContent = S.science ? 'on' : '';
}

// bottom sheet (phone)
const SNAP = { peek: 92, half: () => Math.round(window.innerHeight * 0.46), full: () => Math.round(window.innerHeight * 0.88) };
function setSheet(mode) {
  const p = $('#panel');
  const h = typeof SNAP[mode] === 'function' ? SNAP[mode]() : SNAP[mode];
  p.style.setProperty('--sheet', h + 'px');
  p.dataset.mode = mode;
}
function setupSheet() {
  const p = $('#panel');
  setSheet('peek');
  let y0 = null, h0 = 0;
  const start = e => { if (!App.isPhone()) return; y0 = (e.touches ? e.touches[0] : e).clientY; h0 = parseFloat(getComputedStyle(p).getPropertyValue('--sheet')) || 92; p.classList.add('dragging'); };
  const move = e => { if (y0 === null) return; const y = (e.touches ? e.touches[0] : e).clientY; const h = Math.max(70, Math.min(window.innerHeight * 0.88, h0 + (y0 - y))); p.style.setProperty('--sheet', h + 'px'); };
  const end = () => {
    if (y0 === null) return; y0 = null; p.classList.remove('dragging');
    const h = parseFloat(getComputedStyle(p).getPropertyValue('--sheet'));
    const opts = [['peek', SNAP.peek], ['half', SNAP.half()], ['full', SNAP.full()]];
    opts.sort((a, b) => Math.abs(a[1] - h) - Math.abs(b[1] - h));
    setSheet(opts[0][0]);
  };
  for (const t of [$('#sheet-handle'), $('.panel-head')]) {
    t.addEventListener('touchstart', start, { passive: true }); t.addEventListener('mousedown', start);
  }
  window.addEventListener('touchmove', move, { passive: true }); window.addEventListener('mousemove', move);
  window.addEventListener('touchend', end); window.addEventListener('mouseup', end);
  $('#sheet-handle').addEventListener('click', () => setSheet(p.dataset.mode === 'peek' ? 'half' : 'peek'));
  $('#search').addEventListener('focus', () => { if (App.isPhone()) setSheet('full'); });
}

// ================================================================ time section
function buildTime(box) {
  const btns = [[0, '❚❚ Pause'], [1, 'Real time'], [10, '×10'], [100, '×100']];
  const seg = el('div', { class: 'seg' }, btns.map(([sp, t]) => el('button', { class: 'seg-b', 'data-sp': sp, onclick: () => SAT.setSpeed(sp) }, t)));
  const now = el('button', { class: 'btn small', onclick: () => SAT.resetNow() }, 'Back to now');
  const sync = () => { $$('.seg-b[data-sp]', seg).forEach(b => b.classList.toggle('on', +b.dataset.sp === App.sats.speed)); };
  App.events.addEventListener('speed', sync); sync();
  box.replaceChildren(seg, el('div', { class: 'row' }, now, el('span', { class: 'hint' }, 'Speeds up satellites and the day/night terminator. Imagery dates are unaffected.')));
}

// ================================================================ HUD: clock, chips, ticker
function startClock() {
  const c = $('#utc');
  const upd = () => {
    const t = SAT.now();
    c.textContent = new Date(t).toISOString().slice(11, 19) + ' UTC' + (App.sats.speed !== 1 ? (App.sats.speed === 0 ? ' ❚❚' : ` ×${App.sats.speed}`) : '');
    c.classList.toggle('fast', App.sats.speed !== 1);
    c.title = fmtUTC(t, true) + (Math.abs(t - Date.now()) > 5000 ? ' (simulated)' : '');
    // keep Cesium's clock (sun position / lighting) on the simulated time
    App.viewer.clock.currentTime = C.JulianDate.fromDate(new Date(t), App.viewer.clock.currentTime);
  };
  upd(); setInterval(upd, 1000);
}
function renderChips() {
  const order = ['sats', 'tle', 'imagery', 'goes', 'radar', 'quake', 'nisar'];
  const box = $('#chips');
  box.replaceChildren(...order.filter(k => App.status[k] && App.status[k].level !== 'hide').map(k => { const s = App.status[k]; return el('span', { class: `chip ${s.level}`, title: s.title || '' }, el('i'), s.text); }));
}
App.events.addEventListener('chips', debounce(renderChips, 50));
function renderTicker() {
  const tr = $('#ticker-track');
  const items = [...App.ticker.values()];
  tr.replaceChildren(...items.map(it => el('span', { class: 'it' }, el('i', { style: { background: FAMILY[it.family] || FAMILY.gold } }), it.text)));
  tr.style.setProperty('--dur', Math.max(30, items.reduce((a, b) => a + b.text.length, 0) * 0.22) + 's');
}
App.events.addEventListener('ticker', debounce(renderTicker, 3000));
App.events.addEventListener('satgroups', () => highlightActive());

// ================================================================ scale bar + compass
function setupScaleCompass() {
  const v = App.viewer, s = App.scene;
  const bar = $('#scalebar'), needle = $('#compass-needle');
  const upd = () => {
    needle.style.transform = `rotate(${-C.Math.toDegrees(v.camera.heading)}deg)`;
    const w = s.canvas.clientWidth, h = s.canvas.clientHeight;
    const l = v.camera.getPickRay(new C.Cartesian2(w / 2 - 50, h - 60)), r = v.camera.getPickRay(new C.Cartesian2(w / 2 + 50, h - 60));
    const a = s.globe.pick(l, s), b = s.globe.pick(r, s);
    if (!a || !b) { bar.querySelector('.lbl').textContent = '—'; return; }
    const d = C.Cartesian3.distance(a, b); // metres per 100 px
    const nice = [1, 2, 5]; let best = 1, px = 100;
    for (let e = 0; e < 8; e++) for (const n of nice) { const m = n * 10 ** e; const p = m / d * 100; if (p <= 120) { best = m; px = p; } }
    bar.querySelector('.bar').style.width = px.toFixed(0) + 'px';
    bar.querySelector('.lbl').textContent = best >= 1000 ? `${best / 1000} km` : `${best} m`;
  };
  v.camera.changed.addEventListener(upd);
  v.camera.percentageChanged = 0.05;
  setTimeout(upd, 1500);
  $('#btn-compass').onclick = () => { const c = v.camera; c.flyTo({ destination: c.positionWC, orientation: { heading: 0, pitch: c.pitch, roll: 0 }, duration: 0.8 }); App.pulse(1000); };
  $('#btn-zin').onclick = () => { const h = v.camera.positionCartographic.height; v.camera.zoomIn(h * 0.4); App.lastUserInput = Date.now(); requestRender(); };
  $('#btn-zout').onclick = () => { const h = v.camera.positionCartographic.height; v.camera.zoomOut(h * 0.6); App.lastUserInput = Date.now(); requestRender(); };
  $('#btn-reset').onclick = () => { SAT.unfollow(); App.flyTo({ type: 'global', daylight: true, force: true, reason: 'reset' }); };
  $('#btn-fit').onclick = fitData;
  $('#flypill').onclick = () => { if (pendingHint) doFly({ ...pendingHint, force: true }); };
}
function fitData() {
  const it = App.selected;
  if (it && it.kind === 'sat') { SAT.followSelected(); return; }
  if (it && it.kind === 'swot') { D.selectSwot(it.id); return; }
  if (it && it.kind === 'nisar') { D.selectNisar(it.id); return; }
  if (it && it.kind === 'aoi') { const b = it.id.split(',').map(Number); const c0 = C.Cartesian3.fromDegrees((b[0] + b[2]) / 2, (b[1] + b[3]) / 2); doFly({ type: 'sphere', center: c0, radius: Math.max(3000, C.Cartesian3.distance(C.Cartesian3.fromDegrees(b[0], b[1]), C.Cartesian3.fromDegrees(b[2], b[3])) / 2 * 1.25) }); return; }
  if (App.layers.nrt) { const L = App.layers.byId[App.layers.nrt]; const R = IM.REGIONS[L.region]; if (R) { doFly({ type: 'region', ...R, force: true }); return; } }
  const N = App.data.nisar;
  if (N.on && N.rows.length) { const pts = N.rows.slice(0, 3000).map(r => C.Cartesian3.fromDegrees(r[7][0], r[7][1])); const bs = C.BoundingSphere.fromPoints(pts); doFly({ type: 'sphere', center: bs.center, radius: bs.radius }); return; }
  if (App.data.quakes.on && App.data.quakes.features.length) { D.fitQuakes(false); return; }
  doFly({ type: 'global', daylight: true });
}

// ================================================================ share link (URL hash) + capture + fullscreen
const saveHash = debounce(() => {
  if (App.restoring) return;
  const S = App.layers, cam = App.viewer.camera, c = cam.positionCartographic;
  const p = new URLSearchParams();
  p.set('b', S.base); if (S.date) p.set('d', S.date); if (S.science) p.set('s', S.science); if (S.nrt) p.set('n', S.nrt);
  if (App.selected) p.set('sel', `${App.selected.kind}:${App.selected.id}`);
  if (App.selected && App.selected.kind === 'point') p.set('pt', App.selected.id);
  p.set('cam', [C.Math.toDegrees(c.longitude).toFixed(3), C.Math.toDegrees(c.latitude).toFixed(3), Math.round(c.height), C.Math.toDegrees(cam.heading).toFixed(1), C.Math.toDegrees(cam.pitch).toFixed(1)].join(','));
  if (App.data.nisar.on) p.set('nisar', App.data.nisar.days);
  if (App.data.swot.on) p.set('swot', '1');
  if (App.data.radar && App.data.radar.on) p.set('s1', App.data.radar.mode);
  history.replaceState(null, '', '#' + p.toString());
}, 800);
async function restoreHash() {
  const h = location.hash.slice(1);
  if (!h) return false;
  const p = new URLSearchParams(h);
  App.restoring = true;
  try {
    if (p.get('d')) App.layers.date = p.get('d');
    if (p.get('b') && App.layers.byId[p.get('b')]) IM.setBase(p.get('b'));
    if (p.get('s')) IM.setScience(p.get('s'));
    if (p.get('n')) IM.setNrt(p.get('n'));
    if (p.get('nisar')) { App.data.nisar.days = p.get('nisar'); D.setNisarOn(true); }
    if (p.get('swot')) D.setSwotOn(true);
    if (p.get('s1')) RD.setRadarOn(true);
    const cam = (p.get('cam') || '').split(',').map(Number);
    if (cam.length === 5 && cam.every(x => !isNaN(x))) {
      App.viewer.camera.setView({ destination: C.Cartesian3.fromDegrees(cam[0], cam[1], cam[2]), orientation: { heading: C.Math.toRadians(cam[3]), pitch: C.Math.toRadians(cam[4]), roll: 0 } });
    }
    const ptq = (p.get('pt') || '').split(',').map(Number);
    if (ptq.length === 2 && ptq.every(Number.isFinite)) {
      App.lastUserInput = Date.now();
      const fly = !(cam.length === 5 && cam.every(x => !isNaN(x)));
      const go = (n = 0) => (App.sats.sats.length && App.layers.catalog.length) || n > 40 ? PT.lookup(ptq[0], ptq[1], { fly }) : setTimeout(() => go(n + 1), 500);
      setTimeout(go, 600);
    }
    const sel = p.get('sel');
    if (sel) {
      const [kind, ...rest] = sel.split(':'); const id = rest.join(':');
      App.lastUserInput = Date.now(); // keep the restored camera
      if (kind === 'sat') await SAT.select(+id, { follow: false });
      else if (kind === 'swot') D.selectSwot(id);
    else if (kind === 'aoi') { const b = id.split(',').map(Number); if (b.length === 4 && b.every(isFinite)) { RD.setRadarOn(true); setTimeout(() => RD.setAoi(b), 2500); } }
      else if (kind === 'quake') setTimeout(() => D.selectQuake(id), 2500);
      else if (kind === 'nisar') setTimeout(() => D.selectNisar(id), 4000);
    }
  } finally { App.restoring = false; }
  return true;
}
function setupButtons() {
  $('#btn-share').onclick = async () => { saveHash(); setTimeout(async () => { try { await navigator.clipboard.writeText(location.href); toast('Share link copied'); } catch (e) { toast('Copy this page URL to share the view'); } }, 900); };
  $('#btn-full').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => toast('Fullscreen is not available here')); };
  $('#btn-capture').onclick = capture;
  $('#btn-about').onclick = () => { $('#about').classList.remove('hidden'); perfLine(); };
  $('#about-close').onclick = () => $('#about').classList.add('hidden');
  $('#about').addEventListener('click', e => { if (e.target.id === 'about') $('#about').classList.add('hidden'); });
  $('#card-close').onclick = closeCard;
  $('#btn-collapse').onclick = () => togglePanel(true);
  $('#panel-open').onclick = () => togglePanel(false);
  $('#btn-ticker').onclick = () => { document.body.classList.toggle('no-ticker'); store.set('ticker', !document.body.classList.contains('no-ticker')); };
  if (store.get('ticker', true) === false) document.body.classList.add('no-ticker');
  $('#credits-line').onclick = () => { $('#about').classList.remove('hidden'); $('#credits-anchor')?.scrollIntoView(); };
  // any control in the panel: repaint the panel after the work it starts (some GPU compositors dropped its tiles)
  const nudgeAfterChange = () => { for (const ms of [30, 700, 2000]) setTimeout(repaintPanel, ms); };
  $('#panel').addEventListener('change', nudgeAfterChange);
  App.events.addEventListener('satgroups', nudgeAfterChange);
  App.viewer.camera.moveEnd.addEventListener(saveHash);
  App.events.addEventListener('layers', () => { saveHash(); highlightActive(); updateCreditsLine(); repaintPanel(); });
}
function repaintPanel() {
  const p = $('#panel'); if (!p) return;
  requestAnimationFrame(() => p.classList.toggle('rp'));   // background flips by 1/255: the panel is re-rastered
}
function attributionLine() {
  const parts = ['Imagery NASA GIBS/EOSDIS'];
  if (App.layers.hires) parts.push(`EOxCloudless ${2025} by EOX IT Services (contains modified Copernicus Sentinel data 2025), CC BY-NC-SA 4.0`);
  if (App.layers.terrain) parts.push('Terrain: Mapzen/AWS Terrain Tiles (USGS SRTM, GMTED2010, 3DEP; NOAA ETOPO1; …)');
  parts.push('Orbits CelesTrak', 'Quakes USGS');
  if (App.data.nisar.on) parts.push('NISAR: NASA/JPL-Caltech, ISRO via ASF DAAC');
  if (App.data.swot.on) parts.push('SWOT: NASA/CNES via PO.DAAC');
  if (App.data.radar && App.data.radar.on) parts.push('Contains modified Copernicus Sentinel data 2026 · Sentinel-1 RTC (Catalyst) via Microsoft Planetary Computer');
  if (PT.opticalCredit()) parts.push(PT.opticalCredit());
  if (App.data.ships.on) parts.push('AIS: aisstream.io');
  if (App.data.ships.gfwOn) parts.push('Powered by Global Fishing Watch (non-commercial)');
  parts.push('Borders: Natural Earth', 'CesiumJS');
  return parts.join(' · ');
}
function updateCreditsLine() { $('#credits-line').textContent = attributionLine(); }
function capture() {
  const s = App.scene, v = App.viewer;
  const once = () => {
    s.postRender.removeEventListener(once);
    try {
      const src = s.canvas;
      const out = document.createElement('canvas');
      out.width = src.width; out.height = src.height;
      const g = out.getContext('2d');
      g.drawImage(src, 0, 0);
      const k = out.width / src.clientWidth;
      const grd = g.createLinearGradient(0, out.height - 70 * k, 0, out.height);
      grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(0,0,0,0.75)');
      g.fillStyle = grd; g.fillRect(0, out.height - 70 * k, out.width, 70 * k);
      g.font = `600 ${18 * k}px Inter, sans-serif`; g.fillStyle = '#d9b25f';
      g.fillText('LION', 18 * k, out.height - 34 * k);
      const w1 = g.measureText('LION ').width;
      g.fillStyle = '#ece4cf'; g.font = `300 ${18 * k}px Inter, sans-serif`; g.fillText('SATELLITE STUDIO', 18 * k + w1, out.height - 34 * k);
      g.font = `${10 * k}px Inter, sans-serif`; g.fillStyle = 'rgba(236,228,207,0.75)';
      g.fillText(`${fmtUTC(SAT.now())} · ${attributionLine()}`.slice(0, 260), 18 * k, out.height - 14 * k);
      out.toBlob(b => {
        const a = el('a', { href: URL.createObjectURL(b), download: `lion-satellite-studio-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png` });
        document.body.append(a); a.click(); a.remove();
        toast('Saved a PNG of this view');
      }, 'image/png');
    } catch (e) { toast('Capture failed: ' + e.message); }
  };
  s.postRender.addEventListener(once);
  s.requestRender();
}

// ================================================================ explore tours
const TOURS = [
  { id: 'iss', icon: '🛰', title: 'Ride along with the ISS', sub: 'live position, orbit & passes', c: FAMILY.sat },
  { id: 'point', icon: '📍', title: 'What sees this spot?', sub: 'Golden Gate: satellites, passes & data', c: FAMILY.gold },
  { id: 'goes', icon: '🌎', title: 'The Americas from GOES right now', sub: 'GeoColor every 10 minutes', c: '#7fd3ff' },
  { id: 'fires', icon: '🔥', title: 'Fires burning today', sub: 'VIIRS 375 m + MODIS', c: FAMILY.fire },
  { id: 'swot', icon: '🌊', title: 'Rivers from space (SWOT)', sub: 'water heights, tap a river', c: FAMILY.water },
  { id: 'night', icon: '🌃', title: 'Earth at night', sub: 'city lights on the dark side', c: FAMILY.night },
  { id: 's1clouds', icon: '☁', title: 'Radar sees through clouds', sub: 'Sentinel-1 vs true colour, swipe', c: '#c4b5fd' },
  { id: 'nisar', icon: '📡', title: 'The radar that sees through clouds', sub: 'NISAR L-band footprints', c: FAMILY.radar },
  { id: 'dark', icon: '🚢', title: 'Ships with their transponders off', sub: 'GFW radar detections', c: FAMILY.ship, needs: 'gfw' },
];
function buildExplore(box, status) {
  const gfwOk = status?.sources?.gfw?.state && status.sources.gfw.state !== 'missing key';
  const row = el('div', { class: 'tours' }, TOURS.filter(t => !t.needs || (t.needs === 'gfw' && gfwOk)).map(t => el('button', { class: 'tour', style: { '--c': t.c }, onclick: () => runTour(t.id) }, el('span', { class: 't-ic' }, t.icon), el('b', {}, t.title), el('small', {}, t.sub))));
  box.replaceChildren(row, el('div', { class: 'hint' }, 'One-tap guided stories: the camera flies, layers switch and the right card opens. Every caption is computed from the live data shown.'));
}
let tourAbort = null;
async function runTour(id) {
  if (tourAbort) tourAbort.abort();
  const ac = new AbortController(); tourAbort = ac;
  App.tourRunning = true;
  if (App.isPhone()) setSheet('peek');
  const bar = $('#tour-bar') || document.body.appendChild(el('div', { id: 'tour-bar', class: 'glass' }));
  const show = (i, n, text) => {
    bar.replaceChildren(el('span', { class: 'step' }, `${i}/${n}`), el('span', { class: 'cap' }, text), el('button', { class: 'btn small', onclick: () => { ac.abort(); } }, 'Done'));
    bar.classList.remove('hidden');
  };
  const wait = ms => new Promise((res, rej) => { const t = setTimeout(res, ms); ac.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('abort')); }); });
  App.lastUserInput = 0;
  try {
    if (id === 'iss') {
      const s = SAT.findSat(25544) || (await SAT.select(25544), SAT.findSat(25544));
      await SAT.select(25544);
      const st = SAT.satState(s, SAT.now());
      const per = 1440 / +s.omm.MEAN_MOTION;
      show(1, 3, `The ISS: ${fmtNum(st.alt)} km up, ${fmtNum(Math.hypot(st.vel.x, st.vel.y, st.vel.z) * 3600)} km/h, one orbit every ${per.toFixed(1)} minutes (from today’s CelesTrak elements).`);
      await wait(6000);
      show(2, 3, `It is over ${App.describePlace(st.lat, st.lon)} right now. Solid line: the last orbit; dashed: the next one.`);
      await wait(6000);
      show(3, 3, 'Open “Passes over me” in the card to see when it crosses your sky.');
      await wait(7000);
    } else if (id === 'goes') {
      IM.setNrt('GOES-East_ABI_GeoColor');
      App.flyTo({ type: 'region', ...IM.REGIONS.goes_east, force: true });
      show(1, 2, 'GOES-East (GOES-19, 75.2°W) GeoColor — loading the newest frame…');
      await wait(3500);
      const S = App.layers;
      const t = S.nrtTimes[S.nrtTimes.length - 1];
      show(2, 2, t ? `Newest GOES-East frame published by GIBS: ${t.slice(11, 16)} UTC. Drag the slider on the map to scrub the last ${S.nrtTimes.length} frames.` : 'GIBS has not published a frame yet — try again shortly.');
      await wait(9000);
    } else if (id === 'fires') {
      IM.setFiresToday(true);
      App.flyTo({ type: 'global', daylight: true, force: true });
      show(1, 2, `Active-fire detections for ${ymd(new Date())} UTC from VIIRS (375 m: Suomi NPP, NOAA-20, NOAA-21) and MODIS (1 km). The layer refreshes every 10 minutes.`);
      await wait(7000);
      show(2, 2, 'Each red dot is a satellite thermal anomaly — mostly vegetation fires, some gas flares and industry.');
      await wait(7000);
    } else if (id === 'swot') {
      D.setSwotOn(true);
      const list = App.data.swot.list;
      const f = list.find(x => /mississippi/i.test(x.name)) || list[0];
      if (!f) { show(1, 1, 'The curated SWOT list is not available.'); await wait(4000); return; }
      show(1, 2, `SWOT measures river and lake heights from space. Flying to ${f.name}…`);
      D.selectSwot(`${f.type}:${f.id}`);
      await wait(4500);
      show(2, 2, `The card shows the water-surface elevation of every SWOT pass over ${f.name} in the last 12 months (provisional values).`);
      await wait(9000);
    } else if (id === 'night') {
      IM.setLighting(true);
      IM.setOverlay('VIIRS_Black_Marble', true);
      doFly({ type: 'night', force: true });
      show(1, 1, 'City lights from VIIRS Black Marble (2016 composite), drawn only on the side of the Earth that is in darkness right now.');
      await wait(9000);
    } else if (id === 'nisar') {
      D.setNisarOn(true);
      await SAT.select(65053);
      show(1, 3, 'NISAR (NASA–ISRO) carries an L-band radar that images through cloud, day or night.');
      await wait(6000);
      const N = App.data.nisar;
      const r = N.rows[0];
      if (r) {
        D.selectNisar(r[0]);
        show(2, 3, `Newest footprint in this view: ${N.body.types[r[1]]}, track ${r[3]}, frame ${r[4]}, acquired ${fmtAgo(Date.now() - r[2] * 60000)} ago.`);
        await wait(8000);
      } else { show(2, 3, 'The footprint catalogue is still being built from ASF — try again in a minute.'); await wait(5000); }
      show(3, 3, 'Footprint colour = product type; faded = older. Downloads need a free Earthdata login.');
      await wait(7000);
    } else if (id === 's1clouds') {
      try { await RD.tourClouds(show, wait); } finally { RD.endTourClouds(); }
    } else if (id === 'point') {
      PT.lookup(37.8199, -122.4783, { name: 'Golden Gate Bridge', h: 9e5 });
      show(1, 3, 'Point report for the Golden Gate Bridge (37.8199, −122.4783): every satellite and dataset that sees this exact spot.');
      await wait(7000);
      show(2, 3, 'Satellites above it now, and the next passes that put it inside an instrument swath, computed from today’s orbits.');
      await wait(8000);
      show(3, 3, 'Then the imagery and products that already exist here: GIBS, Sentinel-1 and -2, Landsat, NISAR, SWOT. Tap a row to show it; right-click (or long-press) anywhere for your own spot.');
      await wait(9000);
    } else if (id === 'dark') {
      App.data.ships.gfwOn = true;
      openSection('ships', true);
      show(1, 1, 'Global Fishing Watch: Sentinel-1 radar detections of vessels that broadcast no AIS. Powered by Global Fishing Watch.');
      await wait(9000);
    }
  } catch (e) { /* aborted */ }
  finally {
    if (tourAbort === ac) { bar.classList.add('hidden'); App.tourRunning = false; tourAbort = null; }
  }
}
App.runTour = runTour;

// ================================================================ intro + coach
async function intro() {
  if (App.reducedMotion || store.get('introSeen') || location.hash.length > 2) return;
  const box = $('#intro');
  App.introRunning = true; App.forceContinuous = true; SAT.updateRenderMode();
  box.classList.remove('hidden');
  const v = App.viewer, ss = subsolar();
  v.camera.setView({ destination: C.Cartesian3.fromDegrees(ss.lon - 70, 25, 1.4e8) });
  let skipped = false;
  const end = () => {
    if (!App.introRunning) return;
    App.introRunning = false; store.set('introSeen', true);
    box.classList.add('fade'); setTimeout(() => box.classList.add('hidden'), 800);
    App.forceContinuous = false; SAT.updateRenderMode();
  };
  $('#intro-skip').onclick = () => { skipped = true; v.camera.cancelFlight(); globalView(ss.lon, ss.lat * 0.6, 0); end(); };
  globalView(ss.lon, ss.lat * 0.6, 3.6, { easingFunction: C.EasingFunction.CUBIC_IN_OUT, complete: () => setTimeout(end, 400), cancel: end });
  // satellites fade in near the end of the flight
  if (App.sats.points) { App.sats.points.show = false; setTimeout(() => { App.sats.points.show = true; if (App.sats.labels) App.sats.labels.show = true; requestRender(); }, 2600); }
}
function coach() {
  if (store.get('coachDone')) return;
  const steps = [
    ['🖐', 'Drag to spin', 'Drag the globe to rotate it. Right-drag (or two fingers) tilts the view.'],
    ['🤏', 'Pinch or scroll to zoom', 'Zoom right down to 10 m imagery and 3D terrain. Double-tap zooms into a spot.'],
    ['👆', 'Tap anything', 'Satellites, quakes, radar footprints, rivers and ships open a detail card.'],
  ];
  let i = 0;
  const box = $('#coach');
  const draw = () => {
    const [ic, h, p] = steps[i];
    box.replaceChildren(el('div', { class: 'cbox glass' }, el('div', { class: 'big' }, ic), el('h3', {}, h), el('p', {}, p),
      el('div', { class: 'dots' }, steps.map((_, k) => el('i', { class: k === i ? 'on' : '' }))),
      el('div', { class: 'row', style: { justifyContent: 'center' } }, el('button', { class: 'btn ghost small', onclick: done }, 'Skip'), el('button', { class: 'btn gold small', onclick: () => { i++; i < steps.length ? draw() : done(); } }, i < steps.length - 1 ? 'Next' : 'Start exploring'))));
  };
  const away = e => { if (!e.target.closest || !e.target.closest('.cbox')) done(); };
  const done = () => { box.classList.add('hidden'); store.set('coachDone', true); window.removeEventListener('pointerdown', away, true); };
  window.addEventListener('pointerdown', away, true);
  box.classList.remove('hidden');
  draw();
}

// ================================================================ about / attribution
function buildAbout(status) {
  const b = $('#about-body');
  b.innerHTML = `
  <p>Lion Satellite Studio is a live 3D globe of open satellite data. Everything shown is keyless and fetched from the providers below; the server caches every upstream (CelesTrak ≥ 2 h, USGS 5 min, GIBS catalogue 6 h, ASF hourly, Hydrocron 12 h) and is not an open proxy.</p>
  <p class="small">Created by <a href="https://github.com/sunnychase" target="_blank" rel="noopener">Sunny Chase</a> in collaboration with Claude (Anthropic). Open source under the MIT licence: <a href="https://github.com/sunnychase/lion-satellite-studio" target="_blank" rel="noopener">github.com/sunnychase/lion-satellite-studio</a>.</p>
  <h3>Data rules</h3>
  <ul><li>Satellite positions are propagated in your browser with SGP4 (satellite.js) from CelesTrak general-perturbation elements.</li>
  <li>Imagery tiles load directly from NASA GIBS and EOX; terrain from the AWS Open Data terrain tiles.</li>
  <li>NISAR products are provisional; footprints and browse images need no login, downloads need a free NASA Earthdata account.</li>
  <li>SWOT values are provisional and are reprocessed under new version letters (CRID).</li></ul>
  <h3 id="credits-anchor">Credits &amp; licences</h3>
  <ul>
  <li><b>CelesTrak</b> GP element sets — <a href="https://celestrak.org" target="_blank" rel="noopener">celestrak.org</a> (T.S. Kelso). Cached ≥ 2 h per group as CelesTrak requests.</li>
  <li><b>NASA GIBS / EOSDIS</b> — “We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).” NASA data are open with no restrictions on use.</li>
  <li><b>EOxCloudless 2025</b> — “EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)”, licensed <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener">CC BY-NC-SA 4.0</a> (non-commercial use).</li>
  <li><b>Terrain</b> — Mapzen / AWS Open Data Terrain Tiles: ArcticDEM (DigitalGlobe imagery, NSF awards 1043681, 1559691, 1542736); Australia © Commonwealth of Australia (Geoscience Australia) 2017; Austria © offene Daten Österreichs – DGM; Canada: Open Government Licence – Canada; Europe: Copernicus EU-DEM; global ETOPO1 (U.S. NOAA); Mexico: INEGI Continental relief 2016; New Zealand © LINZ (Crown copyright); Norway © Kartverket; UK © Environment Agency 2015; United States 3DEP (formerly NED) and global GMTED2010 and SRTM courtesy of the U.S. Geological Survey.</li>
  <li><b>USGS</b> earthquake feeds — public domain, U.S. Geological Survey.</li>
  <li><b>NISAR</b> — NASA/JPL-Caltech and ISRO; data via the Alaska Satellite Facility DAAC (ASF SearchAPI). NASA data are free and open; cite “ASF DAAC 2026, contains modified NISAR data”.</li>
  <li><b>SWOT</b> — NASA/JPL and CNES; Hydrocron time series via NASA PO.DAAC.</li>
  <li><b>Sentinel-1</b> — “Contains modified Copernicus Sentinel data [2025–2026]”, used under the <a href="https://sentinel.esa.int/documents/247904/690755/Sentinel_Data_Legal_Notice" target="_blank" rel="noopener">Copernicus Sentinel data legal notice</a> (free, full and open). The radiometrically terrain corrected (RTC) γ⁰ product is processed by Catalyst and published on <b>Microsoft Planetary Computer</b> under <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>; search, tiles and data are used under the <a href="https://planetarycomputer.microsoft.com/terms" target="_blank" rel="noopener">Planetary Computer terms of use</a>. Data are read with anonymous, short-lived SAS tokens (no subscription key; PC rate-limits anonymous use; its RTC docs say an account may be required, so the analysis disables itself if tokens are refused). False-colour render adapted from Sentinel Hub custom scripts (CC BY 4.0), as documented by PC. Analyses are automatic estimates, not validated.</li>
  <li><b>Address search</b> — © <b>OpenStreetMap contributors</b>, ODbL; search by Nominatim (nominatim.openstreetmap.org) through this server, only when you press Enter, cached 30 days, at most 1 request per second. Please don’t search for private addresses you would not share: queries are sent to the OpenStreetMap Foundation (see its privacy policy).</li>
  <li><b>Point report data</b> — <b>Sentinel-2 L2A</b>: “Contains modified Copernicus Sentinel data [2025–2026]” (Copernicus Sentinel data legal notice); <b>Landsat Collection 2 Level-2</b>: courtesy of the U.S. Geological Survey, public domain; <b>HLS v2.0</b> (L30/S30): NASA LP DAAC, free and open; all via Microsoft Planetary Computer (STAC point search and the tiler, under its terms of use). <b>SWOT reaches near a point</b>: SWOT_L2_HR_RiverSP reach (version D) feature service on NASA Earthdata GIS (NASA/JPL, CNES), keyless. NISAR point search: ASF SearchAPI. Pass and swath geometry are computed in your browser.</li>
  <li><b>ESA WorldCover 2021 v200</b> (ship-detection land mask, read server-side from Planetary Computer) — “© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium”, CC BY 4.0.</li>
  <li><b>3D models</b> — NASA 3D Resources (free to use; NASA Images and Media Usage Guidelines): ISS (NASA/Michael D. Carbajal), Terra (NASA/Christian A. Lopez), Aqua, Landsat 8 (also used for Landsat 9), GPM, ICESat-2, OCO-2, GOES (NASA/Christopher R. Meaney), Suomi NPP (NASA/Brian E. Kumanchik, Christian A. Lopez; also used for NOAA-20/21), GRACE (NASA/Christopher M. Garcia; stand-in for GRACE-FO). Generic model for SMAP, SWOT, PACE, NISAR and IS-40E.</li>
  <li><b>Natural Earth</b> borders and gazetteer — public domain. Made with Natural Earth.</li>
  <li><b>CesiumJS</b> 1.146 — Apache License 2.0. <b>satellite.js</b> 7.1 — MIT. <b>Inter</b> and <b>JetBrains Mono</b> fonts — SIL Open Font License 1.1.</li>
  <li><b>aisstream.io</b> live AIS (only when you add a key). No published terms page; data used for personal, non-commercial viewing.</li>
  <li><b>Global Fishing Watch</b> (only when you add a token) — “Powered by Global Fishing Watch.” <a href="https://globalfishingwatch.org" target="_blank" rel="noopener">globalfishingwatch.org</a>. CC BY-NC 4.0, <b>non-commercial use only</b>.</li>
  </ul>
  <h3>Keys (optional sources)</h3>
  <p>Ships and dark-vessel layers stay off until you write the server’s keys file (<code>keys.env</code>, or the path in <code>LSS_KEYS_FILE</code>) with <code>AISSTREAM_API_KEY=…</code> and/or <code>GFW_API_TOKEN=…</code> and restarts the service. Keys stay on the server and are never sent to the browser. Status now: aisstream <b>${status?.sources?.aisstream?.state || 'unknown'}</b>, Global Fishing Watch <b>${status?.sources?.gfw?.state || 'unknown'}</b>.</p>
  <h3>Performance on this device</h3>
  <p class="mono" id="perf-line">measuring…</p>
  <h3>Coming later (needs an account or a sky view)</h3>
  <ul><li>NISAR GCOV backscatter tiles and other product downloads — need a NASA Earthdata login.</li>
  <li>InSAR ground deformation (ASF HyP3 on-demand interferograms) and NISAR GUNW — need a NASA Earthdata login.</li>
  <li>Copernicus / Sentinel Hub imagery — needs an account.</li><li>FIRMS API (fire detections as points) — needs a MAP_KEY.</li>
  <li>USGS EarthExplorer scenes — needs a login.</li><li>Hubble / JWST / MAST sky data — needs a sky view.</li><li>SDO / SOHO solar imagery — needs a sky view.</li></ul>`;
}

// ================================================================ perf watchdog
function perfWatch() {
  let frames = 0, slow = 0, t0 = performance.now(), lastT = performance.now();
  App.fps = null;
  App.scene.postRender.addEventListener(() => {
    const t = performance.now();
    const dt = t - lastT; lastT = t;
    frames++;
    if (dt > 33 && dt < 400) slow++;
    if (t - t0 > 3000) {
      const continuous = !App.scene.requestRenderMode;
      App.fps = frames / ((t - t0) / 1000);
      if (continuous && frames > 20 && slow / frames > 0.5 && !App.lowPower) degrade();
      frames = 0; slow = 0; t0 = t;
    }
  });
}
function perfLine() {
  const p = $('#perf-line');
  if (!p || $('#about').classList.contains('hidden')) return;
  const s = App.sats;
  p.textContent = `${App.fps ? App.fps.toFixed(1) : '—'} frames/s (${App.scene.requestRenderMode ? 'render on demand' : 'continuous'}) · SGP4 for ${fmtNum(s.sats.length)} satellites: ${s.propMs ? s.propMs.toFixed(1) : '—'} ms in a worker, ${s.applyMs ? s.applyMs.toFixed(1) : '—'} ms on the main thread · low-power mode: ${App.lowPower ? 'on' : 'off'}`;
  setTimeout(perfLine, 3000);
}
function degrade() {
  App.lowPower = true;
  if (!App.lowMem) App.setLowMem(true, 'slow frames');
  const g = App.scene.globe;
  g.maximumScreenSpaceError = Math.min(4, g.maximumScreenSpaceError + 1.5);
  App.scene.postProcessStages.fxaa.enabled = false;
  if (App.isPhone()) App.viewer.resolutionScale = 0.85;
  console.info('Lion Satellite Studio: frame time > 33 ms — reduced terrain detail and model count');
}

// ================================================================ boot
function noWebGL(err) {
  console.error(err);
  $('#panel')?.classList.add('hidden');
  document.body.append(el('div', { class: 'nogl glass' }, el('h2', {}, 'This browser can’t draw the 3D globe here'),
    el('p', {}, 'Lion Satellite Studio needs WebGL, and this browser did not provide it (it may be switched off, blocked for this graphics driver, or unavailable in a remote or virtual session).'),
    el('p', {}, 'Try a current Firefox, Chrome, Edge or Safari on this device, or switch the browser’s hardware acceleration back on, then reload.'),
    el('button', { class: 'btn gold', onclick: () => location.reload() }, 'Reload')));
}
async function boot() {
  try { makeViewer(); } catch (e) { noWebGL(e); return; }
  watchInput(App.scene.canvas);
  buildPanel();
  setupSheet();
  setupSearch();
  setupButtons();
  setupScaleCompass();
  setupPicking();
  PT.setupPointPicking();
  idleLoop();
  perfWatch();
  let status = null;
  try { status = (await getJSON('/api/status')).body; } catch (e) { /* offline */ }
  buildAbout(status);
  buildExplore(secBodies.explore, status);
  buildTime(secBodies.time);
  loadGazetteer();
  await IM.initImagery(App.viewer);
  IM.buildUI({ imagery: secBodies.imagery, nrt: secBodies.nrt, science: secBodies.science, overlays: secBodies.overlays });
  { const t = IM.toggle('Low-memory mode (busy or small GPUs): fewer footprints, no 3D models, terrain or hi-res backdrop', App.lowMem, v => App.setLowMem(v)); t.id = 'lowmem-toggle'; secBodies.imagery.append(t); }
  if (App.lowMem) applyMemMode();
  if (App.softNotice) setTimeout(() => toast('This browser draws 3D in software here, so a lighter view is on (Low-memory mode, under Imagery & terrain).', 8000), 4000);
  await D.initSwot();
  D.buildSwotUI(secBodies.swot);
  D.buildQuakeUI(secBodies.quakes);
  D.buildNisarUI(secBodies.nisar);
  D.buildShipUI(secBodies.ships, status);
  RD.buildRadarUI(secBodies.radar);
  PT.buildPointUI(secBodies.point);
  secBodies.about.replaceChildren(el('button', { class: 'btn', onclick: () => $('#about').classList.remove('hidden') }, 'Open credits, licences & about'), el('div', { class: 'hint' }, 'Required credits are always shown in small type at the bottom of the map; tap it for the full list.'));
  const satsP = SAT.initSats().then(() => SAT.buildUI(secBodies.sats)).catch(e => { console.error(e); toast('Satellites unavailable right now — retrying in 5 min'); setTimeout(() => SAT.refreshGroups(), 300e3); });
  SAT.buildUI(secBodies.sats);
  D.initQuakes();
  startClock();
  updateCreditsLine();
  highlightActive();
  const restored = await restoreHash();
  if (!restored) intro();
  await satsP;
  if (!restored && !App.introRunning) coach(); else setTimeout(() => { if (!store.get('coachDone')) coach(); }, 4500);
  if (App.isPhone()) togglePanel(false);
  App.clientVersion = status && status.client_version;
  setInterval(async () => { try { const s = (await getJSON('/api/status')).body; App.serverStatus = s;
    if (App.clientVersion && s.client_version && s.client_version !== App.clientVersion && !$('#update-note')) {
      document.body.append(el('div', { id: 'update-note', class: 'glass gfx-note' }, el('b', {}, 'Updated'), el('span', {}, ' — a newer version of the page is on the server.'),
        el('button', { class: 'btn small gold', onclick: () => location.reload() }, 'Reload'), el('button', { class: 'btn small ghost', onclick: e => e.target.closest('#update-note').remove() }, 'Later')));
    } } catch (e) { /* ignore */ } }, 60e3);
  App.ready = true;
  requestRender();
}
boot().catch(e => { console.error(e); toast('Lion Satellite Studio failed to start: ' + e.message, 10000); });
