"""Frame sources: Raspberry Pi camera, an RTSP(S) network camera, any OpenCV
capture, or a synthetic scene."""
import collections
import math
import re
import subprocess
import threading
import time
from urllib.parse import quote, urlsplit, urlunsplit

import cv2
import numpy as np


class Picamera2Source:
    def __init__(self, width=640, height=480, fps=15, hflip=False, vflip=False, full_fov=True):
        from picamera2 import Picamera2
        from libcamera import Transform

        self.cam = Picamera2()
        kwargs = dict(main={"size": (width, height), "format": "RGB888"},
                      transform=Transform(hflip=hflip, vflip=vflip),
                      controls={"FrameRate": fps}, buffer_count=4)
        if full_fov:
            # Camera Module 2 (IMX219): the 1640x1232 binned mode keeps the
            # whole field of view. Other sensors fall back to the default.
            try:
                cfg = self.cam.create_video_configuration(raw={"size": (1640, 1232)}, **kwargs)
                self.cam.configure(cfg)
            except Exception:
                self.cam.configure(self.cam.create_video_configuration(**kwargs))
        else:
            self.cam.configure(self.cam.create_video_configuration(**kwargs))
        self.cam.start()
        self.name = "picamera2"

    def read(self):
        # "RGB888" in picamera2 is BGR byte order, which is what OpenCV wants.
        return self.cam.capture_array("main")

    def close(self):
        self.cam.stop()


class OpenCVSource:
    def __init__(self, spec, width=640, height=480, fps=15, hflip=False, vflip=False):
        dev = int(spec) if str(spec).isdigit() else spec
        self.cap = cv2.VideoCapture(dev)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.cap.set(cv2.CAP_PROP_FPS, fps)
        self.flip = {(True, False): 1, (False, True): 0, (True, True): -1}.get((hflip, vflip))
        self.name = f"opencv:{spec}"
        self.period = 1.0 / fps
        self.last = 0.0

    def read(self):
        ok, frame = self.cap.read()
        if not ok:
            time.sleep(0.2)
            return None
        if self.flip is not None:
            frame = cv2.flip(frame, self.flip)
        # Video files play as fast as they decode; pace them.
        wait = self.period - (time.monotonic() - self.last)
        if wait > 0:
            time.sleep(wait)
        self.last = time.monotonic()
        return frame

    def close(self):
        self.cap.release()


def mask_url(url):
    """The URL with any password replaced, for logs and the phone UI."""
    return re.sub(r"(//[^:/@]+:)[^@]*@", r"\1***@", url)


def rtsp_url_with_login(url, user=None, password=None):
    u = urlsplit(url)
    if not user or u.scheme not in ("rtsp", "rtsps") or not u.hostname:
        return url
    login = quote(user, safe="") + (":" + quote(password, safe="") if password else "")
    return urlunsplit((u.scheme, f"{login}@{u.hostname}" + (f":{u.port}" if u.port else ""), u.path, u.query, u.fragment))


