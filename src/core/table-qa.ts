/**
 * Table question answering and arithmetic verification (backlog item I09).
 *
 * `tables.ts` reads a table out of cell geometry; this module answers a question about
 * that table and checks whether the table's own arithmetic holds. Both halves exist for
 * the same reason: a number a reader takes from a table must be traceable to the cells
 * that produced it, and a total that does not add up must be caught before the reader
 * trusts it.
 *
 * {@link answerTable} resolves one question against one table and returns either a
 * grounded number or a refusal. Every answer carries the cells it used, with the page the
 * caller attributed to each, and the checks that were run. The intents, in the order they
 * are checked:
 *
 * | Intent  | Question shape                                        | `kind`    |
 * | ------- | ----------------------------------------------------- | --------- |
 * | compare | difference, more than, compare, chênh lệch            | `compare` |
 * | count   | how many, count, number of, số dòng, số lượng         | `count`   |
 * | sum     | total, sum, cộng, tổng                                | `sum`     |
 * | max     | highest, maximum, largest, most, cao nhất             | `value`   |
 * | min     | lowest, minimum, smallest, least, thấp nhất           | `value`   |
 * | lookup  | what is, how much, value, bao nhiêu, or just a row and a column label | `value` |
 *
 * {@link checkArithmetic} verifies three claims a table makes about itself:
 *
 * - a labelled **total row** (`Total`, `Cộng`, `Tổng`, `Grand total`) against the sum of
 *   the rows above it, column by column;
 * - a labelled **percentage column** (`%`, `Share`, `Phần trăm`, `Tỷ lệ`) against 100,
 *   within {@link DEFAULT_PERCENT_TOLERANCE};
 * - a **stated row count** (`Rows`, `Số dòng`) against the number of data rows.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no network, no I/O. The same
 *   question and table always produce the same answer, including its evidence order.
 * - Cells only. An answer is read from cells the caller supplied; nothing is inferred
 *   from a header alone, and a cell the table does not carry is never filled in.
 * - Row numbering matches `tables.ts`: row 0 is the header row, data row `i` in
 *   `rows[i]` is grid row `i + 1`, and `spans[].row` counts the same way. Evidence and
 *   problems report grid rows.
 * - Numbers are read by value, not by spelling: thousands grouping, a decimal tail, a
 *   percent sign, a currency symbol or an ISO code, and the accounting parentheses of a
 *   negative amount all collapse to one number. Grouping versus decimal follows the rule
 *   `qa.ts` already documents — `1,234` is grouping, `0.125` and `1,5` are decimals — so
 *   the two modules never disagree about the same cell.
 * - A labelled total row and a labelled count row are never data: aggregates skip them
 *   and row matching ignores them, so a table that already carries a `Total` row does not
 *   count its own total twice.
 * - A question that cannot be grounded is `unknown` with a stable reason, a sentence and
 *   empty evidence. No number is invented to fill the gap.
 * - Equality is exact after rounding to six decimals: float dust from adding `0.1` and
 *   `0.2` must not read as an arithmetic error, and a total off by a real unit must.
 *
 * Boundaries that are deliberate:
 * - The question reader understands the English and Vietnamese phrasings listed above
 *   and matches them on folded text (case and diacritics removed). Labels from the table
 *   are matched whatever their language; a question in another language still answers
 *   when it names a row and a column, because that is a lookup.
 * - A maximum or a minimum is taken over the numbers of one column; the winning cell is
 *   the evidence, and the check detail says how many cells were read.
 * - A comparison reads two rows in one column. Two columns of one row are not compared:
 *   that question is better asked as two lookups, and guessing which pairing was meant
 *   would be invention.
 * - `answerTable` uses the default label lists. `checkArithmetic` accepts replacements,
 *   for a document that labels its totals in language this module does not list.
 */

import type { Table } from './tables';

// --- Public shapes ---------------------------------------------------------

/** What an answer is. `value` covers a lookup, a maximum and a minimum. */
export type TableAnswerKind = 'value' | 'sum' | 'count' | 'compare' | 'unknown';

/**
 * Why {@link answerTable} could not ground an answer. Stable English codes; the reader
 * gets `unknown.detail` as a sentence.
 *
 * - `empty-table`: the table carries no rows to answer from.
 * - `no-intent`: the question asks for no figure this module reads.
 * - `no-column`: no header label in the question names a column, and there is no single
 *   numeric column to fall back on.
 * - `no-row`: a column is known but the question names no row label.
 * - `ambiguous-row`: the question names more than one row where an answer needs one.
 * - `not-numeric`: the cells an answer needs do not read as numbers.
 * - `no-cells`: the column has no number, or a comparison found fewer than two cells.
 */
export type TableUnknownReason =
  | 'empty-table'
  | 'no-intent'
  | 'no-column'
  | 'no-row'
  | 'ambiguous-row'
  | 'not-numeric'
  | 'no-cells';

/**
 * Where one cell came from. `row` and `col` are grid coordinates: row 0 is the header
 * row, exactly as `spans[].row` counts it in `tables.ts`; `page` is the 1-based page the
 * caller read the cell on.
 */
export interface CellProvenance {
  row: number;
  col: number;
  page: number;
}

/** The shape `tables.ts` returns, plus the optional page attribution of each cell. */
export interface TableQaInput extends Table {
  /** Optional provenance: the page each cell was read from. */
  cells?: readonly CellProvenance[];
}

/** One cell an answer rests on, with its text and the page it came from. */
export interface TableEvidenceCell {
  /** 0-based grid row: 0 is the header row. */
  row: number;
  /** 0-based column. */
  col: number;
  /** The cell text as the table carries it, not a reformatted number. */
  text: string;
  /** 1-based page from `cells`; 0 when the caller attributed no page. */
  page: number;
}

/** One verification step an answer ran, so a reader can see what was checked. */
export interface TableCheck {
  /** Stable English code, such as `column-found` or `cells-numeric`. */
  name: string;
  /** True when the step held. A false step means the answer was refused. */
  ok: boolean;
  /** What was checked and what came out, in English and without markup. */
  detail: string;
}

export interface TableUnknown {
  reason: TableUnknownReason;
  detail: string;
}

