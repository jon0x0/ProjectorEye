"""Projector output resolution control (sway kiosk on the projector Pi).

The kiosk runs under sway, whose config includes ~/.config-sway-output.conf.
Setting a mode applies it live through swaymsg and writes that file so it
survives reboots. "auto" removes the override (sway uses the display's
preferred mode, which may be 4K).

  python3 -m hub.display_output list
  python3 -m hub.display_output set 1920x1080      # or 1920x1080@60, or auto
"""
import glob
import json
import os
import subprocess
import sys

OUTPUT_CONF = os.path.expanduser("~/.config-sway-output.conf")


def _env():
    env = dict(os.environ)
    uid = os.getuid() if hasattr(os, "getuid") else 1000
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{uid}")
    if "SWAYSOCK" not in env:
        socks = sorted(glob.glob(f"{env['XDG_RUNTIME_DIR']}/sway-ipc.*.sock"), key=os.path.getmtime)
        if socks:
            env["SWAYSOCK"] = socks[-1]
    return env


def _swaymsg(*args, timeout=5):
    env = _env()
    if "SWAYSOCK" not in env:
        raise RuntimeError("sway is not running")
    out = subprocess.run(["swaymsg", *args], env=env, capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout).strip() or "swaymsg failed")
    return out.stdout


def list_outputs():
    """[{name, make, model, current: 'WxH@R', modes: ['WxH@R', ...]}], best modes first."""
    data = json.loads(_swaymsg("-t", "get_outputs", "-r"))
    result = []
    for o in data:
        cur = o.get("current_mode") or {}
        modes = {}
        for m in o.get("modes", []):
            key = (m["width"], m["height"], round(m["refresh"] / 1000))
            modes[key] = f"{m['width']}x{m['height']}@{round(m['refresh'] / 1000)}"
        result.append({
            "name": o["name"], "make": o.get("make", ""), "model": o.get("model", ""),
            "current": f"{cur.get('width')}x{cur.get('height')}@{round((cur.get('refresh') or 0) / 1000)}" if cur else "",
            "modes": [modes[k] for k in sorted(modes, reverse=True)],
        })
    return result


def saved_mode():
    try:
        with open(OUTPUT_CONF, "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 4 and parts[0] == "output" and parts[2] == "mode":
                    return parts[3]
    except OSError:
        pass
    return "auto"


def set_mode(mode):
    """mode: 'WxH', 'WxH@R' or 'auto'. Applies live and persists."""
    mode = (mode or "auto").strip()
    if mode == "auto":
        # Leave a placeholder (sway's include needs the file to exist) and go
        # back to the display's preferred mode, which may be 4K.
        with open(OUTPUT_CONF, "w", encoding="utf-8") as f:
            f.write("# Written by the eye hub: auto (display's preferred mode)\n")
        for o in list_outputs():
            if o["modes"]:
                w, _, r = o["modes"][0].partition("@")
                _swaymsg("output", o["name"], "mode", f"{w}@{r}Hz")
        return "auto"
    wh, _, rate = mode.partition("@")
    w, h = (int(v) for v in wh.lower().split("x"))
    spec = f"{w}x{h}" + (f"@{rate}Hz" if rate else "")
    with open(OUTPUT_CONF, "w", encoding="utf-8") as f:
        f.write(f"# Written by the eye hub (Projector tab > Output resolution)\noutput * mode {spec}\n")
    _swaymsg("output", "*", "mode", spec)
    return mode


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        print(json.dumps({"saved": saved_mode(), "outputs": list_outputs()}, indent=2))
    elif cmd == "set":
        print("set:", set_mode(sys.argv[2] if len(sys.argv) > 2 else "auto"))
        print(json.dumps(list_outputs(), indent=2))
