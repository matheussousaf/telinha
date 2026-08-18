import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Room as LKRoom, RoomEvent, Track, VideoQuality } from 'livekit-client';
import { fetchRtcConfig, openSignaling, isStale, STALE_PAGE_MSG } from '../api.js';
import Logo from '../components/Logo.jsx';
import {
  IconActivity, IconCheck, IconCrown, IconEye, IconEyeOff, IconGamepad, IconLink, IconLogout,
  IconMonitor, IconPip, IconScreenShare, IconStop, IconVolume, IconVolumeOff, IconX,
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

function useElementSize(ref, rebind) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, rebind]);
  return size;
}

// Dominant-ish color from the avatar (Discord-style tile tint).
const avatarColorCache = new Map();

function useAvatarColor(url, fallback) {
  const [color, setColor] = useState(() => (url && avatarColorCache.get(url)) || fallback);
  useEffect(() => {
    if (!url) return setColor(fallback);
    if (avatarColorCache.has(url)) return setColor(avatarColorCache.get(url));
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 16;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 16, 16);
        const d = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 128) continue;
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
        if (!n) return;
        const mut = 0.72;
        const col = `rgb(${Math.round((r / n) * mut)}, ${Math.round((g / n) * mut)}, ${Math.round((b / n) * mut)})`;
        avatarColorCache.set(url, col);
        setColor(col);
      } catch {
        setColor(fallback);
      }
    };
    img.onerror = () => setColor(fallback);
    img.src = url;
  }, [url, fallback]);
  return color;
}

// Snapshot an avatar URL into a small base64 data URI (128px WebP).
async function toDataUri(url, size = 128) {
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(img, 0, 0, size, size);
    const data = c.toDataURL('image/webp', 0.85);
    return data.length <= 90_000 ? data : null;
  } catch {
    return null;
  }
}

