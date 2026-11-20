/**
 * Token protection for machine translation (backlog G06).
 *
 * A translation must never change locked content: numbers, URLs, emails,
 * citations, formulas, code spans, file/hash tokens, and ALL-CAPS identifiers.
 * This module replaces each such token with a numbered placeholder (`⟦1⟧`,
 * `⟦2⟧`, ...) before the text leaves the machine, and puts the originals back
 * afterwards.
 *
 * The placeholder is one short token in rare brackets (U+27E6/U+27E7) so a
 * machine translator has nothing to translate inside it and is likely to keep
 * it as a single unit. Masking is lossless: the only visible change is the
 * placeholder itself. {@link restore} reports every placeholder the answer
 * dropped or duplicated instead of silently losing the source token.
 */

export const PLACEHOLDER_OPEN = '⟦';
export const PLACEHOLDER_CLOSE = '⟧';

export type ProtectedKind =
  | 'url'
  | 'email'
  | 'citation'
  | 'formula'
  | 'code'
  | 'path'
  | 'hash'
  | 'identifier'
  | 'date'
  | 'range'
  | 'number';

export interface ProtectedToken {
  /** 1-based placeholder number; `⟦index⟧` marks it in the masked text. */
  index: number;
  /** Source text the placeholder stands for, restored verbatim. */
  value: string;
  kind: ProtectedKind;
}

export interface MaskResult {
  masked: string;
  tokens: ProtectedToken[];
}

export interface RestoreResult {
  /** Translated text with every present placeholder replaced; unpaired markers stay visible. */
  text: string;
  /** Placeholder numbers the answer never returned. */
  missing: number[];
  /** Placeholder numbers the answer returned more than once. */
  duplicated: number[];
}

/** The marker shown to the translator for one token number. */
export function placeholderFor(index: number): string {
  return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
}

/** A placeholder as it may come back from a translator: optional spaces inside. */
const PLACEHOLDER_PATTERN = /⟦\s*(\d{1,9})\s*⟧/gu;

// --- Token patterns -------------------------------------------------------
// Order matters: the first rule that claims a span wins, so narrow, unambiguous
// forms (code, math, citations) run before the broad number sweep.

