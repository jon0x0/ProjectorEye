#!/bin/sh
# One-time WSL setup: venv in ~/.venvs/projector-eye with the hub and sensor deps.
set -e
VENV="$HOME/.venvs/projector-eye"
[ -x "$VENV/bin/python" ] || python3 -m venv --system-site-packages "$VENV"
"$VENV/bin/pip" install -q --disable-pip-version-check --timeout 30 aiohttp opencv-python-headless
"$VENV/bin/python" -c "import aiohttp, cv2, numpy; print('ready: aiohttp', aiohttp.__version__, 'cv2', cv2.__version__)"
