/**
 * Printing and PDF delivery for the bilingual export.
 *
 * Why there are two PDF paths: `src/export/pdf.ts` writes a real file with
 * pdf-lib and is what the "Download real PDF" action uses. This print sheet is
 * kept as the fast fallback for the bilingual layout, because it reuses the
 * stylesheet that `toBilingualHtml` already emits (page breaks, `@page` margins,
 * avoid-break blocks) without a second layout engine. Handing the same
 * self-contained HTML to the browser's own print pipeline needs no dependency and
 * produces the PDF the user's own print sheet is set up for. The hidden iframe
 * keeps the reader page intact while it does so; the new window is only the
 * fallback for environments that refuse an iframe.
 *
 * What this path cannot do, and the UI must not promise:
 * - no page furniture of our own: headers, footers, page numbers and paper size belong to the browser
 *   print sheet, not to this module;
 * - no pixel fidelity with the on-screen reader: the printed page reflows through print media queries
 *   and the user's paper, so line wrapping and page breaks differ from the canvas view;
 * - no control over fonts or images beyond what the exported document itself asks for.
 *
 * All DOM access is resolved inside `printHtml`, never at module scope, so the module imports in node.
 */

export type PrintTransport = 'iframe' | 'window';

export interface PrintOptions {
  /** How long to wait for the printable document to load before giving up. */
  timeoutMs?: number;
  /** How long the hidden iframe, or the opened window, survives after `print()` returns. */
  cleanupDelayMs?: number;
}

export const PRINT_LOAD_TIMEOUT_MS = 15_000;
export const PRINT_CLEANUP_DELAY_MS = 1_000;
export const HIDDEN_IFRAME_STYLE = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;overflow:hidden;';
export const DEFAULT_DOCUMENT_TITLE = 'Mirror';
export const DOCUMENT_TITLE_MAX_LENGTH = 200;
export const PRINT_UNAVAILABLE_MESSAGE = 'Printing needs a browser window; this environment has none.';
export const PRINT_FRAME_MESSAGE = 'This environment refused a hidden print frame.';
export const PRINT_BLOCKED_MESSAGE = 'The browser blocked the print window.';
export const PRINT_TIMEOUT_MESSAGE = 'The printable document did not load in time.';

/** Carries a stable `name` so the UI can map it to a localized message without matching text. */
export class PrintUnavailableError extends Error {
  constructor(message: string = PRINT_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = 'PrintUnavailableError';
  }
}

export class PrintTimeoutError extends Error {
  constructor(message: string = PRINT_TIMEOUT_MESSAGE) {
    super(message);
    this.name = 'PrintTimeoutError';
  }
}

interface ResolvedPrintOptions {
  timeoutMs: number;
  cleanupDelayMs: number;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

function millis(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value ?? fallback)) : fallback;
}

function resolveOptions(opts: PrintOptions): ResolvedPrintOptions {
  return {
    timeoutMs: millis(opts.timeoutMs, PRINT_LOAD_TIMEOUT_MS),
    cleanupDelayMs: millis(opts.cleanupDelayMs, PRINT_CLEANUP_DELAY_MS),
  };
}

function domDocument(): Document | undefined {
  return typeof document === 'undefined' ? undefined : document;
}

function domWindow(): Window | undefined {
  return typeof window === 'undefined' ? undefined : window;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(resolve, ms); });
}

function scheduleCleanup(cleanup: () => void, cleanupDelayMs: number): void {
  const run = (): void => {
    try { cleanup(); } catch { /* the surface is already gone; nothing left to release */ }
  };
  if (typeof setTimeout === 'function') setTimeout(run, cleanupDelayMs);
  else run();
}

function waitForLoad(frame: HTMLIFrameElement, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      frame.removeEventListener('load', onLoad);
      if (timer !== undefined) clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const onLoad = (): void => { finish(); };
    frame.addEventListener('load', onLoad);
    timer = setTimeout(() => { finish(new PrintTimeoutError()); }, timeoutMs);
  });
}

