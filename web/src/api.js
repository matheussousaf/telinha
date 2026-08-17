export async function fetchRtcConfig() {
  const res = await fetch('/api/config');
  return await res.json();
}

// Opens the signaling socket. Messages are handled strictly in arrival order
// (each handler awaited before the next runs) so SDP always lands before ICE.
export function openSignaling(params, onMessage, onClose) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?${new URLSearchParams(params)}`);
  let queue = Promise.resolve();
  ws.onmessage = (e) => {
    queue = queue.then(() => onMessage(JSON.parse(e.data))).catch(console.error);
  };
  if (onClose) ws.onclose = onClose;
  return ws;
}
