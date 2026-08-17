import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchRtcConfig, openSignaling } from '../api.js';
import TopBar from '../components/TopBar.jsx';
import Facepile from '../components/Facepile.jsx';

export default function Watch() {
  const { roomId } = useParams();

  const videoRef = useRef(null);
  const wsRef = useRef(null);
  const pcRef = useRef(null);
  const rtcRef = useRef({ iceServers: [] });
  const unmountedRef = useRef(false);

  const [title, setTitle] = useState('…');
  const [viewerList, setViewerList] = useState([]);
  const [game, setGame] = useState(null);
  const [overlay, setOverlay] = useState('Conectando…');
  const [muted, setMuted] = useState(true);

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
      pcRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  function send(obj) {
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify(obj));
  }

  function connect() {
    wsRef.current = openSignaling({ room: roomId, role: 'watch' }, handleMessage, (e) => {
      if (unmountedRef.current) return;
      if (e.code === 4004) {
        setOverlay('Sala não encontrada — peça um link novo.');
        return;
      }
      setOverlay('Desconectado — reconectando…');
      setTimeout(() => !unmountedRef.current && connect(), 2000);
    });
  }

  async function handleMessage(msg) {
    if (msg.type === 'welcome') {
      setTitle(msg.name);
      setGame(msg.game);
      setOverlay(msg.live ? 'Conectando à transmissão…' : 'Esperando a transmissão começar…');
    } else if (msg.type === 'room-info') {
      setGame(msg.game);
    } else if (msg.type === 'stream-live') {
      setOverlay('Conectando à transmissão…');
    } else if (msg.type === 'stream-ended') {
      pcRef.current?.close();
      pcRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setOverlay('Transmissão encerrada.');
    } else if (msg.type === 'viewers') {
      setViewerList(msg.viewers);
    } else if (msg.type === 'signal') {
      await handleSignal(msg.data);
    }
  }

  async function handleSignal(data) {
    if (data.sdp) {
      // A fresh offer means a (re)started stream — replace any old connection.
      pcRef.current?.close();
      const pc = new RTCPeerConnection(rtcRef.current);
      pcRef.current = pc;
      pc.ontrack = (e) => {
        if (videoRef.current) videoRef.current.srcObject = e.streams[0];
        setOverlay(null);
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) send({ type: 'signal', data: { candidate: e.candidate } });
      };
      pc.onconnectionstatechange = () => {
        if (pcRef.current?.connectionState === 'failed') setOverlay('Conexão perdida.');
      };
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'signal', data: { sdp: pc.localDescription } });
    } else if (data.candidate) {
      await pcRef.current?.addIceCandidate(data.candidate).catch(() => {});
    }
  }

  async function togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await videoRef.current.requestPictureInPicture();
    } catch {
      // no video yet, or the browser doesn't support PiP
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6">
      <TopBar title={title} />

      <div className="video-frame">
        <video ref={videoRef} autoPlay playsInline muted={muted} className="w-full h-full block" />
        {overlay && <div className="overlay">{overlay}</div>}
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button className="btn" onClick={() => setMuted((m) => !m)}>
          {muted ? '🔊 Ativar som' : '🔇 Silenciar'}
        </button>
        <button className="btn btn-secondary" onClick={togglePip}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="14" rx="2" /><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none" /></svg>
          Pop-out
        </button>
        <button className="btn btn-secondary" onClick={() => videoRef.current?.requestFullscreen?.().catch(() => {})}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M16 21h3a2 2 0 0 0 2-2v-3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" /></svg>
          Tela cheia
        </button>
        {game && <span className="pill">🎮 {game}</span>}
        <span className="flex-1" />
        <Facepile viewers={viewerList} />
      </div>

      <p className="text-fg4 text-[13px] mt-4">
        Dica: o “Pop-out” solta a stream numa janelinha sempre-no-topo — deixa num canto por cima
        do Discord e segue o papo.
      </p>
    </main>
  );
}
