// Shader eyeballs, rendered by WebGL fragment shaders into one shared
// offscreen canvas that the 2D renderer then draws inside the window. One GL
// context is shared by every renderer on a page (projector, preview,
// thumbnails) to stay under the browser's context limit.
//
// Styles:
//   fire   - lidless eye of shimmering flame
//   void   - pitch-black eye: oily iridescent sheen, smoke behind the
//            surface, a pulsing pinprick "dying star"
//   sauron - film-style lidless eye: feathery curling flame tongues, smouldering
//            red core, soft dark oval pupil, dark-red haze
//   nebula - indigo space, rotating galaxy iris, black-hole pupil with a
//            photon ring and occasional flares
// Cost is roughly pixels x octaves: each style's quality setting scales the
// offscreen resolution and octaves the noise detail.

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

const NOISE = `
// Precision-safe hash (Dave Hoskins' hash12): small multipliers, so large
// coordinates don't collapse to constant values on GPUs with float32.
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < OCTAVES; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
`;

const FIRE = `
uniform vec2 uRes;
uniform vec4 uBox;        // x0, y0, w, h in window units (y down)
uniform float uTime;
uniform vec2 uCenter;
uniform float uRadius, uOpen, uPupilW, uSlitH, uBright, uTurb, uReach, uFibers, uRim, uBg, uAspect, uSeed, uSlitGlow, uWisps, uCoreDark;
uniform vec3 cCore, cHot, cMid, cDark, cBack;
` + NOISE + `
vec3 ramp(float v) {
  v = clamp(v, 0.0, 1.0);
  vec3 c = mix(vec3(0.0), cDark, smoothstep(0.0, 0.25, v));
  c = mix(c, cMid, smoothstep(0.2, 0.5, v));
  c = mix(c, cHot, smoothstep(0.45, 0.75, v));
  return mix(c, cCore, smoothstep(0.75, 1.0, v));
}

void main() {
  vec2 frag = gl_FragCoord.xy / uRes;
  vec2 uv = vec2(uBox.x + frag.x * uBox.z, uBox.y + (1.0 - frag.y) * uBox.w);
  float t = uTime;
  vec2 p = uv - uCenter;
  p.y /= uAspect;
  float r = length(p);
  vec2 dir = p / max(r, 1e-4);
  float R = uRadius * mix(0.12, 1.0, uOpen);

  // Swirling fire around the eye (domain-warped noise rising upward).
  vec2 q = uv * 2.2 + vec2(0.0, t * 0.25);
  vec2 w = vec2(fbm(q + vec2(uSeed, t * 0.3)), fbm(q + vec2(5.2, 1.3) - t * 0.2));
  float bg = fbm(uv * 3.0 + w * 2.0 * uTurb + vec2(0.0, t * 0.6));

  // Ragged flaming edge of the iris, licking outward.
  float ang = fbm(dir * 4.0 + vec2(uSeed) + vec2(t * 0.15, -t * 0.1));
  float edge = R * (1.0 + uReach * 0.7 * (ang - 0.5));
  float glow = exp(-max(r - edge, 0.0) * 6.0 / (0.3 + uReach));
  float bgv = (bg * 1.25 - 0.1) * (0.5 + 0.7 * glow) * uBg * mix(0.3, 1.0, uOpen) + glow * 0.35 * uOpen;

  // Fibrous iris: angular detail (seamless around the circle) flowing radially.
  float fib = fbm(dir * 9.0 * uFibers + vec2(r * 4.0 - t * 0.8, uSeed));
  float fib2 = noise(dir * 22.0 * uFibers + vec2(r * 2.0 - t * 0.5, 0.0));
  float rn = r / max(edge, 1e-3);
  float irisv = mix(0.12, 0.85, clamp(fib * fib * 1.4, 0.0, 1.0)) + 0.12 * fib2;
  irisv *= 0.65 + 0.5 * smoothstep(0.55, 1.0, rn) * uRim;
  // Darker, smouldering red toward the pupil.
  irisv *= mix(1.0, 0.3 + 0.7 * smoothstep(0.05, 0.6, rn), uCoreDark);
  float inIris = 1.0 - smoothstep(0.85, 1.05, rn);
  // Bright burning ring where the iris meets the surrounding fire.
  float ring = exp(-pow((rn - 0.95) * 3.5, 2.0)) * uRim * 0.35 * uOpen;
  float v = mix(bgv, irisv, inIris) + ring;
  // Long wispy flame strands feathering out into the dark.
  float wisp = smoothstep(0.42, 0.85, fbm(dir * 11.0 + vec2(r * 3.0 - t * 0.7, uSeed * 1.7)));
  v += (1.0 - inIris) * glow * wisp * uWisps;

  // Slit pupil: black inside, white-hot rim, fiery halo along its sides.
  vec2 s = uv - uCenter;
  float h = uSlitH * R;
  float yy = clamp(s.y / max(h, 1e-3), -1.0, 1.0);
  float taper = 1.0 - yy * yy;
  float wdt = uPupilW * R * taper + 0.002;
  float wob = (noise(vec2(s.y * 30.0, t * 3.0)) - 0.5) * 0.12 * wdt;
  float ax = abs(s.x + wob);
  float dx = ax / wdt;
  float along = step(abs(s.y), h);
  float inside = along * (1.0 - smoothstep(0.8, 1.0, dx));
  float rim = step(abs(s.y), h * 1.03) * exp(-pow((dx - 1.0) * 1.8, 2.0));
  float halo = exp(-max(ax - wdt, 0.0) / (0.14 * R)) * sqrt(taper) * step(abs(s.y), h);
  v += halo * 0.4 * uSlitGlow * inIris;

  vec3 col = ramp(v) + cBack * (1.0 - inIris) * 0.6;
  col = mix(col, vec3(0.01, 0.0, 0.0), inside * inIris);
  col += cDark * inside * inIris * 0.5 * noise(vec2(s.y * 12.0, t * 2.0));
  col += mix(cHot, cCore, 0.6) * rim * uSlitGlow * inIris;
  gl_FragColor = vec4(col * uBright, 1.0);
}
`;

