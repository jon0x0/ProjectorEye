#!/bin/sh
# Camera Pi: motion sensor service. Run from the project folder:
#   sh deploy/install-sensor.sh ws://pieye.local:8080/ws
# Writes /tmp/eye-install.done (or .failed) when finished, for unattended runs.
DIR=$(cd "$(dirname "$0")/.." && pwd)
USER_NAME=$(id -un)
rm -f /tmp/eye-install.done /tmp/eye-install.failed
trap '[ -f /tmp/eye-install.done ] || touch /tmp/eye-install.failed' EXIT
set -e
export DEBIAN_FRONTEND=noninteractive
echo "== packages"
sudo apt-get update -q
# libnss-mdns lets this Pi resolve <name>.local hostnames such as the hub;
# ffmpeg decodes network (RTSP) cameras.
sudo -E apt-get install -y -q python3-picamera2 python3-opencv python3-numpy python3-aiohttp ffmpeg avahi-daemon libnss-mdns
if [ -n "$1" ]; then
  python3 - "$DIR/sensor/sensor_config.json" "$1" <<'PY'
import json, sys
p, hub = sys.argv[1], sys.argv[2]
c = json.load(open(p)); c["hub"] = hub
json.dump(c, open(p, "w"), indent=2)
print("hub set to", hub)
PY
fi
echo "== service"
sed -e "s#@USER@#$USER_NAME#" -e "s#@DIR@#$DIR#" "$DIR/deploy/eye-sensor.service" | sudo tee /etc/systemd/system/eye-sensor.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable eye-sensor
sudo systemctl restart eye-sensor
echo "== done (logs: journalctl -u eye-sensor -f)"
touch /tmp/eye-install.done
