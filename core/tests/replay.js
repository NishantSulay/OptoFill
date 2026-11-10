// Rebuilds an EMR screen from a layout report (side panel → "Save report") and runs the real content script on it,
// so a wrong mapping can be reproduced and fixed here instead of guessed from a screenshot. The report holds box
// positions and label texts, never what was typed in the boxes.
// Usage: node core/tests/replay.js report.json [--png out.png]   (needs `playwright`)
const fs = require('fs');
const path = require('path');

const EXT = path.resolve(__dirname, '../../eye-exam-extension');

// Runs in the page: panels as bordered boxes, label texts and boxes at the positions the report gives
function buildPage(report) {
  const far = Math.max(...[...report.fields, ...report.texts, ...report.panels].map(x => x.rect[1] + x.rect[3]), 0);
  document.body.style.cssText = `margin:0;position:relative;width:${report.page.width}px;height:${far + 40}px;font:12px Arial,sans-serif;background:#fff`;
  const panels = report.panels.map(() => document.createElement('div'));
  const origin = i => (i >= 0 ? [report.panels[i].rect[0] + 1, report.panels[i].rect[1] + 1] : [0, 0]);   // inside the 1px border
  const place = (el, rect, parent) => {
    const [ox, oy] = origin(parent);
    el.style.position = 'absolute';
    el.style.left = rect[0] - ox + 'px';
    el.style.top = rect[1] - oy + 'px';
    el.style.boxSizing = 'border-box';
    (parent >= 0 ? panels[parent] : document.body).appendChild(el);
  };
  report.panels.forEach((p, i) => {
    panels[i].style.cssText = `width:${p.rect[2]}px;height:${p.rect[3]}px;border:1px solid #cbd5e1;border-radius:6px`;
  });
  // parents before children
  const done = new Set();
  const addPanel = i => { if (done.has(i)) return; done.add(i); const up = report.panels[i].parent; if (up >= 0) addPanel(up); place(panels[i], report.panels[i].rect, up); };
  report.panels.forEach((_, i) => addPanel(i));

  const items = [...report.fields.map((f, i) => ({ ...f, field: i })), ...report.texts].sort((a, b) => a.order - b.order);
  for (const it of items) {
    const [, , w, h] = it.rect;
    const box = it.panel >= 0 ? panels[it.panel] : document.body;
    if (it.field === undefined) {
      // A text that isn't a checkbox's own label must not sit straight after one
      if (!it.option && box.lastElementChild?.matches?.('input[type=checkbox],input[type=radio]')) box.appendChild(document.createElement('i'));
      const span = document.createElement('span');
      span.textContent = it.text;
      span.style.cssText = `white-space:nowrap;line-height:1;font-size:${Math.max(6, Math.round(h * 0.85))}px;transform-origin:0 0;color:#334155`;
      place(span, it.rect, it.panel);
      // Stretch the text to exactly the size it had on the EMR: labels are matched to boxes by where their edges are
      const range = document.createRange();
      range.selectNodeContents(span.firstChild);
      const r = range.getBoundingClientRect();
      if (r.width && r.height) span.style.transform = `scale(${w / r.width}, ${h / r.height})`;
      continue;
    }
    const tag = it.type === 'textarea' ? 'textarea' : /^select/.test(it.type) ? 'select' : 'input';
    const el = document.createElement(tag);
    if (tag === 'input') el.type = it.type;
    if (tag === 'select') for (const o of it.options || []) el.add(new Option(o.text, o.value));
    if (it.name) el.name = it.name;
    if (it.id) el.id = it.id;
    if (it.placeholder) el.placeholder = it.placeholder;
    // The label the EMR's own markup gave the box (not one OptoFill fell back to)
    const own = it.label && ![it.placeholder, it.name, it.id].includes(it.label) && !/^field_\d+$/.test(it.label);
    if (own && it.type !== 'checkbox' && it.type !== 'radio') el.setAttribute('aria-label', it.label);
    el.dataset.i = it.field;
    el.style.cssText = `width:${w}px;height:${h}px;margin:0;padding:0 2px;border:1px solid #94a3b8;font-size:11px;resize:none`;
    place(el, it.rect, it.panel);
  }
}

