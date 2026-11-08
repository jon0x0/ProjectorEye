// "dragon" eye style: a photographic dragon eye set in the scaled skin of the
// head, modelled on Smaug (The Desolation of Smaug). Everything detailed is
// pre-rendered once per template/size (skin, scales, horns, iris, membrane,
// lid scale tile); each frame only composites them, so it stays cheap on a Pi.
//
// Stages driven by the renderer's "open" value (wake/sleep sequences):
//   0.00-0.35  the heavy lids part along the pointed, tilted almond
//   0.35-0.80  the grey nictitating membrane slides off toward
//              membrane_angle, revealing a dull, desaturated iris
//   0.60-1.00+ the iris warms to its glowing cast
// Blinks dip "open", so a blink is a quick membrane sweep, as in reptiles.
//
// Coordinates: window units (dome radius 1, y down, sill at y = 0). The eye
// is drawn in eye-local space: origin at the eye centre, x along the long
// axis, rotated by dragon.tilt degrees.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

function rgb(hex) {
  const h = (hex || "#000000").replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function mixHex(a, b, t) {
  const A = rgb(a), B = rgb(b);
  return `rgb(${Math.round(lerp(A[0], B[0], t))},${Math.round(lerp(A[1], B[1], t))},${Math.round(lerp(A[2], B[2], t))})`;
}
function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// Pointed eye outline in eye-local coords: an upper and a lower lid curve
// meeting in sharp corners at x = +-rx. ryU/ryL are the lid heights; the
// upper lid's peak leans back, the lower lid's forward, like a real eye.
// cont = true appends to the current path (for even-odd bands).
// sharp: exponent (>1 pointed, <1 rounded), or [front, back] to make the
// front corner (-x) pointed and the back corner (+x) rounded, like Smaug's.
export function eyePath(x, rx, ryU, ryL, sharp = 1.2, cont = false, yOff = 0) {
  if (!cont) x.beginPath();
  const N = 48;
  const [sf, sb] = Array.isArray(sharp) ? sharp : [sharp, sharp];
  const ex = (u) => lerp(sf, sb, (u + 1) / 2);
  for (let i = 0; i <= N; i++) {
    const u = -1 + (2 * i) / N;
    const px = (u + 0.14 * (1 - u * u)) * rx;
    const py = yOff - ryU * Math.pow(Math.max(0, 1 - u * u), ex(u));
    i ? x.lineTo(px, py) : x.moveTo(px, py);
  }
  for (let i = N; i >= 0; i--) {
    const u = -1 + (2 * i) / N;
    const px = (u - 0.1 * (1 - u * u)) * rx;
    const py = yOff + ryL * Math.pow(Math.max(0, 1 - u * u), ex(u));
    x.lineTo(px, py);
  }
  x.closePath();
}

const sharpOf = (D, k = 1) => [D.sharp * k, (D.sharp_back ?? D.sharp) * k];

// Where the lids meet when shut (0 = on the centre line, as in the film;
// >0 lower in the socket), and how much the corners draw in as the eye
// closes, so the opening squeezes toward its centre.
const closeOff = (D, k) => D.ry * D.lower * (D.close_at ?? 0) * (1 - k);
const rxOf = (D, k) => D.rx * (1 - (D.squeeze ?? 0.15) * (1 - k));

// Open eye (k = 0 closed .. 1 open).
function openPath(x, D, k) {
  eyePath(x, rxOf(D, k), D.ry * k, D.ry * D.lower * k, sharpOf(D), false, closeOff(D, k));
}

// ------------------------------------------------------------- textures
export function buildDragonTextures(T, R, rng, seed) {
  const D = T.dragon;
  const tex = {};
  const r = rng(seed + 501);
  const L = { lx: Math.cos((D.light * Math.PI) / 180), ly: -Math.sin((D.light * Math.PI) / 180) };
  const ta = (D.tilt * Math.PI) / 180;
  const ct = Math.cos(ta), stn = Math.sin(ta);
  const toWin = (u, v) => [D.x + u * ct - v * stn, D.y + u * stn + v * ct];

  // ---- skin of the head over the window box x [-1.05,1.05], y [-1.05,0.05]
  {
    const s = Math.min(1800 / 2.1, R * 1.25);
    const c = canvas(2.1 * s, 1.1 * s);
    const x = c.getContext("2d");
    x.setTransform(s, 0, 0, s, 1.05 * s, 1.05 * s);
    x.fillStyle = D.groove;
    x.fillRect(-1.05, -1.05, 2.1, 1.1);
    if (D.scale_layout === "plates") {
      // Scales: an irregular tessellation (Voronoi cells) whose size follows a
      // slowly varying field, so there are broad plates in some places and
      // fields of small pebbles in others, generally finer toward the eye.
      // Only the bead rows hugging the lid folds stay in neat rows.
      const meanR = Math.sqrt((D.rx * D.rx + D.ry * D.ry) / 2);
      const [uOf, vOf] = [(px, py) => (px - D.x) * ct + (py - D.y) * stn, (px, py) => -(px - D.x) * stn + (py - D.y) * ct];
      const socketDist = (px, py) => Math.hypot(uOf(px, py) / D.rx, vOf(px, py) / D.ry);
      const patch = valueNoise(rng(seed + 811), 2.3);           // big/small scale regions
      const tone = valueNoise(rng(seed + 823), 3.1);            // colour patches
      const sizeAt = (px, py) => {
        const d = socketDist(px, py);
        let s = lerp(D.scale_min * 1.6, D.scale_max, clamp((d - 1.6) / 2.6, 0, 1));
        s *= 0.35 + 1.45 * patch(px, py);
        return clamp(s, D.scale_min * 0.9, D.scale_max * 1.7);
      };
      // Variable-radius dart throwing; bucket grid for neighbour lookups.
      const cell = 0.09;
      const grid = new Map();
      const key = (gx, gy) => gx * 1000 + gy;
      const seeds = [];
      const near = (px, py, rad) => {
        const out = [];
        const g0 = Math.floor((px + 1.2) / cell), h0 = Math.floor((py + 1.2) / cell);
        const k = Math.ceil(rad / cell);
        for (let gx = g0 - k; gx <= g0 + k; gx++) for (let gy = h0 - k; gy <= h0 + k; gy++) {
          const b = grid.get(key(gx, gy));
          if (b) for (const q of b) out.push(q);
        }
        return out;
      };
      for (let i = 0; i < 26000; i++) {
        const px = r() * 2.3 - 1.15, py = -r() * 1.3 + 0.12;
        if (socketDist(px, py) < 1.62) continue;              // lid bead rows live here
        const s = sizeAt(px, py);
        let ok = true;
        for (const q of near(px, py, (s + D.scale_max * 1.7) / 2)) {
          if (Math.hypot(q.x - px, q.y - py) < 0.46 * (s + q.s)) { ok = false; break; }
        }
        if (!ok) continue;
        const q = { x: px, y: py, s };
        seeds.push(q);
        const gk = key(Math.floor((px + 1.2) / cell), Math.floor((py + 1.2) / cell));
        if (!grid.has(gk)) grid.set(gk, []);
        grid.get(gk).push(q);
      }
      // Each seed's cell: clip a box by the bisectors with its neighbours.
      for (const p of seeds) {
        const R0 = p.s * 1.3;
        let poly = [[p.x - R0, p.y - R0], [p.x + R0, p.y - R0], [p.x + R0, p.y + R0], [p.x - R0, p.y + R0]];
        for (const q of near(p.x, p.y, p.s * 1.4 + D.scale_max)) {
          if (q === p) continue;
          const nx = q.x - p.x, ny = q.y - p.y;
          if (Math.hypot(nx, ny) > (p.s + q.s) * 1.4) continue;
          const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
          poly = clipHalf(poly, mx, my, nx, ny);
          if (poly.length < 3) break;
        }
        if (poly.length < 3) continue;
        // Inset for the groove, proportionally narrower on small scales.
        const g = 0.86 + r() * 0.06;
        const pts = poly.map(([qx, qy]) => [p.x + (qx - p.x) * g, p.y + (qy - p.y) * g]);
        const t = tone(p.x, p.y) + (r() - 0.5) * 0.35;
        const base = t < 0.3 ? D.skin_dark : t < 0.55 ? D.skin : t < 0.8 ? mixHex(D.skin, D.skin_red, 0.6) : mixHex(D.skin, D.skin_light, 0.35);
        drawPlate(x, pts, p.x, p.y, p.s, base, D, L, r);
      }
      // Tight rows of small beads around the lid folds.
      const rows = [];
      let d = 1.32;
      while (d < 1.75) {
        const size = D.scale_min * (0.8 + (d - 1.32) * 1.2);
        const ru = D.rx * d, rv = D.ry * d;
        const circ = Math.PI * (3 * (ru + rv) - Math.sqrt((3 * ru + rv) * (ru + 3 * rv)));
        const n = Math.max(8, Math.floor(circ / (size * 0.95)));
        const off = r();
        for (let i = 0; i < n; i++) {
          const t = ((i + off + (r() - 0.5) * 0.4) / n) * Math.PI * 2;
          const [px, py] = toWin(ru * Math.cos(t) + (r() - 0.5) * size * 0.5, rv * Math.sin(t) + (r() - 0.5) * size * 0.5);
          if (px < -1.15 || px > 1.15 || py < -1.15 || py > 0.12) continue;
          const ang = Math.atan2(rv * Math.cos(t), -ru * Math.sin(t)) + ta;
          rows.push([px, py, size * (0.7 + r() * 0.6), ang]);
        }
        d += (size * 0.85) / meanR;
      }
      for (const [px, py, sz, ang] of rows) drawScale(x, px, py, sz, ang, D, L, r);
    } else {
      // Scales in rows that follow the socket and then the mass of the head:
      // tight small scales by the lids, growing into broad plates on the brow,
      // with jitter, size variation and occasional gaps so it isn't a lattice.
      const meanR = Math.sqrt((D.rx * D.rx + D.ry * D.ry) / 2);
      const scales = [];
      let d = 1.32;
      while (d < 9) {
        const f = clamp((d - 1.3) / 3.2, 0, 1);
        const size = lerp(D.scale_min, D.scale_max, Math.pow(f, 1.15));
        // Far rows round out from the eye's almond toward the head's shape.
        const round = clamp((d - 1.4) / 4, 0, 1);
        const ru = D.rx * d, rv = lerp(D.ry * d, D.rx * d * 0.85, round);
        const circ = Math.PI * (3 * (ru + rv) - Math.sqrt((3 * ru + rv) * (ru + 3 * rv)));
        const n = Math.max(8, Math.floor(circ / (size * 0.95)));
        const off = r();
        for (let i = 0; i < n; i++) {
          const t = ((i + off + (r() - 0.5) * 0.35) / n) * Math.PI * 2;
          const u = ru * Math.cos(t), v = rv * Math.sin(t);
          if (r() < 0.08) continue;                    // occasional gap: the groove shows
          const [px, py] = toWin(u + (r() - 0.5) * size * 0.6, v + (r() - 0.5) * size * 0.6);
          if (px < -1.15 || px > 1.15 || py < -1.15 || py > 0.12) continue;
          const ang = Math.atan2(rv * Math.cos(t), -ru * Math.sin(t)) + ta;   // along the row
          scales.push([px, py, size * (0.6 + r() * 0.8), ang + (r() - 0.5) * 0.5, d]);
        }
        d += (size * 0.82) / meanR;
      }
      // Big irregular plates over the brow and the top of the head.
      for (let i = 0; i < 40; i++) {
        const t = Math.PI * (1.05 + r() * 0.9), dd = 2.0 + r() * 2.8;
        const [px, py] = toWin(D.rx * dd * Math.cos(t), D.ry * dd * 1.6 * Math.sin(t));
        if (py > 0.1 || py < -1.15 || Math.abs(px) > 1.15) continue;
        scales.push([px, py, D.scale_max * (0.9 + r() * 0.9), r() * Math.PI, dd + 0.4]);
      }
      // Far rows first, so the small scales near the eye sit on top.
      scales.sort((a, b) => b[4] - a[4]);
      for (const [px, py, sz, ang] of scales) drawScale(x, px, py, sz, ang, D, L, r);
    }
    // Broad form lighting: the head lit from the light side, a lit brow
    // ridge over the eye, a deep socket and a shadowed hollow under it.
    x.save();
    x.translate(D.x, D.y);
    x.rotate(ta);
    const blob = (cx, cy, w, h, color, a) => {
      x.save();
      x.translate(cx, cy);
      x.scale(1, h / w);
      const g = x.createRadialGradient(0, 0, 0, 0, 0, w);
      g.addColorStop(0, rgba(color, a));
      g.addColorStop(1, rgba(color, 0));
      x.fillStyle = g;
      x.fillRect(-w, -w, w * 2, w * 2);
      x.restore();
    };
    blob(D.rx * 0.1, -D.ry * 2.05, D.rx * 1.7, D.ry * 0.95, D.skin_light, 0.22);   // brow ridge
    blob(0, D.ry * 1.9, D.rx * 1.5, D.ry * 0.8, "#000000", 0.5);                    // under-eye hollow
    blob(-D.rx * 1.25, D.ry * 0.2, D.rx * 0.5, D.ry * 0.9, "#000000", 0.35);       // front corner pit
    // Socket: darkens toward the lids.
    x.save();
    x.scale(1, D.ry / D.rx);
    const sg = x.createRadialGradient(0, 0, D.rx * 1.0, 0, 0, D.rx * 1.75);
    sg.addColorStop(0, "rgba(0,0,0,0.75)");
    sg.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = sg;
    x.beginPath(); x.arc(0, 0, D.rx * 1.75, 0, 7); x.fill();
    x.restore();
    x.restore();
    const hg = x.createLinearGradient(L.lx * 1.1, L.ly * 1.1 - 0.5, -L.lx * 1.1, -L.ly * 1.1 - 0.5);
    hg.addColorStop(0, "rgba(255,220,190,0.08)");
    hg.addColorStop(0.5, "rgba(0,0,0,0.05)");
    hg.addColorStop(1, "rgba(0,0,0,0.55)");
    x.fillStyle = hg;
    x.fillRect(-1.05, -1.05, 2.1, 1.1);
    // Horn spikes on the upper-left of the head.
    for (let i = 0; i < D.spikes; i++) {
      const f = D.spikes > 1 ? i / (D.spikes - 1) : 0.5;
      const bx = lerp(D.spike_from[0], D.spike_to[0], f) + (r() - 0.5) * 0.03;
      const by = lerp(D.spike_from[1], D.spike_to[1], f) + (r() - 0.5) * 0.03;
      drawSpike(x, bx, by, D.spike_len * (0.65 + r() * 0.55) * (1 - 0.3 * Math.abs(f - 0.5)), D.spike_dir + (r() - 0.5) * 16, D, L);
    }
    tex.skin = c;
  }

  // ---- iris (square, eye-local, radius ri)
  {
    const ri = Math.max(D.rx, D.ry) * 1.2;
    const px = Math.min(1024, ri * 2 * R * 1.3);
    const s = px / (ri * 2);
    const c = canvas(px, px);
    const x = c.getContext("2d");
    x.setTransform(s, 0, 0, s, ri * s, ri * s);
    const gr = x.createRadialGradient(0, 0, 0, 0, 0, ri);
    gr.addColorStop(0, D.iris_inner);
    gr.addColorStop(0.28, D.iris_inner);
    gr.addColorStop(0.42, D.iris_mid);
    gr.addColorStop(0.8, D.iris_outer);
    gr.addColorStop(1, D.iris_rim);
    x.fillStyle = gr;
    x.fillRect(-ri, -ri, ri * 2, ri * 2);
    // Dense radial fibres.
    x.lineCap = "round";
    for (let i = 0; i < 900; i++) {
      const a = r() * Math.PI * 2;
      const r0 = ri * (0.05 + r() * 0.35), r1 = r0 + ri * (0.08 + r() * 0.25);
      const bend = (r() - 0.5) * 0.18;
      x.strokeStyle = r() < 0.55 ? rgba(D.iris_fiber_dark, 0.12 + r() * 0.2) : rgba(D.iris_fiber_light, 0.1 + r() * 0.2);
      x.lineWidth = ri * (0.003 + r() * 0.006);
      x.beginPath();
      x.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      x.quadraticCurveTo(Math.cos(a + bend) * (r0 + r1) / 2, Math.sin(a + bend) * (r0 + r1) / 2, Math.cos(a + bend * 0.6) * r1, Math.sin(a + bend * 0.6) * r1);
      x.stroke();
    }
    // Mottled cells and fine speckles.
    for (let i = 0; i < 520; i++) {
      const a = r() * Math.PI * 2, d = ri * Math.sqrt(r());
      const cx = Math.cos(a) * d, cy = Math.sin(a) * d, sz = ri * (0.02 + r() * 0.045);
      x.beginPath();
      for (let k = 0; k < 8; k++) {
        const t = (k / 8) * Math.PI * 2, rr = sz * (0.6 + r() * 0.6);
        k ? x.lineTo(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr) : x.moveTo(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr);
      }
      x.closePath();
      x.fillStyle = rgba(D.iris_fiber_light, 0.06 + r() * 0.12);
      x.fill();
      x.strokeStyle = rgba(D.iris_fiber_dark, 0.3 + r() * 0.25);
      x.lineWidth = ri * (0.006 + r() * 0.006);
      x.stroke();
    }
    for (let i = 0; i < 6000; i++) {
      const a = r() * Math.PI * 2, d = ri * Math.sqrt(r());
      x.fillStyle = r() < 0.5 ? rgba(D.iris_fiber_dark, 0.35) : rgba(D.iris_fiber_light, 0.3);
      x.beginPath(); x.arc(Math.cos(a) * d, Math.sin(a) * d, ri * (0.002 + r() * 0.004), 0, 7); x.fill();
    }
    // Bright gold collarette around the pupil region.
    const cg = x.createRadialGradient(0, 0, ri * 0.05, 0, 0, ri * 0.45);
    cg.addColorStop(0, rgba(D.iris_glow, 0.35));
    cg.addColorStop(1, rgba(D.iris_glow, 0));
    x.fillStyle = cg;
    x.fillRect(-ri, -ri, ri * 2, ri * 2);
    tex.iris = { c, ri };
  }

  // ---- membrane (grey, faint veins and mottling), unit square
  {
    const px = 384;
    const c = canvas(px, px);
    const x = c.getContext("2d");
    x.setTransform(px, 0, 0, px, 0, 0);
    const gr = x.createLinearGradient(0, 0, 1, 1);
    gr.addColorStop(0, D.membrane_light);
    gr.addColorStop(1, D.membrane);
    x.fillStyle = gr;
    x.fillRect(0, 0, 1, 1);
    for (let i = 0; i < 260; i++) {
      x.fillStyle = rgba(r() < 0.5 ? D.membrane : D.membrane_light, 0.15 + r() * 0.25);
      const rr = 0.01 + r() * 0.05;
      x.beginPath(); x.ellipse(r(), r(), rr, rr * 0.6, r() * 3, 0, 7); x.fill();
    }
    x.lineCap = "round";
    for (let i = 0; i < 40; i++) {
      let cx = r(), cy = r(), a = r() * Math.PI * 2;
      x.strokeStyle = rgba(D.membrane_vein, 0.12 + r() * 0.15);
      x.lineWidth = 0.002 + r() * 0.003;
      x.beginPath(); x.moveTo(cx, cy);
      for (let k = 0; k < 8; k++) { a += (r() - 0.5) * 0.8; cx += Math.cos(a) * 0.03; cy += Math.sin(a) * 0.03; x.lineTo(cx, cy); }
      x.stroke();
    }
    tex.membrane = c;
  }

  // ---- scale tile used as a pattern on the heavy lids
  {
    const px = 256;
    const c = canvas(px, px);
    const x = c.getContext("2d");
    x.setTransform(px, 0, 0, px, 0, 0);
    x.fillStyle = D.groove;
    x.fillRect(0, 0, 1, 1);
    const rr = rng(seed + 777);
    const lidD = { ...D, skin: D.rim, skin_dark: D.rim_dark, skin_light: D.rim_light };
    for (let i = 0; i < 46; i++) {
      // wrap-around copies so the tile repeats seamlessly
      const qx = rr(), qy = rr(), sz = 0.13 + rr() * 0.1, ang = (rr() - 0.5) * 0.6;
      for (const ox of [-1, 0, 1]) for (const oy of [-1, 0, 1]) {
        drawScale(x, qx + ox, qy + oy, sz, ang, lidD, L, rng(i * 31 + 7));
      }
    }
    tex.rimTile = c;
  }
  return tex;
}

// Smooth 2-D value noise in [0,1] at the given frequency (window units).
function valueNoise(r, freq) {
  const N = 64;
  const tbl = new Float32Array(N * N);
  for (let i = 0; i < tbl.length; i++) tbl[i] = r();
  const at = (i, j) => tbl[(((i % N) + N) % N) * N + (((j % N) + N) % N)];
  const sm = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = (x + 4) * freq, fy = (y + 4) * freq;
    const i = Math.floor(fx), j = Math.floor(fy);
    const u = sm(fx - i), v = sm(fy - j);
    return lerp(lerp(at(i, j), at(i + 1, j), u), lerp(at(i, j + 1), at(i + 1, j + 1), u), v);
  };
}

