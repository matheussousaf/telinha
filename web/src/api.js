// Must match src/protocol.js on the server — see the note there.
export const PROTOCOL_VERSION = 4;

export const STALE_PAGE_MSG = 'Página desatualizada — atualize com Ctrl+Shift+R';

export function isStale(msg) {
  return typeof msg.proto === 'number' && msg.proto !== PROTOCOL_VERSION;
}

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
