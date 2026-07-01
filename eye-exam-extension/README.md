# 👁 OptoFill — Eye Exam Autofill Chrome Extension

Dictate your full eye exam narrative and let Claude AI automatically fill the correct fields on any optometry web form.

---

## Installation (Desktop Chrome)

1. **Download** this folder to your computer (or transfer from your phone via email/AirDrop/cloud)
2. Open Chrome and go to: `chrome://extensions`
3. Enable **Developer Mode** (toggle, top-right corner)
4. Click **"Load unpacked"**
5. Select the `eye-exam-extension` folder
6. The OptoFill icon (👁) will appear in your Chrome toolbar

---

## First-Time Setup

1. Click the OptoFill icon in Chrome
2. Click ⚙ **Settings**
3. Paste your **Anthropic API Key** (get one at https://console.anthropic.com)
4. Optionally add custom instructions (e.g. notation preferences, patient context)
5. Click **Save Settings**

---

## How to Use

1. Open your optometry exam web form
2. Click the **OptoFill icon** in Chrome
3. Click the 🎙 **mic button** and dictate your full exam:

   > *"Patient presents with blurred distance vision. Best corrected visual acuity is 20/40 right eye, 20/25 left eye. Manifest refraction right eye: sphere negative one point two five, cylinder negative zero point five zero, axis ninety. Left eye: sphere negative zero point seven five, plano cylinder. IOP right twelve, left thirteen. Fundus exam normal OU. Diagnosis: mild myopia. Recommend new glasses."*

4. Click **⏹ Stop** when done
5. Click **✦ Fill Fields**
6. Claude scans the page, maps your findings to the right fields, and fills them — highlighted in teal

---

## How It Works

```
Dictation → Web Speech API (transcription)
         → Claude AI (maps findings to form fields)  
         → Content Script (fills fields on the page)
```

Claude reads the labels, names, and IDs of every visible form field on the page, then intelligently matches your clinical findings to the correct inputs — even on forms it has never seen before.

---

## Tips for Best Results

- **Speak naturally** — full sentences work better than isolated values
- **Name the eye** — say "right eye" / "left eye" or "OD" / "OS"
- **Include units** — "negative one point two five diopters" → -1.25
- **Cover all sections** — VA, refraction, IOP, slit lamp, fundus, diagnosis, plan
- You can **edit the transcript** before clicking Fill if needed
- Add **custom instructions** in Settings for your preferred notation style

---

## Privacy

- Your API key is stored **locally in your browser only** (chrome.storage.local)
- Dictations are sent to Anthropic's API for processing — not stored by this extension
- No data is sent anywhere except directly to `api.anthropic.com`
