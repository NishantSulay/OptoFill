// Removes patient identifiers from text before it is sent to Anthropic. Shared by extract.js, quickfill.js and tests.
// Pattern-based: it catches identifiers with a recognisable shape (dates, phone/ID numbers, emails, addresses,
// postal codes, "Mr. …", "patient name is …"). A name said with no cue around it can't be recognised, so doctors
// should still not dictate names. It only covers text: Chrome's speech recognition has already sent the audio to Google.
(function (root) {
  const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const NAME = "[A-Z][a-z'’-]+";   // Title-case word: names, not acronyms like OD or PERRLA
  const NAMES = `${NAME}(?:\\s+${NAME}){0,2}`;

  // [type, pattern, keepsCue]. Order matters: specific shapes first so their digits aren't claimed by a looser rule.
  // keepsCue: group 1 is a cue to keep ("Mr. ", "name is ", "DOB ") and group 2 is the identifier.
  const RULES = [
    ['email',   /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g],
    ['date',    new RegExp(`\\b(?:${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\.?,?\\s+\\d{4}|${MONTH}\\.?\\s+\\d{4})\\b`, 'gi')],
    ['date',    /\b\d{4}-\d{1,2}-\d{1,2}\b/g],
    ['date',    /\b\d{1,2}([\/.-])\d{1,2}\1(?:\d{4}|\d{2})\b/g],
    ['phone',   /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g],
    ['id',      /\b\d{4}[\s-]\d{3}[\s-]\d{3}(?:[\s-]?[A-Z]{2})?\b/g],     // Ontario health card style
    ['id',      /\b\d{8,}\b/g],                                             // other long ID numbers
    ['address', /\b\d{1,6}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Crescent|Cres|Boulevard|Blvd|Lane|Ln|Court|Ct|Way|Place|Pl|Parkway|Pkwy|Circle|Cir)\b\.?/g],
    ['postal',  /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/g],                          // Canadian postal code
    ['date',    /\b((?:DOB|D\.O\.B\.?|[Dd]ate of birth|[Bb]orn(?:\s+in|\s+on)?)\s*:?\s*)(\d{4})\b/g, true],
    ['name',    new RegExp(`\\b((?:Mr|Mrs|Ms|Miss|Mx|Dr)\\.?\\s+)(${NAMES})`, 'g'), true],
    ['name',    new RegExp(`\\b((?:(?:[Tt]he\\s+)?[Pp]atient'?s\\s+|[Hh]is\\s+|[Hh]er\\s+|[Tt]heir\\s+)?[Nn]ame\\s+is\\s+)(${NAMES})`, 'g'), true],
    ['name',    new RegExp(`\\b([Pp]atient\\s+)(${NAMES})`, 'g'), true],
  ];

  // → { text, removed: [{ type, text }] }
  function redact(input) {
    let text = String(input ?? '');
    const removed = [];
    for (const [type, re, keepsCue] of RULES) {
      text = text.replace(re, (m, g1, g2) => {
        const cue = keepsCue ? g1 : '', target = keepsCue ? g2 : m;
        removed.push({ type, text: target });
        return `${cue}[${type}]`;
      });
    }
    return { text, removed };
  }

  const api = { redact };
  root.OptoFillRedact = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
