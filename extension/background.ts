/*
 * Manifest permission justification — keep this block in sync with extension/manifest.json.
 *
 * tests/extension-background.test.ts pins the exact permission and host lists, and requires
 * every entry to be justified on its own line here. Adding a permission in one place only
 * fails that test, so the extension can never request new access by accident.
 *
 *   storage          Consent (mirror:enabled), per-tab mirror sessions, the popup target
 *                    language, and pending captures must survive MV3 worker restarts.
 *   tabs             Open the mirror beside its source tab, focus an existing mirror, and
 *                    close it when the source navigates or closes.
 *   webRequest       Read response Content-Type headers so a PDF served without a .pdf
 *                    suffix is still detected; onHeadersReceived only, never blocking.
 *   scripting        Re-read the source page DOM before trusting a content-script report, so
 *                    a page cannot point the reader at an unrelated PDF.
 *   activeTab        The popup may read or capture the visible tab, but only after the user
 *                    clicks the action or runs a command.
 *   nativeMessaging  Optional local desktop companion; never connected during detection,
 *                    translation, or ordinary reader acquisition.
 *   contextMenus     "Mở bản dịch Mirror" for a page or for a link target.
 *   host_permissions  every http/https host and file:/// — the detector inspects response
 *                    headers and embedded objects on whatever page the user browses.
 *                    Nothing is uploaded; the only fetch is the detected PDF, with the
 *                    user's own cookies, into the extension reader.
 */
import { MirrorController, pdfPath, sourceUrl, type MirrorSession } from './controller';
import { createTranslationTransport } from '../src/core/translation';
import type { TranslationSettings } from '../src/core/types';
import { NativeCompanion, NATIVE_HOST, normalizeNativePage, sameSession, COMPANION_UNAVAILABLE, type NativeAnnotation, type NativeAnnotationKind } from './native-bridge';

const viewerUrl = chrome.runtime.getURL('index.html');
const popupUrl = chrome.runtime.getURL('popup.html');
const sessionKey = (id: number) => `mirror:session:${id}`;
const SESSION_PREFIX = 'mirror:session:';
const CONTEXT_MENU_ID = 'mirror-open';
const CAPTURE_PREFIX = 'data:image/png;base64,';
const CAPTURE_MAX_CHARS = 20_000_000;
const CAPTURE_TTL_MS = 120_000;
const notices = {
  invalidSource: 'Chỉ mở bản dịch cho tệp PDF. Hãy mở tệp PDF rồi chọn lại.',
  enabled: 'Đã bật tự động mở bản dịch.',
  disabled: 'Đã tắt tự động mở bản dịch.',
};
interface Capture { id: string; image: string; sourceTabId: number; createdAt: number }

