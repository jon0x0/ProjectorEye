// Phone control UI.
import { connect } from "./link.js";
import { EyeRenderer } from "./eye-renderer.js";
import { SCHEMA, DEFAULT_TEMPLATE, mergeTemplate } from "./eye-schema.js";
import { initCameras } from "./cameras.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined) e.append(k);
  return e;
};

// ------------------------------------------------------- touch sliders
// On phones, native sliders jump to wherever a finger lands, so scrolling
// the settings changes values by accident. With a coarse pointer the slider
// ignores touches (CSS), and its row adjusts only on a deliberate sideways
// drag, relative to the current value. Vertical swipes scroll as usual.
(function touchSliders() {
  let drag = null;
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    const row = e.target.closest(".field");
    const input = row && row.querySelector('input[type="range"]');
    if (!input) return;
    drag = { row, input, x: e.clientX, y: e.clientY, id: e.pointerId, start: parseFloat(input.value), active: false };
  }, true);
  document.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }   // it's a scroll
      if (Math.abs(dx) < 14) return;
      drag.active = true;
      drag.x = e.clientX;                       // start from here: no jump
      drag.row.classList.add("adjusting");
      return;
    }
    const inp = drag.input;
    const min = parseFloat(inp.min || 0), max = parseFloat(inp.max || 100);
    const step = parseFloat(inp.step) || (max - min) / 100;
    const w = inp.getBoundingClientRect().width || 200;
    let v = drag.start + ((e.clientX - drag.x) / w) * (max - min);
    v = Math.min(max, Math.max(min, Math.round((v - min) / step) * step + min));
    if (String(v) !== inp.value) {
      inp.value = v;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, true);
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.row.classList.remove("adjusting");
    drag = null;
  };
  document.addEventListener("pointerup", end, true);
  document.addEventListener("pointercancel", end, true);
})();

let cams = null;   // motion cameras (cameras.js), set up once the helpers below exist
const S = { settings: null, eyes: [], media: [], status: null, frame: null, eye: null, editTemplate: null, eyeDirty: false };

// ------------------------------------------------------------ connection
const link = connect("ui", {
  init(m) { S.settings = m.settings; S.eyes = m.eyes; S.media = m.media; onSettings(); renderEyeList(); renderMedia(); },
  settings(m) { S.settings = m.settings; onSettings(); },
  status(m) { S.status = m; onStatus(); },
  frame(m) { S.frame = m; preview.onFrame(m); onFrame(); },
  phase(m) { preview.onPhase(m); },
  blink(m) { preview.onBlink(m); },
  media(m) { preview.onMedia(m); },
  eye(m) { S.eye = m; preview.setTemplate(m.template); if (!S.eyeDirty || !m.preview) loadEditor(m.template); renderEyeList(); },
  eyes(m) { S.eyes = m.eyes; renderEyeList(); },
  media_list(m) { S.media = m.media; renderMedia(); },
  toast(m) { toast(m.text); },
  _open() { pill("#pill-hub", "hub", "ok"); },
  _close() { pill("#pill-hub", "offline", "bad"); },
});
const send = (m) => link.send(m);
const cmd = (name, extra = {}) => send({ type: "cmd", name, ...extra });

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove("show"), 2200);
}
function pill(sel, text, cls) { const p = $(sel); p.textContent = text; p.className = "pill " + (cls || ""); }

// --------------------------------------------------------------- settings
function get(path, obj = S.settings) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setLocal(path, value) {
  const parts = path.split(".");
  let o = S.settings;
  for (const p of parts.slice(0, -1)) o = o[p] ??= {};
  o[parts.at(-1)] = value;
}
const pending = new Map();
function setSetting(path, value) {
  setLocal(path, value);
  // Throttle per path; always deliver the latest value.
  const p = pending.get(path);
  if (p) { p.value = value; return; }
  send({ type: "set", path, value });
  const entry = { value, sent: value };
  pending.set(path, entry);
  setTimeout(() => {
    pending.delete(path);
    if (entry.value !== entry.sent) send({ type: "set", path, value: entry.value });
  }, 70);
}

const bindings = [];
function field(container, f) {
  const id = "f" + Math.random().toString(36).slice(2);
  const val = el("span", { class: "val" });
  let input;
  const fmt = f.fmt || ((v) => (typeof v === "number" ? (+v.toFixed(3)).toString() : v));
  if (f.type === "toggle") {
    input = el("input", { type: "checkbox", id });
    const wrap = el("span", { class: "switch" }, input, el("span"));
    container.append(el("div", { class: "field" }, el("label", { for: id }, f.label), wrap));
    input.addEventListener("change", () => setSetting(f.path, input.checked));
    bindings.push({ path: f.path, set: (v) => (input.checked = !!v), input });
    return;
  }
  if (f.type === "select") {
    input = el("select", { id }, ...f.options.map((o) => el("option", { value: Array.isArray(o) ? o[0] : o }, Array.isArray(o) ? o[1] : o)));
    container.append(el("div", { class: "field" }, el("label", { for: id }, f.label), input));
    input.addEventListener("change", () => setSetting(f.path, input.value));
    bindings.push({ path: f.path, set: (v) => (input.value = v), input });
    return;
  }
  input = el("input", { type: "range", id, min: f.min, max: f.max, step: f.step || 0.01 });
  container.append(el("div", { class: "field" }, el("label", { for: id }, f.label, f.unit ? el("small", {}, " " + f.unit) : null), val, input));
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    val.textContent = fmt(v);
    setSetting(f.path, v);
  });
  bindings.push({ path: f.path, set: (v) => { input.value = v; val.textContent = fmt(v); }, input });
}
function fields(container, list) {
  const c = typeof container === "string" ? $(container) : container;
  for (const f of list) {
    if (typeof f === "string") c.append(el("div", { class: "group-title" }, f));
    else field(c, f);
  }
}
function refreshBindings() {
  for (const b of bindings) {
    if (document.activeElement === b.input && b.input.type === "range") continue;
    const v = get(b.path);
    if (v !== undefined) b.set(v);
  }
}

