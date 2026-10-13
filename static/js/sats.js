// Lion Satellite Studio — satellites: CelesTrak GP data, SGP4 in a Web Worker, points/labels,
// selection card, orbit + ground track, swath + sensor cone, 3D models, eclipse, passes.
import { App, $, el, getJSON, chip, tick, fmtAgo, fmtUTC, fmtNum, store, toast, sparkline, requestRender, FAMILY, esc } from './util.js';
import { json2satrec } from '../vendor/satellite/io.js';
import { propagate } from '../vendor/satellite/propagation.js';
import { gstime } from '../vendor/satellite/propagation/gstime.js';
import { eciToEcf, eciToGeodetic, ecfToLookAngles, degreesToRadians, radiansToDegrees } from '../vendor/satellite/transforms.js';
import { sunPos } from '../vendor/satellite/sun.js';
import { jday } from '../vendor/satellite/ext.js';
import { toggle } from './imagery.js';

const C = window.Cesium;
const RE = 6378.137;      // km
const MU = 398600.4418;   // km^3/s^2

export const GROUPS = [
  { id: 'fleet', title: 'NASA Earth fleet', color: '#ffd27a', desc: '21 curated Earth-observing satellites (by NORAD id)' },
  { id: 'stations', title: 'Space stations', color: '#ffffff' },
  { id: 'visual', title: 'Brightest (visual)', color: '#fff3c4' },
  { id: 'weather', title: 'Weather', color: '#7fd3ff' },
  { id: 'resource', title: 'Earth resources / imaging', color: '#8ef0c0' },
  { id: 'science', title: 'Science', color: '#c4b5fd' },
  { id: 'gps-ops', title: 'GPS (operational)', color: '#ffb86b' },
  { id: 'galileo', title: 'Galileo', color: '#9ec5ff' },
  { id: 'geo', title: 'Geostationary', color: '#f59fd0' },
  { id: 'last-30-days', title: 'Launched last 30 days', color: '#ff7b7b' },
  { id: 'starlink', title: 'Starlink', color: '#7aa2ff' },
  { id: 'active', title: 'All active (~16k)', color: '#38e1ff' },
];
// NASA Earth fleet: colour, short label, model slug
export const FLEET = {
  25544: ['#ffffff', 'ISS', 'iss'], 25994: ['#ffcf5a', 'Terra', 'terra'], 27424: ['#5ac8ff', 'Aqua', 'aqua'],
  37849: ['#ff9f43', 'Suomi NPP', 'jpss'], 43013: ['#ffb36b', 'NOAA-20', 'jpss'], 54234: ['#ffc78f', 'NOAA-21', 'jpss'],
  39084: ['#7ee787', 'Landsat 8', 'landsat8'], 49260: ['#56d364', 'Landsat 9', 'landsat9'], 39574: ['#4aa3ff', 'GPM', 'gpm'],
  40376: ['#d2a8ff', 'SMAP', 'generic'], 43613: ['#a5f3fc', 'ICESat-2', 'icesat2'], 43476: ['#f0abfc', 'GRACE-FO 1', 'gracefo'],
  43477: ['#f5d0fe', 'GRACE-FO 2', 'gracefo'], 54754: ['#38bdf8', 'SWOT', 'generic'], 40059: ['#bef264', 'OCO-2', 'oco2'],
  58928: ['#22d3ee', 'PACE', 'generic'], 65053: ['#a78bfa', 'NISAR', 'generic'], 41866: ['#fda4af', 'GOES-16', 'goes'],
  51850: ['#fb7185', 'GOES-18', 'goes'], 60133: ['#f43f5e', 'GOES-19', 'goes'], 56174: ['#fcd34d', 'IS-40E (TEMPO)', 'generic'],
};

const st = App.sats = {
  enabled: new Set(store.get('groups', ['fleet'])),
  groupData: {}, groupMeta: {}, groupCounts: {},
  sats: [],          // merged list: {omm, norad, name, groups:Set, color, fleet, rec, cls}
  byNorad: new Map(),
  points: null, labels: null, worker: null, busy: false, seq: 0, lastPos: null, lastVel: null,
  speed: 1, simBase: Date.now(), wallAnchor: Date.now(),
  selected: null, follow: true, ents: [], models: new Map(), missions: {}, manifest: {},
  hover: null, labelsOn: store.get('satLabels', true),
};

// ------------------------------------------------------------------ simulated clock
export function now() { return st.simBase + (Date.now() - st.wallAnchor) * st.speed; }
export function setSpeed(sp) {
  st.simBase = now(); st.wallAnchor = Date.now(); st.speed = sp;
  App.events.dispatchEvent(new Event('speed'));
  restartLoop();
}
export function resetNow() { st.simBase = Date.now(); st.wallAnchor = Date.now(); st.speed = 1; App.events.dispatchEvent(new Event('speed')); restartLoop(); }

// ------------------------------------------------------------------ load groups
function classify(o) {
  const n = +o.MEAN_MOTION, e = +o.ECCENTRICITY;
  const per = 1440 / n;
  if (e > 0.25) return 'HEO';
  if (per < 128) return 'LEO';
  if (per > 1380 && per < 1500) return 'GEO';
  return 'MEO';
}

