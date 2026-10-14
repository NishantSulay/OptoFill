// Records the website demo GIF: the real popup (popup.html/popup.js) and content script (content.js) filling the
// mock EMR (synthetic data). Chrome extension APIs are stubbed so both run in ordinary frames; the only canned
// step is Claude's reply, which is replaced by the values the extraction eval expects for this dictation.
// Usage: node core/demo/record.js   (needs `playwright` and `ffmpeg`; writes assets/optofill-demo.gif, .mp4 and -poster.jpg)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'assets/optofill-demo.gif');
const W = 1440, H = 810;

const DICTATION = 'Distance vision without glasses, right eye 20/40, left 20/30. Pupils PERRLA, no APD. ' +
  'Cover test ortho at distance, 2 prism diopters exophoria at near. Amplitude OD 6 centimeters, OS 5 centimeters. NPC 8 cm. ' +
  'PD 64 distance, 61 near. Color normal both eyes on Ishihara. Stereo 40 seconds with Randot.';
// What the extraction step returns for this dictation (schema keys → values)
const VALUES = {
  va_dist_sc_od: '20/40', va_dist_sc_os: '20/30', pupils_notes: 'PERRLA, no APD',
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
    window.chrome = { runtime: { onMessage: { addListener: f => window.__listeners.push(f) }, sendMessage() {} }, storage };
    return;
  }
  if (!location.pathname.endsWith('/popup.html')) return;

  const emr = () => top.document.getElementById('emr').contentWindow;
  const portListeners = [];
  top.__toPopup = msg => portListeners.forEach(f => f(msg));
  const port = {
    onMessage: { addListener: f => portListeners.push(f) },
    onDisconnect: { addListener() {} },
    postMessage(msg) {
      if (msg.action === 'startRecording') setTimeout(() => top.__toPopup({ action: 'micStarted' }), 150);
      if (msg.action === 'extract') setTimeout(() => top.__toPopup({ action: 'extractResult', ok: true, values }), 1400);
    },
  };
  window.chrome = {
    runtime: { connect: () => port, onMessage: { addListener() {} }, sendMessage() {} },
    storage,
    tabs: {
      query: async () => [{ id: 1, url: 'https://your-emr.example.com/exam' }],
      sendMessage: (tabId, msg) => new Promise(res => emr().__listeners.forEach(l => l(msg, {}, res))),
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
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'optofill-demo-'));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: videoDir, size: { width: W, height: H } } });
  await ctx.addInitScript(installStubs, VALUES);
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(`${base}/core/demo/stage.html`);

  // Mock EMR, set up once (auto-map both tabs) the way a doctor would before the first fill
  const emr = page.frame({ url: /mock-emr/ });
  await emr.waitForSelector('[name=b5]');
  await emr.addScriptTag({ url: `${base}/eye-exam-extension/schema.js` });
  await emr.addScriptTag({ url: `${base}/eye-exam-extension/content.js` });
  const manual = { pupils_notes: 'pn', color_od: 'cv1' };
  const unmapped = await emr.evaluate(async ([keys, manual]) => {
    const map = {};
    autoMapVisible(map);
    document.querySelector('[data-tab=refraction]').click();
    await new Promise(r => setTimeout(r, 50));
    autoMapVisible(map);
    document.querySelector('[data-tab=pretest]').click();
    await new Promise(r => setTimeout(r, 50));
    // Boxes auto-map doesn't suggest, mapped by clicking them in setup like a doctor would
    const fields = getAllFields(true);
    for (const [key, name] of Object.entries(manual)) {
      const f = fields.find(x => x.name === name);
      map[key] = mappingEntry(lastScannedEls[f.index], f);
    }
    await saveMap(map);
    return keys.filter(k => !map[k]);
  }, [Object.keys(VALUES), manual]);
  if (unmapped.length) throw new Error('Demo values without a mapped box: ' + unmapped.join(', '));

  await page.evaluate(() => { document.getElementById('popup').src = '../../eye-exam-extension/popup.html'; });
  let pop;
  while (!(pop = page.frames().find(f => /popup\.html/.test(f.url())))) await page.waitForTimeout(50);
  await pop.waitForSelector('#mic-btn');
  await page.waitForTimeout(1200);
  const introMs = Date.now() - t0;   // trimmed from the GIF: blank loading frames

  const cursor = async (frame, selector, click = true) => {
    const box = await (await frame.$(selector)).boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.evaluate(([x, y]) => { const c = document.getElementById('cursor'); c.style.left = x + 'px'; c.style.top = y + 'px'; }, [x, y]);
    await page.waitForTimeout(650);
    if (!click) return;
    await page.evaluate(() => { const c = document.getElementById('cursor'); c.classList.remove('down'); void c.offsetWidth; c.classList.add('down'); });
    await page.mouse.click(x, y);
  };

  await page.waitForTimeout(600);
  await cursor(pop, '#mic-btn');
  await page.waitForTimeout(500);
  // Dictation streams in word by word, as Chrome's speech recognition would deliver it
  const words = DICTATION.split(' ');
  for (let i = 1; i <= words.length; i++) {
    const text = words.slice(0, i).join(' ');
    await page.evaluate(t => window.__toPopup({ action: 'transcriptUpdate', finalTranscript: t, interimTranscript: '' }), text);
    await page.waitForTimeout(110);
  }
  await page.waitForTimeout(700);
  await cursor(pop, '#stop-btn');
  await page.waitForTimeout(900);
  await cursor(pop, '#fill-btn');
  await page.waitForTimeout(3800);           // Claude's reply, then the fill and its check
  await cursor(pop, '.result-item:nth-child(3)'); // a result row shows which box it filled
  await page.waitForTimeout(2600);
  await page.evaluate(() => { document.getElementById('cursor').style.left = '-40px'; });
  await page.waitForTimeout(1500);

  const video = await page.video().path();
  await ctx.close(); await browser.close(); server.close();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const start = (introMs / 1000).toFixed(2);
  const filters = 'fps=12,scale=1080:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', start, '-i', video, '-vf', filters, '-loop', '0', OUT]);
  // MP4 alongside: a fraction of the GIF's size, better for the website
  const MP4 = OUT.replace(/\.gif$/, '.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', start, '-i', video, '-vf', 'scale=1080:-2', '-c:v', 'libx264',
    '-crf', '26', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', MP4]);
  // Poster for the website video: the finished fill
  const POSTER = OUT.replace(/\.gif$/, '-poster.jpg');
  const dur = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', MP4]).toString());
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, dur - 3.5)), '-i', MP4, '-frames:v', '1', '-q:v', '4', POSTER]);
  for (const f of [OUT, MP4, POSTER]) console.log(`Wrote ${path.relative(ROOT, f)} (${(fs.statSync(f).size / 1e6).toFixed(1)} MB)`);
})().catch(e => { console.error(e); process.exit(1); });
