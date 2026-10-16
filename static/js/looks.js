// Lion Satellite Studio — Created by Sunny Chase (https://github.com/sunnychase) in collaboration with Claude (Anthropic)
// Sensor looks: Normal / Night vision / Thermal (ironbow) / CRT / Noir, each one cheap single-pass Cesium
// PostProcessStage (a few texture reads per pixel, no blur chains, nothing animated, so render-on-demand stays idle).
// Picking is untouched: no stage moves pixels (no lens warp), and the stages only change how the frame is coloured.
// Off by default; the choice is kept in this browser. These are looks, not sensor data: "Thermal" maps brightness.
import { App, $, el, store, toast, requestRender, chip } from './util.js';

const C = window.Cesium;
const COMMON = `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
float lss_hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float lss_vignette(vec2 uv, float k) { vec2 d = uv - 0.5; return clamp(1.0 - k * dot(d, d) * 2.2, 0.0, 1.0); }
float lss_luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;
const SHADERS = {
  nv: COMMON + `
void main() {
  vec2 uv = v_textureCoordinates;
  float l = lss_luma(texture(colorTexture, uv).rgb);
  l = pow(clamp(l * 1.7 + 0.03, 0.0, 1.0), 0.75);                  // image-intensifier gain
  l += (lss_hash(floor(gl_FragCoord.xy)) - 0.5) * 0.09;             // static grain
  l *= 0.93 + 0.07 * sin(gl_FragCoord.y * 1.57);                   // faint raster lines
  vec3 g = vec3(0.12, 1.0, 0.28) * l + vec3(0.0, 0.035, 0.0);
  out_FragColor = vec4(g * lss_vignette(uv, 1.1), 1.0);
}`,
  thermal: COMMON + `
vec3 ironbow(float t) {
  vec3 c = mix(vec3(0.0, 0.0, 0.06), vec3(0.28, 0.0, 0.52), smoothstep(0.0, 0.22, t));
  c = mix(c, vec3(0.80, 0.05, 0.38), smoothstep(0.22, 0.48, t));
  c = mix(c, vec3(1.0, 0.42, 0.0), smoothstep(0.48, 0.70, t));
  c = mix(c, vec3(1.0, 0.86, 0.16), smoothstep(0.70, 0.88, t));
  return mix(c, vec3(1.0, 1.0, 0.92), smoothstep(0.88, 1.0, t));
}
void main() {
  vec2 uv = v_textureCoordinates;
  float l = lss_luma(texture(colorTexture, uv).rgb);
  l = clamp((l - 0.03) * 1.35, 0.0, 1.0);
  out_FragColor = vec4(ironbow(l) * mix(0.82, 1.0, lss_vignette(uv, 1.0)), 1.0);
}`,
  crt: COMMON + `
void main() {
  vec2 uv = v_textureCoordinates;
  vec2 d = uv - 0.5;
  float ca = 0.0009 + 0.0025 * dot(d, d);                           // colour fringing, stronger at the edges
  vec3 c = vec3(texture(colorTexture, uv + vec2(ca, 0.0)).r, texture(colorTexture, uv).g, texture(colorTexture, uv - vec2(ca, 0.0)).b);
  float sl = sin(gl_FragCoord.y * 1.5708);
  float scan = 0.78 + 0.22 * sl * sl;                                // scanlines every 2 px
  float m = mod(floor(gl_FragCoord.x), 3.0);                          // aperture-grille stripes
  vec3 mask = vec3(m == 0.0 ? 1.0 : 0.82, m == 1.0 ? 1.0 : 0.82, m == 2.0 ? 1.0 : 0.82);
  c = pow(c, vec3(0.9)) * scan * mask * 1.18;
  vec2 e = smoothstep(vec2(0.0), vec2(0.035), uv) * smoothstep(vec2(0.0), vec2(0.035), 1.0 - uv);   // rounded tube edge
  out_FragColor = vec4(c * lss_vignette(uv, 1.2) * e.x * e.y + vec3(0.0, 0.012, 0.008), 1.0);
}`,
  noir: COMMON + `
