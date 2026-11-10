// Tests the layout report (buildReport in content.js) and its replay (core/tests/replay.js): a screen rebuilt from
// its report must auto-map exactly as the live screen does — otherwise a report can't stand in for the real EMR —
// and a report must never carry what is typed in the boxes.
// Usage: node core/tests/report.test.js   (needs `playwright`; set CHROME_PATH if no bundled browser)
const path = require('path');
const { chromium } = require('playwright');
const { replay, savedMap } = require('./replay');

const ROOT = path.resolve(__dirname, '../..');
let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? '  → ' + detail : ''}`);
  if (!cond) failures++;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.addInitScript(() => {
    const store = {};
    window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage() {} },
      storage: { local: { get: async () => ({ ...store }), set: async o => { Object.assign(store, JSON.parse(JSON.stringify(o))); } } } };
  });
  await page.goto('file://' + path.join(ROOT, 'core/mock-emr/index.html'));
  await page.addScriptTag({ path: path.join(ROOT, 'eye-exam-extension/schema.js') });
  await page.addScriptTag({ path: path.join(ROOT, 'eye-exam-extension/content.js') });

  for (const tab of ['pretest', 'refraction', 'contacts', 'health', 'plan']) {
    await page.click(`[data-tab=${tab}]`);
    await page.waitForTimeout(50);
    // Type something first: a report must not pick it up
    await page.evaluate(() => { const el = document.querySelector('.screen.on input[type=text], .screen.on textarea'); el.value = 'SECRET-VALUE-123'; });
    const { live, report } = await page.evaluate(async () => {
      const map = {};
      autoMapVisible(map);
      const fields = getAllFields(true);
      const live = Object.fromEntries(Object.entries(map).map(([k, e]) => [k, fields.find(f => lastScannedEls[f.index] === locateMapped(e, fields)).index]));
      await saveMap(map);
      return { live, report: await buildReport() };
    });
    const out = await replay(JSON.parse(JSON.stringify(report)), browser);
    const keys = [...new Set([...Object.keys(live), ...Object.keys(out.map)])];
    const name = i => (report.fields[i] ? report.fields[i].name : 'none');
    const diff = keys.filter(k => live[k] !== out.map[k]).map(k => `${k}: live ${name(live[k])}, replay ${name(out.map[k])}`);
    check(`${tab}: rebuilt from its report, all ${Object.keys(live).length} boxes map as on the live screen`, !diff.length, diff.join('; '));
    const saved = savedMap(report);
    const lost = Object.keys(live).filter(k => saved[k] !== live[k]);
    check(`${tab}: the report carries the saved setup`, !lost.length, lost.join(', '));
    check(`${tab}: the report has no typed values`, !JSON.stringify(report).includes('SECRET-VALUE-123'));
    await page.evaluate(() => { document.querySelectorAll('.screen.on input[type=text], .screen.on textarea').forEach(el => { el.value = ''; }); });
  }

  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
