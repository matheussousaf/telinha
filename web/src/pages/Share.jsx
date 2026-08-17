import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchRtcConfig, openSignaling, isStale, STALE_PAGE_MSG } from '../api.js';
import TopBar from '../components/TopBar.jsx';
import Facepile from '../components/Facepile.jsx';

const IDLE_OVERLAY = 'Clique em “Iniciar transmissão” e escolha a janela do jogo.';

export default function Share() {
  const { roomId } = useParams();
  const streamKey = useMemo(() => new URLSearchParams(window.location.search).get('key') ?? '', []);
  const watchUrl = `${window.location.origin}/watch/${roomId}`;

  const videoRef = useRef(null);
  const wsRef = useRef(null);
  const rtcRef = useRef({ iceServers: [] });
  const streamRef = useRef(null);
  const peersRef = useRef(new Map()); // viewerId -> RTCPeerConnection
  const viewersRef = useRef(new Set());
  const thumbTimerRef = useRef(null);
  const unmountedRef = useRef(false);

  const [title, setTitle] = useState('Compartilhar tela');
  const [status, setStatus] = useState('conectando…');
  const [live, setLive] = useState(false);
  const [viewerList, setViewerList] = useState([]);
  const [game, setGame] = useState(null);
  const [overlay, setOverlay] = useState(IDLE_OVERLAY);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = `${title} — telinha`;
  }, [title]);

  useEffect(() => {
    unmountedRef.current = false;
    (async () => {
      rtcRef.current = await fetchRtcConfig();
      if (!unmountedRef.current) connect();
    })();
    return () => {
      unmountedRef.current = true;
      wsRef.current?.close();
      clearInterval(thumbTimerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      for (const pc of peersRef.current.values()) pc.close();
      peersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  function send(obj) {
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify(obj));
  }

  function connect() {
    wsRef.current = openSignaling({ room: roomId, role: 'share', key: streamKey }, handleMessage, (e) => {
      if (unmountedRef.current) return;
      if (e.code === 4003 || e.code === 4004) {
        setStatus(e.code === 4003 ? 'chave inválida' : 'sala não encontrada');
        return;
      }
      if (e.code === 4000) return; // this tab was replaced by a newer one
      setStatus('reconectando…');
      setTimeout(() => !unmountedRef.current && connect(), 2000);
    });
  }

  async function handleMessage(msg) {
    if (msg.type === 'hello') {
      if (isStale(msg)) {
        setStatus('desatualizado');
        setOverlay(STALE_PAGE_MSG);
        return;
      }
      setTitle(msg.name);
      setGame(msg.game);
      viewersRef.current.clear();
      msg.viewers.forEach((v) => viewersRef.current.add(v.id));
      setViewerList(msg.viewers);
      setStatus(streamRef.current ? 'ao vivo' : 'pronto');
      if (streamRef.current) {
        // Reconnected mid-stream: re-announce and offer to anyone not yet connected.
        send({ type: 'live' });
        for (const id of viewersRef.current) if (!peersRef.current.has(id)) await offerTo(id);
      }
    } else if (msg.type === 'viewer-joined') {
      viewersRef.current.add(msg.viewer.id);
      if (streamRef.current) await offerTo(msg.viewer.id);
    } else if (msg.type === 'viewer-left') {
      viewersRef.current.delete(msg.viewerId);
      peersRef.current.get(msg.viewerId)?.close();
      peersRef.current.delete(msg.viewerId);
    } else if (msg.type === 'room-info') {
      setGame(msg.game);
    } else if (msg.type === 'viewers') {
      setViewerList(msg.viewers);
    } else if (msg.type === 'signal') {
      const pc = peersRef.current.get(msg.from);
      if (!pc) return;
      if (msg.data.sdp) await pc.setRemoteDescription(msg.data.sdp);
      else if (msg.data.candidate) await pc.addIceCandidate(msg.data.candidate).catch(() => {});
    }
  }

  async function startSharing() {
    let media;
    try {
      media = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60 }, width: { max: 1920 }, height: { max: 1080 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      return; // user cancelled the picker
    }

    streamRef.current = media;
    const [videoTrack] = media.getVideoTracks();
    videoTrack.contentHint = 'motion'; // favor framerate over sharpness — right call for games
    videoTrack.addEventListener('ended', stopSharing); // browser's own "stop sharing" bar

    videoRef.current.srcObject = media;
    setOverlay(null);
    setLive(true);
    setStatus('ao vivo');

    send({ type: 'live' });
    for (const id of viewersRef.current) await offerTo(id);

    thumbTimerRef.current = setInterval(uploadThumbnail, 10_000);
    setTimeout(uploadThumbnail, 1500); // give the video element a moment to get frames
  }

  function stopSharing() {
    if (!streamRef.current) return;
    streamRef.current.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    for (const pc of peersRef.current.values()) pc.close();
    peersRef.current.clear();
    clearInterval(thumbTimerRef.current);
    send({ type: 'end' });
    setOverlay('Transmissão encerrada — pode começar de novo quando quiser.');
    setLive(false);
    setStatus('pronto');
  }

  async function offerTo(viewerId) {
    peersRef.current.get(viewerId)?.close();
    const pc = new RTCPeerConnection(rtcRef.current);
    peersRef.current.set(viewerId, pc);

    for (const track of streamRef.current.getTracks()) {
      if (track.kind === 'video') {
        pc.addTransceiver(track, {
          direction: 'sendonly',
          streams: [streamRef.current],
          sendEncodings: [{ maxBitrate: 8_000_000 }],
        });
      } else {
        pc.addTransceiver(track, { direction: 'sendonly', streams: [streamRef.current] });
      }
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'signal', to: viewerId, data: { candidate: e.candidate } });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'signal', to: viewerId, data: { sdp: pc.localDescription } });
  }

  const thumbCanvas = useMemo(() => document.createElement('canvas'), []);

  async function uploadThumbnail() {
    const video = videoRef.current;
    if (!streamRef.current || !video?.videoWidth) return;
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

  async function copyWatchUrl() {
    try {
      await navigator.clipboard.writeText(watchUrl);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = watchUrl;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6">
      <TopBar title={title} />

      <div className={`video-frame ${live ? 'live' : ''}`}>
        <video ref={videoRef} autoPlay playsInline muted className="w-full h-full block" />
        {overlay && <div className="overlay">{overlay}</div>}
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-3">
        {!live ? (
          <button className="btn" onClick={startSharing}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 3l14 9-14 9V3z" /></svg>
            Iniciar transmissão
          </button>
        ) : (
          <button className="btn btn-danger" onClick={stopSharing}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
            Parar
          </button>
        )}
        <span id="status" className={`pill ${live ? 'live' : ''}`}>{status}</span>
        {game && <span className="pill">🎮 {game}</span>}
        <span className="flex-1" />
        <Facepile viewers={viewerList} />
      </div>

      <div className="card p-4 mt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="tag text-green" style={{ background: 'color-mix(in srgb, #23a55a 15%, transparent)' }}>
            link dos amigos
          </span>
          <code className="flex-1 min-w-0 truncate font-mono text-[13px] text-fg2 bg-bg0 border border-line rounded-lg px-3 py-2">
            {watchUrl}
          </code>
          <button className="btn btn-secondary h-9 px-3 text-sm" onClick={copyWatchUrl}>
            {copied ? 'Copiado!' : 'Copiar'}
          </button>
        </div>
        <p className="text-fg4 text-xs mt-2 mb-0">
          Manda esse link pra quem vai assistir. O endereço desta página é o seu link de
          transmissão — esse fica só com você.
        </p>
      </div>

      <p className="text-fg4 text-[13px] mt-4">
        Dica: no seletor, escolha a <em>janela</em> do jogo (ou a tela inteira no Windows, com
        “compartilhar áudio” marcado pra mandar o som). Melhor no Chrome ou Edge.
      </p>
    </main>
  );
}
