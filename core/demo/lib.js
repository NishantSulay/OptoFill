// Shared by record.js (website video) and screenshots.js (store screenshots): serves the repo, opens stage.html with
// the mock EMR and the real OptoFill UI (popup.html, shown as Chrome's side panel), stubs the extension APIs so both
// run in ordinary frames, and drives a camera (zoom), a cursor and captions. Claude's reply is canned (VALUES).
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '../..');

const DICTATION = 'Distance vision without glasses, right eye 20/40, left 20/30 minus 1. Pupils PERRLA, no APD. ' +
  'Cover test ortho at distance, 2 prism diopters exophoria at near. Amplitude OD 6 centimeters, OS 5 centimeters. NPC 8 cm. ' +
  'PD 64 distance, 61 near. Color normal both eyes on Ishihara. Stereo 40 seconds with Randot.';
// What the extraction step returns for this dictation (schema keys → values)
const VALUES = {
  va_dist_sc_od: '20/40', va_dist_sc_os: '20/30-1', pupils_notes: 'PERRLA, no APD',
  cover_dist_direction: 'ortho', cover_near_direction: 'exo', cover_near_amount: '2',
  bv_amplitude_od: '6 cm', bv_amplitude_os: '5 cm', bv_npc: '8 cm', pd_dist_ou: '64', pd_near_ou: '61',
  color_od: 'normal', color_os: 'normal', color_method: 'Ishihara', stereo: '40"', stereo_method: 'Randot',
};

// Stand-ins for the extension APIs, installed in every frame before its scripts run
function installStubs(values) {
  const top = window.top;
  top.__store = top.__store || { local: { apiKey: 'sk-ant-demo' }, session: {} };
  const area = name => ({
    get(keys, cb) {
      const src = top.__store[name], out = {};
      const list = keys == null ? Object.keys(src) : Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      for (const k of list) if (k in src) out[k] = src[k];
      if (cb) { cb(out); return; }
      return Promise.resolve(out);
    },
    set(o, cb) { Object.assign(top.__store[name], JSON.parse(JSON.stringify(o))); cb && cb(); return Promise.resolve(); },
    remove(k, cb) { delete top.__store[name][k]; cb && cb(); return Promise.resolve(); },
  });
  const storage = { local: area('local'), session: area('session') };

  if (location.pathname.endsWith('/mock-emr/index.html')) {
    window.__listeners = [];
    window.chrome = { runtime: { onMessage: { addListener: f => window.__listeners.push(f) },
                                 sendMessage: m => { top.__toPanel && top.__toPanel(m); return Promise.resolve(); } }, storage };
    return;
  }
  if (!location.pathname.endsWith('/popup.html')) return;

  const emr = () => top.document.getElementById('emr').contentWindow;
  const portListeners = [];
  top.__toPanel = msg => portListeners.forEach(f => f(msg));
  const port = {
    onMessage: { addListener: f => portListeners.push(f) },
    onDisconnect: { addListener() {} },
    postMessage(msg) {
      if (msg.action === 'startRecording') setTimeout(() => top.__toPanel({ action: 'micStarted' }), 150);
      if (msg.action === 'extract') setTimeout(() => top.__toPanel({ action: 'extractResult', ok: true, values, redacted: 0 }), 1400);
    },
  };
  window.chrome = {
    runtime: { connect: () => port, onMessage: { addListener() {} }, sendMessage() {} },
    storage,
    tabs: {
      query: async () => [{ id: 1, url: 'https://your-emr.example.com/exam' }],
      sendMessage: (tabId, msg) => new Promise(res => emr().__listeners.forEach(l => l(msg, {}, res))),
      onActivated: { addListener() {} }, onUpdated: { addListener() {} },
    },
    scripting: {
      async executeScript({ func }) {
        if (!func) return [{ frameId: 0, result: null }];
        if (/permissions/.test(String(func))) return [{ frameId: 0, result: 'granted' }];
        return [{ frameId: 0, result: await emr().eval('(' + func + ')()') }];
      },
    },
  };
}

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

