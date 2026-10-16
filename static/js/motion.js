// Lion Satellite Studio — Created by Sunny Chase (https://github.com/sunnychase) in collaboration with Claude (Anthropic)
// Smooth motion + horizon culling. Moving layers (satellites, AIS ships) register here; between
// their data updates they are dead-reckoned (last fix + velocity), never further than one update interval past the
// newest data. Each pass skips objects below the horizon or outside the view: they are not moved, and the ones behind
// the Earth are hidden. Passes run just before a frame, only as often as the fastest visible object moves about a
// pixel (at least once per data update), so in render-on-demand mode the globe still sits idle when nothing visible moves.
import { App, requestRender } from './util.js';

const C = window.Cesium;
const A = 6378137.0, B = 6356752.314245;        // WGS84 radii (m): horizon test in the ellipsoid's scaled space
const layers = [];
const M = App.motion = {
  layers, last: 0, ms: [], ticks: 0, interval: 1000, busy: false, forced: false, li: 0,
  register(layer) { layers.push(layer); kick(); },
  kick: () => kick(),
  stats,
};

// ---------------------------------------------------------------- per-pass view context (built once per pass)
const ctx = { q: new C.Cartesian3(), vh: 0, planes: [], cam: new C.Cartesian3(), pxAngle: 1e-3, now: 0 };
function buildCtx() {
  const cam = App.viewer.camera, s = App.scene;
  const p = cam.positionWC;
  C.Cartesian3.clone(p, ctx.cam);
  ctx.q.x = p.x / A; ctx.q.y = p.y / A; ctx.q.z = p.z / B;
  ctx.vh = ctx.q.x * ctx.q.x + ctx.q.y * ctx.q.y + ctx.q.z * ctx.q.z - 1;
  try { ctx.planes = cam.frustum.computeCullingVolume(p, cam.directionWC, cam.upWC).planes; } catch (e) { ctx.planes = []; }
  const fovy = cam.frustum.fovy || 1.0;
  ctx.pxAngle = fovy / Math.max(1, s.drawingBufferHeight || s.canvas.height || 900);
  ctx.now = Date.now();
  return ctx;
}
// 1 = visible, 0 = outside the view, -1 = behind the Earth. r: margin in metres around the point.
export function cull(x, y, z, r = 0) {
  // horizon (Cesium's EllipsoidalOccluder test, inlined)
  if (ctx.vh > 0) {
    const px = x / A - ctx.q.x, py = y / A - ctx.q.y, pz = z / B - ctx.q.z;
    const d = -(px * ctx.q.x + py * ctx.q.y + pz * ctx.q.z);
    if (d > ctx.vh && d * d / (px * px + py * py + pz * pz) > ctx.vh) return -1;
  }
  const pl = ctx.planes;
  for (let i = 0; i < pl.length; i++) { const n = pl[i]; if (n.x * x + n.y * y + n.z * z + n.w < -r) return 0; }
  return 1;
}
// on-screen speed (pixels per second) of something moving v m/s at (x, y, z)
export function pxSpeed(v, x, y, z) {
  const dx = x - ctx.cam.x, dy = y - ctx.cam.y, dz = z - ctx.cam.z;
  return v / (Math.sqrt(dx * dx + dy * dy + dz * dz) * ctx.pxAngle + 1e-6);
}
export const view = ctx;

// ---------------------------------------------------------------- the pass
function minGap() { return App.softGL ? 500 : App.lowMem ? 200 : App.isPhone() ? 66 : 50; }   // at most 20 passes/s
// main-thread time per frame for the pass: a sweep normally ends in one frame (one buffer rewrite per collection);
// only very large ones (All active on a slow device) continue on the next frames
const budget = () => App.isPhone() || App.lowMem ? 5 : 8;
function pass() {
  if (!App.scene || M.busy) return false;
  M.busy = true;
  const t0 = performance.now(), deadline = t0 + budget();
  let changed = 0, partial = false;
  try {
    buildCtx();
    for (let k = M.li; k < layers.length; k++) {
      const L = layers[k];
      if (!L.active()) continue;
      const r = L.update(ctx, deadline) || {};
      changed += r.changed || 0;
      if (r.partial) { M.li = k; partial = true; break; }   // out of time: this layer resumes on the next frame
      L.lastPx = r.px || 0; L.lastGap = r.maxGap || 1000;
    }
    if (!partial) M.li = 0;
    M.forced = M.forced || partial;
    // the next pass when the fastest visible object has moved ~0.75 px, but at least once per its update interval
    let want = 1000;
    for (const L of layers) if (L.active()) want = Math.min(want, L.lastPx > 0 ? 750 / L.lastPx : Infinity, L.lastGap || 1000);
    M.interval = Math.max(minGap(), want);
  } catch (e) { console.error('motion', e); M.li = 0; }
  M.busy = false;
  const dt = performance.now() - t0;
  M.ms.push(dt); if (M.ms.length > 600) M.ms.shift();
  M.ticks++;
  M.last = performance.now();
  return changed > 0;
}
// Cesium raises preUpdate on every animation frame, also when render-on-demand skips drawing: run a pass when one is
// due and ask for that frame to be drawn. While a finger or mouse is down on the globe there are no passes at all (the
// drag throttle keeps the main thread for the camera, as before): when the drag starts, everything hidden behind the
// Earth is shown once, placed where it is now, so the parts of the globe that rotate into view are complete; the
// next pass after the release hides them again.
function onPreUpdate() {
  if (!layers.length || document.hidden) return;
  if (App.pointerDown) {
    if (!M.dragging) { M.dragging = true; M.li = 0; let n = 0; for (const L of layers) if (L.active() && L.unhideAll) n += L.unhideAll(); for (const L of layers) if (L.acc) L.i = 0; if (n) requestRender(); }
    return;
  }
  if (M.dragging) { M.dragging = false; M.forced = true; }
  const now = performance.now();
  if (M.forced || M.li || now - M.last >= M.interval) { M.forced = false; if (pass()) requestRender(); }
}
function kick() { M.forced = true; }
let camT = 0;
export function initMotion() {
  App.scene.preUpdate.addEventListener(onPreUpdate);
  // the view changed: re-cull soon (throttled), so objects coming over the horizon are shown
  App.viewer.camera.changed.addEventListener(() => { const n = performance.now(); if (n - camT > 300) { camT = n; kick(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  App.viewer.camera.moveEnd.addEventListener(() => kick());   // the camera rests: apply the hides that waited
}

function stats() {
  const a = [...M.ms].sort((x, y) => x - y);
  const mean = a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const out = { passes: M.ticks, passMsMean: +mean.toFixed(2), passMsP95: a.length ? +a[Math.floor(a.length * 0.95)].toFixed(2) : 0, intervalMs: Math.round(M.interval) };
  for (const L of layers) if (L.stats) out[L.name] = L.stats();
  return out;
}
