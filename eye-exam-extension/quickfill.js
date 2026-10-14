// Quick fill: Claude maps the dictation straight onto the page's boxes. Used only for EMRs not set up yet.
// Shared by background.js (importScripts) and core/evals/quickfill.js (require).
(function (root) {
  const MODEL = 'claude-sonnet-4-6';
  // Newer models think by default; low effort keeps latency down for this short mapping task.
  const takesEffort = model => !/^claude-(sonnet|opus)-4-6$/.test(model);

  // One line per box: page text can contain line breaks, which would split a box across lines.
  function buildFieldList(fields) {
    const t = v => String(v ?? '').replace(/\s+/g, ' ').trim();
    return fields.map((f,i) =>
      `[${i}] row="${t(f.row)}" | col="${t(f.col)}" | context="${t(f.context)}" | label="${t(f.label)}" | name="${t(f.name)}" | id="${t(f.id)}" | type="${t(f.type)}" | placeholder="${t(f.placeholder)}"${
        f.options?.length ? ` | options=${f.options.map(o=>t(o.text)).join(', ')}` : ''}`
    ).join('\n');
  }

  function buildSystemPrompt(customInstructions) {
    return `You are an expert optometry medical assistant. Extract clinical data from eye exam dictations and map them to form fields.

TASK: Return a JSON object mapping field indices to fill values.

RULES:
- Return ONLY valid JSON. No explanation, no markdown, no backticks.
- Keys are field indices as strings ("0", "3", "12").
- Only include fields you have data for.
- For selects, match option text as closely as possible.
- Use standard optometric notation (-1.25, +2.00, 20/20, 0.75 x 180).
- For checkboxes use "true" or "false".
- For radio buttons: labels show "Question — Option" (e.g. "Do you drive? — Yes"). Set "true" ONLY for the matching option. Never guess by position.
- Each field has layout hints from the screen: "row" = text immediately to its left, "col" = column header directly above it, "context" = nearby section headings above. Many EMR grids have no HTML labels, so these are usually the most reliable way to identify a field. Example: "amplitude OD 5" goes to the field with row="Amplitude" and col="OD".
- Never put a specific measurement into a generic Notes/Note field when a matching row/col field exists.
${customInstructions ? `\nDOCTOR INSTRUCTIONS:\n${customInstructions}` : ''}

EXAMPLE: {"2":"20/40","5":"-1.25","6":"-0.50","7":"90","12":"Mild myopia OU"}`;
  }

  function buildRequest(dictation, fields, customInstructions, model = MODEL) {
    const req = {
      model,
      max_tokens: 4000,
      system: buildSystemPrompt(customInstructions),
      messages: [{ role:'user', content: `DICTATION:\n${dictation}\n\nFORM FIELDS:\n${buildFieldList(fields)}\n\nReturn JSON mapping:` }]
    };
    if (takesEffort(model)) req.output_config = { effort: 'low' };
    return req;
  }

  // Returns { fieldIndex: value }. Reads the text block (newer models may put a thinking block first).
  function parseResponse(body) {
    if (body.stop_reason === 'refusal') throw new Error('Claude declined this request' + (body.stop_details?.category ? ` (${body.stop_details.category})` : ''));
    if (body.stop_reason === 'max_tokens') throw new Error('Dictation too long — response was cut off');
    const text = (body.content || []).find(b => b.type === 'text')?.text || '';
    const raw = text.replace(/```json|```/g, '').trim();
    const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    try { return JSON.parse(json); }
    catch (e) { throw new Error('Invalid JSON from Claude: ' + raw.substring(0, 80)); }
  }

  // meta (optional) receives the response's usage, for cost reporting in the eval.
  async function quickFill({ apiKey, dictation, fields, customInstructions, model = MODEL, fetchImpl = fetch, browser = false, meta }) {
    const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    if (browser) headers['anthropic-dangerous-direct-browser-access'] = 'true';
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
