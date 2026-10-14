// Records the website demo video: a fill on the mock EMR (synthetic data) with OptoFill in the side panel, with
// zooms onto the panel and the filled boxes and step captions. Frames come straight from Chrome (screencast at 2×
// resolution), so the 1080p output stays sharp. Claude's reply is canned (see lib.js).
// Usage: node core/demo/record.js   (needs `playwright` and `ffmpeg`; writes assets/optofill-demo.mp4, .gif, -poster.jpg)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { ROOT, openStage } = require('./lib');

const W = 1600, H = 900;
const OUT = path.join(ROOT, 'assets/optofill-demo');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const st = await openStage(browser, { width: W, height: H, scale: 2 });
  const { page, emr, panel } = st;

  // Capture every frame Chrome paints (only changes are sent; each frame lasts until the next)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optofill-frames-'));
  const frames = [];
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    const file = path.join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, t: metadata.timestamp });
    await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  const wait = ms => page.waitForTimeout(ms);

  await st.caption('OptoFill runs in Chrome’s side panel, next to your EMR');
  await wait(2600);

  await st.zoomTo(panel, ['.header', '#mic-btn', '#transcript', '#fill-btn'], { pad: 30, max: 2 });
  await st.caption('<b>1</b>Dictate your findings');
  await st.cursorTo(panel, '#mic-btn');
  await wait(400);
  await st.dictate();
  await wait(600);
  await st.cursorTo(panel, '#stop-btn');
  await wait(700);

  await st.caption('<b>2</b>Claude turns the dictation into exam values');
  await st.cursorTo(panel, '#fill-btn');
  await wait(900);
  await st.hideCursor();
  await st.zoomOut(900);                                 // the boxes fill while we pull back
  await st.caption('<b>3</b>Every box is filled — and read back to check it took');
  await wait(2200);
  await page.screenshot({ path: path.join(dir, 'poster.png') });   // the filled form, for the video's poster

  await st.zoomTo(emr, ['[name=v1]', '[name=c8]', '[name=b11]', '[name=d6]', '[name=s2]', '[name=pn]'], { pad: 24, max: 1.6 });
  await wait(2600);

  await st.zoomTo(panel, ['#results-area', '.status-bar'], { pad: 24, max: 1.9 });
  await st.caption('Each result is checked ✓ — click one to find its box');
  await wait(1800);
  await st.zoomOut(700);
  await st.cursorTo(panel, '.result-item:nth-child(3)');
  await wait(2000);

  await st.caption('Not right? One click undoes the whole fill');
  await st.cursorTo(panel, '#undo-btn');
  await wait(2200);
  await st.hideCursor();
  await st.caption('Dictate the exam. <b style="margin:0 0 0 6px">OptoFill fills the form.</b>');
  await wait(2600);

  await cdp.send('Page.stopScreencast');
  await st.close(); await browser.close();

  // Frames → constant 30 fps video; each frame is shown until the next one arrived
  const list = frames.map((f, i) => `file '${f.file}'\nduration ${((frames[i + 1]?.t ?? f.t + 1) - f.t).toFixed(4)}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
  fs.writeFileSync(path.join(dir, 'list.txt'), list);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const ff = args => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
  ff(['-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-movflags', '+faststart', '-an', `${OUT}.mp4`]);
  // Smaller GIF (for places that can't play video)
  ff(['-i', `${OUT}.mp4`, '-vf', 'fps=8,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', `${OUT}.gif`]);
  ff(['-i', path.join(dir, 'poster.png'), '-vf', 'scale=1920:-1:flags=lanczos', '-q:v', '3', `${OUT}-poster.jpg`]);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const ext of ['.mp4', '.gif', '-poster.jpg']) console.log(`Wrote assets/optofill-demo${ext} (${(fs.statSync(OUT + ext).size / 1e6).toFixed(1)} MB)`);
})().catch(e => { console.error(e); process.exit(1); });
