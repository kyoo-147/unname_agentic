import { describe, expect, it, vi } from 'vitest';
import { MirrorController, pdfPath, type MirrorSession } from '../extension/controller';

function harness(enabled = true, extra: { isOpen?: (id: number) => Promise<boolean>; close?: (id: number) => Promise<void> } = {}) {
  const sessions = new Map<number, MirrorSession>();
  const open = vi.fn(async (_url: string, _tab: number) => 90);
  const fetcher = vi.fn(async () => new Response('%PDF-1.7\nhello', { headers: { 'Content-Type': 'application/pdf' } }));
  const controller = new MirrorController({
    enabled: async () => enabled,
    load: async id => sessions.get(id),
    save: async (id, value) => { if (value) sessions.set(id, value); else sessions.delete(id); },
    open,
    viewerUrl: 'chrome-extension://test/index.html',
    fetcher,
    ...extra,
  });
  return { controller, sessions, open, fetcher };
}

describe('automatic PDF mirror', () => {
  it('keeps the source and opens exactly one viewer across simultaneous detection events', async () => {
    const h = harness();
    await Promise.all([h.controller.detect(3, 'https://example.com/report', 'https://example.com/report'), h.controller.detect(3, 'https://example.com/report', 'https://example.com/report')]);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.open).toHaveBeenCalledWith('chrome-extension://test/index.html?file=https%3A%2F%2Fexample.com%2Freport&sourceTab=3', 3);
    expect(h.sessions.get(3)?.viewerTabId).toBe(90);
  });
  it('does not open anything before explicit consent', async () => {
    const h = harness(false);
    await h.controller.detect(3, 'https://example.com/a.pdf', 'https://example.com/a.pdf');
    expect(h.open).not.toHaveBeenCalled();
  });
  it('rejects fetch requests from webpages, unrelated viewers, and other URLs without network access', async () => {
    const h = harness();
    await h.controller.detect(3, 'https://example.com/a.pdf', 'https://example.com/a.pdf');
    for (const [tab, url, target] of [[3, 'https://example.com/a.pdf', 'https://example.com/a.pdf'], [91, 'chrome-extension://test/index.html?sourceTab=3', 'https://example.com/a.pdf'], [90, 'chrome-extension://test/index.html?sourceTab=3', 'https://private.test/secret']] as const) {
      await expect(h.controller.fetchPdf({ tabId: tab, url }, target)).rejects.toThrow();
    }
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it('returns authenticated PDF bytes to the bound reader', async () => {
    const h = harness();
    await h.controller.detect(3, 'https://example.com/a.pdf', 'https://example.com/a.pdf');
    const bytes = await h.controller.fetchPdf({ tabId: 90, url: 'chrome-extension://test/index.html?sourceTab=3' }, 'https://example.com/a.pdf');
    expect(new TextDecoder().decode(bytes)).toBe('%PDF-1.7\nhello');
    expect(h.fetcher).toHaveBeenCalledWith('https://example.com/a.pdf', expect.objectContaining({ credentials: 'include', redirect: 'error' }));
  });
  it('rejects non-PDF responses rather than passing an HTML login page to the reader', async () => {
    const h = harness();
    h.fetcher.mockImplementation(async () => new Response('<html>sign in</html>'));
    await h.controller.detect(3, 'https://example.com/a.pdf', 'https://example.com/a.pdf');
    await expect(h.controller.fetchPdf({ tabId: 90, url: 'chrome-extension://test/index.html?sourceTab=3' }, 'https://example.com/a.pdf')).rejects.toThrow(/PDF/);
  });
  it('revokes old reader access when the source navigates away', async () => {
    const h = harness();
    await h.controller.detect(3, 'https://example.com/a.pdf', 'https://example.com/a.pdf');
    await h.controller.navigate(3, 'https://example.com/home');
    await expect(h.controller.fetchPdf({ tabId: 90, url: 'chrome-extension://test/index.html?sourceTab=3' }, 'https://example.com/a.pdf')).rejects.toThrow();
  });
  it('does not open privileged browser, blob, or data URLs', async () => {
    const h = harness();
    for (const url of ['chrome://settings', 'data:application/pdf;base64,abc', 'blob:https://example.com/id']) await h.controller.detect(3, url, url);
    expect(h.open).not.toHaveBeenCalled();
  });
  it('opens an explicit context-menu request even when automatic mirrors are off', async () => {
    const h = harness(false);
    await h.controller.detect(3, 'https://example.com/a.pdf', 'https://example.com/a.pdf', { force: true });
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.sessions.get(3)?.viewerTabId).toBe(90);
  });
  it('reopens a mirror whose viewer tab disappeared instead of trusting a stale session', async () => {
    const alive = new Set([90]);
    const h = harness(true, { isOpen: async id => alive.has(id) });
    await h.controller.detect(3, 'https://example.com/a.pdf', 'https://example.com/a.pdf');
    await h.controller.detect(3, 'https://example.com/a.pdf', 'https://example.com/a.pdf');
    expect(h.open).toHaveBeenCalledTimes(1);
    alive.clear();
    await h.controller.detect(3, 'https://example.com/a.pdf', 'https://example.com/a.pdf');
    expect(h.open).toHaveBeenCalledTimes(2);
  });
  it('closes the old viewer when the source navigates to a different document', async () => {
    const close = vi.fn(async () => {});
    const h = harness(true, { close });
    await h.controller.detect(3, 'https://example.com/a.pdf', 'https://example.com/a.pdf');
    await h.controller.navigate(3, 'https://example.com/other');
    expect(close).toHaveBeenCalledWith(90);
    expect(h.sessions.has(3)).toBe(false);
  });
  it('accepts only http, https and file PDF paths for context-menu validation', () => {
    expect(pdfPath('https://example.com/report.pdf?token=1')).toBe(true);
    expect(pdfPath('file:///C:/docs/report.PDF')).toBe(true);
    expect(pdfPath('https://example.com/article')).toBe(false);
    expect(pdfPath('chrome-extension://test/index.html?file=https://example.com/a.pdf')).toBe(false);
    expect(pdfPath('data:application/pdf;base64,abc')).toBe(false);
  });
});
