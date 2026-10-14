// Quick fill eval: runs the mock dictations through the Quick fill prompt against the mock EMR's real field scan,
// then checks which box each value landed in. Quick fill only runs on EMRs that haven't been set up.
// Usage (needs the `playwright` package, like core/tests/content.test.js):
//   ANTHROPIC_API_KEY=sk-ant-... node core/evals/quickfill.js [--models claude-sonnet-4-6,claude-haiku-5-5]
//   node core/evals/quickfill.js --dry-run      (prints the scanned fields and the request, no API call)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { MODEL, buildRequest, quickFill } = require('../../eye-exam-extension/quickfill.js');
const { PRICES, score } = require('./score.js');

const ROOT = path.resolve(__dirname, '../..');
const EXT = path.join(ROOT, 'eye-exam-extension');
const MOCK = 'file://' + path.join(ROOT, 'core/mock-emr/index.html');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const models = (arg('--models') || MODEL).split(',').map(s => s.trim()).filter(Boolean);

// Which schema key each mock EMR box holds. VA rows have two boxes ("OD:20/" then a modifier box); both feed one key.
const BOX_KEY = {
  v1: 'va_dist_sc_od', v3: 'va_dist_sc_os', v5: 'va_dist_sc_ou', v7: 'va_dist_cc_od', v9: 'va_dist_cc_os', v11: 'va_dist_cc_ou',
  v13: 'va_near_sc_od', v15: 'va_near_sc_os',
  p1: 'pupils_light_od', p2: 'pupils_dark_od', p3: 'pupils_direct_od', p4: 'pupils_consensual_od', p5: 'pupils_apd_od',
  p6: 'pupils_light_os', p7: 'pupils_dark_os', p8: 'pupils_direct_os', p9: 'pupils_consensual_os', p10: 'pupils_apd_os', pn: 'pupils_notes',
  c1: 'cover_dist_eye', c2: 'cover_dist_intermittent', c3: 'cover_dist_direction', c4: 'cover_dist_amount',
  c5: 'cover_near_eye', c6: 'cover_near_intermittent', c7: 'cover_near_direction', c8: 'cover_near_amount',
  b1: 'bv_pfv_dist', b2: 'bv_nfv_dist', b3: 'bv_pfv_near', b4: 'bv_nfv_near', b5: 'bv_amplitude_od', b6: 'bv_amplitude_os',
  b7: 'bv_cfields_od', b8: 'bv_cfields_os', b9: 'bv_eoms_od', b10: 'bv_eoms_os', b11: 'bv_npc', b12: 'bv_pursuits', b13: 'bv_notes',
  d1: 'pd_dist_od', d2: 'pd_dist_os', d3: 'pd_dist_ou', d4: 'pd_near_od', d5: 'pd_near_os', d6: 'pd_near_ou',
  cv1: 'color_od', cv2: 'color_os', cv3: 'color_method', s1: 'stereo', s2: 'stereo_method',
  r1: 'rx_sph_od', r2: 'rx_cyl_od', r3: 'rx_axis_od', r4: 'rx_add_od', r5: 'rx_va_od',
  r6: 'rx_sph_os', r7: 'rx_cyl_os', r8: 'rx_axis_os', r9: 'rx_add_os', r10: 'rx_va_os',
  t1: 'iop_od', t2: 'iop_os', n1: 'notes_general',
};
const VA_SECOND = { v2: 'v1', v4: 'v3', v6: 'v5', v8: 'v7', v10: 'v9', v12: 'v11', v14: 'v13', v16: 'v15' };
// Free-text boxes: anything may go here without counting as misplaced (they're still graded when a case expects them).
const NOTE_BOXES = new Set(['n1', 'pn', 'b13', 'rn']);
const ON_PAGE = new Set(Object.values(BOX_KEY));

// The fields Quick fill sends to Claude, from the extension's own scan. The mock EMR splits Refraction onto a
// second tab; both tabs are scanned and joined so every case can be graded in one request.
async function scanMock() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.addInitScript(() => {
    window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage() {} }, storage: { local: { get: async () => ({}), set: async () => {} } } };
  });
  await page.goto(MOCK);
  await page.addScriptTag({ path: path.join(EXT, 'schema.js') });
  await page.addScriptTag({ path: path.join(EXT, 'content.js') });
  const pretest = await page.evaluate(() => getAllFields(true));
  await page.click('[data-tab=refraction]');
  const refraction = await page.evaluate(() => getAllFields(true));
  await browser.close();
  const unknown = [...pretest, ...refraction].filter(f => !BOX_KEY[f.name] && !VA_SECOND[f.name] && !NOTE_BOXES.has(f.name) && !/^c(9|1[0-2])$/.test(f.name));
  if (unknown.length) throw new Error('Mock EMR has boxes this eval does not know: ' + unknown.map(f => f.name).join(', '));
  return [...pretest, ...refraction].map((f, index) => ({ ...f, index }));
}

