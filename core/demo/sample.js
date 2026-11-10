// The sample dictation and what the extraction step returns for it (schema keys → values). Synthetic data.
// Shared by the website video and store screenshots (lib.js) and the try-it page (demo.html), where it stands in for
// Claude's reply when no API key is entered.
(function (root) {
  const DICTATION = 'Distance vision without glasses, right eye 20/40, left 20/30 minus 1. Pupils PERRLA, no APD. ' +
    'Cover test ortho at distance, 2 prism diopters exophoria at near. Amplitude OD 6 centimeters, OS 5 centimeters. NPC 8 cm. ' +
    'PD 64 distance, 61 near. Color normal both eyes on Ishihara. Stereo 40 seconds with Randot.';
  const VALUES = {
    va_dist_sc_od: '20/40', va_dist_sc_os: '20/30-1', pupils_notes: 'PERRLA, no APD',
    cover_dist_direction: 'ortho', cover_near_direction: 'exo', cover_near_amount: '2',
    bv_amplitude_od: '6 cm', bv_amplitude_os: '5 cm', bv_npc: '8 cm', pd_dist_ou: '64', pd_near_ou: '61',
    color_od: 'normal', color_os: 'normal', color_method: 'Ishihara', stereo: '40"', stereo_method: 'Randot',
  };
  const api = { DICTATION, VALUES };
  root.OptoFillSample = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
