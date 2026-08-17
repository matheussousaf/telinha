import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo.jsx';

const FEATURES = [
  {
    emoji: '⚡',
    title: 'Latência de call',
    text: 'WebRTC direto entre vocês — a stream anda junto com a conversa, não 15 segundos atrás.',
  },
  {
    emoji: '🤖',
    title: 'Bot no Discord',
    text: '/screenshare cria a sala e posta o link no canal, com thumbnail ao vivo e contador.',
  },
  {
    emoji: '📌',
    title: 'Pop-out flutuante',
    text: 'Janelinha sempre-no-topo por cima do Discord. O tile do Go Live, só que nosso.',
  },
];

// Abstract "gameplay" for the mock stream window
const FAKE_GAME = {
  background: [
    'radial-gradient(120% 90% at 20% 15%, rgba(60, 69, 165, 0.9) 0%, transparent 55%)',
    'radial-gradient(80% 70% at 85% 80%, rgba(35, 165, 90, 0.25) 0%, transparent 60%)',
    'radial-gradient(100% 100% at 60% 40%, rgba(237, 66, 69, 0.18) 0%, transparent 55%)',
    '#15161b',
  ].join(', '),
};

export default function Landing() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function createRoom() {
    setBusy(true);
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || 'stream' }),
      });
      const { shareUrl } = await res.json();
      const u = new URL(shareUrl);
      navigate(u.pathname + u.search);
    } catch {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8">
      <div className="flex items-center gap-2 text-fg1 font-bold">
        <Logo />
        telinha
      </div>

      <div className="grid lg:grid-cols-2 items-center gap-12 lg:gap-10 mt-14 lg:mt-20">
        {/* Left: headline + story + CTA */}
        <div>
          <h1 className="text-fg1 text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.08] m-0">
            A ranked <span className="text-blurple">não pode parar</span>.
          </h1>
          <p className="text-fg3 text-[17px] leading-relaxed mt-5 max-w-[46ch]">
            O Go Live do Discord foi suspenso no Brasil. A{' '}
            <strong className="text-fg1 font-semibold">telinha</strong> é o plano B que virou plano
            A: compartilhe sua tela direto do navegador e mande um link pros amigos. Sem cadastro,
            sem instalação — a call fica no Discord, o vídeo fica aqui.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 mt-8 max-w-md">
            <input
              className="input flex-1 h-11"
              type="text"
              placeholder="ex.: ranked com os cria"
              aria-label="Nome da stream"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && createRoom()}
            />
            <button className="btn h-11 px-6 flex-none" onClick={createRoom} disabled={busy}>
              {busy ? 'Criando…' : 'Criar sala →'}
            </button>
          </div>
          <p className="text-fg4 text-[13px] mt-3">
            Grátis e sem conta — você cai na sua página de transmissão com o link pronto pra colar
            no Discord.
          </p>
        </div>

        {/* Right: mock stream window */}
        <div className="relative mx-auto w-full max-w-lg" aria-hidden="true">
          <div className="absolute -inset-10 rounded-full bg-blurple/20 blur-3xl" />
          <div className="relative video-frame live -rotate-1 select-none">
            <div className="absolute inset-0" style={FAKE_GAME} />
            {/* HUD suggestions */}
            <div className="absolute top-3 right-3 w-16 h-16 rounded-md border border-white/15 bg-white/5" />
            <div className="absolute bottom-4 left-4 w-28 h-2 rounded-full bg-white/15 overflow-hidden">
              <div className="h-full w-3/4 rounded-full bg-green" />
            </div>
            <div className="absolute inset-0 flex items-center justify-center text-white/25 text-2xl font-light">
              +
            </div>
            {/* stream chrome */}
            <span className="pill live absolute top-3 left-3">
              <span className="animate-pulse">●</span> ao vivo
            </span>
            <div className="absolute bottom-3 right-3 flex gap-2">
              <span className="pill">🎮 valorant</span>
              <span className="pill">4 assistindo</span>
            </div>
          </div>
        </div>
      </div>

      {/* Feature strip */}
      <div className="grid sm:grid-cols-3 gap-8 mt-20 pt-8 border-t border-line">
        {FEATURES.map((f) => (
          <div key={f.title} className="flex items-start gap-3">
            <span className="text-2xl leading-none mt-0.5" aria-hidden="true">{f.emoji}</span>
            <div>
              <h3 className="text-fg1 text-sm font-bold m-0">{f.title}</h3>
              <p className="text-fg4 text-[13px] leading-snug mt-1 mb-0">{f.text}</p>
            </div>
          </div>
        ))}
      </div>

      <p className="text-fg4 text-[13px] text-center mt-16">
        Feito por amigos, para amigos — o vídeo vai direto de quem transmite pra quem assiste.
        Nada fica gravado no servidor.
      </p>
    </main>
  );
}