// { fieldIndex: value } → { schemaKey: value } plus values that landed in boxes no case should fill.
function toKeys(fields, mapping) {
  const byName = {}, stray = [];
  for (const [idx, value] of Object.entries(mapping || {})) {
    const f = fields[parseInt(idx)];
    const v = String(value ?? '').trim();
    if (!v) continue;
    if (!f) { stray.push(`[${idx}]="${v}" (no such box)`); continue; }
    byName[f.name] = v;
  }
  const got = {}, notes = {};
  for (const [name, v] of Object.entries(byName)) {
    if (VA_SECOND[name]) continue;
    if (BOX_KEY[name] && BOX_KEY[name].startsWith('va_')) {
      const extra = byName[VA_SECOND_OF[name]] || '';
      got[BOX_KEY[name]] = '20/' + v.replace(/^20\//, '') + extra;
    } else if (BOX_KEY[name]) got[BOX_KEY[name]] = v;
    else if (NOTE_BOXES.has(name)) notes[name] = v;
    else stray.push(`${name}="${v}"`);
  }
  for (const [second, first] of Object.entries(VA_SECOND)) {
    if (byName[second] && !byName[first]) got[BOX_KEY[first]] = '20/' + byName[second];
  }
  return { got, notes, stray };
}
const VA_SECOND_OF = Object.fromEntries(Object.entries(VA_SECOND).map(([s, f]) => [f, s]));

function grade(c, fields, mapping) {
  const { got, notes, stray } = toKeys(fields, mapping);
  const expect = Object.fromEntries(Object.entries(c.expect).filter(([k]) => ON_PAGE.has(k)));
  const allowed = new Set([...Object.keys(c.expect), ...(c.allowExtra || []), ...Object.values(BOX_KEY).filter(k => NOTE_BOXES.has(boxOf(k)))]);
  const { checks, unexpected } = score(expect, got, allowed);
  return { got, notes, checks, unexpected: [...unexpected.map(k => `${k}="${got[k]}"`), ...stray] };
}
const boxOf = key => Object.keys(BOX_KEY).find(n => BOX_KEY[n] === key);

async function runCase(apiKey, model, fields, c) {
  const meta = {};
  const t0 = Date.now();
  let mapping = {}, error;
  try { mapping = await quickFill({ apiKey, dictation: c.dictation, fields, model, meta }); }
  catch (e) { error = e.message; }
  return { id: c.id, mapping, error, ms: Date.now() - t0, usage: meta.usage || {}, ...grade(c, fields, mapping) };
}

async function runModel(apiKey, model, fields) {
  console.log(`\n=== ${model} ===`);
  const results = [];
  for (let i = 0; i < cases.length; i += 3) {
    results.push(...await Promise.all(cases.slice(i, i + 3).map(c => runCase(apiKey, model, fields, c))));
  }
  for (const r of results) {
    const ok = r.checks.filter(x => x.ok).length;
    const clean = !r.error && ok === r.checks.length && !r.unexpected.length;
    console.log(`${clean ? 'PASS' : 'FAIL'}  ${r.id}  ${ok}/${r.checks.length}  ${(r.ms / 1000).toFixed(1)}s` +
      (r.unexpected.length ? `  misplaced: ${r.unexpected.join(', ')}` : '') +
      (r.error ? `  error: ${r.error}` : ''));
    for (const x of r.checks.filter(x => !x.ok)) console.log(`        ${x.key}: got ${JSON.stringify(x.got)}, want ${JSON.stringify(x.want)}`);
  }
  const sum = f => results.reduce((n, r) => n + f(r), 0);
  const price = PRICES[model];
  const inTok = sum(r => r.usage.input_tokens || 0), outTok = sum(r => r.usage.output_tokens || 0);
  return {
    model, correct: sum(r => r.checks.filter(x => x.ok).length), total: sum(r => r.checks.length),
    unexpected: sum(r => r.unexpected.length), errors: results.filter(r => r.error).length,
    avgSec: sum(r => r.ms) / results.length / 1000,
    costPerFill: price ? ((inTok * price[0] + outTok * price[1]) / 1e6) / results.length : null,
    results,
  };
}

(async () => {
  const fields = await scanMock();
  if (process.argv.includes('--dry-run')) {
    for (const m of models) {
      const req = buildRequest(cases[0].dictation, fields, '', m);
      req.system = req.system.slice(0, 200) + '…';
      console.log(`--- ${m}\n${JSON.stringify(req, null, 2)}`);
    }
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('Set ANTHROPIC_API_KEY first.'); process.exit(2); }

  const summary = [];
  for (const m of models) summary.push(await runModel(apiKey, m, fields));

  console.log('\nQuick fill            Right box  Wrong/extra box     Errors  Avg time  Cost per fill');
  for (const s of summary) {
    console.log(`${s.model.padEnd(22)}${`${s.correct}/${s.total}`.padEnd(11)}${String(s.unexpected).padEnd(20)}${String(s.errors).padEnd(8)}${(s.avgSec.toFixed(1) + 's').padEnd(10)}${s.costPerFill == null ? 'n/a' : '$' + s.costPerFill.toFixed(4)}`);
  }
  fs.writeFileSync(path.join(__dirname, 'last-quickfill-run.json'), JSON.stringify(summary, null, 2));
  process.exit(summary.every(s => s.correct === s.total && !s.unexpected && !s.errors) ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(2); });
