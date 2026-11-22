/**
 * User-defined fields and honest field extraction (backlog K01).
 *
 * A reader can be told which fields matter for a document family — invoice
 * number, issue date, total, status — and this module answers with a value, the
 * place it came from, a confidence, and a validation verdict. It never invents
 * a value: a label with nothing under it produces a `missing` entry, not a
 * guess.
 *
 * Two public steps, one small validator:
 *
 * - {@link defineSchema} reads a JSON description of the fields the user wants
 *   (a bare array, or `{ fields: [...] }`) and returns the compiled schema. The
 *   schema itself is validated: an unknown type, a duplicate id or label, an
 *   `enum` with no values, or a `pattern` that does not compile is refused with
 *   a {@link SchemaError} whose message starts with the offending path (for
 *   example `fields[1].pattern: ... is not a valid regular expression`).
 * - {@link extractFields} walks the document blocks in reading order and pairs
 *   each field with at most one value. Matching is a label at the *start* of a
 *   line, followed by a separator (`:`, `=`, a dash) and the value on the same
 *   line, or the value on the next non-empty line, or in the next block on the
 *   same page. Labels are compared case- and accent-insensitively, so a schema
 *   labelled `Ngày` also finds a document that prints `Ngay`.
 * - {@link validateValue} reports concrete problems for one value of one field.
 *
 * Confidence is a fixed product, not a hunch:
 *
 * | Match                                         | Base confidence |
 * | --------------------------------------------- | --------------- |
 * | label and value on the same line              | 0.9             |
 * | label alone, value on the next line           | 0.65            |
 * | label alone, value in the next block          | 0.55            |
 *
 * The base is multiplied by the block's own confidence (OCR text is worth less
 * than decoded text) and by 0.75 when the value does not validate. When two
 * places carry the same label, the higher-confidence one is returned and the
 * other block id is named in `problems` as `ambiguous:label@<blockId>`; the
 * value is still `valid` if it passes validation, because ambiguity is a
 * review note, not a defect in the value.
 *
 * Normalisation, per type:
 *
 * - `text` keeps case and accents, collapsing runs of whitespace to one space.
 * - `number` and `currency` produce a canonical decimal string without grouping
 *   (`1.234,56` and `1,234.56` both become `1234.56`). A single separator
 *   followed by exactly three digits is read as grouping (`1.234` is 1234),
 *   matching `src/core/qa.ts`; write `0.125` or `1.2345` when the decimal
 *   reading is meant. Currency symbols, ISO codes and a trailing `%` are units,
 *   not part of the value; `raw` still carries them.
 * - `date` produces `YYYY-MM-DD`. A four-digit year first (`2024-03-12`) is read
 *   as year-first; otherwise the date is day-first (`12/03/2024`), which is the
 *   Vietnamese and European convention. Month-first input (`03/12/2024`) is not
 *   guessed at: it is read as 3 December, never as 12 March. A two-digit year is
 *   read as 20xx below 69 and 19xx otherwise, and a trailing time is dropped.
 * - `identifier` strips whitespace and keeps case (`INV 2024-001` becomes
 *   `INV2024-001`).
 * - `enum` matches an `enumValues` entry case- and accent-insensitively and
 *   returns that entry's spelling.
 *
 * Boundaries that are deliberate:
 * - Extraction is rule-based over block text. There is no OCR here and no model:
 *   a value the page does not spell out is reported missing.
 * - One label per line, at the start of the line (after a bullet or a list
 *   number). A label mentioned inside a sentence is not a field, and two labels
 *   on one line are not split apart.
 * - A value is only taken from the next block when that block starts with
 *   something other than another schema label, so a neighbouring date line is
 *   not swallowed as an invoice number.
 * - The value's location is reported (`page`, `blockId`, `rect`): for a
 *   next-line or next-block match that is the value's block, which is where a
 *   reader would jump to.
 * - `raw` is the matched text exactly as printed; `value` is the normalised
 *   form. `problems` and `missing` are machine-readable codes and ids, never
 *   user-facing prose.
 */

import type { Rect } from './types';

/** Field types this build can extract and validate. */
export type FieldType = 'text' | 'number' | 'date' | 'currency' | 'identifier' | 'enum';

export const FIELD_TYPES: readonly FieldType[] = ['text', 'number', 'date', 'currency', 'identifier', 'enum'];