// ---------------------------------------------------------------- tabs
$$("#tabs button").forEach((b) => b.addEventListener("click", () => {
  $$("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
  $$(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + b.dataset.tab));
  try { localStorage.setItem("tab", b.dataset.tab); } catch {}
  cams?.onTab();
}));
try {
  // ?tab=calibrate opens a tab directly (handy for bookmarks); else the last one used.
  const t = new URLSearchParams(location.search).get("tab") || localStorage.getItem("tab");
  if (t) $(`#tabs button[data-tab="${t}"]`)?.click();
} catch {}

// ------------------------------------------------------------- preview
const preview = new EyeRenderer($("#preview"), { preview: true });
preview.start();

// ------------------------------------------------------------- control
const MODE_HINT = {
  auto: "One eye. Sleeps until motion, wakes, blinks, then follows the motion.",
  manual: "You drive the eye: Wake/Sleep/Blink and the gaze pad. Motion is ignored.",
  demo: "Cycles through the demo positions.",
  track: "Follows motion continuously and never sleeps. Use it to test calibration.",
  random: "Like Auto, but a different eye (from the Eyes tab list) after each sleep.",
};
const AWAKE_HINT = {
  auto: " Always awake: it never sleeps; it darts around (and scans, if on) until motion, then locks on.",
  random: " Always awake: no sleeps, so it briefly sleeps and changes eye every few minutes (set below).",
};
$$("#awake-seg button").forEach((b) => b.addEventListener("click", () => setSetting("behavior.stay_awake", b.dataset.awake === "1")));
$$("#scan-seg button").forEach((b) => b.addEventListener("click", () => setSetting("behavior.patrol_scan", b.dataset.scan === "1")));
fields("#control-mode-fields", [
  { path: "eye.random_awake_min", label: "Random + always awake: new eye every", unit: "min", min: 1, max: 60, step: 1 },
  { path: "behavior.patrol_scan_every_s", label: "Security scan about every", unit: "s", min: 5, max: 180, step: 5 },
]);
$$("#mode-seg button").forEach((b) => b.addEventListener("click", () => setSetting("mode", b.dataset.mode)));
$$("#shape-seg button").forEach((b) => b.addEventListener("click", () => {
  setSetting("projection.shape", b.dataset.shape);
  $$("#shape-seg button").forEach((x) => x.classList.toggle("on", x === b));
}));
$$("[data-cmd]").forEach((b) => b.addEventListener("click", () => cmd(b.dataset.cmd)));

fields("#control-fields", [
  { path: "sensor.enabled", label: "Motion detection", type: "toggle" },
  { path: "projection.brightness", label: "Brightness", min: 0, max: 1, step: 0.01 },
]);
{
  const c = $("#manual-fields");
  for (const [name, label, init] of [["open", "Lid open", 1], ["pupil", "Pupil size", 0.5]]) {
    const v = el("span", { class: "val" }, String(init));
    const r = el("input", { type: "range", min: 0, max: name === "open" ? 1.2 : 1, step: 0.01, value: init });
    r.addEventListener("input", () => {
      v.textContent = r.value;
      if (get("mode") !== "manual") setSetting("mode", "manual");
      cmd(name, { value: parseFloat(r.value) });
    });
    c.append(el("div", { class: "field" }, el("label", {}, label), v, r));
  }
}
fields("#demo-fields", [{ path: "demo.dwell_s", label: "Dwell per position", unit: "s", min: 0.5, max: 10, step: 0.1 }]);

let manualGaze = [0, 0.25];
function sendGaze(x, y) {
  manualGaze = [x, y];
  if (get("mode") !== "manual") setSetting("mode", "manual");
  const now = performance.now();
  if (now - (sendGaze.t || 0) > 40) { cmd("gaze", { x, y }); sendGaze.t = now; }
  else { clearTimeout(sendGaze.h); sendGaze.h = setTimeout(() => cmd("gaze", { x, y }), 45); }
}

