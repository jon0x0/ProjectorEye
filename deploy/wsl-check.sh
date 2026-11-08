#!/bin/sh
# Reports what the WSL environment has for running the eye locally.
python3 --version
for m in aiohttp cv2 numpy; do
  python3 -c "import $m; print('$m', $m.__version__)" 2>/dev/null || echo "$m MISSING"
done
command -v pip3 >/dev/null && echo "pip3 ok" || echo "pip3 MISSING"
python3 -m venv --help >/dev/null 2>&1 && echo "venv ok" || echo "venv MISSING"
