// Tests the doctor's word fixes (eye-exam-extension/wordfix.js). No browser, no API calls.
// Usage: node core/tests/wordfix.test.js
const { DEFAULTS, parse, apply } = require('../../eye-exam-extension/wordfix.js');
const cases = require('../evals/cases.json');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? '  → ' + detail : ''}`);
  if (!cond) failures++;
}
const is = (name, got, want) => check(name, got === want, `got "${got}", want "${want}"`);

is('a phrase is replaced, any letter case', apply('Pupils Pearl A, no APD.', 'pearl a = PERRLA'), 'Pupils PERRLA, no APD.');
is('every occurrence, across extra spaces', apply('oh dee 20/20, oh  dee plano', 'oh dee = OD'), 'OD 20/20, OD plano');
is('whole words only', apply('The perlage and superla', 'perla = PERRLA'), 'The perlage and superla');
is('the longer phrase wins', apply('plain oh sphere', 'plain = plane\nplain oh = plano'), 'plano sphere');
is("a fix never rewrites another fix's output", apply('ess', 'ess = OS\nOS = left eye'), 'OS');
is('fixing twice changes nothing, even when the result contains what was heard',
   apply(apply('dilated with trope', 'trope = trope 1%'), 'trope = trope 1%'), 'dilated with trope 1%');
is('"->" and "→" also separate the two sides', apply('trope and fenil', 'trope -> tropicamide\nfenil → phenylephrine'), 'tropicamide and phenylephrine');
is('punctuation in a phrase is matched literally', apply('see over d. 0.3', 'see over d. = C/D'), 'C/D 0.3');
is('half-written lines are ignored', apply('oh dee', 'oh dee =\n= OD\nno separator'), 'oh dee');
is('no fixes leaves the text alone', apply('Lids clear OU.', ''), 'Lids clear OU.');
check('parse reads heard and meant', JSON.stringify(parse(' oh  dee  =  OD ')) === '[{"heard":"oh dee","meant":"OD"}]', JSON.stringify(parse(' oh  dee  =  OD ')));

// The starter fixes must not touch a dictation that was heard correctly
const clean = cases.filter(c => c.id !== 'misheard-speech');
const changed = clean.filter(c => apply(c.dictation, DEFAULTS) !== c.dictation).map(c => c.id);
check(`starter fixes leave correctly heard dictations unchanged (${clean.length} cases)`, !changed.length, changed.join(', '));
is('starter fixes repair the misheard terms', apply('Pupils pearl a. Oh dee 20/25, oh ess 20/30. Manifest oh dee plain oh.', DEFAULTS),
   'Pupils PERRLA. OD 20/25, OS 20/30. Manifest OD plano.');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