/** One field the user wants from a document. */
export interface FieldSchema {
  /** Stable key used in the extraction result; unique within a schema. */
  id: string;
  /** The label as printed in the document, in any language the text uses. */
  label: string;
  type: FieldType;
  /** A required field with no match is reported in `missing` instead of omitted. */
  required: boolean;
  /** Optional regular expression (Unicode mode) the normalised value must match. */
  pattern?: string;
  /** Allowed spellings for an `enum` field, compared case- and accent-insensitively. */
  enumValues?: string[];
}

/**
 * A block as the extraction sees it. `src/core/blocks.ts` blocks pass `text`
 * and `rect`; a Document IR block passes `raw` and `polygon`, so either can be
 * handed in without a copy step. `id`, `page` and `confidence` are optional and
 * default to a derived reading-order id, page 1 and 1.
 */
export interface FieldBlock {
  /** Reader block id, for example `p1-r3`. */
  id?: string;
  /** 1-based page number; blocks without one are treated as page 1. */
  page?: number;
  /** Source text. */
  text?: string;
  /** Alias for `text`, so a Document IR `Block` can be passed directly. */
  raw?: string;
  /** Reader rect; used when `polygon` is absent. */
  rect?: Rect;
  /** Four or more page points; the bounding box is used as the field location. */
  polygon?: readonly { x: number; y: number }[];
  /** 0..1 source confidence; defaults to 1. */
  confidence?: number;
}

/** One value found for one field. */
export interface ExtractedField {
  /** `FieldSchema.id` this value belongs to. */
  id: string;
  /** Normalised value: canonical decimal, `YYYY-MM-DD`, canonical enum, or text. */
  value: string;
  /** The matched text exactly as printed, before normalisation. */
  raw: string;
  /** 1-based page of the block that holds the value. */
  page: number;
  /** Id of the block that holds the value. */
  blockId: string;
  /** Bounding box of that block, in page points. */
  rect: Rect;
  /** 0..1; see the table in the module comment. */
  confidence: number;
  /** True when `problems` holds no validation problem. Ambiguity notes do not count. */
  valid: boolean;
  /**
   * Validation problem codes (`required`, `pattern`, `not-a-number`,
   * `date-format`, `date-implausible`, `enum`, `not-an-identifier`,
   * `identifier-whitespace`), plus `ambiguous:label@<blockId>` notes naming
   * other places that carried the same label.
   */
  problems: string[];
}

/** A required field with no match anywhere in the document. */
export interface MissingField {
  id: string;
  label: string;
}

export interface FieldExtractionResult {
  /** One entry per matched field, in schema order. */
  fields: ExtractedField[];
  /** One entry per required field with no match, in schema order. */
  missing: MissingField[];
}

export type SchemaErrorCode =
  | 'malformed-schema'
  | 'malformed-input'
  | 'duplicate-id'
  | 'duplicate-label'
  | 'unknown-type'
  | 'invalid-pattern'
  | 'invalid-enum-values'
  | 'unexpected-enum-values';

/**
 * A schema, or the input to extraction, that cannot be used as written. `path`
 * points at the offending member (`fields[2].type`); `message` repeats it.
 */
export class SchemaError extends Error {
  readonly code: SchemaErrorCode;
  readonly path: string;

  constructor(code: SchemaErrorCode, path: string, message: string) {
    super(message);
    this.name = 'SchemaError';
    this.code = code;
    this.path = path;
  }
}

/** Prefix of a `problems` entry that names a second place carrying the same label. */
export const AMBIGUOUS_LABEL_PREFIX = 'ambiguous:label@';

/** Confidence of a value on the same line as its label. */
const INLINE_CONFIDENCE = 0.9;

/** Confidence of a value on the line after a label that has no value beside it. */
const NEXT_LINE_CONFIDENCE = 0.65;

/** Confidence of a value in the next block after a label-only block. */
const NEXT_BLOCK_CONFIDENCE = 0.55;

/** Multiplier applied when the normalised value does not validate. */
const INVALID_VALUE_PENALTY = 0.75;

/** Years outside this range are reported as implausible, not as a parse failure. */
const MIN_PLAUSIBLE_YEAR = 1800;
const MAX_PLAUSIBLE_YEAR = 2200;

/** Two-digit years below 69 belong to the 2000s, the rest to the 1900s. */
const CENTURY_PIVOT = 69;

