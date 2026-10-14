// Extraction eval: runs mock dictations through the same prompt the extension uses and scores the schema output.
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node core/evals/run.js
//   ANTHROPIC_API_KEY=sk-ant-... node core/evals/run.js --models claude-sonnet-4-6,claude-sonnet-5-5,claude-haiku-5-5
//   node core/evals/run.js --dry-run [--models ...]      (prints the request per model, no API call)
const fs = require('fs');
const path = require('path');
const { MODEL, buildRequest, extractFindings } = require('../../eye-exam-extension/extract.js');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const models = (arg('--models') || MODEL).split(',').map(s => s.trim()).filter(Boolean);

// USD per million tokens (input, output) — Claude API list prices
const PRICES = {
  'claude-sonnet-4-6': [3, 15], 'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10],
  'claude-haiku-5-5': [0.10, 0.50], 'claude-haiku-4-5': [1, 5], 'claude-opus-5-5': [4, 20],
};

function norm(v) {
  return String(v).toLowerCase().replace(/\s+/g, '').replace(/mmhg$/, '');
}

function sameValue(got, want) {
  const g = norm(got), w = norm(want);
  if (g === w) return true;
  const num = /^[+-]?\d*\.?\d+$/;
  if (num.test(g) && num.test(w)) return parseFloat(g) === parseFloat(w) && (g[0] === '-') === (w[0] === '-');
  return false;
}

function score(c, got) {
  const checks = [];
  for (const [key, rule] of Object.entries(c.expect)) {
    const v = got[key];
    let ok;
    if (rule.absent) ok = v === undefined;
    else if (v === undefined) ok = false;
    else if (rule.equals !== undefined) ok = sameValue(v, rule.equals);
    else if (rule.contains !== undefined) ok = norm(v).includes(norm(rule.contains));
    else if (rule.containsAny) ok = rule.containsAny.some(x => norm(v).includes(norm(x)));
    checks.push({ key, ok, got: v, want: rule });
  }
  const allowed = new Set([...Object.keys(c.expect), ...(c.allowExtra || [])]);
  const unexpected = Object.keys(got).filter(k => !allowed.has(k));
  return { checks, unexpected };
}

async function runCase(apiKey, model, c) {
  const meta = {};
  const t0 = Date.now();
  let got = {}, error;
  try { got = await extractFindings({ apiKey, dictation: c.dictation, model, meta }); }
  catch (e) { error = e.message; }
  const ms = Date.now() - t0;
  return { id: c.id, got, error, ms, usage: meta.usage || {}, ...score(c, got) };
}

async function runModel(apiKey, model) {
  console.log(`\n=== ${model} ===`);
  const results = [];
  for (let i = 0; i < cases.length; i += 3) {
    results.push(...await Promise.all(cases.slice(i, i + 3).map(c => runCase(apiKey, model, c))));
  }
  for (const r of results) {
    const ok = r.checks.filter(x => x.ok).length;
    const clean = !r.error && ok === r.checks.length && !r.unexpected.length;
    console.log(`${clean ? 'PASS' : 'FAIL'}  ${r.id}  ${ok}/${r.checks.length}  ${(r.ms / 1000).toFixed(1)}s` +
      (r.unexpected.length ? `  unexpected: ${r.unexpected.map(k => `${k}="${r.got[k]}"`).join(', ')}` : '') +
      (r.error ? `  error: ${r.error}` : ''));
    for (const x of r.checks.filter(x => !x.ok)) console.log(`        ${x.key}: got ${JSON.stringify(x.got)}, want ${JSON.stringify(x.want)}`);
  }
  const correct = results.reduce((n, r) => n + r.checks.filter(x => x.ok).length, 0);
  const total = results.reduce((n, r) => n + r.checks.length, 0);
  const inTok = results.reduce((n, r) => n + (r.usage.input_tokens || 0), 0);
  const outTok = results.reduce((n, r) => n + (r.usage.output_tokens || 0), 0);
  const price = PRICES[model];
  return {
    model, correct, total,
    unexpected: results.reduce((n, r) => n + r.unexpected.length, 0),
    errors: results.filter(r => r.error).length,
    avgSec: results.reduce((n, r) => n + r.ms, 0) / results.length / 1000,
    costPerFill: price ? ((inTok * price[0] + outTok * price[1]) / 1e6) / results.length : null,
    results,
  };
}

(async () => {
  if (process.argv.includes('--dry-run')) {
    for (const m of models) {
      const req = buildRequest(cases[0].dictation, '', m);
      req.system = req.system.slice(0, 300) + '…';
      console.log(`--- ${m}\n${JSON.stringify(req, (k, v) => (k === 'enum' ? `[${v.length} keys]` : v), 2)}`);
    }
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('Set ANTHROPIC_API_KEY first.'); process.exit(2); }

  const summary = [];
  for (const m of models) summary.push(await runModel(apiKey, m));

  console.log('\nModel                 Correct    Invented/misplaced  Errors  Avg time  Cost per fill');
  for (const s of summary) {
    console.log(`${s.model.padEnd(22)}${`${s.correct}/${s.total}`.padEnd(11)}${String(s.unexpected).padEnd(20)}${String(s.errors).padEnd(8)}${(s.avgSec.toFixed(1) + 's').padEnd(10)}${s.costPerFill == null ? 'n/a' : '$' + s.costPerFill.toFixed(4)}`);
  }
  fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify(summary, null, 2));
  process.exit(summary.every(s => s.correct === s.total && !s.unexpected && !s.errors) ? 0 : 1);
})();