const VOID = `
uniform vec2 uRes;
uniform vec4 uBox;
uniform float uTime, uBright, uStar, uPulse, uSmoke, uSheen, uIrid, uBallR, uParallax;
uniform vec2 uCenter, uBall;
uniform vec3 cSmoke, cSheen, cStar, cBase;
` + NOISE + `
void main() {
  vec2 frag = gl_FragCoord.xy / uRes;
  vec2 uv = vec2(uBox.x + frag.x * uBox.z, uBox.y + (1.0 - frag.y) * uBox.w);
  float t = uTime;
  vec2 b = uv - uBall;
  float rb = length(b) / uBallR;
  vec2 look = uCenter - uBall;

  // Smoke drifting *behind* the glossy surface: it shifts less with gaze.
  vec2 q = (uv - look * uParallax) * 2.4;
  vec2 w = vec2(fbm(q + vec2(0.0, t * 0.05)), fbm(q * 1.3 + vec2(3.1, -t * 0.04)));
  float sm = fbm(q + w * 1.6 + vec2(t * 0.02, t * 0.035));
  float wisps = smoothstep(0.5, 0.85, sm) * uSmoke;
  vec3 col = cBase + cSmoke * wisps;

  // Pinprick "dying star" at the centre of gaze, slowly swelling and fading.
  float d = length(uv - uCenter);
  float pulse = 0.5 + 0.5 * sin(t * uPulse);
  float sr = max(uStar * (0.45 + 0.55 * pulse), 1e-4);
  float core = exp(-pow(d / sr, 2.0) * 2.5);
  float halo = exp(-d / (sr * 7.0)) * 0.3 * (0.4 + 0.6 * pulse);
  col += cStar * (core + halo);

  // Wet, oily surface: a soft specular that slides with the eye, plus an
  // iridescent thin-film sheen toward the rim.
  vec2 hp = uBall + vec2(-0.3, -0.18) * uBallR + look * 0.3;
  float spec = exp(-pow(length((uv - hp) * vec2(1.0, 1.7)) / (0.11 * uBallR), 2.0));
  float ang = atan(b.y, b.x);
  vec3 irid = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + rb * 1.4 + ang * 0.25 + t * 0.03));
  float film = smoothstep(0.35, 1.0, rb) * (0.5 + 0.5 * fbm(b * 5.0 + t * 0.08));
  col += cSheen * spec * uSheen + irid * film * uIrid * 0.35;
  col *= 1.0 - smoothstep(1.0, 1.2, rb) * 0.8;
  gl_FragColor = vec4(col * uBright, 1.0);
}
`;

