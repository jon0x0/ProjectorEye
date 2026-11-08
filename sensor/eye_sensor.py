"""Camera Pi service: detect motion and stream targets to the eye hub.

  python -m sensor --hub ws://eye-display.local:8080/ws --source picamera2

Runs one worker per camera the hub asks for (Settings > cameras): the Pi
camera module and/or network (RTSP/RTSPS) cameras. Detection settings,
camera logins and each camera's ignore zones live on the hub (phone UI) and
are pushed here. Until the hub sends a config, a single camera "cam1" runs
from this Pi's own defaults (--source, and rtsp_url / rtsp_user in
sensor_config.json with the password in ~/.config/eye-sensor/rtsp_password).

Each camera's annotated MJPEG preview is served on --preview-port:
/stream.mjpg?cam=<id> and /snapshot.jpg?cam=<id>.
"""
import argparse
import asyncio
import json
import os
import threading
import time

import aiohttp
import cv2
from aiohttp import web

from .motion import Detector, annotate
from .sources import open_source

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SECRET = os.path.expanduser("~/.config/eye-sensor/rtsp_password")


def read_secret(path):
    """Network camera password, kept out of the project folder (mode 600)."""
    try:
        with open(os.path.expanduser(path), "r", encoding="utf-8") as f:
            return f.read().strip() or None
    except (OSError, TypeError):
        return None


class Camera:
    """One camera: its own capture thread, detector and preview."""

    def __init__(self, sensor, cid):
        self.sensor, self.id = sensor, cid
        self.detector = Detector({})
        self.jpeg = None
        self.event = asyncio.Event()      # created on the event loop
        self.viewers = 0
        self.fps = 0.0
        self.frame_size = None
        self.status = None
        self._last_status = None
        self._status_t = 0.0
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    # What this camera should be running, from the hub's config.
    def cfg(self):
        return (self.sensor.cfg.get("cameras") or {}).get(self.id)

    def active(self):
        c = self.cfg()
        return self.sensor.running and c is not None and c.get("enabled", True)

    def wanted(self):
        """Any change here (source, URL, login) reopens the camera."""
        c = self.cfg() or {}
        spec = self.sensor.resolve_source(c.get("source"))
        if spec != "rtsp":
            return (spec, None)
        a = self.sensor.args
        if c.get("rtsp_url"):
            login = (c["rtsp_url"].strip(), (c.get("rtsp_user") or "").strip() or None, c.get("rtsp_password") or None)
        else:
            login = (a.rtsp_url, a.rtsp_user, read_secret(a.rtsp_password_file))
        return (spec, login)

    def detect_cfg(self):
        c = self.cfg() or {}
        return dict(self.sensor.cfg, exclusions=c.get("exclusions") or [])

    def set_status(self, spec, status):
        if (spec, status) != self._last_status or time.monotonic() - self._status_t > 5:
            self._last_status = (spec, status)
            self._status_t = time.monotonic()
            self.status = status
            self.sensor.post({"type": "sensor_status", "cam": self.id, "source": spec, "status": status,
                              "sources": self.sensor.available_sources()})

    def run(self):
        a = self.sensor.args
        while self.active():
            want = self.wanted()
            spec, login = want
            try:
                if spec == "rtsp" and not (login and login[0]):
                    raise ValueError("no network camera URL set (Camera tab)")
                url, user, password = login or (None, None, None)
                src = open_source(spec, width=a.width, height=a.height, fps=a.fps, hflip=a.hflip, vflip=a.vflip,
                                  full_fov=not a.no_full_fov, url=url, user=user, password=password)
            except Exception as e:      # camera missing, busy or not set up: report and retry
                if self._last_status != (spec, f"error: {e}"):
                    print(f"{self.id} {spec}: {e}")
                self.set_status(spec, f"error: {e}")
                end = time.monotonic() + 5     # retry, or sooner if the settings change
                while self.active() and time.monotonic() < end and self.wanted() == want:
                    time.sleep(0.2)
                continue
            print(f"{self.id}: {src.name} {a.width}x{a.height}@{a.fps}")
            self.detector.reset()
            try:
                self.capture(src, spec, want)
            finally:
                src.close()
        self.sensor.post({"type": "sensor_status", "cam": self.id, "source": None, "status": "off"})
        print(f"{self.id}: stopped")

    def capture(self, src, spec, want):
        last_send = 0.0
        last_preview = 0.0
        was_empty = True
        n, t_fps = 0, time.monotonic()
        while self.active() and self.wanted() == want:
            self.set_status(spec, getattr(src, "status", "streaming"))
            frame = src.read()
            if frame is None:
                continue
            if frame.ndim == 3 and frame.shape[2] == 4:
                frame = cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)
            self.frame_size = [frame.shape[1], frame.shape[0]]
            now = time.monotonic()
            n += 1
            if now - t_fps >= 2.0:
                self.fps = n / (now - t_fps)
                n, t_fps = 0, now
            cfg = self.detect_cfg()
            self.detector.update(cfg)
            targets, mask = ([], None)
            if cfg.get("enabled", True):
                targets, mask = self.detector.process(frame)
            # Send every frame with motion; heartbeat otherwise.
            if targets or not was_empty or now - last_send > 0.5:
                self.sensor.post({"type": "motion", "cam": self.id, "targets": targets, "fps": round(self.fps, 1),
                                  "frame": self.frame_size, "t": time.time()})
                last_send = now
            was_empty = not targets
            if self.viewers and now - last_preview >= 1.0 / max(1, cfg.get("preview_fps", 6)):
                last_preview = now
                img = annotate(frame, targets, cfg, mask)
                ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])
                if ok:
                    self.sensor.loop.call_soon_threadsafe(self._set_jpeg, buf.tobytes())

    def _set_jpeg(self, data):
        self.jpeg = data
        self.event.set()
        self.event = asyncio.Event()


