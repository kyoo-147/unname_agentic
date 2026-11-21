/**
 * Table export (RFC4180 CSV, pure-TS OOXML `.xlsx`) and LaTeX `.tex` formula bundle exporter
 * (backlog item H08).
 *
 * Contract:
 * - Pure, deterministic, browser- and Node-safe: no `node:*` imports, no DOM access, no clock,
 *   no randomness.
 * - Uses a zero-dependency pure-TypeScript STORE ZIP writer with IEEE 802.3 CRC32, local file
 *   headers, central directory headers, and End of Central Directory (EOCD) record, emitting
 *   UTF-8 OPC/OOXML parts starting with `[Content_Types].xml`.
 * - Preserves table row/column structure, UTF-8 Vietnamese/CJK strings, numeric vs string cell
 *   typing, and `<mergeCells>` for `colSpan` and `rowSpan` merged cells.
 * - Exports formulas detected by `src/core/formulas.ts` into valid LaTeX `.tex` documents that
 *   preserve block/page provenance and round-trip cleanly through `segmentText` / `detectFormulas`.
 */

import { detectFormulas } from '../core/formulas';
import type { FormulaBlockHit, FormulaBlockInput, MathSegment } from '../core/formulas';
import type { Table, TableReason, TableSpan } from '../core/tables';
import { sanitizeFilename } from './download';

// --- Public constants ----------------------------------------------------

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME = 'text/csv;charset=utf-8';
export const TEX_MIME = 'application/x-tex;charset=utf-8';

// --- Public types --------------------------------------------------------

/** Extended span descriptor supporting both horizontal (`colSpan`) and vertical (`rowSpan`) merges. */
export interface TableCellSpan extends TableSpan {
  /** Number of rows spanned vertically (1-based count; defaults to 1). */
  rowSpan?: number;
}

/**
 * Table shape accepted by H08 exporters.
 *
 * Any `Table` returned by `extractTable` in `src/core/tables.ts` is assignable directly, while
 * callers may also attach `id`, `page`, `title`, and `rowSpan` spans.
 */
export interface ExportableTable
  extends Omit<Table, 'spans' | 'rowCount' | 'columnCount' | 'confidence' | 'reasons'> {
  id?: string;
  page?: number;
  title?: string;
  rowCount?: number;
  columnCount?: number;
  spans?: readonly TableCellSpan[];
  confidence?: number;
  reasons?: readonly TableReason[];
}

/** Predicate to select a subset of extracted tables for export. */
export interface TableSelection {
  /** Keep only tables whose `id` is in this list (empty list selects nothing). */
  ids?: readonly string[];
  /** Keep only tables whose 1-based `page` is in this list (empty list selects nothing). */
  pages?: readonly number[];
  /** Exclude empty or refused (`not-a-table`) tables. Defaults to `true`. */
  excludeEmpty?: boolean;
}

export interface CsvExportOptions {
  /** Prepend UTF-8 BOM (`\uFEFF`) for Excel compatibility. Defaults to `false`. */
  bom?: boolean;
  /** Record terminator; RFC 4180 defaults to `\r\n`. */
  lineEnding?: '\r\n' | '\n';
  /** Append trailing line ending after the final row. Defaults to `false`. */
  trailingNewline?: boolean;
  /** Include the header row when present. Defaults to `true`. */
  includeHeaders?: boolean;
  /** Repeat anchor cell value into covered merge slots instead of leaving them empty. Defaults to `false`. */
  repeatMergedValues?: boolean;
}

export interface SelectedCsvExportOptions extends CsvExportOptions {
  selection?: TableSelection;
}

export interface MultiCsvExportOptions extends SelectedCsvExportOptions {
  /** Separator placed between multiple tables in combined CSV output. Defaults to a blank line. */
  tableSeparator?: string;
}

export interface SelectedCsvFile {
  id?: string;
  page?: number;
  title?: string;
  filename: string;
  csv: string;
}

/**
 * How cell strings are classified as OOXML numeric (`t="n"`) vs shared string (`t="s"`):
 * - `'strict'` (default): unformatted finite numbers within IEEE-754 safe integer bounds without leading zeros.
 * - `'grouped'`: also recognises English comma-grouped numbers like `1,250`.
 * - `'none'`: keep all non-empty cells as shared strings.
 */
export type NumberDetectionMode = 'strict' | 'grouped' | 'none';

export interface XlsxExportOptions {
  selection?: TableSelection;
  numberDetection?: NumberDetectionMode;
  /** Apply bold styling to the header row when headers exist. Defaults to `true`. */
  styleHeaders?: boolean;
  /** Freeze the header row (`ySplit="1"`) when headers exist. Defaults to `false`. */
  freezeHeader?: boolean;
  /** Fallback prefix used when a table has neither `title` nor `id`. Defaults to `'Table'`. */
  defaultSheetName?: string;
}

export interface ZipStoreEntry {
  name: string;
  data: Uint8Array;
}

/** Block input for formula extraction, optionally carrying 1-based `page` metadata. */
export interface FormulaSourceBlock extends FormulaBlockInput {
  page?: number;
  title?: string;
}

export interface FormulaSelectionOptions {
  blockIds?: readonly string[];
  pages?: readonly number[];
  kinds?: readonly MathSegment['kind'][];
  /** Drop duplicate `(kind, latex)` pairs after the first occurrence. Defaults to `false`. */
  deduplicate?: boolean;
}

