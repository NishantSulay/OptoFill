// OptoFill desktop: the doctor's web EMR on the left and the OptoFill panel on the right, in one window.
// The extension's own files (eye-exam-extension/) run unchanged. This file and preload.js stand in for the parts of
// Chrome they use: chrome.storage, messages and ports between the page, the panel and the background script, the
// exam "tab" and its frames (chrome.tabs / chrome.scripting), and the side panel itself.
//
//   npm start                     (from desktop/, after npm install)
//   npm start -- --url=https://your-emr.example.com
const { app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, protocol, net, session, globalShortcut, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'eye-exam-extension');
const UI = path.join(__dirname, 'ui');
const PRACTICE_EMR = pathToFileURL(path.join(ROOT, 'core/mock-emr/index.html')).href;
const APP_ORIGIN = 'optofill://app';
const TAB_ID = 1;                       // the EMR view is the one "tab" the extension code sees
const PANEL_WIDTH = 400, TOOLBAR_HEIGHT = 44;
const MIC_SHORTCUT = 'CommandOrControl+Alt+D';

if (process.env.OPTOFILL_USER_DATA) app.setPath('userData', process.env.OPTOFILL_USER_DATA);   // tests use a fresh profile
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

// The panel and background pages are served from optofill://app/ext/… (the extension folder) and optofill://app/shell/…
// (this app's own pages), so they share one secure origin, as an extension's pages do.
protocol.registerSchemesAsPrivileged([{ scheme: 'optofill', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

// ─── chrome.storage ──────────────────────────────────────────────────────────
// local is kept in a file in the app's data folder (like Chrome's profile); session lives until the app quits.
let storeFile;
const store = { local: {}, session: {} };

function loadStore() {
  storeFile = path.join(app.getPath('userData'), 'optofill-storage.json');
  try { store.local = JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch (e) { store.local = {}; }
}
function saveStore() {
  const tmp = storeFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store.local), { mode: 0o600 });
  fs.renameSync(tmp, storeFile);
}
function storageOp(area, op, arg) {
  const src = store[area];
  if (!src) throw new Error('Unknown storage area ' + area);
  if (op === 'get') {
    if (arg == null) return structuredClone(src);
    const defaults = typeof arg === 'object' && !Array.isArray(arg) ? arg : {};
    const keys = typeof arg === 'string' ? [arg] : Array.isArray(arg) ? arg : Object.keys(arg);
    const out = {};
    for (const k of keys) if (k in src) out[k] = structuredClone(src[k]); else if (k in defaults) out[k] = defaults[k];
    return out;
  }
  if (op === 'set') Object.assign(src, structuredClone(arg));
  else if (op === 'remove') for (const k of [].concat(arg)) delete src[k];
  else if (op === 'clear') for (const k of Object.keys(src)) delete src[k];
  else throw new Error('Unknown storage call ' + op);
  if (area === 'local') saveStore();
}

// ─── Window ──────────────────────────────────────────────────────────────────
let win, toolbar, emr, panel, background, panelOpen = true;

function layout() {
  const [w, h] = win.getContentSize();
  const p = panelOpen ? Math.min(PANEL_WIDTH, Math.floor(w / 2)) : 0;
  toolbar.setBounds({ x: 0, y: 0, width: w, height: TOOLBAR_HEIGHT });
  emr.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w - p, height: h - TOOLBAR_HEIGHT });
  panel.setBounds({ x: w - p, y: TOOLBAR_HEIGHT, width: p, height: h - TOOLBAR_HEIGHT });
  panel.setVisible(panelOpen);
}

const prefs = (role, extra = {}) => ({
  preload: path.join(__dirname, 'preload.js'),
  additionalArguments: [`--optofill-role=${role}`],
  sandbox: true, nodeIntegration: false, contextIsolation: true, ...extra,
});

