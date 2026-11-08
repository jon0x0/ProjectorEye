#!/bin/sh
# Opens the eye renderer full screen. Started by the desktop autostart, or by
# cage on Pi OS Lite (see install-kiosk-lite.sh).
URL="${1:-http://localhost:8080/display}"
until curl -sf -o /dev/null "$URL"; do sleep 1; done
BROWSER=$(command -v chromium-browser || command -v chromium)
EXTRA=""
if [ -n "$WAYLAND_DISPLAY" ]; then
  EXTRA="--ozone-platform=wayland"
  # Extra Chromium flags for experiments (set in ~/.eye-kiosk-flags).
  [ -f "$HOME/.eye-kiosk-flags" ] && EXTRA="$EXTRA $(cat "$HOME/.eye-kiosk-flags")"
  # Chromium sets its arrow cursor while starting up and only re-reads the
  # page's cursor when the mouse moves, which never happens on a kiosk with
  # no mouse. So Chromium must use the transparent theme too (env + GTK).
  export XCURSOR_THEME=invisible XCURSOR_PATH="$HOME/.icons:/usr/share/icons"
  mkdir -p "$HOME/.config/gtk-3.0"
  printf '[Settings]\ngtk-cursor-theme-name=invisible\ngtk-cursor-theme-size=24\n' > "$HOME/.config/gtk-3.0/settings.ini"
else
  # Keep an X11 screen from blanking.
  xset s off -dpms 2>/dev/null
fi
# The kiosk browser has its own profile. Any copy left from an earlier
# session is closed first: otherwise a new launch just hands the page to the
# old browser and exits at once.
PROFILE_DIR=/tmp/eye-kiosk-chromium
# Only one kiosk loop at a time (an old one may survive a display restart).
for pid in $(pgrep -f "deploy/kiosk.sh"); do [ "$pid" != "$$" ] && kill "$pid" 2>/dev/null; done

# Keep the eye on screen: if Chromium exits or crashes, start it again rather
# than leaving a black projector. If it keeps dying straight away, back off
# instead of spawning browsers in a tight loop (that exhausted the Pi's memory).
fails=0
while true; do
  pkill -f -- "--user-data-dir=$PROFILE_DIR" 2>/dev/null
  sleep 1
  started=$(date +%s)
  "$BROWSER" $EXTRA --kiosk --noerrdialogs --disable-infobars --no-first-run \
    --disable-session-crashed-bubble --disable-features=Translate \
    --autoplay-policy=no-user-gesture-required --check-for-update-interval=31536000 \
    --password-store=basic --incognito --user-data-dir="$PROFILE_DIR" "$URL"
  rc=$?
  ran=$(( $(date +%s) - started ))
  if [ "$ran" -lt 20 ]; then fails=$((fails + 1)); else fails=0; fi
  echo "$(date) chromium exited ($rc) after ${ran}s; restarting" >> /tmp/kiosk.log
  if [ "$fails" -ge 3 ]; then sleep 30; else sleep 2; fi
  until curl -sf -o /dev/null "$URL"; do sleep 1; done
done
