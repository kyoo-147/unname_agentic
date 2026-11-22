import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import manifest from '../manifest.json';

type Listener = (...args: any[]) => any;
function event() {
  const listeners: Listener[] = [];
  return { addListener: (listener: Listener) => { listeners.push(listener); }, fire: (...args: any[]) => listeners.forEach(listener => listener(...args)), listeners };
}
async function install() {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  function storage(values: Record<string, unknown>) {
    return {
      get: vi.fn(async (key: string | null) => key === null ? { ...values } : { [key]: values[key] }),
      set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
      remove: vi.fn(async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; }),
    };
  }
  const chrome = {
    runtime: { id: 'test', getURL: (path: string) => `chrome-extension://test/${path}`, onMessage: event(), onInstalled: event(), onStartup: event(), connectNative: vi.fn<() => any>(() => { throw new Error('Host not registered'); }), sendMessage: vi.fn(async () => ({})) },
    storage: { local: storage(local), session: storage(session), onChanged: event() },
    tabs: {
      get: vi.fn(async (id: number) => ({ id, url: 'https://example.com/download', index: 0, active: true, windowId: 1 })),
      create: vi.fn(async () => ({ id: 90 })),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,' + 'A'.repeat(64)),
      query: vi.fn(async (): Promise<Array<{ id: number; url: string; index: number }>> => []), sendMessage: vi.fn(async () => ({})), onUpdated: event(), onRemoved: event(),
    },
    webRequest: { onHeadersReceived: event() },
    scripting: { executeScript: vi.fn(async () => [{ result: ['https://example.com/embedded.pdf'] }]) },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
    commands: { onCommand: event() },
    contextMenus: { create: vi.fn(), removeAll: vi.fn((callback?: () => void) => callback?.()), onClicked: event() },
  };
  vi.stubGlobal('chrome', chrome);
  await import('../background');
  async function message(body: unknown, sender = { id: 'test', tab: { id: 90 }, url: 'chrome-extension://test/index.html?capture=1&sourceTab=3', frameId: 0 }): Promise<any> {
    return new Promise(resolve => { chrome.runtime.onMessage.listeners[0]!(body, sender, resolve); });
  }
  return { chrome, local, session, message };
}
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Chrome extension event and message boundaries', () => {
  it('automatically mirrors a PDF MIME response without a filename suffix only after consent', async () => {
    const h = await install();
    const response = { tabId: 3, url: 'https://example.com/download', type: 'main_frame', responseHeaders: [{ name: 'Content-Type', value: 'application/pdf; charset=binary' }] };
    h.chrome.webRequest.onHeadersReceived.fire(response);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.chrome.tabs.create).not.toHaveBeenCalled();
    h.local['mirror:enabled'] = true;
    h.chrome.webRequest.onHeadersReceived.fire(response);
    await vi.waitFor(() => expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1));
    expect(h.chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ openerTabId: 3, active: false, url: 'chrome-extension://test/index.html?file=https%3A%2F%2Fexample.com%2Fdownload&sourceTab=3' }));
  });
  it('does not trust content discovery until the PDF is verified in the source DOM', async () => {
    const h = await install();
    h.local['mirror:enabled'] = true;
    const sender = { id: 'test', tab: { id: 3 }, url: 'https://example.com/download', frameId: 0 };
    expect((await h.message({ type: 'mirror:discovered', url: 'https://private.example/secret' }, sender)).ok).toBe(false);
    expect(h.chrome.tabs.create).not.toHaveBeenCalled();
    expect((await h.message({ type: 'mirror:discovered', url: 'https://example.com/embedded.pdf' }, sender)).ok).toBe(true);
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
  });
  it('rejects webpage translation requests and returns actual provider responses to extension readers', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Bản dịch từ máy chủ' } }] }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    const h = await install();
    const request = { text: 'Server text', settings: { provider: 'local', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen3:4b', apiKey: '', allowCloud: false, sourceLanguage: 'auto', targetLanguage: 'vi', glossary: {}, promptVersion: 'v1' } };
    const denied = await h.message({ type: 'mirror:translate', request }, { id: 'test', tab: { id: 3 }, url: 'https://example.com/download', frameId: 0 });
    expect(denied.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await h.message({ type: 'mirror:translate', request })).toEqual({ ok: true, text: 'Bản dịch từ máy chủ' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('transfers a large PDF in bounded reader-only chunks', async () => {
    const bytes = new Uint8Array(9 * 1024 * 1024);
    bytes.set(new TextEncoder().encode('%PDF-1.7'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes)));
    const h = await install();
    h.session['mirror:session:3'] = { sourceTabId: 3, viewerTabId: 90, documentUrl: 'https://example.com/download', pdfUrl: 'https://example.com/download' };
    const result = await h.message({ type: 'mirror:fetch-pdf', url: 'https://example.com/download' });
    expect(result).toEqual({ ok: true, transferId: expect.any(String), size: 9 * 1024 * 1024, chunkSize: 256 * 1024, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await h.message({ type: 'mirror:fetch-pdf-chunk', transferId: result.transferId, offset: -1 })).ok).toBe(false);
    const first = await h.message({ type: 'mirror:fetch-pdf-chunk', transferId: result.transferId, offset: 0 });
    expect(first.ok).toBe(true);
    expect(first.data.length).toBe(256 * 1024);
    expect(new TextDecoder().decode(new Uint8Array(first.data.slice(0, 8)))).toBe('%PDF-1.7');
    let offset = first.data.length;
    let last = first;
    while (offset < bytes.length) {
      last = await h.message({ type: 'mirror:fetch-pdf-chunk', transferId: result.transferId, offset });
      expect(last.ok).toBe(true);
      offset += last.data.length;
    }
    expect(last.done).toBe(true);
    expect(last.sha256).toBe(result.sha256);
    expect((await h.message({ type: 'mirror:fetch-pdf-chunk', transferId: result.transferId, offset: 0 })).ok).toBe(false);
  });
  it('reuses a persisted session without opening another mirror after worker restart', async () => {
    const h = await install();
    h.local['mirror:enabled'] = true;
    h.session['mirror:session:3'] = { sourceTabId: 3, viewerTabId: 90, documentUrl: 'https://example.com/download', pdfUrl: 'https://example.com/download' };
    h.chrome.webRequest.onHeadersReceived.fire({ tabId: 3, url: 'https://example.com/download', type: 'main_frame', responseHeaders: [{ name: 'Content-Type', value: 'application/pdf' }] });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('never connects to a desktop host during automatic discovery or ordinary reader acquisition', async () => {
    const h = await install();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('%PDF-1.7\nsynthetic')));
    h.local['mirror:enabled'] = true;
    h.chrome.tabs.onUpdated.fire(3, { url: 'https://example.com/report.pdf' }, { url: 'https://example.com/report.pdf' });
    await vi.waitFor(() => expect(h.chrome.tabs.create).toHaveBeenCalledOnce());
    await h.message({ type: 'mirror:fetch-pdf', url: 'https://example.com/report.pdf' });
    expect(h.chrome.runtime.connectNative).not.toHaveBeenCalled();
  });
  it('rejects desktop operations from web pages, source frames, and the reader itself', async () => {
    const h = await install();
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const type of ['mirror:desktop-open', 'mirror:desktop-status', 'mirror:desktop-stop', 'mirror:annotation']) {
      expect((await h.message({ type })).ok).toBe(false);
      expect((await h.message({ type }, { id: 'test', tab: { id: 3 }, url: 'https://example.com/download', frameId: 0 })).ok).toBe(false);
    }
    expect(h.chrome.runtime.connectNative).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('shows unavailable status without fetching or pretending the companion is installed', async () => {
    const h = await install(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const popup = { id: 'test', tab: { id: 91 }, url: 'chrome-extension://test/popup.html', frameId: 0 };
    const result = await h.message({ type: 'mirror:desktop-status' }, popup);
    expect(result).toMatchObject({ ok: true, available: false, sourceAvailable: false, following: false, status: expect.stringContaining('unavailable') });
    expect(h.chrome.runtime.connectNative).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not acquire an active authorized PDF when the companion is unavailable', async () => {
    const h = await install(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    h.session['mirror:session:3'] = { sourceTabId: 3, viewerTabId: 90, documentUrl: 'https://example.com/download', pdfUrl: 'https://example.com/download' };
    h.chrome.tabs.query.mockResolvedValue([{ id: 3, url: 'https://example.com/download', index: 0 }]);
    h.chrome.tabs.get.mockImplementation(async id => ({ id, index: 0, active: true, windowId: 1, url: id === 90 ? 'chrome-extension://test/index.html?sourceTab=3' : 'https://example.com/download' }));
    const result = await h.message({ type: 'mirror:desktop-open', url: 'https://unrelated.test/private' }, { id: 'test', tab: { id: 91 }, url: 'chrome-extension://test/popup.html', frameId: 0 });
    expect(result.ok).toBe(false); expect(result.error).toContain('unavailable');
    expect(h.chrome.runtime.connectNative).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('reauthorizes native commands and dispatches only to the bound viewer with no source broadcast', async () => {
    const h = await install();
    vi.useFakeTimers();
    try {
      const requests: any[] = []; const nativeMessages = event(); const nativeDisconnect = event();
      let disconnected = false;
      h.chrome.runtime.connectNative.mockImplementation(() => ({
        onMessage: nativeMessages, onDisconnect: nativeDisconnect,
        disconnect: () => { if (!disconnected) { disconnected = true; nativeDisconnect.fire(); } },
        postMessage: (request: any) => {
          requests.push(request);
          const reply = request.type === 'hello' ? { ok: true, protocol: 1, status: 'ready' }
            : request.type === 'begin' ? { ok: true, binding: request.binding, status: 'receiving', next_index: 0 }
            : request.type === 'chunk' ? { ok: true, binding: request.binding, status: 'receiving', next_index: request.index + 1 }
            : request.type === 'poll' ? { ok: true, binding: request.binding, status: 'following', command: { version: 1, kind: 'view_state', binding: request.binding, sequence: 1, page: { page: 2, page_count: 4, fraction: .25, zoom: 1.5 } } }
            : request.type === 'annotation' ? { ok: true, binding: request.binding, status: 'applied', revision: 1, annotation: { ...request.annotation, base_revision: 1 } }
            : { ok: true, binding: request.binding, status: request.type === 'commit' ? 'complete' : 'receiving' };
          queueMicrotask(() => { if (!disconnected) nativeMessages.fire(reply); });
        },
      }));
      vi.stubGlobal('fetch', vi.fn(async () => new Response('%PDF-1.7\nsynthetic')));
      h.session['mirror:session:3'] = { sourceTabId: 3, viewerTabId: 90, documentUrl: 'https://example.com/download', pdfUrl: 'https://example.com/download' };
      h.chrome.tabs.query.mockResolvedValue([{ id: 3, url: 'https://example.com/download', index: 0 }]);
      h.chrome.tabs.get.mockImplementation(async id => ({ id, index: 0, active: true, windowId: 1, url: id === 90 ? 'chrome-extension://test/index.html?sourceTab=3' : 'https://example.com/download' }));
      const popup = { id: 'test', tab: { id: 91 }, url: 'chrome-extension://test/popup.html', frameId: 0 };
      expect((await h.message({ type: 'mirror:desktop-open' }, popup)).ok).toBe(true);
      expect((await h.message({ type: 'mirror:desktop-open' }, popup)).ok).toBe(true);
      await expect(h.message({ type: 'mirror:annotation', annotation: { id: 'a1', page: 2, x: .1, y: .2, width: .3, height: .1, kind: 'highlight', text: 'hello', baseRevision: 0 } })).resolves.toMatchObject({ ok: true, status: 'applied', revision: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      const viewMessages = (h.chrome.runtime.sendMessage as any).mock.calls.map((call: any[]) => call[0]).filter((message: any) => message?.type === 'mirror:view-state');
      expect(viewMessages).toHaveLength(1);
      expect(viewMessages[0]).toEqual({ type: 'mirror:view-state', state: { page: 3, fraction: .25, zoom: 1.5 }, targetTabId: 90, sourceTabId: 3, origin: 'desktop' });
      expect(h.chrome.tabs.sendMessage).not.toHaveBeenCalled();
      await h.message({ type: 'mirror:view-state', state: { page: 3, fraction: .2501, zoom: 1.5 } });
      expect(requests.filter(request => request.type === 'page')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect((h.chrome.runtime.sendMessage as any).mock.calls.filter((call: any[]) => call[0]?.type === 'mirror:view-state')).toHaveLength(1);
      await h.message({ type: 'mirror:desktop-stop' }, popup);
      const count = requests.length; await vi.advanceTimersByTimeAsync(5000);
      expect(requests).toHaveLength(count); expect(h.chrome.runtime.connectNative).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('does not allow webpage callers to trigger screenshots', async () => {
    const h = await install();
    const result = await h.message({ type: 'mirror:open-capture', image: 'data:image/png;base64,abc', sourceTabId: 3 });
    expect(result.ok).toBe(false);
    expect(h.chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe('context menu, commands, badge and capture contract', () => {
  it('declares both commands and only the minimal contextMenus addition', () => {
    expect(manifest.commands['toggle-mirror']?.suggested_key.default).toBe('Ctrl+Shift+M');
    expect(manifest.commands['capture-page']?.suggested_key.default).toBe('Ctrl+Shift+Y');
    expect(manifest.permissions).toContain('contextMenus');
    expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*', 'file:///*']);
    expect(manifest.description).toMatch(/chụp/i);
  });
  it('pins the exact permission list and requires a written justification for each entry', () => {
    expect(manifest.permissions).toEqual(['storage', 'tabs', 'webRequest', 'scripting', 'activeTab', 'nativeMessaging', 'contextMenus']);
    expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*', 'file:///*']);
    const source = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
    const justification = /^\/\*[\s\S]*?\*\//.exec(source)?.[0] ?? '';
    expect(justification).toContain('Manifest permission justification');
    for (const permission of manifest.permissions) expect(justification, permission).toMatch(new RegExp(`^\\s*\\*\\s+${permission}\\s`, 'm'));
    const hosts = justification.split('\n').find(line => /^\s*\*\s+host_permissions\s/.test(line)) ?? '';
    for (const scheme of ['http', 'https', 'file']) expect(hosts, scheme).toMatch(new RegExp(`\\b${scheme}\\b`));
  });
  it('registers the Vietnamese PDF context menu on install', async () => {
    const h = await install();
    h.chrome.runtime.onInstalled.fire({ reason: 'install' });
    expect(h.chrome.contextMenus.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'mirror-open', title: 'Mở bản dịch Mirror', contexts: ['page', 'link'] }));
  });
  it('opens a mirror from the context menu for an authorized PDF page', async () => {
    const h = await install();
    h.chrome.contextMenus.onClicked.fire({ menuItemId: 'mirror-open', tabId: 3, pageUrl: 'https://example.com/a.pdf' }, { id: 3, url: 'https://example.com/a.pdf', index: 0, active: true });
    await vi.waitFor(() => expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1));
    expect(h.chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'chrome-extension://test/index.html?file=https%3A%2F%2Fexample.com%2Fa.pdf&sourceTab=3', openerTabId: 3 }));
    expect(h.session['mirror:session:3']).toMatchObject({ sourceTabId: 3, pdfUrl: 'https://example.com/a.pdf' });
  });
  it('notifies instead of mirroring a page that is not a PDF source', async () => {
    const h = await install();
    h.chrome.contextMenus.onClicked.fire({ menuItemId: 'mirror-open', tabId: 3, pageUrl: 'https://example.com/article' }, { id: 3, url: 'https://example.com/article', index: 0, active: true });
    await vi.waitFor(() => expect(h.chrome.tabs.sendMessage).toHaveBeenCalledWith(3, expect.objectContaining({ type: 'mirror:notice', message: expect.stringContaining('PDF') })));
    expect(h.chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('opens a mirror for a PDF link target even though the page itself is not a PDF', async () => {
    const h = await install();
    h.chrome.contextMenus.onClicked.fire({ menuItemId: 'mirror-open', tabId: 3, pageUrl: 'https://example.com/article', linkUrl: 'https://example.com/paper.pdf' }, { id: 3, url: 'https://example.com/article', index: 0, active: true });
    await vi.waitFor(() => expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1));
    expect(h.chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'chrome-extension://test/index.html?file=https%3A%2F%2Fexample.com%2Fpaper.pdf&sourceTab=3', openerTabId: 3 }));
    expect(h.session['mirror:session:3']).toMatchObject({ documentUrl: 'https://example.com/article', pdfUrl: 'https://example.com/paper.pdf' });
    expect(h.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it('opens a mirror for a tab whose response type alone is PDF, then stops trusting it after navigation', async () => {
    const h = await install();
    h.chrome.webRequest.onHeadersReceived.fire({ tabId: 3, url: 'https://example.com/download', type: 'main_frame', responseHeaders: [{ name: 'content-type', value: 'application/pdf' }] });
    h.chrome.contextMenus.onClicked.fire({ menuItemId: 'mirror-open', tabId: 3, pageUrl: 'https://example.com/download' }, { id: 3, url: 'https://example.com/download', index: 0, active: true });
    await vi.waitFor(() => expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1));
    expect(h.chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: 'chrome-extension://test/index.html?file=https%3A%2F%2Fexample.com%2Fdownload&sourceTab=3' }));
    delete h.session['mirror:session:3'];
    h.chrome.tabs.onUpdated.fire(3, { url: 'https://example.com/download' }, { id: 3, url: 'https://example.com/download', index: 0 });
    h.chrome.contextMenus.onClicked.fire({ menuItemId: 'mirror-open', tabId: 3, pageUrl: 'https://example.com/download' }, { id: 3, url: 'https://example.com/download', index: 0, active: true });
    await vi.waitFor(() => expect(h.chrome.tabs.sendMessage).toHaveBeenCalledWith(3, expect.objectContaining({ type: 'mirror:notice' })));
    expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1);
  });
  it('notifies instead of mirroring the same URL when neither the path nor the response is PDF', async () => {
    const h = await install();
    h.chrome.contextMenus.onClicked.fire({ menuItemId: 'mirror-open', tabId: 3, pageUrl: 'https://example.com/download' }, { id: 3, url: 'https://example.com/download', index: 0, active: true });
    await vi.waitFor(() => expect(h.chrome.tabs.sendMessage).toHaveBeenCalledWith(3, expect.objectContaining({ type: 'mirror:notice', message: expect.stringContaining('PDF') })));
    expect(h.chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('focuses the existing mirror instead of opening a duplicate on context click', async () => {
    const h = await install();
    h.session['mirror:session:3'] = { sourceTabId: 3, viewerTabId: 90, documentUrl: 'https://example.com/a.pdf', pdfUrl: 'https://example.com/a.pdf' };
    h.chrome.contextMenus.onClicked.fire({ menuItemId: 'mirror-open', tabId: 3, pageUrl: 'https://example.com/a.pdf' }, { id: 3, url: 'https://example.com/a.pdf', index: 0, active: true });
    await vi.waitFor(() => expect(h.chrome.tabs.update).toHaveBeenCalledWith(90, { active: true }));
    expect(h.chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('toggles automatic mirrors from the keyboard command and persists consent', async () => {
    const h = await install();
    const tab = { id: 3, url: 'https://example.com/download', active: true, windowId: 1 };
    h.chrome.commands.onCommand.fire('toggle-mirror', tab);
    await vi.waitFor(() => expect(h.local['mirror:enabled']).toBe(true));
    expect(h.local['mirror:consentVersion']).toBe(1);
    h.chrome.commands.onCommand.fire('toggle-mirror', tab);
    await vi.waitFor(() => expect(h.local['mirror:enabled']).toBe(false));
  });
  it('shows the open mirror count on the badge and clears it when mirrors close', async () => {
    const h = await install();
    h.session['mirror:session:3'] = { sourceTabId: 3, viewerTabId: 90, documentUrl: 'https://example.com/a.pdf', pdfUrl: 'https://example.com/a.pdf' };
    h.session['mirror:session:4'] = { sourceTabId: 4, viewerTabId: 91, documentUrl: 'https://example.com/b.pdf', pdfUrl: 'https://example.com/b.pdf' };
    h.chrome.storage.onChanged.fire({}, 'session');
    await vi.waitFor(() => expect(h.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '2' }));
    delete h.session['mirror:session:4'];
    h.chrome.storage.onChanged.fire({}, 'session');
    await vi.waitFor(() => expect(h.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '1' }));
    delete h.session['mirror:session:3'];
    h.chrome.storage.onChanged.fire({}, 'session');
    await vi.waitFor(() => expect(h.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' }));
  });
  it('closes the mirror viewer when its source tab closes and clears the badge', async () => {
    const h = await install();
    h.session['mirror:session:3'] = { sourceTabId: 3, viewerTabId: 90, documentUrl: 'https://example.com/a.pdf', pdfUrl: 'https://example.com/a.pdf' };
    h.chrome.tabs.onRemoved.fire(3, {});
    await vi.waitFor(() => expect(h.chrome.tabs.remove).toHaveBeenCalledWith(90));
    await vi.waitFor(() => expect(h.session['mirror:session:3']).toBeUndefined());
    await vi.waitFor(() => expect(h.chrome.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' }));
  });
  it('captures the visible page from the keyboard command and hands it to only that viewer once', async () => {
    const h = await install();
    h.chrome.commands.onCommand.fire('capture-page', { id: 3, url: 'https://example.com/article', active: true, windowId: 1 });
    await vi.waitFor(() => expect(h.chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringMatching(/^chrome-extension:\/\/test\/index\.html\?capture=1&sourceTab=3&captureId=/), openerTabId: 3 })));
    expect(h.chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'mirror:capture-ready', targetTabId: 90, sourceTabId: 3 }));
    const createdUrl = (h.chrome.tabs.create as any).mock.calls[0][0].url as string;
    h.chrome.tabs.onUpdated.fire(90, { url: createdUrl }, { id: 90, url: createdUrl, index: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));
    const captureId = new URL(createdUrl).searchParams.get('captureId')!;
    const capture = await h.message({ type: 'mirror:get-capture', captureId }, { id: 'test', tab: { id: 90 }, url: createdUrl, frameId: 0 });
    expect(capture).toMatchObject({ ok: true, sourceTabId: 3, captureId: expect.any(String) });
    expect(capture.image).toMatch(/^data:image\/png;base64,/);
    expect((await h.message({ type: 'mirror:get-capture' })).ok).toBe(false);
  });
  it('keeps the capture handoff race-safe when the new reader asks before storage persistence', async () => {
    const h = await install();
    let releaseCreate!: (tab: { id: number }) => void;
    h.chrome.tabs.create.mockImplementation(() => new Promise(resolve => { releaseCreate = resolve; }));
    h.chrome.commands.onCommand.fire('capture-page', { id: 3, url: 'https://example.com/article', index: 0, active: true, windowId: 1 });
    await vi.waitFor(() => expect(releaseCreate).toBeTypeOf('function'));
    const createdUrl = (h.chrome.tabs.create as any).mock.calls[0][0].url as string;
    const captureId = new URL(createdUrl).searchParams.get('captureId')!;
    let settled = false;
    const captureRequest = h.message({ type: 'mirror:get-capture', captureId }, { id: 'test', tab: { id: 90 }, url: createdUrl, frameId: 0 }).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    releaseCreate({ id: 90 });
    await expect(captureRequest).resolves.toMatchObject({ ok: true, captureId });
  });
  it('rejects capture requests that target the extension reader itself', async () => {
    const h = await install();
    h.chrome.tabs.get.mockResolvedValue({ id: 3, url: 'chrome-extension://test/index.html', index: 0, active: true, windowId: 1 });
    const popup = { id: 'test', tab: { id: 91 }, url: 'chrome-extension://test/popup.html', frameId: 0 };
    const result = await h.message({ type: 'mirror:open-capture', sourceTabId: 3, image: 'data:image/png;base64,' + 'A'.repeat(64) }, popup);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('accessible source tab') });
    expect(h.chrome.tabs.create).not.toHaveBeenCalled();
  });
  it('expires an unredeemed capture and rejects mismatched or untrusted readers', async () => {
    const h = await install();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      h.chrome.commands.onCommand.fire('capture-page', { id: 3, url: 'https://example.com/article', index: 0, active: true, windowId: 1 });
      await vi.waitFor(() => expect(h.chrome.tabs.create).toHaveBeenCalledTimes(1));
      expect((await h.message({ type: 'mirror:get-capture' }, { id: 'test', tab: { id: 3 }, url: 'https://example.com/article', frameId: 0 })).ok).toBe(false);
      expect((await h.message({ type: 'mirror:get-capture', captureId: 'other' })).ok).toBe(false);
      now.mockReturnValue(1_000_000 + 120_001);
      expect((await h.message({ type: 'mirror:get-capture' })).ok).toBe(false);
    } finally { now.mockRestore(); }
  });
  it('rejects non-PNG and oversized capture payloads from the popup path', async () => {
    const h = await install();
    const popup = { id: 'test', tab: { id: 91 }, url: 'chrome-extension://test/popup.html', frameId: 0 };
    expect((await h.message({ type: 'mirror:open-capture', sourceTabId: 3, image: 'data:image/jpeg;base64,AAAA' }, popup)).ok).toBe(false);
    expect((await h.message({ type: 'mirror:open-capture', sourceTabId: 3, image: 'data:image/png;base64,' + 'A'.repeat(20_000_000) }, popup)).ok).toBe(false);
    expect(h.chrome.tabs.create).not.toHaveBeenCalled();
  });
});
