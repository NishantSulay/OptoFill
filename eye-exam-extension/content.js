// content.js — field scanning, filling, and speech recognition

let recognition = null;
let isRecording = false;
let finalTranscript = '';

function startRecording(existingTranscript) {
  finalTranscript = existingTranscript || '';

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    chrome.runtime.sendMessage({ action: 'micError', error: 'Speech recognition not supported in Chrome.' });
    return;
  }

  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onstart = () => {
    // Recognition actually started — mic is live
    isRecording = true;
    chrome.runtime.sendMessage({ action: 'micStarted' });
  };

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalTranscript += t + ' ';
      else interim += t;
    }
    chrome.runtime.sendMessage({ action: 'transcriptUpdate', finalTranscript, interimTranscript: interim });
  };

  recognition.onerror = (e) => {
    if (e.error === 'not-allowed') {
      isRecording = false;
      // Watch for permission to be granted, then auto-restart
      navigator.permissions.query({ name: 'microphone' }).then(status => {
        if (status.state === 'granted') {
          // Already granted somehow — just retry immediately
          startRecording(finalTranscript);
        } else {
          // Watch for the user to click Allow
          status.onchange = () => {
            if (status.state === 'granted') {
              status.onchange = null;
              startRecording(finalTranscript);
            }
          };
        }
      }).catch(() => {});
    } else if (e.error !== 'no-speech') {
      chrome.runtime.sendMessage({ action: 'micError', error: e.error });
      isRecording = false;
    }
  };

  recognition.onend = () => {
    if (isRecording) { try { recognition.start(); } catch(e) {} }
    else chrome.runtime.sendMessage({ action: 'micStopped' });
  };

  // Start directly - if mic permission needed Chrome will fire onerror('not-allowed')
  // If granted, onstart fires confirming recording is live
  try { recognition.start(); } catch(e) {
    chrome.runtime.sendMessage({ action: 'micError', error: e.message });
  }
}

function stopRecording() {
  isRecording = false;
  if (recognition) { recognition.stop(); recognition = null; }
}

// Find question text for a radio/checkbox by searching wider DOM context
function getRadioQuestionText(el) {
  // Walk up the DOM looking for a field container, then find the question label inside it
  // This handles Gravity Forms, WPForms, and similar structures where the question label
  // is a sibling of the input container, not a direct parent/ancestor of the input itself.
  let node = el.parentElement;
  for (let i = 0; i < 8 && node && node !== document.body; i++) {
    // Look for a question label that is NOT a label[for=...] option label
    // Gravity Forms uses .gfield_label, WPForms uses .wpforms-field-label, etc.
    const questionLabel = node.querySelector(
      'label:not([for]), .gfield_label, .wpforms-field-label, .field-label, legend, .label-text'
    );
    if (questionLabel && !questionLabel.closest('ul,ol')) {
      const text = questionLabel.innerText.replace(/\*/g, '').trim();
      if (text.length > 2) return text;
    }
    // Also check: first label in container that isn't an option label
    const allLabels = Array.from(node.querySelectorAll('label'));
    const questionLbl = allLabels.find(l => !l.getAttribute('for') && l.innerText.trim().length > 2);
    if (questionLbl) {
      const text = questionLbl.innerText.replace(/\*/g, '').trim();
      if (text.length > 2) return text;
    }
    // Table row: sibling cells
    if (node.tagName === 'TR') {
      const cells = Array.from(node.querySelectorAll('td,th'));
      const textCell = cells.find(c => !c.contains(el) && c.innerText.trim().length > 2);
      if (textCell) return textCell.innerText.trim();
    }
    // Fieldset legend
    if (node.tagName === 'FIELDSET') {
      const leg = node.querySelector('legend');
      if (leg) return leg.innerText.replace(/\*/g, '').trim();
    }
    node = node.parentElement;
  }
  return '';
}

