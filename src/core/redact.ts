/**
 * Sensitive-data detection and redaction planning (backlog H11/H12).
 *
 * A contract or an invoice carries identifiers the reader may not want to keep or pass
 * on: an email, a phone number, a citizen identity number, a bank account, a tax code, a
 * card number, a home address, a person's name. This module finds them and hands back a
 * plan a human confirms. It never edits the document itself: the caller prints, exports
 * or re-saves, and owns the decision.
 *
 * Contract:
 * - No rule fires on "this looks like a number" alone. Every match needs one of three
 *   kinds of evidence: a label the text itself provides (`CCCD`, `CMND`, `Số tài khoản`,
 *   `MST`, `Họ tên`, `Mr`), a checksum (the Luhn test on a card number), or a structural
 *   cue (a Vietnamese phone prefix, an administrative unit named on the line). A bare
 *   12-digit number with no label is not a citizen identity number.
 * - `detectSensitive` is pure and deterministic. Matches come back in reading order,
 *   longer first where two start together, and `value` is the exact text at the span, so
 *   `text.slice(start, end)` always equals `value`. `reason` is a stable English code for
 *   an audit log, never a localised sentence: this module owns no copy.
 * - `planRedaction` is the confirmation step. Overlapping matches become one span, a
 *   match below the confidence floor becomes a `skipped` entry instead of disappearing,
 *   and `kept` accounts for every remaining character with the reason it stays. A plan
 *   therefore partitions the text: no character is unaccounted for.
 * - `applyRedaction` replaces only the spans the plan produced. Text outside them is
 *   copied byte for byte, so the caller can diff the result and see exactly what changed,
 *   and a span that overlaps one already applied is refused rather than allowed to
 *   corrupt the output.
 * - `redactionReport` carries counts and character totals only. It never holds a raw
 *   value, which is what makes it safe to keep in an audit line.
 * - Pure data: no DOM, no clock, no locale, no I/O. Positions are UTF-16 code units, the
 *   same unit `String.prototype.slice` uses.
 * - What this module does not do: remove text from a PDF. A redacted page must be
 *   re-rendered or have its text layer rebuilt by the caller; a span list on its own
 *   leaves the original bytes readable.
 */

// --- Public shape ----------------------------------------------------------

/** What kind of identifier a match is. */
export type SensitiveKind =
  | 'email'
  | 'phone'
  | 'national-id'
  | 'bank-account'
  | 'tax-code'
  | 'card'
  | 'address'
  | 'person-name';

/**
 * Every kind, in the canonical order this module reports and breaks ties with. A caller
 * that lists kinds sorts by this array rather than by discovery order, so two plans of
 * the same text print the same way.
 */
export const SENSITIVE_KINDS: readonly SensitiveKind[] = [
  'email',
  'phone',
  'national-id',
  'bank-account',
  'tax-code',
  'card',
  'address',
  'person-name',
];

/** Canonical rank of each kind, for deterministic ordering. */
const KIND_RANK: Readonly<Record<SensitiveKind, number>> = {
  email: 0,
  phone: 1,
  'national-id': 2,
  'bank-account': 3,
  'tax-code': 4,
  card: 5,
  address: 6,
  'person-name': 7,
};

/**
 * Why a rule claimed a span. Stable codes, safe to log and to switch on:
 *
 * - `email-syntax`: a well-formed address (`local@domain.tld`).
 * - `phone-prefix`: a Vietnamese dialling prefix (`0` or `+84`) followed by 9 or 10
 *   digits, tolerating single spaces, dots and dashes between digits.
 * - `card-luhn`: 13 to 19 digits that pass the Luhn check.
 * - `label-cccd`: 12 digits right after a citizen-identity label.
 * - `label-cmnd`: 9 digits right after a citizen-identity label.
 * - `label-bank-account`: 6 to 20 digits right after an account label.
 * - `label-tax-code`: 10 or 13 digits right after a tax label.
 * - `label-name`: a capitalised name right after a name label.
 * - `address-admin-unit`: a line that names Vietnamese administrative units.
 * - `address-street-line`: a line shaped like a house number and a street.
 */
export type SensitiveReason =
  | 'email-syntax'
  | 'phone-prefix'
  | 'card-luhn'
  | 'label-cccd'
  | 'label-cmnd'
  | 'label-bank-account'
  | 'label-tax-code'
  | 'label-name'
  | 'address-admin-unit'
  | 'address-street-line';

/** Every reason code, used by the runtime guard that reads matches back from JSON. */
const SENSITIVE_REASONS: readonly SensitiveReason[] = [
  'email-syntax',
  'phone-prefix',
  'card-luhn',
  'label-cccd',
  'label-cmnd',
  'label-bank-account',
  'label-tax-code',
  'label-name',
  'address-admin-unit',
  'address-street-line',
];

