/**
 * OCR anomaly and consistency verification (backlog F13).
 *
 * Recognised text from scanned PDFs and screenshots routinely introduces silent
 * high-risk corruptions: digits swapped with lookalike letters (`0/O`, `1/l/I`,
 * `5/S`, `8/B`), decimal and thousand separators flipped across lines, impossible
 * or contradictory dates, corrupted or mismatched units, and table columns that no
 * longer add up to their stated totals.
 *
 * This module inspects plain text, block lists (including `DocumentIR` blocks),
 * and parsed tables, returning flagged spans with machine-readable reasons,
 * severity (`'error' | 'warn'`), context excerpts, and optional suggestions.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no network, no I/O.
 * - Spans use 0-based UTF-16 code unit offsets (`text.slice(start, end) === value`).
 * - Multiple findings on the exact same span merge into one finding with combined
 *   `reasons`, elevating severity to `'error'` when any finding is an error.
 * - Reuses `checkArithmetic`, `parseTableNumber`, and label constants from
 *   `table-qa.ts` so OCR table checks never disagree with table QA.
 */

import {
  COUNT_ROW_LABELS,
  PERCENT_COLUMN_LABELS,
  TOTAL_ROW_LABELS,
  checkArithmetic,
  parseTableNumber,
  type ArithmeticOptions,
  type TableQaInput,
} from './table-qa';

// --- Public shape ----------------------------------------------------------

export type OcrFindingKind =
  | 'glyph-confusion'
  | 'number-format'
  | 'number-contradiction'
  | 'date'
  | 'unit'
  | 'table-arithmetic';

export type OcrSeverity = 'error' | 'warn';

export type OcrReasonCode =
  | 'glyph-0-o'
  | 'glyph-1-l-i'
  | 'glyph-5-s'
  | 'glyph-8-b'
  | 'malformed-number-separator'
  | 'mixed-decimal-separators'
  | 'ambiguous-number-separator'
  | 'contradictory-number'
  | 'invalid-date'
  | 'implausible-date'
  | 'mixed-date-format'
  | 'ambiguous-date-order'
  | 'reversed-date-range'
  | 'contradictory-date'
  | 'corrupted-unit'
  | 'mixed-column-units'
  | 'contradictory-unit'
  | 'column-sum-mismatch'
  | 'percentage-sum-mismatch'
  | 'row-count-mismatch'
  | 'empty-table'
  | 'low-ocr-confidence';

export interface OcrSpan {
  /** 0-based UTF-16 start offset inside the inspected text or cell. */
  start: number;
  /** 0-based exclusive UTF-16 end offset; `text.slice(start, end) === value` for text spans. */
  end: number;
  /** Exact text at the flagged span. */
  value: string;
  /** 1-based page number when known. */
  page?: number;
  /** Block identifier when inspecting block inputs or DocumentIR. */
  blockId?: string;
  /** 0-based grid row when inside a table (0 = header, 1+ = data/total). */
  row?: number;
  /** 0-based grid column when inside a table. */
  col?: number;
}

export interface OcrFinding {
  id: string;
  kind: OcrFindingKind;
  severity: OcrSeverity;
  /** True when the span poses a high verification risk requiring human review. */
  highRisk: boolean;
  /** Machine-readable reason codes explaining why the span was flagged. */
  reasons: OcrReasonCode[];
  /** Plain-English explanation without markup. */
  detail: string;
  span: OcrSpan;
  /** Context excerpt around the span, matching `qa.ts`. */
  excerpt: string;
  /** Optional disambiguation candidates for reviewer guidance. */
  suggestions?: string[];
}

export interface OcrBlockInput {
  id?: string;
  page?: number;
  text?: string;
  /** Compatibility with `DocumentIR` `Block.raw`. */
  raw?: string;
  confidence?: number;
}

export interface OcrVerifyInput {
  text?: string;
  blocks?: readonly OcrBlockInput[];
  tables?: readonly TableQaInput[];
}

export interface OcrVerifyOptions {
  /** Expected decimal separator convention if known (`'dot'` = `1,234.56`, `'comma'` = `1.234,56`). */
  expectedDecimalSeparator?: 'dot' | 'comma';
  /** Expected numeric date order if known (`'dmy'` = `DD/MM/YYYY`, `'mdy'` = `MM/DD/YYYY`). */
  expectedDateOrder?: 'dmy' | 'mdy';
  /** Minimum plausible calendar year (inclusive). Defaults to 1900. */
  minYear?: number;
  /** Maximum plausible calendar year (inclusive). Defaults to 2100. */
  maxYear?: number;
  /** Flag blocks whose OCR confidence falls below this floor (0..1). */
  minConfidence?: number;
  /** Forwarded to `checkArithmetic` for table verification. */
  tableOptions?: ArithmeticOptions;
}

export interface OcrVerificationSummary {
  total: number;
  errors: number;
  warnings: number;
  highRisk: number;
}

export interface OcrVerificationReport {
  /** True when no finding has severity `'error'`. */
  ok: boolean;
  /** True when at least one high-risk span requires human review. */
  needsReview: boolean;
  findings: OcrFinding[];
  highRiskSpans: OcrFinding[];
  summary: OcrVerificationSummary;
}

export type OcrVerifyErrorCode = 'invalid-input' | 'invalid-option';

export class OcrVerifyError extends Error {
  readonly code: OcrVerifyErrorCode;
  readonly path: string;

  constructor(code: OcrVerifyErrorCode, message: string, path = '') {
    super(path ? `${path}: ${message}` : message);
    this.name = 'OcrVerifyError';
    this.code = code;
    this.path = path;
  }
}

// --- Constants -------------------------------------------------------------

const DEFAULT_MIN_YEAR = 1900;
const DEFAULT_MAX_YEAR = 2100;
const EXCERPT_RADIUS = 28;
const SUM_EPSILON = 1e-6;

const KIND_RANK: Readonly<Record<OcrFindingKind, number>> = {
  'table-arithmetic': 0,
  'glyph-confusion': 1,
  date: 2,
  unit: 3,
  'number-format': 4,
  'number-contradiction': 5,
};

const HIGH_RISK_REASONS: ReadonlySet<OcrReasonCode> = new Set([
  'glyph-0-o',
  'glyph-1-l-i',
  'glyph-5-s',
  'glyph-8-b',
  'malformed-number-separator',
  'mixed-decimal-separators',
  'ambiguous-number-separator',
  'contradictory-number',
  'invalid-date',
  'implausible-date',
  'mixed-date-format',
  'ambiguous-date-order',
  'reversed-date-range',
  'contradictory-date',
  'corrupted-unit',
  'mixed-column-units',
  'contradictory-unit',
  'column-sum-mismatch',
  'percentage-sum-mismatch',
  'row-count-mismatch',
  'empty-table',
  'low-ocr-confidence',
]);

const CURRENCY_SYMBOL_BEFORE = /[$€£¥₩₹₽₫₴₺₦₱฿¢]/u;
const CURRENCY_SYMBOL_RE = /[$€£¥₩₹₽₫₴₺₦₱฿¢]/gu;
const CURRENCY_CODE_SET = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'VND', 'CHF', 'CNY', 'AUD', 'CAD', 'INR', 'KRW',
  'RUB', 'THB', 'SGD', 'HKD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'BRL', 'MXN',
  'ZAR', 'NGN', 'UAH', 'TRY', 'PHP', 'IDR', 'MYR',
]);

const UNIT_DIMENSION_ALIASES: Readonly<Record<string, string>> = {
  kg: 'kg',
  g: 'g',
  mg: 'mg',
  km: 'km',
  m: 'm',
  cm: 'cm',
  mm: 'mm',
  l: 'l',
  ml: 'ml',
  lb: 'lb',
  lbs: 'lb',
  oz: 'oz',
  '%': '%',
  '％': '%',
  '‰': '‰',
  $: '$',
  '€': '€',
  '£': '£',
  '¥': '¥',
  '₫': '₫',
  '₹': '₹',
  '₩': '₩',
  usd: 'USD',
  eur: 'EUR',
  gbp: 'GBP',
  vnd: 'VND',
  jpy: 'JPY',
  cny: 'CNY',
  chf: 'CHF',
  aud: 'AUD',
  cad: 'CAD',
  sgd: 'SGD',
};

/** Labels that represent pagination or structure rather than contradictory metric values. */
const STRUCTURAL_LABEL_STOPWORDS = new Set([
  'page', 'pages', 'trang', 'item', 'items', 'row', 'rows', 'line', 'lines',
  'step', 'part', 'section', 'chapter', 'figure', 'fig', 'table', 'date',
  'mục', 'muc', 'chương', 'chuong', 'hình', 'hinh', 'bảng', 'bang', 'phần', 'phan',
  'col', 'column', 'appendix', 'annex', 'note', 'ref', 'no',
]);

const ENGLISH_MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const VALID_UNIT_SUFFIXES = new Set([
  's', 'ms', 'ns', 'us', 'm', 'cm', 'mm', 'km', 'g', 'kg', 'mg', 'l', 'ml', 'cl', 'dl',
  'b', 'kb', 'mb', 'gb', 'tb', 'pb', 'hz', 'khz', 'mhz', 'ghz', 'w', 'kw', 'mw',
  'v', 'kv', 'a', 'ma', 'px', 'pt', 'em', 'rem', 'dpi', 'fps', 'yr', 'yrs', 'mo', 'mos',
  'wk', 'wks', 'hr', 'hrs', 'min', 'mins', 'sec', 'secs', 'usd', 'eur', 'gbp', 'vnd', 'jpy', 'cny',
]);

const KNOWN_TECHNICAL_SUFFIX_DIGITS = new Set([
  'sha1', 'utf8', 'md5', 'es5', 'ps5', 'tls1', 'pop3', 'bzip2', 'sqlite3',
  'python3', 'html5', 'css3', 'http2', 'ipv4', 'ipv6', 'base64', 'win11', 'arm64',
]);

const LEADING_DIGIT_UNIT_STEMS =
  /^(?:year|month|week|day|hour|min|sec|page|line|part|step|item|byte|bit|gram|inch|mile|foot|feet|yard|row|col|fold|pack|box|lot|unit|case)s?$/iu;

const MISSING_CELL = /^(?:-|–|—|n\/a|na|nil|none|null|\.{2,}|…|\?)$/iu;

// --- Internal normalized options & segments --------------------------------

