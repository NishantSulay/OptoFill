let isListening = false;
let transcript = '';
let port = null;

const micBtn             = document.getElementById('mic-btn');
const micHint            = document.getElementById('mic-hint');
const transcriptEl       = document.getElementById('transcript');
const fillBtn            = document.getElementById('fill-btn');
const fillBtnContent     = document.getElementById('fill-btn-content');
const clearBtn           = document.getElementById('clear-btn');
const statusDot          = document.getElementById('status-dot');
const statusText         = document.getElementById('status-text');
const resultsArea        = document.getElementById('results-area');
const resultList         = document.getElementById('result-list');
const toast              = document.getElementById('toast');
const toggleSettings     = document.getElementById('toggle-settings');
const backBtn            = document.getElementById('back-btn');
const saveSettingsBtn    = document.getElementById('save-settings-btn');
const apiKeyInput        = document.getElementById('api-key-input');
const customInstructions = document.getElementById('custom-instructions');
const mainPanel          = document.getElementById('main-panel');
const settingsPanel      = document.getElementById('settings-panel');

// ─── Port connection ──────────────────────────────────────────────────────────
function connectPort() {
  port = chrome.runtime.connect({ name: 'popup' });
  port.onMessage.addListener((msg) => {
    if (msg.action === 'transcriptUpdate') {
      transcript = msg.finalTranscript;
      transcriptEl.value = (msg.finalTranscript + (msg.interimTranscript || '')).trim();
      transcriptEl.classList.remove('empty');
      updateLiveTranscript();
      updateFillBtn();
      chrome.storage.session.set({ transcript: msg.finalTranscript });
    }
    if (msg.action === 'micStarted') {
      setListeningState(true);
      chrome.storage.session.set({ isRecording: true });
    }
    if (msg.action === 'micStopped') {
      setListeningState(false);
      chrome.storage.session.remove('isRecording');
    }
    if (msg.action === 'micPermissionNeeded') {
      // Chrome denied mic — show setup bar so user knows to grant permission
      setListeningState(false);
      const bar = document.getElementById('mic-setup-bar');
      bar.style.display = 'block';
      bar.innerHTML = '🎙 <strong>Allow microphone access first:</strong> Click here, then click Allow in the Chrome prompt. After that, click 🎙 again.';
    }
    if (msg.action === 'micError') {
      showToast(msg.error, 'error');
      setListeningState(false);
    }
    if (msg.action === 'claudeResult') handleClaudeResult(msg);
    if (msg.action === 'extractResult') handleExtractResult(msg);
    if (msg.action === 'fillUpdated') showResults(schemaItems(msg.results), { quiet: true });
  });
  port.onDisconnect.addListener(() => setTimeout(connectPort, 100));
}
connectPort();

// ─── Init ─────────────────────────────────────────────────────────────────────
chrome.storage.local.get(['apiKey', 'customInstructions'], (data) => {
  if (data.apiKey) apiKeyInput.value = data.apiKey;
  if (data.customInstructions) customInstructions.value = data.customInstructions;
});

// Restore recording state if popup was closed while recording was active
chrome.storage.session.get(['isRecording', 'transcript'], (data) => {
  if (data.isRecording) {
    if (data.transcript) {
      transcript = data.transcript;
      transcriptEl.value = transcript;
      transcriptEl.classList.remove('empty');
      updateFillBtn();
    }
    setListeningState(true);
  }
});

// Check if mic is already granted on the exam page
// If not, show the setup bar so user can grant it before using the popup
(async () => {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs.find(t => t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://'));
    if (!tab) return;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        try {
          const s = await navigator.permissions.query({ name: 'microphone' });
          return s.state; // 'granted', 'denied', or 'prompt'
        } catch(e) { return 'unknown'; }
      }
    });

    const state = results?.[0]?.result;
    if (state === 'prompt') {
      // Not yet granted — show the setup bar
      const bar = document.getElementById('mic-setup-bar');
      bar.style.display = 'block';
      bar.addEventListener('click', async () => {
        // Tell content script to call getUserMedia on the page, which shows Chrome's permission prompt there
        await chrome.tabs.sendMessage(tab.id, { action: 'requestMicPermission' }, { frameId: 0 });
        bar.style.display = 'none';
      });
    }
  } catch(e) { /* scripting not available on this page type */ }
})();

