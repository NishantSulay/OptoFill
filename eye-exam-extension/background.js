// background.js
importScripts('schema.js', 'redact.js', 'extract.js', 'quickfill.js', 'wordfix.js', 'speech.js');

let popupPort = null;

// OptoFill runs in Chrome's side panel: clicking the toolbar icon opens it, and it stays open while you work in the EMR
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  popupPort = port;
  port.onDisconnect.addListener(() => { popupPort = null; });

  port.onMessage.addListener(async (msg) => {

    if (['startRecording','stopRecording','clearRecording'].includes(msg.action)) {
      const tabId = await getExamTabId();
      if (!tabId) { toPopup({ action:'micError', error:'No active tab. Navigate to your exam page first.' }); return; }
      if (msg.action === 'startRecording') {
        const s = await chrome.storage.local.get(['speechEngine', 'deepgramKey', 'wordFixes']);
        if (s.speechEngine === 'medical' && s.deepgramKey) return startMedical(tabId, msg.existingTranscript, s);
      }
      if (msg.action === 'stopRecording' && medical) return stopMedical();
      if (msg.action === 'clearRecording') discardMedical();
      await sendToTop(tabId, msg);
      return;
    }

    if (msg.action === 'extract') {
      try {
        const meta = {};
        const values = await OptoFillExtract.extractFindings({
          apiKey: msg.apiKey, dictation: msg.transcript, customInstructions: msg.customInstructions, customFields: msg.customFields || [], normals: msg.normals, browser: true, meta
        });
        toPopup({ action:'extractResult', ok:true, values, redacted: meta.redacted || 0 });
      } catch(err) {
        toPopup({ action:'extractResult', ok:false, error:err.message });
      }
    }

    if (msg.action === 'callClaude') {
      try {
        const meta = {};
        const mapping = await OptoFillQuickFill.quickFill({
          apiKey: msg.apiKey, dictation: msg.transcript, fields: msg.fields, customInstructions: msg.customInstructions, browser: true, meta
        });
        toPopup({ action:'claudeResult', ok:true, mapping, redacted: meta.redacted || 0 });
      } catch(err) {
        toPopup({ action:'claudeResult', ok:false, error:err.message });
      }
    }
  });
});

// Dictation always runs in the top page, even when the exam form is in an iframe
async function sendToTop(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch(e) {
    // Content script not loaded — inject and retry
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['schema.js', 'content.js'] });
      await new Promise(r => setTimeout(r, 300));
      await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
    } catch(e2) {
      toPopup({ action:'micError', error:'Could not reach page. Make sure you are on your exam form.' });
    }
  }
}

// ─── Medical speech (Settings → Speech engine) ───────────────────────────────
// The page records and sends the audio here in pieces; this worker streams it to the speech service and passes the
// words on to the side panel. If the service can't be reached, the dictation carries on with Chrome's recognition.
let medical = null;   // { tabId, session, text } for the dictation in progress

function startMedical(tabId, existing, settings) {
  discardMedical();
  const m = medical = { tabId, session: null, text: existing || '' };
  const mine = () => medical === m;
  const fixes = OptoFillWordFix.parse(settings.wordFixes ?? OptoFillWordFix.DEFAULTS);
  m.session = OptoFillSpeech.startSession({
    apiKey: settings.deepgramKey, existing, extraTerms: fixes.map(f => f.meant),
    onStart: () => { if (mine()) toPopup({ action: 'micStarted', engine: 'medical' }); },
    onUpdate: (finalTranscript, interimTranscript) => {
      if (!mine()) return;
      m.text = finalTranscript;
      toPopup({ action: 'transcriptUpdate', finalTranscript, interimTranscript });
    },
    onError: (error) => {
      if (!mine()) return;
      medical = null;
      chrome.tabs.sendMessage(tabId, { action: 'stopAudioCapture', discard: true }, { frameId: 0 }).catch(() => {});
      toPopup({ action: 'speechFallback', error });
      sendToTop(tabId, { action: 'startRecording', existingTranscript: m.text });
    },
    onEnd: () => { if (!mine()) return; medical = null; toPopup({ action: 'micStopped' }); },
  });
  return sendToTop(tabId, { action: 'startAudioCapture' });
}

// Stop: the page sends its last piece of audio and "end", then the service returns the last words
function stopMedical() {
  const m = medical;
  chrome.tabs.sendMessage(m.tabId, { action: 'stopAudioCapture' }, { frameId: 0 }).catch(() => {});
  setTimeout(() => { if (medical === m) m.session.finish(); }, 1500);   // in case "end" never arrives
}

function discardMedical() {
  const m = medical;
  medical = null;
  if (!m) return;
  m.session.discard();
  chrome.tabs.sendMessage(m.tabId, { action: 'stopAudioCapture', discard: true }, { frameId: 0 }).catch(() => {});
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'optofill-audio') return;
  const m = medical;
  port.onMessage.addListener((msg) => {
    if (medical !== m || !m) return;
    if (msg.audio) m.session.sendAudio(Uint8Array.from(atob(msg.audio), c => c.charCodeAt(0)));
    if (msg.end) m.session.finish();
  });
});

// Relay messages from content script → popup
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'audioError') {
    discardMedical();
    toPopup({ action: 'micError', error: msg.error === 'not-allowed' ? 'Microphone is blocked for this page — allow it in the address bar' : msg.error });
    return;
  }
  if (['transcriptUpdate','micError','micStopped','micStarted','micReady','fillUpdated'].includes(msg.action)) {
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
