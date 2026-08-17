import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { getRoom, roomEvents } from './rooms.js';

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

// Pushes current room metadata (e.g. the detected game) to everyone connected.
export function notifyRoomInfo(room) {
  const info = { type: 'room-info', name: room.name, game: room.game };
  send(room.streamer, info);
  for (const v of room.viewers.values()) send(v, info);
}

function broadcastViewerCount(room) {
  const count = room.viewers.size;
  for (const v of room.viewers.values()) send(v, { type: 'viewer-count', count });
  send(room.streamer, { type: 'viewer-count', count });
}

function handleStreamer(room, ws) {
  // A page refresh reconnects before the old socket dies — replace it.
  room.streamer?.close(4000, 'replaced by new streamer session');
  room.streamer = ws;

  send(ws, { type: 'hello', role: 'share', name: room.name, game: room.game, viewers: [...room.viewers.keys()] });
  broadcastViewerCount(room);

  ws.on('message', (raw) => {
    const msg = safeParse(raw);
    if (!msg) return;
    if (msg.type === 'signal' && msg.to) {
      send(room.viewers.get(msg.to), { type: 'signal', data: msg.data });
    } else if (msg.type === 'live') {
      room.live = true;
      room.liveAt = Date.now();
      for (const v of room.viewers.values()) send(v, { type: 'stream-live' });
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
  for (const v of room.viewers.values()) send(v, { type: 'stream-ended' });
  roomEvents.emit('ended', room.id);
}

function handleViewer(room, ws) {
  const viewerId = crypto.randomUUID();
  room.viewers.set(viewerId, ws);

  send(ws, { type: 'welcome', name: room.name, live: room.live, game: room.game });
  send(room.streamer, { type: 'viewer-joined', viewerId });
  broadcastViewerCount(room);

  ws.on('message', (raw) => {
    const msg = safeParse(raw);
    if (msg?.type === 'signal') send(room.streamer, { type: 'signal', from: viewerId, data: msg.data });
  });

  ws.on('close', () => {
    room.viewers.delete(viewerId);
    send(room.streamer, { type: 'viewer-left', viewerId });
    broadcastViewerCount(room);
  });
}
