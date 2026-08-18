import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { createRoom, getRoom } from './rooms.js';
import { attachSignaling } from './signaling.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');
if (!fs.existsSync(INDEX_HTML)) {
  console.warn('[web] web/dist not found — run `npm run build` first (pages will 404 until then)');
}
const PORT = Number(process.env.PORT ?? 3000);

export const BASE_URL = (process.env.BASE_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');

export function describeRoom(room, withKey = false) {
  const out = { id: room.id, name: room.name, roomUrl: `${BASE_URL}/room/${room.id}` };
  if (withKey) out.ownerUrl = `${BASE_URL}/room/${room.id}?key=${room.streamKey}`;
  return out;
}

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// SPA routes — React Router takes it from here client-side.
// /share and /watch are legacy paths that redirect to /room in the client.
app.get('/room/:room', (_req, res) => res.sendFile(INDEX_HTML));
app.get('/share/:room', (_req, res) => res.sendFile(INDEX_HTML));
app.get('/watch/:room', (_req, res) => res.sendFile(INDEX_HTML));

app.get('/api/config', (_req, res) => {
  const iceServers = [{ urls: process.env.STUN_URL ?? 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    // Offer UDP and TCP transports; TCP saves viewers on UDP-hostile networks.
    const urls = [process.env.TURN_URL];
    if (!process.env.TURN_URL.includes('?')) urls.push(`${process.env.TURN_URL}?transport=tcp`);
    iceServers.push({
      urls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_PASSWORD,
    });
  }
  res.json({ iceServers, livekitUrl: process.env.LIVEKIT_URL ?? null });
});

// LiveKit access token. Auth chain: the WS welcome hands each participant a
// secret token; presenting it here proves who you are in that room, and the
// minted JWT carries the same participant id as its LiveKit identity.
app.post('/api/rooms/:id/lk-token', express.json(), async (req, res) => {
  const room = getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'room not found' });
  const entry = [...room.participants.entries()].find(([, p]) => p.token === req.body?.token);
  if (!entry) return res.status(403).json({ error: 'unknown participant token' });
  if (!process.env.LIVEKIT_API_KEY) return res.status(503).json({ error: 'livekit not configured' });
  const [pid, participant] = entry;
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: pid,
    name: participant.identity.name,
    ttl: '12h',
  });
  at.addGrant({ room: room.id, roomJoin: true, canPublish: true, canSubscribe: true });
  res.json({ token: await at.toJwt() });
});

app.post('/api/rooms', (req, res) => {
  const room = createRoom(req.body?.name || 'stream');
  res.json(describeRoom(room, true));
});

app.get('/api/rooms/:id', (req, res) => {
  const room = getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'not found' });
  res.json({
    id: room.id,
    name: room.name,
    live: room.live,
    participants: room.participants.size,
    sharing: room.sharing.size,
    voiceRoster: room.voiceRoster ?? [],
  });
});

app.post('/api/rooms/:id/thumbnail', express.raw({ type: 'image/jpeg', limit: '1mb' }), (req, res) => {
  const room = getRoom(req.params.id);
  if (!room) return res.status(404).end();
  const entry = [...room.participants.entries()].find(([, p]) => p.token === req.query.token);
  if (!entry) return res.status(403).end();
  if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    room.thumbnails.set(entry[0], { buf: req.body, at: Date.now() });
  }
  res.status(204).end();
});

function latestThumb(room) {
  let latest = null;
  for (const t of room.thumbnails.values()) if (!latest || t.at > latest.at) latest = t;
  return latest;
}

// Per-sharer preview (the "shared but not focused" tile state).
app.get('/thumbs/:room/:pid', (req, res) => {
  const room = getRoom(req.params.room);
  const t = room?.thumbnails.get(req.params.pid.replace(/\.jpg$/, ''));
  if (!t) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(t.buf);
});

// Legacy room-level thumbnail (Discord embed): newest of any sharer.
app.get('/thumbs/:file', (req, res) => {
  const room = getRoom(req.params.file.replace(/\.jpg$/, ''));
  const t = room && latestThumb(room);
  if (!t) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(t.buf);
});

const server = http.createServer(app);
attachSignaling(server);
server.listen(PORT, () => console.log(`[web] listening on port ${PORT} — ${BASE_URL}`));