/** The print title also becomes the "save as PDF" file name in the browser dialog. */
export function documentTitle(title: string, opts: { fallback?: string; maxLength?: number } = {}): string {
  const collapse = (value: string): string => value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const fallback = collapse(typeof opts.fallback === 'string' ? opts.fallback : '') || DEFAULT_DOCUMENT_TITLE;
  const text = collapse(typeof title === 'string' ? title : '');
  if (!text) return fallback;
  const limit = millis(opts.maxLength, DOCUMENT_TITLE_MAX_LENGTH) || DOCUMENT_TITLE_MAX_LENGTH;
  const chars = [...text];
  return chars.length > limit ? chars.slice(0, limit).join('').trimEnd() || fallback : text;
}

function createFrame(doc: Document): HTMLIFrameElement {
  try {
    const frame = doc.createElement('iframe');
    if (frame && typeof frame.setAttribute === 'function') return frame;
  } catch { /* fall through to the window path */ }
  throw new PrintUnavailableError(PRINT_FRAME_MESSAGE);
}

function mountFrame(doc: Document, frame: HTMLIFrameElement): void {
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  frame.setAttribute('style', HIDDEN_IFRAME_STYLE);
  try {
    (doc.body ?? doc.documentElement).append(frame);
  } catch {
    throw new PrintUnavailableError(PRINT_FRAME_MESSAGE);
  }
}

async function printViaIframe(html: string, opts: ResolvedPrintOptions, doc: Document): Promise<PrintTransport> {
  const frame = createFrame(doc);
  let mounted = false;
  try {
    const loaded = waitForLoad(frame, opts.timeoutMs);
    mountFrame(doc, frame);
    mounted = true;
    const inner = frame.contentWindow;
    if (!inner || typeof inner.print !== 'function') throw new PrintUnavailableError(PRINT_FRAME_MESSAGE);
    frame.srcdoc = html;
    await loaded;
    const surface = frame.contentWindow ?? inner;
    surface.focus();
    surface.print();
    return 'iframe';
  } finally {
    if (mounted) scheduleCleanup(() => frame.remove(), opts.cleanupDelayMs);
  }
}

async function printViaWindow(html: string, opts: ResolvedPrintOptions, win: Window): Promise<PrintTransport> {
  let popup: Window | null;
  try {
    popup = win.open('', '_blank');
  } catch {
    throw new PrintUnavailableError(PRINT_BLOCKED_MESSAGE);
  }
  if (!popup) throw new PrintUnavailableError(PRINT_BLOCKED_MESSAGE);
  const opened = popup;
  try {
    try { opened.opener = null; } catch { /* the sheet still prints without severing opener */ }
    const doc = opened.document;
    doc.open();
    doc.write(html);
    doc.close();
    // One task hop so the written document finishes parsing and layout before the print snapshot.
    await delay(0);
    opened.focus();
    opened.print();
    return 'window';
  } finally {
    // print() blocks until the sheet is dismissed, so this closes after the job has been handed off.
    scheduleCleanup(() => { opened.close(); }, opts.cleanupDelayMs);
  }
}

/**
 * Prints a self-contained HTML document through a hidden iframe, falling back to a new window when the
 * environment refuses a frame. Rejects with `PrintUnavailableError` when there is no browser at all and
 * with `PrintTimeoutError` when the printable document never loads.
 */
export async function printHtml(html: string, opts: PrintOptions = {}): Promise<PrintTransport> {
  const doc = domDocument();
  const win = domWindow();
  if (!doc || !win) throw new PrintUnavailableError();
  const resolved = resolveOptions(opts);
  try {
    return await printViaIframe(html, resolved, doc);
  } catch (error) {
    if (!(error instanceof PrintUnavailableError)) throw error;
    return printViaWindow(html, resolved, win);
  }
}
