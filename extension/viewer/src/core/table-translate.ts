/**
 * Cell-by-cell table translation (backlog G12).
 *
 * A table is structure plus text. Translating its cells wholesale — one call per
 * line of the page — destroys both: a translator may merge two cells into one
 * sentence, split a number, or rename a header into something the reader cannot
 * line up with the data below it. This module keeps the structure and changes only
 * the text that a translator is allowed to change.
 *
 * Contract:
 * - The input is the `Table` shape `src/core/tables.ts` returns. The translator is
 *   injected as `translate(cell): Promise<string>`, so this module owns splitting,
 *   ordering and caching only, never the transport.
 * - Cells are walked in reading order: the header row first, then each data row from
 *   left to right. Row `0` is the header row when the table has one, matching
 *   `TableSpan.row` in `tables.ts`; a table with no header row numbers its data rows
 *   from 0.
 * - A cell that cannot change without breaking its meaning stays byte-identical:
 *   empty cells, cells with no letters left once currency marks and numeric dates are
 *   removed (plain numbers, money, percentages, times, punctuation), and the header
 *   row unless `options.translateHeaders` is set. Those are never sent to the
 *   translator.
 * - Identical cell texts share one translation: the first occurrence is translated and
 *   every later occurrence reuses the result, so a repeated "Total" costs one call.
 *   The cache is keyed on the cell text exactly as it appears in the table.
 * - A cell whose translation fails (the promise rejects, throws synchronously, or
 *   returns no text) keeps its source text and is reported in `failures`. Nothing is
 *   dropped and the call itself never throws for a failing cell.
 * - `headers`, `rows`, `rowCount`, `columnCount` and `spans` keep their shape: the
 *   same row and column counts, the same spans, in the same order. The input table is
 *   not mutated.
 * - Deterministic: no clock, no randomness, no locale. Calls run in reading order, one
 *   at a time, so the same table and translator always produce the same counts.
 */

import type { Table, TableSpan } from './tables';

/** Translates one cell's text. A rejection is reported, never thrown out of `translateTable`. */
export type TableTranslator = (cell: string) => Promise<string>;

export interface TableTranslateOptions {
  /**
   * Translate the header row too. Off by default: a header keeps its source text so a
   * reviewer can line translated data up with the original columns.
   */
  translateHeaders?: boolean;
}

/**
 * Cell counts of one run.
 *
 * The four fields partition the cells that were walked:
 * `cells === translated + cached + skipped + failures.length`.
 * `translated` counts cells a translator call produced; `cached` counts cells that
 * reused an earlier translation of the same text; `skipped` counts cells kept
 * byte-identical on purpose (empty, numeric/date/currency, preserved header).
 */
export interface TableTranslateStats {
  /** Every cell slot walked, header row included. */
  cells: number;
  /** Cells whose text came from a fresh translator call. */
  translated: number;
  /** Cells kept byte-identical: empty, numeric/date/currency, or a preserved header. */
  skipped: number;
  /** Cells that reused an earlier translation of the same text (no call made). */
  cached: number;
}

/** One cell that could not be translated and kept its source text. */
export interface TableTranslateFailure {
  /** 0-based row index; the header row is row 0. */
  row: number;
  /** 0-based column index. */
  col: number;
  /** Source text the cell keeps. */
  source: string;
  /** Why the translation was refused, for a reviewer or a retry. */
  error: string;
}

export interface TableTranslateResult {
  /** A new table with the same shape as the input. */
  table: Table;
  stats: TableTranslateStats;
  failures: TableTranslateFailure[];
}

/** Address of one cell. `row` 0 is the header row. */
export interface TableCellKey {
  row: number;
  col: number;
}

/** One cell whose text differs between two tables. */
export interface TableCellChange extends TableCellKey {
  before: string;
  after: string;
}

/** Currency symbols that carry no words to translate. */
const CURRENCY_SYMBOL = /[$€£¥₫₽₹₩₪₺₴₦₱฿]/gu;

/** ISO 4217 codes, kept whole: `USD 12` and `12 USD` are still money, not prose. */
const CURRENCY_CODE = /(?<![\p{L}])(?:USD|EUR|GBP|JPY|VND|CNY|KRW|INR|AUD|CAD|CHF|SGD|THB|MYR|IDR|PHP|RUB|BRL|MXN|NZD|SEK|NOK|DKK|PLN|TRY|ZAR|HKD|TWD|AED|SAR|ILS|CZK|HUF|RON)(?![\p{L}])/gu;

/** `1.050.000đ` and `1 000 ₫`: the local mark is written after the amount. */
const CURRENCY_TRAILING = /(?:đ|₫)\s*$/iu;

