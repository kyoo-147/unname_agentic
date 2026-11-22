/**
 * Table structure from block geometry (backlog item E06).
 *
 * A block group that looks like a table reaches this module as cells: text plus the
 * page-space rect the text occupies. The module turns that geometry into one header
 * row, data rows, column bands and the spans that merged cells occupy, so later exports
 * can write a table instead of a run of loose lines.
 *
 * Contract:
 * - Coordinates are PDF points with the origin at the top-left corner and y growing
 *   downwards, matching `Rect` in `src/core/types.ts`.
 * - Deterministic: no clock, no randomness, no locale. The same cells produce the same
 *   table, including when the caller passes them in a different order.
 * - Data comes only from the input: every value in the result is folded input text, and
 *   a slot that no cell covers stays empty rather than being guessed. Two cells that
 *   land in the same column band are joined by a single space instead of one being
 *   dropped.
 * - Cell text is folded: runs of whitespace, including the line breaks of a wrapped
 *   cell, become single spaces. A cell that wrapped onto two lines therefore stays one
 *   cell in one row instead of becoming two rows.
 * - Row 0 is the header row. `spans[].row` counts it as row 0, and `rowCount` counts it
 *   too: a table with a header and two data rows reports `rowCount: 3` while
 *   `rows.length` is 2.
 * - A group that is not table-like (fewer than two rows or fewer than two columns)
 *   returns an empty table whose `confidence` is 0 and whose only reason is
 *   `not-a-table`. `toCsv` and `toMarkdown` write nothing for it.
 */

import type { Rect } from './types';

/** A cell-shaped block: its text and the rect the text occupies on the page. */
export interface TableCell {
  text: string;
  rect: Rect;
  /**
   * Optional caller row assignment. Cells that share a hint are always one row, even
   * when their vertical positions are far apart. A hinted cell whose geometry agrees
   * with a row already found joins that row instead of opening a second one.
   */
  rowHint?: number;
}

/** A cell that covers more than one column band. */
export interface TableSpan {
  /** 0-based row index; the header row is row 0. */
  row: number;
  /** 0-based column index of the first band the cell covers. */
  col: number;
  colSpan: number;
}

/** Machine-readable note about how the table was read. */
export type TableReason = 'not-a-table' | 'assumed-header' | 'merged-cells' | 'sparse-grid' | 'unaligned-cells';

export interface Table {
  /** First row, read as the header. Cell values only, no invented fillers. */
  headers: string[];
  /** Data rows only; the header row is kept separate. */
  rows: string[][];
  /** Header row plus data rows. */
  rowCount: number;
  columnCount: number;
  /** One entry per cell that covers more than one band; empty when no cell merged. */
  spans: TableSpan[];
  /** 0..1; exactly 0 when `reasons` contains `not-a-table`. */
  confidence: number;
  reasons: TableReason[];
}

/** A table needs at least this many rows (header included) to be a table. */
const MIN_ROWS = 2;

/** A table needs at least this many column bands to be a table. */
const MIN_COLUMNS = 2;

/** Line height assumed when no cell reports a positive height, in points. */
const FALLBACK_LINE_HEIGHT = 1;

/** Two cells share a row while their first-line centres stay this close, as a fraction of the median line height. */
const ROW_TOLERANCE_RATIO = 0.5;

/** Floor for the row tolerance, in points, so sub-point noise never splits every cell. */
const MIN_ROW_TOLERANCE = 0.25;

/** A shared gap must be at least this wide, as a fraction of the median line height. */
const MIN_GAP_WIDTH_RATIO = 0.25;

/** Floor for the minimum shared gap, in points. */
const MIN_GAP_WIDTH = 0.5;

/** A cell edge counts as aligned while it stays this close to its column edge, as a fraction of the median line height. */
const ALIGNMENT_RATIO = 0.5;

/** Floor for the alignment tolerance, in points. */
const MIN_ALIGNMENT_TOLERANCE = 0.5;

/** Weight of grid coverage in the confidence score. */
const COVERAGE_WEIGHT = 0.6;