// ─── Mic ──────────────────────────────────────────────────────────────────────
micBtn.addEventListener('click', () => {
  if (isListening) {
    port.postMessage({ action: 'stopRecording' });
    setListeningState(false);
  } else {
    port.postMessage({ action: 'startRecording', existingTranscript: transcript });
  }
});

function setListeningState(listening) {
  isListening = listening;
  micBtn.classList.toggle('listening', listening);
  micBtn.innerHTML = listening
    ? '⏹ <span style="font-size:11px;font-weight:600;letter-spacing:0.5px">RECORDING</span>'
    : '🎙';
  micHint.textContent = listening ? 'Click to stop' : 'Click to start recording';
  // Listening overlay replaces the idle mic area while recording
  document.getElementById('listening-panel').style.display = listening ? 'flex' : 'none';
  document.getElementById('mic-idle').style.display        = listening ? 'none' : 'block';
  if (listening) setStatus('listening', 'Listening — speak your exam findings…');
  else if (transcript.trim()) setStatus('ready', 'Transcript ready — click Fill Fields');
  else setStatus('', 'Ready — click mic to dictate your exam');
}

// ─── Transcript ───────────────────────────────────────────────────────────────
transcriptEl.addEventListener('input', () => {
  transcript = transcriptEl.value;
  transcriptEl.classList.toggle('empty', !transcript.trim());
  updateFillBtn();
  updateLiveTranscript();
});

// Mirror the transcript into the listening overlay's card
function updateLiveTranscript() {
  const t = transcriptEl.value.trim();
  document.getElementById('live-transcript-text').textContent =
    t ? '“' + t.slice(-160) + '…”' : 'Speak and your dictation will appear here…';
}

// Stop button inside the listening overlay does the same as the mic button
document.getElementById('stop-btn').addEventListener('click', () => micBtn.click());

function updateFillBtn() { fillBtn.disabled = !transcript.trim(); }

// ─── Clear ────────────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  if (isListening) { port.postMessage({ action: 'stopRecording' }); setListeningState(false); }
  port.postMessage({ action: 'clearRecording' });
  transcript = '';
  transcriptEl.value = '';
  transcriptEl.classList.add('empty');
  resultsArea.classList.remove('visible');
  resultList.innerHTML = '';
  getExamTab().then(tab => tab && sendToPage(tab.id, { action: 'forgetLastFill' })).catch(() => {});
  updateFillBtn();
  setStatus('', 'Ready — click mic to dictate your exam');
});

// ─── Talking to the exam page ─────────────────────────────────────────────────
async function getExamTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs.find(t => t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://'));
}

// Some EMRs put the exam form inside an iframe. Every frame runs content.js; the form frame is the one
// showing the most boxes (the top page on a tie, or when there's nothing to compare).
async function findFormFrame(tabId) {
  const count = () => (typeof countVisibleFields === 'function' ? countVisibleFields() : null);
  try {
    let res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: count });
    const missing = res.filter(r => r.result == null).map(r => r.frameId);
    if (missing.length) {
      // Frames loaded before the extension was installed or reloaded have no content script yet
      await chrome.scripting.executeScript({ target: { tabId, frameIds: missing }, files: ['schema.js', 'content.js'] }).catch(() => {});
      res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: count });
    }
    let best = { frameId: 0, n: 0 };
    for (const r of res) if ((r.result || 0) > best.n) best = { frameId: r.frameId, n: r.result };
    return best.frameId;
  } catch(e) { return 0; }
}

// frameId: pass the frame from an earlier call to keep talking to the same frame (Quick fill scan → fill)
async function sendToPage(tabId, msg, frameId) {
  if (frameId == null) frameId = await findFormFrame(tabId);
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId });
  } catch(e) {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['schema.js', 'content.js'] });
    await new Promise(r => setTimeout(r, 300));
    return chrome.tabs.sendMessage(tabId, msg, { frameId });
  }
}