export type LatexDisplayEnvironment = 'brackets' | 'equation' | 'equation*' | 'dollars';
export type LatexInlineDelimiter = 'parens' | 'dollars';

export interface LatexExportOptions extends FormulaSelectionOptions {
  title?: string;
  author?: string;
  documentClass?: string;
  /** Include `\usepackage[utf8]{inputenc}` and `\usepackage[T1]{fontenc}`. Defaults to `true`. */
  utf8?: boolean;
  /** Wrap output in `\documentclass ... \begin{document} ... \end{document}`. Defaults to `true`. */
  standalone?: boolean;
  /** Include `% Page ..., Block ...` provenance comments above each formula. Defaults to `true`. */
  includeMetadataComments?: boolean;
  displayEnvironment?: LatexDisplayEnvironment;
  inlineDelimiter?: LatexInlineDelimiter;
}

export interface ExportedFormula {
  index: number;
  blockIndex: number;
  blockId?: string;
  page?: number;
  kind: MathSegment['kind'];
  source: string;
  latex: string;
}

export interface LatexBundleResult {
  tex: string;
  formulas: ExportedFormula[];
}

// --- Pure-TS CRC32 & STORE ZIP writer ------------------------------------

const ZIP_LOCAL_FILE_HEADER_SIG = 0x04034b50;
const ZIP_CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_VERSION_NEEDED = 20;
const ZIP_VERSION_MADE_BY = 20;
const ZIP_FLAG_UTF8 = 0x0800;
const ZIP_METHOD_STORE = 0;
const ZIP_DOS_TIME = 0x0000;
const ZIP_DOS_DATE = 0x5821; // Deterministic 2024-01-01 00:00:00

const CRC32_TABLE = buildCrc32Table();
const UTF8_ENCODER = new TextEncoder();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (0xedb88320 ^ (crc >>> 1)) >>> 0 : crc >>> 1;
    }
    table[index] = crc;
  }
  return table;
}

/** Computes IEEE 802.3 CRC-32 as an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    const lookup = CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = (lookup ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface PreparedZipEntry {
  nameBytes: Uint8Array;
  data: Uint8Array;
  crc: number;
  localOffset: number;
}

function normalizeZipEntryName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Builds a deterministic, uncompressed (method 0 / STORE) ZIP archive in pure TypeScript.
 *
 * Emits standard local file headers, central directory headers, UTF-8 general-purpose bit flag
 * (`0x0800`), IEEE CRC-32 checksums, and an End of Central Directory (EOCD) record.
 */
export function buildStoreZip(entries: readonly ZipStoreEntry[]): Uint8Array {
  if (entries.length > 0xffff) {
    throw new Error(`ZIP archive supports at most 65535 entries in standard EOCD; got ${entries.length}.`);
  }

  const prepared: PreparedZipEntry[] = [];
  let localSectionSize = 0;
  let centralDirSize = 0;

  for (const entry of entries) {
    const normalizedName = normalizeZipEntryName(entry.name);
    if (normalizedName.length === 0) {
      throw new Error('ZIP entry name must not be empty.');
    }
    const nameBytes = UTF8_ENCODER.encode(normalizedName);
    if (nameBytes.length > 0xffff) {
      throw new Error(`ZIP entry name exceeds 65535 UTF-8 bytes: ${normalizedName}`);
    }
    const data = entry.data;
    const localOffset = localSectionSize;
    localSectionSize += 30 + nameBytes.length + data.length;
    centralDirSize += 46 + nameBytes.length;
    prepared.push({ nameBytes, data, crc: crc32(data), localOffset });
  }

  const totalSize = localSectionSize + centralDirSize + 22;
  if (totalSize > 0xffffffff) {
    throw new Error('ZIP archive exceeds standard 4 GiB 32-bit ZIP limit.');
  }

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  // Local file headers + file payloads
  for (const item of prepared) {
    const offset = item.localOffset;
    view.setUint32(offset, ZIP_LOCAL_FILE_HEADER_SIG, true);
    view.setUint16(offset + 4, ZIP_VERSION_NEEDED, true);
    view.setUint16(offset + 6, ZIP_FLAG_UTF8, true);
    view.setUint16(offset + 8, ZIP_METHOD_STORE, true);
    view.setUint16(offset + 10, ZIP_DOS_TIME, true);
    view.setUint16(offset + 12, ZIP_DOS_DATE, true);
    view.setUint32(offset + 14, item.crc, true);
    view.setUint32(offset + 18, item.data.length, true);
    view.setUint32(offset + 22, item.data.length, true);
    view.setUint16(offset + 26, item.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true);
    out.set(item.nameBytes, offset + 30);
    out.set(item.data, offset + 30 + item.nameBytes.length);
  }

  // Central directory headers
  let cdCursor = localSectionSize;
  for (const item of prepared) {
    view.setUint32(cdCursor, ZIP_CENTRAL_DIR_HEADER_SIG, true);
    view.setUint16(cdCursor + 4, ZIP_VERSION_MADE_BY, true);
    view.setUint16(cdCursor + 6, ZIP_VERSION_NEEDED, true);
    view.setUint16(cdCursor + 8, ZIP_FLAG_UTF8, true);
    view.setUint16(cdCursor + 10, ZIP_METHOD_STORE, true);
    view.setUint16(cdCursor + 12, ZIP_DOS_TIME, true);
    view.setUint16(cdCursor + 14, ZIP_DOS_DATE, true);
    view.setUint32(cdCursor + 16, item.crc, true);
    view.setUint32(cdCursor + 20, item.data.length, true);
    view.setUint32(cdCursor + 24, item.data.length, true);
    view.setUint16(cdCursor + 28, item.nameBytes.length, true);
    view.setUint16(cdCursor + 30, 0, true);
    view.setUint16(cdCursor + 32, 0, true);
    view.setUint16(cdCursor + 34, 0, true);
    view.setUint16(cdCursor + 36, 0, true);
    view.setUint32(cdCursor + 38, 0, true);
    view.setUint32(cdCursor + 42, item.localOffset, true);
    out.set(item.nameBytes, cdCursor + 46);
    cdCursor += 46 + item.nameBytes.length;
  }

  // End of Central Directory Record (EOCD)
  view.setUint32(cdCursor, ZIP_EOCD_SIG, true);
  view.setUint16(cdCursor + 4, 0, true);
  view.setUint16(cdCursor + 6, 0, true);
  view.setUint16(cdCursor + 8, prepared.length, true);
  view.setUint16(cdCursor + 10, prepared.length, true);
  view.setUint32(cdCursor + 12, centralDirSize, true);
  view.setUint32(cdCursor + 16, localSectionSize, true);
  view.setUint16(cdCursor + 20, 0, true);

  return out;
}