// Our own pages (panel, background, toolbar) never leave optofill://app; links open in the doctor's browser
function keepHome(contents) {
  contents.on('will-navigate', (e, url) => { if (!url.startsWith(APP_ORIGIN + '/')) e.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

async function createWindow() {
  // The background script: background.js and the files it imports, in a hidden page
  background = new BrowserWindow({ show: false, webPreferences: prefs('background', { contextIsolation: false }) });
  keepHome(background.webContents);
  await background.loadURL(`${APP_ORIGIN}/shell/background.html`);

  win = new BaseWindow({ width: 1500, height: 950, minWidth: 900, minHeight: 600, title: 'OptoFill', icon: path.join(EXT, 'icons/icon128.png') });
  toolbar = new WebContentsView({ webPreferences: prefs('toolbar') });
  // The EMR: a remote site, so it is sandboxed with context isolation; the content script runs in every frame
  // (nodeIntegrationInSubFrames only means the preload runs there too — no Node in any frame)
  emr = new WebContentsView({ webPreferences: prefs('content', { partition: 'persist:emr', nodeIntegrationInSubFrames: true }) });
  // The side panel: popup.html, unchanged. Context isolation is off only so the preload can hand it a plain chrome
  // object (scripting.executeScript needs the panel's own functions); it shows nothing but this app's files.
  panel = new WebContentsView({ webPreferences: prefs('panel', { contextIsolation: false }) });
  for (const v of [toolbar, emr, panel]) win.contentView.addChildView(v);
  keepHome(toolbar.webContents);
  keepHome(panel.webContents);
  layout();
  win.on('resize', layout);
  win.on('closed', () => app.quit());

  watchEmr();
  toolbar.webContents.loadURL(`${APP_ORIGIN}/shell/toolbar.html`);
  panel.webContents.loadURL(`${APP_ORIGIN}/ext/popup.html`);
  emr.webContents.loadURL(startUrl());

  globalShortcut.register(MIC_SHORTCUT, () => panel.webContents.send('optofill:shortcut', 'mic'));
}

function startUrl() {
  const arg = process.argv.find(a => a.startsWith('--url='));
  if (arg) return normalizeUrl(arg.slice(6));
  const last = readState().lastUrl;
  return last || pathToFileURL(path.join(UI, 'start.html')).href + '?practice=' + encodeURIComponent(PRACTICE_EMR);
}

// What the doctor types in the address bar: a host ("emr.example.com") becomes https://
function normalizeUrl(input) {
  const s = String(input || '').trim();
  if (/^(https?|file):/i.test(s)) return s;
  return 'https://' + s;
}

// Window state (last EMR address), kept apart from the extension's storage
const stateFile = () => path.join(app.getPath('userData'), 'desktop-state.json');
function readState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { return {}; } }
function writeState(s) { fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...s }), { mode: 0o600 }); }

function watchEmr() {
  const wc = emr.webContents;
  const sendNav = () => toolbar.webContents.send('optofill:nav-state', {
    url: wc.getURL().startsWith('file:') && wc.getURL().includes('/desktop/ui/start.html') ? '' : wc.getURL(),
    title: wc.getTitle(), canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), panelOpen,
  });
  wc.on('did-navigate', sendNav);
  wc.on('did-navigate-in-page', sendNav);
  wc.on('page-title-updated', sendNav);
  toolbar.webContents.on('did-finish-load', sendNav);
  wc.on('did-navigate', (e, url) => { if (/^https?:/.test(url)) writeState({ lastUrl: url }); });

  // Like chrome.tabs.onUpdated: the panel shows the status of the page that just loaded
  wc.on('did-finish-load', () => {
    for (const c of [panel.webContents, background.webContents]) c.send('optofill:tab-updated', TAB_ID, { status: 'complete' }, tabInfo());
  });
  // A page that goes away takes its pending replies and open ports with it
  wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) dropEmrPage(); });
  wc.on('render-process-gone', dropEmrPage);

  // EMRs that open the exam in a new window: keep it in this view, where OptoFill can see it (prototype)
  wc.setWindowOpenHandler(({ url }) => { if (/^(https?|file):/.test(url)) wc.loadURL(url); return { action: 'deny' }; });

  // Microphone for dictation: asked once per EMR site, like Chrome's prompt. Everything else is refused.
  const ses = session.fromPartition('persist:emr');
  const allowed = () => readState().micOrigins || [];
  const originOf = u => { try { return new URL(u).origin; } catch (e) { return ''; } };
  ses.setPermissionCheckHandler((c, permission, origin, details) =>
    permission === 'media' && details.mediaType === 'audio' && allowed().includes(originOf(details.requestingUrl || origin)));
  ses.setPermissionRequestHandler(async (c, permission, callback, details) => {
    const audioOnly = permission === 'media' && (details.mediaTypes || []).length && details.mediaTypes.every(t => t === 'audio');
    if (!audioOnly) return callback(permission === 'fullscreen' || permission === 'clipboard-sanitized-write');
    const origin = originOf(details.requestingUrl);
    if (allowed().includes(origin)) return callback(true);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Allow', 'Block'], defaultId: 0, cancelId: 1, title: 'Microphone',
      message: `Allow OptoFill to use the microphone on ${origin || 'this page'}?`,
      detail: 'Dictation records while you hold the mic on, and only then.',
    });
    if (response === 0) writeState({ micOrigins: [...allowed(), origin] });
    callback(response === 0);
  });
}