// ─── EMR setup status + Undo ──────────────────────────────────────────────────
const emrSetup     = document.getElementById('emr-setup');
const emrSetupText = document.getElementById('emr-setup-text');
const undoBtn      = document.getElementById('undo-btn');
let mappedCount = 0;
let customFields = [];   // boxes the doctor labelled themselves on this EMR, sent with the dictation

async function refreshPageStatus() {
  const tab = await getExamTab();
  if (!tab) { emrSetupText.textContent = 'Open your EMR exam page to use OptoFill.'; return; }
  try {
    const s = await sendToPage(tab.id, { action: 'getStatus' });
    mappedCount = s?.mappedCount || 0;
    customFields = s?.customFields || [];
    emrSetup.classList.toggle('warn', mappedCount === 0);
    emrSetupText.textContent = mappedCount
      ? `${mappedCount} exam fields set up for this EMR.`
      : 'This EMR isn’t set up yet — fills are a best guess. Set it up once for reliable filling.';
    document.getElementById('setup-btn').textContent = mappedCount ? 'Edit setup' : 'Set up EMR';
    undoBtn.style.display = s?.undoDepth ? '' : 'none';
    // Reopened after a fill (e.g. the popup closed when you clicked an EMR tab): show its results, with
    // values that have since filled on their tab now ticked
    if (s?.lastFill?.length && !resultsArea.classList.contains('visible')) showResults(schemaItems(s.lastFill), { quiet: true });
  } catch(e) {
    emrSetupText.textContent = 'OptoFill can’t reach this page.';
  }
}
refreshPageStatus();

// The side panel stays open across tabs: when you switch tab or the page reloads, show that page's status
function onTabChange() {
  resultsArea.classList.remove('visible');
  resultList.innerHTML = '';
  refreshPageStatus();
}
chrome.tabs.onActivated?.addListener(onTabChange);
chrome.tabs.onUpdated?.addListener((tabId, info, tab) => { if (info.status === 'complete' && tab.active) onTabChange(); });

document.getElementById('setup-btn').addEventListener('click', async () => {
  const tab = await getExamTab();
  if (!tab) return;
  try {
    await sendToPage(tab.id, { action: 'startSetup' });
    showToast('Setup is open on the page — click any box to tell OptoFill what it is.', 'success');
  } catch(e) { showToast('Could not start setup on this page.', 'error'); }
});

undoBtn.addEventListener('click', async () => {
  const tab = await getExamTab();
  if (!tab) return;
  const r = await sendToPage(tab.id, { action: 'undoFill' }).catch(() => null);
  if (r?.restored) showToast(`↶ Restored ${r.restored} box${r.restored === 1 ? '' : 'es'}`, 'success');
  else showToast('Nothing to undo.', '');
  undoBtn.style.display = r?.undoDepth ? '' : 'none';
  resultsArea.classList.remove('visible');
  setStatus('ready', 'Fill undone — boxes restored');
});

// ─── Fill Fields ──────────────────────────────────────────────────────────────
let pendingTabId = null;
let pendingQuickFields = null;
let pendingQuickFrameId = 0;   // the frame Quick fill scanned, so the fill goes to the same boxes

fillBtn.addEventListener('click', async () => {
  const { apiKey, customInstructions: ci } = await getSettings();
  if (!apiKey) { showToast('Enter your API key in Settings first.', 'error'); showSettingsPanel(); return; }
  if (!transcript.trim()) return;

  fillBtn.disabled = true;
  const tab = await getExamTab();
  if (!tab) { showToast('Open your exam form first.', 'error'); resetFillBtn(); return; }
  pendingTabId = tab.id;

  await refreshPageStatus();
  if (mappedCount > 0) {
    setStatus('processing', 'Reading your dictation…');
    fillBtnContent.innerHTML = '<span class="spinner"></span> Reading…';
    port.postMessage({ action: 'extract', apiKey, transcript: transcript.trim(), customInstructions: ci, customFields });
    return;
  }

  // Quick fill for EMRs that aren't set up: Claude guesses boxes from the page layout
  setStatus('processing', 'Scanning page fields…');
  fillBtnContent.innerHTML = '<span class="spinner"></span> Scanning…';
  let fields;
  try {
    pendingQuickFrameId = await findFormFrame(tab.id);
    fields = (await sendToPage(tab.id, { action: 'getFields' }, pendingQuickFrameId))?.fields;
  } catch(e) {
    showToast('Could not reach page. Make sure you are on your exam form and try again.', 'error');
    resetFillBtn(); return;
  }
  if (!fields || fields.length === 0) { showToast('No form fields found on this page.', 'error'); resetFillBtn(); return; }
  pendingQuickFields = fields;
  setStatus('processing', 'Claude is mapping your exam data…');
  fillBtnContent.innerHTML = '<span class="spinner"></span> Mapping…';
  port.postMessage({ action: 'callClaude', apiKey, transcript: transcript.trim(), fields, customInstructions: ci });
});