// Keep the part of a convex polygon on the near side of the bisector
// through (mx,my) with normal (nx,ny): points where (p - m) . n <= 0.
function clipHalf(poly, mx, my, nx, ny) {
  const out = [];
  const side = ([x, y]) => (x - mx) * nx + (y - my) * ny;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const sa = side(a), sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa <= 0) !== (sb <= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

// A rounded, slightly domed plate on a polygon: groove shadow, body shaded
// toward the light, lit rim, pores, the odd crack across big plates, glint.
function drawPlate(x, pts, cx, cy, s, base, D, L, r) {
  const path = (ox = 0, oy = 0, g = 1) => {
    x.beginPath();
    const n = pts.length;
    const P = pts.map(([px, py]) => [cx + (px - cx) * g + ox, cy + (py - cy) * g + oy]);
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    let m = mid(P[n - 1], P[0]);
    x.moveTo(m[0], m[1]);
    for (let i = 0; i < n; i++) {
      const nm = mid(P[i], P[(i + 1) % n]);
      x.quadraticCurveTo(P[i][0], P[i][1], nm[0], nm[1]);   // rounded corners
    }
    x.closePath();
  };
  path(-L.lx * s * 0.06, -L.ly * s * 0.06, 1.03);
  x.fillStyle = "rgba(0,0,0,0.55)";
  x.fill();
  path();
  const gr = x.createRadialGradient(cx + L.lx * s * 0.22, cy + L.ly * s * 0.22, s * 0.03, cx, cy, s * 0.75);
  gr.addColorStop(0, mixHex(base, D.skin_light, 0.3));
  gr.addColorStop(0.5, base);
  gr.addColorStop(1, mixHex(base, "#000000", 0.5));
  x.fillStyle = gr;
  x.fill();
  x.save();
  x.clip();
  path(-L.lx * s * 0.05, -L.ly * s * 0.05);
  x.strokeStyle = rgba(D.skin_light, 0.22);
  x.lineWidth = s * 0.07;
  x.stroke();
  // Pores and pitting, more on bigger plates.
  const pores = 2 + Math.floor(s / D.scale_min * 2);
  for (let k = 0; k < pores; k++) {
    x.fillStyle = r() < 0.75 ? "rgba(0,0,0,0.3)" : rgba(D.skin_light, 0.2);
    x.beginPath(); x.arc(cx + (r() - 0.5) * s * 0.9, cy + (r() - 0.5) * s * 0.9, s * (0.012 + r() * 0.022), 0, 7); x.fill();
  }
  // A hairline crack across some of the large plates.
  if (s > D.scale_max * 0.8 && r() < 0.35) {
    const a = r() * Math.PI;
    x.strokeStyle = "rgba(0,0,0,0.45)";
    x.lineWidth = s * 0.025;
    x.beginPath();
    x.moveTo(cx - Math.cos(a) * s * 0.6, cy - Math.sin(a) * s * 0.6);
    x.quadraticCurveTo(cx + (r() - 0.5) * s * 0.3, cy + (r() - 0.5) * s * 0.3, cx + Math.cos(a) * s * 0.6, cy + Math.sin(a) * s * 0.6);
    x.stroke();
  }
  x.restore();
  if (r() < 0.3) {
    const gx = cx + L.lx * s * 0.2, gy = cy + L.ly * s * 0.2;
    const gg = x.createRadialGradient(gx, gy, 0, gx, gy, s * 0.22);
    gg.addColorStop(0, `rgba(255,236,220,${0.08 + r() * 0.14})`);
    gg.addColorStop(1, "rgba(255,236,220,0)");
    x.fillStyle = gg;
    x.beginPath(); x.arc(gx, gy, s * 0.22, 0, 7); x.fill();
  }
}

// One raised plate, elongated along its row (ang), with a dark groove
// shadow, low-contrast domed shading toward the light, pores, and a glint.
function drawScale(x, px, py, sz, ang, D, L, r) {
  const n = 5 + Math.floor(r() * 3);
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const pts = [];
  for (let k = 0; k < n; k++) {
    const t = ((k + (r() - 0.5) * 0.45) / n) * Math.PI * 2;
    const rr = 0.8 + r() * 0.3;
    const a = Math.cos(t) * sz * 0.58 * rr, b = Math.sin(t) * sz * 0.42 * rr;
    pts.push([px + a * ca - b * sa, py + a * sa + b * ca]);
  }
  const path = (ox = 0, oy = 0, g = 1) => {
    x.beginPath();
    pts.forEach(([qx, qy], i) => {
      const vx = px + (qx - px) * g + ox, vy = py + (qy - py) * g + oy;
      i ? x.lineTo(vx, vy) : x.moveTo(vx, vy);
    });
    x.closePath();
  };
  path(-L.lx * sz * 0.07, -L.ly * sz * 0.07, 1.04);
  x.fillStyle = "rgba(0,0,0,0.6)";
  x.fill();
  const tint = r();
  const base = tint < 0.3 ? D.skin_dark : tint < 0.8 ? D.skin : mixHex(D.skin, D.skin_light, 0.3);
  path();
  const gr = x.createRadialGradient(px + L.lx * sz * 0.2, py + L.ly * sz * 0.2, sz * 0.02, px, py, sz * 0.62);
  gr.addColorStop(0, mixHex(base, D.skin_light, 0.32));
  gr.addColorStop(0.5, base);
  gr.addColorStop(1, mixHex(base, "#000000", 0.5));
  x.fillStyle = gr;
  x.fill();
  // lit edge facing the light
  x.save();
  x.clip();
  path(-L.lx * sz * 0.05, -L.ly * sz * 0.05);
  x.strokeStyle = rgba(D.skin_light, 0.25);
  x.lineWidth = sz * 0.06;
  x.stroke();
  x.restore();
  for (let k = 0; k < 3; k++) {
    x.fillStyle = "rgba(0,0,0,0.28)";
    x.beginPath(); x.arc(px + (r() - 0.5) * sz * 0.6, py + (r() - 0.5) * sz * 0.45, sz * (0.02 + r() * 0.025), 0, 7); x.fill();
  }
  if (r() < 0.35) {
    const gx = px + L.lx * sz * 0.18, gy = py + L.ly * sz * 0.18;
    const gg = x.createRadialGradient(gx, gy, 0, gx, gy, sz * 0.2);
    gg.addColorStop(0, `rgba(255,236,220,${0.1 + r() * 0.16})`);
    gg.addColorStop(1, "rgba(255,236,220,0)");
    x.fillStyle = gg;
    x.beginPath(); x.arc(gx, gy, sz * 0.2, 0, 7); x.fill();
  }
}

// A smooth conical horn rising from a collar of scaly skin, curving slightly
// back, with cylindrical shading (dark edges, a lit band toward the light),
// a specular streak, a paler tip and faint growth rings near the base.
function drawSpike(x, bx, by, len, dirDeg, D, L) {
  const a = (dirDeg * Math.PI) / 180;
  const ux = Math.cos(a), uy = -Math.sin(a);                 // along the horn (y down)
  const nx = -uy, ny = ux;                                    // across it
  const w = len * 0.3;                                        // half-width at the base
  const bend = len * 0.12;                                    // curves back (toward +n)
  const tx = bx + ux * len + nx * bend, ty = by + uy * len + ny * bend;
  const midx = bx + ux * len * 0.55 + nx * bend * 0.35, midy = by + uy * len * 0.55 + ny * bend * 0.35;
  const outline = () => {
    x.beginPath();
    x.moveTo(bx - nx * w, by - ny * w);
    x.quadraticCurveTo(midx - nx * w * 0.62, midy - ny * w * 0.62, tx - nx * w * 0.08, ty - ny * w * 0.08);
    x.quadraticCurveTo(tx + ux * w * 0.12, ty + uy * w * 0.12, tx + nx * w * 0.08, ty + ny * w * 0.08);
    x.quadraticCurveTo(midx + nx * w * 0.62, midy + ny * w * 0.62, bx + nx * w, by + ny * w);
    x.closePath();
  };
  // Shadow cast onto the head, away from the light.
  x.save();
  x.translate(-L.lx * len * 0.12, -L.ly * len * 0.12 + len * 0.04);
  outline();
  x.fillStyle = "rgba(0,0,0,0.5)";
  x.fill();
  x.restore();
  // Body with cylindrical shading across its width.
  const lit = nx * L.lx + ny * L.ly > 0 ? 1 : -1;            // which side faces the light
  outline();
  const cg = x.createLinearGradient(bx - nx * w * lit, by - ny * w * lit, bx + nx * w * lit, by + ny * w * lit);
  cg.addColorStop(0, D.horn_dark);
  cg.addColorStop(0.35, D.horn);
  cg.addColorStop(0.68, D.horn_light);
  cg.addColorStop(0.85, D.horn);
  cg.addColorStop(1, D.horn_dark);
  x.fillStyle = cg;
  x.fill();
  x.save();
  x.clip();
  // Darker toward the base, paler at the tip.
  const lg = x.createLinearGradient(bx, by, tx, ty);
  lg.addColorStop(0, "rgba(0,0,0,0.45)");
  lg.addColorStop(0.45, "rgba(0,0,0,0)");
  lg.addColorStop(1, rgba(D.horn_light, 0.25));
  x.fillStyle = lg;
  x.fillRect(Math.min(bx, tx) - w * 2, Math.min(by, ty) - w * 2, Math.abs(tx - bx) + w * 4, Math.abs(ty - by) + w * 4);
  // Specular streak along the lit side.
  x.strokeStyle = "rgba(255,240,220,0.22)";
  x.lineWidth = w * 0.12;
  x.lineCap = "round";
  x.beginPath();
  x.moveTo(bx + nx * w * 0.35 * lit + ux * len * 0.15, by + ny * w * 0.35 * lit + uy * len * 0.15);
  x.quadraticCurveTo(midx + nx * w * 0.25 * lit, midy + ny * w * 0.25 * lit, tx - ux * len * 0.08 + nx * w * 0.08 * lit, ty - uy * len * 0.08 + ny * w * 0.08 * lit);
  x.stroke();
  // Faint growth rings near the base only.
  x.strokeStyle = "rgba(0,0,0,0.2)";
  x.lineWidth = len * 0.012;
  for (let k = 1; k <= 3; k++) {
    const f = k * 0.08;
    const cx = bx + ux * len * f, cy = by + uy * len * f, ww = w * (1 - f * 0.9);
    x.beginPath();
    x.moveTo(cx - nx * ww, cy - ny * ww);
    x.quadraticCurveTo(cx + ux * ww * 0.25, cy + uy * ww * 0.25, cx + nx * ww, cy + ny * ww);
    x.stroke();
  }
  x.restore();
  // Collar of skin where the horn emerges.
  x.save();
  x.translate(bx, by);
  x.rotate(-a + Math.PI / 2);
  const kg = x.createRadialGradient(0, 0, w * 0.6, 0, 0, w * 1.5);
  kg.addColorStop(0, "rgba(0,0,0,0.65)");
  kg.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = kg;
  x.beginPath(); x.ellipse(0, 0, w * 1.5, w * 0.6, 0, 0, 7); x.fill();
  x.restore();
}

// ---------------------------------------------------------------- draw
// Jagged slit pupil with sharp points, in eye-local units.
function pupilPath(x, D, width, h, seedPts) {
  const N = 48;
  const side = (sign, spikes) => {
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      const y = lerp(-h, h, f);
      const yn = y / h;
      let w = width * Math.pow(Math.max(0, 1 - yn * yn), 0.55);
      for (const [yy, amp] of spikes) w += width * amp * Math.max(0, 1 - Math.abs(yn - yy) / 0.09);
      pts.push([sign * w, y]);
    }
    return pts;
  };
  const right = side(1, seedPts.right);
  const left = side(-1, seedPts.left).reverse();
  x.beginPath();
  right.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py)));
  left.forEach(([px, py]) => x.lineTo(px, py));
  x.closePath();
}