/** Weight of edge alignment in the confidence score. */
const ALIGNMENT_WEIGHT = 0.4;

/** Float slack for edge comparisons. */
const EPSILON = 1e-9;

/** Rect edges after sanitising. */
interface CellBounds {
  left: number;
  right: number;
  top: number;
  height: number;
}

interface PreparedCell {
  text: string;
  left: number;
  right: number;
  top: number;
  lineHeight: number;
  /** Centre of the cell's first line: a wrapped cell still starts where its row starts. */
  anchor: number;
  rowHint: number | null;
  /** Position in the caller's array, used only to break exact geometric ties. */
  order: number;
}

interface RowCluster {
  anchor: number;
  cells: PreparedCell[];
  hint: number | null;
}

/** One whitespace corridor between two neighbouring cells of the same row. */
interface GapBand {
  row: number;
  lower: number;
  upper: number;
}

/** Gaps that overlap across rows, narrowed to the part every supporting row leaves empty. */
interface Corridor {
  lower: number;
  upper: number;
  rows: Set<number>;
}

/** A column boundary, with the shared gap it came from. */
interface Boundary {
  position: number;
  lower: number;
  upper: number;
  support: number;
}

interface PlacedCell {
  left: number;
  right: number;
  start: number;
  end: number;
}

/**
 * Reads a table out of cell geometry.
 *
 * Rows come from clustering first-line centres with a tolerance derived from the median
 * cell line height, so slightly misaligned rows still group and a wrapped cell stays on
 * its own row. Column bands come from the whitespace gaps that most rows share. A cell
 * that covers a whole shared gap spans the bands on both sides of it.
 *
 * Never throws for geometry it cannot use: cells without text or without a rect are
 * dropped, and a group that stays below two rows or two columns is refused.
 */
export function extractTable(cells: readonly TableCell[]): Table {
  const prepared = prepareCells(cells);
  const measured = median(prepared.filter(cell => cell.lineHeight > 0).map(cell => cell.lineHeight));
  const unit = measured > 0 ? measured : FALLBACK_LINE_HEIGHT;

  const rowTolerance = Math.max(MIN_ROW_TOLERANCE, unit * ROW_TOLERANCE_RATIO);
  const rows = groupRows(prepared, rowTolerance);
  const boundaries = findBoundaries(collectGaps(rows), rows.length, unit);
  const columnCount = boundaries.length + 1;

  if (rows.length < MIN_ROWS || columnCount < MIN_COLUMNS) return refusedTable();

  const columns: string[][] = [];
  const spans: TableSpan[] = [];
  const placed: PlacedCell[][] = [];
  let coveredSlots = 0;

  rows.forEach((row, rowIndex) => {
    const slots = Array.from({ length: columnCount }, () => '');
    const covered = Array.from({ length: columnCount }, () => false);
    const placedCells: PlacedCell[] = [];

    for (const cell of row.cells) {
      const start = columnOf(boundaries, cell.left);
      if (start >= columnCount) continue;

      const existing = slots[start] ?? '';
      if (covered[start]) {
        // A second block inside one visual cell; joining it is the only repair that
        // keeps its text, and it invents nothing beyond the separating space.
        slots[start] = existing ? `${existing} ${cell.text}` : cell.text;
        placedCells.push({ left: cell.left, right: cell.right, start, end: start });
        continue;
      }

      let span = spanOf(boundaries, cell.left, cell.right, start, columnCount);
      if (span > 1 && rangeCovered(covered, start, span)) span = 1;

      slots[start] = cell.text;
      for (let offset = 0; offset < span; offset += 1) {
        const target = start + offset;
        if (target < columnCount) covered[target] = true;
      }
      if (span > 1) spans.push({ row: rowIndex, col: start, colSpan: span });
      placedCells.push({ left: cell.left, right: cell.right, start, end: start + span - 1 });
    }

    for (const flag of covered) if (flag) coveredSlots += 1;
    columns.push(slots);
    placed.push(placedCells);
  });

  const totalSlots = rows.length * columnCount;
  const coverage = totalSlots > 0 ? coveredSlots / totalSlots : 0;
  const alignment = alignmentScore(placed, columnCount, Math.max(MIN_ALIGNMENT_TOLERANCE, unit * ALIGNMENT_RATIO));
  const confidence = round2(clamp01(COVERAGE_WEIGHT * coverage + ALIGNMENT_WEIGHT * alignment));
  const headers = columns[0] ?? [];

  const reasons: TableReason[] = ['assumed-header'];
  if (spans.length > 0) reasons.push('merged-cells');
  if (coveredSlots < totalSlots) reasons.push('sparse-grid');
  if (alignment < 1) reasons.push('unaligned-cells');

  return {
    headers,
    rows: columns.slice(1),
    rowCount: rows.length,
    columnCount,
    spans,
    confidence,
    reasons,
  };
}

