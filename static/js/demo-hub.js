// In-browser stand-in for the hub, so the phone UI runs with no Pi (GitHub
// Pages, or any page opened with ?demo). It loads the default settings and the
// built-in eyes from demo/data.json (tools/build_demo_data.py) and drives the
// preview with a simple version of the hub's behaviour: darts, an occasional
// scan, blinks, and tracking of the pointer over the eye preview in place of
// a camera. Nothing is saved; cameras, media and eye saving need the Pi.

const DATA_URL = new URL("../demo/data.json", import.meta.url);
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function isDemo() {
  return location.hostname.endsWith("github.io") || new URLSearchParams(location.search).has("demo")
    || location.protocol === "file:";
}

export function demoLink(role, handlers) {
  const emit = (m) => { const h = handlers[m.type]; if (h) h(m); };
  let defaults = null, settings = null, eyes = [];
  let phase = "asleep", gaze = [0, 0.25], open = 1, pupil = 0.55, manual = [0, 0.25];
  let nextDart = 0, nextBlink = 0, scan = null, nextScan = 0, demoI = 0, nextDemo = 0;
  let pointer = null;                    // {x, y, t} in gaze space
  const preview = () => document.getElementById("preview");

  const get = (path, o = settings) => path.split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
  function set(path, value) {
    const parts = path.split(".");
    let o = settings;
    for (const p of parts.slice(0, -1)) o = o[p] ??= {};
    o[parts.at(-1)] = value;
  }
  const template = (id) => (eyes.find((e) => e.id === id) || eyes[0] || {}).template;
  const sendEye = (t, prev = false) => emit({ type: "eye", id: get("eye.template"), template: t || template(get("eye.template")), preview: prev });
  const toast = (text) => emit({ type: "toast", text });
  function setPhase(p) { phase = p; emit({ type: "phase", phase: p }); }

  // Pointer over the preview = a person in front of the camera.
  function onPointer(e) {
    const c = preview();
    if (!c) return;
    const r = c.getBoundingClientRect();
    if (!r.width || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    pointer = { x: clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1),
                y: clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1), t: performance.now() / 1000 };
  }
  addEventListener("pointermove", onPointer);
  addEventListener("pointerdown", onPointer);

  function receive(m) {
    if (!settings) return;
    if (m.type === "set") {
      set(m.path, m.value);
      emit({ type: "settings", settings });
      if (m.path === "eye.template") sendEye();
      if (m.path === "mode" && m.value !== "manual" && phase === "asleep") setPhase("awake");
      return;
    }
    if (m.type !== "cmd") return;
    const now = performance.now() / 1000;
    switch (m.name) {
      case "wake": setPhase("awake"); break;
      case "sleep": setPhase("asleep"); break;
      case "blink": emit({ type: "blink", duration: 0.2 }); break;
      case "gaze": manual = [m.x, m.y]; break;
      case "open": open = m.value; break;
      case "pupil": pupil = m.value; break;
      case "eye_preview": sendEye(m.template, true); break;
      case "eye_revert": sendEye(); break;
      case "random_eye": {
        const ex = new Set(get("eye.random_exclude") || []);
        const pool = eyes.filter((e) => !ex.has(e.id) && e.id !== get("eye.template"));
        const pick = pool[Math.floor(Math.random() * pool.length)];
        if (pick) { set("eye.template", pick.id); emit({ type: "settings", settings }); sendEye(); toast(pick.name); }
        break;
      }
      case "reset":
        if (m.section) settings[m.section] = structuredClone(defaults[m.section]);
        else settings = structuredClone(defaults);
        emit({ type: "settings", settings });
        sendEye();
        break;
      default:
        toast("Demo: this needs the Pi");
    }
    nextDart = Math.min(nextDart, now + 0.5);
  }

  // The hub's frame loop, much simplified.
  function tick() {
    const now = performance.now() / 1000;
    const mode = get("mode");
    const b = settings.behavior || {};
    let sub = "", motion = false, target = null;
    open = mode === "manual" ? open : 1;
    if (phase === "awake") {
      const seen = pointer && now - pointer.t < 1.5 && mode !== "manual" && mode !== "demo";
      if (mode === "manual") {
        gaze = manual;
      } else if (mode === "demo") {
        const pos = get("demo.positions") || [];
        if (pos.length && now >= nextDemo) {
          const p = pos[demoI++ % pos.length];
          gaze = [p.x, p.y];
          nextDemo = now + (get("demo.dwell_s") || 2.5);
        }
      } else if (seen) {
        sub = "tracking"; motion = true;
        target = [pointer.x, pointer.y];
        gaze = target;
        scan = null;
      } else if (scan) {
        sub = "scanning";
        const k = (now - scan.t0) / scan.dur;
        if (k >= 1) { scan = null; nextDart = now + rnd(0.5, 1.5); }
        else gaze = [Math.sin(k * Math.PI * 2 + scan.ph) * 0.85, 0.3];
      } else {
        sub = "patrolling";
        if (now >= nextDart) {
          gaze = [rnd(-0.8, 0.8), rnd(-0.2, 0.6)];
          nextDart = now + rnd(b.patrol_dart_min_s || 1.2, b.patrol_dart_max_s || 4);
        }
        if (b.patrol_scan !== false && now >= nextScan) {
          if (nextScan) scan = { t0: now, dur: b.patrol_scan_s || 5, ph: Math.asin(clamp(gaze[0] / 0.85, -1, 1)) };
          nextScan = now + (b.patrol_scan_every_s || 30) * rnd(0.6, 1.4);
        }
      }
      if (now >= nextBlink) {
        if (nextBlink) emit({ type: "blink", duration: 0.2 });
        nextBlink = now + rnd(2.5, 7);
      }
    }
    const p = mode === "manual" ? pupil : motion ? 0.35 : 0.55;
    emit({ type: "frame", phase, sub, mode, gaze, open, pupil: p, target, src: null, motion, targets: target ? [{ x: target[0], y: target[1], cam: null }] : [] });
  }

  const status = () => emit({ type: "status", sensor: { connected: false }, displays: 0, uis: 1, cameras: {},
    display: null, pi: null, calibration: { cameras: {}, residuals: [] } });

  fetch(DATA_URL).then((r) => r.json()).then((d) => {
    defaults = d.settings;
    settings = structuredClone(defaults);
    eyes = d.eyes;
    if (handlers._open) handlers._open();
    const pill = document.getElementById("pill-hub");
    if (pill) { pill.textContent = "demo"; pill.title = "Running in your browser with no Pi"; }
    emit({ type: "init", settings, eyes, media: [], phase });
    sendEye();
    status();
    setInterval(status, 3000);
    setPhase("awake");
    setInterval(tick, 33);
    setTimeout(() => toast("Demo, no Pi: move over the eye and it follows you"), 600);
  }).catch((e) => toast("Demo data failed to load: " + e));

  return { connected: true, send: receive };
}
