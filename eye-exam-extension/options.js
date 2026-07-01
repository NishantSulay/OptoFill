document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['apiKey', 'customInstructions'], (data) => {
    if (data.apiKey) document.getElementById('api-key').value = data.apiKey;
    if (data.customInstructions) document.getElementById('custom-instructions').value = data.customInstructions;
  });
  document.getElementById('save-btn').addEventListener('click', saveSettings);
});

function saveSettings() {
  const key = document.getElementById('api-key').value.trim();
  const ci = document.getElementById('custom-instructions').value.trim();
  const status = document.getElementById('status');

  if (!key) { status.className = 'status error'; status.textContent = 'Please enter your API key.'; return; }
  if (!key.startsWith('sk-ant-')) { status.className = 'status error'; status.textContent = 'API key should start with sk-ant-'; return; }

  chrome.storage.local.set({ apiKey: key, customInstructions: ci }, () => {
    document.getElementById('saved-badge').classList.add('show');
    setTimeout(() => document.getElementById('saved-badge').classList.remove('show'), 2500);
    status.className = 'status success';
    status.textContent = '✓ Settings saved — you\'re ready to use OptoFill';
  });
}