async function loadGroup(g) {
  if (st.groupData[g]) return;
  const r = await getJSON(`/api/sats?group=${encodeURIComponent(g)}`);
  st.groupData[g] = r.body;
  st.groupMeta[g] = { fetched: r.fetched, cache: r.cache };
  st.groupCounts[g] = r.body.length;
}

export async function refreshGroups() {
  const want = [...st.enabled];
  const errs = [];
  await Promise.all(want.map(g => loadGroup(g).catch(e => { errs.push(`${g}: ${e.message}`); })));
  if (errs.length) toast(`Satellite data unavailable (${errs.join('; ')}) — retrying in a few minutes`, 6000);
  rebuild();
  store.set('groups', want);
  App.events.dispatchEvent(new Event('satgroups'));
}

function rebuild() {
  const merged = new Map();
  for (const g of st.enabled) {
    for (const o of st.groupData[g] || []) {
      const id = o.NORAD_CAT_ID;
      let s = merged.get(id);
      if (!s) {
        s = { omm: o, norad: id, name: o.OBJECT_NAME, groups: new Set(), cls: classify(o) };
        merged.set(id, s);
      }
      s.groups.add(g);
      if (Date.parse(o.EPOCH + 'Z') > Date.parse(s.omm.EPOCH + 'Z')) s.omm = o;
    }
  }
  st.sats = [...merged.values()];
  st.byNorad = merged;
  for (const s of st.sats) {
    const f = FLEET[s.norad];
    s.fleet = !!f;
    s.color = f ? f[0] : (GROUPS.find(g => s.groups.has(g.id) && g.id !== 'fleet') || GROUPS[0]).color;
    s.short = f ? f[1] : s.name;
  }
  buildPrimitives();
  st.seq++;
  st.worker.postMessage({ type: 'load', sats: st.sats.map(s => s.omm), seq: st.seq });
  // TLE age chip: median epoch age of what is shown
  const ages = st.sats.map(s => Date.now() - Date.parse(s.omm.EPOCH + 'Z')).filter(x => !isNaN(x)).sort((a, b) => a - b);
  const med = ages.length ? ages[Math.floor(ages.length / 2)] : null;
  const fetchedAges = Object.values(st.groupMeta).map(m => Date.now() - Date.parse(m.fetched)).filter(x => !isNaN(x));
  const fa = fetchedAges.length ? Math.max(...fetchedAges) : null;
  chip('sats', `${fmtNum(st.sats.length)} satellites`, st.sats.length ? 'ok' : 'warn', 'satellites tracked');
  chip('tle', `TLE ${fmtAgo(med)} old`, med > 3 * 86400e3 ? 'warn' : 'ok', `median element-set epoch age; CelesTrak data fetched ${fmtAgo(fa)} ago (server caches >= 2 h)`);
}

function buildPrimitives() {
  const scene = App.scene;
  if (st.points) scene.primitives.remove(st.points);
  if (st.labels) scene.primitives.remove(st.labels);
  st.points = scene.primitives.add(new C.PointPrimitiveCollection({ blendOption: C.BlendOption.TRANSLUCENT }));
  st.labels = scene.primitives.add(new C.LabelCollection());
  const big = st.sats.length > 3000;
  const sbd = new C.NearFarScalar(2.0e6, 1.5, 4.5e7, big ? 0.45 : 0.75);
  const tbd = big ? new C.NearFarScalar(1.2e7, 1.0, 6.0e7, 0.35) : undefined;
  st.sats.forEach((s, i) => {
    const col = C.Color.fromCssColorString(s.color);
    s.pt = st.points.add({
      position: C.Cartesian3.ZERO, pixelSize: s.fleet ? 7 : (big ? 2.5 : 4), color: col,
      outlineColor: s.fleet ? C.Color.BLACK.withAlpha(0.6) : C.Color.TRANSPARENT, outlineWidth: s.fleet ? 1.5 : 0,
      scaleByDistance: sbd, translucencyByDistance: tbd, show: false, id: { kind: 'sat', norad: s.norad },
      disableDepthTestDistance: 0,
    });
    if (s.fleet || st.sats.length < 400) {
      s.lbl = st.labels.add({
        position: C.Cartesian3.ZERO, text: s.short, font: '500 12px Inter, sans-serif', fillColor: col,
        outlineColor: C.Color.BLACK.withAlpha(0.85), outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new C.Cartesian2(9, -9), horizontalOrigin: C.HorizontalOrigin.LEFT,
        distanceDisplayCondition: new C.DistanceDisplayCondition(0, s.fleet ? 3.2e7 : 9e6),
        translucencyByDistance: new C.NearFarScalar(8e6, 1.0, 3.2e7, 0.0),
        show: false, id: { kind: 'sat', norad: s.norad },
      });
    }
  });
  requestRender();
}

