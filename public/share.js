import { fetchRtcConfig, wsConnect } from './common.js';

const roomId = location.pathname.split('/').pop();
const streamKey = new URLSearchParams(location.search).get('key') ?? '';

const video = document.querySelector('video');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');

let rtcConfig = { iceServers: [] };
let ws = null;
let stream = null;
let thumbTimer = null;
const peers = new Map(); // viewerId -> RTCPeerConnection
const viewers = new Set(); // viewerIds currently in the room

init();

async function init() {
  rtcConfig = await fetchRtcConfig();
  connect();
}

function connect() {
  ws = wsConnect({ room: roomId, role: 'share', key: streamKey }, handleMessage, (e) => {
    if (e.code === 4003 || e.code === 4004) {
      statusEl.textContent = e.code === 4003 ? 'invalid streamer key' : 'room not found';
      return;
    }
    if (e.code === 4000) return; // this tab was replaced by a newer one
    statusEl.textContent = 'reconnecting…';
    setTimeout(connect, 2000);
  });
}

async function handleMessage(msg) {
  if (msg.type === 'hello') {
    document.getElementById('title').textContent = msg.name;
    document.title = `${msg.name} — telinha`;
    applyGame(msg.game);
    viewers.clear();
    msg.viewers.forEach((id) => viewers.add(id));
    statusEl.textContent = stream ? 'live' : 'ready';
    statusEl.classList.toggle('live', !!stream);
    if (stream) {
      // Reconnected mid-stream: re-announce and offer to anyone not yet connected.
      ws.send(JSON.stringify({ type: 'live' }));
      for (const id of viewers) if (!peers.has(id)) await offerTo(id);
    }
  } else if (msg.type === 'viewer-joined') {
    viewers.add(msg.viewerId);
    if (stream) await offerTo(msg.viewerId);
  } else if (msg.type === 'viewer-left') {
    viewers.delete(msg.viewerId);
    peers.get(msg.viewerId)?.close();
    peers.delete(msg.viewerId);
  } else if (msg.type === 'room-info') {
    applyGame(msg.game);
  } else if (msg.type === 'viewer-count') {
    countEl.textContent = `${msg.count} watching`;
  } else if (msg.type === 'signal') {
    const pc = peers.get(msg.from);
    if (!pc) return;
    if (msg.data.sdp) await pc.setRemoteDescription(msg.data.sdp);
    else if (msg.data.candidate) await pc.addIceCandidate(msg.data.candidate).catch(() => {});
  }
}

startBtn.onclick = async () => {
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    return; // user cancelled the picker
  }

  const [videoTrack] = stream.getVideoTracks();
  videoTrack.contentHint = 'motion'; // favor framerate over sharpness — right call for games
  videoTrack.addEventListener('ended', stopSharing); // browser's own "Stop sharing" button

  video.srcObject = stream;
  overlay.classList.add('hidden');
  startBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  statusEl.textContent = 'live';
  statusEl.classList.add('live');

  ws.send(JSON.stringify({ type: 'live' }));
  for (const id of viewers) await offerTo(id);

  thumbTimer = setInterval(uploadThumbnail, 10_000);
  setTimeout(uploadThumbnail, 1500); // give the video element a moment to get frames
};

stopBtn.onclick = stopSharing;

function stopSharing() {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  for (const pc of peers.values()) pc.close();
  peers.clear();
  clearInterval(thumbTimer);
  ws?.send(JSON.stringify({ type: 'end' }));
  overlay.textContent = 'Stream ended — you can start again.';
  overlay.classList.remove('hidden');
  startBtn.classList.remove('hidden');
  stopBtn.classList.add('hidden');
  statusEl.textContent = 'ready';
  statusEl.classList.remove('live');
}

async function offerTo(viewerId) {
  peers.get(viewerId)?.close();
  const pc = new RTCPeerConnection(rtcConfig);
  peers.set(viewerId, pc);

  for (const track of stream.getTracks()) {
    if (track.kind === 'video') {
      pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream],
        sendEncodings: [{ maxBitrate: 8_000_000 }],
      });
    } else {
      pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    }
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: 'signal', to: viewerId, data: { candidate: e.candidate } }));
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'signal', to: viewerId, data: { sdp: pc.localDescription } }));
}

function applyGame(game) {
  const el = document.getElementById('game');
  if (game) {
    el.textContent = `🎮 ${game}`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

const thumbCanvas = document.createElement('canvas');

async function uploadThumbnail() {
  if (!stream || !video.videoWidth) return;
  const width = 640;
  thumbCanvas.width = width;
  thumbCanvas.height = Math.round((video.videoHeight / video.videoWidth) * width);
  thumbCanvas.getContext('2d').drawImage(video, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const blob = await new Promise((r) => thumbCanvas.toBlob(r, 'image/jpeg', 0.7));
  if (!blob) return;
  fetch(`/api/rooms/${roomId}/thumbnail?key=${encodeURIComponent(streamKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  }).catch(() => {});
}
