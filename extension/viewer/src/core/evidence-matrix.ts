/**
 * Cross-document evidence matrix (backlog item I07).
 *
 * Several documents can be compared on the same aspects — revenue, a launch date, a
 * named system — and each comparison has to show what it is based on. This module
 * builds that matrix: one row per document, one column per aspect, and one cell per
 * pair that holds the page, the block id, the excerpt a reader can open, the text the
 * document wrote, and a normalised value used to compare it with the other documents.
 *
 * The two questions a reader actually asks are answered from the same cells:
 * {@link conflicts} names the aspects whose values disagree and carries a cell from
 * each side; {@link agreeing} names the aspects every document agrees on, with all of
 * their cells. {@link toMarkdown} and {@link toCsv} render the matrix without ever
 * dropping the provenance of a cell.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no network, no I/O. The
 *   same documents and aspects always produce an equal matrix, and the matrix is plain
 *   JSON data, so it can be stored, diffed and tested byte for byte.
 * - Evidence only, no summaries. A cell carries `page`, `blockId`, `excerpt`, `raw`
 *   (the matched text as the document wrote it) and `value` (the normalised comparison
 *   key). `cells` holds only pairs that carry evidence; every pair without evidence is
 *   listed in `gaps`. A gap is information: it is never written as a zero, an empty
 *   string or an empty excerpt, and it is never counted as agreement.
 * - One reading per cell: the first match in reading order (block `readingOrder`, then
 *   the position inside the block). A fact stated twice in one document keeps its first
 *   mention, the same rule the I04 matrix applies to a first mention.
 * - `value` is normalised for comparison, never rewritten for display:
 *   - `number`: `1,200`, `1.200`, `1 200` and `1200` all become `1200`; `3,14` and
 *     `3.14` both become `3.14`; a percent sign is kept, so `12%` is not `0.12`, and a
 *     `+` is dropped. `12.0` and `12` are the same number and compare equal.
 *   - `date`: `2020-04-03`, `2020/04/03`, `03/04/2020` (day first, documented rather
 *     than guessed), `3 April 2020` and `April 3, 2020` all become `2020-04-03`; a
 *     month-only value becomes `YYYY-MM`, a bare year `YYYY`. Impossible dates
 *     (`2020-02-31`) do not normalise, so they cannot silently agree with a real date.
 *   - `text`: case, diacritics and spacing are folded, so `Hà Nội` and `Ha Noi` are one
 *     value.
 *   - A kind that cannot be read from the matched text falls back to the folded text.
 *     Nothing is invented: a value is never replaced by `0` or by a guess.
 * - Conflicts and agreements are claims about the values that were found, not about the
 *   documents. Two values disagree when their normalised forms differ; documents agree
 *   only when at least two of them state the same value. One witness is neither
 *   agreement nor conflict, and an aspect every document is silent on is not a conflict.
 * - Renderers keep the source in every cell: the markdown and CSV cells carry the matched
 *   text, the page, the block id and the excerpt, and a gap is written as
 *   {@link GAP_MARKER}. Nothing is truncated out of the evidence except the excerpt
 *   length, which is capped at {@link MATRIX_EXCERPT_CHARS} code points and marked with
 *   an ellipsis when clipped.
 * - A definition that cannot produce a column is refused instead of guessed: no
 *   documents, an empty aspect list, or an aspect without a usable id or with a pattern
 *   that is not a regular expression yields a matrix with `refusal` set and no rows,
 *   columns, cells or gaps. Nothing is claimed about documents that were not compared.
 */

import type { Block, DocumentIR } from './ir';

// --- Public shape ----------------------------------------------------------

/** How a matched value is normalised before it is compared. */
export type MatrixAspectKind = 'text' | 'number' | 'date';

/** Every kind this module knows, in the order the documentation lists them. */
export const MATRIX_ASPECT_KINDS: readonly MatrixAspectKind[] = ['text', 'number', 'date'];

/**
 * Longest excerpt a cell carries, in Unicode code points, ellipsis included. A table
 * cell has to stay readable; the page and block id beside it are what a reader opens
 * for the rest of the passage.
 */
export const MATRIX_EXCERPT_CHARS = 160;

/**
 * What a renderer writes for a pair without evidence. The words matter: a dash and
 * "no evidence" cannot be misread as the number zero or as an empty cell.
 */
export const GAP_MARKER = '— (no evidence)';

