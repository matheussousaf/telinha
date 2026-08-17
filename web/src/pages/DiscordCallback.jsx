import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Logo from '../components/Logo.jsx';

// Discord OAuth implicit-grant callback. The token lives only in this page's
// URL fragment and this function scope — we read the profile client-side,
// keep name/avatar in localStorage, and never send the token anywhere.
export default function DiscordCallback() {
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const token = params.get('access_token');
      const dest = decodeURIComponent(params.get('state') ?? '/');
      if (!token) {
        setError('Login com Discord cancelado.');
        return;
      }
      try {
        const res = await fetch('https://discord.com/api/users/@me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(String(res.status));
        const u = await res.json();
        localStorage.setItem('telinha:name', (u.global_name || u.username || '').slice(0, 32));
        if (u.avatar) {
          localStorage.setItem('telinha:avatar', `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`);
        } else {
          localStorage.removeItem('telinha:avatar');
        }
        localStorage.setItem('telinha:autojoin', '1');
      } catch {
        setError('Não rolou falar com o Discord — tenta entrar com o nome mesmo.');
        return;
      }
      // Guard against open redirects: only ever land back inside a room.
      navigate(dest.startsWith('/room/') ? dest : '/', { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="h-screen bg-black flex flex-col items-center justify-center gap-4 px-6 text-center">
      <Logo size={40} />
      <p className="text-fg2 text-lg m-0">{error ?? 'Entrando com o Discord…'}</p>
      {error && (
        <button className="btn" onClick={() => navigate('/')}>Voltar pro início</button>
      )}
    </div>
  );
}