/** Currency signs accepted around an amount, including the Vietnamese dong sign. */
const CURRENCY_SYMBOLS = new Set(Array.from('$€£¥₫đĐ₩₹₽₺₪₴₦₱฿¢₡₲₵₸₼₾'));

/** ISO currency codes accepted around an amount. */
const CURRENCY_CODES = new Set([
  'USD', 'EUR', 'VND', 'GBP', 'JPY', 'CNY', 'KRW', 'THB', 'AUD', 'CAD', 'SGD', 'HKD',
  'INR', 'RUB', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'BRL', 'MXN', 'NZD', 'ZAR', 'IDR',
  'MYR', 'PHP', 'TRY', 'UAH', 'NGN', 'TWD', 'AED', 'SAR',
]);

/** Unit signs that may trail a number without changing its value. */
const UNIT_SYMBOLS = new Set(Array.from('%‰'));

/** Characters that may separate a label from its value on one line. */
const SEPARATOR_PATTERN = /^[:：=\-–—]$/u;

/** Characters a value line may start with after the label on the same line. */
const LABEL_FOLLOWER_PATTERN = /[\s:：=\-–—]/u;

/**
 * Compiles and validates a field schema.
 *
 * Accepts `{ fields: [...] }` or a bare array. Every field needs a non-empty
 * `id`, a non-empty `label` and a known `type`; `required` defaults to false.
 * Ids must be unique (exactly, after trimming), labels must be unique after
 * case and accent folding, `enum` needs at least one non-empty `enumValues`
 * entry, a non-enum field must not carry `enumValues`, and `pattern` must
 * compile in Unicode mode. The first problem is thrown as a {@link SchemaError}.
 */
export function defineSchema(json: unknown): FieldSchema[] {
  const entries = fieldEntries(json);
  const fields: FieldSchema[] = [];
  const ids = new Set<string>();
  const labels = new Set<string>();

  entries.forEach((entry, index) => {
    const path = `fields[${index}]`;
    if (!isRecord(entry)) fail('malformed-schema', path, 'must be an object.');

    const id = readId(entry.id, `${path}.id`);
    if (ids.has(id)) {
      fail('duplicate-id', `${path}.id`, `field id "${id}" appears more than once.`);
    }
    ids.add(id);

    const label = readLabel(entry.label, `${path}.label`);
    const foldedLabel = foldLabel(label);
    if (labels.has(foldedLabel)) {
      fail('duplicate-label', `${path}.label`, `field label "${label}" appears more than once.`);
    }
    labels.add(foldedLabel);

    const type = readType(entry.type, `${path}.type`);
    const required = readRequired(entry.required, `${path}.required`);
    const pattern = readPattern(entry.pattern, `${path}.pattern`);
    const enumValues = readEnumValues(entry.enumValues, `${path}.enumValues`, type);

    const field: FieldSchema = { id, label, type, required };
    if (pattern !== undefined) field.pattern = pattern;
    if (enumValues !== undefined) field.enumValues = enumValues;
    fields.push(field);
  });

  return fields;
}

/**
 * Finds at most one value per field.
 *
 * Blocks are read in document order (page, top edge, left edge, id) so the
 * result does not depend on the order the caller passed them in. A required
 * field with no match is listed in `missing`; an optional field with no match
 * is simply absent. The input blocks and schema are not mutated, and the same
 * input always produces the same result.
 */
export function extractFields(blocks: readonly FieldBlock[], schema: readonly FieldSchema[]): FieldExtractionResult {
  const fields = defineSchema(schema);
  if (!Array.isArray(blocks)) {
    throw new SchemaError('malformed-input', 'blocks', 'blocks: extraction needs an array of blocks.');
  }

  const ordered = orderBlocks(blocks);
  const foldedLabels = fields.map(field => foldLabel(field.label));
  const extracted: ExtractedField[] = [];
  const missing: MissingField[] = [];

  for (const field of fields) {
    const candidates = collectCandidates(field, ordered, foldedLabels);
    const best = candidates[0];
    if (!best) {
      if (field.required) missing.push({ id: field.id, label: field.label });
      continue;
    }

    const block = ordered[best.blockIndex];
    if (!block) continue;

    const problems = validateValue(field, best.value);
    const notes: string[] = [];
    const named = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.blockIndex === best.blockIndex) continue;
      const other = ordered[candidate.blockIndex];
      if (!other || named.has(other.id)) continue;
      named.add(other.id);
      notes.push(`${AMBIGUOUS_LABEL_PREFIX}${other.id}`);
    }

    extracted.push({
      id: field.id,
      value: best.value,
      raw: best.raw,
      page: block.page,
      blockId: block.id,
      rect: { ...block.rect },
      confidence: best.confidence,
      valid: problems.length === 0,
      problems: [...problems, ...notes],
    });
  }

  return { fields: extracted, missing };
}