/**
 * Writes a table as CSV.
 *
 * Fields that contain a comma, a double quote, a carriage return or a line feed are
 * quoted, and inner quotes are doubled, so a cell that carries its own line break stays
 * one field. Rows are separated by LF and the result has no trailing newline; an empty
 * or refused table writes an empty string.
 */
export function toCsv(table: Table): string {
  const { headers, rows, width } = tableRows(table);
  if (width === 0) return '';

  const lines: string[] = [];
  if (headers.length > 0) lines.push(csvLine(padCells(headers, width)));
  for (const row of rows) lines.push(csvLine(padCells(row, width)));
  return lines.join('\n');
}

/**
 * Writes a table as a GitHub-flavoured Markdown table with a header separator row.
 *
 * A cell keeps its value; pipes are escaped and a cell's own line breaks become `<br>`
 * so they cannot end the table row early. An empty or refused table writes an empty
 * string.
 */
export function toMarkdown(table: Table): string {
  const { headers, rows, width } = tableRows(table);
  if (width === 0) return '';

  const lines: string[] = [];
  lines.push(markdownLine(padCells(headers, width)));
  lines.push(`| ${Array.from({ length: width }, () => '---').join(' | ')} |`);
  for (const row of rows) lines.push(markdownLine(padCells(row, width)));
  return lines.join('\n');
}

function refusedTable(): Table {
  return {
    headers: [],
    rows: [],
    rowCount: 0,
    columnCount: 0,
    spans: [],
    confidence: 0,
    reasons: ['not-a-table'],
  };
}

function prepareCells(cells: readonly TableCell[]): PreparedCell[] {
  if (!Array.isArray(cells)) return [];
  const prepared: PreparedCell[] = [];

  cells.forEach((cell, order) => {
    if (typeof cell !== 'object' || cell === null) return;
    const rawText = typeof cell.text === 'string' ? cell.text : '';
    const text = foldText(rawText);
    // An empty block carries no value; keeping it would only add a phantom band.
    if (text === '') return;

    const bounds = readBounds(cell.rect);
    if (!bounds) return;

    const lineHeight = bounds.height > 0 ? bounds.height / countLines(rawText) : 0;
    prepared.push({
      text,
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      lineHeight,
      anchor: bounds.top + lineHeight / 2,
      rowHint: finite(cell.rowHint),
      order,
    });
  });

  return prepared;
}

function readBounds(value: unknown): CellBounds | null {
  if (typeof value !== 'object' || value === null) return null;
  const rect = value as Partial<Rect>;
  const left = finite(rect.x) ?? 0;
  const top = finite(rect.y) ?? 0;
  const width = Math.max(0, finite(rect.width) ?? 0);
  const height = Math.max(0, finite(rect.height) ?? 0);
  return { left, right: left + width, top, height };
}

