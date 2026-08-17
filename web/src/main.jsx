import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom';
import './app.css';
import Landing from './pages/Landing.jsx';
import Room from './pages/Room.jsx';

// Old /share and /watch links keep working — same room, same query string.
function LegacyRedirect() {
  const { roomId } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/room/${roomId}${search}`} replace />;
}

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/room/:roomId" element={<Room />} />
      <Route path="/share/:roomId" element={<LegacyRedirect />} />
      <Route path="/watch/:roomId" element={<LegacyRedirect />} />
    </Routes>
  </BrowserRouter>,
);
