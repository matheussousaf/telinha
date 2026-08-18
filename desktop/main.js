// telinha desktop — thin Electron shell around the deployed web app.
// What it adds over the browser:
//   * no "sharing this screen" capture bar (that's Chrome UI, absent here)
//   * our own source picker (Discord-style, highlights likely games)
//   * system loopback audio on Windows via audio: 'loopback'
// The web app is untouched: its getDisplayMedia() call is intercepted by
// setDisplayMediaRequestHandler and answered with the picked source.
const path = require('node:path');
const { app, BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');

const APP_URL = process.env.TELINHA_URL ?? 'https://ranx.gg';

let mainWindow = null;

// Window titles that smell like games — highlighted in the picker.
const GAME_HINTS =
  /valorant|league of legends|counter-strike|cs2|dota|fortnite|minecraft|grand theft auto|gta|elden|dark souls|dark and darker|apex|overwatch|rocket league|warzone|call of duty|rainbow six|pubg|palworld|terraria|stardew|hades|hollow knight|celeste|baldur|cyberpunk|witcher|diablo|path of exile|escape from tarkov|rust|ark|dayz|sea of thieves|fifa|efootball|nba 2k/i;

function openPicker(sources) {
  return new Promise((resolve) => {
    const picker = new BrowserWindow({
      parent: mainWindow ?? undefined,
      modal: true,
      width: 1100,
      height: 720,
      frame: false,
      resizable: false,
      backgroundColor: '#1e1f22',
      webPreferences: {
        preload: path.join(__dirname, 'preload-picker.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const payload = sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      game: GAME_HINTS.test(s.name),
      thumb: s.thumbnail?.toDataURL() ?? null,
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeAllListeners('picker:choose');
      ipcMain.removeAllListeners('picker:cancel');
      resolve(value);
      if (!picker.isDestroyed()) picker.close();
    };

    ipcMain.once('picker:choose', (_event, choice) => finish(choice));
    ipcMain.once('picker:cancel', () => finish(null));
    picker.on('closed', () => finish(null));

    picker.loadFile(path.join(__dirname, 'picker.html'));
    picker.webContents.once('did-finish-load', () => {
      picker.webContents.send('picker:sources', payload);
    });
  });
}

function registerDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 480, height: 270 },
          fetchWindowIcons: true,
        });
        const choice = await openPicker(sources);
        if (!choice) return callback(null); // denied → NotAllowedError in the page
        const source = sources.find((s) => s.id === choice.id);
        if (!source) return callback(null);
        callback({
          video: source,
          // 'loopback' = full system audio (Windows). Per-application audio needs
          // a WASAPI process-loopback native addon — see README roadmap.
          audio: choice.audio && process.platform === 'win32' ? 'loopback' : undefined,
        });
      } catch (err) {
        console.error('[picker] failed:', err);
        try {
          callback(null);
        } catch {
          /* request already gone */
        }
      }
    },
    { useSystemPicker: false },
  );
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'telinha',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(APP_URL);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerDisplayMediaHandler();
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
