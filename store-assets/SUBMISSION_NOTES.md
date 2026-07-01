# Chrome Web Store Submission Notes

## Store Listing Details

### Extension Name
OptoFill – Eye Exam Autofill

### Short Description (132 chars max)
Dictate your eye exam and let AI fill every EHR field instantly. Save 5+ minutes per patient with voice + Claude AI.

### Full Description

**OptoFill turns your voice into a completed patient chart.**

As an optometrist or ophthalmologist, you spend 5–10 minutes per patient manually typing exam findings into your EHR. OptoFill eliminates that entirely. Speak naturally during the exam — OptoFill listens, understands, and fills every form field automatically.

**How it works:**
1. Click the OptoFill icon while your EHR form is open
2. Click 🎙 and dictate your exam findings naturally
3. Click ✦ Fill Fields — Claude AI maps your findings to the correct fields
4. Review the highlighted results and confirm

**What it fills:**
- Visual acuity (OD/OS/OU, distance and near)
- Manifest refraction (sphere, cylinder, axis, prism, add power)
- Intraocular pressure
- Patient information and chief complaint
- Slit lamp and fundus findings
- Diagnosis and clinical notes
- Any other visible form field

**Works everywhere:**
Compatible with any web-based EHR, optometry practice management system, or online form — WebPT, Eyefinity, Crystal PM, and more. No integration, no IT setup, no configuration needed.

**Privacy first:**
- Your API key is stored locally on your device only
- No audio is ever transmitted — transcription happens on-device
- No data is collected by OptoFill
- One secure call to Anthropic's API per fill, nothing else

**Requirements:**
- Your own Anthropic API key (get one free at console.anthropic.com)
- Works on any web-based EHR or optometry form

---

## Permission Justifications
(Copy-paste these into the Chrome Web Store "Permission justification" field)

### activeTab
OptoFill needs access to the currently active tab to scan form fields and fill them when the user explicitly clicks "Fill Fields." This permission is used only when the user interacts with the extension — it is never used passively.

### storage
Required to store the user's Anthropic API key and custom instructions locally on their device using chrome.storage.local. No data is synced to the cloud or transmitted to OptoFill.

### scripting
Required to inject the field-scanning and field-filling content script into the active EHR tab when the user clicks "Fill Fields." The script reads visible form field labels and fills matched values. It runs only on explicit user action and is not injected passively.

### host_permissions: <all_urls>
OptoFill is designed for use on any web-based EHR or optometry practice management system. These platforms can be hosted on any domain (e.g., clinic-specific subdomains, white-labeled SaaS products). It is technically impossible to enumerate all possible EHR URLs in advance. This permission is used only when the user explicitly clicks "Fill Fields" on their currently open EHR tab — it is never used to access arbitrary websites passively or in the background.

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
- `screenshot-1.png` — Extension in action filling an eye exam form (1280×800)
- `screenshot-2.png` — How it works step-by-step (1280×800)
- `screenshot-3.png` — Privacy and security features (1280×800)

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
3. **Data use disclosure** — Already handled in privacy policy
