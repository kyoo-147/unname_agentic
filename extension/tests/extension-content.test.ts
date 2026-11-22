import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPPORTED_TARGETS } from '../viewer/src/core/language';

/*
 * Tests for the two DOM-bound extension surfaces: the content script (extension/content.ts)
 * and the popup document (extension/popup.ts + popup.html). The repository deliberately has
 * no DOM test environment and no extra dependency, so this file ships a tiny, strict DOM:
 * only the APIs those two modules actually call are implemented, and unknown selectors fail
 * the assertion instead of silently matching nothing.
 */

type Handler = (event: any) => void;
type Rect = { top: number; height: number };

function matchesCompound(element: FakeElement, compound: string): boolean {
  let rest = compound;
  const tag = /^[a-z][a-z0-9-]*/i.exec(rest)?.[0];
  if (tag) {
    if (element.tagName !== tag.toLowerCase()) return false;
    rest = rest.slice(tag.length);
  }
  const id = /^#[\w-]+/.exec(rest)?.[0];
  if (id) {
    if (element.id !== id.slice(1)) return false;
    rest = rest.slice(id.length);
  }
  let consumed = 0;
  for (const match of rest.matchAll(/\[([\w-]+)(?:(\*?=)"([^"]*)")?\]/g)) {
    consumed += match[0].length;
    const actual = element.getAttribute(match[1]!);
    if (actual === null) return false;
    if (match[2] === '=' && actual !== match[3]) return false;
    if (match[2] === '*=' && !actual.includes(match[3]!)) return false;
  }
  return consumed === rest.length;
}

class FakeElement {
  readonly tagName: string;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly style = { cssText: '' };
  ownerDocument: FakeDocument | null = null;
  parent: FakeElement | null = null;
  textContent = '';
  innerHTML = '';
  value = '';
  selected = false;
  disabled = false;
  type = '';
  rect: Rect | null = null;
  private readonly handlers = new Map<string, Handler[]>();
  constructor(tagName: string) { this.tagName = tagName.toLowerCase(); }
  private idValue = '';
  get id(): string { return this.idValue; }
  set id(value: string) { this.idValue = String(value); }
  setAttribute(name: string, value: string): void {
    if (name === 'id') this.idValue = String(value);
    else this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    if (name === 'id') return this.idValue === '' ? null : this.idValue;
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    if (name === 'id') this.idValue = '';
    else this.attributes.delete(name);
  }
  append(...nodes: FakeElement[]): void { for (const node of nodes) { node.parent?.drop(node); node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: FakeElement[]): void { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  remove(): void { this.parent?.drop(this); this.parent = null; }
  addEventListener(type: string, handler: Handler): void { this.handlers.set(type, [...this.handlers.get(type) ?? [], handler]); }
  dispatch(type: string, event: unknown = {}): void { for (const handler of this.handlers.get(type) ?? []) handler(event); }
  getBoundingClientRect(): Rect & { bottom: number; left: number; width: number } {
    const rect = this.rect ?? { top: 0, height: 0 };
    return { top: rect.top, height: rect.height, bottom: rect.top + rect.height, left: 0, width: 0 };
  }
  descendants(): FakeElement[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  matches(selector: string): boolean { return selector.split(',').some(compound => matchesCompound(this, compound.trim())); }
  private drop(node: FakeElement): void { const index = this.children.indexOf(node); if (index >= 0) this.children.splice(index, 1); }
}

class FakeDocument {
  readonly documentElement = new FakeElement('html');
  readonly body = new FakeElement('body');
  title = '';
  baseURI = 'https://example.com/reader/page.html';
  constructor() { this.documentElement.append(this.body); }
  createElement(tagName: string): FakeElement {
    const element = new FakeElement(tagName);
    element.ownerDocument = this;
    return element;
  }
  append(...elements: FakeElement[]): FakeElement[] { for (const element of elements) this.body.append(element); return elements; }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): FakeElement[] { return this.documentElement.descendants().filter(element => element.matches(selector)); }
  getElementById(id: string): FakeElement | null { return this.documentElement.descendants().find(element => element.id === id) ?? null; }
}

const wait = (ms = 20) => new Promise<void>(resolve => setTimeout(resolve, ms));

interface ContentHarness {
  document: FakeDocument;
  sent: any[];
  sendMessage: ReturnType<typeof vi.fn>;
  state: { enabled: boolean };
  scrollBy: ReturnType<typeof vi.fn>;
  notify(message: any): void;
  change(changes: any, area?: string): void;
  mutate(): void;
  scroll(event?: any): void;
}

let acceptsReports = true;

async function installContent(options: { enabled?: boolean; title?: string; pathname?: string; prepare?: (document: FakeDocument) => void } = {}): Promise<ContentHarness> {
  const document = new FakeDocument();
  document.title = options.title ?? 'Company handbook';
  options.prepare?.(document);
  const state = { enabled: options.enabled ?? true };
  const sent: any[] = [];
  const messageListeners: Handler[] = [];
  const changeListeners: ((changes: any, area: string) => void)[] = [];
  const scrollListeners: Handler[] = [];
  const observers: (() => void)[] = [];
  const scrollBy = vi.fn();
  const sendMessage = vi.fn(async (message: any) => { sent.push(message); return acceptsReports ? { ok: true } : { ok: false }; });
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: vi.fn(async (key: string) => ({ [key]: state.enabled })) },
      onChanged: { addListener: (listener: (changes: any, area: string) => void) => changeListeners.push(listener) },
    },
    runtime: { sendMessage, onMessage: { addListener: (listener: Handler) => messageListeners.push(listener) } },
  });
  vi.stubGlobal('document', document);
  vi.stubGlobal('location', { pathname: options.pathname ?? '/' });
  vi.stubGlobal('window', { addEventListener: (type: string, handler: Handler) => { if (type === 'scroll') scrollListeners.push(handler); }, scrollBy });
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { observers.push(callback); }
    observe(): void {}
    disconnect(): void {}
  });
  await import('../content');
  return {
    document,
    sent,
    sendMessage,
    state,
    scrollBy,
    notify: message => { for (const listener of messageListeners) listener(message); },
    change: (changes, area = 'local') => { for (const listener of changeListeners) listener(changes, area); },
    mutate: () => { for (const observer of observers) observer(); },
    scroll: (event = {}) => { for (const listener of scrollListeners) listener(event); },
  };
}

