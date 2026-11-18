/**
 * Export delivery: hand a finished string or Blob to the browser as a download.
 *
 * Every DOM touch sits behind `Saver`, so export builders and their tests stay pure; `defaultSaver()`
 * is the only implementation that needs a browser. Object URLs are revoked on a short delay because
 * Firefox cancels a download whose URL is revoked in the same task as the click.
 */

export interface Saver {
  save(name: string, blob: Blob): void;
}

export interface FilenameOptions {
  /** Extension forced onto the saved name, with or without a leading dot. */
  extension?: string;
  /** Base name used when sanitising leaves nothing usable behind. */
  fallback?: string;
  /** Hard cap for the saved name, extension included. */
  maxLength?: number;
}

export interface SaveOptions extends FilenameOptions {
  /** Where the finished file goes. Defaults to `defaultSaver()`. */
  saver?: Saver;
}

export const TEXT_MIME = 'text/plain;charset=utf-8';
export const TEXT_EXTENSION = 'txt';
export const DEFAULT_FILENAME = 'mirror-export';
export const FILENAME_MAX_LENGTH = 120;
export const OBJECT_URL_REVOKE_DELAY_MS = 1000;
export const NO_DOM_MESSAGE = 'Export needs a browser document; this environment has none.';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const RESERVED_CHARS = /[<>:"/\\|?*]/g;
const DOT_RUNS = /\.{2,}/g;
const EDGE_DOTS = /^\.+|\.+$/g;
const EDGE_NOISE = /[.\s]+$/;

/** Separators and reserved characters are removed rather than escaped: no file manager needs them back. */
function cleanName(value: string): string {
  return value
    .normalize('NFC')
    .replace(CONTROL_CHARS, '')
    .replace(RESERVED_CHARS, '')
    .replace(DOT_RUNS, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EDGE_DOTS, '');
}

function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { stem: name, extension: '' };
  return { stem: name.slice(0, dot), extension: name.slice(dot + 1) };
}

function fit(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, Math.max(1, limit)).replace(EDGE_NOISE, '');
}

/**
 * Turns any caller string into one safe file name: no path separators, no Windows-reserved
 * characters, no control characters, no dot runs, capped length, and always the requested extension.
 * Letters outside ASCII are kept as they are, so "Tài liệu tiếng Việt" survives intact.
 */
export function sanitizeFilename(name: string, opts: FilenameOptions = {}): string {
  const cleaned = cleanName(typeof name === 'string' ? name : '');
  const split = splitExtension(cleaned);
  const fallback = cleanName(typeof opts.fallback === 'string' ? opts.fallback : '') || DEFAULT_FILENAME;
  const forced = typeof opts.extension === 'string' ? cleanName(opts.extension) : '';
  const extension = forced || split.extension;
  const suffix = extension ? `.${extension}` : '';
  const requested = Number.isFinite(opts.maxLength) ? Math.trunc(opts.maxLength ?? FILENAME_MAX_LENGTH) : FILENAME_MAX_LENGTH;
  const limit = Math.max(suffix.length + 1, requested);
  const stem = fit(split.stem, limit - suffix.length) || fit(fallback, limit - suffix.length) || DEFAULT_FILENAME;
  return `${stem}${suffix}`;
}

/** Saves an already-built blob under the sanitised name and returns the name it used. */
export function saveBlob(name: string, blob: Blob, opts: SaveOptions = {}): string {
  const filename = sanitizeFilename(name, opts);
  const saver = opts.saver ?? defaultSaver();
  saver.save(filename, blob);
  return filename;
}

/** Saves UTF-8 text as a download and returns the sanitised name it used. */
export function saveTextFile(name: string, text: string, mime: string = TEXT_MIME, opts: SaveOptions = {}): string {
  const type = typeof mime === 'string' && mime.trim() ? mime.trim() : TEXT_MIME;
  return saveBlob(name, new Blob([text], { type }), { extension: TEXT_EXTENSION, ...opts });
}

/** The browser sink: object URL, a synthetic anchor click, then revoke. */
export function defaultSaver(): Saver {
  return {
    save(name: string, blob: Blob): void {
      if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        throw new Error(NO_DOM_MESSAGE);
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      try {
        anchor.href = url;
        anchor.download = name;
        anchor.rel = 'noopener';
        anchor.style.display = 'none';
        (document.body ?? document.documentElement).append(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_DELAY_MS);
      }
    },
  };
}