// ------------------------------------------------------------------ propagation loop
let loopTimer = null;
function restartLoop() {
  clearInterval(loopTimer);
  const ms = st.speed === 0 ? 1000 : st.speed <= 1 ? 1000 : st.speed <= 10 ? 250 : 100;
  loopTimer = setInterval(step, ms);
  // continuous rendering only while time runs fast or something is followed
  updateRenderMode();
  step();
}
export function updateRenderMode() {
  const s = App.scene;
  if (!s) return;
  const continuous = st.speed > 1 || (st.selected && st.follow) || App.forceContinuous;
  s.requestRenderMode = !continuous;
  s.maximumRenderTimeChange = Infinity;
}
function step() {
  if (!st.worker || st.busy || !st.sats.length) return;
  st.busy = true;
  st.postT = performance.now();
  st.worker.postMessage({ type: 'prop', t: now(), seq: st.seq });
}
const scratch = new C.Cartesian3();
function onWorker(ev) {
  const m = ev.data;
  if (m.type === 'loaded') { st.busy = false; step(); return; }
  if (m.type !== 'pos') return;
  st.busy = false;
  if (m.seq !== st.seq) { step(); return; }
  st.lastPos = m.pos; st.lastVel = m.vel; st.lastT = m.t;
  st.propMs = performance.now() - st.postT; // worker round trip (SGP4 for every satellite)
  const t0 = performance.now();
  const pos = m.pos;
  const labelsOn = st.labelsOn;
  for (let i = 0; i < st.sats.length; i++) {
    const s = st.sats[i];
    const x = pos[i * 3];
    if (isNaN(x)) { s.pt.show = false; if (s.lbl) s.lbl.show = false; continue; }
    scratch.x = x; scratch.y = pos[i * 3 + 1]; scratch.z = pos[i * 3 + 2];
    s.pt.position = scratch;
    s.pt.show = !(st.models.has(s.norad) && st.models.get(s.norad).show);
    if (s.lbl) { s.lbl.position = scratch; s.lbl.show = labelsOn; }
  }
  st.applyMs = performance.now() - t0; // main-thread cost of moving the points
  if (!st.firstPaint) { st.firstPaint = true; App.events.dispatchEvent(new Event('satsready')); }
  manageModels();
  if (st.selected) updateLive();
  requestRender();
}

// ------------------------------------------------------------------ single-satellite math (main thread)
export function satState(s, tms) {
  if (!s.rec) { try { s.rec = json2satrec(s.omm); } catch (e) { return null; } }
  const d = new Date(tms);
  const pv = propagate(s.rec, d);
  if (!pv || !pv.position || isNaN(pv.position.x)) return null;
  const g = gstime(d);
  const ecf = eciToEcf(pv.position, g);
  const geo = eciToGeodetic(pv.position, g);
  const vEcf = eciToEcf(pv.velocity, g);
  return { ecf, eci: pv.position, vel: pv.velocity, vEcf, gmst: g, lat: radiansToDegrees(geo.latitude), lon: radiansToDegrees(geo.longitude), alt: geo.height };
}
function sunEcf(tms) {
  const d = new Date(tms);
  const s = sunPos(jday(d));
  const AU = 149597870.7;
  const eci = { x: s.rsun.x * AU, y: s.rsun.y * AU, z: s.rsun.z * AU };
  return eciToEcf(eci, gstime(d));
}
function sunlit(ecf, sun) {
  const sl = Math.hypot(sun.x, sun.y, sun.z);
  const sx = sun.x / sl, sy = sun.y / sl, sz = sun.z / sl;
  const p = ecf.x * sx + ecf.y * sy + ecf.z * sz;
  if (p > 0) return true;
  const px = ecf.x - p * sx, py = ecf.y - p * sy, pz = ecf.z - p * sz;
  return Math.hypot(px, py, pz) > RE;
}
function elements(o) {
  const n = +o.MEAN_MOTION * 2 * Math.PI / 86400; // rad/s
  const a = Math.cbrt(MU / (n * n));
  const e = +o.ECCENTRICITY;
  return { a, e, perigee: a * (1 - e) - RE, apogee: a * (1 + e) - RE, period: 1440 / +o.MEAN_MOTION, inc: +o.INCLINATION, raan: +o.RA_OF_ASC_NODE };
}
const toC3 = e => new C.Cartesian3(e.x * 1000, e.y * 1000, e.z * 1000);

// ------------------------------------------------------------------ selection
export function findSat(norad) { return st.byNorad.get(+norad); }

export async function select(norad, opts = {}) {
  let s = findSat(norad);
  if (!s && FLEET[norad] && !st.enabled.has('fleet')) {
    st.enabled.add('fleet'); await refreshGroups(); s = findSat(norad);
  }
  if (!s) { toast('That satellite is not in the loaded groups'); return; }
  clearSelection(false);
  st.selected = s;
  st.follow = opts.follow !== false;
  s.pt.pixelSize = s.fleet ? 11 : 8;
  s.pt.outlineColor = C.Color.fromCssColorString('#d9b25f'); s.pt.outlineWidth = 2;
  buildSelectionVisuals(s);
  App.selectItem({ kind: 'sat', id: s.norad, title: s.short || s.name, family: 'sat', layer: 'Satellites', render: renderCard, onClear: () => clearSelection(true) });
  if (st.follow) followSelected(); else App.flyTo({ type: 'sphere', center: toC3(satState(s, now()).ecf), radius: 2.0e6, reason: s.name });
  updateRenderMode();
}

