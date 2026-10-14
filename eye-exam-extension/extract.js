// Turns a dictation into schema values. Shared by background.js (importScripts) and core/evals (require).
(function (root) {
  const SCHEMA = root.OPTOFILL_SCHEMA || require('./schema.js');
  const KEYS = SCHEMA.map(f => f.key);
  const MODEL = 'claude-sonnet-4-6';
  const TOOL = 'record_exam_findings';

  function buildSystemPrompt(customInstructions) {
    const fieldList = SCHEMA.map(f => `${f.key}: ${f.label}`).join('\n');
    return `You extract eye exam findings from an optometrist's dictation into a fixed clinical schema.

Call the ${TOOL} tool exactly once with every finding that was dictated.

RULES:
- Only record values the doctor actually said. Never infer, guess, or fill normal defaults.
- Eyes: OD = right, OS = left, OU = both. If a per-eye finding is stated for "both eyes" or "OU" and no OU key exists, record it for both the OD and OS keys.
- Visual acuity in Snellen form, e.g. "20/40", "20/20-2". Write "CF", "HM", "LP", "NLP" as dictated.
- Sphere/cylinder with sign and two decimals ("-1.25", "+0.50"); "plano" as "plano". Axis as a whole number ("180"). Add as "+2.00".
- IOP as a number only ("16"). Pupillary distance and NPC with units only if spoken ("5 cm").
- Keep text findings short and clinical (e.g. "clear", "trace NS", "0.3").
- Anything clinically relevant that has no matching key goes into notes_general.
${customInstructions ? `\nDOCTOR INSTRUCTIONS:\n${customInstructions}\n` : ''}
SCHEMA KEYS:
${fieldList}`;
  }

  function buildRequest(dictation, customInstructions) {
    return {
      model: MODEL,
      max_tokens: 4000,
      system: buildSystemPrompt(customInstructions),
      tools: [{
        name: TOOL,
        description: 'Record the clinical findings dictated in this exam, one entry per schema key.',
        input_schema: {
          type: 'object',
          properties: {
            findings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string', enum: KEYS },
                  value: { type: 'string' }
                },
                required: ['key', 'value']
              }
            }
          },
          required: ['findings']
        }
      }],
      tool_choice: { type: 'tool', name: TOOL },
      messages: [{ role: 'user', content: `DICTATION:\n${dictation}` }]
    };
  }

  // Returns { key: value } using only known schema keys.
  function parseResponse(body) {
    if (body.stop_reason === 'max_tokens') throw new Error('Dictation too long — response was cut off');
    const block = (body.content || []).find(b => b.type === 'tool_use' && b.name === TOOL);
    if (!block) throw new Error('Claude did not return findings');
    const out = {};
    for (const f of block.input?.findings || []) {
      if (KEYS.includes(f.key) && f.value != null && String(f.value).trim()) out[f.key] = String(f.value).trim();
    }
    return out;
  }

  async function extractFindings({ apiKey, dictation, customInstructions, fetchImpl = fetch, browser = false }) {
    const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    if (browser) headers['anthropic-dangerous-direct-browser-access'] = 'true';
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers, body: JSON.stringify(buildRequest(dictation, customInstructions))
    });
    const text = await res.text();
    if (!res.ok) {
      let m = `HTTP ${res.status}`;
      try { m = JSON.parse(text).error?.message || m; } catch (_) {}
      throw new Error(m);
    }
    return parseResponse(JSON.parse(text));
  }

  const api = { SCHEMA, KEYS, MODEL, buildRequest, buildSystemPrompt, parseResponse, extractFindings };
  root.OptoFillExtract = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
