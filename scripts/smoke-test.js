// Boots the server on a test port and exercises the room + signaling flow
// end to end with fake streamer/viewer WebSocket clients. Run: npm run smoke
import { WebSocket } from 'ws';

process.env.PORT = '3999';
process.env.BASE_URL = 'http://localhost:3999';
await import('../src/server.js');
const { getRoom } = await import('../src/rooms.js');
const { notifyRoomInfo } = await import('../src/signaling.js');
await new Promise((r) => setTimeout(r, 300));

const base = 'http://localhost:3999';
let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

// Room creation
const res = await fetch(`${base}/api/rooms`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'smoke' }),
});
const room = await res.json();
check(room.id && room.shareUrl && room.watchUrl, 'room created with share + watch URLs');
const streamKey = new URL(room.shareUrl).searchParams.get('key');

// WS helper: buffers messages, next(type) resolves the first message of that type
function open(params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:3999/ws?${new URLSearchParams(params)}`);
    const buffered = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.type === msg.type);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else buffered.push(msg);
    });
    ws.next = (type) => {
      const i = buffered.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(buffered.splice(i, 1)[0]);
      return new Promise((res2, rej2) => {
        waiters.push({ type, resolve: res2 });
        setTimeout(() => rej2(new Error(`timeout waiting for '${type}'`)), 3000).unref();
      });
    };
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Wrong stream key is rejected
const badKeyCode = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://localhost:3999/ws?${new URLSearchParams({ room: room.id, role: 'share', key: 'wrong' })}`);
  ws.on('close', (code) => resolve(code));
  ws.on('error', () => {});
});
check(badKeyCode === 4003, 'wrong stream key closed with 4003');

// Streamer + viewer handshake
const streamer = await open({ room: room.id, role: 'share', key: streamKey });
const hello = await streamer.next('hello');
check(hello.role === 'share' && hello.name === 'smoke', 'streamer hello');

const viewer = await open({ room: room.id, role: 'watch' });
const welcome = await viewer.next('welcome');
check(welcome.live === false, 'viewer welcome (not live yet)');
const joined = await streamer.next('viewer-joined');
check(Boolean(joined.viewerId), 'streamer notified of viewer join');

streamer.send(JSON.stringify({ type: 'live' }));
await viewer.next('stream-live');
check(true, 'viewer received stream-live');

// Signal relay in both directions
streamer.send(JSON.stringify({ type: 'signal', to: joined.viewerId, data: { sdp: { type: 'offer', sdp: 'x' } } }));
const offer = await viewer.next('signal');
check(offer.data?.sdp?.type === 'offer', 'offer relayed streamer → viewer');

viewer.send(JSON.stringify({ type: 'signal', data: { sdp: { type: 'answer', sdp: 'y' } } }));
const answer = await streamer.next('signal');
check(answer.from === joined.viewerId && answer.data?.sdp?.type === 'answer', 'answer relayed viewer → streamer');

// Thumbnails
const upload = await fetch(`${base}/api/rooms/${room.id}/thumbnail?key=${streamKey}`, {
  method: 'POST',
  headers: { 'Content-Type': 'image/jpeg' },
  body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
});
check(upload.status === 204, 'thumbnail upload accepted');
const download = await fetch(`${base}/thumbs/${room.id}.jpg`);
check(download.status === 200, 'thumbnail served');
const badUpload = await fetch(`${base}/api/rooms/${room.id}/thumbnail?key=nope`, {
  method: 'POST',
  headers: { 'Content-Type': 'image/jpeg' },
  body: Buffer.from([1]),
});
check(badUpload.status === 403, 'thumbnail upload with wrong key rejected');

// Game detection update fan-out (the bot sets room.game and calls notifyRoomInfo)
const serverRoom = getRoom(room.id);
serverRoom.game = 'VALORANT';
notifyRoomInfo(serverRoom);
const viewerInfo = await viewer.next('room-info');
const streamerInfo = await streamer.next('room-info');
check(viewerInfo.game === 'VALORANT' && streamerInfo.game === 'VALORANT', 'game update pushed to viewer and streamer');

// End of stream
streamer.send(JSON.stringify({ type: 'end' }));
await viewer.next('stream-ended');
check(true, 'viewer received stream-ended');

const state = await (await fetch(`${base}/api/rooms/${room.id}`)).json();
check(state.live === false && state.viewers === 1, 'room state reflects ended stream');

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
