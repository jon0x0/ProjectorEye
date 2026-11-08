"""Camera-point -> eye-gaze mapping.

Camera points are normalised image coordinates (0..1, origin top-left).
Gaze is -1..1 on each axis: +x looks to the eye's image-right as projected,
+y looks down.

Without captured points a linear base mapping is used. Captured pairs refine
it: one point shifts the base mapping, two fit a per-axis scale and offset,
three or more fit an affine (or bilinear/quadratic) least-squares model.
"homography" (4+ points) fits a perspective mapping, which suits a camera
looking down at the ground at an angle.
"""
import math

MODELS = {
    "affine": (3, lambda x, y: [1.0, x, y]),
    "bilinear": (4, lambda x, y: [1.0, x, y, x * y]),
    "quadratic": (6, lambda x, y: [1.0, x, y, x * y, x * x, y * y]),
}


def apply_align(gx, gy, a):
    """Shift / scale / rotate (degrees) about the gaze centre."""
    if not a:
        return gx, gy
    s = float(a.get("scale", 1.0))
    r = math.radians(float(a.get("rot", 0.0)))
    c, n = math.cos(r), math.sin(r)
    return (s * (gx * c - gy * n) + float(a.get("dx", 0.0)),
            s * (gx * n + gy * c) + float(a.get("dy", 0.0)))


def base_map(cx, cy, cal):
    x = (cx - 0.5) * 2.0
    y = (cy - 0.5) * 2.0
    if cal.get("invert_x"):
        x = -x
    if cal.get("invert_y"):
        y = -y
    # A camera's alignment sliders ("align") place it before calibration
    # points take over; one point still shifts the aligned base mapping.
    return apply_align(x * cal.get("x_gain", 1.0) + cal.get("x_offset", 0.0),
                       y * cal.get("y_gain", 1.0) + cal.get("y_offset", 0.0), cal.get("align"))


def _solve(a, b):
    """Gaussian elimination with partial pivoting. Returns None if singular."""
    n = len(a)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[piv][col]) < 1e-12:
            return None
        m[col], m[piv] = m[piv], m[col]
        for r in range(n):
            if r != col:
                f = m[r][col] / m[col][col]
                for c in range(col, n + 1):
                    m[r][c] -= f * m[col][c]
    return [m[i][n] / m[i][i] for i in range(n)]


def _lstsq(rows, targets, ridge=1e-6):
    k = len(rows[0])
    ata = [[sum(r[i] * r[j] for r in rows) + (ridge if i == j else 0.0) for j in range(k)] for i in range(k)]
    atb = [sum(r[i] * t for r, t in zip(rows, targets)) for i in range(k)]
    return _solve(ata, atb)


