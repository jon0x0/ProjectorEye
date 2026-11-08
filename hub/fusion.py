"""Several cameras -> one set of targets in gaze space.

Each camera has its own mapping from its image (0..1) into gaze space
(-1..1, the eye's point of view): its alignment sliders (shift, scale,
rotate the base mapping), refined by the calibration points it took part
in; with two or more points the fit replaces the sliders. Gaze space is the common frame because cameras in different
places, at different angles, can't be lined up as raw images.

Targets from all cameras are mapped, then:
  - an optional dividing line gives each side to one camera; the other
    camera's detections on that side are used only while the owner sees
    nothing there (it may be blocked by a tree, for example);
  - detections from different cameras within merge_radius are one target,
    positioned by the preferred camera (side owner, else the priority one).

A calibration point is {"gaze": [x, y], "cams": {cam_id: [x, y], ...}}:
everything that saw the person when it was captured.
"""
import copy
import math

from .calibration import Mapper, base_map

CAMERA_DEFAULTS = {
    "name": "",
    "enabled": True,
    "source": "default",      # default (camera Pi's own) | picamera2 | rtsp
    "rtsp_url": "",           # no password here: it is in secrets.json
    "rtsp_user": "",
    "exclusions": [],         # ignore zones, [[x, y, w, h]] in this camera's image
    "align": {"dx": 0.0, "dy": 0.0, "scale": 1.0, "rot": 0.0},
    "opacity": 0.6,           # in the combined view
}
STALE_S = 0.6                 # camera data older than this is ignored
GRID = (9, 7)                 # mapping grid sent to the UI for the combined view


def _merge(base, over):
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else copy.deepcopy(v)
    return out


def camera_cfgs(settings):
    """id -> camera settings with defaults filled in (ordered as stored)."""
    cams = settings.get("cameras") or {}
    out = {}
    for i, (cid, c) in enumerate(cams.items()):
        cfg = _merge(CAMERA_DEFAULTS, c)
        cfg["name"] = cfg["name"] or f"Camera {i + 1}"
        out[cid] = cfg
    return out


def points_for(points, cam_id):
    return [{"cam": p["cams"][cam_id], "gaze": p["gaze"]}
            for p in points or [] if cam_id in (p.get("cams") or {}) and "gaze" in p]