class Sensor:
    def __init__(self, args):
        self.args = args
        # Until the hub says otherwise: one camera from this Pi's defaults.
        self.cfg = {"enabled": True, "preview_fps": 6, "cameras": {"cam1": {"source": "default"}}}
        self.cams = {}
        self.loop = None
        self.queue = None
        self.running = True
        self._sources = None

    def available_sources(self):
        if self._sources is None:
            out = [self.args.source]
            if self.args.source != "picamera2":
                try:
                    import picamera2  # noqa: F401
                    out.append("picamera2")
                except ImportError:
                    pass
            if "rtsp" not in out:
                out.append("rtsp")      # configured from the phone UI (or sensor_config.json)
            self._sources = out
        return self._sources

    def resolve_source(self, want):
        """A camera's source choice, with "default" meaning this Pi's own."""
        if not want or want == "default" or want not in self.available_sources():
            return self.args.source
        return want

    def apply_config(self, cfg):
        if "cameras" not in cfg:
            # An older hub: one camera, described by the flat sensor settings.
            cfg = dict(cfg, cameras={"cam1": {k: cfg.get(k) for k in
                                              ("source", "rtsp_url", "rtsp_user", "rtsp_password", "exclusions")}})
        self.cfg = cfg
        self.sync_cameras()

    def sync_cameras(self):
        """Start workers for newly enabled cameras; finished ones are dropped."""
        for cid, c in (self.cfg.get("cameras") or {}).items():
            cam = self.cams.get(cid)
            if c.get("enabled", True) and (cam is None or not cam.thread.is_alive()):
                self.cams[cid] = Camera(self, cid)
        for cid in [k for k, cam in self.cams.items() if not cam.thread.is_alive() and not cam.active()]:
            del self.cams[cid]

    def post(self, msg):
        def put():
            if self.queue.qsize() > 60:
                self.queue.get_nowait()
            self.queue.put_nowait(msg)
        self.loop.call_soon_threadsafe(put)

    # ------------------------------------------------------------ hub link
    async def hub_link(self):
        backoff = 1.0
        async with aiohttp.ClientSession() as session:
            while self.running:
                try:
                    async with session.ws_connect(self.args.hub, heartbeat=10) as ws:
                        print(f"connected to hub {self.args.hub}")
                        backoff = 1.0
                        await ws.send_json({"type": "hello", "role": "sensor", "preview_port": self.args.preview_port,
                                            "source": self.args.source, "sources": self.available_sources()})
                        while not self.queue.empty():
                            self.queue.get_nowait()
                        for cam in self.cams.values():
                            cam._last_status = None      # resend each camera's status
                        sender = asyncio.create_task(self._sender(ws))
                        try:
                            async for m in ws:
                                if m.type != aiohttp.WSMsgType.TEXT:
                                    continue
                                msg = json.loads(m.data)
                                if msg.get("type") == "config":
                                    self.apply_config(msg.get("sensor") or {})
                        finally:
                            sender.cancel()
                except (aiohttp.ClientError, OSError) as e:
                    print(f"hub link: {e}; retrying in {backoff:.0f}s")
                await asyncio.sleep(backoff)
                backoff = min(10.0, backoff * 1.5)

    async def _sender(self, ws):
        while True:
            msg = await self.queue.get()
            await ws.send_str(json.dumps(msg))

    # ------------------------------------------------------------- preview
    def camera(self, request):
        cid = request.query.get("cam")
        if cid in self.cams:
            return self.cams[cid]
        return next(iter(self.cams.values()), None) if not cid else None

    async def stream(self, request):
        cam = self.camera(request)
        if cam is None:
            return web.Response(status=404, text="no such camera")
        resp = web.StreamResponse(headers={
            "Content-Type": "multipart/x-mixed-replace; boundary=frame",
            "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*"})
        await resp.prepare(request)
        cam.viewers += 1
        try:
            while True:
                await cam.event.wait()
                data = cam.jpeg
                await resp.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                 + str(len(data)).encode() + b"\r\n\r\n" + data + b"\r\n")
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        finally:
            cam.viewers -= 1
        return resp

    async def snapshot(self, request):
        cam = self.camera(request)
        if cam is None:
            return web.Response(status=404, text="no such camera")
        cam.viewers += 1
        try:
            await asyncio.wait_for(cam.event.wait(), 3)
        except asyncio.TimeoutError:
            pass
        finally:
            cam.viewers -= 1
        if not cam.jpeg:
            return web.Response(status=503, text="no frame yet")
        return web.Response(body=cam.jpeg, content_type="image/jpeg",
                            headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"})

    async def status(self, request):
        cams = {cid: {"fps": c.fps, "frame": c.frame_size, "viewers": c.viewers, "status": c.status,
                      "source": c.wanted()[0]} for cid, c in self.cams.items()}
        cfg = {k: v for k, v in self.cfg.items() if k != "cameras"}
        return web.json_response({"cameras": cams, "config": cfg})

    async def main(self):
        self.loop = asyncio.get_running_loop()
        self.queue = asyncio.Queue()
        app = web.Application()
        app.router.add_get("/stream.mjpg", self.stream)
        app.router.add_get("/snapshot.jpg", self.snapshot)
        app.router.add_get("/", self.status)
        runner = web.AppRunner(app)
        await runner.setup()
        await web.TCPSite(runner, "0.0.0.0", self.args.preview_port).start()
        print(f"preview on http://0.0.0.0:{self.args.preview_port}/stream.mjpg?cam=<id>")
        self.sync_cameras()
        try:
            await asyncio.gather(self.hub_link(), self.housekeeping())
        finally:
            self.running = False

    async def housekeeping(self):
        while self.running:
            await asyncio.sleep(2)
            self.sync_cameras()


def main():
    defaults = {}
    cfg_path = os.path.join(HERE, "sensor_config.json")
    if os.path.exists(cfg_path):
        with open(cfg_path, "r", encoding="utf-8") as f:
            defaults = json.load(f)
    ap = argparse.ArgumentParser(description="Projector eye motion sensor")
    ap.add_argument("--hub", default=defaults.get("hub", "ws://eye-display.local:8080/ws"))
    ap.add_argument("--source", default=defaults.get("source", "picamera2"),
                    help="this Pi's default camera: picamera2 | rtsp | synthetic | opencv:<index or file/url>")
    ap.add_argument("--rtsp-url", default=defaults.get("rtsp_url"), help="rtsp:// or rtsps:// stream, no password")
    ap.add_argument("--rtsp-user", default=defaults.get("rtsp_user"))
    ap.add_argument("--rtsp-password-file", default=defaults.get("rtsp_password_file", DEFAULT_SECRET))
    ap.add_argument("--width", type=int, default=defaults.get("width", 640))
    ap.add_argument("--height", type=int, default=defaults.get("height", 480))
    ap.add_argument("--fps", type=int, default=defaults.get("fps", 15))
    ap.add_argument("--hflip", action="store_true", default=defaults.get("hflip", False))
    ap.add_argument("--vflip", action="store_true", default=defaults.get("vflip", False))
    ap.add_argument("--no-full-fov", action="store_true", default=not defaults.get("full_fov", True))
    ap.add_argument("--preview-port", type=int, default=defaults.get("preview_port", 8081))
    args = ap.parse_args()
    try:
        asyncio.run(Sensor(args).main())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
