let isListening = false;
let transcript = '';
let port = null;
let pendingFillFields = null;
let pendingTabId = null;

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
        // Tell content script to call getUserMedia on the page
        // This will trigger Chrome's permission prompt, closing this popup — that's intentional
        // After allowing, user reopens popup and mic works instantly
        await chrome.tabs.sendMessage(tab.id, { action: 'requestMicPermission' });
        window.close();
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
  if (listening) setStatus('listening', 'Listening — speak your exam findings…');
  else if (transcript.trim()) setStatus('ready', 'Transcript ready — click Fill Fields');
  else setStatus('', 'Ready — click mic to dictate your exam');
}

// ─── Transcript ───────────────────────────────────────────────────────────────
transcriptEl.addEventListener('input', () => {
  transcript = transcriptEl.value;
  transcriptEl.classList.toggle('empty', !transcript.trim());
  updateFillBtn();
});

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
  updateFillBtn();
  setStatus('', 'Ready — click mic to dictate your exam');
});

// ─── Fill Fields ──────────────────────────────────────────────────────────────
fillBtn.addEventListener('click', async () => {
  const { apiKey, customInstructions: ci } = await getSettings();
  if (!apiKey) { showToast('Enter your API key in Settings first.', 'error'); showSettingsPanel(); return; }
  if (!transcript.trim()) return;

  setStatus('processing', 'Scanning page fields…');
  fillBtn.disabled = true;
  fillBtnContent.innerHTML = '<span class="spinner"></span> Scanning…';

  let fields, tabId;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs.find(t => t.url && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('chrome://'));
    if (!tab) throw new Error('No exam tab found');
    tabId = tab.id;

    // Try sending message to content script
    let response = null;
    try {
      response = await chrome.tabs.sendMessage(tabId, { action: 'getFields' });
    } catch(e) {
      // Content script not loaded yet — inject it now and retry
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await new Promise(r => setTimeout(r, 300)); // wait for script to initialize
      response = await chrome.tabs.sendMessage(tabId, { action: 'getFields' });
    }
    fields = response?.fields;
  } catch(e) {
    showToast('Could not reach page. Make sure you are on your exam form and try again.', 'error');
    resetFillBtn(); return;
  }

  if (!fields || fields.length === 0) {
    showToast('No form fields found on this page.', 'error');
    resetFillBtn(); return;
  }

  setStatus('processing', 'Claude is mapping your exam data…');
  fillBtnContent.innerHTML = '<span class="spinner"></span> Mapping…';
  pendingFillFields = fields;
  pendingTabId = tabId;

  port.postMessage({ action: 'callClaude', apiKey, transcript: transcript.trim(), fields, customInstructions: ci });
});

async function handleClaudeResult(msg) {
  const fields = pendingFillFields, tabId = pendingTabId;
  pendingFillFields = null; pendingTabId = null;

  if (!msg.ok) { showToast('Claude error: ' + msg.error, 'error'); resetFillBtn(); return; }
  const mapping = msg.mapping;
  if (!mapping || !Object.keys(mapping).length) {
    showToast('No fields mapped. Try a more detailed dictation.', 'error');
    resetFillBtn(); return;
  }

  setStatus('processing', 'Filling fields…');
  fillBtnContent.innerHTML = '<span class="spinner"></span> Filling…';

  // Fill fields and capture debug result in one call
  let fillResult = null;
  try {
    fillResult = await chrome.tabs.sendMessage(tabId, { action: 'fillFields', mapping });
  } catch(e) {
    showToast('Could not fill fields on the page.', 'error');
    resetFillBtn(); return;
  }

  // Store mapping in content script so it auto-fills when form tabs switch
  chrome.tabs.sendMessage(tabId, { action: 'storeMappingForRetry', mapping }).catch(() => {});

  const attempted = Object.keys(mapping).length;
  const actuallyFilled = fillResult?.filled?.filter(f => !f.error)?.length ?? attempted;
  const failed = fillResult?.filled?.filter(f => f.error) ?? [];

  showResults(mapping, fields, fillResult?.filled ?? []);
  setStatus('ready', `Done — ${actuallyFilled}/${attempted} field(s) filled`);
  resetFillBtn();

  if (failed.length > 0) {
    showToast(`⚠ ${failed.length} field(s) could not be filled`, 'error');
  } else {
    showToast(`✓ Filled ${actuallyFilled} fields`, 'success');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function showResults(mapping, fields, fillResults = []) {
  resultList.innerHTML = '';
  // Build a map of idx -> fill result for status icons
  const fillMap = {};
  fillResults.forEach(r => { fillMap[r.idx] = r; });

  Object.entries(mapping).forEach(([idx, value]) => {
    const field = fields[parseInt(idx)];
    const label = field?.label || field?.name || field?.id || `Field ${idx}`;
    const selector = field?.selector || '';
    const fillInfo = fillMap[idx];
    const didFill = fillInfo && !fillInfo.error;
    const item = document.createElement('div');
    item.className = 'result-item';
    item.style.cssText = 'cursor:pointer;';
    item.title = didFill ? 'Click to highlight this field on the page' : (fillInfo?.error || 'Field not found on page');
    item.innerHTML = `
      <span class="result-field" title="${label}" style="color:${didFill ? '' : 'var(--danger)'}">${label}</span>
      <span class="result-value" style="display:flex;align-items:center;gap:5px;color:${didFill ? '' : 'var(--danger)'}">
        ${String(value).substring(0,28)}
        <span style="font-size:11px;">${didFill ? '🔍' : '⚠'}</span>
      </span>
    `;
    item.addEventListener('click', async () => {
      if (didFill && selector) {
        // Scroll to and highlight the field on the page
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const tab = tabs.find(t => t.url && !t.url.startsWith('chrome-extension://'));
        if (!tab) return;
        chrome.tabs.sendMessage(tab.id, { action: 'highlightField', selector });
      } else {
        // Show error reason inline
        const existing = item.querySelector('.fill-error');
        if (existing) { existing.remove(); return; }
        const errDiv = document.createElement('div');
        errDiv.className = 'fill-error';
        errDiv.style.cssText = 'margin-top:4px;padding:5px 8px;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:5px;font-size:10.5px;color:#f87171;line-height:1.5;grid-column:1/-1;';
        const reason = fillInfo?.error
          ? `Error: ${fillInfo.error}`
          : selector
            ? `Selector not found on page: ${selector}`
            : `Claude mapped this field but no selector was generated — field label may be ambiguous`;
        errDiv.textContent = reason;
        item.style.flexWrap = 'wrap';
        item.appendChild(errDiv);
      }
    });
    resultList.appendChild(item);
  });
  resultsArea.classList.add('visible');
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

// Re-fill button — manually re-apply mapping to current tab's visible fields
document.getElementById('refill-btn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs.find(t => t.url && !t.url.startsWith('chrome-extension://'));
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { action: 'refillCurrentTab' }).catch(() => {});
  showToast('Re-filling visible fields…', '');
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
