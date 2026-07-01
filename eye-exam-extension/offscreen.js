// offscreen.js
// Runs in a persistent offscreen document that holds mic permission
// across all tabs and page navigations.

let recognition = null;
let isRecording = false;
let finalTranscript = '';

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== 'offscreen') return;

  if (message.action === 'startRecording') {
    finalTranscript = message.existingTranscript || '';
    startRecording();
  }

  if (message.action === 'stopRecording') {
    stopRecording();
  }

  if (message.action === 'clearRecording') {
    stopRecording();
    finalTranscript = '';
  }
});

function startRecording() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    chrome.runtime.sendMessage({ action: 'micError', error: 'Speech recognition not supported.' });
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += t + ' ';
      } else {
        interim += t;
      }
    }
    chrome.runtime.sendMessage({
      action: 'transcriptUpdate',
      finalTranscript,
      interimTranscript: interim
    });
  };

  recognition.onerror = (e) => {
    if (e.error === 'not-allowed') {
      chrome.runtime.sendMessage({
        action: 'micError',
        error: 'Microphone access denied. Please allow microphone access in Chrome settings.'
      });
    } else if (e.error !== 'no-speech') {
      chrome.runtime.sendMessage({ action: 'micError', error: e.error });
    }
    isRecording = false;
  };

  recognition.onend = () => {
    if (isRecording) {
      try { recognition.start(); } catch(e) {}
    } else {
      chrome.runtime.sendMessage({ action: 'micStopped' });
    }
  };

  isRecording = true;
  try {
    recognition.start();
  } catch(e) {
    chrome.runtime.sendMessage({ action: 'micError', error: e.message });
    isRecording = false;
  }
}

function stopRecording() {
  isRecording = false;
  if (recognition) {
    recognition.stop();
    recognition = null;
  }
}
