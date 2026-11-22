import { describe, expect, it, vi } from 'vitest';
import { boundViewState, fetchPdf, ViewRelayGuard } from '../viewer/src/ui/bridge';

describe('bound viewer navigation', () => {
  const state = { page: 3, fraction: 0.25, zoom: 1.3 };
  it('applies navigation only to its exact extension viewer tab', () => {
    expect(boundViewState({ type: 'mirror:view-state', targetTabId: 90, state }, 90)).toEqual(state);
    expect(boundViewState({ type: 'mirror:view-state', targetTabId: 91, state }, 90)).toBeUndefined();
    expect(boundViewState({ type: 'mirror:view-state', state }, 90)).toBeUndefined();
  });
  it('does not echo programmatic linked scroll even after geometry clamps', () => {
    const guard = new ViewRelayGuard(); expect(guard.canRelay()).toBe(true);
    guard.applyExternal(); expect(guard.canRelay()).toBe(false);
    expect(guard.canRelay()).toBe(false);
    guard.userInput(); expect(guard.canRelay()).toBe(true);
  });
  it('rejects invalid geometry and unexpected message types', () => {
    for (const invalid of [{ ...state, page: 0 }, { ...state, page: 1.5 }, { ...state, fraction: Infinity }, { ...state, fraction: -0.1 }, { ...state, zoom: NaN }]) {
      expect(boundViewState({ type: 'mirror:view-state', targetTabId: 90, state: invalid }, 90)).toBeUndefined();
    }
    expect(boundViewState({ type: 'unrelated', targetTabId: 90, state }, 90)).toBeUndefined();
  });
  it('rejects a small extension PDF when its checksum is wrong', async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'test', sendMessage: vi.fn(async () => ({ ok: true, data: [37, 80, 68, 70], size: 4, sha256: '0'.repeat(64) })) } });
    await expect(fetchPdf('https://example.com/file.pdf')).rejects.toThrow(/checksum mismatch/);
    vi.unstubAllGlobals();
  });
  it('requires ordered complete chunks and verifies the streamed checksum', async () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    const sendMessage = vi.fn(async (request: any) => request.type === 'mirror:fetch-pdf'
      ? { ok: true, transferId: 'transfer-1', size: bytes.length, chunkSize: 4, sha256 }
      : { ok: true, data: Array.from(bytes.slice(request.offset, request.offset + 4)), done: request.offset + 4 === bytes.length, sha256 });
    vi.stubGlobal('chrome', { runtime: { id: 'test', sendMessage } });
    await expect(fetchPdf('https://example.com/file.pdf')).resolves.toEqual(bytes);
    expect(sendMessage.mock.calls.map(call => call[0].offset).filter((offset: unknown) => offset !== undefined)).toEqual([0, 4]);
    vi.unstubAllGlobals();
  });
});
