// Created by Sunny Chase (https://github.com/sunnychase) in collaboration with Claude (Anthropic).
// Lion Satellite Studio — SGP4 propagation worker. Propagates every satellite in a batch and
// returns Earth-fixed positions (metres) in a transferable Float64Array.
import { json2satrec } from '../vendor/satellite/io.js';
import { propagate } from '../vendor/satellite/propagation.js';
import { gstime } from '../vendor/satellite/propagation/gstime.js';
import { eciToEcf } from '../vendor/satellite/transforms.js';

let recs = [];

self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === 'load') {
    recs = [];
    const failed = [];
    for (let i = 0; i < m.sats.length; i++) {
      try {
        const r = json2satrec(m.sats[i]);
        recs.push(r && !r.error ? r : null);
        if (!r || r.error) failed.push(i);
      } catch (e) { recs.push(null); failed.push(i); }
    }
    self.postMessage({ type: 'loaded', n: recs.length, failed, seq: m.seq });
  } else if (m.type === 'prop') {
    const d = new Date(m.t);
    const gmst = gstime(d);
    const n = recs.length;
    const out = new Float64Array(n * 3);
    const vel = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = recs[i];
      if (!r) { out[i * 3] = NaN; continue; }
      let pv;
      try { pv = propagate(r, d); } catch (e) { pv = null; }
      if (!pv || !pv.position || typeof pv.position === 'boolean' || isNaN(pv.position.x)) { out[i * 3] = NaN; continue; }
      const f = eciToEcf(pv.position, gmst);
      out[i * 3] = f.x * 1000; out[i * 3 + 1] = f.y * 1000; out[i * 3 + 2] = f.z * 1000;
      const v = pv.velocity;
      vel[i] = v ? Math.hypot(v.x, v.y, v.z) : NaN;
    }
    self.postMessage({ type: 'pos', t: m.t, pos: out, vel, seq: m.seq }, [out.buffer, vel.buffer]);
  }
};
