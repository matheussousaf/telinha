# telinha desktop

Electron shell around the deployed web app (`https://ranx.gg`). The web code runs unchanged —
this shell intercepts `getDisplayMedia()` and supplies the capture itself, which buys:

- **No capture bar** — Chrome's "sharing this screen / Ocultar" tray doesn't exist in Electron.
- **Own source picker** — Discord-style grid of windows/screens with app icons; window titles
  that look like games get a 🎮 badge and sort first. Pick the game window directly.
- **System loopback audio (Windows)** — the "incluir áudio do sistema" toggle uses Electron's
  `audio: 'loopback'`, no browser quirks involved.

## Running (on Windows, not WSL!)

Games and their windows live on Windows — run this from a Windows terminal, not inside WSL
(an Electron inside WSL only sees Linux windows):

```powershell
cd desktop
npm install
npm start                # loads https://ranx.gg
npm run start:local      # loads http://localhost:3000 (dev server)
```

## Roadmap

- **Per-application audio** (only the game's sound): needs a native N-API addon using WASAPI
  process loopback (`ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`,
  Windows 10 2004+). The picker already knows which window was chosen; the addon would map the
  window to its PID and capture that process tree's audio as a second track. This is the same
  mechanism Discord uses.
- Process-based game detection (tasklist scan) to complement window-title hints.
- Tray icon + global hotkey to start/stop sharing.
- Packaging: electron-builder (NSIS installer) + code signing + auto-update via GitHub Releases.
