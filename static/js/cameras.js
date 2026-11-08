// Motion cameras on the phone: per-camera settings and views (Camera tab),
// calibration views and points, and the combined view (Calibrate tab) where
// every camera is warped into the eye's gaze space so they can be lined up.
//
// Gaze space is -1..1 on both axes (+y down), as seen from the eye. Each
// camera's mapping into it comes from the hub as a grid. Until a camera has
// two calibration points its alignment sliders (shift, scale, rotate) place
// it, and they are applied here so dragging moves the overlay at once (same
// formula as hub/calibration.py); after that its calibration fit decides.

const CAM_DEFAULTS = {
  name: "", enabled: true, source: "default", rtsp_url: "", rtsp_user: "",
  exclusions: [], align: { dx: 0, dy: 0, scale: 1, rot: 0 }, opacity: 0.6,
};
const CAM_COLORS = ["#ffb347", "#5db8e1", "#c38bff", "#7ee07e"];
const SOURCES = [["default", "Camera Pi default"], ["picamera2", "Pi camera module"], ["rtsp", "Network camera (RTSP)"]];
const SOURCE_NAME = { picamera2: "Pi camera module", rtsp: "network camera", synthetic: "synthetic test scene" };
const RANGE = 1.35;          // combined view shows gaze -RANGE..RANGE

export function applyAlign(g, a) {
  const s = +a.scale || 1, r = ((+a.rot || 0) * Math.PI) / 180;
  const c = Math.cos(r), n = Math.sin(r);
  return [s * (g[0] * c - g[1] * n) + (+a.dx || 0), s * (g[0] * n + g[1] * c) + (+a.dy || 0)];
}