/**
 * Checks one value against one field and returns problem codes, empty when the
 * value is usable.
 *
 * An empty value is a problem only for a required field (`required`), so an
 * empty optional value validates. The checks per type are: `number`/`currency`
 * parse as a number, `date` is a real calendar date inside a plausible range,
 * `identifier` carries no whitespace and at least one letter or digit, `enum`
 * is one of its `enumValues`, and `pattern` (when set) matches the value.
 *
 * A malformed field is reported as `invalid-schema` and an uncompilable
 * `pattern` as `invalid-pattern`; {@link extractFields} never produces either,
 * because it validates the schema first.
 */
export function validateValue(field: FieldSchema, value: string): string[] {
  if (!isRecord(field)) return ['invalid-schema'];
  const type = field.type;
  if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) return ['invalid-schema'];

  const text = typeof value === 'string' ? value : '';
  if (text.trim() === '') return field.required === true ? ['required'] : [];

  const problems: string[] = [];
  switch (type as FieldType) {
    case 'text':
      break;
    case 'number':
    case 'currency':
      if (parseCanonicalNumber(text) === null) problems.push('not-a-number');
      break;
    case 'date': {
      const iso = parseDate(text);
      if (iso === null) {
        problems.push('date-format');
      } else {
        const year = Number.parseInt(iso.slice(0, 4), 10);
        if (year < MIN_PLAUSIBLE_YEAR || year > MAX_PLAUSIBLE_YEAR) problems.push('date-implausible');
      }
      break;
    }
    case 'identifier':
      if (/[\s\u00A0\u202F\u2009]/u.test(text)) problems.push('identifier-whitespace');
      if (!/[\p{L}\p{N}]/u.test(text)) problems.push('not-an-identifier');
      break;
    case 'enum':
      if (canonicalEnumValue(field.enumValues ?? [], text) === null) problems.push('enum');
      break;
    default:
      break;
  }

  const pattern = patternProblem(field.pattern, text);
  if (pattern !== null) problems.push(pattern);
  return problems;
}

// --- Schema reading --------------------------------------------------------

function fieldEntries(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (isRecord(json) && Array.isArray(json.fields)) return json.fields;
  fail(
    'malformed-schema',
    'fields',
    'a schema must be an array of field objects, or an object with a fields array.',
  );
}

function readId(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('malformed-schema', path, 'must be a non-empty string.');
  }
  return value.trim();
}

function readLabel(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('malformed-schema', path, 'must be a non-empty string.');
  }
  return value.trim();
}

function readType(value: unknown, path: string): FieldType {
  if (typeof value !== 'string' || !(FIELD_TYPES as readonly string[]).includes(value)) {
    fail('unknown-type', path, `must be one of ${FIELD_TYPES.join(' | ')}.`);
  }
  return value as FieldType;
}

function readRequired(value: unknown, path: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail('malformed-schema', path, 'must be a boolean.');
  return value;
}

function readPattern(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail('invalid-pattern', path, 'must be a regular expression string.');
  try {
    new RegExp(value, 'u');
  } catch (error) {
    fail('invalid-pattern', path, `is not a valid regular expression: ${errorMessage(error)}`);
  }
  return value;
}

function readEnumValues(value: unknown, path: string, type: FieldType): string[] | undefined {
  if (type !== 'enum') {
    if (value !== undefined) {
      fail('unexpected-enum-values', path, `is only valid on an enum field, not on "${type}".`);
    }
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    fail('invalid-enum-values', path, 'an enum field needs at least one value.');
  }

  const values: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== 'string' || item.trim() === '') {
      fail('invalid-enum-values', itemPath, 'must be a non-empty string.');
    }
    const folded = fold(item);
    if (seen.has(folded)) {
      fail('invalid-enum-values', itemPath, `duplicates the enum value "${item}".`);
    }
    seen.add(folded);
    values.push(item.trim());
  });
  return values;
}

