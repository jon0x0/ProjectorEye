"""Eye behaviour state machine.

Phases (what the projector shows):
  asleep   - black screen
  waking   - scripted wake sequence (renderer plays the keyframes)
  awake    - eye open; gaze/open/pupil targets streamed in frames
  sleeping - scripted sleep sequence
  media    - an animation file is playing instead of the eye

While awake the sub-state explains what the eye is doing:
  orienting (wake blinks) / tracking / holding / searching / manual / demo
"""
import math
import random



def seq_duration(seq):
    return max((k.get("t", 0.0) for k in seq), default=0.0)


class Brain:
    def __init__(self, settings, emit, now, rng=None):
        self.s = settings
        self.emit = emit
        self.rng = rng or random.Random()
        self.phase = "asleep"
        self.phase_t0 = now - 1e6   # no re-wake cooldown at startup
        self.phase_end = None
        self.sub = ""
        self.gaze = [0.0, 0.25]
        self.open = 1.0
        self.pupil = 0.5
        self.target = None         # smoothed target, gaze space [x, y] (cameras are fused by the hub)
        self.target_t = None
        self.src = None            # which camera placed it: {"cam": id, "xy": [x, y]}
        self.seen = {}             # every camera that sees that target: {id: [x, y]}
        self.targets = []
        self.last_motion = -1e9
        self.motion_first = None
        self.sensor_t = -1e9
        self.sim_until = -1e9
        self.pending_blinks = []
        self.next_blink = None
        self.focus_at = now
        self.search_next = 0.0
        self.demo_idx = 0
        self.demo_next = 0.0
        self.manual_gaze = [0.0, 0.25]
        self.manual_open = 1.0
        self.manual_pupil = 0.5
        self.media_until = None
        self.media_next = None
        self.media_item = None
        self.template_seqs = {}     # per-eye wake/sleep keyframes (override settings)
        self.scan = None            # patrol sweep in progress: (start, side)
        self.scan_next = 0.0
        self.hold_sleep = False     # an eye switch is in progress: don't let motion cut the sleep short

    # ----------------------------------------------------------- helpers
    @property
    def b(self):
        return self.s.get("behavior")

    @property
    def mode(self):
        # "random" behaves exactly like "auto"; the hub swaps eyes while asleep.
        m = self.s.get("mode")
        return "auto" if m == "random" else m

    def motion_present(self, now):
        return now - self.last_motion <= self.b["motion_gap_s"]

    def _set_phase(self, phase, now, **extra):
        self.phase = phase
        self.phase_t0 = now
        self.phase_end = None
        msg = {"type": "phase", "phase": phase}
        if phase in ("waking", "sleeping"):
            name = "wake" if phase == "waking" else "sleep"
            seq = (self.template_seqs or {}).get(name) or self.b["sequences"][name]
            self.phase_end = now + seq_duration(seq)
            msg["seq"] = seq
        msg.update(extra)
        self.emit(msg)

    def _blink(self):
        self.emit({"type": "blink", "duration": self.b["blink_duration_s"]})

    def _schedule_blink(self, now):
        b = self.b
        self.next_blink = now + self.rng.uniform(b["blink_min_s"], max(b["blink_min_s"], b["blink_max_s"]))

    # ------------------------------------------------------------ inputs
    def on_motion(self, targets, now, source="sensor"):
        if source == "sensor":
            self.sensor_t = now
            if now < self.sim_until:
                return
        else:
            self.sim_until = now + 0.8
        self.targets = targets
        if not targets:
            return
        pick = self._select(targets)
        point = [pick["x"], pick["y"]]
        self.src, self.seen = pick.get("src"), pick.get("seen") or {}
        tau = self.b["track_smoothing_s"]
        if self.target is None or self.target_t is None or now - self.last_motion > self.b["motion_gap_s"] * 3:
            self.target = point
        else:
            a = 1.0 if tau <= 0 else 1.0 - math.exp(-(now - self.target_t) / tau)
            self.target = [self.target[0] + (point[0] - self.target[0]) * a,
                           self.target[1] + (point[1] - self.target[1]) * a]
        self.target_t = now
        if not self.motion_present(now):
            self.motion_first = now
        self.last_motion = now

    def _select(self, targets):
        if self.b["target_select"] == "sticky" and self.target is not None:
            r = self.b["sticky_radius"] * 2      # setting is in frame widths; gaze space is 2 wide
            tx, ty = self.target
            near = [t for t in targets if math.hypot(t["x"] - tx, t["y"] - ty) <= r]
            if near:
                return min(near, key=lambda t: math.hypot(t["x"] - tx, t["y"] - ty))
        return max(targets, key=lambda t: t.get("area", 0))

    def command(self, name, now, **kw):
        """Commands from the control UI."""
        if name == "wake":
            if self.phase in ("asleep", "sleeping", "media"):
                if self.phase == "media":
                    self.emit({"type": "media", "action": "stop"})
                self.start_wake(now)
        elif name == "sleep":
            if self.phase in ("awake", "waking"):
                self.start_sleep(now)
            elif self.phase == "media":
                self.end_media(now, allow_wake=False)
        elif name == "blink":
            if self.phase == "awake":
                self._blink()
        elif name == "gaze":
            self.manual_gaze = [float(kw.get("x", 0)), float(kw.get("y", 0))]
        elif name == "open":
            self.manual_open = float(kw.get("value", 1))
        elif name == "pupil":
            self.manual_pupil = float(kw.get("value", 0.5))
        elif name == "media_play":
            self.start_media(kw.get("item"), now)
        elif name == "media_stop":
            if self.phase == "media":
                self.end_media(now, allow_wake=False)
        elif name == "media_ended":
            if self.phase == "media":
                self.end_media(now)

    def on_mode_change(self, now):
        mode = self.mode
        if mode in ("demo", "track", "manual") and self.phase == "asleep":
            if mode == "track":
                self._set_phase("awake", now)
                self.focus_at = now
            elif mode == "demo":
                self.start_wake(now)
        self.demo_next = now

    # ------------------------------------------------------ transitions
    def start_wake(self, now):
        self.pending_blinks = []
        self._set_phase("waking", now)

    def start_sleep(self, now):
        self.pending_blinks = []
        self._set_phase("sleeping", now)

    def _enter_awake(self, now, wake_blinks=True):
        self._set_phase("awake", now)
        b = self.b
        n = int(b["wake_blinks"]) if wake_blinks else 0
        gap = b["wake_blink_gap_s"]
        self.pending_blinks = [now + gap * (i + 1) for i in range(n)]
        self.focus_at = (self.pending_blinks[-1] + gap * 0.8) if n else now
        self._schedule_blink(self.focus_at)
        self.search_next = 0.0

    def start_media(self, item, now):
        media = self.s.get("media")
        if item is None:
            return False
        kind = "image" if item.lower().rsplit(".", 1)[-1] in ("gif", "png", "jpg", "jpeg", "webp") else "video"
        dur = media["image_duration_s"] if kind == "image" else media["max_duration_s"]
        self.media_item = item
        self.media_until = now + dur
        self.pending_blinks = []
        self._set_phase("media", now)
        self.emit({"type": "media", "action": "play", "item": item, "kind": kind,
                   "url": "/media/" + item, "duration": dur,
                   "fit": media["fit"], "audio": media["audio"]})
        return True

    def end_media(self, now, allow_wake=True):
        self.emit({"type": "media", "action": "stop"})
        self.media_item = None
        self.media_until = None
        self.media_next = None
        if allow_wake and self.mode == "auto" and self.motion_present(now) and self.s.get("media.wake_after"):
            self.start_wake(now)
        else:
            self._set_phase("asleep", now)

    def pick_media(self, available):
        items = self.s.get("media.items") or {}
        pool = []
        for name in available:
            cfg = items.get(name, {})
            if cfg.get("enabled", True):
                pool.append((name, max(0.0, float(cfg.get("weight", 1.0)))))
        total = sum(w for _, w in pool)
        if total <= 0:
            return None
        r = self.rng.uniform(0, total)
        for name, w in pool:
            r -= w
            if r <= 0:
                return name
        return pool[-1][0]

    # -------------------------------------------------------------- tick
    def tick(self, now, media_available=()):
        b = self.b
        mode = self.mode
        present = self.motion_present(now)
        if not present:
            self.motion_first = None
        confirmed = present and self.motion_first is not None and now - self.motion_first >= b["wake_confirm_s"]
        media = self.s.get("media")

        if self.phase == "media":
            if now >= self.media_until:
                self.end_media(now)
        elif self.phase == "waking":
            if now >= self.phase_end:
                self._enter_awake(now)
        elif self.phase == "sleeping":
            if mode in ("auto", "track") and confirmed and b["wake_interrupts_sleep"] and not self.hold_sleep:
                self._enter_awake(now, wake_blinks=False)
            elif now >= self.phase_end:
                self._set_phase("asleep", now)
                self.media_next = None
        elif self.phase == "asleep":
            if mode == "auto" and b.get("stay_awake") and not self.hold_sleep:
                # Always awake: wake on its own (an eye switch holds it asleep until the swap).
                self.start_wake(now)
            elif mode == "auto":
                if confirmed and now - self.phase_t0 >= b["rewake_cooldown_s"]:
                    if media["enabled"] and media_available and self.rng.random() < media["on_motion_chance"]:
                        if self.start_media(self.pick_media(media_available), now):
                            return self.frame(now)
                    self.start_wake(now)
                elif media["enabled"] and media["random_when_asleep"] and media_available:
                    if self.media_next is None:
                        self.media_next = now + self.rng.uniform(
                            media["asleep_interval_min_s"],
                            max(media["asleep_interval_min_s"], media["asleep_interval_max_s"]))
                    elif now >= self.media_next:
                        self.start_media(self.pick_media(media_available), now)
            elif mode == "track":
                self._enter_awake(now, wake_blinks=False)
            elif mode == "demo":
                self.start_wake(now)
        elif self.phase == "awake":
            self._awake(now, present)
        return self.frame(now)

    def _awake(self, now, present):
        b = self.b
        mode = self.mode
        idle = now - self.last_motion

        # Blinks: scripted wake blinks first, then random ones.
        if self.pending_blinks and now >= self.pending_blinks[0]:
            self.pending_blinks.pop(0)
            self._blink()
        elif not self.pending_blinks and self.next_blink is not None and now >= self.next_blink:
            if mode != "manual" or b["manual_blinks"]:
                self._blink()
                if self.rng.random() < b["double_blink_chance"]:
                    self.pending_blinks.append(now + b["blink_duration_s"] * 1.8)
            self._schedule_blink(now)

        if mode == "manual":
            self.sub = "manual"
            self.gaze = list(self.manual_gaze)
            self.open = self.manual_open
            self.pupil = self.manual_pupil
            return
        if mode == "demo":
            self.sub = "demo"
            pos = self.s.get("demo.positions") or [{"x": 0, "y": 0.3}]
            if now >= self.demo_next:
                self.demo_idx = (self.demo_idx + 1) % len(pos)
                self.demo_next = now + self.s.get("demo.dwell_s")
            p = pos[self.demo_idx % len(pos)]
            self.gaze = [p["x"], p["y"]]
            self.open = b["open_tracking"]
            self.pupil = b["pupil_idle"]
            return

        if now < self.focus_at:
            self.sub = "orienting"
            self.gaze = [0.0, b["rest_gaze_y"]]
            self.open = b["open_idle"]
            self.pupil = b["pupil_idle"]
        elif present and self.target is not None:
            self.sub = "tracking"
            self.gaze = list(self.target)
            self.open = b["open_tracking"]
            self.pupil = b["pupil_tracking"]
        elif idle < b["hold_s"] or mode == "track":
            self.sub = "holding"
            self.open = b["open_tracking"]
            self.pupil = b["pupil_tracking"]
        elif b.get("stay_awake") and idle >= b["hold_s"]:
            self._patrol(now, b)
        elif idle < b["hold_s"] + b["search_s"]:
            self.sub = "searching"
            if now >= self.search_next:
                self.gaze = [self.rng.uniform(-1, 1) * b["search_range_x"],
                             b["rest_gaze_y"] + self.rng.uniform(-1, 1) * b["search_range_y"]]
                self.search_next = now + self.rng.uniform(b["search_glance_min_s"], b["search_glance_max_s"])
            drowsy = idle > b["hold_s"] + b["search_s"] * 0.6
            self.open = b["open_drowsy"] if drowsy else b["open_idle"]
            self.pupil = b["pupil_idle"]
        else:
            self.start_sleep(now)

    def _patrol(self, now, b):
        """Always awake, nothing to follow: random darts and, once in a
        while, a slow sweep across the scene. Motion takes over at once."""
        self.open = b["open_idle"]
        self.pupil = b["pupil_idle"]
        if not b.get("patrol_scan", True):
            self.scan = None
        elif self.scan is None and now >= self.scan_next:
            if self.scan_next:      # first entry only schedules the first sweep
                side = self.rng.choice((-1, 1))
                self.scan = (now, side)
            self.scan_next = now + self.rng.uniform(0.6, 1.4) * b["patrol_scan_every_s"]
        if self.scan is not None:
            t0, side = self.scan
            dur = max(1.0, b["patrol_scan_s"])
            k = (now - t0) / dur
            if k >= 1:
                self.scan = None
                self.search_next = now + 0.8
            else:
                self.sub = "scanning"
                e = 0.5 - 0.5 * math.cos(math.pi * k)          # ease in/out
                x = side * b["search_range_x"] * (1 - 2 * e)   # one side to the other
                self.gaze = [x, b["rest_gaze_y"] + 0.15 * b["search_range_y"] * math.sin(math.pi * k)]
                return
        self.sub = "patrolling"
        if now >= self.search_next:
            self.gaze = [self.rng.uniform(-1, 1) * b["search_range_x"],
                         b["rest_gaze_y"] + self.rng.uniform(-1, 1) * b["search_range_y"]]
            self.search_next = now + self.rng.uniform(b["patrol_dart_min_s"], b["patrol_dart_max_s"])

    def frame(self, now):
        return {
            "type": "frame",
            "phase": self.phase,
            "sub": self.sub if self.phase == "awake" else "",
            "mode": self.mode,
            "gaze": [round(self.gaze[0], 4), round(self.gaze[1], 4)],
            "open": self.open,
            "pupil": self.pupil,
            "target": [round(self.target[0], 4), round(self.target[1], 4)] if self.target else None,
            "src": self.src if self.motion_present(now) else None,
            "motion": self.motion_present(now),
            "targets": [{"x": round(t["x"], 4), "y": round(t["y"], 4), "cam": (t.get("src") or {}).get("cam")}
                        for t in self.targets] if self.motion_present(now) else [],
            "media": self.media_item,
        }
