import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo.jsx';
import { IconBot, IconGamepad, IconLock, IconPip, IconZap } from '../components/icons.jsx';

const GITHUB_URL = 'https://github.com/matheussousaf/telinha';

function GitHubIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

const FEATURES = [
  {
    Icon: IconZap,
    title: 'Latência de call',
    text: 'WebRTC direto entre vocês — a stream anda junto com a conversa, não 15 segundos atrás.',
  },
  {
    Icon: IconBot,
    title: 'Bot no Discord',
    text: '/telinha cria a sala com o nome do seu canal de voz e posta o convite com thumbnail ao vivo.',
  },
  {
    Icon: IconPip,
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
      const { ownerUrl } = await res.json();
      const u = new URL(ownerUrl);
      navigate(u.pathname + u.search);
    } catch {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-fg1 font-bold">
          <Logo />
          telinha
        </div>
        <a
          className="flex items-center gap-2 text-fg4 hover:text-fg1 text-[13px] no-underline transition-colors"
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
        >
          <GitHubIcon />
          código aberto
        </a>
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
            Grátis e sem conta — a sala é tipo um canal de voz: todo mundo que entrar pode
            compartilhar a tela, e você (dono) decide quando ela fecha.
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
              <span className="pill"><IconGamepad size={13} /> valorant</span>
              <span className="pill">4 assistindo</span>
            </div>
          </div>
        </div>
      </div>

      {/* Feature strip */}
      <div className="grid sm:grid-cols-3 gap-8 mt-20 pt-8 border-t border-line">
        {FEATURES.map((f) => (
          <div key={f.title} className="flex items-start gap-3">
            <f.Icon size={20} className="text-blurple flex-none mt-0.5" />
            <div>
              <h3 className="text-fg1 text-sm font-bold m-0">{f.title}</h3>
              <p className="text-fg4 text-[13px] leading-snug mt-1 mb-0">{f.text}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="card p-6 mt-16 max-w-xl mx-auto text-center">
        <h3 className="text-fg1 text-base font-bold m-0 flex items-center justify-center gap-2">
          <IconLock size={16} className="text-blurple" /> Seguro por desenho, aberto por princípio
        </h3>
        <p className="text-fg4 text-[13px] leading-relaxed mt-2 mb-0">
          O vídeo vai direto (P2P) de quem transmite pra quem assiste — não passa nem fica gravado
          no servidor. As salas têm link impossível de adivinhar, e a chave de transmissão fica só
          com você. E não precisa confiar na nossa palavra: o código é todo aberto.
        </p>
        <a
          className="btn btn-secondary h-9 px-4 text-sm mt-4"
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
        >
          <GitHubIcon />
          Ver código no GitHub
        </a>
      </div>

      <p className="text-fg4 text-[13px] text-center mt-8">Feito por amigos, para amigos.</p>
    </main>
  );
}
