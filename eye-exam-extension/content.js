// content.js — field scanning, filling, and speech recognition

let recognition = null;   // the current dictation session; events from older (stopped or cleared) ones are ignored
let isRecording = false;   // the current session should keep listening (Chrome ends sessions on silence)
let finalTranscript = '';

function startRecording(existingTranscript) {
  discardRecognition();
  finalTranscript = existingTranscript || '';

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    chrome.runtime.sendMessage({ action: 'micError', error: 'Speech recognition not supported in Chrome.' });
    return;
  }

  const rec = new SR();
  recognition = rec;
  const current = () => recognition === rec;
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';

  rec.onstart = () => {
    if (!current()) return;
    // Recognition actually started — mic is live
    isRecording = true;
    chrome.runtime.sendMessage({ action: 'micStarted' });
  };

  rec.onresult = (event) => {
    if (!current()) return;
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalTranscript += t + ' ';
      else interim += t;
    }
    chrome.runtime.sendMessage({ action: 'transcriptUpdate', finalTranscript, interimTranscript: interim });
  };

  rec.onerror = (e) => {
    if (!current()) return;
    if (e.error === 'not-allowed') {
      isRecording = false;
      // Watch for permission to be granted, then auto-restart
      navigator.permissions.query({ name: 'microphone' }).then(status => {
        if (status.state === 'granted') {
          // Already granted somehow — just retry immediately
          startRecording(finalTranscript);
        } else {
          // Watch for the user to click Allow
          status.onchange = () => {
            if (status.state === 'granted') {
              status.onchange = null;
              startRecording(finalTranscript);
            }
          };
        }
      }).catch(() => {});
    } else if (e.error !== 'no-speech') {
      chrome.runtime.sendMessage({ action: 'micError', error: e.error });
      isRecording = false;
    }
  };

  rec.onend = () => {
    if (!current()) return;
    if (isRecording) { try { rec.start(); } catch(e) {} }
    else { recognition = null; chrome.runtime.sendMessage({ action: 'micStopped' }); }
  };

  // Start directly - if mic permission needed Chrome will fire onerror('not-allowed')
  // If granted, onstart fires confirming recording is live
  try { rec.start(); } catch(e) {
    chrome.runtime.sendMessage({ action: 'micError', error: e.message });
  }
}

// Stop listening; Chrome still delivers the last words it heard, which belong to this dictation
function stopRecording() {
  isRecording = false;
  if (recognition) recognition.stop();
}

// Throw the current session away (Clear, or a new recording): words still in flight must not come back later
function discardRecognition() {
  isRecording = false;
  const rec = recognition;
  recognition = null;
  if (rec) { rec.onstart = rec.onresult = rec.onerror = rec.onend = null; try { rec.abort(); } catch(e) {} }
}

// Find question text for a radio/checkbox by searching wider DOM context
function getRadioQuestionText(el) {
  // Walk up the DOM looking for a field container, then find the question label inside it
  // This handles Gravity Forms, WPForms, and similar structures where the question label
  // is a sibling of the input container, not a direct parent/ancestor of the input itself.
  let node = el.parentElement;
  for (let i = 0; i < 8 && node && node !== document.body; i++) {
    // Look for a question label that is NOT a label[for=...] option label
    // Gravity Forms uses .gfield_label, WPForms uses .wpforms-field-label, etc.
    const questionLabel = node.querySelector(
      'label:not([for]), .gfield_label, .wpforms-field-label, .field-label, legend, .label-text'
    );
    if (questionLabel && !questionLabel.closest('ul,ol')) {
      const text = questionLabel.innerText.replace(/\*/g, '').trim();
      if (text.length > 2) return text;
    }
    // Also check: first label in container that isn't an option label
    const allLabels = Array.from(node.querySelectorAll('label'));
    const questionLbl = allLabels.find(l => !l.getAttribute('for') && l.innerText.trim().length > 2);
    if (questionLbl) {
      const text = questionLbl.innerText.replace(/\*/g, '').trim();
      if (text.length > 2) return text;
    }
    // Table row: sibling cells
    if (node.tagName === 'TR') {
      const cells = Array.from(node.querySelectorAll('td,th'));
      const textCell = cells.find(c => !c.contains(el) && c.innerText.trim().length > 2);
      if (textCell) return textCell.innerText.trim();
    }
    // Fieldset legend
    if (node.tagName === 'FIELDSET') {
      const leg = node.querySelector('legend');
      if (leg) return leg.innerText.replace(/\*/g, '').trim();
    }
    node = node.parentElement;
  }
  return '';
}
// ─── Page scanning ────────────────────────────────────────────────────────────

// Short visible text snippets with their on-screen boxes, used to label fields by layout
function getTextAnchors() {
  const anchors = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let n;
  while ((n = walker.nextNode())) {
    const text = n.textContent.replace(/\s+/g, ' ').trim();
    if (text.length < 2 || text.length > 40) continue;
    const p = n.parentElement;
    if (!p || p.closest('#optofill-setup-host, script, style, noscript, option, select, textarea')) continue;
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (getComputedStyle(p).visibility === 'hidden') continue;
    // A checkbox/radio's own label ("☐ Glasses") names that box, not a section of the form
    const option = !!(p.previousElementSibling?.matches?.('input[type=checkbox],input[type=radio]') ||
                      p.closest('label')?.querySelector('input[type=checkbox],input[type=radio]'));
    anchors.push({ text, r, node: p, option });
  }
  return anchors;
}

