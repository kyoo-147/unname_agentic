import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FILENAME,
  FILENAME_MAX_LENGTH,
  NO_DOM_MESSAGE,
  TEXT_MIME,
  defaultSaver,
  sanitizeFilename,
  saveBlob,
  saveTextFile,
  type Saver,
} from '../src/export/download';
import {
  DEFAULT_DOCUMENT_TITLE,
  DOCUMENT_TITLE_MAX_LENGTH,
  HIDDEN_IFRAME_STYLE,
  PRINT_UNAVAILABLE_MESSAGE,
  PrintTimeoutError,
  PrintUnavailableError,
  documentTitle,
  printHtml,
} from '../src/export/print';

afterEach(() => vi.unstubAllGlobals());

const flushCleanup = (): Promise<void> => new Promise<void>(resolve => { setTimeout(resolve, 5); });

const collector = (): { calls: { name: string; blob: Blob }[]; saver: Saver } => {
  const calls: { name: string; blob: Blob }[] = [];
  return { calls, saver: { save: (name, blob) => { calls.push({ name, blob }); } } };
};

describe('sanitizeFilename', () => {
  it('strips traversal, path separators and reserved Windows characters from a hostile name', () => {
    expect(sanitizeFilename('..\\evil/name?.txt')).toBe('evilname.txt');
    expect(sanitizeFilename('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeFilename('a<b>c:d"e|f?g*h/i\\j.txt')).toBe('abcdefghij.txt');
    expect(sanitizeFilename('..\\evil/name?.txt')).not.toMatch(/[<>:"/\\|?*]/);
  });

  it('removes control characters instead of turning them into spaces', () => {
    expect(sanitizeFilename('tài\u0000liệu\u001f')).toBe('tàiliệu');
    expect(sanitizeFilename('a\u007fb')).toBe('ab');
  });

  it('keeps Vietnamese diacritics and composes decomposed input', () => {
    const composed = 'Tài liệu tiếng Việt';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    expect(sanitizeFilename(composed)).toBe(composed);
    expect(sanitizeFilename(decomposed)).toBe(composed);
    expect(sanitizeFilename(composed)).not.toContain('\uFFFD');
  });

  it('collapses dot runs and drops leading and trailing dots and spaces', () => {
    expect(sanitizeFilename('report..final...txt')).toBe('report.final.txt');
    expect(sanitizeFilename('.bashrc')).toBe('bashrc');
    expect(sanitizeFilename('name.  ')).toBe('name');
  });

  it('clamps a 300 character name and still ends with the extension', () => {
    const clamped = sanitizeFilename(`${'a'.repeat(300)}.txt`);
    expect(clamped.length).toBeLessThanOrEqual(FILENAME_MAX_LENGTH);
    expect(clamped).toBe(`${'a'.repeat(FILENAME_MAX_LENGTH - 4)}.txt`);
    const forced = sanitizeFilename('a'.repeat(300), { extension: 'html' });
    expect(forced.endsWith('.html')).toBe(true);
    expect(forced.length).toBeLessThanOrEqual(FILENAME_MAX_LENGTH);
  });

  it('never lets the length cap drop the extension', () => {
    expect(sanitizeFilename('abcdefghij.txt', { extension: 'txt', maxLength: 6 })).toBe('ab.txt');
    expect(sanitizeFilename('abcdefghij', { extension: 'txt', maxLength: 2 })).toBe('a.txt');
  });

  it('falls back to a default name when nothing usable is left', () => {
    expect(sanitizeFilename('')).toBe(DEFAULT_FILENAME);
    expect(sanitizeFilename('   ')).toBe(DEFAULT_FILENAME);
    expect(sanitizeFilename('...')).toBe(DEFAULT_FILENAME);
    expect(sanitizeFilename('///???')).toBe(DEFAULT_FILENAME);
    expect(sanitizeFilename('', { extension: 'txt' })).toBe(`${DEFAULT_FILENAME}.txt`);
    expect(sanitizeFilename('', { fallback: 'Bản song ngữ' })).toBe('Bản song ngữ');
    expect(sanitizeFilename('..', { fallback: 'Bản dịch', extension: 'txt' })).toBe('Bản dịch.txt');
  });

  it('always ends with the requested extension and is idempotent', () => {
    expect(sanitizeFilename('báo-cáo.pdf', { extension: '.txt' })).toBe('báo-cáo.txt');
    expect(sanitizeFilename('báo-cáo.txt', { extension: 'txt' })).toBe('báo-cáo.txt');
    expect(sanitizeFilename('Bản dịch', { extension: 'txt' })).toBe('Bản dịch.txt');
    expect(sanitizeFilename('archive.tar.gz')).toBe('archive.tar.gz');
  });
});

describe('defaultSaver', () => {
  it('refuses to pretend a download happened outside a browser', () => {
    expect(() => defaultSaver().save('a.txt', new Blob(['x']))).toThrow(NO_DOM_MESSAGE);
  });
});

describe('saveTextFile', () => {
  it('calls the injected saver exactly once with the sanitised name and the requested mime', () => {
    const { calls, saver } = collector();
    const saved = saveTextFile('Bản dịch: chương 1/2', 'Xin chào', 'text/plain;charset=utf-8', { saver });
    expect(saved).toBe('Bản dịch chương 12.txt');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe(saved);
    expect(calls[0]?.blob).toBeInstanceOf(Blob);
    expect(calls[0]?.blob.type).toBe('text/plain;charset=utf-8');
  });

  it('writes UTF-8 text with the default mime and reads back unchanged', async () => {
    const { calls, saver } = collector();
    const saved = saveTextFile('Tài liệu', 'Điều 3: quyền tự do — 日本語', undefined, { saver });
    expect(saved).toBe('Tài liệu.txt');
    expect(calls[0]?.blob.type).toBe(TEXT_MIME);
    await expect(calls[0]?.blob.text()).resolves.toBe('Điều 3: quyền tự do — 日本語');
  });

  it('falls back to the default name for an empty title and still saves once', () => {
    const { calls, saver } = collector();
    const saved = saveTextFile('', 'body', TEXT_MIME, { saver });
    expect(saved).toBe(`${DEFAULT_FILENAME}.txt`);
    expect(calls.map(call => call.name)).toEqual([`${DEFAULT_FILENAME}.txt`]);
  });

  it('throws the DOM message when no saver is injected outside a browser', () => {
    expect(() => saveTextFile('a', 'b')).toThrow(NO_DOM_MESSAGE);
  });
});

describe('saveBlob', () => {
  it('keeps the blob mime type and the name extension', () => {
    const { calls, saver } = collector();
    const blob = new Blob(['<p>x</p>'], { type: 'text/html;charset=utf-8' });
    const saved = saveBlob('bài..giảng.html', blob, { saver });
    expect(saved).toBe('bài.giảng.html');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('bài.giảng.html');
    expect(calls[0]?.blob).toBe(blob);
    expect(calls[0]?.blob.type).toBe('text/html;charset=utf-8');
  });
});

describe('documentTitle', () => {
  it('trims and collapses whitespace', () => {
    expect(documentTitle('  Bản song ngữ  ')).toBe('Bản song ngữ');
    expect(documentTitle('Bản\tsong\nngữ')).toBe('Bản song ngữ');
    expect(documentTitle('\u0000 Bản song ngữ \u001f')).toBe('Bản song ngữ');
  });

  it('falls back to the product name when the title is blank', () => {
    expect(documentTitle('')).toBe(DEFAULT_DOCUMENT_TITLE);
    expect(documentTitle('   ')).toBe(DEFAULT_DOCUMENT_TITLE);
    expect(documentTitle('', { fallback: 'Tài liệu' })).toBe('Tài liệu');
    expect(documentTitle('  ', { fallback: 'Tài liệu' })).toBe('Tài liệu');
  });

  it('clamps a long title without touching diacritics or CJK', () => {
    const clamped = documentTitle(`Bản dịch ${'x'.repeat(500)}`);
    expect(clamped.length).toBeLessThanOrEqual(DOCUMENT_TITLE_MAX_LENGTH);
    expect(clamped.startsWith('Bản dịch ')).toBe(true);
    expect(documentTitle('Điều 3 — 第三章')).toBe('Điều 3 — 第三章');
  });
});

type LoadListener = () => void;

interface FakeFrame {
  attributes: Map<string, string>;
  srcdoc: string;
  removed: boolean;
  contentWindow: { focus: () => void; print: () => void };
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: LoadListener): void;
  removeEventListener(type: string, listener: LoadListener): void;
  remove(): void;
}

function fakeIframeHost() {
  const listeners: LoadListener[] = [];
  const attributes = new Map<string, string>();
  const print = vi.fn();
  const focus = vi.fn();
  const frame: FakeFrame = {
    attributes,
    srcdoc: '',
    removed: false,
    contentWindow: { focus, print },
    setAttribute(name: string, value: string): void { attributes.set(name, String(value)); },
    addEventListener(_type: string, listener: LoadListener): void { listeners.push(listener); },
    removeEventListener(_type: string, listener: LoadListener): void {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
    remove(): void { frame.removed = true; },
  };
  const doc = {
    createElement: () => frame,
    body: { append: (node: unknown): void => { if (node !== frame) throw new Error('unexpected mounted node'); } },
    documentElement: null,
  } as unknown as Document;
  const fireLoad = (): void => { for (const listener of listeners.splice(0)) listener(); };
  return { doc, frame, fireLoad, print, focus };
}

describe('printHtml in a browser document', () => {
  it('waits for load, prints the hidden iframe once, then removes it', async () => {
    const host = fakeIframeHost();
    const open = vi.fn(() => null);
    vi.stubGlobal('document', host.doc);
    vi.stubGlobal('window', { open });
    const pending = printHtml('<p>Xin chào</p>', { timeoutMs: 5_000, cleanupDelayMs: 0 });
    expect(host.print).not.toHaveBeenCalled();
    host.fireLoad();
    await expect(pending).resolves.toBe('iframe');
    expect(open).not.toHaveBeenCalled();
    expect(host.frame.srcdoc).toBe('<p>Xin chào</p>');
    expect(host.frame.attributes.get('aria-hidden')).toBe('true');
    expect(host.frame.attributes.get('tabindex')).toBe('-1');
    expect(host.frame.attributes.get('style')).toBe(HIDDEN_IFRAME_STYLE);
    expect(host.focus).toHaveBeenCalledTimes(1);
    expect(host.print).toHaveBeenCalledTimes(1);
    await flushCleanup();
    expect(host.frame.removed).toBe(true);
  });

  it('rejects with PrintTimeoutError when the printable document never loads', async () => {
    const host = fakeIframeHost();
    vi.stubGlobal('document', host.doc);
    vi.stubGlobal('window', { open: vi.fn(() => null) });
    await expect(printHtml('<p>x</p>', { timeoutMs: 1, cleanupDelayMs: 0 })).rejects.toBeInstanceOf(PrintTimeoutError);
    expect(host.print).not.toHaveBeenCalled();
    await flushCleanup();
    expect(host.frame.removed).toBe(true);
  });

  it('falls back to a new window when the document refuses an iframe', async () => {
    const written: string[] = [];
    const popup = {
      opener: {},
      document: {
        open: vi.fn(),
        write: (markup: string): void => { written.push(markup); },
        close: vi.fn(),
      },
      focus: vi.fn(),
      print: vi.fn(),
      close: vi.fn(),
    };
    const open = vi.fn(() => popup);
    vi.stubGlobal('document', { createElement: () => { throw new Error('no frame'); } } as unknown as Document);
    vi.stubGlobal('window', { open });
    await expect(printHtml('<p>Xin chào</p>', { cleanupDelayMs: 0 })).resolves.toBe('window');
    expect(open).toHaveBeenCalledTimes(1);
    expect(written).toEqual(['<p>Xin chào</p>']);
    expect(popup.focus).toHaveBeenCalledTimes(1);
    expect(popup.print).toHaveBeenCalledTimes(1);
    await flushCleanup();
    expect(popup.close).toHaveBeenCalledTimes(1);
  });

  it('rejects when the iframe is unavailable and the new window is blocked', async () => {
    vi.stubGlobal('document', { createElement: () => { throw new Error('no frame'); } } as unknown as Document);
    vi.stubGlobal('window', { open: vi.fn(() => null) });
    await expect(printHtml('<p>x</p>', { cleanupDelayMs: 0 })).rejects.toBeInstanceOf(PrintUnavailableError);
  });
});

describe('printHtml without a DOM', () => {
  it('imports cleanly and rejects instead of throwing when there is no window', async () => {
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('window', undefined);
    const pending = printHtml('<p>xin chào</p>');
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toBeInstanceOf(PrintUnavailableError);
    await expect(printHtml('<p>x</p>')).rejects.toMatchObject({
      name: 'PrintUnavailableError',
      message: PRINT_UNAVAILABLE_MESSAGE,
    });
  });
});