function injectFieldHighlights(fields) {
  removeFieldHighlights();
  fields.forEach((f, i) => {
    try {
      const el = document.querySelector(f.selector);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const overlay = document.createElement('div');
      overlay.className = 'optofill-hl';
      overlay.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;border:2px solid #2563eb;background:rgba(37,99,235,0.08);z-index:2147483647;pointer-events:none;box-sizing:border-box`;
      const badge = document.createElement('span');
      badge.textContent = i;
      badge.style.cssText = `position:absolute;top:-2px;left:-2px;background:#facc15;color:#000;border:1px solid #000;font-size:15px;font-family:Arial,sans-serif;font-weight:bold;padding:0 4px;line-height:18px`;
      overlay.appendChild(badge);
      document.body.appendChild(overlay);
    } catch(e) {}
  });
}

function removeFieldHighlights() {
  document.querySelectorAll('.optofill-hl').forEach(el => el.remove());
}

// Short visible text snippets with their on-screen boxes, used to label fields by layout
function getTextAnchors() {
  const anchors = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let n;
  while ((n = walker.nextNode())) {
    const text = n.textContent.replace(/\s+/g, ' ').trim();
    if (text.length < 2 || text.length > 40) continue;
    const p = n.parentElement;
    if (!p || p.closest('.optofill-hl, script, style, noscript, option, select, textarea')) continue;
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (getComputedStyle(p).visibility === 'hidden') continue;
    anchors.push({ text, r });
  }
  return anchors;
}

function getLayoutContext(el, anchors) {
  const f = el.getBoundingClientRect();
  if (!f.width || !f.height) return { row: '', col: '', context: '' };
  const cy = a => (a.r.top + a.r.bottom) / 2;
  const cx = a => (a.r.left + a.r.right) / 2;

  // Row label: nearest text to the left on the same horizontal band
  let row = null;
  for (const a of anchors) {
    if (a.r.right > f.left + 2 || f.left - a.r.right > 400) continue;
    if (cy(a) < f.top - 4 || cy(a) > f.bottom + 4) continue;
    if (!row || a.r.right > row.r.right) row = a;
  }

  // Column header: nearest text directly above, horizontally within the field
  let col = null;
  for (const a of anchors) {
    if (a.r.bottom > f.top + 2 || f.top - a.r.bottom > 250) continue;
    if (cx(a) < f.left - 4 || cx(a) > f.right + 4) continue;
    if (!col || a.r.bottom > col.r.bottom) col = a;
  }

  // Nearby headings above, for section context (e.g. "Near Vision", "BV Vergences")
  const skip = new Set([row?.text, col?.text]);
  const context = anchors
    .filter(a => a.r.bottom <= f.top + 2 && f.top - a.r.bottom < 300 &&
                 a.r.right >= f.left - 250 && a.r.left <= f.right + 50 && !skip.has(a.text))
    .sort((a, b) => b.r.bottom - a.r.bottom)
    .map(a => a.text)
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, 3)
    .join(' / ');

  return { row: row?.text || '', col: col?.text || '', context };
}

