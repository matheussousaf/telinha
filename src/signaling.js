import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { getRoom, roomEvents } from './rooms.js';

// Anonymous viewer identities, BR edition — no accounts, still human.
const ANON_ANIMALS = [
  'capivara', 'tucano', 'jabuti', 'arara', 'boto', 'mico', 'tatu', 'quati',
  'axolote', 'onça', 'sagui', 'lontra', 'tamanduá', 'seriema', 'maritaca', 'curió',
];
const ANON_EMOJI = ['🦫', '🦜', '🐢', '🦉', '🐬', '🐵', '🦔', '🦝', '🦎', '🐆', '🐒', '🦦', '🐜', '🦤', '🦩', '🐦'];
const ANON_COLORS = ['#5865F2', '#23A55A', '#F0B232', '#ED4245', '#EB459E', '#3BA6C4', '#9B59B6', '#E67E22'];

function makeIdentity(viewerId) {
  const i = crypto.randomInt(ANON_ANIMALS.length);
  return {
    id: viewerId,
    name: `${ANON_ANIMALS[i]} #${crypto.randomInt(1, 100)}`,
    emoji: ANON_EMOJI[i],
    color: ANON_COLORS[crypto.randomInt(ANON_COLORS.length)],
  };
}

export function attachSignaling(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://internal');
    if (url.pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://internal');
    const room = getRoom(url.searchParams.get('room') ?? '');
    if (!room) return ws.close(4004, 'room not found');

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    if (url.searchParams.get('role') === 'share') {
      if (url.searchParams.get('key') !== room.streamKey) return ws.close(4003, 'bad stream key');
      handleStreamer(room, ws);
    } else {
      handleViewer(room, ws);
    }
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));
}

function send(ws, msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function identities(room) {
  return [...room.viewers.values()].map((v) => v.identity);
}

// Pushes current room metadata (e.g. the detected game) to everyone connected.
export function notifyRoomInfo(room) {
  const info = { type: 'room-info', name: room.name, game: room.game };
  send(room.streamer, info);
  for (const v of room.viewers.values()) send(v.ws, info);
}

function broadcastViewers(room) {
  const msg = { type: 'viewers', count: room.viewers.size, viewers: identities(room) };
  for (const v of room.viewers.values()) send(v.ws, msg);
  send(room.streamer, msg);
}

function handleStreamer(room, ws) {
  // A page refresh reconnects before the old socket dies — replace it.
  room.streamer?.close(4000, 'replaced by new streamer session');
  room.streamer = ws;

  send(ws, { type: 'hello', role: 'share', name: room.name, game: room.game, viewers: identities(room) });
  broadcastViewers(room);

  ws.on('message', (raw) => {
    const msg = safeParse(raw);
    if (!msg) return;
    if (msg.type === 'signal' && msg.to) {
      send(room.viewers.get(msg.to)?.ws, { type: 'signal', data: msg.data });
    } else if (msg.type === 'live') {
      room.live = true;
      room.liveAt = Date.now();
      for (const v of room.viewers.values()) send(v.ws, { type: 'stream-live' });
      roomEvents.emit('live', room.id);
    } else if (msg.type === 'end') {
      endStream(room);
    }
  });

  ws.on('close', () => {
    if (room.streamer !== ws) return; // an old, replaced socket
    room.streamer = null;
    endStream(room);
  });
}

function endStream(room) {
  if (!room.live) return;
  room.live = false;
  for (const v of room.viewers.values()) send(v.ws, { type: 'stream-ended' });
  roomEvents.emit('ended', room.id);
}

function handleViewer(room, ws) {
  const viewerId = crypto.randomUUID();
  const identity = makeIdentity(viewerId);
  room.viewers.set(viewerId, { ws, identity });

  send(ws, { type: 'welcome', name: room.name, live: room.live, game: room.game, you: identity });
  send(room.streamer, { type: 'viewer-joined', viewer: identity });
  broadcastViewers(room);

  ws.on('message', (raw) => {
    const msg = safeParse(raw);
    if (msg?.type === 'signal') send(room.streamer, { type: 'signal', from: viewerId, data: msg.data });
  });

  ws.on('close', () => {
    room.viewers.delete(viewerId);
    send(room.streamer, { type: 'viewer-left', viewerId });
    broadcastViewers(room);
  });
}
