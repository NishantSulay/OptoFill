# OptoFill — Claude Code Project Rules

## What this project is
OptoFill is a Chrome extension that uses voice dictation + Claude AI to fill out
optometry EMR exam forms.

Two steps, kept separate:
1. **Extraction (AI):** the dictation is turned into values for a fixed clinical schema
   (`eye-exam-extension/schema.js`, keys like `bv_amplitude_od`). The AI never sees the EMR page.
2. **Mapping (deterministic):** each EMR is set up once — the doctor clicks a box and picks its
   schema key (with auto-suggestions from on-screen row/column labels). Saved per site in
   `chrome.storage.local`. Filling is a lookup, then every box is read back to verify, and the
   fill can be undone.

"Quick fill" (AI maps directly to page boxes) only runs on EMRs that haven't been set up.

## Architecture
- `eye-exam-extension/` — Chrome MV3 extension
  - `schema.js` — clinical schema + auto-map hints (shared by content script, background, evals; `family` tells refraction grids apart by their titles — manifest, habitual, final, auto, retinoscopy, contact lens, keratometry — and `after` maps a box by position, e.g. a K axis); also the normal findings (`OPTOFILL_NORMALS`, editable in Settings) that fill a section the doctor calls normal; also VA modifier keys (`*_mod`), which the AI never sees — content.js splits "20/50-2" into the VA box and its modifier box
  - `redact.js` — removes patient identifiers (names after cues, dates, ID/phone numbers, emails, addresses) from text before it goes to Anthropic
  - `wordfix.js` — the doctor's "heard = meant" fixes for misheard words (Settings), applied to the dictation in the side panel before redaction and the AI
  - `speech.js` — optional medical speech engine (Settings; the doctor's own Deepgram key): eye-care key terms and the streaming session. `content.js` only records the audio and passes it to `background.js`, which holds the connection and falls back to Chrome's recognition if it can't connect
  - `extract.js` — extraction prompt/request/parse (shared by background and `core/evals`)
  - `quickfill.js` — Quick fill prompt/request/parse (shared by background and `core/evals/quickfill.js`)
  - `content.js` — page scan, layout labels, fill + verify + undo, per-EMR mapping, in-page setup mode (runs in every frame; the side panel talks to the frame with the most boxes)
  - `background.js` — API calls; `popup.*` — UI, shown in Chrome's side panel (`side_panel` in manifest.json)
- `core/mock-emr/` — fake EMR pages for testing (synthetic data only; tabs: Pretest/BV, Refraction, Contact Lens, Ocular Health, Assessment/Plan); `framed.html` puts the form in an iframe
- `core/tests/content.test.js` — Playwright tests of content.js against the mock EMR
- `core/tests/replay.js` — rebuilds an EMR screen from a layout report (side panel → Save report: boxes, label texts and panels, never box contents) and runs the real content script on it: `node core/tests/replay.js report.json`. Reports from real EMRs must not be committed unless they came from a test patient and hold no identifiers
- `core/evals/` — extraction eval (`cases.json` mock dictations, `run.js`) and Quick fill eval (`quickfill.js`, same cases, graded by box on the mock EMR)
- `index.html` / `privacy.html` — GitHub Pages landing site
- `demo.html` — try-it page on the site (works on a phone): the mock EMR in a frame running the real `content.js`, with a small stand-in for the side panel. Without an API key only the sample dictation fills, from the recorded reply in `core/demo/sample.js`; with one, `extract.js` reads what was dictated
- `core/demo/` — website video (`node core/demo/record.js` → `assets/optofill-demo.mp4`, `.gif`, `-poster.jpg`) and store screenshots (`node core/demo/screenshots.js` → `store-assets/`): the real side panel and content script on the mock EMR (`stage.html`, `lib.js`), with Claude's reply canned
- `store-assets/` — Chrome Web Store submission screenshots and notes

## Testing
- Content script: `node core/tests/content.test.js` (needs `playwright`; set `CHROME_PATH` if no bundled browser)
- Redaction: `node core/tests/redact.test.js` (no browser; must keep every eval dictation unchanged)
- Section normals: `node core/tests/normals.test.js` (no browser, no API calls)
- Side panel (review before fill, report, setup files): `node core/tests/panel.test.js` (needs `playwright`)
- Layout report and replay: `node core/tests/report.test.js` (needs `playwright`; every mock tab rebuilt from its report must map as the live one, and the real EMR layouts in `core/tests/fixtures/` — labels and box positions only — must map as recorded, from an empty setup and from the older setups saved with them)
- Medical speech: `node core/tests/speech.test.js` (needs `playwright`; stand-in WebSocket and Chrome's fake microphone, no speech account)
- Try-it page: `node core/tests/demo-page.test.js` (needs `playwright`; phone-sized, no API calls)
- Word fixes: `node core/tests/wordfix.test.js` (no browser; the starter fixes must leave every correctly heard eval dictation unchanged)
- Extraction eval: `ANTHROPIC_API_KEY=... node core/evals/run.js` (real API calls; `--dry-run` prints the request)
- Quick fill eval: `ANTHROPIC_API_KEY=... node core/evals/quickfill.js` (real API calls; needs `playwright`)
- Any change to `schema.js` hints or layout detection must keep the content tests passing; any change to
  the extraction or Quick fill prompt must be checked with its eval.

## Rules for Claude Code sessions

### Mock data only
Never use real patient data. All evals and tests must use synthetic/mock data.
Do not generate realistic patient names, dates of birth, SSNs, or any PHI.

### AI fills the schema, not EMR fields directly
The AI returns values for schema keys only. Which box a key goes into is decided by the
saved per-EMR mapping, never by the AI. Custom fields (a box the doctor labels in setup, e.g. "Habitual Rx",
stored as a `custom_*` key in that EMR's mapping) are added to the keys for that EMR — the AI sees only their
names, never the page. Do not have the AI emit DOM selectors, CSS classes, or HTML,
and do not send screenshots or page content to the AI in the schema path.

### API key
Set `ANTHROPIC_API_KEY` in your terminal before running evals:
```
export ANTHROPIC_API_KEY=sk-ant-...
```
The key is never committed to the repo. The extension stores it in `chrome.storage.local`.

### Claude model
Dictation extraction (`extract.js`) uses `claude-haiku-5-5`; Quick fill (`quickfill.js`) uses `claude-sonnet-5-5`.
Do not change either model without explicit instruction.

### Commit author
After every commit run:
```
git config user.email noreply@anthropic.com
git config user.name Claude
```
The stop hook enforces this. If a push is rejected for authorship, amend and re-push.

### Branch
`main` is the release branch, and GitHub Pages publishes the site (`index.html`, `privacy.html`, `demo.html`, `assets/`) from it. `demo.html` loads `eye-exam-extension/*.js` and `core/mock-emr/` from the published site, so a change to those changes the live demo.
Bump `version` in `eye-exam-extension/manifest.json` for each release so the version on chrome://extensions shows what's loaded.
