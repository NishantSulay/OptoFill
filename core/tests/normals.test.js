// Tests "section normal" handling (applyNormals in eye-exam-extension/extract.js). No API calls.
// Usage: node core/tests/normals.test.js
const { applyNormals, parseResponse, buildSystemPrompt, DEFAULT_NORMALS } = require('../../eye-exam-extension/extract.js');

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? '  → ' + detail : ''}`);
  if (!cond) failures++;
}

const reply = findings => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ findings }) }] });

// "SLE normal OU except lens 1+ NS": dictated findings win, the rest of the section gets the normals
const sle = applyNormals(parseResponse(reply([{ key: 'normal_anterior', value: 'OU' }, { key: 'sle_lens_od', value: '1+ NS' }])));
check('anterior normal OU: lids filled for both eyes', sle.sle_lids_od === 'Clear' && sle.sle_lids_os === 'Clear', JSON.stringify(sle));
check('anterior normal OU: a dictated finding is kept', sle.sle_lens_od === '1+ NS' && sle.sle_lens_os === 'Clear', JSON.stringify(sle));
check('anterior normal: the posterior segment is left alone', !Object.keys(sle).some(k => /^(fundus|onh)_/.test(k)), JSON.stringify(sle));
check('the normal_* flag itself is never filled', !Object.keys(sle).some(k => k.startsWith('normal_')));
check('boxes with no normal text are skipped', !('sle_sclera_od' in sle) && !('sle_tbut_od' in sle));

const od = applyNormals({ normal_posterior: 'OD', fundus_cd_od: '0.3' });
check('posterior normal OD: right eye only', od.fundus_macula_od === DEFAULT_NORMALS.fundus_macula && !od.fundus_macula_os && od.onh_rim_od === 'Healthy rim', JSON.stringify(od));
check('posterior normal: C/D stays a measurement, not a normal', od.fundus_cd_od === '0.3' && !od.fundus_cd_os);

const own = applyNormals({ normal_anterior: 'both eyes' }, { sle_lids: 'Lids/lashes clean', sle_cornea: '' });
check("doctor's own normals are used, empty ones skipped", own.sle_lids_os === 'Lids/lashes clean' && !own.sle_cornea_od && !own.sle_conj_od, JSON.stringify(own));

check('prompt lists the normal sections', /normal_anterior:/.test(buildSystemPrompt()) && /normal_posterior:/.test(buildSystemPrompt()));

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
