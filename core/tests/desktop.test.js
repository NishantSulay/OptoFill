// Tests the desktop app (desktop/): the real side panel and content script, run by the Electron shell on the mock EMR,
// with the form inside an iframe (framed.html). Claude's reply is canned; no API calls.
// Usage: (cd desktop && npm install) && node core/tests/desktop.test.js   (needs `playwright`; on Linux without a
// display, run it under xvfb-run)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { _electron: electron } = require('playwright');
const { DICTATION, VALUES } = require('../demo/sample');

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'desktop');
const FRAMED = pathToFileURL(path.join(ROOT, 'core/mock-emr/framed.html')).href;

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? '  → ' + detail : ''}`);
  if (!cond) failures++;
}

async function launch(userData) {
  const app = await electron.launch({
    executablePath: require(path.join(APP, 'node_modules/electron')),
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), '--use-fake-device-for-media-stream', APP, `--url=${FRAMED}`],
    env: { ...process.env, OPTOFILL_USER_DATA: userData },
  });
  const page = async re => {
    for (let i = 0; i < 200; i++) {
      const p = app.windows().find(w => re.test(w.url()));
      if (p) return p;
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error('No window for ' + re + ': ' + app.windows().map(w => w.url()).join(', '));
  };
  const panel = await page(/^optofill:\/\/app\/ext\/popup\.html/);
  const background = await page(/^optofill:\/\/app\/shell\/background\.html/);
  const emr = await page(/mock-emr\/framed\.html/);
  await panel.waitForSelector('#mic-btn');
  let form;
  while (!(form = emr.frames().find(f => /mock-emr\/index\.html/.test(f.url())))) await emr.waitForTimeout(50);
  await form.waitForSelector('[name=b5]');
  return { app, panel, background, emr, form };
}

const statusText = panel => panel.textContent('#emr-setup-text');
async function waitForStatus(panel, re) {
  for (let i = 0; i < 100 && !re.test(await statusText(panel)); i++) await panel.waitForTimeout(50);
  return statusText(panel);
}

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'optofill-desktop-'));
  let { app, panel, background, form } = await launch(userData);
  const errors = [];
  panel.on('pageerror', e => errors.push('panel: ' + e.message));
  background.on('pageerror', e => errors.push('background: ' + e.message));

  // 1. The panel reaches the exam form, which is in an iframe: tabs.query, executeScript in every frame, and
  //    tabs.sendMessage to the frame with the most boxes
  check('panel: sees the EMR, not set up yet', /isn.t set up yet/.test(await waitForStatus(panel, /set up/)), await statusText(panel));
  const frameId = await panel.evaluate(async () => findFormFrame((await chrome.tabs.query({ active: true }))[0].id));
  check('panel: picks the iframe holding the form', frameId > 0, String(frameId));

  // 2. Set up the EMR with auto-map, from the panel, in the content script's world in that frame
  const mapped = await panel.evaluate(async (frameId) => {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: 1, frameIds: [frameId] }, func: async () => {
      const map = {};
      autoMapVisible(map);
      document.querySelector('[data-tab=refraction]').click();
      await new Promise(r => setTimeout(r, 50));
      autoMapVisible(map);
      document.querySelector('[data-tab=pretest]').click();
      await saveMap(map);
      return Object.keys(map);
    } });
    await refreshPageStatus();
    return r.result;
  }, frameId);
  const unmapped = Object.keys(VALUES).filter(k => !mapped.includes(k));
  check('setup: auto-map finds a box for every sample value', mapped.length > 40 && !unmapped.length, `${mapped.length} mapped; missing ${unmapped.join(', ')}`);
  check('setup: the panel shows the saved setup', /exam fields set up/.test(await waitForStatus(panel, /exam fields set up/)), await statusText(panel));
  const onDisk = JSON.parse(fs.readFileSync(path.join(userData, 'optofill-storage.json'), 'utf8'));
  check('setup: saved in the app’s data folder', Object.keys(Object.values(onDisk.optofillMaps || {})[0] || {}).length === mapped.length);

  // 3. Dictate (typed here), read it with Claude (canned in the background page), review, fill
  await background.evaluate((values) => {
    window.fetch = async (url, opts) => {
      window.lastRequest = { url, headers: opts.headers, body: JSON.parse(opts.body) };
      const text = JSON.stringify({ findings: Object.entries(values).map(([key, value]) => ({ key, value })) });
      return new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    };
  }, VALUES);
  await panel.evaluate(() => chrome.storage.local.set({ apiKey: 'sk-ant-test', reviewBeforeFill: true }));
  await panel.fill('#transcript', DICTATION);
  await panel.click('#fill-btn');
  await panel.waitForSelector('#review-area.visible', { timeout: 10000 });
  const req = await background.evaluate(() => window.lastRequest);
  check('extract: the background script calls the Anthropic API', req?.url === 'https://api.anthropic.com/v1/messages' && req.body.model === 'claude-haiku-5-5', JSON.stringify(req?.url));
  check('extract: only the dictation is sent, not the page', req && JSON.stringify(req.body.messages).includes('Amplitude OD 6') && !JSON.stringify(req.body).includes('mock-emr'));
  const rows = await panel.$$eval('#review-list .result-item', els => els.length);
  check(`review: all ${Object.keys(VALUES).length} values are listed`, rows === Object.keys(VALUES).length, String(rows));
  check('review: nothing is filled yet', await form.inputValue('[name=v1]') === '');
  await panel.click('#review-fill');
  await panel.waitForSelector('#results-area.visible');
  const box = name => form.inputValue(`[name=${name}]`);
  check('fill: values land in the iframe’s boxes', await box('v1') === '40' && await box('v3') === '30' && await box('v4') === '-1' && await box('b5') === '6 cm',
    [await box('v1'), await box('v3'), await box('v4'), await box('b5')].join(' | '));
  const filled = await panel.$$eval('#result-list .result-item', els => els.length);
  check('fill: the panel lists what was filled', filled >= Object.keys(VALUES).length - 2, String(filled));

  // 4. Undo
  await panel.click('#undo-btn');
  await panel.waitForTimeout(300);
  check('undo: the boxes are cleared again', await box('v1') === '' && await box('b5') === '', (await box('v1')) + ' | ' + (await box('b5')));

  // 5. Dictation with Chrome's speech says what to do instead of failing silently
  await panel.click('#mic-btn');
  await panel.waitForSelector('#toast.show', { timeout: 5000 }).catch(() => {});
  check('mic: Chrome speech explains it needs Medical speech here', /Medical speech/.test(await panel.textContent('#toast')), await panel.textContent('#toast'));

  // 6. Medical speech: the app asks once for the microphone, the EMR page records (Chromium's fake microphone), the
  //    audio reaches the speech connection in the background page (a stand-in for Deepgram), and the words come back
  await app.evaluate(({ dialog }) => {
    globalThis.micAsked = [];
    dialog.showMessageBox = async (win, opts) => { globalThis.micAsked.push(opts.message); return { response: 0 }; };
  });
  await background.evaluate(() => {
    window.sockets = [];
    window.WebSocket = class {
      constructor(url, protocols) { this.url = url; this.protocols = protocols; this.sent = []; window.sockets.push(this); setTimeout(() => this.onopen?.()); }
      send(data) {
        this.sent.push(data);
        if (typeof data === 'string' && JSON.parse(data).type === 'CloseStream') setTimeout(() => this.onclose?.({ code: 1000 }));
      }
      close() { setTimeout(() => this.onclose?.({ code: 1000 })); }
    };
  });
  await panel.evaluate(() => chrome.storage.local.set({ speechEngine: 'medical', deepgramKey: 'dg-test-key' }));
  await panel.fill('#transcript', '');
  await panel.click('#mic-btn');
  const audioBytes = () => background.evaluate(() => (window.sockets.at(-1)?.sent || []).filter(x => typeof x !== 'string').reduce((n, x) => n + x.byteLength, 0));
  for (let i = 0; i < 60 && await audioBytes() < 1000; i++) await panel.waitForTimeout(100);
  const asked = await app.evaluate(() => globalThis.micAsked);
  check('speech: the app asks once to use the microphone on this EMR', asked.length === 1 && /microphone/.test(asked[0]), JSON.stringify(asked));
  check('speech: the EMR page’s audio reaches the speech connection', await audioBytes() >= 1000, String(await audioBytes()));
  check('speech: the connection uses the medical model and the doctor’s key', await background.evaluate(() => /nova-3-medical/.test(window.sockets.at(-1).url) && window.sockets.at(-1).protocols[1] === 'dg-test-key'));
  await background.evaluate(() => window.sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'IOP 15 OD, 16 OS.' }] } }) }));
  await panel.waitForTimeout(200);
  check('speech: the words show in the panel', /IOP 15 OD, 16 OS/.test(await panel.inputValue('#transcript')), await panel.inputValue('#transcript'));
  await panel.click('#stop-btn');
  for (let i = 0; i < 40 && !(await background.evaluate(() => window.sockets.at(-1).sent.some(x => typeof x === 'string' && x.includes('CloseStream')))); i++) await panel.waitForTimeout(100);
  check('speech: stopping ends the stream', await background.evaluate(() => window.sockets.at(-1).sent.some(x => typeof x === 'string' && x.includes('CloseStream'))));
  check('speech: the permission is remembered', (JSON.parse(fs.readFileSync(path.join(userData, 'desktop-state.json'), 'utf8')).micOrigins || []).length === 1);

  // 7. In-page setup opens in the form's frame
  await panel.click('#setup-btn');
  await form.waitForSelector('#optofill-setup-host', { timeout: 5000 }).catch(() => {});
  check('setup mode: opens on the form', await form.$('#optofill-setup-host') !== null);

  check('no script errors', !errors.length, errors.join(' / '));
  await app.close();

  // 8. A restart keeps the setup and settings
  ({ app, panel } = await launch(userData));
  check('restart: the setup is still there', /exam fields set up/.test(await waitForStatus(panel, /exam fields set up/)), await statusText(panel));
  check('restart: the API key is still there', await panel.inputValue('#api-key-input') === 'sk-ant-test');
  await app.close();

  fs.rmSync(userData, { recursive: true, force: true });
  console.log(failures ? `${failures} check(s) failed` : 'All checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
