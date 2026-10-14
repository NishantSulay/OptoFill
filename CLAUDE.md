# OptoFill — Claude Code Project Rules

## What this project is
OptoFill is a Chrome extension that uses voice dictation + Claude AI to fill out
optometry patient forms (EHR fields). The AI receives a voice transcript and a list
of detected form fields, then returns a structured JSON object mapping field names
to filled values. Content scripts apply those values to the DOM.

## Architecture
- `eye-exam-extension/` — Chrome MV3 extension (background service worker, content script, popup)
- `index.html` / `privacy.html` — GitHub Pages landing site
- `store-assets/` — Chrome Web Store submission screenshots and notes

## Rules for Claude Code sessions

### Mock data only
Never use real patient data. All evals and tests must use synthetic/mock data.
Do not generate realistic patient names, dates of birth, SSNs, or any PHI.

### AI fills the schema, not EMR fields directly
The AI (Claude API) receives the transcript and returns a structured JSON object
mapping field names to values. Content scripts then apply those values to the DOM.
Do not have the AI emit raw DOM selectors, CSS classes, or HTML.

### API key
Set `ANTHROPIC_API_KEY` in your terminal before running evals:
```
export ANTHROPIC_API_KEY=sk-ant-...
```
The key is never committed to the repo. The extension stores it in `chrome.storage.local`.

### Claude model
The extension uses `claude-sonnet-4-6`. Do not change the model without explicit instruction.

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