/** One grounded number, or a refusal that names what is missing. */
export interface TableAnswer {
  /** The number the question asked for; `null` exactly when `kind` is `unknown`. */
  answer: number | null;
  kind: TableAnswerKind;
  /** The column sum, when `kind` is `sum`; `null` otherwise. */
  sum: number | null;
  /** The number of matching rows, when `kind` is `count`; `null` otherwise. */
  count: number | null;
  /** `left - right`, when `kind` is `compare`; `null` otherwise. */
  compare: number | null;
  /** Why no answer was given; `null` exactly when there is an answer. */
  unknown: TableUnknown | null;
  /** The cells the answer used, in the order it used them. Empty for `unknown`. */
  evidence: TableEvidenceCell[];
  /** The verification steps that ran, in order. */
  checks: TableCheck[];
}

/** What {@link checkArithmetic} found wrong with a table. */
export type ArithmeticProblemKind = 'empty-table' | 'total' | 'percent' | 'count';

/** One claim the table makes that its own rows do not support. */
export interface ArithmeticProblem {
  kind: ArithmeticProblemKind;
  /**
   * 0-based grid row of the claim (header is 0 and a data row is its `rows` index + 1).
   * `0` for a problem about a whole column (the header row), `-1` for the table itself.
   */
  row: number;
  /** What the rows add up to, or the row count the table actually has. */
  expected: number;
  /** What the table states. */
  actual: number;
  /** The claim and the arithmetic that contradicts it, in English and without markup. */
  detail: string;
}

export interface ArithmeticReport {
  /** True when the table made no claim this module could contradict. */
  ok: boolean;
  /** Every contradiction found, in row order then column order; empty when `ok`. */
  problems: ArithmeticProblem[];
}

export interface ArithmeticOptions {
  /** Labels that mark a total row, folded for comparison. Defaults to {@link TOTAL_ROW_LABELS}. */
  totalLabels?: readonly string[];
  /** Labels that mark a percentage column. Defaults to {@link PERCENT_COLUMN_LABELS}. */
  percentLabels?: readonly string[];
  /** Labels that introduce a stated row count. Defaults to {@link COUNT_ROW_LABELS}. */
  countLabels?: readonly string[];
  /**
   * Allowed absolute deviation of a percentage column from 100. Defaults to
   * {@link DEFAULT_PERCENT_TOLERANCE}: rounding each share to a whole percent can leave a
   * percent or two unaccounted for, and a column off by two points is already a real
   * arithmetic error.
   */
  percentTolerance?: number;
  /** Allowed absolute deviation of a stated count from the row count. Defaults to 0. */
  countTolerance?: number;
}

// --- Labels and thresholds -------------------------------------------------

/**
 * Labels that mark a total row. Folded before comparison, so `Tổng` and `Tong` are one
 * label; a trailing colon or a parenthetical currency (`Total (VND)`) is stripped first.
 */
export const TOTAL_ROW_LABELS: readonly string[] = [
  'Total',
  'Totals',
  'Grand total',
  'Subtotal',
  'Sub-total',
  'Sum',
  'Cộng',
  'Tổng',
  'Tổng cộng',
];

/** Headers that mark a percentage column. A header carrying `%` always counts. */
export const PERCENT_COLUMN_LABELS: readonly string[] = [
  '%',
  'Percent',
  'Percentage',
  'Share',
  'Share of total',
  'Percent of total',
  'Phần trăm',
  'Tỷ lệ',
  'Tỉ lệ',
];

/** Labels that introduce a stated row count in the first column of a row. */
export const COUNT_ROW_LABELS: readonly string[] = [
  'Count',
  'Rows',
  'Row count',
  'Number of rows',
  'Total rows',
  'Số dòng',
  'Số hàng',
  'Số lượng',
  'Tổng số dòng',
];

/**
 * Allowed absolute deviation of a percentage column from 100. Half a point: whole-percent
 * shares that are rounded independently routinely miss 100 by a fraction, while a column
 * that sums to 98 or 102 is an error a reader must be told about.
 */
export const DEFAULT_PERCENT_TOLERANCE = 0.5;

/** Allowed absolute deviation of a stated count from the row count: a count is exact. */
export const DEFAULT_COUNT_TOLERANCE = 0;

/** Percent a labelled percentage column must add up to. */
const PERCENT_WHOLE = 100;

/** Decimal places every answer and every reported figure is rounded to. */
const ANSWER_DECIMALS = 6;

/** Float slack left after that rounding, so an exact total is never reported as wrong. */
const SUM_EPSILON = 1e-6;

// --- Text helpers ----------------------------------------------------------

const COMBINING_MARKS = /\p{M}+/gu;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const HAN = /\p{Script=Han}/u;

/** Cells that carry no value: a dash, `n/a`, an ellipsis, a question mark. */
const MISSING_CELL = /^(?:-|–|—|n\/a|na|nil|none|null|\.{2,}|…|\?)$/u;

/** Currency symbols a table may put beside a number. */
const CURRENCY_SYMBOLS = /[$€£¥₩₹₽₫₴₺₦₱฿¢]/gu;

/** Space characters used as thousands grouping. */
const GROUP_SPACES = /[\s\u00A0\u202F\u2009\u2007]/gu;

/** A run of spaces, folded to one space. */
const SPACE_RUN = /\s+/gu;

/**
 * Folds case and diacritics and collapses whitespace: `Tổng` and `Tong` meet on `tong`,
 * and `Hà Nội` meets `Ha Noi`, matching how `abstain.ts` and `retrieval.ts` fold text.
 */
function fold(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/đ/gu, 'd')
    .replace(SPACE_RUN, ' ')
    .trim();
}

/** The visible label of a row or column, without a trailing colon or parenthetical unit. */
function normaliseLabel(value: string): string {
  return fold(value)
    .replace(/\s*\([^)]*\)\s*$/u, ' ')
    .replace(/[\s:：.]+$/u, '')
    .replace(SPACE_RUN, ' ')
    .trim();
}

function labelSet(labels: readonly string[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const label of labels) {
    const folded = normaliseLabel(label);
    if (folded !== '') set.add(folded);
  }
  return set;
}

function matchesLabel(value: string, labels: ReadonlySet<string>): boolean {
  const folded = normaliseLabel(value);
  return folded !== '' && labels.has(folded);
}