class RTSPSource:
    """A network camera (rtsp:// or rtsps://) decoded by an ffmpeg subprocess.

    A reader thread keeps only the newest frame, so a slow consumer never
    builds up latency, and reconnects whenever the stream drops. Frames are
    scaled to `width` (height follows the camera's aspect ratio).
    """

    def __init__(self, url, width=640, fps=15, hflip=False, vflip=False, **_):
        self.url, self.width, self.fps = url, width, fps
        self.flip = {(True, False): 1, (False, True): 0, (True, True): -1}.get((hflip, vflip))
        self.name = "rtsp:" + mask_url(url)
        # TCP survives Wi-Fi far better than UDP; rtsps is TCP only anyway.
        # -timeout (us): give up on a camera that stops sending instead of blocking forever.
        self.transport = ["-rtsp_transport", "tcp", "-timeout", "10000000"] if url.startswith(("rtsp://", "rtsps://")) else []
        self.low_latency = ["-fflags", "nobuffer"] if self.transport else []   # breaks file input
        self.status = "connecting"
        self.size = None
        self.frame = None
        self.seq = 0
        self.cond = threading.Condition()
        self.proc = None
        self.running = True
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _probe(self):
        cmd = ["ffprobe", "-v", "error", *self.transport, "-select_streams", "v:0",
               "-show_entries", "stream=width,height", "-of", "csv=p=0", self.url]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        m = re.search(r"(\d+),(\d+)", r.stdout)
        if not m:
            raise OSError((r.stderr.strip().splitlines() or ["no video stream"])[-1].replace(self.url, mask_url(self.url)))
        return int(m.group(1)), int(m.group(2))

    def _run(self):
        backoff = 2.0
        while self.running:
            try:
                sw, sh = self._probe()
                w = self.width
                h = max(2, int(round(sh * w / sw / 2)) * 2)
                cmd = ["ffmpeg", "-nostdin", "-loglevel", "error", *self.transport, *self.low_latency,
                       "-flags", "low_delay", "-threads", "2", "-i", self.url,
                       "-an", "-vf", f"fps={self.fps},scale={w}:{h}", "-pix_fmt", "bgr24",
                       "-f", "rawvideo", "pipe:1"]
                proc = self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
                tail = collections.deque(maxlen=4)
                # Drain stderr so a chatty stream can never fill the pipe and stall ffmpeg.
                threading.Thread(target=lambda: [tail.append(ln) for ln in proc.stderr], daemon=True).start()
                self.size = (w, h)
                self.status = f"streaming {sw}x{sh} -> {w}x{h}"
                print(f"rtsp: {mask_url(self.url)} {self.status}")
                n = w * h * 3
                while self.running:
                    buf = self._read_exact(proc.stdout, n)
                    if buf is None:
                        break
                    img = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
                    if self.flip is not None:
                        img = cv2.flip(img, self.flip)
                    with self.cond:
                        self.frame = img
                        self.seq += 1
                        self.cond.notify_all()
                    backoff = 2.0
                self._kill()
                msg = (tail[-1].decode(errors="replace").strip() if tail else "") or "stream ended"
                raise OSError(msg.replace(self.url, mask_url(self.url)))
            except (OSError, subprocess.SubprocessError, ValueError) as e:
                self._kill()
                if not self.running:
                    break
                self.status = f"error: {e}; retry in {backoff:.0f}s"
                print(f"rtsp: {self.status}")
                end = time.monotonic() + backoff
                while self.running and time.monotonic() < end:
                    time.sleep(0.2)
                backoff = min(30.0, backoff * 1.5)

    @staticmethod
    def _read_exact(pipe, n):
        out = bytearray()
        while len(out) < n:
            try:
                chunk = pipe.read(n - len(out))
            except (OSError, ValueError):
                return None
            if not chunk:
                return None
            out += chunk
        return bytes(out)

    def _kill(self):
        p, self.proc = self.proc, None
        if p and p.poll() is None:
            p.kill()
            try:
                p.wait(3)
            except subprocess.TimeoutExpired:
                pass

    def read(self):
        with self.cond:
            seq = self.seq
            self.cond.wait_for(lambda: self.seq != seq or not self.running, timeout=1.0)
            return self.frame if self.seq != seq else None

    def close(self):
        self.running = False
        self._kill()
        with self.cond:
            self.cond.notify_all()


class SyntheticSource:
    """A noisy static scene with a figure that walks, stops and leaves.

    Lets the whole chain run on a laptop or in WSL without a camera.
    """

    def __init__(self, width=640, height=480, fps=15, **_):
        self.w, self.h, self.fps = width, height, fps
        rng = np.random.default_rng(1)
        bg = rng.integers(40, 90, (height, width, 3), dtype=np.uint8)
        self.bg = cv2.GaussianBlur(bg, (0, 0), 6)
        cv2.rectangle(self.bg, (0, int(height * 0.6)), (width, height), (60, 70, 60), -1)
        self.t0 = time.monotonic()
        self.next = time.monotonic()
        self.name = "synthetic"

    def read(self):
        now = time.monotonic()
        if now < self.next:
            time.sleep(self.next - now)
        self.next = max(now, self.next) + 1.0 / self.fps
        t = (time.monotonic() - self.t0) % 40.0
        img = self.bg.copy()
        # 0-16 s walk left->right with a pause, 16-24 s walk back, 24-40 s empty.
        if t < 16:
            x = 0.1 + 0.4 * min(1.0, t / 6) + (0.4 * (t - 10) / 6 if t > 10 else 0)
            depth = 0.7
        elif t < 24:
            x = 0.9 - 0.8 * (t - 16) / 8
            depth = 0.85 + 0.1 * math.sin((t - 16) / 8 * math.pi)
        else:
            x = None
        if x is not None:
            ph = int(self.h * 0.35 * depth)
            pw = int(ph * 0.35)
            cx = int(x * self.w)
            feet = int(self.h * depth)
            bob = int(3 * math.sin(t * 9))
            cv2.rectangle(img, (cx - pw // 2, feet - ph + bob), (cx + pw // 2, feet), (170, 150, 140), -1)
            cv2.circle(img, (cx, feet - ph - pw // 3 + bob), pw // 3, (150, 170, 200), -1)
        noise = np.random.default_rng().integers(-6, 7, img.shape, dtype=np.int16)
        return np.clip(img.astype(np.int16) + noise, 0, 255).astype(np.uint8)

    def close(self):
        pass


def open_source(spec, url=None, user=None, password=None, **kw):
    if spec == "rtsp" or spec.startswith(("rtsp://", "rtsps://")):
        kw.pop("full_fov", None)
        kw.pop("height", None)
        return RTSPSource(rtsp_url_with_login(url or spec, user, password), **kw)
    if spec == "picamera2":
        return Picamera2Source(**kw)
    if spec == "synthetic":
        return SyntheticSource(**kw)
    if spec.startswith("opencv:"):
        kw.pop("full_fov", None)
        return OpenCVSource(spec.split(":", 1)[1], **kw)
    raise ValueError(f"unknown source {spec!r}")