function groupRows(cells: readonly PreparedCell[], tolerance: number): RowCluster[] {
  const sorted = [...cells].sort((left, right) => left.anchor - right.anchor || left.left - right.left || left.order - right.order);
  const clusters: RowCluster[] = [];
  const hinted = new Map<number, RowCluster>();

  for (const cell of sorted) {
    if (cell.rowHint === null) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(cell.anchor - last.anchor) <= tolerance) {
        last.cells.push(cell);
        last.anchor = meanAnchor(last.cells);
      } else {
        clusters.push({ anchor: cell.anchor, cells: [cell], hint: null });
      }
      continue;
    }

    const group = hinted.get(cell.rowHint);
    if (group) {
      group.cells.push(cell);
      group.anchor = meanAnchor(group.cells);
    } else {
      const created: RowCluster = { anchor: cell.anchor, cells: [cell], hint: cell.rowHint };
      hinted.set(cell.rowHint, created);
    }
  }

  // Merge hints in hint order so the result does not depend on the caller's array order.
  const hintedRows = [...hinted.values()].sort((left, right) => (left.hint ?? 0) - (right.hint ?? 0));
  for (const group of hintedRows) {
    let target: RowCluster | null = null;
    let closest = Number.POSITIVE_INFINITY;
    for (const cluster of clusters) {
      const distance = Math.abs(cluster.anchor - group.anchor);
      if (distance <= tolerance && distance < closest) {
        closest = distance;
        target = cluster;
      }
    }
    if (target) {
      target.cells.push(...group.cells);
      target.anchor = meanAnchor(target.cells);
    } else {
      clusters.push(group);
    }
  }

  for (const cluster of clusters) cluster.cells.sort(compareCellsInRow);
  clusters.sort((left, right) => {
    if (left.anchor !== right.anchor) return left.anchor - right.anchor;
    const leftEdge = left.cells[0]?.left ?? 0;
    const rightEdge = right.cells[0]?.left ?? 0;
    if (leftEdge !== rightEdge) return leftEdge - rightEdge;
    return (left.hint ?? Number.POSITIVE_INFINITY) - (right.hint ?? Number.POSITIVE_INFINITY);
  });

  return clusters;
}

function compareCellsInRow(left: PreparedCell, right: PreparedCell): number {
  if (left.left !== right.left) return left.left - right.left;
  if (left.top !== right.top) return left.top - right.top;
  if (left.order !== right.order) return left.order - right.order;
  return left.text < right.text ? -1 : left.text > right.text ? 1 : 0;
}

function meanAnchor(cells: readonly PreparedCell[]): number {
  const sum = cells.reduce((total, cell) => total + cell.anchor, 0);
  return cells.length > 0 ? sum / cells.length : 0;
}

function collectGaps(rows: readonly RowCluster[]): GapBand[] {
  const gaps: GapBand[] = [];
  rows.forEach((row, rowIndex) => {
    for (let position = 0; position < row.cells.length - 1; position += 1) {
      const current = row.cells[position];
      const next = row.cells[position + 1];
      if (!current || !next) continue;
      // Cells that touch or overlap leave no corridor to share with another row.
      if (next.left - current.right <= EPSILON) continue;
      gaps.push({ row: rowIndex, lower: current.right, upper: next.left });
    }
  });
  return gaps;
}

function findBoundaries(gaps: readonly GapBand[], rowCount: number, unit: number): Boundary[] {
  const minGapWidth = Math.max(MIN_GAP_WIDTH, unit * MIN_GAP_WIDTH_RATIO);
  const sorted = [...gaps].sort((left, right) => left.lower - right.lower || left.upper - right.upper || left.row - right.row);
  const corridors: Corridor[] = [];

  for (const gap of sorted) {
    const current = corridors[corridors.length - 1];
    if (current && gap.lower < current.upper) {
      current.lower = Math.max(current.lower, gap.lower);
      current.upper = Math.min(current.upper, gap.upper);
      current.rows.add(gap.row);
    } else {
      corridors.push({ lower: gap.lower, upper: gap.upper, rows: new Set([gap.row]) });
    }
  }

  // A boundary must be left empty by at least half of the rows: a merged cell removes
  // its own row from the support, so requiring every row would reject merged headers.
  const requiredSupport = Math.max(1, Math.ceil(rowCount / 2));
  const candidates: Boundary[] = [];
  for (const corridor of corridors) {
    if (corridor.upper - corridor.lower < minGapWidth) continue;
    if (corridor.rows.size < requiredSupport) continue;
    candidates.push({
      position: (corridor.lower + corridor.upper) / 2,
      lower: corridor.lower,
      upper: corridor.upper,
      support: corridor.rows.size,
    });
  }

  // Two corridors closer together than their own width describe one gap, not two
  // columns; keep the better supported one.
  candidates.sort((left, right) => right.support - left.support || left.position - right.position);
  const distinct: Boundary[] = [];
  for (const candidate of candidates) {
    if (distinct.some(kept => Math.abs(kept.position - candidate.position) < minGapWidth)) continue;
    distinct.push(candidate);
  }
  distinct.sort((left, right) => left.position - right.position);
  return distinct;
}

