#!/bin/sh
# Capture what the projector Pi is actually showing (including the cursor).
#   sh deploy/screenshot.sh [/tmp/out.png]
OUT=${1:-/tmp/eye-screen.png}
export XDG_RUNTIME_DIR=/run/user/$(id -u)
for s in "$XDG_RUNTIME_DIR"/wayland-*; do
  case "$s" in *.lock) continue ;; esac
  if WAYLAND_DISPLAY=$(basename "$s") grim -c -s 0.5 "$OUT" 2>/dev/null; then
    echo "$OUT (display $(basename "$s"))"
    exit 0
  fi
done
echo "no wayland display could be captured" >&2
exit 1
