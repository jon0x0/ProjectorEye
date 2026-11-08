#!/bin/sh
# Projector Pi running Raspberry Pi OS *Lite* (no desktop):
#   - eye-hub systemd service on port 8080
#   - console auto-login on tty1, which starts sway (a Wayland compositor,
#     configured as a kiosk) running Chromium full screen on /display
# sway is used rather than cage because it can hide the mouse cursor; cage
# always draws its built-in arrow.
# Idempotent; run from the project folder:  sh deploy/install-kiosk-lite.sh
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
USER_NAME=$(id -un)
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
sudo apt-get update -q
if apt-cache policy chromium-browser | grep -q 'Candidate: [0-9]'; then BROWSER_PKG=chromium-browser; else BROWSER_PKG=chromium; fi
sudo -E apt-get install -y -q python3-aiohttp curl grim "$BROWSER_PKG"
sudo -E apt-get install -y -q --no-install-recommends sway

echo "== hub service"
sed -e "s#@USER@#$USER_NAME#" -e "s#@DIR@#$DIR#" "$DIR/deploy/eye-hub.service" | sudo tee /etc/systemd/system/eye-hub.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable eye-hub
sudo systemctl restart eye-hub

echo "== kiosk on tty1"
chmod +x "$DIR"/deploy/*.sh
sudo raspi-config nonint do_boot_behaviour B2      # console auto-login
# Transparent cursor themes so Chromium never shows an arrow either.
python3 "$DIR/deploy/make-invisible-cursor.py" "$HOME/.icons/invisible"
python3 "$DIR/deploy/make-invisible-cursor.py" "$HOME/.icons/default"
sed "s#/home/pi/ProjectorEye#$DIR#g" "$DIR/deploy/sway-kiosk.conf" > "$HOME/.config-sway-kiosk.conf"
# sway includes this; the Projector tab writes the chosen resolution into it.
[ -f "$HOME/.config-sway-output.conf" ] || echo "# auto" > "$HOME/.config-sway-output.conf"
PROFILE="$HOME/.bash_profile"
if ! grep -q "projector-eye kiosk" "$PROFILE" 2>/dev/null; then
  cat >> "$PROFILE" <<EOF

# projector-eye kiosk: start the eye full screen on the HDMI console.
# (Ctrl+Alt+F2 gives a text console; ssh sessions are not affected.)
if [ -z "\$WAYLAND_DISPLAY" ] && [ "\$(tty)" = "/dev/tty1" ]; then
  exec sway -c \$HOME/.config-sway-kiosk.conf 2>>/tmp/sway.log
fi
EOF
fi
# Upgrade a profile written by an earlier (cage) version of this script.
sed -i "s#^  exec .*cage -s -- .*#  exec sway -c \$HOME/.config-sway-kiosk.conf 2>>/tmp/sway.log#" "$PROFILE"

echo "== no console blanking"
CMDLINE=/boot/firmware/cmdline.txt
[ -f "$CMDLINE" ] || CMDLINE=/boot/cmdline.txt
grep -q consoleblank=0 "$CMDLINE" || sudo sed -i '1 s/$/ consoleblank=0/' "$CMDLINE"

echo "== done"
systemctl is-active eye-hub