function fail(code: SchemaErrorCode, path: string, message: string): never {
  throw new SchemaError(code, path, `${path}: ${message}`);
}

// --- Extraction ------------------------------------------------------------

type MatchMode = 'inline' | 'next-line' | 'next-block';

/** A block after defaults, in reading order. */
interface OrderedBlock {
  id: string;
  page: number;
  text: string;
  rect: Rect;
  confidence: number;
  /** Input position, used only as the final tie-break. */
  order: number;
}

/** One place a label was found, with the value it carried. */
interface Candidate {
  /** Index in the ordered block list of the block that holds the value. */
  blockIndex: number;
  mode: MatchMode;
  raw: string;
  value: string;
  confidence: number;
  /** Reading position of the match, used only to break confidence ties. */
  position: number;
}

function orderBlocks(blocks: readonly FieldBlock[]): OrderedBlock[] {
  const prepared = blocks.map((block, index) => prepareBlock(block, index));
  prepared.sort(compareBlocks);

  const used = new Set(prepared.map(block => block.id).filter(id => id !== ''));
  const rankByPage = new Map<number, number>();
  return prepared.map(block => {
    if (block.id !== '') return block;
    let rank = rankByPage.get(block.page) ?? 0;
    let id = `p${block.page}-r${rank}`;
    while (used.has(id)) {
      rank += 1;
      id = `p${block.page}-r${rank}`;
    }
    rankByPage.set(block.page, rank + 1);
    used.add(id);
    return { ...block, id };
  });
}

function prepareBlock(block: FieldBlock | undefined, order: number): OrderedBlock {
  if (block === null || typeof block !== 'object') {
    return { id: '', page: 1, text: '', rect: emptyRect(), confidence: 1, order };
  }
  const page = typeof block.page === 'number' && Number.isInteger(block.page) && block.page > 0 ? block.page : 1;
  const text = typeof block.text === 'string' ? block.text : typeof block.raw === 'string' ? block.raw : '';
  return {
    id: typeof block.id === 'string' ? block.id.trim() : '',
    page,
    text,
    rect: blockRect(block),
    confidence: confidenceOf(block.confidence),
    order,
  };
}

function blockRect(block: FieldBlock): Rect {
  if (isRecord(block.rect)) {
    return {
      x: finiteOr(block.rect.x, 0),
      y: finiteOr(block.rect.y, 0),
      width: Math.max(0, finiteOr(block.rect.width, 0)),
      height: Math.max(0, finiteOr(block.rect.height, 0)),
    };
  }
  if (Array.isArray(block.polygon) && block.polygon.length > 0) {
    const points = block.polygon.filter(point => isRecord(point) && Number.isFinite(point.x) && Number.isFinite(point.y));
    if (points.length > 0) {
      const xs = points.map(point => point.x);
      const ys = points.map(point => point.y);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      return { x: left, y: top, width: Math.max(0, Math.max(...xs) - left), height: Math.max(0, Math.max(...ys) - top) };
    }
  }
  return emptyRect();
}

function emptyRect(): Rect {
  return { x: 0, y: 0, width: 0, height: 0 };
}

function compareBlocks(left: OrderedBlock, right: OrderedBlock): number {
  if (left.page !== right.page) return left.page - right.page;
  // The 0.5 pt row bucket matches the classifier's reading order, so sub-point
  // noise cannot swap a label and its value.
  const leftRow = Math.round(left.rect.y * 2) / 2;
  const rightRow = Math.round(right.rect.y * 2) / 2;
  if (leftRow !== rightRow) return leftRow - rightRow;
  if (left.rect.x !== right.rect.x) return left.rect.x - right.rect.x;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return left.order - right.order;
}

