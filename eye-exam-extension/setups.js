// Ready-made setups: for each EMR OptoFill knows, what its boxes are, from a setup a doctor set up and checked there
// and exported (side panel → Export setup). The first time an EMR with nothing set up is open in the side panel, the
// page is asked which of these it is, by its screen labels (row, column, label and headings of the boxes; never the
// address, which can differ between practices), and that setup is loaded (content.js, adoptReadySetup).
// Each entry holds labels only: no page address, no selectors, no patient data.
// Add or update one with: node core/setups/add.js optofill-setup-….json --name "EMR name"
(function (root) {
  const SETUPS = [];
  root.OPTOFILL_SETUPS = SETUPS;
  if (typeof module !== 'undefined' && module.exports) module.exports = SETUPS;
})(typeof self !== 'undefined' ? self : globalThis);