class Mapper:
    """Builds a mapping function from the calibration settings."""

    def __init__(self, cal):
        self.cal = cal
        self.kind = "base"
        self.coef = None
        self.basis = None
        self.offset = (0.0, 0.0)
        self.axis = None
        self.homo = None
        pts = [p for p in cal.get("points", []) if "cam" in p and "gaze" in p]
        if cal.get("use_points", True) and pts:
            self._fit(pts)
        self.residuals = [self._residual(p) for p in pts]

    def _fit(self, pts):
        n = len(pts)
        model = self.cal.get("model", "affine")
        if model == "homography" and n >= 4 and self._spread_ok(pts) and self._fit_homography(pts):
            self.kind = "homography"
            return
        limit = MODELS.get(model, MODELS["affine"])[0]
        # Fall back to simpler models when there are too few points.
        for name in ("quadratic", "bilinear", "affine"):
            if MODELS[name][0] > limit:
                continue
            need, basis = MODELS[name]
            if n >= need and self._fit_basis(pts, basis):
                self.kind = name
                return
        if n >= 2 and self._fit_axes(pts):
            self.kind = "axes"
            return
        # One point (or degenerate set): shift the base mapping.
        dx = sum(p["gaze"][0] - base_map(*p["cam"], self.cal)[0] for p in pts) / n
        dy = sum(p["gaze"][1] - base_map(*p["cam"], self.cal)[1] for p in pts) / n
        self.offset = (dx, dy)
        self.kind = "offset"

    @staticmethod
    def _spread_ok(pts):
        # The camera points must spread in two dimensions for a 2-D model.
        n = len(pts)
        mx = sum(p["cam"][0] for p in pts) / n
        my = sum(p["cam"][1] for p in pts) / n
        sxx = sum((p["cam"][0] - mx) ** 2 for p in pts) / n
        syy = sum((p["cam"][1] - my) ** 2 for p in pts) / n
        sxy = sum((p["cam"][0] - mx) * (p["cam"][1] - my) for p in pts) / n
        tr, det = sxx + syy, sxx * syy - sxy * sxy
        return tr / 2 - math.sqrt(max(0.0, tr * tr / 4 - det)) >= 0.03 ** 2

    def _fit_homography(self, pts):
        # gx = (a x + b y + c) / (g x + h y + 1), gy = (d x + e y + f) / (g x + h y + 1),
        # linearised into one least-squares system over the eight unknowns.
        rows, rhs = [], []
        for p in pts:
            (x, y), (u, v) = p["cam"], p["gaze"]
            rows.append([x, y, 1.0, 0.0, 0.0, 0.0, -x * u, -y * u]); rhs.append(u)
            rows.append([0.0, 0.0, 0.0, x, y, 1.0, -x * v, -y * v]); rhs.append(v)
        h = _lstsq(rows, rhs)
        if h is None:
            return False
        self.homo = h
        # Reject a fit whose horizon (denominator = 0) cuts through the frame.
        for x, y in ((0, 0), (1, 0), (0, 1), (1, 1), (0.5, 0.5)):
            den = h[6] * x + h[7] * y + 1.0
            if den <= 0.05:
                self.homo = None
                return False
            gx, gy = self.raw(x, y)
            if abs(gx) > 25 or abs(gy) > 25:
                self.homo = None
                return False
        return True

    def _fit_basis(self, pts, basis):
        # The camera points must spread in two dimensions for a 2-D model.
        n = len(pts)
        mx = sum(p["cam"][0] for p in pts) / n
        my = sum(p["cam"][1] for p in pts) / n
        sxx = sum((p["cam"][0] - mx) ** 2 for p in pts) / n
        syy = sum((p["cam"][1] - my) ** 2 for p in pts) / n
        sxy = sum((p["cam"][0] - mx) * (p["cam"][1] - my) for p in pts) / n
        tr, det = sxx + syy, sxx * syy - sxy * sxy
        min_eig = tr / 2 - math.sqrt(max(0.0, tr * tr / 4 - det))
        if min_eig < 0.03 ** 2:
            return False
        rows = [basis(*p["cam"]) for p in pts]
        cx = _lstsq(rows, [p["gaze"][0] for p in pts])
        cy = _lstsq(rows, [p["gaze"][1] for p in pts])
        if cx is None or cy is None:
            return False
        # Reject fits from nearly collinear points: check that the mapping is
        # not wildly steep anywhere in the frame.
        for x, y in ((0, 0), (1, 0), (0, 1), (1, 1), (0.5, 0.5)):
            b = basis(x, y)
            if abs(sum(c * v for c, v in zip(cx, b))) > 25 or abs(sum(c * v for c, v in zip(cy, b))) > 25:
                return False
        self.basis, self.coef = basis, (cx, cy)
        return True

    def _fit_axes(self, pts):
        out = []
        for axis in (0, 1):
            xs = [p["cam"][axis] for p in pts]
            ys = [p["gaze"][axis] for p in pts]
            if max(xs) - min(xs) < 0.05:
                # Not enough spread on this axis: keep the base gain, fit offset.
                gain = self.cal.get("x_gain" if axis == 0 else "y_gain", 1.0) * 2.0
                inv = self.cal.get("invert_x" if axis == 0 else "invert_y")
                gain = -gain if inv else gain
                off = sum(y - gain * x for x, y in zip(xs, ys)) / len(xs)
                out.append((gain, off))
                continue
            sol = _lstsq([[x, 1.0] for x in xs], ys)
            if sol is None:
                return False
            out.append(tuple(sol))
        self.axis = out
        return True

    def raw(self, cx, cy):
        if self.homo:
            h = self.homo
            den = h[6] * cx + h[7] * cy + 1.0
            den = den if abs(den) > 1e-6 else 1e-6
            return ((h[0] * cx + h[1] * cy + h[2]) / den, (h[3] * cx + h[4] * cy + h[5]) / den)
        if self.coef:
            b = self.basis(cx, cy)
            return (sum(c * v for c, v in zip(self.coef[0], b)),
                    sum(c * v for c, v in zip(self.coef[1], b)))
        if self.axis:
            return (self.axis[0][0] * cx + self.axis[0][1], self.axis[1][0] * cy + self.axis[1][1])
        gx, gy = base_map(cx, cy, self.cal)
        return gx + self.offset[0], gy + self.offset[1]

    def __call__(self, cx, cy):
        gx, gy = self.raw(cx, cy)
        if self.cal.get("clamp", True):
            gx = max(-1.0, min(1.0, gx))
            gy = max(-1.0, min(1.0, gy))
        return gx, gy

    def _residual(self, p):
        gx, gy = self.raw(*p["cam"])
        return math.hypot(gx - p["gaze"][0], gy - p["gaze"][1])
