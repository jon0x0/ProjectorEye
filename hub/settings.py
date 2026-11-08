"""Persistent settings for the eye hub.

Settings are one JSON document. Saved values are deep-merged over DEFAULTS so
new keys added in later versions appear automatically.
"""
import copy
import json
import os
import threading

# Keyframes for scripted phases. Each keyframe: t (s) plus any of
# open (0 closed .. 1 open, >1 wide), bright (0..1), pupil (0 small .. 1 large),
# gx/gy (gaze offset added to the live gaze), ease (linear|in|out|inout).
# The t=0 keyframe is replaced by the renderer's current values so a
# sequence always starts smoothly from wherever the eye is.
WAKE_SEQUENCE = [
    {"t": 0.0, "open": 0.0, "bright": 0.0, "pupil": 0.9},
    {"t": 0.9, "open": 0.0, "bright": 1.0},
    {"t": 1.5, "open": 0.22, "ease": "out"},
    {"t": 2.0, "open": 0.17},
    {"t": 2.3, "open": 0.02, "ease": "in"},
    {"t": 2.8, "open": 0.02},
    {"t": 3.3, "open": 1.1, "pupil": 0.75, "ease": "out"},
    {"t": 4.2, "open": 1.0, "pupil": 0.45, "ease": "inout"},
]

SLEEP_SEQUENCE = [
    {"t": 0.0, "open": 1.0, "bright": 1.0, "pupil": 0.5, "gy": 0.0},
    {"t": 1.3, "open": 0.5, "gy": 0.25, "ease": "inout"},
    {"t": 1.8, "open": 0.72, "ease": "out"},
    {"t": 3.0, "open": 0.28, "ease": "inout"},
    {"t": 3.3, "open": 0.4},
    {"t": 4.3, "open": 0.0, "pupil": 0.85, "gy": 0.35, "ease": "in"},
    {"t": 4.8, "bright": 1.0},
    {"t": 6.0, "bright": 0.0, "ease": "inout"},
]

