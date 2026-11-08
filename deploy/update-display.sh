#!/bin/sh
# Apply a code update on the projector Pi without reinstalling packages:
# refresh the cursor themes and kiosk config, restart the hub and the kiosk.
#   sh deploy/update-display.sh
DIR=$(cd "$(dirname "$0")/.." && pwd)
find "$DIR" -name "*.sh" -exec sed -i 's/\r$//' {} +
sed -i 's/\r$//' "$DIR/deploy/sway-kiosk.conf"
# Archives built on Windows drop the executable bit; sway execs kiosk.sh.
chmod +x "$DIR"/deploy/*.sh
python3 "$DIR/deploy/make-invisible-cursor.py" "$HOME/.icons/invisible"
python3 "$DIR/deploy/make-invisible-cursor.py" "$HOME/.icons/default"
sed "s#/home/pi/ProjectorEye#$DIR#g" "$DIR/deploy/sway-kiosk.conf" > "$HOME/.config-sway-kiosk.conf"
# sway includes this; the Projector tab writes the chosen resolution into it.
[ -f "$HOME/.config-sway-output.conf" ] || echo "# auto" > "$HOME/.config-sway-output.conf"
sed -i "s#^  exec .*cage -s -- .*#  exec sway -c \$HOME/.config-sway-kiosk.conf 2>>/tmp/sway.log#" "$HOME/.bash_profile"
grep "exec " "$HOME/.bash_profile"
sudo systemctl restart eye-hub
sudo systemctl reset-failed getty@tty1 2>/dev/null
sudo systemctl restart getty@tty1
sleep 10
echo "hub: $(systemctl is-active eye-hub)"
echo "sway: $(pgrep -x sway || echo none)"
echo "chromium processes: $(pgrep -c chromium)"