const controller = new MirrorController({
  enabled: async () => (await chrome.storage.local.get('mirror:enabled'))['mirror:enabled'] === true,
  load: async id => (await chrome.storage.session.get(sessionKey(id)))[sessionKey(id)] as MirrorSession | undefined,
  save: async (id, session) => { if (session) await chrome.storage.session.set({ [sessionKey(id)]: session }); else await chrome.storage.session.remove(sessionKey(id)); },
  open: async (url, sourceTabId) => {
    const source = await chrome.tabs.get(sourceTabId);
    const tab = await chrome.tabs.create({ url, openerTabId: sourceTabId, index: source.index + 1, active: false });
    if (tab.id === undefined) throw new Error('Chrome did not create the mirror tab.');
    return tab.id;
  },
  isOpen: async viewerTabId => {
    try { await chrome.tabs.get(viewerTabId); return true; } catch { return false; }
  },
  close: async viewerTabId => { await chrome.tabs.remove(viewerTabId); },
  viewerUrl,
  fetcher: (input, init) => fetch(input, init),
});
const transport = createTranslationTransport();
const transfers = new Map<string, { bytes: Uint8Array; viewer: number; created: number }>();
const captures = new Map<number, Capture>();
const viewStates = new Map<number, { page: number; fraction: number; zoom?: number }>();
const mimePdfTabs = new Set<number>();
const companion = new NativeCompanion(() => {
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
  return port;
}, async (session, page) => {
  const state = { page: page.page + 1, fraction: page.fraction, zoom: page.zoom };
  viewStates.set(session.sourceTabId, state);
  await chrome.runtime.sendMessage({ type: 'mirror:view-state', state, targetTabId: session.viewerTabId, sourceTabId: session.sourceTabId, origin: 'desktop' }).catch(() => {});
});
async function authorizeDesktop(session: MirrorSession): Promise<{ tabId: number; url: string }> {
  const viewer = await chrome.tabs.get(session.viewerTabId);
  const identity = { tabId: viewer.id!, url: viewer.url ?? '' };
  const current = await controller.authorize(identity);
  const source = await chrome.tabs.get(session.sourceTabId);
  if (!sameSession(current, session) || sourceUrl(source.url ?? '') !== session.documentUrl) throw new Error('The PDF source changed. Reopen its current mirror before sending to desktop.');
  return identity;
}
async function activeDesktopSource(): Promise<{ session: MirrorSession; title: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || !tab.url) throw new Error('Select an active PDF source tab or its bound mirror first.');
  const session = isReader({ id: chrome.runtime.id, url: tab.url })
    ? await controller.authorize({ tabId: tab.id, url: tab.url })
    : (await chrome.storage.session.get(sessionKey(tab.id)))[sessionKey(tab.id)] as MirrorSession | undefined;
  if (!session || (tab.id === session.sourceTabId && sourceUrl(tab.url) !== session.documentUrl)) throw new Error('No authorized PDF source for this tab. Enable automatic mirrors and open a PDF first. Captures and unbound readers cannot be sent to desktop.');
  await authorizeDesktop(session);
  const source = await chrome.tabs.get(session.sourceTabId);
  return { session, title: source.title ?? 'Browser PDF' };
}