function collectCandidates(field: FieldSchema, ordered: readonly OrderedBlock[], foldedLabels: readonly string[]): Candidate[] {
  const label = foldLabel(field.label);
  const candidates: Candidate[] = [];

  for (let blockIndex = 0; blockIndex < ordered.length; blockIndex += 1) {
    const block = ordered[blockIndex];
    if (!block) continue;
    const lines = block.text.split(/\r?\n/u);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      const match = matchLabel(line, label);
      if (match === null) continue;

      if (match.value !== '') {
        candidates.push(makeCandidate(field, blockIndex, block.confidence, 'inline', match.value, positionOf(blockIndex, lineIndex)));
        continue;
      }

      // The label owns its line but not its value: look at the next non-empty
      // line in the same block, then at the next block on the same page.
      const next = nextNonEmptyLine(lines, lineIndex + 1);
      if (next !== null) {
        if (!isLabelLine(next.text, foldedLabels)) {
          candidates.push(makeCandidate(field, blockIndex, block.confidence, 'next-line', next.text, positionOf(blockIndex, next.index)));
        }
        continue;
      }

      const following = ordered[blockIndex + 1];
      if (!following || following.page !== block.page) continue;
      const first = nextNonEmptyLine(following.text.split(/\r?\n/u), 0);
      if (first === null || isLabelLine(first.text, foldedLabels)) continue;
      candidates.push(makeCandidate(field, blockIndex + 1, following.confidence, 'next-block', first.text, positionOf(blockIndex + 1, first.index)));
    }
  }

  return candidates.sort(compareCandidates);
}

function makeCandidate(
  field: FieldSchema,
  blockIndex: number,
  blockConfidence: number,
  mode: MatchMode,
  raw: string,
  position: number,
): Candidate {
  const value = normalizeValue(field, raw);
  const base = mode === 'inline' ? INLINE_CONFIDENCE : mode === 'next-line' ? NEXT_LINE_CONFIDENCE : NEXT_BLOCK_CONFIDENCE;
  const penalty = validateValue(field, value).length === 0 ? 1 : INVALID_VALUE_PENALTY;
  return { blockIndex, mode, raw, value, confidence: round4(clamp01(base * blockConfidence * penalty)), position };
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.confidence !== right.confidence) return right.confidence - left.confidence;
  return left.position - right.position;
}

function positionOf(blockIndex: number, lineIndex: number): number {
  return blockIndex * 1_000_000 + lineIndex;
}

function nextNonEmptyLine(lines: readonly string[], from: number): { text: string; index: number } | null {
  for (let index = from; index < lines.length; index += 1) {
    const text = (lines[index] ?? '').trim();
    if (text !== '') return { text, index };
  }
  return null;
}

function isLabelLine(line: string, foldedLabels: readonly string[]): boolean {
  return foldedLabels.some(label => matchLabel(line, label) !== null);
}

/**
 * Matches one label at the start of a line and returns the printed value that
 * follows the separator, or the empty string when the label has no value on its
 * line.
 */
function matchLabel(line: string, foldedLabel: string): { value: string } | null {
  if (foldedLabel === '' || typeof line !== 'string') return null;
  const folded = foldWithMap(line);

  for (const offset of labelStartOffsets(folded.text)) {
    if (!folded.text.startsWith(foldedLabel, offset)) continue;

    let cursor = offset + foldedLabel.length;
    const after = folded.text[cursor];
    // `date` must not match `dated`: the label ends at a word boundary.
    if (after !== undefined && !LABEL_FOLLOWER_PATTERN.test(after)) continue;

    cursor = skipWhitespace(folded.text, cursor);
    if (cursor >= folded.text.length) return { value: '' };

    const separator = folded.text[cursor] ?? '';
    if (!SEPARATOR_PATTERN.test(separator)) continue;
    cursor = skipWhitespace(folded.text, cursor + 1);
    if (cursor >= folded.text.length) return { value: '' };

    const start = folded.map[cursor];
    if (start === undefined) return { value: line.trim() };
    return { value: line.slice(start).trim() };
  }
  return null;
}

/** Start offsets worth testing: after leading decoration, and after a list number. */
function labelStartOffsets(foldedText: string): number[] {
  const offsets: number[] = [];
  const leading = /^[\s\-–—•▪◦‣∙·*]+/u.exec(foldedText);
  const base = leading ? leading[0].length : 0;
  offsets.push(base);

  const enumeration = /^(?:\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+/u.exec(foldedText.slice(base));
  if (enumeration) offsets.push(base + enumeration[0].length);
  return offsets;
}

function skipWhitespace(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/u.test(text[index] ?? '')) index += 1;
  return index;
}

// --- Normalisation ---------------------------------------------------------

function normalizeValue(field: FieldSchema, raw: string): string {
  const text = raw.trim();
  switch (field.type) {
    case 'text':
      return text.replace(/\s+/gu, ' ').trim();
    case 'number':
    case 'currency':
      return parseCanonicalNumber(text) ?? text;
    case 'date':
      return parseDate(text) ?? text;
    case 'identifier':
      return text.replace(/[\s\u00A0\u202F\u2009]+/gu, '');
    case 'enum':
      return canonicalEnumValue(field.enumValues ?? [], text) ?? text;
    default:
      return text;
  }
}

