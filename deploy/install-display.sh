#!/bin/sh
# Projector Pi: hub service + Chromium kiosk. Run from the project folder:
#   sh deploy/install-display.sh
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
USER_NAME=$(id -un)
sudo apt-get update
sudo apt-get install -y python3-aiohttp curl
command -v chromium-browser >/dev/null || command -v chromium >/dev/null || sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium
sed -e "s#@USER@#$USER_NAME#" -e "s#@DIR@#$DIR#" "$DIR/deploy/eye-hub.service" | sudo tee /etc/systemd/system/eye-hub.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now eye-hub
chmod +x "$DIR/deploy/kiosk.sh"

# XDG autostart is honoured by Pi OS desktops (X11/LXDE, wayfire and labwc).
# If the kiosk does not appear after a reboot on a custom setup, add
# "<dir>/deploy/kiosk.sh &" to ~/.config/labwc/autostart instead.
mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/eye-kiosk.desktop" <<EOD
[Desktop Entry]
Type=Application
Name=Eye kiosk
Exec=$DIR/deploy/kiosk.sh
EOD
echo
echo "Done. Disable screen blanking: sudo raspi-config > Display Options > Screen Blanking > No"
echo "Control UI: http://$(hostname -I | awk '{print $1}'):8080/   (reboot to start the kiosk)"
