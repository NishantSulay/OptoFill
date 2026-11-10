// Medical speech-to-text (optional, Settings → Speech engine): the dictation audio is streamed to Deepgram's medical
// model with a list of eye-care terms, instead of Chrome's general-purpose recognition. Used by background.js (which
// holds the connection; the page only records) and core/tests/speech.test.js.
(function (root) {
  const MODEL = 'nova-3-medical';
  const ENDPOINT = 'wss://api.deepgram.com/v1/listen';
  const MAX_TERMS = 100;   // Deepgram's limit for key terms on one request

  // Eye-care words a general recogniser gets wrong. Most-missed first: the list is cut at MAX_TERMS.
  const TERMS = [
    'OD', 'OS', 'OU', 'PERRLA', 'APD', 'EOMs', 'plano', 'sphere', 'cylinder', 'axis', 'add', 'prism', 'diopters',
    'C/D', 'cup to disc', 'IOP', 'NCT', 'Goldmann', 'iCare', 'pachymetry', 'tonometry', 'Van Herick', 'gonioscopy',
    'exophoria', 'esophoria', 'exotropia', 'esotropia', 'hyperphoria', 'orthophoria', 'ortho', 'NPC', 'stereopsis',
    'Randot', 'Ishihara', 'confrontation fields', 'cover test', 'vergences', 'accommodation', 'amplitude',
    'manifest', 'retinoscopy', 'autorefraction', 'keratometry', 'lensometry', 'pinhole', 'count fingers', 'hand motion',
    'conjunctiva', 'cornea', 'anterior chamber', 'iris', 'sclera', 'lids and lashes', 'tear breakup time', 'TBUT',
    'nuclear sclerosis', 'cortical', 'posterior subcapsular', 'pseudophakia', 'pinguecula', 'pterygium', 'blepharitis',
    'meibomian', 'punctate', 'staining', 'injection', 'arcus', 'macula', 'fovea', 'foveal reflex', 'drusen', 'vitreous',
    'PVD', 'periphery', 'optic nerve', 'neuroretinal rim', 'peripapillary', 'A/V ratio', 'nicking', 'lattice',
    'retinal tear', 'retinal detachment', 'tropicamide', 'phenylephrine', 'cyclopentolate', 'proparacaine',
    'fluorescein', 'BIO', '90 diopter', 'Optomap', 'OCT', 'visual field', 'presbyopia', 'myopia', 'hyperopia',
    'astigmatism', 'amblyopia', 'glaucoma suspect', 'base curve', 'RTC',
  ];

  // The doctor's own words (the "meant" side of their word fixes) go first: they are the ones that matter to them
  function keyterms(extra = []) {
    const seen = new Set(), out = [];
    for (const t of [...extra, ...TERMS]) {
      const term = String(t || '').trim();
      if (!term || term.length > 40 || seen.has(term.toLowerCase())) continue;
      seen.add(term.toLowerCase());
      out.push(term);
      if (out.length === MAX_TERMS) break;
    }
    return out;
  }

  function listenUrl(terms) {
    const q = [`model=${MODEL}`, 'interim_results=true', 'smart_format=true', ...terms.map(t => 'keyterm=' + encodeURIComponent(t))];
    return `${ENDPOINT}?${q.join('&')}`;
  }

  // One dictation. The key travels as a WebSocket subprotocol, not in the URL.
  //   onStart()                  the service accepted the connection: the mic is live
  //   onUpdate(final, interim)   the whole dictation so far (existing text included) and the words still changing
  //   onError(message)           could not connect, or the connection dropped; nothing more follows
  //   onEnd(final)               finished after finish(): every word heard has been delivered
  // After discard() nothing is called again: late words must not come back into a cleared dictation.
  function startSession({ apiKey, existing = '', extraTerms = [], WebSocketImpl = root.WebSocket, onStart, onUpdate, onError, onEnd, finishTimeoutMs = 3000 }) {
    let final = existing ? existing.replace(/\s*$/, ' ') : '';
    let live = true, opened = false, finishing = false, timer = null;
    const queue = [];   // audio recorded before the connection opened
    const ws = new WebSocketImpl(listenUrl(keyterms(extraTerms)), ['token', apiKey]);
    ws.binaryType = 'arraybuffer';

    const end = () => { if (!live) return; live = false; clearTimeout(timer); onEnd && onEnd(final); };
    ws.onopen = () => {
      if (!live) return;
      opened = true;
      for (const chunk of queue.splice(0)) ws.send(chunk);
      onStart && onStart();
    };
    ws.onmessage = (e) => {
      if (!live) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (msg.type !== 'Results') return;
      const text = (msg.channel?.alternatives?.[0]?.transcript || '').trim();
      if (msg.is_final) { if (text) final += text + ' '; onUpdate && onUpdate(final, ''); }
      else onUpdate && onUpdate(final, text);
    };
    ws.onerror = () => {};   // a close always follows, with the reason
    ws.onclose = (e) => {
      if (!live) return;
      if (finishing) return end();
      live = false;
      clearTimeout(timer);
      onError && onError(opened ? 'The medical speech connection dropped' : 'Could not connect to medical speech — check the Deepgram key in Settings');
    };

    return {
      sendAudio(chunk) {
        if (!live || finishing) return;
        if (opened) ws.send(chunk); else queue.push(chunk);
      },
      // Stop: the service sends the last words it heard, then closes
      finish() {
        if (!live || finishing) return;
        finishing = true;
        if (!opened) { try { ws.close(); } catch (_) {} return end(); }
        try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {}
        timer = setTimeout(() => { try { ws.close(); } catch (_) {} end(); }, finishTimeoutMs);
      },
      discard() {
        live = false;
        clearTimeout(timer);
        try { ws.close(); } catch (_) {}
      },
    };
  }

  const api = { MODEL, TERMS, MAX_TERMS, keyterms, listenUrl, startSession };
  root.OptoFillSpeech = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