async function handleExtractResult(msg) {
  const tabId = pendingTabId;
  if (!msg.ok) { showToast('Claude error: ' + msg.error, 'error'); resetFillBtn(); return; }
  if (!Object.keys(msg.values || {}).length) {
    showToast('No exam findings recognised. Try a more detailed dictation.', 'error');
    resetFillBtn(); return;
  }
  setStatus('processing', 'Filling and checking boxes…');
  fillBtnContent.innerHTML = '<span class="spinner"></span> Filling…';
  let res;
  try { res = await sendToPage(tabId, { action: 'fillSchema', values: msg.values }); }
  catch(e) { showToast('Could not fill fields on the page.', 'error'); resetFillBtn(); return; }
  showResults(schemaItems(res?.results), { redacted: msg.redacted });
  resetFillBtn();
  refreshPageStatus();
}

// Fill results for schema values (from fillSchema or the page's lastFill) → result list items
function schemaItems(results) {
  return (results || []).map(r => ({
    label: r.label.replace(/\s*\([^)]*\)/g, '').replace(/^Visual acuity /, 'VA '), value: r.value, status: r.status, reason: r.reason, key: r.key
  }));
}

async function handleClaudeResult(msg) {
  const fields = pendingQuickFields, tabId = pendingTabId;
  pendingQuickFields = null;
  if (!msg.ok) { showToast('Claude error: ' + msg.error, 'error'); resetFillBtn(); return; }
  const mapping = msg.mapping;
  if (!mapping || !Object.keys(mapping).length) {
    showToast('No fields mapped. Try a more detailed dictation.', 'error');
    resetFillBtn(); return;
  }
  setStatus('processing', 'Filling and checking boxes…');
  fillBtnContent.innerHTML = '<span class="spinner"></span> Filling…';
  let res;
  try { res = await sendToPage(tabId, { action: 'fillFields', mapping }, pendingQuickFrameId); }
  catch(e) { showToast('Could not fill fields on the page.', 'error'); resetFillBtn(); return; }
  showResults((res?.filled || []).map(r => {
    const f = fields[parseInt(r.idx)];
    return { label: f?.row ? [f.row, f.col].filter(Boolean).join(' · ') : (f?.label || `Field ${r.idx}`),
             value: r.value, status: r.ok ? 'filled' : 'failed', reason: r.reason, selector: f?.selector };
  }), { redacted: msg.redacted });
  resetFillBtn();
  refreshPageStatus();
}

// ─── Results ──────────────────────────────────────────────────────────────────
const STATUS_ICON = { filled: '✓', failed: '⚠', pending: '⏳', unmapped: '○' };

