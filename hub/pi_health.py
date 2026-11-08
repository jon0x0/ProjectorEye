"""Raspberry Pi health: SoC temperature and the firmware's power/thermal flags.

vcgencmd get_throttled bits:
  0 under-voltage now       16 under-voltage has occurred
  1 ARM frequency capped    17 frequency capping has occurred
  2 throttled now           18 throttling has occurred
  3 soft temp limit now     19 soft temp limit has occurred
Returns None off a Pi (no vcgencmd), so the hub works anywhere.
"""
import shutil
import subprocess

FLAGS = {0: "under-voltage", 1: "freq capped", 2: "throttled", 3: "soft temp limit"}


def _vc(*args):
    out = subprocess.run(["vcgencmd", *args], capture_output=True, text=True, timeout=3)
    return out.stdout.strip()


def read():
    if not shutil.which("vcgencmd"):
        return None
    try:
        temp = float(_vc("measure_temp").split("=")[1].split("'")[0])
        bits = int(_vc("get_throttled").split("=")[1], 16)
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None
    now = [name for b, name in FLAGS.items() if bits & (1 << b)]
    past = [name for b, name in FLAGS.items() if bits & (1 << (b + 16))]
    return {"temp": round(temp, 1), "throttled": hex(bits), "now": now, "since_boot": past}
