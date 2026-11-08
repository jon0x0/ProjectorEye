"""Motion detection: background subtraction -> blobs -> merged targets."""
import cv2
import numpy as np


class Detector:
    def __init__(self, cfg=None):
        self.cfg = {}
        self.bg = None
        self.mog = None
        self.warmup = 0
        self.mask = None
        self.update(cfg or {})

    def update(self, cfg):
        old = self.cfg
        self.cfg = dict(cfg)
        if old.get("method") != self.cfg.get("method") or old.get("detect_width") != self.cfg.get("detect_width"):
            self.reset()

    def reset(self):
        self.bg = None
        self.mog = None
        self.warmup = 15

    def process(self, frame):
        """frame: BGR image. Returns (targets, mask) with normalised targets."""
        c = self.cfg
        h0, w0 = frame.shape[:2]
        dw = int(c.get("detect_width", 320))
        dh = max(1, int(h0 * dw / w0))
        small = cv2.resize(frame, (dw, dh), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        k = int(c.get("blur", 5)) | 1
        if k > 1:
            gray = cv2.GaussianBlur(gray, (k, k), 0)
        lr = float(c.get("learning_rate", 0.01))
        thr = int(c.get("threshold", 25))

        if c.get("method", "mog2") == "mog2":
            if self.mog is None:
                self.mog = cv2.createBackgroundSubtractorMOG2(history=500, varThreshold=16, detectShadows=True)
            self.mog.setVarThreshold(float(thr) * 0.8)
            fg = self.mog.apply(gray, learningRate=lr if self.warmup <= 0 else 0.3)
            _, mask = cv2.threshold(fg, 200, 255, cv2.THRESH_BINARY)   # drop shadows (127)
        else:
            if self.bg is None:
                self.bg = gray.astype(np.float32)
            cv2.accumulateWeighted(gray, self.bg, lr if self.warmup <= 0 else 0.3)
            diff = cv2.absdiff(gray, cv2.convertScaleAbs(self.bg))
            _, mask = cv2.threshold(diff, thr, 255, cv2.THRESH_BINARY)

        for x, y, w, h in c.get("exclusions", []):
            cv2.rectangle(mask, (int(x * dw), int(y * dh)), (int((x + w) * dw), int((y + h) * dh)), 0, -1)
        d = int(c.get("dilate", 3))
        if d > 0:
            mask = cv2.dilate(mask, None, iterations=d)
        self.mask = mask

        if self.warmup > 0:
            self.warmup -= 1
            return [], mask
        frac = cv2.countNonZero(mask) / float(dw * dh)
        if frac > float(c.get("max_area", 0.45)):
            # Whole-scene change (lights, exposure jump, headlights): relearn.
            self.reset()
            return [], mask

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        min_px = float(c.get("min_area", 0.002)) * dw * dh
        boxes = []
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < min_px * 0.25:
                continue
            x, y, w, h = cv2.boundingRect(cnt)
            boxes.append([x, y, x + w, y + h, area])
        boxes = merge_boxes(boxes, float(c.get("merge_distance", 0.06)) * dw)
        aim = float(c.get("aim_y", 0.35))
        targets = []
        for x0, y0, x1, y1, area in boxes:
            if area < min_px:
                continue
            w, h = x1 - x0, y1 - y0
            targets.append({
                "x": round((x0 + w / 2) / dw, 4),
                "y": round((y0 + h * aim) / dh, 4),
                "w": round(w / dw, 4),
                "h": round(h / dh, 4),
                "area": round(area / (dw * dh), 5),
            })
        targets.sort(key=lambda t: t["area"], reverse=True)
        return targets[: int(c.get("max_targets", 4))], mask


def merge_boxes(boxes, gap):
    """Union boxes closer than gap pixels (a person is often several blobs)."""
    boxes = [b[:] for b in boxes]
    changed = True
    while changed:
        changed = False
        out = []
        while boxes:
            a = boxes.pop()
            i = 0
            while i < len(boxes):
                b = boxes[i]
                if a[0] - gap <= b[2] and b[0] - gap <= a[2] and a[1] - gap <= b[3] and b[1] - gap <= a[3]:
                    a = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]), a[4] + b[4]]
                    boxes.pop(i)
                    changed = True
                else:
                    i += 1
            out.append(a)
        boxes = out
    return boxes


def annotate(frame, targets, cfg, mask=None):
    """Draw zones and targets onto a copy of the frame for the preview stream."""
    if cfg.get("preview_mask") and mask is not None:
        img = cv2.cvtColor(cv2.resize(mask, (frame.shape[1], frame.shape[0])), cv2.COLOR_GRAY2BGR)
    else:
        img = frame.copy()
    h, w = img.shape[:2]
    for x, y, zw, zh in cfg.get("exclusions", []):
        cv2.rectangle(img, (int(x * w), int(y * h)), (int((x + zw) * w), int((y + zh) * h)), (60, 60, 255), 1)
    aim = float(cfg.get("aim_y", 0.35))
    for i, t in enumerate(targets):
        x0 = int((t["x"] - t["w"] / 2) * w)
        y0 = int((t["y"] - t["h"] * aim) * h)
        color = (93, 225, 155) if i == 0 else (200, 200, 200)
        cv2.rectangle(img, (x0, y0), (x0 + int(t["w"] * w), y0 + int(t["h"] * h)), color, 2)
        cv2.circle(img, (int(t["x"] * w), int(t["y"] * h)), 5, (71, 179, 255), -1)
    if not cfg.get("enabled", True):
        cv2.putText(img, "DETECTION OFF", (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (80, 80, 255), 2)
    return img