/** An ISO instant: the `T` and `Z` are letters, so the plain letter test would miss it. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u;

/** A numeric date written any of the usual ways: 2024-01-31, 31/01/2024, 1.31.2024. */
const NUMERIC_DATE = /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})$/u;

/** A clock time with an optional seconds part. */
const CLOCK = /^\d{1,2}:\d{2}(?::\d{2})?$/u;

const LETTER = /\p{L}/u;

/**
 * Translates a table cell by cell.
 *
 * See the module contract for the skip rules, the cache and the failure handling. A
 * translator that rejects leaves the cell's source text in place; the run continues
 * with the next cell, so one bad cell never costs the rest of the table.
 *
 * ```ts
 * const { table, stats, failures } = await translateTable(table, translate, {});
 * ```
 */
export async function translateTable(
  table: Table,
  translate: TableTranslator,
  options: TableTranslateOptions = {},
): Promise<TableTranslateResult> {
  const source = readGrid(table);
  // Row 0 is the header row only when it carries a header cell; a table with no
  // headers has no row to preserve.
  const preserveHeader = options?.translateHeaders !== true && source.headers.length > 0;
  const cache = new Map<string, string>();
  const failures: TableTranslateFailure[] = [];
  const stats: TableTranslateStats = { cells: 0, translated: 0, skipped: 0, cached: 0 };

  const translateCell = async (text: string, row: number, col: number): Promise<string> => {
    stats.cells += 1;
    if (text === '') {
      stats.skipped += 1;
      return text;
    }
    if (row === 0 && preserveHeader) {
      stats.skipped += 1;
      return text;
    }
    if (isFixedCell(text)) {
      stats.skipped += 1;
      return text;
    }

    const remembered = cache.get(text);
    if (remembered !== undefined) {
      stats.cached += 1;
      return remembered;
    }

    let translated: unknown;
    try {
      translated = await translate(text);
    } catch (error) {
      failures.push({ row, col, source: text, error: describeError(error) });
      return text;
    }
    if (typeof translated !== 'string' || translated.trim() === '') {
      failures.push({ row, col, source: text, error: 'The translator returned no text.' });
      return text;
    }

    cache.set(text, translated);
    stats.translated += 1;
    return translated;
  };

  const headers: string[] = [];
  for (let col = 0; col < source.headers.length; col += 1) {
    headers.push(await translateCell(source.headers[col] ?? '', 0, col));
  }

  const rows: string[][] = [];
  for (let index = 0; index < source.rows.length; index += 1) {
    const row = source.rows[index] ?? [];
    const rowNumber = rowNumberOf(source, index);
    const translatedRow: string[] = [];
    for (let col = 0; col < row.length; col += 1) {
      translatedRow.push(await translateCell(row[col] ?? '', rowNumber, col));
    }
    rows.push(translatedRow);
  }

  return { table: copyTable(table, { headers, rows }), stats, failures };
}

/**
 * Reports every cell whose text differs between two tables.
 *
 * The comparison runs over the union of both shapes: row 0 is the header row when the
 * table has one, and a cell one side does not have compares as an empty string, so an
 * added or removed cell is reported as a change instead of vanishing. Changes are in
 * reading order, which is the order a reviewer can walk them in; two equal tables
 * report nothing.
 */
export function diffTable(before: Table, after: Table): TableCellChange[] {
  const from = readGrid(before);
  const to = readGrid(after);
  const rowCount = Math.max(rowSpan(from), rowSpan(to));
  const columnCount = Math.max(widthOf(from), widthOf(to));

  const changes: TableCellChange[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < columnCount; col += 1) {
      const beforeText = cellAt(from, row, col);
      const afterText = cellAt(to, row, col);
      if (beforeText !== afterText) changes.push({ row, col, before: beforeText, after: afterText });
    }
  }
  return changes;
}

/**
 * Applies only the accepted cells of `after` to `before`.
 *
 * `accepted` is usually a subset of `diffTable(before, after)`; only its `row`/`col`
 * coordinates are read, and the value always comes from `after`, so a stale `after`
 * text in the selector cannot leak into the result. A key outside either table is
 * ignored, which keeps the shape — row and column counts, spans — exactly as `before`
 * has it. The returned table is a copy; neither input is mutated.
 */