/** Where `label` stands as a word in `question`, or -1. Han labels match without a gap. */
function labelIndex(question: string, label: string): number {
  if (question === '' || label === '') return -1;
  let from = 0;
  while (from <= question.length - label.length) {
    const index = question.indexOf(label, from);
    if (index < 0) return -1;
    if (hasCleanEdges(question, index, label)) return index;
    from = index + 1;
  }
  return -1;
}

function hasCleanEdges(question: string, index: number, label: string): boolean {
  const first = label.charAt(0);
  const last = label.charAt(label.length - 1);
  const before = index === 0 ? '' : question.charAt(index - 1);
  const after = question.charAt(index + label.length);
  return cleanEdge(first, before) && cleanEdge(last, after);
}

function cleanEdge(edge: string, neighbour: string): boolean {
  if (edge === '' || neighbour === '') return true;
  // Chinese and Japanese separate no words with spaces, so a gap cannot be required.
  if (HAN.test(edge)) return true;
  return !WORD_CHAR.test(edge) || !WORD_CHAR.test(neighbour);
}

// --- Number reading --------------------------------------------------------

/**
 * Reads one table cell as a number, or returns `null` when it is not a number.
 *
 * A percent sign, a currency symbol or an ISO 4217-shaped code beside the value is a unit
 * and is dropped, so `12%` reads as `12` and `VND 1,250` as `1250`. Parentheses mark a
 * negative amount, as they do in accounting. Grouping versus decimal follows `qa.ts`:
 * with both separators present the last one is the decimal mark, `1,234` with exactly
 * three trailing digits is grouping, and any other single separator is a decimal mark.
 * A digit run whose separators are all grouping reads as an integer whatever the group
 * lengths (`1,23,456` included), and a unit that is not `%`, a currency symbol or a
 * currency code (`12 kg`) is refused rather than half-read.
 */
