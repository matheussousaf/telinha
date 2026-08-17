import { fetchRtcConfig, wsConnect } from './common.js';

const roomId = location.pathname.split('/').pop();

const video = document.querySelector('video');
const overlay = document.getElementById('overlay');
const titleEl = document.getElementById('title');
const countEl = document.getElementById('count');
const unmuteBtn = document.getElementById('unmute');
const pipBtn = document.getElementById('pip');
const fullBtn = document.getElementById('full');

let rtcConfig = { iceServers: [] };
let ws = null;
let pc = null;

init();

async function init() {
  rtcConfig = await fetchRtcConfig();
  connect();
}

function connect() {
  ws = wsConnect({ room: roomId, role: 'watch' }, handleMessage, (e) => {
    if (e.code === 4004) {
      setOverlay('Room not found — ask for a fresh link.');
      return;
    }
    setOverlay('Disconnected — reconnecting…');
    setTimeout(connect, 2000);
  });
}

async function handleMessage(msg) {
  if (msg.type === 'welcome') {
    titleEl.textContent = msg.name;
    document.title = `${msg.name} — telinha`;
    applyGame(msg.game);
    setOverlay(msg.live ? 'Connecting to stream…' : 'Waiting for the stream to start…');
  } else if (msg.type === 'room-info') {
    applyGame(msg.game);
  } else if (msg.type === 'stream-live') {
    setOverlay('Connecting to stream…');
  } else if (msg.type === 'stream-ended') {
    pc?.close();
    pc = null;
    video.srcObject = null;
    setOverlay('Stream ended.');
  } else if (msg.type === 'viewer-count') {
    countEl.textContent = `${msg.count} watching`;
  } else if (msg.type === 'signal') {
    await handleSignal(msg.data);
  }
}

async function handleSignal(data) {
  if (data.sdp) {
    // A fresh offer means a (re)started stream — replace any old connection.
    pc?.close();
    pc = new RTCPeerConnection(rtcConfig);
    pc.ontrack = (e) => {
      video.srcObject = e.streams[0];
      overlay.classList.add('hidden');
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) ws.send(JSON.stringify({ type: 'signal', data: { candidate: e.candidate } }));
    };
    pc.onconnectionstatechange = () => {
      if (pc?.connectionState === 'failed') setOverlay('Connection lost.');
    };
    await pc.setRemoteDescription(data.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({ type: 'signal', data: { sdp: pc.localDescription } }));
  } else if (data.candidate) {
    await pc?.addIceCandidate(data.candidate).catch(() => {});
  }
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

function setOverlay(text) {
  overlay.textContent = text;
  overlay.classList.remove('hidden');
}

unmuteBtn.onclick = () => {
  video.muted = !video.muted;
  unmuteBtn.textContent = video.muted ? '🔊 Unmute' : '🔇 Mute';
};

pipBtn.onclick = async () => {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch {
    // no video yet, or the browser doesn't support PiP
  }
};

fullBtn.onclick = () => video.requestFullscreen?.().catch(() => {});
