// Tests the layout report (buildReport in content.js) and its replay (core/tests/replay.js): a screen rebuilt from
// its report must auto-map exactly as the live screen does — otherwise a report can't stand in for the real EMR —
// and a report must never carry what is typed in the boxes.
// Usage: node core/tests/report.test.js   (needs `playwright`; set CHROME_PATH if no bundled browser)
const fs = require('fs');
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

  // A real EMR's Ocular Health screen in a narrow window (the side panel takes room): rows wrap, so the OS box
  // drops under its OD box and the next label moves up beside it. Labels must come from the page order there.
  const wrapped = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/wrapped-health.json'), 'utf8'));
  const got = (await replay(wrapped, browser)).map;
  const want = {
    sle_lids_od: 0, sle_lids_os: 1, sle_conj_od: 2, sle_conj_os: 3, sle_cornea_od: 4, sle_cornea_os: 5, sle_ac_od: 6, sle_ac_os: 7,
    sle_iris_od: 8, sle_iris_os: 9, sle_lens_od: 10, sle_lens_os: 11, sle_notes: 12,
    fundus_cd_od: 21, fundus_cd_v_od: 23, fundus_cd_os: 25, fundus_cd_v_os: 27, onh_sup_od: 22, onh_inf_os: 28,
    onh_rim_od: 29, onh_rim_os: 30, onh_color_od: 31, onh_color_os: 32, onh_margin_od: 33, onh_margin_os: 34, onh_depth_od: 35, onh_depth_os: 36,
    fundus_nerve_od: 37, fundus_nerve_os: 38, iop_od: 41, iop_os: 42, iop_method: 43, pach_od: 48, pach_os: 49,
    fundus_macula_od: 55, fundus_general_os: 58, fundus_vessels_od: 59, fundus_crossing_od: 61, fundus_crossing_os: 62, fundus_periphery_os: 66, fundus_notes: 67,
  };
  const wrong = Object.entries(want).filter(([k, i]) => got[k] !== i).map(([k, i]) => `${k}: got box ${got[k] ?? 'none'}, want ${i}`);
  check(`wrapped rows (real EMR layout): ${Object.keys(want).length - wrong.length}/${Object.keys(want).length} boxes mapped by page order`, !wrong.length, wrong.join('; '));
  const stray = Object.entries(got).filter(([, i]) => [20, 39, 40, 44, 45].includes(i)).map(([k, i]) => `${k}→${i}`);
  check('wrapped rows: note boxes and the IOP 2 row are left alone', !stray.length, stray.join(', '));

  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
