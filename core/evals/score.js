// Scoring shared by the extraction eval (run.js) and the Quick fill eval (quickfill.js).

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

// expect: only the rules to grade. allowed: keys that may be filled without counting as invented/misplaced.
function score(expect, got, allowed) {
  const checks = [];
  for (const [key, rule] of Object.entries(expect)) {
    const v = got[key];
    let ok;
    if (rule.absent) ok = v === undefined;
    else if (v === undefined) ok = false;
    else if (rule.equals !== undefined) ok = sameValue(v, rule.equals);
    else if (rule.contains !== undefined) ok = norm(v).includes(norm(rule.contains));
    else if (rule.containsAny) ok = rule.containsAny.some(x => norm(v).includes(norm(x)));
    checks.push({ key, ok, got: v, want: rule });
  }
  const unexpected = Object.keys(got).filter(k => !allowed.has(k));
  return { checks, unexpected };
}

module.exports = { PRICES, norm, sameValue, score };
