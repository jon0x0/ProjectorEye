#!/bin/sh
# Restart the tty1 kiosk with cage's output logged to /tmp/cage.log, then
# report what happened. For diagnosing a kiosk that won't start.
sed -i 's#cage -s -- \([^ ]*kiosk.sh\)$#cage -s -- \1 2>>/tmp/cage.log#' "$HOME/.bash_profile"
grep "exec " "$HOME/.bash_profile"
: > /tmp/cage.log
sudo systemctl reset-failed getty@tty1
sudo systemctl restart getty@tty1
sleep 8
echo "cage: $(pgrep -x cage || echo none)  chromium: $(pgrep -c chromium)"
echo "--- cage.log"
tail -n 30 /tmp/cage.log