function parseNativeAnnotation(value: unknown): NativeAnnotation {
  if (!value || typeof value !== 'object') throw new Error('Invalid desktop annotation.');
  const annotation = value as Record<string, unknown>;
  const kind = annotation.kind;
  const validKind = kind === 'highlight' || kind === 'underline' || kind === 'note' || kind === 'selection';
  if (typeof annotation.id !== 'string' || annotation.id.length === 0 || annotation.id.length > 128 || [...annotation.id].some(character => character.charCodeAt(0) < 32) || !Number.isSafeInteger(annotation.page) || Number(annotation.page) < 0 || Number(annotation.page) > 65535 || !validKind || typeof annotation.text !== 'string' || [...annotation.text].length > 4000 || [...annotation.text].some(character => character.charCodeAt(0) < 32 && !'\n\r\t'.includes(character)) || !Number.isFinite(annotation.x) || !Number.isFinite(annotation.y) || !Number.isFinite(annotation.width) || !Number.isFinite(annotation.height) || Number(annotation.x) < 0 || Number(annotation.y) < 0 || Number(annotation.width) <= 0 || Number(annotation.height) <= 0 || Number(annotation.x) + Number(annotation.width) > 1 || Number(annotation.y) + Number(annotation.height) > 1 || !Number.isSafeInteger(annotation.baseRevision) || Number(annotation.baseRevision) < 0) throw new Error('Invalid desktop annotation.');
  return { id: annotation.id as string, page: annotation.page as number, x: annotation.x as number, y: annotation.y as number, width: annotation.width as number, height: annotation.height as number, kind: kind as NativeAnnotationKind, text: annotation.text as string, baseRevision: annotation.baseRevision as number };
}
function isReader(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return `${url.protocol}//${url.host}${url.pathname}` === viewerUrl;
  } catch { return false; }
}
function isPopup(sender: chrome.runtime.MessageSender): boolean { return sender.id === chrome.runtime.id && sender.url === popupUrl; }
function report(error: unknown): void { console.warn('Mirror PDF', error); }
function pngCapture(image: unknown): image is string {
  if (typeof image !== 'string' || !image.startsWith(CAPTURE_PREFIX) || image.length <= CAPTURE_PREFIX.length || image.length > CAPTURE_MAX_CHARS) return false;
  const body = image.slice(CAPTURE_PREFIX.length);
  return body.length % 4 === 0 && !body.includes(' ') && !body.includes('\n');
}
async function runDetect(tabId: number, documentUrl: string, candidate: string, force = false): Promise<void> {
  await controller.detect(tabId, documentUrl, candidate, { force });
  await updateBadge();
}
async function discover(tabId: number, documentUrl: string, url: string): Promise<void> { await runDetect(tabId, documentUrl, url); }
async function rescanTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined || !sourceUrl(tab.url ?? '')) continue;
    if (pdfPath(tab.url)) await runDetect(tab.id, tab.url!, tab.url!);
    else await chrome.tabs.sendMessage(tab.id, { type: 'mirror:rescan' }).catch(() => {});
  }
}

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0 || !details.responseHeaders?.some(h => h.name.toLowerCase() === 'content-type' && /^application\/pdf(?:;|$)/i.test(h.value ?? ''))) return;
  mimePdfTabs.add(details.tabId);
  void chrome.tabs.get(details.tabId).then(tab => discover(details.tabId, details.type === 'main_frame' ? details.url : tab.url ?? '', details.url)).catch(report);
  return undefined;
}, { urls: ['http://*/*', 'https://*/*', 'file:///*'], types: ['main_frame', 'sub_frame', 'object'] }, ['responseHeaders']);

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url) {
    companion.revoke(tabId); viewStates.delete(tabId); mimePdfTabs.delete(tabId);
    for (const [captureId, capture] of captures) if (capture.sourceTabId === tabId) captures.delete(captureId);
    void controller.navigate(tabId, change.url).catch(report);
  }
  const url = change.url ?? tab.url;
  if (url && pdfPath(url) && (change.url || change.status === 'complete')) void discover(tabId, url, url).catch(report);
});
chrome.tabs.onRemoved.addListener(tabId => {
  companion.revoke(tabId);
  viewStates.delete(tabId);
  mimePdfTabs.delete(tabId);
  captures.delete(tabId);
  for (const [id, capture] of captures) if (capture.sourceTabId === tabId) captures.delete(id);
  for (const [id, transfer] of transfers) if (transfer.viewer === tabId) transfers.delete(id);
  void removeTabSessions(tabId).catch(report);
});
async function removeTabSessions(tabId: number): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keys: string[] = [];
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(SESSION_PREFIX)) continue;
    const session = value as MirrorSession;
    if (session.sourceTabId !== tabId && session.viewerTabId !== tabId) continue;
    keys.push(key);
    if (session.sourceTabId === tabId && session.viewerTabId !== tabId) await chrome.tabs.remove(session.viewerTabId).catch(() => {});
  }
  if (keys.length) await chrome.storage.session.remove(keys);
  await updateBadge();
}