/** One identifier a detector found, with the evidence behind it. */
export interface SensitiveMatch {
  kind: SensitiveKind;
  /** Exact text of the span; `text.slice(start, end)` for the text it was found in. */
  value: string;
  /** First UTF-16 code unit of the span. */
  start: number;
  /** One past the last UTF-16 code unit of the span. */
  end: number;
  /** How sure the rule is, 0..1, rounded to three decimals. */
  confidence: number;
  reason: SensitiveReason;
}

/** What `planRedaction` needs besides the matches. */
export interface PlanRedactionOptions {
  /** The text the matches were found in. Bounds checking and `kept` both depend on it. */
  text: string;
  /**
   * Lowest confidence that earns a span, inclusive. A lower match is reported in
   * `skipped` with reason `below-threshold` instead of being redacted; the human sees it
   * and can lower the floor for this document. Defaults to
   * {@link DEFAULT_MIN_CONFIDENCE}.
   */
  minConfidence?: number;
}

/**
 * Why characters stay in the clear.
 *
 * - `no-match`: no detector ever claimed this range.
 * - `below-threshold`: a detector claimed part of it, but at a confidence below the
 *   plan's floor, so the plan left it for the human instead of guessing.
 */
export type KeptReason = 'no-match' | 'below-threshold';

/** A run of characters the plan leaves untouched, and why. */
export interface KeptRange {
  start: number;
  end: number;
  reason: KeptReason;
}

/**
 * Why a match did not become a span.
 *
 * - `below-threshold`: its confidence was under the plan's floor.
 * - `overlaps-span`: a stronger match claimed the same characters; the span already
 *   covers this match, or the winner covers it as part of a merged range.
 * - `invalid-range`: the span was empty, negative, or past the end of the text, so the
 *   plan could not trust it.
 */
export type SkipReason = 'below-threshold' | 'overlaps-span' | 'invalid-range';

/**
 * A match the plan refused. It keeps both reasons: `detectedReason` says why the rule
 * proposed it, `reason` says why the plan left it alone, so a human reviewing the plan
 * can tell a weak rule from a lost argument between rules.
 */
export interface SkippedMatch {
  kind: SensitiveKind;
  value: string;
  start: number;
  end: number;
  confidence: number;
  detectedReason: SensitiveReason;
  reason: SkipReason;
}

/** One range the plan would redact. Spans are sorted and never overlap. */
export interface RedactionSpan {
  start: number;
  end: number;
  /**
   * The kind of the strongest match in the range. A per-kind mask is chosen from this
   * field; `kinds` keeps every kind the range covers, so a label lost to a merge is
   * still visible in the report.
   */
  kind: SensitiveKind;
  /** Every kind the range covers, in canonical {@link SENSITIVE_KINDS} order. */
  kinds: SensitiveKind[];
  /** Highest confidence in the range, 0..1. */
  confidence: number;
  /** Why the winning match was detected. */
  reason: SensitiveReason;
  /** True when the span joined two or more matches that overlapped. */
  merged: boolean;
}

/** A redaction plan: what to mask, what stays, and what was refused. */
export interface PlanRedactionResult {
  /** Sorted by `start`, disjoint, and covering every match at or above the floor. */
  spans: RedactionSpan[];
  /**
   * The complement of `spans`, split by reason. Concatenating the ranges in order
   * reconstructs the text, which is the property a human-confirmed plan needs.
   */
  kept: KeptRange[];
  /** Matches the plan refused, sorted by position, for the human to review. */
  skipped: SkippedMatch[];
}

/** The mask used when the caller names none, and the fallback for a missing kind. */
export const DEFAULT_MASK = '[REDACTED]';

/**
 * A mask is either one replacement for every span, or a table keyed by kind. A kind the
 * table omits falls back to {@link DEFAULT_MASK}, so a partial table can never leave a
 * span unmasked.
 */
export type RedactionMask = string | Partial<Record<SensitiveKind, string>>;

/** The redacted text, plus how many spans were actually replaced. */
export interface ApplyRedactionResult {
  text: string;
  /** Spans written into `text`. Refused spans (invalid or overlapping) are not counted. */
  replaced: number;
}

/** Counts per kind for an audit line; no raw value can appear here. */
export interface RedactionReport {
  /** Number of spans summarised. */
  spans: number;
  /** Total characters the spans cover. */
  characters: number;
  /** Count per kind; every kind is present, `0` when absent. */
  counts: Record<SensitiveKind, number>;
  /** One English audit line: counts and character totals only. */
  line: string;
}

