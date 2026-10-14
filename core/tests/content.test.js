// Runs the extension's content script against the mock EMR (fake data) in headless Chromium.
// Usage: node core/tests/content.test.js   (needs the `playwright` package)
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const EXT = path.join(ROOT, 'eye-exam-extension');
const MOCK = 'file://' + path.join(ROOT, 'core/mock-emr/index.html');
const OUT = process.env.OUT_DIR || __dirname;

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? '  → ' + detail : ''}`);
  if (!cond) failures++;
}

async function openMock(browser, query = '') {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.addInitScript(() => {
    const store = {};
    window.chrome = {
      runtime: { onMessage: { addListener() {} }, sendMessage(m) { (window.__sent = window.__sent || []).push(m); } },
      storage: { local: {
        get: async k => (typeof k === 'string' ? { [k]: store[k] } : { ...store }),
        set: async o => { Object.assign(store, JSON.parse(JSON.stringify(o))); }
      } }
    };
  });
  await page.goto(MOCK + query);
  await page.addScriptTag({ path: path.join(EXT, 'schema.js') });
  await page.addScriptTag({ path: path.join(EXT, 'content.js') });
  return page;
}

const val = (page, name) => page.$eval(`[name="${name}"]`, el => el.value);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

  // 1. Auto-map both EMR screens
  const page = await openMock(browser);
  const mapped = await page.evaluate(async () => {
    const map = {};
    autoMapVisible(map);
    document.querySelector('[data-tab=refraction]').click();
    await new Promise(r => setTimeout(r, 50));
    autoMapVisible(map);
    document.querySelector('[data-tab=pretest]').click();
    await saveMap(map);
    return Object.fromEntries(Object.entries(map).map(([k, e]) => [k, e.name]));
  });
  const expect = {
    bv_amplitude_od: 'b5', bv_amplitude_os: 'b6', bv_cfields_os: 'b8', bv_eoms_od: 'b9', bv_npc: 'b11', bv_pursuits: 'b12',
    bv_pfv_dist: 'b1', bv_nfv_dist: 'b2', bv_pfv_near: 'b3', bv_nfv_near: 'b4',
    va_dist_sc_od: 'v1', va_dist_sc_os: 'v3', va_dist_sc_ou: 'v5', va_dist_cc_od: 'v7', va_dist_cc_os: 'v9', va_near_sc_od: 'v13', va_near_sc_os: 'v15',
    pupils_light_od: 'p1', pupils_apd_os: 'p10', cover_dist_eye: 'c1', cover_dist_amount: 'c4', cover_near_direction: 'c7',
    pd_dist_od: 'd1', pd_dist_ou: 'd3', pd_near_os: 'd5', color_os: 'cv2', color_method: 'cv3', stereo: 's1', stereo_method: 's2',
    rx_sph_od: 'r1', rx_cyl_os: 'r7', rx_axis_os: 'r8', rx_add_od: 'r4', iop_od: 't1', iop_os: 't2',
  };
  const wrong = Object.entries(expect).filter(([k, n]) => mapped[k] !== n).map(([k, n]) => `${k}: got ${mapped[k] || 'none'}, want ${n}`);
  check(`auto-map: ${Object.keys(expect).length - wrong.length}/${Object.keys(expect).length} key boxes mapped correctly`, !wrong.length, wrong.join('; '));
  const stray = Object.entries(mapped).filter(([, n]) => ['n1', 'v8'].includes(n));
  check('auto-map: top note box and second VA box are left for the doctor to map', !stray.length, JSON.stringify(stray));
  const cover_vertical = Object.entries(mapped).filter(([, n]) => ['c9', 'c10', 'c11', 'c12'].includes(n));
  check('auto-map: Vertical Dx row is not mistaken for distance cover test', !cover_vertical.length, JSON.stringify(cover_vertical));

  // 2. Fill schema values on the Pretest screen
  const results = await page.evaluate(() => fillSchema({
    bv_amplitude_od: '5 cm', va_dist_sc_os: '20/200', rx_sph_od: '-1.25', notes_general: 'patient reports glare'
  }));
  const st = Object.fromEntries(results.map(r => [r.key, r.status]));
  check('fill: Amplitude OD box gets "5 cm"', (await val(page, 'b5')) === '5 cm' && st.bv_amplitude_od === 'filled');
  check('fill: "20/" prefix stripped for VA box (OS:20/ → "200")', (await val(page, 'v3')) === '200' && st.va_dist_sc_os === 'filled');
  check('fill: Pupils Notes untouched', (await val(page, 'pn')) === '');
  check('fill: refraction value waits for its tab', st.rx_sph_od === 'pending', st.rx_sph_od);
  check('fill: value with no box reported as not set up', st.notes_general === 'unmapped', st.notes_general);

  // 3. Switching to the Refraction tab fills the pending value
  await page.click('[data-tab=refraction]');
  await page.waitForTimeout(1200);
  check('tab switch: pending sphere fills when Refraction tab opens', (await val(page, 'r1')) === '-1.25');
  const after = await page.evaluate(() => ({
    sph: lastFill.find(r => r.key === 'rx_sph_od')?.status,
    sent: (window.__sent || []).filter(m => m.action === 'fillUpdated').pop()?.results.find(r => r.key === 'rx_sph_od')?.status,
  }));
  check('tab switch: last fill results now show the sphere as filled, and an open popup is told', after.sph === 'filled' && after.sent === 'filled', JSON.stringify(after));

  // 4. Undo restores everything from that fill, including the tab-switch part
  const restored = await page.evaluate(() => undoLastFill());
  check(`undo: restored ${restored} boxes`, restored === 3 && (await val(page, 'b5')) === '' && (await val(page, 'v3')) === '' && (await val(page, 'r1')) === '');
  check('undo: last fill results are cleared', await page.evaluate(() => lastFill === null));

  // 5. Duplicate ids: two textareas share id="notes"; only the visible one may be filled
  await page.click('[data-tab=pretest]');
  const dup = await page.evaluate(async () => {
    const fields = getAllFields(true);
    const f = fields.find(x => x.name === 'pn');
    const res = await fillByIndex({ [f.index]: 'PERRLA' });
    return { selector: f.selector, ok: res[0].ok };
  });
  check('duplicate id: selector does not use the shared #notes id', !dup.selector.includes('#notes'), dup.selector);
  check('duplicate id: visible Pupils Notes filled, hidden Refraction Notes untouched',
        dup.ok && (await val(page, 'pn')) === 'PERRLA' && (await val(page, 'rn')) === '');

  // 6. Setup screen renders and suggests the right key for the Amplitude OD box
  await page.evaluate(() => startSetup());
  await page.waitForTimeout(300);
  await page.click('[name=b5]');
  await page.waitForTimeout(200);
  const pick = await page.evaluate(() => ({
    open: !setup.root.querySelector('.picker').hidden,
    first: setup.root.querySelector('.opt')?.textContent,
    where: setup.root.querySelector('.where').textContent,
    focusedPage: document.activeElement?.name || ''
  }));
  check('setup: clicking a box opens the picker (and does not type into the EMR)', pick.open && pick.focusedPage !== 'b5', JSON.stringify(pick));
  check('setup: top suggestion for Amplitude/OD box', /accommodation amplitude OD/i.test(pick.first || ''), pick.first);
  await page.screenshot({ path: path.join(OUT, 'setup-mode.png') });
  await page.keyboard.press('Escape');
  page.once('dialog', d => d.accept());
  await page.click('.reset');
  await page.waitForTimeout(200);
  const afterReset = await page.evaluate(async () => Object.keys(await loadMap()).length);
  check('setup: Clear all removes every saved mapping for the site', afterReset === 0, String(afterReset));
  await page.evaluate(() => stopSetup());

  // 7. A page that wipes script-set values is reported, not counted as filled
  const page2 = await openMock(browser, '?revert=1');
  const revert = await page2.evaluate(async () => {
    const map = {}; autoMapVisible(map); await saveMap(map);
    return fillSchema({ bv_npc: '6 cm' });
  });
  check('verify: value wiped by the page is reported as failed', revert[0].status === 'failed' && /reverted/.test(revert[0].reason), JSON.stringify(revert[0]));

  // 8. Exam form inside an iframe: the form frame shows the most boxes, and mapping/filling work inside it
  const page3 = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page3.addInitScript(() => {
    const store = {};
    window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage() {} }, storage: { local: {
      get: async k => (typeof k === 'string' ? { [k]: store[k] } : { ...store }),
      set: async o => { Object.assign(store, JSON.parse(JSON.stringify(o))); }
    } } };
  });
  await page3.goto('file://' + path.join(ROOT, 'core/mock-emr/framed.html'));
  const frame = page3.frames().find(f => f !== page3.mainFrame());
  await frame.waitForSelector('[name=b5]');
  for (const target of [page3, frame]) {
    await target.addScriptTag({ path: path.join(EXT, 'schema.js') });
    await target.addScriptTag({ path: path.join(EXT, 'content.js') });
  }
  const topCount = await page3.evaluate(() => countVisibleFields());
  const frameCount = await frame.evaluate(() => countVisibleFields());
  check(`iframe: form frame shows the most boxes (top ${topCount}, iframe ${frameCount})`, topCount === 1 && frameCount > 50);
  const noSideEffect = await frame.evaluate(() => {
    getAllFields(true); const before = lastScannedEls.slice();
    countVisibleFields();
    return before.length === lastScannedEls.length && before.every((el, i) => el === lastScannedEls[i]);
  });
  check('iframe: counting boxes does not disturb a Quick fill scan in progress', noSideEffect);
  const framed = await frame.evaluate(async () => {
    const map = {}; autoMapVisible(map); await saveMap(map);
    return fillSchema({ bv_amplitude_od: '5 cm', va_dist_sc_os: '20/200' });
  });
  check('iframe: mapped values fill the boxes inside the frame',
        framed.every(r => r.status === 'filled') && (await frame.$eval('[name=b5]', el => el.value)) === '5 cm' &&
        (await frame.$eval('[name=v3]', el => el.value)) === '200', JSON.stringify(framed));

  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