export function parseTableNumber(text: string): number | null {
  if (typeof text !== 'string') return null;
  let body = text.replace(GROUP_SPACES, ' ').trim();
  if (body === '') return null;

  let negative = false;
  if (body.length >= 2 && body.startsWith('(') && body.endsWith(')')) {
    negative = true;
    body = body.slice(1, -1).trim();
  }

  body = body.replace(CURRENCY_SYMBOLS, '').replace(/[%％‰]/gu, '').trim();
  body = body.replace(/^[A-Z]{3}\s+/u, '').replace(/\s+[A-Z]{3}$/u, '');
  if (body === '') return null;

  if (/^[-−]/u.test(body)) {
    negative = !negative;
    body = body.slice(1);
  }
  if (body.startsWith('+')) body = body.slice(1);
  body = body.replace(/[\s'’]/gu, '');
  if (!/^\d[\d.,]*$/u.test(body)) return null;

  const magnitude = decimalValue(body);
  if (magnitude === null) return null;
  return negative && magnitude !== 0 ? -magnitude : magnitude;
}

/** The value of a digit run that may carry grouping and a decimal tail. */
function decimalValue(body: string): number | null {
  const separators = [...body].filter(char => char === ',' || char === '.');
  if (separators.length === 0) return finiteNumber(body);

  const groups = body.split(/[.,]/u);
  const kinds = new Set(separators);
  const head = groups[0] ?? '';
  const tail = groups[groups.length - 1] ?? '';
  let integerPart: string;
  let fraction: string;

  if (kinds.size > 1) {
    // Two kinds can only mean the last one is the decimal separator.
    integerPart = groups.slice(0, -1).join('');
    fraction = tail;
  } else if (groups.length === 2) {
    // `1,234` is thousands grouping; `1,5` and `0,125` are decimals.
    if (tail.length === 3 && head.length <= 3 && !head.startsWith('0')) {
      integerPart = groups.join('');
      fraction = '';
    } else {
      integerPart = head;
      fraction = tail;
    }
  } else if (tail.length === 3) {
    integerPart = groups.join('');
    fraction = '';
  } else {
    integerPart = groups.slice(0, -1).join('');
    fraction = tail;
  }

  return finiteNumber(fraction === '' ? integerPart : `${integerPart}.${fraction}`);
}

function finiteNumber(text: string): number | null {
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** True when a cell carries no value at all, rather than a value this module cannot read. */
function isMissingCell(text: string): boolean {
  const folded = fold(text);
  return folded === '' || MISSING_CELL.test(folded);
}

// --- Grid ------------------------------------------------------------------

interface Grid {
  headers: string[];
  /** Data rows only; the header row is row 0 of the grid. */
  rows: string[][];
  width: number;
  pages: ReadonlyMap<string, number>;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function pad(cells: readonly string[], width: number): string[] {
  const padded: string[] = [];
  for (let index = 0; index < width; index += 1) padded.push(cells[index] ?? '');
  return padded;
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

function readPages(value: unknown): Map<string, number> {
  const pages = new Map<string, number>();
  if (!Array.isArray(value)) return pages;
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { row, col, page } = entry as Partial<CellProvenance>;
    if (!isIndex(row) || !isIndex(col) || !isIndex(page) || page < 1) continue;
    pages.set(cellKey(row, col), page);
  }
  return pages;
}

/**
 * Copies the table into a rectangular grid, or returns `null` when there is nothing to
 * read. A refused `tables.ts` table (`rows: []`) is refused here the same way: an empty
 * table is not a table with no mistakes.
 */
function readGrid(table: TableQaInput | null | undefined): Grid | null {
  if (typeof table !== 'object' || table === null) return null;
  const headers = Array.isArray(table.headers) ? table.headers.map(textOf) : [];
  const rows = Array.isArray(table.rows)
    ? table.rows.map(row => (Array.isArray(row) ? row.map(textOf) : []))
    : [];
  const declared =
    typeof table.columnCount === 'number' && Number.isFinite(table.columnCount)
      ? Math.max(0, Math.trunc(table.columnCount))
      : 0;

  let width = Math.max(declared, headers.length);
  for (const row of rows) width = Math.max(width, row.length);
  if (rows.length === 0 || width === 0) return null;

  return {
    headers: pad(headers, width),
    rows: rows.map(row => pad(row, width)),
    width,
    pages: readPages(table.cells),
  };
}

/** Text of one cell by grid coordinates; row 0 is the header row. */
function cellAt(grid: Grid, row: number, col: number): string {
  if (col < 0 || col >= grid.width) return '';
  if (row === 0) return grid.headers[col] ?? '';
  return grid.rows[row - 1]?.[col] ?? '';
}

/** The page the caller attributed to one cell, or 0 when it gave none. */
function pageAt(grid: Grid, row: number, col: number): number {
  return grid.pages.get(cellKey(row, col)) ?? 0;
}

function evidenceCell(grid: Grid, row: number, col: number): TableEvidenceCell {
  return { row, col, text: cellAt(grid, row, col), page: pageAt(grid, row, col) };
}

/** The first cell of a row that carries text: the row's own label. */
function gridRowLabel(grid: Grid, row: number): string {
  for (let col = 0; col < grid.width; col += 1) {
    const text = cellAt(grid, row, col);
    if (fold(text) !== '') return text;
  }
  return '';
}

/** The column of a row's first non-empty cell: where its label stands. */
function labelColumn(grid: Grid, row: number): number {
  for (let col = 0; col < grid.width; col += 1) {
    if (fold(cellAt(grid, row, col)) !== '') return col;
  }
  return 0;
}

/** `"Revenue"`, or `column 2` when the table carries no header for the column. */
function columnName(grid: Grid, col: number): string {
  const label = (grid.headers[col] ?? '').trim();
  return label === '' ? `column ${col + 1}` : `"${label}"`;
}

// --- Row classification ----------------------------------------------------

/** Grid rows that are a labelled total or a labelled count, and so are not data. */
interface RowLabels {
  totalRows: Set<number>;
  countRows: Set<number>;
}

/**
 * Finds the rows that state a total or a count. The label is read from the row's first
 * non-empty cell, and the count labels are tried first so `Total rows` is a count rather
 * than a total.
 */
function classifyRows(grid: Grid, totalLabels: ReadonlySet<string>, countLabels: ReadonlySet<string>): RowLabels {
  const totalRows = new Set<number>();
  const countRows = new Set<number>();
  for (let row = 1; row <= grid.rows.length; row += 1) {
    const label = gridRowLabel(grid, row);
    if (label === '') continue;
    if (matchesLabel(label, countLabels)) countRows.add(row);
    else if (matchesLabel(label, totalLabels)) totalRows.add(row);
  }
  return { totalRows, countRows };
}

const DEFAULT_TOTAL_LABELS = labelSet(TOTAL_ROW_LABELS);
const DEFAULT_COUNT_LABELS = labelSet(COUNT_ROW_LABELS);
const DEFAULT_PERCENT_LABELS = labelSet(PERCENT_COLUMN_LABELS);

function defaultRowLabels(grid: Grid): RowLabels {
  return classifyRows(grid, DEFAULT_TOTAL_LABELS, DEFAULT_COUNT_LABELS);
}

function excludedRows(labels: RowLabels): Set<number> {
  return new Set<number>([...labels.totalRows, ...labels.countRows]);
}

// --- Column and row resolution --------------------------------------------

interface ColumnChoice {
  col: number;
  label: string;
  /** `label` when a header was named, `only-numeric` when the column was the only choice. */
  how: 'label' | 'only-numeric';
}

interface HeaderMatch {
  col: number;
  label: string;
  index: number;
  length: number;
}

/**
 * Headers whose text appears in the question, in the order the question mentions them.
 * A header that is only a number names no column.
 */
function findHeaderMatches(grid: Grid, question: string): HeaderMatch[] {
  const matches: HeaderMatch[] = [];
  for (let col = 0; col < grid.width; col += 1) {
    const raw = grid.headers[col] ?? '';
    const folded = fold(raw);
    if (folded === '') continue;
    if (parseTableNumber(raw) !== null) continue;
    const index = labelIndex(question, folded);
    if (index < 0) continue;
    matches.push({ col, label: raw, index, length: folded.length });
  }
  matches.sort((left, right) => left.index - right.index || right.length - left.length || left.col - right.col);
  return matches;
}

/**
 * Columns that carry numbers: at least one numeric data cell, and at least as many
 * numeric cells as other non-empty ones. A total or count row is not a data cell here.
 */
function numericColumns(grid: Grid, excluded: ReadonlySet<number>): number[] {
  const columns: number[] = [];
  for (let col = 0; col < grid.width; col += 1) {
    let numeric = 0;
    let other = 0;
    for (let row = 1; row <= grid.rows.length; row += 1) {
      if (excluded.has(row)) continue;
      const text = cellAt(grid, row, col);
      if (isMissingCell(text)) continue;
      if (parseTableNumber(text) !== null) numeric += 1;
      else other += 1;
    }
    if (numeric > 0 && numeric >= other) columns.push(col);
  }
  return columns;
}

/**
 * The column a question reads. A named header wins, and the longest named header wins
 * over a shorter one it contains (`Revenue growth` over `Revenue`). With no header named,
 * the single numeric column of the table is used; a table with two numeric columns is
 * ambiguous and resolves to nothing rather than to a guess.
 */
function resolveColumn(grid: Grid, question: string, excluded: ReadonlySet<number>): ColumnChoice | null {
  const matches = findHeaderMatches(grid, question);
  if (matches.length > 0) {
    let best = matches[0] as HeaderMatch;
    for (const match of matches) {
      if (match.length > best.length) best = match;
    }
    return { col: best.col, label: best.label, how: 'label' };
  }
  const numeric = numericColumns(grid, excluded);
  if (numeric.length === 1) {
    const col = numeric[0] as number;
    return { col, label: grid.headers[col] ?? '', how: 'only-numeric' };
  }
  return null;
}

interface RowMatch {
  row: number;
  col: number;
  text: string;
  /** Where the label stands in the question, so two labels keep the order they were asked. */
  index: number;
  length: number;
}

/**
 * Row labels from the question, one per row, in the order the question mentions them.
 * A cell that reads as a number is not a label, and a labelled total or count row is not
 * a data row: a question that says `total` matches the total row's label, which must not
 * become a value to answer from.
 */
function findRowMatches(grid: Grid, question: string, excluded: ReadonlySet<number>): RowMatch[] {
  const matches: RowMatch[] = [];
  for (let row = 1; row <= grid.rows.length; row += 1) {
    if (excluded.has(row)) continue;
    let best: RowMatch | null = null;
    for (let col = 0; col < grid.width; col += 1) {
      const text = cellAt(grid, row, col);
      const folded = fold(text);
      if (folded === '') continue;
      if (parseTableNumber(text) !== null) continue;
      const index = labelIndex(question, folded);
      if (index < 0) continue;
      if (best === null || folded.length > best.length) {
        best = { row, col, text, index, length: folded.length };
      }
    }
    if (best !== null) matches.push(best);
  }
  matches.sort((left, right) => left.index - right.index || right.length - left.length || left.row - right.row);
  return matches;
}

// --- Intent ----------------------------------------------------------------

type Intent = 'sum' | 'count' | 'compare' | 'max' | 'min' | 'lookup';

const COMPARE_PATTERNS: readonly RegExp[] = [
  /\bdifference\b/u,
  /\bdiffer\b/u,
  /\bcompare\b/u,
  /\bmore than\b/u,
  /\bless than\b/u,
  /\bhigher than\b/u,
  /\blower than\b/u,
  /\bchenh lech\b/u,
  /\bso voi\b/u,
];

const COUNT_PATTERNS: readonly RegExp[] = [
  /\bhow many\b/u,
  /\bcount\b/u,
  /\bnumber of\b/u,
  /\bso dong\b/u,
  /\bso hang\b/u,
  /\bso luong\b/u,
];

const SUM_PATTERNS: readonly RegExp[] = [
  /\btotal\b/u,
  /\bsums?\b/u,
  /\badd(?:ed)? up\b/u,
  /\baltogether\b/u,
  /\bcombined\b/u,
  /\btong\b/u,
  /\bcong\b/u,
];

const MAX_PATTERNS: readonly RegExp[] = [
  /\bmax(?:imum)?\b/u,
  /\bhighest\b/u,
  /\blargest\b/u,
  /\bbiggest\b/u,
  /\bgreatest\b/u,
  /\bmost\b/u,
  /\bcao nhat\b/u,
  /\blon nhat\b/u,
  /\bnhieu nhat\b/u,
];

const MIN_PATTERNS: readonly RegExp[] = [
  /\bmin(?:imum)?\b/u,
  /\blowest\b/u,
  /\bsmallest\b/u,
  /\bleast\b/u,
  /\bthap nhat\b/u,
  /\bnho nhat\b/u,
  /\bit nhat\b/u,
];

const LOOKUP_PATTERNS: readonly RegExp[] = [
  /\bwhat is\b/u,
  /\bwhat are\b/u,
  /\bwhat's\b/u,
  /\bhow much\b/u,
  /\bvalue\b/u,
  /\blook up\b/u,
  /\blookup\b/u,
  /\bfind\b/u,
  /\bbao nhieu\b/u,
];

const ROW_NOUN_PATTERNS: readonly RegExp[] = [
  /\brows?\b/u,
  /\brecords?\b/u,
  /\bentries\b/u,
  /\bentry\b/u,
  /\blines?\b/u,
  /\bso dong\b/u,
  /\bso hang\b/u,
];

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

/**
 * Reads the intent from the folded question. Order matters: `difference` is checked
 * before `more than` can be read as a maximum, and `number of` before `total` can be read
 * as a sum, so the more specific phrasing wins.
 */
function detectIntent(question: string): Intent | null {
  if (matchesAny(question, COMPARE_PATTERNS)) return 'compare';
  if (matchesAny(question, COUNT_PATTERNS)) return 'count';
  if (matchesAny(question, SUM_PATTERNS)) return 'sum';
  if (matchesAny(question, MAX_PATTERNS)) return 'max';
  if (matchesAny(question, MIN_PATTERNS)) return 'min';
  if (matchesAny(question, LOOKUP_PATTERNS)) return 'lookup';
  return null;
}

// --- Answer assembly -------------------------------------------------------

function unknownAnswer(reason: TableUnknownReason, detail: string, checks: TableCheck[] = []): TableAnswer {
  return { answer: null, kind: 'unknown', sum: null, count: null, compare: null, unknown: { reason, detail }, evidence: [], checks };
}

interface AnswerNumbers {
  sum?: number;
  count?: number;
  compare?: number;
}

function valueAnswer(
  kind: Exclude<TableAnswerKind, 'unknown'>,
  value: number,
  evidence: TableEvidenceCell[],
  checks: TableCheck[],
  numbers: AnswerNumbers = {},
): TableAnswer {
  return {
    answer: value,
    kind,
    sum: numbers.sum ?? null,
    count: numbers.count ?? null,
    compare: numbers.compare ?? null,
    unknown: null,
    evidence,
    checks,
  };
}

function columnDetail(column: ColumnChoice): string {
  const name = column.label.trim() === '' ? `column ${column.col + 1}` : `"${column.label}"`;
  return column.how === 'label'
    ? `Header ${name} is named in the question.`
    : `${name} is the only column in the table that carries numbers.`;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function amount(value: number): number {
  return roundTo(value, ANSWER_DECIMALS);
}

// --- Answering one question -------------------------------------------------

/**
 * Answers one question about one table.
 *
 * The intent is read first, then the column and the row labels the question names. An
 * answer that would need a cell the table does not carry, or a number the cell does not
 * hold, is refused with the reason and the check that failed rather than approximated.
 * Every answer lists the cells it used — with the page the caller attributed — and the
 * checks it ran, so a reader can go and look at the cell instead of trusting the prose.
 */
export function answerTable(question: string, table: TableQaInput): TableAnswer {
  const grid = readGrid(table);
  if (grid === null) {
    return unknownAnswer('empty-table', 'The table carries no rows, so no cell can support an answer.');
  }
  if (typeof question !== 'string') {
    return unknownAnswer('no-intent', 'The question is not text.');
  }
  const text = fold(question);
  if (text === '') {
    return unknownAnswer('no-intent', 'The question is empty.');
  }

  const intent = detectIntent(text);
  if (intent === 'compare') return compareAnswer(grid, text);
  if (intent === 'count') return countAnswer(grid, text);
  if (intent !== null) return numericAnswer(grid, text, intent);

  // No intent word: a question that names a row and a column is a lookup, which is the
  // shape a reader uses most ("Revenue for North?").
  const excluded = excludedRows(defaultRowLabels(grid));
  const column = resolveColumn(grid, text, excluded);
  if (column !== null && findRowMatches(grid, text, excluded).length > 0) {
    return numericAnswer(grid, text, 'lookup');
  }
  return unknownAnswer(
    'no-intent',
    'The question asks for no table figure this module reads. Ask for a sum, a count, a maximum, a minimum, a comparison, or one cell by row and column label.',
    [{ name: 'intent', ok: false, detail: 'No sum, count, comparison, maximum, minimum or lookup phrasing was recognised.' }],
  );
}

/** A sum, maximum, minimum or lookup: one column, and at most one named row. */
function numericAnswer(grid: Grid, question: string, intent: Exclude<Intent, 'count' | 'compare'>): TableAnswer {
  const excluded = excludedRows(defaultRowLabels(grid));
  const column = resolveColumn(grid, question, excluded);
  const rows = findRowMatches(grid, question, excluded);

  if (column !== null && rows.length > 1) {
    const named = rows.map(match => `"${match.text}"`).join(', ');
    return unknownAnswer(
      'ambiguous-row',
      `The question names more than one row (${named}); an answer of this kind names one row.`,
      [{ name: 'row-found', ok: false, detail: `Rows ${named} all appear in the question.` }],
    );
  }

  if (column !== null && rows.length === 1) {
    const match = rows[0] as RowMatch;
    const text = cellAt(grid, match.row, column.col);
    const value = parseTableNumber(text);
    const checks: TableCheck[] = [{ name: 'column-found', ok: true, detail: columnDetail(column) }];
    if (value === null) {
      checks.push({ name: 'cells-numeric', ok: false, detail: `The cell reads "${text}", which is not a number.` });
      return unknownAnswer('not-numeric', `Row "${match.text}" in ${columnName(grid, column.col)} reads "${text}", which is not a number.`, checks);
    }
    checks.push({ name: 'row-found', ok: true, detail: `Row "${match.text}" is named in the question.` });
    checks.push({ name: 'cells-numeric', ok: true, detail: 'The one cell the answer rests on reads as a number.' });
    if (intent !== 'lookup') {
      checks.push({
        name: 'row-narrowed',
        ok: true,
        detail: 'The question names a row, so the answer is that row\'s cell rather than a column aggregate.',
      });
    }
    return valueAnswer('value', amount(value), [evidenceCell(grid, match.row, column.col)], checks);
  }

  if (column === null) {
    return unknownAnswer(
      'no-column',
      'No header label in the question names a column, and the table has no single numeric column to fall back on.',
      [{ name: 'column-found', ok: false, detail: 'No header label from the question matches a column.' }],
    );
  }

  if (intent === 'lookup') {
    return unknownAnswer(
      'no-row',
      `The column ${columnName(grid, column.col)} is known but the question names no row label.`,
      [
        { name: 'column-found', ok: true, detail: columnDetail(column) },
        { name: 'row-found', ok: false, detail: 'No data-row label from the table appears in the question.' },
      ],
    );
  }

  return columnAggregate(grid, column, excluded, intent);
}

interface ColumnScan {
  /** Rows that carry a readable number, in row order. */
  values: { row: number; value: number }[];
  /** Cells that carry something, but not a number. */
  unreadable: { row: number; text: string }[];
  /** Blank cells, which add nothing and are not a defect. */
  missing: number;
  /** Excluded rows that stated a number, so the reader knows the total was skipped. */
  skippedRows: number;
}

function scanColumn(grid: Grid, col: number, excluded: ReadonlySet<number>): ColumnScan {
  const values: { row: number; value: number }[] = [];
  const unreadable: { row: number; text: string }[] = [];
  let missing = 0;
  let skippedRows = 0;

  for (let row = 1; row <= grid.rows.length; row += 1) {
    const text = cellAt(grid, row, col);
    const value = parseTableNumber(text);
    if (excluded.has(row)) {
      if (value !== null) skippedRows += 1;
      continue;
    }
    if (isMissingCell(text)) {
      missing += 1;
      continue;
    }
    if (value === null) {
      unreadable.push({ row, text });
      continue;
    }
    values.push({ row, value });
  }

  return { values, unreadable, missing, skippedRows };
}

/** A sum, maximum or minimum over one column. */
function columnAggregate(
  grid: Grid,
  column: ColumnChoice,
  excluded: ReadonlySet<number>,
  intent: 'sum' | 'max' | 'min',
): TableAnswer {
  const scan = scanColumn(grid, column.col, excluded);
  const checks: TableCheck[] = [{ name: 'column-found', ok: true, detail: columnDetail(column) }];

  if (scan.unreadable.length > 0) {
    const first = scan.unreadable[0] as { row: number; text: string };
    checks.push({
      name: 'cells-numeric',
      ok: false,
      detail: `${scan.unreadable.length} cell(s) in ${columnName(grid, column.col)} are text, starting with "${first.text}".`,
    });
    return unknownAnswer(
      'not-numeric',
      `The column ${columnName(grid, column.col)} mixes numbers and text, so a figure over it would be a guess.`,
      checks,
    );
  }

  if (scan.skippedRows > 0) {
    checks.push({
      name: 'total-row-skipped',
      ok: true,
      detail: `${scan.skippedRows} labelled total or count row(s) were left out; their cells are not data.`,
    });
  }
  checks.push({
    name: 'cells-numeric',
    ok: true,
    detail: `${scan.values.length} numeric cell(s) read and ${scan.missing} blank cell(s) skipped.`,
  });

  if (scan.values.length === 0) {
    return unknownAnswer('no-cells', `The column ${columnName(grid, column.col)} carries no number.`, checks);
  }

  if (intent === 'max' || intent === 'min') {
    let best = scan.values[0] as { row: number; value: number };
    for (const candidate of scan.values) {
      if (intent === 'max' ? candidate.value > best.value : candidate.value < best.value) best = candidate;
    }
    checks.push({
      name: 'extreme-cell',
      ok: true,
      detail: `The ${intent === 'max' ? 'largest' : 'smallest'} of the ${scan.values.length} value(s) is in ${columnName(grid, column.col)}.`,
    });
    return valueAnswer('value', amount(best.value), [evidenceCell(grid, best.row, column.col)], checks);
  }

  let total = 0;
  for (const entry of scan.values) total += entry.value;
  const sum = amount(total);
  checks.push({ name: 'sum-added', ok: true, detail: `${scan.values.length} cell(s) added.` });
  return valueAnswer('sum', sum, scan.values.map(entry => evidenceCell(grid, entry.row, column.col)), checks, { sum });
}

/** How many rows carry one value, or how many data rows the table has. */
function countAnswer(grid: Grid, question: string): TableAnswer {
  const excluded = excludedRows(defaultRowLabels(grid));
  const column = resolveColumn(grid, question, excluded);
  const target = findValueTarget(grid, question, excluded);
  const checks: TableCheck[] = [];

  if (target !== null) {
    const col = column?.col ?? target.col;
    const wanted = fold(target.text);
    const cells: TableEvidenceCell[] = [];
    for (let row = 1; row <= grid.rows.length; row += 1) {
      if (excluded.has(row)) continue;
      if (fold(cellAt(grid, row, col)) !== wanted) continue;
      cells.push(evidenceCell(grid, row, col));
    }
    if (column !== null) checks.push({ name: 'column-found', ok: true, detail: columnDetail(column) });
    checks.push({
      name: 'rows-matched',
      ok: true,
      detail: `${cells.length} row(s) carry "${target.text}" in ${columnName(grid, col)}.`,
    });
    return valueAnswer('count', cells.length, cells, checks, { count: cells.length });
  }

  if (!matchesAny(question, ROW_NOUN_PATTERNS)) {
    return unknownAnswer('no-row', 'The question names no value to match and does not ask how many rows the table has.', [
      { name: 'rows-matched', ok: false, detail: 'No cell value from the table appears in the question.' },
    ]);
  }

  const cells: TableEvidenceCell[] = [];
  for (let row = 1; row <= grid.rows.length; row += 1) {
    if (excluded.has(row)) continue;
    cells.push(evidenceCell(grid, row, labelColumn(grid, row)));
  }
  checks.push({
    name: 'rows-matched',
    ok: true,
    detail: `The table has ${cells.length} data row(s); the header and labelled total or count rows are excluded.`,
  });
  return valueAnswer('count', cells.length, cells, checks, { count: cells.length });
}

/**
 * The value a count question asks about: a row label first, then a numeric cell whose
 * text appears in the question, so "how many rows have 10 in Qty" reads the cell.
 */
function findValueTarget(grid: Grid, question: string, excluded: ReadonlySet<number>): { text: string; col: number } | null {
  const labels = findRowMatches(grid, question, excluded);
  if (labels.length > 0) {
    const first = labels[0] as RowMatch;
    return { text: first.text, col: first.col };
  }

  let best: { text: string; col: number; index: number; length: number } | null = null;
  for (let row = 1; row <= grid.rows.length; row += 1) {
    if (excluded.has(row)) continue;
    for (let col = 0; col < grid.width; col += 1) {
      const text = cellAt(grid, row, col);
      if (parseTableNumber(text) === null) continue;
      const folded = fold(text);
      const index = labelIndex(question, folded);
      if (index < 0) continue;
      if (best === null || index < best.index || (index === best.index && folded.length > best.length)) {
        best = { text, col, index, length: folded.length };
      }
    }
  }
  return best === null ? null : { text: best.text, col: best.col };
}

/** The difference between two rows of one column: the first row in the question minus the second. */
function compareAnswer(grid: Grid, question: string): TableAnswer {
  const excluded = excludedRows(defaultRowLabels(grid));
  const column = resolveColumn(grid, question, excluded);
  const rows = findRowMatches(grid, question, excluded);

  if (rows.length < 2) {
    return unknownAnswer('no-cells', 'A comparison needs two row labels from the table, and fewer than two were named.', [
      { name: 'two-rows-found', ok: false, detail: `The question names ${rows.length} row label(s).` },
    ]);
  }

  const left = rows[0] as RowMatch;
  const right = rows[1] as RowMatch;
  const col = column?.col ?? commonNumericColumn(grid, left.row, right.row);
  if (col === null) {
    return unknownAnswer(
      'no-column',
      'The comparison names two rows but no column, and their only common numeric column cannot be identified.',
      [{ name: 'column-found', ok: false, detail: 'No single column carries a number for both named rows.' }],
    );
  }

  const leftText = cellAt(grid, left.row, col);
  const rightText = cellAt(grid, right.row, col);
  const leftValue = parseTableNumber(leftText);
  const rightValue = parseTableNumber(rightText);
  const checks: TableCheck[] = [];
  if (column !== null) checks.push({ name: 'column-found', ok: true, detail: columnDetail(column) });
  if (leftValue === null || rightValue === null) {
    const bad = leftValue === null ? leftText : rightText;
    checks.push({ name: 'cells-numeric', ok: false, detail: `A compared cell reads "${bad}", which is not a number.` });
    return unknownAnswer('not-numeric', `A comparison needs two numbers; "${bad}" is not one.`, checks);
  }

  const difference = amount(leftValue - rightValue);
  checks.push({
    name: 'two-rows-found',
    ok: true,
    detail: `Row "${left.text}" minus row "${right.text}" in ${columnName(grid, col)}.`,
  });
  checks.push({ name: 'cells-numeric', ok: true, detail: 'Both compared cells read as numbers.' });
  return valueAnswer('compare', difference, [evidenceCell(grid, left.row, col), evidenceCell(grid, right.row, col)], checks, {
    compare: difference,
  });
}

/** The one column whose cells are numbers for both rows, or `null` when there is none or several. */
function commonNumericColumn(grid: Grid, rowA: number, rowB: number): number | null {
  let found: number | null = null;
  for (let col = 0; col < grid.width; col += 1) {
    if (parseTableNumber(cellAt(grid, rowA, col)) === null) continue;
    if (parseTableNumber(cellAt(grid, rowB, col)) === null) continue;
    if (found !== null) return null;
    found = col;
  }
  return found;
}

// --- Arithmetic ------------------------------------------------------------

/**
 * Checks the arithmetic a table states about itself.
 *
 * Three claims are read from the table and compared with its own rows:
 * 1. a labelled **total row** (`Total`, `Cộng`, `Tổng`, `Subtotal`) states, column by
 *    column, what the rows above it add up to; a column the total leaves non-numeric
 *    states nothing and is skipped, and a labelled total or count row above is not data;
 * 2. a labelled **percentage column** adds up to 100 within `percentTolerance`;
 * 3. a labelled **count row** (`Rows`, `Số dòng`) states how many data rows the table
 *    has, where a data row is neither the header, the count row, nor a total row.
 *
 * The report is `ok` when the table made no claim these checks could contradict. An
 * empty table is refused rather than passed: zero claims verified is not a clean bill of
 * health, and a caller that reads `ok: true` would treat it as one.
 */
export function checkArithmetic(table: TableQaInput, options: ArithmeticOptions = {}): ArithmeticReport {
  const grid = readGrid(table);
  if (grid === null) {
    return {
      ok: false,
      problems: [
        {
          kind: 'empty-table',
          row: -1,
          expected: 0,
          actual: 0,
          detail: 'The table carries no rows, so there is no arithmetic to verify; an empty table is not a pass.',
        },
      ],
    };
  }

  const totalLabels = labelSet(options.totalLabels ?? TOTAL_ROW_LABELS);
  const countLabels = labelSet(options.countLabels ?? COUNT_ROW_LABELS);
  const percentLabels = labelSet(options.percentLabels ?? PERCENT_COLUMN_LABELS);
  const percentTolerance = readTolerance(options.percentTolerance, DEFAULT_PERCENT_TOLERANCE);
  const countTolerance = readTolerance(options.countTolerance, DEFAULT_COUNT_TOLERANCE);

  const labels = classifyRows(grid, totalLabels, countLabels);
  const excluded = excludedRows(labels);
  const problems: ArithmeticProblem[] = [];

  // 1. A labelled total row against the rows above it.
  for (const totalRow of [...labels.totalRows].sort((left, right) => left - right)) {
    const label = gridRowLabel(grid, totalRow);
    for (let col = 0; col < grid.width; col += 1) {
      const stated = parseTableNumber(cellAt(grid, totalRow, col));
      if (stated === null) continue;
      const above = sumAbove(grid, totalRow, col, excluded);
      if (above.counted === 0) continue;
      const actual = amount(stated);
      const expected = amount(above.total);
      if (Math.abs(actual - expected) <= SUM_EPSILON) continue;
      const unreadable = above.unreadable > 0 ? `; ${above.unreadable} cell(s) above could not be read` : '';
      problems.push({
        kind: 'total',
        row: totalRow,
        expected,
        actual,
        detail: `Total row "${label}" states ${actual} in ${columnName(grid, col)}, but the ${above.counted} row(s) above add to ${expected}${unreadable}.`,
      });
    }
  }

  // 2. A labelled percentage column against 100.
  for (let col = 0; col < grid.width; col += 1) {
    const header = grid.headers[col] ?? '';
    if (!isPercentHeader(header, percentLabels)) continue;
    let total = 0;
    let counted = 0;
    for (let row = 1; row <= grid.rows.length; row += 1) {
      if (excluded.has(row)) continue;
      const value = parseTableNumber(cellAt(grid, row, col));
      if (value === null) continue;
      total += value;
      counted += 1;
    }
    if (counted === 0) continue;
    const actual = amount(total);
    if (Math.abs(actual - PERCENT_WHOLE) <= percentTolerance) continue;
    problems.push({
      kind: 'percent',
      row: 0,
      expected: PERCENT_WHOLE,
      actual,
      detail: `Column ${columnName(grid, col)} sums to ${actual}, not ${PERCENT_WHOLE} within a tolerance of ${percentTolerance}.`,
    });
  }

  // 3. A stated count against the rows that are data.
  const dataRows = countDataRows(grid, excluded);
  for (const countRow of [...labels.countRows].sort((left, right) => left - right)) {
    const stated = statedCount(grid, countRow, countLabels);
    if (stated === null) continue;
    if (Math.abs(stated - dataRows) <= countTolerance) continue;
    const label = gridRowLabel(grid, countRow);
    problems.push({
      kind: 'count',
      row: countRow,
      expected: dataRows,
      actual: stated,
      detail: `Row "${label}" states ${stated} rows, but the table has ${dataRows} data row(s); the header and labelled total or count rows are excluded.`,
    });
  }

  return { ok: problems.length === 0, problems };
}

/** True when a header labels a percentage column: a `%` anywhere, or a listed label. */
function isPercentHeader(text: string, labels: ReadonlySet<string>): boolean {
  const folded = normaliseLabel(text);
  if (folded === '') return false;
  if (/[%％]/u.test(folded)) return true;
  if (labels.has(folded)) return true;
  for (const label of labels) {
    if (label === '') continue;
    if (folded.startsWith(`${label} `) || folded.endsWith(` ${label}`)) return true;
  }
  return false;
}

interface SumAbove {
  total: number;
  counted: number;
  unreadable: number;
}

/** What the data rows above one total row add up to in one column. */
function sumAbove(grid: Grid, totalRow: number, col: number, excluded: ReadonlySet<number>): SumAbove {
  let total = 0;
  let counted = 0;
  let unreadable = 0;
  for (let row = 1; row < totalRow; row += 1) {
    if (excluded.has(row)) continue;
    const text = cellAt(grid, row, col);
    if (isMissingCell(text)) continue;
    const value = parseTableNumber(text);
    if (value === null) {
      unreadable += 1;
      continue;
    }
    total += value;
    counted += 1;
  }
  return { total, counted, unreadable };
}

/** The number of data rows: every row that is neither the header nor a labelled total or count. */
function countDataRows(grid: Grid, excluded: ReadonlySet<number>): number {
  let rows = 0;
  for (let row = 1; row <= grid.rows.length; row += 1) {
    if (!excluded.has(row)) rows += 1;
  }
  return rows;
}

/** The number a count row states: its first numeric cell that is not the label itself. */
function statedCount(grid: Grid, countRow: number, countLabels: ReadonlySet<string>): number | null {
  for (let col = 0; col < grid.width; col += 1) {
    const text = cellAt(grid, countRow, col);
    if (matchesLabel(text, countLabels)) continue;
    const value = parseTableNumber(text);
    if (value !== null) return value;
  }
  return null;
}

function readTolerance(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}
