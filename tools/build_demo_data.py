"""Write static/demo/data.json for the in-browser demo (GitHub Pages).

The demo runs the phone UI with no Pi: static/js/demo-hub.js stands in for the
hub and needs the default settings and the built-in eyes. Run this after
changing either:  python tools/build_demo_data.py
(tests/test_hub.py fails while the file is out of date.)
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from hub.settings import DEFAULTS  # noqa: E402

OUT = os.path.join(ROOT, "static", "demo", "data.json")


def build():
    eyes_dir = os.path.join(ROOT, "eyes")
    eyes = []
    for f in sorted(os.listdir(eyes_dir)):
        if f.endswith(".json"):
            with open(os.path.join(eyes_dir, f), encoding="utf-8") as fh:
                t = json.load(fh)
            i = f[:-5]
            eyes.append({"id": i, "name": t.get("name", i), "description": t.get("description", ""),
                         "template": t, "builtin": True, "modified": False})
    return json.dumps({"settings": DEFAULTS, "eyes": eyes}, separators=(",", ":"), sort_keys=True) + "\n"


if __name__ == "__main__":
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(build())
    print("wrote", OUT)
