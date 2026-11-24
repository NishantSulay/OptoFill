# OptoFill desktop (prototype)

The doctor's web EMR and the OptoFill panel in one desktop window, built with Electron. It runs the extension's own
files from `eye-exam-extension/` unchanged: the side panel (`popup.html`), the content script, the background script,
extraction, Quick fill, redaction, word fixes and medical speech. Only the parts of Chrome they rely on are replaced.

```
cd desktop
npm install
npm start                                   # opens a start page; type your EMR's address in the bar
npm start -- --url=https://emr.example.com  # or open it directly
```

The toolbar's **Practice EMR** button opens the mock EMR (`core/mock-emr/`), which has made-up data only.

## How it fits together

| Chrome extension | Desktop app |
|---|---|
| Side panel showing `popup.html` | The right-hand view, loading the same `popup.html` |
| The EMR tab | The left-hand view (its own sandboxed browser profile, so EMR sign-ins persist) |
| `content.js` in every frame | `preload.js` runs `schema.js` + `content.js` in an isolated world in every frame, where the page's own scripts can't see it |
| Service worker `background.js` | A hidden page loading `background.js` and the files it imports |
| `chrome.storage.local` | `optofill-storage.json` in the app's data folder |
| `chrome.runtime` messages and ports, `chrome.tabs`, `chrome.scripting` | `main.js` passes them between the three, by frame |
| Toolbar icon | `Ctrl+Alt+D` (`⌘⌥D` on a Mac) starts and stops dictation from anywhere, even when the window is in the background |

## What's different from the extension

- **Dictation needs Medical speech.** Chrome's built-in speech recognition is a Google service only Chrome itself can
  use. In the app, the doctor turns on Medical speech in Settings with their Deepgram key. Choosing Chrome's speech
  shows a message saying so.
- **Microphone permission** is asked once per EMR site in an app dialog and remembered. Every other permission an
  EMR page asks for is refused, except fullscreen and copying to the clipboard.
- **One EMR view.** Links that open a new window open in the same view, so OptoFill can still see the form. EMRs
  that need several windows at once aren't covered yet.

## Not done yet

- Installers and code signing (electron-builder, an Apple Developer ID, a Windows signing certificate) and auto-update.
- Packaging: `main.js` reads the extension from `../eye-exam-extension`, which an installer would need to copy in.
- Keys are stored the way Chrome stores them (a plain file in the user's profile). Electron's `safeStorage` could
  encrypt them with the OS keychain.

## Test

`node core/tests/desktop.test.js` (from the repo root, after `npm install` here; on Linux without a display, run it
under `xvfb-run -a`). It drives the real app on the mock EMR, with the form inside an iframe and Claude's reply
canned. It covers the panel finding the form's frame, setup, extraction, review, fill, undo, medical speech (with a
fake microphone and a stand-in for Deepgram), in-page setup, and settings kept across a restart.