/** One document in the matrix: the id a cell carries, a title, and its IR. */
export interface MatrixDocument {
  /** Unique id; a duplicate id is skipped after its first appearance. */
  id: string;
  /** Name shown as the row label. Falls back to the id when blank. */
  title: string;
  /** The document as `ir.ts`'s `buildDocument` produced it. */
  ir: DocumentIR;
}

/** One aspect compared across the documents. */
export interface MatrixAspect {
  /** Unique id; a duplicate id is skipped after its first appearance. */
  id: string;
  /** Name shown as the column header. Falls back to the id when blank. */
  label: string;
  /**
   * Pattern that finds the fact in a block's text. The value is the first
   * participating capture group, or the whole match when the pattern has no groups;
   * put the payload in the first group. `g` is added and `y` dropped, so the pattern
   * is searched across the block instead of only at its start.
   */
  pattern: RegExp;
  /** How `value` is normalised; an unrecognised kind compares as `text`. */
  kind: MatrixAspectKind;
}

/** One document as a row label. */
export interface MatrixRow {
  documentId: string;
  title: string;
}

/** One aspect as a column header. */
export interface MatrixColumn {
  aspectId: string;
  label: string;
  kind: MatrixAspectKind;
}

/** One piece of evidence: what one document states about one aspect, and where. */
export interface MatrixCell {
  documentId: string;
  aspectId: string;
  /** 1-based page the evidence was read from. */
  page: number;
  /** Id of the block the evidence was read from, so a reader can open it. */
  blockId: string;
  /** Text around the match, capped at {@link MATRIX_EXCERPT_CHARS}. */
  excerpt: string;
  /** The matched text exactly as the document wrote it, whitespace collapsed. */
  raw: string;
  /** Normalised comparison key; equal values are the same fact, not the same meaning. */
  value: string;
}

/** A pair the documents say nothing about. A gap is evidence of absence, not a zero. */
export interface MatrixGap {
  documentId: string;
  aspectId: string;
}

/** Why a matrix was not built. */
export type MatrixRefusal = 'no-documents' | 'no-aspects';

/** Documents as rows, aspects as columns, evidence in the cells that have any. */
export interface AspectMatrix {
  /** Row labels in input order, after duplicates were dropped. */
  rows: MatrixRow[];
  /** Column headers in input order, after unusable aspects were dropped. */
  columns: MatrixColumn[];
  /** Evidence cells in row-major order: document order, then aspect order. */
  cells: MatrixCell[];
  /** Pairs without evidence, in the same row-major order. Empty when every cell is filled. */
  gaps: MatrixGap[];
  /** Set when nothing was compared; the rest of the matrix is then empty. */
  refusal: MatrixRefusal | null;
}

/** One distinct value an aspect was stated with, and the cells that state it. */
export interface AspectValueGroup {
  /** Normalised comparison value shared by `cells`. */
  value: string;
  /** Every evidence cell that states it, in matrix order; never empty. */
  cells: MatrixCell[];
}

/** An aspect whose evidence states more than one value. */
export interface AspectConflict {
  aspectId: string;
  label: string;
  /**
   * One representative cell per disagreeing reading, in the order the readings first
   * appear. Two entries for the ordinary two-sided disagreement; more when several
   * documents disagree with each other.
   */
  cells: MatrixCell[];
  /** Every reading with the cells behind it; two or more, never one. */
  groups: AspectValueGroup[];
  /** Pairs with no evidence, so silence is never read as one side of the dispute. */
  gaps: MatrixGap[];
}

/** An aspect every document with evidence states with the same value. */
export interface AspectAgreement {
  aspectId: string;
  label: string;
  /** The one normalised value all evidence cells state. */
  value: string;
  /** Every evidence cell; at least two, so one witness cannot agree with itself. */
  cells: MatrixCell[];
  /** Pairs with no evidence: they are neither agreeing nor disagreeing. */
  gaps: MatrixGap[];
}

// --- Building --------------------------------------------------------------

/** An aspect after validation, with the scanner used to find its value. */
interface PreparedAspect {
  id: string;
  label: string;
  kind: MatrixAspectKind;
  scanner: RegExp;
}

/** An aspect's evidence grouped by value, for the comparison readers. */
interface AspectComparison {
  aspectId: string;
  label: string;
  groups: AspectValueGroup[];
  gaps: MatrixGap[];
}

