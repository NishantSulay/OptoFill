// Tests the medical speech engine without a speech account: the session logic (speech.js) and the background worker's
// handling of it against a stand-in WebSocket, and the page's audio recording with Chrome's fake microphone.
// Usage: node core/tests/speech.test.js   (needs `playwright`; set CHROME_PATH if no bundled browser)
const path = require('path');
const EXT = path.resolve(__dirname, '../../eye-exam-extension');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? '  → ' + detail : ''}`);
  if (!cond) failures++;
}
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// Stand-in for the speech service's WebSocket
class FakeSocket {
  static all = [];
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.sent = []; this.closed = false; FakeSocket.all.push(this); }
  send(data) { this.sent.push(data); }
  close() { if (this.closed) return; this.closed = true; setTimeout(() => this.onclose && this.onclose({ code: 1000 })); }
  open() { this.onopen && this.onopen(); }
  results(transcript, is_final) { this.onmessage({ data: JSON.stringify({ type: 'Results', is_final, channel: { alternatives: [{ transcript }] } }) }); }
  fail() { this.closed = true; this.onclose && this.onclose({ code: 1006 }); }
  get audio() { return this.sent.filter(x => typeof x !== 'string'); }
  get control() { return this.sent.filter(x => typeof x === 'string').map(x => JSON.parse(x).type); }
}
const last = () => FakeSocket.all[FakeSocket.all.length - 1];

async function sessionTests() {
  const { startSession, keyterms, listenUrl, TERMS, MAX_TERMS } = require(path.join(EXT, 'speech.js'));

  check('terms: the built-in list fits the limit, with no repeats', TERMS.length <= MAX_TERMS && new Set(TERMS.map(t => t.toLowerCase())).size === TERMS.length, String(TERMS.length));
  const terms = keyterms(['Xiidra', 'PERRLA', '  ', 'x'.repeat(50)]);
  check("terms: the doctor's own words come first, without repeats or junk", terms[0] === 'Xiidra' && terms[1] === 'PERRLA' && terms.filter(t => t === 'PERRLA').length === 1 && terms.length <= MAX_TERMS, terms.slice(0, 4).join(', '));
  const url = listenUrl(['C/D', 'Van Herick']);
  check('request: medical model, live results, terms encoded', /^wss:\/\/api\.deepgram\.com\/v1\/listen\?model=nova-3-medical&interim_results=true&smart_format=true&keyterm=C%2FD&keyterm=Van%20Herick$/.test(url), url);

  const log = [];
  const s = startSession({ apiKey: 'dg-test-key', existing: 'Pupils PERRLA.', WebSocketImpl: FakeSocket, finishTimeoutMs: 50,
    onStart: () => log.push('start'), onUpdate: (f, i) => log.push(`${f}|${i}`), onError: e => log.push('error:' + e), onEnd: f => log.push('end:' + f) });
  const ws = last();
  check('request: the key is not in the address', !ws.url.includes('dg-test-key') && ws.protocols.join(',') === 'token,dg-test-key', ws.url.slice(0, 60));
  s.sendAudio(new Uint8Array([1]));
  check('audio recorded before the connection opens is kept back', ws.sent.length === 0);
  ws.open();
  s.sendAudio(new Uint8Array([2]));
  check('…and sent in order once it opens', log[0] === 'start' && ws.audio.length === 2 && ws.audio[0][0] === 1 && ws.audio[1][0] === 2);
  ws.results('distance vision', false);
  ws.results('Distance vision 20/40 OD.', true);
  ws.results('', true);
  check('words: added to the existing dictation, interim words kept apart',
        log[1] === 'Pupils PERRLA. |distance vision' && log[2] === 'Pupils PERRLA. Distance vision 20/40 OD. |' && log[3] === log[2], log.slice(1).join(' / '));
  s.finish();
  s.sendAudio(new Uint8Array([3]));
  check('stop: the service is told to finish, and no more audio is sent', ws.control.join() === 'CloseStream' && ws.audio.length === 2);
  ws.results('IOP 16.', true);
  ws.close();
  await tick(5);
  check('stop: the last words still arrive before the end', log[log.length - 1] === 'end:Pupils PERRLA. Distance vision 20/40 OD. IOP 16. ', log.slice(-2).join(' / '));

  const log2 = [];
  const s2 = startSession({ apiKey: 'k', WebSocketImpl: FakeSocket, onUpdate: f => log2.push(f), onEnd: () => log2.push('end'), onError: () => log2.push('error') });
  last().open();
  s2.discard();
  last().results('late words', true);
  await tick(5);
  check('clear: words still in flight never come back', log2.length === 0, log2.join(' / '));

  const log3 = [];
  startSession({ apiKey: 'bad', WebSocketImpl: FakeSocket, onStart: () => log3.push('start'), onError: e => log3.push(e) });
  last().fail();
  check('a refused connection is reported as a key problem', log3.length === 1 && /check the Deepgram key/.test(log3[0]), log3.join(' / '));

  const log4 = [];
  const s4 = startSession({ apiKey: 'k', WebSocketImpl: FakeSocket, finishTimeoutMs: 20, onEnd: f => log4.push('end:' + f) });
  last().open();
  last().results('Lids clear.', true);
  last().close = () => {};           // a service that never closes
  s4.finish();
  await tick(60);
  check('stop: a service that never answers does not leave the dictation hanging', log4.join() === 'end:Lids clear. ', log4.join(' / '));
}

// background.js with stand-ins for Chrome's APIs: the side panel's port, the page, saved settings
async function backgroundTests() {
  const toPanel = [], toPage = [];
  let panelMsg, audioConnect, runtimeMsg;
  const settings = { speechEngine: 'medical', deepgramKey: 'dg-test-key', wordFixes: 'zy dra = Xiidra' };
  globalThis.WebSocket = FakeSocket;
  globalThis.importScripts = (...files) => files.forEach(f => require(path.join(EXT, f)));
  globalThis.chrome = {
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: {
      onConnect: { addListener(f) { if (!panelMsg) f({ name: 'popup', onDisconnect: { addListener() {} }, onMessage: { addListener(h) { panelMsg = h; } }, postMessage: m => toPanel.push(m) }); else audioConnect = f; } },
      onMessage: { addListener(f) { runtimeMsg = f; } },
    },
    storage: { local: { get: async () => ({ ...settings }) } },
    tabs: { query: async () => [{ id: 7, url: 'https://emr.example.com/exam' }], sendMessage: async (tabId, msg) => { toPage.push(msg); } },
    scripting: { executeScript: async () => [] },
  };
  require(path.join(EXT, 'background.js'));
  const pageAudio = () => { let h; audioConnect({ name: 'optofill-audio', onMessage: { addListener(f) { h = f; } } }); return h; };
  const b64 = bytes => Buffer.from(bytes).toString('base64');
  const actions = list => list.map(m => m.action).join(',');
  FakeSocket.all.length = 0;

  // A dictation from start to stop
  await panelMsg({ action: 'startRecording', existingTranscript: 'Lids clear.' });
  check('start: the page is asked to record only, not to run Chrome’s recognition', actions(toPage) === 'startAudioCapture', actions(toPage));
  const ws = last();
  check("start: the doctor's own words are sent as key terms", ws.url.includes('keyterm=Xiidra&keyterm=OD'), ws.url.slice(0, 120));
  const audio = pageAudio();
  ws.open();
  audio({ audio: b64([9, 8, 7]) });
  check('audio from the page reaches the service as bytes', ws.audio.length === 1 && [...ws.audio[0]].join() === '9,8,7', JSON.stringify(ws.audio));
  ws.results('IOP 16 OD.', true);
  check('words reach the side panel', toPanel[0].action === 'micStarted' && toPanel[0].engine === 'medical' && toPanel[1].finalTranscript === 'Lids clear. IOP 16 OD. ', JSON.stringify(toPanel));
  await panelMsg({ action: 'stopRecording' });
  check('stop: the page stops recording', actions(toPage) === 'startAudioCapture,stopAudioCapture');
  audio({ end: true });
  ws.close();
  await tick(5);
  check('stop: the side panel hears it ended, after the last words', toPanel[toPanel.length - 1].action === 'micStopped' && ws.control.join() === 'CloseStream', actions(toPanel));

  // The service can't be reached: carry on with Chrome's recognition, keeping what was said
  toPanel.length = toPage.length = 0;
  await panelMsg({ action: 'startRecording', existingTranscript: 'Lids clear.' });
  last().fail();
  await tick(5);
  const restart = toPage.find(m => m.action === 'startRecording');
  check('no connection: the side panel is told, and Chrome’s recognition takes over with the dictation so far',
        toPanel.some(m => m.action === 'speechFallback') && restart && restart.existingTranscript === 'Lids clear.' && toPage.some(m => m.action === 'stopAudioCapture' && m.discard), actions(toPage) + ' | ' + actions(toPanel));

  // Clear in the middle of a dictation
  toPanel.length = toPage.length = 0;
  await panelMsg({ action: 'startRecording', existingTranscript: '' });
  const ws3 = last(), audio3 = pageAudio();
  ws3.open();
  await panelMsg({ action: 'clearRecording' });
  ws3.results('late words', true);
  audio3({ audio: b64([1]) });
  await tick(5);
  check('clear: recording is thrown away and late words are dropped',
        toPage.some(m => m.action === 'stopAudioCapture' && m.discard) && !toPanel.some(m => m.action === 'transcriptUpdate') && ws3.audio.length === 0, actions(toPanel));

  // Microphone blocked on the page
  toPanel.length = 0;
  await panelMsg({ action: 'startRecording', existingTranscript: '' });
  runtimeMsg({ action: 'audioError', error: 'not-allowed' });
  check('blocked microphone: reported, and the connection is dropped', toPanel.some(m => m.action === 'micError' && /blocked/.test(m.error)) && last().closed);

  // Chrome engine: nothing changes
  toPage.length = 0;
  settings.speechEngine = 'chrome';
  const before = FakeSocket.all.length;
  await panelMsg({ action: 'startRecording', existingTranscript: 'x' });
  check('Chrome engine: the page runs recognition as before, and nothing is sent to the speech service', actions(toPage) === 'startRecording' && FakeSocket.all.length === before, actions(toPage));
  settings.speechEngine = 'medical'; settings.deepgramKey = '';
  toPage.length = 0;
  await panelMsg({ action: 'startRecording', existingTranscript: 'x' });
  check('medical engine without a key: Chrome’s recognition is used', actions(toPage) === 'startRecording' && FakeSocket.all.length === before, actions(toPage));
}

// The page's recording, with Chrome's fake microphone
async function captureTests() {
  const { chromium } = require('playwright');
  const { serve } = require('../demo/lib');
  const server = await serve();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__posted = []; window.__errors = [];
    window.chrome = {
      runtime: { onMessage: { addListener() {} }, sendMessage: m => { window.__errors.push(m); }, connect: () => ({ postMessage: m => window.__posted.push(m), disconnect() { window.__posted.push({ disconnected: true }); } }) },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/core/mock-emr/index.html`);
  await page.addScriptTag({ path: path.join(EXT, 'schema.js') });
  await page.addScriptTag({ path: path.join(EXT, 'content.js') });

  await page.evaluate(() => startAudioCapture());
  await page.waitForFunction(() => window.__posted.filter(m => m.audio).length >= 3, null, { timeout: 10000 });
  await page.evaluate(() => stopAudioCapture());
  await page.waitForFunction(() => window.__posted.some(m => m.end), null, { timeout: 5000 });
  const posted = await page.evaluate(() => window.__posted.map(m => (m.audio ? 'audio:' + atob(m.audio).length : Object.keys(m)[0])));
  check('recording: audio goes out in pieces, then "end" last', posted.length >= 4 && posted.slice(0, -1).every(p => /^audio:[1-9]/.test(p)) && posted[posted.length - 1] === 'end', posted.join(', '));
  const webm = await page.evaluate(() => { const b = atob(window.__posted[0].audio); return [0, 1, 2, 3].map(i => b.charCodeAt(i).toString(16)).join(''); });
  check('recording: the first piece starts a WebM file, which the service can read without settings', webm === '1a45dfa3', webm);

  await page.evaluate(() => { window.__posted.length = 0; return startAudioCapture(); });
  await page.waitForFunction(() => window.__posted.some(m => m.audio), null, { timeout: 10000 });
  await page.evaluate(() => { stopAudioCapture(true); window.__posted.length = 0; });
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.__posted.map(m => Object.keys(m)[0]));
  check('clear: nothing more is sent after the recording is thrown away', after.every(k => k === 'disconnected'), after.join(', '));
  const live = await page.evaluate(() => typeof capture);
  check('the microphone is released', live === 'object' && await page.evaluate(() => capture === null));

  await browser.close();
  server.close();
}

(async () => {
  await sessionTests();
  await backgroundTests();
  await captureTests();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
