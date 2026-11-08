import os
import random
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hub.brain import Brain, seq_duration  # noqa: E402
from hub.calibration import Mapper, base_map  # noqa: E402
from hub.fusion import Fusion, migrate  # noqa: E402
from hub.settings import Settings  # noqa: E402


def cal(**kw):
    c = {"invert_x": False, "invert_y": False, "x_gain": 1.0, "y_gain": 1.0,
         "x_offset": 0.0, "y_offset": 0.0, "use_points": True, "model": "affine", "clamp": False, "points": []}
    c.update(kw)
    return c


class CalibrationTest(unittest.TestCase):
    def test_base(self):
        self.assertEqual(base_map(0.5, 0.5, cal()), (0.0, 0.0))
        self.assertEqual(base_map(1.0, 0.5, cal(invert_x=True)), (-1.0, 0.0))

    def test_one_point_offsets(self):
        m = Mapper(cal(points=[{"cam": [0.5, 0.5], "gaze": [0.2, 0.3]}]))
        self.assertEqual(m.kind, "offset")
        gx, gy = m(0.5, 0.5)
        self.assertAlmostEqual(gx, 0.2)
        self.assertAlmostEqual(gy, 0.3)

    def test_affine_recovers_exact_mapping(self):
        f = lambda x, y: (-1.6 * x + 0.2 * y + 0.7, 0.1 * x + 0.9 * y - 0.1)
        pts = [{"cam": [x, y], "gaze": list(f(x, y))} for x, y in ((0.1, 0.2), (0.9, 0.3), (0.5, 0.8), (0.2, 0.9))]
        m = Mapper(cal(points=pts))
        self.assertEqual(m.kind, "affine")
        for x, y in ((0.3, 0.3), (0.7, 0.6)):
            for a, b in zip(m(x, y), f(x, y)):
                self.assertAlmostEqual(a, b, places=4)
        self.assertTrue(all(r < 1e-4 for r in m.residuals))

    def test_collinear_falls_back(self):
        pts = [{"cam": [x, 0.5], "gaze": [x, 0.2]} for x in (0.1, 0.5, 0.9)]
        m = Mapper(cal(points=pts))
        self.assertEqual(m.kind, "axes")
        self.assertAlmostEqual(m(0.3, 0.5)[0], 0.3, places=4)