/**
 * Canonical decimal string for an amount, or `null` when the text is not a
 * number. Mirrors the separator rule documented in `src/core/qa.ts`.
 */
function parseCanonicalNumber(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw.trim();
  if (text === '') return null;

  let negative = false;
  const parenthesised = /^\((.*)\)$/su.exec(text);
  if (parenthesised) {
    negative = true;
    text = (parenthesised[1] ?? '').trim();
  }

  text = stripUnits(text);
  if (/[-−]$/u.test(text)) {
    negative = true;
    text = text.slice(0, -1).trim();
  }
  if (text.startsWith('-') || text.startsWith('−')) {
    negative = true;
    text = text.slice(1).trim();
  } else if (text.startsWith('+')) {
    text = text.slice(1).trim();
  }

  if (!/^\d[\d.,\s]*$/u.test(text)) return null;
  const compact = text.replace(/\s+/gu, '');
  const canonical = canonicalNumberString(compact);
  if (canonical === null) return null;
  return negative && canonical !== '0' ? `-${canonical}` : canonical;
}

/** Removes currency signs, ISO codes and unit signs from both ends of an amount. */
function stripUnits(text: string): string {
  let body = text.trim();
  for (;;) {
    const before = body;
    body = stripLeadingUnit(body).trim();
    body = stripTrailingUnit(body).trim();
    if (body === before) return body;
  }
}

function stripLeadingUnit(text: string): string {
  const first = Array.from(text)[0];
  if (first !== undefined && (CURRENCY_SYMBOLS.has(first) || UNIT_SYMBOLS.has(first))) {
    return text.slice(first.length);
  }
  const code = text.slice(0, 3).toUpperCase();
  if (CURRENCY_CODES.has(code)) {
    const boundary = text.slice(3, 4);
    // A code may sit against the digits (`VND1.234`); the body check still has
    // to see a pure number afterwards, so this cannot turn an identifier into one.
    if (boundary === '' || /[\s\d.,]/u.test(boundary)) return text.slice(3);
  }
  return text;
}

function stripTrailingUnit(text: string): string {
  const characters = Array.from(text);
  const last = characters[characters.length - 1];
  if (last !== undefined && (CURRENCY_SYMBOLS.has(last) || UNIT_SYMBOLS.has(last))) {
    return characters.slice(0, -1).join('');
  }
  const code = text.slice(-3).toUpperCase();
  if (CURRENCY_CODES.has(code)) {
    const boundary = text.slice(-4, -3);
    if (boundary === '' || /[\s\d.,]/u.test(boundary)) return text.slice(0, -3);
  }
  return text;
}

/** Canonical decimal string for digits with either separator convention. */
function canonicalNumberString(value: string): string | null {
  if (!/^\d[\d.,]*$/u.test(value)) return null;
  const separators = Array.from(value).filter(char => char === ',' || char === '.');
  if (separators.length === 0) return normalizeIntegerString(value);

  const groups = value.split(/[.,]/u);
  const kinds = new Set(separators);
  const head = groups[0] ?? '';
  const tail = groups[groups.length - 1] ?? '';
  let integerPart: string;
  let fraction = '';

  if (kinds.size > 1) {
    // Two kinds can only mean the last one is the decimal separator.
    integerPart = groups.slice(0, -1).join('');
    fraction = tail;
  } else if (groups.length === 2) {
    // `1,234` is grouping; `1,5` and `0,125` are decimals.
    if (tail.length === 3 && head.length <= 3 && !/^0/u.test(head)) {
      integerPart = groups.join('');
    } else {
      integerPart = head;
      fraction = tail;
    }
  } else if (tail.length === 3) {
    // `1,234,567` and the Indian `1,23,456` both read as integers.
    integerPart = groups.join('');
  } else {
    integerPart = groups.slice(0, -1).join('');
    fraction = tail;
  }

  const integer = normalizeIntegerString(integerPart);
  const decimal = fraction.replace(/0+$/u, '');
  return `${integer}${decimal === '' ? '' : `.${decimal}`}`;
}

function normalizeIntegerString(digits: string): string {
  const stripped = digits.replace(/^0+(?=\d)/u, '');
  return stripped === '' ? '0' : stripped;
}