interface NormalizedOptions {
  expectedDecimalSeparator?: 'dot' | 'comma';
  expectedDateOrder?: 'dmy' | 'mdy';
  minYear: number;
  maxYear: number;
  minConfidence?: number;
  tableOptions: ArithmeticOptions;
}

interface Segment {
  text: string;
  order: number;
  page?: number;
  blockId?: string;
  row?: number;
  col?: number;
  confidence?: number;
}

interface RawFinding {
  kind: OcrFindingKind;
  severity: OcrSeverity;
  reasons: OcrReasonCode[];
  detail: string;
  span: OcrSpan;
  excerpt: string;
  suggestions: string[];
  order: number;
}

interface ParsedNumberInfo {
  raw: string;
  start: number;
  end: number;
  style: 'plain' | 'dot-decimal' | 'comma-decimal' | 'ambiguous-dot-3' | 'ambiguous-comma-3' | 'malformed';
  value: number | null;
  unit: string | null;
}

interface ParsedDateInfo {
  raw: string;
  start: number;
  end: number;
  order: number;
  page?: number;
  blockId?: string;
  row?: number;
  col?: number;
  year: number;
  month: number | null;
  day: number | null;
  inferredOrder: 'iso' | 'named' | 'dmy' | 'mdy' | 'ambiguous' | 'invalid';
  isoDate: string | null;
  altIsoDate?: string | null;
  valid: boolean;
  invalidDetail?: string;
}

interface LabeledClaim {
  label: string;
  kind: 'number' | 'date' | 'unit';
  canonical: string;
  unit?: string;
  raw: string;
  start: number;
  end: number;
  order: number;
  page?: number;
  blockId?: string;
  row?: number;
  col?: number;
  text: string;
}

// --- Public entrypoints ----------------------------------------------------

/**
 * Verifies OCR output: plain text, block lists (`DocumentIR` compatible), and/or tables.
 */
export function verifyOcr(
  input: string | OcrVerifyInput,
  options: OcrVerifyOptions = {},
): OcrVerificationReport {
  const opts = validateOptions(options);
  if (typeof input === 'string') {
    return verifySegments([{ text: input, order: 0 }], [], opts);
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new OcrVerifyError('invalid-input', 'verifyOcr expects a string or an OcrVerifyInput object.', 'input');
  }

  const segments: Segment[] = [];
  let order = 0;

  if (input.text !== undefined) {
    if (typeof input.text !== 'string') {
      throw new OcrVerifyError('invalid-input', 'input.text must be a string when present.', 'text');
    }
    if (input.text.trim().length > 0) {
      segments.push({ text: input.text, order });
      order += 1;
    }
  }

  if (input.blocks !== undefined) {
    if (!Array.isArray(input.blocks)) {
      throw new OcrVerifyError('invalid-input', 'input.blocks must be an array when present.', 'blocks');
    }
    const prepared = prepareBlocks(input.blocks, order);
    for (const seg of prepared) segments.push(seg);
    order += prepared.length;
  }

  const tables: TableQaInput[] = [];
  if (input.tables !== undefined) {
    if (!Array.isArray(input.tables)) {
      throw new OcrVerifyError('invalid-input', 'input.tables must be an array when present.', 'tables');
    }
    for (const table of input.tables) tables.push(table);
  }

  return verifySegments(segments, tables, opts);
}

/** Verifies a single plain OCR string. */
export function verifyOcrText(text: string, options: OcrVerifyOptions = {}): OcrVerificationReport {
  if (typeof text !== 'string') {
    throw new OcrVerifyError('invalid-input', 'verifyOcrText expects a string.', 'text');
  }
  return verifyOcr(text, options);
}

/** Verifies one parsed OCR table: cells, column units/separators, and arithmetic sums. */
export function verifyOcrTable(table: TableQaInput, options: OcrVerifyOptions = {}): OcrVerificationReport {
  const opts = validateOptions(options);
  if (typeof table !== 'object' || table === null || Array.isArray(table)) {
    throw new OcrVerifyError('invalid-input', 'verifyOcrTable expects a table object.', 'table');
  }
  return verifySegments([], [table], opts);
}

// --- Option & input preparation --------------------------------------------

function validateOptions(options: OcrVerifyOptions): NormalizedOptions {
  if (options === undefined) {
    return { minYear: DEFAULT_MIN_YEAR, maxYear: DEFAULT_MAX_YEAR, tableOptions: {} };
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new OcrVerifyError('invalid-option', 'options must be an object.', 'options');
  }

  const expectedDecimalSeparator = options.expectedDecimalSeparator;
  if (
    expectedDecimalSeparator !== undefined &&
    expectedDecimalSeparator !== 'dot' &&
    expectedDecimalSeparator !== 'comma'
  ) {
    throw new OcrVerifyError(
      'invalid-option',
      'expectedDecimalSeparator must be "dot" or "comma".',
      'expectedDecimalSeparator',
    );
  }

  const expectedDateOrder = options.expectedDateOrder;
  if (expectedDateOrder !== undefined && expectedDateOrder !== 'dmy' && expectedDateOrder !== 'mdy') {
    throw new OcrVerifyError('invalid-option', 'expectedDateOrder must be "dmy" or "mdy".', 'expectedDateOrder');
  }

  const minYear = options.minYear ?? DEFAULT_MIN_YEAR;
  const maxYear = options.maxYear ?? DEFAULT_MAX_YEAR;
  if (!Number.isInteger(minYear) || minYear < 1) {
    throw new OcrVerifyError('invalid-option', 'minYear must be a positive integer.', 'minYear');
  }
  if (!Number.isInteger(maxYear) || maxYear < minYear) {
    throw new OcrVerifyError('invalid-option', 'maxYear must be an integer >= minYear.', 'maxYear');
  }

  const minConfidence = options.minConfidence;
  if (
    minConfidence !== undefined &&
    (typeof minConfidence !== 'number' || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1)
  ) {
    throw new OcrVerifyError('invalid-option', 'minConfidence must be a number in [0, 1].', 'minConfidence');
  }

  return {
    ...(expectedDecimalSeparator !== undefined ? { expectedDecimalSeparator } : {}),
    ...(expectedDateOrder !== undefined ? { expectedDateOrder } : {}),
    minYear,
    maxYear,
    ...(minConfidence !== undefined ? { minConfidence } : {}),
    tableOptions: options.tableOptions ?? {},
  };
}

function prepareBlocks(blocks: readonly OcrBlockInput[], startOrder: number): Segment[] {
  const prepared: Segment[] = [];
  blocks.forEach((block, index) => {
    if (typeof block !== 'object' || block === null) return;
    const text = typeof block.raw === 'string' ? block.raw : typeof block.text === 'string' ? block.text : '';
    const page = typeof block.page === 'number' && Number.isInteger(block.page) && block.page >= 1
      ? block.page
      : undefined;
    const blockId = typeof block.id === 'string' && block.id.length > 0 ? block.id : undefined;
    const confidence = typeof block.confidence === 'number' && Number.isFinite(block.confidence)
      ? block.confidence
      : undefined;
    prepared.push({
      text,
      order: startOrder + index,
      ...(page !== undefined ? { page } : {}),
      ...(blockId !== undefined ? { blockId } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
    });
  });

  // Sort blocks deterministically by page ascending then original index so cross-block
  // reporting order does not depend on unordered input order.
  prepared.sort((left, right) => (left.page ?? 0) - (right.page ?? 0) || left.order - right.order);
  prepared.forEach((seg, idx) => {
    seg.order = startOrder + idx;
  });
  return prepared;
}

// --- Core verification orchestration ---------------------------------------

function verifySegments(
  segments: readonly Segment[],
  tables: readonly TableQaInput[],
  opts: NormalizedOptions,
): OcrVerificationReport {
  const raw: RawFinding[] = [];
  const allNumbers: { seg: Segment; info: ParsedNumberInfo }[] = [];
  const allDates: ParsedDateInfo[] = [];
  const allClaims: LabeledClaim[] = [];

  for (const seg of segments) {
    if (opts.minConfidence !== undefined && seg.confidence !== undefined && seg.confidence < opts.minConfidence) {
      raw.push({
        kind: 'glyph-confusion',
        severity: 'warn',
        reasons: ['low-ocr-confidence'],
        detail: `OCR block confidence ${seg.confidence.toFixed(2)} is below threshold ${opts.minConfidence.toFixed(2)}.`,
        span: makeSpan(seg, 0, seg.text.length, seg.text),
        excerpt: makeExcerpt(seg.text, 0, seg.text.length),
        suggestions: [],
        order: seg.order,
      });
    }

    if (seg.text.trim() === '') continue;

    checkGlyphConfusions(seg, raw);
    const numbers = checkNumbersInSegment(seg, raw);
    for (const info of numbers) allNumbers.push({ seg, info });

    const dates = checkDatesInSegment(seg, opts, raw);
    for (const date of dates) allDates.push(date);

    checkUnitsInSegment(seg, raw);
    checkInlineDateRanges(seg, dates, raw);
    collectLabeledClaims(seg, dates, allClaims);
  }

  checkDocumentNumberConventions(allNumbers, opts, raw);
  checkDocumentDateConventions(allDates, opts, segments, raw);
  checkDocumentDatePairs(allDates, segments, raw);
  checkLabeledContradictions(allClaims, raw);

  tables.forEach((table, tableIndex) => {
    verifySingleTable(table, tableIndex, segments.length + tableIndex * 1000, opts, raw);
  });

  return buildReport(raw);
}

// --- Glyph confusion detection ---------------------------------------------

const TOKEN_RE = /(?<![\p{L}\p{N}])[+-]?[\p{L}\p{N}]+(?:[.,\/\-:][\p{L}\p{N}]+)*(?![\p{L}\p{N}])/gu;

const CONFUSABLE_LETTER_TO_DIGIT: Readonly<Record<string, { digit: string; reason: OcrReasonCode }>> = {
  O: { digit: '0', reason: 'glyph-0-o' },
  o: { digit: '0', reason: 'glyph-0-o' },
  l: { digit: '1', reason: 'glyph-1-l-i' },
  I: { digit: '1', reason: 'glyph-1-l-i' },
  S: { digit: '5', reason: 'glyph-5-s' },
  B: { digit: '8', reason: 'glyph-8-b' },
};

const CONFUSABLE_DIGIT_TO_LETTER: Readonly<Record<string, { chars: readonly string[]; reason: OcrReasonCode }>> = {
  '0': { chars: ['o', 'O'], reason: 'glyph-0-o' },
  '1': { chars: ['i', 'l', 'I'], reason: 'glyph-1-l-i' },
  '5': { chars: ['s', 'S'], reason: 'glyph-5-s' },
  '8': { chars: ['b', 'B'], reason: 'glyph-8-b' },
};

function checkGlyphConfusions(seg: Segment, out: RawFinding[], inNumericColumn = false): void {
  const text = seg.text;
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];
    const start = match.index ?? 0;
    const end = start + token.length;
    const prevChar = start > 0 ? text.charAt(start - 1) : '';
    const nextChar = end < text.length ? text.charAt(end) : '';

    if (isExemptToken(token, prevChar, nextChar, inNumericColumn)) continue;

    // 1. Digits mixed with confusable letters in a numeric/date-like token.
    if (looksLikeNumericGlyphConfusion(token, prevChar, nextChar, inNumericColumn)) {
      const reasons = new Set<OcrReasonCode>();
      let suggestion = '';
      for (let idx = 0; idx < token.length; idx += 1) {
        const ch = token.charAt(idx);
        const mapped = CONFUSABLE_LETTER_TO_DIGIT[ch];
        if (mapped && shouldReplaceLetterInNumeric(token, idx, prevChar, nextChar, inNumericColumn)) {
          reasons.add(mapped.reason);
          suggestion += mapped.digit;
        } else {
          suggestion += ch;
        }
      }
      if (reasons.size > 0) {
        const reasonList = [...reasons];
        const numericLike = !token.includes('-') && !token.includes('/');
        const severity: OcrSeverity =
          numericLike || inNumericColumn || CURRENCY_SYMBOL_BEFORE.test(prevChar) || nextChar === '%' || nextChar === '‰'
            ? 'error'
            : 'error';
        out.push({
          kind: 'glyph-confusion',
          severity,
          reasons: reasonList,
          detail: `Token "${token}" mixes digits and confusable glyph(s) (${reasonList.join(', ')}); possible OCR reading "${suggestion}".`,
          span: makeSpan(seg, start, end, token),
          excerpt: makeExcerpt(text, start, token.length),
          suggestions: suggestion !== token ? [suggestion] : [],
          order: seg.order,
        });
        continue;
      }
    }

    // 2. Digits embedded inside alphabetic words (letter -> digit OCR error).
    const wordCheck = checkWordEmbeddedDigits(token);
    if (wordCheck !== null) {
      out.push({
        kind: 'glyph-confusion',
        severity: 'warn',
        reasons: wordCheck.reasons,
        detail: `Word "${token}" contains confusable digit(s) (${wordCheck.reasons.join(', ')}); possible OCR reading "${wordCheck.suggestions[0] ?? token}".`,
        span: makeSpan(seg, start, end, token),
        excerpt: makeExcerpt(text, start, token.length),
        suggestions: wordCheck.suggestions,
        order: seg.order,
      });
    }
  }
}