/**
 * Builds the matrix for `documents` and `aspects`.
 *
 * Documents and aspects keep their input order; a duplicate id is dropped after its
 * first appearance, and an aspect without a usable id or pattern is dropped instead of
 * producing a column that can never be filled. Each cell is the first match in reading
 * order; a pair with no match becomes a gap and never a zero.
 *
 * An empty aspect list, no usable documents, or no usable aspect refuses the matrix:
 * `refusal` names the reason and `rows`, `columns`, `cells` and `gaps` are all empty,
 * because a comparison that did not happen must not look like one that found nothing.
 */
export function buildMatrix(
  documents: readonly MatrixDocument[],
  aspects: readonly MatrixAspect[],
): AspectMatrix {
  const docs = usableDocuments(documents);
  const columns = prepareAspects(aspects);
  if (docs.length === 0) return refusedMatrix('no-documents');
  if (columns.length === 0) return refusedMatrix('no-aspects');

  const rows: MatrixRow[] = docs.map(document => ({ documentId: document.id, title: document.title }));
  const cells: MatrixCell[] = [];
  const gaps: MatrixGap[] = [];

  for (const document of docs) {
    const blocks = orderedBlocks(document.ir);
    for (const aspect of columns) {
      const cell = evidenceFor(document.id, aspect, blocks);
      if (cell) cells.push(cell);
      else gaps.push({ documentId: document.id, aspectId: aspect.id });
    }
  }

  return {
    rows,
    columns: columns.map(aspect => ({ aspectId: aspect.id, label: aspect.label, kind: aspect.kind })),
    cells,
    gaps,
    refusal: null,
  };
}

function refusedMatrix(refusal: MatrixRefusal): AspectMatrix {
  return { rows: [], columns: [], cells: [], gaps: [], refusal };
}

function evidenceFor(
  documentId: string,
  aspect: PreparedAspect,
  blocks: readonly Block[],
): MatrixCell | null {
  for (const block of blocks) {
    const text = typeof block?.raw === 'string' ? block.raw : '';
    if (text.length === 0) continue;

    aspect.scanner.lastIndex = 0;
    let match = aspect.scanner.exec(text);
    while (match !== null) {
      // A pattern that can match nothing is walked forward instead of looping, and an
      // empty match is not evidence: there is no text to show or compare.
      if (match[0].length === 0) {
        aspect.scanner.lastIndex += 1;
        match = aspect.scanner.exec(text);
        continue;
      }

      const start = match.index;
      const end = start + match[0].length;
      const raw = collapseSpace(matchValue(match));
      if (raw.length > 0) {
        return {
          documentId,
          aspectId: aspect.id,
          page: pageOf(block),
          blockId: block.id,
          excerpt: excerptAround(text, start, end, MATRIX_EXCERPT_CHARS),
          raw,
          value: comparisonValue(raw, aspect.kind),
        };
      }
      match = aspect.scanner.exec(text);
    }
  }
  return null;
}

/**
 * The value text of one match: the first capture group that participated, or the whole
 * match when the pattern captured nothing. A caller writes its payload in group one.
 */
function matchValue(match: RegExpExecArray): string {
  for (let index = 1; index < match.length; index += 1) {
    const group = match[index];
    if (typeof group === 'string') return group;
  }
  return match[0];
}

// --- Comparing -------------------------------------------------------------

/**
 * The aspects whose evidence states more than one value.
 *
 * Each conflict carries a representative cell per reading — `cells[0]` and `cells[1]`
 * for the ordinary two-sided case — plus every reading in `groups`, so a third document
 * that states the same thing as the first is not lost. The gaps of the aspect travel
 * with it: with three documents and one silent, the disagreement is between two of them.
 */
export function conflicts(matrix: AspectMatrix): AspectConflict[] {
  const found: AspectConflict[] = [];
  for (const comparison of compareAspects(matrix)) {
    if (comparison.groups.length < 2) continue;
    const representatives: MatrixCell[] = [];
    for (const group of comparison.groups) {
      const first = group.cells[0];
      if (first) representatives.push(first);
    }
    found.push({
      aspectId: comparison.aspectId,
      label: comparison.label,
      cells: representatives,
      groups: comparison.groups,
      gaps: comparison.gaps,
    });
  }
  return found;
}

/**
 * The aspects at least two documents state with the same value.
 *
 * A single evidence cell is not agreement: one witness cannot agree with itself. The
 * aspect's gaps are carried along, because a document that says nothing about the value
 * is neither agreeing nor disagreeing, and a reader has to see which it is.
 */