/**
 * Default confidence floor. At or above it a match is redacted; below it the match stays
 * visible in `skipped`. Chosen so structural guesses that are still worth a human's
 * attention (a bare house-number line, a generic `Name:` field) do not silently mask
 * prose, while every labelled or checksum-backed rule passes.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.7;

// --- Detection: shared helpers ---------------------------------------------

interface LabelledHit {
  value: string;
  start: number;
  end: number;
}

/** Nearest 0.001, so two plans of the same text carry the same numbers. */
function roundConfidence(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Drops punctuation a digit group may have picked up at either edge. */
function stripGroupSeparators(value: string): string {
  return value.replace(/[ .\-]/gu, '');
}

/** True when a run of digits carries more than one distinct digit (0000000000 is not a phone). */
function hasDistinctDigits(digits: string): boolean {
  const first = digits.charAt(0);
  for (let index = 1; index < digits.length; index += 1) {
    if (digits.charAt(index) !== first) return true;
  }
  return false;
}

/**
 * Luhn checksum. A card number is the only identifier this module trusts without a
 * label, so the check has to be real: one wrong digit rejects the candidate.
 */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const code = digits.charCodeAt(index) - 48;
    if (code < 0 || code > 9) return false;
    let value = code;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Finds a labelled value: the label is matched wherever it appears, and the value pattern
 * is applied to a short window right after it. The value pattern is anchored at `^` and
 * captures the value as its first and only group, so the value ends where the match ends
 * and its start can be derived by subtraction.
 */
function findLabelledValues(text: string, label: RegExp, value: RegExp, window: number): LabelledHit[] {
  const hits: LabelledHit[] = [];
  for (const match of text.matchAll(label)) {
    const labelEnd = (match.index ?? 0) + match[0].length;
    if (labelEnd >= text.length) continue;
    const slice = text.slice(labelEnd, Math.min(text.length, labelEnd + window));
    const found = value.exec(slice);
    if (!found) continue;
    const raw = found[1];
    if (raw === undefined || raw.length === 0) continue;
    const start = labelEnd + found[0].length - raw.length;
    hits.push({ value: raw, start, end: start + raw.length });
  }
  return hits;
}

// --- Detection: patterns ---------------------------------------------------

/** `local@domain.tld`, the same shape `protect.ts` locks during translation. */
const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const EMAIL_CONFIDENCE = 0.95;

/**
 * A Vietnamese number: `+84` (with or without brackets) or a leading `0`, then 9 or 10
 * more digits. One space, dot or dash may sit between digits, which is how the number is
 * usually printed; the lookbehind keeps a match from starting inside a longer digit run.
 */
const PHONE = /(?<![\d+])(?:\(\+84\)|\+84|0)(?:[ .-]?\d){9,10}(?!\d)/gu;

/** 13 to 19 digits, optionally grouped by a single space or dash. */
const CARD_CANDIDATE = /(?<![\p{L}\d])\d(?:[ -]?\d){12,18}(?!\d)/gu;

/**
 * A digit run the text has already labelled as some other identifier is not a card. The
 * test looks only at the 32 characters before the candidate, where a field label would
 * sit, so a Luhn accident in a labelled account number cannot outvote the label.
 */
const IDENTIFIER_LABEL_BEFORE =
  /(?:mst|mã\s+số\s+thuế|tài\s+khoản|stk|cccd|cmnd|căn\s+cước|tax\s+(?:code|number|id))\s*[:：.\-–—]?\s*$/iu;

/** Any Vietnamese dialling prefix, with the subscriber body validated afterwards. */
const PHONE_LOCAL = /^0\d{9,10}$/u;
const PHONE_INTERNATIONAL = /^84\d{9,10}$/u;

const CCCD_LABEL =
  /(?<![\p{L}])(?:số\s+)?(?:căn\s+cước(?:\s+công\s+dân)?|cccd|cmnd|chứng\s+minh\s+(?:nhân\s+dân|thư)|citizen\s+id|national\s+id)(?![\p{L}])/giu;
// 12 digits (CCCD) or 9 (CMND), with the usual 4-4-4 / 3-3-3 grouping tolerated.
const CCCD_VALUE =
  /^[\s:：.\-–—]*(?:(?:số|no\.?|number|#)\s*)?(\d{12}|\d{4}[ .]\d{4}[ .]\d{4}|\d{9}|\d{3}[ .]\d{3}[ .]\d{3})(?!\d)/u;
const NATIONAL_ID_CONFIDENCE = 0.96;

const BANK_LABEL =
  /(?<![\p{L}])(?:số\s+tài\s+khoản(?:\s+(?:ngân\s+hàng|nh))?|tài\s+khoản(?:\s+(?:ngân\s+hàng|nh))?|stk|bank\s+account(?:\s+(?:number|no\.?))?|account\s+(?:number|no\.?)|account)(?![\p{L}])/giu;
const BANK_VALUE = /^[\s:：.\-–—]*(?:#\s*)?([\d][\d .\-]{4,30}\d)(?!\d)/u;
const BANK_ACCOUNT_CONFIDENCE = 0.94;
const SHORT_BANK_ACCOUNT_CONFIDENCE = 0.85;

const TAX_LABEL = /(?<![\p{L}])(?:mã\s+số\s+thuế|mst|tax\s+(?:code|number|id))(?![\p{L}])/giu;
// 10 digits, optionally followed by the 3-digit branch suffix (contiguous or dashed).
const TAX_VALUE = /^[\s:：.\-–—]*(?:#\s*)?(\d{10}(?:[ .\-]?\d{3})?)(?!\d)/u;
const TAX_CODE_CONFIDENCE = 0.96;

const NAME_LABEL = /(?<![\p{L}])(?:họ\s+(?:và\s+)?tên|ông|bà|mrs\.?|mr\.?|ms\.?|name)(?![\p{L}])/giu;
// One to four capitalised words; the connector absorbs the colon and spacing of a field.
const NAME_VALUE = /^[\s:：.\-–—,]*(?:#\s*)?([\p{Lu}][\p{L}'’.-]*(?:\s+[\p{Lu}][\p{L}'’.-]*){0,3})/u;
const NAME_CONFIDENCE = 0.85;
/** A generic `Name:` field promises less than `Họ tên` or `Ông`, so it sits under the floor. */
const NAME_GENERIC_CONFIDENCE = 0.66;
const NAME_WINDOW = 48;

const ADMIN_UNIT_PAIR =
  /(?<![\p{L}])(?:(?:tỉnh|thành\s*phố|phường|xã|quận|huyện|thị\s*xã|thị\s*trấn)\s+|tp\.?\s*)[\p{Lu}\d]/giu;
const STREET_START = /^(?:số\s+)?\d{1,4}[a-z]?(?:\s*\/\s*\d{1,3})?\s+[\p{L}]/iu;
const STREET_WORD = /(?<![\p{L}])(?:đường|phố)\s+[\p{Lu}\d]/iu;

/**
 * Capitalised words that end a captured name because they are far more likely to start
 * the next field or sentence. Compared folded, so the accents do not matter.
 */
const NAME_STOP_WORDS: ReadonlySet<string> = new Set([
  'ngay',
  'dia',
  'dien',
  'so',
  'ma',
  'kinh',
  'xin',
  'vui',
  'theo',
  'toi',
  'chung',
  'thua',
]);

// --- Detection: helpers ----------------------------------------------------

/** Folds case and diacritics for comparisons that must not depend on the keyboard. */
function foldWord(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/gu, 'd');
}

/**
 * Confidence for a phone candidate, or `undefined` when the digit body does not fit a
 * Vietnamese number. `0` plus 9 digits is a mobile, `0` plus 10 a landline; an
 * international number carries no trunk zero.
 */
function phoneConfidence(raw: string): number | undefined {
  const international = raw.startsWith('+84') || raw.startsWith('(+84)');
  const digits = raw.replace(/[ .\-()]/gu, '').replace(/^\+/u, '');
  if (international) {
    if (!PHONE_INTERNATIONAL.test(digits)) return undefined;
    const body = digits.slice(2);
    if (body.startsWith('0') || !hasDistinctDigits(body)) return undefined;
    return 0.9;
  }
  if (!PHONE_LOCAL.test(digits)) return undefined;
  const body = digits.slice(1);
  if (!hasDistinctDigits(body)) return undefined;
  // `body` is 9 digits for a 10-digit number and 10 for an 11-digit one.
  return body.length >= 10 ? 0.85 : 0.78;
}

/** Confidence for a card candidate, or `undefined` when the Luhn check rejects it. */
function cardConfidence(raw: string): number | undefined {
  const digits = raw.replace(/[ -]/gu, '');
  if (digits.length < 13 || digits.length > 19) return undefined;
  if (digits.startsWith('0')) return undefined;
  if (!passesLuhn(digits)) return undefined;
  // Grouped digits are how a card is printed; an ungrouped run needs the same checksum
  // but is weaker evidence, because account and contract numbers also run long.
  return raw.length > digits.length ? 0.96 : 0.88;
}

/**
 * Trims a name candidate at the first stop word and the last word's sentence punctuation,
 * then requires the minimum word count. Returns the exact text to keep, so the span end
 * stays on a word boundary.
 */
function trimName(raw: string, minWords: number): string | undefined {
  const words = raw.split(/\s+/u);
  const kept: string[] = [];
  for (const word of words) {
    if (NAME_STOP_WORDS.has(foldWord(word))) break;
    kept.push(word);
  }
  const lastIndex = kept.length - 1;
  const last = kept[lastIndex];
  if (last !== undefined) {
    const cleaned = last.replace(/[.'’\-]+$/u, '');
    if (cleaned.length === 0) kept.pop();
    else kept[lastIndex] = cleaned;
  }
  if (kept.length < minWords) return undefined;
  return kept.join(' ');
}

/** Trimmed bounds of one line, so a match never starts or ends on indentation. */
function trimmedBounds(text: string, start: number, end: number): { start: number; end: number } {
  let first = start;
  let last = end;
  while (first < last && /\s/u.test(text.charAt(first))) first += 1;
  while (last > first && /\s/u.test(text.charAt(last - 1))) last -= 1;
  return { start: first, end: last };
}

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const _match of text.matchAll(pattern)) count += 1;
  return count;
}

// --- Detection -------------------------------------------------------------

/**
 * Finds every identifier `text` carries, with the evidence that justifies each match.
 *
 * Rules, in the order they run:
 * 1. email syntax;
 * 2. Vietnamese phone prefixes;
 * 3. card numbers that pass Luhn (and are not already labelled as another identifier);
 * 4. citizen identity numbers after a `CCCD`/`CMND` label, 9 or 12 digits;
 * 5. bank accounts after an account label, 6 to 20 digits;
 * 6. tax codes after an `MST`/`Mã số thuế` label, 10 or 13 digits;
 * 7. names after `Họ tên`, `Ông`, `Bà`, `Mr`, `Mrs`, `Ms` or `Name`;
 * 8. address lines: a house number and street, or a named ward/district/province.
 *
 * Matches may overlap — a labelled tax code is also shaped like a phone number — and
 * resolving that is `planRedaction`'s job, not this function's. The result is sorted by
 * position so a caller can show it in reading order.
 */
export function detectSensitive(text: string): SensitiveMatch[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const matches: SensitiveMatch[] = [];
  const push = (
    kind: SensitiveKind,
    start: number,
    end: number,
    confidence: number,
    reason: SensitiveReason,
  ): void => {
    if (!Number.isInteger(start) || !Number.isInteger(end)) return;
    if (start < 0 || end <= start || end > text.length) return;
    matches.push({
      kind,
      value: text.slice(start, end),
      start,
      end,
      confidence: roundConfidence(clamp01(confidence)),
      reason,
    });
  };

  for (const match of text.matchAll(EMAIL)) {
    const start = match.index ?? 0;
    push('email', start, start + match[0].length, EMAIL_CONFIDENCE, 'email-syntax');
  }

  for (const match of text.matchAll(PHONE)) {
    const confidence = phoneConfidence(match[0]);
    if (confidence === undefined) continue;
    const start = match.index ?? 0;
    push('phone', start, start + match[0].length, confidence, 'phone-prefix');
  }

  for (const match of text.matchAll(CARD_CANDIDATE)) {
    const confidence = cardConfidence(match[0]);
    if (confidence === undefined) continue;
    const start = match.index ?? 0;
    const before = text.slice(Math.max(0, start - 32), start);
    if (IDENTIFIER_LABEL_BEFORE.test(before)) continue;
    push('card', start, start + match[0].length, confidence, 'card-luhn');
  }

  for (const hit of findLabelledValues(text, CCCD_LABEL, CCCD_VALUE, 24)) {
    const digits = stripGroupSeparators(hit.value);
    if (digits.length !== 9 && digits.length !== 12) continue;
    const reason: SensitiveReason = digits.length === 12 ? 'label-cccd' : 'label-cmnd';
    push('national-id', hit.start, hit.end, NATIONAL_ID_CONFIDENCE, reason);
  }

  for (const hit of findLabelledValues(text, BANK_LABEL, BANK_VALUE, 28)) {
    const digits = stripGroupSeparators(hit.value);
    if (digits.length < 6 || digits.length > 20) continue;
    const confidence = digits.length <= 7 ? SHORT_BANK_ACCOUNT_CONFIDENCE : BANK_ACCOUNT_CONFIDENCE;
    push('bank-account', hit.start, hit.end, confidence, 'label-bank-account');
  }

  for (const hit of findLabelledValues(text, TAX_LABEL, TAX_VALUE, 24)) {
    const digits = stripGroupSeparators(hit.value);
    if (digits.length !== 10 && digits.length !== 13) continue;
    push('tax-code', hit.start, hit.end, TAX_CODE_CONFIDENCE, 'label-tax-code');
  }

  for (const match of text.matchAll(NAME_LABEL)) {
    const label = match[0];
    const folded = foldWord(label);
    // `Họ tên` is a form field that promises a name, so a one-word name is enough there.
    const formLabel = folded.startsWith('ho ');
    const genericLabel = folded === 'name';
    const minWords = formLabel ? 1 : 2;
    const labelEnd = (match.index ?? 0) + label.length;
    if (labelEnd >= text.length) continue;
    const slice = text.slice(labelEnd, Math.min(text.length, labelEnd + NAME_WINDOW));
    const found = NAME_VALUE.exec(slice);
    if (!found) continue;
    const raw = found[1];
    if (raw === undefined || raw.length === 0) continue;
    const start = labelEnd + found[0].length - raw.length;
    const name = trimName(raw, minWords);
    if (name === undefined) continue;
    const confidence = genericLabel ? NAME_GENERIC_CONFIDENCE : NAME_CONFIDENCE;
    push('person-name', start, start + name.length, confidence, 'label-name');
  }

  scanAddressLines(text, push);

  return dedupe(matches.sort(compareMatches));
}

/**
 * Scores each line as a Vietnamese address. A line qualifies when it names an
 * administrative unit (a ward, district or province) or opens with a house number on a
 * street; how strong the cue is sets the confidence, and weak cues stay below the default
 * floor so prose that merely mentions a province is not masked.
 */
function scanAddressLines(
  text: string,
  push: (kind: SensitiveKind, start: number, end: number, confidence: number, reason: SensitiveReason) => void,
): void {
  let lineStart = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const atEnd = index === text.length;
    if (!atEnd && text.charCodeAt(index) !== 10) continue;
    const bounds = trimmedBounds(text, lineStart, index);
    lineStart = index + 1;
    if (bounds.end <= bounds.start) continue;
    const line = text.slice(bounds.start, bounds.end);
    const adminPairs = countMatches(line, ADMIN_UNIT_PAIR);
    const streetStart = STREET_START.test(line);
    const streetWord = STREET_WORD.test(line);
    if (adminPairs === 0 && !streetStart && !streetWord) continue;

    let confidence: number;
    if (streetStart && adminPairs >= 2) confidence = 0.93;
    else if (streetStart && adminPairs === 1) confidence = 0.9;
    else if (adminPairs >= 2) confidence = 0.86;
    else if (adminPairs === 1) confidence = 0.68;
    else if (streetStart && streetWord) confidence = 0.75;
    else if (streetStart) confidence = 0.55;
    else confidence = 0.6;

    const reason: SensitiveReason = adminPairs > 0 ? 'address-admin-unit' : 'address-street-line';
    push('address', bounds.start, bounds.end, confidence, reason);
  }
}

/**
 * Reading order, then longer span, then stronger confidence, then canonical kind. This
 * ordering is what makes `detectSensitive` deterministic for equal input and what lets
 * deduplication keep the best of two rules that claim the same span.
 */
function compareMatches(a: SensitiveMatch, b: SensitiveMatch): number {
  if (a.start !== b.start) return a.start - b.start;
  if (a.end !== b.end) return b.end - a.end;
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  return KIND_RANK[a.kind] - KIND_RANK[b.kind];
}

/** Drops an exact duplicate span of the same kind, keeping the first (strongest) one. */
function dedupe(matches: SensitiveMatch[]): SensitiveMatch[] {
  const seen = new Set<string>();
  const unique: SensitiveMatch[] = [];
  for (const match of matches) {
    const key = `${match.start}:${match.end}:${match.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(match);
  }
  return unique;
}

// --- Planning --------------------------------------------------------------

/**
 * Turns raw matches into the plan a human confirms.
 *
 * Steps, in the order they run:
 * 1. a match with an impossible range is refused (`invalid-range`) rather than allowed
 *    to produce a broken span;
 * 2. a match under `options.minConfidence` is refused (`below-threshold`) and kept for
 *    review;
 * 3. the survivors are grouped by overlap and each group becomes one span, covering the
 *    group's whole extent; the strongest match decides the span's kind and reason, and
 *    every other match in the group is refused (`overlaps-span`) because the span
 *    already covers it;
 * 4. `kept` is the complement of the spans, split into ranges that never had a candidate
 *    (`no-match`) and ranges only a refused weak match claimed (`below-threshold`).
 *
 * Spans are sorted by position and disjoint. The plan partitions the text: every
 * character is in exactly one span or one kept range.
 */
export function planRedaction(
  matches: readonly SensitiveMatch[],
  options: PlanRedactionOptions,
): PlanRedactionResult {
  if (options === null || typeof options !== 'object' || typeof options.text !== 'string') {
    throw new TypeError('planRedaction requires options.text: the text the matches were found in.');
  }
  const text = options.text;
  const floor = readFloor(options.minConfidence);

  const skipped: SkippedMatch[] = [];
  const candidates: SensitiveMatch[] = [];
  const input: readonly SensitiveMatch[] = Array.isArray(matches) ? matches : [];
  for (const raw of input) {
    const match = normalizeMatch(raw, text);
    if (match === undefined) {
      const entry = invalidEntry(raw, text);
      if (entry !== undefined) skipped.push(entry);
      continue;
    }
    if (match.confidence < floor) {
      skipped.push(skipEntry(match, 'below-threshold'));
      continue;
    }
    candidates.push(match);
  }

  const clusters = clusterMatches(candidates);
  const spans: RedactionSpan[] = [];
  for (const cluster of clusters) {
    let winnerIndex = 0;
    for (let index = 1; index < cluster.length; index += 1) {
      const candidate = cluster[index];
      const best = cluster[winnerIndex];
      if (candidate !== undefined && best !== undefined && isStronger(candidate, best)) winnerIndex = index;
    }
    const winner = cluster[winnerIndex];
    if (winner === undefined) continue;
    spans.push(spanOf(cluster, winner));
    for (let index = 0; index < cluster.length; index += 1) {
      if (index === winnerIndex) continue;
      const match = cluster[index];
      if (match !== undefined) skipped.push(skipEntry(match, 'overlaps-span'));
    }
  }

  skipped.sort((a, b) => a.start - b.start || a.end - b.end);

  return {
    spans,
    kept: keptRanges(text.length, spans, skipped),
    skipped,
  };
}

/** The confidence floor, clamped to 0..1; a missing or non-numeric value means default. */
function readFloor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MIN_CONFIDENCE;
  return clamp01(value);
}

/**
 * Validates a match against the text and returns a normalised copy, or `undefined` when
 * the range cannot be trusted. Confidence is coerced because a caller may hand over a
 * value from JSON, where `undefined` would poison every comparison.
 */
function normalizeMatch(raw: SensitiveMatch, text: string): SensitiveMatch | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  if (!isSensitiveKind(raw.kind)) return undefined;
  if (!Number.isInteger(raw.start) || !Number.isInteger(raw.end)) return undefined;
  if (raw.start < 0 || raw.end <= raw.start || raw.end > text.length) return undefined;
  if (!isSensitiveReason(raw.reason)) return undefined;
  const confidence =
    typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? clamp01(raw.confidence) : 0;
  return {
    kind: raw.kind,
    value: text.slice(raw.start, raw.end),
    start: raw.start,
    end: raw.end,
    confidence: roundConfidence(confidence),
    reason: raw.reason,
  };
}

/** True for a kind this module knows; the runtime guard a `SensitiveKind` from JSON needs. */
function isSensitiveKind(value: unknown): value is SensitiveKind {
  return typeof value === 'string' && SENSITIVE_KINDS.includes(value as SensitiveKind);
}

/** True for a reason code this module emits. */
function isSensitiveReason(value: unknown): value is SensitiveReason {
  return typeof value === 'string' && SENSITIVE_REASONS.includes(value as SensitiveReason);
}

/** A refused match, flattened for display, with both the detector's and the plan's reason. */
function skipEntry(match: SensitiveMatch, reason: SkipReason): SkippedMatch {
  return {
    kind: match.kind,
    value: match.value,
    start: match.start,
    end: match.end,
    confidence: match.confidence,
    detectedReason: match.reason,
    reason,
  };
}

/**
 * Describes a match that is too malformed to normalise, when enough of it is readable to
 * name it. A record whose kind cannot be recognised is dropped outright: there is nothing
 * truthful a skipped entry could say about it.
 */
function invalidEntry(raw: unknown, text: string): SkippedMatch | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const record = raw as Partial<SensitiveMatch>;
  if (!isSensitiveKind(record.kind)) return undefined;
  const start = typeof record.start === 'number' && Number.isFinite(record.start) ? record.start : -1;
  const end = typeof record.end === 'number' && Number.isFinite(record.end) ? record.end : start;
  const confidence =
    typeof record.confidence === 'number' && Number.isFinite(record.confidence)
      ? roundConfidence(clamp01(record.confidence))
      : 0;
  const value =
    typeof record.value === 'string'
      ? record.value
      : start >= 0 && end > start && end <= text.length
        ? text.slice(start, end)
        : '';
  if (!isSensitiveReason(record.reason)) return undefined;
  return {
    kind: record.kind,
    value,
    start: Math.trunc(start),
    end: Math.trunc(end),
    confidence,
    detectedReason: record.reason,
    reason: 'invalid-range',
  };
}

/** Stronger evidence first: confidence, then length, then earlier start, then kind order. */
function isStronger(candidate: SensitiveMatch, current: SensitiveMatch): boolean {
  if (candidate.confidence !== current.confidence) return candidate.confidence > current.confidence;
  const candidateLength = candidate.end - candidate.start;
  const currentLength = current.end - current.start;
  if (candidateLength !== currentLength) return candidateLength > currentLength;
  if (candidate.start !== current.start) return candidate.start < current.start;
  return KIND_RANK[candidate.kind] < KIND_RANK[current.kind];
}

/** Groups matches whose ranges overlap; a shared edge alone does not join two tokens. */
function clusterMatches(matches: readonly SensitiveMatch[]): SensitiveMatch[][] {
  const ordered = [...matches].sort((a, b) => a.start - b.start || a.end - b.end);
  const clusters: SensitiveMatch[][] = [];
  let current: SensitiveMatch[] = [];
  let reach = -1;
  for (const match of ordered) {
    if (current.length > 0 && match.start >= reach) {
      clusters.push(current);
      current = [];
      reach = -1;
    }
    current.push(match);
    if (match.end > reach) reach = match.end;
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/** One cluster into one span: whole extent, strongest kind, every kind remembered. */
function spanOf(cluster: readonly SensitiveMatch[], winner: SensitiveMatch): RedactionSpan {
  let start = Number.POSITIVE_INFINITY;
  let end = -1;
  let confidence = 0;
  const kinds = new Set<SensitiveKind>();
  for (const match of cluster) {
    if (match.start < start) start = match.start;
    if (match.end > end) end = match.end;
    if (match.confidence > confidence) confidence = match.confidence;
    kinds.add(match.kind);
  }
  return {
    start,
    end,
    kind: winner.kind,
    kinds: SENSITIVE_KINDS.filter(kind => kinds.has(kind)),
    confidence: roundConfidence(confidence),
    reason: winner.reason,
    merged: cluster.length > 1,
  };
}

/**
 * The complement of the spans, split by why each run stays. A run inside a weak match's
 * range says `below-threshold`; everything else says `no-match`. Boundaries are taken
 * from the weak ranges, so a range is never partly one reason and partly another.
 */
function keptRanges(length: number, spans: readonly RedactionSpan[], skipped: readonly SkippedMatch[]): KeptRange[] {
  const weak: { start: number; end: number }[] = [];
  for (const match of skipped) {
    if (match.reason === 'below-threshold') weak.push({ start: match.start, end: match.end });
  }
  weak.sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: KeptRange[] = [];
  let cursor = 0;
  for (const span of spans) {
    appendKept(kept, cursor, span.start, weak);
    cursor = span.end;
  }
  appendKept(kept, cursor, length, weak);
  return kept;
}

/** Splits one gap at weak-range boundaries and appends each part with its reason. */
function appendKept(
  out: KeptRange[],
  start: number,
  end: number,
  weak: readonly { start: number; end: number }[],
): void {
  if (end <= start) return;
  const cuts = new Set<number>([start, end]);
  for (const range of weak) {
    if (range.end <= start || range.start >= end) continue;
    cuts.add(Math.max(start, range.start));
    cuts.add(Math.min(end, range.end));
  }
  const points = [...cuts].sort((a, b) => a - b);
  for (let index = 0; index + 1 < points.length; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (from === undefined || to === undefined || to <= from) continue;
    const covered = weak.some(range => range.start < to && range.end > from);
    pushKept(out, { start: from, end: to, reason: covered ? 'below-threshold' : 'no-match' });
  }
}

/** Appends a kept range, joining it to the previous one when both stay for the same reason. */
function pushKept(out: KeptRange[], range: KeptRange): void {
  const previous = out[out.length - 1];
  if (previous !== undefined && previous.end === range.start && previous.reason === range.reason) {
    previous.end = range.end;
    return;
  }
  out.push(range);
}

// --- Applying --------------------------------------------------------------

/**
 * Replaces each span with a mask and leaves every other character exactly as it was.
 *
 * Spans are applied in position order. A span that is out of bounds, empty, or overlaps
 * one already applied is skipped, so a stale or hand-built span list cannot duplicate or
 * swallow text; `replaced` reports how many spans actually landed. With mask `''` the
 * call deletes the spans and nothing else, which is the shape a caller tests byte
 * identity with.
 */
export function applyRedaction(
  text: string,
  spans: readonly RedactionSpan[],
  mask: RedactionMask = DEFAULT_MASK,
): ApplyRedactionResult {
  if (typeof text !== 'string') {
    throw new TypeError('applyRedaction requires the text the spans were planned for.');
  }
  const list: readonly RedactionSpan[] = Array.isArray(spans) ? spans : [];
  const ordered = [...list].filter(span => isUsableSpan(span, text.length)).sort((a, b) => a.start - b.start);
  let result = '';
  let cursor = 0;
  let replaced = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue;
    result += text.slice(cursor, span.start) + maskFor(mask, span.kind);
    cursor = span.end;
    replaced += 1;
  }
  return { text: result + text.slice(cursor), replaced };
}

/** True when a span can be applied to a text of `length` code units. */
function isUsableSpan(span: RedactionSpan | null | undefined, length: number): span is RedactionSpan {
  if (span === null || span === undefined || typeof span !== 'object') return false;
  if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) return false;
  return span.start >= 0 && span.end > span.start && span.end <= length;
}

/** The replacement for one span: the caller's string, its per-kind entry, or the default. */
function maskFor(mask: RedactionMask, kind: SensitiveKind): string {
  if (typeof mask === 'string') return mask;
  if (mask !== null && typeof mask === 'object') {
    const value = mask[kind];
    if (typeof value === 'string') return value;
  }
  return DEFAULT_MASK;
}

// --- Report ----------------------------------------------------------------

/**
 * Summarises a plan's spans as counts per kind and one English audit line.
 *
 * The line names kinds and numbers only: a raw value would turn the audit trail into a
 * second copy of the data it describes, which is exactly what a redaction report must not
 * be. Kinds with no span stay out of the line but are present in `counts` as `0`.
 */
export function redactionReport(spans: readonly RedactionSpan[]): RedactionReport {
  const counts: Record<SensitiveKind, number> = {
    email: 0,
    phone: 0,
    'national-id': 0,
    'bank-account': 0,
    'tax-code': 0,
    card: 0,
    address: 0,
    'person-name': 0,
  };
  let total = 0;
  let characters = 0;
  const list: readonly RedactionSpan[] = Array.isArray(spans) ? spans : [];
  for (const span of list) {
    if (span === null || span === undefined || typeof span !== 'object') continue;
    if (!isSensitiveKind(span.kind)) continue;
    total += 1;
    counts[span.kind] += 1;
    if (Number.isInteger(span.start) && Number.isInteger(span.end) && span.end > span.start) {
      characters += span.end - span.start;
    }
  }
  const parts: string[] = [];
  for (const kind of SENSITIVE_KINDS) {
    const count = counts[kind];
    if (count > 0) parts.push(`${count} ${kind}`);
  }
  const line =
    total === 0
      ? 'Redaction plan: no redactions.'
      : `Redaction plan: ${total} ${plural(total, 'span')}, ${characters} ${plural(characters, 'character')} (${parts.join(', ')}).`;
  return { spans: total, characters, counts, line };
}

/** `1 span`, `2 spans`, and the same for any noun the audit line uses. */
function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