function embed(document: FakeDocument, tagName: 'embed' | 'object' | 'iframe', url: string, type?: string): FakeElement {
  const element = document.createElement(tagName);
  element.setAttribute(tagName === 'object' ? 'data' : 'src', url);
  if (type !== undefined) element.setAttribute('type', type);
  document.append(element);
  return element;
}

function page(document: FakeDocument, number: number, rect: Rect): FakeElement {
  const element = document.createElement('section');
  element.setAttribute('data-page-number', String(number));
  element.rect = rect;
  document.append(element);
  return element;
}

beforeEach(() => { vi.resetModules(); acceptsReports = true; });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('content script embedded PDF detection', () => {
  it('reports an embed whose type is application/pdf even without a .pdf suffix', async () => {
    const h = await installContent({ prepare: document => { embed(document, 'embed', '/download?id=7', 'application/pdf'); } });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toEqual({ type: 'mirror:discovered', url: 'https://example.com/download?id=7' });
  });

  it('resolves a relative object data path against the document base and accepts MIME parameters', async () => {
    const h = await installContent({ prepare: document => { embed(document, 'object', 'docs/paper.pdf', 'application/pdf; charset=binary'); } });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toEqual({ type: 'mirror:discovered', url: 'https://example.com/reader/docs/paper.pdf' });
  });

  it('keeps the page fragment of an iframe PDF source', async () => {
    const h = await installContent({ prepare: document => { embed(document, 'iframe', 'paper.pdf#page=4', ''); } });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    expect(h.sent[0]).toEqual({ type: 'mirror:discovered', url: 'https://example.com/reader/paper.pdf#page=4' });
  });

  it('does not mirror a page that merely looks like a PDF viewer', async () => {
    const h = await installContent({
      title: 'Report — PDF.js viewer',
      pathname: '/web/viewer.html',
      prepare: document => { embed(document, 'embed', '/viewer?id=123'); document.append(document.createElement('canvas')); },
    });
    await wait();
    expect(h.sent.filter(message => message.type === 'mirror:discovered')).toHaveLength(0);
    const hint = h.document.getElementById('mirror-capture-hint');
    expect(hint?.getAttribute('role')).toBe('status');
    expect(hint?.children.map(child => child.tagName)).toEqual(['span', 'button']);
  });

  it('stays silent until automatic mirroring is enabled, then reacts to the stored change', async () => {
    const h = await installContent({ enabled: false, prepare: document => { embed(document, 'embed', '/paper.pdf'); } });
    await wait();
    expect(h.sent).toHaveLength(0);
    h.state.enabled = true;
    h.change({ 'mirror:enabled': { newValue: true } });
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
  });

  it('deduplicates one URL and retries it after the background rejects the report', async () => {
    acceptsReports = false;
    const h = await installContent({ prepare: document => { embed(document, 'embed', 'paper.pdf'); embed(document, 'iframe', 'paper.pdf'); } });
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(1));
    await wait();
    acceptsReports = true;
    h.notify({ type: 'mirror:rescan' });
    await vi.waitFor(() => expect(h.sendMessage).toHaveBeenCalledTimes(2));
    expect(h.sent.map(message => message.url)).toEqual(['https://example.com/reader/paper.pdf', 'https://example.com/reader/paper.pdf']);
  });

  it('discovers a PDF element inserted after load only after the debounce window', async () => {
    vi.useFakeTimers();
    const h = await installContent();
    embed(h.document, 'iframe', 'late.pdf');
    h.mutate();
    expect(h.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.sent).toEqual([{ type: 'mirror:discovered', url: 'https://example.com/reader/late.pdf' }]);
  });
});