class Fusion:
    def __init__(self, settings):
        self.s = settings
        self.data = {}            # cam id -> {"targets": [...], "t": time, "sim": bool}
        self.rebuild()

    def rebuild(self):
        self.cams = camera_cfgs(self.s)
        cal = self.s.get("calibration") or {}
        pts = cal.get("points") or []
        self.mappers = {cid: Mapper(dict(cal, points=points_for(pts, cid), align=c["align"]))
                        for cid, c in self.cams.items()}

    def enabled(self):
        return [cid for cid, c in self.cams.items() if c["enabled"]]

    def to_gaze(self, cid, x, y, clamp=None):
        m = self.mappers.get(cid)
        if m is None:
            return None
        gx, gy = m.raw(x, y)
        if clamp is None:
            clamp = self.s.get("calibration.clamp") is not False
        if clamp:
            gx, gy = max(-1.0, min(1.0, gx)), max(-1.0, min(1.0, gy))
        return gx, gy

    def update(self, cid, targets, now, sim=False):
        self.data[cid] = {"targets": targets or [], "t": now, "sim": sim}

    def fresh(self, now, sim=False):
        """cam id -> raw targets that are recent enough."""
        return {cid: d["targets"] for cid, d in self.data.items()
                if cid in self.cams and self.cams[cid]["enabled"] and d["sim"] == sim and now - d["t"] <= STALE_S}

    # ------------------------------------------------------------ fusing
    def _side(self, g):
        d = self.s.get("fusion.divider") or {}
        (ax, ay), (bx, by) = d.get("a", [0, -1]), d.get("b", [0, 1])
        return "left" if (bx - ax) * (g[1] - ay) - (by - ay) * (g[0] - ax) > 0 else "right"

    def _owners(self):
        """{"left": cam, "right": cam} when the divider is on, else None."""
        d = self.s.get("fusion.divider") or {}
        en = self.enabled()
        if not d.get("enabled") or len(en) < 2:
            return None
        left = d.get("left") if d.get("left") in en else en[0]
        right = d.get("right") if d.get("right") in en and d.get("right") != left else next(c for c in en if c != left)
        return {"left": left, "right": right}

    def fuse(self, now, sim=False):
        cands = []
        for cid, targets in self.fresh(now, sim).items():
            for t in targets:
                g = self.to_gaze(cid, t["x"], t["y"])
                cands.append({"x": g[0], "y": g[1], "area": t.get("area", 0.0), "cam": cid, "raw": [t["x"], t["y"]]})
        owners = self._owners()
        if owners:
            for c in cands:
                c["side"] = self._side((c["x"], c["y"]))
            owner_sees = {side for side in ("left", "right")
                          if any(c["side"] == side and c["cam"] == owners[side] for c in cands)}
            cands = [c for c in cands if c["cam"] == owners[c["side"]] or c["side"] not in owner_sees]
            rank = lambda c: 0 if c["cam"] == owners[c["side"]] else 1
        else:
            prio = self.s.get("fusion.priority")
            rank = lambda c: 0 if c["cam"] == prio else 1
        radius = float(self.s.get("fusion.merge_radius") or 0.0)
        fused = []
        for c in sorted(cands, key=lambda c: (rank(c), -c["area"])):
            near = [f for f in fused if c["cam"] not in f["seen"]
                    and math.hypot(f["x"] - c["x"], f["y"] - c["y"]) <= radius]
            if near:
                f = min(near, key=lambda f: math.hypot(f["x"] - c["x"], f["y"] - c["y"]))
                f["seen"][c["cam"]] = c["raw"]
                f["area"] = max(f["area"], c["area"])
            else:
                fused.append({"x": c["x"], "y": c["y"], "area": c["area"],
                              "src": {"cam": c["cam"], "xy": c["raw"]}, "seen": {c["cam"]: c["raw"]}})
        return fused

    # ----------------------------------------------------------- reports
    def residuals(self):
        """Per calibration point: {cam id: error in gaze units}."""
        out = []
        for p in self.s.get("calibration.points") or []:
            r = {}
            for cid, xy in (p.get("cams") or {}).items():
                g = self.to_gaze(cid, *xy, clamp=False) if cid in self.mappers else None
                if g is not None:
                    r[cid] = round(math.hypot(g[0] - p["gaze"][0], g[1] - p["gaze"][1]), 3)
            out.append(r)
        return out

    def report(self):
        """For the UI: each camera's fit and a grid of its mapping. While the
        sliders are in charge (no fit yet) the grid leaves them out and the
        phone applies them itself, so dragging moves the overlay at once."""
        out = {}
        nx, ny = GRID
        cal = self.s.get("calibration") or {}
        for cid, m in self.mappers.items():
            sliders = m.kind in ("base", "offset")
            f = (lambda x, y: base_map(x, y, dict(cal, align=None))) if sliders else m.raw
            grid = [[[round(v, 4) for v in f(i / (nx - 1), j / (ny - 1))] for i in range(nx)] for j in range(ny)]
            out[cid] = {"kind": m.kind, "points": len(m.residuals), "grid": grid,
                        "sliders": sliders, "offset": [round(v, 4) for v in m.offset]}
        return out


def migrate(settings, secrets):
    """Single-camera settings (sensor.source / rtsp_url / exclusions /
    profiles, points with "cam") -> the cameras dict. Runs once."""
    if settings.get("fusion.migrated"):
        return False
    sen = settings.get("sensor") or {}
    cams = dict(settings.get("cameras") or {})
    cam1 = dict(cams.get("cam1") or {})
    if sen.get("source"):
        cam1["source"] = sen["source"]
    for k in ("rtsp_url", "rtsp_user", "exclusions"):
        if sen.get(k):
            cam1[k] = sen[k]
    cams["cam1"] = cam1
    pts = []
    for p in settings.get("calibration.points") or []:
        if "cam" in p and "cams" not in p:
            p = {"gaze": p["gaze"], "cams": {"cam1": p["cam"]}}
        pts.append(p)
    # Zones/points kept for the other camera by the old per-source profiles.
    cur = sen.get("source") or "default"
    for key, prof in (sen.get("profiles") or {}).items():
        if key in (cur, "default") or not (prof.get("exclusions") or prof.get("points")):
            continue
        cid = f"cam{len(cams) + 1}"
        cams[cid] = {"source": key, "enabled": False, "exclusions": prof.get("exclusions") or []}
        pts += [{"gaze": p["gaze"], "cams": {cid: p["cam"]}} for p in prof.get("points") or [] if "cam" in p]
    settings.set("cameras", cams)
    settings.set("calibration.points", pts)
    for k in ("source", "rtsp_url", "rtsp_user", "exclusions", "profiles"):
        (settings.get("sensor") or {}).pop(k, None)
    if secrets.get("rtsp_password") and not secrets.get("rtsp_password:cam1"):
        secrets["rtsp_password:cam1"] = secrets.pop("rtsp_password")
    settings.set("fusion.migrated", True)
    return True
