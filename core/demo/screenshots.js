// Renders the Chrome Web Store screenshots (1280×800) into store-assets/: the real side panel and fill on the mock
// EMR (synthetic data), plus a privacy slide. Claude's reply is canned (see lib.js).
// Usage: node core/demo/screenshots.js   (needs `playwright` and `ffmpeg`)
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { ROOT, openStage } = require('./lib');

const OUT = path.join(ROOT, 'store-assets');
// Rendered at 1600×1000 (the stage needs the room) and 1.6× density, then scaled to the store's 1280×800
const W = 1600, H = 1000, DPR = 1.6;
const save = async (page, name) => {
  const tmp = path.join(OUT, `.${name}.png`);
  await page.screenshot({ path: tmp });
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-vf', 'scale=1280:800:flags=lanczos', path.join(OUT, `${name}.png`)]);
  require('fs').rmSync(tmp);
  console.log(`Wrote store-assets/${name}.png`);
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

  // 1. Dictating, with OptoFill open in the side panel
  let st = await openStage(browser, { width: W, height: H, scale: DPR });
  await st.caption('Dictate your findings — OptoFill listens in Chrome’s side panel');
  await st.panel.click('#mic-btn');
  await st.dictate(undefined, 0);
  await st.page.waitForTimeout(900);
  await save(st.page, 'screenshot-1');

  // 2. Filled and checked
  await st.panel.click('#stop-btn');
  await st.panel.click('#fill-btn');
  await st.page.waitForTimeout(2800);
  await st.caption('Every box filled from your dictation — and read back to check');
  await st.page.waitForTimeout(3200);                 // let the success message fade
  await save(st.page, 'screenshot-2');
  await st.close();

  // 3. Setting up the EMR once, with auto-map's suggestions shown on the boxes
  st = await openStage(browser, { width: W, height: H, scale: DPR });
  await st.emr.evaluate(() => startSetup());
  await st.page.waitForTimeout(1500);
  await st.caption('Set up each EMR once — auto-map suggests what every box is');
  await st.page.waitForTimeout(800);
  await save(st.page, 'screenshot-3');
  await st.close();

  // 4. Privacy
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  await page.goto('file://' + path.join(__dirname, 'privacy-card.html'));
  await save(page, 'screenshot-4');

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