export function drawDragon(x, eye, now, tex) {
  const T = eye.template;
  const D = T.dragon;
  const st = eye.st;
  // Stage comes from the wake/sleep "open" value (blinks excluded):
  //   0.00-0.30 lids part to D.partial, cover still over the eye
  //   0.30-0.65 the cover slides off (the iris is dull)
  //   0.65-1.00 lids open the rest of the way and the iris warms to a glow
  // Sleep runs the same stages backwards. Blinks only move the lids.
  const stage = clamp(st.open, 0, 1.2);
  const P = D.partial ?? 0.45;
  let lidK = stage < 0.3 ? lerp(0.02, P, stage / 0.3) : stage < 0.65 ? P : lerp(P, 1, Math.min(1, (stage - 0.65) / 0.35));
  const blinkF = st.open > 0.01 ? clamp(eye.effectiveOpen(now, false) / st.open, 0, 1) : 1;
  lidK = Math.max(0.02, lidK * blinkF);
  const cover = 1 - clamp((stage - 0.3) / 0.35, 0, 1);              // membrane, 1 = covering
  const glow = clamp((stage - 0.65) / 0.35, 0, 1.2);
  const ta = (D.tilt * Math.PI) / 180;
  const { rx, ry } = D;

  x.drawImage(tex.skin, -1.05, -1.05, 2.1, 1.1);

  x.save();
  x.translate(D.x, D.y);
  x.rotate(ta);

  // ---- inside the eye opening
  x.save();
  openPath(x, D, lidK);
  x.clip();
  const gx = clamp(st.gx, -1.2, 1.2), gy = clamp(st.gy, -1.2, 1.2);
  const ox = gx * D.gaze_x * rx, oy = gy * D.gaze_y * ry;
  const ri = tex.iris.ri;
  x.drawImage(tex.iris.c, ox * 0.6 - ri, oy * 0.6 - ri, ri * 2, ri * 2);
  if (glow > 0) {
    x.save();
    x.globalCompositeOperation = "lighter";
    const pulse = 0.85 + 0.15 * Math.sin(now * 1.3);
    const gg = x.createRadialGradient(ox, oy, 0, ox, oy, ri);
    gg.addColorStop(0, rgba(D.glow_color, 0.55 * glow * pulse * D.glow));
    gg.addColorStop(0.6, rgba(D.glow_color, 0.25 * glow * pulse * D.glow));
    gg.addColorStop(1, rgba(D.glow_color, 0));
    x.fillStyle = gg;
    x.fillRect(-ri * 1.2, -ri * 1.2, ri * 2.4, ri * 2.4);
    x.restore();
  }
  if (glow < 1) {
    // Dull, desaturated look while the eye is still waking.
    x.save();
    x.globalCompositeOperation = "saturation";
    x.fillStyle = `rgba(128,128,128,${(1 - glow) * 0.55})`;
    x.fillRect(-ri, -ri, ri * 2, ri * 2);
    x.restore();
    x.fillStyle = `rgba(0,0,0,${(1 - glow) * 0.3})`;
    x.fillRect(-ri, -ri, ri * 2, ri * 2);
  }
  if (!eye._dragonPupil) {
    const pr = Math.random;
    eye._dragonPupil = {
      right: [[-0.45, 0.9], [0.05, 0.55], [0.5, 0.75]].map(([y, a]) => [y + (pr() - 0.5) * 0.1, a]),
      left: [[-0.2, 0.7], [0.3, 0.85]].map(([y, a]) => [y + (pr() - 0.5) * 0.1, a]),
    };
  }
  const pw = lerp(T.pupil.min, T.pupil.max, clamp(st.pupil, 0, 1)) * ry;
  const ph = ry * D.pupil_len;
  x.save();
  x.translate(ox, oy);
  x.rotate((D.pupil_tilt * Math.PI) / 180);
  for (const [g, a] of [[1.6, 0.18], [1.25, 0.3]]) {
    x.save(); x.scale(g, 1 + (g - 1) * 0.2);
    pupilPath(x, D, pw, ph, eye._dragonPupil);
    x.fillStyle = rgba(D.iris_rim, a);
    x.fill();
    x.restore();
  }
  pupilPath(x, D, pw, ph, eye._dragonPupil);
  x.fillStyle = "#050201";
  x.fill();
  x.restore();
  // Ambient occlusion where the lids overhang the eye.
  for (const [w, a] of [[0.55, 0.22], [0.3, 0.32], [0.12, 0.45]]) {
    openPath(x, D, lidK);
    x.strokeStyle = `rgba(0,0,0,${a})`;
    x.lineWidth = ry * w;
    x.stroke();
  }
  // Nictitating membrane: grey, nearly opaque, slides off toward membrane_angle.
  if (cover > 0.001) {
    const ma = ((D.membrane_angle * Math.PI) / 180) + ta;
    const dx = Math.cos(ma), dy = -Math.sin(ma);
    const ext = Math.max(rx, ry) * 1.15;
    const e = -ext + (1 - cover) * 2 * ext;
    const ex = dx * e, ey = dy * e, px = -dy, py = dx, big = ext * 3;
    // Covered region: a big disc beyond the edge, so the edge is a curve
    // bulging back toward the uncovered side, as the real membrane does.
    const Rc = ext * 1.7;
    const ccx = ex + dx * Rc, ccy = ey + dy * Rc;
    x.save();
    x.beginPath();
    x.arc(ccx, ccy, Rc, 0, Math.PI * 2);
    x.clip();
    x.globalAlpha = D.membrane_opacity;
    x.drawImage(tex.membrane, -ext, -ext, ext * 2, ext * 2);
    x.globalAlpha = 1;
    // Domed shading so the membrane reads as a curved sheet over the eye.
    x.save();
    x.scale(1, ry / rx);
    const mg = x.createRadialGradient(-rx * 0.25, -rx * 0.35, rx * 0.1, 0, 0, rx * 1.1);
    mg.addColorStop(0, "rgba(255,255,255,0.16)");
    mg.addColorStop(0.5, "rgba(255,255,255,0.03)");
    mg.addColorStop(1, "rgba(0,0,0,0.55)");
    x.fillStyle = mg;
    x.fillRect(-rx * 1.2, -rx * 1.2, rx * 2.4, rx * 2.4);
    x.restore();
    // Thin bright rim on the leading edge, with a shadow on the eye beside it.
    x.restore();
    x.beginPath();
    x.arc(ccx, ccy, Rc + ry * 0.03, 0, Math.PI * 2);
    x.strokeStyle = "rgba(0,0,0,0.45)";
    x.lineWidth = ry * 0.07;
    x.stroke();
    x.beginPath();
    x.arc(ccx, ccy, Rc - ry * 0.015, 0, Math.PI * 2);
    x.strokeStyle = rgba(D.membrane_light, 0.75);
    x.lineWidth = ry * 0.025;
    x.stroke();
  }
  x.restore(); // end eye clip

  // ---- corneal reflections (window panes) and wet sheen
  const ra = (1 - cover * 0.25) * lidK;
  x.save();
  openPath(x, D, lidK);
  x.clip();
  for (const [qx, qy, s] of D.reflections) {
    const w = s * ry, h = s * ry * 0.85;
    const g = x.createLinearGradient(qx * rx - w / 2, qy * ry - h / 2, qx * rx + w / 2, qy * ry + h / 2);
    g.addColorStop(0, `rgba(255,252,245,${0.95 * ra})`);
    g.addColorStop(1, `rgba(220,232,255,${0.7 * ra})`);
    x.fillStyle = g;
    x.beginPath();
    x.roundRect ? x.roundRect(qx * rx - w / 2, qy * ry - h / 2, w, h, w * 0.18) : x.rect(qx * rx - w / 2, qy * ry - h / 2, w, h);
    x.fill();
  }
  const sh = x.createLinearGradient(0, -ry, 0, -ry * 0.4);
  sh.addColorStop(0, `rgba(255,255,255,${0.16 * ra})`);
  sh.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = sh;
  x.fillRect(-rx, -ry, rx * 2, ry);
  x.restore();

  // ---- heavy rolled lids: filled bands between a fixed outer fold and the
  // moving opening, scaled, shaded dark-light-dark across the roll.
  const oU = ry * (1 + D.lid_upper), oL = ry * D.lower * (1 + D.lid_lower), oX = rx * 1.12;
  const outer = () => eyePath(x, oX, oU, oL, sharpOf(D, 0.85));
  // Further folds stacked around the lids, deepest below the eye.
  for (const [gx, gu, gl, a] of [[1.1, 1.12, 1.55, 0.5], [1.2, 1.3, 2.1, 0.35]]) {
    eyePath(x, oX * gx, oU * gu, oL * gl, sharpOf(D, 0.8));
    x.strokeStyle = `rgba(0,0,0,${a})`;
    x.lineWidth = ry * 0.16;
    x.stroke();
    eyePath(x, oX * gx * 0.985, oU * gu * 0.97, oL * gl * 0.94, sharpOf(D, 0.8));
    x.strokeStyle = rgba(D.rim_light, a * 0.12);
    x.lineWidth = ry * 0.06;
    x.stroke();
  }
  outer();
  x.strokeStyle = "rgba(0,0,0,0.55)";                        // shadow the fold casts on the skin
  x.lineWidth = ry * 0.22;
  x.stroke();
  if (!eye._rimPattern || eye._rimPatternTex !== tex) {
    eye._rimPattern = x.createPattern(tex.rimTile, "repeat");
    eye._rimPatternTex = tex;
  }
  const pat = eye._rimPattern;
  if (pat.setTransform) pat.setTransform(new DOMMatrix().scale(D.rim_scale / tex.rimTile.width));
  // Build the band as one path: outer + inner, filled even-odd.
  x.beginPath();
  eyePath(x, oX, oU, oL, sharpOf(D, 0.85), true);
  eyePath(x, rxOf(D, lidK), ry * lidK, ry * D.lower * lidK, sharpOf(D), true, closeOff(D, lidK));
  x.fillStyle = pat;
  x.fill("evenodd");
  // Roll shading: dark at the opening, lit crest, darker toward the fold.
  x.save();
  x.clip("evenodd");
  x.save();
  x.scale(1, (ry * (1 + D.lid_upper * 0.5)) / oX);
  const rg = x.createRadialGradient(0, 0, rx * 0.9, 0, 0, oX * 1.05);
  rg.addColorStop(0, "rgba(0,0,0,0.7)");
  rg.addColorStop(0.35, rgba(D.rim_light, 0.28));
  rg.addColorStop(0.6, "rgba(0,0,0,0.1)");
  rg.addColorStop(1, "rgba(0,0,0,0.55)");
  x.fillStyle = rg;
  x.fillRect(-oX * 1.2, -oX * 1.2, oX * 2.4, oX * 2.4);
  x.restore();
  const lg = x.createLinearGradient(-oX * 0.6, -oU, oX * 0.6, oL);
  lg.addColorStop(0, rgba(D.rim_light, 0.18));
  lg.addColorStop(1, "rgba(0,0,0,0.45)");
  x.fillStyle = lg;
  x.fillRect(-oX * 1.2, -oU * 1.2, oX * 2.4, (oU + oL) * 1.2);
  // A crease running along the upper lid.
  eyePath(x, rx * 1.06, ry * lidK + (oU - ry * lidK) * 0.55, ry * D.lower * lidK + (oL - ry * D.lower * lidK) * 0.5, sharpOf(D), false, closeOff(D, lidK));
  x.strokeStyle = "rgba(0,0,0,0.35)";
  x.lineWidth = ry * 0.035;
  x.stroke();
  x.restore();
  // Tight dark edge and wet line at the opening.
  openPath(x, D, lidK);
  x.strokeStyle = "rgba(0,0,0,0.85)";
  x.lineWidth = ry * 0.04;
  x.stroke();
  eyePath(x, rxOf(D, lidK) * 0.985, ry * lidK * 0.97, ry * D.lower * lidK * 0.97, sharpOf(D), false, closeOff(D, lidK));
  x.strokeStyle = rgba(D.rim_wet, 0.35);
  x.lineWidth = ry * 0.014;
  x.stroke();
  // As the lids close, their rounded lips catch the light, and when shut
  // they meet in a dark crease.
  if (lidK < 0.98) {
    eyePath(x, rxOf(D, lidK) * 1.01, ry * lidK + ry * 0.06, ry * D.lower * lidK + ry * 0.05, sharpOf(D), false, closeOff(D, lidK));
    x.strokeStyle = rgba(D.rim_light, 0.14 * (1 - lidK));
    x.lineWidth = ry * 0.03;
    x.stroke();
  }
  if (lidK < 0.2) {
    eyePath(x, rxOf(D, lidK), ry * lidK, ry * D.lower * lidK, sharpOf(D), false, closeOff(D, lidK));
    x.strokeStyle = `rgba(0,0,0,${0.9 * (1 - lidK / 0.2)})`;
    x.lineWidth = ry * 0.06;
    x.stroke();
  }
  x.restore();
}