export function agreeing(matrix: AspectMatrix): AspectAgreement[] {
  const found: AspectAgreement[] = [];
  for (const comparison of compareAspects(matrix)) {
    const group = comparison.groups[0];
    if (comparison.groups.length !== 1 || !group) continue;
    if (group.cells.length < 2) continue;
    found.push({
      aspectId: comparison.aspectId,
      label: comparison.label,
      value: group.value,
      cells: [...group.cells],
      gaps: comparison.gaps,
    });
  }
  return found;
}

/**
 * Groups every aspect's evidence cells by their normalised value, in column order and,
 * inside a column, in the order the cells appear in the matrix (row-major). Gaps stay
 * with their aspect so both readers can report them.
 */
function compareAspects(matrix: AspectMatrix): AspectComparison[] {
  const columns = Array.isArray(matrix?.columns) ? matrix.columns : [];
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  const gaps = Array.isArray(matrix?.gaps) ? matrix.gaps : [];

  return columns.map(column => {
    const groups: AspectValueGroup[] = [];
    const byValue = new Map<string, AspectValueGroup>();

    for (const cell of cells) {
      if (!cell || cell.aspectId !== column.aspectId) continue;
      const existing = byValue.get(cell.value);
      if (existing) {
        existing.cells.push(cell);
        continue;
      }
      const group: AspectValueGroup = { value: cell.value, cells: [cell] };
      byValue.set(cell.value, group);
      groups.push(group);
    }

    return {
      aspectId: column.aspectId,
      label: column.label,
      groups,
      gaps: gaps.filter(gap => gap?.aspectId === column.aspectId),
    };
  });
}

// --- Rendering -------------------------------------------------------------

/**
 * Writes the matrix as a GitHub-flavoured Markdown table: a "Document" column, one
 * column per aspect, and every cell carrying the matched text, page, block id and
 * excerpt. A pair without evidence is written as {@link GAP_MARKER} rather than an empty
 * cell.
 *
 * Pipes are escaped and a cell's own line breaks become `<br>`, so an excerpt cannot
 * end its row early. A refused matrix writes an empty string: there is nothing to show
 * and no header worth inventing.
 */
export function toMarkdown(matrix: AspectMatrix): string {
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];
  const columns = Array.isArray(matrix?.columns) ? matrix.columns : [];
  if (rows.length === 0 || columns.length === 0) return '';

  const index = cellIndex(matrix);
  const lines: string[] = [];
  lines.push(markdownLine(['Document', ...columns.map(column => column.label)]));
  lines.push(`| ${Array.from({ length: columns.length + 1 }, () => '---').join(' | ')} |`);

  for (const row of rows) {
    const cells = columns.map(column => {
      const cell = index.get(cellKey(row.documentId, column.aspectId));
      return cell ? cellText(cell) : GAP_MARKER;
    });
    lines.push(markdownLine([row.title, ...cells]));
  }
  return lines.join('\n');
}

/**
 * Writes the matrix as CSV: a "Document" header column, one column per aspect, rows
 * separated by LF and no trailing newline. A cell carries the same evidence text the
 * Markdown renderer writes, and a gap is {@link GAP_MARKER}.
 *
 * A field is quoted when it contains a comma, a double quote, a carriage return, a line
 * feed or surrounding whitespace; inner quotes are doubled. That is what keeps an
 * excerpt holding its own comma and quotation marks one field.
 */
export function toCsv(matrix: AspectMatrix): string {
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];
  const columns = Array.isArray(matrix?.columns) ? matrix.columns : [];
  if (rows.length === 0 || columns.length === 0) return '';

  const index = cellIndex(matrix);
  const lines: string[] = [];
  lines.push(csvLine(['Document', ...columns.map(column => column.label)]));

  for (const row of rows) {
    const fields = columns.map(column => {
      const cell = index.get(cellKey(row.documentId, column.aspectId));
      return cell ? cellText(cell) : GAP_MARKER;
    });
    lines.push(csvLine([row.title, ...fields]));
  }
  return lines.join('\n');
}

/** What one rendered cell says: the matched text, the page, the block and the excerpt. */
function cellText(cell: MatrixCell): string {
  const page = Number.isInteger(cell.page) && cell.page >= 1 ? cell.page : 1;
  return `${cell.raw} — p.${page} · ${cell.blockId}: ${cell.excerpt}`;
}

function cellIndex(matrix: AspectMatrix): Map<string, MatrixCell> {
  const index = new Map<string, MatrixCell>();
  const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
  for (const cell of cells) {
    if (!cell) continue;
    const key = cellKey(cell.documentId, cell.aspectId);
    if (!index.has(key)) index.set(key, cell);
  }
  return index;
}

