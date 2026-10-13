// Created by Sunny Chase (https://github.com/sunnychase) in collaboration with Claude (Anthropic).
// Lion Satellite Studio — shared helpers and app state.
export const App = {
  viewer: null,
  scene: null,
  lastUserInput: 0,       // ms timestamp of last manual camera interaction
  selected: null,         // {kind, id, title, family}
  layers: {},             // imagery state (imagery.js)
  sats: null,             // satellites module
  data: {},               // quakes / nisar / swot / ships modules
  status: {},             // HUD chips state
  ticker: new Map(),      // key -> {text, family, t}
  reducedMotion: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  isPhone: () => window.innerWidth < 700,
  events: new EventTarget(),
};

export const FAMILY = {
  sat: '#38e1ff', radar: '#a78bfa', water: '#4aa3ff', fire: '#ff8a3d',
  quake: '#ff4d5e', ship: '#3ddc84', gold: '#d9b25f', night: '#ffd27a', cloud: '#cfd8e3',
};

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) e.style.setProperty(sk, sv); else e.style[sk] = sv; } }
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return e;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function getJSON(url, opts = {}) {
  const r = await fetch(url, { cache: 'no-store', ...opts });
  let body = null;
  try { body = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok) {
    const err = new Error((body && body.error) || `HTTP ${r.status}`);
    err.status = r.status;
    err.retry = (body && body.retry_in_s) || Number(r.headers.get('Retry-After')) || 300;
    throw err;
  }
  return { body, cache: r.headers.get('X-Cache'), fetched: r.headers.get('X-Fetched-At'), age: Number(r.headers.get('X-Age') || 0) };
}

export const store = {
  get(k, d = null) { try { const v = localStorage.getItem('lionearth.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('lionearth.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};

export function fmtAgo(ms) {
  if (ms === null || ms === undefined || isNaN(ms)) return '—';
  const s = Math.max(0, ms / 1000);
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400 * 2) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h`;
  return `${Math.round(s / 86400)} d`;
}
export const fmtUTC = (d, sec = false) => {
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x)) return '—';
  return x.toISOString().slice(0, sec ? 19 : 16).replace('T', ' ') + ' UTC';
};
export const fmtNum = (n, d = 0) => (n === null || n === undefined || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
export const fmtBytes = b => !b ? '—' : b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1e3).toFixed(0) + ' kB';
export const ymd = d => d.toISOString().slice(0, 10);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// toast / error-state helper
let toastTimer = null;
export function toast(msg, ms = 3500) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// A placeholder skeleton in a container
export function skeleton(container, lines = 3) {
  container.replaceChildren(...Array.from({ length: lines }, (_, i) => el('div', { class: 'skel', style: { width: `${90 - i * 18}%` } })));
}
export function emptyState(container, text, retryIn) {
  container.replaceChildren(el('div', { class: 'empty' }, text, retryIn ? ` — retrying in ${fmtAgo(retryIn * 1000)}` : ''));
}

// Inline SVG sparkline
export function sparkline(values, { w = 120, h = 28, color = FAMILY.gold, fill = true, bars = false } = {}) {
  const v = values.filter(x => x !== null && !isNaN(x));
  if (!v.length) return el('span', { class: 'muted' }, '—');
  const min = Math.min(...v, bars ? 0 : Infinity), max = Math.max(...v);
  const span = max - min || 1;
  const n = values.length;
  let inner = '';
  if (bars) {
    const bw = w / n;
    values.forEach((x, i) => {
      const bh = x ? Math.max(1, ((x - min) / span) * (h - 2)) : 0;
      inner += `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" rx="1" fill="${color}" opacity="0.85"/>`;
    });
  } else {
    const pts = values.map((x, i) => x === null || isNaN(x) ? null : [i / Math.max(1, n - 1) * (w - 2) + 1, h - 2 - ((x - min) / span) * (h - 4)]).filter(Boolean);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    if (fill && pts.length > 1) inner += `<path d="${d} L${pts[pts.length - 1][0].toFixed(1)} ${h} L${pts[0][0].toFixed(1)} ${h} Z" fill="${color}" opacity="0.15"/>`;
    inner += `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    const last = pts[pts.length - 1];
    if (last) inner += `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.2" fill="${color}"/>`;
  }
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', `0 0 ${w} ${h}`);
  s.setAttribute('width', w); s.setAttribute('height', h);
  s.classList.add('spark');
  s.innerHTML = inner;
  return s;
}

// Time-series chart (canvas) used by the SWOT card
export function drawSeries(canvas, series, { color = FAMILY.water, yLabel = '', xFmt = d => d.toISOString().slice(5, 10) } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 300, H = canvas.clientHeight || 140;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  const pts = series.filter(p => p && isFinite(p.y) && p.x instanceof Date && !isNaN(p.x));
  g.font = '10px "JetBrains Mono", monospace';
  g.fillStyle = 'rgba(235,228,210,0.55)';
  if (pts.length < 1) { g.fillText('no valid passes in the last 12 months', 10, H / 2); return; }
  const pad = { l: 46, r: 10, t: 10, b: 22 };
  const xs = pts.map(p => +p.x), ys = pts.map(p => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x1 === x0) { x0 -= 86400e3; x1 += 86400e3; }
  let y0 = Math.min(...ys), y1 = Math.max(...ys); const yp = (y1 - y0) * 0.12 || 0.5; y0 -= yp; y1 += yp;
  const X = x => pad.l + (x - x0) / (x1 - x0) * (W - pad.l - pad.r);
  const Y = y => H - pad.b - (y - y0) / (y1 - y0) * (H - pad.t - pad.b);
  g.strokeStyle = 'rgba(217,178,95,0.14)'; g.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const yy = y0 + (y1 - y0) * i / 3; const py = Y(yy);
    g.beginPath(); g.moveTo(pad.l, py); g.lineTo(W - pad.r, py); g.stroke();
    g.fillText(yy.toFixed(Math.abs(y1 - y0) < 10 ? 2 : 0), 2, py + 3);
  }
  for (let i = 0; i <= 3; i++) {
    const xx = x0 + (x1 - x0) * i / 3;
    g.fillText(xFmt(new Date(xx)), X(xx) - 14, H - 6);
  }
  if (yLabel) { g.save(); g.fillStyle = 'rgba(235,228,210,0.4)'; g.fillText(yLabel, pad.l + 4, pad.t + 8); g.restore(); }
  const sorted = pts.slice().sort((a, b) => a.x - b.x);
  g.strokeStyle = color; g.lineWidth = 1.6; g.globalAlpha = 0.9;
  g.beginPath(); sorted.forEach((p, i) => i ? g.lineTo(X(+p.x), Y(p.y)) : g.moveTo(X(+p.x), Y(p.y))); g.stroke();
  g.globalAlpha = 1; g.fillStyle = color;
  for (const p of sorted) { g.beginPath(); g.arc(X(+p.x), Y(p.y), 2.4, 0, Math.PI * 2); g.fill(); }
}

export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// Register a live ticker item (real data only; callers pass the values they display)
export function tick(key, text, family = 'gold') {
  App.ticker.set(key, { text, family, t: Date.now() });
  App.events.dispatchEvent(new Event('ticker'));
}

// HUD status chip
export function chip(key, text, level = 'ok', title = '') {
  App.status[key] = { text, level, title };
  App.events.dispatchEvent(new Event('chips'));
}

export function requestRender() { App.scene && App.scene.requestRender(); }
