import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { deleteRoom, getRoom, roomEvents, touchRoom } from './rooms.js';
import { PROTOCOL_VERSION } from './protocol.js';

// Fallback identities for people who skip picking a name.
const ANON_ANIMALS = [
  'capivara', 'tucano', 'jabuti', 'arara', 'boto', 'mico', 'tatu', 'quati',
  'axolote', 'onça', 'sagui', 'lontra', 'tamanduá', 'seriema', 'maritaca', 'curió',
];
const AVATAR_EMOJI = ['🦫', '🦜', '🐢', '🦉', '🐬', '🐵', '🦔', '🦝', '🦎', '🐆', '🐒', '🦦', '🐜', '🦤', '🦩', '🐦'];
const AVATAR_COLORS = ['#5865F2', '#23A55A', '#F0B232', '#ED4245', '#EB459E', '#3BA6C4', '#9B59B6', '#E67E22', '#795548', '#607D8B'];

function makeIdentity(id, name, owner) {
  const i = crypto.randomInt(ANON_ANIMALS.length);
  return {
    id,
    name: (name || '').trim().slice(0, 32) || `${ANON_ANIMALS[i]} #${crypto.randomInt(1, 100)}`,
    emoji: AVATAR_EMOJI[i],
    color: AVATAR_COLORS[crypto.randomInt(AVATAR_COLORS.length)],
    owner,
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

    const key = url.searchParams.get('key');
    if (key && key !== room.streamKey) return ws.close(4003, 'bad owner key');

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    handleParticipant(room, ws, url.searchParams.get('name'), key === room.streamKey);
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

function roster(room) {
  return [...room.participants.values()].map((p) => p.identity);
}

function broadcast(room, msg) {
  for (const p of room.participants.values()) send(p.ws, msg);
}

function broadcastRoster(room) {
  broadcast(room, { type: 'participants', participants: roster(room), sharing: [...room.sharing] });
}

// Pushes current room metadata (e.g. the detected game) to everyone connected.
export function notifyRoomInfo(room) {
  broadcast(room, { type: 'room-info', name: room.name, game: room.game });
}

function handleParticipant(room, ws, name, owner) {
  const id = crypto.randomUUID();
  const identity = makeIdentity(id, name, owner);
  const token = crypto.randomBytes(12).toString('base64url'); // authorizes thumbnail uploads
  room.participants.set(id, { ws, identity, token });
  touchRoom(room);

  send(ws, {
    type: 'welcome',
    proto: PROTOCOL_VERSION,
    you: identity,
    token,
    name: room.name,
    game: room.game,
    participants: roster(room),
    sharing: [...room.sharing],
  });
  broadcastRoster(room);

  ws.on('message', (raw) => {
    const msg = safeParse(raw);
    if (!msg) return;
    if (msg.type === 'signal' && msg.to) {
      send(room.participants.get(msg.to)?.ws, { type: 'signal', from: id, sharer: msg.sharer, data: msg.data });
    } else if (msg.type === 'share-start') {
      room.sharing.add(id);
      broadcastRoster(room);
      if (!room.live) {
        room.live = true;
        room.liveAt = Date.now();
        roomEvents.emit('live', room.id);
      }
    } else if (msg.type === 'share-stop') {
      stopSharing(room, id);
    } else if (msg.type === 'close' && identity.owner) {
      closeRoom(room);
    }
  });

  ws.on('close', () => {
    if (!room.participants.has(id)) return; // room was closed
    room.participants.delete(id);
    stopSharing(room, id);
    broadcastRoster(room);
  });
}

function stopSharing(room, id) {
  if (!room.sharing.delete(id)) return;
  broadcastRoster(room);
  if (room.sharing.size === 0 && room.live) {
    room.live = false;
    roomEvents.emit('ended', room.id);
  }
}

function closeRoom(room) {
  broadcast(room, { type: 'room-closed' });
  for (const p of room.participants.values()) p.ws.close(4001, 'room closed');
  room.participants.clear();
  room.sharing.clear();
  if (room.live) {
    room.live = false;
    roomEvents.emit('ended', room.id);
  }
  roomEvents.emit('closed', room.id);
  deleteRoom(room.id);
}
