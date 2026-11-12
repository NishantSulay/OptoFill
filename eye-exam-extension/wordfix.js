// The doctor's own fixes for words speech recognition keeps getting wrong ("pearl a = PERRLA"), applied to the
// dictation before it is shown or sent anywhere. Shared by popup.js and core/tests.
(function (root) {
  // Safe starters: phrases that only ever mean the eye-care term in a dictation
  const DEFAULTS = ['oh dee = OD', 'oh ess = OS', 'o d = OD', 'o s = OS', 'odos = OD OS', 'pearl a = PERRLA', 'perla = PERRLA', 'plain oh = plano'].join('\n');

  // "heard = meant" per line ("->" and "→" also work). Lines without both sides are ignored.
  function parse(text) {
    const fixes = [];
    for (const line of String(text || '').split('\n')) {
      const m = line.match(/^(.*?)\s*(?:=|->|→)\s*(.*)$/);
      const heard = m && m[1].trim().replace(/\s+/g, ' '), meant = m && m[2].trim();
      if (heard && meant) fixes.push({ heard, meant });
    }
    return fixes;
  }

  // Whole words only, any letter case, in one pass (a fix never rewrites another fix's output); longer phrases first.
  // Running it again changes nothing, even for a fix whose result contains what was heard ("trope = trope 1%"):
  // the growing dictation is fixed again on every update.
  function apply(text, fixesText) {
    const fixes = parse(fixesText).sort((a, b) => b.heard.length - a.heard.length);
    if (!fixes.length || !text) return text || '';
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
    const byHeard = new Map(fixes.map(f => [f.heard.toLowerCase(), f.meant]));
    const re = new RegExp(`(?<![A-Za-z0-9])(?:${fixes.map(f => esc(f.heard)).join('|')})(?![A-Za-z0-9])`, 'gi');
    return text.replace(re, (m, at) => {
      const heard = m.toLowerCase().replace(/\s+/g, ' '), meant = byHeard.get(heard);
      if (meant == null) return m;
      const low = meant.toLowerCase();
      for (let i = low.indexOf(heard); i >= 0; i = low.indexOf(heard, i + 1)) {
        if (at - i >= 0 && text.substr(at - i, meant.length).toLowerCase() === low) return m;   // already fixed
      }
      return meant;
    });
  }

  const api = { DEFAULTS, parse, apply };
  root.OptoFillWordFix = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