describe('content script notices and scroll relay', () => {
  it('ignores an empty or non-string notice payload', async () => {
    const h = await installContent();
    h.notify({ type: 'mirror:notice' });
    h.notify({ type: 'mirror:notice', message: '' });
    h.notify({ type: 'mirror:notice', message: 42 });
    expect(h.document.getElementById('mirror-notice')).toBeNull();
  });

  it('shows one replaceable notice with a status role, a close control and a timeout', async () => {
    const h = await installContent();
    vi.useFakeTimers();
    h.notify({ type: 'mirror:notice', message: 'Chỉ mở bản dịch cho tệp PDF.' });
    const notice = h.document.getElementById('mirror-notice');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.children[0]?.textContent).toBe('Chỉ mở bản dịch cho tệp PDF.');
    expect(notice?.children[1]?.getAttribute('aria-label')).toBe('Đóng thông báo');
    notice!.children[1]!.dispatch('click');
    expect(h.document.getElementById('mirror-notice')).toBeNull();

    h.notify({ type: 'mirror:notice', message: 'Bản dịch mở bên cạnh.' });
    h.notify({ type: 'mirror:notice', message: 'Bản dịch mở bên cạnh.' });
    const notices = h.document.querySelectorAll('#mirror-notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.children[0]?.textContent).toBe('Bản dịch mở bên cạnh.');
    await vi.advanceTimersByTimeAsync(7000);
    expect(h.document.getElementById('mirror-notice')).toBeNull();
  });

  it('relays the visible page position and suppresses the scroll echo it caused', async () => {
    const h = await installContent();
    page(h.document, 1, { top: -300, height: 100 });
    const second = page(h.document, 2, { top: -50, height: 100 });
    await wait();
    vi.useFakeTimers();

    h.scroll();
    expect(h.sent).toEqual([{ type: 'mirror:view-state', state: { page: 2, fraction: 0.5 } }]);
    h.scroll();
    expect(h.sent).toHaveLength(1);

    h.notify({ type: 'mirror:view-state', state: { page: 2, fraction: 0.25 } });
    expect(h.scrollBy).toHaveBeenCalledWith({ top: -25, behavior: 'instant' });

    second.rect = { top: -40, height: 100 };
    h.scroll();
    expect(h.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    h.scroll();
    expect(h.sent[1]).toEqual({ type: 'mirror:view-state', state: { page: 2, fraction: 0.4 } });
  });

  it('does not scroll to a page that is not rendered in this document', async () => {
    const h = await installContent();
    page(h.document, 1, { top: 0, height: 100 });
    h.notify({ type: 'mirror:view-state', state: { page: 9, fraction: 0.5 } });
    expect(h.scrollBy).not.toHaveBeenCalled();
  });
});

interface PopupHarness {
  select: FakeElement;
  local: Record<string, unknown>;
  storage: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
}

async function installPopup(stored: Record<string, unknown> = {}): Promise<PopupHarness> {
  const document = new FakeDocument();
  for (const id of ['toggle', 'mode', 'status', 'desktop', 'desktop-stop', 'desktop-status', 'locale-switch', 'reader', 'capture', 'target-language']) {
    const element = document.createElement(id === 'target-language' ? 'select' : 'button');
    element.setAttribute('id', id);
    document.append(element);
  }
  const local: Record<string, unknown> = { ...stored };
  const storage = {
    get: vi.fn(async (key: string) => ({ [key]: local[key] })),
    set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(local, next); }),
  };
  vi.stubGlobal('chrome', {
    storage: { local: storage },
    runtime: { sendMessage: vi.fn(async () => ({ ok: true, available: false, sourceAvailable: false, transferring: false, following: false })) },
    tabs: { create: vi.fn(async () => ({})), query: vi.fn(async () => []), captureVisibleTab: vi.fn(async () => '') },
  });
  vi.stubGlobal('document', document);
  await import('../popup');
  return { select: document.getElementById('target-language')!, local, storage };
}

