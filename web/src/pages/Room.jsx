import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchRtcConfig, openSignaling, isStale, STALE_PAGE_MSG } from '../api.js';
import Logo from '../components/Logo.jsx';
import {
  IconCheck, IconCrown, IconGamepad, IconLink, IconLogout, IconMonitor,
  IconPip, IconScreenShare, IconStop, IconVolume, IconVolumeOff, IconX,
} from '../components/icons.jsx'; // (Tile also uses IconX/IconVolume for voltar + ativar som)

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

// Dominant-ish color from the avatar (Discord-style tile tint): average the
// pixels of a tiny downscale, slightly darkened. Discord's CDN sends CORS
// headers, so canvas readback works.
const avatarColorCache = new Map();

// Snapshot an avatar URL into a small base64 data URI (128px WebP, ~10-20KB)
// so the pfp lives in the client's localStorage, independent of any CDN.
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
        const mut = 0.72; // muted tone, like Discord's tiles
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

export default function Room() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const ownerKey = query.get('key') ?? '';

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
  const prevFocusRef = useRef(null);
  const manualUnfocusRef = useRef(false); // user chose the grid — don't yank focus back

  // --- UI state ---
  const [nameInput, setNameInput] = useState(localStorage.getItem('telinha:name') ?? '');
  const [joinToken, setJoinToken] = useState(() => query.get('j') ?? '');
  // Personalized links and remembered identities (localStorage only — the
  // server never stores anyone) skip the join screen entirely.
  const [joined, setJoined] = useState(
    () => !!(query.get('j') ?? '') || !!(localStorage.getItem('telinha:name') ?? '').trim(),
  );
  const [voiceRoster, setVoiceRoster] = useState([]);
  const [roomName, setRoomName] = useState('…');
  const [me, setMe] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [sharingIds, setSharingIds] = useState([]);
  const [streams, setStreams] = useState({}); // sharerId -> MediaStream (only who we watch + own preview)
  const [iAmSharing, setIAmSharing] = useState(false);
  const [focusedId, setFocusedId] = useState(null);
  const [globalMuted, setGlobalMuted] = useState(false);
  const [volumes, setVolumes] = useState({}); // sharerId -> 0..1, remembered per person
  const [game, setGame] = useState(null);
  const [notice, setNotice] = useState(null); // terminal overlays: closed/not found/stale
  const [copied, setCopied] = useState(false);
  const [shareWarning, setShareWarning] = useState(null); // transient capture problems

  const roomUrl = `${window.location.origin}/room/${roomId}`;
  const gridSize = useElementSize(gridRef, focusedId != null);

  // Refresh cadence for "shared but not focused" tile previews (the
  // screenshots sharers upload for the Discord embed).
  const [thumbTick, setThumbTick] = useState(0);
  useEffect(() => {
    if (!joined) return;
    const t = setInterval(() => setThumbTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [joined]);

  useEffect(() => {
    document.title = `${roomName} — telinha`;
  }, [roomName]);

  // While the join screen is up, poll the room for the voice-channel roster
  // (the bot mirrors who's in the voice call) so people can click their own
  // face instead of typing anything.
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

  // Subscription model: we download at most ONE remote stream — the focused
  // one. Changing focus unsubscribes from the old sharer and asks the new one
  // to start sending.
  useEffect(() => {
    const myId = meRef.current?.id;
    const prev = prevFocusRef.current;
    if (prev === focusedId) return;
    if (prev && prev !== myId) {
      send({ type: 'unwatch', to: prev });
      pcsInRef.current.get(prev)?.close();
      pcsInRef.current.delete(prev);
      setStreams((s) => {
        const { [prev]: _, ...rest } = s;
        return rest;
      });
    }
    if (focusedId && focusedId !== myId) send({ type: 'watch', to: focusedId });
    prevFocusRef.current = focusedId;
  }, [focusedId]);

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
    if (joinToken) params.j = joinToken;
    // Legacy CDN URLs still travel as a query param; base64 avatars are sent
    // as a message after welcome (too big for a URL).
    const avatar = localStorage.getItem('telinha:avatar');
    if (avatar?.startsWith('https://') && !joinToken) params.avatar = avatar;
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
      prevFocusRef.current = null;
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
      // Remember the confirmed identity so a reload rejoins seamlessly —
      // avatars are kept as client-held base64, never as a CDN dependency.
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
      knownIdsRef.current = new Set(msg.participants.map((p) => p.id));
      setParticipants(msg.participants);
      setSharingIds(msg.sharing);
      // Joining mid-show: focus (and thereby subscribe to) the first sharer.
      setFocusedId((f) => f ?? msg.sharing.find((id) => id !== msg.you.id) ?? null);
      if (myStreamRef.current) {
        // Reconnected mid-share: re-announce; watchers will re-request.
        setStreams((s) => ({ ...s, [msg.you.id]: myStreamRef.current }));
        send({ type: 'share-start' });
      }
    } else if (msg.type === 'participants') {
      applyRoster(msg.participants, msg.sharing);
      // Our own identity may have been enriched (e.g. avatar handover).
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
    } else if (msg.type === 'watch') {
      if (myStreamRef.current) await offerTo(msg.from);
    } else if (msg.type === 'unwatch') {
      pcsOutRef.current.get(msg.from)?.close();
      pcsOutRef.current.delete(msg.from);
    } else if (msg.type === 'signal') {
      await handleSignal(msg);
    }
  }

  function applyRoster(list, sharing) {
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

    knownIdsRef.current = ids;
    setParticipants(list);
    setSharingIds(sharing);
    setFocusedId((f) => {
      const stillValid = f && sharingSet.has(f) && ids.has(f);
      if (stillValid) return f;
      if (manualUnfocusRef.current) return null; // respect a deliberate unfocus
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
        const tr = pc.addTransceiver(track, {
          direction: 'sendonly',
          streams: [myStreamRef.current],
          sendEncodings: [{ maxBitrate: 10_000_000 }],
        });
        // Prefer VP9 — noticeably better quality-per-bit than the VP8 default.
        try {
          const codecs = [...RTCRtpSender.getCapabilities('video').codecs];
          codecs.sort((a, b) => (b.mimeType === 'video/VP9' ? 1 : 0) - (a.mimeType === 'video/VP9' ? 1 : 0));
          tr.setCodecPreferences(codecs);
        } catch {
          // codec preferences are best-effort
        }
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

  async function captureScreen() {
    const base = {
      video: { frameRate: { ideal: 60 }, width: { max: 1920 }, height: { max: 1080 } },
      systemAudio: 'include', // surface the audio checkbox whenever the OS allows it
      surfaceSwitching: 'include', // lets the sharer swap tabs mid-stream via the capture bar
      selfBrowserSurface: 'exclude', // don't offer the room's own tab (mirror hall)
    };
    try {
      // audio: true (no processing constraints) — mic-style constraints are a
      // known failure source for system-audio loopback capture.
      return await navigator.mediaDevices.getDisplayMedia({ ...base, audio: true });
    } catch (err) {
      if (err?.name === 'NotAllowedError') return null; // user cancelled the picker
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
    send({ type: 'share-start' }); // watchers subscribe on demand
    thumbTimerRef.current = setInterval(uploadThumbnail, 15_000);
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
    // 1280px wide so previews stay crisp even on big tiles.
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

  async function pickIdentity(member) {
    localStorage.setItem('telinha:name', member.name);
    const data = await toDataUri(member.avatarUrl);
    if (data) localStorage.setItem('telinha:avatar', data);
    else localStorage.setItem('telinha:avatar', member.avatarUrl); // conversion failed — keep the URL
    setNameInput(member.name);
    setJoined(true);
  }

  function joinRoom() {
    const name = nameInput.trim();
    // Typing a DIFFERENT name is choosing a new identity — drop the old pfp.
    if (name && name !== localStorage.getItem('telinha:name')) localStorage.removeItem('telinha:avatar');
    if (name) localStorage.setItem('telinha:name', name);
    setJoined(true);
  }

  function changeIdentity() {
    if (!window.confirm('Trocar seu nome/foto? Você sai da sala e volta pela tela de entrada.')) return;
    localStorage.removeItem('telinha:name');
    localStorage.removeItem('telinha:avatar');
    // Drop the personalized token from the URL so it can't override the new identity.
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
    prevFocusRef.current = null;
    meRef.current = null;
    knownIdsRef.current = new Set();
    setNameInput('');
    setJoined(false); // the join effect's cleanup closes ws + media
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
          // Discord-style focus: big stream + participants in a real side
          // column (bottom row on narrow screens) — nobody gets hidden.
          <div className="h-full flex flex-col sm:flex-row gap-2">
            <Tile
              p={focused}
              stream={streams[focused.id]}
              isMe={focused.id === myId}
              focused
              muted={globalMuted}
              volume={focusedVolume}
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
                  previewUrl={sharingSet.has(p.id) && !streams[p.id] && p.id !== myId ? `/thumbs/${roomId}/${p.id}.jpg?t=${thumbTick}` : null}
                  onClick={() => sharingSet.has(p.id) && focusOn(p.id)}
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
                previewUrl={sharingSet.has(p.id) && !streams[p.id] && p.id !== myId ? `/thumbs/${roomId}/${p.id}.jpg?t=${thumbTick}` : null}
                onClick={() => sharingSet.has(p.id) && focusOn(p.id)}
                style={{ width: `${tilePx}px` }}
              />
            ))}
          </div>
        )}
      </main>

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
        <button className="btn btn-secondary" onClick={() => navigate('/')}>
          <IconLogout size={16} /> Sair
        </button>
      </footer>
    </div>
  );
}

