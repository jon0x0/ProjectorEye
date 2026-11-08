#!/bin/sh
# Restart the projector display cleanly: stop the kiosk loop and every
# browser, then let the tty1 auto-login start sway and the kiosk afresh.
#   sh deploy/restart-display.sh
# (Named so that its own command line doesn't match "kiosk.sh" below.)
for pid in $(pgrep -f 'kiosk[.]sh'); do kill "$pid" 2>/dev/null; done
pkill chromium 2>/dev/null
sleep 3
pkill -9 chromium 2>/dev/null
sudo systemctl reset-failed getty@tty1 2>/dev/null
sudo systemctl restart getty@tty1
sleep 20
echo "chromium=$(pgrep -c chromium) kiosk_loops=$(pgrep -fc 'kiosk[.]sh') sway=$(pgrep -x sway)"
free -m | grep -E 'Mem|Swap'
tail -n 3 /tmp/kiosk.log 2>/dev/null