class GazePad {
  constructor(canvas) {
    this.c = canvas;
    this.drag = false;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 2.4 - 1.2;
      const y = ((e.clientY - r.top) / r.height) * 2.4 - 1.2;
      return [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y))];
    };
    canvas.addEventListener("pointerdown", (e) => { this.drag = true; canvas.setPointerCapture(e.pointerId); sendGaze(...pos(e)); });
    canvas.addEventListener("pointermove", (e) => { if (this.drag) sendGaze(...pos(e)); });
    canvas.addEventListener("pointerup", () => (this.drag = false));
    canvas.addEventListener("pointercancel", () => (this.drag = false));
  }
  draw() {
    const c = this.c;
    const dpr = devicePixelRatio || 1;
    const w = (c.width = c.clientWidth * dpr), h = (c.height = c.clientHeight * dpr);
    if (!w) return;
    const x = c.getContext("2d");
    const P = (gx, gy) => [((gx + 1.2) / 2.4) * w, ((gy + 1.2) / 2.4) * h];
    x.clearRect(0, 0, w, h);
    x.strokeStyle = "#262a31";
    x.lineWidth = dpr;
    for (let i = -1; i <= 1; i += 0.5) {
      const [a] = P(i, 0); const [, b] = P(0, i);
      x.beginPath(); x.moveTo(a, 0); x.lineTo(a, h); x.moveTo(0, b); x.lineTo(w, b); x.stroke();
    }
    x.strokeStyle = "#454b56";
    const [x0, y0] = P(-1, -1); const [x1, y1] = P(1, 1);
    x.strokeRect(x0, y0, x1 - x0, y1 - y0);
    x.fillStyle = "#6b717d";
    x.font = `${11 * dpr}px system-ui`;
    x.fillText("up", w / 2 - 8 * dpr, 12 * dpr);
    x.fillText("down", w / 2 - 14 * dpr, h - 4 * dpr);
    x.fillText("viewer's left", 4 * dpr, h / 2 - 4 * dpr);
    const dot = (gx, gy, color, r) => { const [a, b] = P(gx, gy); x.fillStyle = color; x.beginPath(); x.arc(a, b, r * dpr, 0, 7); x.fill(); };
    for (const p of get("demo.positions") || []) dot(p.x, p.y, "#3d6b8a", 4);
    (get("calibration.points") || []).forEach((p, i) => {
      const sel = i === cams?.selectedPoint();
      dot(p.gaze[0], p.gaze[1], sel ? "#ffe14d" : "#8a5a2a", sel ? 7 : 4);
    });
    dot(manualGaze[0], manualGaze[1], "#ffb347", 7);
    if (S.frame) dot(S.frame.gaze[0], S.frame.gaze[1], "#9be15d", 5);
  }
}
const pads = [new GazePad($("#pad-control")), new GazePad($("#pad-cal"))];
cams = initCameras({ S, get, setSetting, cmd, el, $, $$, fields, refreshBindings, toast });

$("#pos-save").addEventListener("click", () => {
  const label = prompt("Name for this position?", "");
  if (label !== null) cmd("demo_save", { label });
});
function renderPositions() {
  const c = $("#positions");
  c.replaceChildren(...(get("demo.positions") || []).map((p, i) =>
    el("span", { class: "chip" },
      el("button", { class: "go", onclick: () => { manualGaze = [p.x, p.y]; sendGaze(p.x, p.y); } }, p.name),
      el("button", { onclick: () => cmd("demo_delete", { index: i }), "aria-label": "delete" }, "×"))));
}