export function clearSelection(fromApp = true) {
  const v = App.viewer;
  for (const e of st.ents) v.entities.remove(e);
  st.ents = [];
  if (st.selected && st.selected.pt) {
    const s = st.selected;
    s.pt.pixelSize = s.fleet ? 7 : (st.sats.length > 3000 ? 2.5 : 4);
    s.pt.outlineColor = s.fleet ? C.Color.BLACK.withAlpha(0.6) : C.Color.TRANSPARENT; s.pt.outlineWidth = s.fleet ? 1.5 : 0;
  }
  if (v.trackedEntity && v.trackedEntity._lionSat) v.trackedEntity = undefined;
  st.selected = null; st.selEnt = null;
  clearInterval(st.pathTimer);
  updateRenderMode();
  requestRender();
}

function buildSelectionVisuals(s) {
  const v = App.viewer;
  const cyan = C.Color.fromCssColorString(s.color || FAMILY.sat);
  // live position entity (used for follow and the model)
  const pos = new C.CallbackProperty((time, result) => {
    const ss = satState(s, now());
    return ss ? C.Cartesian3.fromElements(ss.ecf.x * 1000, ss.ecf.y * 1000, ss.ecf.z * 1000, result) : undefined;
  }, false);
  const ex = elements(s.omm);
  const isGeo = s.cls === 'GEO' || ex.perigee > 20000;
  const ent = v.entities.add({
    name: s.name, position: pos,
    viewFrom: isGeo ? new C.Cartesian3(0, -2.0e7, 5.2e7) : new C.Cartesian3(0, -Math.max(900e3, ex.perigee * 1000 * 1.6), Math.max(500e3, ex.perigee * 1000 * 1.1)),
    point: { pixelSize: 1, color: C.Color.TRANSPARENT },
  });
  ent._lionSat = true;
  st.selEnt = ent; st.ents.push(ent);
  // nadir line + subsatellite point
  const sub = new C.CallbackProperty((time, result) => {
    const ss = satState(s, now()); return ss ? C.Cartesian3.fromDegrees(ss.lon, ss.lat, 0, undefined, result) : undefined;
  }, false);
  st.ents.push(v.entities.add({ position: sub, point: { pixelSize: 6, color: cyan, outlineColor: C.Color.BLACK, outlineWidth: 1, heightReference: C.HeightReference.CLAMP_TO_GROUND, disableDepthTestDistance: 5e6 } }));
  st.ents.push(v.entities.add({ polyline: { positions: new C.CallbackProperty(() => { const a = pos.getValue(); const b = sub.getValue(); return a && b ? [a, b] : []; }, false), width: 1, material: cyan.withAlpha(0.35), arcType: C.ArcType.NONE } }));
  // orbit / ground track (recomputed every 20 s of wall time or on time jumps)
  const mk = (dashed, ground) => v.entities.add({ polyline: { positions: [], width: ground ? 1.6 : 1.4, arcType: C.ArcType.NONE, clampToGround: false,
    material: dashed ? new C.PolylineDashMaterialProperty({ color: cyan.withAlpha(ground ? 0.85 : 0.6), dashLength: 14 }) : cyan.withAlpha(ground ? 0.75 : 0.5) } });
  const lines = { pastO: mk(false, false), futO: mk(true, false), pastG: mk(false, true), futG: mk(true, true) };
  st.ents.push(...Object.values(lines));
  st.lines = lines;
  computePaths(s);
  clearInterval(st.pathTimer);
  st.pathTimer = setInterval(() => { if (st.selected === s) { computePaths(s); updateSwath(s); } }, st.speed > 10 ? 2000 : 15000);
  // swath + sensor cone
  st.swathEnts = [];
  updateSwath(s);
}

function computePaths(s) {
  const ex = elements(s.omm);
  const per = ex.period * 60e3;
  const t0 = now();
  const n = 180;
  const past = [], fut = [], gp = [], gf = [];
  for (let i = -n; i <= n; i++) {
    const t = t0 + per * i / n;
    const ss = satState(s, t);
    if (!ss) continue;
    const p = toC3(ss.ecf);
    const g = C.Cartesian3.fromDegrees(ss.lon, ss.lat, 2000);
    if (i <= 0) { past.push(p); gp.push(g); }
    if (i >= 0) { fut.push(p); gf.push(g); }
  }
  const L = st.lines;
  L.pastO.polyline.positions = past; L.futO.polyline.positions = fut;
  L.pastG.polyline.positions = gp; L.futG.polyline.positions = gf;
  requestRender();
}

// destination point on a sphere from lat/lon, bearing, distance (km)
function dest(lat, lon, brg, dkm) {
  const R = 6371.0, d = dkm / R, b = brg * Math.PI / 180, f1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180;
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(f1), Math.cos(d) - Math.sin(f1) * Math.sin(f2));
  return [f2 * 180 / Math.PI, ((l2 * 180 / Math.PI + 540) % 360) - 180];
}
function bearing(a, b) {
  const f1 = a[0] * Math.PI / 180, f2 = b[0] * Math.PI / 180, dl = (b[1] - a[1]) * Math.PI / 180;
  return Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) * 180 / Math.PI;
}

