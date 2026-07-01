// background.js

let popupPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPort = port;
  port.onDisconnect.addListener(() => { popupPort = null; });

  port.onMessage.addListener(async (msg) => {

    if (['startRecording','stopRecording','clearRecording'].includes(msg.action)) {
      const tabId = await getExamTabId();
      if (!tabId) { toPopup({ action:'micError', error:'No active tab. Navigate to your exam page first.' }); return; }
      try {
        await chrome.tabs.sendMessage(tabId, msg);
      } catch(e) {
        // Content script not loaded — inject and retry
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
          await new Promise(r => setTimeout(r, 300));
          await chrome.tabs.sendMessage(tabId, msg);
        } catch(e2) {
          toPopup({ action:'micError', error:'Could not reach page. Make sure you are on your exam form.' });
        }
      }
      return;
    }

    if (msg.action === 'callClaude') {
      try {
        const mapping = await callClaudeAPI(msg.apiKey, msg.transcript, msg.fields, msg.customInstructions);
        toPopup({ action:'claudeResult', ok:true, mapping });
      } catch(err) {
        toPopup({ action:'claudeResult', ok:false, error:err.message });
      }
    }
  });
});

// Relay messages from content script → popup
chrome.runtime.onMessage.addListener((msg) => {
  if (['transcriptUpdate','micError','micStopped','micStarted','micReady'].includes(msg.action)) {
    toPopup(msg);
  }
});

function toPopup(msg) {
  if (popupPort) try { popupPort.postMessage(msg); } catch(e) {}
}

async function getExamTabId() {
  const tabs = await chrome.tabs.query({ active:true, lastFocusedWindow:true });
  const tab = tabs.find(t => t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://'));
  return tab ? tab.id : null;
}

async function callClaudeAPI(apiKey, dictation, fields, customInstructions) {
  const fieldList = fields.map((f,i) =>
    `[${i}] label="${f.label}" | name="${f.name}" | id="${f.id}" | type="${f.type}" | placeholder="${f.placeholder}"${
      f.options?.length ? ` | options=${f.options.map(o=>o.text).join(', ')}` : ''}`
  ).join('\n');

  const systemPrompt = `You are an expert optometry medical assistant. Extract clinical data from eye exam dictations and map them to form fields.

TASK: Return a JSON object mapping field indices to fill values.

RULES:
- Return ONLY valid JSON. No explanation, no markdown, no backticks.
- Keys are field indices as strings ("0", "3", "12").
- Only include fields you have data for.
- For selects, match option text as closely as possible.
- Use standard optometric notation (-1.25, +2.00, 20/20, 0.75 x 180).
- For checkboxes use "true" or "false".
- For radio buttons: labels show "Question — Option" (e.g. "Do you drive? — Yes"). Set "true" ONLY for the matching option. Never guess by position.
${customInstructions ? `\nDOCTOR INSTRUCTIONS:\n${customInstructions}` : ''}

EXAMPLE: {"2":"20/40","5":"-1.25","6":"-0.50","7":"90","12":"Mild myopia OU"}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role:'user', content:`DICTATION:\n${dictation}\n\nFORM FIELDS:\n${fieldList}\n\nReturn JSON mapping:` }]
    })
  });

  const text = await response.text();
  if (!response.ok) {
    let m = `HTTP ${response.status}`;
    try { m = JSON.parse(text).error?.message || m; } catch(_) {}
    throw new Error(m);
  }
  const raw = (JSON.parse(text).content?.[0]?.text||'').replace(/```json|```/g,'').trim();
  try { return JSON.parse(raw); }
  catch(e) { throw new Error('Invalid JSON from Claude: ' + raw.substring(0,80)); }
}
