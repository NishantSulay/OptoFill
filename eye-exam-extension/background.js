// background.js
importScripts('schema.js', 'extract.js', 'quickfill.js');

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

    if (msg.action === 'extract') {
      try {
        const values = await OptoFillExtract.extractFindings({
          apiKey: msg.apiKey, dictation: msg.transcript, customInstructions: msg.customInstructions, browser: true
        });
        toPopup({ action:'extractResult', ok:true, values });
      } catch(err) {
        toPopup({ action:'extractResult', ok:false, error:err.message });
      }
    }

    if (msg.action === 'callClaude') {
      try {
        const mapping = await OptoFillQuickFill.quickFill({
          apiKey: msg.apiKey, dictation: msg.transcript, fields: msg.fields, customInstructions: msg.customInstructions, browser: true
        });
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
