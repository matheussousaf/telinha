import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADJECTIVES, NOUNS } from './words.js';

// Emits: 'live' (roomId), 'ended' (roomId). The bot listens to keep embeds fresh.
export const roomEvents = new EventEmitter();

const rooms = new Map();

// --- persistence -----------------------------------------------------------
// Rooms outlive server restarts, but only their shell is written to disk:
// id, name, owner key, timestamps. No identities, no thumbnails, no history —
// nothing about the people who use the room is ever persisted.
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');

function persist() {
  const shells = [...rooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    streamKey: r.streamKey,
    createdAt: r.createdAt,
    lastActiveAt: r.lastActiveAt,
    voiceChannelId: r.voiceChannelId ?? null,
    guildId: r.guildId ?? null,
  }));
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(shells));
  } catch (err) {
    console.warn('[rooms] persist failed:', err.message);
  }
}

function hydrate(shell) {
  return {
    ...shell,
    lastActiveAt: shell.lastActiveAt ?? shell.createdAt,
    voiceChannelId: shell.voiceChannelId ?? null,
    guildId: shell.guildId ?? null,
    voiceRoster: [], // RAM only — refreshed by the bot from the voice channel
    game: null,
    gameIconUrl: null,
    live: false,
    liveAt: 0,
    participants: new Map(), // participantId -> { ws, identity, token } — never persisted
    sharing: new Set(),
    thumbnail: null, // RAM only, gone on restart
    thumbnailAt: 0,
  };
}

try {
  const shells = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  for (const shell of shells) rooms.set(shell.id, hydrate(shell));
  if (rooms.size) console.log(`[rooms] restored ${rooms.size} room(s)`);
} catch {
  // first boot or no data file — start empty
}

// --- API -------------------------------------------------------------------

// Readable alias like "neon-falcon-4821". Room privacy relies on this being
// hard to enumerate; owner powers additionally require streamKey.
function readableId() {
  const pick = (list) => list[crypto.randomInt(list.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${crypto.randomInt(1000, 10000)}`;
}

export function createRoom(name = 'stream', meta = {}) {
  let id;
  do {
    id = readableId();
  } while (rooms.has(id));
  const room = hydrate({
    id,
    name: String(name).slice(0, 80),
    // Held only by the room's creator — grants owner powers (closing the room).
    streamKey: crypto.randomBytes(16).toString('base64url'),
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    voiceChannelId: meta.voiceChannelId ?? null,
    guildId: meta.guildId ?? null,
  });
  rooms.set(room.id, room);
  persist();
  return room;
}

export function getRoom(id) {
  return rooms.get(id);
}

export function listRooms() {
  return [...rooms.values()];
}

export function touchRoom(room) {
  room.lastActiveAt = Date.now();
}

export function deleteRoom(id) {
  rooms.delete(id);
  persist();
}

// Rooms persist until the owner closes them; abandoned ones (nobody inside for
// 30 days) are swept so the file doesn't grow forever.
setInterval(() => {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let swept = false;
  for (const [id, room] of rooms) {
    if (room.participants.size === 0 && room.lastActiveAt < cutoff) {
      rooms.delete(id);
      swept = true;
    }
  }
  if (swept) persist();
}, 60 * 60 * 1000).unref();