function cellKey(documentId: string, aspectId: string): string {
  return `${documentId}\u0000${aspectId}`;
}

function markdownLine(cells: readonly string[]): string {
  return `| ${cells.map(markdownCell).join(' | ')} |`;
}

function markdownCell(value: string): string {
  const text = typeof value === 'string' ? value : '';
  return text.replace(/\r\n|\r|\n/gu, '<br>').replace(/\|/gu, '\\|');
}

function csvLine(fields: readonly string[]): string {
  return fields.map(csvField).join(',');
}

function csvField(value: string): string {
  const text = typeof value === 'string' ? value : '';
  // A cell may carry its own comma, quotation mark or line break; quoting keeps it one
  // field, and doubling the quotation marks is what lets the reader undo the quoting.
  const needsQuotes = /[",\r\n]/u.test(text) || /^\s|\s$/u.test(text);
  return needsQuotes ? `"${text.replace(/"/gu, '""')}"` : text;
}

// --- Matching and normalising ---------------------------------------------

/**
 * Reads the normalised comparison value of a matched surface. A number or date that the
 * surface does not carry falls back to the folded text, which is stricter than the kind
 * would be: it reports a difference rather than resolving one it cannot prove.
 */
function comparisonValue(surface: string, kind: MatrixAspectKind): string {
  if (kind === 'number') return normalizeNumberSurface(surface) ?? foldText(surface);
  if (kind === 'date') return normalizeDateSurface(surface) ?? foldText(surface);
  return foldText(surface);
}

/**
 * A numeric token: a grouped number (`1,200.50`, `1.200,50`, `1 200`), a plain or
 * decimal number (`1200`, `3.14`, `3,14`), an optional sign and an optional percent
 * sign. A space only joins digits that follow in groups of exactly three, so `1 200` is
 * one number while `3 14` is read as `3`.
 */
const NUMBER_TOKEN = new RegExp(
  [
    '[-+\\u2212]?(?:',
    '\\d{1,3}(?:[.,\\s\\u00A0\\u202F\\u2009]\\d{3})+(?:[.,]\\d+)?',
    '|\\d+(?:[.,]\\d+)?',
    ')(?:\\s*%)?',
  ].join(''),
  'u',
);

/** `YYYY-MM-DD`, `YYYY/MM/DD`, `YYYY.MM.DD`. */
const ISO_DATE = /(?<![\p{L}\p{N}])(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?![\p{L}\p{N}])/gu;

/** `YYYY-MM`, the month-precision form. */
const YEAR_MONTH = /(?<![\p{L}\p{N}])(\d{4})[-./](\d{1,2})(?![\p{L}\p{N}])/gu;

/** `D/M/Y` with a two- or four-digit year; day first when the components are ambiguous. */
const NUMERIC_DATE = /(?<![\p{L}\p{N}])(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})(?![\p{L}\p{N}])/gu;

const MONTH_PATTERN =
  'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';

/** `March 3, 2020`, `Mar 3 2020`, `March 3rd, 2020`. */
const MONTH_FIRST_DATE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?![\\p{L}\\p{N}])`,
  'giu',
);

/** `3 March 2020`, `3rd of March 2020`. */
const DAY_FIRST_DATE = new RegExp(
  `(?<![\\p{L}\\p{N}])(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PATTERN})\\.?,?\\s+(\\d{4})(?![\\p{L}\\p{N}])`,
  'giu',
);

/** A bare year, read as a date with year precision. */
const BARE_YEAR = /(?<![\p{L}\p{N}])((?:19|20)\d{2})(?![\p{L}\p{N}])/gu;

/** Month name to number, in the folded spelling the readers produce. */
const MONTH_NUMBERS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** A candidate date read from one surface, with where it sat in the surface. */
interface DateCandidate {
  start: number;
  end: number;
  value: string;
}

/** A half-open character range inside a surface. */
interface Span {
  start: number;
  end: number;
}

/**
 * Normalises the first date in a surface to `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, the form
 * a reader can compare across documents. Patterns are tried for their position, not
 * their kind: the earliest date in the surface wins and the longer reading breaks a tie
 * at the same position, so the full date beats the year it starts with.
 *
 * A date-shaped span that is not a real date (`2020-02-31`, `31/13/2020`) is blocked
 * rather than shortened: the year or month inside it is not read as a weaker date, so an
 * impossible date compares as its own text and cannot agree with a real one.
 */