function updateSwath(s) {
  const v = App.viewer;
  for (const e of st.swathEnts || []) { v.entities.remove(e); st.ents = st.ents.filter(x => x !== e); }
  st.swathEnts = [];
  const m = st.missions[s.norad];
  if (!m || !m.swaths || !m.swaths.length || s.cls !== 'LEO') return;
  const t0 = now();
  const track = [];
  for (let k = -8; k <= 12; k++) { const ss = satState(s, t0 + k * 30e3); if (ss) track.push([ss.lat, ss.lon]); }
  if (track.length < 3) return;
  const col = C.Color.fromCssColorString(s.color || FAMILY.sat);
  const sw = [...m.swaths].sort((a, b) => b.width_km - a.width_km);
  sw.forEach((w, idx) => {
    const half = w.width_km / 2, gap = (w.nadir_gap_km || 0) / 2;
    const sides = gap > 0 ? [[gap, half], [-half, -gap]] : [[-half, half]];
    for (const [a, b] of sides) {
      const mid = (a + b) / 2, width = Math.abs(b - a);
      const pts = track.map((p, i) => {
        if (mid === 0) return p;
        const q = track[Math.min(i + 1, track.length - 1)], r = track[Math.max(i - 1, 0)];
        const brg = bearing(r, q);
        return dest(p[0], p[1], brg + (mid > 0 ? 90 : -90), Math.abs(mid));
      });
      const e = v.entities.add({ corridor: { positions: C.Cartesian3.fromDegreesArray(pts.flatMap(p => [p[1], p[0]])), width: width * 1000,
        material: col.withAlpha(idx === 0 ? 0.2 : 0.32), cornerType: C.CornerType.ROUNDED } });
      st.swathEnts.push(e); st.ents.push(e);
    }
  });
  // translucent sensor cone from the satellite to the widest swath
  const w = sw[0].width_km * 1000;
  const coneLen = new C.CallbackProperty(() => { const ss = satState(s, now()); return ss ? ss.alt * 1000 : 1; }, false);
  const conePos = new C.CallbackProperty((time, result) => {
    const ss = satState(s, now()); if (!ss) return undefined;
    return C.Cartesian3.fromDegrees(ss.lon, ss.lat, ss.alt * 500, undefined, result);
  }, false);
  const cone = v.entities.add({ position: conePos, cylinder: { length: coneLen, topRadius: 0, bottomRadius: w / 2, material: col.withAlpha(0.09), outline: true, outlineColor: col.withAlpha(0.25), numberOfVerticalLines: 6, slices: 48 } });
  st.swathEnts.push(cone); st.ents.push(cone);
  requestRender();
}

export function followSelected() {
  const v = App.viewer;
  if (!st.selEnt) return;
  st.follow = true;
  v.trackedEntity = st.selEnt;
  updateRenderMode();
}
export function unfollow() {
  const v = App.viewer;
  st.follow = false;
  if (v.trackedEntity && v.trackedEntity._lionSat) v.trackedEntity = undefined;
  updateRenderMode();
}

// ------------------------------------------------------------------ 3D models on approach
function modelScale(slug) {
  const m = st.manifest[slug];
  if (!m || typeof m !== 'object') return { scale: 1, real: null };
  if (m.metresPerUnit) return { scale: m.metresPerUnit, real: m.realLongestM };
  return { scale: 10 / (m.longestModelUnits || 10), real: null }; // no sourced size: normalise to ~10 m
}
function manageModels() {
  const v = App.viewer;
  const cam = v.camera.positionWC;
  const pos = st.lastPos;
  if (!pos) return;
  const near = [];
  st.sats.forEach((s, i) => {
    if (!s.fleet || isNaN(pos[i * 3])) return;
    const dx = pos[i * 3] - cam.x, dy = pos[i * 3 + 1] - cam.y, dz = pos[i * 3 + 2] - cam.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 2.0e6 || (st.selected === s && d < 6.0e6 && s.cls !== 'LEO')) near.push([d, s]);
  });
  near.sort((a, b) => a[0] - b[0]);
  const keep = new Set(near.slice(0, App.lowPower ? 1 : 3).map(x => x[1].norad));
  for (const [norad, ent] of st.models) {
    if (!keep.has(norad)) { v.entities.remove(ent); st.models.delete(norad); const s = findSat(norad); if (s) s.pt.show = true; }
  }
  for (const norad of keep) {
    if (st.models.has(norad)) continue;
    const s = findSat(norad);
    const slug = FLEET[norad][2];
    const { scale, real } = modelScale(slug);
    const pos = new C.CallbackProperty((t, r) => { const ss = satState(s, now()); return ss ? C.Cartesian3.fromElements(ss.ecf.x * 1000, ss.ecf.y * 1000, ss.ecf.z * 1000, r) : undefined; }, false);
    const ori = new C.CallbackProperty((t, r) => {
      const ss = satState(s, now()); if (!ss) return undefined;
      const z = C.Cartesian3.normalize(new C.Cartesian3(ss.ecf.x, ss.ecf.y, ss.ecf.z), new C.Cartesian3());
      let x = new C.Cartesian3(ss.vEcf.x, ss.vEcf.y, ss.vEcf.z);
      x = C.Cartesian3.normalize(C.Cartesian3.subtract(x, C.Cartesian3.multiplyByScalar(z, C.Cartesian3.dot(x, z), new C.Cartesian3()), x), x);
      const y = C.Cartesian3.cross(z, x, new C.Cartesian3());
      const m3 = new C.Matrix3(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z);
      return C.Quaternion.fromRotationMatrix(m3, r);
    }, false);
    const ent = v.entities.add({ position: pos, orientation: ori,
      model: { uri: `models/${slug}.glb`, scale, minimumPixelSize: 90, maximumScale: 200000, runAnimations: false, silhouetteColor: C.Color.fromCssColorString(s.color).withAlpha(0.7), silhouetteSize: 1.0 } });
    ent._modelInfo = { slug, real, scale };
    st.models.set(norad, ent);
    s.pt.show = false;
  }
}
export function modelLabel(s) {
  const ent = st.models.get(s.norad);
  if (!ent) return null;
  const v = App.viewer;
  const ss = satState(s, now());
  if (!ss) return null;
  const p = toC3(ss.ecf);
  const d = C.Cartesian3.distance(p, v.camera.positionWC);
  const mpp = v.camera.frustum.getPixelDimensions(v.scene.drawingBufferWidth, v.scene.drawingBufferHeight, d, v.scene.pixelRatio, new C.Cartesian2()).y;
  const info = ent._modelInfo;
  const realM = info.real || 10;
  const shownM = Math.max(realM, 90 * mpp);
  const n = shownM / realM;
  return { n, sourced: !!info.real, slug: info.slug };
}

