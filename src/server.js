import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createRoom, getRoom } from './rooms.js';
import { attachSignaling } from './signaling.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT ?? 3000);

export const BASE_URL = (process.env.BASE_URL ?? `http://localhost:${PORT}`).replace(/\/+$/, '');

export function describeRoom(room, withKey = false) {
  const out = { id: room.id, name: room.name, watchUrl: `${BASE_URL}/watch/${room.id}` };
  if (withKey) out.shareUrl = `${BASE_URL}/share/${room.id}?key=${room.streamKey}`;
  return out;
}

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/share/:room', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'share.html')));
app.get('/watch/:room', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'watch.html')));

app.get('/api/config', (_req, res) => {
  const iceServers = [{ urls: process.env.STUN_URL ?? 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_PASSWORD,
    });
  }
  res.json({ iceServers });
});

app.post('/api/rooms', (req, res) => {
  const room = createRoom(req.body?.name || 'stream');
  res.json(describeRoom(room, true));
});

app.get('/api/rooms/:id', (req, res) => {
  const room = getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'not found' });
  res.json({ id: room.id, name: room.name, live: room.live, viewers: room.viewers.size });
});

app.post('/api/rooms/:id/thumbnail', express.raw({ type: 'image/jpeg', limit: '1mb' }), (req, res) => {
  const room = getRoom(req.params.id);
  if (!room) return res.status(404).end();
  if (req.query.key !== room.streamKey) return res.status(403).end();
  if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    room.thumbnail = req.body;
    room.thumbnailAt = Date.now();
  }
  res.status(204).end();
});

app.get('/thumbs/:file', (req, res) => {
  const room = getRoom(req.params.file.replace(/\.jpg$/, ''));
  if (!room?.thumbnail) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(room.thumbnail);
});

const server = http.createServer(app);
attachSignaling(server);
server.listen(PORT, () => console.log(`[web] listening on port ${PORT} — ${BASE_URL}`));