// -------------------------------------------------------------- camera
fields("#camera-fields", [
  { path: "sensor.enabled", label: "Motion detection on", type: "toggle" },
  { path: "sensor.method", label: "Method", type: "select", options: [["mog2", "Background model (MOG2)"], ["diff", "Frame difference"]] },
  { path: "sensor.threshold", label: "Sensitivity threshold", min: 4, max: 80, step: 1, fmt: (v) => v + " (lower = more sensitive)" },
  { path: "sensor.min_area", label: "Minimum blob size", unit: "of frame", min: 0.0002, max: 0.05, step: 0.0002, fmt: (v) => (v * 100).toFixed(2) + "%" },
  { path: "sensor.max_area", label: "Ignore changes larger than", min: 0.05, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100) + "%" },
  { path: "sensor.merge_distance", label: "Merge nearby blobs", min: 0, max: 0.3, step: 0.005 },
  { path: "sensor.aim_y", label: "Aim point in box", min: 0, max: 1, step: 0.01, fmt: (v) => (v < 0.2 ? "top " : v > 0.8 ? "bottom " : "") + v.toFixed(2) },
  { path: "sensor.blur", label: "Blur", min: 1, max: 21, step: 2 },
  { path: "sensor.dilate", label: "Dilate", min: 0, max: 8, step: 1 },
  { path: "sensor.learning_rate", label: "Background learning rate", min: 0.001, max: 0.2, step: 0.001 },
  { path: "sensor.max_targets", label: "Max targets", min: 1, max: 8, step: 1 },
  { path: "sensor.detect_width", label: "Detection width", unit: "px", min: 160, max: 640, step: 32 },
  { path: "sensor.preview_fps", label: "Preview fps", min: 1, max: 15, step: 1 },
  { path: "sensor.preview_mask", label: "Show motion mask in preview", type: "toggle" },
  "Target choice",
  { path: "behavior.target_select", label: "Follow", type: "select", options: [["sticky", "Same person (sticky)"], ["largest", "Largest motion"]] },
  { path: "behavior.sticky_radius", label: "Sticky radius", min: 0.02, max: 0.6, step: 0.01 },
  { path: "behavior.track_smoothing_s", label: "Smoothing", unit: "s", min: 0, max: 1, step: 0.01 },
]);
// ----------------------------------------------------------- calibrate
$("#cal-capture").addEventListener("click", () => cmd("cal_capture", { gaze: manualGaze }));
$("#cal-track").addEventListener("click", () => setSetting("mode", "track"));
$("#cal-manual").addEventListener("click", () => { setSetting("mode", "manual"); cmd("wake"); });
$("#cal-clear").addEventListener("click", () => { if (confirm("Delete all calibration points?")) cmd("cal_clear"); });
fields("#cal-fields", [
  { path: "calibration.use_points", label: "Use captured points", type: "toggle" },
  { path: "calibration.model", label: "Fit (per camera)", type: "select", options: [["affine", "Affine (3+ points)"],
    ["homography", "Perspective (4+), camera looking down at the ground"], ["bilinear", "Bilinear (4+)"], ["quadratic", "Quadratic (6+)"]] },
  { path: "calibration.clamp", label: "Clamp to range", type: "toggle" },
  "Base mapping (used with fewer than 3 points)",
  { path: "calibration.invert_x", label: "Mirror left/right", type: "toggle" },
  { path: "calibration.invert_y", label: "Invert up/down", type: "toggle" },
  { path: "calibration.x_gain", label: "Horizontal gain", min: 0, max: 2, step: 0.01 },
  { path: "calibration.x_offset", label: "Horizontal offset", min: -1, max: 1, step: 0.01 },
  { path: "calibration.y_gain", label: "Vertical gain", min: 0, max: 2, step: 0.01 },
  { path: "calibration.y_offset", label: "Eyeline (vertical offset)", min: -1, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) + (v > 0 ? " down" : " up") },
]);
// -------------------------------------------------------------- tune
{
  const groups = [
    ["Waking", [
      { path: "behavior.wake_confirm_s", label: "Motion needed to wake", unit: "s", min: 0, max: 3, step: 0.05 },
      { path: "behavior.rewake_cooldown_s", label: "Minimum sleep time", unit: "s", min: 0, max: 30, step: 0.5 },
      { path: "behavior.wake_blinks", label: "Blinks after waking", min: 0, max: 6, step: 1 },
      { path: "behavior.wake_blink_gap_s", label: "Gap between wake blinks", unit: "s", min: 0.2, max: 2, step: 0.05 },
      { path: "behavior.wake_interrupts_sleep", label: "Motion interrupts falling asleep", type: "toggle" },
      { path: "behavior.motion_gap_s", label: "Ignore detection dropouts under", unit: "s", min: 0.05, max: 2, step: 0.05 },
    ]],
    ["Losing the target", [
      { path: "behavior.hold_s", label: "Stare at last position", unit: "s", min: 0, max: 20, step: 0.5 },
      { path: "behavior.search_s", label: "Then look around for", unit: "s", min: 0, max: 30, step: 0.5 },
      { path: "behavior.search_range_x", label: "Look-around range X", min: 0, max: 1, step: 0.01 },
      { path: "behavior.search_range_y", label: "Look-around range Y", min: 0, max: 1, step: 0.01 },
      { path: "behavior.search_glance_min_s", label: "Glance time min", unit: "s", min: 0.2, max: 4, step: 0.1 },
      { path: "behavior.search_glance_max_s", label: "Glance time max", unit: "s", min: 0.2, max: 6, step: 0.1 },
      { path: "behavior.rest_gaze_y", label: "Resting gaze height", min: -1, max: 1, step: 0.01 },
    ]],
    ["Blinking", [
      { path: "behavior.blink_min_s", label: "Random blink every min", unit: "s", min: 0.5, max: 30, step: 0.5 },
      { path: "behavior.blink_max_s", label: "Random blink every max", unit: "s", min: 0.5, max: 60, step: 0.5 },
      { path: "behavior.double_blink_chance", label: "Double-blink chance", min: 0, max: 1, step: 0.01 },
      { path: "behavior.blink_duration_s", label: "Blink duration", unit: "s", min: 0.08, max: 0.8, step: 0.01 },
      { path: "behavior.manual_blinks", label: "Random blinks in Manual", type: "toggle" },
    ]],
    ["Lid and pupil", [
      { path: "behavior.open_tracking", label: "Lid open while tracking", min: 0.2, max: 1.2, step: 0.01 },
      { path: "behavior.open_idle", label: "Lid open while idle", min: 0.2, max: 1.2, step: 0.01 },
      { path: "behavior.open_drowsy", label: "Lid open when drowsy", min: 0.1, max: 1.2, step: 0.01 },
      { path: "behavior.lid_follow", label: "Lid follows downward gaze", min: 0, max: 1, step: 0.01 },
      { path: "behavior.pupil_tracking", label: "Pupil while tracking", min: 0, max: 1, step: 0.01 },
      { path: "behavior.pupil_idle", label: "Pupil while idle", min: 0, max: 1, step: 0.01 },
    ]],
    ["Eye movement", [
      { path: "behavior.saccade_threshold", label: "Jump (saccade) threshold", min: 0, max: 1, step: 0.01 },
      { path: "behavior.saccade_speed", label: "Saccade speed", min: 2, max: 40, step: 0.5 },
      { path: "behavior.pursuit_s", label: "Smooth pursuit lag", unit: "s", min: 0.01, max: 1, step: 0.01 },
      { path: "behavior.micro_saccade", label: "Micro jitter", min: 0, max: 0.1, step: 0.001 },
    ]],
  ];
  const root = $("#tune-fields");
  groups.forEach(([title, list], i) => {
    const body = el("div");
    root.append(el("details", { class: "group", ...(i === 0 ? { open: "" } : {}) }, el("summary", {}, title), body));
    fields(body, list);
  });
}
let seqName = "wake";
$$("#seq-seg button").forEach((b) => b.addEventListener("click", () => {
  $$("#seq-seg button").forEach((x) => x.classList.toggle("on", x === b));
  seqName = b.dataset.seq;
  renderSeq(true);
}));
function renderSeq(force) {
  const ta = $("#seq-text");
  if (!force && document.activeElement === ta) return;
  const seq = get(`behavior.sequences.${seqName}`) || [];
  ta.value = "[\n" + seq.map((k) => "  " + JSON.stringify(k)).join(",\n") + "\n]";
}
$("#seq-apply").addEventListener("click", () => {
  try {
    const seq = JSON.parse($("#seq-text").value);
    if (!Array.isArray(seq) || !seq.every((k) => typeof k.t === "number")) throw new Error("need a list of {t: ...}");
    setSetting(`behavior.sequences.${seqName}`, seq);
    toast("Applied");
  } catch (e) { toast("Invalid JSON: " + e.message); }
});
$("#seq-test").addEventListener("click", () => {
  setSetting("mode", "manual");
  if (seqName === "wake") { cmd("sleep"); setTimeout(() => cmd("wake"), 200); } else cmd("sleep");
});
$("#seq-reset").addEventListener("click", () => {
  if (confirm("Reset all behavior settings (including keyframes) to defaults?")) cmd("reset", { section: "behavior" });
});
$$("[data-reset]").forEach((b) => b.addEventListener("click", () => {
  const sec = b.dataset.reset;
  if (confirm(sec ? `Reset ${sec} settings to defaults?` : "Reset ALL settings (calibration too) to defaults?")) cmd("reset", { section: sec });
}));

