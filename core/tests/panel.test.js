// Tests the side panel (popup.html) working with the real content script on the mock EMR, on the demo stage
// (core/demo/lib.js). Claude's reply is canned; no API calls.
// Usage: node core/tests/panel.test.js   (needs `playwright`; set CHROME_PATH if no bundled browser)
const fs = require('fs');
const { chromium } = require('playwright');
const { openStage, VALUES } = require('../demo/lib');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? '  → ' + detail : ''}`);
  if (!cond) failures++;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const st = await openStage(browser, { width: 1500, height: 950, scale: 1, local: { reviewBeforeFill: true } });
  const { page, emr, panel } = st;
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const box = name => emr.inputValue(`[name=${name}]`);
  const readDictation = async () => {
    await st.dictate(undefined, 1);
    await panel.click('#fill-btn');
    await panel.waitForSelector('#review-area.visible');
  };

  // 1. Review before filling: nothing is typed into the EMR until the doctor has seen the values
  await readDictation();
  const rows = await panel.$$eval('#review-list .result-item', els => els.map(r => r.dataset.key));
  check(`review: all ${Object.keys(VALUES).length} values are listed`, rows.length === Object.keys(VALUES).length, rows.join(', '));
  check('review: nothing is filled yet', await box('v1') === '' && await box('b5') === '', (await box('v1')) + ' | ' + (await box('b5')));
  check('review: the button counts the boxes', (await panel.textContent('#review-fill')).includes(`Fill ${rows.length} boxes`), await panel.textContent('#review-fill'));

  // Correct one value, drop another, then fill
  await panel.fill('#review-list [data-key=bv_amplitude_od] input', '7 cm');
  await panel.click('#review-list [data-key=stereo_method] button');
  check('review: removing a value updates the count', (await panel.textContent('#review-fill')).includes(`Fill ${rows.length - 1} boxes`), await panel.textContent('#review-fill'));
  await panel.click('#review-fill');
  await panel.waitForSelector('#results-area.visible');
  check('review: the corrected value is what gets filled', await box('b5') === '7 cm', await box('b5'));
  check('review: the removed value is not filled', await box('s2') === 'Select', await box('s2'));
  check('review: the rest fill as read', await box('v1') === '40' && await box('v4') === '-1', (await box('v1')) + ' | ' + (await box('v4')));
  check('review: the list closes after filling', !(await panel.isVisible('#review-area')));

  // 2. Cancel leaves the EMR untouched
  await panel.click('#undo-btn');
  await page.waitForTimeout(200);
  await readDictation();
  await panel.click('#review-cancel');
  check('cancel: nothing is filled and the list closes', await box('v1') === '' && !(await panel.isVisible('#review-area')), await box('v1'));
  check('cancel: the dictation is kept for another try', (await panel.inputValue('#transcript')).length > 50 && !(await panel.isDisabled('#fill-btn')));

  // 3. Layout report: what OptoFill sees on the screen, for fixing a wrong mapping — never what is typed in the boxes
  const saved = async click => {
    const [download] = await Promise.all([page.waitForEvent('download'), click()]);
    return { name: download.suggestedFilename(), data: JSON.parse(fs.readFileSync(await download.path(), 'utf8')) };
  };
  await emr.fill('[name=n1]', 'TYPED-IN-THE-EMR');
  const report = await saved(() => panel.click('#report-btn'));
  check('report: saved as a file with the boxes, texts, panels and setup of this screen',
        /^optofill-report-.*\.json$/.test(report.name) && report.data.fields.length > 50 && report.data.texts.length > 20 && report.data.panels.length > 3 && Object.keys(report.data.map).length > 50,
        `${report.name}: ${report.data.fields?.length} boxes, ${report.data.texts?.length} texts, ${report.data.panels?.length} panels`);
  check('report: has the last dictation and what was read from it', /Amplitude OD 6/.test(report.data.dictation || '') && report.data.read?.bv_npc === '8 cm');
  check('report: does not have what is typed in the EMR', !JSON.stringify(report.data).includes('TYPED-IN-THE-EMR'));

  // 4. Setup file: export this EMR's setup, load one on another computer
  const setup = await saved(() => panel.click('#export-btn'));
  const count = Object.keys(setup.data.map).length;
  check('export: the setup file holds every mapped field', setup.data.optofillSetup === 1 && count > 50, `${setup.name}: ${count}`);
  page.on('dialog', d => d.accept());
  const two = Object.fromEntries(Object.entries(setup.data.map).filter(([k]) => ['va_dist_sc_od', 'bv_npc'].includes(k)));
  await panel.setInputFiles('#import-file', { name: 'setup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ optofillSetup: 1, host: 'x', map: two })) });
  await panel.waitForFunction(() => /^2 exam fields/.test(document.getElementById('emr-setup-text').textContent));
  check('import: a setup file replaces this EMR’s setup', true);
  await panel.setInputFiles('#import-file', { name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  await panel.waitForFunction(() => /isn’t an OptoFill setup file/.test(document.getElementById('toast').textContent));
  check('import: any other file is refused and the setup is kept', /^2 exam fields/.test(await panel.textContent('#emr-setup-text')), await panel.textContent('#emr-setup-text'));

  check('no script errors', !errors.length, errors.join(' | '));
  await st.close();
  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