function Tile({ p, stream, isMe, sharing = false, focused = false, small = false, muted, volume = 1, previewUrl = null, onClick, className = '', style }) {
  const videoRef = useRef(null);
  const avatarColor = useAvatarColor(p.avatarUrl, p.color);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  // Attach and actively play. If the browser blocks unmuted autoplay (e.g.
  // auto-rejoin means zero interaction yet), fall back to muted playback and
  // surface a click-to-unmute prompt instead of silent black.
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

  // Audio policy: only the focused stream is audible, at its remembered volume.
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

  const hasVideo = !!stream;
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
      {previewUrl && (
        // "Shared but not focused": ~10s-fresh screenshot preview over the
        // avatar — looks live without downloading the stream.
        <img
          src={previewUrl}
          alt=""
          className="absolute inset-0 w-full h-full object-cover"
          onError={(e) => (e.currentTarget.style.display = 'none')}
          onLoad={(e) => (e.currentTarget.style.display = '')}
        />
      )}
      {sharing && !hasVideo && !isMe && (
        <span className="absolute top-2 right-2 bg-red text-white text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded-md">
          ao vivo
        </span>
      )}
      {clickable && !small && (
        <span className="absolute top-2 left-2 bg-black/70 text-fg3 text-[11px] px-2 py-1 rounded-md">clique pra assistir</span>
      )}
      {focused && (
        <button
          className="absolute top-2 right-2 bg-black/70 hover:bg-black/90 text-fg1 text-[12px] px-2.5 py-1.5 rounded-md flex items-center gap-1.5 cursor-pointer border-0"
          onClick={(e) => {
            e.stopPropagation();
            onClick?.();
          }}
        >
          <IconX size={12} /> voltar
        </button>
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