// --------------------------------------------------------------- eyes
function thumb(template) {
  const c = el("canvas");
  requestAnimationFrame(() => {
    const r = new EyeRenderer(c, { preview: true });
    r.setTemplate(template);
    r.forceAwake = true;
    r.onFrame({ gaze: [0.25, 0.3], open: 1, pupil: 0.45 });
    r.renderNow();
    setTimeout(() => r.renderNow(), 400);   // after any images load
  });
  return c;
}
let thumbsKey = "";
function renderEyeList() {
  const active = get("eye.template");
  const key = JSON.stringify(S.eyes.map((e) => [e.id, e.template]));
  if (key !== thumbsKey) {
    thumbsKey = key;
    $("#eye-list").replaceChildren(...S.eyes.map((e) =>
      el("button", { class: "eye-card", "data-id": e.id, onclick: () => { S.eyeDirty = false; setSetting("eye.template", e.id); } },
        thumb(e.template), el("b", {}, e.name), el("small", {}, e.description))));
  }
  $$(".eye-card").forEach((c) => c.classList.toggle("on", c.dataset.id === active));
  renderRandomPool();
  renderBootEye();
  $("#eye-edit-name").textContent = S.eyes.find((e) => e.id === active)?.name || active || "";
}

// The eye the projector starts with after a reboot.
function renderBootEye() {
  const sel = $("#boot-eye");
  const key = S.eyes.map((e) => e.id + e.name).join();
  if (renderBootEye.key !== key) {
    renderBootEye.key = key;
    sel.replaceChildren(el("option", { value: "" }, "The last eye shown"),
      ...S.eyes.map((e) => el("option", { value: e.id }, e.name)));
  }
  if (document.activeElement !== sel) sel.value = get("eye.boot_template") || "";
}
$("#boot-eye").addEventListener("change", (e) => setSetting("eye.boot_template", e.target.value));

// Random eye: which eyes take part (stored as an exclude list so new eyes join automatically).
fields("#random-fields", [
  { path: "eye.random_every", label: "Switch after every", unit: "sleeps", min: 1, max: 10, step: 1 },
  { path: "eye.random_force_min", label: "Force a new eye every", unit: "min", min: 0, max: 60, step: 1,
    fmt: (v) => (v ? v + " min, even with motion" : "off") },
  { path: "eye.switch_transition", label: "Switch now button", type: "select",
    options: [["sleep_wake", "Sleep, fade out, new eye wakes"], ["instant", "Instant"]] },
]);
function renderRandomPool() {
  const ex = new Set(get("eye.random_exclude") || []);
  const key = JSON.stringify([S.eyes.map((e) => e.id), [...ex]]);
  if (key === renderRandomPool.key) return;
  renderRandomPool.key = key;
  $("#random-pool").replaceChildren(...S.eyes.map((e) => {
    const cb = el("input", { type: "checkbox" });
    cb.checked = !ex.has(e.id);
    cb.addEventListener("change", () => {
      const set = new Set(get("eye.random_exclude") || []);
      cb.checked ? set.delete(e.id) : set.add(e.id);
      setSetting("eye.random_exclude", [...set]);
    });
    return el("label", { class: "chip pick" }, cb, " " + e.name);
  }));
}
$("#random-now").addEventListener("click", () => { S.eyeDirty = false; cmd("random_eye"); });

