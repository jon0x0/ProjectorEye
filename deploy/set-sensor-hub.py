"""Point the camera Pi's motion sensor at a different eye hub.

  python3 deploy/set-sensor-hub.py ws://pieye2.local:8080/ws
  sudo systemctl restart eye-sensor
"""
import json
import os
import sys

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sensor", "sensor_config.json")
cfg = json.load(open(path, encoding="utf-8"))
old = cfg.get("hub")
cfg["hub"] = sys.argv[1]
with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
print(f"hub: {old} -> {cfg['hub']}")
