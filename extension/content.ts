const seen = new Set<string>();
let lastState = '';
let applying = false;
function scan(): void {
  void chrome.storage.local.get('mirror:enabled').then(config => {
    if (config['mirror:enabled'] !== true) return;
    for (const element of document.querySelectorAll('embed,object,iframe')) {
      const raw = element.getAttribute('src') ?? element.getAttribute('data');
      if (!raw) continue;
      const url = new URL(raw, document.baseURI).href;
      const type = element.getAttribute('type') ?? '';
      if (!/^application\/pdf(?:;|$)/i.test(type) && !/\.pdf(?:[?#]|$)/i.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      void chrome.runtime.sendMessage({ type: 'mirror:discovered', url }).then(result => { if (!result?.ok) seen.delete(url); }).catch(() => { seen.delete(url); });
    }
    const canvasViewer = document.querySelector('canvas') && (/pdf|document|reader|viewer/i.test(document.title + ' ' + location.pathname) || document.querySelector('[class*="pdfViewer"], [data-page-number]'));
    if (canvasViewer && !document.getElementById('mirror-capture-hint')) {
      const hint = document.createElement('aside');
      hint.id = 'mirror-capture-hint';
      hint.setAttribute('role', 'status');
      hint.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:2147483647;max-width:320px;background:#102a24;color:white;padding:14px;border:1px solid #73988b;border-radius:8px;font:13px/1.5 system-ui;box-shadow:0 4px 24px #0004';
      const text = document.createElement('span');
      text.textContent = 'Canvas document detected. If no PDF mirror opens, use Mirror PDF’s extension action to capture the visible page. Capture does not unlock protected content.';
      const close = document.createElement('button');
      close.textContent = 'Dismiss';
      close.style.cssText = 'display:block;margin-top:8px;cursor:pointer';
      close.addEventListener('click', () => hint.remove());
      hint.append(text, close);
      document.documentElement.append(hint);
    }
  }).catch(() => {});
}
let scanTimer: ReturnType<typeof setTimeout> | undefined;
new MutationObserver(() => { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 300); }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data', 'type'] });
chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'mirror:rescan') { seen.clear(); scan(); }
  if (message.type === 'mirror:view-state' && message.state) {
    const { page, fraction } = message.state as { page: number; fraction: number };
    const target = document.querySelector(`[data-page-number="${Number(page)}"]`);
    if (!target) return;
    applying = true;
    const rect = target.getBoundingClientRect();
    window.scrollBy({ top: rect.top + rect.height * Math.max(0, Math.min(1, Number(fraction))), behavior: 'instant' });
    setTimeout(() => { applying = false; }, 100);
  }
});
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes['mirror:enabled']) { seen.clear(); scan(); } });
window.addEventListener('scroll', () => {
  if (applying) return;
  const pages = [...document.querySelectorAll('[data-page-number]')];
  const page = pages.find(element => element.getBoundingClientRect().bottom > 0);
  if (!page) return;
  const rect = page.getBoundingClientRect();
  const state = { page: Number(page.getAttribute('data-page-number')), fraction: Math.max(0, Math.min(1, -rect.top / rect.height)) };
  const key = JSON.stringify(state);
  if (key === lastState) return;
  lastState = key;
  void chrome.runtime.sendMessage({ type: 'mirror:view-state', state }).catch(() => {});
}, { passive: true });
scan();