// Opens the stage with the EMR set up and the side panel loaded. Returns helpers to drive it.
async function openStage(browser, { width, height, scale = 2, setup = true }) {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
  await ctx.addInitScript(installStubs, VALUES);
  const page = await ctx.newPage();
  await page.goto(`${base}/core/demo/stage.html`);

  const emr = page.frame({ url: /mock-emr/ });
  await emr.waitForSelector('[name=b5]');
  await emr.addScriptTag({ url: `${base}/eye-exam-extension/schema.js` });
  await emr.addScriptTag({ url: `${base}/eye-exam-extension/content.js` });
  if (setup) {
    const unmapped = await emr.evaluate(async (keys) => {
      const map = {};
      autoMapVisible(map);
      document.querySelector('[data-tab=refraction]').click();
      await new Promise(r => setTimeout(r, 50));
      autoMapVisible(map);
      document.querySelector('[data-tab=pretest]').click();
      await saveMap(map);
      return keys.filter(k => !map[k]);
    }, Object.keys(VALUES));
    if (unmapped.length) throw new Error('Demo values without a mapped box: ' + unmapped.join(', '));
  }

  await page.evaluate(() => { document.getElementById('panel').src = '../../eye-exam-extension/popup.html'; });
  let panel;
  while (!(panel = page.frames().find(f => /popup\.html/.test(f.url())))) await page.waitForTimeout(50);
  await panel.waitForSelector('#mic-btn');
  await page.waitForTimeout(800);

  // Camera: #cam is scaled/translated; element boxes from Playwright are in screen space, so convert back
  const cam = { s: 1, tx: 0, ty: 0 };
  const toCam = b => ({ x: (b.x - cam.tx) / cam.s, y: (b.y - cam.ty) / cam.s, w: b.width / cam.s, h: b.height / cam.s });
  const boxOf = async (frame, selectors) => {
    const boxes = [];
    for (const sel of [].concat(selectors)) for (const el of await frame.$$(sel)) { const b = await el.boundingBox(); if (b) boxes.push(toCam(b)); }
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
    return { x, y, w: Math.max(...boxes.map(b => b.x + b.w)) - x, h: Math.max(...boxes.map(b => b.y + b.h)) - y };
  };
  const setCam = async (s, tx, ty, wait = 1250) => {
    Object.assign(cam, { s, tx, ty });
    await page.evaluate(([s, tx, ty]) => { document.getElementById('cam').style.transform = `translate(${tx}px, ${ty}px) scale(${s})`; }, [s, tx, ty]);
    await page.waitForTimeout(wait);
  };

  const api = {
    page, emr, panel, base,
    // Zoom so the given elements (in one frame) fill the view, leaving room for the caption at the bottom.
    // The view is kept inside the stage, so a target near an edge sits off-centre rather than showing empty space.
    async zoomTo(frame, selectors, { pad = 40, max = 2.4, wait } = {}) {
      const r = await boxOf(frame, selectors);
      const capH = 110, availH = height - capH;
      const s = Math.min(max, width / (r.w + 2 * pad), availH / (r.h + 2 * pad));
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const tx = clamp(width / 2 - (r.x + r.w / 2) * s, width - width * s, 0);
      const ty = clamp(availH / 2 - (r.y + r.h / 2) * s, height - height * s, 0);
      await setCam(s, tx, ty, wait);
    },
    zoomOut: (wait) => setCam(1, 0, 0, wait),
    async cursorTo(frame, selector, { click = true } = {}) {
      const r = await boxOf(frame, selector);
      await page.evaluate(([x, y]) => { const c = document.getElementById('cursor'); c.style.left = x + 'px'; c.style.top = y + 'px'; },
        [r.x + r.w / 2, r.y + r.h / 2]);
      await page.waitForTimeout(800);
      if (!click) return;
      await page.evaluate(() => { const c = document.getElementById('cursor'); c.classList.remove('down'); void c.offsetWidth; c.classList.add('down'); });
      await frame.click(selector);
    },
    hideCursor: () => page.evaluate(() => { const c = document.getElementById('cursor'); c.style.left = '-60px'; c.style.top = '-60px'; }),
    async caption(html) {
      await page.evaluate(h => {
        const c = document.getElementById('caption');
        if (!h) { c.classList.remove('show'); return; }
        c.classList.remove('show');
        setTimeout(() => { c.innerHTML = h; c.classList.add('show'); }, c.textContent ? 250 : 0);
      }, html || '');
    },
    // Streams the dictation into the side panel word by word, as Chrome's speech recognition would deliver it
    async dictate(text = DICTATION, msPerWord = 85) {
      const words = text.split(' ');
      for (let i = 1; i <= words.length; i++) {
        await page.evaluate(t => window.__toPanel({ action: 'transcriptUpdate', finalTranscript: t, interimTranscript: '' }), words.slice(0, i).join(' '));
        await page.waitForTimeout(msPerWord);
      }
    },
    async close() { await ctx.close(); server.close(); },
  };
  return api;
}

module.exports = { ROOT, DICTATION, VALUES, openStage };