async function notifyTab(tabId: number, message: string): Promise<void> {
  await chrome.tabs.sendMessage(tabId, { type: 'mirror:notice', message }).catch(() => {});
}
async function reveal(session: MirrorSession): Promise<boolean> {
  try {
    await chrome.tabs.get(session.viewerTabId);
    await chrome.tabs.update(session.viewerTabId, { active: true });
    return true;
  } catch { return false; }
}
async function contextMirror(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<void> {
  const tabId = tab?.id;
  if (tabId === undefined || !tab) return;
  const source = tab;
  const documentUrl = source.url ?? info.pageUrl ?? '';
  if (!sourceUrl(documentUrl)) { await notifyTab(tabId, notices.invalidSource); return; }
  const session = (await chrome.storage.session.get(sessionKey(tabId)))[sessionKey(tabId)] as MirrorSession | undefined;
  if (session && session.documentUrl === sourceUrl(documentUrl)) {
    if (await reveal(session)) return;
    await chrome.storage.session.remove(sessionKey(tabId));
    await runDetect(tabId, documentUrl, session.pdfUrl, true);
    return;
  }
  const candidate = info.linkUrl ?? info.pageUrl ?? documentUrl;
  if (!pdfPath(candidate) && !mimePdfTabs.has(tabId)) { await notifyTab(tabId, notices.invalidSource); return; }
  await runDetect(tabId, documentUrl, candidate, true);
}
function createContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: CONTEXT_MENU_ID, title: 'Mở bản dịch Mirror', contexts: ['page', 'link'] });
  });
}
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_ID) void contextMirror(info, tab).catch(report);
});
chrome.runtime.onInstalled.addListener(() => { createContextMenus(); void updateBadge().catch(report); });

async function toggleMirrors(): Promise<void> {
  const enabled = (await chrome.storage.local.get('mirror:enabled'))['mirror:enabled'] === true;
  await chrome.storage.local.set({ 'mirror:enabled': !enabled, 'mirror:consentVersion': 1 });
  await updateBadge();
  if (!enabled) await rescanTabs();
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id !== undefined) await notifyTab(active.id, enabled ? notices.disabled : notices.enabled);
}
async function capturePage(tab: chrome.tabs.Tab | undefined): Promise<void> {
  if (!tab || tab.active === false || tab.id === undefined || tab.windowId === undefined || !sourceUrl(tab.url ?? '')) throw new Error('Select an active web page first.');
  const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  await openCapture(tab.id, image);
}
async function openCapture(sourceTabId: number, image: string): Promise<{ viewerTabId: number; captureId: string }> {
  if (!pngCapture(image)) throw new Error('Capture must be a PNG data URL under 20 MB.');
  for (const [captureId, capture] of captures) if (Date.now() - capture.createdAt > CAPTURE_TTL_MS) captures.delete(captureId);
  const source = await chrome.tabs.get(sourceTabId);
  if (source.active === false || !sourceUrl(source.url ?? '')) throw new Error('Capture only supports the current accessible source tab.');
  const tab = await chrome.tabs.create({ url: `${viewerUrl}?capture=1&sourceTab=${sourceTabId}`, openerTabId: sourceTabId });
  if (tab.id === undefined) throw new Error('Could not open captured mirror.');
  const captureId = crypto.randomUUID();
  captures.set(tab.id, { id: captureId, image, sourceTabId, createdAt: Date.now() });
  void chrome.runtime.sendMessage({ type: 'mirror:capture-ready', captureId, targetTabId: tab.id, sourceTabId }).catch(() => {});
  await updateBadge();
  return { viewerTabId: tab.id, captureId };
}
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-mirror') void toggleMirrors().catch(report);
  else if (command === 'capture-page') void capturePage(tab).catch(report);
});

