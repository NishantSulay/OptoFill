// Ready-made setups (eye-exam-extension/setups.js, core/setups/add.js): a setup checked on one EMR is recognised on
// that EMR's screens by their labels alone, at any address, and finds the right boxes; it is never taken for another
// EMR; the side panel loads it by itself the first time, once; and nothing identifying gets into one.
// The "doctor's setup" here is auto-map's, from the real EMR layouts in fixtures/ (labels and positions only).
// Usage: node core/tests/setups.test.js   (needs `playwright`; no API calls)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { replay } = require('./replay');
const { toReadySetup } = require('../setups/add');
const { openStage, VALUES } = require('../demo/lib');

const ROOT = path.resolve(__dirname, '../..');
const EXT = path.join(ROOT, 'eye-exam-extension');
const MOCK = 'file://' + path.join(ROOT, 'core/mock-emr/index.html');
const fixture = f => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));
const REAL = ['real-pretest.json', 'real-refraction.json', 'real-contact-lens.json', 'stale-setup-health.json', 'wrapped-health.json'];

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? '  → ' + detail : ''}`);
  if (!cond) failures++;
}

// Auto-map's setup of a screen, as the side panel would export it: { key: entry }
const autoSetup = () => { const m = {}; autoMapVisible(m); return m; };

// The mock EMR's tabs, each with the content script, and a way to run something on every tab
async function mockTabs(browser, fn, arg) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.addInitScript(() => {
    const store = {};
    window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage() {} },
      storage: { local: { get: async k => (typeof k === 'string' ? { [k]: store[k] } : { ...store }), set: async o => { Object.assign(store, JSON.parse(JSON.stringify(o))); } } } };
  });
  await page.goto(MOCK);
  await page.addScriptTag({ path: path.join(EXT, 'schema.js') });
  await page.addScriptTag({ path: path.join(EXT, 'content.js') });
  const out = {};
  for (const tab of ['pretest', 'refraction', 'contacts', 'health', 'plan']) {
    await page.click(`[data-tab=${tab}]`).catch(() => {});
    await page.waitForTimeout(50);
    out[tab] = await page.evaluate(fn, arg);
  }
  await page.close();
  return out;
}

(async () => {
  // 1. Making one from an exported file: labels kept; address, selectors and ids left out; identifiers refused
  const made = toReadySetup({ optofillSetup: 1, host: 'smith-optometry.emr-vendor.com', map: {
    iop_od: { selector: 'body > div:nth-of-type(3) > input', id: 'x', name: '', label: 'IOP OD', row: 'IOP', col: 'OD', context: 'Tonometry', stripPrefix: '', auto: true },
    bv_npc: { selector: '#npc', label: 'field_71', row: 'NPC', col: '', context: 'BV', stripPrefix: '', manual: true },
    custom_dilated: { selector: '#d', label: 'Dilated', row: '', col: '', context: '', custom: true, customLabel: 'Dilated', type: 'checkbox' },
    pupils_notes: { selector: 'body > textarea', label: 'field_12', row: '', col: '', context: 'Pupils' },
  } }, { name: 'Test EMR' });
  const text = JSON.stringify(made.setup.map);
  check('file: the setup keeps each box’s labels and how it was set', made.setup.map.iop_od.row === 'IOP' && made.setup.map.bv_npc.manual === true && made.setup.map.custom_dilated.customLabel === 'Dilated');
  check('file: no practice address, selector or id is kept', !/smith|emr-vendor|selector|nth-of-type|"id"/.test(text), text.slice(0, 200));
  check('file: a box’s input number is not kept as its label, and a box with no labels is left out',
    made.setup.map.bv_npc.label === undefined && !made.setup.map.pupils_notes && made.skipped.length === 1, JSON.stringify(made.skipped));
  const leaky = toReadySetup({ optofillSetup: 1, map: { iop_od: { selector: '', row: 'IOP', col: 'OD', label: '', context: 'Patient: Mr. John Doe / DOB 03/14/1961' } } }, { name: 'x' });
  check('file: a patient identifier in a label stops the setup being added', leaky.identifiers.length === 1, JSON.stringify(leaky.identifiers));

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

  // 2. A checked setup of the real EMR (here: auto-map's, over its screens), as add.js would ship it
  const screens = {};
  for (const f of REAL) screens[f] = (await replay(fixture(f), browser, { probe: autoSetup })).probe;
  const exported = {};
  for (const f of REAL) for (const [k, e] of Object.entries(screens[f])) exported[k] ??= e;
  const real = toReadySetup({ optofillSetup: 1, host: 'emr.example.com', map: exported }, { name: 'Real EMR' });
  check(`real EMR: the setup is made (${Object.keys(real.setup.map).length} boxes) with nothing identifying in it`, Object.keys(real.setup.map).length > 100 && !real.identifiers.length, real.identifiers.join('; '));

  // 3. Recognised on each of its screens, finding the boxes auto-map finds there
  for (const f of REAL) {
    const { probe } = await replay(fixture(f), browser, { probe: `(() => {
      const setups = ${JSON.stringify([real.setup])};
      const fields = getAllFields(true);
      const best = recogniseSetup(setups, fields);
      const ready = Object.fromEntries(Object.entries(setups[0].map).map(([k, e]) => [k, { ...e, selector: '' }]));
      const boxes = resolveMap(ready, fields);
      const want = ${JSON.stringify(Object.keys(screens[f]))}.map(k => [k, locateMapped(${JSON.stringify(screens[f])}[k], fields)]);
      return { n: best?.n || 0, name: best?.setup.name, want: want.length, right: want.filter(([k, el]) => boxes.get(k) === el).length,
               wrong: want.filter(([k, el]) => boxes.has(k) && boxes.get(k) !== el).map(([k]) => k) };
    })()` });
    check(`real EMR, ${f}: recognised (${probe.n} boxes by their labels) and finds ${probe.right}/${probe.want} boxes, none wrong`,
      probe.name === 'Real EMR' && probe.right >= probe.want * 0.9 && !probe.wrong.length, `wrong: ${probe.wrong.join(', ')}`);
  }

  // 4. Never taken for another EMR: the real EMR's setup on the mock EMR, and the mock EMR's setup on the real EMR
  const mockMaps = await mockTabs(browser, autoSetup);
  const mockExport = {};
  for (const m of Object.values(mockMaps)) for (const [k, e] of Object.entries(m)) mockExport[k] ??= e;
  const mock = toReadySetup({ optofillSetup: 1, map: mockExport }, { name: 'Mock EMR' });
  const onMock = await mockTabs(browser, setups => recogniseSetup(setups, getAllFields(true))?.setup.name || null, [real.setup]);
  check('another EMR: the real EMR’s setup is not recognised on any mock EMR tab', Object.values(onMock).every(x => x === null), JSON.stringify(onMock));
  for (const f of REAL) {
    const { probe } = await replay(fixture(f), browser, { probe: `recogniseSetup(${JSON.stringify([mock.setup])}, getAllFields(true))?.setup.name || null` });
    check(`another EMR: the mock EMR’s setup is not recognised on ${f}`, probe === null, String(probe));
  }
  const both = await mockTabs(browser, setups => recogniseSetup(setups, getAllFields(true))?.setup.name || null, [real.setup, mock.setup]);
  check('two setups: the mock EMR is recognised as itself on its tabs with exam boxes', ['pretest', 'refraction', 'health'].every(t => both[t] === 'Mock EMR'), JSON.stringify(both));

  // 5. The side panel loads it by itself, once: an EMR with nothing set up, at an address the setup never saw
  const st = await openStage(browser, { width: 1500, height: 950, scale: 1, setup: false, local: { reviewBeforeFill: false } });
  const { panel, emr } = st;
  const status = () => panel.textContent('#emr-setup-text');
  check('panel: starts with nothing set up', /isn.t set up yet/.test(await status()), await status());
  await panel.evaluate(async (s) => { self.OPTOFILL_SETUPS.push(s); await refreshPageStatus(); }, mock.setup);
  check('panel: the ready-made setup is loaded by itself', /exam fields set up/.test(await status()), await status());
  check('panel: and says so', /Loaded OptoFill’s setup for Mock EMR/.test(await panel.textContent('#toast')), await panel.textContent('#toast'));
  await st.dictate(undefined, 1);
  await panel.click('#fill-btn');
  await panel.waitForSelector('#results-area.visible');
  const box = n => emr.inputValue(`[name=${n}]`);
  check('panel: a fill uses it', await box('v1') === '40' && await box('b5') === '6 cm', (await box('v1')) + ' | ' + (await box('b5')));
  const healed = await emr.evaluate(async () => Object.values(await loadMap()).filter(e => e.selector).length);
  check('panel: the boxes on screen get this page’s own selectors', healed > 20, String(healed));
  // The doctor clears it: it isn't loaded again behind their back
  await emr.evaluate(async () => saveMap({}));
  await panel.evaluate(() => refreshPageStatus());
  check('panel: a setup the doctor cleared is not loaded again', /isn.t set up yet/.test(await status()), await status());

  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
