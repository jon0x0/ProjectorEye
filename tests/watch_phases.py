"""Send commands to a running hub, then log phase/eye changes for a while.

  python tests/watch_phases.py ws://pieye.local:8080/ws 20 '{"type":"cmd","name":"random_eye"}'
"""
import asyncio
import json
import sys
import time

import aiohttp


async def main(url, seconds, cmds):
    async with aiohttp.ClientSession() as s:
        async with s.ws_connect(url, timeout=5) as ws:
            await ws.send_json({"type": "hello", "role": "ui"})
            for c in cmds:
                await ws.send_json(json.loads(c))
            t0 = time.monotonic()
            last = None
            eye = None
            while time.monotonic() - t0 < seconds:
                try:
                    m = json.loads((await asyncio.wait_for(ws.receive(), 1.0)).data)
                except asyncio.TimeoutError:
                    continue
                if m["type"] == "eye":
                    eye = m["id"]
                if m["type"] in ("frame", "eye"):
                    state = (m.get("phase") or (last or ("", ""))[0], eye)
                    if m["type"] == "frame":
                        state = (m["phase"], eye)
                    if state != last:
                        print(f"{time.monotonic() - t0:5.1f}s  phase={state[0]:<9} eye={state[1]}")
                        last = state


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], float(sys.argv[2]), sys.argv[3:]))
