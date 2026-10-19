// OptoFill clinical exam schema — the AI fills these keys; per-EMR setup maps keys to boxes.
// Matching hints (used only to auto-suggest mappings):
//   must: groups of alternative words; every group must appear in the box's label/row/column/headings
//   not:  words that must NOT appear in the box's own label/row/column
//   eye:  'od' | 'os' | 'ou' — must appear in the box's own label/row/column
//   kind: 'checkbox' — only checkboxes (and other keys never go to checkboxes)
//   family: which refraction grid the box belongs to (manifest, habitual, final, auto, retino, cl). The nearest family
//           word decides; familyOptional: a grid with no family word at all counts as this one (the manifest)
(function (root) {
  const W = {
    dist: ['distance', 'dist', 'far', 'dva', 'dx'],
    near: ['near', 'nva', 'reading', 'nr'],
    sc: ['uncorrected', 'sc', 'unaided'],
    cc: ['corrected', 'cc', 'aided'],
    k1: ['k1', 'flat', 'kf', 'flat k'],
    k2: ['k2', 'steep', 'ks', 'steep k'],
  };
  // Words that say which refraction grid a box is in. Specific families first: on a tie the first listed wins.
  const FAMILIES = {
    habitual: ['habitual', 'lensometry', 'lensometer', 'lenso', 'current', 'hrx'],
    final: ['final', 'prescribed', 'frx'],
    auto: ['autorefraction', 'autorefractor', 'auto', 'ar', 'objective'],
    retino: ['retinoscopy', 'retino', 'ret'],
    cl: ['contact', 'contacts', 'cl', 'cls'],
    kerato: ['keratometry', 'kerato', 'k1', 'k2'],
    manifest: ['manifest', 'mrx', 'subjective', 'subj'],
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

  // How VA was measured: Glasses / Contacts checkboxes next to the Distance / Near Vision headings
  for (const [d, dl] of [['dist', 'distance'], ['near', 'near']]) {
    add(`va_${d}_glasses`, `Visual acuity ${dl} measured with glasses (checkbox)`, { must: [W[d], ['glasses', 'spectacles', 'specs', 'spec']], not: ['contacts', 'contact'], kind: 'checkbox' }, 'Visual acuity');
    add(`va_${d}_contacts`, `Visual acuity ${dl} measured with contact lenses (checkbox)`, { must: [W[d], ['contacts', 'contact', 'cl', 'cls']], kind: 'checkbox' }, 'Visual acuity');
  }

  // Pinhole acuity
  perEye(['od', 'os'], (e, el) => add(`va_dist_ph_${e}`, `Visual acuity distance pinhole (PH) ${el}`, { must: [['ph', 'pinhole']], eye: e }, 'Visual acuity'));

  // Manifest refraction
  const RX = [['sph', 'sphere', ['sphere', 'sph']], ['cyl', 'cylinder', ['cylinder', 'cyl']], ['axis', 'axis', ['axis', 'ax']],
              ['add', 'add power', ['add']], ['prism', 'prism', ['prism']], ['va', 'best corrected VA', ['va', 'bcva', 'acuity']]];
  for (const [k, l, words] of RX) perEye(['od', 'os'], (e, el) =>
    add(`rx_${k}_${e}`, `Manifest refraction ${l} ${el}`,
        { must: k === 'va' ? [words, ['manifest', 'refraction', 'mrx', 'rx']] : [words], eye: e, family: 'manifest', familyOptional: true }, 'Refraction'));

  // Other refractions: habitual Rx (current glasses, from lensometry), final Rx prescribed, autorefraction, retinoscopy
  const OTHER_RX = [
    ['hrx', 'Habitual Rx (current glasses / lensometry)', 'habitual', ['sph', 'cyl', 'axis', 'add', 'prism']],
    ['frx', 'Final Rx prescribed', 'final', ['sph', 'cyl', 'axis', 'add', 'prism']],
    ['ar', 'Autorefraction', 'auto', ['sph', 'cyl', 'axis']],
    ['ret', 'Retinoscopy', 'retino', ['sph', 'cyl', 'axis']],
  ];
  for (const [p, name, family, parts] of OTHER_RX)
    for (const [k, l, words] of RX.filter(r => parts.includes(r[0])))
      perEye(['od', 'os'], (e, el) => add(`${p}_${k}_${e}`, `${name} ${l} ${el}`, { must: [words], eye: e, family }, 'Refraction'));

  // Keratometry: flat (K1) and steep (K2) power, each with its axis
  for (const [k, kw] of [['k1', W.k1], ['k2', W.k2]])
    perEye(['od', 'os'], (e, el) => {
      add(`kerato_${k}_${e}`, `Keratometry ${k.toUpperCase()} power (D) ${el}`, { must: [kw], not: ['axis', 'ax'], eye: e }, 'Keratometry');
      // An axis column sits between K1 and K2, so its heading can't say which K it is: it's the box after its K
      add(`kerato_${k}_axis_${e}`, `Keratometry ${k.toUpperCase()} axis ${el}`, { after: `kerato_${k}_${e}` }, 'Keratometry');
    });

  // Contact lens Rx
  for (const [k, l, words] of [['brand', 'brand / lens name', ['brand', 'product', 'manufacturer', 'name']], ['bc', 'base curve', ['bc', 'base curve', 'bozr', 'curve']],
                               ['dia', 'diameter', ['dia', 'diameter', 'diam']], ['sph', 'power / sphere', ['power', 'pwr', 'sph', 'sphere']],
                               ['cyl', 'cylinder', ['cylinder', 'cyl']], ['axis', 'axis', ['axis', 'ax']], ['add', 'add', ['add']],
                               ['va', 'VA with contacts', ['va', 'acuity']]])
    perEye(['od', 'os'], (e, el) => add(`cl_${k}_${e}`, `Contact lens ${l} ${el}`, { must: [words], eye: e, family: 'cl' }, 'Contact lens'));
  add('cl_fit', 'Contact lens fit assessment / notes', { must: [['fit', 'fitting']], family: 'cl' }, 'Contact lens');

  // Intraocular pressure
  perEye(['od', 'os'], (e, el) => add(`iop_${e}`, `IOP (mmHg) ${el}`, { must: [['iop', 'pressure', 'tonometry', 'nct', 'gat']], eye: e }, 'IOP'));
  add('iop_method', 'IOP method (NCT, Goldmann, iCare…)', { must: [['iop', 'pressure', 'tonometry'], ['method', 'type']] }, 'IOP');
  add('iop_time', 'IOP time measured', { must: [['iop', 'pressure', 'tonometry'], ['time']] }, 'IOP');
  perEye(['od', 'os'], (e, el) => add(`pach_${e}`, `Pachymetry / central corneal thickness (µm) ${el}`, { must: [['pach', 'pachymetry', 'cct', 'thickness']], eye: e }, 'IOP'));

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
                               ['ac', 'anterior chamber', ['ac', 'a/c', 'anterior chamber']], ['iris', 'iris', ['iris']], ['lens', 'lens', ['lens']],
                               ['sclera', 'sclera', ['sclera']], ['tbut', 'tear film / TBUT', ['tbut', 'tear', 'tears', 'tear film', 'fbut', 'nitbut']],
                               ['angles', 'angles / Van Herick', ['angle', 'angles', 'van herick', 'vh', 'vanherick']]])
    // "Lens" is also in a "Contact Lens" panel title: its fit notes box isn't the slit lamp lens
    perEye(['od', 'os'], (e, el) => add(`sle_${k}_${e}`, `Slit lamp ${l} ${el}`, { must: [words], eye: e, ...(k === 'lens' ? { not: ['fit', 'fitting'] } : {}) }, 'Anterior segment'));
  add('sle_notes', 'Slit lamp / anterior segment notes', { must: [['biomicroscopy', 'slit lamp', 'sle', 'anterior segment', 'anterior'], ['note', 'notes', 'comments']] }, 'Anterior segment');

  // Posterior segment (fundus)
  for (const [k, l, words, not] of [['cd', 'C/D ratio (horizontal, or the only C/D given)', ['c/d', 'cd', 'cup'], ['vertical', 'vert']],
                                    ['cd_v', 'C/D ratio vertical', ['vertical', 'vert'], null],
                                    ['nerve', 'optic nerve', ['nerve', 'disc', 'onh'], null], ['macula', 'macula', ['macula'], null],
                                    ['vessels', 'vessels', ['vessels', 'vasculature', 'a/v', 'bvs', 'blood vessels'], ['ratio']],
                                    ['av_ratio', 'A/V ratio', ['ratio'], null],
                                    ['periphery', 'periphery', ['periphery', 'peripheral'], null], ['vitreous', 'vitreous', ['vitreous'], null]])
    perEye(['od', 'os'], (e, el) => add(`fundus_${k}_${e}`, `Fundus ${l} ${el}`,
      { must: k === 'cd_v' ? [words, ['c/d', 'cd', 'cup']] : k === 'av_ratio' ? [words, ['a/v', 'av', 'artery', 'arteriole']] : [words], eye: e, ...(not ? { not } : {}) }, 'Posterior segment'));
  add('fundus_method', 'Fundus exam method (DFE, BIO, 90D, Optomap…)', { must: [['method', 'technique'], ['fundus', 'posterior', 'dfe', 'retina', 'retinal']] }, 'Posterior segment');
  add('fundus_notes', 'Fundus / posterior segment notes', { must: [['fundus', 'posterior', 'dfe', 'retina'], ['note', 'notes', 'comments']] }, 'Posterior segment');
  add('dilation_agent', 'Dilation drops used (e.g. tropicamide 1%)', { must: [['dilation', 'dilated', 'dilate', 'dilating', 'mydriatic', 'mydriasis']], not: ['consent', 'post', 'after'] }, 'Posterior segment');
  add('dilation_consent', 'Informed consent for dilation obtained (checkbox)', { must: [['consent'], ['dilation', 'dilated', 'dilate', 'dilating']], kind: 'checkbox' }, 'Posterior segment');

  // Tests done
  add('tests_photos', 'Fundus / retinal photos taken (checkbox)', { must: [['photos', 'photo', 'photography', 'photographs'], ['taken', 'done']], kind: 'checkbox' }, 'Tests done');
  add('tests_oct', 'OCT done (checkbox)', { must: [['oct']], kind: 'checkbox' }, 'Tests done');
  add('tests_vf', 'Visual field test done (checkbox)', { must: [['vf', 'vfs', 'visual field', 'visual fields', 'perimetry']], kind: 'checkbox' }, 'Tests done');

  // Assessment / plan
  add('assessment', 'Assessment / diagnosis', { must: [['assessment', 'diagnosis', 'impression']], not: ['fit', 'fitting'] }, 'Assessment & plan');
  add('plan', 'Plan / recommendations', { must: [['plan', 'recommendation', 'recommendations']] }, 'Assessment & plan');
  add('follow_up', 'Follow-up / return to clinic (e.g. 1 year)', { must: [['follow', 'follow-up', 'followup', 'f/u', 'rtc', 'return', 'recall']] }, 'Assessment & plan');
  add('referral', 'Referral (to whom and why)', { must: [['referral', 'refer', 'referred', 'referring']] }, 'Assessment & plan');
  add('notes_general', 'Other clinical notes not covered by any field above', {}, 'Other');

  // Modifier boxes ("−2", "+1") that some EMRs put right after a VA box. Not part of the schema the AI fills:
  // OptoFill splits a value like "20/50-2" between the VA box and its modifier box when both are set up.
  const MODS = S.filter(s => /^(va_|rx_va_)/.test(s.key))
    .map(s => ({ key: `${s.key}_mod`, label: `${s.label} — modifier (e.g. −2)`, group: s.group, modifierOf: s.key }));

  root.OPTOFILL_SCHEMA = S;
  root.OPTOFILL_MODIFIERS = MODS;
  root.OPTOFILL_WORDS = W;   // shared word groups, so auto-map can tell rival groups apart (corrected vs uncorrected, distance vs near)
  root.OPTOFILL_FAMILIES = FAMILIES;
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
})(typeof self !== 'undefined' ? self : globalThis);
