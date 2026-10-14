// Quick fill: Claude maps the dictation straight onto the page's boxes. Used only for EMRs not set up yet.
// Shared by background.js (importScripts) and core/evals/quickfill.js (require).
(function (root) {
  const MODEL = 'claude-sonnet-5-5';
  // Sonnet/Opus 4.6 answer in plain JSON; newer models think by default (low effort keeps latency down)
  // and use structured outputs, so the reply is always valid JSON with numeric box indices.
  const isLegacy = model => /^claude-(sonnet|opus)-4-6$/.test(model);
  // If a newer model declines (a rare safety false positive), the API retries on a fallback model it picks.
  const usesFallback = model => /^claude-(sonnet-5-5|opus-5-5|opus-5|fable-5-1)$/.test(model);

  const FILLS_SCHEMA = {
    type: 'object',
    properties: {
      fills: {
        type: 'array',
        items: {
          type: 'object',
          properties: { index: { type: 'integer' }, value: { type: 'string' } },
          required: ['index', 'value'],
          additionalProperties: false
        }
      }
    },
    required: ['fills'],
    additionalProperties: false
  };

  // One line per box: page text can contain line breaks, which would split a box across lines.
  function buildFieldList(fields) {
    const t = v => String(v ?? '').replace(/\s+/g, ' ').trim();
    return fields.map((f,i) =>
      `[${i}] row="${t(f.row)}" | col="${t(f.col)}" | context="${t(f.context)}" | label="${t(f.label)}" | name="${t(f.name)}" | id="${t(f.id)}" | type="${t(f.type)}" | placeholder="${t(f.placeholder)}"${
        f.options?.length ? ` | options=${f.options.map(o=>t(o.text)).join(', ')}` : ''}`
    ).join('\n');
  }

  function buildSystemPrompt(customInstructions, model = MODEL) {
    const legacy = isLegacy(model);
    return `You are an expert optometry medical assistant. Extract clinical data from eye exam dictations and map them to form fields.

TASK: ${legacy ? 'Return a JSON object mapping field indices to fill values.' : 'Return a list of {index, value} entries, one per field you fill.'}

RULES:
${legacy ? `- Return ONLY valid JSON. No explanation, no markdown, no backticks.
- Keys are field indices as strings ("0", "3", "12").` : '- index is the number in [brackets] before each field.'}
- Only include fields you have data for.
- Only fill values the doctor actually said. Never infer or fill normal defaults (e.g. "PERRLA" goes in a pupils notes box, not into Direct/Consensual boxes).
- A field must match the finding on every hint: eye, distance vs near, corrected vs uncorrected, and section. If no field matches, put the finding in a Notes field for that section or leave it out. Never use a similar-looking field instead.
- For selects, match option text as closely as possible.
- Use standard optometric notation (-1.25, +2.00, 20/20, 0.75 x 180).
- If a field's label or row already shows "20/", enter only the rest ("40", "20-2").
- Best-corrected VA from a refraction goes only in that refraction's VA field, not in the corrected (cc) acuity fields.
- A single pupillary distance (PD) value is binocular: use the OU field.
- Cover test: ortho, eso, exo, phoria and tropia go in the Direction field. The Eye field only takes OD/OS/OU when the doctor names an eye.
- For checkboxes use "true" or "false".
- For radio buttons: labels show "Question — Option" (e.g. "Do you drive? — Yes"). Set "true" ONLY for the matching option. Never guess by position.
- Each field has layout hints from the screen: "row" = text immediately to its left, "col" = column header directly above it, "context" = nearby section headings above. Many EMR grids have no HTML labels, so these are usually the most reliable way to identify a field. Example: "amplitude OD 5" goes to the field with row="Amplitude" and col="OD".
- Never put a specific measurement into a generic Notes/Note field when a matching row/col field exists.
${customInstructions ? `\nDOCTOR INSTRUCTIONS:\n${customInstructions}` : ''}
${legacy ? '\nEXAMPLE: {"2":"20/40","5":"-1.25","6":"-0.50","7":"90","12":"Mild myopia OU"}' : ''}`;
  }

  function buildRequest(dictation, fields, customInstructions, model = MODEL) {
    const req = {
      model,
      max_tokens: 4000,
      system: buildSystemPrompt(customInstructions, model),
      messages: [{ role:'user', content: `DICTATION:\n${dictation}\n\nFORM FIELDS:\n${buildFieldList(fields)}\n\n${isLegacy(model) ? 'Return JSON mapping:' : 'Return the fields to fill.'}` }]
    };
    if (!isLegacy(model)) req.output_config = { effort: 'low', format: { type: 'json_schema', schema: FILLS_SCHEMA } };
    if (usesFallback(model)) req.fallbacks = 'default';
    return req;
  }

  // Returns { fieldIndex: value }. Reads the text block (newer models may put a thinking block first).
  function parseResponse(body) {
    if (body.stop_reason === 'refusal') throw new Error('Claude declined this request' + (body.stop_details?.category ? ` (${body.stop_details.category})` : ''));
    if (body.stop_reason === 'max_tokens') throw new Error('Dictation too long — response was cut off');
    const text = (body.content || []).find(b => b.type === 'text')?.text || '';
    const raw = text.replace(/```json|```/g, '').trim();
    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    let parsed;
    try { parsed = JSON.parse(json); }
    catch (e) { throw new Error('Invalid JSON from Claude: ' + raw.substring(0, 80)); }
    if (!Array.isArray(parsed.fills)) return parsed;
    const out = {};
    for (const f of parsed.fills) if (Number.isInteger(f.index) && f.value != null) out[String(f.index)] = String(f.value);
    return out;
  }

  // meta (optional) receives the response's usage, for cost reporting in the eval.
  async function quickFill({ apiKey, dictation, fields, customInstructions, model = MODEL, fetchImpl = fetch, browser = false, meta }) {
    const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    if (browser) headers['anthropic-dangerous-direct-browser-access'] = 'true';
    if (usesFallback(model)) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers, body: JSON.stringify(buildRequest(dictation, fields, customInstructions, model))
    });
    const text = await res.text();
    if (!res.ok) {
      let m = `HTTP ${res.status}`;
      try { m = JSON.parse(text).error?.message || m; } catch (_) {}
      throw new Error(m);
    }
    const body = JSON.parse(text);
    if (meta) meta.usage = body.usage;
    return parseResponse(body);
  }

  const api = { MODEL, buildFieldList, buildSystemPrompt, buildRequest, parseResponse, quickFill };
  root.OptoFillQuickFill = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
