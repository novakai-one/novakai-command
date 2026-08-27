// Electron thin shell for Novakai Command: a WINDOW onto the live nvk-server
// on :5180, nothing more. It attaches only to a STAMPED deployed release
// (provenance-checked via /version) and NEVER starts a server itself —
// only `nvk deploy` (launchd job com.novakai.prod) may do that. One starter,
// so there is exactly one server process running exactly one release.
const { app, BrowserWindow, shell } = require('electron');
const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const APP_URL = 'http://localhost:5180';
const PROBE_URL = 'http://127.0.0.1:5180';
const STARTUP_TIMEOUT_MS = 90_000;
const LOG_FILE = path.join(os.homedir(), 'Library', 'Logs', 'NovakaiCommand.log');

let win = null;
let quitting = false;
let recovery = null;

// Identity probe against /version — only a STAMPED deployed release counts:
//   'live'      /version answered with a release stamp: a real `nvk deploy`
//   'unstamped' an nvk-server answered but it runs a bare checkout (dev boot,
//               pre-deploy serve, corrupt stamp) — shown, waited out, never loaded
//   'foreign'   something answered that is not an nvk-server — never load it
//   'free'      nothing on the port
function readJson(pathname) {
  return new Promise((resolve) => {
    const req = http.get(`${PROBE_URL}${pathname}`, { timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ reachable: true, value: JSON.parse(body) });
        } catch {
          resolve({ reachable: true, value: null });
        }
      });
    });
    req.on('error', () => resolve({ reachable: false, value: null }));
    req.on('timeout', () => { req.destroy(); resolve({ reachable: false, value: null }); });
  });
}

async function probe() {
  const versionResponse = await readJson('/version');
  if (!versionResponse.reachable) return 'free';
  const version = versionResponse.value;
  if (typeof version?.release?.commit === 'string') return 'live';
  if (typeof version?.pid === 'number') return 'unstamped';

  // Servers from before /version return the shell HTML above. Their bootstrap
  // contract still proves they are nvk-server, so treat them as replaceable
  // pre-deploy servers instead of an unrelated port conflict.
  const bootstrap = (await readJson('/bootstrap.json')).value;
  if (typeof bootstrap?.wsUrl === 'string' && typeof bootstrap?.protocolVersion === 'number') {
    return 'unstamped';
  }
  return 'foreign';
}

/** Record who holds 5180 so the fail-loud splash has evidence in the log. */
function logConflict() {
  try {
    const owners = execSync('lsof -nP -iTCP:5180 -sTCP:LISTEN', { encoding: 'utf8' });
    fs.appendFileSync(LOG_FILE, `\n--- foreign :5180 responder ${new Date().toISOString()} ---\n${owners}`);
  } catch { /* lsof empty or unavailable — nothing to record */ }
}

function splashHtml(message) {
  const body = `
    <body style="margin:0;display:grid;place-items:center;height:100vh;background:#0b0e14;
                 color:#8b93a7;font:14px -apple-system,system-ui">
      <div style="text-align:center">
        <div style="font-size:20px;color:#e6e9f0;margin-bottom:8px">Novakai Command</div>
        <div>${message}</div>
      </div>
    </body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(body);
}

async function waitForServer() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await probe();
    // 'unstamped' keeps waiting like 'free': `nvk deploy` will kill that
    // server and put a stamped release on the port — this window just watches.
    if (status === 'live' || status === 'foreign') return status;
    if (win?.isDestroyed() !== false) return 'timeout'; // window closed while waiting
    await new Promise((r) => setTimeout(r, 500));
  }
  return 'timeout';
}

async function recover() {
  if (quitting || recovery) return recovery;
  recovery = (async () => {
    if (win && !win.isDestroyed()) await win.loadURL(splashHtml('Reconnecting&hellip;'));
    let status = await probe();
    if (status === 'free' || status === 'unstamped') {
      // This window never starts a server. Say what will, and keep watching —
      // the moment a stamped release serves 5180, the app loads it.
      if (win && !win.isDestroyed()) {
        await win.loadURL(splashHtml(status === 'unstamped'
          ? 'The server on :5180 is not a deployed release (dev boot or pre-deploy serve). '
            + 'Run <code>nvk deploy</code> to replace it. Waiting&hellip;'
          : 'Server is not running. Start it with <code>nvk deploy</code> '
            + '(or <code>launchctl kickstart -k gui/$UID/com.novakai.prod</code>). Waiting&hellip;'));
      }
      status = await waitForServer();
    }
    if (win?.isDestroyed() !== false) return;
    if (status === 'live') {
      await win.loadURL(APP_URL);
    } else if (status === 'foreign') {
      logConflict();
      await win.loadURL(splashHtml(
        `Port 5180 is held by a server that is not nvk-server — not loading it. Details in ${LOG_FILE}`,
      ));
    } else {
      await win.loadURL(splashHtml(
        `Server did not appear. Deploy it with <code>nvk deploy</code>; log at ${LOG_FILE}`,
      ));
    }
  })().finally(() => { recovery = null; });
  return recovery;
}

async function launch() {
  win = new BrowserWindow({
    width: 1512,
    height: 945,
    backgroundColor: '#0b0e14',
    title: 'Novakai Command',
  });
  // External links open in the default browser, not in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-fail-load', (_event, _code, _description, url, mainFrame) => {
    if (mainFrame && url.startsWith(APP_URL)) void recover();
  });
  win.webContents.on('render-process-gone', () => void recover());

  if (await probe() === 'live') {
    try {
      await win.loadURL(APP_URL); // attach to the running deployed serve
    } catch {
      await recover();
    }
    return;
  }

  await recover(); // 'free' → wait for the deployed serve; 'foreign' → fail-loud splash
}

app.whenReady().then(launch);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) launch();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  quitting = true; // nothing to tear down: this app owns no server process
});