// --- Table grid normalization and selection ------------------------------

interface NormalizedSpan {
  row: number;
  col: number;
  colSpan: number;
  rowSpan: number;
}

interface NormalizedTableGrid {
  hasHeaders: boolean;
  rowCount: number;
  columnCount: number;
  rows: string[][];
  spans: NormalizedSpan[];
}

function asCellText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function finiteNonNegInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizeTableGrid(table: ExportableTable, repeatMergedValues = false): NormalizedTableGrid {
  const rawHeaders = Array.isArray(table?.headers) ? table.headers.map(asCellText) : [];
  const rawRows = Array.isArray(table?.rows)
    ? table.rows.map(row => (Array.isArray(row) ? row.map(asCellText) : []))
    : [];
  const hasHeaders = rawHeaders.length > 0;
  const combined = hasHeaders ? [rawHeaders, ...rawRows] : [...rawRows];

  let columnCount = Math.max(finiteNonNegInt(table?.columnCount), rawHeaders.length);
  for (const row of rawRows) columnCount = Math.max(columnCount, row.length);

  let rowCount = combined.length;
  const rawSpans = Array.isArray(table?.spans) ? table.spans : [];

  if (rowCount > 0 && columnCount > 0) {
    for (const span of rawSpans) {
      if (typeof span !== 'object' || span === null) continue;
      if (!Number.isFinite(span.row) || !Number.isFinite(span.col)) continue;
      const r = Math.trunc(span.row);
      const c = Math.trunc(span.col);
      if (r < 0 || c < 0) continue;
      const cs = Number.isFinite(span.colSpan) ? Math.max(1, Math.trunc(span.colSpan)) : 1;
      const rs = Number.isFinite(span.rowSpan) ? Math.max(1, Math.trunc(span.rowSpan)) : 1;
      rowCount = Math.max(rowCount, r + rs);
      columnCount = Math.max(columnCount, c + cs);
    }
  }

  if (rowCount === 0 || columnCount === 0) {
    return { hasHeaders, rowCount: 0, columnCount: 0, rows: [], spans: [] };
  }

  const rows: string[][] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const sourceRow = combined[r] ?? [];
    const padded: string[] = [];
    for (let c = 0; c < columnCount; c += 1) {
      padded.push(sourceRow[c] ?? '');
    }
    rows.push(padded);
  }

  const occupied = Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => false));
  const spans: NormalizedSpan[] = [];

  for (const span of rawSpans) {
    if (typeof span !== 'object' || span === null) continue;
    if (!Number.isFinite(span.row) || !Number.isFinite(span.col)) continue;
    const row = Math.trunc(span.row);
    const col = Math.trunc(span.col);
    if (row < 0 || col < 0 || row >= rowCount || col >= columnCount) continue;

    const rawColSpan = Number.isFinite(span.colSpan) ? Math.max(1, Math.trunc(span.colSpan)) : 1;
    const rawRowSpan = Number.isFinite(span.rowSpan) ? Math.max(1, Math.trunc(span.rowSpan)) : 1;
    const colSpan = Math.min(rawColSpan, columnCount - col);
    const rowSpan = Math.min(rawRowSpan, rowCount - row);
    if (colSpan <= 1 && rowSpan <= 1) continue;

    let overlaps = false;
    for (let r = row; r < row + rowSpan && !overlaps; r += 1) {
      for (let c = col; c < col + colSpan; c += 1) {
        if (occupied[r]?.[c]) {
          overlaps = true;
          break;
        }
      }
    }
    if (overlaps) continue;

    for (let r = row; r < row + rowSpan; r += 1) {
      const targetRow = occupied[r];
      if (!targetRow) continue;
      for (let c = col; c < col + colSpan; c += 1) {
        targetRow[c] = true;
      }
    }

    spans.push({ row, col, colSpan, rowSpan });

    if (repeatMergedValues) {
      const anchorValue = rows[row]?.[col] ?? '';
      if (anchorValue.length > 0) {
        for (let r = row; r < row + rowSpan; r += 1) {
          const targetRow = rows[r];
          if (!targetRow) continue;
          for (let c = col; c < col + colSpan; c += 1) {
            if (r === row && c === col) continue;
            if ((targetRow[c] ?? '') === '') {
              targetRow[c] = anchorValue;
            }
          }
        }
      }
    }
  }

  return { hasHeaders, rowCount, columnCount, rows, spans };
}

