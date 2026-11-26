// Adds (or updates) a ready-made setup in eye-exam-extension/setups.js from a setup a doctor checked and exported
// (side panel → Export setup → optofill-setup-<host>.json).
// Usage: node core/setups/add.js optofill-setup-….json --name "EMR name" [--id emr-id]
//
// What is kept for each box: its labels (row, column, own label, name, headings) and how it was set (auto-map, by
// hand, or a field the doctor named). Left out: the practice's address, selectors and ids (where the box sat on that
// doctor's page). Every kept text goes through the same identifier check as the dictation (redact.js); if anything
// looks like a patient identifier, nothing is written.
const fs = require('fs');
const path = require('path');
const { redact } = require('../../eye-exam-extension/redact.js');

const SETUPS_FILE = path.join(__dirname, '../../eye-exam-extension/setups.js');
const KEEP = ['row', 'col', 'label', 'name', 'context', 'stripPrefix', 'auto', 'manual', 'custom', 'customLabel', 'type'];
const TEXT = ['row', 'col', 'label', 'name', 'context', 'customLabel'];

// → { setup: { id, name, map }, skipped: [key: why], identifiers: [key.field: text] }
function toReadySetup(file, { name, id }) {
  if (!file || file.optofillSetup !== 1 || !file.map || typeof file.map !== 'object') throw new Error('Not an OptoFill setup file (side panel → Export setup)');
  if (!name) throw new Error('Give the EMR a name: --name "EMR name"');
  const map = {}, skipped = [], identifiers = [];
  for (const [key, e] of Object.entries(file.map)) {
    const out = {};
    for (const k of KEEP) if (e[k] !== undefined && e[k] !== '') out[k] = e[k];
    if (/^field_\d+$/.test(out.label || '')) delete out.label;   // its number among the page's inputs: not a label
    for (const k of TEXT) {
      if (typeof out[k] !== 'string') continue;
      const r = redact(out[k]);
      if (r.removed.length || /\[(name|date|id|phone|email|address|postal)\]/.test(r.text)) identifiers.push(`${key}.${k}: ${JSON.stringify(out[k])}`);
    }
    // Recognised by its labels only: a box with none can't be found on another practice's page
    if (!out.row && !out.col && !out.label && !out.name) { skipped.push(`${key}: no labels to find it by`); continue; }
    map[key] = out;
  }
  const slug = (id || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { setup: { id: slug, name, map }, skipped, identifiers };
}

function writeSetups(setups) {
  const src = fs.readFileSync(SETUPS_FILE, 'utf8');
  const body = JSON.stringify(setups, null, 2).replace(/\n/g, '\n  ');
  const next = src.replace(/const SETUPS = [\s\S]*?;\n  root\.OPTOFILL_SETUPS/, `const SETUPS = ${body};\n  root.OPTOFILL_SETUPS`);
  if (next === src && !src.includes(body)) throw new Error('Could not find the SETUPS list in setups.js');
  fs.writeFileSync(SETUPS_FILE, next);
}

if (require.main === module) {
  const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
  const input = process.argv[2];
  if (!input || input.startsWith('--')) { console.error('Usage: node core/setups/add.js optofill-setup-….json --name "EMR name" [--id emr-id]'); process.exit(2); }
  try {
    const { setup, skipped, identifiers } = toReadySetup(JSON.parse(fs.readFileSync(input, 'utf8')), { name: arg('--name'), id: arg('--id') });
    if (identifiers.length) {
      console.error('Not added: these texts look like patient identifiers. Export the setup from a test patient, or remove them:\n  ' + identifiers.join('\n  '));
      process.exit(1);
    }
    const setups = require(SETUPS_FILE).filter(s => s.id !== setup.id);
    writeSetups([...setups, setup]);
    console.log(`${setup.name} (${setup.id}): ${Object.keys(setup.map).length} boxes added to eye-exam-extension/setups.js`);
    if (skipped.length) console.log('Left out:\n  ' + skipped.join('\n  '));
    console.log('Next: node core/tests/setups.test.js, and bump the version in eye-exam-extension/manifest.json');
  } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { toReadySetup, writeSetups, SETUPS_FILE };
