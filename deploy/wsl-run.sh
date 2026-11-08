#!/bin/sh
# Start the hub and the synthetic-camera sensor under WSL (after wsl-setup.sh).
#   sh deploy/wsl-run.sh          start (returns immediately; logs in /tmp)
#   sh deploy/wsl-run.sh fg       start and stay attached (keeps WSL alive)
#   sh deploy/wsl-run.sh stop     stop both
DIR=$(cd "$(dirname "$0")/.." && pwd)
PY="$HOME/.venvs/projector-eye/bin/python"
HUB_PORT=${HUB_PORT:-8790}
CAM_PORT=${CAM_PORT:-8791}
SOURCE=${SOURCE:-synthetic}

pkill -f "python -u -m hub --port $HUB_PORT" 2>/dev/null
pkill -f "python -u -m sensor --source" 2>/dev/null
[ "$1" = "stop" ] && { echo stopped; exit 0; }

cd "$DIR"
nohup "$PY" -u -m hub --port "$HUB_PORT" > /tmp/eye-hub.log 2>&1 &
# Wait (max ~10 s) for the hub before starting the sensor.
i=0
until "$PY" -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:$HUB_PORT/', timeout=1)" 2>/dev/null; do
  i=$((i + 1)); [ $i -ge 20 ] && { echo "hub did not start:"; cat /tmp/eye-hub.log; exit 1; }
  sleep 0.5
done
nohup "$PY" -u -m sensor --source "$SOURCE" --hub "ws://127.0.0.1:$HUB_PORT/ws" --preview-port "$CAM_PORT" > /tmp/eye-sensor.log 2>&1 &
sleep 2
echo "hub:    http://localhost:$HUB_PORT/   (projector view: /display)"
echo "camera: http://localhost:$CAM_PORT/stream.mjpg"
tail -n 3 /tmp/eye-hub.log /tmp/eye-sensor.log
# "fg": stay attached so WSL keeps the distro (and these processes) alive.
[ "$1" = "fg" ] && wait