function columnOf(boundaries: readonly Boundary[], left: number): number {
  let column = 0;
  for (const boundary of boundaries) {
    if (left >= boundary.position - EPSILON) column += 1;
  }
  return column;
}

/** Number of bands a cell covers, given that it starts in `startColumn`. */
function spanOf(boundaries: readonly Boundary[], left: number, right: number, startColumn: number, columnCount: number): number {
  let endColumn = startColumn;
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index];
    if (!boundary) continue;
    // "Clearly spans" means the cell covers the whole shared gap, not merely the
    // boundary point: a cell that only overflows a few points does not qualify.
    if (left <= boundary.lower + EPSILON && right >= boundary.upper - EPSILON) {
      endColumn = Math.max(endColumn, index + 1);
    }
  }
  const limit = Math.max(1, columnCount - startColumn);
  return Math.min(limit, endColumn - startColumn + 1);
}

function rangeCovered(covered: readonly boolean[], start: number, span: number): boolean {
  for (let offset = 1; offset < span; offset += 1) {
    if (covered[start + offset]) return true;
  }
  return false;
}

function alignmentScore(placed: readonly PlacedCell[][], columnCount: number, tolerance: number): number {
  const lefts = Array.from({ length: columnCount }, (): number[] => []);
  const rights = Array.from({ length: columnCount }, (): number[] => []);
  for (const row of placed) {
    for (const cell of row) {
      lefts[cell.start]?.push(cell.left);
      rights[cell.end]?.push(cell.right);
    }
  }

  const leftEdges = lefts.map(values => median(values));
  const rightEdges = rights.map(values => median(values));

  let aligned = 0;
  let total = 0;
  for (const row of placed) {
    for (const cell of row) {
      total += 1;
      const expectedLeft = leftEdges[cell.start] ?? cell.left;
      const expectedRight = rightEdges[cell.end] ?? cell.right;
      // Either edge may carry the column: left-aligned text and right-aligned numbers
      // are both tables.
      if (Math.abs(cell.left - expectedLeft) <= tolerance || Math.abs(cell.right - expectedRight) <= tolerance) aligned += 1;
    }
  }
  return total > 0 ? aligned / total : 0;
}

interface TableRows {
  headers: string[];
  rows: string[][];
  width: number;
}

function tableRows(table: Table): TableRows {
  const headers = Array.isArray(table?.headers) ? table.headers : [];
  const rows = Array.isArray(table?.rows) ? table.rows : [];
  const declared = typeof table?.columnCount === 'number' && Number.isFinite(table.columnCount) ? Math.max(0, Math.trunc(table.columnCount)) : 0;

  let width = Math.max(declared, headers.length);
  for (const row of rows) width = Math.max(width, Array.isArray(row) ? row.length : 0);

  return {
    headers: headers.map(cell => (typeof cell === 'string' ? cell : '')),
    rows: rows.map(row => (Array.isArray(row) ? row.map(cell => (typeof cell === 'string' ? cell : '')) : [])),
    width,
  };
}

function padCells(cells: readonly string[], width: number): string[] {
  const padded: string[] = [];
  for (let index = 0; index < width; index += 1) padded.push(cells[index] ?? '');
  return padded;
}

function csvLine(cells: readonly string[]): string {
  return cells.map(csvCell).join(',');
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function markdownLine(cells: readonly string[]): string {
  return `| ${cells.map(markdownCell).join(' | ')} |`;
}

function markdownCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, '<br>');
}

function foldText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function countLines(text: string): number {
  return Math.max(1, text.split(/\r\n|\r|\n/).length);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
