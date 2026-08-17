// End-to-end WebRTC test: boots the server, opens a streamer page and a viewer
// page in headless Chrome (fake capture device standing in for the screen),
// and asserts real frames arrive at the viewer. Run: node scripts/e2e-webrtc.js
import puppeteer from 'puppeteer';

// E2E_BASE=https://ranx.gg targets a deployed server instead of booting one.
// E2E_RELAY=1 forces iceTransportPolicy 'relay' — the test then only passes
// if the TURN server actually works.
const TARGET = process.env.E2E_BASE;
const FORCE_RELAY = process.env.E2E_RELAY === '1';

if (!TARGET) {
  process.env.PORT = '4001';
  process.env.BASE_URL = 'http://localhost:4001';
  await import('../src/server.js');
  await new Promise((r) => setTimeout(r, 300));
}
const base = TARGET ?? 'http://localhost:4001';
console.log(`target: ${base}${FORCE_RELAY ? ' (TURN relay forced)' : ''}`);
const res = await fetch(`${base}/api/rooms`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'e2e' }),
});
const room = await res.json();
console.log(`room: ${room.id}`);

const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream', // fake camera produces a moving test pattern
    '--autoplay-policy=no-user-gesture-required',
  ],
});

function wirePage(page, label) {
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warn') console.log(`[${label} console.${t}] ${m.text()}`);
  });
  page.on('pageerror', (e) => console.log(`[${label} PAGEERROR] ${e.message}`));
}

// Instrument RTCPeerConnection: optionally force relay, always log ICE progress.
function instrumentRtc(page, forceRelay) {
  return page.evaluateOnNewDocument((relay) => {
    const Orig = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Orig {
      constructor(cfg = {}) {
        super(relay ? { ...cfg, iceTransportPolicy: 'relay' } : cfg);
        this.addEventListener('iceconnectionstatechange', () =>
          console.warn(`[ice] ${this.iceConnectionState}`),
        );
        this.addEventListener('icecandidateerror', (e) =>
          console.warn(`[ice-err] ${e.errorCode} ${e.errorText} url=${e.url}`),
        );
      }
    };
  }, forceRelay);
}

// Streamer: stand in for getDisplayMedia with the fake camera — the capture
// API isn't the suspect; the transport and rendering path is.
const streamer = await browser.newPage();
wirePage(streamer, 'share');
await instrumentRtc(streamer, FORCE_RELAY);
await streamer.evaluateOnNewDocument(() => {
  navigator.mediaDevices.getDisplayMedia = (opts) =>
    navigator.mediaDevices.getUserMedia({ video: true, audio: false });
});
await streamer.goto(`${base}${new URL(room.shareUrl).pathname}${new URL(room.shareUrl).search}`);
await streamer.waitForSelector('button');
await new Promise((r) => setTimeout(r, 800)); // let the WS connect
await streamer.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Iniciar'));
  if (!btn) throw new Error('start button not found');
  btn.click();
});

// Viewer
const viewer = await browser.newPage();
wirePage(viewer, 'watch');
await instrumentRtc(viewer, FORCE_RELAY);
await viewer.goto(`${base}/watch/${room.id}`);

// Give the handshake a few seconds, then interrogate the viewer's video element.
await new Promise((r) => setTimeout(r, 6000));

const state = await viewer.evaluate(async () => {
  const v = document.querySelector('video');
  const first = v.currentTime;
  await new Promise((r) => setTimeout(r, 1200));
  const c = document.createElement('canvas');
  let luma = -1;
  if (v.videoWidth) {
    c.width = 64;
    c.height = 36;
    c.getContext('2d').drawImage(v, 0, 0, 64, 36);
    const d = c.getContext('2d').getImageData(0, 0, 64, 36).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    luma = sum / (d.length / 4);
  }
  return {
    hasSrcObject: !!v.srcObject,
    videoWidth: v.videoWidth,
    videoHeight: v.videoHeight,
    paused: v.paused,
    readyState: v.readyState,
    timeAdvancing: v.currentTime > first,
    currentTime: v.currentTime,
    meanLuma: Math.round(luma * 10) / 10,
    overlayText: document.querySelector('main')?.innerText?.split('\n').slice(0, 6).join(' | '),
  };
});

console.log('viewer state:', JSON.stringify(state, null, 2));

const ok = state.hasSrcObject && state.videoWidth > 0 && !state.paused && state.timeAdvancing && state.meanLuma > 1;
console.log(
  ok
    ? '\nE2E PASS: viewer is receiving and rendering real frames (not black).'
    : '\nE2E FAIL: media not flowing or rendering black — see state above.',
);

await browser.close();
process.exit(ok ? 0 : 1);