const NEBULA = `
uniform vec2 uRes;
uniform vec4 uBox;
uniform float uTime, uBright, uRadius, uHole, uSpin, uArms, uDust, uStars, uFlare, uSeed;
uniform vec2 uCenter;
uniform vec3 cDeep, cDust, cCore, cRing, cStar;
` + NOISE + `
void main() {
  vec2 frag = gl_FragCoord.xy / uRes;
  vec2 uv = vec2(uBox.x + frag.x * uBox.z, uBox.y + (1.0 - frag.y) * uBox.w);
  float t = uTime;
  vec2 p = uv - uCenter;
  float r = length(p);
  float a = atan(p.y, p.x);

  // Deep space with faint drifting dust.
  vec3 col = cDeep * (0.35 + 0.65 * fbm(uv * 1.8 + vec2(uSeed, t * 0.01)));
  col += cDust * 0.25 * smoothstep(0.55, 0.9, fbm(uv * 3.0 - vec2(t * 0.015, 0.0)));

  // Twinkling star field.
  vec2 g = uv * 55.0;
  vec2 id = floor(g);
  vec2 f = fract(g) - 0.5;
  float h = hash(id + uSeed);
  float star = step(1.0 - 0.025 * uStars, h) * exp(-dot(f, f) * 30.0) * (0.55 + 0.45 * sin(t * 2.5 + h * 60.0));
  col += cStar * star;

  // Galaxy disc in the iris: differential rotation, spiral arms of dust.
  float rn = r / uRadius;
  float rot = t * uSpin / (0.25 + rn);
  float spiral = a - rot + log(max(rn, 0.02)) * 1.1;
  float arms = 0.5 + 0.5 * cos(spiral * uArms);
  vec2 sp = vec2(cos(a - rot), sin(a - rot)) * rn * 3.0;
  float dust = fbm(sp * 2.2 + vec2(uSeed));
  float disc = exp(-rn * rn * 2.2);
  float gal = disc * (0.25 + 0.75 * arms * dust) * uDust;
  col += mix(cDust, cCore, exp(-rn * 2.5)) * gal * 1.6;

  // Supermassive black hole pupil: photon ring, lensing glow, solar flares.
  float hr = max(uHole, 1e-3);
  float ring = exp(-pow((r - hr * 1.2) / (hr * 0.16), 2.0));
  float glow = exp(-max(r - hr, 0.0) / (hr * 1.2)) * 0.35;
  float id2 = floor(t * 0.35);
  float ph = fract(t * 0.35);
  float fa = hash(vec2(id2, 3.7)) * 6.2831;
  float on = step(0.45, hash(vec2(id2, 9.1))) * uFlare;
  float da = abs(atan(sin(a - fa), cos(a - fa)));
  float flare = on * exp(-da * da * 30.0) * exp(-max(r - hr, 0.0) / (hr * (0.4 + ph * 2.5))) * sin(ph * 3.14159);
  col += cRing * (ring * 1.6 + glow + flare * 1.8);
  col *= smoothstep(hr * 0.92, hr * 1.04, r);
  gl_FragColor = vec4(col * uBright, 1.0);
}
`;

