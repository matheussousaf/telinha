// Boots the server on a test port and exercises the room + signaling flow
// (protocol v3: participants, multi-share, owner close). Run: npm run smoke
import { WebSocket } from 'ws';

process.env.PORT = '3999';
process.env.BASE_URL = 'http://localhost:3999';
await import('../src/server.js');
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
check(room.id && room.roomUrl && room.ownerUrl, 'room created with room + owner URLs');
const ownerKey = new URL(room.ownerUrl).searchParams.get('key');

// WS helper: buffers messages, next(type, pred?) resolves the first match
function open(params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:3999/ws?${new URLSearchParams(params)}`);
    const buffered = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.type === msg.type && (!w.pred || w.pred(msg)));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else buffered.push(msg);
    });
    ws.next = (type, pred) => {
      const i = buffered.findIndex((m) => m.type === type && (!pred || pred(m)));
      if (i >= 0) return Promise.resolve(buffered.splice(i, 1)[0]);
      return new Promise((res2, rej2) => {
        waiters.push({ type, pred, resolve: res2 });
        setTimeout(() => rej2(new Error(`timeout waiting for '${type}'`)), 3000).unref();
      });
    };
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Wrong owner key is rejected
const badKeyCode = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://localhost:3999/ws?${new URLSearchParams({ room: room.id, key: 'wrong' })}`);
  ws.on('close', (code) => resolve(code));
  ws.on('error', () => {});
});
check(badKeyCode === 4003, 'wrong owner key closed with 4003');

// Owner + guest join
const owner = await open({ room: room.id, name: 'dono', key: ownerKey });
const ownerHello = await owner.next('welcome');
check(ownerHello.you.owner === true && !!ownerHello.token, 'owner welcome with owner flag + token');

const guest = await open({ room: room.id, name: 'amigo' });
const guestHello = await guest.next('welcome');
check(guestHello.you.owner === false && guestHello.you.name === 'amigo', 'guest welcome with custom name');
const guestId = guestHello.you.id;
const ownerId = ownerHello.you.id;

const rosterAtOwner = await owner.next('participants', (m) => m.participants.length === 2);
check(rosterAtOwner.participants.some((p) => p.id === guestId), 'owner sees guest in roster');

// Guest starts sharing (anyone can share)
guest.send(JSON.stringify({ type: 'share-start' }));
const sharingRoster = await owner.next('participants', (m) => m.sharing.length === 1);
check(sharingRoster.sharing[0] === guestId, 'guest sharing broadcast to room');

// Media signaling: guest (sharer) offers to owner, owner answers — sharer-tagged
guest.send(JSON.stringify({ type: 'signal', to: ownerId, sharer: guestId, data: { sdp: { type: 'offer', sdp: 'x' } } }));
const offer = await owner.next('signal');
check(offer.from === guestId && offer.sharer === guestId && offer.data.sdp.type === 'offer', 'offer relayed with sharer tag');

owner.send(JSON.stringify({ type: 'signal', to: guestId, sharer: guestId, data: { sdp: { type: 'answer', sdp: 'y' } } }));
const answer = await guest.next('signal');
check(answer.from === ownerId && answer.sharer === guestId && answer.data.sdp.type === 'answer', 'answer relayed back');

// Thumbnails: any participant token works, junk doesn't
const up = await fetch(`${base}/api/rooms/${room.id}/thumbnail?token=${guestHello.token}`, {
  method: 'POST',
  headers: { 'Content-Type': 'image/jpeg' },
  body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
});
check(up.status === 204, 'thumbnail upload with participant token');
const badUp = await fetch(`${base}/api/rooms/${room.id}/thumbnail?token=nope`, {
  method: 'POST',
  headers: { 'Content-Type': 'image/jpeg' },
  body: Buffer.from([1]),
});
check(badUp.status === 403, 'thumbnail upload with junk token rejected');

// Guest stops sharing — room stays open
guest.send(JSON.stringify({ type: 'share-stop' }));
await owner.next('participants', (m) => m.sharing.length === 0);
const state = await (await fetch(`${base}/api/rooms/${room.id}`)).json();
check(state.live === false && state.participants === 2, 'room idle but open after share stops');

// Guest cannot close; owner can
guest.send(JSON.stringify({ type: 'close' }));
await new Promise((r) => setTimeout(r, 300));
const stillThere = await (await fetch(`${base}/api/rooms/${room.id}`)).json();
check(stillThere.id === room.id, 'guest close ignored');

owner.send(JSON.stringify({ type: 'close' }));
const closedMsg = await guest.next('room-closed');
check(!!closedMsg, 'guest notified of room close');
await new Promise((r) => setTimeout(r, 300));
const gone = await fetch(`${base}/api/rooms/${room.id}`);
check(gone.status === 404, 'room deleted after owner close');

console.log(failures === 0 ? '\nAll smoke tests passed.' : `\n${failures} smoke test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
