// Tests the website's try-it page (demo.html) at phone size: the sample dictation fills the practice EMR, undo
// restores it, and without an API key your own words are not sent anywhere. No API calls.
// Usage: node core/tests/demo-page.test.js   (needs `playwright`; set CHROME_PATH if no bundled browser)
const { chromium } = require('playwright');
const { serve, VALUES } = require('../demo/lib');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? '  → ' + detail : ''}`);
  if (!cond) failures++;
}

(async () => {
  const server = await serve();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [], calls = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/anthropic\.com/.test(r.url())) calls.push(r.url()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/demo.html`);
  await page.waitForFunction(() => !document.getElementById('sample').disabled, null, { timeout: 15000 });
  const box = name => page.frameLocator('#emr').locator(`[name=${name}]`).inputValue();

  const widths = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  check('the page fits a phone: no sideways scrolling', widths[0] <= widths[1], widths.join(' > '));
  check('fill is off until there is a dictation', await page.isDisabled('#fill'));

  await page.click('#sample');
  await page.waitForFunction(() => !document.getElementById('fill').disabled, null, { timeout: 15000 });
  await page.click('#fill');
  await page.waitForFunction(() => /ok|err/.test(document.getElementById('status').className), null, { timeout: 15000 });
  check('sample: the fill finished without a problem', await page.evaluate(() => document.getElementById('status').classList.contains('ok')), await page.textContent('#status-text'));
  const rows = await page.$$eval('#results li', els => els.map(li => li.className));
  const want = Object.keys(VALUES).length;
  check(`sample: all ${want} values filled and checked`, rows.length === want && rows.every(c => c === 'filled'), JSON.stringify(rows));
  const filled = [await box('v1'), await box('b5'), await box('s2')];
  check('sample: boxes hold the values', filled.join('|') === '40|6 cm|Randot', filled.join(' | '));
  const va = [await box('v3'), await box('v4')];
  check('sample: the VA modifier went to its own box', va.join('|') === '30|-1', va.join(' | '));

  await page.click('#undo');
  const after = [await box('v1'), await box('b5')];
  check('undo: boxes are empty again', after.join('') === '' && !(await page.$$('#results li')).length, after.join(' | '));

  await page.fill('#transcript', 'Oh dee 20/25 without glasses.');
  await page.click('#fill');
  await page.waitForFunction(() => document.getElementById('status').classList.contains('err'));
  const liveOpen = await page.evaluate(() => document.getElementById('live').open);
  check('no key: your own words are not filled, and live mode is offered', liveOpen && await box('v1') === '');
  const tidy = await page.inputValue('#transcript');
  check('no key: the word fixes still tidy the dictation', tidy === 'OD 20/25 without glasses.', tidy);
  check('no key: nothing was sent to Anthropic', !calls.length, calls.join(', '));
  check('no script errors', !errors.length, errors.join(' | '));

  if (process.argv[2]) await page.screenshot({ path: process.argv[2], fullPage: true });
  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
