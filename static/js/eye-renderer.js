// Procedural monster-eye renderer for a half-circle (flat side down) window.
// Shared by the projector display page and the phone preview.
//
// Unit space: the aperture is a half circle of radius 1 centred on the
// origin, flat side on y = 0, dome toward negative y (canvas y points down).

import { DEFAULT_TEMPLATE, mergeTemplate } from "./eye-schema.js";
import { renderShader } from "./shader-eye.js";
import { buildDragonTextures, drawDragon } from "./dragon-eye.js";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const approach = (v, target, rate, dt) => v + (target - v) * (1 - Math.exp(-rate * dt));
const EASE = {
  linear: (t) => t,
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  inout: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function hexA(hex, alpha) {
  const h = (hex || "#000000").replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// Superellipse lid curve height at x for apex height h.
function lidY(x, h, p) {
  return -h * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(x), p)), 1 / p);
}

// Solve the homography mapping 4 source points to 4 destination points and
// return a CSS matrix3d string (transform-origin must be 0 0).
export function homographyCss(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return "none";
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,1)`;
}

export class EyeRenderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.preview = !!opts.preview;   // fit the aperture to the canvas
    this.onMediaEnded = opts.onMediaEnded || null;
    this.mediaEnabled = !!opts.media;
    this.template = mergeTemplate(DEFAULT_TEMPLATE, {});
    this.projection = { cx: 0.5, cy: 0.85, radius: 0.4, rotation: 0, flip_h: false, flip_v: false,
      feather: 0.015, brightness: 1, outline: false, render_scale: 1 };
    this.behavior = { saccade_threshold: 0.12, saccade_speed: 14, pursuit_s: 0.12, micro_saccade: 0.015, lid_follow: 0.35 };
    this.phase = "asleep";
    this.frame = { gaze: [0, 0.25], open: 1, pupil: 0.5 };
    this.st = { open: 0, bright: 0, pupil: 0.6, gx: 0, gy: 0.25, ox: 0, oy: 0 };
    this.seq = null;
    this.blinkT0 = null;
    this.blinkDur = 0.2;
    this.micro = [0, 0];
    this.microNext = 0;
    this.snapUntil = 0;          // pupil snap ("it just spotted you")
    this.multi = [];             // independent pupils (template pupil.count > 1)
    this.clumpUntil = 0;
    this.clumpNext = 0;
    this.images = {};
    this.tex = null;
    this.texKey = "";
    this.media = null;
    this.forceAwake = false;      // thumbnails: render a static open eye
    this.last = performance.now() / 1000;
    this.running = false;
  }

  // ---------------------------------------------------------- inputs
  setTemplate(t, baseUrl = "/eyes/") {
    this.template = mergeTemplate(DEFAULT_TEMPLATE, t || {});
    this.images = {};
    const imgs = this.template.images || {};
    for (const [k, src] of Object.entries(imgs)) {
      if (!src) continue;
      const im = new Image();
      im.onload = () => { this.texKey = ""; };
      im.src = /^(https?:|\/|data:)/.test(src) ? src : baseUrl + src;
      this.images[k] = im;
    }
    this.texKey = "";
  }

  setProjection(p) { this.projection = { ...this.projection, ...p }; this.texKey = ""; }
  setBehavior(b) { this.behavior = { ...this.behavior, ...b }; }

  onPhase(msg) {
    const now = performance.now() / 1000;
    this.phase = msg.phase;
    this.blinkT0 = null;
    if (msg.seq) this.seq = this._buildSeq(msg.seq, now);
    else this.seq = null;
    if (msg.instant && msg.phase === "asleep") { this.st.bright = 0; this.st.open = 0; }
    if (msg.phase !== "media") this._stopMedia(false);
  }

  onFrame(msg) {
    // The moment the eye starts tracking someone, an eye with pupil_snap
    // contracts its pupil almost instantly, as if it just spotted them.
    const M = this.template.motion;
    if (msg.sub === "tracking" && this.frame.sub !== "tracking") {
      const now = performance.now() / 1000;
      if (M.pupil_snap > 0) {
        this.st.pupil *= 1 - M.pupil_snap;
        this.snapUntil = now + 1.2;
      }
      // Roll-back (sharks as they strike): the eye rolls up out of sight.
      if (M.rollback > 0) this.rollT0 = now;
    }
    this.frame = msg;
  }

  onBlink(msg) {
    if (this.phase !== "awake") return;
    this.blinkT0 = performance.now() / 1000;
    this.blinkDur = (msg.duration || 0.2) * (this.template.motion.blink_speed || 1);
  }

  onMedia(msg) {
    if (msg.action === "stop") return this._stopMedia(false);
    this._stopMedia(false);
    this.media = { ...msg, el: null, t0: performance.now() / 1000 };
    if (!this.mediaEnabled) return;
    if (msg.kind === "image") {
      const im = new Image();
      im.src = msg.url;
      this.media.el = im;
      return;
    }
    const v = document.createElement("video");
    v.src = msg.url;
    v.muted = !msg.audio;
    v.playsInline = true;
    v.onended = () => this._stopMedia(true);
    v.onerror = () => this._stopMedia(true);
    v.play().catch(() => { v.muted = true; v.play().catch(() => this._stopMedia(true)); });
    this.media.el = v;
  }

  _stopMedia(ended) {
    if (!this.media) return;
    const el = this.media.el;
    if (el && el.pause) { el.pause(); el.removeAttribute("src"); el.load(); }
    this.media = null;
    if (ended && this.onMediaEnded) this.onMediaEnded();
  }

  _buildSeq(keys, now) {
    const props = ["open", "bright", "pupil", "gx", "gy"];
    const cur = { open: this.st.open, bright: this.st.bright, pupil: this.st.pupil, gx: this.st.ox, gy: this.st.oy };
    const tracks = {};
    for (const p of props) {
      const tr = [{ t: 0, v: cur[p], ease: "linear" }];
      for (const k of keys) if (k[p] !== undefined && k.t > 0) tr.push({ t: k.t, v: k[p], ease: k.ease || "inout" });
      tr.sort((a, b) => a.t - b.t);
      tracks[p] = tr;
    }
    const dur = Math.max(0, ...keys.map((k) => k.t || 0));
    return { t0: now, tracks, dur };
  }

  _seqValue(tr, t) {
    if (t <= tr[0].t) return tr[0].v;
    for (let i = 1; i < tr.length; i++) {
      if (t <= tr[i].t) {
        const a = tr[i - 1], b = tr[i];
        const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
        return lerp(a.v, b.v, (EASE[b.ease] || EASE.inout)(f));
      }
    }
    return tr[tr.length - 1].v;
  }

  // ---------------------------------------------------------- update
  update(now, dt) {
    const st = this.st;
    const b = this.behavior;
    const f = this.frame;
    if (this.forceAwake) {
      st.open = 1; st.bright = 1; st.pupil = f.pupil; st.gx = f.gaze[0]; st.gy = f.gaze[1];
      return;
    }
    // Gaze: fast saccade for big jumps, smooth pursuit for small moves. The
    // eye template can scale these (motion.*) to give an eye its character.
    const M = this.template.motion;
    if (now > this.microNext) {
      const m = (b.micro_saccade || 0) * M.micro;
      this.micro = [(Math.random() * 2 - 1) * m, (Math.random() * 2 - 1) * m];
      this.microNext = now + 0.4 + Math.random() * 1.2;
    }
    // Slow wet drift: an eye that never quite holds still.
    const dr = M.drift;
    const driftX = dr * (Math.sin(now * 0.23) + 0.6 * Math.sin(now * 0.51 + 1.7));
    const driftY = dr * 0.6 * (Math.sin(now * 0.17 + 0.4) + 0.5 * Math.sin(now * 0.43 + 2.2));
    let roll = 0;
    if (this.rollT0) {
      const p = (now - this.rollT0) / Math.max(0.2, M.rollback_s);
      if (p >= 1) this.rollT0 = 0;
      else roll = (p < 0.2 ? p / 0.2 : p < 0.65 ? 1 : 1 - (p - 0.65) / 0.35) * M.rollback * 5;
    }
    const tx = f.gaze[0] + this.micro[0] + st.ox + driftX;
    const ty = f.gaze[1] + this.micro[1] + st.oy + driftY - roll;
    const dist = Math.hypot(tx - st.gx, ty - st.gy);
    const thr = M.saccades > 0 ? b.saccade_threshold / M.saccades : Infinity;
    const rate = dist > thr ? b.saccade_speed : 1 / Math.max(0.01, b.pursuit_s * M.pursuit);
    st.gx = approach(st.gx, tx, rate, dt);
    st.gy = approach(st.gy, ty, rate, dt);
    if (this.template.pupil.count > 1) this._updatePupils(now, dt);

    if (this.seq) {
      const t = now - this.seq.t0;
      const tr = this.seq.tracks;
      st.open = this._seqValue(tr.open, t);
      st.bright = this._seqValue(tr.bright, t);
      st.pupil = this._seqValue(tr.pupil, t);
      st.ox = this._seqValue(tr.gx, t);
      st.oy = this._seqValue(tr.gy, t);
      if (t > this.seq.dur + 0.5) this.seq = null;
      return;
    }
    st.ox = approach(st.ox, 0, 3, dt);
    st.oy = approach(st.oy, 0, 3, dt);
    // "waking"/"sleeping" without a sequence means we joined mid-way: ease
    // toward the live targets until the next phase message arrives.
    if (this.phase === "awake" || ((this.phase === "waking" || this.phase === "sleeping") && !this.seq)) {
      st.open = approach(st.open, f.open, 7, dt);
      st.bright = approach(st.bright, 1, 4, dt);
      const pTarget = now < this.snapUntil ? f.pupil * (1 - M.pupil_snap) : f.pupil;
      st.pupil = approach(st.pupil, pTarget, 2.5 * M.pupil_speed, dt);
    } else if (this.phase === "asleep" || this.phase === "media") {
      st.bright = approach(st.bright, 0, 3, dt);
      st.open = approach(st.open, 0, 3, dt);
      if (st.bright < 0.003) st.bright = 0;
    }
  }

  // Several pupils darting independently inside one iris (positions in iris
  // radii). Every so often they clump in the centre, then scatter.
  _updatePupils(now, dt) {
    const P = this.template.pupil;
    const n = Math.round(P.count);
    while (this.multi.length < n) this.multi.push({ x: 0, y: 0, tx: 0, ty: 0, next: 0 });
    this.multi.length = n;
    const spread = P.spread;
    if (now > this.clumpNext) {
      this.clumpUntil = now + 0.8 + Math.random() * 0.8;
      this.clumpNext = now + (P.clump_every || 8) * (0.6 + Math.random() * 0.8);
      for (const q of this.multi) q.next = 0;
    }
    const clumping = now < this.clumpUntil;
    for (const q of this.multi) {
      if (now > q.next) {
        const r = clumping ? Math.random() * 0.12 : spread * Math.sqrt(Math.random());
        const a = Math.random() * Math.PI * 2;
        q.tx = Math.cos(a) * r;
        q.ty = Math.sin(a) * r;
        q.next = clumping ? this.clumpUntil : now + 0.15 + Math.random() * (P.dart_s || 1);
      }
      const rate = clumping ? 9 : 22;
      q.x = approach(q.x, q.tx, rate, dt);
      q.y = approach(q.y, q.ty, rate, dt);
    }
  }

  effectiveOpen(now, lidFollow = true) {
    const st = this.st;
    let open = st.open;
    if (this.blinkT0 !== null) {
      const p = (now - this.blinkT0) / this.blinkDur;
      if (p >= 1) this.blinkT0 = null;
      else {
        const c = p < 0.4 ? EASE.out(p / 0.4) : 1 - EASE.inout((p - 0.4) / 0.6);
        open *= 1 - c * (this.template.blink_strength ?? 1);   // 0 = unblinking eye
      }
    }
    if (this.phase === "awake" && lidFollow) {
      const lf = this.behavior.lid_follow || 0;
      open -= lf * Math.max(0, st.gy) * 0.3 * Math.min(1, open);
      open += 0.08 * Math.max(0, -st.gy) * Math.min(1, open);
    }
    return Math.max(0, open);
  }

  // --------------------------------------------------------- textures
  _layout() {
    const c = this.canvas;
    const dpr = (window.devicePixelRatio || 1) * (this.preview ? 1 : this.projection.render_scale || 1);
    const w = Math.round(c.clientWidth * dpr) || c.width;
    const h = Math.round(c.clientHeight * dpr) || c.height;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    let px, py, R;
    if (this.preview) {
      R = Math.min(w / 2.08, h / 1.06);
      px = w / 2;
      py = h / 2 + R / 2;
    } else {
      const p = this.projection;
      R = p.radius * w;
      px = p.cx * w;
      py = p.cy * h;
      if (p.shape === "full") {
        // No window shape: centre the eye itself on the screen.
        py = (p.full_cy ?? 0.5) * h + this.template.geometry.eye_center_y * R;
      }
    }
    // The visible screen in eye units (used to size shader eyes in full mode).
    this._full = !this.preview && this.projection.shape === "full";
    this._view = this._full ? { x0: -px / R, y0: -py / R, w: w / R, h: h / R } : null;
    return { w, h, px, py, R };
  }

  _buildTextures(R) {
    const T = this.template;
    // Rebuild only when the template object, size or loaded images change
    // (setTemplate/setProjection/image onload clear texKey).
    const key = Math.round(R) + ":" + Object.values(this.images).filter((im) => im.complete).length;
    if (key === this.texKey && this.tex) return this.tex;
    this.texKey = key;
    const seed = hashString(T.name || "eye") ^ (T.seed || 0);
    const tex = {};
    const g = T.geometry;

    // Veins on the eyeball, in a box x [-1.4,1.4], y [-1.4,0.5].
    {
      const box = { x0: -1.4, y0: -1.4, w: 2.8, h: 1.9 };
      const s = Math.min(1200 / box.w, R);
      const c = makeCanvas(box.w * s, box.h * s);
      const x = c.getContext("2d");
      x.setTransform(s, 0, 0, s, -box.x0 * s, -box.y0 * s);
      const sc = T.sclera;
      const img = this.images.sclera;
      if (img && img.complete && img.naturalWidth) {
        x.drawImage(img, -1.2, -1.2, 2.4, 1.6);
      }
      const r = rng(seed);
      const E = [0, -g.eye_center_y];
      // Hemorrhages: soft, irregular blood blotches toward the eyeball edge.
      const rb = rng(seed + 29);
      for (let i = 0; i < (sc.blotches || 0); i++) {
        const a = Math.PI + rb() * Math.PI;
        const d = 0.55 + rb() * 0.45;
        const bx = E[0] + Math.cos(a) * d * 1.1, by = E[1] + Math.sin(a) * d;
        const size = 0.05 + rb() * 0.12;
        for (let k = 0; k < 6; k++) {
          const ox = bx + (rb() - 0.5) * size, oy = by + (rb() - 0.5) * size * 0.7;
          const rr = size * (0.3 + rb() * 0.5);
          const bg = x.createRadialGradient(ox, oy, 0, ox, oy, rr);
          bg.addColorStop(0, hexA(sc.blotch_color, 0.55));
          bg.addColorStop(1, hexA(sc.blotch_color, 0));
          x.fillStyle = bg;
          x.beginPath(); x.arc(ox, oy, rr, 0, Math.PI * 2); x.fill();
        }
      }
      x.lineCap = "round";
      const branch = (px, py, ang, len, width, depth) => {
        let cx = px, cy = py;
        const steps = 10;
        x.strokeStyle = hexA(sc.vein_color, sc.vein_alpha);
        for (let i = 0; i < steps; i++) {
          ang += (r() - 0.5) * 0.7;
          const nx = cx + Math.cos(ang) * len / steps;
          const ny = cy + Math.sin(ang) * len / steps;
          x.lineWidth = width * (1 - i / steps * 0.8);
          x.beginPath(); x.moveTo(cx, cy); x.lineTo(nx, ny); x.stroke();
          if (depth < 2 && r() < 0.18) branch(nx, ny, ang + (r() - 0.5) * 1.8, len * 0.5, x.lineWidth * 0.7, depth + 1);
          cx = nx; cy = ny;
        }
      };
      for (let i = 0; i < sc.veins; i++) {
        const a = Math.PI + r() * Math.PI * 1.15 - 0.07 * Math.PI;
        const rad = 1.05 + r() * 0.2;
        const sx = E[0] + Math.cos(a) * rad * 1.1;
        const sy = E[1] + Math.sin(a) * rad;
        const toward = Math.atan2(E[1] - sy, E[0] - sx) + (r() - 0.5) * 0.6;
        branch(sx, sy, toward, sc.vein_length * (0.6 + r() * 0.6), sc.vein_width * (0.7 + r() * 0.8), 0);
      }
      tex.veins = { c, box };
    }

    // Iris texture.
    {
      const ri = g.iris_radius;
      const s = Math.min(1024, ri * 2 * R) / (ri * 2);
      const c = makeCanvas(ri * 2 * s, ri * 2 * s);
      const x = c.getContext("2d");
      x.setTransform(s, 0, 0, s, ri * s, ri * s);
      const I = T.iris;
      const img = this.images.iris;
      x.save();
      x.beginPath(); x.arc(0, 0, ri, 0, Math.PI * 2); x.clip();
      if (img && img.complete && img.naturalWidth) {
        x.drawImage(img, -ri, -ri, ri * 2, ri * 2);
      } else {
        const gr = x.createRadialGradient(0, 0, 0, 0, 0, ri);
        gr.addColorStop(0, I.inner);
        gr.addColorStop(0.35, I.inner);
        gr.addColorStop(0.65, I.mid);
        gr.addColorStop(1, I.outer);
        x.fillStyle = gr;
        x.fillRect(-ri, -ri, ri * 2, ri * 2);
        const r = rng(seed + 7);
        x.lineCap = "round";
        for (let i = 0; i < I.fibers; i++) {
          const a = r() * Math.PI * 2;
          const r0 = ri * (0.12 + r() * 0.2);
          const r1 = ri * (0.6 + r() * 0.38);
          const bend = (r() - 0.5) * 0.25;
          x.strokeStyle = r() < 0.3 ? hexA(I.inner, I.fiber_alpha * 0.7) : hexA(I.fiber_color, I.fiber_alpha);
          x.lineWidth = ri * (0.006 + r() * 0.012);
          x.beginPath();
          x.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
          x.quadraticCurveTo(Math.cos(a + bend) * (r0 + r1) / 2, Math.sin(a + bend) * (r0 + r1) / 2,
            Math.cos(a + bend * 0.5) * r1, Math.sin(a + bend * 0.5) * r1);
          x.stroke();
        }
        for (let i = 0; i < I.spots; i++) {
          const a = r() * Math.PI * 2;
          const d = ri * (0.3 + r() * 0.55);
          x.fillStyle = hexA(I.fiber_color, 0.25 + r() * 0.35);
          x.beginPath();
          x.ellipse(Math.cos(a) * d, Math.sin(a) * d, ri * (0.02 + r() * 0.04), ri * (0.01 + r() * 0.02), a, 0, Math.PI * 2);
          x.fill();
        }
        // Reptile mottling: irregular cells with dark outlines (Smaug-like).
        if (I.cells > 0) {
          const rc = rng(seed + 83);
          x.lineJoin = "round";
          for (let i = 0; i < I.cells; i++) {
            const a = rc() * Math.PI * 2, d = ri * Math.sqrt(rc()) * 0.97;
            const cx = Math.cos(a) * d, cy = Math.sin(a) * d;
            const size = ri * (0.035 + rc() * 0.06) * (I.cell_size || 1);
            x.beginPath();
            for (let k = 0; k < 9; k++) {
              const t = (k / 9) * Math.PI * 2;
              const rr = size * (0.65 + rc() * 0.5);
              k ? x.lineTo(cx + Math.cos(t) * rr * 1.3, cy + Math.sin(t) * rr) : x.moveTo(cx + Math.cos(t) * rr * 1.3, cy + Math.sin(t) * rr);
            }
            x.closePath();
            x.fillStyle = hexA(rc() < 0.5 ? I.cell_fill : I.inner, 0.18 + rc() * 0.2);
            x.fill();
            x.strokeStyle = hexA(I.cell_color, 0.45 + rc() * 0.35);
            x.lineWidth = ri * (0.008 + rc() * 0.01);
            x.stroke();
          }
        }
        // collarette ring
        x.strokeStyle = hexA(I.inner, 0.35);
        x.lineWidth = ri * 0.025;
        x.beginPath();
        for (let i = 0; i <= 64; i++) {
          const a = (i / 64) * Math.PI * 2;
          const d = ri * (0.42 + Math.sin(a * 9 + seed) * 0.025);
          i ? x.lineTo(Math.cos(a) * d, Math.sin(a) * d) : x.moveTo(Math.cos(a) * d, Math.sin(a) * d);
        }
        x.stroke();
      }
      const lw = clamp(I.limbus_width, 0, 0.6);
      const lg = x.createRadialGradient(0, 0, ri * (1 - lw), 0, 0, ri);
      lg.addColorStop(0, hexA(I.limbus, 0));
      lg.addColorStop(1, hexA(I.limbus, 0.95));
      x.fillStyle = lg;
      x.fillRect(-ri, -ri, ri * 2, ri * 2);
      x.restore();
      tex.iris = c;
    }

    // Lid skin texture over the aperture box x [-1,1], y [-1.05,0.05].
    {
      const s = Math.min(1400 / 2, R);
      const c = makeCanvas(2 * s, 1.1 * s);
      const x = c.getContext("2d");
      x.setTransform(s, 0, 0, s, s, 1.05 * s);
      const L = T.lid;
      const img = this.images.lid;
      if (img && img.complete && img.naturalWidth) {
        x.drawImage(img, -1, -1.05, 2, 1.1);
      } else {
        const gr = x.createRadialGradient(0, -0.35, 0.1, 0, -0.2, 1.1);
        gr.addColorStop(0, L.color);
        gr.addColorStop(1, L.shade);
        x.fillStyle = gr;
        x.fillRect(-1, -1.05, 2, 1.1);
        const r = rng(seed + 13);
        const n = Math.round(L.texture * 400);
        for (let i = 0; i < n; i++) {
          x.fillStyle = hexA(r() < 0.5 ? L.spots_color : L.color, 0.15 + r() * 0.35);
          const rr = 0.004 + r() * 0.02 * L.texture;
          x.beginPath();
          x.ellipse(r() * 2 - 1, -r() * 1.05, rr, rr * (0.5 + r()), r() * 3, 0, Math.PI * 2);
          x.fill();
        }
        if (L.fur > 0) this._drawFur(x, L, r);
        if (L.feathers > 0) this._drawFeathers(x, L, r);
        if (L.scales > 0) {
          if (L.scale_style === "craggy") this._drawCraggyScales(x, L, r);
          else this._drawScales(x, L, r);
        }
      }
      tex.lid = c;
    }

    // Compound-eye facets covering the eyeball (box x [-1.3,1.3], y [-1.4,0.3]).
    if (T.sclera.facets > 0) {
      const box = { x0: -1.3, y0: -1.4, w: 2.6, h: 1.7 };
      const s = Math.min(1400 / box.w, R);
      const c = makeCanvas(box.w * s, box.h * s);
      const x = c.getContext("2d");
      x.setTransform(s, 0, 0, s, -box.x0 * s, -box.y0 * s);
      this._drawFacets(x, T.sclera, box, g, rng(seed + 41));
      tex.facets = { c, box };
    }
    // Static overlays across the whole window: cracks (glass/porcelain) and frost.
    for (const kind of ["cracks", "frost"]) {
      if (!(T.overlay_fx[kind] > 0)) continue;
      const s = Math.min(1400 / 2, R);
      const c = makeCanvas(2 * s, 1.05 * s);
      const x = c.getContext("2d");
      x.setTransform(s, 0, 0, s, s, 1.02 * s);
      if (kind === "cracks") this._drawCracks(x, T.overlay_fx, rng(seed + 53));
      else this._drawFrost(x, T.overlay_fx, rng(seed + 67));
      tex[kind] = c;
    }
    if (T.style === "dragon") tex.dragon = buildDragonTextures(T, R, rng, seed);
    this.tex = tex;
    return tex;
  }

  _drawFacets(x, sc, box, g, r) {
    const sz = sc.facets;                       // hex radius
    const E = [0, -g.eye_center_y];
    const hw = Math.sqrt(3) * sz;
    let row = 0;
    for (let cy = box.y0; cy < box.y0 + box.h + sz; cy += sz * 1.5, row++) {
      for (let cx = box.x0 + (row % 2) * hw / 2; cx < box.x0 + box.w + hw; cx += hw) {
        const d = Math.hypot(cx - E[0], cy - E[1]);
        const shade = Math.max(0, 1 - d / 1.25);
        const f = sz * (0.95 - 0.15 * (1 - shade));   // facets shrink toward the edge (curvature)
        const gr = x.createRadialGradient(cx - f * 0.3, cy - f * 0.35, f * 0.05, cx, cy, f);
        gr.addColorStop(0, sc.facet_highlight);
        gr.addColorStop(0.35, sc.center);
        gr.addColorStop(1, sc.edge);
        x.fillStyle = gr;
        x.globalAlpha = 0.55 + 0.45 * shade + (r() - 0.5) * 0.15;
        x.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = Math.PI / 6 + (k * Math.PI) / 3;
          k ? x.lineTo(cx + Math.cos(a) * f, cy + Math.sin(a) * f) : x.moveTo(cx + Math.cos(a) * f, cy + Math.sin(a) * f);
        }
        x.closePath();
        x.fill();
      }
    }
    x.globalAlpha = 1;
  }

  // Jagged branching cracks radiating from a few impact points.
  _drawCracks(x, fx, r) {
    x.lineCap = "round";
    x.lineJoin = "round";
    const crack = (px, py, ang, len, width, depth) => {
      x.strokeStyle = hexA(fx.crack_color, 0.85);
      let cx = px, cy = py;
      const steps = 8;
      for (let i = 0; i < steps; i++) {
        ang += (r() - 0.5) * 0.9;
        const nx = cx + Math.cos(ang) * len / steps, ny = cy + Math.sin(ang) * len / steps;
        x.lineWidth = width * (1 - i / steps * 0.7);
        x.beginPath(); x.moveTo(cx, cy); x.lineTo(nx, ny); x.stroke();
        // faint light edge beside the crack, like chipped glaze
        x.strokeStyle = `rgba(255,255,255,${0.25 * fx.cracks})`;
        x.lineWidth *= 0.5;
        x.beginPath(); x.moveTo(cx + 0.004, cy + 0.004); x.lineTo(nx + 0.004, ny + 0.004); x.stroke();
        x.strokeStyle = hexA(fx.crack_color, 0.85);
        if (depth < 3 && r() < 0.3) crack(nx, ny, ang + (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.8), len * 0.5, width * 0.7, depth + 1);
        cx = nx; cy = ny;
      }
    };
    const n = Math.max(1, Math.round(fx.cracks * 4));
    for (let k = 0; k < n; k++) {
      const ox = (r() - 0.5) * 1.4, oy = -0.15 - r() * 0.7;
      const arms = 3 + Math.floor(r() * 4);
      for (let a = 0; a < arms; a++) crack(ox, oy, r() * Math.PI * 2, 0.3 + r() * 0.6, 0.008, 0);
    }
  }

  // Frost: feathery ice dendrites growing inward from the window edge.
  _drawFrost(x, fx, r) {
    x.lineCap = "round";
    const grow = (px, py, ang, len, depth) => {
      const nx = px + Math.cos(ang) * len, ny = py + Math.sin(ang) * len;
      x.strokeStyle = hexA(fx.frost_color, 0.35 + 0.4 * (1 - depth / 4));
      x.lineWidth = 0.006 / (depth + 1);
      x.beginPath(); x.moveTo(px, py); x.lineTo(nx, ny); x.stroke();
      if (depth >= 3) return;
      const k = 2 + Math.floor(r() * 2);
      for (let i = 1; i <= k; i++) {
        const t = i / (k + 1);
        const bx = px + (nx - px) * t, by = py + (ny - py) * t;
        for (const side of [-1, 1]) grow(bx, by, ang + side * Math.PI / 3, len * 0.35 * (1 - t * 0.5), depth + 1);
      }
    };
    const n = Math.round(30 * fx.frost);
    for (let i = 0; i < n; i++) {
      // Seed points around the dome edge and along the sill, pointing inward.
      let px, py, ang;
      if (r() < 0.75) {
        const a = Math.PI + r() * Math.PI;
        px = Math.cos(a) * 0.99; py = Math.sin(a) * 0.99; ang = a + Math.PI + (r() - 0.5) * 0.6;
      } else {
        px = r() * 2 - 1; py = -0.01; ang = -Math.PI / 2 + (r() - 0.5) * 0.8;
      }
      grow(px, py, ang, (0.12 + r() * 0.22) * (0.6 + fx.frost * 0.6), 0);
    }
  }

  // Fur: thousands of short hairs combed down and outward over the lid.
  _drawFur(x, L, r) {
    const n = Math.round(4000 * L.fur);
    x.lineCap = "round";
    for (let i = 0; i < n; i++) {
      const px = r() * 2.1 - 1.05, py = -r() * 1.1 + 0.05;
      const a = Math.PI / 2 + px * 0.5 + (r() - 0.5) * 0.6;   // down, fanning out at the sides
      const len = 0.02 + r() * 0.045;
      x.strokeStyle = hexA(r() < 0.6 ? L.fur_color : L.shade, 0.25 + r() * 0.45);
      x.lineWidth = 0.002 + r() * 0.003;
      x.beginPath();
      x.moveTo(px, py);
      x.quadraticCurveTo(px + Math.cos(a) * len * 0.5 + (r() - 0.5) * 0.01, py + Math.sin(a) * len * 0.5,
        px + Math.cos(a) * len, py + Math.sin(a) * len);
      x.stroke();
    }
  }

  // Feathers: overlapping rows of soft, pointed feathers with a shaft and barbs.
  _drawFeathers(x, L, r) {
    const sz = L.feathers;
    const w = sz * 0.55;
    let row = 0;
    for (let cy = -1.05 - sz; cy < 0.05; cy += sz * 0.45, row++) {
      const off = (row % 2) * w;
      for (let cx = -1.05 - w + off; cx < 1.05 + w; cx += w * 2 * 0.85) {
        const tip = cy + sz * (1 + (r() - 0.5) * 0.2);
        const g = x.createLinearGradient(cx, cy, cx, tip);
        g.addColorStop(0, L.shade);
        g.addColorStop(0.5, L.color);
        g.addColorStop(1, L.feather_tip);
        x.fillStyle = g;
        x.beginPath();
        x.moveTo(cx - w, cy);
        x.quadraticCurveTo(cx - w * 0.95, tip - sz * 0.25, cx, tip);
        x.quadraticCurveTo(cx + w * 0.95, tip - sz * 0.25, cx + w, cy);
        x.closePath();
        x.fill();
        x.strokeStyle = hexA(L.shade, 0.5);
        x.lineWidth = sz * 0.03;
        x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx, tip); x.stroke();
        x.lineWidth = sz * 0.012;
        for (let k = 1; k < 6; k++) {
          const yy = cy + (tip - cy) * (k / 6);
          x.beginPath(); x.moveTo(cx, yy); x.lineTo(cx - w * 0.8, yy - sz * 0.12); x.moveTo(cx, yy); x.lineTo(cx + w * 0.8, yy - sz * 0.12); x.stroke();
        }
      }
    }
  }

  // Photographic dragon/croc hide: irregular scales of varying size on a dark
  // grooved base, each with a cast shadow, curved shading toward the light,
  // a bevelled lit edge, pitting, and a faint wet glint. Light comes from
  // lid.light (degrees, 0 = from the right, 90 = from above).
  _drawCraggyScales(x, L, r) {
    const sz = L.scales;
    const la = ((L.light ?? 60) * Math.PI) / 180;
    const lx = Math.cos(la), ly = -Math.sin(la);           // toward the light (y down)
    // Grooves and mottled base between scales.
    for (let i = 0; i < 900; i++) {
      x.fillStyle = hexA(r() < 0.5 ? L.shade : L.spots_color, 0.25 + r() * 0.35);
      const rr = sz * (0.2 + r() * 0.8);
      x.beginPath(); x.ellipse(r() * 2.1 - 1.05, -r() * 1.1 + 0.05, rr, rr * 0.7, r() * 3, 0, Math.PI * 2); x.fill();
    }
    const scales = [];
    for (let cy = -1.08; cy < 0.08; cy += sz * 0.68) {
      for (let cx = -1.08; cx < 1.08; cx += sz * 0.68) {
        const px = cx + (r() - 0.5) * sz * 0.5, py = cy + (r() - 0.5) * sz * 0.5;
        // Bigger, bolder plates higher up on the brow; finer near the rim.
        const s = sz * (0.4 + r() * 0.3) * (0.7 + Math.min(1, -py) * 0.6);
        scales.push([px, py, s]);
      }
    }
    scales.sort((a, b) => a[1] - b[1]);
    const poly = (px, py, s, ox = 0, oy = 0, grow = 1) => {
      x.beginPath();
      const n = 5 + Math.floor(r() * 4);              // angular plates, not pebbles
      const rot = r() * Math.PI;
      for (let k = 0; k < n; k++) {
        const t = rot + ((k + (r() - 0.5) * 0.5) / n) * Math.PI * 2;
        const rr = s * grow * (0.6 + r() * 0.5);
        const vx = px + ox + Math.cos(t) * rr * 1.15, vy = py + oy + Math.sin(t) * rr * 0.9;
        k ? x.lineTo(vx, vy) : x.moveTo(vx, vy);
      }
      x.closePath();
    };
    for (const [px, py, s] of scales) {
      const seedState = r();                      // shape varies per scale but repeats per pass
      // Re-seed so each pass traces the same outline for this scale.
      const pass = (fn) => { const save = r; r = rng(Math.floor(seedState * 1e9)); fn(); r = save; };
      // 1. narrow cast shadow into the groove, away from the light
      pass(() => poly(px, py, s, -lx * s * 0.14, -ly * s * 0.14, 1.05));
      x.fillStyle = "rgba(0,0,0,0.5)";
      x.fill();
      // 2. body: mostly flat hide colour, each plate a little different
      const tint = r();
      pass(() => poly(px, py, s));
      x.fillStyle = tint < 0.3 ? L.spots_color : L.color;
      x.fill();
      x.fillStyle = `rgba(0,0,0,${r() * 0.55})`;
      x.fill();
      // ... with a low, raking sheen from the light side
      const gr = x.createLinearGradient(px + lx * s, py + ly * s, px - lx * s, py - ly * s);
      gr.addColorStop(0, hexA(L.scale_highlight, 0.15 + r() * 0.3));
      gr.addColorStop(0.55, hexA(L.scale_highlight, 0));
      x.fillStyle = gr;
      x.fill();
      // 3. bevel: thin lit edge toward the light, dark edge opposite
      x.save();
      x.clip();
      pass(() => poly(px, py, s, -lx * s * 0.08, -ly * s * 0.08));
      x.strokeStyle = hexA(L.scale_highlight, 0.3);
      x.lineWidth = s * 0.08;
      x.stroke();
      pass(() => poly(px, py, s, lx * s * 0.1, ly * s * 0.1));
      x.strokeStyle = "rgba(0,0,0,0.4)";
      x.lineWidth = s * 0.12;
      x.stroke();
      // 4. pitting and specks
      for (let k = 0; k < 5; k++) {
        const qx = px + (r() - 0.5) * s * 1.2, qy = py + (r() - 0.5) * s;
        x.fillStyle = r() < 0.6 ? "rgba(0,0,0,0.35)" : hexA(L.scale_highlight, 0.35);
        x.beginPath(); x.arc(qx, qy, s * (0.03 + r() * 0.06), 0, Math.PI * 2); x.fill();
      }
      // 5. faint wet glint
      if (r() < 0.55) {
        const gx = px + lx * s * 0.45, gy = py + ly * s * 0.45;
        const gg = x.createRadialGradient(gx, gy, 0, gx, gy, s * 0.35);
        gg.addColorStop(0, `rgba(255,255,255,${0.12 + r() * 0.18})`);
        gg.addColorStop(1, "rgba(255,255,255,0)");
        x.fillStyle = gg;
        x.beginPath(); x.arc(gx, gy, s * 0.35, 0, Math.PI * 2); x.fill();
      }
      x.restore();
    }
  }

  // Overlapping reptile scales over the lid box, rows drawn top to bottom so
  // each row overlaps the one above (scales point down, like armour).
  _drawScales(x, L, r) {
    const sz = L.scales;
    const h = sz * 0.5;
    const rowStep = sz * 0.55;
    let row = 0;
    for (let cy = -1.05 - sz; cy < 0.05; cy += rowStep, row++) {
      const off = (row % 2) * h;
      for (let cx = -1 - sz + off; cx < 1 + sz; cx += sz) {
        const j = (r() - 0.5) * 0.25;
        const g = x.createRadialGradient(cx, cy + h * 0.6, 0, cx, cy + h, h * 1.05);
        g.addColorStop(0, L.color);
        g.addColorStop(0.75, L.scale_highlight);
        g.addColorStop(1, L.shade);
        x.fillStyle = g;
        // Fish-scale: straight sides, round bottom; the next row covers the top.
        x.beginPath();
        x.moveTo(cx - h, cy);
        x.lineTo(cx - h, cy + h);
        x.arc(cx, cy + h, h, Math.PI, 0, true);
        x.lineTo(cx + h, cy);
        x.closePath();
        x.fill();
        if (j) {
          x.fillStyle = j > 0 ? `rgba(255,220,160,${j * 0.5})` : `rgba(0,0,0,${-j})`;
          x.fill();
        }
        x.strokeStyle = hexA(L.edge, 0.55);
        x.lineWidth = sz * 0.05;
        x.stroke();
      }
    }
  }

  // ------------------------------------------------------------ draw
  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.renderNow();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() { this.running = false; }

  renderNow() {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, Math.max(0, now - this.last));
    this.last = now;
    this.update(now, dt);
    this.draw(now);
  }

  _aperture(x) {
    x.beginPath();
    x.arc(0, 0, 1, Math.PI, Math.PI * 2, false);
    x.closePath();
  }

  draw(now) {
    const x = this.ctx;
    const L = this._layout();
    const P = this.projection;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalCompositeOperation = "source-over";
    x.globalAlpha = 1;
    x.fillStyle = "#000";
    x.fillRect(0, 0, L.w, L.h);

    x.translate(L.px, L.py);
    if (!this.preview) {
      x.rotate((P.rotation || 0) * Math.PI / 180);
      x.scale(P.flip_h ? -L.R : L.R, L.R);
      if (P.flip_v) { x.translate(0, -0.5); x.scale(1, -1); x.translate(0, 0.5); }
    } else {
      x.scale(L.R, L.R);
    }
    const bright = this.st.bright * (P.brightness ?? 1);
    if (this.media) {
      this._drawMedia(x);
    } else if (bright > 0.002) {
      x.save();
      if (!this._full) {            // full-screen mode: no window-shaped clip
        this._aperture(x);
        x.clip();
      }
      this._drawEye(x, now, L.R);
      if (this.template.glitch > 0) this._glitch(x, now, L);
      x.restore();
      if (bright < 0.999) {
        x.fillStyle = `rgba(0,0,0,${1 - bright})`;
        const v = this._view || { x0: -1.1, y0: -1.1, w: 2.2, h: 1.2 };
        x.fillRect(v.x0 - 1, v.y0 - 1, v.w + 2, v.h + 2);
      }
    }
    if (!this._full) {
      this._drawFeather(x);
      if (P.outline && !this.preview) this._drawOutline(x, L.R);
    }
  }

  // Digital glitch, done in device pixels inside the window clip: scanlines
  // always, plus bursts of torn, shifted, colour-tinted slices.
  _glitch(x, now, L) {
    const gl = this.template.glitch;
    const c = this.canvas;
    const top = Math.max(0, Math.floor(L.py - L.R)), bottom = Math.min(c.height, Math.ceil(L.py));
    x.save();
    x.setTransform(1, 0, 0, 1, 0, 0);     // the clip set earlier still applies
    x.fillStyle = `rgba(0,0,0,${0.25 * gl})`;
    const step = Math.max(3, Math.round(L.R / 120));
    for (let y = top; y < bottom; y += step) x.fillRect(L.px - L.R, y, L.R * 2, 1);
    // Bursts: mostly calm, then a few frames of tearing.
    if (now > (this.glitchUntil || 0) && Math.random() < 0.02 * gl) this.glitchUntil = now + 0.08 + Math.random() * 0.25;
    if (now < (this.glitchUntil || 0)) {
      const slices = 2 + Math.floor(Math.random() * 5);
      for (let i = 0; i < slices; i++) {
        const h = Math.max(2, Math.round(L.R * (0.02 + Math.random() * 0.1)));
        const y = Math.round(top + Math.random() * (bottom - top - h));
        const dx = Math.round((Math.random() - 0.5) * L.R * 0.25 * gl);
        x.drawImage(c, 0, y, c.width, h, dx, y, c.width, h);
        x.fillStyle = Math.random() < 0.5 ? "rgba(255,0,60,0.18)" : "rgba(0,255,220,0.18)";
        x.fillRect(L.px - L.R, y, L.R * 2, h);
      }
    }
    x.restore();
  }

  _drawMedia(x) {
    const m = this.media;
    x.save();
    this._aperture(x);
    x.clip();
    const el = m.el;
    const w = el ? (el.videoWidth || el.naturalWidth) : 0;
    const h = el ? (el.videoHeight || el.naturalHeight) : 0;
    if (w && h) {
      const boxW = 2, boxH = 1;
      const sc = (m.fit === "contain" ? Math.min : Math.max)(boxW / w, boxH / h);
      x.drawImage(el, -w * sc / 2, -boxH / 2 - h * sc / 2, w * sc, h * sc);
    } else if (!this.mediaEnabled) {
      x.fillStyle = "#222";
      x.fillRect(-1, -1, 2, 1);
      x.fillStyle = "#aaa";
      x.font = "0.12px sans-serif";
      x.textAlign = "center";
      x.fillText("▶ " + (m.item || "media"), 0, -0.4);
    }
    x.restore();
  }

  // Eye = eyeball (classic 2D, or a shader style) + optional lids on top.
  // Lids default on, except for "fire" which is lidless; template.lids can
  // force "on"/"off". Without lids, "open" scales the shader eye instead.
  _drawEye(x, now, R) {
    const T = this.template;
    const style = T.style || "classic";
    const lids = T.lids === "on" || (T.lids !== "off" && style !== "fire" && style !== "sauron");
    const open = this.effectiveOpen(now, lids);
    const tex = this._buildTextures(R);
    if (style === "dragon") {
      drawDragon(x, this, now, tex.dragon);
      const dv = x.createRadialGradient(0, 0, 0.75, 0, 0, 1);
      dv.addColorStop(0, "rgba(0,0,0,0)");
      dv.addColorStop(1, `rgba(0,0,0,${T.vignette})`);
      x.fillStyle = dv;
      x.fillRect(-1.05, -1.05, 2.1, 1.1);
      return;
    }
    if (style === "classic") this._drawClassicBall(x, now, R, tex);
    else this._drawShaderBall(x, now, R, style, lids ? 1 : Math.min(1.2, open));
    // Cracks sit on the eye's glassy surface (under the lids); frost on top.
    if (tex.cracks) x.drawImage(tex.cracks, -1, -1.02, 2, 1.05);
    if (lids) this._drawLids(x, open, tex);
    if (tex.frost) {
      x.save();
      x.globalCompositeOperation = "lighter";
      x.drawImage(tex.frost, -1, -1.02, 2, 1.05);
      x.restore();
    }

    // Depth vignette at the window edge (none without a window shape).
    if (!this._full) {
      const vg = x.createRadialGradient(0, 0, lids ? 0.78 : 0.7, 0, 0, 1);
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, `rgba(0,0,0,${T.vignette})`);
      x.fillStyle = vg;
      x.fillRect(-1.05, -1.05, 2.1, 1.1);
    }
    const ov = this.images.overlay;
    if (ov && ov.complete && ov.naturalWidth) x.drawImage(ov, -1, -1, 2, 1);
  }

  _irisCenter() {
    const g = this.template.geometry;
    // gy may go far negative during a roll-back (iris rolls up under the lid).
    const gx = clamp(this.st.gx, -1.2, 1.2), gy = clamp(this.st.gy, -6, 1.2);
    return [gx * g.gaze_range_x, -g.eye_center_y + gy * g.gaze_range_y];
  }

  _drawShaderBall(x, now, R, style, open) {
    const T = this.template;
    const g = T.geometry;
    const S = T[style] || {};
    const center = this._irisCenter();
    // Full-screen mode renders the whole visible screen, not just the dome.
    const box = this._view || { x0: -1.05, y0: -1.05, w: 2.1, h: 1.1 };
    const q = clamp(S.quality ?? 0.5, 0.1, 1);
    const w = Math.max(16, Math.min(2048, Math.round(box.w * R * q)));
    const h = Math.max(8, Math.round((w * box.h) / box.w));
    const pupil = lerp(T.pupil.min, T.pupil.max, clamp(this.st.pupil, 0, 1));
    const seed = (T.seed || 0) % 97;
    // Shader time wraps at 600 s to stay within float precision.
    const common = { uBox: [box.x0, box.y0, box.w, box.h], uCenter: center, uTime: (now * (S.speed ?? 1)) % 600, uBright: 1, uSeed: seed };
    let u;
    if (style === "fire") {
      u = { ...common, uRadius: g.iris_radius, uOpen: open, uPupilW: pupil, uSlitH: T.pupil.height,
        uTurb: S.turbulence, uReach: S.flame_reach, uFibers: S.fibers, uRim: S.rim_glow, uBg: S.background_fire,
        uAspect: S.iris_aspect, uSlitGlow: S.slit_glow, uWisps: S.wisps || 0, uCoreDark: S.core_dark || 0,
        cCore: S.core, cHot: S.hot, cMid: S.mid, cDark: S.dark, cBack: S.background };
    } else if (style === "sauron") {
      u = { ...common, uRadius: g.iris_radius, uOpen: open, uPupilW: pupil, uSlitH: T.pupil.height,
        uReach: S.flame_reach, uAspect: S.aspect, uWisp: S.wisps, uHalo: S.halo, uInnerRed: S.inner_red,
        uFeather: S.feather, uBase: S.base ?? 0.95, cCore: S.core, cHot: S.hot, cMid: S.mid, cDark: S.dark, cHaloC: S.halo_color };
    } else if (style === "void") {
      u = { ...common, uBall: [0, -g.eye_center_y], uBallR: 1.05, uStar: pupil * g.iris_radius * open,
        uPulse: S.pulse, uSmoke: S.smoke, uSheen: S.sheen, uIrid: S.iridescence, uParallax: S.parallax,
        cSmoke: S.smoke_color, cSheen: S.sheen_color, cStar: S.star_color, cBase: S.base };
    } else {
      u = { ...common, uRadius: g.iris_radius * open, uHole: pupil * g.iris_radius * open, uSpin: S.spin,
        uArms: S.arms, uDust: S.dust, uStars: S.stars, uFlare: S.flares,
        cDeep: S.deep, cDust: S.dust_color, cCore: S.core, cRing: S.ring, cStar: S.star_color };
    }
    const c = renderShader(style, u, w, h, S.octaves);
    if (c) {
      x.drawImage(c, box.x0, box.y0, box.w, box.h);
      return;
    }
    // No WebGL: a static glow so the eye still reads.
    const rr = g.iris_radius * lerp(0.12, 1, Math.min(1, open));
    const gr = x.createRadialGradient(center[0], center[1], 0, center[0], center[1], rr * 1.8);
    const color = (...c) => c.find((v) => typeof v === "string") || "#000";   // sauron.base is a number
    gr.addColorStop(0, color(S.hot, S.core, S.star_color, "#888"));
    gr.addColorStop(1, color(S.background, S.deep, S.base));
    x.fillStyle = gr;
    x.fillRect(box.x0, box.y0, box.w, box.h);
  }

  _drawClassicBall(x, now, R, tex) {
    const T = this.template;
    const g = T.geometry;
    const st = this.st;
    const E = [0, -g.eye_center_y];
    const gx = clamp(st.gx, -1.2, 1.2), gy = clamp(st.gy, -1.2, 1.2);

    // Sclera with spherical shading.
    const sc = T.sclera;
    const sg = x.createRadialGradient(E[0] + gx * 0.15, E[1] + gy * 0.1, 0.05, E[0], E[1], 1.05);
    sg.addColorStop(0, sc.center);
    sg.addColorStop(0.45, sc.mid || sc.center);
    sg.addColorStop(1, sc.edge);
    x.fillStyle = sg;
    x.fillRect(-1.05, -1.05, 2.1, 1.1);
    const vb = tex.veins.box;
    x.drawImage(tex.veins.c, vb.x0 + gx * 0.18, vb.y0 + gy * 0.1, vb.w, vb.h);
    if (tex.facets) {
      const fb = tex.facets.box;
      x.drawImage(tex.facets.c, fb.x0 + gx * 0.12, fb.y0 + gy * 0.06, fb.w, fb.h);
    }

    // Iris position with foreshortening as it rotates away from centre.
    const ri = g.iris_radius;
    const [ix, iy] = this._irisCenter();
    const dx = ix - E[0], dy = iy - E[1];
    const d = Math.hypot(dx, dy);
    const fs = Math.sqrt(1 - Math.min(0.85, (d / g.ball_radius) ** 2));
    const ang = Math.atan2(dy, dx);

    const I = T.iris;
    if (I.glow > 0) {
      // glow_pulse (Hz) makes the glow throb between 40% and 100%.
      let glow = I.glow_pulse > 0 ? I.glow * (0.7 + 0.3 * Math.sin(now * I.glow_pulse * Math.PI * 2)) : I.glow;
      // glow_flicker: irregular candle-like flicker from beating sines.
      if (I.glow_flicker > 0) {
        const n = 0.5 + 0.5 * Math.sin(now * 13.1) * Math.sin(now * 7.7 + 0.5) * Math.sin(now * 3.3 + 2.1);
        glow *= 1 - I.glow_flicker * n;
      }
      const gg = x.createRadialGradient(ix, iy, ri * 0.2, ix, iy, ri * 1.7);
      gg.addColorStop(0, hexA(I.glow_color, Math.min(1, glow)));
      gg.addColorStop(1, hexA(I.glow_color, 0));
      x.fillStyle = gg;
      x.fillRect(ix - ri * 1.7, iy - ri * 1.7, ri * 3.4, ri * 3.4);
    }

    x.save();
    x.translate(ix, iy);
    x.rotate(ang);
    x.scale(fs, 1);
    x.rotate(-ang);
    x.drawImage(tex.iris, -ri, -ri, ri * 2, ri * 2);
    if (I.chromatophores > 0) this._drawChromatophores(x, now, ri);
    if (I.hypno > 0) this._drawHypno(x, now, ri);
    if (I.spiral > 0) this._drawSpiral(x, now, ri);
    if (I.gears > 0) this._drawGears(x, now, ri);
    if (I.scanline > 0) {
      // A bright sensor line sweeping up and down the iris.
      const sy = ri * 0.85 * Math.sin(now * I.scan_speed * 2);
      const sg2 = x.createLinearGradient(0, sy - ri * 0.08, 0, sy + ri * 0.08);
      sg2.addColorStop(0, hexA(I.scan_color, 0));
      sg2.addColorStop(0.5, hexA(I.scan_color, I.scanline));
      sg2.addColorStop(1, hexA(I.scan_color, 0));
      x.save();
      x.globalCompositeOperation = "lighter";
      x.beginPath(); x.arc(0, 0, ri, 0, Math.PI * 2); x.clip();
      x.fillStyle = sg2;
      x.fillRect(-ri, sy - ri * 0.08, ri * 2, ri * 0.16);
      x.restore();
    }
    if (T.pupil.count > 1) {
      for (const q of this.multi) {
        x.save();
        x.translate(q.x * ri, q.y * ri);
        this._drawPupil(x, ri, 0.45);
        x.restore();
      }
    } else {
      this._drawPupil(x, ri);
    }
    if (I.cataract > 0) {
      // Milky film clouding the lens, densest in the middle.
      const cg = x.createRadialGradient(-ri * 0.15, -ri * 0.1, 0, 0, 0, ri * 1.05);
      cg.addColorStop(0, hexA(I.cataract_color, I.cataract));
      cg.addColorStop(0.7, hexA(I.cataract_color, I.cataract * 0.6));
      cg.addColorStop(1, hexA(I.cataract_color, 0));
      x.fillStyle = cg;
      x.beginPath(); x.arc(0, 0, ri * 1.05, 0, Math.PI * 2); x.fill();
    }
    x.restore();

    // Highlights (moves a little with the cornea).
    const H = T.highlight;
    if (H.alpha > 0) {
      // Highlight rides on the cornea but lags slightly toward the eye centre.
      const hx = ix - dx * 0.15 + H.x * ri, hy = iy - dy * 0.15 + H.y * ri;
      const hg = x.createRadialGradient(hx, hy, 0, hx, hy, H.size);
      hg.addColorStop(0, `rgba(255,255,255,${H.alpha})`);
      hg.addColorStop(0.5, `rgba(255,255,255,${H.alpha * 0.4})`);
      hg.addColorStop(1, "rgba(255,255,255,0)");
      x.fillStyle = hg;
      x.beginPath(); x.arc(hx, hy, H.size, 0, Math.PI * 2); x.fill();
      x.fillStyle = `rgba(255,255,255,${H.alpha * 0.6})`;
      x.beginPath(); x.arc(hx + H.size * 1.3, hy + H.size * 1.1, H.size * 0.25, 0, Math.PI * 2); x.fill();
    }
    if (H.window > 0) {
      // Reflection of a bright window: a soft, slightly skewed pane of cold light.
      const wx = ix - dx * 0.25 + H.wx * ri, wy = iy - dy * 0.25 + H.wy * ri;
      const ww = ri * H.window_size, wh = ri * H.window_size * 0.8;
      x.save();
      x.globalCompositeOperation = "lighter";
      x.translate(wx, wy);
      x.transform(1, 0, -0.18, 1, 0, 0);
      const wg = x.createLinearGradient(-ww / 2, -wh / 2, ww / 2, wh / 2);
      wg.addColorStop(0, hexA(H.window_color, H.window));
      wg.addColorStop(0.6, hexA(H.window_color, H.window * 0.55));
      wg.addColorStop(1, hexA(H.window_color, H.window * 0.15));
      x.fillStyle = wg;
      x.beginPath();
      x.roundRect ? x.roundRect(-ww / 2, -wh / 2, ww, wh, ww * 0.12) : x.rect(-ww / 2, -wh / 2, ww, wh);
      x.fill();
      x.restore();
    }
  }

  // Cephalopod chromatophores: spots of light rippling outward across the
  // iris in slow waves, like a deep-sea creature breathing.
  _drawChromatophores(x, now, ri) {
    const I = this.template.iris;
    if (!this._chroma || this._chroma.n !== I.chromatophores || this._chroma.T !== this.template) {
      const r = rng(hashString(this.template.name || "") + 101);
      const pts = [];
      for (let i = 0; i < I.chromatophores; i++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 0.95;
        pts.push([Math.cos(a) * d, Math.sin(a) * d, 0.02 + r() * 0.05, r()]);
      }
      this._chroma = { n: I.chromatophores, T: this.template, pts };
    }
    const sp = I.chroma_speed;
    x.save();
    x.globalCompositeOperation = "lighter";
    for (const [px, py, sz, ph] of this._chroma.pts) {
      const dist = Math.hypot(px, py);
      const wave = 0.5 + 0.5 * Math.sin(now * sp * 2.2 - dist * 7 + ph * 1.5);
      const a = Math.pow(wave, 3) * I.chroma_alpha;
      if (a < 0.02) continue;
      const cx = px * ri, cy = py * ri, rr = sz * ri * (0.7 + wave * 0.6);
      const gr = x.createRadialGradient(cx, cy, 0, cx, cy, rr);
      gr.addColorStop(0, hexA(I.chroma_color, a));
      gr.addColorStop(1, hexA(I.chroma_color, 0));
      x.fillStyle = gr;
      x.beginPath(); x.arc(cx, cy, rr, 0, Math.PI * 2); x.fill();
    }
    x.restore();
  }

  // Hypnotic rings: glowing rings that keep shrinking toward the pupil.
  _drawHypno(x, now, ri) {
    const I = this.template.iris;
    const n = 5;
    x.save();
    x.globalCompositeOperation = "lighter";
    x.lineWidth = ri * 0.035;
    for (let k = 0; k < n; k++) {
      const f = (k / n + now * I.hypno_speed * 0.25) % 1;   // 0 at rim -> 1 at centre
      const rr = ri * 0.95 * (1 - f) + ri * 0.12 * f;
      x.strokeStyle = hexA(I.hypno_color, I.hypno * Math.sin(f * Math.PI));
      x.beginPath(); x.arc(0, 0, rr, 0, Math.PI * 2); x.stroke();
    }
    x.restore();
  }

  // Mesmerising spiral arms rotating in the iris.
  _drawSpiral(x, now, ri) {
    const I = this.template.iris;
    const arms = Math.max(1, Math.round(I.spiral_arms));
    const rot = now * I.spiral_speed;
    x.save();
    x.globalCompositeOperation = "lighter";
    x.lineCap = "round";
    for (let a = 0; a < arms; a++) {
      x.beginPath();
      for (let i = 0; i <= 60; i++) {
        const f = i / 60;
        const rr = ri * (0.12 + 0.85 * f);
        const ang = rot + (a * Math.PI * 2) / arms + f * Math.PI * 3;
        i ? x.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr) : x.moveTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
      }
      x.strokeStyle = hexA(I.spiral_color, I.spiral);
      x.lineWidth = ri * 0.09;
      x.stroke();
    }
    x.restore();
  }

  // Brass gear rings turning in alternate directions around the pupil.
  _drawGears(x, now, ri) {
    const I = this.template.iris;
    const n = Math.round(I.gears);
    for (let k = 0; k < n; k++) {
      const r0 = ri * (0.3 + (0.6 * (k + 1)) / (n + 1));
      const teeth = 10 + k * 8;
      const rot = now * I.gear_speed * (k % 2 ? -1 : 1) / (k + 1);
      const tw = (Math.PI * 2) / teeth;
      x.beginPath();
      for (let t = 0; t < teeth; t++) {
        const a = rot + t * tw;
        const r1 = r0 + ri * 0.06;
        x.lineTo(Math.cos(a) * r0, Math.sin(a) * r0);
        x.lineTo(Math.cos(a + tw * 0.15) * r1, Math.sin(a + tw * 0.15) * r1);
        x.lineTo(Math.cos(a + tw * 0.5) * r1, Math.sin(a + tw * 0.5) * r1);
        x.lineTo(Math.cos(a + tw * 0.65) * r0, Math.sin(a + tw * 0.65) * r0);
      }
      x.closePath();
      x.strokeStyle = hexA(I.gear_color, 0.95);
      x.lineWidth = ri * 0.025;
      x.stroke();
      x.strokeStyle = hexA(I.gear_color, 0.35);
      x.lineWidth = ri * 0.012;
      x.beginPath(); x.arc(0, 0, r0 - ri * 0.04, 0, Math.PI * 2); x.stroke();
      // spokes
      for (let s = 0; s < 4 + k; s++) {
        const a = rot + (s * Math.PI * 2) / (4 + k);
        x.beginPath();
        x.moveTo(Math.cos(a) * (r0 - ri * 0.04), Math.sin(a) * (r0 - ri * 0.04));
        x.lineTo(Math.cos(a) * (r0 - ri * 0.16), Math.sin(a) * (r0 - ri * 0.16));
        x.stroke();
      }
    }
  }

  _drawLids(x, open, tex) {
    const T = this.template;
    const g = T.geometry;
    const p = g.lid_shape;
    const h = open * g.lid_open_height;
    const lower = g.lower_lid + (1 - Math.min(1, open)) * 0.05;
    const N = 48;
    const lidPts = [];
    for (let i = 0; i <= N; i++) {
      const lx = 1 - (2 * i) / N;
      lidPts.push([lx, lidY(lx, h, p)]);
    }
    const L = T.lid;

    // Shadow cast by the upper lid onto the eyeball.
    x.lineJoin = "round";
    for (const [w, a] of [[0.22, 0.18], [0.12, 0.25], [0.05, 0.3]]) {
      x.strokeStyle = `rgba(0,0,0,${a})`;
      x.lineWidth = w;
      x.beginPath();
      lidPts.forEach(([px, py], i) => (i ? x.lineTo(px, py + w * 0.3) : x.moveTo(px, py + w * 0.3)));
      x.stroke();
    }

    // Lower lid.
    x.save();
    x.beginPath();
    x.moveTo(-1, 0.01);
    for (let i = 0; i <= N; i++) {
      const lx = -1 + (2 * i) / N;
      x.lineTo(lx, lidY(lx, lower, p));
    }
    x.lineTo(1, 0.01);
    x.closePath();
    x.clip();
    x.drawImage(tex.lid, -1, -1.05, 2, 1.1);
    x.restore();
    x.strokeStyle = hexA(L.edge, 0.85);
    x.lineWidth = L.edge_width * 0.6;
    x.beginPath();
    for (let i = 0; i <= N; i++) {
      const lx = -1 + (2 * i) / N;
      i ? x.lineTo(lx, lidY(lx, lower, p)) : x.moveTo(lx, lidY(lx, lower, p));
    }
    x.stroke();

    // Upper lid skin.
    x.save();
    x.beginPath();
    x.arc(0, 0, 1.02, Math.PI, Math.PI * 2, false);
    lidPts.forEach(([px, py]) => x.lineTo(px, py));
    x.closePath();
    x.clip();
    x.drawImage(tex.lid, -1, -1.05, 2, 1.1);
    // Creases bunch up as the lid opens.
    x.strokeStyle = hexA(L.crease_color, 0.55);
    x.lineWidth = 0.012;
    for (let c = 1; c <= L.creases; c++) {
      const f = c / (L.creases + 1);
      const hc = h + (1.25 - h) * f * (0.35 + 0.65 * (1 - Math.min(1, open)));
      x.beginPath();
      for (let i = 0; i <= N; i++) {
        const lx = (1 - (2 * i) / N) * (1 - f * 0.15);
        const ly = lidY(lx, hc, p * 0.9);
        i ? x.lineTo(lx, ly) : x.moveTo(lx, ly);
      }
      x.stroke();
    }
    // Shading toward the lid edge.
    for (let i = 0; i < 3; i++) {
      x.strokeStyle = `rgba(0,0,0,${0.12})`;
      x.lineWidth = 0.05 + i * 0.05;
      x.beginPath();
      lidPts.forEach(([px, py], k) => (k ? x.lineTo(px, py - 0.02) : x.moveTo(px, py - 0.02)));
      x.stroke();
    }
    x.restore();

    // Lid edge, wet line and lashes.
    if (open > 0.03) {
      x.strokeStyle = hexA(L.wet_line, 0.55);
      x.lineWidth = L.edge_width * 0.45;
      x.beginPath();
      lidPts.forEach(([px, py], i) => (i ? x.lineTo(px, py + L.edge_width * 0.55) : x.moveTo(px, py + L.edge_width * 0.55)));
      x.stroke();
    }
    x.strokeStyle = L.edge;
    x.lineWidth = L.edge_width;
    x.lineCap = "round";
    x.beginPath();
    lidPts.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py)));
    x.stroke();
    if (L.rim_highlight_alpha > 0) {
      // Light catching the top of a thick lid rim.
      x.strokeStyle = hexA(L.rim_highlight, L.rim_highlight_alpha);
      x.lineWidth = L.edge_width * 0.28;
      x.beginPath();
      lidPts.forEach(([px, py], i) => (i ? x.lineTo(px, py - L.edge_width * 0.42) : x.moveTo(px, py - L.edge_width * 0.42)));
      x.stroke();
    }
    if (L.lashes > 0) {
      x.fillStyle = L.edge;
      for (let i = 1; i < L.lashes; i++) {
        const lx = -0.92 + (1.84 * i) / L.lashes;
        const ly = lidY(lx, h, p);
        // Lashes hang down from the lid edge and fan outward toward the corners.
        const len = L.lash_length * (0.6 + 0.4 * Math.cos(lx * 1.4)) * Math.min(1, open * 2);
        const ox = lx * 0.6 * len, oy = len;
        x.beginPath();
        x.moveTo(lx - 0.012, ly);
        x.quadraticCurveTo(lx + ox * 0.2, ly + oy * 0.6, lx + ox, ly + oy);
        x.lineTo(lx + 0.012, ly);
        x.fill();
      }
    }
  }

  _drawPupil(x, ri, scale = 1) {
    const Pp = this.template.pupil;
    const s = lerp(Pp.min, Pp.max, clamp(this.st.pupil, 0, 1)) * ri * scale;
    x.beginPath();
    if (Pp.shape === "slit") {
      const hh = ri * Pp.height * scale;
      x.moveTo(0, -hh);
      x.quadraticCurveTo(s * 2, 0, 0, hh);
      x.quadraticCurveTo(-s * 2, 0, 0, -hh);
    } else if (Pp.shape === "goat") {
      const ww = ri * Pp.height * scale;
      const r = Math.min(s, ww) * 0.9;
      x.roundRect ? x.roundRect(-ww, -s, ww * 2, s * 2, r) : x.rect(-ww, -s, ww * 2, s * 2);
    } else if (Pp.shape === "w") {
      // Cuttlefish W: flat-ish top, two rounded lower lobes, notch between.
      const ww = ri * Pp.height * scale;
      x.moveTo(-ww, -s * 0.35);
      x.quadraticCurveTo(0, -s * 1.1, ww, -s * 0.35);
      x.quadraticCurveTo(ww * 1.02, s * 0.9, ww * 0.55, s * 1.25);
      x.quadraticCurveTo(ww * 0.2, s * 1.2, 0, s * 0.1);
      x.quadraticCurveTo(-ww * 0.2, s * 1.2, -ww * 0.55, s * 1.25);
      x.quadraticCurveTo(-ww * 1.02, s * 0.9, -ww, -s * 0.35);
    } else if (Pp.shape === "aperture") {
      // Camera shutter: a polygon whose blades twist as it opens.
      const n = Math.max(3, Math.round(Pp.blades || 6));
      const rot = this.st.pupil * 1.2;
      for (let k = 0; k <= n; k++) {
        const a = rot + (k * Math.PI * 2) / n;
        k ? x.lineTo(Math.cos(a) * s, Math.sin(a) * s) : x.moveTo(Math.cos(a) * s, Math.sin(a) * s);
      }
      x.closePath();
      x.fillStyle = Pp.color;
      x.fill();
      // blade edges continuing out across the iris
      x.strokeStyle = hexA(Pp.rim_color, 0.6);
      x.lineWidth = ri * 0.012 * scale;
      for (let k = 0; k < n; k++) {
        const a = rot + (k * Math.PI * 2) / n;
        const b = a + Math.PI / 2 + 0.35;
        x.beginPath();
        x.moveTo(Math.cos(a) * s, Math.sin(a) * s);
        x.lineTo(Math.cos(a) * s + Math.cos(b) * ri * 0.55 * scale, Math.sin(a) * s + Math.sin(b) * ri * 0.55 * scale);
        x.stroke();
      }
      return;
    } else if (Pp.shape === "none") {
      return;
    } else {
      x.arc(0, 0, s, 0, Math.PI * 2);
    }
    x.closePath();
    if (Pp.rim_width > 0) {
      x.strokeStyle = hexA(Pp.rim_color, 0.7);
      x.lineWidth = Pp.rim_width * ri * 2 * scale;
      x.stroke();
    }
    x.fillStyle = Pp.color;
    x.fill();
  }

  _drawFeather(x) {
    const f = this.projection.feather || 0;
    if (f <= 0) return;
    const rg = x.createRadialGradient(0, 0, 1 - f, 0, 0, 1);
    rg.addColorStop(0, "rgba(0,0,0,0)");
    rg.addColorStop(1, "rgba(0,0,0,1)");
    x.fillStyle = rg;
    x.fillRect(-1.01, -1.01, 2.02, 1.02);
    const lg = x.createLinearGradient(0, -f, 0, 0);
    lg.addColorStop(0, "rgba(0,0,0,0)");
    lg.addColorStop(1, "rgba(0,0,0,1)");
    x.fillStyle = lg;
    x.fillRect(-1.01, -f, 2.02, f + 0.001);
  }

  _drawOutline(x, R) {
    x.save();
    x.lineWidth = 2 / R;
    x.strokeStyle = "#fff";
    this._aperture(x);
    x.stroke();
    x.strokeStyle = "rgba(255,255,255,0.5)";
    x.lineWidth = 1 / R;
    x.beginPath();
    for (let i = -3; i <= 3; i++) { x.moveTo(i / 4, 0); x.lineTo(i / 4, -1); }
    for (let j = 1; j <= 3; j++) { x.moveTo(-1, -j / 4); x.lineTo(1, -j / 4); }
    x.stroke();
    x.strokeStyle = "#f33";
    x.lineWidth = 3 / R;
    x.beginPath();
    x.moveTo(-0.08, 0); x.lineTo(0.08, 0); x.moveTo(0, 0); x.lineTo(0, -0.08);
    x.stroke();
    x.restore();
  }
}
