const $ = id => document.getElementById(id);
const nav = window.optofillNav;
$('go').addEventListener('submit', e => { e.preventDefault(); if ($('url').value.trim()) nav.go($('url').value); });
for (const id of ['back', 'forward', 'reload', 'practice', 'panel']) $(id).addEventListener('click', () => nav.run(id));
nav.onState(s => {
  if ('url' in s && document.activeElement !== $('url')) $('url').value = s.url;
  if ('canGoBack' in s) { $('back').disabled = !s.canGoBack; $('forward').disabled = !s.canGoForward; }
  if ('panelOpen' in s) { $('panel').setAttribute('aria-pressed', s.panelOpen); $('panel').textContent = s.panelOpen ? 'OptoFill ▸' : '◂ OptoFill'; }
});
