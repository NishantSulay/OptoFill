// mic-permission.js
// Opens as a tab, requests mic, tells background the result, then closes itself.
(async function() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    // Tell background: permission granted, go start recording
    await chrome.runtime.sendMessage({ action: 'micPermissionResult', granted: true });
  } catch(e) {
    await chrome.runtime.sendMessage({ action: 'micPermissionResult', granted: false, error: e.message });
  }
  // Close this tab
  window.close();
})();