// The bordered panel/card a box sits in — labels from neighbouring panels must not leak in
const TABLE_TAGS = new Set(['TD', 'TH', 'TR', 'TBODY', 'THEAD', 'TFOOT', 'TABLE']);
function panelOf(el) {
  const f = el.getBoundingClientRect();
  for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    if (TABLE_TAGS.has(n.tagName)) continue;
    const s = getComputedStyle(n);
    const boxed = (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' &&
                   parseFloat(s.borderBottomWidth) > 0 && s.borderBottomStyle !== 'none') || s.boxShadow !== 'none';
    if (!boxed) continue;
    const r = n.getBoundingClientRect();
    if (r.height > f.height * 2.5 || r.width > f.width + 150) return n;
  }
  return null;
}

function getLayoutContext(el, anchors) {
  const f = el.getBoundingClientRect();
  if (!f.width || !f.height) return { row: '', col: '', context: '' };
  const panel = panelOf(el);
  if (panel) anchors = anchors.filter(a => panel.contains(a.node));
  const cy = a => (a.r.top + a.r.bottom) / 2;
  const cx = a => (a.r.left + a.r.right) / 2;

  // Row label: nearest text to the left on the same horizontal band
  let row = null;
  for (const a of anchors) {
    if (a.r.right > f.left + 2 || f.left - a.r.right > 400) continue;
    if (cy(a) < f.top - 4 || cy(a) > f.bottom + 4) continue;
    if (!row || a.r.right > row.r.right) row = a;
  }

  // Column header: nearest text directly above, horizontally within the field. Within a panel, look further up:
  // tall grids (slit lamp, fundus) have their OD/OS headers only at the top
  const colReach = panel ? 600 : 250;
  let col = null;
  for (const a of anchors) {
    if (a.r.bottom > f.top + 2 || f.top - a.r.bottom > colReach) continue;
    if (cx(a) < f.left - 4 || cx(a) > f.right + 4) continue;
    if (!col || a.r.bottom > col.r.bottom) col = a;
  }

  const skip = new Set([row?.text, col?.text]);
  const headingDist = a => (f.top - a.r.bottom) + 0.5 * Math.max(0, a.r.left - f.right, f.left - a.r.right);
  // Labels further left on the same line (e.g. "Stereoacuity  [ ]  Method Used [select]"), nearest first
  // Must line up with this row's own label, so a heading of a neighbouring column that happens to sit at this height
  // doesn't count
  const sameRow = !row ? [] : anchors
    .filter(a => a !== row && a.r.right <= row.r.left + 2 && row.r.left - a.r.right < 500 &&
                 Math.abs(cy(a) - cy(row)) < 4 && !skip.has(a.text))
    .sort((a, b) => b.r.right - a.r.right)
    .slice(0, 2);
  // Other rows' labels (lined up with this row's label, e.g. "OD:20/" above "OU:20/") aren't headings: skip them
  // and any other copy of their text, so they don't push the real headings out of the nearest 4
  const siblingRows = new Set(row ? anchors.filter(a => a !== row && Math.abs(a.r.left - row.r.left) < 6 && a.r.bottom <= row.r.top + 2)
                                          .map(a => a.text) : []);
  // Nearby headings above, nearest first (e.g. "Near Vision", "BV Vergences")
  const above = anchors
    .filter(a => a.r.bottom <= f.top + 2 && f.top - a.r.bottom < 300 && !a.option &&
                 a.r.right >= f.left - 400 && a.r.left <= f.right + 50 && !skip.has(a.text) && !siblingRows.has(a.text))
    // Nearest first: distance above, plus half the sideways gap (a heading right over the box beats one off to the side)
    .sort((a, b) => headingDist(a) - headingDist(b))
    .filter((a, i, arr) => arr.findIndex(x => x.text === a.text) === i)   // de-duplicate before taking the nearest 4
    .slice(0, 4);
  // The panel's title (its top-left text, e.g. "Pupils", "Color Vision"), which busy grids push out of range
  const title = panel && anchors.filter(a => a.r.bottom <= f.top + 2)
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)[0];
  const context = [...sameRow, ...above, ...(title ? [title] : [])]
    .map(a => a.text)
    .filter((t, i, arr) => !skip.has(t) && arr.indexOf(t) === i)
    .join(' / ');

  // Text straight after the box on the same line: a checkbox's own label ("☐ Glasses ☐ Contacts")
  const after = anchors
    .filter(a => a.r.left >= f.right - 2 && a.r.left - f.right < 60 && Math.abs(cy(a) - (f.top + f.bottom) / 2) < Math.max(6, f.height))
    .sort((a, b) => a.r.left - b.r.left)[0];

  return { row: row?.text || '', col: col?.text || '', context, after: after?.text || '' };
}

function isVisibleField(el) {
  if (!el || !el.isConnected) return false;
  const style = window.getComputedStyle(el);
  return !(style.display === 'none' || style.visibility === 'hidden' || el.offsetParent === null);
}

// Elements from the most recent scan, by index — fills target these exact elements
let lastScannedEls = [];

const FIELD_SELECTOR = [
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
  'textarea', 'select'
].join(', ');

// How many fillable boxes this frame shows. The popup asks every frame and uses the one with the most,
// so an exam form inside an iframe is found. No side effects: a Quick fill scan may be in progress.
function countVisibleFields() {
  if (!innerWidth || !innerHeight) return 0;
  return Array.from(document.querySelectorAll(FIELD_SELECTOR))
    .filter(el => !el.closest('#optofill-setup-host') && isVisibleField(el)).length;
}

