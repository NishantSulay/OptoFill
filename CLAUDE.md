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
  - `schema.js` — clinical schema + auto-map hints (shared by content script, background, evals)
  - `extract.js` — extraction prompt/request/parse (shared by background and `core/evals`)
  - `quickfill.js` — Quick fill prompt/request/parse (shared by background and `core/evals/quickfill.js`)
  - `content.js` — page scan, layout labels, fill + verify + undo, per-EMR mapping, in-page setup mode (runs in every frame; the popup talks to the frame with the most boxes)
  - `background.js` — API calls; `popup.*` — UI
- `core/mock-emr/` — fake EMR pages for testing (synthetic data only); `framed.html` puts the form in an iframe
- `core/tests/content.test.js` — Playwright tests of content.js against the mock EMR
- `core/evals/` — extraction eval (`cases.json` mock dictations, `run.js`) and Quick fill eval (`quickfill.js`, same cases, graded by box on the mock EMR)
- `index.html` / `privacy.html` — GitHub Pages landing site
- `store-assets/` — Chrome Web Store submission screenshots and notes

## Testing
- Content script: `node core/tests/content.test.js` (needs `playwright`; set `CHROME_PATH` if no bundled browser)
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
saved per-EMR mapping, never by the AI. Do not have the AI emit DOM selectors, CSS classes, or HTML,
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
Active dev branch: `claude/new-repo-setup-xp1pq3`
Mirror to main with: `git push origin claude/new-repo-setup-xp1pq3:main --force-with-lease`
