import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { ADJECTIVES, NOUNS } from './words.js';

// Emits: 'live' (roomId), 'ended' (roomId). The bot listens to keep embeds fresh.
export const roomEvents = new EventEmitter();

const rooms = new Map();

// Readable alias like "neon-falcon-4821". The watch link's privacy relies on
// this being hard to enumerate; broadcasting additionally requires streamKey.
function readableId() {
  const pick = (list) => list[crypto.randomInt(list.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${crypto.randomInt(1000, 10000)}`;
}

export function createRoom(name = 'stream') {
  let id;
  do {
    id = readableId();
  } while (rooms.has(id));
  const room = {
    id,
    name: String(name).slice(0, 80),
    // Secret held only by whoever created the room — required to broadcast
    // and to upload thumbnails. Viewers never see it.
    streamKey: crypto.randomBytes(16).toString('base64url'),
    createdAt: Date.now(),
    game: null, // detected game name (from Discord presence)
    gameIconUrl: null,
    live: false,
    liveAt: 0,
    streamer: null, // WebSocket of the active broadcaster
    viewers: new Map(), // viewerId -> WebSocket
    thumbnail: null, // Buffer (jpeg)
    thumbnailAt: 0,
  };
  rooms.set(room.id, room);
  return room;
}

export function getRoom(id) {
  return rooms.get(id);
}

// Drop rooms nobody has touched for 6 hours.
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, room] of rooms) {
    const lastSeen = Math.max(room.createdAt, room.liveAt, room.thumbnailAt);
    if (!room.streamer && room.viewers.size === 0 && lastSeen < cutoff) rooms.delete(id);
  }
}, 10 * 60 * 1000).unref();
