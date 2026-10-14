// Lion Satellite Studio — Created by Sunny Chase (https://github.com/sunnychase) in collaboration with Claude (Anthropic)
// Pass prediction worker for the Point report: rise / peak / set of each satellite over one point (elevation above
// 10 degrees), the maximum elevation, and whether the pass can be seen with the eye (the satellite is sunlit while the
// sun is more than 6 degrees below the point's horizon). SGP4 (satellite.js) runs here so the page never freezes.
import { json2satrec } from '../vendor/satellite/io.js';
import { propagate } from '../vendor/satellite/propagation.js';
import { gstime } from '../vendor/satellite/propagation/gstime.js';
import { eciToEcf, ecfToLookAngles, degreesToRadians, radiansToDegrees } from '../vendor/satellite/transforms.js';
import { sunPos } from '../vendor/satellite/sun.js';
import { jday } from '../vendor/satellite/ext.js';

const RE = 6378.137, AU = 149597870.7;
const MIN_EL = 10, STEP = 30e3, VIS_STEP = 10e3;

function look(rec, og, t) {
  const d = new Date(t);
  let pv;
  try { pv = propagate(rec, d); } catch (e) { return null; }
  if (!pv || !pv.position || typeof pv.position === 'boolean' || isNaN(pv.position.x)) return null;
  const ecf = eciToEcf(pv.position, gstime(d));
  const la = ecfToLookAngles(og, ecf);
  return { el: radiansToDegrees(la.elevation), az: radiansToDegrees(la.azimuth), ecf };
}
function sunEcf(t) {
  const d = new Date(t), s = sunPos(jday(d));
  return eciToEcf({ x: s.rsun.x * AU, y: s.rsun.y * AU, z: s.rsun.z * AU }, gstime(d));
}
// in sunlight: on the sun side of the Earth, or outside the cylinder of its shadow
function sunlit(ecf, sun) {
  const sl = Math.hypot(sun.x, sun.y, sun.z), sx = sun.x / sl, sy = sun.y / sl, sz = sun.z / sl;
  const p = ecf.x * sx + ecf.y * sy + ecf.z * sz;
  if (p > 0) return true;
  return Math.hypot(ecf.x - p * sx, ecf.y - p * sy, ecf.z - p * sz) > RE;
}
// time where the elevation crosses MIN_EL between a (below) and b (above), or the other way round
function crossing(rec, og, a, b) {
  const up = (look(rec, og, b) || { el: -90 }).el > MIN_EL;
  for (let i = 0; i < 12; i++) {
    const m = (a + b) / 2, e = (look(rec, og, m) || { el: -90 }).el;
    if ((e > MIN_EL) === up) b = m; else a = m;
  }
  return (a + b) / 2;
}
function peak(rec, og, a, b) {
  const g = 0.381966;
  let c = a + g * (b - a), d = b - g * (b - a);
  let fc = (look(rec, og, c) || { el: -90 }).el, fd = (look(rec, og, d) || { el: -90 }).el;
  for (let i = 0; i < 30 && b - a > 500; i++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = a + g * (b - a); fc = (look(rec, og, c) || { el: -90 }).el; }
    else { a = c; c = d; fc = fd; d = b - g * (b - a); fd = (look(rec, og, d) || { el: -90 }).el; }
  }
  return fc > fd ? c : d;
}
function passesOf(rec, og, t0, t1) {
  const out = [];
  let prev = look(rec, og, t0), tp = t0, rise = null;
  if (!prev) return out;
  if (prev.el > MIN_EL) rise = t0;                       // already up at the start
  for (let t = t0 + STEP; t <= t1; t += STEP) {
    const cur = look(rec, og, t);
    if (!cur) break;
    if (prev.el <= MIN_EL && cur.el > MIN_EL) rise = crossing(rec, og, tp, t);
    else if (prev.el > MIN_EL && cur.el <= MIN_EL && rise !== null) { out.push(finish(rec, og, rise, crossing(rec, og, tp, t))); rise = null; }
    prev = cur; tp = t;
  }
  if (rise !== null) out.push(finish(rec, og, rise, null));
  return out;
}
function finish(rec, og, rise, set) {
  const end = set ?? rise + 20 * 60e3;
  const tpk = peak(rec, og, rise, end);
  const pk = look(rec, og, tpk), r0 = look(rec, og, rise), s0 = set ? look(rec, og, set) : null;
  // visible to the eye: some moment of the pass with the satellite sunlit and the sun below -6 degrees at the point
  let visFrom = null, visTo = null, litAny = false, darkAny = false;
  for (let t = rise; t <= end; t += VIS_STEP) {
    const L = look(rec, og, t); if (!L || L.el < MIN_EL - 0.5) continue;
    const sun = sunEcf(t);
    const lit = sunlit(L.ecf, sun), dark = radiansToDegrees(ecfToLookAngles(og, sun).elevation) < -6;
    litAny = litAny || lit; darkAny = darkAny || dark;
    if (lit && dark) { if (visFrom === null) visFrom = t; visTo = t; }
  }
  const sunPk = radiansToDegrees(ecfToLookAngles(og, sunEcf(tpk)).elevation);
  return { rise, peak: tpk, set, maxEl: pk ? pk.el : null, azRise: r0 ? r0.az : null, azPeak: pk ? pk.az : null, azSet: s0 ? s0.az : null,
    visible: visFrom !== null, visFrom, visTo, sunlit: litAny, dark: darkAny, sunElPeak: sunPk };
}

self.onmessage = ev => {
  const m = ev.data;
  if (m.type !== 'passes') return;
  const og = { latitude: degreesToRadians(m.lat), longitude: degreesToRadians(m.lon), height: (m.h || 0) / 1000 };
  const t1 = m.t0 + m.hours * 3600e3;
  const all = [];
  m.sats.forEach((s, i) => {
    let rec = null;
    try { rec = json2satrec(s.omm); } catch (e) { rec = null; }
    if (rec && !rec.error) for (const p of passesOf(rec, og, m.t0, t1)) all.push({ norad: s.norad, ...p });
    if (i % 4 === 3) self.postMessage({ type: 'progress', id: m.id, done: i + 1, of: m.sats.length });
  });
  all.sort((a, b) => a.rise - b.rise);
  self.postMessage({ type: 'passes', id: m.id, passes: all, t0: m.t0, hours: m.hours });
};
