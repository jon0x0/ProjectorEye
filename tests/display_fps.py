"""Measure the projector page's real frame rate for one or more eyes.

  python tests/display_fps.py ws://pieye.local:8080/ws eye-of-sauron swamp-beast
  python tests/display_fps.py ws://pieye.local:8080/ws eye-of-sauron --preview '{"sauron":{"quality":0.3}}'

For each eye: selects it (or previews it with overrides, unsaved), waits for
two fresh 5 s reports from the display, prints fps / worst frame. Restores the
originally selected eye at the end.
"""
import asyncio
import json
import sys

import aiohttp


def merge(a, b):
    out = dict(a)
    for k, v in b.items():
        out[k] = merge(a.get(k, {}), v) if isinstance(v, dict) and isinstance(a.get(k), dict) else v
    return out


async def measure(ws, label):
    seen = 0
    t = asyncio.get_running_loop().time()
    while asyncio.get_running_loop().time() - t < 25:
        try:
            m = json.loads((await asyncio.wait_for(ws.receive(), 2)).data)
        except asyncio.TimeoutError:
            continue
        if m.get("type") == "status" and m.get("display"):
            seen += 1
            if seen >= 8:       # status is 1 Hz; display stats every 5 s: skip the stale ones
                d = m["display"]
                print(f"{label:<40} {d['fps']:>3} fps   worst frame {d['worst_ms']} ms   draw {d.get('draw_ms')} ms/frame   canvas {d['canvas']}")
                return


async def main(url, args):
    preview = None
    if "--preview" in args:
        i = args.index("--preview")
        preview = json.loads(args[i + 1])
        args = args[:i] + args[i + 2:]
    async with aiohttp.ClientSession() as s:
        async with s.ws_connect(url, timeout=5) as ws:
            await ws.send_json({"type": "hello", "role": "ui"})
            original = None
            while original is None:
                m = json.loads((await ws.receive()).data)
                if m["type"] == "init":
                    original = m["settings"]["eye"]["template"]
            for eye in args:
                if preview is not None:
                    base = await (await s.get(url.replace("ws://", "http://").replace("/ws", f"/eyes/{eye}.json"))).json()
                    await ws.send_json({"type": "set", "path": "eye.template", "value": eye})
                    await asyncio.sleep(1)
                    await ws.send_json({"type": "cmd", "name": "eye_preview", "template": merge(base, preview)})
                    await measure(ws, f"{eye} + {json.dumps(preview)}")
                else:
                    await ws.send_json({"type": "set", "path": "eye.template", "value": eye})
                    await measure(ws, eye)
            await ws.send_json({"type": "cmd", "name": "eye_revert"})
            await ws.send_json({"type": "set", "path": "eye.template", "value": original})
            await asyncio.sleep(0.5)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2:]))