function isExemptToken(token: string, prevChar: string, nextChar: string, inNumericColumn: boolean): boolean {
  if (/^0x[0-9a-f]+$/iu.test(token)) return true;
  if (/^\d+(?:st|nd|rd|th)$/iu.test(token)) return true;
  if (KNOWN_TECHNICAL_SUFFIX_DIGITS.has(token.toLowerCase())) return true;
  if (/^[+-]?\d+(?:[.,]\d+)?$/u.test(token)) return true;

  // `$` misread as `S` before a formatted money figure like `S1,250.00` or `S49.99`
  // is handled as a `corrupted-unit`, not a `5/S` digit confusion.
  if (isCurrencySFormattedAmount(token, prevChar)) return true;

  // Corrupted currency/unit codes (`U5D`, `VNO`, `m1`, `1b`) are reported by the unit checker.
  if (isCorruptedUnitToken(token)) return true;

  // Alphanumeric standard/model codes unless inside a numeric table column:
  // e.g., `B52`, `F13`, `E04`, `S10`, `ISO9001`, `O2`, `CO2`, `H2O`.
  if (!inNumericColumn && !CURRENCY_SYMBOL_BEFORE.test(prevChar) && nextChar !== '%' && nextChar !== '‰') {
    if (/^[A-Z]{1,5}[1-9]\d{0,3}$/u.test(token)) return true;
    if (/^[A-Z]{2,5}0\d{1,2}$/u.test(token)) return true;
    if (/^[A-Z]\d+[A-Z]$/u.test(token)) return true; // e.g. B2B, P2P, O2? No, O2 is ^[A-Z]\d$
    if (/^O\d$/u.test(token)) return true; // O2
  }

  // Valid number + short unit (e.g. 15s, 5l, 8GB, 100kg, $5B).
  const unitSuffixMatch = /^([+-]?\d+(?:[.,]\d+)?)([A-Za-z]+)$/u.exec(token);
  if (unitSuffixMatch) {
    const suffix = (unitSuffixMatch[2] ?? '').toLowerCase();
    if (VALID_UNIT_SUFFIXES.has(suffix)) return true;
    if (unitSuffixMatch[2] === 'B' && prevChar !== '' && CURRENCY_SYMBOL_BEFORE.test(prevChar)) return true;
    if (unitSuffixMatch[2] === 'B' && /^[+-]?\d+(?:\.\d+)?B$/u.test(token) && !inNumericColumn) return true;
  }

  return false;
}

function isCurrencySFormattedAmount(token: string, prevChar: string): boolean {
  if (CURRENCY_SYMBOL_BEFORE.test(prevChar)) return false;
  return /^S[1-9]\d{0,2}(?:,\d{3})+(?:\.\d{1,2})?$/u.test(token) || /^S[1-9]\d*\.\d{2}$/u.test(token);
}

function looksLikeNumericGlyphConfusion(
  token: string,
  prevChar: string,
  nextChar: string,
  inNumericColumn: boolean,
): boolean {
  const hasDigit = /\d/u.test(token);
  const hasConfusable = /[OlISB]/u.test(token);
  if (!hasConfusable) return false;

  // Standalone single confusable letter right next to currency or percent, e.g., `$O`, `O%`, `l%`.
  if (!hasDigit && (CURRENCY_SYMBOL_BEFORE.test(prevChar) || nextChar === '%' || nextChar === '‰')) {
    return /^[OlISB](?:[.,]\d+)?$/u.test(token);
  }

  // Numeric-shaped token with only digits, separators, and confusable letters (no non-confusable letters).
  if (!/^[+-]?[\dOlISB.,\/\-:]+$/u.test(token)) return false;
  if (!hasDigit) {
    // e.g. `O.50` has digit after `.` (`hasDigit` would be true); without any digit it's just letters like `ISO`.
    return false;
  }

  // In a numeric column, any mix of digits and [OlISB] is suspicious.
  if (inNumericColumn) return true;

  // Date-like tokens containing confusable letters (`2O25-01-15`, `O5/12/2025`, `1l/02/2025`).
  if (/^[\dOlISB]{4}[-/.][\dOlISB]{1,2}[-/.][\dOlISB]{1,2}$/u.test(token)) return true;
  if (/^[\dOlISB]{1,2}[-/.][\dOlISB]{1,2}[-/.][\dOlISB]{4}$/u.test(token)) return true;

  // Flanked by digits (`1O0`, `1l0`, `5S0`, `8B0`).
  if (/\d[OlISB]\d/u.test(token)) return true;

  // Adjacent to decimal/thousand separator (`O.75`, `1,2O0`, `1,B00`, `12.5O`, `5S.00`, `B00.00`).
  if (/(?:[OlISB][.,]\d|\d[.,][OlISB]|\d[OlISB][.,]|[OlISB]\d+[.,]\d)/u.test(token)) return true;

  // Lowercase `l` or `o` immediately preceding digits or confusable digits (`l50`, `lO0`, `l00`, `o5`).
  if (/^[+-]?[lo][\dOlISB.,]*\d/u.test(token)) return true;

  // Preceded by currency (`$l00`, `$S0`) or followed by `%`/`‰` (`2O%`, `I00%`).
  if (CURRENCY_SYMBOL_BEFORE.test(prevChar) || nextChar === '%' || nextChar === '‰') return true;

  // Leading `I`/`S`/`B`/`O` followed by `00` or `,`+3 digits (`I,250`, `B00`, `S00`).
  if (/^[+-]?[OlISB](?:00+|,\d{3})/u.test(token)) return true;

  // Trailing confusable letter after >=1 digits and a non-initial separator or >=2 digits (`123O`, `2O`).
  if (/\d[OlISB]$/u.test(token) && (token.length >= 3 || /\d[.,]/u.test(token))) return true;

  return false;
}

function shouldReplaceLetterInNumeric(
  token: string,
  index: number,
  prevChar: string,
  nextChar: string,
  inNumericColumn: boolean,
): boolean {
  const ch = token.charAt(index);
  if (!(ch in CONFUSABLE_LETTER_TO_DIGIT)) return false;
  if (inNumericColumn || CURRENCY_SYMBOL_BEFORE.test(prevChar) || nextChar === '%' || nextChar === '‰') {
    return true;
  }
  const before = index > 0 ? token.charAt(index - 1) : '';
  const after = index + 1 < token.length ? token.charAt(index + 1) : '';
  return /[\dOlISB.,\-\/]/u.test(before) || /[\dOlISB.,\-\/]/u.test(after);
}

function checkWordEmbeddedDigits(
  token: string,
): { reasons: OcrReasonCode[]; suggestions: string[] } | null {
  if (/[.,\/\-:]/u.test(token)) return null;
  const hasInternal = /(?:\p{L}{2,}[0158]\p{Ll}+|\p{L}+[0158]\p{Ll}{2,})/u.test(token);
  const hasLeading = /^[0158]\p{Ll}{3,}$/u.test(token) && !LEADING_DIGIT_UNIT_STEMS.test(token.slice(1));
  const hasTrailing = /^\p{Ll}{3,}[0158]$/u.test(token);
  if (!hasInternal && !hasLeading && !hasTrailing) return null;

  const reasons = new Set<OcrReasonCode>();
  let primary = '';
  for (let idx = 0; idx < token.length; idx += 1) {
    const ch = token.charAt(idx);
    const prev = idx > 0 ? token.charAt(idx - 1) : '';
    const next = idx + 1 < token.length ? token.charAt(idx + 1) : '';
    const mapped = CONFUSABLE_DIGIT_TO_LETTER[ch];
    const adjacentLetter = /\p{L}/u.test(prev) || /\p{L}/u.test(next);
    if (mapped && adjacentLetter) {
      reasons.add(mapped.reason);
      const isInitial = idx === 0;
      const isAllUpper = /^\p{Lu}+$/u.test(token.replace(/[0158]/gu, ''));
      if (isInitial || isAllUpper) {
        // Prefer uppercase at start of capitalized token (`0ctober` -> `October`, `1nvoice` -> `Invoice`).
        const preferred = mapped.chars.find(c => c === c.toUpperCase()) ?? mapped.chars[0]!;
        primary += preferred;
      } else {
        primary += mapped.chars[0]!;
      }
    } else {
      primary += ch;
    }
  }

  if (reasons.size === 0) return null;
  return {
    reasons: [...reasons],
    suggestions: primary !== token ? [primary] : [],
  };
}