function normalizeDateSurface(surface: string): string | null {
  const text = surface.normalize('NFKC');
  const candidates: DateCandidate[] = [];
  const blocked: Span[] = [];

  for (const match of text.matchAll(ISO_DATE)) {
    const year = toInteger(match[1]);
    const month = toInteger(match[2]);
    const day = toInteger(match[3]);
    if (validDate(year, month, day)) pushDate(candidates, match, `${formatDate(year, month, day)}`);
    else block(blocked, match);
  }

  for (const match of text.matchAll(YEAR_MONTH)) {
    if (overlapsSpan(blocked, match)) continue;
    const year = toInteger(match[1]);
    const month = toInteger(match[2]);
    if (validDate(year, month, 1)) pushDate(candidates, match, `${formatDate(year, month, null)}`);
  }

  for (const match of text.matchAll(NUMERIC_DATE)) {
    if (overlapsSpan(blocked, match)) continue;
    const day = toInteger(match[1]);
    const month = toInteger(match[2]);
    const year = expandYear(toInteger(match[3]));
    if (validDate(year, month, day)) pushDate(candidates, match, `${formatDate(year, month, day)}`);
    else block(blocked, match);
  }

  for (const match of text.matchAll(MONTH_FIRST_DATE)) {
    if (overlapsSpan(blocked, match)) continue;
    const month = MONTH_NUMBERS[foldText(match[1] ?? '')] ?? 0;
    const day = toInteger(match[2]);
    const year = toInteger(match[3]);
    if (validDate(year, month, day)) pushDate(candidates, match, `${formatDate(year, month, day)}`);
    else block(blocked, match);
  }

  for (const match of text.matchAll(DAY_FIRST_DATE)) {
    if (overlapsSpan(blocked, match)) continue;
    const day = toInteger(match[1]);
    const month = MONTH_NUMBERS[foldText(match[2] ?? '')] ?? 0;
    const year = toInteger(match[3]);
    if (validDate(year, month, day)) pushDate(candidates, match, `${formatDate(year, month, day)}`);
    else block(blocked, match);
  }

  for (const match of text.matchAll(BARE_YEAR)) {
    if (overlapsSpan(blocked, match)) continue;
    const year = toInteger(match[1]);
    if (Number.isInteger(year) && year > 0) pushDate(candidates, match, `${formatDate(year, null, null)}`);
  }

  const best = earliestCandidate(candidates);
  return best ? best.value : null;
}

function pushDate(candidates: DateCandidate[], match: RegExpMatchArray, value: string): void {
  const start = match.index ?? 0;
  candidates.push({ start, end: start + match[0].length, value });
}

function block(spans: Span[], match: RegExpMatchArray): void {
  const start = match.index ?? 0;
  spans.push({ start, end: start + match[0].length });
}

function overlapsSpan(spans: readonly Span[], match: RegExpMatchArray): boolean {
  const start = match.index ?? 0;
  const end = start + match[0].length;
  return spans.some(span => start < span.end && end > span.start);
}

function earliestCandidate(candidates: readonly DateCandidate[]): DateCandidate | null {
  let best: DateCandidate | null = null;
  for (const candidate of candidates) {
    if (!best) {
      best = candidate;
      continue;
    }
    if (candidate.start < best.start) best = candidate;
    else if (candidate.start === best.start && candidate.end > best.end) best = candidate;
  }
  return best;
}

/**
 * Normalises one number surface. Grouping separators are resolved by shape: a 1-3 digit
 * head followed by groups of exactly three digits is a thousands group in whichever
 * separator is used, so `1,200` and `1.200` both become `1200`; any other single
 * separator is a decimal point, so `3,14` and `3.14` both become `3.14`. A trailing
 * percent sign is kept and the number itself is canonicalised, so `12.0` and `12` are one
 * value.
 */
function normalizeNumberSurface(surface: string): string | null {
  const text = surface.normalize('NFKC');
  const token = NUMBER_TOKEN.exec(text)?.[0];
  if (token === undefined) return null;
  return normalizeNumberToken(token);
}