function getAllFields(withLayout) {
  const anchors = withLayout ? getTextAnchors() : null;
  const fields = [], seen = new Set();
  const selectors = [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
    'textarea', 'select'
  ];
  document.querySelectorAll(selectors.join(', ')).forEach((el, rawIndex) => {
    const style = window.getComputedStyle(el);
    if (style.display==='none'||style.visibility==='hidden'||el.offsetParent===null) return;
    if (seen.has(el)) return;
    seen.add(el);
    const id=el.id||'', name=el.name||'', placeholder=el.placeholder||'';
    const type=el.type||el.tagName.toLowerCase();
    let label='';
    if (el.getAttribute('aria-label')) label=el.getAttribute('aria-label');
    else if (id) { const l=document.querySelector(`label[for="${id}"]`); if(l) label=l.innerText.trim(); }
    if (!label) { const p=el.closest('label'); if(p) label=p.innerText.replace(el.value||'','').trim(); }
    if (!label&&el.getAttribute('aria-labelledby')) { const r=document.getElementById(el.getAttribute('aria-labelledby')); if(r) label=r.innerText.trim(); }
    if (!label) { const prev=el.previousElementSibling; if(prev&&['LABEL','SPAN','P','DIV','TH','LEGEND'].includes(prev.tagName)) label=prev.innerText.trim(); }
    // For radio/checkbox: combine group question + option label
    if (type==='radio'||type==='checkbox') {
      // Option label from label[for=id] e.g. "Yes", "No", "Allergies"
      const optionLabel = id ? document.querySelector(`label[for="${id}"]`)?.innerText?.trim() : '';
      // Group question from gfield_label or similar e.g. "Do you drive?", "Medical History"
      const question = getRadioQuestionText(el);
      // Value attribute as fallback
      const val = el.value && !['on','off','true','false','1','0'].includes(el.value.toLowerCase()) ? el.value : '';
      const option = optionLabel || val;
      if (question && option && question.toLowerCase() !== option.toLowerCase()) {
        label = question + ' — ' + option;
      } else if (option) {
        label = option;
      } else if (question) {
        label = question;
      }
    }
    if (!label) label=name||id||placeholder||`field_${rawIndex}`;
    const options=el.tagName==='SELECT'?Array.from(el.options).map(o=>({value:o.value,text:o.text.trim()})):[];
    const layout = anchors ? getLayoutContext(el, anchors) : {};
    fields.push({ index:fields.length, label:label.substring(0,80), name:name.substring(0,40), id:id.substring(0,40), type, placeholder:placeholder.substring(0,60), options, selector:buildSelector(el), ...layout });
  });
  return fields;
}

function buildSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if (el.name) return `${el.tagName.toLowerCase()}[name="${el.name}"]`;
  let path='', node=el;
  while (node&&node!==document.body) {
    const tag=node.tagName.toLowerCase();
    const siblings=Array.from(node.parentNode?.children||[]).filter(c=>c.tagName===node.tagName);
    path=`${tag}:nth-of-type(${siblings.indexOf(node)+1})${path?' > '+path:''}`;
    node=node.parentNode;
  }
  return path;
}

