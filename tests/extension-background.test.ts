import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      get: vi.fn(async (id: number) => ({ id, url: 'https://example.com/download', index: 0 })),
      create: vi.fn(async () => ({ id: 90 })),
      query: vi.fn(async (): Promise<Array<{ id: number; url: string; index: number }>> => []), sendMessage: vi.fn(async () => ({})), onUpdated: event(), onRemoved: event(),
    },
    webRequest: { onHeadersReceived: event() },
    scripting: { executeScript: vi.fn(async () => [{ result: ['https://example.com/embedded.pdf'] }]) },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
  };
  vi.stubGlobal('chrome', chrome);
  await import('../extension/background');
  async function message(body: unknown, sender = { id: 'test', tab: { id: 90 }, url: 'chrome-extension://test/index.html?sourceTab=3', frameId: 0 }): Promise<any> {
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
    expect(result).toEqual({ ok: true, transferId: expect.any(String), size: 9 * 1024 * 1024, chunkSize: 256 * 1024 });
    expect((await h.message({ type: 'mirror:fetch-pdf-chunk', transferId: result.transferId, offset: -1 })).ok).toBe(false);
    const first = await h.message({ type: 'mirror:fetch-pdf-chunk', transferId: result.transferId, offset: 0 });
    expect(first.ok).toBe(true);
    expect(first.data.length).toBe(256 * 1024);
    expect(new TextDecoder().decode(new Uint8Array(first.data.slice(0, 8)))).toBe('%PDF-1.7');
    const last = await h.message({ type: 'mirror:fetch-pdf-chunk', transferId: result.transferId, offset: bytes.length - 4 });
    expect(last).toEqual({ ok: true, data: [0, 0, 0, 0], done: true });
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
    for (const type of ['mirror:desktop-open', 'mirror:desktop-status', 'mirror:desktop-stop']) {
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
    h.chrome.tabs.get.mockImplementation(async id => ({ id, index: 0, url: id === 90 ? 'chrome-extension://test/index.html?sourceTab=3' : 'https://example.com/download' }));
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
            : request.type === 'chunk' ? { ok: true, binding: request.binding, next_index: request.index + 1 }
            : request.type === 'poll' ? { ok: true, binding: request.binding, status: 'following', command: { version: 1, kind: 'view_state', binding: request.binding, sequence: 1, page: { page: 2, page_count: 4, fraction: .25, zoom: 1.5 } } }
            : { ok: true, binding: request.binding, status: request.type === 'commit' ? 'complete' : 'receiving' };
          queueMicrotask(() => { if (!disconnected) nativeMessages.fire(reply); });
        },
      }));
      vi.stubGlobal('fetch', vi.fn(async () => new Response('%PDF-1.7\nsynthetic')));
      h.session['mirror:session:3'] = { sourceTabId: 3, viewerTabId: 90, documentUrl: 'https://example.com/download', pdfUrl: 'https://example.com/download' };
      h.chrome.tabs.query.mockResolvedValue([{ id: 3, url: 'https://example.com/download', index: 0 }]);
      h.chrome.tabs.get.mockImplementation(async id => ({ id, index: 0, url: id === 90 ? 'chrome-extension://test/index.html?sourceTab=3' : 'https://example.com/download' }));
      const popup = { id: 'test', tab: { id: 91 }, url: 'chrome-extension://test/popup.html', frameId: 0 };
      expect((await h.message({ type: 'mirror:desktop-open' }, popup)).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ type: 'mirror:view-state', state: { page: 3, fraction: .25, zoom: 1.5 }, targetTabId: 90, sourceTabId: 3, origin: 'desktop' });
      expect(h.chrome.tabs.sendMessage).not.toHaveBeenCalled();
      await h.message({ type: 'mirror:view-state', state: { page: 3, fraction: .2501, zoom: 1.5 } });
      expect(requests.filter(request => request.type === 'page')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
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