DEFAULTS = {
    # auto: motion driven | random: auto, with a different eye after each
    # sleep | manual: phone controls the eye | demo: cycle
    # positions | track: follow motion continuously, never sleeps (for
    # calibration testing)
    "mode": "track",            # current default: follow motion, never sleep
    "behavior": {
        "stay_awake": True,           # Auto/Random: wake on its own and never fall asleep from lack of motion
        "wake_confirm_s": 0.4,        # motion must persist this long to wake
        "motion_gap_s": 0.35,         # dropouts shorter than this are ignored
        "rewake_cooldown_s": 2.0,     # minimum time asleep before waking again
        "wake_interrupts_sleep": True,
        "wake_blinks": 2,
        "wake_blink_gap_s": 0.7,
        "hold_s": 3.0,                # stare at the last position after losing motion
        "search_s": 4.0,              # then glance around for this long
        "search_range_x": 0.7,
        "search_range_y": 0.35,
        "search_glance_min_s": 0.7,
        "search_glance_max_s": 1.8,
        # Always awake with nothing to follow: random darts, plus a slow
        # side-to-side "security camera" sweep now and then.
        "patrol_scan": True,          # security scan mode on/off (off: darts only)
        "patrol_dart_min_s": 1.2,
        "patrol_dart_max_s": 4.0,
        "patrol_scan_every_s": 30.0,
        "patrol_scan_s": 5.0,
        "rest_gaze_y": 0.25,          # where the eye looks when unfocused
        "track_smoothing_s": 0.12,    # camera point smoothing time constant
        "target_select": "sticky",    # sticky | largest
        "sticky_radius": 0.2,
        "blink_min_s": 3.0,
        "blink_max_s": 9.0,
        "double_blink_chance": 0.2,
        "blink_duration_s": 0.2,
        "manual_blinks": True,
        "open_tracking": 1.0,
        "open_idle": 0.85,
        "open_drowsy": 0.6,
        "pupil_tracking": 0.3,
        "pupil_idle": 0.55,
        "lid_follow": 0.35,           # upper lid drops when looking down
        "saccade_threshold": 0.12,    # gaze jumps larger than this are fast saccades
        "saccade_speed": 14.0,
        "pursuit_s": 0.12,            # smooth pursuit time constant
        "micro_saccade": 0.015,
        "sequences": {"wake": WAKE_SEQUENCE, "sleep": SLEEP_SEQUENCE},
    },
    "calibration": {
        # Base mapping from camera (0..1) to gaze (-1..1); used when fewer
        # than `points` are captured, and as the prior for 1-2 points.
        "invert_x": True,
        "invert_y": False,
        "x_gain": 1.0,
        "y_gain": 0.6,
        "x_offset": 0.0,
        "y_offset": 0.35,
        "use_points": True,
        "model": "affine",            # affine (>=3) | homography (>=4) | bilinear (>=4) | quadratic (>=6)
        "clamp": True,
        "points": [],                 # [{"gaze":[x,y], "cams":{cam_id:[x,y], ...}}]
    },
    # Motion cameras (all on the camera Pi), see hub/fusion.py. Each: name,
    # enabled, source, rtsp_url, rtsp_user, exclusions, align, opacity.
    "cameras": {"cam1": {}},
    "fusion": {
        "priority": "cam1",       # where both cameras see someone, this one sets the position
        "merge_radius": 0.25,     # gaze units: detections this close are the same person
        "divider": {"enabled": False, "a": [0.0, -1.0], "b": [0.0, 1.0], "left": "cam1", "right": "cam2"},
        "migrated": False,
    },
    "demo": {
        "dwell_s": 2.5,
        "positions": [
            {"name": "Center", "x": 0.0, "y": 0.3},
            {"name": "Left", "x": -0.8, "y": 0.4},
            {"name": "Right", "x": 0.8, "y": 0.4},
            {"name": "Down", "x": 0.0, "y": 0.9},
            {"name": "Up", "x": 0.0, "y": -0.5},
        ],
    },
    "projection": {
        "cx": 0.5,          # base-centre of the half circle, fraction of screen width
        "cy": 0.85,         # fraction of screen height
        "radius": 0.4,      # fraction of screen width
        "rotation": 0.0,    # degrees
        "flip_h": False,    # rear projection usually needs this
        "flip_v": False,
        "feather": 0.015,   # soft edge, fraction of radius
        "brightness": 1.0,
        "outline": False,   # alignment overlay
        "render_scale": 0.6,      # 1080p on a Pi 4: ~16-18 fps at 0.6 vs 6-8 at 1.0
        "shape": "full",          # full (whole screen, no mask) | semicircle window
        "full_cy": 0.46,          # full-screen mode: eye height (fraction of screen)
        "keystone": {"tl": [0.0, 0.0], "tr": [0.0, 0.0], "br": [0.0, 0.0], "bl": [0.0, 0.0]},
    },
    "eye": {
        "template": "eye-of-sauron",
        "boot_template": "eye-of-sauron",   # eye shown after every start-up; "" = carry on with the last one
        "random_every": 1,        # random mode: new eye after every N sleeps
        "switch_transition": "sleep_wake",   # "Switch now": sleep_wake (fade out, new eye wakes) | instant
        "random_force_min": 0,    # random mode: switch at least this often (minutes), even with motion; 0 = off
        "random_awake_min": 10,   # random mode while always awake (it never sleeps): new eye this often (minutes)
        "random_exclude": [],     # eye ids left out of the random pick
    },
    "sensor": {
        "enabled": True,
        "method": "mog2",         # mog2 | diff
        "threshold": 25,
        "min_area": 0.002,        # fraction of frame
        "max_area": 0.45,         # larger => lighting change, ignored
        "blur": 5,
        "learning_rate": 0.01,
        "dilate": 3,
        "merge_distance": 0.06,
        "aim_y": 0.35,            # 0 top of box, 1 bottom
        "max_targets": 4,
        "detect_width": 320,
        "preview_fps": 6,
        "preview_mask": False,
    },
    "media": {
        "enabled": False,
        "random_when_asleep": True,
        "asleep_interval_min_s": 120,
        "asleep_interval_max_s": 600,
        "on_motion_chance": 0.0,
        "wake_after": True,
        "max_duration_s": 60,
        "image_duration_s": 6,
        "audio": False,
        "fit": "cover",           # cover | contain
        "items": {},              # filename -> {"enabled": bool, "weight": float}
    },
}


def deep_merge(base, over):
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def _coerce(old, value):
    """Coerce value to the type of the existing setting where sensible."""
    if isinstance(old, bool):
        if isinstance(value, str):
            return value.lower() in ("1", "true", "yes", "on")
        return bool(value)
    if isinstance(old, int) and not isinstance(old, bool) and isinstance(value, (int, float, str)):
        f = float(value)
        return int(f) if f.is_integer() else f
    if isinstance(old, float) and isinstance(value, (int, float, str)):
        return float(value)
    return value


class Settings:
    def __init__(self, path):
        self.path = path
        self.data = copy.deepcopy(DEFAULTS)
        self._lock = threading.Lock()
        self.dirty = False
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    self.data = deep_merge(DEFAULTS, json.load(f))
            except (OSError, ValueError) as e:
                print(f"settings: could not load {path}: {e}; using defaults")

    def get(self, path, default=None):
        node = self.data
        for part in path.split("."):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node

    def set(self, path, value):
        parts = path.split(".")
        node = self.data
        for part in parts[:-1]:
            if part not in node or not isinstance(node[part], dict):
                node[part] = {}
            node = node[part]
        key = parts[-1]
        if key in node and value is not None:
            value = _coerce(node[key], value)
        node[key] = value
        self.dirty = True
        return value

    def replace(self, data):
        self.data = deep_merge(DEFAULTS, data)
        self.dirty = True

    def reset(self, section=None):
        if section:
            self.data[section] = copy.deepcopy(DEFAULTS[section])
        else:
            self.data = copy.deepcopy(DEFAULTS)
        self.dirty = True

    def save(self):
        if not self.dirty:
            return
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        tmp = self.path + ".tmp"
        with self._lock:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=2)
            os.replace(tmp, self.path)
            self.dirty = False