function fillFields(mapping, fields) {
  const filled=[];
  Object.entries(mapping).forEach(([idxStr, value]) => {
    const meta=fields[parseInt(idxStr)]; if(!meta) return;
    let el=null; try { el=document.querySelector(meta.selector); } catch(e) {}
    if (!el) return;
    try {
      const tag=el.tagName.toLowerCase(), type=(el.type||'').toLowerCase();
      if (tag==='select') {
        const v=String(value).toLowerCase();
        for (const opt of el.options) {
          if (opt.value.toLowerCase()===v||opt.text.toLowerCase().includes(v)||v.includes(opt.text.toLowerCase())) { el.value=opt.value; break; }
        }
      } else if (type==='radio') {
        const shouldCheck = ['true','1','yes','checked'].includes(String(value).toLowerCase());
        if (shouldCheck && !el.checked) {
          el.checked = true;
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } else if (type==='checkbox') {
        const shouldCheck = ['true','1','yes','checked'].includes(String(value).toLowerCase());
        if (el.checked !== shouldCheck) {
          // Gravity Forms requires clicking the label, not the input directly
          const lbl = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
          if (lbl) {
            lbl.click();
          } else {
            el.click();
          }
          // Verify it worked, force if not
          if (el.checked !== shouldCheck) {
            el.checked = shouldCheck;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      } else {
        const proto = el.tagName==='TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter ? setter.call(el, String(value)) : (el.value = String(value));
      }
      // Fire input events for text fields (radio/checkbox already handled above)
      if (type!=='radio'&&type!=='checkbox') {
        ['input','change','blur'].forEach(e=>el.dispatchEvent(new Event(e,{bubbles:true})));
      }
      el.style.transition='outline 0.3s, background 0.3s';
      el.style.outline='2px solid #2dd4bf';
      el.style.background='rgba(45,212,191,0.08)';
      setTimeout(()=>{ el.style.outline=''; el.style.background=''; },1800);
      filled.push({ idx: idxStr, label: meta.label, selector: meta.selector, value: String(value) });
    } catch(e) {
      console.warn('OptoFill fill error:', meta.label, e);
      filled.push({ idx: idxStr, label: meta.label, selector: meta.selector, value: String(value), error: e.message });
    }
  });
  return filled;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action==='getFields')       { sendResponse({fields:getAllFields(true)}); return true; }
  if (msg.action==='fillFields')      { sendResponse({filled:fillFields(msg.mapping,getAllFields())}); return true; }
  if (msg.action==='injectHighlights'){ injectFieldHighlights(msg.fields); sendResponse({done:true}); return true; }
  if (msg.action==='removeHighlights'){ removeFieldHighlights(); sendResponse({done:true}); return true; }
  if (msg.action==='highlightField') {
    try {
      const el = document.querySelector(msg.selector);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.transition = 'outline 0.2s, background 0.2s';
        el.style.outline = '3px solid #f87171';
        el.style.background = 'rgba(248,113,113,0.15)';
        setTimeout(() => { el.style.outline = '2px solid #2dd4bf'; el.style.background = 'rgba(45,212,191,0.08)'; }, 1200);
        setTimeout(() => { el.style.outline = ''; el.style.background = ''; }, 3000);
      }
    } catch(e) {}
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action==='startRecording'){ startRecording(msg.existingTranscript); sendResponse({ok:true}); return true; }
  if (msg.action==='stopRecording') { stopRecording(); sendResponse({ok:true}); return true; }
  if (msg.action==='clearRecording'){ stopRecording(); finalTranscript=''; sendResponse({ok:true}); return true; }
  if (msg.action==='requestMicPermission') {
    // Triggered by setup bar click — requests mic permission on this page
    // Chrome will show prompt, user clicks Allow, permission cached for this site forever
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => { stream.getTracks().forEach(t => t.stop()); })
      .catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
});

// ─── Multi-tab form support ───────────────────────────────────────────────────
// When a form has tabs, fields in hidden tabs aren't in the DOM yet.
// We watch for tab clicks and re-fill any pending mappings automatically.

let pendingMapping = null;

// Store the last mapping so we can re-apply it when tabs switch
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'storeMappingForRetry') {
    pendingMapping = msg.mapping;
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === 'refillCurrentTab') {
    if (pendingMapping) {
      const fields = getAllFields();
      fillFields(pendingMapping, fields);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'No mapping stored yet' });
    }
    return true;
  }
});

// Watch for tab/accordion clicks that reveal new form sections
function watchForTabSwitches() {
  document.addEventListener('click', async (e) => {
    if (!pendingMapping) return;

    // Check if the click target looks like a tab, step, or accordion trigger
    const el = e.target.closest('[role="tab"], [role="button"], .tab, .nav-link, .nav-item, .step, button');
    if (!el) return;

    // Wait for new tab content to render, then re-fill
    setTimeout(() => {
      if (!pendingMapping) return;
      const fields = getAllFields();
      if (fields.length > 0) {
        fillFields(pendingMapping, fields);
      }
    }, 400); // 400ms for tab animation to complete
  }, true);

  // Watch for DOM mutations that add new form fields (lazy-rendered tabs)
  // Throttled so we don't hammer fill on every tiny DOM change
  let mutationTimer = null;
  const observer = new MutationObserver((mutations) => {
    if (!pendingMapping) return;
    // Only care about mutations that add input/select/textarea elements
    const hasNewFields = mutations.some(m =>
      Array.from(m.addedNodes).some(n =>
        n.nodeType === 1 && (
          n.matches?.('input,select,textarea') ||
          n.querySelector?.('input,select,textarea')
        )
      )
    );
    if (!hasNewFields) return;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      const fields = getAllFields();
      if (fields.length > 0) fillFields(pendingMapping, fields);
    }, 300);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: false
  });
}

watchForTabSwitches();
