"""Eye hub: web server, behaviour loop and message routing.

Runs on the projector Pi. Serves
  /          phone control UI
  /display   full-screen renderer (opened by the Chromium kiosk)
  /ws        WebSocket for UI, display and sensor clients
  /media/*   animation files, /eyes/* eye templates and assets
"""
import argparse
import asyncio
import json
import os
import random
import re
import time

from aiohttp import web, WSMsgType

from .brain import Brain
from .fusion import Fusion, camera_cfgs, migrate
from .settings import Settings

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(ROOT, "static")
MEDIA_EXT = {".mp4", ".webm", ".mov", ".m4v", ".ogv", ".gif", ".png", ".jpg", ".jpeg", ".webp"}
SAFE_NAME = re.compile(r"[^A-Za-z0-9._ -]+")
TICK_HZ = 30
FRAME_HZ = 20


def safe_name(name):
    name = SAFE_NAME.sub("_", os.path.basename(name or "")).strip(" .")
    return name or None


class Hub:
    def __init__(self, settings_path, eyes_dir, media_dir):
        self.settings = Settings(settings_path)
        self.eyes_dir = eyes_dir          # built-in templates (replaced by updates)
        # Edits and new eyes live beside the settings, which updates never touch.
        self.user_eyes_dir = os.path.join(os.path.dirname(os.path.abspath(settings_path)), "eyes")
        os.makedirs(self.user_eyes_dir, exist_ok=True)
        self.media_dir = media_dir
        os.makedirs(media_dir, exist_ok=True)
        self.clients = {}          # ws -> role
        self.sensor_ws = None
        self.sensor_info = {}
        self.cam_stats = {}        # camera id -> {"fps", "frame", "status", "source", "t"}
        self.preview_eye = None    # unsaved template being edited
        self.sleep_cycles = 0      # sleeps since the last random eye switch
        self.pending_switch = False  # "Switch now": swap once the current eye is asleep
        self.last_switch = time.monotonic()   # for random mode's forced periodic switch
        boot = self.settings.get("eye.boot_template")
        if boot and boot in self.eye_ids():
            self.settings.set("eye.template", boot)
        self.brain = Brain(self.settings, self._emit, time.monotonic())
        self._out = []
        # Network camera password: kept out of settings.json, which every UI client receives.
        self.secrets_path = os.path.join(os.path.dirname(os.path.abspath(settings_path)), "secrets.json")
        self.secrets = {}
        try:
            with open(self.secrets_path, "r", encoding="utf-8") as f:
                self.secrets = json.load(f)
        except (OSError, ValueError):
            pass
        if migrate(self.settings, self.secrets):
            self.save_secrets()
        self.fusion = Fusion(self.settings)

    def save_secrets(self):
        tmp = self.secrets_path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(self.secrets, f)
        os.replace(tmp, self.secrets_path)

    # ------------------------------------------------------------- utils
    def _emit(self, msg):
        self._out.append(msg)

    async def _flush(self):
        out, self._out = self._out, []
        for msg in out:
            await self.broadcast(msg)

    async def broadcast(self, msg, roles=("ui", "display", "preview")):
        data = json.dumps(msg)
        for ws, role in list(self.clients.items()):
            if role in roles and not ws.closed:
                try:
                    await ws.send_str(data)
                except (ConnectionError, RuntimeError):
                    pass

    def media_files(self):
        try:
            return sorted(f for f in os.listdir(self.media_dir)
                          if os.path.splitext(f)[1].lower() in MEDIA_EXT and not f.startswith("."))
        except OSError:
            return []

    def media_list(self):
        items = self.settings.get("media.items") or {}
        out = []
        for f in self.media_files():
            cfg = items.get(f, {})
            st = os.stat(os.path.join(self.media_dir, f))
            out.append({"name": f, "size": st.st_size,
                        "enabled": cfg.get("enabled", True), "weight": cfg.get("weight", 1.0)})
        return out

    @staticmethod
    def _json_ids(folder):
        try:
            return {os.path.splitext(f)[0] for f in os.listdir(folder) if f.endswith(".json")}
        except OSError:
            return set()

    def eye_ids(self):
        return sorted(self._json_ids(self.eyes_dir) | self._json_ids(self.user_eyes_dir))

    @staticmethod
    def _read_json(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def builtin_eye(self, eye_id):
        return self._read_json(os.path.join(self.eyes_dir, (safe_name(eye_id) or "") + ".json"))

    def user_eye_path(self, eye_id):
        return os.path.join(self.user_eyes_dir, (safe_name(eye_id) or "") + ".json")

    def load_eye(self, eye_id):
        # Your saved copy wins over the built-in original.
        t = self._read_json(self.user_eye_path(eye_id)) or self.builtin_eye(eye_id)
        if t is not None:
            return t
        ids = self.eye_ids()
        if ids and ids[0] != eye_id:
            return self.load_eye(ids[0])
        return {}

    def eye_list(self):
        out = []
        builtin, user = self._json_ids(self.eyes_dir), self._json_ids(self.user_eyes_dir)
        for i in self.eye_ids():
            t = self.load_eye(i)
            out.append({"id": i, "name": t.get("name", i), "description": t.get("description", ""), "template": t,
                        "builtin": i in builtin, "modified": i in builtin and i in user})
        return out

    def eye_message(self):
        eye_id = self.settings.get("eye.template")
        template = self.preview_eye or self.load_eye(eye_id)
        self.brain.template_seqs = (template or {}).get("sequences") or {}
        return {"type": "eye", "id": eye_id, "template": template, "preview": self.preview_eye is not None}

    def status(self):
        now = time.monotonic()
        roles = list(self.clients.values())
        sensor_ok = self.sensor_ws is not None and not self.sensor_ws.closed
        return {
            "type": "status",
            "sensor": {
                "connected": sensor_ok,
                "address": self.sensor_info.get("address"),
                "preview_port": self.sensor_info.get("preview_port"),
                "sources": self.sensor_info.get("sources"),
                "fps": max([c.get("fps") or 0 for c in self.cam_stats.values()] or [0]),
                "last_s": round(now - self.brain.sensor_t, 1) if self.brain.sensor_t > 0 else None,
            },
            "cameras": {cid: {
                "fps": st.get("fps"), "frame": st.get("frame"), "status": st.get("status"),
                "source": st.get("source"),
                "last_s": round(now - st["t"], 1) if st.get("t") else None,
                "rtsp_password_set": bool(self.secrets.get("rtsp_password:" + cid)),
            } for cid in self.fusion.cams for st in [self.cam_stats.get(cid, {})]},
            "displays": roles.count("display"),
            "uis": roles.count("ui"),
            "display": getattr(self, "display_stats", None),
            "pi": getattr(self, "pi_health", None),
            "calibration": {"cameras": self.fusion.report(), "residuals": self.fusion.residuals()},
        }

    def init_message(self):
        return {"type": "init", "settings": self.settings.data, "eyes": self.eye_list(),
                "media": self.media_list(), "phase": self.brain.phase}

    async def push_settings(self):
        await self.broadcast({"type": "settings", "settings": self.settings.data})

    async def push_sensor_config(self):
        if self.sensor_ws is not None and not self.sensor_ws.closed:
            cams = {cid: {k: c[k] for k in ("enabled", "source", "rtsp_url", "rtsp_user", "exclusions")}
                    for cid, c in camera_cfgs(self.settings).items()}
            for cid, c in cams.items():
                c["rtsp_password"] = self.secrets.get("rtsp_password:" + cid) or ""
            cfg = dict(self.settings.get("sensor"), cameras=cams)
            await self.sensor_ws.send_str(json.dumps({"type": "config", "sensor": cfg}))

    # ---------------------------------------------------------- handlers
    async def apply_set(self, path, value):
        now = time.monotonic()
        self.settings.set(path, value)
        if path.startswith(("calibration", "cameras", "fusion")):
            self.fusion.rebuild()
        if path == "mode":
            self.brain.on_mode_change(now)
        # The camera Pi needs sources, logins and ignore zones, not view alignment.
        if path.startswith(("sensor", "cameras")) and not any(k in path for k in (".align", ".opacity", ".name")):
            await self.push_sensor_config()
        if path == "eye.template":
            self.preview_eye = None
            await self.broadcast(self.eye_message())
        await self.push_settings()

    async def handle_cmd(self, msg, ws):
        name = msg.get("name")
        now = time.monotonic()
        b = self.brain
        if name in ("wake", "sleep", "blink", "gaze", "open", "pupil", "media_play", "media_stop", "media_ended"):
            if name == "media_ended" and self.clients.get(ws) != "display":
                return
            if name == "media_play" and msg.get("item") is None:
                msg["item"] = b.pick_media(self.media_files())
            b.command(name, now, **{k: v for k, v in msg.items() if k not in ("type", "name")})
        elif name == "sim_motion":
            # A finger on one camera's view stands in for that camera's detection.
            cid = msg.get("cam") or next(iter(self.fusion.cams), "cam1")
            self.fusion.update(cid, msg.get("targets") or [], now, sim=True)
            b.on_motion(self.fusion.fuse(now, sim=True), now, source="sim")
        elif name == "cal_capture":
            # One point records every camera that sees the tracked person, so
            # the cameras are calibrated against each other as well as the eye.
            gaze = msg.get("gaze") or b.manual_gaze
            seen = b.seen if b.motion_present(now) else {}
            if not seen:
                await ws.send_str(json.dumps({"type": "toast", "text": "No current detection to capture"}))
                return
            pts = list(self.settings.get("calibration.points") or [])
            pts.append({"gaze": [round(gaze[0], 4), round(gaze[1], 4)],
                        "cams": {cid: [round(v, 4) for v in xy] for cid, xy in seen.items()}})
            await self.apply_set("calibration.points", pts)
            names = ", ".join(self.fusion.cams[c]["name"] for c in seen if c in self.fusion.cams)
            await ws.send_str(json.dumps({"type": "toast", "text": f"Point {len(pts)} captured ({names})"}))
        elif name == "cal_delete":
            pts = list(self.settings.get("calibration.points") or [])
            i = int(msg.get("index", -1))
            if 0 <= i < len(pts):
                pts.pop(i)
                await self.apply_set("calibration.points", pts)
        elif name == "cal_clear":
            await self.apply_set("calibration.points", [])
        elif name == "demo_save":
            pos = list(self.settings.get("demo.positions") or [])
            pos.append({"name": msg.get("label") or f"Pos {len(pos) + 1}",
                        "x": round(b.manual_gaze[0], 3), "y": round(b.manual_gaze[1], 3)})
            await self.apply_set("demo.positions", pos)
        elif name == "demo_delete":
            pos = list(self.settings.get("demo.positions") or [])
            i = int(msg.get("index", -1))
            if 0 <= i < len(pos):
                pos.pop(i)
                await self.apply_set("demo.positions", pos)
        elif name == "reset":
            section = msg.get("section")
            self.settings.reset(section if section in self.settings.data else None)
            self.fusion.rebuild()
            await self.push_sensor_config()
            await self.broadcast(self.eye_message())
            await self.push_settings()
        elif name == "eye_preview":
            self.preview_eye = msg.get("template")
            await self.broadcast(self.eye_message())
        elif name == "eye_revert":
            self.preview_eye = None
            await self.broadcast(self.eye_message())
        elif name == "random_eye":
            await self.switch_eye_now(now)
        elif name == "rtsp_password" and self.clients.get(ws) == "ui":
            self.secrets["rtsp_password:" + str(msg.get("cam") or "cam1")] = str(msg.get("value") or "")
            self.save_secrets()
            await self.push_sensor_config()
            await self.broadcast(self.status(), roles=("ui",))
        elif name == "camera_add":
            cams = dict(self.settings.get("cameras") or {})
            n = 1
            while f"cam{n}" in cams:
                n += 1
            cams[f"cam{n}"] = {"name": f"Camera {n}", "source": "rtsp"}
            await self.apply_set("cameras", cams)
        elif name == "camera_remove":
            cid = msg.get("cam")
            cams = dict(self.settings.get("cameras") or {})
            if cid in cams and len(cams) > 1:
                cams.pop(cid)
                pts = [dict(p, cams={k: v for k, v in (p.get("cams") or {}).items() if k != cid})
                       for p in self.settings.get("calibration.points") or []]
                self.settings.set("calibration.points", [p for p in pts if p["cams"]])
                self.secrets.pop("rtsp_password:" + cid, None)
                self.save_secrets()
                await self.apply_set("cameras", cams)
        elif name == "reload_display":
            # Projector pages reload to pick up new renderer code.
            await self.broadcast({"type": "reload"}, roles=("display",))
        await self._flush()

    async def ws_handler(self, request):
        ws = web.WebSocketResponse(heartbeat=10, max_msg_size=8 * 1024 * 1024)
        await ws.prepare(request)
        role = None
        try:
            async for m in ws:
                if m.type != WSMsgType.TEXT:
                    continue
                try:
                    msg = json.loads(m.data)
                except ValueError:
                    continue
                t = msg.get("type")
                if t == "hello":
                    role = msg.get("role", "ui")
                    if role == "sensor":
                        if self.sensor_ws is not None and not self.sensor_ws.closed:
                            await self.sensor_ws.close()
                        self.sensor_ws = ws
                        self.sensor_info = {"address": request.remote, "preview_port": msg.get("preview_port"),
                                            "source": msg.get("source"), "sources": msg.get("sources"),
                                            "default_source": (msg.get("sources") or [None])[0]}
                        await self.push_sensor_config()
                        print(f"sensor connected from {request.remote} ({msg.get('source')})")
                    else:
                        self.clients[ws] = role
                        await ws.send_str(json.dumps(self.init_message()))
                        await ws.send_str(json.dumps(self.eye_message()))
                        await ws.send_str(json.dumps({"type": "phase", "phase": self.brain.phase, "instant": True}))
                        await ws.send_str(json.dumps(self.status()))
                elif t == "display_stats" and role == "display":
                    self.display_stats = {k: msg.get(k) for k in ("fps", "worst_ms", "canvas", "screen", "dpr", "gpu", "draw_ms")}
                elif t == "sensor_status" and role == "sensor":
                    st = self.cam_stats.setdefault(msg.get("cam") or "cam1", {})
                    st.update({k: msg.get(k) for k in ("source", "status")})
                    if msg.get("sources"):
                        self.sensor_info["sources"] = msg["sources"]
                elif t == "motion" and role == "sensor":
                    now = time.monotonic()
                    cid = msg.get("cam") or "cam1"
                    self.cam_stats.setdefault(cid, {}).update({"fps": msg.get("fps"), "frame": msg.get("frame"), "t": now})
                    self.fusion.update(cid, msg.get("targets") or [], now)
                    self.brain.on_motion(self.fusion.fuse(now), now)
                elif t == "set" and role in ("ui", "display"):
                    await self.apply_set(str(msg.get("path")), msg.get("value"))
                elif t == "cmd":
                    await self.handle_cmd(msg, ws)
        finally:
            self.clients.pop(ws, None)
            if ws is self.sensor_ws:
                self.sensor_ws = None
                print("sensor disconnected")
        return ws

    # ------------------------------------------------------------- REST
    async def api_media_upload(self, request):
        reader = await request.multipart()
        saved = []
        while True:
            part = await reader.next()
            if part is None:
                break
            name = safe_name(part.filename)
            if not name or os.path.splitext(name)[1].lower() not in MEDIA_EXT:
                continue
            path = os.path.join(self.media_dir, name)
            with open(path + ".part", "wb") as f:
                while True:
                    chunk = await part.read_chunk(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
            os.replace(path + ".part", path)
            saved.append(name)
        await self.broadcast({"type": "media_list", "media": self.media_list()}, roles=("ui",))
        return web.json_response({"saved": saved})

    async def api_media_delete(self, request):
        name = safe_name(request.match_info["name"])
        path = os.path.join(self.media_dir, name or "")
        if name and os.path.isfile(path):
            os.remove(path)
        items = dict(self.settings.get("media.items") or {})
        if items.pop(name, None) is not None:
            self.settings.set("media.items", items)
        await self.broadcast({"type": "media_list", "media": self.media_list()}, roles=("ui",))
        return web.json_response({"ok": True})

    async def api_media_list(self, request):
        return web.json_response(self.media_list())

    async def api_eye_save(self, request):
        eye_id = safe_name(request.match_info["id"]).replace(" ", "-").lower()
        template = await request.json()
        with open(self.user_eye_path(eye_id), "w", encoding="utf-8") as f:
            json.dump(template, f, indent=2)
        self.preview_eye = None
        self.settings.set("eye.template", eye_id)
        await self.broadcast({"type": "eyes", "eyes": self.eye_list()}, roles=("ui",))
        await self.broadcast(self.eye_message())
        await self.push_settings()
        return web.json_response({"id": eye_id})

    async def api_eye_builtin(self, request):
        # The shipped original (for per-setting resets); {} for your own eyes.
        return web.json_response(self.builtin_eye(request.match_info["id"]) or {})

    async def api_eye_restore(self, request):
        # Throw away your saved copy so the built-in original is used again.
        eye_id = safe_name(request.match_info["id"])
        path = self.user_eye_path(eye_id)
        if eye_id and self.builtin_eye(eye_id) is not None and os.path.isfile(path):
            os.remove(path)
        self.preview_eye = None
        await self.broadcast({"type": "eyes", "eyes": self.eye_list()}, roles=("ui",))
        await self.broadcast(self.eye_message())
        return web.json_response({"ok": True})

    async def api_eye_delete(self, request):
        # Only your own eyes can be deleted; built-ins can only be restored.
        eye_id = safe_name(request.match_info["id"])
        path = self.user_eye_path(eye_id)
        if eye_id and self.builtin_eye(eye_id) is None and os.path.isfile(path) and len(self.eye_ids()) > 1:
            os.remove(path)
            if self.settings.get("eye.template") == eye_id:
                self.settings.set("eye.template", self.eye_ids()[0])
            await self.broadcast({"type": "eyes", "eyes": self.eye_list()}, roles=("ui",))
            await self.broadcast(self.eye_message())
            await self.push_settings()
        return web.json_response({"ok": True})

    async def api_outputs_get(self, request):
        # Projector output modes (sway on the projector Pi); empty elsewhere.
        from . import display_output
        try:
            outs = await asyncio.get_running_loop().run_in_executor(None, display_output.list_outputs)
            return web.json_response({"saved": display_output.saved_mode(), "outputs": outs})
        except Exception as e:  # not on the kiosk Pi, sway not running, ...
            return web.json_response({"saved": "auto", "outputs": [], "error": str(e)})

    async def api_outputs_set(self, request):
        from . import display_output
        mode = (await request.json()).get("mode", "auto")
        try:
            done = await asyncio.get_running_loop().run_in_executor(None, display_output.set_mode, mode)
            return web.json_response({"ok": True, "mode": done})
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)

    async def api_settings_get(self, request):
        return web.json_response(self.settings.data, headers={
            "Content-Disposition": 'attachment; filename="projector-eye-settings.json"'})

    async def api_settings_put(self, request):
        self.settings.replace(await request.json())
        self.fusion.rebuild()
        await self.push_sensor_config()
        await self.broadcast(self.eye_message())
        await self.push_settings()
        return web.json_response({"ok": True})

    # ------------------------------------------------------------- loops
    def pick_random_eye(self):
        """Switch to a different eye from the random pool. True if switched."""
        current = self.settings.get("eye.template")
        exclude = set(self.settings.get("eye.random_exclude") or [])
        pool = [i for i in self.eye_ids() if i not in exclude and i != current]
        if not pool:
            return False
        self.preview_eye = None
        self.settings.set("eye.template", random.choice(pool))
        self.last_switch = time.monotonic()
        return True

    async def switch_eye_now(self, now):
        """'Switch now': by default the current eye goes to sleep and fades
        out, the eye is swapped in the dark, and the new one fades in and wakes."""
        b = self.brain
        if self.settings.get("eye.switch_transition") == "instant" or b.phase == "media":
            if self.pick_random_eye():
                await self.broadcast(self.eye_message())
                await self.push_settings()
            return
        if b.phase == "asleep":
            await self.finish_switch(now)
            return
        self.pending_switch = True
        b.hold_sleep = True
        if b.phase in ("awake", "waking"):
            b.start_sleep(now)
        # already "sleeping": the swap happens when it reaches "asleep"

    async def finish_switch(self, now):
        self.pending_switch = False
        self.brain.hold_sleep = False
        if self.pick_random_eye():
            await self.broadcast(self.eye_message())
            await self.push_settings()
        self.brain.start_wake(now)
        await self._flush()

    async def check_health(self):
        # Temperature and power/thermal flags; new problems go to the journal,
        # which is persistent, so they survive an unexpected reboot.
        from . import pi_health
        h = await asyncio.get_running_loop().run_in_executor(None, pi_health.read)
        if h is None:
            return
        prev = getattr(self, "pi_health", None) or {}
        new = sorted(set(h["now"] + h["since_boot"]) - set(prev.get("now", []) + prev.get("since_boot", [])))
        if new or h["temp"] >= 75 and prev.get("temp", 0) < 75:
            print(f"pi health: {h['temp']} C, flags {h['throttled']} now={h['now']} since boot={h['since_boot']}", flush=True)
        self.pi_health = h

    async def check_forced_switch(self, now):
        # Random mode can force a new eye every N minutes, even while it is
        # awake and tracking someone. Asleep, it just swaps quietly in the dark.
        minutes = float(self.settings.get("eye.random_force_min") or 0)
        if self.settings.get("behavior.stay_awake"):
            # It never sleeps, so sleep-count switching can't happen: use the awake interval.
            awake_min = float(self.settings.get("eye.random_awake_min") or 0)
            minutes = min(minutes, awake_min) if minutes > 0 and awake_min > 0 else (minutes or awake_min)
        if minutes <= 0 or self.settings.get("mode") != "random" or self.pending_switch:
            return
        if now - self.last_switch < minutes * 60 or self.brain.phase == "media":
            return
        self.last_switch = now
        if self.brain.phase == "asleep":
            if self.pick_random_eye():
                await self.broadcast(self.eye_message())
                await self.push_settings()
        else:
            # Always the gentle sleep -> swap -> wake transition here.
            self.pending_switch = True
            self.brain.hold_sleep = True
            if self.brain.phase in ("awake", "waking"):
                self.brain.start_sleep(now)
            await self._flush()

    async def on_fell_asleep(self):
        # Random mode: swap while the screen is dark, after N sleeps.
        if self.settings.get("mode") != "random":
            return
        self.sleep_cycles += 1
        if self.sleep_cycles < max(1, int(self.settings.get("eye.random_every") or 1)):
            return
        self.sleep_cycles = 0
        if self.pick_random_eye():
            await self.broadcast(self.eye_message())
            await self.push_settings()

    async def run_loop(self):
        frame_every = 1.0 / FRAME_HZ
        last_frame = 0.0
        last_status = 0.0
        last_save = time.monotonic()
        while True:
            now = time.monotonic()
            media = self.media_files() if self.settings.get("media.enabled") else ()
            prev_phase = self.brain.phase
            frame = self.brain.tick(now, media)
            await self._flush()
            await self.check_forced_switch(now)
            if prev_phase == "sleeping" and self.brain.phase == "asleep":
                if self.pending_switch:
                    await self.finish_switch(now)
                else:
                    await self.on_fell_asleep()
            if now - last_frame >= frame_every:
                last_frame = now
                # Raw detections per camera, for the boxes on each camera view.
                fresh = self.fusion.fresh(now, sim=True) or self.fusion.fresh(now)
                frame["cams"] = {cid: [{k: t.get(k) for k in ("x", "y", "w", "h")} for t in ts]
                                 for cid, ts in fresh.items()}
                await self.broadcast(frame)
            if now - last_status >= 1.0:
                last_status = now
                if int(now) % 5 == 0:
                    await self.check_health()
                await self.broadcast(self.status(), roles=("ui",))
            if now - last_save >= 2.0:
                last_save = now
                self.settings.save()
            await asyncio.sleep(1.0 / TICK_HZ)

    async def on_startup(self, app):
        app["loop_task"] = asyncio.create_task(self.run_loop())

    async def on_cleanup(self, app):
        app["loop_task"].cancel()
        self.settings.save()


def page(path):
    async def handler(request):
        return web.FileResponse(path, headers={"Cache-Control": "no-cache"})
    return handler


def make_app(settings_path, eyes_dir, media_dir):
    hub = Hub(settings_path, eyes_dir, media_dir)
    app = web.Application(client_max_size=1024 ** 3)
    # The phone UI sits at the project root so GitHub Pages can serve it too
    # (as an in-browser demo, static/js/demo-hub.js).
    app.router.add_get("/", page(os.path.join(ROOT, "index.html")))
    app.router.add_get("/display", page(os.path.join(STATIC, "display.html")))
    app.router.add_get("/ws", hub.ws_handler)
    app.router.add_get("/api/media", hub.api_media_list)
    app.router.add_post("/api/media", hub.api_media_upload)
    app.router.add_delete("/api/media/{name}", hub.api_media_delete)
    app.router.add_put("/api/eyes/{id}", hub.api_eye_save)
    app.router.add_get("/api/eyes/{id}/builtin", hub.api_eye_builtin)
    app.router.add_post("/api/eyes/{id}/restore", hub.api_eye_restore)
    app.router.add_delete("/api/eyes/{id}", hub.api_eye_delete)
    app.router.add_get("/api/outputs", hub.api_outputs_get)
    app.router.add_post("/api/outputs", hub.api_outputs_set)
    app.router.add_get("/api/settings", hub.api_settings_get)
    app.router.add_put("/api/settings", hub.api_settings_put)
    app.router.add_static("/static", STATIC)
    app.router.add_static("/eyes", eyes_dir)
    app.router.add_static("/media", media_dir)
    app.on_startup.append(hub.on_startup)
    app.on_cleanup.append(hub.on_cleanup)

    @web.middleware
    async def no_cache(request, handler):
        resp = await handler(request)
        if request.path.startswith(("/static", "/eyes")):
            resp.headers["Cache-Control"] = "no-cache"
        return resp
    app.middlewares.append(no_cache)
    app["hub"] = hub
    return app


def main():
    ap = argparse.ArgumentParser(description="Projector eye hub")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--settings", default=os.path.join(ROOT, "config", "settings.json"))
    ap.add_argument("--eyes", default=os.path.join(ROOT, "eyes"))
    ap.add_argument("--media", default=os.path.join(ROOT, "media"))
    args = ap.parse_args()
    web.run_app(make_app(args.settings, args.eyes, args.media), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