const DATE_TIME_TAIL = String.raw`(?:[ T]+\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)?`;
const ISO_DATE_PATTERN = new RegExp(String.raw`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})${DATE_TIME_TAIL}$`, 'u');
const DAY_FIRST_PATTERN = new RegExp(String.raw`^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})${DATE_TIME_TAIL}$`, 'u');
const SHORT_YEAR_PATTERN = new RegExp(String.raw`^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})${DATE_TIME_TAIL}$`, 'u');

const MONTH_DAYS: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** `YYYY-MM-DD` for a real calendar date, or `null` when the text is not one. */
function parseDate(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text === '') return null;

  const iso = ISO_DATE_PATTERN.exec(text);
  if (iso) return isoDate(iso[1], iso[2], iso[3]);

  const dayFirst = DAY_FIRST_PATTERN.exec(text);
  if (dayFirst) return isoDate(dayFirst[3], dayFirst[2], dayFirst[1]);

  const shortYear = SHORT_YEAR_PATTERN.exec(text);
  if (shortYear) return isoDate(expandYear(shortYear[3]), shortYear[2], shortYear[1]);

  return null;
}

function isoDate(yearText: string | undefined, monthText: string | undefined, dayText: string | undefined): string | null {
  const year = Number.parseInt(yearText ?? '', 10);
  const month = Number.parseInt(monthText ?? '', 10);
  const day = Number.parseInt(dayText ?? '', 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return MONTH_DAYS[month - 1] ?? 0;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function expandYear(text: string | undefined): string {
  const year = Number.parseInt(text ?? '', 10);
  if (!Number.isInteger(year)) return text ?? '';
  return String(year < CENTURY_PIVOT ? 2000 + year : 1900 + year);
}

/** The schema spelling of the enum value the text matches, or `null`. */
function canonicalEnumValue(values: readonly string[], raw: string): string | null {
  const probe = fold(stripTrailingPunctuation(raw));
  if (probe === '') return null;
  for (const value of values) {
    if (fold(value) === probe) return value;
  }
  return null;
}

function stripTrailingPunctuation(value: string): string {
  return value.trim().replace(/[.,;:!?]+$/u, '').trim();
}

// --- Folding and text helpers ---------------------------------------------

/** Case- and accent-insensitive, whitespace-collapsed form used for matching. */
function fold(value: string): string {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const character of value) out += foldCharacter(character);
  return out.replace(/\s+/gu, ' ').trim();
}

/** Folds a label and drops the trailing punctuation a user may have typed. */
function foldLabel(label: string): string {
  return fold(label).replace(/[\s:：=–—-]+$/u, '');
}

function foldCharacter(character: string): string {
  const lowered = character.toLowerCase();
  const withoutMarks = lowered.normalize('NFD').replace(/\p{M}/gu, '');
  return withoutMarks.replace(/đ/gu, 'd');
}

interface FoldedLine {
  text: string;
  /** For each folded position, the index of the original character it came from. */
  map: number[];
}

function foldWithMap(line: string): FoldedLine {
  let text = '';
  const map: number[] = [];
  let index = 0;
  for (const character of line) {
    for (const folded of foldCharacter(character)) {
      text += folded;
      map.push(index);
    }
    index += character.length;
  }

  // Collapse whitespace runs the same way `fold` does for a schema label, so
  // `Invoice   number :` still matches `Invoice number`. The map keeps pointing
  // at the original characters, so the value is sliced from the printed line.
  let collapsed = '';
  const collapsedMap: number[] = [];
  let previousSpace = false;
  for (let position = 0; position < text.length; position += 1) {
    const character = text[position] ?? '';
    if (/\s/u.test(character)) {
      if (previousSpace) continue;
      previousSpace = true;
      collapsed += ' ';
      collapsedMap.push(map[position] ?? 0);
      continue;
    }
    previousSpace = false;
    collapsed += character;
    collapsedMap.push(map[position] ?? 0);
  }
  return { text: collapsed, map: collapsedMap };
}

function confidenceOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return clamp01(value);
}

function patternProblem(pattern: unknown, value: string): string | null {
  if (typeof pattern !== 'string' || pattern === '') return null;
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, 'u');
  } catch {
    return 'invalid-pattern';
  }
  return expression.test(value) ? null : 'pattern';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