export function initCameras(ctx) {
  const { S, get, setSetting, cmd, el, $, $$, fields, refreshBindings, toast } = ctx;
  let editing = null;            // camera shown on the Camera tab
  let aligning = null;           // camera whose sliders are shown in the combined card
  let selPoint = (+new URLSearchParams(location.search).get("point") || 0) - 1;   // highlighted point (row tapped; ?point=N)

  // ------------------------------------------------------------ helpers
  const ids = () => Object.keys(get("cameras") || {});
  const cfg = (id) => {
    const c = (get("cameras") || {})[id] || {};
    return { ...CAM_DEFAULTS, ...c, align: { ...CAM_DEFAULTS.align, ...(c.align || {}) } };
  };
  const name = (id) => cfg(id).name || `Camera ${ids().indexOf(id) + 1}`;
  const color = (id) => CAM_COLORS[Math.max(0, ids().indexOf(id)) % CAM_COLORS.length];
  const enabled = () => ids().filter((id) => cfg(id).enabled !== false);
  const camStatus = (id) => S.status?.cameras?.[id] || {};

  function previewUrl(id, file = "stream.mjpg") {
    const s = S.status?.sensor;
    if (!s?.connected || !s.preview_port) return "";
    let host = s.address || location.hostname;
    if (/^(127\.|::1|localhost)/.test(host) || host.startsWith("::ffff:127.")) host = location.hostname;
    host = host.replace(/^::ffff:/, "");
    if (host.includes(":")) host = `[${host}]`;
    return `http://${host}:${s.preview_port}/${file}?cam=${encodeURIComponent(id)}`;
  }

  // --------------------------------------------------------- camera view
  class CamView {
    constructor(container, id) {
      this.root = container;
      this.id = id;
      this.img = el("img", { alt: "" });
      this.ph = el("div", { class: "placeholder" }, "No picture from this camera yet. Use Simulate motion to test.");
      this.c = el("canvas");
      container.replaceChildren(this.ph, this.img, this.c);
      this.tool = "none";
      this.drawing = null;
      this.simTimer = null;
      this.img.onerror = () => { this.img.style.display = "none"; this.src = ""; };
      const pos = (e) => {
        const r = this.c.getBoundingClientRect();
        return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
      };
      this.c.addEventListener("pointerdown", (e) => {
        if (this.tool === "none") return;
        this.c.setPointerCapture(e.pointerId);
        const p = pos(e);
        if (this.tool === "zone") this.drawing = [p, p];
        if (this.tool === "sim") {
          this.sim = p;
          this.sendSim();
          this.simTimer = setInterval(() => this.sendSim(), 100);
        }
      });
      this.c.addEventListener("pointermove", (e) => {
        if (this.drawing) this.drawing[1] = pos(e);
        if (this.simTimer) this.sim = pos(e);
      });
      const end = () => {
        if (this.drawing) {
          const [[ax, ay], [bx, by]] = this.drawing;
          const z = [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)].map((v) => +v.toFixed(4));
          if (z[2] > 0.01 && z[3] > 0.01) setSetting(`cameras.${this.id}.exclusions`, [...cfg(this.id).exclusions, z]);
          this.drawing = null;
          renderZones();
        }
        clearInterval(this.simTimer);
        this.simTimer = null;
      };
      this.c.addEventListener("pointerup", end);
      this.c.addEventListener("pointercancel", end);
    }
    sendSim() {
      const [x, y] = this.sim;
      cmd("sim_motion", { cam: this.id, targets: [{ x, y, w: 0.08, h: 0.25, area: 0.02 }] });
    }
    setStream(url) {
      if (url === this.src) return;
      this.src = url;
      if (url) { this.img.style.display = ""; this.img.src = url; } else { this.img.removeAttribute("src"); this.img.style.display = "none"; }
    }
    fit() {
      const st = camStatus(this.id);
      const fr = st.frame;
      if (fr && fr[0]) this.root.style.aspectRatio = `${fr[0]} / ${fr[1]}`;
      // Say why there is no picture.
      const sen = S.status?.sensor;
      this.ph.textContent = !sen?.connected
        ? "The camera Pi is offline (not connected to the hub). Check its power and Wi-Fi. Simulate motion still works."
        : cfg(this.id).enabled === false ? `${name(this.id)} is switched off.`
        : st.status && !String(st.status).startsWith("streaming") ? `${name(this.id)}: ${st.status}`
        : "No picture from this camera yet. Use Simulate motion to test.";
    }
    draw() {
      const c = this.c;
      const dpr = devicePixelRatio || 1;
      const w = (c.width = c.clientWidth * dpr), h = (c.height = c.clientHeight * dpr);
      if (!w) return;
      const x = c.getContext("2d");
      x.clearRect(0, 0, w, h);
      x.fillStyle = "rgba(255,60,60,0.25)";
      x.strokeStyle = "rgba(255,90,90,0.8)";
      x.lineWidth = dpr;
      for (const z of cfg(this.id).exclusions) { x.fillRect(z[0] * w, z[1] * h, z[2] * w, z[3] * h); x.strokeRect(z[0] * w, z[1] * h, z[2] * w, z[3] * h); }
      if (this.drawing) {
        const [[ax, ay], [bx, by]] = this.drawing;
        x.strokeRect(ax * w, ay * h, (bx - ax) * w, (by - ay) * h);
      }
      drawPoints(x, dpr, (p) => p.cams?.[this.id] && [p.cams[this.id][0] * w, p.cams[this.id][1] * h]);
      const f = S.frame;
      if (!f) return;
      x.strokeStyle = "rgba(155,225,93,0.9)";
      x.lineWidth = 2 * dpr;
      const aim = get("sensor.aim_y") ?? 0.5;
      for (const t of f.cams?.[this.id] || []) {
        if (t.w) x.strokeRect((t.x - t.w / 2) * w, (t.y - aim * t.h) * h, t.w * w, t.h * h);
      }
      if (f.src && f.src.cam === this.id && f.motion) {
        x.fillStyle = "#ffb347";
        x.beginPath(); x.arc(f.src.xy[0] * w, f.src.xy[1] * h, 8 * dpr, 0, 7); x.fill();
      }
    }
  }

  // Calibration points: numbered dots; the selected one gets a big ring.
  function drawPoints(x, dpr, place) {
    const pts = get("calibration.points") || [];
    x.font = `bold ${11 * dpr}px system-ui`;
    x.textAlign = "center";
    x.textBaseline = "middle";
    pts.forEach((p, i) => {
      const at = place(p);
      if (!at) return;
      const sel = i === selPoint;
      x.fillStyle = sel ? "#ffe14d" : "#c07a35";
      x.beginPath(); x.arc(at[0], at[1], (sel ? 9 : 7) * dpr, 0, 7); x.fill();
      x.fillStyle = "#111";
      x.fillText(String(i + 1), at[0], at[1] + 0.5 * dpr);
      if (sel) {
        x.strokeStyle = "#ffe14d";
        x.lineWidth = 2.5 * dpr;
        x.beginPath(); x.arc(at[0], at[1], 18 * dpr, 0, 7); x.stroke();
      }
    });
  }

  // ------------------------------------------------------- Camera tab
  const camMain = new CamView($("#cam-main"), "cam1");
  $$("#cam-tool button").forEach((b) => b.addEventListener("click", () => {
    $$("#cam-tool button").forEach((x) => x.classList.toggle("on", x === b));
    camMain.tool = b.dataset.tool;
  }));
  let knownIds = "";
  let wantSelectNew = false;

  function renderPicker() {
    const list = ids();
    if (!list.includes(editing)) editing = list[0] || null;
    camMain.id = editing;
    $("#cam-pick").replaceChildren(
      ...list.map((id) => {
        const st = camStatus(id);
        const ok = st.status && String(st.status).startsWith("streaming");
        return el("button", { class: "chip cam-chip" + (id === editing ? " on" : ""), onclick: () => { editing = id; renderAll(); } },
          el("span", { class: "dot", style: `background:${cfg(id).enabled === false ? "#555" : ok ? color(id) : "#a33"}` }), name(id));
      }),
      el("button", { class: "chip", onclick: () => { wantSelectNew = true; cmd("camera_add"); } }, "+ Add camera"));
  }

  function renderEditor() {
    const id = editing;
    const box = $("#cam-settings");
    if (!id) { box.replaceChildren(); return; }
    const c = cfg(id);
    const key = JSON.stringify([id, c.name, c.enabled, c.source, c.rtsp_url, c.rtsp_user, ids().length]);
    if (box.dataset.key === key) return updateEditorStatus();
    if (box.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return updateEditorStatus();
    box.dataset.key = key;
    const txt = (label, value, attrs, onchange) => {
      const inp = el("input", { type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", ...attrs });
      inp.value = value || "";
      inp.addEventListener("change", () => onchange(inp.value.trim()));
      return [el("div", { class: "field" }, el("label", {}, label), inp), inp];
    };
    const [nameRow] = txt("Name", c.name || name(id), {}, (v) => setSetting(`cameras.${id}.name`, v));
    const en = el("input", { type: "checkbox" });
    en.checked = c.enabled !== false;
    en.addEventListener("change", () => setSetting(`cameras.${id}.enabled`, en.checked));
    const src = el("select", {}, ...SOURCES.map(([v, l]) => el("option", { value: v }, l)));
    src.value = c.source || "default";
    src.addEventListener("change", () => setSetting(`cameras.${id}.source`, src.value));
    const rows = [nameRow,
      el("div", { class: "field" }, el("label", {}, "Use this camera"), el("span", { class: "switch" }, en, el("span"))),
      el("div", { class: "field" }, el("label", {}, "Source"), src)];
    if (c.source === "rtsp") {
      const [urlRow, url] = txt("Stream URL", c.rtsp_url, { placeholder: "rtsps://192.168.1.70:322/stream0" }, () => {});
      const [userRow, user] = txt("User", c.rtsp_user, {}, () => {});
      const pass = el("input", { type: "password", autocomplete: "new-password", id: "cam-pass" });
      pass.placeholder = camStatus(id).rtsp_password_set ? "saved (type to change)" : "not set";
      const save = el("button", { onclick: () => {
        setSetting(`cameras.${id}.rtsp_url`, url.value.trim());
        setSetting(`cameras.${id}.rtsp_user`, user.value.trim());
        if (pass.value) cmd("rtsp_password", { cam: id, value: pass.value });
        pass.value = "";
        toast("Saved. Connecting...");
      } }, "Save and connect");
      rows.push(urlRow, userRow, el("div", { class: "field" }, el("label", {}, "Password"), pass), el("div", { class: "row" }, save));
    }
    if (ids().length > 1) {
      rows.push(el("div", { class: "row" }, el("button", { class: "danger", onclick: () => {
        if (confirm(`Remove ${name(id)}? Its ignore zones and its part of the calibration points go too.`)) cmd("camera_remove", { cam: id });
      } }, "Remove this camera")));
    }
    box.replaceChildren(...rows);
    updateEditorStatus();
  }
  function updateEditorStatus() {
    const id = editing;
    const st = camStatus(id);
    const sen = S.status?.sensor;
    const pass = $("#cam-pass");
    if (pass && document.activeElement !== pass) pass.placeholder = st.rtsp_password_set ? "saved (type to change)" : "not set";
    $("#cam-status").textContent = !sen?.connected
      ? "Camera Pi not connected. Simulate motion works without it."
      : cfg(id).enabled === false ? `${name(id)} is switched off.`
      : `${name(id)}: ${SOURCE_NAME[st.source] || st.source || "starting"}${st.status ? " (" + st.status + ")" : ""}`
        + `${st.frame ? ", " + st.frame.join("×") : ""}${st.last_s != null ? `, last data ${st.last_s} s ago` : ""}.`;
  }
  function renderZones() {
    const id = editing;
    const zs = id ? cfg(id).exclusions : [];
    $("#zones-title").textContent = id ? `Ignore zones: ${name(id)}` : "Ignore zones";
    $("#zones").replaceChildren(...zs.map((z, i) =>
      el("span", { class: "chip" }, `Zone ${i + 1}`,
        el("button", { onclick: () => { const n = [...cfg(id).exclusions]; n.splice(i, 1); setSetting(`cameras.${id}.exclusions`, n); renderZones(); } }, "×"))));
    if (!zs.length) $("#zones").append(el("span", { class: "hint" }, "None. Choose Draw ignore zone and drag on the image (trees, road, flags, the clock overlay)."));
  }

  // ---------------------------------------------------- Calibrate tab
  let calViews = [];
  function renderCalViews() {
    const want = enabled();
    if (calViews.map((v) => v.id).join() === want.join()) return;
    const box = $("#cal-views");
    calViews = want.map((id) => {
      const holder = el("div", { class: "camview" });
      const v = new CamView(holder, id);
      v.tool = "sim";
      v.label = el("div", { class: "cam-label" }, el("span", { class: "dot", style: `background:${color(id)}` }), name(id));
      v.wrap = el("div", {}, v.label, holder);
      return v;
    });
    box.replaceChildren(...calViews.map((v) => v.wrap));
  }

  function renderCalPoints() {
    const pts = get("calibration.points") || [];
    if (selPoint >= pts.length) selPoint = -1;
    const res = S.status?.calibration?.residuals || [];
    const short = (id) => `C${ids().indexOf(id) + 1}`;
    const f2 = (a) => a.map((v) => v.toFixed(2)).join(", ");
    $("#cal-points").replaceChildren(...pts.map((p, i) => {
      const cams = Object.entries(p.cams || (p.cam ? { cam1: p.cam } : {}));
      const errs = Object.entries(res[i] || {});
      const tr = el("tr", { class: i === selPoint ? "sel" : "", onclick: (e) => {
        if (e.target.closest("button")) return;
        selPoint = selPoint === i ? -1 : i;
        renderCalPoints();
      } },
        el("td", {}, String(i + 1)),
        el("td", {}, ...cams.map(([id, xy]) => el("div", {}, el("span", { class: "dot", style: `background:${color(id)}` }), `${short(id)} ${f2(xy)}`))),
        el("td", {}, f2(p.gaze)),
        el("td", {}, ...errs.map(([id, r]) => el("div", {}, `${short(id)} ${r.toFixed(3)}`))),
        el("td", {}, el("button", { onclick: () => { selPoint = -1; cmd("cal_delete", { index: i }); } }, "×")));
      return tr;
    }));
    const kinds = S.status?.calibration?.cameras || {};
    $("#cal-kind").textContent = enabled().map((id) => `${name(id)}: ${kinds[id] ? kinds[id].kind + " (" + kinds[id].points + " pts)" : "?"}`).join(" · ");
    $("#cal-sel-hint").textContent = selPoint >= 0 ? `Point ${selPoint + 1} is highlighted in yellow on the camera views, the combined view and the gaze pad.` : "Tap a row to highlight that point.";
  }

  function onFrame() {
    const f = S.frame;
    const seen = Object.entries(f.cams || {}).filter(([, ts]) => ts.length).map(([id]) => name(id));
    $("#cal-live").textContent = f.motion && f.target
      ? `Seen by ${seen.join(" + ") || "?"} → gaze ${f.gaze.map((v) => v.toFixed(2)).join(", ")}. Capture records every camera that sees them.`
      : "No detection right now.";
  }

  // ---------------------------------------------------- combined view
  const combo = $("#combo");
  const bitmaps = {};            // camera id -> latest ImageBitmap
  let comboTool = "view";
  let dragEnd = null;
  let lastCombo = 0;
  const G2P = (g, w, h) => [((g[0] + RANGE) / (2 * RANGE)) * w, ((g[1] + RANGE) / (2 * RANGE)) * h];
  const P2G = (p, w, h) => [(p[0] / w) * 2 * RANGE - RANGE, (p[1] / h) * 2 * RANGE - RANGE];

  $$("#combo-tool button").forEach((b) => b.addEventListener("click", () => {
    $$("#combo-tool button").forEach((x) => x.classList.toggle("on", x === b));
    comboTool = b.dataset.tool;
    if (comboTool === "divider" && !get("fusion.divider.enabled")) setSetting("fusion.divider.enabled", true);
  }));
  const evPos = (e) => {
    const r = combo.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  combo.addEventListener("pointerdown", (e) => {
    const [u, v] = evPos(e);
    const g = P2G([u, v], 1, 1);
    if (comboTool === "divider") {
      const d = get("fusion.divider");
      const da = Math.hypot(g[0] - d.a[0], g[1] - d.a[1]), db = Math.hypot(g[0] - d.b[0], g[1] - d.b[1]);
      dragEnd = da < db ? "a" : "b";
      combo.setPointerCapture(e.pointerId);
      moveEnd(g);
    } else {
      // Tap near a calibration point to highlight it.
      const pts = get("calibration.points") || [];
      let best = -1, bd = 0.12;
      pts.forEach((p, i) => { const dd = Math.hypot(p.gaze[0] - g[0], p.gaze[1] - g[1]); if (dd < bd) { bd = dd; best = i; } });
      selPoint = best === selPoint ? -1 : best;
      renderCalPoints();
    }
  });
  combo.addEventListener("pointermove", (e) => { if (dragEnd) moveEnd(P2G(evPos(e), 1, 1)); });
  const stopDrag = () => { dragEnd = null; };
  combo.addEventListener("pointerup", stopDrag);
  combo.addEventListener("pointercancel", stopDrag);
  function moveEnd(g) {
    const c = (v) => +Math.max(-RANGE, Math.min(RANGE, v)).toFixed(3);
    setSetting(`fusion.divider.${dragEnd}`, [c(g[0]), c(g[1])]);
  }

  // Fresh stills for the warped overlay (snapshot polling works on every phone browser).
  async function pollSnapshots() {
    while (true) {
      const active = $(".tab.on")?.id === "tab-calibrate";
      if (active && S.status?.sensor?.connected) {
        await Promise.all(enabled().map(async (id) => {
          try {
            const r = await fetch(previewUrl(id, "snapshot.jpg") + "&t=" + Date.now(), { cache: "no-store" });
            if (r.ok) {
              const bmp = await createImageBitmap(await r.blob());
              bitmaps[id]?.close?.();
              bitmaps[id] = bmp;
            }
          } catch {}
        }));
      }
      await new Promise((res) => setTimeout(res, active ? 350 : 1500));
    }
  }
  pollSnapshots();

  // Warp one camera image into gaze space, triangle by triangle.
  function drawWarped(x, id, w, h) {
    const rep = S.status?.calibration?.cameras?.[id];
    const img = bitmaps[id];
    if (!rep?.grid) return;
    const a = cfg(id).align, off = rep.offset || [0, 0];
    const place = rep.sliders ? (g) => { const p = applyAlign(g, a); return [p[0] + off[0], p[1] + off[1]]; } : (g) => g;
    const grid = rep.grid.map((row) => row.map((g) => G2P(place(g), w, h)));
    const ny = grid.length, nx = grid[0].length;
    const ok = (p) => Math.abs(p[0] - w / 2) < w * 2 && Math.abs(p[1] - h / 2) < h * 2;
    x.save();
    x.globalAlpha = Math.max(0.05, Math.min(1, +cfg(id).opacity));
    if (img) {
      const sx = (i) => (i / (nx - 1)) * img.width, sy = (j) => (j / (ny - 1)) * img.height;
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const p00 = grid[j][i], p10 = grid[j][i + 1], p01 = grid[j + 1][i], p11 = grid[j + 1][i + 1];
          if (![p00, p10, p01, p11].every(ok)) continue;
          tri(x, img, [sx(i), sy(j)], [sx(i + 1), sy(j)], [sx(i), sy(j + 1)], p00, p10, p01);
          tri(x, img, [sx(i + 1), sy(j)], [sx(i + 1), sy(j + 1)], [sx(i), sy(j + 1)], p10, p11, p01);
        }
      }
    }
    // Outline of the camera's field of view.
    x.globalAlpha = 1;
    x.strokeStyle = color(id);
    x.lineWidth = 2 * (devicePixelRatio || 1);
    x.beginPath();
    const edge = [...grid[0], ...grid.map((r) => r[nx - 1]), ...[...grid[ny - 1]].reverse(), ...grid.map((r) => r[0]).reverse()];
    edge.forEach((p, k) => (k ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])));
    x.closePath();
    x.stroke();
    x.restore();
  }
  function tri(x, img, s0, s1, s2, d0, d1, d2) {
    // Grow the clip slightly so neighbouring triangles don't leave hairline seams.
    const cx = (d0[0] + d1[0] + d2[0]) / 3, cy = (d0[1] + d1[1] + d2[1]) / 3;
    const grow = (p) => { const dx = p[0] - cx, dy = p[1] - cy, l = Math.hypot(dx, dy) || 1; return [p[0] + (dx / l) * 0.8, p[1] + (dy / l) * 0.8]; };
    const [g0, g1, g2] = [grow(d0), grow(d1), grow(d2)];
    const den = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
    if (!den) return;
    const ax = ((d1[0] - d0[0]) * (s2[1] - s0[1]) - (d2[0] - d0[0]) * (s1[1] - s0[1])) / den;
    const cxx = ((d2[0] - d0[0]) * (s1[0] - s0[0]) - (d1[0] - d0[0]) * (s2[0] - s0[0])) / den;
    const bx = ((d1[1] - d0[1]) * (s2[1] - s0[1]) - (d2[1] - d0[1]) * (s1[1] - s0[1])) / den;
    const dy = ((d2[1] - d0[1]) * (s1[0] - s0[0]) - (d1[1] - d0[1]) * (s2[0] - s0[0])) / den;
    const e = d0[0] - ax * s0[0] - cxx * s0[1], f = d0[1] - bx * s0[0] - dy * s0[1];
    x.save();
    x.beginPath(); x.moveTo(g0[0], g0[1]); x.lineTo(g1[0], g1[1]); x.lineTo(g2[0], g2[1]); x.closePath();
    x.clip();
    x.setTransform(ax, bx, cxx, dy, e, f);
    x.drawImage(img, 0, 0);
    x.restore();
  }

  function drawCombo() {
    const dpr = devicePixelRatio || 1;
    const w = (combo.width = combo.clientWidth * dpr), h = (combo.height = combo.clientHeight * dpr);
    if (!w) return;
    const x = combo.getContext("2d");
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = "#08090b";
    x.fillRect(0, 0, w, h);
    for (const id of enabled()) drawWarped(x, id, w, h);
    // The eye's gaze range and centre lines.
    x.strokeStyle = "rgba(255,255,255,0.35)";
    x.lineWidth = dpr;
    const [x0, y0] = G2P([-1, -1], w, h), [x1, y1] = G2P([1, 1], w, h);
    x.setLineDash([4 * dpr, 4 * dpr]);
    x.strokeRect(x0, y0, x1 - x0, y1 - y0);
    x.setLineDash([]);
    x.fillStyle = "rgba(255,255,255,0.5)";
    x.font = `${10 * dpr}px system-ui`;
    x.textAlign = "left";
    x.fillText("eye's gaze range", x0 + 4 * dpr, y0 - 4 * dpr);
    // Divider and who owns each side.
    const d = get("fusion.divider");
    if (d?.enabled && enabled().length > 1) {
      const pa = G2P(d.a, w, h), pb = G2P(d.b, w, h);
      x.strokeStyle = "#fff";
      x.lineWidth = 2 * dpr;
      x.beginPath(); x.moveTo(pa[0], pa[1]); x.lineTo(pb[0], pb[1]); x.stroke();
      for (const p of [pa, pb]) { x.fillStyle = "#fff"; x.beginPath(); x.arc(p[0], p[1], 7 * dpr, 0, 7); x.fill(); }
      const mx = (pa[0] + pb[0]) / 2, my = (pa[1] + pb[1]) / 2;
      const dx = pb[0] - pa[0], dyy = pb[1] - pa[1], l = Math.hypot(dx, dyy) || 1;
      const nx = dyy / l, nyy = -dx / l;          // normal towards the "right" side (see fusion.py)
      const owners = { left: d.left, right: d.right };
      x.font = `bold ${12 * dpr}px system-ui`;
      x.textAlign = "center";
      for (const [side, sgn] of [["left", -1], ["right", 1]]) {
        const id = owners[side];
        if (!ids().includes(id)) continue;
        x.fillStyle = color(id);
        x.fillText(name(id), mx + sgn * nx * 40 * dpr, my + sgn * nyy * 40 * dpr);
      }
    }
    drawPoints(x, dpr, (p) => G2P(p.gaze, w, h));
    const f = S.frame;
    if (f) {
      for (const t of f.targets || []) {
        const [a, b] = G2P([t.x, t.y], w, h);
        x.strokeStyle = t.cam ? color(t.cam) : "#fff";
        x.lineWidth = 2 * dpr;
        x.beginPath(); x.arc(a, b, 10 * dpr, 0, 7); x.stroke();
      }
      const [gx, gy] = G2P(f.gaze, w, h);
      x.fillStyle = "#9be15d";
      x.beginPath(); x.arc(gx, gy, 5 * dpr, 0, 7); x.fill();
    }
  }

  // Align sliders for one camera, plus divider / priority controls.
  function renderComboControls() {
    const list = enabled();
    if (!list.includes(aligning)) aligning = list[1] || list[0] || null;
    const key = JSON.stringify([aligning, list, list.map(name)]);
    const box = $("#combo-fields");
    $("#align-pick").replaceChildren(...list.map((id) =>
      el("button", { class: "chip cam-chip" + (id === aligning ? " on" : ""), onclick: () => { aligning = id; renderComboControls(); } },
        el("span", { class: "dot", style: `background:${color(id)}` }), name(id))));
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.replaceChildren();
      if (aligning) {
        const p = `cameras.${aligning}`;
        // Make sure the values exist before the sliders bind to them.
        const c = cfg(aligning);
        if (!(get("cameras") || {})[aligning]?.align) setSetting(`${p}.align`, { ...c.align });
        if ((get("cameras") || {})[aligning]?.opacity === undefined) setSetting(`${p}.opacity`, c.opacity);
        fields(box, [
          { path: `${p}.opacity`, label: "Overlay opacity", min: 0.05, max: 1, step: 0.05 },
          { path: `${p}.align.dx`, label: "Slide left / right", min: -1.5, max: 1.5, step: 0.005 },
          { path: `${p}.align.dy`, label: "Slide up / down", min: -1.5, max: 1.5, step: 0.005 },
          { path: `${p}.align.scale`, label: "Scale", min: 0.2, max: 4, step: 0.01 },
          { path: `${p}.align.rot`, label: "Rotate", unit: "°", min: -180, max: 180, step: 0.5 },
        ]);
        refreshBindings();      // new sliders: show the current values
        box.append(el("p", { class: "hint", id: "align-note" }),
          el("div", { class: "row" }, el("button", { onclick: () => setSetting(`${p}.align`, { ...CAM_DEFAULTS.align }) }, "Reset alignment")));
      }
    }
    const rep = aligning && S.status?.calibration?.cameras?.[aligning];
    const note = $("#align-note");
    // Position sliders do nothing once the calibration fit has taken over.
    [...box.querySelectorAll(".field")].slice(1).forEach((f) => f.classList.toggle("dim", !!rep && !rep.sliders));
    if (note) note.textContent = rep && !rep.sliders
      ? `${name(aligning)} is placed by its ${rep.points} calibration points (${rep.kind} fit); the sliders take over again with fewer than 2.`
      : "The sliders place this camera until it has 2 or more calibration points; then its calibration takes over.";
    // Divider and priority choices depend on the camera list.
    const multi = list.length > 1;
    $("#fusion-box").style.display = multi ? "" : "none";
    const opts = (sel, path) => {
      const cur = get(path);
      sel.replaceChildren(...list.map((id) => el("option", { value: id }, name(id))));
      sel.value = list.includes(cur) ? cur : list[0] || "";
    };
    if (document.activeElement !== $("#div-left")) opts($("#div-left"), "fusion.divider.left");
    if (document.activeElement !== $("#div-right")) opts($("#div-right"), "fusion.divider.right");
    if (document.activeElement !== $("#fuse-prio")) opts($("#fuse-prio"), "fusion.priority");
    $("#div-on").checked = !!get("fusion.divider.enabled");
    $("#combo-hint").textContent = multi
      ? "Each camera is drawn where it maps in the eye's view. Line them up with the sliders (or calibration points seen by both), then tap a point to highlight it."
      : "Add a second camera on the Camera tab to combine them. This shows where the camera maps in the eye's view.";
  }
  $("#div-on").addEventListener("change", (e) => setSetting("fusion.divider.enabled", e.target.checked));
  $("#div-left").addEventListener("change", (e) => setSetting("fusion.divider.left", e.target.value));
  $("#div-right").addEventListener("change", (e) => setSetting("fusion.divider.right", e.target.value));
  $("#fuse-prio").addEventListener("change", (e) => setSetting("fusion.priority", e.target.value));
  $("#div-swap").addEventListener("click", () => {
    const l = get("fusion.divider.left"), r = get("fusion.divider.right");
    setSetting("fusion.divider.left", r);
    setSetting("fusion.divider.right", l);
  });
  $("#div-reset").addEventListener("click", () => {
    setSetting("fusion.divider.a", [0, -1]);
    setSetting("fusion.divider.b", [0, 1]);
  });
  fields("#fuse-fields", [
    { path: "fusion.merge_radius", label: "Same person if within", unit: "gaze", min: 0, max: 0.8, step: 0.01 },
  ]);

  // ------------------------------------------------------------ hooks
  function renderAll() {
    const now = ids().join();
    if (wantSelectNew && now !== knownIds && knownIds) {
      editing = ids().at(-1);
      wantSelectNew = false;
    }
    knownIds = now;
    renderPicker();
    renderEditor();
    renderZones();
    renderCalViews();
    renderCalPoints();
    renderComboControls();
    onTab();
  }
  function onTab() {
    const active = $(".tab.on")?.id;
    camMain.setStream(active === "tab-camera" && editing && cfg(editing).enabled !== false ? previewUrl(editing) : "");
    for (const v of calViews) v.setStream(active === "tab-calibrate" ? previewUrl(v.id) : "");
  }
  return {
    onSettings() { renderAll(); onTab(); },
    onStatus() {
      renderPicker();
      updateEditorStatus();
      camMain.fit();
      for (const v of calViews) v.fit();
      renderCalPoints();
      renderComboControls();
      onTab();
    },
    onFrame,
    onTab,
    draw(active) {
      if (active === "tab-camera") camMain.draw();
      if (active === "tab-calibrate") {
        for (const v of calViews) v.draw();
        const now = performance.now();
        if (now - lastCombo > 90) { lastCombo = now; drawCombo(); }
      }
    },
    selectedPoint: () => selPoint,
  };
}