// ------------------------------------------------------------------ passes over an observer
export function passes(s, obs, count = 5) {
  const ex = elements(s.omm);
  if (s.cls === 'GEO' || ex.perigee > 20000) {
    const ss = satState(s, now());
    const la = ecfToLookAngles({ latitude: degreesToRadians(obs.lat), longitude: degreesToRadians(obs.lon), height: 0 }, ss.ecf);
    return { geo: true, el: radiansToDegrees(la.elevation), az: radiansToDegrees(la.azimuth) };
  }
  const og = { latitude: degreesToRadians(obs.lat), longitude: degreesToRadians(obs.lon), height: 0 };
  const out = [];
  let t = now(), end = t + 4 * 86400e3, stepMs = 30e3;
  let cur = null;
  while (t < end && out.length < count) {
    const ss = satState(s, t);
    if (ss) {
      const la = ecfToLookAngles(og, ss.ecf);
      const elv = radiansToDegrees(la.elevation);
      if (elv > 10) {
        if (!cur) cur = { rise: t, max: elv, peak: t, peakState: ss, az0: radiansToDegrees(la.azimuth) };
        if (elv > cur.max) { cur.max = elv; cur.peak = t; cur.peakState = ss; }
      } else if (cur) {
        cur.set = t;
        const sun = sunEcf(cur.peak);
        const lit = sunlit(cur.peakState.ecf, sun);
        const sunEl = radiansToDegrees(ecfToLookAngles(og, sun).elevation);
        cur.sunlit = lit; cur.dark = sunEl < -6; cur.visible = lit && cur.dark;
        out.push(cur); cur = null;
      }
    }
    t += stepMs;
  }
  return { passes: out };
}

