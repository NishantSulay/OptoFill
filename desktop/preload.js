// Gives each part of the extension the chrome.* calls it uses, forwarded to main.js.
//   content    — every frame of the EMR page: runs schema.js + content.js in this isolated world, as Chrome runs a
//                content script (the page's own scripts can't see it)
//   panel      — popup.html, the side panel
//   background — background.js and the files it imports, in a hidden page
//   toolbar    — the address bar (no chrome.* at all)
const { ipcRenderer, contextBridge } = require('electron');

const role = (process.argv.find(a => a.startsWith('--optofill-role=')) || '').split('=')[1];

// ─── chrome.* ─────────────────────────────────────────────────────────────────
function event() {
  const ls = new Set();
  return { addListener: f => ls.add(f), removeListener: f => ls.delete(f), hasListener: f => ls.has(f), fire: (...a) => [...ls].map(f => f(...a)), listeners: ls };
}
// Chrome calls take a callback, or return a promise when there is none
const either = (promise, cb) => {
  if (typeof cb !== 'function') return promise;
  promise.then(v => cb(v), () => cb());
};

// Runs onMessage listeners and replies once, as Chrome does: a listener answers with sendResponse (returning true to
// answer later) or a promise; no answer means undefined
function dispatch(listeners, id, msg, sender) {
  let done = false, later = false;
  const answer = (handled, response) => {
    if (done) return;
    done = true;
    ipcRenderer.send('optofill:reply', id, true, { handled, response });
  };
  for (const f of listeners) {
    try {
      const r = f(msg, sender, resp => answer(true, resp));
      if (r === true) later = true;
      else if (r && typeof r.then === 'function') { later = true; r.then(v => answer(true, v), () => answer(false)); }
    } catch (err) { console.error(err); }
  }
  if (!later) answer(false);
}

const ports = new Map();   // portId → { port, onMessage, onDisconnect, open }
function makePort(portId, name, sender) {
  const onMessage = event(), onDisconnect = event();
  const entry = { onMessage, onDisconnect, open: true };
  const port = entry.port = {
    name, sender, onMessage, onDisconnect,
    postMessage(msg) {
      if (!entry.open) throw new Error('Attempting to use a disconnected port object');
      ipcRenderer.send('optofill:port-post', portId, msg);
    },
    disconnect() {
      if (!entry.open) return;
      entry.open = false;
      ports.delete(portId);
      ipcRenderer.send('optofill:port-close', portId);
    },
  };
  ports.set(portId, entry);
  return port;
}
ipcRenderer.on('optofill:port-message', (e, portId, msg) => { const p = ports.get(portId); if (p) p.onMessage.fire(msg, p.port); });
ipcRenderer.on('optofill:port-disconnect', (e, portId) => {
  const p = ports.get(portId);
  if (!p) return;
  p.open = false;
  ports.delete(portId);
  p.onDisconnect.fire(p.port);
});

