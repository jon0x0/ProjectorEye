#!/bin/sh
# Camera Pi: set up a network (RTSP/RTSPS) camera as a motion source.
#   sh deploy/set-rtsp-camera.sh rtsps://192.168.1.70:322/stream0 jon
# Prompts for the camera password (not echoed) and stores it in
# ~/.config/eye-sensor/rtsp_password (mode 600), never in the project folder.
# Then tests the stream and restarts the sensor. Choose "Network camera" on
# the phone's Camera tab to use it.
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
URL=$1
CAM_USER=$2
if [ -z "$URL" ]; then
  echo "usage: sh deploy/set-rtsp-camera.sh <rtsp(s)://host:port/path> [user]"
  exit 1
fi
command -v ffmpeg >/dev/null || sudo apt-get install -y -q ffmpeg

python3 - "$DIR/sensor/sensor_config.json" "$URL" "$CAM_USER" <<'PY'
import json, sys
p, url, user = sys.argv[1:4]
c = json.load(open(p))
c["rtsp_url"] = url
c["rtsp_user"] = user or None
json.dump(c, open(p, "w"), indent=2)
print("camera:", url, "user:", user or "(none)")
PY

SECRET="$HOME/.config/eye-sensor/rtsp_password"
if [ -n "$CAM_USER" ]; then
  mkdir -p "$(dirname "$SECRET")"
  chmod 700 "$(dirname "$SECRET")"
  printf "Camera password for %s: " "$CAM_USER"
  stty -echo
  read -r PASS
  stty echo
  echo
  (umask 077 && printf '%s\n' "$PASS" > "$SECRET")
  chmod 600 "$SECRET"
  unset PASS
  echo "password saved to $SECRET"
fi

echo "== testing the stream (up to 20 s)"
cd "$DIR"
timeout 25 python3 - <<'PY' || true
import json, os, time
from sensor.eye_sensor import read_secret, DEFAULT_SECRET
from sensor.sources import open_source
c = json.load(open("sensor/sensor_config.json"))
src = open_source("rtsp", url=c["rtsp_url"], user=c.get("rtsp_user"),
                  password=read_secret(c.get("rtsp_password_file", DEFAULT_SECRET)), width=640, fps=10)
t0 = time.time()
frame = None
while time.time() - t0 < 20 and frame is None:
    frame = src.read()
print("OK:", src.status if frame is not None else "no frames yet - " + src.status)
src.close()
PY

sudo systemctl restart eye-sensor
echo "== sensor restarted (logs: journalctl -u eye-sensor -f)"