export default function Room() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const ownerKey = query.get('key') ?? '';

  // --- refs (mutable per-connection state) ---
  const wsRef = useRef(null);
  const lkRef = useRef(null); // LiveKit Room — the entire media plane
  const lkUrlRef = useRef(null);
  const myStreamRef = useRef(null);
  const previewRef = useRef(null); // offscreen <video> for thumbnails
  const meRef = useRef(null);
  const tokenRef = useRef('');
  const hiddenRef = useRef(new Set());
  const thumbTimerRef = useRef(null);
  const unmountedRef = useRef(false);
  const gridRef = useRef(null);
  const manualUnfocusRef = useRef(false); // user chose the grid — don't yank focus back

  // --- UI state ---
  const [nameInput, setNameInput] = useState(localStorage.getItem('telinha:name') ?? '');
  const [joinToken, setJoinToken] = useState(() => query.get('j') ?? '');
  const [joined, setJoined] = useState(
    () => !!(query.get('j') ?? '') || !!(localStorage.getItem('telinha:name') ?? '').trim(),
  );
  const [voiceRoster, setVoiceRoster] = useState([]);
  const [roomName, setRoomName] = useState('…');
  const [me, setMe] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [sharingIds, setSharingIds] = useState([]);
  const [streams, setStreams] = useState({}); // participantId -> MediaStream
  const [iAmSharing, setIAmSharing] = useState(false);
  const [focusedId, setFocusedId] = useState(null);
  const [hiddenIds, setHiddenIds] = useState(() => new Set());
  const [globalMuted, setGlobalMuted] = useState(false);
  const [volumes, setVolumes] = useState({});
  const [game, setGame] = useState(null);
  const [notice, setNotice] = useState(null);
  const [copied, setCopied] = useState(false);
  const [shareWarning, setShareWarning] = useState(null);
  const [statsOn, setStatsOn] = useState(false);
  const [stats, setStats] = useState(null);

  const roomUrl = `${window.location.origin}/room/${roomId}`;
  const gridSize = useElementSize(gridRef, focusedId != null);

  useEffect(() => {
    document.title = `${roomName} — telinha`;
  }, [roomName]);

  // Join-screen roster polling (bot mirrors the voice channel).
  useEffect(() => {
    if (joined) return;
    let cancelled = false;
    const load = () =>
      fetch(`/api/rooms/${roomId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (cancelled || !data) return;
          setVoiceRoster(data.voiceRoster ?? []);
          setRoomName(data.name);
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [joined, roomId]);

  useEffect(() => {
    if (!joined) return;
    unmountedRef.current = false;
    (async () => {
      const cfg = await fetchRtcConfig();
      lkUrlRef.current = cfg.livekitUrl;
      if (!unmountedRef.current) connect();
    })();
    return () => {
      unmountedRef.current = true;
      wsRef.current?.close();
      teardownMedia();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);

  useEffect(() => {
    hiddenRef.current = hiddenIds;
    applySubscriptions();
  }, [hiddenIds]);

  function teardownMedia() {
    clearInterval(thumbTimerRef.current);
    myStreamRef.current?.getTracks().forEach((t) => t.stop());
    myStreamRef.current = null;
    lkRef.current?.disconnect();
    lkRef.current = null;
  }

  function send(obj) {
    if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify(obj));
  }

  function connect() {
    const params = { room: roomId, name: (localStorage.getItem('telinha:name') ?? nameInput).trim() };
    if (ownerKey) params.key = ownerKey;
    if (joinToken) params.j = joinToken;
    const avatar = localStorage.getItem('telinha:avatar');
    if (avatar?.startsWith('https://') && !joinToken) params.avatar = avatar;
    wsRef.current = openSignaling(params, handleMessage, (e) => {
      if (unmountedRef.current) return;
      if (e.code === 4004) return setNotice('Sala não encontrada — ou já foi encerrada.');
      if (e.code === 4003) return setNotice('Link de dono inválido.');
      if (e.code === 4001) return; // room closed — handled by the room-closed message
      setTimeout(() => !unmountedRef.current && connect(), 2000);
    });
  }

  // ---------- LiveKit media plane ----------

  function addRemoteTrack(id, track) {
    setStreams((s) => {
      const ms = new MediaStream([...(s[id]?.getTracks() ?? []), track.mediaStreamTrack]);
      return { ...s, [id]: ms };
    });
  }

  function removeRemoteTrack(id, track) {
    setStreams((s) => {
      const remaining = (s[id]?.getTracks() ?? []).filter((t) => t.id !== track.mediaStreamTrack.id);
      if (!remaining.length) {
        const { [id]: _, ...rest } = s;
        return rest;
      }
      return { ...s, [id]: new MediaStream(remaining) };
    });
  }

  function applySubscriptions() {
    const lk = lkRef.current;
    if (!lk) return;
    for (const p of lk.remoteParticipants.values()) {
      const wanted = !hiddenRef.current.has(p.identity);
      for (const pub of p.trackPublications.values()) {
        if (pub.setSubscribed) pub.setSubscribed(wanted);
      }
    }
    applyQuality();
  }

  const focusedIdRef = useRef(null);

  // Explicit simulcast layer selection: the focused stream gets the top layer
  // (1080p60), everything in tiles sips the low one.
  function applyQuality() {
    const lk = lkRef.current;
    if (!lk) return;
    for (const p of lk.remoteParticipants.values()) {
      const quality = p.identity === focusedIdRef.current ? VideoQuality.HIGH : VideoQuality.LOW;
      for (const pub of p.videoTrackPublications.values()) {
        if (pub.isSubscribed && pub.setVideoQuality) pub.setVideoQuality(quality);
      }
    }
  }

  useEffect(() => {
    focusedIdRef.current = focusedId;
    applyQuality();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedId]);

  const lkConnectSeqRef = useRef(0);

  async function connectLiveKit(room) {
    // Serialize: a newer call (e.g. WS reconnect mid-setup) supersedes this one,
    // otherwise two racing connects double-publish ("track already published").
    const seq = ++lkConnectSeqRef.current;
    lkRef.current?.disconnect();
    if (!lkUrlRef.current) {
      setNotice('Servidor de mídia não configurado (LIVEKIT_URL).');
      return;
    }
    const res = await fetch(`/api/rooms/${room}/lk-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenRef.current }),
    });
    if (seq !== lkConnectSeqRef.current) return;
    if (!res.ok) {
      setNotice('Não consegui autorizar a mídia — recarrega a página.');
      return;
    }
    const { token } = await res.json();
    if (seq !== lkConnectSeqRef.current) return;
    // adaptiveStream is off: it sizes quality by elements LiveKit attached,
    // but we drive our own <video> elements — so we pick layers explicitly
    // (focused = HIGH, tiles = LOW) in applyQuality().
    const lk = new LKRoom({ adaptiveStream: false, dynacast: true });
    lkRef.current = lk;

    lk.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      addRemoteTrack(participant.identity, track);
      applyQuality();
    });
    lk.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
      removeRemoteTrack(participant.identity, track);
    });
    lk.on(RoomEvent.TrackPublished, () => applySubscriptions());
    lk.on(RoomEvent.ParticipantConnected, () => applySubscriptions());

    await lk.connect(lkUrlRef.current, token);
    if (seq !== lkConnectSeqRef.current) {
      lk.disconnect();
      return;
    }
    applySubscriptions();

    // Sharing already (started before connect finished, or reconnecting):
    // publish only if this session hasn't yet — double-publish throws.
    if (myStreamRef.current) {
      if (lk.localParticipant.videoTrackPublications.size === 0) {
        await publishTracks(myStreamRef.current);
      }
      send({ type: 'share-start' });
    }
  }

  async function publishTracks(media) {
    const lk = lkRef.current;
    if (!lk) return;
    const [videoTrack] = media.getVideoTracks();
    const [audioTrack] = media.getAudioTracks();
    await lk.localParticipant.publishTrack(videoTrack, {
      source: Track.Source.ScreenShare,
      // No simulcast: encoding multiple layers pushes Chrome off the hardware
      // H264 path (software = ~15fps at 1080p). One stream = one guaranteed
      // hardware session at 1080p60 — Discord ships the same trade-off.
      simulcast: false,
      videoCodec: 'h264',
      videoEncoding: { maxBitrate: 8_000_000, maxFramerate: 60 },
    });
    if (audioTrack) {
      await lk.localParticipant.publishTrack(audioTrack, {
        source: Track.Source.ScreenShareAudio,
        dtx: false, // game audio has real quiet passages — don't compress them away
        audioPreset: { maxBitrate: 96_000 },
      });
    }
  }

  // ---------- our signaling (roster/identity/rooms — unchanged) ----------

  async function handleMessage(msg) {
    if (msg.type === 'welcome') {
      if (isStale(msg)) return setNotice(STALE_PAGE_MSG);
      meRef.current = msg.you;
      tokenRef.current = msg.token;
      setMe(msg.you);
      localStorage.setItem('telinha:name', msg.you.name);
      if (msg.you.avatarUrl?.startsWith('data:image/')) {
        localStorage.setItem('telinha:avatar', msg.you.avatarUrl);
      } else if (msg.you.avatarUrl) {
        toDataUri(msg.you.avatarUrl).then((data) => {
          if (data) {
            localStorage.setItem('telinha:avatar', data);
            send({ type: 'avatar', data });
          }
        });
      } else {
        const saved = localStorage.getItem('telinha:avatar');
        if (saved?.startsWith('data:image/')) send({ type: 'avatar', data: saved });
      }
      setRoomName(msg.name);
      setGame(msg.game);
      setParticipants(msg.participants);
      setSharingIds(msg.sharing);
      setFocusedId((f) => f ?? msg.sharing.find((id) => id !== msg.you.id) ?? null);
      connectLiveKit(roomId).catch((err) => {
        console.error('[livekit] connect failed:', err);
        setNotice('Falha ao conectar no servidor de mídia — recarrega a página.');
      });
    } else if (msg.type === 'participants') {
      applyRoster(msg.participants, msg.sharing);
      const mine = msg.participants.find((p) => p.id === meRef.current?.id);
      if (mine) {
        meRef.current = mine;
        setMe(mine);
      }
    } else if (msg.type === 'room-info') {
      setGame(msg.game);
      setRoomName(msg.name);
    } else if (msg.type === 'room-closed') {
      teardownMedia();
      setStreams({});
      setNotice('Sala encerrada pelo dono. Valeu!');
    }
  }

  function applyRoster(list, sharing) {
    const myId = meRef.current?.id;
    const ids = new Set(list.map((p) => p.id));
    const sharingSet = new Set(sharing);
    setHiddenIds((prev) => {
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setParticipants(list);
    setSharingIds(sharing);
    setFocusedId((f) => {
      const stillValid = f && sharingSet.has(f) && ids.has(f);
      if (stillValid) return f;
      if (manualUnfocusRef.current) return null;
      const firstOther = sharing.find((id) => id !== myId);
      return firstOther ?? (sharing.length ? sharing[0] : null);
    });
  }

  function focusOn(id) {
    manualUnfocusRef.current = false;
    setFocusedId(id);
  }

  function unfocus() {
    manualUnfocusRef.current = true;
    setFocusedId(null);
  }

  function toggleHide(id) {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setFocusedId((f) => (f === id ? null : f));
  }

  function tileClick(p, sharingSet) {
    if (!sharingSet.has(p.id)) return;
    if (hiddenIds.has(p.id)) toggleHide(p.id);
    focusOn(p.id);
  }

  // ---------- capture / share ----------

  async function captureScreen() {
    const base = {
      video: {
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 60, max: 60 },
      },
      systemAudio: 'include',
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude',
    };
    try {
      return await navigator.mediaDevices.getDisplayMedia({ ...base, audio: true });
    } catch (err) {
      if (err?.name === 'NotAllowedError') return null;
      console.warn('[share] capture with audio failed:', err?.name, err?.message);
      const why =
        err?.name === 'NotReadableError'
          ? 'o Windows bloqueou a captura do som — comum com Voicemeeter/Nahimic/driver de áudio virtual como saída padrão, ou ao compartilhar janela em vez de tela.'
          : `erro ${err?.name ?? 'desconhecido'} (${err?.message ?? ''}).`;
      setShareWarning(
        `Sem áudio do sistema: ${why} Escolhe de novo — vai sem áudio; pra ter som certo, compartilha uma aba do Chrome com “compartilhar áudio”.`,
      );
      try {
        return await navigator.mediaDevices.getDisplayMedia({ ...base, audio: false });
      } catch (err2) {
        if (err2?.name !== 'NotAllowedError') {
          setShareWarning(`Falha ao compartilhar (${err2?.name ?? 'erro desconhecido'}). Tenta de novo?`);
        }
        return null;
      }
    }
  }

  async function startShare() {
    setShareWarning(null);
    const media = await captureScreen();
    if (!media) return;
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
    try {
      // If LiveKit is still connecting, connectLiveKit's post-connect path
      // publishes for us — publishing here too would double-publish.
      if (lkRef.current?.state === 'connected') await publishTracks(media);
    } catch (err) {
      console.error('[livekit] publish failed:', err);
      setShareWarning('Falha ao publicar a transmissão — recarrega a página.');
      stopShare();
      return;
    }
    send({ type: 'share-start' });
    thumbTimerRef.current = setInterval(uploadThumbnail, 15_000);
    setTimeout(uploadThumbnail, 1500);
  }

  function stopShare() {
    if (!myStreamRef.current) return;
    const lk = lkRef.current;
    for (const track of myStreamRef.current.getTracks()) {
      try {
        lk?.localParticipant.unpublishTrack(track);
      } catch {
        /* already gone */
      }
      track.stop();
    }
    myStreamRef.current = null;
    previewRef.current = null;
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
    thumbCanvas.width = 1280;
    thumbCanvas.height = Math.round((pv.videoHeight / pv.videoWidth) * 1280);
    thumbCanvas.getContext('2d').drawImage(pv, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const blob = await new Promise((r) => thumbCanvas.toBlob(r, 'image/jpeg', 0.75));
    if (!blob) return;
    fetch(`/api/rooms/${roomId}/thumbnail?token=${encodeURIComponent(tokenRef.current)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    }).catch(() => {});
  }

  // ---------- diagnostics ----------

  useEffect(() => {
    if (!statsOn) {
      setStats(null);
      return;
    }
    let prevBytes = 0;
    let prevTime = 0;
    const timer = setInterval(async () => {
      const next = {};
      const lk = lkRef.current;
      const focusedP = focusedId && lk?.remoteParticipants
        ? [...lk.remoteParticipants.values()].find((p) => p.identity === focusedId)
        : null;
      const inTrack = focusedP
        ? [...focusedP.videoTrackPublications.values()].find((pub) => pub.track)?.track
        : null;
      if (inTrack?.receiver?.getStats) {
        const report = await inTrack.receiver.getStats();
        report.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            next.fps = s.framesPerSecond ?? 0;
            next.res = `${s.frameWidth ?? 0}×${s.frameHeight ?? 0}`;
            const codec = s.codecId && report.get(s.codecId);
            if (codec) next.codec = codec.mimeType?.replace('video/', '');
            if (prevTime) next.kbps = Math.max(0, Math.round(((s.bytesReceived - prevBytes) * 8) / (s.timestamp - prevTime)));
            prevBytes = s.bytesReceived;
            prevTime = s.timestamp;
          }
          if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded' && s.currentRoundTripTime != null) {
            next.rtt = `${Math.round(s.currentRoundTripTime * 1000)}ms`;
          }
        });
        next.route = 'SFU';
      }
      const outTrack = lk
        ? [...lk.localParticipant.videoTrackPublications.values()].find((pub) => pub.track)?.track
        : null;
      if (outTrack?.sender?.getStats) {
        const report = await outTrack.sender.getStats();
        let bestFps = 0;
        report.forEach((s) => {
          if (s.type === 'outbound-rtp' && s.kind === 'video') {
            bestFps = Math.max(bestFps, s.framesPerSecond ?? 0);
            if (s.qualityLimitationReason && s.qualityLimitationReason !== 'none') next.limit = s.qualityLimitationReason;
            const codec = s.codecId && report.get(s.codecId);
            if (codec) next.sendCodec = codec.mimeType?.replace('video/', '');
          }
        });
        next.sendFps = bestFps;
      }
      const track = myStreamRef.current?.getVideoTracks()[0];
      if (track) next.captureFps = Math.round(track.getSettings().frameRate ?? 0);
      setStats(next);
    }, 2000);
    return () => clearInterval(timer);
  }, [statsOn, focusedId]);

  // ---------- misc actions ----------

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(roomUrl);
    } catch {
      /* clipboard blocked */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function closeRoom() {
    if (window.confirm('Encerrar a sala para todo mundo?')) send({ type: 'close' });
  }

  async function pickIdentity(member) {
    localStorage.setItem('telinha:name', member.name);
    const data = await toDataUri(member.avatarUrl);
    if (data) localStorage.setItem('telinha:avatar', data);
    else localStorage.setItem('telinha:avatar', member.avatarUrl);
    setNameInput(member.name);
    setJoined(true);
  }

  function joinRoom() {
    const name = nameInput.trim();
    if (name && name !== localStorage.getItem('telinha:name')) localStorage.removeItem('telinha:avatar');
    if (name) localStorage.setItem('telinha:name', name);
    setJoined(true);
  }

  function changeIdentity() {
    if (!window.confirm('Trocar seu nome/foto? Você sai da sala e volta pela tela de entrada.')) return;
    localStorage.removeItem('telinha:name');
    localStorage.removeItem('telinha:avatar');
    if (joinToken) {
      setJoinToken('');
      window.history.replaceState(null, '', `/room/${roomId}${ownerKey ? `?key=${ownerKey}` : ''}`);
    }
    setParticipants([]);
    setSharingIds([]);
    setStreams({});
    setMe(null);
    setFocusedId(null);
    setIAmSharing(false);
    meRef.current = null;
    setNameInput('');
    setJoined(false);
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
          {voiceRoster.length > 0 && (
            <>
              <p className="label mb-3">Quem é você? <span className="normal-case font-normal text-fg4">(do canal de voz)</span></p>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {voiceRoster.map((m) => (
                  <button
                    key={m.name + m.avatarUrl}
                    className="flex flex-col items-center gap-1.5 bg-bg0 border border-line rounded-lg p-3 cursor-pointer hover:border-blurple transition-colors"
                    onClick={() => pickIdentity(m)}
                  >
                    <img src={m.avatarUrl} alt="" className="w-12 h-12 rounded-full" referrerPolicy="no-referrer" />
                    <span className="text-fg2 text-[12px] max-w-full truncate">{m.name}</span>
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3 my-4 text-fg4 text-xs">
                <span className="flex-1 h-px bg-line" /> não tô na lista <span className="flex-1 h-px bg-line" />
              </div>
            </>
          )}
          <label className="label" htmlFor="name">Como te chamam?</label>
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
        {me && (
          <button
            className="flex items-center gap-2 bg-bg1 border border-line rounded-lg h-8 px-2 cursor-pointer hover:border-blurple transition-colors"
            title="Trocar identidade"
            onClick={changeIdentity}
          >
            {me.avatarUrl ? (
              <img src={me.avatarUrl} alt="" className="w-5 h-5 rounded-full" referrerPolicy="no-referrer" />
            ) : (
              <span className="text-sm" aria-hidden="true">{me.emoji}</span>
            )}
            <span className="text-fg3 text-[12px] max-w-24 truncate hidden sm:block">{me.name}</span>
          </button>
        )}
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

      <main className="flex-1 min-h-0 px-3 pb-2">
        {focused ? (
          <div className="h-full flex flex-col sm:flex-row gap-2">
            <Tile
              p={focused}
              stream={streams[focused.id]}
              isMe={focused.id === myId}
              focused
              muted={globalMuted}
              volume={focusedVolume}
              onToggleHide={() => toggleHide(focused.id)}
              onClick={unfocus}
              className="flex-1 min-h-0 tile-focused"
            />
            {gridPeople.length > 0 && (
            <div className="flex-none flex sm:flex-col gap-2 overflow-x-auto sm:overflow-y-auto sm:w-52 h-28 sm:h-auto">
              {gridPeople.map((p) => (
                <Tile
                  key={p.id}
                  p={p}
                  stream={streams[p.id]}
                  isMe={p.id === myId}
                  sharing={sharingSet.has(p.id)}
                  muted
                  small
                  hidden={hiddenIds.has(p.id)}
                  onToggleHide={() => toggleHide(p.id)}
                  onClick={() => tileClick(p, sharingSet)}
                  className="w-44 sm:w-full"
                />
              ))}
            </div>
            )}
          </div>
        ) : (
          <div
            ref={gridRef}
            className="h-full flex flex-wrap content-center items-center justify-center gap-3"
          >
            {gridPeople.map((p) => (
              <Tile
                key={p.id}
                p={p}
                stream={streams[p.id]}
                isMe={p.id === myId}
                sharing={sharingSet.has(p.id)}
                muted
                hidden={hiddenIds.has(p.id)}
                onToggleHide={() => toggleHide(p.id)}
                onClick={() => tileClick(p, sharingSet)}
                style={{ width: `${tilePx}px` }}
              />
            ))}
          </div>
        )}
      </main>

      {statsOn && stats && (
        <div className="flex-none flex justify-center px-3 pb-1">
          <code className="bg-bg1 border border-line rounded-lg px-3 py-1.5 text-[12px] text-fg3 font-mono">
            {stats.fps != null &&
              `↓ ${stats.fps}fps ${stats.res} ${stats.codec ?? ''} ${stats.kbps ?? '…'}kbps · ${stats.route ?? '…'} ${stats.rtt ?? ''}`}
            {stats.sendFps != null &&
              `${stats.fps != null ? '  |  ' : ''}↑ ${stats.sendFps}fps ${stats.sendCodec ?? ''}${stats.captureFps ? ` (captura ${stats.captureFps}fps)` : ''}${stats.limit ? ` — limitado por ${stats.limit === 'cpu' ? 'CPU (encoder)' : stats.limit === 'bandwidth' ? 'banda' : stats.limit}` : ''}`}
            {stats.fps == null && stats.sendFps == null && 'sem streams ativos'}
          </code>
        </div>
      )}
      {shareWarning && (
        <div className="flex-none flex justify-center px-3">
          <button
            className="bg-bg1 border border-yellow/50 text-fg2 text-[13px] px-3 py-2 rounded-lg cursor-pointer"
            onClick={() => setShareWarning(null)}
            title="fechar aviso"
          >
            ⚠️ {shareWarning}
          </button>
        </div>
      )}
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
        <button
          className={`btn btn-secondary ${statsOn ? 'text-blurple' : ''}`}
          onClick={() => setStatsOn((s) => !s)}
          title="Estatísticas da transmissão"
        >
          <IconActivity size={16} />
        </button>
        <button className="btn btn-secondary" onClick={() => navigate('/')}>
          <IconLogout size={16} /> Sair
        </button>
      </footer>
    </div>
  );
}

function Tile({ p, stream, isMe, sharing = false, focused = false, small = false, muted, volume = 1, hidden = false, onToggleHide, onClick, className = '', style }) {
  const videoRef = useRef(null);
  const avatarColor = useAvatarColor(p.avatarUrl, p.color);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    v.srcObject = stream;
    v.play().catch(() => {
      if (v.muted) return;
      v.muted = true;
      setAutoplayBlocked(true);
      v.play().catch(() => {});
    });
  }, [stream]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume, stream]);

  function enableSound(e) {
    e.stopPropagation();
    const v = videoRef.current;
    if (v) {
      v.muted = false;
      v.play().catch(() => {});
    }
    setAutoplayBlocked(false);
  }

  const hasVideo = !!stream && stream.getVideoTracks().length > 0;
  const clickable = (sharing || hasVideo) && !focused;
  return (
    <div
      onClick={onClick}
      className={`relative rounded-xl overflow-hidden flex-none transition-[width] duration-200 ease-out ${clickable ? 'cursor-pointer' : ''} ${focused ? '' : 'aspect-video'} ${className}`}
      style={{ background: hasVideo ? '#000' : avatarColor, ...style }}
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
        {(sharing || hasVideo) && <IconMonitor size={12} className="flex-none" />}
        {p.owner && <IconCrown size={12} className="flex-none text-yellow" />}
        <span className="truncate">
          {p.name}
          {isMe && ' (você)'}
        </span>
      </span>
      {sharing && !hasVideo && !isMe && (
        <span className="absolute top-2 right-2 bg-red text-white text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md">
          ao vivo
        </span>
      )}
      {hidden && sharing && !small && (
        <span className="absolute top-2 left-2 bg-black/70 text-fg3 text-[11px] px-2 py-1 rounded-md flex items-center gap-1">
          <IconEye size={12} /> clique pra voltar a ver
        </span>
      )}
      {hasVideo && !isMe && !focused && (
        <button
          title="Deixar de ver esta transmissão"
          className="absolute top-2 right-2 bg-black/70 hover:bg-black/90 text-fg1 rounded-md p-1.5 flex items-center cursor-pointer border-0"
          onClick={(e) => {
            e.stopPropagation();
            onToggleHide?.();
          }}
        >
          <IconEyeOff size={13} />
        </button>
      )}
      {focused && (
        <span className="absolute top-2 right-2 flex gap-1.5">
          {!isMe && (
            <button
              title="Deixar de ver esta transmissão"
              className="bg-black/70 hover:bg-black/90 text-fg1 text-[12px] px-2.5 py-1.5 rounded-md flex items-center gap-1.5 cursor-pointer border-0"
              onClick={(e) => {
                e.stopPropagation();
                onToggleHide?.();
              }}
            >
              <IconEyeOff size={12} /> não ver
            </button>
          )}
          <button
            className="bg-black/70 hover:bg-black/90 text-fg1 text-[12px] px-2.5 py-1.5 rounded-md flex items-center gap-1.5 cursor-pointer border-0"
            onClick={(e) => {
              e.stopPropagation();
              onClick?.();
            }}
          >
            <IconX size={12} /> voltar
          </button>
        </span>
      )}
      {focused && autoplayBlocked && !isMe && (
        <button
          className="absolute inset-0 m-auto w-fit h-fit bg-black/80 hover:bg-black text-fg1 text-[14px] font-medium px-4 py-2.5 rounded-lg flex items-center gap-2 cursor-pointer border border-line"
          onClick={enableSound}
        >
          <IconVolume size={16} /> ativar som
        </button>
      )}
    </div>
  );
}
