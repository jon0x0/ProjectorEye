// WebSocket link to the hub with automatic reconnect.
export function connect(role, handlers) {
  let ws = null;
  let backoff = 500;
  const link = {
    connected: false,
    send(msg) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
    },
  };
  function open() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      backoff = 500;
      link.connected = true;
      ws.send(JSON.stringify({ type: "hello", role }));
      handlers._open && handlers._open();
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      const h = handlers[m.type];
      if (h) h(m);
    };
    ws.onclose = () => {
      link.connected = false;
      handlers._close && handlers._close();
      setTimeout(open, backoff);
      backoff = Math.min(5000, backoff * 1.6);
    };
    ws.onerror = () => ws.close();
  }
  open();
  return link;
}