// --- Number format & separator checks --------------------------------------

const NUMBER_TOKEN_RE = /(?<![\p{L}\p{N}])[-−]?(\d+(?:[.,]+\d*)*)(?![\p{L}\p{N}])/gu;

function checkNumbersInSegment(seg: Segment, out: RawFinding[]): ParsedNumberInfo[] {
  const results: ParsedNumberInfo[] = [];
  const text = seg.text;

  for (const match of text.matchAll(NUMBER_TOKEN_RE)) {
    const rawCore = match[1] ?? '';
    const matchStart = match.index ?? 0;
    const matchText = match[0];

    // Strip a single trailing sentence period or clause comma (`Total is 123.` or `ISO 9001,`).
    let cleanCore = rawCore;
    let end = matchStart + matchText.length;
    if (/[.,]$/u.test(cleanCore) && !/[.,]{2}$/u.test(cleanCore)) {
      cleanCore = cleanCore.slice(0, -1);
      end -= 1;
    }
    if (cleanCore === '' || !/\d/u.test(cleanCore)) continue;

    // Skip date tokens like `2025.01.15` or `15.04.2025` (2 dots + 4-digit head or tail).
    if (isDotDateToken(cleanCore)) continue;
    // Skip bare version/section numbers like `1.2.3` unless currency is directly attached.
    const prevChar = matchStart > 0 ? text.charAt(matchStart - 1) : '';
    const hasCurrency = CURRENCY_SYMBOL_BEFORE.test(prevChar);
    if (!hasCurrency && /^\d+(?:\.\d+){2,}$/u.test(cleanCore) && !hasMalformedSeparatorShape(cleanCore)) {
      const parts = cleanCore.split('.');
      if (parts.every(p => p.length > 0 && p.length !== 3) || parts.length >= 4) continue;
    }

    const start = end - (matchText.startsWith('-') || matchText.startsWith('−') ? cleanCore.length + 1 : cleanCore.length);
    const fullRaw = text.slice(start, end);
    const unit = detectAttachedUnit(text, matchStart, end);

    if (hasMalformedSeparatorShape(cleanCore)) {
      out.push({
        kind: 'number-format',
        severity: 'error',
        reasons: ['malformed-number-separator'],
        detail: `Number "${fullRaw}" has malformed decimal or thousands separators.`,
        span: makeSpan(seg, start, end, fullRaw),
        excerpt: makeExcerpt(text, start, fullRaw.length),
        suggestions: [],
        order: seg.order,
      });
      results.push({ raw: fullRaw, start, end, style: 'malformed', value: null, unit });
      continue;
    }

    const classified = classifyNumberStyle(cleanCore, hasCurrency);
    const negative = matchText.startsWith('-') || matchText.startsWith('−');
    const signedValue =
      classified.value !== null && negative && classified.value !== 0 ? -classified.value : classified.value;
    results.push({
      raw: fullRaw,
      start,
      end,
      style: classified.style,
      value: signedValue,
      unit,
    });
  }

  return results;
}

function isDotDateToken(core: string): boolean {
  return /^(?:\d{4}\.\d{1,2}\.\d{1,2}|\d{1,2}\.\d{1,2}\.\d{4})$/u.test(core);
}

function hasMalformedSeparatorShape(core: string): boolean {
  // Consecutive or trailing/dangling separators (`1..50`, `1,,200`, `1,.50`, `1,`).
  if (/[.,]{2,}/u.test(core) || /[.,]$/u.test(core)) return true;

  const separators = [...core].filter(ch => ch === '.' || ch === ',');
  if (separators.length === 0) return false;

  const groups = core.split(/[.,]/u);
  const kinds = new Set(separators);

  if (kinds.size > 1) {
    // Mixed `,` and `.`: every separator must be the same up to the last one, and every
    // intermediate thousands group (index 1 .. length-2) must be 3 digits.
    const lastSep = separators[separators.length - 1];
    for (let i = 0; i < separators.length - 1; i += 1) {
      if (separators[i] !== separators[0] || separators[i] === lastSep) return true;
    }
    for (let i = 1; i < groups.length - 1; i += 1) {
      if ((groups[i] ?? '').length !== 3) return true;
    }
    if ((groups[0] ?? '').length > 3) return true;
    return false;
  }

  if (separators.length >= 2 && separators[0] === ',') {
    // Multiple commas: either every non-head group is 3 digits, or valid Indian grouping
    // (2-digit middle groups + 3-digit final group).
    const tail = groups[groups.length - 1] ?? '';
    if (tail.length !== 3) return true;
    const westernOk = groups.slice(1).every(g => g.length === 3) && (groups[0] ?? '').length <= 3;
    const indianOk = groups.slice(1, -1).every(g => g.length === 2) && (groups[0] ?? '').length <= 2;
    return !westernOk && !indianOk;
  }

  return false;
}

function classifyNumberStyle(
  core: string,
  hasCurrency: boolean,
): { style: ParsedNumberInfo['style']; value: number | null } {
  const separators = [...core].filter(ch => ch === '.' || ch === ',');
  if (separators.length === 0) {
    const value = Number(core);
    return { style: 'plain', value: Number.isFinite(value) ? value : null };
  }

  const groups = core.split(/[.,]/u);
  const kinds = new Set(separators);
  const head = groups[0] ?? '';
  const tail = groups[groups.length - 1] ?? '';

  if (kinds.size > 1) {
    const lastSep = separators[separators.length - 1];
    const intPart = groups.slice(0, -1).join('');
    const value = Number(`${intPart}.${tail}`);
    return {
      style: lastSep === '.' ? 'dot-decimal' : 'comma-decimal',
      value: Number.isFinite(value) ? value : null,
    };
  }

  const sep = separators[0]!;
  if (groups.length === 2) {
    if (tail.length === 3 && head.length <= 3 && !/^0/u.test(head)) {
      const value = Number(groups.join(''));
      return {
        style: sep === '.' ? 'ambiguous-dot-3' : 'ambiguous-comma-3',
        value: Number.isFinite(value) ? value : null,
      };
    }
    const value = Number(`${head}.${tail}`);
    return {
      style: sep === '.' ? 'dot-decimal' : 'comma-decimal',
      value: Number.isFinite(value) ? value : null,
    };
  }

  // >= 3 groups with one separator type and valid 3-digit grouping (`1,234,567`).
  if (tail.length === 3 && (sep === ',' || hasCurrency)) {
    const value = Number(groups.join(''));
    return {
      style: sep === ',' ? 'dot-decimal' : 'comma-decimal',
      value: Number.isFinite(value) ? value : null,
    };
  }

  return { style: 'plain', value: null };
}

function checkDocumentNumberConventions(
  numbers: readonly { seg: Segment; info: ParsedNumberInfo }[],
  opts: NormalizedOptions,
  out: RawFinding[],
): void {
  const dotExplicit = numbers.filter(item => item.info.style === 'dot-decimal');
  const commaExplicit = numbers.filter(item => item.info.style === 'comma-decimal');

  let dominant: 'dot' | 'comma' | null = opts.expectedDecimalSeparator ?? null;
  if (dominant === null && dotExplicit.length > 0 && commaExplicit.length > 0) {
    dominant = dotExplicit.length >= commaExplicit.length ? 'dot' : 'comma';
  } else if (dominant === null && dotExplicit.length > 0) {
    dominant = 'dot';
  } else if (dominant === null && commaExplicit.length > 0) {
    dominant = 'comma';
  }

  // Flag conflicting decimal styles when both dot-decimal and comma-decimal appear,
  // or when an explicit `expectedDecimalSeparator` is contradicted.
  if (opts.expectedDecimalSeparator !== undefined) {
    const conflicting = opts.expectedDecimalSeparator === 'dot' ? commaExplicit : dotExplicit;
    for (const item of conflicting) {
      pushSeparatorFinding(
        item.seg,
        item.info,
        'mixed-decimal-separators',
        'error',
        `Number "${item.info.raw}" uses ${item.info.style === 'comma-decimal' ? 'comma' : 'dot'} decimal style, conflicting with expected ${opts.expectedDecimalSeparator}-decimal convention.`,
        out,
      );
    }
  } else if (dotExplicit.length > 0 && commaExplicit.length > 0) {
    const flagged = dotExplicit.length >= commaExplicit.length ? commaExplicit : dotExplicit;
    for (const item of flagged) {
      pushSeparatorFinding(
        item.seg,
        item.info,
        'mixed-decimal-separators',
        'warn',
        `Number "${item.info.raw}" mixes decimal/thousand separator conventions with other numbers in the document.`,
        out,
      );
    }
  }

  // Flag ambiguous 3-digit separator (`1.250` under dot-decimal or `1,250` under comma-decimal).
  if (dominant === 'dot') {
    for (const item of numbers) {
      if (item.info.style === 'ambiguous-dot-3') {
        pushSeparatorFinding(
          item.seg,
          item.info,
          'ambiguous-number-separator',
          'warn',
          `Number "${item.info.raw}" uses "." with three trailing digits while the document uses "." as a decimal separator (ambiguous between 1.25 and 1250-style grouping).`,
          out,
        );
      }
    }
  } else if (dominant === 'comma') {
    for (const item of numbers) {
      if (item.info.style === 'ambiguous-comma-3') {
        pushSeparatorFinding(
          item.seg,
          item.info,
          'ambiguous-number-separator',
          'warn',
          `Number "${item.info.raw}" uses "," with three trailing digits while the document uses "," as a decimal separator.`,
          out,
        );
      }
    }
  }
}