function tabInfo() {
  const url = emr.webContents.getURL();
  return { id: TAB_ID, windowId: 1, active: true, status: 'complete', url, title: emr.webContents.getTitle() };
}

// ─── Frames: frameId 0 is the EMR's top page; other frames use their (stable) frame tree id ──────────────────────
const idOfFrame = f => (!f.parent ? 0 : f.frameTreeNodeId);
function frameById(id) {
  const top = emr.webContents.mainFrame;
  return !id ? top : top.framesInSubtree.find(f => f.frameTreeNodeId === id) || null;
}
const sameFrame = (a, b) => a && b && a.processId === b.processId && a.routingId === b.routingId;

// Requests to a page, panel or background frame; the preload answers with optofill:reply
let seq = 0;
const pending = new Map();   // id → { resolve, reject, wcId }
function ask(frame, channel, payload) {
  return new Promise((resolve, reject) => {
    if (!frame || frame.detached) return reject(new Error('Could not establish connection. Receiving end does not exist.'));
    const id = ++seq;
    pending.set(id, { resolve, reject, frame });
    frame.send(channel, id, payload);
  });
}
ipcMain.on('optofill:reply', (e, id, ok, value) => {
  const p = pending.get(id);
  if (!p || !sameFrame(p.frame, e.senderFrame)) return;
  pending.delete(id);
  ok ? p.resolve(value) : p.reject(new Error(value));
});

function dropEmrPage() {
  for (const [id, p] of pending) {
    if (sameFrame(p.frame.top, emr.webContents.mainFrame)) {
      pending.delete(id);
      p.reject(new Error('The page was closed before it answered.'));
    }
  }
  for (const [portId, p] of ports) if (p.emr) closePort(portId, null);
}

// Who sent a message, as chrome.runtime.MessageSender
function senderOf(e) {
  if (isEmr(e.sender)) return { tab: tabInfo(), frameId: idOfFrame(e.senderFrame), url: e.senderFrame.url, origin: e.senderFrame.origin };
  return { id: 'optofill', url: e.senderFrame.url, origin: APP_ORIGIN };
}
const isEmr = c => !!emr && c?.id === emr.webContents.id;
const extensionPages = () => [background?.webContents, panel?.webContents].filter(c => c && !c.isDestroyed());

// ─── IPC: the chrome.* calls preload.js forwards ────────────────────────────
ipcMain.handle('optofill:storage', (e, area, op, arg) => storageOp(area, op, arg));
ipcMain.on('optofill:manifest', (e) => { e.returnValue = MANIFEST; });
ipcMain.on('optofill:content-source', (e) => {
  // Only the EMR's frames get the content script, as the manifest's content_scripts would give it
  e.returnValue = isEmr(e.sender) ? ['schema.js', 'content.js'].map(f => fs.readFileSync(path.join(EXT, f), 'utf8')) : [];
});