function getAllFields(withLayout) {
  const anchors = withLayout ? getTextAnchors() : null;
  const fields = [], els = [], seen = new Set();
  document.querySelectorAll(FIELD_SELECTOR).forEach((el, rawIndex) => {
    if (el.closest('#optofill-setup-host')) return;
    if (!isVisibleField(el)) return;
    if (seen.has(el)) return;
    seen.add(el);
    const id=el.id||'', name=el.name||'', placeholder=el.placeholder||'';
    const type=el.type||el.tagName.toLowerCase();
    let label='';
    if (el.getAttribute('aria-label')) label=el.getAttribute('aria-label');
    else if (id) { const l=document.querySelector(`label[for="${CSS.escape(id)}"]`); if(l) label=l.innerText.trim(); }
    if (!label) { const p=el.closest('label'); if(p) label=p.innerText.replace(el.value||'','').trim(); }
    if (!label&&el.getAttribute('aria-labelledby')) { const r=document.getElementById(el.getAttribute('aria-labelledby')); if(r) label=r.innerText.trim(); }
    if (!label) { const prev=el.previousElementSibling; if(prev&&['LABEL','SPAN','P','DIV','TH','LEGEND'].includes(prev.tagName)&&!prev.querySelector('input,select,textarea')) label=prev.innerText.trim(); }
    const layout = anchors ? getLayoutContext(el, anchors) : {};
    if (type==='radio'||type==='checkbox') {
      // No label[for]: the text right after the box is its own label ("☐ Glasses"); the element before it is
      // often the previous option's label, so it must not name this one
      const optionLabel = (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.innerText?.trim() : '') ||
                          el.closest('label')?.innerText?.trim() || layout.after || '';
      const question = getRadioQuestionText(el);
      const val = el.value && !['on','off','true','false','1','0'].includes(el.value.toLowerCase()) ? el.value : '';
      const option = optionLabel || val;
      if (question && option && question.toLowerCase() !== option.toLowerCase()) label = question + ' — ' + option;
      else if (option) label = option;
      else if (question) label = question;
    }
    if (!label) label=placeholder||name||id||`field_${rawIndex}`;
    const options=el.tagName==='SELECT'?Array.from(el.options).map(o=>({value:o.value,text:o.text.trim()})):[];
    fields.push({ index:fields.length, label:label.substring(0,80), name:name.substring(0,40), id:id.substring(0,40), type, placeholder:placeholder.substring(0,60), options, selector:buildSelector(el), ...layout });
    els.push(el);
  });
  lastScannedEls = els;
  return fields;
}

// Prefer #id / [name] only when they identify exactly one element — EMRs often reuse them
function buildSelector(el) {
  const unique = sel => { try { return document.querySelectorAll(sel).length === 1; } catch(e) { return false; } };
  if (el.id && unique(`#${CSS.escape(el.id)}`)) return `#${CSS.escape(el.id)}`;
  if (el.name) {
    const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
    if (unique(sel)) return sel;
  }
  let path='', node=el;
  while (node&&node!==document.body&&node.parentNode) {
    const tag=node.tagName.toLowerCase();
    const siblings=Array.from(node.parentNode.children).filter(c=>c.tagName===node.tagName);
    path=`${tag}:nth-of-type(${siblings.indexOf(node)+1})${path?' > '+path:''}`;
    node=node.parentNode;
  }
  return 'body > ' + path;
}

// ─── Setting, checking and undoing values ─────────────────────────────────────

const TRUE_WORDS = ['true','1','yes','checked','positive','present'];