const eyeInputs = [];
function buildEyeEditor() {
  const root = $("#eye-editor");
  for (const [section, items] of SCHEMA) {
    const body = el("div");
    root.append(el("details", { class: "group" }, el("summary", {}, section === "Overall" ? "Overall" : section[0].toUpperCase() + section.slice(1)), body));
    for (const [key, type, min, max, step, label] of items) {
      const path = section === "Overall" ? key : `${section}.${key}`;
      const id = "e" + Math.random().toString(36).slice(2);
      const val = el("span", { class: "val" });
      let input;
      if (type === "color") input = el("input", { type: "color", id });
      else if (type === "select") input = el("select", { id }, ...step.map((o) => el("option", { value: o }, o)));
      else if (type === "text") input = el("input", { type: "text", id });
      else if (type === "number") input = el("input", { type: "number", id, min, max, step });
      else input = el("input", { type: "range", id, min, max, step });
      const isRange = type === "range";
      const reset = el("button", { class: "reset", title: "Reset to original", "aria-label": "reset " + label,
        onclick: () => resetEyeFields([path]) }, "↺");
      body.append(el("div", { class: "field" }, el("span", { class: "lab" }, el("label", { for: id }, label), reset),
        isRange ? val : input, isRange ? input : null));
      const evt = type === "select" || type === "text" ? "change" : "input";
      input.addEventListener(evt, () => {
        let v = input.value;
        if (type === "range" || type === "number") { v = parseFloat(v); val.textContent = +v.toFixed(3); }
        setTemplatePath(path, v);
      });
      eyeInputs.push({ path, input, val, type, reset });
    }
    const paths = items.map(([key]) => (section === "Overall" ? key : `${section}.${key}`));
    body.append(el("div", { class: "row" }, el("button", { onclick: () => resetEyeFields(paths) }, "Reset this section")));
  }
}
// The original values: the built-in template as shipped (or, for your own
// eyes, the last saved version), filled in with the defaults.
function originalTemplate() {
  return mergeTemplate(DEFAULT_TEMPLATE, S.original || {});
}
function resetEyeFields(paths) {
  const orig = originalTemplate();
  for (const path of paths) {
    const v = get(path, orig);
    if (v !== undefined) setTemplatePath(path, JSON.parse(JSON.stringify(v)));
  }
  refreshEyeInputs();
}
function refreshEyeInputs() {
  const full = mergeTemplate(DEFAULT_TEMPLATE, S.editTemplate || {});
  const orig = originalTemplate();
  for (const f of eyeInputs) {
    const v = get(f.path, full);
    if (v === undefined) continue;
    if (document.activeElement !== f.input) f.input.value = v;
    if (f.type === "range") f.val.textContent = +(+v).toFixed(3);
    f.reset.classList.toggle("changed", JSON.stringify(v) !== JSON.stringify(get(f.path, orig)));
  }
}
async function loadOriginal(id) {
  try {
    const r = await fetch(`/api/eyes/${encodeURIComponent(id)}/builtin`, { cache: "no-store" });
    const t = r.ok ? await r.json() : {};
    const info = S.eyes.find((e) => e.id === id);
    S.original = Object.keys(t).length ? t : (info ? info.template : S.editTemplate);
    S.originalBuiltin = Object.keys(t).length > 0;
  } catch { S.original = S.editTemplate; S.originalBuiltin = false; }
  $("#eye-restore").style.display = S.originalBuiltin ? "" : "none";
  $("#eye-delete").style.display = S.originalBuiltin ? "none" : "";
  refreshEyeInputs();
}
buildEyeEditor();
function loadEditor(template) {
  S.editTemplate = JSON.parse(JSON.stringify(template || {}));
  S.eyeDirty = false;
  $("#eye-dirty").textContent = "";
  refreshEyeInputs();
  const id = get("eye.template");
  if (id && id !== S.originalId) { S.originalId = id; loadOriginal(id); }
}
function setTemplatePath(path, v) {
  const parts = path.split(".");
  let o = S.editTemplate;
  for (const p of parts.slice(0, -1)) o = o[p] ??= {};
  o[parts.at(-1)] = v;
  S.eyeDirty = true;
  $("#eye-dirty").textContent = "(unsaved)";
  clearTimeout(setTemplatePath.h);
  setTemplatePath.h = setTimeout(() => cmd("eye_preview", { template: S.editTemplate }), 60);
  clearTimeout(setTemplatePath.m);
  setTemplatePath.m = setTimeout(refreshEyeInputs, 80);
}
async function saveEye(id) {
  const r = await fetch(`/api/eyes/${encodeURIComponent(id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(S.editTemplate) });
  if (r.ok) { S.eyeDirty = false; $("#eye-dirty").textContent = ""; toast("Saved"); } else toast("Save failed");
}
$("#eye-save").addEventListener("click", () => saveEye(get("eye.template")));
$("#eye-saveas").addEventListener("click", () => {
  const name = prompt("Name for the new eye?", (S.editTemplate.name || "eye") + " copy");
  if (!name) return;
  S.editTemplate.name = name;
  saveEye(name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""));
});
$("#eye-revert").addEventListener("click", () => { S.eyeDirty = false; cmd("eye_revert"); });
$("#eye-restore").addEventListener("click", async () => {
  const id = get("eye.template");
  if (!confirm("Restore this eye to its original settings? Your saved changes to it will be discarded.")) return;
  S.eyeDirty = false;
  const r = await fetch(`/api/eyes/${encodeURIComponent(id)}/restore`, { method: "POST" });
  toast(r.ok ? "Restored original" : "Restore failed");
});
$("#eye-delete").addEventListener("click", async () => {
  const id = get("eye.template");
  if (S.eyes.length < 2) return toast("Keep at least one eye");
  if (confirm(`Delete eye "${id}"?`)) await fetch(`/api/eyes/${encodeURIComponent(id)}`, { method: "DELETE" });
});

// -------------------------------------------------------------- media
fields("#media-fields", [
  { path: "media.enabled", label: "Play animations", type: "toggle" },
  { path: "media.random_when_asleep", label: "Randomly while asleep", type: "toggle" },
  { path: "media.asleep_interval_min_s", label: "Every (min)", unit: "s", min: 10, max: 3600, step: 10 },
  { path: "media.asleep_interval_max_s", label: "Every (max)", unit: "s", min: 10, max: 7200, step: 10 },
  { path: "media.on_motion_chance", label: "Chance on motion instead of waking", min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100) + "%" },
  { path: "media.wake_after", label: "Wake the eye afterwards if motion", type: "toggle" },
  { path: "media.image_duration_s", label: "Show still images / GIFs for", unit: "s", min: 1, max: 60, step: 1 },
  { path: "media.max_duration_s", label: "Cut videos off after", unit: "s", min: 5, max: 600, step: 5 },
  { path: "media.fit", label: "Fit", type: "select", options: [["cover", "Fill window"], ["contain", "Whole frame"]] },
  { path: "media.audio", label: "Play sound", type: "toggle" },
]);
function renderMedia() {
  const list = $("#media-list");
  if (!S.media.length) { list.replaceChildren(el("p", { class: "hint" }, "No files yet. Upload MP4/WebM video or GIF/PNG images, or copy them into the media/ folder.")); return; }
  list.replaceChildren(...S.media.map((m) => {
    const en = el("input", { type: "checkbox" });
    en.checked = m.enabled;
    const w = el("input", { type: "number", min: 0, max: 10, step: 0.5, value: m.weight, title: "weight" });
    // File names contain dots, so update the whole items map rather than a dotted path.
    const save = () => setSetting("media.items", { ...(get("media.items") || {}), [m.name]: { enabled: en.checked, weight: parseFloat(w.value) || 0 } });
    en.addEventListener("change", save);
    w.addEventListener("change", save);
    return el("div", { class: "media-item" },
      el("div", { class: "name" }, m.name, el("small", {}, (m.size / 1048576).toFixed(1) + " MB")),
      el("label", { class: "switch" }, en, el("span")), w,
      el("span", {}, el("button", { onclick: () => cmd("media_play", { item: m.name }) }, "▶"),
        el("button", { onclick: async () => { if (confirm(`Delete ${m.name}?`)) await fetch(`/api/media/${encodeURIComponent(m.name)}`, { method: "DELETE" }); } }, "×")));
  }));
}
$("#media-upload").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const fd = new FormData();
  files.forEach((f) => fd.append("file", f, f.name));
  toast("Uploading…");
  const r = await fetch("/api/media", { method: "POST", body: fd });
  toast(r.ok ? "Uploaded" : "Upload failed");
  e.target.value = "";
});
$("#media-random").addEventListener("click", () => cmd("media_play", { item: null }));
$("#media-stop").addEventListener("click", () => cmd("media_stop"));

// ---------------------------------------------------------- projector
fields("#proj-fields", [
  { path: "projection.shape", label: "Shape", type: "select", options: [["semicircle", "Semicircle window"], ["full", "Full screen (no semicircle)"]] },
  { path: "projection.full_cy", label: "Eye height (full screen)", min: 0, max: 1, step: 0.005 },
  { path: "projection.outline", label: "Show alignment outline", type: "toggle" },
  { path: "projection.cx", label: "Horizontal position", min: 0, max: 1, step: 0.001 },
  { path: "projection.cy", label: "Vertical position (flat edge)", min: 0, max: 1.2, step: 0.001 },
  { path: "projection.radius", label: "Size", min: 0.05, max: 0.6, step: 0.001 },
  { path: "projection.rotation", label: "Rotation", unit: "°", min: -20, max: 20, step: 0.1 },
  { path: "projection.flip_h", label: "Mirror (rear projection)", type: "toggle" },
  { path: "projection.flip_v", label: "Flip vertically", type: "toggle" },
  { path: "projection.feather", label: "Soft edge", min: 0, max: 0.15, step: 0.001 },
  { path: "projection.brightness", label: "Brightness", min: 0, max: 1, step: 0.01 },
  { path: "projection.render_scale", label: "Render resolution", min: 0.3, max: 1, step: 0.05, fmt: (v) => Math.round(v * 100) + "% (lower if choppy)" },
]);
let corner = "tl";
$$("#corner-seg button").forEach((b) => b.addEventListener("click", () => {
  $$("#corner-seg button").forEach((x) => x.classList.toggle("on", x === b));
  corner = b.dataset.corner;
  buildKeystoneFields();
}));
$$("[data-nudge]").forEach((b) => b.addEventListener("click", () => {
  const path = `projection.keystone.${corner}`;
  const cur = [...(get(path) || [0, 0])];
  if (b.dataset.nudge === "reset") setSetting(path, [0, 0]);
  else {
    const [dx, dy] = b.dataset.nudge.split(",").map(Number);
    setSetting(path, [+(cur[0] + dx * 0.002).toFixed(4), +(cur[1] + dy * 0.002).toFixed(4)]);
  }
  refreshBindings();
}));
function buildKeystoneFields() {
  const c = $("#keystone-fields");
  c.replaceChildren(el("p", { class: "hint" }, `${corner.toUpperCase()} offset: ${(get(`projection.keystone.${corner}`) || [0, 0]).map((v) => v.toFixed(3)).join(", ")} (fraction of screen). Turn on the outline to see it.`));
}
$("#display-url").textContent = `${location.origin}/display`;
$("#reload-display").addEventListener("click", () => { cmd("reload_display"); toast("Projector reloading"); });

// Projector output resolution (sway on the projector Pi).
async function loadOutputs() {
  try {
    const r = await (await fetch("/api/outputs", { cache: "no-store" })).json();
    const sel = $("#out-mode");
    const o = r.outputs[0];
    if (!o) { $("#out-status").textContent = r.error ? "Not available: " + r.error : "No display found."; return; }
    sel.replaceChildren(el("option", { value: "auto" }, "Auto (projector's choice)"),
      ...o.modes.map((m) => el("option", { value: m }, m.replace("@", " @ ") + " Hz")));
    const saved = (r.saved || "auto").replace(/Hz$/, "");
    sel.value = o.modes.includes(saved) ? saved : "auto";
    $("#out-status").textContent = `${o.make} ${o.model}: now ${o.current.replace("@", " @ ")} Hz`;
  } catch { $("#out-status").textContent = "Could not read the projector modes."; }
}
$("#out-mode").addEventListener("change", async (e) => {
  $("#out-status").textContent = "Switching...";
  const r = await fetch("/api/outputs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: e.target.value }) });
  toast(r.ok ? "Projector resolution changed" : "Could not change resolution");
  setTimeout(loadOutputs, 1500);
});
loadOutputs();
$("#settings-import").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    toast(r.ok ? "Imported" : "Import failed");
  } catch { toast("Not a valid settings file"); }
  e.target.value = "";
});

// ------------------------------------------------------------- updates
function onSettings() {
  preview.setBehavior(S.settings.behavior);
  refreshBindings();
  const mode = get("mode");
  $$("#mode-seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  const shape = get("projection.shape") || "semicircle";
  $$("#shape-seg button").forEach((b) => b.classList.toggle("on", b.dataset.shape === shape));
  const awake = !!get("behavior.stay_awake");
  const motionMode = mode === "auto" || mode === "random";
  $$("#awake-seg button").forEach((b) => b.classList.toggle("on", (b.dataset.awake === "1") === awake));
  $$("#scan-seg button").forEach((b) => b.classList.toggle("on", (b.dataset.scan === "1") === !!get("behavior.patrol_scan")));
  $("#awake-seg").style.display = motionMode ? "" : "none";
  $("#scan-seg").style.display = motionMode && awake ? "" : "none";
  const cmf = $("#control-mode-fields").children;
  if (cmf[0]) cmf[0].style.display = mode === "random" && awake ? "" : "none";
  if (cmf[1]) cmf[1].style.display = motionMode && awake && get("behavior.patrol_scan") ? "" : "none";
  $("#mode-hint").textContent = (MODE_HINT[mode] || "") + (motionMode && awake ? AWAKE_HINT[mode] : "");
  renderPositions();
  cams.onSettings();
  renderSeq(false);
  renderEyeList();
  buildKeystoneFields();
}
function onStatus() {
  const s = S.status;
  const sen = s.sensor;
  pill("#pill-sensor", sen.connected ? `camera ${sen.fps ? sen.fps.toFixed(0) + " fps" : ""}` : "no camera", sen.connected ? "ok" : "bad");
  pill("#pill-display", s.displays ? "projector" : "no projector", s.displays ? "ok" : "bad");
  if (s.pi) {
    // Projector Pi health: red for power problems, amber when hot or throttled.
    const p = s.pi;
    const power = p.now.includes("under-voltage") || p.since_boot.includes("under-voltage");
    const hot = p.temp >= 75 || p.now.length > 0;
    const note = power ? " low power!" : p.since_boot.length ? " (" + p.since_boot.join(", ") + ")" : "";
    $("#pill-pi").style.display = "";
    pill("#pill-pi", `pi ${Math.round(p.temp)}\u00b0C${note}`, power ? "bad" : hot ? "warn" : "ok");
    $("#pill-pi").title = `throttled ${p.throttled}; now: ${p.now.join(", ") || "none"}; since boot: ${p.since_boot.join(", ") || "none"}`;
  }
  cams.onStatus();
}
function onFrame() {
  const f = S.frame;
  const label = f.phase === "awake" ? f.sub || "awake" : f.phase;
  pill("#pill-phase", label + (f.media ? `: ${f.media}` : ""), f.phase === "asleep" ? "" : f.motion ? "ok" : "warn");
  cams.onFrame();
}
function animate() {
  const active = $(".tab.on")?.id;
  if (active === "tab-control") pads[0].draw();
  if (active === "tab-calibrate") pads[1].draw();
  cams.draw(active);
  requestAnimationFrame(animate);
}
animate();