void main() {
  vec2 uv = v_textureCoordinates;
  float l = lss_luma(texture(colorTexture, uv).rgb);
  l = smoothstep(0.02, 0.85, l);                                     // hard contrast
  l = l * l * (3.0 - 2.0 * l);
  l += (lss_hash(floor(gl_FragCoord.xy) + 7.0) - 0.5) * 0.06;         // film grain (static)
  out_FragColor = vec4(vec3(l * lss_vignette(uv, 1.4)), 1.0);
}`,
};
export const LOOKS = [
  ['normal', 'Normal', 'the true colours'],
  ['nv', 'Night vision', 'green image-intensifier look'],
  ['thermal', 'Thermal', 'ironbow palette on brightness (a look, not temperatures)'],
  ['crt', 'CRT', 'scanlines and colour fringes of an old monitor'],
  ['noir', 'Noir', 'high-contrast black and white with grain'],
];
const L = App.look = { id: 'normal', stage: null };

export function setLook(id, quiet = false) {
  if (!LOOKS.some(x => x[0] === id)) id = 'normal';
  const pps = App.scene && App.scene.postProcessStages;
  if (!pps) return;
  if (L.stage) { try { pps.remove(L.stage); } catch (e) { /* already gone */ } L.stage = null; }
  L.id = 'normal';
  if (id !== 'normal') {
    try {
      L.stage = pps.add(new C.PostProcessStage({ name: `lss_look_${id}`, fragmentShader: SHADERS[id] }));
      L.id = id;
    } catch (e) { console.error('look', e); if (!quiet) toast('This look is not available in this browser'); }
  }
  store.set('look', L.id);
  const t = LOOKS.find(x => x[0] === L.id);
  chip('look', L.id === 'normal' ? '' : `${t[1]} look`, L.id === 'normal' ? 'hide' : 'ok', t[2]);
  sync();
  requestRender();
  if (!quiet && L.id !== 'normal') toast(`${t[1]} look — ${t[2]}`);
}

// UI: a HUD button with a small menu, and the same choice in Imagery & terrain
const ui = { segs: [] };
function sync() {
  for (const seg of ui.segs) seg.querySelectorAll('[data-look]').forEach(b => { b.classList.toggle('on', b.dataset.look === L.id); b.setAttribute('aria-checked', b.dataset.look === L.id ? 'true' : 'false'); });
  const btn = $('#btn-look'); if (btn) btn.classList.toggle('on', L.id !== 'normal');
}
function seg(cls) {
  const s = el('div', { class: cls, role: 'radiogroup', 'aria-label': 'sensor look' }, LOOKS.map(([id, t, sub]) =>
    el('button', { class: 'seg-b', 'data-look': id, role: 'radio', title: sub, onclick: () => { setTimeout(() => setLook(id), 0); closeMenu(); App.events.dispatchEvent(new Event('layers')); } }, t)));
  ui.segs.push(s);
  return s;
}
function closeMenu() { const m = $('#look-menu'); if (m) m.classList.add('hidden'); }
export function initLooks(panelBox) {
  const btn = $('#btn-look');
  if (btn) {
    const menu = el('div', { id: 'look-menu', class: 'glass look-menu hidden' }, el('div', { class: 'small muted' }, 'Sensor look'), seg('look-list'));
    document.body.append(menu);
    btn.addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('hidden'); });
    document.addEventListener('pointerdown', e => { if (!e.target.closest('#look-menu') && !e.target.closest('#btn-look')) closeMenu(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
  }
  if (panelBox) panelBox.append(el('div', { class: 'h small' }, 'Sensor look'), seg('seg look-seg'), el('div', { class: 'hint' }, 'Colour filters on the whole view (kept in this browser). Clicks and picking work the same in every look.'));
  setLook(store.get('look', 'normal'), true);
}