function pushSeparatorFinding(
  seg: Segment,
  info: ParsedNumberInfo,
  reason: OcrReasonCode,
  severity: OcrSeverity,
  detail: string,
  out: RawFinding[],
): void {
  out.push({
    kind: 'number-format',
    severity,
    reasons: [reason],
    detail,
    span: makeSpan(seg, info.start, info.end, info.raw),
    excerpt: makeExcerpt(seg.text, info.start, info.raw.length),
    suggestions: [],
    order: seg.order,
  });
}

// --- Date checks & contradictions ------------------------------------------

const ISO_DATE_RE = /(?<![\p{L}\p{N}])([\dOlISB]{4})([-/.])([\dOlISB]{1,2})\2([\dOlISB]{1,2})(?![\p{L}\p{N}])/gu;
const DMY_MDY_DATE_RE = /(?<![\p{L}\p{N}])([\dOlISB]{1,2})([-/.])([\dOlISB]{1,2})\2([\dOlISB]{4})(?![\p{L}\p{N}])/gu;
const VIETNAMESE_DATE_RE = /\bngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})\s+năm\s+(\d{4})\b/giu;
const ENGLISH_MONTH_FIRST_RE =
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})\b/giu;
const ENGLISH_DAY_FIRST_RE =
  /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?),?\s+(\d{4})\b/giu;

