// Turns a dictation into schema values. Shared by background.js (importScripts) and core/evals (require).
(function (root) {
  const SCHEMA = root.OPTOFILL_SCHEMA || require('./schema.js');
  const { redact } = root.OptoFillRedact || require('./redact.js');
  const NORMAL_SECTIONS = root.OPTOFILL_NORMAL_SECTIONS;
  const DEFAULT_NORMALS = root.OPTOFILL_NORMALS;
  // "<section> is normal" flags the AI can return; applyNormals turns them into the doctor's normal text
  const NORMAL_KEYS = Object.keys(NORMAL_SECTIONS).map(s => `normal_${s}`);
  const KEYS = [...SCHEMA.map(f => f.key), ...NORMAL_KEYS];
  const MODEL = 'claude-haiku-5-5';
  const TOOL = 'record_exam_findings';

  // Sonnet/Opus 4.6 don't take output_config.format, so they get a forced tool call instead;
  // newer models reject forced tool_choice and use structured outputs.
  const usesTool = model => /^claude-(sonnet|opus)-4-6$/.test(model);

  // customFields: [{ key, label, type }] — boxes the doctor labelled themselves in this EMR's setup
  const findingsSchema = (customFields = []) => ({
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: { key: { type: 'string', enum: [...KEYS, ...customFields.map(c => c.key)] }, value: { type: 'string' } },
          required: ['key', 'value'],
          additionalProperties: false
        }
      }
    },
    required: ['findings'],
    additionalProperties: false
  });

  function buildSystemPrompt(customInstructions, model = MODEL, customFields = []) {
    const fieldList = SCHEMA.map(f => `${f.key}: ${f.label}`).join('\n');
    const customList = customFields.map(c => `${c.key}: ${c.label}${c.type === 'checkbox' ? ' (checkbox: "true" only when dictated)' : ''}`).join('\n');
    return `You extract eye exam findings from an optometrist's dictation into a fixed clinical schema.

${usesTool(model) ? `Call the ${TOOL} tool exactly once with every finding that was dictated.` : 'Return every finding that was dictated as a list of {key, value} entries.'}

RULES:
- Only record values the doctor actually said. Never infer, guess, or fill normal defaults yourself (the normal_* keys below cover a section the doctor calls normal).
- Eyes: OD = right, OS = left, OU = both. If a per-eye finding is stated for "both eyes" or "OU" and no OU key exists, record it for both the OD and OS keys.
- Visual acuity in Snellen form, e.g. "20/40", "20/20-2". Write "CF", "HM", "LP", "NLP" as dictated.
- Sphere/cylinder with sign and two decimals ("-1.25", "+0.50"); "plano" as "plano". Axis as a whole number ("180"). Add as "+2.00".
- IOP as a number only ("16"). Pupillary distance and NPC with units only if spoken ("5 cm").
- Refractions go to the keys of the one that was dictated: manifest/subjective (or an unnamed refraction) → rx_*, habitual/current glasses/lensometry → hrx_*, final or prescribed Rx → frx_*, autorefraction → ar_*, retinoscopy → ret_*, contact lens Rx → cl_*. Never copy one refraction into another's keys.
- Keratometry: K1 is the flatter meridian, K2 the steeper; power in diopters ("43.25") and its axis as a whole number ("180"). "43.25 at 180" is K power 43.25, axis 180.
- Pinhole acuity ("PH", "pinhole") goes in va_dist_ph_*; "no improvement" as "NI".
- When the next visit is given ("RTC 1 year", "follow up in 6 months"), put it in follow_up; plan holds the rest of the plan.
- The dictation comes from speech recognition and may mishear eye-care terms (e.g. "oh dee"/"old e" = OD, "oh ess" = OS, "pearl a"/"perla" = PERRLA, "plain oh" = plano, "see over d" = C/D, "e o m's" = EOMs). Read them as the intended term when the meaning is clear.
- Cover test: "ortho"/"orthophoria" goes in the direction key (e.g. cover_dist_direction), not the amount key.
- Keep text findings short and clinical (e.g. "clear", "trace NS", "0.3").
- Anything clinically relevant that has no matching key goes into notes_general.
- Keys whose label ends in "(checkbox)" are checkboxes: "true" only when the doctor says so (e.g. acuity "with glasses", "consent obtained", "OCT done"). Never "false". A test that is only planned is not done.
- Text like [name], [date] or [id] marks a patient identifier that was removed. Never record it in any key.

NORMAL SECTIONS: when the doctor says a whole section is normal (e.g. "SLE normal OU", "anterior segment WNL", "fundus unremarkable OD", "rest of the exam normal"), record its key with the eyes it applies to: "OU", "OD" or "OS". OptoFill then fills that section's boxes that weren't dictated with the doctor's own normal findings. Still record every specific finding dictated in that section. A single normal structure ("lens clear") is that structure's key, not a section.
${Object.entries(NORMAL_SECTIONS).map(([s, v]) => `normal_${s}: ${v.label} is normal`).join('\n')}
${customInstructions ? `\nDOCTOR INSTRUCTIONS:\n${customInstructions}\n` : ''}
SCHEMA KEYS:
${fieldList}${customList ? `

CUSTOM FIELDS ON THIS EMR (named by the doctor; record one only when the dictation clearly refers to that name):
${customList}` : ''}`;
  }

  function buildRequest(dictation, customInstructions, model = MODEL, customFields = []) {
    const FINDINGS_SCHEMA = findingsSchema(customFields);
    const base = {
      model,
      system: buildSystemPrompt(customInstructions, model, customFields),
      messages: [{ role: 'user', content: `DICTATION:\n${redact(dictation).text}` }]
    };
    if (usesTool(model)) {
      return {
        ...base,
        max_tokens: 4000,
        tools: [{
          name: TOOL,
          description: 'Record the clinical findings dictated in this exam, one entry per schema key.',
          input_schema: FINDINGS_SCHEMA
        }],
        tool_choice: { type: 'tool', name: TOOL }
      };
    }
    // Low effort keeps latency down; extraction from a short dictation doesn't need deep reasoning.
    return {
      ...base,
      max_tokens: 8000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: FINDINGS_SCHEMA } }
    };
  }

  // Returns { key: value } using only known schema keys.
  function parseResponse(body, customFields = []) {
    const keys = new Set([...KEYS, ...customFields.map(c => c.key)]);
    if (body.stop_reason === 'refusal') throw new Error('Claude declined this request' + (body.stop_details?.category ? ` (${body.stop_details.category})` : ''));
    if (body.stop_reason === 'max_tokens') throw new Error('Dictation too long — response was cut off');
    const content = body.content || [];
    const toolBlock = content.find(b => b.type === 'tool_use' && b.name === TOOL);
    const textBlock = content.find(b => b.type === 'text');
    let input;
    if (toolBlock) input = toolBlock.input;
    else if (textBlock) {
      try { input = JSON.parse(textBlock.text); } catch (e) { throw new Error('Claude returned invalid JSON'); }
    } else throw new Error('Claude did not return findings');
    const out = {};
    for (const f of input?.findings || []) {
      if (keys.has(f.key) && f.value != null && String(f.value).trim()) out[f.key] = String(f.value).trim();
    }
    return out;
  }

  // Replaces the normal_* flags with the normal text for every box in that section (and those eyes) that wasn't
  // dictated. normals: { sle_lids: 'Clear', … } — the doctor's own, or the defaults.
  function applyNormals(values, normals = DEFAULT_NORMALS) {
    const out = { ...values };
    for (const [section, { keys }] of Object.entries(NORMAL_SECTIONS)) {
      const flag = out[`normal_${section}`];
      delete out[`normal_${section}`];
      if (!flag) continue;
      const v = flag.toLowerCase();
      const eyes = /\b(od|right)\b/.test(v) && !/\b(os|left|ou|both)\b/.test(v) ? ['od']
                 : /\b(os|left)\b/.test(v) && !/\b(od|right|ou|both)\b/.test(v) ? ['os'] : ['od', 'os'];
      for (const base of keys) {
        const text = String(normals?.[base] || '').trim();
        if (!text) continue;
        for (const e of eyes) if (!out[`${base}_${e}`]) out[`${base}_${e}`] = text;
      }
    }
    return out;
  }

  // meta (optional) receives the response's usage, for cost reporting in the eval.
  async function extractFindings({ apiKey, dictation, customInstructions, customFields = [], normals, model = MODEL, fetchImpl = fetch, browser = false, meta }) {
    const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    if (browser) headers['anthropic-dangerous-direct-browser-access'] = 'true';
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers, body: JSON.stringify(buildRequest(dictation, customInstructions, model, customFields))
    });
    const text = await res.text();
    if (!res.ok) {
      let m = `HTTP ${res.status}`;
      try { m = JSON.parse(text).error?.message || m; } catch (_) {}
      throw new Error(m);
    }
    const body = JSON.parse(text);
    if (meta) { meta.usage = body.usage; meta.redacted = redact(dictation).removed.length; }
    return applyNormals(parseResponse(body, customFields), normals || DEFAULT_NORMALS);
  }

  const api = { SCHEMA, KEYS, MODEL, DEFAULT_NORMALS, buildRequest, buildSystemPrompt, parseResponse, applyNormals, extractFindings };
  root.OptoFillExtract = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