// quiet: re-showing results (popup reopened, or waiting values filled) — update the list without a toast
function showResults(items, { quiet = false, redacted = 0 } = {}) {
  resultList.innerHTML = '';
  const order = { failed: 0, unmapped: 1, pending: 2, filled: 3 };
  items.sort((a, b) => order[a.status] - order[b.status]);
  for (const it of items) {
    const ok = it.status === 'filled';
    const color = it.status === 'failed' ? 'var(--danger)' : it.status === 'filled' ? '' : 'var(--gray-600)';
    const item = document.createElement('div');
    item.className = 'result-item';
    item.style.cssText = 'cursor:pointer;flex-wrap:wrap;';
    item.title = ok ? 'Click to show this box on the page' : (it.reason || '');
    const name = document.createElement('span');
    name.className = 'result-field'; name.style.color = color; name.textContent = it.label; name.title = it.label;
    const val = document.createElement('span');
    val.className = 'result-value'; val.style.cssText = `display:flex;align-items:center;gap:5px;color:${color}`;
    val.textContent = String(it.value).substring(0, 28);
    const icon = document.createElement('span');
    icon.className = 'result-status'; icon.textContent = STATUS_ICON[it.status] || '';
    val.appendChild(icon);
    item.append(name, val);
    item.addEventListener('click', async () => {
      if (ok) {
        const tab = await getExamTab();
        if (!tab) return;
        sendToPage(tab.id, it.key ? { action: 'highlightKey', key: it.key } : { action: 'highlightField', selector: it.selector }).catch(() => {});
        return;
      }
      const existing = item.querySelector('.fill-error');
      if (existing) { existing.remove(); return; }
      const errDiv = document.createElement('div');
      errDiv.className = 'fill-error';
      errDiv.style.cssText = 'flex-basis:100%;margin-top:4px;padding:5px 8px;background:var(--danger-lt);border:1px solid rgba(220,38,38,0.25);border-radius:5px;font-size:10.5px;color:var(--gray-600);line-height:1.5;';
      errDiv.textContent = it.reason || 'Not filled';
      item.appendChild(errDiv);
    });
    resultList.appendChild(item);
  }
  resultsArea.classList.add('visible');

  const n = s => items.filter(i => i.status === s).length;
  const filled = n('filled'), failed = n('failed'), unmapped = n('unmapped'), pending = n('pending');
  // Waiting for another EMR tab is expected, not an error: it fills when that tab opens
  setStatus('ready', `Done — ${filled}/${items.length} filled and checked` + (pending ? ` · ${pending} waiting for their tab` : ''));
  if (quiet) return;
  const problems = [failed && `${failed} didn’t stick`, unmapped && `${unmapped} not set up`].filter(Boolean);
  const removed = redacted ? ` · ${redacted} identifier${redacted === 1 ? '' : 's'} removed before sending` : '';
  if (problems.length) showToast(`⚠ ${problems.join(' · ')}`, 'error');
  else if (pending) showToast(`✓ Filled ${filled} · ${pending} more will fill when you open their tab${removed}`, '');
  else showToast(`✓ Filled ${filled} box${filled === 1 ? '' : 'es'}${removed}`, 'success');
}

function setStatus(type, message) {
  statusDot.className = 'status-dot' + (type ? ' '+type : '');
  statusText.textContent = message;
}

function resetFillBtn() {
  fillBtn.disabled = !transcript.trim();
  fillBtnContent.innerHTML = '✦ Fill Fields';
}

function showToast(message, type='') {
  toast.textContent = message;
  toast.className = 'toast' + (type ? ' '+type : '');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function getSettings() {
  return new Promise(resolve => chrome.storage.local.get(['apiKey','customInstructions'], resolve));
}

// Re-fill button — fill values whose boxes are on an EMR tab that wasn't open before
document.getElementById('refill-btn').addEventListener('click', async () => {
  const tab = await getExamTab();
  if (!tab) return;
  const r = await sendToPage(tab.id, { action: 'refillPending' }).catch(() => null);
  const n = (r?.results || []).filter(x => x.status === 'filled').length;
  showToast(n ? `✓ Filled ${n} more box${n === 1 ? '' : 'es'}` : 'Nothing waiting for this tab.', n ? 'success' : '');
});

function showSettingsPanel() { mainPanel.classList.remove('active'); settingsPanel.classList.add('active'); }
function showMainPanel() { settingsPanel.classList.remove('active'); mainPanel.classList.add('active'); }

toggleSettings.addEventListener('click', showSettingsPanel);
backBtn.addEventListener('click', showMainPanel);
saveSettingsBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  const ci = customInstructions.value.trim();
  if (key && !key.startsWith('sk-ant-')) { showToast('API key should start with sk-ant-', 'error'); return; }
  chrome.storage.local.set({ apiKey: key, customInstructions: ci }, () => {
    showToast('Settings saved ✓', 'success');
    setTimeout(showMainPanel, 800);
  });
});