const LATEX_DISPLAY = /\\\[[\s\S]*?\\\]/gu;
const LATEX_INLINE = /\\\([\s\S]*?\\\)/gu;
const DOLLAR_DISPLAY = /\$\$[\s\S]+?\$\$/gu;
// Inline math only: the character after `$` must not be a digit, so currency
// such as "$5 and $6" is not read as one formula.
const DOLLAR_INLINE = /\$(?![\s\d$])[^$\n]*?[^\s$]\$/gu;
const FENCED_CODE = /```[\s\S]*?```/gu;
const INLINE_CODE = /`[^`\n]+`/gu;

const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const URL = /(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'`]+/giu;
const WINDOWS_PATH = /(?<![\p{L}\p{N}_])[A-Za-z]:[\\/][^\s<>"'|]+/gu;
const UNIX_PATH = /(?<![\p{L}\p{N}_./-])(?:\.{1,2}[\\/]|~[\\/]|\/)(?:[\p{L}\p{N}_.-]+[\\/])*[\p{L}\p{N}_.-]+/gu;

// Extensions are listed explicitly so ordinary prose ("e.g.", "Fig.", "Prof.")
// never looks like a file name.
const FILE_EXTENSIONS = [
  'pdf', 'docx?', 'xlsx?', 'pptx?', 'csv', 'tsv', 'json', 'jsonl', 'md', 'txt', 'rtf',
  'html?', 'xml', 'ya?ml', 'toml', 'ini', 'cfg', 'log', 'bib', 'tex', 'cls', 'sty', 'epub',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar',
  'png', 'jpe?g', 'gif', 'svg', 'webp', 'bmp', 'tiff?',
  'mp3', 'wav', 'flac', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  'py', 'ipynb', 'js', 'mjs', 'cjs', 'tsx?', 'jsx', 'vue', 'svelte', 'java', 'kt', 'kts', 'swift',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'rs', 'go', 'rb', 'php', 'cs', 'sh', 'bash', 'zsh', 'ps1',
  'sql', 'r', 'lua', 'pl', 'dart', 'scala', 'groovy', 'gradle', 'lock', 'env',
  'pem', 'key', 'crt', 'cer', 'der', 'p12', 'pfx',
  'db', 'sqlite3?', 'parquet', 'avro', 'orc', 'sav', 'dta', 'mat', 'npy', 'npz', 'pkl', 'h5',
  'hdf5', 'ckpt', 'pt', 'onnx', 'bin', 'dat', 'iso', 'img', 'dmg', 'exe', 'msi', 'deb', 'rpm',
  'apk', 'ipa',
].join('|');
const FILENAME = new RegExp(String.raw`(?<![\p{L}\p{N}_-])[\p{L}\p{N}_-]*(?:\.[\p{L}\p{N}_-]+)*\.(?:${FILE_EXTENSIONS})\b`, 'giu');

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
// Hex digest: at least one digit and one hex letter, so plain words are skipped.
const HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/giu;

const CITATION_BRACKET = /\[\s*\d+(?:\s*[,;–—-]\s*\d+)*\s*\]/gu;
const CITATION_NARRATIVE = /\b[\p{Lu}][\p{L}'’-]+(?:\s+et\s+al\.?)\s*\((?:19|20)\d{2}[a-z]?\)/gu;
const CITATION_PAREN = /(?<![\p{L}\p{N}])(\(\s*[\p{Lu}][\p{L}'’-]+(?:[\s,]+(?:et\s+al\.?|and|&|va|và))?(?:[\s,]+[\p{Lu}][\p{L}'’-]+)*[\s,]+(?:19|20)\d{2}[a-z]?(?:[\s,;]+(?:19|20)\d{2}[a-z]?)*\s*\))/gu;

// x_1, a^2, H_2, b^{n+1}; only an identifier followed by a script counts.
const SCRIPT = /(?<![\p{L}\p{N}])[\p{L}][\p{L}\p{N}]*(?:\s*[_^]\s*(?:\{[^{}\n]*\}|[\p{L}\p{N}]+))+/gu;
// ASCII only: an all-caps heading in a non-Latin script stays translatable.
const CAPS = /(?<![\p{L}\p{N}])[A-Z][A-Z0-9]*(?:[-_/][A-Z0-9]+)*(?![\p{L}\p{N}])/gu;
// `accept` keeps the rule to identifier-shaped runs: long all-caps words are
// headings (ABSTRACT, INTRODUCTION) and must stay translatable.
const CAPS_ACCEPT = (value: string): boolean => value.length <= 12 && (/\d|[^\p{L}\p{N}]/u.test(value) || value.length <= 6);

const DATE_ISO = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/gu;
const DATE_SLASH = /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/gu;
const TIME = /\b\d{1,2}:\d{2}(?::\d{2})?(?![\p{L}\p{N}])/gu;
// Grouped serial numbers and phone numbers: 978-3-16-148410-0, 555-123-4567.
const SERIAL = /(?<![\p{L}\p{N}])\d+(?:-\d+){2,}(?![\p{L}\p{N}])/gu;

// One number: grouped thousands (1,234.56 / 1.234,56), plain digits, decimals
// with either separator, and an optional percent sign. Ordinals like "5th"
// stay whole so the suffix cannot be translated away from its digit.
const NUM = String.raw`\d{1,3}(?:[.,\u00A0\u202F\u2009]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const RANGE = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${NUM})\s*(?:[–—−~]|\.{2,3}|-)\s*(?:${NUM})(?![%‰])`, 'gu');
const NUMBER = new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${NUM})(?:st|nd|rd|th)?(?:\s?[%‰])?(?![\p{L}])`, 'giu');

interface Rule {
  kind: ProtectedKind;
  pattern: RegExp;
  /** Drop sentence punctuation a URL or path pattern swallowed. */
  trim?: boolean;
  minLength?: number;
  /** Reject a match the pattern cannot tell apart from ordinary prose. */
  accept?: (value: string) => boolean;
}

const RULES: readonly Rule[] = [
  { kind: 'code', pattern: FENCED_CODE },
  { kind: 'code', pattern: INLINE_CODE },
  { kind: 'formula', pattern: LATEX_DISPLAY },
  { kind: 'formula', pattern: LATEX_INLINE },
  { kind: 'formula', pattern: DOLLAR_DISPLAY },
  { kind: 'formula', pattern: DOLLAR_INLINE },
  { kind: 'email', pattern: EMAIL },
  { kind: 'url', pattern: URL, trim: true },
  { kind: 'path', pattern: WINDOWS_PATH, trim: true },
  { kind: 'path', pattern: UNIX_PATH, trim: true },
  { kind: 'path', pattern: FILENAME },
  { kind: 'hash', pattern: UUID },
  { kind: 'hash', pattern: HASH },
  { kind: 'citation', pattern: CITATION_BRACKET },
  { kind: 'citation', pattern: CITATION_NARRATIVE },
  { kind: 'citation', pattern: CITATION_PAREN },
  { kind: 'formula', pattern: SCRIPT },
  { kind: 'identifier', pattern: CAPS, minLength: 2, accept: CAPS_ACCEPT },
  { kind: 'date', pattern: DATE_ISO },
  { kind: 'date', pattern: DATE_SLASH },
  { kind: 'date', pattern: TIME },
  { kind: 'number', pattern: SERIAL },
  { kind: 'range', pattern: RANGE },
  { kind: 'number', pattern: NUMBER },
];

const TRAILING_PUNCTUATION = '.,;:!?…"\'”’»';

/** Trims sentence punctuation, keeping a bracket that balances inside the token. */
function trimTrailing(text: string, start: number, end: number): number {
  let stop = end;
  while (stop > start && TRAILING_PUNCTUATION.includes(text.charAt(stop - 1))) stop -= 1;
  for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
    while (stop > start && text.charAt(stop - 1) === close) {
      const slice = text.slice(start, stop);
      if (slice.split(close).length - 1 <= slice.split(open).length - 1) break;
      stop -= 1;
    }
  }
  return stop;
}

interface Span {
  start: number;
  end: number;
  kind: ProtectedKind;
}

/**
 * Collects non-overlapping spans. One byte per code unit marks claimed spans,
 * so a number inside a URL, or a year inside a citation, can never become a
 * second token.
 */
function collectSpans(text: string): Span[] {
  const claimed = new Uint8Array(text.length);
  const spans: Span[] = [];
  const reserve = (start: number, end: number): boolean => {
    if (end <= start || end > text.length) return false;
    for (let i = start; i < end; i += 1) if (claimed[i] === 1) return false;
    for (let i = start; i < end; i += 1) claimed[i] = 1;
    return true;
  };
  // Placeholders already in the text are left alone, so masking twice is safe
  // and a marker number is never masked as a number.
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const start = match.index ?? 0;
    reserve(start, start + match[0].length);
  }
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const start = match.index ?? 0;
      const end = rule.trim ? trimTrailing(text, start, start + match[0].length) : start + match[0].length;
      if (end - start < (rule.minLength ?? 1)) continue;
      if (rule.accept && !rule.accept(text.slice(start, end))) continue;
      if (reserve(start, end)) spans.push({ start, end, kind: rule.kind });
    }
  }
  return spans;
}

/**
 * Replaces every locked token with `⟦n⟧`, numbered from 1 in reading order.
 *
 * Repeated source values get distinct numbers, so each placeholder maps back to
 * exactly one span and a dropped occurrence is visible. Empty input is a no-op.
 */
export function mask(text: string): MaskResult {
  if (text === '') return { masked: '', tokens: [] };
  const spans = collectSpans(text).sort((a, b) => a.start - b.start);
  if (spans.length === 0) return { masked: text, tokens: [] };
  const tokens: ProtectedToken[] = [];
  let masked = '';
  let cursor = 0;
  for (const span of spans) {
    const index = tokens.length + 1;
    masked += text.slice(cursor, span.start) + placeholderFor(index);
    tokens.push({ index, value: text.slice(span.start, span.end), kind: span.kind });
    cursor = span.end;
  }
  return { masked: masked + text.slice(cursor), tokens };
}

/**
 * Puts the tokens back into a translated answer.
 *
 * A placeholder the translator dropped is reported in `missing`; one it emitted
 * twice is reported in `duplicated` and only its first occurrence is replaced,
 * so no extra marker is swallowed. Unpaired markers stay visible in `text`
 * rather than disappearing, which makes the failure obvious in the UI.
 */
export function restore(translated: string, tokens: readonly ProtectedToken[]): RestoreResult {
  const values = new Map<number, string>();
  for (const token of tokens) if (!values.has(token.index)) values.set(token.index, token.value);
  const seen = new Map<number, number>();
  let text = '';
  let cursor = 0;
  for (const match of translated.matchAll(PLACEHOLDER_PATTERN)) {
    const raw = match[1] ?? '';
    const index = Number.parseInt(raw, 10);
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const count = (seen.get(index) ?? 0) + 1;
    seen.set(index, count);
    const value = values.get(index);
    text += translated.slice(cursor, start);
    text += value === undefined || count > 1 ? match[0] : value;
    cursor = end;
  }
  text += translated.slice(cursor);
  const missing: number[] = [];
  const duplicated: number[] = [];
  for (const token of tokens) {
    const count = seen.get(token.index) ?? 0;
    if (count === 0) missing.push(token.index);
    else if (count > 1) duplicated.push(token.index);
  }
  return { text, missing, duplicated };
}
