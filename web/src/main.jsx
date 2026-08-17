import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './app.css';
import Landing from './pages/Landing.jsx';
import Share from './pages/Share.jsx';
import Watch from './pages/Watch.jsx';

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/share/:roomId" element={<Share />} />
      <Route path="/watch/:roomId" element={<Watch />} />
    </Routes>
  </BrowserRouter>,
);
