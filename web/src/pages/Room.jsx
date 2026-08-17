import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchRtcConfig, openSignaling, isStale, STALE_PAGE_MSG } from '../api.js';
import Logo from '../components/Logo.jsx';
import {
  IconCheck, IconCrown, IconDiscord, IconGamepad, IconLink, IconLogout, IconMonitor,
  IconPip, IconScreenShare, IconStop, IconVolume, IconVolumeOff, IconX,
} from '../components/icons.jsx';

// Best-fit tile width (Discord-style): try every column count, keep the
// largest tile that still fits everyone in the container at 16:9.
function bestTileWidth(w, h, n, gap = 12, maxW = 1000) {
  if (!w || !h || !n) return 320;
  let best = 160;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const byWidth = (w - gap * (cols - 1)) / cols;
    const byHeight = ((h - gap * (rows - 1)) / rows) * (16 / 9);
    best = Math.max(best, Math.min(byWidth, byHeight, maxW));
  }
  return Math.floor(best);
}

function useElementSize(ref) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export default function Room() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const ownerKey = useMemo(() => new URLSearchParams(window.location.search).get('key') ?? '', []);

  // --- refs (mutable per-connection state) ---
  const wsRef = useRef(null);
  const rtcRef = useRef({ iceServers: [] });
  const myStreamRef = useRef(null);
  const previewRef = useRef(null); // offscreen <video> for thumbnails
  const pcsOutRef = useRef(new Map()); // peerId -> pc carrying MY stream to them
  const pcsInRef = useRef(new Map()); // sharerId -> pc carrying THEIR stream to me
  const meRef = useRef(null);
  const tokenRef = useRef('');
  const knownIdsRef = useRef(new Set());
  const thumbTimerRef = useRef(null);
  const unmountedRef = useRef(false);
  const gridRef = useRef(null);

  // --- UI state ---
  const [nameInput, setNameInput] = useState(localStorage.getItem('telinha:name') ?? '');
  const [joined, setJoined] = useState(false);
  const [discordClientId, setDiscordClientId] = useState(null);
  const myAvatar = useMemo(() => localStorage.getItem('telinha:avatar'), [joined]);
  const [roomName, setRoomName] = useState('…');
  const [me, setMe] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [sharingIds, setSharingIds] = useState([]);
  const [streams, setStreams] = useState({}); // sharerId -> MediaStream
  const [iAmSharing, setIAmSharing] = useState(false);
  const [focusedId, setFocusedId] = useState(null);
  const [globalMuted, setGlobalMuted] = useState(false);
  const [volumes, setVolumes] = useState({}); // sharerId -> 0..1, remembered per person
  const [game, setGame] = useState(null);
  const [notice, setNotice] = useState(null); // terminal overlays: closed/not found/stale
  const [copied, setCopied] = useState(false);

  const roomUrl = `${window.location.origin}/room/${roomId}`;
  const gridSize = useElementSize(gridRef);

  useEffect(() => {
    document.title = `${roomName} — telinha`;
  }, [roomName]);

  // Config early: the modal needs the Discord client id; the rtc config is
  // reused when we actually join. Coming back from the Discord login, join
  // straight away with the fetched profile.
  useEffect(() => {
    fetchRtcConfig().then((c) => {
      rtcRef.current = c;
      setDiscordClientId(c.discordClientId ?? null);
    });
    if (localStorage.getItem('telinha:autojoin') === '1') {
      localStorage.removeItem('telinha:autojoin');
      if ((localStorage.getItem('telinha:name') ?? '').trim()) setJoined(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function discordLogin() {
    const redirect = encodeURIComponent(`${window.location.origin}/discord-callback`);
    const state = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `https://discord.com/oauth2/authorize?client_id=${discordClientId}&response_type=token&scope=identify&redirect_uri=${redirect}&state=${state}`;
  }

  useEffect(() => {
    if (!joined) return;
    unmountedRef.current = false;
    (async () => {
      rtcRef.current = await fetchRtcConfig();
      if (!unmountedRef.current) connect();
    })();
    return () => {
      unmountedRef.current = true;
      wsRef.current?.close();
      teardownMedia();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);

  function teardownMedia() {
    clearInterval(thumbTimerRef.current);
    myStreamRef.current?.getTracks().forEach((t) => t.stop());
    myStreamRef.current = null;
    for (const pc of pcsOutRef.current.values()) pc.close();
    for (const pc of pcsInRef.current.values()) pc.close();
    pcsOutRef.current.clear();
    pcsInRef.current.clear();
  }

  function send(obj) {
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify(obj));
  }

  function connect() {
    const params = { room: roomId, name: (localStorage.getItem('telinha:name') ?? nameInput).trim() };
    if (ownerKey) params.key = ownerKey;
    const avatar = localStorage.getItem('telinha:avatar');
    if (avatar) params.avatar = avatar;
    wsRef.current = openSignaling(params, handleMessage, (e) => {
      if (unmountedRef.current) return;
      if (e.code === 4004) return setNotice('Sala não encontrada — ou já foi encerrada.');
      if (e.code === 4003) return setNotice('Link de dono inválido.');
      if (e.code === 4001) return; // room closed — handled by the room-closed message
      // Reconnect: our old participant id is gone, so all pcs are dead.
      for (const pc of pcsInRef.current.values()) pc.close();
      pcsInRef.current.clear();
      for (const pc of pcsOutRef.current.values()) pc.close();
      pcsOutRef.current.clear();
      setStreams(() => {
        const mine = myStreamRef.current;
        return mine && meRef.current ? { [meRef.current.id]: mine } : {};
      });
      setTimeout(() => !unmountedRef.current && connect(), 2000);
    });
  }

  async function handleMessage(msg) {
    if (msg.type === 'welcome') {
      if (isStale(msg)) return setNotice(STALE_PAGE_MSG);
      meRef.current = msg.you;
      tokenRef.current = msg.token;
      setMe(msg.you);
      setRoomName(msg.name);
      setGame(msg.game);
      knownIdsRef.current = new Set(msg.participants.map((p) => p.id));
      setParticipants(msg.participants);
      setSharingIds(msg.sharing);
      if (myStreamRef.current) {
        // Reconnected mid-share: re-announce under our new id and re-offer.
        setStreams({ [msg.you.id]: myStreamRef.current });
        send({ type: 'share-start' });
        for (const p of msg.participants) if (p.id !== msg.you.id) await offerTo(p.id);
      }
    } else if (msg.type === 'participants') {
      await applyRoster(msg.participants, msg.sharing);
    } else if (msg.type === 'room-info') {
      setGame(msg.game);
      setRoomName(msg.name);
    } else if (msg.type === 'room-closed') {
      teardownMedia();
      setStreams({});
      setNotice('Sala encerrada pelo dono. Valeu!');
    } else if (msg.type === 'signal') {
      await handleSignal(msg);
    }
  }

  async function applyRoster(list, sharing) {
    const myId = meRef.current?.id;
    const ids = new Set(list.map((p) => p.id));
    const sharingSet = new Set(sharing);

    // People who left: drop their media both ways.
    for (const gone of knownIdsRef.current) {
      if (!ids.has(gone)) {
        pcsOutRef.current.get(gone)?.close();
        pcsOutRef.current.delete(gone);
        pcsInRef.current.get(gone)?.close();
        pcsInRef.current.delete(gone);
        setStreams((s) => {
          const { [gone]: _, ...rest } = s;
          return rest;
        });
      }
    }
    // Sharers who stopped: drop their inbound stream.
    for (const [sharerId, pc] of pcsInRef.current) {
      if (!sharingSet.has(sharerId)) {
        pc.close();
        pcsInRef.current.delete(sharerId);
        setStreams((s) => {
          const { [sharerId]: _, ...rest } = s;
          return rest;
        });
      }
    }
    // If I'm sharing, offer to newcomers.
    if (myStreamRef.current && myId) {
      for (const p of list) {
        if (p.id !== myId && !knownIdsRef.current.has(p.id)) await offerTo(p.id);
      }
    }

    knownIdsRef.current = ids;
    setParticipants(list);
    setSharingIds(sharing);
    setFocusedId((f) => {
      const stillValid = f && sharingSet.has(f) && ids.has(f);
      if (stillValid) return f;
      const firstOther = sharing.find((id) => id !== myId);
      return firstOther ?? (sharing.length ? sharing[0] : null);
    });
  }

  async function handleSignal(msg) {
    const myId = meRef.current?.id;
    if (msg.sharer === myId) {
      // Answer/candidate for one of my outbound connections.
      const pc = pcsOutRef.current.get(msg.from);
      if (!pc) return;
      if (msg.data.sdp) await pc.setRemoteDescription(msg.data.sdp);
      else if (msg.data.candidate) await pc.addIceCandidate(msg.data.candidate).catch(() => {});
      return;
    }
    // Inbound: msg.from is the sharer sending me their screen.
    if (msg.data.sdp) {
      pcsInRef.current.get(msg.sharer)?.close();
      const pc = new RTCPeerConnection(rtcRef.current);
      pcsInRef.current.set(msg.sharer, pc);
      pc.ontrack = (e) => {
        setStreams((s) => ({ ...s, [msg.sharer]: e.streams[0] }));
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) send({ type: 'signal', to: msg.sharer, sharer: msg.sharer, data: { candidate: e.candidate } });
      };
      await pc.setRemoteDescription(msg.data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'signal', to: msg.sharer, sharer: msg.sharer, data: { sdp: pc.localDescription } });
    } else if (msg.data.candidate) {
      await pcsInRef.current.get(msg.sharer)?.addIceCandidate(msg.data.candidate).catch(() => {});
    }
  }

  async function offerTo(peerId) {
    pcsOutRef.current.get(peerId)?.close();
    const pc = new RTCPeerConnection(rtcRef.current);
    pcsOutRef.current.set(peerId, pc);
    for (const track of myStreamRef.current.getTracks()) {
      if (track.kind === 'video') {
        pc.addTransceiver(track, {
          direction: 'sendonly',
          streams: [myStreamRef.current],
          sendEncodings: [{ maxBitrate: 6_000_000 }],
        });
      } else {
        pc.addTransceiver(track, { direction: 'sendonly', streams: [myStreamRef.current] });
      }
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'signal', to: peerId, sharer: meRef.current.id, data: { candidate: e.candidate } });
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'signal', to: peerId, sharer: meRef.current.id, data: { sdp: pc.localDescription } });
  }

  async function startShare() {
    let media;
    try {
      media = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60 }, width: { max: 1920 }, height: { max: 1080 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      return; // picker cancelled
    }
    myStreamRef.current = media;
    const [videoTrack] = media.getVideoTracks();
    videoTrack.contentHint = 'motion';
    videoTrack.addEventListener('ended', stopShare);

    const pv = document.createElement('video');
    pv.muted = true;
    pv.srcObject = media;
    pv.play().catch(() => {});
    previewRef.current = pv;

    setIAmSharing(true);
    setStreams((s) => ({ ...s, [meRef.current.id]: media }));
    send({ type: 'share-start' });
    for (const p of knownIdsRef.current) if (p !== meRef.current.id) await offerTo(p);
    thumbTimerRef.current = setInterval(uploadThumbnail, 10_000);
    setTimeout(uploadThumbnail, 1500);
  }

  function stopShare() {
    if (!myStreamRef.current) return;
    myStreamRef.current.getTracks().forEach((t) => t.stop());
    myStreamRef.current = null;
    previewRef.current = null;
    for (const pc of pcsOutRef.current.values()) pc.close();
    pcsOutRef.current.clear();
    clearInterval(thumbTimerRef.current);
    send({ type: 'share-stop' });
    setIAmSharing(false);
    setStreams((s) => {
      const { [meRef.current?.id]: _, ...rest } = s;
      return rest;
    });
  }

  const thumbCanvas = useMemo(() => document.createElement('canvas'), []);

  async function uploadThumbnail() {
    const pv = previewRef.current;
    if (!myStreamRef.current || !pv?.videoWidth) return;
    thumbCanvas.width = 640;
    thumbCanvas.height = Math.round((pv.videoHeight / pv.videoWidth) * 640);
    thumbCanvas.getContext('2d').drawImage(pv, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const blob = await new Promise((r) => thumbCanvas.toBlob(r, 'image/jpeg', 0.7));
    if (!blob) return;
    fetch(`/api/rooms/${roomId}/thumbnail?token=${encodeURIComponent(tokenRef.current)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    }).catch(() => {});
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(roomUrl);
    } catch {
      /* clipboard blocked — nothing sane to do */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function closeRoom() {
    if (window.confirm('Encerrar a sala para todo mundo?')) send({ type: 'close' });
  }

  function joinRoom() {
    const name = nameInput.trim();
    if (name) localStorage.setItem('telinha:name', name);
    setJoined(true);
  }

  // ---------- render ----------

  if (notice) {
    return (
      <div className="h-screen bg-black flex flex-col items-center justify-center gap-4 px-6 text-center">
        <Logo size={40} />
        <p className="text-fg2 text-lg m-0">{notice}</p>
        <button className="btn" onClick={() => navigate('/')}>Voltar pro início</button>
      </div>
    );
  }

  if (!joined) {
    return (
      <div className="h-screen bg-black flex items-center justify-center px-4">
        <div className="card p-6 w-full max-w-sm">
          <div className="flex items-center gap-2 text-fg1 font-bold mb-4">
            <Logo /> telinha
          </div>
          {discordClientId && (
            <>
              <button className="btn w-full" onClick={discordLogin}>
                <IconDiscord size={16} /> Entrar com Discord
              </button>
              <div className="flex items-center gap-3 my-4 text-fg4 text-xs">
                <span className="flex-1 h-px bg-line" /> ou <span className="flex-1 h-px bg-line" />
              </div>
            </>
          )}
          <label className="label" htmlFor="name">Como te chamam?</label>
          <div className="flex items-center gap-2">
            {myAvatar && <img src={myAvatar} alt="" className="w-10 h-10 rounded-full flex-none" referrerPolicy="no-referrer" />}
            <input
              id="name"
              className="input"
              type="text"
              placeholder="seu nome ou apelido"
              maxLength={32}
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && joinRoom()}
            />
          </div>
          <button className="btn btn-secondary w-full mt-4" onClick={joinRoom}>Entrar na sala</button>
          <p className="text-fg4 text-xs mt-3 mb-0">
            Sem cadastro — nome e foto aparecem só pra quem tá na sala, e nada fica salvo no servidor.
          </p>
        </div>
      </div>
    );
  }

  const myId = me?.id;
  const sharingSet = new Set(sharingIds);
  const focused = focusedId && sharingSet.has(focusedId) ? participants.find((p) => p.id === focusedId) : null;
  const gridPeople = focused ? participants.filter((p) => p.id !== focused.id) : participants;
  const tilePx = bestTileWidth(gridSize.w, gridSize.h, Math.max(gridPeople.length, 1));
  const focusedVolume = focusedId != null ? (volumes[focusedId] ?? 1) : 1;

  return (
    <div className="h-screen bg-black flex flex-col overflow-hidden">
      <header className="flex items-center gap-3 px-4 py-3 flex-none min-w-0">
        <IconVolume size={18} className="text-fg4 flex-none" />
        <span className="text-fg1 font-bold truncate">{roomName}</span>
        {game && (
          <span className="pill hidden sm:inline-flex">
            <IconGamepad size={13} /> {game}
          </span>
        )}
        <span className="flex-1" />
        <button className="btn btn-secondary h-8 px-3 text-[13px]" onClick={copyInvite}>
          {copied ? <IconCheck size={14} /> : <IconLink size={14} />}
          {copied ? 'copiado!' : 'copiar convite'}
        </button>
        {me?.owner && (
          <button className="btn btn-danger h-8 px-3 text-[13px]" onClick={closeRoom}>
            <IconX size={14} /> Encerrar sala
          </button>
        )}
      </header>

      <main className="flex-1 min-h-0 px-3 pb-2 flex flex-col gap-2">
        {focused && (
          <Tile
            p={focused}
            stream={streams[focused.id]}
            isMe={focused.id === myId}
            focused
            muted={globalMuted}
            volume={focusedVolume}
            onClick={() => setFocusedId(null)}
            className="flex-1 min-h-0 tile-focused"
          />
        )}
        <div
          ref={gridRef}
          className={
            focused
              ? 'flex-none h-24 flex gap-2 justify-center overflow-x-auto'
              : 'flex-1 min-h-0 flex flex-wrap content-center items-center justify-center gap-3'
          }
        >
          {gridPeople.map((p) => (
            <Tile
              key={p.id}
              p={p}
              stream={streams[p.id]}
              isMe={p.id === myId}
              muted
              small={!!focused}
              onClick={() => sharingSet.has(p.id) && setFocusedId(p.id)}
              style={focused ? { width: '9.5rem' } : { width: `${tilePx}px` }}
            />
          ))}
        </div>
      </main>

      <footer className="flex-none flex flex-wrap items-center justify-center gap-2 py-3 px-3">
        {!iAmSharing ? (
          <button className="btn" onClick={startShare}>
            <IconScreenShare size={16} /> Compartilhar tela
          </button>
        ) : (
          <button className="btn btn-danger" onClick={stopShare}>
            <IconStop size={16} /> Parar
          </button>
        )}
        <button className="btn btn-secondary" onClick={() => setGlobalMuted((m) => !m)} title={globalMuted ? 'Ativar som' : 'Silenciar'}>
          {globalMuted ? <IconVolumeOff size={16} /> : <IconVolume size={16} />}
        </button>
        {focused && focused.id !== myId && (
          <label className="flex items-center gap-2 bg-bg1 border border-line rounded-lg h-[38px] px-3" title={`Volume de ${focused.name}`}>
            <span className="text-fg4 text-[12px] max-w-24 truncate">{focused.name}</span>
            <input
              type="range"
              className="vol"
              min="0"
              max="100"
              value={Math.round((globalMuted ? 0 : focusedVolume) * 100)}
              disabled={globalMuted}
              onChange={(e) => setVolumes((v) => ({ ...v, [focused.id]: Number(e.target.value) / 100 }))}
            />
          </label>
        )}
        <button
          className="btn btn-secondary"
          onClick={() => document.querySelector('.tile-focused video')?.requestPictureInPicture?.().catch(() => {})}
          title="Pop-out"
        >
          <IconPip size={16} />
        </button>
        <button className="btn btn-secondary" onClick={() => navigate('/')}>
          <IconLogout size={16} /> Sair
        </button>
      </footer>
    </div>
  );
}

function Tile({ p, stream, isMe, focused = false, small = false, muted, volume = 1, onClick, className = '', style }) {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);

  // Audio policy: only the focused stream is audible, at its remembered volume.
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume, stream]);

  const hasVideo = !!stream;
  return (
    <div
      onClick={onClick}
      className={`relative rounded-xl overflow-hidden flex-none transition-[width] duration-200 ease-out ${hasVideo && !focused ? 'cursor-pointer' : ''} ${focused ? '' : 'aspect-video'} ${className}`}
      style={{ background: hasVideo ? '#000' : p.color, ...style }}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isMe || muted || !focused}
          className="w-full h-full object-contain"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          {p.avatarUrl ? (
            <img
              src={p.avatarUrl}
              alt=""
              referrerPolicy="no-referrer"
              className={`rounded-full object-cover ${small ? 'w-10 h-10' : 'w-20 h-20'}`}
            />
          ) : (
            <span
              className={`rounded-full bg-black/30 flex items-center justify-center ${small ? 'w-10 h-10 text-xl' : 'w-20 h-20 text-4xl'}`}
              aria-hidden="true"
            >
              {p.emoji}
            </span>
          )}
        </div>
      )}
      <span className="absolute bottom-2 left-2 max-w-[85%] bg-black/70 text-fg1 text-[12px] font-medium px-2 py-1 rounded-md flex items-center gap-1.5">
        {hasVideo && <IconMonitor size={12} className="flex-none" />}
        {p.owner && <IconCrown size={12} className="flex-none text-yellow" />}
        <span className="truncate">
          {p.name}
          {isMe && ' (você)'}
        </span>
      </span>
      {hasVideo && !focused && !small && (
        <span className="absolute top-2 right-2 bg-black/70 text-fg3 text-[11px] px-2 py-1 rounded-md">clique pra focar</span>
      )}
    </div>
  );
}