// chrome.runtime.sendMessage: reaches every extension page but the sender (here the background script, and the panel)
ipcMain.handle('optofill:runtime-send', async (e, msg) => {
  const targets = extensionPages().filter(c => c.id !== e.sender.id);
  const replies = await Promise.allSettled(targets.map(c => ask(c.mainFrame, 'optofill:runtime-message', { msg, sender: senderOf(e) })));
  return replies.find(r => r.status === 'fulfilled' && r.value?.handled)?.value.response;
});

// chrome.tabs.*
ipcMain.handle('optofill:tabs-query', () => {
  const url = emr?.webContents.getURL();
  return url && url !== 'about:blank' ? [tabInfo()] : [];
});
ipcMain.handle('optofill:tabs-send', async (e, tabId, msg, opts = {}) => {
  if (tabId !== TAB_ID) throw new Error('No tab with id: ' + tabId);
  const reply = await ask(frameById(opts.frameId || 0), 'optofill:tab-message', { msg, sender: senderOf(e) });
  return reply?.response;
});

// chrome.scripting.executeScript: a function runs in the content script's world of each target frame (where
// content.js's functions are); files are the content script, which every frame already has
ipcMain.handle('optofill:execute', async (e, target, code, args) => {
  if (target.tabId !== TAB_ID) throw new Error('No tab with id: ' + target.tabId);
  const top = emr.webContents.mainFrame;
  const frames = target.allFrames ? [top, ...top.framesInSubtree.filter(f => f !== top && f.parent)]
    : (target.frameIds || [0]).map(frameById).filter(Boolean);
  const out = await Promise.allSettled(frames.map(f => code == null ? undefined : ask(f, 'optofill:execute', { code, args })));
  return frames.map((f, i) => ({ frameId: idOfFrame(f), result: out[i].status === 'fulfilled' ? out[i].value : undefined }));
});

// chrome.runtime.connect: ports always open to the background script (the only page with onConnect listeners)
const ports = new Map();   // portId → { a: opener frame, b: background frame, emr: opened from the EMR page }
ipcMain.on('optofill:port-open', (e, portId, name) => {
  const b = background.webContents.mainFrame;
  ports.set(portId, { a: e.senderFrame, b, emr: isEmr(e.sender) });
  b.send('optofill:port-connect', portId, name, senderOf(e));
});
ipcMain.on('optofill:port-post', (e, portId, msg) => {
  const p = ports.get(portId);
  if (!p) return;
  const to = sameFrame(e.senderFrame, p.a) ? p.b : p.a;
  if (!to.detached) to.send('optofill:port-message', portId, msg);
});
ipcMain.on('optofill:port-close', (e, portId) => closePort(portId, e.senderFrame));
function closePort(portId, from) {
  const p = ports.get(portId);
  if (!p) return;
  ports.delete(portId);
  for (const f of [p.a, p.b]) if (!sameFrame(f, from) && !f.detached) f.send('optofill:port-disconnect', portId);
}

// Toolbar: address bar, back/forward/reload, show or hide the panel
ipcMain.on('optofill:nav', (e, cmd, arg) => {
  if (e.sender.id !== toolbar.webContents.id) return;
  const wc = emr.webContents;
  if (cmd === 'go') wc.loadURL(normalizeUrl(arg));
  if (cmd === 'practice') wc.loadURL(PRACTICE_EMR);
  if (cmd === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  if (cmd === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  if (cmd === 'reload') wc.reload();
  if (cmd === 'panel') { panelOpen = !panelOpen; layout(); toolbar.webContents.send('optofill:nav-state', { panelOpen }); }
});
// The start page's "Open the practice EMR" link
ipcMain.on('optofill:open-practice', (e) => { if (isEmr(e.sender)) emr.webContents.loadURL(PRACTICE_EMR); });

// ─── App ─────────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  loadStore();
  protocol.handle('optofill', (req) => {
    const u = new URL(req.url);
    const [, area, ...rest] = decodeURIComponent(u.pathname).split('/');
    const base = area === 'ext' ? EXT : area === 'shell' ? UI : null;
    const file = base && path.normalize(path.join(base, ...rest));
    if (u.host !== 'app' || !file || !file.startsWith(base + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
  await createWindow();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