class HomographyTest(unittest.TestCase):
    def test_recovers_perspective(self):
        h = [1.3, 0.2, -0.6, 0.1, 1.1, -0.4, 0.4, 0.7]

        def f(x, y):
            d = h[6] * x + h[7] * y + 1
            return ((h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d)
        pts = [{"cam": [x, y], "gaze": list(f(x, y))} for x, y in ((0.1, 0.1), (0.9, 0.2), (0.8, 0.9), (0.2, 0.8), (0.5, 0.5))]
        m = Mapper(cal(points=pts, model="homography"))
        self.assertEqual(m.kind, "homography")
        for a, b in zip(m(0.3, 0.6), f(0.3, 0.6)):
            self.assertAlmostEqual(a, b, places=4)


class FusionTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.s = Settings(os.path.join(self.tmp.name, "s.json"))
        self.s.set("calibration", cal(clamp=False))
        # cam1: base mapping (gaze = 2*cam - 1); cam2: same, shifted by +0.5 in x.
        self.s.set("cameras", {"cam1": {}, "cam2": {"align": {"dx": 0.5, "dy": 0, "scale": 1, "rot": 0}}})
        self.f = Fusion(self.s)

    def tearDown(self):
        self.tmp.cleanup()

    def t(self, x, y, area=0.02):
        return {"x": x, "y": y, "area": area}

    def test_same_person_merges_with_priority(self):
        self.f.update("cam1", [self.t(0.5, 0.5)], 0.0)
        self.f.update("cam2", [self.t(0.3, 0.5)], 0.0)        # -> gaze x 0.1
        out = self.f.fuse(0.1)
        self.assertEqual(len(out), 1)
        self.assertEqual(set(out[0]["seen"]), {"cam1", "cam2"})
        self.assertAlmostEqual(out[0]["x"], 0.0)              # cam1 has priority
        self.s.set("fusion.priority", "cam2")
        self.assertAlmostEqual(self.f.fuse(0.1)[0]["x"], 0.1)

    def test_far_apart_stay_separate_and_stale_dropped(self):
        self.f.update("cam1", [self.t(0.1, 0.5)], 0.0)
        self.f.update("cam2", [self.t(0.7, 0.5)], 0.0)
        self.assertEqual(len(self.f.fuse(0.1)), 2)
        self.f.update("cam1", [self.t(0.1, 0.5)], 5.0)
        self.assertEqual([t["src"]["cam"] for t in self.f.fuse(5.1)], ["cam1"])

    def test_divider_owner_and_occlusion_fallback(self):
        self.s.set("fusion.divider", {"enabled": True, "a": [0, -1], "b": [0, 1], "left": "cam1", "right": "cam2"})
        self.s.set("fusion.merge_radius", 0.0)
        # cam2 sees someone on cam1's (left) side while cam1 also sees someone there: cam2's is dropped.
        self.f.update("cam1", [self.t(0.2, 0.5)], 0.0)        # gaze -0.6, left
        self.f.update("cam2", [self.t(0.0, 0.5)], 0.0)        # gaze -0.5, left
        self.assertEqual([t["src"]["cam"] for t in self.f.fuse(0.1)], ["cam1"])
        # cam1 sees nobody on its side (blocked): cam2 fills in.
        self.f.update("cam1", [], 0.0)
        self.assertEqual([t["src"]["cam"] for t in self.f.fuse(0.1)], ["cam2"])
        # cam1 detections on cam2's side are dropped while cam2 sees someone there.
        self.f.update("cam1", [self.t(0.9, 0.5)], 0.0)        # gaze 0.8, right
        self.f.update("cam2", [self.t(0.6, 0.5)], 0.0)        # gaze 0.7, right
        self.assertEqual([t["src"]["cam"] for t in self.f.fuse(0.1)], ["cam2"])

    def test_points_fit_per_camera(self):
        pts = [{"gaze": [g, 0.0], "cams": {"cam1": [c, 0.5]}} for c, g in ((0.2, -0.3), (0.8, 0.3))]
        pts.append({"gaze": [0.0, 0.0], "cams": {"cam2": [0.5, 0.5]}})
        self.s.set("calibration.points", pts)
        self.f.rebuild()
        rep = self.f.report()
        self.assertEqual(rep["cam1"]["points"], 2)
        self.assertEqual(rep["cam2"]["points"], 1)
        self.assertAlmostEqual(self.f.to_gaze("cam1", 0.5, 0.5)[0], 0.0, places=4)
        self.assertEqual(len(self.f.residuals()), 3)

    def test_migrates_single_camera_settings(self):
        s = Settings(os.path.join(self.tmp.name, "old.json"))
        s.set("sensor.source", "rtsp")
        s.set("sensor.rtsp_url", "rtsps://cam/stream0")
        s.set("sensor.exclusions", [[0, 0, 0.1, 0.1]])
        s.set("sensor.profiles", {"picamera2": {"exclusions": [[0.5, 0.5, 0.1, 0.1]], "points": [{"cam": [0.4, 0.4], "gaze": [0, 0]}]}})
        s.set("calibration.points", [{"cam": [0.3, 0.3], "gaze": [0.1, 0.1]}])
        secrets = {"rtsp_password": "pw"}
        self.assertTrue(migrate(s, secrets))
        cams = s.get("cameras")
        self.assertEqual(cams["cam1"]["source"], "rtsp")
        self.assertEqual(cams["cam1"]["exclusions"], [[0, 0, 0.1, 0.1]])
        self.assertEqual(cams["cam2"]["source"], "picamera2")
        self.assertFalse(cams["cam2"]["enabled"])
        self.assertEqual([list(p["cams"]) for p in s.get("calibration.points")], [["cam1"], ["cam2"]])
        self.assertEqual(secrets, {"rtsp_password:cam1": "pw"})
        self.assertNotIn("source", s.get("sensor"))
        self.assertFalse(migrate(s, secrets))


class BrainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.s = Settings(os.path.join(self.tmp.name, "s.json"))
        self.s.set("mode", "auto")      # these tests cover the motion-driven behaviour
        self.s.set("behavior.stay_awake", False)
        self.events = []
        self.t = 0.0
        self.brain = Brain(self.s, self.events.append, self.t, rng=random.Random(3))

    def tearDown(self):
        self.tmp.cleanup()

    def run_for(self, seconds, motion=None, dt=1 / 30):
        end = self.t + seconds
        while self.t < end:
            self.t += dt
            if motion is not None:
                self.brain.on_motion([{"x": motion[0], "y": motion[1], "w": 0.1, "h": 0.3, "area": 0.02}], self.t)
            self.brain.tick(self.t)

    def phases(self):
        return [e["phase"] for e in self.events if e["type"] == "phase"]

    def test_full_cycle(self):
        b = self.s.get("behavior")
        self.run_for(1.0)
        self.assertEqual(self.brain.phase, "asleep")
        self.run_for(0.5, motion=(0.3, 0.6))
        self.assertEqual(self.brain.phase, "waking")
        wake = seq_duration(b["sequences"]["wake"])
        self.run_for(wake + 0.1, motion=(0.3, 0.6))
        self.assertEqual(self.brain.phase, "awake")
        self.run_for(b["wake_blinks"] * b["wake_blink_gap_s"] + 1.0, motion=(0.3, 0.6))
        blinks = [e for e in self.events if e["type"] == "blink"]
        self.assertGreaterEqual(len(blinks), b["wake_blinks"])
        self.assertEqual(self.brain.sub, "tracking")
        # Targets arrive already in gaze space (the hub fuses the cameras).
        self.assertAlmostEqual(self.brain.gaze[0], 0.3, places=3)
        held = list(self.brain.gaze)
        # Lose motion: hold, then search, then sleep.
        self.run_for(b["hold_s"] - 0.5)
        self.assertEqual(self.brain.sub, "holding")
        self.assertEqual(self.brain.gaze, held)
        self.run_for(b["search_s"] * 0.5)
        self.assertEqual(self.brain.sub, "searching")
        self.run_for(b["search_s"])
        self.assertEqual(self.brain.phase, "sleeping")
        self.run_for(seq_duration(b["sequences"]["sleep"]) + 0.1)
        self.assertEqual(self.brain.phase, "asleep")
        self.assertEqual(self.phases(), ["waking", "awake", "sleeping", "asleep"])

    def test_brief_motion_does_not_wake(self):
        self.run_for(0.1, motion=(0.5, 0.5))
        self.run_for(1.0)
        self.assertEqual(self.brain.phase, "asleep")

    def test_motion_interrupts_sleep(self):
        self.run_for(0.6, motion=(0.5, 0.5))
        self.run_for(10, motion=(0.5, 0.5))
        self.run_for(9)
        self.assertEqual(self.brain.phase, "sleeping")
        self.run_for(0.6, motion=(0.5, 0.5))
        self.assertEqual(self.brain.phase, "awake")

    def test_stay_awake_patrols_then_locks_on(self):
        self.s.set("behavior.stay_awake", True)
        self.s.set("behavior.patrol_scan_every_s", 5.0)
        b = self.s.get("behavior")
        self.run_for(seq_duration(b["sequences"]["wake"]) + 0.5)
        self.assertEqual(self.brain.phase, "awake")         # woke with no motion at all
        subs, gazes = set(), set()
        for _ in range(int(60 * 30)):
            self.run_for(1 / 30)
            subs.add(self.brain.sub)
            gazes.add(tuple(round(g, 2) for g in self.brain.gaze))
        self.assertEqual(self.brain.phase, "awake")         # a minute idle, still awake
        self.assertIn("patrolling", subs)
        self.assertIn("scanning", subs)
        self.assertGreater(len(gazes), 10)
        self.run_for(1.0, motion=(0.3, 0.6))
        self.assertEqual(self.brain.sub, "tracking")
        self.s.set("behavior.patrol_scan", False)
        self.run_for(b["hold_s"] + 30)
        self.assertNotEqual(self.brain.sub, "scanning")

    def test_stay_awake_waits_for_eye_switch(self):
        self.s.set("behavior.stay_awake", True)
        self.run_for(6)
        self.brain.hold_sleep = True
        self.brain.start_sleep(self.t)
        self.run_for(10)
        self.assertEqual(self.brain.phase, "asleep")        # held for the hub's eye swap
        self.brain.hold_sleep = False
        self.run_for(0.1)
        self.assertEqual(self.brain.phase, "waking")

    def test_manual_mode(self):
        self.s.set("mode", "manual")
        self.brain.command("wake", self.t)
        self.run_for(6)
        self.assertEqual(self.brain.phase, "awake")
        self.brain.command("gaze", self.t, x=-0.5, y=0.4)
        self.run_for(0.1, motion=(0.9, 0.9))
        self.assertEqual(self.brain.gaze, [-0.5, 0.4])
        self.run_for(30)
        self.assertEqual(self.brain.phase, "awake")

    def test_media_on_motion(self):
        self.s.set("media.enabled", True)
        self.s.set("media.on_motion_chance", 1.0)
        self.s.set("media.random_when_asleep", False)
        for _ in range(int(0.6 * 30)):
            self.t += 1 / 30
            self.brain.on_motion([{"x": 0.5, "y": 0.5, "area": 0.1}], self.t)
            self.brain.tick(self.t, media_available=["a.mp4"])
        self.assertEqual(self.brain.phase, "media")
        self.brain.on_motion([{"x": 0.5, "y": 0.5, "area": 0.1}], self.t)
        self.brain.command("media_ended", self.t)
        self.assertEqual(self.brain.phase, "waking")


if __name__ == "__main__":
    unittest.main()
