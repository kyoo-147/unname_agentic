import { describe, expect, it, vi } from 'vitest';
import { NativeCompanion, NATIVE_CHUNK_BYTES, normalizeNativePage, nativeCommand, type NativePage, type NativePort } from '../extension/native-bridge';
import type { MirrorSession } from '../extension/controller';

const session: MirrorSession = { sourceTabId: 3, viewerTabId: 90, documentUrl: 'https://example.test/report', pdfUrl: 'https://example.test/report.pdf' };
const page = normalizeNativePage({ page: 2, fraction: 0.25, zoom: 1.5 });
function harness(onCommand?: (session: MirrorSession, page: NativePage) => Promise<void>) {
  const messages: Record<string, any>[] = [];
  const listeners: ((message: unknown) => void)[] = [];
  const disconnects: (() => void)[] = [];
  let disconnected = false;
  const port: NativePort = {
    onMessage: { addListener: listener => { listeners.push(listener); } },
    onDisconnect: { addListener: listener => { disconnects.push(listener); } },
    disconnect: vi.fn(() => { if (!disconnected) { disconnected = true; disconnects.forEach(listener => listener()); } }),
    postMessage: vi.fn(message => {
      const request = message as Record<string, any>; messages.push(request);
      const reply = request.type === 'hello' ? { ok: true, protocol: 1, status: 'ready' }
        : request.type === 'chunk' ? { ok: true, binding: request.binding, next_index: request.index + 1 }
        : { ok: true, binding: request.binding, status: request.type === 'commit' ? 'complete' : 'receiving' };
      queueMicrotask(() => { if (!disconnected) listeners.forEach(listener => listener(reply)); });
    }),
  };
  const connect = vi.fn(() => port);
  return { companion: new NativeCompanion(connect, onCommand), messages, port, connect, reply: (message: unknown) => listeners.forEach(listener => listener(message)) };
}
function pdf(size = 400_000): Uint8Array { const bytes = new Uint8Array(size); bytes.set(new TextEncoder().encode('%PDF-1.7\nsynthetic')); return bytes; }