function isTableEmpty(table: ExportableTable): boolean {
  if (Array.isArray(table.reasons) && table.reasons.includes('not-a-table')) return true;
  const grid = normalizeTableGrid(table);
  return grid.rowCount === 0 || grid.columnCount === 0;
}

/**
 * Filters `tables` by optional `ids` and `pages` (AND across filters, OR within each list),
 * excluding refused/empty tables by default while preserving input order.
 */
export function selectTables(tables: readonly ExportableTable[], selection: TableSelection = {}): ExportableTable[] {
  if (!Array.isArray(tables)) return [];
  const excludeEmpty = selection.excludeEmpty !== false;
  const idFilter = selection.ids !== undefined ? new Set(selection.ids) : null;
  const pageFilter =
    selection.pages !== undefined
      ? new Set(selection.pages.filter(p => Number.isFinite(p)).map(p => Math.trunc(p)))
      : null;

  const selected: ExportableTable[] = [];
  for (const table of tables) {
    if (typeof table !== 'object' || table === null) continue;
    if (excludeEmpty && isTableEmpty(table)) continue;
    if (idFilter !== null) {
      if (typeof table.id !== 'string' || !idFilter.has(table.id)) continue;
    }
    if (pageFilter !== null) {
      if (typeof table.page !== 'number' || !Number.isFinite(table.page) || !pageFilter.has(Math.trunc(table.page))) {
        continue;
      }
    }
    selected.push(table);
  }
  return selected;
}

// --- RFC4180 CSV Export --------------------------------------------------

const UTF8_BOM = '\uFEFF';