function normalizeDatePart(part: string): number | null {
  let out = '';
  for (const ch of part) {
    if (ch >= '0' && ch <= '9') {
      out += ch;
    } else if (ch in CONFUSABLE_LETTER_TO_DIGIT) {
      out += CONFUSABLE_LETTER_TO_DIGIT[ch]!.digit;
    } else {
      return null;
    }
  }
  const num = Number.parseInt(out, 10);
  return Number.isFinite(num) ? num : null;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function formatIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function checkDatesInSegment(seg: Segment, opts: NormalizedOptions, out: RawFinding[]): ParsedDateInfo[] {
  const text = seg.text;
  const parsed: ParsedDateInfo[] = [];
  const claimedRanges: { start: number; end: number }[] = [];

  const overlapsClaimed = (start: number, end: number): boolean =>
    claimedRanges.some(range => start < range.end && end > range.start);

  const recordParsed = (entry: ParsedDateInfo): void => {
    claimedRanges.push({ start: entry.start, end: entry.end });
    parsed.push(entry);
    if (!entry.valid) {
      out.push({
        kind: 'date',
        severity: 'error',
        reasons: ['invalid-date'],
        detail: entry.invalidDetail ?? `Date "${entry.raw}" is not a valid calendar date.`,
        span: makeSpan(seg, entry.start, entry.end, entry.raw),
        excerpt: makeExcerpt(text, entry.start, entry.raw.length),
        suggestions: [],
        order: seg.order,
      });
    }
    if (entry.year < opts.minYear || entry.year > opts.maxYear) {
      out.push({
        kind: 'date',
        severity: 'warn',
        reasons: ['implausible-date'],
        detail: `Date "${entry.raw}" has year ${entry.year} outside expected range ${opts.minYear}..${opts.maxYear}.`,
        span: makeSpan(seg, entry.start, entry.end, entry.raw),
        excerpt: makeExcerpt(text, entry.start, entry.raw.length),
        suggestions: [],
        order: seg.order,
      });
    }
  };

  for (const match of text.matchAll(ISO_DATE_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const end = start + raw.length;
    if (overlapsClaimed(start, end)) continue;
    const year = normalizeDatePart(match[1] ?? '');
    const month = normalizeDatePart(match[3] ?? '');
    const day = normalizeDatePart(match[4] ?? '');
    if (year === null || month === null || day === null) continue;
    const valid = isValidCalendarDate(year, month, day);
    recordParsed({
      raw,
      start,
      end,
      order: seg.order,
      ...(seg.page !== undefined ? { page: seg.page } : {}),
      ...(seg.blockId !== undefined ? { blockId: seg.blockId } : {}),
      ...(seg.row !== undefined ? { row: seg.row } : {}),
      ...(seg.col !== undefined ? { col: seg.col } : {}),
      year,
      month,
      day,
      inferredOrder: valid ? 'iso' : 'invalid',
      isoDate: valid ? formatIso(year, month, day) : null,
      valid,
      ...(valid ? {} : { invalidDetail: `Date "${raw}" (${year}-${month}-${day}) is not a valid calendar date.` }),
    });
  }

  for (const match of text.matchAll(DMY_MDY_DATE_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const end = start + raw.length;
    if (overlapsClaimed(start, end)) continue;
    const first = normalizeDatePart(match[1] ?? '');
    const second = normalizeDatePart(match[3] ?? '');
    const year = normalizeDatePart(match[4] ?? '');
    if (first === null || second === null || year === null) continue;

    const dmyValid = isValidCalendarDate(year, second, first);
    const mdyValid = isValidCalendarDate(year, first, second);

    let inferredOrder: ParsedDateInfo['inferredOrder'] = 'invalid';
    let month: number | null = null;
    let day: number | null = null;
    let isoDate: string | null = null;
    let altIsoDate: string | null = null;

    if (dmyValid && mdyValid) {
      inferredOrder = first === second ? 'dmy' : 'ambiguous';
      day = first;
      month = second;
      isoDate = formatIso(year, second, first);
      altIsoDate = formatIso(year, first, second);
    } else if (dmyValid) {
      inferredOrder = 'dmy';
      day = first;
      month = second;
      isoDate = formatIso(year, second, first);
    } else if (mdyValid) {
      inferredOrder = 'mdy';
      month = first;
      day = second;
      isoDate = formatIso(year, first, second);
    }

    const valid = dmyValid || mdyValid;
    recordParsed({
      raw,
      start,
      end,
      order: seg.order,
      ...(seg.page !== undefined ? { page: seg.page } : {}),
      ...(seg.blockId !== undefined ? { blockId: seg.blockId } : {}),
      ...(seg.row !== undefined ? { row: seg.row } : {}),
      ...(seg.col !== undefined ? { col: seg.col } : {}),
      year,
      month,
      day,
      inferredOrder,
      isoDate,
      altIsoDate,
      valid,
      ...(valid ? {} : { invalidDetail: `Date "${raw}" is invalid under both DD/MM/YYYY and MM/DD/YYYY.` }),
    });
  }

  for (const match of text.matchAll(VIETNAMESE_DATE_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const end = start + raw.length;
    if (overlapsClaimed(start, end)) continue;
    const day = Number.parseInt(match[1] ?? '', 10);
    const month = Number.parseInt(match[2] ?? '', 10);
    const year = Number.parseInt(match[3] ?? '', 10);
    const valid = isValidCalendarDate(year, month, day);
    recordParsed({
      raw,
      start,
      end,
      order: seg.order,
      ...(seg.page !== undefined ? { page: seg.page } : {}),
      ...(seg.blockId !== undefined ? { blockId: seg.blockId } : {}),
      year,
      month,
      day,
      inferredOrder: valid ? 'named' : 'invalid',
      isoDate: valid ? formatIso(year, month, day) : null,
      valid,
      ...(valid ? {} : { invalidDetail: `Vietnamese date "${raw}" is not a valid calendar date.` }),
    });
  }

  for (const match of text.matchAll(ENGLISH_MONTH_FIRST_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const end = start + raw.length;
    if (overlapsClaimed(start, end)) continue;
    const month = ENGLISH_MONTHS[(match[1] ?? '').toLowerCase()] ?? 0;
    const day = Number.parseInt(match[2] ?? '', 10);
    const year = Number.parseInt(match[3] ?? '', 10);
    const valid = isValidCalendarDate(year, month, day);
    recordParsed({
      raw,
      start,
      end,
      order: seg.order,
      ...(seg.page !== undefined ? { page: seg.page } : {}),
      ...(seg.blockId !== undefined ? { blockId: seg.blockId } : {}),
      year,
      month,
      day,
      inferredOrder: valid ? 'named' : 'invalid',
      isoDate: valid ? formatIso(year, month, day) : null,
      valid,
    });
  }

  for (const match of text.matchAll(ENGLISH_DAY_FIRST_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const end = start + raw.length;
    if (overlapsClaimed(start, end)) continue;
    const day = Number.parseInt(match[1] ?? '', 10);
    const month = ENGLISH_MONTHS[(match[2] ?? '').toLowerCase()] ?? 0;
    const year = Number.parseInt(match[3] ?? '', 10);
    const valid = isValidCalendarDate(year, month, day);
    recordParsed({
      raw,
      start,
      end,
      order: seg.order,
      ...(seg.page !== undefined ? { page: seg.page } : {}),
      ...(seg.blockId !== undefined ? { blockId: seg.blockId } : {}),
      year,
      month,
      day,
      inferredOrder: valid ? 'named' : 'invalid',
      isoDate: valid ? formatIso(year, month, day) : null,
      valid,
    });
  }

  return parsed.sort((left, right) => left.start - right.start);
}

function checkDocumentDateConventions(
  dates: readonly ParsedDateInfo[],
  opts: NormalizedOptions,
  segments: readonly Segment[],
  out: RawFinding[],
): void {
  const segmentByOrder = new Map(segments.map(seg => [seg.order, seg]));
  const dmyDates = dates.filter(d => d.inferredOrder === 'dmy' && !d.altIsoDate);
  const mdyDates = dates.filter(d => d.inferredOrder === 'mdy');

  if (opts.expectedDateOrder !== undefined) {
    const opposite = opts.expectedDateOrder === 'dmy' ? mdyDates : dmyDates;
    for (const date of opposite) {
      const seg = segmentByOrder.get(date.order);
      if (!seg) continue;
      out.push({
        kind: 'date',
        severity: 'error',
        reasons: ['mixed-date-format'],
        detail: `Date "${date.raw}" uses ${date.inferredOrder.toUpperCase()} order, contradicting expected ${opts.expectedDateOrder.toUpperCase()} order.`,
        span: makeSpan(seg, date.start, date.end, date.raw),
        excerpt: makeExcerpt(seg.text, date.start, date.raw.length),
        suggestions: [],
        order: seg.order,
      });
    }
    return;
  }

  const strictDmy = dates.filter(d => d.inferredOrder === 'dmy' && !d.altIsoDate);
  if (strictDmy.length > 0 && mdyDates.length > 0) {
    for (const date of [...strictDmy, ...mdyDates]) {
      const seg = segmentByOrder.get(date.order);
      if (!seg) continue;
      out.push({
        kind: 'date',
        severity: 'warn',
        reasons: ['mixed-date-format'],
        detail: `Date "${date.raw}" conflicts with other numeric dates in the document (both DMY and MDY formats appear).`,
        span: makeSpan(seg, date.start, date.end, date.raw),
        excerpt: makeExcerpt(seg.text, date.start, date.raw.length),
        suggestions: [],
        order: seg.order,
      });
    }
    for (const date of dates) {
      if (date.inferredOrder !== 'ambiguous') continue;
      const seg = segmentByOrder.get(date.order);
      if (!seg) continue;
      out.push({
        kind: 'date',
        severity: 'warn',
        reasons: ['ambiguous-date-order'],
        detail: `Date "${date.raw}" is ambiguous between DMY (${date.isoDate}) and MDY (${date.altIsoDate}) in a mixed-format document.`,
        span: makeSpan(seg, date.start, date.end, date.raw),
        excerpt: makeExcerpt(seg.text, date.start, date.raw.length),
        suggestions: [],
        order: seg.order,
      });
    }
  }
}

function checkInlineDateRanges(seg: Segment, dates: readonly ParsedDateInfo[], out: RawFinding[]): void {
  if (dates.length < 2) return;
  for (let idx = 0; idx < dates.length - 1; idx += 1) {
    const first = dates[idx]!;
    const second = dates[idx + 1]!;
    if (!first.valid || !second.valid || !first.isoDate || !second.isoDate) continue;
    if (first.inferredOrder === 'ambiguous' || second.inferredOrder === 'ambiguous') continue;

    const between = seg.text.slice(first.end, second.start);
    const isRangeConnector = /^\s*(?:to|until|through|–|—|-|đến(?:\s+ngày)?)\s*$/iu.test(between);
    const before = seg.text.slice(Math.max(0, first.start - 16), first.start);
    const hasFromCue = /(?:from|between|từ(?:\s+ngày)?)\s*$/iu.test(before);

    if ((isRangeConnector || (hasFromCue && /^\s*(?:and|to|đến(?:\s+ngày)?)\s*$/iu.test(between))) && first.isoDate > second.isoDate) {
      out.push({
        kind: 'date',
        severity: 'error',
        reasons: ['reversed-date-range'],
        detail: `Date range ends on "${second.raw}" (${second.isoDate}) before start date "${first.raw}" (${first.isoDate}).`,
        span: makeSpan(seg, second.start, second.end, second.raw),
        excerpt: makeExcerpt(seg.text, first.start, second.end - first.start),
        suggestions: [],
        order: seg.order,
      });
    }
  }
}

function checkDocumentDatePairs(
  dates: readonly ParsedDateInfo[],
  segments: readonly Segment[],
  out: RawFinding[],
): void {
  const segmentByOrder = new Map(segments.map(seg => [seg.order, seg]));
  const starts: ParsedDateInfo[] = [];
  const ends: ParsedDateInfo[] = [];

  for (const date of dates) {
    if (!date.valid || !date.isoDate || date.inferredOrder === 'ambiguous') continue;
    const seg = segmentByOrder.get(date.order);
    if (!seg) continue;
    const linePrefix = lastLinePrefix(seg.text, date.start).toLowerCase();
    if (/(?:issue\s*date|issued|start\s*date|effective\s*date|ngày\s*cấp|ngày\s*bắt\s*đầu)\s*[:：]?\s*$/iu.test(linePrefix)) {
      starts.push(date);
    } else if (/(?:due\s*date|expir(?:y|es|ation)(?:\s*date)?|end\s*date|ngày\s*hết\s*hạn|ngày\s*kết\s*thúc)\s*[:：]?\s*$/iu.test(linePrefix)) {
      ends.push(date);
    }
  }

  for (const start of starts) {
    for (const end of ends) {
      if (start.order > end.order && end.order - start.order > 10) continue;
      if (!start.isoDate || !end.isoDate || start.isoDate <= end.isoDate) continue;
      const seg = segmentByOrder.get(end.order);
      if (!seg) continue;
      out.push({
        kind: 'date',
        severity: 'error',
        reasons: ['reversed-date-range'],
        detail: `Due/end date "${end.raw}" (${end.isoDate}) precedes issue/start date "${start.raw}" (${start.isoDate}).`,
        span: makeSpan(seg, end.start, end.end, end.raw),
        excerpt: makeExcerpt(seg.text, end.start, end.raw.length),
        suggestions: [],
        order: seg.order,
      });
    }
  }
}

// --- Unit checks & contradictions ------------------------------------------

const PERCENT_CORRUPTION_RE = /(\d[\d.,]*)\s*(o\/o|0\/0|°\/o|％o)(?![\p{L}\p{N}])/giu;
const UNIT_CORRUPTION_RE = /(?<![\p{L}\p{N}])(\d[\d.,]*)\s*(m1|1bs?|k9|m9|U5D|US0|VNO|VN0|EUB|G8P)(?![\p{L}\p{N}])/gu;
const S_CURRENCY_RE = /(?<![\p{L}\p{N}$])(S(?:[1-9]\d{0,2}(?:,\d{3})+(?:\.\d{1,2})?|[1-9]\d*\.\d{2}))(?![\p{L}\p{N}])/gu;
const INLINE_UNIT_ARITHMETIC_RE =
  /(\d[\d.,]*)\s*([a-zA-Z%‰$€£¥₫]+)\s*[+−\-]\s*(\d[\d.,]*)\s*([a-zA-Z%‰$€£¥₫]+)\s*=\s*(\d[\d.,]*)\s*([a-zA-Z%‰$€£¥₫]+)/gu;

const CORRUPTED_UNIT_MAP: Readonly<Record<string, string>> = {
  m1: 'ml',
  '1b': 'lb',
  '1bs': 'lbs',
  k9: 'kg',
  m9: 'mg',
  U5D: 'USD',
  US0: 'USD',
  VNO: 'VND',
  VN0: 'VND',
  EUB: 'EUR',
  G8P: 'GBP',
};

function isCorruptedUnitToken(token: string): boolean {
  return token in CORRUPTED_UNIT_MAP;
}

function checkUnitsInSegment(seg: Segment, out: RawFinding[]): void {
  const text = seg.text;

  for (const match of text.matchAll(PERCENT_CORRUPTION_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const num = match[1] ?? '';
    out.push({
      kind: 'unit',
      severity: 'error',
      reasons: ['corrupted-unit'],
      detail: `Percent unit "${match[2]}" in "${raw}" looks like OCR-corrupted "%".`,
      span: makeSpan(seg, start, start + raw.length, raw),
      excerpt: makeExcerpt(text, start, raw.length),
      suggestions: [`${num}%`],
      order: seg.order,
    });
  }

  for (const match of text.matchAll(UNIT_CORRUPTION_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const num = match[1] ?? '';
    const badUnit = match[2] ?? '';
    const cleanUnit = CORRUPTED_UNIT_MAP[badUnit] ?? badUnit;
    out.push({
      kind: 'unit',
      severity: 'error',
      reasons: ['corrupted-unit'],
      detail: `Unit "${badUnit}" in "${raw}" looks like OCR-corrupted "${cleanUnit}".`,
      span: makeSpan(seg, start, start + raw.length, raw),
      excerpt: makeExcerpt(text, start, raw.length),
      suggestions: [`${num} ${cleanUnit}`],
      order: seg.order,
    });
  }

  for (const match of text.matchAll(S_CURRENCY_RE)) {
    const start = match.index ?? 0;
    const raw = match[1] ?? match[0];
    out.push({
      kind: 'unit',
      severity: 'error',
      reasons: ['corrupted-unit'],
      detail: `Monetary value "${raw}" starts with "S", likely OCR-corrupted "$".`,
      span: makeSpan(seg, start, start + raw.length, raw),
      excerpt: makeExcerpt(text, start, raw.length),
      suggestions: [`$${raw.slice(1)}`],
      order: seg.order,
    });
  }

  for (const match of text.matchAll(INLINE_UNIT_ARITHMETIC_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const u1 = normalizeUnit(match[2] ?? '');
    const u2 = normalizeUnit(match[4] ?? '');
    const u3 = normalizeUnit(match[6] ?? '');
    if (u1 && u2 && u3 && (u1 !== u2 || u1 !== u3)) {
      out.push({
        kind: 'unit',
        severity: 'error',
        reasons: ['contradictory-unit'],
        detail: `Expression "${raw}" mixes incompatible units (${u1}, ${u2}, ${u3}) without conversion.`,
        span: makeSpan(seg, start, start + raw.length, raw),
        excerpt: makeExcerpt(text, start, raw.length),
        suggestions: [],
        order: seg.order,
      });
    }
  }
}

// --- Labeled cross-document contradictions ---------------------------------

const LABELED_LINE_RE = /^([^:\n]{2,40}?)\s*[:：]\s*(.+)$/gmu;

function collectLabeledClaims(
  seg: Segment,
  dates: readonly ParsedDateInfo[],
  claims: LabeledClaim[],
): void {
  const text = seg.text;
  for (const match of text.matchAll(LABELED_LINE_RE)) {
    const lineStart = match.index ?? 0;
    const rawLabel = (match[1] ?? '').trim();
    const labelKey = normalizeClaimLabel(rawLabel);
    if (labelKey === '' || STRUCTURAL_LABEL_STOPWORDS.has(labelKey)) continue;

    const valueBody = match[2] ?? '';
    const valueOffset = lineStart + match[0].length - valueBody.length;
    const trimmed = valueBody.trim();
    if (trimmed === '') continue;

    // Check if the line carries a single unambiguous date.
    const lineDates = dates.filter(d => d.start >= valueOffset && d.end <= valueOffset + valueBody.length);
    const singleDate = lineDates.length === 1 ? lineDates[0] : undefined;
    if (singleDate !== undefined && singleDate.valid && singleDate.isoDate !== null && singleDate.inferredOrder !== 'ambiguous') {
      claims.push({
        label: labelKey,
        kind: 'date',
        canonical: singleDate.isoDate,
        raw: singleDate.raw,
        start: singleDate.start,
        end: singleDate.end,
        order: seg.order,
        ...(seg.page !== undefined ? { page: seg.page } : {}),
        ...(seg.blockId !== undefined ? { blockId: seg.blockId } : {}),
        text,
      });
      continue;
    }

    // Otherwise check if the line carries a clean primary number (and optional unit).
    const numMatch = /^\s*([$€£¥₫₹]?)\s*([-−]?\d[\d.,]*)\s*([A-Za-z%‰]{1,5})?\b/u.exec(valueBody);
    if (!numMatch) continue;
    const rawNum = numMatch[2] ?? '';
    const parsedVal = parseTableNumber(rawNum);
    if (parsedVal === null) continue;

    const sym = numMatch[1] ?? '';
    const suffixUnit = numMatch[3] ?? '';
    const normalizedUnit = normalizeUnit(sym || suffixUnit);
    const valStart = valueOffset + numMatch[0].indexOf(sym || rawNum);
    const valEnd = valueOffset + numMatch[0].length;
    const fullVal = text.slice(valStart, valEnd).trim();

    claims.push({
      label: labelKey,
      kind: 'number',
      canonical: String(parsedVal),
      ...(normalizedUnit ? { unit: normalizedUnit } : {}),
      raw: fullVal,
      start: valStart,
      end: valStart + fullVal.length,
      order: seg.order,
      ...(seg.page !== undefined ? { page: seg.page } : {}),
      ...(seg.blockId !== undefined ? { blockId: seg.blockId } : {}),
      text,
    });
  }
}

function checkLabeledContradictions(claims: readonly LabeledClaim[], out: RawFinding[]): void {
  const byLabel = new Map<string, LabeledClaim[]>();
  for (const claim of claims) {
    const key = `${claim.kind}:${claim.label}`;
    const list = byLabel.get(key);
    if (list) list.push(claim);
    else byLabel.set(key, [claim]);
  }

  for (const [, group] of byLabel) {
    if (group.length < 2) continue;
    const first = group[0]!;

    const distinctValues = new Set(group.map(c => c.canonical));
    if (distinctValues.size > 1) {
      const reason: OcrReasonCode = first.kind === 'date' ? 'contradictory-date' : 'contradictory-number';
      const kind: OcrFindingKind = first.kind === 'date' ? 'date' : 'number-contradiction';
      for (const claim of group.slice(1)) {
        if (claim.canonical === first.canonical) continue;
        out.push({
          kind,
          severity: 'error',
          reasons: [reason],
          detail: `Label "${claim.label}" has contradictory value "${claim.raw}" vs earlier "${first.raw}".`,
          span: {
            start: claim.start,
            end: claim.end,
            value: claim.raw,
            ...(claim.page !== undefined ? { page: claim.page } : {}),
            ...(claim.blockId !== undefined ? { blockId: claim.blockId } : {}),
          },
          excerpt: makeExcerpt(claim.text, claim.start, claim.raw.length),
          suggestions: [],
          order: claim.order,
        });
      }
    }

    if (first.kind === 'number') {
      const units = new Set(group.map(c => c.unit).filter((u): u is string => Boolean(u)));
      if (units.size > 1) {
        const baselineUnit = group.find(c => c.unit)?.unit;
        for (const claim of group) {
          if (!claim.unit || claim.unit === baselineUnit) continue;
          out.push({
            kind: 'unit',
            severity: 'error',
            reasons: ['contradictory-unit'],
            detail: `Label "${claim.label}" uses conflicting unit "${claim.unit}" vs "${baselineUnit}".`,
            span: {
              start: claim.start,
              end: claim.end,
              value: claim.raw,
              ...(claim.page !== undefined ? { page: claim.page } : {}),
              ...(claim.blockId !== undefined ? { blockId: claim.blockId } : {}),
            },
            excerpt: makeExcerpt(claim.text, claim.start, claim.raw.length),
            suggestions: [],
            order: claim.order,
          });
        }
      }
    }
  }
}

// --- Table verification ----------------------------------------------------

function verifySingleTable(
  table: TableQaInput,
  tableIndex: number,
  baseOrder: number,
  opts: NormalizedOptions,
  out: RawFinding[],
): void {
  const report = checkArithmetic(table, opts.tableOptions);
  const pageMap = buildCellPageMap(table);
  const headers = Array.isArray(table.headers) ? table.headers.map(h => (typeof h === 'string' ? h : '')) : [];
  const rows = Array.isArray(table.rows)
    ? table.rows.map(row => (Array.isArray(row) ? row.map(cell => (typeof cell === 'string' ? cell : '')) : []))
    : [];

  if (rows.length === 0) {
    out.push({
      kind: 'table-arithmetic',
      severity: 'error',
      reasons: ['empty-table'],
      detail: report.problems[0]?.detail ?? 'The table carries no rows to verify.',
      span: { start: 0, end: 0, value: '', row: -1 },
      excerpt: '',
      suggestions: [],
      order: baseOrder,
    });
    return;
  }

  const width = Math.max(
    headers.length,
    ...rows.map(r => r.length),
    typeof table.columnCount === 'number' && Number.isFinite(table.columnCount) ? Math.trunc(table.columnCount) : 0,
  );

  const totalLabelSet = normalizedLabelSet(opts.tableOptions.totalLabels ?? TOTAL_ROW_LABELS);
  const countLabelSet = normalizedLabelSet(opts.tableOptions.countLabels ?? COUNT_ROW_LABELS);
  const percentLabelSet = normalizedLabelSet(opts.tableOptions.percentLabels ?? PERCENT_COLUMN_LABELS);

  const totalRowSet = new Set<number>();
  const countRowSet = new Set<number>();
  rows.forEach((rowCells, idx) => {
    const gridRow = idx + 1;
    const firstLabel = rowCells.find(c => foldLabel(c) !== '') ?? '';
    const norm = foldLabel(firstLabel);
    if (countLabelSet.has(norm)) countRowSet.add(gridRow);
    else if (totalLabelSet.has(norm)) totalRowSet.add(gridRow);
  });

  // Identify columns that carry numbers so glyph checks run in strict numeric-column mode.
  const numericCols = new Set<number>();
  for (let col = 0; col < width; col += 1) {
    let numeric = 0;
    for (let idx = 0; idx < rows.length; idx += 1) {
      const gridRow = idx + 1;
      if (totalRowSet.has(gridRow) || countRowSet.has(gridRow)) continue;
      const cellText = rows[idx]?.[col] ?? '';
      if (extractCellNumberAndUnit(cellText).value !== null) numeric += 1;
    }
    if (numeric > 0) numericCols.add(col);
  }

  // Cell-level OCR checks (glyph confusions, dates, malformed separators, units) + column unit tracking.
  const columnUnits = new Map<number, { gridRow: number; col: number; text: string; unit: string }[]>();
  const columnNumberInfos = new Map<number, { seg: Segment; info: ParsedNumberInfo }[]>();

  for (let col = 0; col < width; col += 1) {
    const headerText = headers[col] ?? '';
    const headerUnit = extractHeaderUnit(headerText);
    const headerPage = pageMap.get(`0:${col}`);
    if (headerText.trim() !== '') {
      const headerSeg: Segment = {
        text: headerText,
        order: baseOrder + col,
        row: 0,
        col,
        ...(headerPage !== undefined ? { page: headerPage } : {}),
      };
      checkGlyphConfusions(headerSeg, out, false);
    }

    for (let idx = 0; idx < rows.length; idx += 1) {
      const gridRow = idx + 1;
      const cellText = rows[idx]?.[col] ?? '';
      if (cellText.trim() === '' || MISSING_CELL.test(cellText.trim())) continue;

      const cellPage = pageMap.get(`${gridRow}:${col}`);
      const cellSeg: Segment = {
        text: cellText,
        order: baseOrder + gridRow * 100 + col,
        row: gridRow,
        col,
        ...(cellPage !== undefined ? { page: cellPage } : {}),
      };

      const isLabelCol = col === 0 && (totalRowSet.has(gridRow) || countRowSet.has(gridRow));
      const inNumCol = numericCols.has(col) && !isLabelCol;
      checkGlyphConfusions(cellSeg, out, inNumCol);
      const cellNums = checkNumbersInSegment(cellSeg, out);
      if (cellNums.length > 0) {
        const list = columnNumberInfos.get(col) ?? [];
        for (const info of cellNums) list.push({ seg: cellSeg, info });
        columnNumberInfos.set(col, list);
      }
      checkDatesInSegment(cellSeg, opts, out);
      checkUnitsInSegment(cellSeg, out);

      if (!countRowSet.has(gridRow)) {
        const extracted = extractCellNumberAndUnit(cellText);
        if (extracted.value !== null && extracted.unit !== null) {
          const list = columnUnits.get(col) ?? [];
          list.push({ gridRow, col, text: cellText, unit: extracted.unit });
          columnUnits.set(col, list);
        }
      }
    }

    // Check column unit consistency (and mismatch against header unit if stated).
    const unitEntries = columnUnits.get(col) ?? [];
    if (unitEntries.length > 0) {
      const counts = new Map<string, number>();
      for (const entry of unitEntries) counts.set(entry.unit, (counts.get(entry.unit) ?? 0) + 1);

      if (headerUnit !== null) {
        for (const entry of unitEntries) {
          if (entry.unit === headerUnit) continue;
          const cellPage = pageMap.get(`${entry.gridRow}:${entry.col}`);
          out.push({
            kind: 'unit',
            severity: 'error',
            reasons: ['mixed-column-units'],
            detail: `Cell "${entry.text}" in column ${col + 1} uses unit "${entry.unit}", conflicting with header unit "${headerUnit}".`,
            span: {
              start: 0,
              end: entry.text.length,
              value: entry.text,
              row: entry.gridRow,
              col: entry.col,
              ...(cellPage !== undefined ? { page: cellPage } : {}),
            },
            excerpt: entry.text,
            suggestions: [],
            order: baseOrder + entry.gridRow * 100 + entry.col,
          });
        }
      } else if (counts.size > 1) {
        const sortedUnits = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        const winningUnit = sortedUnits[0]![0];
        const tiedTop = sortedUnits.length > 1 && sortedUnits[0]![1] === sortedUnits[1]![1];
        for (const entry of unitEntries) {
          if (!tiedTop && entry.unit === winningUnit) continue;
          const cellPage = pageMap.get(`${entry.gridRow}:${entry.col}`);
          out.push({
            kind: 'unit',
            severity: 'error',
            reasons: ['mixed-column-units'],
            detail: `Column ${col + 1} mixes unit "${entry.unit}" in "${entry.text}" with other units (${[...counts.keys()].join(', ')}).`,
            span: {
              start: 0,
              end: entry.text.length,
              value: entry.text,
              row: entry.gridRow,
              col: entry.col,
              ...(cellPage !== undefined ? { page: cellPage } : {}),
            },
            excerpt: entry.text,
            suggestions: [],
            order: baseOrder + entry.gridRow * 100 + entry.col,
          });
        }
      }
    }

    const colNums = columnNumberInfos.get(col) ?? [];
    if (colNums.length > 0) {
      checkDocumentNumberConventions(colNums, opts, out);
    }
  }

  // Map arithmetic contradictions from `checkArithmetic` with exact column coordinates.
  for (const problem of report.problems) {
    if (problem.kind === 'total') {
      const totalRow = problem.row;
      const rowCells = rows[totalRow - 1] ?? [];
      for (let col = 0; col < width; col += 1) {
        const cellText = rowCells[col] ?? '';
        const stated = parseTableNumber(cellText);
        if (stated === null || Math.abs(stated - problem.actual) > SUM_EPSILON) continue;
        // Verify this column's rows above actually match `problem.expected` so two columns
        // with the same stated number don't misattribute the mismatch.
        let sum = 0;
        let counted = 0;
        for (let r = 1; r < totalRow; r += 1) {
          if (totalRowSet.has(r) || countRowSet.has(r)) continue;
          const v = parseTableNumber(rows[r - 1]?.[col] ?? '');
          if (v !== null) {
            sum += v;
            counted += 1;
          }
        }
        if (counted === 0 || Math.abs(Math.round(sum * 1e6) / 1e6 - problem.expected) > SUM_EPSILON) continue;
        const page = pageMap.get(`${totalRow}:${col}`);
        out.push({
          kind: 'table-arithmetic',
          severity: 'error',
          reasons: ['column-sum-mismatch'],
          detail: problem.detail,
          span: {
            start: 0,
            end: cellText.length,
            value: cellText,
            row: totalRow,
            col,
            ...(page !== undefined ? { page } : {}),
          },
          excerpt: cellText,
          suggestions: [],
          order: baseOrder + totalRow * 100 + col,
        });
      }
    } else if (problem.kind === 'percent') {
      const pctCol = headers.findIndex(header => isPercentHeader(header, percentLabelSet));
      const col = pctCol >= 0 ? pctCol : 0;
      const headerText = headers[col] ?? '';
      const page = pageMap.get(`0:${col}`);
      out.push({
        kind: 'table-arithmetic',
        severity: 'error',
        reasons: ['percentage-sum-mismatch'],
        detail: problem.detail,
        span: {
          start: 0,
          end: headerText.length,
          value: headerText,
          row: 0,
          col,
          ...(page !== undefined ? { page } : {}),
        },
        excerpt: headerText,
        suggestions: [],
        order: baseOrder + col,
      });
    } else if (problem.kind === 'count') {
      const rowCells = rows[problem.row - 1] ?? [];
      let countCol = 0;
      let countText = '';
      for (let c = 0; c < width; c += 1) {
        const cell = rowCells[c] ?? '';
        if (countLabelSet.has(foldLabel(cell))) continue;
        if (parseTableNumber(cell) !== null) {
          countCol = c;
          countText = cell;
          break;
        }
      }
      const page = pageMap.get(`${problem.row}:${countCol}`);
      out.push({
        kind: 'table-arithmetic',
        severity: 'error',
        reasons: ['row-count-mismatch'],
        detail: problem.detail,
        span: {
          start: 0,
          end: countText.length,
          value: countText,
          row: problem.row,
          col: countCol,
          ...(page !== undefined ? { page } : {}),
        },
        excerpt: countText,
        suggestions: [],
        order: baseOrder + problem.row * 100 + countCol,
      });
    }
  }
  void tableIndex;
}

function buildCellPageMap(table: TableQaInput): Map<string, number> {
  const map = new Map<string, number>();
  for (const cell of table.cells ?? []) {
    if (Number.isInteger(cell.row) && Number.isInteger(cell.col) && Number.isInteger(cell.page) && cell.page >= 1) {
      map.set(`${cell.row}:${cell.col}`, cell.page);
    }
  }
  return map;
}

function extractCellNumberAndUnit(cellText: string): { value: number | null; unit: string | null } {
  const trimmed = cellText.trim();
  if (trimmed === '') return { value: null, unit: null };
  const direct = parseTableNumber(trimmed);
  if (direct !== null) {
    const symMatch = CURRENCY_SYMBOL_RE.exec(trimmed);
    CURRENCY_SYMBOL_RE.lastIndex = 0;
    if (symMatch) return { value: direct, unit: symMatch[0] };
    if (/[%％]/u.test(trimmed)) return { value: direct, unit: '%' };
    if (/‰/u.test(trimmed)) return { value: direct, unit: '‰' };
    const codeMatch = /(?:^|\s)([A-Z]{3})(?:\s|$)/u.exec(trimmed);
    if (codeMatch && CURRENCY_CODE_SET.has(codeMatch[1]!)) return { value: direct, unit: codeMatch[1]! };
    return { value: direct, unit: null };
  }

  const withUnit = /^([-−]?\d[\d.,]*)\s*([a-zA-Z]{1,4})$/u.exec(trimmed);
  if (withUnit) {
    const num = parseTableNumber(withUnit[1] ?? '');
    const unit = normalizeUnit(withUnit[2] ?? '');
    if (num !== null && unit !== null) return { value: num, unit };
  }
  return { value: null, unit: null };
}

function extractHeaderUnit(header: string): string | null {
  if (/[%％]/u.test(header)) return '%';
  if (/‰/u.test(header)) return '‰';
  const paren = /\(([^)]+)\)/u.exec(header);
  if (paren) {
    return normalizeUnit((paren[1] ?? '').trim());
  }
  return null;
}

function isPercentHeader(text: string, labels: ReadonlySet<string>): boolean {
  const folded = foldLabel(text);
  if (folded === '') return false;
  if (/[%％]/u.test(folded)) return true;
  return labels.has(folded);
}

// --- Report assembly & merging ---------------------------------------------

function buildReport(raw: readonly RawFinding[]): OcrVerificationReport {
  const merged = new Map<string, RawFinding>();

  for (const item of raw) {
    const key = [
      item.span.page ?? '',
      item.span.blockId ?? '',
      item.span.row ?? '',
      item.span.col ?? '',
      item.span.start,
      item.span.end,
    ].join('|');

    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...item,
        reasons: [...new Set(item.reasons)],
        suggestions: [...new Set(item.suggestions)],
      });
      continue;
    }

    for (const reason of item.reasons) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    }
    for (const sug of item.suggestions) {
      if (!existing.suggestions.includes(sug)) existing.suggestions.push(sug);
    }
    if (item.severity === 'error') existing.severity = 'error';
    if (!existing.detail.includes(item.detail)) existing.detail = `${existing.detail} ${item.detail}`;
    if (KIND_RANK[item.kind] < KIND_RANK[existing.kind]) existing.kind = item.kind;
  }

  const sorted = [...merged.values()].sort(compareFindings);
  const findings: OcrFinding[] = sorted.map((entry, idx) => {
    const highRisk = entry.severity === 'error' || entry.reasons.some(r => HIGH_RISK_REASONS.has(r));
    return {
      id: `ocr-${idx + 1}`,
      kind: entry.kind,
      severity: entry.severity,
      highRisk,
      reasons: entry.reasons,
      detail: entry.detail,
      span: entry.span,
      excerpt: entry.excerpt,
      ...(entry.suggestions.length > 0 ? { suggestions: entry.suggestions } : {}),
    };
  });

  const highRiskSpans = findings.filter(f => f.highRisk);
  const errors = findings.filter(f => f.severity === 'error').length;
  const warnings = findings.length - errors;

  return {
    ok: errors === 0,
    needsReview: highRiskSpans.length > 0,
    findings,
    highRiskSpans,
    summary: {
      total: findings.length,
      errors,
      warnings,
      highRisk: highRiskSpans.length,
    },
  };
}

function compareFindings(left: RawFinding, right: RawFinding): number {
  return (
    (left.span.page ?? 0) - (right.span.page ?? 0) ||
    left.order - right.order ||
    (left.span.row ?? -1) - (right.span.row ?? -1) ||
    (left.span.col ?? -1) - (right.span.col ?? -1) ||
    left.span.start - right.span.start ||
    left.span.end - right.span.end ||
    KIND_RANK[left.kind] - KIND_RANK[right.kind]
  );
}

// --- Small helpers ---------------------------------------------------------

function makeSpan(seg: Segment, start: number, end: number, value: string): OcrSpan {
  return {
    start,
    end,
    value,
    ...(seg.page !== undefined ? { page: seg.page } : {}),
    ...(seg.blockId !== undefined ? { blockId: seg.blockId } : {}),
    ...(seg.row !== undefined ? { row: seg.row } : {}),
    ...(seg.col !== undefined ? { col: seg.col } : {}),
  };
}

function makeExcerpt(text: string, index: number, length: number): string {
  if (text === '' || index < 0 || index > text.length) return '';
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + Math.max(1, length) + EXCERPT_RADIUS);
  const body = text.slice(start, end).replace(/\s+/gu, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

function normalizeUnit(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed in UNIT_DIMENSION_ALIASES) return UNIT_DIMENSION_ALIASES[trimmed]!;
  const lower = trimmed.toLowerCase();
  if (lower in UNIT_DIMENSION_ALIASES) return UNIT_DIMENSION_ALIASES[lower]!;
  if (CURRENCY_CODE_SET.has(trimmed)) return trimmed;
  return null;
}

function detectAttachedUnit(text: string, matchStart: number, end: number): string | null {
  if (matchStart > 0 && CURRENCY_SYMBOL_BEFORE.test(text.charAt(matchStart - 1))) {
    return text.charAt(matchStart - 1);
  }
  const after = text.slice(end, end + 8);
  const match = /^\s*(%|％|‰|[A-Za-z]{1,4})\b/u.exec(after) ?? /^([%％‰])/u.exec(after);
  if (!match) return null;
  return normalizeUnit(match[1] ?? '');
}

function lastLinePrefix(text: string, offset: number): string {
  const upTo = text.slice(0, offset);
  const nl = upTo.lastIndexOf('\n');
  return nl < 0 ? upTo : upTo.slice(nl + 1);
}

function foldLabel(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/gu, 'd')
    .replace(/\s*\([^)]*\)\s*$/u, ' ')
    .replace(/[\s:：.]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizedLabelSet(labels: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const label of labels) {
    const folded = foldLabel(label);
    if (folded !== '') set.add(folded);
  }
  return set;
}

function normalizeClaimLabel(raw: string): string {
  return raw.toLowerCase().replace(/\s+/gu, ' ').trim();
}
