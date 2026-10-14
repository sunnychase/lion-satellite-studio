// Created by Sunny Chase (https://github.com/sunnychase) in collaboration with Claude (Anthropic).
// Lion Satellite Studio — NAIP aerial photography (USDA, ~0.6 m, US only) as a close-zoom detail layer: when the camera
// is below ~3 km over the US, the server finds the newest NAIP item under the view centre (Planetary Computer STAC) and
// its tiles come through the server's tile endpoint. Loads only at close zoom, one layer at a time, disposed on zoom-out.
import { App, el, getJSON, store, chip, requestRender } from './util.js';
import { toggle, raiseRefLayers } from './imagery.js';

const C = window.Cesium;
const ON_BELOW = 3000, OFF_ABOVE = 4500;   // metres above the ground (hysteresis)
const US = [[-125, 24, -66.5, 49.5], [-160.5, 18.8, -154.5, 22.5], [-67.5, 17.8, -65.2, 18.6]]; // CONUS, Hawaii, Puerto Rico
const NA = App.data.naip = { mode: store.get('naip', 'auto'), layer: null, item: null, busy: false, timer: null, last: null };
export const inUS = (lat, lon) => US.some(b => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]);
export const label = it => `NAIP aerial · ${(it.state || '').toUpperCase()} · ${it.dt.slice(0, 10)}`;
export function credit() { return NA.layer ? 'Aerial: USDA NAIP via Microsoft Planetary Computer' : null; }

function dispose(msg) {
  if (NA.layer) { App.viewer.imageryLayers.remove(NA.layer, true); NA.layer = null; NA.item = null; App.events.dispatchEvent(new Event('layers')); requestRender(); }
  if (msg) chip('naip', msg, 'idle', 'NAIP aerial photography (USDA), US only, loads below ~3 km');
  else if (App.status.naip && App.status.naip.level !== 'hide') chip('naip', '', 'hide');
}
export function showItem(it) {
  if (NA.item && NA.item.id === it.id) return;
  const v = App.viewer, b = it.bbox;
  const prov = new C.UrlTemplateImageryProvider({
    url: `/api/point/tile?collection=naip&item=${encodeURIComponent(it.id)}&z={z}&x={x}&y={y}`, tilingScheme: new C.WebMercatorTilingScheme(),
    minimumLevel: 12, maximumLevel: 18, rectangle: b && b.length === 4 ? C.Rectangle.fromDegrees(b[0], b[1], b[2], b[3]) : undefined,
    credit: new C.Credit('USDA NAIP via Microsoft Planetary Computer'),
  });
  prov.errorEvent.addEventListener(() => { });
  const old = NA.layer;
  NA.layer = v.imageryLayers.addImageryProvider(prov);   // add() returns nothing; this returns the layer
  NA.item = it;
  raiseRefLayers();
  if (old) setTimeout(() => { try { v.imageryLayers.remove(old, true); } catch (e) { /* gone */ } }, 800);
  chip('naip', label(it), 'ok', `USDA NAIP ${it.gsd || 0.6} m aerial photograph, acquired ${it.dt.slice(0, 10)} (NAIP is flown every 2–3 years per state)`);
  App.events.dispatchEvent(new Event('layers'));
  requestRender();
}
async function check() {
  if (NA.busy || App.pointerDown) return;
  const cam = App.viewer.camera, h = cam.positionCartographic.height;
  if (h > OFF_ABOVE) { NA.last = null; dispose(null); return; }   // zoomed out: free the layer and its tiles
  if (NA.mode !== 'auto') return;
  if (h > ON_BELOW && !NA.layer) { dispose(null); return; }
  // the ground point at the centre of the view (the camera may be tilted)
  const s = App.scene, ray = cam.getPickRay(new C.Cartesian2(s.canvas.clientWidth / 2, s.canvas.clientHeight / 2));
  const p = ray && s.globe.pick(ray, s);
  const g = p ? C.Cartographic.fromCartesian(p) : cam.positionCartographic;
  const lat = +C.Math.toDegrees(g.latitude).toFixed(3), lon = +C.Math.toDegrees(g.longitude).toFixed(3);
  if (!inUS(lat, lon)) { dispose('no aerial here'); return; }
  const it = NA.item, bb = it && it.bbox;
  if (bb && lon >= bb[0] && lon <= bb[2] && lat >= bb[1] && lat <= bb[3]) return; // still inside the shown photo
  const key = `${lat},${lon}`;
  if (NA.last === key) return;
  NA.busy = true;
  try {
    const { body } = await getJSON(`/api/naip?lat=${lat}&lon=${lon}`);
    NA.last = key;
    if (body.item) showItem(body.item); else dispose('no aerial here');
  } catch (e) {
    if (e.status === 429) { clearTimeout(NA.timer); NA.timer = setTimeout(check, Math.min(e.retry, 5) * 1000); }
    else chip('naip', 'NAIP unavailable', 'warn', e.message);
  } finally { NA.busy = false; }
}
export function setMode(m) {
  NA.mode = m; store.set('naip', m);
  if (m === 'off') dispose(null); else { NA.last = null; check(); }
}
export function initNaip(box) {
  App.viewer.camera.moveEnd.addEventListener(() => { clearTimeout(NA.timer); NA.timer = setTimeout(check, 700); });
  box.append(toggle('NAIP aerial photos when zoomed in over the US (USDA, ~0.6 m; often 1–3 years old)', NA.mode === 'auto', v => setMode(v ? 'auto' : 'off')));
}