function normalizeNumberToken(token: string): string | null {
  const label = token.trim();
  if (label.length === 0) return null;

  const percent = /%$/u.test(label);
  const body = label
    .replace(/\s*%$/u, '')
    .replace(/[\s\u00A0\u202F\u2009]/gu, '')
    .replace(/^\u2212/u, '-')
    .replace(/^\+/u, '');
  const negative = body.startsWith('-');
  let magnitude = negative ? body.slice(1) : body;

  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(magnitude)) {
    magnitude = magnitude.replace(/,/gu, '');
  } else if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/u.test(magnitude)) {
    magnitude = magnitude.replace(/\./gu, '');
    const comma = magnitude.indexOf(',');
    if (comma !== -1) magnitude = `${magnitude.slice(0, comma)}.${magnitude.slice(comma + 1)}`;
  } else {
    magnitude = magnitude.replace(/,/gu, '.');
  }

  if (!/^\d+(?:\.\d+)?$/u.test(magnitude)) return null;
  const canonical = canonicalNumber(magnitude);
  if (canonical === null) return null;
  // A negative zero is zero: keeping the sign would invent a value the text never made.
  const signed = negative && canonical !== '0' ? `-${canonical}` : canonical;
  return percent ? `${signed}%` : signed;
}

/**
 * Canonical decimal form of a non-negative number: no leading zeros in the integer part,
 * no trailing zeros in the fraction, and an empty fraction dropped, so `007.50` becomes
 * `7.5` and `12.0` becomes `12`.
 */
function canonicalNumber(body: string): string | null {
  const [integerPart = '', fractionPart = ''] = body.split('.');
  if (!/^\d+$/u.test(integerPart)) return null;

  const integer = integerPart.replace(/^0+(?=\d)/u, '');
  const fraction = fractionPart.replace(/0+$/u, '');
  return fraction.length > 0 ? `${integer}.${fraction}` : integer;
}

// --- Text folding ----------------------------------------------------------

const COMBINING_MARKS = /\p{M}+/gu;

/** Punctuation and spaces a value may pick up at its edges; not part of the value. */
const EDGE_PUNCTUATION = /^[\s.,;:!?\u2026'"“”‘’()[\]{}]+|[\s.,;:!?\u2026'"“”‘’()[\]{}]+$/gu;

/**
 * Folds a value for comparison: fullwidth and combined forms are normalised, case and
 * diacritics are dropped (`Hà Nội` and `Ha Noi` meet), and leading or trailing
 * punctuation and spacing are removed. A surface that is nothing but punctuation keeps
 * its collapsed form rather than folding away to an empty value.
 */
function foldText(value: string): string {
  const collapsed = collapseSpace(value);
  if (collapsed.length === 0) return '';
  const folded = collapsed
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/đ/gu, 'd')
    .toLowerCase();
  const trimmed = folded.replace(EDGE_PUNCTUATION, '').replace(/\s+/gu, ' ').trim();
  return trimmed.length > 0 ? trimmed : collapsed;
}

// --- Excerpts --------------------------------------------------------------

/** Characters that can end a sentence on their own, Latin and CJK. */
const SENTENCE_ENDS = /[.!?\u2026\n。！？]+/gu;

/**
 * The sentence around a match, capped at `maxChars` code points including any ellipsis.
 *
 * A sentence that fits is returned whole, because the sentence is what makes a number
 * mean something. When it does not fit the window is narrowed around the match and a
 * leading or trailing `…` marks the cut, so a clipped excerpt never reads as a complete
 * sentence. The excerpt is whitespace-collapsed, which is what makes it a single table
 * cell even when the block it came from wrapped.
 */
function excerptAround(text: string, start: number, end: number, maxChars: number): string {
  const limit = Math.max(1, Math.floor(maxChars));

  let windowStart = 0;
  let windowEnd = text.length;
  for (const boundary of sentenceBoundaries(text)) {
    if (boundary <= start) windowStart = boundary;
    else if (boundary >= end) {
      windowEnd = boundary;
      break;
    }
  }

  const sentence = text.slice(windowStart, windowEnd);
  if (codePointLength(sentence) <= limit) return collapseSpace(sentence);

  const characters = [...text];
  const matchStart = codePointLength(text.slice(0, start));
  const matchEnd = codePointLength(text.slice(0, end));
  const matchLength = Math.max(1, matchEnd - matchStart);

  // Two code points go to the ellipses; the rest is document text centred on the match.
  const room = Math.max(1, limit - 2);
  const span = Math.min(matchLength, room);
  const before = Math.max(0, Math.floor((room - span) / 2));
  let from = Math.max(0, matchStart - before);
  const to = Math.min(characters.length, from + room);
  from = Math.max(0, to - room);

  const head = from > 0 ? '\u2026' : '';
  const tail = to < characters.length ? '\u2026' : '';
  return `${head}${collapseSpace(characters.slice(from, to).join(''))}${tail}`;
}

