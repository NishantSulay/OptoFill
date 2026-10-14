// OptoFill clinical exam schema — the AI fills these keys; per-EMR setup maps keys to boxes.
// Matching hints (used only to auto-suggest mappings):
//   must: groups of alternative words; every group must appear in the box's label/row/column/headings
//   not:  words that must NOT appear in the box's own label/row/column
//   eye:  'od' | 'os' | 'ou' — must appear in the box's own label/row/column
(function (root) {
  const W = {
    dist: ['distance', 'dist', 'far', 'dva', 'dx'],
    near: ['near', 'nva', 'reading', 'nr'],
    sc: ['uncorrected', 'sc', 'unaided'],
    cc: ['corrected', 'cc', 'aided'],
  };
  const EYE_LABEL = { od: 'OD (right eye)', os: 'OS (left eye)', ou: 'OU (both eyes)' };
  const S = [];
  const add = (key, label, hints = {}, group) => S.push({ key, label, group, ...hints });
  const perEye = (eyes, fn) => eyes.forEach(e => fn(e, EYE_LABEL[e]));

  // History
  add('chief_complaint', 'Chief complaint / reason for visit / history', { must: [['chief', 'complaint', 'reason', 'hpi', 'history']] }, 'History');

  // Visual acuity
  for (const [d, dl] of [['dist', 'distance'], ['near', 'near']]) {
    for (const [c, cl] of [['sc', 'uncorrected (sc)'], ['cc', 'corrected (cc)']]) {
      perEye(['od', 'os', 'ou'], (e, el) =>
        add(`va_${d}_${c}_${e}`, `Visual acuity ${dl} ${cl} ${el}`, { must: [W[d], W[c]], eye: e, not: ['pd', 'pupillary'] }, 'Visual acuity'));
    }
  }

  // Manifest refraction
  const RX = [['sph', 'sphere', ['sphere', 'sph']], ['cyl', 'cylinder', ['cylinder', 'cyl']], ['axis', 'axis', ['axis', 'ax']],
              ['add', 'add power', ['add']], ['prism', 'prism', ['prism']], ['va', 'best corrected VA', ['va', 'bcva', 'acuity']]];
  for (const [k, l, words] of RX) perEye(['od', 'os'], (e, el) =>
    add(`rx_${k}_${e}`, `Manifest refraction ${l} ${el}`,
        { must: k === 'va' ? [words, ['manifest', 'refraction', 'mrx', 'rx']] : [words], eye: e }, 'Refraction'));

  // Intraocular pressure
  perEye(['od', 'os'], (e, el) => add(`iop_${e}`, `IOP (mmHg) ${el}`, { must: [['iop', 'pressure', 'tonometry', 'nct', 'gat']], eye: e }, 'IOP'));
  add('iop_method', 'IOP method (NCT, Goldmann, iCare…)', { must: [['iop', 'pressure', 'tonometry'], ['method', 'type']] }, 'IOP');
  add('iop_time', 'IOP time measured', { must: [['iop', 'pressure', 'tonometry'], ['time']] }, 'IOP');

  // Pupils
  for (const [k, words] of [['light', ['light']], ['dark', ['dark']], ['direct', ['direct']], ['consensual', ['consensual']], ['apd', ['apd', 'rapd', 'mg']]])
    perEye(['od', 'os'], (e, el) => add(`pupils_${k}_${e}`, `Pupils ${k} ${el}`, { must: [words], eye: e }, 'Pupils'));
  add('pupils_notes', 'Pupils notes (e.g. PERRLA)', { must: [['pupils', 'pupil'], ['notes', 'note', 'comments']] }, 'Pupils');

  // Cover test
  for (const [d, dl] of [['dist', 'distance'], ['near', 'near']])
    for (const [k, words] of [['eye', ['eye']], ['intermittent', ['intermittent', 'constant']], ['direction', ['direction', 'type']], ['amount', ['amt', 'amount', 'pd', 'magnitude']]])
      add(`cover_${d}_${k}`, `Cover test ${dl} — ${k}`, { must: [W[d], words], not: ['vertical', 'fusional', '+ve', '-ve'] }, 'Cover test');

  // Binocular vision
  add('bv_pfv_dist', 'Positive fusional vergence (BO) distance', { must: [W.dist, ['+ve', 'positive', 'pfv', 'bo']] }, 'Binocular vision');
  add('bv_nfv_dist', 'Negative fusional vergence (BI) distance', { must: [W.dist, ['-ve', 'negative', 'nfv', 'bi']] }, 'Binocular vision');
  add('bv_pfv_near', 'Positive fusional vergence (BO) near', { must: [W.near, ['+ve', 'positive', 'pfv', 'bo']] }, 'Binocular vision');
  add('bv_nfv_near', 'Negative fusional vergence (BI) near', { must: [W.near, ['-ve', 'negative', 'nfv', 'bi']] }, 'Binocular vision');
  for (const [k, l, words] of [['amplitude', 'accommodation amplitude', ['amplitude', 'amp', 'aa']], ['cfields', 'confrontation fields', ['c fields', 'cvf', 'confrontation', 'fields']], ['eoms', 'EOMs / motility', ['eoms', 'eom', 'motility']]])
    perEye(['od', 'os'], (e, el) => add(`bv_${k}_${e}`, `${l} ${el}`, { must: [words], eye: e }, 'Binocular vision'));
  add('bv_npc', 'Near point of convergence (NPC)', { must: [['npc', 'convergence']] }, 'Binocular vision');
  add('bv_saccades', 'Versions / saccades', { must: [['saccades', 'version/saccades', 'versions']] }, 'Binocular vision');
  add('bv_pursuits', 'Pursuits', { must: [['pursuits', 'pursuit']] }, 'Binocular vision');
  add('bv_notes', 'Binocular vision / additional tests notes', { must: [['additional'], ['tests', 'test']] }, 'Binocular vision');

  // Pupillary distance
  for (const [d, dl] of [['dist', 'distance'], ['near', 'near']])
    perEye(['od', 'os', 'ou'], (e, el) => add(`pd_${d}_${e}`, `Pupillary distance ${dl} ${el}`, { must: [['pupillary', 'pd'], W[d]], eye: e }, 'Pupillary distance'));

  // Color vision & stereo
  perEye(['od', 'os'], (e, el) => add(`color_${e}`, `Color vision ${el}`, { must: [['color', 'colour', 'ishihara']], eye: e }, 'Color vision'));
  add('color_method', 'Color vision method', { must: [['color', 'colour'], ['method']] }, 'Color vision');
  add('stereo', 'Stereoacuity (seconds of arc)', { must: [['stereoacuity', 'stereo']], not: ['method'] }, 'Stereo');
  add('stereo_method', 'Stereoacuity method', { must: [['stereoacuity', 'stereo'], ['method']] }, 'Stereo');

  // Anterior segment (slit lamp)
  for (const [k, l, words] of [['lids', 'lids/lashes', ['lids', 'lid', 'lashes', 'adnexa']], ['conj', 'conjunctiva', ['conj', 'conjunctiva']], ['cornea', 'cornea', ['cornea']],
                               ['ac', 'anterior chamber', ['ac', 'anterior chamber']], ['iris', 'iris', ['iris']], ['lens', 'lens', ['lens']]])
    perEye(['od', 'os'], (e, el) => add(`sle_${k}_${e}`, `Slit lamp ${l} ${el}`, { must: [words], eye: e }, 'Anterior segment'));

  // Posterior segment (fundus)
  for (const [k, l, words] of [['cd', 'C/D ratio', ['c/d', 'cd', 'cup']], ['nerve', 'optic nerve', ['nerve', 'disc', 'onh']], ['macula', 'macula', ['macula']],
                               ['vessels', 'vessels', ['vessels', 'vasculature', 'a/v']], ['periphery', 'periphery', ['periphery', 'peripheral']], ['vitreous', 'vitreous', ['vitreous']]])
    perEye(['od', 'os'], (e, el) => add(`fundus_${k}_${e}`, `Fundus ${l} ${el}`, { must: [words], eye: e }, 'Posterior segment'));

  // Assessment / plan
  add('assessment', 'Assessment / diagnosis', { must: [['assessment', 'diagnosis', 'impression']] }, 'Assessment & plan');
  add('plan', 'Plan / recommendations / follow-up', { must: [['plan', 'recommendation', 'recommendations']] }, 'Assessment & plan');
  add('notes_general', 'Other clinical notes not covered by any field above', {}, 'Other');

  root.OPTOFILL_SCHEMA = S;
  root.OPTOFILL_WORDS = W;   // shared word groups, so auto-map can tell rival groups apart (corrected vs uncorrected, distance vs near)
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
})(typeof self !== 'undefined' ? self : globalThis);
