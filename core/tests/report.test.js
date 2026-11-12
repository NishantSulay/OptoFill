// Tests the layout report (buildReport in content.js) and its replay (core/tests/replay.js): a screen rebuilt from
// its report must auto-map exactly as the live screen does — otherwise a report can't stand in for the real EMR —
// and a report must never carry what is typed in the boxes.
// Usage: node core/tests/report.test.js   (needs `playwright`; set CHROME_PATH if no bundled browser)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { replay, savedMap } = require('./replay');

const ROOT = path.resolve(__dirname, '../..');
let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? '  → ' + detail : ''}`);
  if (!cond) failures++;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  await page.addInitScript(() => {
    const store = {};
    window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage() {} },
      storage: { local: { get: async () => ({ ...store }), set: async o => { Object.assign(store, JSON.parse(JSON.stringify(o))); } } } };
  });
  await page.goto('file://' + path.join(ROOT, 'core/mock-emr/index.html'));
  await page.addScriptTag({ path: path.join(ROOT, 'eye-exam-extension/schema.js') });
  await page.addScriptTag({ path: path.join(ROOT, 'eye-exam-extension/content.js') });

  for (const tab of ['pretest', 'refraction', 'contacts', 'health', 'plan']) {
    await page.click(`[data-tab=${tab}]`);
    await page.waitForTimeout(50);
    // Type something first: a report must not pick it up
    await page.evaluate(() => { const el = document.querySelector('.screen.on input[type=text], .screen.on textarea'); el.value = 'SECRET-VALUE-123'; });
    const { live, report } = await page.evaluate(async () => {
      const map = {};
      autoMapVisible(map);
      const fields = getAllFields(true);
      const live = Object.fromEntries(Object.entries(map).map(([k, e]) => [k, fields.find(f => lastScannedEls[f.index] === locateMapped(e, fields)).index]));
      await saveMap(map);
      return { live, report: await buildReport() };
    });
    const out = await replay(JSON.parse(JSON.stringify(report)), browser);
    const keys = [...new Set([...Object.keys(live), ...Object.keys(out.map)])];
    const name = i => (report.fields[i] ? report.fields[i].name : 'none');
    const diff = keys.filter(k => live[k] !== out.map[k]).map(k => `${k}: live ${name(live[k])}, replay ${name(out.map[k])}`);
    check(`${tab}: rebuilt from its report, all ${Object.keys(live).length} boxes map as on the live screen`, !diff.length, diff.join('; '));
    const saved = savedMap(report);
    const lost = Object.keys(live).filter(k => saved[k] !== live[k]);
    check(`${tab}: the report carries the saved setup`, !lost.length, lost.join(', '));
    check(`${tab}: the report has no typed values`, !JSON.stringify(report).includes('SECRET-VALUE-123'));
    await page.evaluate(() => { document.querySelectorAll('.screen.on input[type=text], .screen.on textarea').forEach(el => { el.value = ''; }); });
  }

  // A real EMR's Ocular Health screen in a narrow window (the side panel takes room): rows wrap, so the OS box
  // drops under its OD box and the next label moves up beside it. Labels must come from the page order there.
  const wrapped = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/wrapped-health.json'), 'utf8'));
  const got = (await replay(wrapped, browser)).map;
  const want = {
    sle_lids_od: 0, sle_lids_os: 1, sle_conj_od: 2, sle_conj_os: 3, sle_cornea_od: 4, sle_cornea_os: 5, sle_ac_od: 6, sle_ac_os: 7,
    sle_iris_od: 8, sle_iris_os: 9, sle_lens_od: 10, sle_lens_os: 11, sle_notes: 12,
    fundus_cd_od: 21, fundus_cd_v_od: 23, fundus_cd_os: 25, fundus_cd_v_os: 27, onh_sup_od: 22, onh_inf_os: 28,
    onh_rim_od: 29, onh_rim_os: 30, onh_color_od: 31, onh_color_os: 32, onh_margin_od: 33, onh_margin_os: 34, onh_depth_od: 35, onh_depth_os: 36,
    fundus_nerve_od: 37, fundus_nerve_os: 38, iop_od: 41, iop_os: 42, iop_method: 43, pach_od: 48, pach_os: 49,
    fundus_macula_od: 55, fundus_general_os: 58, fundus_vessels_od: 59, fundus_crossing_od: 61, fundus_crossing_os: 62, fundus_periphery_os: 66, fundus_notes: 67,
  };
  const wrong = Object.entries(want).filter(([k, i]) => got[k] !== i).map(([k, i]) => `${k}: got box ${got[k] ?? 'none'}, want ${i}`);
  check(`wrapped rows (real EMR layout): ${Object.keys(want).length - wrong.length}/${Object.keys(want).length} boxes mapped by page order`, !wrong.length, wrong.join('; '));
  const stray = Object.entries(got).filter(([, i]) => [20, 39, 40, 44, 45].includes(i)).map(([k, i]) => `${k}→${i}`);
  check('wrapped rows: note boxes and the IOP 2 row are left alone', !stray.length, stray.join(', '));

  // The same screen in a wide window, with a setup saved by an older OptoFill that had read the wrapped rows wrongly:
  // auto-map must correct the outdated mappings by itself, not leave the doctor to clear the setup
  const stale = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/stale-setup-health.json'), 'utf8'));
  check('outdated setup: starts with Cornea OS saved on the OD box and A/C OS on the Iris box', stale.map.sle_cornea_os.selector === '@4' && stale.map.sle_ac_os.selector === '@9' && !stale.map.sle_cornea_od);
  const healed = await replay(stale, browser, { fromSaved: true });
  const fixes = { sle_cornea_od: 4, sle_cornea_os: 5, sle_ac_od: 6, sle_ac_os: 7, sle_iris_od: 8, sle_iris_os: 9, pach_od: 48, pach_os: 49, iop_od: 41, fundus_crossing_od: 61 };
  const unfixed = Object.entries(fixes).filter(([k, i]) => healed.map[k] !== i).map(([k, i]) => `${k}: box ${healed.map[k] ?? 'none'}, want ${i}`);
  check(`outdated setup: auto-map corrects it (${healed.fixed} mappings) and keeps the right ones`, healed.fixed === 3 && !unfixed.length, `fixed ${healed.fixed}; ${unfixed.join('; ')}`);

  // The other screens of that EMR. Each is checked from an empty setup, and (where the fixture carries the setup an
  // older version saved) from that setup, which auto-map must bring to the same result.
  const screen = async (file, name, want, never) => {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'));
    const got = (await replay(fx, browser)).map;
    const wrong = Object.entries(want).filter(([k, i]) => got[k] !== i).map(([k, i]) => `${k}: got box ${got[k] ?? 'none'}, want ${i}`);
    check(`${name}: ${Object.keys(want).length - wrong.length}/${Object.keys(want).length} boxes mapped`, !wrong.length, wrong.join('; '));
    const stray = Object.entries(got).filter(([k, i]) => never(k, i)).map(([k, i]) => `${k}→${i}`);
    check(`${name}: nothing mapped where it does not belong`, !stray.length, stray.join(', '));
    if (!Object.keys(fx.map).length) return;
    const healed = await replay(fx, browser, { fromSaved: true });
    const differs = Object.keys(got).filter(k => healed.map[k] !== got[k]).map(k => `${k}: ${healed.map[k]} not ${got[k]}`);
    check(`${name}: an older saved setup is brought to the same mapping (${healed.fixed} corrected)`, healed.fixed > 0 && !differs.length, differs.join('; '));
  };
  // Pretest: "+ve fusional vergences" is the left column; a "Contacts" checkbox over the corrected-VA modifier boxes
  // does not make them contact lens boxes; the colour vision method is the drop-down, not an eye
  await screen('real-pretest.json', 'pretest (real EMR layout)', {
    chief_complaint: 0, va_dist_sc_od: 1, va_dist_sc_od_mod: 2, va_dist_cc_od: 9, va_dist_cc_od_mod: 10, va_dist_cc_os_mod: 12, va_near_cc_ou: 27,
    va_dist_glasses: 7, va_dist_contacts: 8, pupils_light_od: 30, pupils_apd_os: 39, cover_dist_eye: 43, cover_near_amount: 50,
    bv_pfv_dist: 59, bv_nfv_dist: 60, bv_pfv_near: 61, bv_nfv_near: 62, bv_amplitude_od: 63, bv_eoms_os: 68, bv_npc: 69,
    pd_dist_od: 74, pd_near_ou: 79, color_od: 82, color_os: 83, color_method: 84, stereo: 85, stereo_method: 86,
  }, k => /^(cl_|rx_|sle_)/.test(k));
  // Refraction: headingless "OD [ ][ ][ ]" grids are sphere/cyl/axis; each grid's drop-down names its refraction; the
  // manifest goes to the grid that says Subjective, not to "Optical RX"; the final Rx stays in Final 1
  await screen('real-refraction.json', 'refraction (real EMR layout)', {
    hrx_sph_od: 0, hrx_add_od: 3, hrx_prism_os: 14, kerato_k1_od: 46, kerato_k2_od: 47, kerato_k2_axis_od: 48, kerato_k1_os: 49,
    ar_sph_od: 66, ar_cyl_od: 67, ar_axis_os: 73, ret_sph_od: 77, ret_axis_os: 84,
    rx_sph_od: 88, rx_cyl_od: 89, rx_axis_od: 90, rx_va_od: 91, rx_va_od_mod: 92, rx_sph_os: 93, rx_va_os: 96, rx_add_od: 101, rx_add_os: 104,
    frx_sph_od: 109, frx_cyl_od: 110, frx_axis_od: 111, frx_add_od: 112, frx_prism_od: 113, frx_sph_os: 117, frx_add_os: 120,
  }, (k, i) => i >= 126 || /^(cl_|va_)/.test(k));
  // Contact lens: one lens stays in one panel (Current CLs, the first), and nothing here is a slit lamp or glasses box
  await screen('real-contact-lens.json', 'contact lens (real EMR layout)', {
    cl_brand_od: 1, cl_bc_od: 2, cl_dia_od: 3, cl_brand_os: 5, cl_sph_od: 8, cl_cyl_od: 9, cl_axis_od: 10, cl_add_od: 11,
    cl_sph_os: 12, cl_add_os: 15, cl_va_od: 22, cl_va_os: 24, cl_fit: 33,
  }, (k, i) => i >= 35 || !/^cl_/.test(k));

  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