async function handle(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (sender.id !== chrome.runtime.id) throw new Error('Invalid extension sender.');
  const identity = { tabId: sender.tab?.id, url: sender.url };
  switch (message.type) {
    case 'mirror:desktop-status': {
      if (!isPopup(sender)) throw new Error('Use the extension action to query the desktop companion.');
      let sourceAvailable = false;
      let sourceStatus = '';
      try { await activeDesktopSource(); sourceAvailable = true; } catch (error) { sourceStatus = error instanceof Error ? error.message : 'No active PDF source.'; }
      try {
        await companion.probe();
        return { ok: true, available: true, sourceAvailable, following: companion.following, transferring: companion.transferring, status: companion.following ? 'Desktop companion is following the selected PDF locally.' : sourceStatus || 'Desktop companion ready. Open in desktop sends this PDF locally, with no provider upload.' };
      } catch { return { ok: true, available: false, sourceAvailable, following: false, status: COMPANION_UNAVAILABLE }; }
    }
    case 'mirror:desktop-open': {
      if (!isPopup(sender)) throw new Error('Open in desktop requires the explicit extension action.');
      const { session, title } = await activeDesktopSource();
      await companion.open(session,
        async () => controller.fetchPdf(await authorizeDesktop(session), session.pdfUrl),
        async () => { await authorizeDesktop(session); },
        normalizeNativePage(viewStates.get(session.sourceTabId)), title);
      return { ok: true, status: 'PDF delivered to the local desktop inbox. Following page changes until you stop, close, or navigate the source. Open PDF Workspace to view it.' };
    }
    case 'mirror:annotation': {
      if (!isReader(sender)) throw new Error('Desktop annotations require the bound extension reader.');
      const session = await controller.authorize(identity);
      return { ok: true, ...(await companion.annotation(session, parseNativeAnnotation(message.annotation))) };
    }
    case 'mirror:desktop-stop': {
      if (!isPopup(sender)) throw new Error('Use the extension action to stop following.');
      await companion.stop();
      return { ok: true, status: 'Desktop following stopped. Already imported local PDF copies are retained.' };
    }
    case 'mirror:discovered': {
      if (sender.tab?.id === undefined || !sender.url || sender.frameId !== 0) throw new Error('A source document is required.');
      if (!sourceUrl(sender.url) || typeof message.url !== 'string' || !sourceUrl(message.url)) throw new Error('Unsupported source URL.');
      const results = await chrome.scripting.executeScript({ target: { tabId: sender.tab.id }, func: () => Array.from(document.querySelectorAll('embed,object,iframe')).map(element => element.getAttribute('src') ?? element.getAttribute('data')).filter((value): value is string => !!value).map(value => new URL(value, document.baseURI).href) });
      if (!results.some(result => result.result?.some(url => sourceUrl(url) === sourceUrl(message.url as string)))) throw new Error('PDF is not embedded in the source document.');
      await discover(sender.tab.id, sender.tab.url ?? sender.url, message.url);
      return { ok: true };
    }
    case 'mirror:fetch-pdf': {
      if (typeof message.url !== 'string') throw new Error('A PDF URL is required.');
      const bytes = await controller.fetchPdf(identity, message.url);
      if (bytes.length <= 8 * 1024 * 1024) return { ok: true, data: Array.from(bytes) };
      for (const [id, transfer] of transfers) if (Date.now() - transfer.created > 120_000) transfers.delete(id);
      const transferId = crypto.randomUUID();
      transfers.set(transferId, { bytes, viewer: sender.tab!.id!, created: Date.now() });
      return { ok: true, transferId, size: bytes.length, chunkSize: 256 * 1024 };
    }
    case 'mirror:fetch-pdf-chunk': {
      await controller.authorize(identity);
      const transfer = transfers.get(String(message.transferId));
      const offset = message.offset;
      if (!transfer || transfer.viewer !== sender.tab?.id || Date.now() - transfer.created > 120_000 || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset >= transfer.bytes.length) throw new Error('PDF transfer expired or invalid. Reload the reader.');
      const end = Math.min(offset + 256 * 1024, transfer.bytes.length);
      const data = Array.from(transfer.bytes.subarray(offset, end));
      if (end === transfer.bytes.length) transfers.delete(String(message.transferId));
      return { ok: true, data, done: end === transfer.bytes.length };
    }
    case 'mirror:translate': {
      if (!isReader(sender)) throw new Error('Only the extension reader can translate.');
      const request = message.request as { text?: unknown; settings?: TranslationSettings } | undefined;
      if (!request || typeof request.text !== 'string' || request.text.length > 200_000 || !request.settings || !['local', 'google', 'deepl', 'openai'].includes(request.settings.provider)) throw new Error('Invalid translation request.');
      const text = await transport.translate({ text: request.text, settings: request.settings, signal: AbortSignal.timeout(60_000) });
      return { ok: true, text };
    }
    case 'mirror:view-state': {
      const state = message.state as { page?: number; fraction?: number; zoom?: number } | undefined;
      if (!state || !Number.isInteger(state.page) || state.page! < 1 || typeof state.fraction !== 'number' || !Number.isFinite(state.fraction) || state.fraction < 0 || state.fraction > 1 || (state.zoom !== undefined && (typeof state.zoom !== 'number' || !Number.isFinite(state.zoom) || state.zoom < 0.1 || state.zoom > 10))) throw new Error('Invalid view state.');
      let session: MirrorSession;
      let destination: number;
      if (isReader(sender)) { session = await controller.authorize(identity); destination = session.sourceTabId; }
      else {
        if (sender.tab?.id === undefined || sender.frameId !== 0) throw new Error('Invalid source tab.');
        const sourceSession = (await chrome.storage.session.get(sessionKey(sender.tab.id)))[sessionKey(sender.tab.id)] as MirrorSession | undefined;
        if (!sourceSession || sourceUrl(sender.url ?? '') !== sourceSession.documentUrl) throw new Error('Unknown source tab.');
        session = sourceSession;
        destination = session.viewerTabId;
      }
      const normalized = { page: state.page!, fraction: state.fraction, zoom: typeof state.zoom === 'number' && Number.isFinite(state.zoom) ? state.zoom : viewStates.get(session.sourceTabId)?.zoom };
      viewStates.set(session.sourceTabId, normalized);
      void companion.page(session, normalizeNativePage(normalized));
      if (isReader(sender)) await chrome.tabs.sendMessage(destination, { type: 'mirror:view-state', state }).catch(() => {});
      else await chrome.runtime.sendMessage({ type: 'mirror:view-state', state, targetTabId: destination, sourceTabId: sender.tab!.id }).catch(() => {});
      return { ok: true };
    }
    case 'mirror:open-capture': {
      if (!isPopup(sender) || typeof message.sourceTabId !== 'number' || !Number.isInteger(message.sourceTabId)) throw new Error('Capture requires the extension action.');
      const capture = await openCapture(message.sourceTabId, message.image as string);
      return { ok: true, viewerTabId: capture.viewerTabId };
    }
    case 'mirror:get-capture': {
      if (!isReader(sender) || sender.tab?.id === undefined) throw new Error('Invalid capture reader.');
      const capture = captures.get(sender.tab.id);
      if (!capture) throw new Error('Capture expired. Capture the visible source tab again.');
      if (typeof message.captureId === 'string' && message.captureId !== capture.id) throw new Error('Capture does not belong to this viewer.');
      captures.delete(sender.tab.id);
      if (Date.now() - capture.createdAt > CAPTURE_TTL_MS) throw new Error('Capture expired. Capture the visible source tab again.');
      return { ok: true, image: capture.image, sourceTabId: capture.sourceTabId, captureId: capture.id };
    }
    case 'mirror:rescan': {
      if (!isPopup(sender)) throw new Error('Use the extension action.');
      await rescanTabs();
      return { ok: true };
    }
    default: throw new Error('Unknown mirror request.');
  }
}
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string' || !message.type.startsWith('mirror:')) return false;
  void handle(message as Record<string, unknown>, sender).then(respond, error => respond({ ok: false, error: error instanceof Error ? error.message : 'Extension request failed.' }));
  return true;
});

async function updateBadge(): Promise<void> {
  const sessions = await chrome.storage.session.get(null);
  const count = Object.keys(sessions).filter(key => key.startsWith(SESSION_PREFIX)).length;
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#147d66' });
}
chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local' || area === 'session') void updateBadge().catch(report); });
chrome.runtime.onStartup.addListener(() => { void updateBadge().catch(report); });
