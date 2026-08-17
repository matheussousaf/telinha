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

async function joinRoom(page, url, name) {
  await page.goto(url);
  await page.waitForSelector('#name');
  await page.type('#name', name);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Entrar na sala'));
    btn.click();
  });
  await new Promise((r) => setTimeout(r, 800)); // let the WS connect
}

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

// Stand in for getDisplayMedia with the fake camera — the capture API isn't
// the suspect; the transport and rendering path is.
const patchCapture = (page) =>
  page.evaluateOnNewDocument(() => {
    // Fake devices: moving test pattern + sine tone, so audio is measurable.
    navigator.mediaDevices.getDisplayMedia = () =>
      navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  });

const clickShare = (page) =>
  page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Compartilhar'));
    if (!btn) throw new Error('share button not found');
    btn.click();
  });

const clickTileByName = (page, name) =>
  page.evaluate((n) => {
    const tile = [...document.querySelectorAll('div')].find(
      (d) => typeof d.className === 'string' && d.className.includes('cursor-pointer') && d.innerText.includes(n),
    );
    if (!tile) throw new Error(`clickable tile not found for "${n}"`);
    tile.click();
  }, name);

const streamer = await (await browser.createBrowserContext()).newPage();
wirePage(streamer, 'share');
await instrumentRtc(streamer, FORCE_RELAY);
await patchCapture(streamer);
await joinRoom(streamer, `${base}${new URL(room.ownerUrl).pathname}${new URL(room.ownerUrl).search}`, 'e2e-dono');
await clickShare(streamer);

// Viewer joins through the plain room link
const viewer = await (await browser.createBrowserContext()).newPage();
wirePage(viewer, 'watch');
await instrumentRtc(viewer, FORCE_RELAY);
await joinRoom(viewer, `${base}/room/${room.id}`, 'e2e-amigo');

// Give the handshake a few seconds, then interrogate the viewer's video element.
await new Promise((r) => setTimeout(r, 6000));

async function frameState(page) {
  return page.evaluate(async () => {
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
      hasSrcObject: !!v?.srcObject,
      videoWidth: v?.videoWidth ?? 0,
      paused: v?.paused ?? true,
      timeAdvancing: v ? v.currentTime > first : false,
      meanLuma: Math.round(luma * 10) / 10,
    };
  });
}

const isGood = (s) => s.hasSrcObject && s.videoWidth > 0 && !s.paused && s.timeAdvancing && s.meanLuma > 1;

const state = await frameState(viewer);
console.log('first watch:', JSON.stringify(state));
const firstOk = isGood(state);

// Audio: does the focused stream carry an audible track?
const audioState = await viewer.evaluate(async () => {
  const v = document.querySelector('video');
  const tracks = v?.srcObject ? v.srcObject.getAudioTracks() : [];
  let rms = 0;
  if (tracks.length) {
    const ac = new AudioContext();
    const src = ac.createMediaStreamSource(new MediaStream([tracks[0]]));
    const an = ac.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    await new Promise((r) => setTimeout(r, 700));
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    rms = Math.sqrt(buf.reduce((a, x) => a + x * x, 0) / buf.length);
    await ac.close();
  }
  return { audioTracks: tracks.length, muted: v?.muted, volume: v?.volume, rms: Number(rms.toFixed(4)) };
});
console.log('audio state:', JSON.stringify(audioState));
const audioOk = audioState.audioTracks > 0 && audioState.muted === false && audioState.rms > 0.005;

// Regression check: unfocus (click the big tile), then focus the sharer again.
await viewer.evaluate(() => document.querySelector('.tile-focused')?.click());
await new Promise((r) => setTimeout(r, 1500));
await viewer.evaluate(() => {
  const tile = [...document.querySelectorAll('div')].find(
    (d) => typeof d.className === 'string' && d.className.includes('cursor-pointer'),
  );
  if (!tile) throw new Error('no clickable sharer tile after unfocus');
  tile.click();
});
await new Promise((r) => setTimeout(r, 5000));

const state2 = await frameState(viewer);
console.log('after unfocus and refocus:', JSON.stringify(state2));
const secondOk = isGood(state2);

// The reported bug: TWO sharers, switch A -> B -> back to A.
const sharer2 = await (await browser.createBrowserContext()).newPage();
wirePage(sharer2, 'share2');
await instrumentRtc(sharer2, FORCE_RELAY);
await patchCapture(sharer2);
await joinRoom(sharer2, `${base}/room/${room.id}`, 'e2e-b');
await clickShare(sharer2);
await new Promise((r) => setTimeout(r, 1500));

await clickTileByName(viewer, 'e2e-b'); // switch A -> B
await new Promise((r) => setTimeout(r, 5000));
const state3 = await frameState(viewer);
console.log('watching second sharer:', JSON.stringify(state3));
const thirdOk = isGood(state3);

await clickTileByName(viewer, 'e2e-dono'); // switch B -> back to A
await new Promise((r) => setTimeout(r, 5000));
const state4 = await frameState(viewer);
console.log('back to first sharer:', JSON.stringify(state4));
const fourthOk = isGood(state4);

console.log(firstOk ? 'ok    first watch renders frames' : 'FAIL  first watch broken');
console.log(audioOk ? 'ok    audio track present, unmuted, audible' : 'FAIL  audio missing/muted/silent');
console.log(secondOk ? 'ok    re-watch after unfocus renders frames' : 'FAIL  re-watch after unfocus broken');
console.log(thirdOk ? 'ok    switch to second sharer renders frames' : 'FAIL  switch to second sharer broken');
console.log(fourthOk ? 'ok    switch BACK to first sharer renders frames' : 'FAIL  switch back broken (reported bug)');
const allOk = firstOk && audioOk && secondOk && thirdOk && fourthOk;
console.log(allOk ? '\nE2E PASS: all watch/switch paths render real frames.' : '\nE2E FAIL — see states above.');

await browser.close();
process.exit(allOk ? 0 : 1);