export function mergeTable(before: Table, after: Table, accepted: readonly TableCellKey[]): Table {
  const target = readGrid(before);
  const source = readGrid(after);
  const merged: Grid = { headers: [...target.headers], rows: target.rows.map(row => [...row]) };

  for (const key of Array.isArray(accepted) ? accepted : []) {
    if (typeof key !== 'object' || key === null) continue;
    const { row, col } = key;
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0) continue;
    // Both tables must have the cell: writing into a row `before` lacks, or blanking a
    // cell `after` lacks, would change the structure instead of merging text.
    if (!hasCell(target, row, col) || !hasCell(source, row, col)) continue;
    writeCell(merged, row, col, cellAt(source, row, col));
  }

  return copyTable(before, merged);
}

/** A table's text as this module walks it: the header row and the data rows. */
interface Grid {
  headers: string[];
  rows: string[][];
}

function readGrid(table: Table | null | undefined): Grid {
  const source = (table ?? {}) as Partial<Table>;
  return {
    headers: readCells(source.headers),
    rows: Array.isArray(source.rows) ? source.rows.map(readCells) : [],
  };
}

function readCells(cells: readonly unknown[] | undefined): string[] {
  return Array.isArray(cells) ? cells.map(cell => (typeof cell === 'string' ? cell : '')) : [];
}

/** The header row counts as a row only when it carries a cell. */
function rowSpan(grid: Grid): number {
  return grid.rows.length + (grid.headers.length > 0 ? 1 : 0);
}

function widthOf(grid: Grid): number {
  let width = grid.headers.length;
  for (const row of grid.rows) width = Math.max(width, row.length);
  return width;
}

/** Index of `row` inside `grid.rows`, or `null` when it is the header row. */
function dataRowIndex(grid: Grid, row: number): number | null {
  if (row === 0 && grid.headers.length > 0) return null;
  return grid.headers.length > 0 ? row - 1 : row;
}

/** Table row number of the data row at `index`; the inverse of {@link dataRowIndex}. */
function rowNumberOf(grid: Grid, index: number): number {
  return grid.headers.length > 0 ? index + 1 : index;
}

function cellAt(grid: Grid, row: number, col: number): string {
  const index = dataRowIndex(grid, row);
  if (index === null) return grid.headers[col] ?? '';
  return grid.rows[index]?.[col] ?? '';
}

function hasCell(grid: Grid, row: number, col: number): boolean {
  const index = dataRowIndex(grid, row);
  if (index === null) return col < grid.headers.length;
  const cells = grid.rows[index];
  return cells !== undefined && col < cells.length;
}

function writeCell(grid: Grid, row: number, col: number, value: string): void {
  const index = dataRowIndex(grid, row);
  if (index === null) {
    grid.headers[col] = value;
    return;
  }
  const cells = grid.rows[index];
  if (cells !== undefined) cells[col] = value;
}

/** Copies the input table's shape and swaps in the new text. */
function copyTable(table: Table, grid: Grid): Table {
  const source = (table ?? {}) as Partial<Table>;
  return {
    ...source,
    headers: grid.headers,
    rows: grid.rows,
    rowCount: countOr(source.rowCount, rowSpan(grid)),
    columnCount: countOr(source.columnCount, widthOf(grid)),
    spans: copySpans(source.spans),
    confidence: typeof source.confidence === 'number' && Number.isFinite(source.confidence) ? source.confidence : 0,
    reasons: Array.isArray(source.reasons) ? [...source.reasons] : [],
  };
}

function copySpans(spans: readonly TableSpan[] | undefined): TableSpan[] {
  if (!Array.isArray(spans)) return [];
  const copied: TableSpan[] = [];
  for (const span of spans) {
    if (typeof span !== 'object' || span === null) continue;
    const { row, col, colSpan } = span;
    if (!Number.isInteger(row) || !Number.isInteger(col) || !Number.isInteger(colSpan)) continue;
    copied.push({ row, col, colSpan });
  }
  return copied;
}

function countOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * True when a cell must stay byte-identical.
 *
 * A cell is fixed when nothing in it is left to translate: it is empty, it is a
 * numeric date, instant or clock time, or every letter disappears once currency
 * symbols, ISO codes and a trailing local mark are removed. That covers `1,250`,
 * `$1,250.00`, `12%`, `(980)`, `31/01/2024`, `1.050.000đ` and `—`, while any cell that
 * still holds a word ("1,250 km") is translated.
 */
function isFixedCell(text: string): boolean {
  if (text === '') return true;
  if (ISO_INSTANT.test(text) || NUMERIC_DATE.test(text) || CLOCK.test(text)) return true;
  const remainder = text.replace(CURRENCY_SYMBOL, ' ').replace(CURRENCY_CODE, ' ').replace(CURRENCY_TRAILING, ' ').trim();
  return !LETTER.test(remainder);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message !== '' ? error.message : error.name;
  if (typeof error === 'string' && error !== '') return error;
  return 'The translator failed.';
}