// → { fields: what the content script reads from the rebuilt page, map: { schemaKey: field index } }
async function replay(report, browser, { png } = {}) {
  const far = Math.max(...[...report.fields, ...report.texts].map(x => x.rect[1] + x.rect[3]), 600);
  const page = await browser.newPage({ viewport: { width: report.page.width, height: Math.min(far + 60, 8000) } });
  await page.addInitScript(() => {
    window.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage() {} }, storage: { local: { get: async () => ({}), set: async () => {} } } };
  });
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  await page.evaluate(buildPage, report);
  await page.addScriptTag({ path: path.join(EXT, 'schema.js') });
  await page.addScriptTag({ path: path.join(EXT, 'content.js') });
  const out = await page.evaluate(() => {
    const map = {};
    autoMapVisible(map);
    const fields = getAllFields(true);
    const at = Object.fromEntries(Object.entries(map).map(([k, e]) => [k, Number(locateMapped(e, fields)?.dataset.i ?? -1)]));
    return { map: at, fields: fields.map((f, i) => ({ ...f, i: Number(lastScannedEls[i].dataset.i) })) };
  });
  if (png) await page.screenshot({ path: png, fullPage: true });
  await page.close();
  return out;
}

// The saved mapping in the report, as { schemaKey: field index } (an entry is matched as the extension matches it)
function savedMap(report) {
  const out = {};
  for (const [key, e] of Object.entries(report.map || {})) {
    let hits = report.fields.filter(f => f.selector === e.selector);
    if (hits.length !== 1) hits = report.fields.filter(f => f.row === e.row && f.col === e.col && f.label === e.label && (!e.name || f.name === e.name));
    if (hits.length === 1) out[key] = hits[0].index;
  }
  return out;
}

if (require.main === module) {
  (async () => {
    const file = process.argv[2];
    if (!file) { console.error('Usage: node core/tests/replay.js report.json [--png out.png]'); process.exit(2); }
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    const png = process.argv.includes('--png') ? process.argv[process.argv.indexOf('--png') + 1] : null;
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
    const { map } = await replay(report, browser, { png });
    await browser.close();

    const saved = savedMap(report);
    const keyAt = m => Object.fromEntries(Object.entries(m).map(([k, i]) => [i, k]));
    const auto = keyAt(map), was = keyAt(saved);
    const name = f => (f.name || f.id || `#${f.index}`).padEnd(14);
    console.log(`${report.page.host} (${report.page.frame}) — ${report.fields.length} boxes, ${Object.keys(saved).length} in the saved setup\n`);
    console.log('box            auto-map now                  saved setup                   labels');
    for (const f of report.fields) {
      const a = auto[f.index] || '', s = was[f.index] || '';
      const flag = a === s ? ' ' : !a ? '?' : !s ? '+' : '≠';
      console.log(`${name(f)} ${a.padEnd(28)}${flag} ${s.padEnd(29)} ${[f.label, f.row, f.col].filter(Boolean).join(' | ')}${f.eye ? ' [' + f.eye + ']' : ''}`);
    }
    console.log('\n  ≠ auto-map disagrees with the saved setup   + auto-map found a box the setup lacks   ? set up by hand, auto-map has no answer');
    const bad = (report.lastFill || []).filter(r => r.status !== 'filled');
    if (bad.length) console.log('\nLast fill, not filled:\n' + bad.map(r => `  ${r.key} = ${JSON.stringify(r.value)} — ${r.status}: ${r.reason || ''}`).join('\n'));
    if (report.dictation) console.log('\nDictation: ' + report.dictation);
  })().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { replay, savedMap };