const SAURON = `
uniform vec2 uRes;
uniform vec4 uBox;
uniform float uTime, uBright, uRadius, uOpen, uPupilW, uSlitH, uReach, uAspect, uSeed, uWisp, uHalo, uInnerRed, uFeather, uBase;
uniform vec2 uCenter;
uniform vec3 cCore, cHot, cMid, cDark, cHaloC;
` + NOISE + `
vec3 ramp(float v) {
  v = clamp(v, 0.0, 1.2);
  vec3 c = mix(vec3(0.0), cDark, smoothstep(0.0, 0.2, v));
  c = mix(c, cMid, smoothstep(0.15, 0.45, v));
  c = mix(c, cHot, smoothstep(0.4, 0.75, v));
  return mix(c, cCore, smoothstep(0.75, 1.1, v));
}

void main() {
  vec2 frag = gl_FragCoord.xy / uRes;
  vec2 uv = vec2(uBox.x + frag.x * uBox.z, uBox.y + (1.0 - frag.y) * uBox.w);
  float t = uTime;
  vec2 p = uv - uCenter;
  p.x /= uAspect;                                 // > 1: wider than tall
  float r = length(p);
  vec2 dir = p / max(r, 1e-4);
  float R = uRadius * mix(0.15, 1.0, uOpen);
  float rn = r / max(R, 1e-3);

  // Curling domain warp so the tongues bend and lick rather than radiate.
  vec2 w = vec2(fbm(p * 4.0 + vec2(t * 0.9, uSeed)), fbm(p * 4.0 + vec2(5.2, -t * 0.8)));
  // Feathery tongues streaming outward, at two scales.
  float tongues = fbm(dir * 5.0 + w * 0.9 + vec2(r * 5.0 - t * 1.6, uSeed));
  float fine = fbm(dir * 13.0 * uFeather + w * 1.5 + vec2(r * 9.0 - t * 2.4, 3.0));
  float flame = tongues * 0.65 + fine * 0.45;

  // Solid burning band; tongues reach out by a noisy amount.
  float reach = uBase + uReach * (flame - 0.35) * 1.4;     // uBase: flame base radius
  float body = 1.0 - smoothstep(reach * 0.55, reach * 1.05, rn);
  float v = body * (0.18 + 0.85 * flame * flame * 1.4);
  // Smouldering red toward the pupil.
  v *= mix(1.0, 0.3 + 0.7 * smoothstep(0.1, 0.6, rn), uInnerRed);
  // Wisps feathering off into the dark.
  float wisp = smoothstep(0.5, 0.9, fine) * exp(-max(rn - reach, 0.0) * 3.0) * (1.0 - body) * uWisp;
  v += wisp * 0.6;

  // Soft dark oval pupil with a deep red rim.
  vec2 s = uv - uCenter;
  float h = uSlitH * R;
  float yy = clamp(s.y / max(h, 1e-3), -1.0, 1.0);
  float wdt = uPupilW * R * sqrt(max(0.0, 1.0 - yy * yy)) + 0.002;
  float wob = (fbm(vec2(s.y * 12.0, t * 1.5)) - 0.5) * 0.35 * wdt;
  float dx = abs(s.x + wob) / wdt;
  float along = 1.0 - smoothstep(h * 0.92, h * 1.05, abs(s.y));
  float inside = along * (1.0 - smoothstep(0.7, 1.15, dx));
  float rim = along * exp(-pow(max(dx - 0.8, 0.0) * 1.4, 2.0)) * (1.0 - inside);

  vec3 col = ramp(v);
  col = mix(col, cDark * 0.7, clamp(rim * 0.7, 0.0, 1.0) * body);
  col = mix(col, vec3(0.025, 0.0, 0.0), inside);
  // Faint dark-red haze around the whole eye.
  col += cHaloC * exp(-rn * 1.5) * uHalo * (0.6 + 0.4 * fbm(uv * 2.0 + vec2(0.0, t * 0.2)));
  gl_FragColor = vec4(col * uBright, 1.0);
}
`;

const SOURCES = { fire: FIRE, void: VOID, nebula: NEBULA, sauron: SAURON };

export const SHADER_STYLES = Object.keys(SOURCES);

function hexRgb(hex) {
  const h = (hex || "#000000").replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

class ShaderGL {
  constructor() {
    this.canvas = document.createElement("canvas");
    const opts = { alpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: "high-performance" };
    this.gl = this.canvas.getContext("webgl", opts) || this.canvas.getContext("experimental-webgl", opts);
    this.programs = {};
    this.ok = !!this.gl;
    if (!this.ok) return;
    const gl = this.gl;
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  }

  program(style, octaves) {
    const key = style + octaves;
    if (this.programs[key]) return this.programs[key];
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(style + ": " + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, `#define OCTAVES ${octaves}\n` + PRECISION + SOURCES[style]));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    this.programs[key] = { p, u, aPos: gl.getAttribLocation(p, "aPos") };
    return this.programs[key];
  }

  // uniforms: {name: number | [x,y] | [x,y,z] | [x,y,z,w] | "#rrggbb"}
  render(style, uniforms, w, h, octaves) {
    const gl = this.gl;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    const prog = this.program(style, Math.max(2, Math.min(7, Math.round(octaves || 5))));
    gl.useProgram(prog.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(prog.aPos);
    gl.vertexAttribPointer(prog.aPos, 2, gl.FLOAT, false, 0, 0);
    const all = { uRes: [w, h], ...uniforms };
    for (const [name, v] of Object.entries(all)) {
      const loc = prog.u[name];
      if (!loc) continue;
      if (typeof v === "string") gl.uniform3fv(loc, hexRgb(v));
      else if (typeof v === "number") gl.uniform1f(loc, v);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
      else if (v.length === 4) gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return this.canvas;
  }
}

let shared = null;
const failed = new Set();

// Returns a canvas holding the rendered eyeball, or null without WebGL.
export function renderShader(style, uniforms, w, h, octaves) {
  if (failed.has(style) || !SOURCES[style]) return null;
  try {
    if (!shared) shared = new ShaderGL();
    if (!shared.ok) { failed.add(style); return null; }
    return shared.render(style, uniforms, w, h, octaves);
  } catch (e) {
    console.error("eye shader:", e);
    failed.add(style);
    return null;
  }
}