describe('popup target language control', () => {
  it('builds every supported target from its native name and restores the stored choice', async () => {
    const h = await installPopup({ 'mirror:targetLanguage': 'zh' });
    await vi.waitFor(() => expect(h.select.children).toHaveLength(SUPPORTED_TARGETS.length));
    expect(h.select.children.map(option => option.value)).toEqual(SUPPORTED_TARGETS.map(target => target.code));
    expect(h.select.children.map(option => option.textContent)).toEqual(SUPPORTED_TARGETS.map(target => target.nativeName));
    expect(h.select.children.filter(option => option.selected).map(option => option.value)).toEqual(['zh']);
    expect(h.select.value).toBe('zh');
  });

  it('persists a chosen target and falls back to Vietnamese for an unsupported value', async () => {
    const h = await installPopup();
    await vi.waitFor(() => expect(h.select.children).toHaveLength(SUPPORTED_TARGETS.length));
    h.select.value = 'ja';
    h.select.dispatch('change');
    await vi.waitFor(() => expect(h.local['mirror:targetLanguage']).toBe('ja'));
    h.select.value = 'klingon';
    h.select.dispatch('change');
    await vi.waitFor(() => expect(h.storage.set).toHaveBeenCalledTimes(2));
    expect(h.local['mirror:targetLanguage']).toBe('vi');
  });

  it('ships the control in the popup markup using existing translation keys', () => {
    const markup = readFileSync(new URL('../popup.html', import.meta.url), 'utf8');
    expect(markup).toContain('<select id="target-language"');
    expect(markup).toContain('data-i18n="targetLanguage"');
    expect(markup).toContain('data-i18n-aria-label="targetLanguageAria"');
    expect(markup).not.toContain('<option');
  });
});
