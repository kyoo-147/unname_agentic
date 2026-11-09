import { MirrorController, sourceUrl, type MirrorSession } from './controller';
import { createTranslationTransport } from '../src/core/translation';
import type { TranslationSettings } from '../src/core/types';
import { NativeCompanion, NATIVE_HOST, normalizeNativePage, sameSession, COMPANION_UNAVAILABLE } from './native-bridge';

const viewerUrl = chrome.runtime.getURL('index.html');
const popupUrl = chrome.runtime.getURL('popup.html');
const sessionKey = (id: number) => `mirror:session:${id}`;
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
  viewerUrl,
  fetcher: (input, init) => fetch(input, init),
});
const transport = createTranslationTransport();
const transfers = new Map<string, { bytes: Uint8Array; viewer: number; created: number }>();
const captures = new Map<number, { image: string; sourceTabId: number }>();
const viewStates = new Map<number, { page: number; fraction: number; zoom?: number }>();
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

function isReader(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  const url = new URL(sender.url);
  return `${url.protocol}//${url.host}${url.pathname}` === viewerUrl;
}
function report(error: unknown): void { console.warn('Mirror PDF', error); }
async function discover(tabId: number, documentUrl: string, url: string): Promise<void> {
  await controller.detect(tabId, documentUrl, url);
}

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0 || !details.responseHeaders?.some(h => h.name.toLowerCase() === 'content-type' && /^application\/pdf(?:;|$)/i.test(h.value ?? ''))) return;
  void chrome.tabs.get(details.tabId).then(tab => discover(details.tabId, details.type === 'main_frame' ? details.url : tab.url ?? '', details.url)).catch(report);
  return undefined;
}, { urls: ['http://*/*', 'https://*/*', 'file:///*'], types: ['main_frame', 'sub_frame', 'object'] }, ['responseHeaders']);

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url) { companion.revoke(tabId); viewStates.delete(tabId); void controller.navigate(tabId, change.url).catch(report); }
  const url = change.url ?? tab.url;
  if (url && /\.pdf(?:[?#]|$)/i.test(url) && (change.url || change.status === 'complete')) void discover(tabId, url, url).catch(report);
});
chrome.tabs.onRemoved.addListener(tabId => {
  companion.revoke(tabId);
  viewStates.delete(tabId);
  void chrome.storage.session.get(null).then(async all => {
    const keys = Object.entries(all).filter(([key, value]) => key.startsWith('mirror:session:') && ((value as MirrorSession).sourceTabId === tabId || (value as MirrorSession).viewerTabId === tabId)).map(([key]) => key);
    if (keys.length) await chrome.storage.session.remove(keys);
  }).catch(report);
  captures.delete(tabId);
  for (const [id, transfer] of transfers) if (transfer.viewer === tabId) transfers.delete(id);
});

async function handle(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (sender.id !== chrome.runtime.id) throw new Error('Invalid extension sender.');
  const identity = { tabId: sender.tab?.id, url: sender.url };
  switch (message.type) {
    case 'mirror:desktop-status': {
      if (sender.url !== popupUrl) throw new Error('Use the extension action to query the desktop companion.');
      let sourceAvailable = false;
      let sourceStatus = '';
      try { await activeDesktopSource(); sourceAvailable = true; } catch (error) { sourceStatus = error instanceof Error ? error.message : 'No active PDF source.'; }
      try {
        await companion.probe();
        return { ok: true, available: true, sourceAvailable, following: companion.following, transferring: companion.transferring, status: companion.following ? 'Desktop companion is following the selected PDF locally.' : sourceStatus || 'Desktop companion ready. Open in desktop sends this PDF locally, with no provider upload.' };
      } catch { return { ok: true, available: false, sourceAvailable, following: false, status: COMPANION_UNAVAILABLE }; }
    }
    case 'mirror:desktop-open': {
      if (sender.url !== popupUrl) throw new Error('Open in desktop requires the explicit extension action.');
      const { session, title } = await activeDesktopSource();
      await companion.open(session,
        async () => controller.fetchPdf(await authorizeDesktop(session), session.pdfUrl),
        async () => { await authorizeDesktop(session); },
        normalizeNativePage(viewStates.get(session.sourceTabId)), title);
      return { ok: true, status: 'PDF delivered to the local desktop inbox. Following page changes until you stop, close, or navigate the source. Open PDF Workspace to view it.' };
    }
    case 'mirror:desktop-stop': {
      if (sender.url !== popupUrl) throw new Error('Use the extension action to stop following.');
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
      if (!state || !Number.isInteger(state.page) || state.page! < 1 || typeof state.fraction !== 'number' || !Number.isFinite(state.fraction) || state.fraction < 0 || state.fraction > 1) throw new Error('Invalid view state.');
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
      if (sender.url !== popupUrl || typeof message.image !== 'string' || !message.image.startsWith('data:image/png;base64,') || message.image.length > 20_000_000 || typeof message.sourceTabId !== 'number') throw new Error('Capture requires the extension action.');
      const source = await chrome.tabs.get(message.sourceTabId);
      if (!source.active || !sourceUrl(source.url ?? '')) throw new Error('Capture only supports the current accessible source tab.');
      const tab = await chrome.tabs.create({ url: `${viewerUrl}?capture=1&sourceTab=${source.id}`, openerTabId: source.id });
      if (tab.id === undefined) throw new Error('Could not open captured mirror.');
      captures.set(tab.id, { image: message.image, sourceTabId: source.id! });
      return { ok: true };
    }
    case 'mirror:get-capture': {
      if (!isReader(sender) || sender.tab?.id === undefined) throw new Error('Invalid capture reader.');
      const capture = captures.get(sender.tab.id);
      if (!capture) throw new Error('Capture expired. Capture the visible source tab again.');
      captures.delete(sender.tab.id);
      return { ok: true, image: capture.image, sourceTabId: capture.sourceTabId };
    }
    case 'mirror:rescan': {
      if (sender.url !== popupUrl) throw new Error('Use the extension action.');
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id === undefined || !sourceUrl(tab.url ?? '')) continue;
        if (/\.pdf(?:[?#]|$)/i.test(tab.url!)) await discover(tab.id, tab.url!, tab.url!);
        else await chrome.tabs.sendMessage(tab.id, { type: 'mirror:rescan' }).catch(() => {});
      }
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
  const enabled = (await chrome.storage.local.get('mirror:enabled'))['mirror:enabled'] === true;
  await chrome.action.setBadgeText({ text: enabled ? 'ON' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#147d66' });
}
chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'local') void updateBadge().catch(report); });
chrome.runtime.onInstalled.addListener(() => { void updateBadge().catch(report); });
chrome.runtime.onStartup.addListener(() => { void updateBadge().catch(report); });
