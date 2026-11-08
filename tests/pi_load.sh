#!/bin/sh
# Projector frame rate per eye plus this Pi's CPU, memory and temperature,
# for before/after comparisons (e.g. with the motion sensor on this Pi).
#   sh tests/pi_load.sh [eye ...]      (default: eye-of-sauron smaug-photoreal swamp-beast)
cd "$(dirname "$0")/.."
EYES=${*:-eye-of-sauron smaug-photoreal swamp-beast}
echo "== $(hostname) $(date -u +%FT%TZ)"
python3 tests/display_fps.py ws://localhost:8080/ws $EYES 2>&1 | grep -v "^$"
echo "== load over 10 s"
top -bn2 -d10 | awk '/^%Cpu/ {cpu=$0} /^MiB Mem/ {mem=$0} END {print cpu; print mem}'
top -bn1 -o %CPU | sed -n '8,13p' | awk '{printf "  %-6s %5s%% %s\n", $1, $9, $12}'
echo "temp $(vcgencmd measure_temp | cut -d= -f2), throttled $(vcgencmd get_throttled | cut -d= -f2)"