function makeChrome() {
  const area = name => ({
    get: (keys, cb) => either(ipcRenderer.invoke('optofill:storage', name, 'get', keys ?? null), cb),
    set: (items, cb) => either(ipcRenderer.invoke('optofill:storage', name, 'set', items), cb),
    remove: (keys, cb) => either(ipcRenderer.invoke('optofill:storage', name, 'remove', keys), cb),
    clear: cb => either(ipcRenderer.invoke('optofill:storage', name, 'clear'), cb),
  });
  const onMessage = event(), onConnect = event(), onUpdated = event(), onActivated = event();
  ipcRenderer.on('optofill:runtime-message', (e, id, { msg, sender }) => dispatch(onMessage.listeners, id, msg, sender));
  ipcRenderer.on('optofill:port-connect', (e, portId, name, sender) => onConnect.fire(makePort(portId, name, sender)));
  ipcRenderer.on('optofill:tab-updated', (e, tabId, info, tab) => onUpdated.fire(tabId, info, tab));
  let manifest;

  const chrome = {
    runtime: {
      id: 'optofill',
      lastError: undefined,
      getManifest: () => (manifest ??= ipcRenderer.sendSync('optofill:manifest')),
      getURL: p => 'optofill://app/ext/' + String(p).replace(/^\//, ''),
      sendMessage: (msg, cb) => either(ipcRenderer.invoke('optofill:runtime-send', msg), cb),
      connect: (info = {}) => {
        const portId = crypto.randomUUID();
        const port = makePort(portId, info.name || '');
        ipcRenderer.send('optofill:port-open', portId, info.name || '');
        return port;
      },
      onMessage, onConnect,
    },
    storage: { local: area('local'), session: area('session') },
  };
  if (role === 'content') return chrome;   // content scripts get runtime and storage only, as in Chrome

  chrome.tabs = {
    query: (q, cb) => either(ipcRenderer.invoke('optofill:tabs-query', q), cb),
    sendMessage: (tabId, msg, opts, cb) => {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      return either(ipcRenderer.invoke('optofill:tabs-send', tabId, msg, opts || {}), cb);
    },
    onUpdated, onActivated,
  };
  chrome.scripting = {
    executeScript: ({ target, func, args = [], files } = {}, cb) => {
      if (!func && !files) return either(Promise.reject(new Error('executeScript needs func or files')), cb);
      return either(ipcRenderer.invoke('optofill:execute', target, func ? `(${func})` : null, args), cb);
    },
  };
  return chrome;
}

// ─── Roles ────────────────────────────────────────────────────────────────────
if (role === 'panel' || role === 'background') {
  window.chrome = makeChrome();
  // background.js starts with importScripts(...); background.html loads those files itself
  if (role === 'background') window.importScripts = () => {};
  // The desktop app's global shortcut (Ctrl/Cmd+Alt+D) starts and stops dictation, like clicking the mic
  if (role === 'panel') ipcRenderer.on('optofill:shortcut', () => document.getElementById('mic-btn')?.click());
}

if (role === 'toolbar') {
  contextBridge.exposeInMainWorld('optofillNav', {
    go: url => ipcRenderer.send('optofill:nav', 'go', String(url)),
    run: cmd => ipcRenderer.send('optofill:nav', String(cmd)),
    onState: f => ipcRenderer.on('optofill:nav-state', (e, s) => f(s)),
  });
}

if (role === 'content') {
  const sources = ipcRenderer.sendSync('optofill:content-source');
  if (sources.length) {
    globalThis.chrome = makeChrome();
    // Chrome's own speech recognition is a Google service that only Chrome itself can use. The extension's
    // fallback to it would fail here with a bare "network" error, so say what to do instead.
    const NO_CHROME_SPEECH = 'Chrome’s built-in speech isn’t available in the desktop app — turn on Medical speech in Settings (⚙)';
    globalThis.SpeechRecognition = globalThis.webkitSpeechRecognition = class {
      start() { setTimeout(() => this.onerror?.({ error: NO_CHROME_SPEECH })); }
      stop() {} abort() {}
    };

    // The start page's link to the practice EMR
    window.addEventListener('click', e => {
      if (e.target.closest?.('[data-optofill-practice]')) { e.preventDefault(); ipcRenderer.send('optofill:open-practice'); }
    });

    // Run the content script once the page is parsed (the manifest's document_idle). Requests that arrive before then wait.
    let loaded;
    const ready = new Promise(r => { loaded = r; });
    const run = () => {
      try { for (const src of sources) (0, eval)(src); }   // indirect eval: top-level functions become this world's globals
      catch (err) { console.error('OptoFill content script failed', err); }
      loaded();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(run), { once: true });
    else setTimeout(run);

    ipcRenderer.on('optofill:tab-message', async (e, id, { msg, sender }) => {
      await ready;
      dispatch(chrome.runtime.onMessage.listeners, id, msg, sender);
    });
    ipcRenderer.on('optofill:execute', async (e, id, { code, args }) => {
      await ready;
      try { ipcRenderer.send('optofill:reply', id, true, await (0, eval)(code)(...args)); }
      catch (err) { ipcRenderer.send('optofill:reply', id, false, String(err?.message || err)); }
    });
  }
}