// ------------------------------------------------------------------ info card
let liveBox = null;
function renderCard(card) {
  const s = st.selected;
  if (!s) return;
  const m = st.missions[s.norad];
  const ex = elements(s.omm);
  const epoch = Date.parse(s.omm.EPOCH + 'Z');
  const ageH = (Date.now() - epoch) / 3600e3;
  const kids = [];
  kids.push(el('div', { class: 'card-sub' }, m ? m.mission : s.name, m ? el('span', { class: 'muted' }, ` · ${m.operator}`) : ''));
  liveBox = el('div', { class: 'live grid2' });
  kids.push(liveBox);
  const rows = [
    ['NORAD id', s.norad], ['Int’l designator', s.omm.OBJECT_ID], ['Orbit class', s.cls],
    ['Perigee / apogee', `${fmtNum(ex.perigee)} / ${fmtNum(ex.apogee)} km`], ['Inclination', `${ex.inc.toFixed(2)}°`],
    ['Period', `${ex.period.toFixed(1)} min`], ['RAAN', `${ex.raan.toFixed(2)}°`],
    ['TLE epoch', el('span', { class: ageH > 72 ? 'warn' : '' }, `${fmtUTC(epoch)} (${ageH.toFixed(1)} h${ageH > 72 ? ' — older than 3 days' : ''})`)],
  ];
  kids.push(el('div', { class: 'kv' }, rows.map(([k, v]) => [el('span', { class: 'k' }, k), el('span', { class: 'v mono' }, v)])));
  const acts = el('div', { class: 'actions' });
  const fbtn = el('button', { class: 'btn' + (st.follow ? ' on' : ''), onclick: () => { st.follow ? unfollow() : followSelected(); fbtn.classList.toggle('on', st.follow); fbtn.textContent = st.follow ? 'Following' : 'Follow'; } }, st.follow ? 'Following' : 'Follow');
  acts.append(fbtn);
  if (m && m.gibs_layers && m.gibs_layers.length) {
    acts.append(el('button', { class: 'btn gold', onclick: () => App.showLayerFor(m.gibs_layers[0], s) }, 'Show its data'));
  }
  if (s.norad === 65053) acts.append(el('button', { class: 'btn', onclick: () => App.openSection('nisar', true) }, 'NISAR footprints'));
  if (s.norad === 54754) acts.append(el('button', { class: 'btn', onclick: () => App.openSection('swot', true) }, 'SWOT rivers & lakes'));
  kids.push(acts);
  if (m) {
    if (m.status) kids.push(el('div', { class: 'note' }, m.status));
    kids.push(el('p', { class: 'measures' }, m.measures));
    const facts = [['Launch', m.launch_date + (m.launch_note ? ` (${m.launch_note})` : '')], ['Orbit', m.orbit]];
    kids.push(el('div', { class: 'kv' }, facts.filter(f => f[1]).map(([k, v]) => [el('span', { class: 'k' }, k), el('span', { class: 'v' }, v)])));
    if (m.instruments?.length) kids.push(el('div', { class: 'instr' }, el('div', { class: 'h' }, 'Instruments'), m.instruments.map(i => el('div', { class: 'ins' }, el('b', {}, i.name), ' — ', i.desc))));
    if (m.swaths?.length) kids.push(el('div', { class: 'instr' }, el('div', { class: 'h' }, 'Swath on the map'), m.swaths.map(w => el('div', { class: 'ins small' }, `${w.instrument}: ${w.width_km} km`, w.nadir_gap_km ? ` (nadir gap ${w.nadir_gap_km} km)` : '', w.note ? ` — ${w.note}` : '', ' · ', el('a', { href: w.source, target: '_blank', rel: 'noopener' }, 'source')))));
    kids.push(el('div', { class: 'links small' }, el('a', { href: m.mission_page, target: '_blank', rel: 'noopener' }, 'Mission page ↗'), ' · sources: ', (m.sources || []).slice(0, 3).map((u, i) => [i ? ', ' : '', el('a', { href: u, target: '_blank', rel: 'noopener' }, new URL(u).hostname.replace('www.', ''))])));
  }
  // passes over me
  const pbox = el('div', { class: 'passes' }, el('div', { class: 'h' }, 'Passes over me'));
  const pres = el('div', { class: 'pres' });
  const runPasses = (obs) => {
    pres.replaceChildren(el('div', { class: 'skel' }), el('div', { class: 'skel', style: { width: '70%' } }));
    setTimeout(() => {
      const r = passes(s, obs);
      if (r.geo) { pres.replaceChildren(el('div', { class: 'small' }, `Geostationary: fixed in your sky at elevation ${r.el.toFixed(1)}°, azimuth ${r.az.toFixed(1)}° (${obs.name}).`)); return; }
      if (!r.passes.length) { pres.replaceChildren(el('div', { class: 'small muted' }, `No passes above 10° in the next 4 days over ${obs.name}.`)); return; }
      pres.replaceChildren(el('div', { class: 'small muted' }, `Next passes above 10° over ${obs.name} (times UTC):`),
        el('table', { class: 'ptable mono' }, el('tr', {}, ['Rise', 'Peak', 'Set', 'Max el', ''].map(h => el('th', {}, h))),
          r.passes.map(p => el('tr', {}, el('td', {}, new Date(p.rise).toISOString().slice(5, 16).replace('T', ' ')), el('td', {}, new Date(p.peak).toISOString().slice(11, 16)),
            el('td', {}, new Date(p.set).toISOString().slice(11, 16)), el('td', {}, `${p.max.toFixed(0)}°`),
            el('td', { class: p.visible ? 'vis' : 'muted' }, p.visible ? 'visible' : p.sunlit ? (p.dark ? '' : 'daylight') : 'in shadow')))));
    }, 30);
  };
  const obs = store.get('observer');
  const geoBtn = el('button', { class: 'btn small', onclick: () => {
    if (!navigator.geolocation) { toast('Geolocation is not available here — type a place instead'); return; }
    navigator.geolocation.getCurrentPosition(p => { const o = { lat: p.coords.latitude, lon: p.coords.longitude, name: 'your location' }; store.set('observer', o); runPasses(o); },
      () => toast('Location not shared — type a place instead'), { timeout: 10000, maximumAge: 600000 });
  } }, 'Use my location');
  const placeIn = el('input', { class: 'input small', placeholder: 'or type a city…', list: 'place-list', 'aria-label': 'observer place' });
  placeIn.addEventListener('change', () => { const p = App.findPlace(placeIn.value); if (p) { const o = { lat: p.lat, lon: p.lon, name: p.name }; store.set('observer', o); runPasses(o); } else toast('Place not in the built-in gazetteer'); });
  pbox.append(el('div', { class: 'row' }, geoBtn, placeIn), pres);
  kids.push(pbox);
  if (obs) runPasses(obs);
  card.replaceChildren(...kids);
  updateLive();
}

function updateLive() {
  const s = st.selected;
  if (!s || !liveBox || !liveBox.isConnected) return;
  const t = now();
  const ss = satState(s, t);
  if (!ss) { liveBox.replaceChildren(el('div', { class: 'muted' }, 'propagation failed (element set too old?)')); return; }
  const v = Math.hypot(ss.vel.x, ss.vel.y, ss.vel.z);
  const lit = sunlit(ss.ecf, sunEcf(t));
  const ml = modelLabel(s);
  const cells = [
    ['Altitude', `${fmtNum(ss.alt, 1)} km`], ['Speed', `${fmtNum(v * 3600)} km/h`],
    ['Lat / lon', `${ss.lat.toFixed(2)}°, ${ss.lon.toFixed(2)}°`], ['Sunlight', lit ? '☀ sunlit' : '● in Earth’s shadow'],
  ];
  if (ml) cells.push(['3D model', `${ml.slug}.glb shown ×${ml.n < 10 ? ml.n.toFixed(1) : fmtNum(ml.n)} size${ml.sourced ? '' : ' (scale approximate)'}`]);
  liveBox.replaceChildren(...cells.map(([k, val]) => el('div', { class: 'cell' }, el('span', { class: 'k' }, k), el('span', { class: 'v mono' }, val))));
}

