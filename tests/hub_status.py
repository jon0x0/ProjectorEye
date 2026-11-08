"""Print a running hub's status (displays connected, sensor, phase).

  python tests/hub_status.py ws://pieye.local:8080/ws
"""
import asyncio
import json
import sys

import aiohttp


async def main(url):
    async with aiohttp.ClientSession() as s:
        async with s.ws_connect(url, timeout=5) as ws:
            await ws.send_json({"type": "hello", "role": "ui"})
            seen = {}
            loop = asyncio.get_running_loop()
            end = loop.time() + 2.5
            while loop.time() < end and not ("status" in seen and "frame" in seen):
                m = json.loads((await asyncio.wait_for(ws.receive(), 3)).data)
                seen[m["type"]] = m
            st, fr = seen.get("status", {}), seen.get("frame", {})
            print("displays:", st.get("displays"), " sensor:", (st.get("sensor") or {}).get("connected"),
                  " phase:", fr.get("phase"), fr.get("sub") or "", " mode:", fr.get("mode"))
            print("eye:", (seen.get("init") or {}).get("settings", {}).get("eye"))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:8080/ws"))
