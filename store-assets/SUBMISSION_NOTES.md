# Chrome Web Store Submission Notes

## Store Listing Details

### Extension Name
OptoFill – Eye Exam Autofill

### Short Description (132 chars max)
Dictate your eye exam and OptoFill fills your web-based EMR's exam form, checks every box, and lets you undo. Powered by Claude.

### Full Description

**Dictate the eye exam. OptoFill fills the form.**

OptoFill turns your spoken exam findings into entries on your web-based EMR's exam form — visual acuity, refraction, IOP, pupils, binocular vision, slit lamp and fundus findings, assessment and plan.

**How it works:**
1. Add your Anthropic API key in OptoFill's Settings (stored only on your computer).
2. Set up your EMR once: open the exam screen, start setup, and let Auto-map suggest what each box is from its row and column labels. Click any box to correct it.
3. Click 🎙 in the OptoFill popup and dictate your findings.
4. Click ✦ Fill Fields. Claude turns your dictation into standard exam values, and OptoFill puts each one in the box you set up.
5. Every box is read back to confirm the value took; anything that didn't is listed. One click undoes the whole fill.

On an EMR you haven't set up yet, Quick fill lets Claude match values to boxes from the page's labels.

**What it fills:**
- Visual acuity (distance and near, sc/cc, OD/OS/OU)
- Manifest refraction (sphere, cylinder, axis, add, prism) and PD
- Intraocular pressure, pupils, cover test, NPC, vergences, EOMs, color vision, stereo
- Slit lamp and fundus findings
- Chief complaint, assessment, plan and notes

**Works with web-based EMRs:** any EMR that runs in Chrome, including exam forms split across tabs or embedded in a frame. You set each EMR up once; no integration from your EMR vendor is needed.

**Privacy:**
- No OptoFill servers, no analytics. Your API key and EMR setup are stored only on your computer.
- Chrome's built-in speech recognition sends your audio to Google to transcribe it.
- Your dictation text is sent to Anthropic's API (Claude) when you click Fill Fields. In Quick fill, labels and nearby text from the page are sent too.
- Do not dictate patient names or other identifiers. You are responsible for complying with the health privacy laws that apply to you.

**Requirements:**
- Your own Anthropic API key with credit (console.anthropic.com). You pay Anthropic directly — in our tests, less than a tenth of a cent per fill on a set-up EMR.
- Google Chrome and a web-based EMR.

---

## Permission Justifications
(Copy-paste these into the Chrome Web Store "Permission justification" field)

### activeTab
Lets OptoFill work with the tab the user is on when they open the popup: scanning the exam form's boxes during setup and filling them when the user clicks "Fill Fields."

### storage
Stores the user's Anthropic API key, custom instructions, and per-EMR setup (which box holds which exam value) locally with chrome.storage.local, and the current transcript in chrome.storage.session. Nothing is synced or sent to OptoFill.

### scripting
Used to load OptoFill's page script into the EHR tab if it isn't loaded yet, and to count the form boxes in each frame so OptoFill can find an exam form that is embedded in an iframe.

### host_permissions: <all_urls>
OptoFill is for any web-based EHR or optometry practice management system, and these are hosted on many different domains (clinic-specific subdomains, white-labeled products), so the URLs cannot be listed in advance. The content script loads on pages so it is ready when the user opens OptoFill, but it does not read, fill, or send anything from a page until the user uses OptoFill on that page (setup, dictation, or Fill Fields).

---

## Category
Productivity

## Language
English

## Privacy Policy URL
https://nishantsulay.github.io/OptoFill/privacy.html

## Homepage URL
https://nishantsulay.github.io/OptoFill

---

## Developer Account Setup

1. Go to: https://chrome.google.com/webstore/devconsole
2. Sign in with your Google account
3. Pay the one-time $5 developer registration fee
4. Click "New Item" and upload the ZIP file

## How to Create the ZIP for Submission

Run this from the repo root:
```bash
cd eye-exam-extension
zip -r ../optofill-extension.zip . -x "*.DS_Store" -x "__MACOSX/*"
```

Upload `optofill-extension.zip` to the Chrome Web Store dashboard.

---

## Screenshots Required
Upload these from the `store-assets/` folder:
- `screenshot-1.png` — Extension in action filling an eye exam form (1280×800) — **outdated: the dictation includes a patient name, age and sex, and the header shows a DOB. Replace it before submitting.**
- `screenshot-2.png` — How it works step-by-step (1280×800) — **outdated: says "no setup needed". Replace it before submitting.**
- `screenshot-3.png` — Privacy and security features (1280×800) — **outdated: it claims audio is transcribed on-device, "scripts only run when you click Fill" and "HIPAA-ready". Replace it before submitting.**

Store icon (128×128) is already in `eye-exam-extension/icons/icon128.png`.

---

## Expected Review Timeline
- Standard review: 1–3 business days
- Extended review (triggered by `<all_urls>` permission): 1–3 weeks
- You will receive an email from Google with the outcome

## If Google Requests Changes
Common requests for extensions with broad permissions:
1. **Narrower permissions** — If asked, explain that EHR URLs cannot be known in advance
2. **Single-purpose statement** — "This extension's sole purpose is to fill optometry EHR form fields from voice dictation"
3. **Data use disclosure** — See the privacy policy (audio to Google via Chrome's speech recognition, dictation to Anthropic)