function sentenceBoundaries(text: string): number[] {
  const boundaries = [0];
  for (const match of text.matchAll(SENTENCE_ENDS)) {
    const start = match.index ?? 0;
    boundaries.push(start + match[0].length);
  }
  return boundaries;
}

// --- Dates -----------------------------------------------------------------

function validDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; a day of `null` drops to month precision. */
function formatDate(year: number, month: number | null, day: number | null): string {
  const base = String(year).padStart(4, '0');
  if (month === null) return base;
  const monthText = `${base}-${String(month).padStart(2, '0')}`;
  if (day === null) return monthText;
  return `${monthText}-${String(day).padStart(2, '0')}`;
}

/** A two-digit year is read inside this century, the same reading the I04 matrix uses. */
function expandYear(year: number): number {
  return year >= 100 ? year : 2000 + year;
}

function toInteger(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) return Number.NaN;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : Number.NaN;
}

// --- Inputs and small helpers ---------------------------------------------

/**
 * Documents that can be compared: objects with a non-blank id, first one per id. A
 * document without a usable `ir` still counts as a row; it simply contributes no
 * evidence, which is a gap rather than a reason to drop it.
 */
function usableDocuments(documents: readonly MatrixDocument[] | undefined): MatrixDocument[] {
  if (!Array.isArray(documents)) return [];
  const seen = new Set<string>();
  const usable: MatrixDocument[] = [];
  for (const document of documents) {
    if (!document || typeof document !== 'object') continue;
    const id = typeof document.id === 'string' ? document.id.trim() : '';
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const title = typeof document.title === 'string' ? document.title.trim() : '';
    usable.push({ id, title: title.length > 0 ? title : id, ir: document.ir });
  }
  return usable;
}

/**
 * Aspects that can produce a column: a non-blank unique id and a usable regular
 * expression. The pattern is rebuilt with `g` and without `y`, so every block is
 * searched from its start and the shared scanner cannot carry state between blocks.
 */
function prepareAspects(aspects: readonly MatrixAspect[] | undefined): PreparedAspect[] {
  if (!Array.isArray(aspects)) return [];
  const seen = new Set<string>();
  const prepared: PreparedAspect[] = [];
  for (const aspect of aspects) {
    if (!aspect || typeof aspect !== 'object') continue;
    const id = typeof aspect.id === 'string' ? aspect.id.trim() : '';
    if (id.length === 0 || seen.has(id)) continue;
    const scanner = scannerFor(aspect.pattern);
    if (!scanner) continue;
    seen.add(id);
    const label = typeof aspect.label === 'string' ? aspect.label.trim() : '';
    prepared.push({
      id,
      label: label.length > 0 ? label : id,
      kind: readKind(aspect.kind),
      scanner,
    });
  }
  return prepared;
}

function scannerFor(pattern: unknown): RegExp | null {
  if (!(pattern instanceof RegExp)) return null;
  const flags = `${pattern.flags.replace(/[gy]/gu, '')}g`;
  try {
    return new RegExp(pattern.source, flags);
  } catch {
    return null;
  }
}

/** An unrecognised kind compares as text: the stricter reading, never a guessed one. */
function readKind(value: unknown): MatrixAspectKind {
  return MATRIX_ASPECT_KINDS.find(kind => kind === value) ?? 'text';
}

/** Blocks in reading order, so a cell always holds the document's first mention. */
function orderedBlocks(ir: DocumentIR | undefined): Block[] {
  const blocks = Array.isArray(ir?.blocks) ? ir.blocks : [];
  return [...blocks].sort(
    (left, right) => readingOrderOf(left) - readingOrderOf(right) || compareText(left?.id, right?.id),
  );
}

function readingOrderOf(block: Block): number {
  return Number.isFinite(block?.readingOrder) ? block.readingOrder : 0;
}

function pageOf(block: Block): number {
  return Number.isInteger(block?.page) && block.page >= 1 ? block.page : 1;
}

function collapseSpace(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function codePointLength(value: string): number {
  return [...value].length;
}

/** Locale-independent text order, used as a reading-order tie-break. */
function compareText(left: string | undefined, right: string | undefined): number {
  const first = typeof left === 'string' ? left : '';
  const second = typeof right === 'string' ? right : '';
  return first < second ? -1 : first > second ? 1 : 0;
}
