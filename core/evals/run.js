// Extraction eval: runs mock dictations through the same prompt the extension uses and scores the schema output.
// Usage:  ANTHROPIC_API_KEY=sk-ant-... node core/evals/run.js        (~9 API calls, a few cents)
//         node core/evals/run.js --dry-run                            (prints one request, no API call)
const fs = require('fs');
const path = require('path');
const { buildRequest, extractFindings } = require('../../eye-exam-extension/extract.js');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));

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

(async () => {
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(buildRequest(cases[0].dictation, ''), null, 2).slice(0, 4000));
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('Set ANTHROPIC_API_KEY first.'); process.exit(2); }

  let passed = 0, total = 0, extras = 0;
  const report = [];
  for (const c of cases) {
    let got, error;
    try { got = await extractFindings({ apiKey, dictation: c.dictation }); }
    catch (e) { error = e.message; got = {}; }
    const { checks, unexpected } = score(c, got);
    const ok = checks.filter(x => x.ok).length;
    passed += ok; total += checks.length; extras += unexpected.length;
    const clean = !error && ok === checks.length && !unexpected.length;
    console.log(`${clean ? 'PASS' : 'FAIL'}  ${c.id}  ${ok}/${checks.length}${unexpected.length ? `  unexpected: ${unexpected.map(k => `${k}="${got[k]}"`).join(', ')}` : ''}${error ? `  error: ${error}` : ''}`);
    for (const x of checks.filter(x => !x.ok)) console.log(`        ${x.key}: got ${JSON.stringify(x.got)}, want ${JSON.stringify(x.want)}`);
    report.push({ id: c.id, got, checks, unexpected, error });
  }
  console.log(`\nValues correct: ${passed}/${total}   Unexpected (invented or misplaced) values: ${extras}`);
  fs.writeFileSync(path.join(__dirname, 'last-run.json'), JSON.stringify(report, null, 2));
  process.exit(passed === total && !extras ? 0 : 1);
})();
