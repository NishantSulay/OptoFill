// Tests identifier redaction (eye-exam-extension/redact.js). Synthetic identifiers only.
// Usage: node core/tests/redact.test.js
const path = require('path');
const { redact } = require('../../eye-exam-extension/redact.js');
const cases = require('../evals/cases.json');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? '  → ' + detail : ''}`);
  if (!cond) failures++;
}

// Identifiers that must be removed: [input, text that must be gone, placeholder expected]
const REMOVE = [
  ['Patient Test Sample here for annual exam', 'Test Sample', '[name]'],
  ['Mr. Test Sample reports blur', 'Test Sample', '[name]'],
  ['Dr Example referred her', 'Example', '[name]'],
  ["The patient's name is Test Sample.", 'Test Sample', '[name]'],
  ['Her name is Ann Example', 'Ann Example', '[name]'],
  ['DOB 01/01/1900', '01/01/1900', '[date]'],
  ['date of birth 1900', '1900', '[date]'],
  ['born in 1900', '1900', '[date]'],
  ['seen on January 5, 1900', 'January 5, 1900', '[date]'],
  ['seen 5 Jan 1900', '5 Jan 1900', '[date]'],
  ['visit 1900-01-05', '1900-01-05', '[date]'],
  ['health card 1234-567-890 AB', '1234-567-890', '[id]'],
  ['chart number 123456789', '123456789', '[id]'],
  ['call 416-555-0100', '555-0100', '[phone]'],
  ['call (416) 555 0100', '555 0100', '[phone]'],
  ['email test@example.com', 'test@example.com', '[email]'],
  ['lives at 12 Sample Street', '12 Sample Street', '[address]'],
  ['postal code M5V 2T6', 'M5V 2T6', '[postal]'],
];
for (const [input, gone, placeholder] of REMOVE) {
  const out = redact(input).text;
  check(`removes: ${input}`, !out.includes(gone) && out.includes(placeholder), out);
}

// Clinical text that must come through unchanged
const KEEP = [
  'Distance VA sc OD 20/40, OS 20/20-2, OU 20/25+1. Near 20/30.',
  'Manifest -1.25 -0.50 x 180, OS plano -0.75 x 090, add +2.00. PD 64/61.',
  'IOP 16 mmHg and 18 by Goldmann at 10:20. C/D 0.3 / 0.35. 1+ NS OU.',
  'Patient reports flashes. patient denies pain. Pupils PERRLA, no APD.',
  'Color 14/14 Ishihara, stereo 40 seconds Randot. Return in 1 year. Dr said follow up 6 months.',
  'NPC 8 cm, amplitude OD 6 cm. Cover test 2 prism diopters exophoria. Vergences 14/10.',
];
for (const t of KEEP) check(`keeps: ${t.slice(0, 50)}…`, redact(t).text === t, redact(t).text);

// Every eval dictation is clinical only, so redaction must not change any of them
const changed = cases.filter(c => !c.dictation.includes('Test Sample') && redact(c.dictation).text !== c.dictation);
check(`eval dictations without identifiers are unchanged (${cases.length} cases)`, !changed.length, changed.map(c => c.id).join(', '));

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
