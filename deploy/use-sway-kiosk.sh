#!/bin/sh
# Switch the tty1 kiosk from cage to sway (sway can hide the cursor; cage
# always draws its built-in arrow). Idempotent. Run as the kiosk user:
#   sh deploy/use-sway-kiosk.sh
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
command -v sway >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends sway
sed "s#/home/pi/ProjectorEye#$DIR#g" "$DIR/deploy/sway-kiosk.conf" > "$HOME/.config-sway-kiosk.conf"
chmod +x "$DIR"/deploy/*.sh
PROFILE="$HOME/.bash_profile"
# Replace whatever compositor line the kiosk block has with sway.
sed -i "s#^  exec .*cage -s -- .*#  exec sway -c \$HOME/.config-sway-kiosk.conf 2>>/tmp/sway.log#" "$PROFILE"
grep -q "exec sway" "$PROFILE" || { echo "kiosk block not found in $PROFILE; run install-kiosk-lite.sh first"; exit 1; }
grep "exec " "$PROFILE"
sudo systemctl reset-failed getty@tty1 2>/dev/null || true
sudo systemctl restart getty@tty1
sleep 12
echo "sway: $(pgrep -x sway || echo none)  chromium: $(pgrep -c chromium)"