describe('opt-in native PDF companion', () => {
  it('normalizes browser one-based pages into bounded zero-based native events', () => {
    expect(page).toEqual({ page: 1, page_count: null, fraction: 0.25, zoom: 1.5 });
    expect(normalizeNativePage({ page: -3, fraction: -1, zoom: 50 })).toEqual({ page: 0, page_count: null, fraction: 0, zoom: 10 });
    expect(normalizeNativePage()).toEqual({ page: 0, page_count: null, fraction: 0, zoom: 1 });
  });
  it('rejects malformed geometry, unsafe sequences and changed command nonces', () => {
    const binding = { session_id: 's', source_id: 'a'.repeat(64), request_nonce: 'n', generation: 1 };
    const command = { version: 1, kind: 'view_state', binding, sequence: 1, page };
    expect(nativeCommand(command, binding)).toEqual({ sequence: 1, page });
    for (const changed of [
      { ...command, binding: { ...binding, request_nonce: 'old' } },
      { ...command, binding: { ...binding, generation: 2 } },
      { ...command, sequence: 0 }, { ...command, sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...command, page: { ...page, fraction: NaN } }, { ...command, page: { ...page, fraction: 1.01 } },
      { ...command, page: { ...page, page: -1 } }, { ...command, page: { ...page, page_count: 1 } },
    ]) expect(() => nativeCommand(changed, binding)).toThrow(/Invalid/);
  });
  it('probes only availability without reading or transferring document bytes', async () => {
    const h = harness();
    expect(await h.companion.probe()).toBe(true);
    expect(h.messages).toEqual([{ type: 'hello' }]);
    expect(h.port.disconnect).toHaveBeenCalledOnce(); expect(h.companion.following).toBe(false);
  });
  it('shares the initial hello when status probing overlaps an explicit desktop transfer', async () => {
    const h = harness();
    const status = h.companion.probe();
    const transfer = h.companion.open(session, async () => pdf(100), async () => {}, page, 'Synthetic');
    await expect(status).resolves.toBe(true);
    await expect(transfer).resolves.toBeUndefined();
    expect(h.messages.filter(message => message.type === 'hello')).toHaveLength(1);
    expect(h.port.disconnect).not.toHaveBeenCalled();
    expect(h.companion.following).toBe(true);
    await h.companion.stop();
  });
  it('reports an unavailable companion without starting PDF acquisition', async () => {
    const companion = new NativeCompanion(() => { throw new Error('not installed'); });
    const acquire = vi.fn(async () => pdf());
    await expect(companion.open(session, acquire, async () => {}, page, 'Synthetic')).rejects.toThrow(/unavailable/);
    expect(acquire).not.toHaveBeenCalled(); expect(companion.following).toBe(false);
  });
  it('uses ordered bounded chunks bound to source, nonce, session and whole-PDF digest', async () => {
    const h = harness(); const bytes = pdf(); const authorize = vi.fn(async () => {});
    await h.companion.open(session, async () => bytes, authorize, page, 'Synthetic PDF');
    expect(h.companion.following).toBe(true); expect(h.port.disconnect).not.toHaveBeenCalled();
    expect(h.messages.map(m => m.type)).toEqual(['hello', 'begin', 'chunk', 'chunk', 'chunk', 'commit']);
    const begin = h.messages[1]!;
    expect(begin.binding).toMatchObject({ session_id: expect.any(String), source_id: expect.stringMatching(/^[a-f0-9]{64}$/), request_nonce: expect.any(String), generation: expect.any(Number) });
    expect(begin.binding.session_id).not.toBe(begin.binding.request_nonce);
    expect(begin.sha256).toBe(Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)).toString('hex'));
    const chunks = h.messages.filter(m => m.type === 'chunk');
    expect(chunks.map(m => m.index)).toEqual([0, 1, 2]);
    expect(chunks.every(m => Buffer.from(m.data, 'base64').length <= NATIVE_CHUNK_BYTES)).toBe(true);
    expect(Buffer.concat(chunks.map(m => Buffer.from(m.data, 'base64')))).toEqual(Buffer.from(bytes));
    expect(h.messages.slice(1).every(m => JSON.stringify(m.binding) === JSON.stringify(begin.binding))).toBe(true);
    expect(JSON.stringify(h.messages)).not.toContain('https://'); expect(authorize).toHaveBeenCalledTimes(6);
    await h.companion.stop(); expect(h.messages.at(-1)?.type).toBe('end'); expect(h.companion.following).toBe(false);
  });
  it('rejects a changed authorization before upload begin and rejects overlapping opens', async () => {
    const h = harness(); let release!: (value: Uint8Array) => void;
    const pending = h.companion.open(session, () => new Promise(resolve => { release = resolve; }), async () => { throw new Error('source changed'); }, page, 'Synthetic');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(h.companion.open(session, async () => pdf(), async () => {}, page, 'Other')).rejects.toThrow(/in progress/);
    release(pdf()); await expect(pending).rejects.toThrow('source changed');
    expect(h.messages).toEqual([{ type: 'hello' }]); expect(h.companion.following).toBe(false);
  });
  it('follows only the uploaded authorized source and stops without reconnecting after navigation', async () => {
    const h = harness(); await h.companion.open(session, async () => pdf(100), async () => {}, page, 'Synthetic');
    await h.companion.page({ ...session, pdfUrl: 'https://unrelated.test/private.pdf' }, page);
    expect(h.messages.filter(m => m.type === 'page')).toHaveLength(0);
    await h.companion.page(session, page); expect(h.messages.at(-1)).toMatchObject({ type: 'page', page });
    h.companion.revoke(3);
    await h.companion.page(session, page);
    expect(h.companion.following).toBe(false); expect(h.connect).toHaveBeenCalledOnce();
  });
  it('polls only the committed binding, reauthorizes commands and suppresses browser scroll echoes', async () => {
    vi.useFakeTimers();
    try {
      const delivered = vi.fn(async () => {}); const authorize = vi.fn(async () => {});
      const h = harness(delivered);
      await h.companion.open(session, async () => pdf(100), authorize, page, 'Synthetic');
      const binding = h.messages.find(m => m.type === 'begin')!.binding;
      const original = h.port.postMessage;
      h.port.postMessage = message => {
        if ((message as any).type !== 'poll') { original(message); return; }
        h.messages.push(message as any);
        queueMicrotask(() => h.reply({ ok: true, status: 'following', binding, command: { version: 1, kind: 'view_state', binding, sequence: 1, page } }));
      };
      const before = authorize.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.messages.at(-1)).toMatchObject({ type: 'poll', binding, after_sequence: 0 });
      expect(authorize.mock.calls.length).toBeGreaterThan(before);
      expect(delivered).toHaveBeenCalledExactlyOnceWith(session, page);
      await h.companion.page(session, { ...page, fraction: page.fraction + 0.0001 });
      expect(h.messages.filter(m => m.type === 'page')).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(delivered).toHaveBeenCalledTimes(1);
      await h.companion.stop();
      const count = h.messages.length; await vi.advanceTimersByTimeAsync(5000);
      expect(h.messages).toHaveLength(count); expect(h.connect).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('serializes poll with page/status/open and closes a stalled poll within one second', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(); await h.companion.open(session, async () => pdf(100), async () => {}, page, 'Synthetic');
      const original = h.port.postMessage;
      h.port.postMessage = message => { if ((message as any).type === 'poll') h.messages.push(message as any); else original(message); };
      await vi.advanceTimersByTimeAsync(1000);
      const pageTask = h.companion.page(session, { ...page, fraction: 0.8 });
      expect(await h.companion.probe()).toBe(true);
      expect(h.messages.at(-1)?.type).toBe('poll');
      await vi.advanceTimersByTimeAsync(1000); await pageTask;
      expect(h.companion.following).toBe(false); expect(h.connect).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5000); expect(h.connect).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('waits for an in-flight poll before starting another explicit upload', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(); await h.companion.open(session, async () => pdf(100), async () => {}, page, 'First');
      const binding = h.messages.find(m => m.type === 'begin')!.binding;
      const original = h.port.postMessage;
      h.port.postMessage = message => { if ((message as any).type === 'poll') h.messages.push(message as any); else original(message); };
      await vi.advanceTimersByTimeAsync(1000);
      const task = h.companion.open(session, async () => pdf(100), async () => {}, page, 'Second');
      await Promise.resolve(); expect(h.messages.at(-1)?.type).toBe('poll');
      h.reply({ ok: true, status: 'following', binding, command: null });
      await task;
      expect(h.messages.filter(m => m.type === 'begin')).toHaveLength(2);
      expect(h.messages.filter(m => m.type === 'begin')[1]!.binding.generation).toBeGreaterThan(binding.generation);
      expect(h.connect).toHaveBeenCalledOnce(); expect(h.companion.following).toBe(true);
      await h.companion.stop();
    } finally { vi.useRealTimers(); }
  });
  it('revokes an upload before begin and never reconnects or starts its poller', async () => {
    const h = harness(); let release!: (value: Uint8Array) => void;
    const task = h.companion.open(session, () => new Promise(resolve => { release = resolve; }), async () => {}, page, 'Synthetic');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    h.companion.revoke(session.sourceTabId); release(pdf(100));
    await expect(task).rejects.toThrow();
    expect(h.messages.map(m => m.type)).toEqual(['hello']); expect(h.companion.following).toBe(false);
    expect(h.connect).toHaveBeenCalledOnce();
  });
  it('does not deliver a command after source revocation during reauthorization', async () => {
    vi.useFakeTimers();
    try {
      const delivered = vi.fn(async () => {}); const h = harness(delivered);
      let revoked = false; const authorize = async () => { if (revoked) h.companion.revoke(session.viewerTabId); };
      await h.companion.open(session, async () => pdf(100), authorize, page, 'Synthetic');
      const binding = h.messages.find(m => m.type === 'begin')!.binding;
      h.port.postMessage = message => { h.messages.push(message as any); queueMicrotask(() => h.reply({ ok: true, status: 'following', binding, command: { version: 1, kind: 'view_state', binding, sequence: 1, page } })); };
      revoked = true; await vi.advanceTimersByTimeAsync(1000);
      expect(delivered).not.toHaveBeenCalled(); expect(h.companion.following).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('closes on acknowledgement mismatch without committing an incomplete transfer', async () => {
    const h = harness();
    const original = h.port.postMessage;
    h.port.postMessage = message => {
      if ((message as any).type === 'chunk') {
        h.port.disconnect();
      } else original(message);
    };
    await expect(h.companion.open(session, async () => pdf(100), async () => {}, page, 'Synthetic')).rejects.toThrow(/unavailable/);
    expect(h.messages.some(m => m.type === 'commit')).toBe(false); expect(h.companion.following).toBe(false);
  });
});