function setElementValue(el, value) {
  const tag=el.tagName.toLowerCase(), type=(el.type||'').toLowerCase();
  if (tag==='select') {
    const v=String(value).toLowerCase();
    let found = false;
    for (const opt of el.options) {
      if (opt.value.toLowerCase()===v||opt.text.toLowerCase()===v) { el.value=opt.value; found=true; break; }
    }
    if (!found) for (const opt of el.options) {
      const t = opt.text.toLowerCase();
      if (t && (t.includes(v)||v.includes(t))) { el.value=opt.value; found=true; break; }
    }
    if (!found) throw new Error(`No option matching "${value}"`);
    ['input','change'].forEach(e=>el.dispatchEvent(new Event(e,{bubbles:true})));
  } else if (type==='radio') {
    if (TRUE_WORDS.includes(String(value).toLowerCase()) && !el.checked) {
      el.checked = true;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } else if (type==='checkbox') {
    const shouldCheck = TRUE_WORDS.includes(String(value).toLowerCase());
    if (el.checked !== shouldCheck) {
      const lbl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      (lbl || el).click();
      if (el.checked !== shouldCheck) {
        el.checked = shouldCheck;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  } else {
    setNativeValue(el, String(value));
    ['input','change','blur'].forEach(e=>el.dispatchEvent(new Event(e,{bubbles:true})));
  }
}

function setNativeValue(el, v) {
  const proto = el.tagName==='TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter ? setter.call(el, v) : (el.value = v);
}

function valueMatches(el, value) {
  const tag=el.tagName.toLowerCase(), type=(el.type||'').toLowerCase();
  if (type==='checkbox') return el.checked === TRUE_WORDS.includes(String(value).toLowerCase());
  if (type==='radio') return !TRUE_WORDS.includes(String(value).toLowerCase()) || el.checked;
  if (tag==='select') {
    const opt = el.selectedOptions[0];
    const v = String(value).toLowerCase();
    return !!opt && (opt.value.toLowerCase()===v || opt.text.toLowerCase().includes(v) || v.includes(opt.text.toLowerCase()));
  }
  return el.value.trim() === String(value).trim();
}

function snapshot(el) { return { value: el.value, checked: el.checked, selectedIndex: el.selectedIndex }; }

function restore(el, s) {
  if (!el.isConnected) return;
  const tag=el.tagName.toLowerCase(), type=(el.type||'').toLowerCase();
  if (type==='checkbox'||type==='radio') {
    if (el.checked !== s.checked) { el.checked = s.checked; el.dispatchEvent(new Event('change', { bubbles: true })); }
    return;
  }
  if (tag==='select') el.selectedIndex = s.selectedIndex;
  else setNativeValue(el, s.value);
  ['input','change','blur'].forEach(e=>el.dispatchEvent(new Event(e,{bubbles:true})));
}

function flash(el) {
  el.style.transition='outline 0.3s, background 0.3s';
  el.style.outline='2px solid #2dd4bf';
  el.style.background='rgba(45,212,191,0.08)';
  setTimeout(()=>{ el.style.outline=''; el.style.background=''; },1800);
}

const undoStack = [];   // each entry: [{ el, snap }] for one Fill Fields click
const sleep = ms => new Promise(r => setTimeout(r, ms));

// items: [{ el, value, info }] → results [{ ...info, value, ok, reason }]
async function applyFills(items, { mergeIntoLast = false } = {}) {
  const snaps = [];
  const results = items.map(({ el, value, info }) => {
    snaps.push({ el, snap: snapshot(el) });
    try {
      setElementValue(el, value);
      flash(el);
      const ok = valueMatches(el, value);
      return { ...info, value, ok, reason: ok ? '' : 'The page did not accept the value' };
    } catch(e) {
      return { ...info, value, ok: false, reason: e.message };
    }
  });
  // Re-check after the page has had a chance to react — some EMRs re-render and wipe script-set values
  await sleep(400);
  results.forEach((r, i) => {
    if (!r.ok) return;
    const el = items[i].el;
    if (!el.isConnected || !isVisibleField(el)) { r.ok = false; r.reason = 'The box disappeared after filling'; }
    else if (!valueMatches(el, items[i].value)) { r.ok = false; r.reason = 'The page reverted the value'; }
  });
  if (snaps.length) {
    if (mergeIntoLast && undoStack.length) undoStack[undoStack.length - 1].push(...snaps);
    else undoStack.push(snaps);
  }
  return results;
}

function undoLastFill() {
  const entry = undoStack.pop();
  pendingSchema = {};
  lastFill = null;
  if (!entry) return 0;
  for (let i = entry.length - 1; i >= 0; i--) restore(entry[i].el, entry[i].snap);
  return entry.length;
}

// ─── Per-EMR mapping (schema key → box) ──────────────────────────────────────

const MAPS_KEY = 'optofillMaps';
const SCHEMA = self.OPTOFILL_SCHEMA || [];
const MODIFIERS = self.OPTOFILL_MODIFIERS || [];          // VA modifier boxes, set up like schema keys but never sent to the AI
const ALL_KEYS = [...SCHEMA, ...MODIFIERS];
const SCHEMA_BY_KEY = Object.fromEntries(ALL_KEYS.map(s => [s.key, s]));

async function loadMap() {
  const data = await chrome.storage.local.get(MAPS_KEY);
  return (data[MAPS_KEY] || {})[location.origin] || {};
}

async function saveMap(map) {
  const data = await chrome.storage.local.get(MAPS_KEY);
  const all = data[MAPS_KEY] || {};
  all[location.origin] = map;
  await chrome.storage.local.set({ [MAPS_KEY]: all });
}

// A key's display label: built-in fields from the schema, the doctor's own labels from the EMR's setup
function keyLabel(key, map) {
  return SCHEMA_BY_KEY[key]?.label || map?.[key]?.customLabel || key;
}

// The doctor's own fields on this EMR (boxes they labelled in setup), for the AI to fill like schema keys
function customFieldsOf(map) {
  return Object.entries(map).filter(([, e]) => e.custom).map(([key, e]) => ({ key, label: e.customLabel, type: e.type || 'text' }));
}

function mappingEntry(el, f) {
  return {
    selector: f.selector, name: f.name, id: f.id, label: f.label, row: f.row || '', col: f.col || '', context: f.context || '',
    stripPrefix: /20\/$/.test(f.row || '') ? '20/' : ''
  };
}

// Find the box for a saved mapping among the currently visible fields
function locateMapped(entry, fields) {
  try {
    const hits = Array.from(document.querySelectorAll(entry.selector)).filter(isVisibleField);
    if (hits.length === 1 && lastScannedEls.includes(hits[0])) return hits[0];
  } catch(e) {}
  const cands = fields.filter(f => f.row === entry.row && f.col === entry.col && f.label === entry.label &&
                                   (!entry.name || f.name === entry.name));
  if (cands.length === 1) return lastScannedEls[cands[0].index];
  if (cands.length > 1) {
    const exact = cands.filter(f => f.context === entry.context);
    if (exact.length === 1) return lastScannedEls[exact[0].index];
  }
  return null;
}

function formatForBox(entry, value) {
  return entry.stripPrefix && String(value).startsWith(entry.stripPrefix) ? String(value).slice(entry.stripPrefix.length) : value;
}

let pendingSchema = {};   // mapped values whose box isn't on screen yet (e.g. another EMR tab)
let lastFill = null;      // results of the last fill, kept up to date as waiting values fill — the popup shows them on reopen

// "20/50-2" → ["20/50", "-2"]: a trailing letter-count modifier, split off when the VA box has a modifier box set up
function splitModifier(value) {
  const m = String(value).match(/^(.*\d)\s*([+-])\s*(\d{1,2})$/);
  return m && /\/\s*\d+$/.test(m[1]) ? [m[1], m[2] + m[3]] : null;
}

// values: { schemaKey: value } → [{ key, label, value, status, reason }]
async function fillSchema(input, { mergeIntoLast = false } = {}) {
  const map = await loadMap();
  const values = {};
  for (const [key, value] of Object.entries(input)) {
    const parts = map[`${key}_mod`] && splitModifier(value);
    if (parts) { values[key] = parts[0]; values[`${key}_mod`] = parts[1]; }
    else values[key] = value;
  }
  const fields = getAllFields(true);
  const items = [], out = [], usedEls = new Set();
  for (const [key, value] of Object.entries(values)) {
    const label = keyLabel(key, map);
    const entry = map[key];
    if (!entry) { out.push({ key, label, value, status: 'unmapped', reason: 'Not set up on this EMR yet' }); continue; }
    const el = locateMapped(entry, fields);
    if (!el || usedEls.has(el)) { pendingSchema[key] = value; out.push({ key, label, value, status: 'pending', reason: 'Box is not on screen — it will fill when you open its tab' }); continue; }
    usedEls.add(el);
    items.push({ el, value: formatForBox(entry, value), info: { key, label } });
  }
  const filled = await applyFills(items, { mergeIntoLast });
  for (const r of filled) {
    delete pendingSchema[r.key];
    out.push({ key: r.key, label: r.label, value: r.value, status: r.ok ? 'filled' : 'failed', reason: r.reason });
  }
  if (!mergeIntoLast) lastFill = out;
  return out;
}

async function fillPending() {
  if (!Object.keys(pendingSchema).length) return [];
  const map = await loadMap();
  const fields = getAllFields(true);
  const ready = {};
  for (const [key, value] of Object.entries(pendingSchema)) {
    if (map[key] && locateMapped(map[key], fields)) ready[key] = value;
  }
  if (!Object.keys(ready).length) return [];
  const results = await fillSchema(ready, { mergeIntoLast: true });
  if (lastFill) {
    for (const r of results) { const i = lastFill.findIndex(x => x.key === r.key); if (i >= 0) lastFill[i] = r; }
    // Let an open popup swap its ⏳ for ✓; nobody may be listening, which is fine
    try { chrome.runtime.sendMessage({ action: 'fillUpdated', results: lastFill })?.catch?.(() => {}); } catch(e) {}
  }
  return results;
}

// Quick fill (EMR not set up): mapping is { fieldIndex: value } from the last scan
async function fillByIndex(mapping) {
  const items = [];
  for (const [idx, value] of Object.entries(mapping)) {
    const el = lastScannedEls[parseInt(idx)];
    if (el && el.isConnected) items.push({ el, value, info: { idx } });
  }
  const results = await applyFills(items);
  const missing = Object.keys(mapping).filter(idx => !results.some(r => r.idx === idx))
    .map(idx => ({ idx, value: mapping[idx], ok: false, reason: 'The box is no longer on the page' }));
  return [...results, ...missing];
}

// ─── Auto-suggest: score how well a schema key fits a box ─────────────────────

const EYE_WORDS = { od: ['od', 'right', 're', 'r'], os: ['os', 'left', 'le', 'l'], ou: ['ou', 'both'] };

function normText(t) {
  const s = String(t || '').toLowerCase();
  const a = s.replace(/[^a-z0-9+\-\/.]+/g, ' ').trim();
  const b = s.replace(/[^a-z0-9+\-.]+/g, ' ').trim();
  return ` ${a} | ${b} `;
}
const hasToken = (text, token) => text.includes(` ${token} `);

// Word groups that exclude each other (schema.js shares these arrays between keys, so they're matched by identity)
const RIVALS = new Map();
{
  const W = self.OPTOFILL_WORDS;
  if (W) for (const [a, b] of [['sc', 'cc'], ['dist', 'near']]) { RIVALS.set(W[a], W[b]); RIVALS.set(W[b], W[a]); }
}

function scoreKey(entry, f) {
  if (!entry.must || !entry.must.length) return 0;
  const own = normText([f.label, f.row, f.col, f.placeholder].join(' | '));
  const sources = [own, ...String(f.context || '').split(' / ').filter(Boolean).map(normText)];
  if (entry.not && entry.not.some(t => hasToken(own, t))) return 0;
  // Checkbox fields only go to checkboxes, and other fields never do
  if ((entry.kind === 'checkbox') !== (f.type === 'checkbox')) return 0;
  let score = 0;
  if (entry.eye) {
    if (!EYE_WORDS[entry.eye].some(t => hasToken(own, t))) return 0;
    for (const [eye, words] of Object.entries(EYE_WORDS)) {
      // "OD/OU" boxes are the OD box when the field has no OU variant (e.g. colour vision)
      if (eye === 'ou' && entry.eye === 'od' && !SCHEMA_BY_KEY[entry.key.replace(/_od$/, '_ou')]) continue;
      if (eye !== entry.eye && words.some(t => hasToken(own, t))) return 0;
    }
    score += 10;
  }
  for (const group of entry.must) {
    const pos = sources.findIndex(s => group.some(t => hasToken(s, t)));
    if (pos < 0) return 0;
    // Corrected vs uncorrected, distance vs near: the nearer label decides ("Uncorrected" right above beats
    // a "Corrected" heading further away)
    const rival = RIVALS.get(group);
    if (rival) {
      const rpos = sources.findIndex(s => rival.some(t => hasToken(s, t)));
      if (rpos >= 0 && rpos < pos) return 0;
    }
    score += 10 - Math.min(pos, 9);
  }
  return score;
}

// Suggest keys for every visible, unmapped box; each key and each box used once
function autoMapVisible(map) {
  const fields = getAllFields(true);
  const taken = new Set(Object.values(map).map(e => locateMapped(e, fields)).filter(Boolean));
  const cands = [];
  fields.forEach(f => {
    const el = lastScannedEls[f.index];
    if (taken.has(el)) return;
    const r = el.getBoundingClientRect();
    for (const s of SCHEMA) {
      if (map[s.key]) continue;
      const score = scoreKey(s, f);
      if (score > 0) cands.push({ score, f, el, key: s.key, top: r.top, left: r.left });
    }
  });
  cands.sort((a, b) => b.score - a.score || a.top - b.top || a.left - b.left);
  let added = 0;
  const usedEls = new Set(taken);
  for (const c of cands) {
    if (map[c.key] || usedEls.has(c.el)) continue;
    map[c.key] = mappingEntry(c.el, c.f);
    usedEls.add(c.el);
    added++;
  }
  // VA modifier boxes: the box straight after a mapped VA box on the same row
  for (const mod of MODIFIERS) {
    if (map[mod.key] || !map[mod.modifierOf]) continue;
    const vaEl = locateMapped(map[mod.modifierOf], fields);
    const f = vaEl && fields.find(f => !usedEls.has(lastScannedEls[f.index]) && isModifierBoxOf(lastScannedEls[f.index], vaEl));
    if (!f) continue;
    map[mod.key] = mappingEntry(lastScannedEls[f.index], f);
    usedEls.add(lastScannedEls[f.index]);
    added++;
  }
  return added;
}

// A small text box right after the VA box on the same line, with nothing in between: where EMRs put "−2" / "+1"
function isModifierBoxOf(el, vaEl) {
  if (el === vaEl || el.tagName !== 'INPUT' || !['text', 'number', ''].includes(el.type)) return false;
  const a = vaEl.getBoundingClientRect(), b = el.getBoundingClientRect();
  return Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 6 && b.left >= a.right - 2 && b.left - a.right < 40;
}

// ─── Setup mode (in-page) ─────────────────────────────────────────────────────

let setup = null;

const SETUP_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .bar { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); pointer-events: auto; z-index: 3;
         background: #fff; border: 1.5px solid #2563eb; border-radius: 10px; box-shadow: 0 6px 24px rgba(15,23,42,.18);
         padding: 8px 10px 8px 14px; display: flex; align-items: center; gap: 10px; font-size: 13px; color: #0f172a; max-width: calc(100vw - 32px); }
  .bar b { color: #2563eb; }
  .msg { color: #475569; font-size: 12px; }
  button { font: inherit; font-size: 12px; font-weight: 600; border-radius: 6px; padding: 6px 10px; cursor: pointer; border: 1.5px solid #e2e8f0; background: #fff; color: #334155; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  .box { position: fixed; pointer-events: none; border: 2px dashed #2563eb; border-radius: 3px; z-index: 1; }
  .box.mapped { border: 2px solid #059669; background: rgba(5,150,105,.06); }
  .tag { position: absolute; left: -2px; bottom: 100%; background: #059669; color: #fff; font-size: 10px; font-weight: 600;
         padding: 1px 5px; border-radius: 3px 3px 0 0; white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
  .picker { position: fixed; pointer-events: auto; z-index: 4; width: 320px; max-height: 380px; display: flex; flex-direction: column;
            background: #fff; border: 1.5px solid #cbd5e1; border-radius: 10px; box-shadow: 0 10px 30px rgba(15,23,42,.25); }
  .picker[hidden] { display: none; }
  .ph { padding: 10px 10px 6px; font-size: 12px; color: #475569; border-bottom: 1px solid #e2e8f0; }
  .ph .where { color: #0f172a; font-weight: 600; margin-bottom: 6px; }
  .ph input { width: 100%; padding: 7px 9px; border: 1.5px solid #cbd5e1; border-radius: 6px; font-size: 13px; outline: none; }
  .ph input:focus { border-color: #2563eb; }
  .list { overflow-y: auto; padding: 4px 0; }
  .sec { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #94a3b8; padding: 8px 12px 3px; }
  .opt { display: block; width: 100%; text-align: left; border: 0; border-radius: 0; padding: 6px 12px; font-weight: 400; font-size: 13px; color: #0f172a; }
  .opt:hover, .opt:focus { background: #eff6ff; outline: none; }
  .opt.suggested { color: #1d4ed8; font-weight: 600; }
  .pf { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid #e2e8f0; }
  .pf button { flex: 1; }
`;

async function startSetup() {
  if (setup) return;
  const host = document.createElement('div');
  host.id = 'optofill-setup-host';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${SETUP_CSS}</style>
    <div class="bar">
      <span><b>OptoFill setup</b> — click any box to tell OptoFill what it is.</span>
      <span class="msg"></span>
      <button class="auto">Auto-map this screen</button>
      <button class="reset">Clear all</button>
      <button class="primary done">Done</button>
    </div>
    <div class="layer"></div>
    <div class="picker" hidden>
      <div class="ph"><div class="where"></div><input type="text" placeholder="Search, e.g. amplitude OD"></div>
      <div class="list"></div>
      <div class="pf"><button class="unmap">Remove mapping</button><button class="cancel">Cancel</button></div>
    </div>`;
  document.documentElement.appendChild(host);
  setup = { host, root, map: await loadMap(), fields: [], current: null };

  root.querySelector('.done').addEventListener('click', stopSetup);
  root.querySelector('.auto').addEventListener('click', async () => {
    const n = autoMapVisible(setup.map);
    await saveMap(setup.map);
    renderSetup(`Auto-mapped ${n} box${n === 1 ? '' : 'es'} — check the green labels and click any box to fix it.`);
  });
  root.querySelector('.reset').addEventListener('click', async () => {
    const n = Object.keys(setup.map).length;
    if (!n) { renderSetup('Nothing is mapped on this site yet.'); return; }
    if (!confirm(`Remove all ${n} box mapping${n === 1 ? '' : 's'} OptoFill saved for ${location.host}?`)) return;
    setup.map = {};
    await saveMap(setup.map);
    renderSetup('Cleared — click boxes or use Auto-map to start again.');
  });
  root.querySelector('.cancel').addEventListener('click', closePicker);
  root.querySelector('.unmap').addEventListener('click', async () => {
    const key = setup.current && keyForEl(setup.current.el);
    if (key) { delete setup.map[key]; await saveMap(setup.map); }
    closePicker(); renderSetup();
  });
  root.querySelector('.ph input').addEventListener('input', renderPickerList);

  document.addEventListener('mousedown', onSetupPointer, true);
  document.addEventListener('click', onSetupPointer, true);
  document.addEventListener('keydown', onSetupKey, true);
  window.addEventListener('scroll', onSetupMove, true);
  window.addEventListener('resize', onSetupMove);
  setup.timer = setInterval(() => { if (!setup.current) renderSetup(); }, 1000);
  renderSetup();
}

function stopSetup() {
  if (!setup) return;
  clearInterval(setup.timer);
  document.removeEventListener('mousedown', onSetupPointer, true);
  document.removeEventListener('click', onSetupPointer, true);
  document.removeEventListener('keydown', onSetupKey, true);
  window.removeEventListener('scroll', onSetupMove, true);
  window.removeEventListener('resize', onSetupMove);
  setup.host.remove();
  setup = null;
}

let moveTimer = null;
function onSetupMove() { clearTimeout(moveTimer); moveTimer = setTimeout(() => setup && renderSetup(), 60); }

function onSetupKey(e) {
  if (!setup) return;
  if (e.key === 'Escape') { e.stopPropagation(); setup.current ? closePicker() : stopSetup(); }
}

function onSetupPointer(e) {
  if (!setup || e.composedPath().includes(setup.host)) return;
  const el = e.target.closest?.('input, select, textarea');
  if (!el) return;   // let tab/accordion clicks through so other EMR screens can be set up too
  let idx = lastScannedEls.indexOf(el);
  if (idx < 0) { renderSetup(); idx = lastScannedEls.indexOf(el); }
  if (idx < 0) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.type === 'click') openPicker(el, setup.fields[idx]);
}

function keyForEl(el) {
  return Object.keys(setup.map).find(k => locateMapped(setup.map[k], setup.fields) === el);
}

function renderSetup(message) {
  if (!setup) return;
  setup.fields = getAllFields(true);
  const layer = setup.root.querySelector('.layer');
  layer.textContent = '';
  const elToKey = new Map();
  for (const [key, entry] of Object.entries(setup.map)) {
    const el = locateMapped(entry, setup.fields);
    if (el) elToKey.set(el, key);
  }
  let unmapped = 0;
  setup.fields.forEach(f => {
    const el = lastScannedEls[f.index];
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return;
    const key = elToKey.get(el);
    const box = document.createElement('div');
    box.className = 'box' + (key ? ' mapped' : '');
    box.style.cssText = `left:${r.left - 2}px;top:${r.top - 2}px;width:${r.width + 4}px;height:${r.height + 4}px;`;
    if (key) {
      const tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = keyLabel(key, setup.map).replace(/\s*\([^)]*\)/g, '').replace(/^Visual acuity /, 'VA ');
      box.appendChild(tag);
    } else unmapped++;
    layer.appendChild(box);
  });
  const msg = setup.root.querySelector('.msg');
  if (message) { msg.textContent = message; setup.message = message; }
  else msg.textContent = setup.message || `${Object.keys(setup.map).length} mapped on this EMR · ${unmapped} unmapped on screen`;
}

function openPicker(el, f) {
  setup.current = { el, f };
  const p = setup.root.querySelector('.picker');
  const where = [f.row, f.col].filter(Boolean).join(' · ') || f.label;
  const key = keyForEl(el);
  p.querySelector('.where').textContent = key ? `${where} — currently: ${keyLabel(key, setup.map)}` : `What is this box? (${where}) — pick a field, or type your own label`;
  p.querySelector('.unmap').style.display = key ? '' : 'none';
  const input = p.querySelector('input');
  input.value = '';
  // A box right after a set-up VA box is suggested as its modifier box first
  const mods = MODIFIERS.filter(m => { const va = setup.map[m.modifierOf] && locateMapped(setup.map[m.modifierOf], setup.fields);
                                       return va && isModifierBoxOf(el, va); }).map(m => ({ s: m, score: 1000 }));
  setup.suggested = [...mods, ...SCHEMA.map(s => ({ s, score: scoreKey(s, f) }))].filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score).slice(0, 6).map(x => x.s.key);
  renderPickerList();
  p.hidden = false;
  const r = el.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.left), innerWidth - 330);
  const top = r.bottom + 390 < innerHeight ? r.bottom + 6 : Math.max(8, r.top - 386);
  p.style.left = left + 'px';
  p.style.top = top + 'px';
  input.focus();
}

function renderPickerList() {
  const list = setup.root.querySelector('.list');
  const q = setup.root.querySelector('.ph input').value.toLowerCase().trim();
  const words = q.split(/\s+/).filter(Boolean);
  const match = s => words.every(w => (s.label + ' ' + s.key + ' ' + (s.group || '')).toLowerCase().includes(w));
  list.textContent = '';
  const currentKey = keyForEl(setup.current.el);
  const addSection = (title, items, cls) => {
    if (!items.length) return;
    const h = document.createElement('div'); h.className = 'sec'; h.textContent = title; list.appendChild(h);
    for (const s of items) {
      const b = document.createElement('button');
      b.className = 'opt' + (cls ? ' ' + cls : '');
      b.textContent = s.key === currentKey ? `✓ ${s.label} (current)`
        : s.label + (setup.map[s.key] ? '  (mapped elsewhere — will move here)' : '');
      b.addEventListener('click', () => assignKey(s.key));
      list.appendChild(b);
    }
  };
  // Typed text that isn't one of OptoFill's fields becomes the box's own label
  const typed = setup.root.querySelector('.ph input').value.trim();
  if (typed) {
    const h = document.createElement('div'); h.className = 'sec'; h.textContent = 'Your own label'; list.appendChild(h);
    const b = document.createElement('button');
    b.className = 'opt suggested';
    b.textContent = `➕ Use “${typed}” as this box's label`;
    b.addEventListener('click', () => assignCustom(typed));
    list.appendChild(b);
  }
  const mine = customFieldsOf(setup.map).map(c => ({ key: c.key, label: `${c.label} (your label)` })).filter(match);
  const suggested = setup.suggested.map(k => SCHEMA_BY_KEY[k]).filter(match);
  addSection('Suggested', suggested, 'suggested');
  addSection('Your labels on this EMR', mine);
  const groups = {};
  for (const s of ALL_KEYS) if (match(s) && !suggested.includes(s)) (groups[s.group || 'Other'] ||= []).push(s);
  for (const [g, items] of Object.entries(groups)) addSection(g, items);
}

// Labels the box with the doctor's own name for it (e.g. "Habitual Rx"): a custom field on this EMR that the AI
// fills from the dictation like any other field
async function assignCustom(text) {
  const label = text.replace(/\s+/g, ' ').trim().slice(0, 60);
  const base = 'custom_' + (label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'field');
  const existing = Object.keys(setup.map).find(k => setup.map[k].custom && setup.map[k].customLabel.toLowerCase() === label.toLowerCase());
  let key = existing || base;
  for (let i = 2; !existing && setup.map[key]; i++) key = `${base}_${i}`;
  await assignKey(key, { custom: true, customLabel: label, type: setup.current.f.type });
}

async function assignKey(key, extra) {
  const { el, f } = setup.current;
  const prev = keyForEl(el);
  if (prev) delete setup.map[prev];
  // Moving the doctor's own label to another box keeps its name
  const keep = setup.map[key]?.custom ? { custom: true, customLabel: setup.map[key].customLabel, type: f.type } : null;
  setup.map[key] = { ...mappingEntry(el, f), ...(extra || keep || {}) };
  await saveMap(setup.map);
  closePicker();
  setup.message = '';
  renderSetup();
}

function closePicker() {
  if (!setup) return;
  setup.current = null;
  setup.root.querySelector('.picker').hidden = true;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

function highlight(el) {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.style.transition = 'outline 0.2s, background 0.2s';
  el.style.outline = '3px solid #f87171';
  el.style.background = 'rgba(248,113,113,0.15)';
  setTimeout(() => { el.style.outline = '2px solid #2dd4bf'; el.style.background = 'rgba(45,212,191,0.08)'; }, 1200);
  setTimeout(() => { el.style.outline = ''; el.style.background = ''; }, 3000);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = p => p.then(sendResponse, e => sendResponse({ error: e.message }));
  switch (msg.action) {
    case 'getFields':      sendResponse({ fields: getAllFields(true) }); return true;
    case 'fillFields':     reply(fillByIndex(msg.mapping).then(filled => ({ filled }))); return true;
    case 'fillSchema':     reply(fillSchema(msg.values).then(results => ({ results }))); return true;
    case 'refillPending':  reply(fillPending().then(results => ({ results }))); return true;
    case 'undoFill':       sendResponse({ restored: undoLastFill(), undoDepth: undoStack.length }); return true;
    case 'getStatus':      reply(loadMap().then(map => ({ mappedCount: Object.keys(map).length, undoDepth: undoStack.length, origin: location.origin, lastFill, customFields: customFieldsOf(map) }))); return true;
    case 'forgetLastFill': lastFill = null; sendResponse({ ok: true }); return true;
    case 'startSetup':     startSetup(); sendResponse({ ok: true }); return true;
    case 'highlightField': {
      try { const el = document.querySelector(msg.selector); if (el) highlight(el); } catch(e) {}
      sendResponse({ ok: true }); return true;
    }
    case 'highlightKey':
      reply(loadMap().then(map => {
        const el = map[msg.key] && locateMapped(map[msg.key], getAllFields(true));
        if (el) highlight(el);
        return { ok: !!el };
      }));
      return true;
    case 'startRecording': startRecording(msg.existingTranscript); sendResponse({ ok: true }); return true;
    case 'stopRecording':  stopRecording(); sendResponse({ ok: true }); return true;
    case 'clearRecording': discardRecognition(); finalTranscript = ''; sendResponse({ ok: true }); return true;
    case 'requestMicPermission':
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => { stream.getTracks().forEach(t => t.stop()); })
        .catch(() => {});
      sendResponse({ ok: true }); return true;
  }
});

// ─── Multi-tab EMRs: fill mapped values when their tab opens ─────────────────

function watchForTabSwitches() {
  let timer = null;
  const later = (ms) => { clearTimeout(timer); timer = setTimeout(() => { fillPending().catch(() => {}); }, ms); };
  document.addEventListener('click', (e) => {
    if (!Object.keys(pendingSchema).length || setup) return;
    if (e.target.closest('[role="tab"], [role="button"], .tab, .nav-link, .nav-item, .step, button, a')) later(400);
  }, true);
  new MutationObserver((mutations) => {
    if (!Object.keys(pendingSchema).length || setup) return;
    const hasNewFields = mutations.some(m => Array.from(m.addedNodes).some(n =>
      n.nodeType === 1 && (n.matches?.('input,select,textarea') || n.querySelector?.('input,select,textarea'))));
    if (hasNewFields) later(300);
  }).observe(document.body, { childList: true, subtree: true });
}

watchForTabSwitches();
