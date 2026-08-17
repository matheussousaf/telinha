import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo.jsx';

const FEATURES = [
  {
    emoji: '⚡',
    title: 'Latência de outro mundo',
    text: 'WebRTC direto de você pros seus amigos — a stream anda junto com a call, não 15 segundos atrás.',
  },
  {
    emoji: '🤖',
    title: 'Bot no Discord',
    text: '/screenshare cria a sala e posta o link no canal, com thumbnail ao vivo e contador de quem tá assistindo.',
  },
  {
    emoji: '📌',
    title: 'Janelinha flutuante',
    text: 'Quem assiste solta um pop-out sempre-no-topo por cima do Discord. Igualzinho ao tile do Go Live, só que nosso.',
  },
];

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
    <main className="mx-auto w-full max-w-2xl px-4 py-16">
      <div className="text-center">
        <Logo size={52} />
        <h1 className="text-fg1 text-4xl font-extrabold tracking-tight mt-4">telinha</h1>
        <p className="text-fg3 text-lg mt-1">sua tela, na telinha dos amigos</p>
      </div>

      <div className="card p-6 mt-10 text-[15px] leading-relaxed">
        <p className="m-0">
          Em agosto de 2026, o Go Live do Discord foi suspenso no Brasil por ordem da ANPD.
          Discussão jurídica à parte… <strong className="text-fg1">a ranked não pode parar</strong>.
        </p>
        <p className="mt-3 mb-0">
          A <strong className="text-fg1">telinha</strong> é o plano B que virou plano A: você cria
          uma sala, compartilha a tela direto do navegador e manda um link pros amigos. Sem
          cadastro, sem instalação, sem delay de live de estádio. A call fica no Discord — o vídeo
          fica aqui.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 mt-4">
        {FEATURES.map((f) => (
          <div key={f.title} className="card p-4">
            <div className="text-2xl" aria-hidden="true">{f.emoji}</div>
            <h3 className="text-fg1 text-sm font-bold mt-2 mb-1">{f.title}</h3>
            <p className="text-fg4 text-[13px] leading-snug m-0">{f.text}</p>
          </div>
        ))}
      </div>

      <div className="card p-6 mt-4 border-blurple/40">
        <label className="label" htmlFor="name">Como vamos chamar a stream de hoje?</label>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            id="name"
            className="input flex-1"
            type="text"
            placeholder="ex.: ranked com os cria"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && createRoom()}
          />
          <button className="btn flex-none sm:px-6" onClick={createRoom} disabled={busy}>
            {busy ? 'Criando…' : 'Criar sala →'}
          </button>
        </div>
        <p className="text-fg4 text-xs mt-3 mb-0">
          Você cai direto na sua página de transmissão, com o link dos amigos pronto pra copiar.
        </p>
      </div>

      <p className="text-fg4 text-[13px] text-center mt-8">
        Feito por amigos, para amigos. O vídeo vai direto de quem transmite pra quem assiste —
        nada fica gravado no servidor.
      </p>
    </main>
  );
}