// ------------------------------------------------------------------ hover
export function hover(norad) {
  if (st.hover && st.hover !== st.selected && st.hover.pt) { st.hover.pt.pixelSize = st.hover.fleet ? 7 : (st.sats.length > 3000 ? 2.5 : 4); st.hover.pt.outlineWidth = st.hover.fleet ? 1.5 : 0; }
  st.hover = null;
  if (norad === null || norad === undefined) { requestRender(); return; }
  const s = findSat(norad);
  if (!s) return;
  st.hover = s;
  if (s !== st.selected) { s.pt.pixelSize = (s.fleet ? 7 : 4) + 5; s.pt.outlineColor = C.Color.fromCssColorString(s.color).withAlpha(0.45); s.pt.outlineWidth = 4; }
  requestRender();
}

// ------------------------------------------------------------------ search
export function search(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const num = /^\d+$/.test(q) ? +q : null;
  const out = [];
  for (const s of st.sats) {
    if ((num && s.norad === num) || s.name.toLowerCase().includes(q) || (s.short && s.short.toLowerCase().includes(q))) {
      out.push({ kind: 'sat', id: s.norad, title: s.short && s.short !== s.name ? `${s.short} (${s.name})` : s.name, sub: `NORAD ${s.norad} · ${s.cls}`, score: (s.fleet ? 2 : 0) + (s.name.toLowerCase().startsWith(q) ? 1 : 0) });
      if (out.length > 60) break;
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

// ------------------------------------------------------------------ panel section
export function buildUI(box) {
  const list = el('div', { class: 'group-list' });
  const draw = () => {
    list.replaceChildren(...GROUPS.map(g => {
      const on = st.enabled.has(g.id);
      const n = st.groupCounts[g.id];
      const inp = el('input', { type: 'checkbox', checked: on });
      inp.addEventListener('change', async () => {
        if (inp.checked) st.enabled.add(g.id); else st.enabled.delete(g.id);
        if (g.id === 'active' && inp.checked) toast('Loading ~16,000 satellites… (best on desktop)');
        lbl.classList.add('loading');
        await refreshGroups();
        lbl.classList.remove('loading');
        draw();
      });
      const lbl = el('label', { class: 'grp' + (on ? ' active' : ''), title: g.desc || '' }, inp, el('span', { class: 'dot', style: { background: g.color } }), el('span', { class: 'g-t' }, g.title), el('span', { class: 'g-n mono' }, n !== undefined ? fmtNum(n) : ''));
      return lbl;
    }));
  };
  draw();
  App.events.addEventListener('satgroups', draw);
  const labels = toggle('Labels for named satellites', st.labelsOn, v => { st.labelsOn = v; store.set('satLabels', v); st.sats.forEach(s => { if (s.lbl) s.lbl.show = v; }); requestRender(); }, 'sat');
  const classes = el('div', { class: 'classes' });
  const drawClasses = () => {
    const c = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 };
    st.sats.forEach(s => c[s.cls]++);
    classes.replaceChildren(el('span', { class: 'muted small' }, 'per orbit class'), sparkline(Object.values(c), { bars: true, w: 80, h: 24, color: FAMILY.sat }),
      el('span', { class: 'mono small' }, Object.entries(c).map(([k, v]) => `${k} ${fmtNum(v)}`).join(' · ')));
  };
  App.events.addEventListener('satgroups', drawClasses);
  const fleetRow = el('div', { class: 'chips-row' }, Object.entries(FLEET).map(([id, f]) => el('button', { class: 'pill', style: { '--c': f[0] }, onclick: () => select(+id) }, f[1])));
  box.replaceChildren(list, classes, labels, el('div', { class: 'h small' }, 'Fleet — tap to select & follow'), fleetRow);
}

export async function initSats() {
  st.worker = new Worker('js/satworker.js', { type: 'module' });
  st.worker.onmessage = onWorker;
  st.worker.onerror = e => { console.error('sat worker', e.message); toast('Satellite worker failed to start'); };
  try { st.missions = (await (await fetch('data/missions.json')).json()).missions || {}; } catch (e) { st.missions = {}; }
  try { const mj = await (await fetch('models/manifest.json')).json(); st.manifest = mj.models || mj; } catch (e) { st.manifest = {}; }
  await refreshGroups();
  restartLoop();
  // ISS live line for the ticker (real data from the propagation)
  setInterval(() => {
    const iss = findSat(25544);
    if (!iss) return;
    const ss = satState(iss, now());
    if (!ss) return;
    const v = Math.hypot(ss.vel.x, ss.vel.y, ss.vel.z) * 3600;
    tick('iss', `ISS over ${App.describePlace ? App.describePlace(ss.lat, ss.lon) : `${ss.lat.toFixed(1)}°, ${ss.lon.toFixed(1)}°`} · ${fmtNum(v)} km/h · ${fmtNum(ss.alt)} km up`, 'sat');
  }, 5000);
}