function formatCsvField(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

/** Exports one table to RFC 4180 CSV. Returns `''` for empty or refused tables. */
export function exportTableToCsv(table: ExportableTable, options: CsvExportOptions = {}): string {
  const grid = normalizeTableGrid(table, options.repeatMergedValues ?? false);
  if (grid.rowCount === 0 || grid.columnCount === 0) return '';

  const rowsToWrite = options.includeHeaders === false && grid.hasHeaders ? grid.rows.slice(1) : grid.rows;
  if (rowsToWrite.length === 0) return '';

  const eol = options.lineEnding ?? '\r\n';
  const lines = rowsToWrite.map(row => row.map(formatCsvField).join(','));
  const body = `${lines.join(eol)}${options.trailingNewline ? eol : ''}`;
  return options.bom ? `${UTF8_BOM}${body}` : body;
}

/** Exports selected tables as individual named CSV entries with collision-free filenames. */
export function exportSelectedTablesToCsv(
  tables: readonly ExportableTable[],
  options: SelectedCsvExportOptions = {},
): SelectedCsvFile[] {
  const chosen = selectTables(tables, options.selection);
  const usedFilenames = new Set<string>();
  const results: SelectedCsvFile[] = [];

  chosen.forEach((table, index) => {
    const rawBase = table.title?.trim() || table.id?.trim() || `table-${index + 1}`;
    let filename = sanitizeFilename(rawBase, { extension: 'csv', fallback: `table-${index + 1}` });
    if (usedFilenames.has(filename.toLowerCase())) {
      const stem = filename.slice(0, -4);
      let suffix = 2;
      while (usedFilenames.has(`${stem}-${suffix}.csv`.toLowerCase())) {
        suffix += 1;
      }
      filename = `${stem}-${suffix}.csv`;
    }
    usedFilenames.add(filename.toLowerCase());

    const entry: SelectedCsvFile = {
      filename,
      csv: exportTableToCsv(table, options),
    };
    if (table.id !== undefined) entry.id = table.id;
    if (table.page !== undefined) entry.page = table.page;
    if (table.title !== undefined) entry.title = table.title;
    results.push(entry);
  });

  return results;
}

/** Exports selected tables into one combined RFC 4180 CSV string separated by `tableSeparator`. */
export function exportTablesToCsv(tables: readonly ExportableTable[], options: MultiCsvExportOptions = {}): string {
  const chosen = selectTables(tables, options.selection);
  const eol = options.lineEnding ?? '\r\n';
  const separator = options.tableSeparator ?? `${eol}${eol}`;
  const perTableOpts: CsvExportOptions = { ...options, bom: false };

  const chunks = chosen
    .map(table => exportTableToCsv(table, perTableOpts))
    .filter(chunk => chunk.length > 0);
  if (chunks.length === 0) return '';

  const body = chunks.join(separator);
  return options.bom ? `${UTF8_BOM}${body}` : body;
}

// --- OOXML `.xlsx` Builder -----------------------------------------------

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const NS_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_OD_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_SPREADSHEET = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

const FORBIDDEN_SHEET_NAME_CHARS = /[\\/?*[\]:]/g;
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** Converts a 0-based column index (`0 -> A`, `25 -> Z`, `26 -> AA`) to Excel column letters. */
export function columnLetter(colIndex: number): string {
  if (!Number.isFinite(colIndex) || colIndex < 0) {
    throw new RangeError(`Column index must be a non-negative integer, got ${colIndex}.`);
  }
  let n = Math.trunc(colIndex) + 1;
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

/** Converts 0-based `(row, col)` indices into an A1-style Excel cell reference (e.g. `AA10`). */
export function cellRef(rowIndex: number, colIndex: number): string {
  if (!Number.isFinite(rowIndex) || rowIndex < 0) {
    throw new RangeError(`Row index must be a non-negative integer, got ${rowIndex}.`);
  }
  return `${columnLetter(colIndex)}${Math.trunc(rowIndex) + 1}`;
}

function stripLoneSurrogates(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value.slice(index, index + 2);
        index += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    out += value.charAt(index);
  }
  return out;
}

function sanitizeXmlText(text: string): string {
  return stripLoneSurrogates(text).replace(INVALID_XML_CHARS, '');
}

function escapeXml(text: string): string {
  return sanitizeXmlText(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sanitizeSheetName(raw: string, usedLowerNames: Set<string>, fallbackIndex: number, prefix: string): string {
  const cleaned = sanitizeXmlText(raw)
    .replace(FORBIDDEN_SHEET_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^'+|'+$/g, '');

  const fallback = `${prefix}${fallbackIndex}`.replace(FORBIDDEN_SHEET_NAME_CHARS, '').trim() || `Sheet${fallbackIndex}`;
  const base = (cleaned || fallback).slice(0, 31).replace(/['\s]+$/g, '') || fallback.slice(0, 31);

  let candidate = base;
  let suffix = 2;
  while (usedLowerNames.has(candidate.toLowerCase())) {
    const tag = ` (${suffix})`;
    const maxBase = Math.max(1, 31 - tag.length);
    candidate = `${base.slice(0, maxBase).replace(/['\s]+$/g, '')}${tag}`;
    suffix += 1;
  }
  usedLowerNames.add(candidate.toLowerCase());
  return candidate;
}

const STRICT_NUMERIC_PATTERN = /^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d+)?|\.\d+)$/;
const GROUPED_NUMERIC_PATTERN = /^[+-]?(?:0|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?$/;

type ClassifiedCell =
  | { kind: 'empty' }
  | { kind: 'number'; value: string }
  | { kind: 'string'; value: string };

function classifyCell(text: string, mode: NumberDetectionMode): ClassifiedCell {
  if (text.length === 0) return { kind: 'empty' };
  if (mode === 'none') return { kind: 'string', value: text };

  const trimmed = text.trim();
  if (trimmed !== text || trimmed.length === 0) {
    return { kind: 'string', value: text };
  }

  let candidate: string | null = null;
  if (STRICT_NUMERIC_PATTERN.test(trimmed)) {
    candidate = trimmed;
  } else if (mode === 'grouped' && GROUPED_NUMERIC_PATTERN.test(trimmed)) {
    candidate = trimmed.replace(/,/g, '');
  }

  if (candidate !== null) {
    const parsed = Number(candidate);
    const intPart = candidate.replace(/^[+-]/, '').split('.')[0] ?? '';
    if (
      Number.isFinite(parsed) &&
      Math.abs(parsed) <= Number.MAX_SAFE_INTEGER &&
      intPart.length <= 15
    ) {
      const normalized = Object.is(parsed, -0) ? '0' : String(parsed);
      return { kind: 'number', value: normalized };
    }
  }

  return { kind: 'string', value: text };
}

class SharedStringTable {
  readonly items: string[] = [];
  private readonly indexByText = new Map<string, number>();
  totalRefs = 0;

  intern(text: string): number {
    this.totalRefs += 1;
    const sanitized = sanitizeXmlText(text);
    const existing = this.indexByText.get(sanitized);
    if (existing !== undefined) return existing;
    const index = this.items.length;
    this.items.push(sanitized);
    this.indexByText.set(sanitized, index);
    return index;
  }

  toXml(): string {
    const entries = this.items.map(item => {
      const preserve = item.trim() !== item || /[\r\n\t]/.test(item);
      const spaceAttr = preserve ? ' xml:space="preserve"' : '';
      return `<si><t${spaceAttr}>${escapeXml(item)}</t></si>`;
    });
    if (entries.length === 0) {
      return `${XML_HEADER}<sst xmlns="${NS_SPREADSHEET}" count="0" uniqueCount="0"/>`;
    }
    return `${XML_HEADER}<sst xmlns="${NS_SPREADSHEET}" count="${this.totalRefs}" uniqueCount="${this.items.length}">${entries.join('')}</sst>`;
  }
}

function buildStylesXml(): string {
  return [
    XML_HEADER,
    `<styleSheet xmlns="${NS_SPREADSHEET}">`,
    '<fonts count="2">',
    '<font><sz val="11"/><name val="Calibri"/></font>',
    '<font><b/><sz val="11"/><name val="Calibri"/></font>',
    '</fonts>',
    '<fills count="2">',
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
    '</fills>',
    '<borders count="1">',
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    '</borders>',
    '<cellStyleXfs count="1">',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>',
    '</cellStyleXfs>',
    '<cellXfs count="4">',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>',
    '</cellXfs>',
    '<cellStyles count="1">',
    '<cellStyle name="Normal" xfId="0" builtinId="0"/>',
    '</cellStyles>',
    '</styleSheet>',
  ].join('');
}

function buildContentTypesXml(sheetCount: number): string {
  const overrides = [
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.workbook.main+xml"/>',
    ...Array.from(
      { length: sheetCount },
      (_unused, idx) =>
        `<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ),
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
  ];

  return [
    XML_HEADER,
    `<Types xmlns="${NS_CONTENT_TYPES}">`,
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    ...overrides,
    '</Types>',
  ].join('');
}

function buildRootRelsXml(): string {
  return [
    XML_HEADER,
    `<Relationships xmlns="${NS_RELS}">`,
    `<Relationship Id="rId1" Type="${NS_OD_RELS}/officeDocument" Target="xl/workbook.xml"/>`,
    '</Relationships>',
  ].join('');
}

function buildWorkbookRelsXml(sheetCount: number): string {
  const rels: string[] = [];
  for (let idx = 0; idx < sheetCount; idx += 1) {
    rels.push(
      `<Relationship Id="rId${idx + 1}" Type="${NS_OD_RELS}/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`,
    );
  }
  rels.push(
    `<Relationship Id="rId${sheetCount + 1}" Type="${NS_OD_RELS}/styles" Target="styles.xml"/>`,
  );
  rels.push(
    `<Relationship Id="rId${sheetCount + 2}" Type="${NS_OD_RELS}/sharedStrings" Target="sharedStrings.xml"/>`,
  );
  return `${XML_HEADER}<Relationships xmlns="${NS_RELS}">${rels.join('')}</Relationships>`;
}

function buildWorkbookXml(sheetNames: readonly string[]): string {
  const sheetElements = sheetNames.map(
    (name, idx) => `<sheet name="${escapeXml(name)}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`,
  );
  return [
    XML_HEADER,
    `<workbook xmlns="${NS_SPREADSHEET}" xmlns:r="${NS_OD_RELS}">`,
    `<sheets>${sheetElements.join('')}</sheets>`,
    '</workbook>',
  ].join('');
}

function computeColumnWidths(grid: NormalizedTableGrid): number[] {
  const widths = Array.from({ length: grid.columnCount }, () => 10);
  const spanMap = new Map<string, NormalizedSpan>();
  for (const span of grid.spans) {
    spanMap.set(`${span.row},${span.col}`, span);
  }

  for (let r = 0; r < grid.rowCount; r += 1) {
    const row = grid.rows[r];
    if (!row) continue;
    for (let c = 0; c < grid.columnCount; c += 1) {
      const value = row[c] ?? '';
      if (value.length === 0) continue;
      const longestLine = value.split(/\r\n|\r|\n/).reduce((max, line) => Math.max(max, line.length), 0);
      const span = spanMap.get(`${r},${c}`);
      const perCol = span ? Math.ceil(longestLine / span.colSpan) : longestLine;
      const estimated = Math.min(60, Math.max(10, Math.ceil(perCol * 1.15) + 2));
      const colSpan = span ? span.colSpan : 1;
      for (let offset = 0; offset < colSpan; offset += 1) {
        const targetCol = c + offset;
        const current = widths[targetCol] ?? 10;
        if (estimated > current) widths[targetCol] = estimated;
      }
    }
  }

  return widths;
}

function buildWorksheetXml(
  grid: NormalizedTableGrid,
  sst: SharedStringTable,
  options: XlsxExportOptions,
): string {
  const styleHeaders = options.styleHeaders !== false;
  const freezeHeader = options.freezeHeader === true && grid.hasHeaders && grid.rowCount > 0;
  const numberMode = options.numberDetection ?? 'strict';

  const sheetView = freezeHeader
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

  if (grid.rowCount === 0 || grid.columnCount === 0) {
    return [
      XML_HEADER,
      `<worksheet xmlns="${NS_SPREADSHEET}">`,
      '<dimension ref="A1"/>',
      sheetView,
      '<sheetData/>',
      '</worksheet>',
    ].join('');
  }

  const coveredNonAnchors = new Set<string>();
  const spanAnchors = new Set<string>();
  for (const span of grid.spans) {
    spanAnchors.add(`${span.row},${span.col}`);
    for (let r = span.row; r < span.row + span.rowSpan; r += 1) {
      for (let c = span.col; c < span.col + span.colSpan; c += 1) {
        if (r === span.row && c === span.col) continue;
        coveredNonAnchors.add(`${r},${c}`);
      }
    }
  }

  const colWidths = computeColumnWidths(grid);
  const colsXml = `<cols>${colWidths
    .map((w, idx) => `<col min="${idx + 1}" max="${idx + 1}" width="${w}" customWidth="1"/>`)
    .join('')}</cols>`;

  const rowElements: string[] = [];
  for (let r = 0; r < grid.rowCount; r += 1) {
    const row = grid.rows[r] ?? [];
    const cellElements: string[] = [];
    const isHeaderRow = styleHeaders && grid.hasHeaders && r === 0;

    for (let c = 0; c < grid.columnCount; c += 1) {
      const key = `${r},${c}`;
      if (coveredNonAnchors.has(key)) continue;

      const text = row[c] ?? '';
      const classified = classifyCell(text, numberMode);
      if (classified.kind === 'empty') continue;

      const isMultiline = /[\r\n]/.test(text);
      const isMergedAnchor = spanAnchors.has(key);
      let styleIndex = 0;
      if (isHeaderRow) {
        styleIndex = isMergedAnchor || isMultiline ? 3 : 1;
      } else if (isMultiline) {
        styleIndex = 2;
      }

      const ref = cellRef(r, c);
      if (classified.kind === 'number') {
        cellElements.push(`<c r="${ref}" s="${styleIndex}" t="n"><v>${classified.value}</v></c>`);
      } else {
        const sstIndex = sst.intern(classified.value);
        cellElements.push(`<c r="${ref}" s="${styleIndex}" t="s"><v>${sstIndex}</v></c>`);
      }
    }

    if (cellElements.length > 0) {
      rowElements.push(`<row r="${r + 1}">${cellElements.join('')}</row>`);
    } else {
      rowElements.push(`<row r="${r + 1}"/>`);
    }
  }

  const mergeElements = grid.spans.map(span => {
    const startRef = cellRef(span.row, span.col);
    const endRef = cellRef(span.row + span.rowSpan - 1, span.col + span.colSpan - 1);
    return `<mergeCell ref="${startRef}:${endRef}"/>`;
  });

  const mergeCellsXml =
    mergeElements.length > 0 ? `<mergeCells count="${mergeElements.length}">${mergeElements.join('')}</mergeCells>` : '';

  const dimensionRef = `A1:${cellRef(grid.rowCount - 1, grid.columnCount - 1)}`;

  return [
    XML_HEADER,
    `<worksheet xmlns="${NS_SPREADSHEET}">`,
    `<dimension ref="${dimensionRef}"/>`,
    sheetView,
    colsXml,
    `<sheetData>${rowElements.join('')}</sheetData>`,
    mergeCellsXml,
    '</worksheet>',
  ].join('');
}

/** Exports one table into a single-sheet OOXML `.xlsx` archive. */
export function exportTableToXlsx(
  table: ExportableTable,
  options: Omit<XlsxExportOptions, 'selection'> = {},
): Uint8Array {
  return exportTablesToXlsx([table], { ...options, selection: { excludeEmpty: false } });
}

/**
 * Exports selected tables into a multi-sheet OOXML `.xlsx` archive (`Uint8Array`).
 *
 * When zero tables match `options.selection`, emits a valid single-empty-sheet workbook (`Sheet1`)
 * so Excel and OOXML readers never encounter an invalid `<sheets/>` element.
 */
export function exportTablesToXlsx(tables: readonly ExportableTable[], options: XlsxExportOptions = {}): Uint8Array {
  const selected = selectTables(tables, options.selection);
  const effectiveTables: ExportableTable[] =
    selected.length > 0
      ? selected
      : [{ headers: [], rows: [], rowCount: 0, columnCount: 0, spans: [] }];

  const sst = new SharedStringTable();
  const usedSheetNames = new Set<string>();
  const prefix = options.defaultSheetName?.trim() || 'Table';

  const sheetNames: string[] = [];
  const worksheetXmls: string[] = [];

  effectiveTables.forEach((table, index) => {
    const rawName =
      selected.length === 0
        ? 'Sheet1'
        : table.title?.trim() ||
          table.id?.trim() ||
          (table.page !== undefined ? `Page ${Math.trunc(table.page)} ${prefix} ${index + 1}` : `${prefix} ${index + 1}`);
    const sheetName = sanitizeSheetName(rawName, usedSheetNames, index + 1, prefix);
    sheetNames.push(sheetName);
    const grid = normalizeTableGrid(table, false);
    worksheetXmls.push(buildWorksheetXml(grid, sst, options));
  });

  const sheetCount = worksheetXmls.length;
  const entries: ZipStoreEntry[] = [
    { name: '[Content_Types].xml', data: UTF8_ENCODER.encode(buildContentTypesXml(sheetCount)) },
    { name: '_rels/.rels', data: UTF8_ENCODER.encode(buildRootRelsXml()) },
    { name: 'xl/_rels/workbook.xml.rels', data: UTF8_ENCODER.encode(buildWorkbookRelsXml(sheetCount)) },
    { name: 'xl/workbook.xml', data: UTF8_ENCODER.encode(buildWorkbookXml(sheetNames)) },
    { name: 'xl/styles.xml', data: UTF8_ENCODER.encode(buildStylesXml()) },
    { name: 'xl/sharedStrings.xml', data: UTF8_ENCODER.encode(sst.toXml()) },
  ];

  worksheetXmls.forEach((xml, idx) => {
    entries.push({
      name: `xl/worksheets/sheet${idx + 1}.xml`,
      data: UTF8_ENCODER.encode(xml),
    });
  });

  return buildStoreZip(entries);
}

// --- LaTeX `.tex` Formula Bundle Export ----------------------------------

const LATEX_TEXT_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '$': '\\$',
  '&': '\\&',
  '%': '\\%',
  '#': '\\#',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

function escapeLatexText(text: string): string {
  return text.replace(/[\\{}$&%#_~^]/g, ch => LATEX_TEXT_ESCAPES[ch] ?? ch);
}

function formatCommentText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

function collectFilteredFormulas(
  hits: readonly FormulaBlockHit[],
  pageLookup: ReadonlyMap<number, number>,
  options: FormulaSelectionOptions = {},
): ExportedFormula[] {
  const idFilter = options.blockIds !== undefined ? new Set(options.blockIds) : null;
  const pageFilter =
    options.pages !== undefined
      ? new Set(options.pages.filter(p => Number.isFinite(p)).map(p => Math.trunc(p)))
      : null;
  const kindFilter = options.kinds !== undefined ? new Set(options.kinds) : null;
  const deduplicate = options.deduplicate === true;
  const seen = new Set<string>();
  const exported: ExportedFormula[] = [];

  for (const hit of hits) {
    if (idFilter !== null) {
      if (typeof hit.id !== 'string' || !idFilter.has(hit.id)) continue;
    }
    const hitWithPage = hit as FormulaBlockHit & { page?: unknown };
    const rawPage = pageLookup.get(hit.index) ?? (typeof hitWithPage.page === 'number' ? hitWithPage.page : undefined);
    const page = rawPage !== undefined && Number.isFinite(rawPage) ? Math.trunc(rawPage) : undefined;
    if (pageFilter !== null) {
      if (page === undefined || !pageFilter.has(page)) continue;
    }

    for (const seg of hit.formulas) {
      if (kindFilter !== null && !kindFilter.has(seg.kind)) continue;
      const latex = seg.latex.replace(/[\r\n]+/g, ' ').trim();
      if (latex.length === 0) continue;

      if (deduplicate) {
        const key = `${seg.kind}\0${latex}`;
        if (seen.has(key)) continue;
        seen.add(key);
      }

      const item: ExportedFormula = {
        index: exported.length + 1,
        blockIndex: hit.index,
        kind: seg.kind,
        source: seg.value,
        latex,
      };
      if (hit.id !== undefined) item.blockId = hit.id;
      if (page !== undefined) item.page = page;
      exported.push(item);
    }
  }

  return exported;
}

/** Detects formulas in document blocks via `src/core/formulas.ts` and filters by block ID/page/kind. */
export function extractExportFormulas(
  blocks: readonly FormulaSourceBlock[],
  options: FormulaSelectionOptions = {},
): ExportedFormula[] {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  const hits = detectFormulas(blocks);
  const pageLookup = new Map<number, number>();
  blocks.forEach((block, index) => {
    if (typeof block?.page === 'number' && Number.isFinite(block.page)) {
      pageLookup.set(index, Math.trunc(block.page));
    }
  });
  return collectFilteredFormulas(hits, pageLookup, options);
}

function wrapFormulaLatex(formula: ExportedFormula, options: LatexExportOptions): string {
  if (formula.kind === 'inline-math') {
    const inlineMode = options.inlineDelimiter ?? 'parens';
    return inlineMode === 'dollars' ? `$${formula.latex}$` : `\\(${formula.latex}\\)`;
  }

  const displayEnv = options.displayEnvironment ?? 'brackets';
  switch (displayEnv) {
    case 'equation':
      return `\\begin{equation}\n${formula.latex}\n\\end{equation}`;
    case 'equation*':
      return `\\begin{equation*}\n${formula.latex}\n\\end{equation*}`;
    case 'dollars':
      return `$$${formula.latex}$$`;
    case 'brackets':
    default:
      return `\\[${formula.latex}\\]`;
  }
}

function renderLatexDocument(formulas: readonly ExportedFormula[], options: LatexExportOptions = {}): string {
  const standalone = options.standalone !== false;
  const includeComments = options.includeMetadataComments !== false;
  const utf8 = options.utf8 !== false;
  const documentClass = options.documentClass?.trim() || 'article';

  const bodyLines: string[] = [];
  if (formulas.length === 0) {
    bodyLines.push('% No formulas detected.');
  } else {
    formulas.forEach((formula, idx) => {
      if (idx > 0) bodyLines.push('');
      if (includeComments) {
        const meta: string[] = [`Formula ${formula.index}`];
        if (formula.page !== undefined) meta.push(`Page ${formula.page}`);
        if (formula.blockId !== undefined) meta.push(`Block ${formatCommentText(formula.blockId)}`);
        meta.push(formula.kind);
        bodyLines.push(`% ${meta.join(', ')}`);
      }
      bodyLines.push(wrapFormulaLatex(formula, options));
    });
  }

  const body = bodyLines.join('\n');
  if (!standalone) return body;

  const preamble: string[] = [`\\documentclass[11pt]{${escapeLatexText(documentClass)}}`];
  if (utf8) {
    preamble.push('\\usepackage[utf8]{inputenc}');
    preamble.push('\\usepackage[T1]{fontenc}');
  }
  preamble.push('\\usepackage{amsmath}');
  preamble.push('\\usepackage{amssymb}');

  const hasTitle = typeof options.title === 'string' && options.title.trim().length > 0;
  const hasAuthor = typeof options.author === 'string' && options.author.trim().length > 0;
  if (hasTitle) preamble.push(`\\title{${escapeLatexText(options.title!.trim())}}`);
  if (hasAuthor) preamble.push(`\\author{${escapeLatexText(options.author!.trim())}}`);
  if (hasTitle || hasAuthor) preamble.push('\\date{}');

  const docLines: string[] = [...preamble, '', '\\begin{document}'];
  if (hasTitle) docLines.push('\\maketitle');
  docLines.push('', body, '', '\\end{document}', '');
  return docLines.join('\n');
}

/** Extracts formulas from `blocks` and bundles them with a complete `.tex` document string. */
export function exportFormulasBundle(
  blocks: readonly FormulaSourceBlock[],
  options: LatexExportOptions = {},
): LatexBundleResult {
  const formulas = extractExportFormulas(blocks, options);
  return {
    tex: renderLatexDocument(formulas, options),
    formulas,
  };
}

/** Exports formulas detected in `blocks` directly to a LaTeX `.tex` document string. */
export function exportFormulasToTex(
  blocks: readonly FormulaSourceBlock[],
  options: LatexExportOptions = {},
): string {
  return exportFormulasBundle(blocks, options).tex;
}

/** Exports pre-detected `FormulaBlockHit[]` from `src/core/formulas.ts` into a `.tex` document string. */
export function exportDetectedFormulasToTex(
  hits: readonly FormulaBlockHit[],
  options: LatexExportOptions = {},
): string {
  if (!Array.isArray(hits)) return renderLatexDocument([], options);
  const formulas = collectFilteredFormulas(hits, new Map<number, number>(), options);
  return renderLatexDocument(formulas, options);
}
