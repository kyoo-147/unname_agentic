/**
 * Reading order for multi-column pages (backlog item E02).
 *
 * A PDF stores text in content-stream order, which is the order the producer drew
 * the glyphs: often column after column interleaved, sometimes grouped by font, and
 * regularly not the order a human reads. This module derives reading order from
 * geometry instead. It finds the vertical whitespace corridors that separate the
 * columns, sorts each column top to bottom, and cuts the page into row bands at the
 * blocks that span the columns, so a full-width title or table never ends up after
 * the two-column text it introduces — the classic mistake that pushes an abstract
 * after its own introduction.
 *
 * Contract:
 * - Pure and deterministic: no globals, no clock, no randomness, no DOM, no locale.
 *   The same blocks in any input order produce the same `ordered`, `columns` and
 *   `reasons`. Blocks carrying the same geometry are separated by id and then by
 *   input position, so a shuffle can never change the output.
 * - Geometry is in page points with the origin at the top-left corner and y growing
 *   downwards, matching `TextBlock` in `src/core/types.ts`.
 * - The text area is the union of the blocks' rects, clamped to the page box when
 *   the page has a usable width; a block overhanging its margin therefore cannot
 *   inflate the area and deflate the spanning threshold.
 * - A vertical corridor is a maximal run of equal coverage, where the coverage of a
 *   strip is the number of blocks that cross it. Strips come from the sorted x edges
 *   of the page's blocks. A corridor is accepted as a gutter only when all of these
 *   hold:
 *   1. at least {@link CORRIDOR_RESPECT_SHARE} (60 %) of the page's blocks respect it,
 *      i.e. lie entirely on its left or entirely on its right. The crossing minority
 *      are the spanning blocks, plus any block the producer drew across a boundary;
 *      a page whose content really crosses the corridor everywhere is not columnar.
 *   2. it is a strict local minimum of coverage against the strips on either side, so
 *      the interior of a sparse column — where its own blocks cross — is never
 *      mistaken for whitespace;
 *   3. it is at least {@link MIN_GUTTER_WIDTH} points wide and has at least
 *      {@link MIN_COLUMN_BLOCKS} block entirely on each side, so a margin, or the
 *      white space beside a single wide block, can never become a column.
 *   Two gutters closer than {@link MIN_COLUMN_WIDTH} points are merged into one,
 *   because the column between them could not hold text.
 * - A block *spans* when the page has at least two columns and the block is at least
 *   {@link SPANNING_WIDTH_RATIO} (80 %) of the text area wide. A spanning block
 *   belongs to no column: it closes the current row band, so the blocks above it
 *   come first and the blocks after it continue below.
 * - A non-spanning block is put in the band selected by its vertical centre against
 *   the spanning blocks' centres, then ordered column by column and top to bottom
 *   inside a column. A one-column page is ordered top to bottom, left as the
 *   tie-break. A block that crosses an accepted gutter without reaching the spanning
 *   width stays in the column of its centre and is counted in `column:straddling`;
 *   content with no coverage valley at all is read as one column.
 * - Tie-break everywhere: top edge, then left edge, then block id (code-unit
 *   order), then input position.
 * - Document order concatenates pages ascending by 1-based page number. A page
 *   without a usable number is numbered by its input position; two pages with the
 *   same number keep their input order and their blocks are never interleaved.
 * - `stripRepeats` removes running headers and footers: a block that sits in the top
 *   or bottom {@link HEADER_BAND_SHARE} / {@link FOOTER_BAND_SHARE} of its page and
 *   whose normalised text recurs on at least {@link REPEAT_PAGE_SHARE} of the
 *   document's pages. Normalisation (see {@link normalizeRepeatText}) folds case,
 *   whitespace, edge punctuation and numeric page numbers, so `Page 3` and `Page 12`
 *   are the same text. Removing a repeat does not renumber the surviving `order`
 *   values, so a caller can still map them back to the full list.
 * - Nothing is over-claimed: every accepted gutter, every spanning block and every
 *   removal carries a stable, machine-readable reason. A page with no blocks returns
 *   `page:empty` and no columns instead of inventing a layout.
 */

import type { Rect } from './types';

/** A page box in points; only the width is needed to clamp the text area. */
export interface PageBox {
  width: number;
  height: number;
}

/** A block as the reader holds it, and the fields this module orders by. */
export interface ReadingOrderBlock {
  /** Reader block id (for example `p3-r0`); used as a reading-order tie-break. */
  id: string;
  /** Block box in page points. */
  rect: Rect;
  /** Source text, used only by {@link stripRepeats} to recognise a running header. */
  text: string;
  /** Body size of the block, in points; carried through, not used for ordering. */
  fontSize?: number;
  /** Pre-split lines when the reader already has them; carried through. */
  lines?: readonly string[];
}

/** Letter width assumed when a page box carries no usable width, in points. */
export const DEFAULT_PAGE_WIDTH = 612;

/** Letter height assumed when a page box carries no usable height, in points. */
export const DEFAULT_PAGE_HEIGHT = 792;

/** A corridor is a gutter only when this share of the page's blocks respect it. */
export const CORRIDOR_RESPECT_SHARE = 0.6;

/** Narrowest whitespace strip that can be a column gutter, in points. */
export const MIN_GUTTER_WIDTH = 6;

/** Two gutters closer than this are one gutter, in points. */
export const MIN_COLUMN_WIDTH = 24;

/** A block at least this wide, relative to the text area, spans the columns. */
export const SPANNING_WIDTH_RATIO = 0.8;

/** Blocks that must lie entirely on each side of a gutter for it to be a column break. */
export const MIN_COLUMN_BLOCKS = 1;

/** Top band of a page a running header may start in, as a share of page height. */
export const HEADER_BAND_SHARE = 0.1;

/** Bottom band of a page a running footer may reach, as a share of page height. */
export const FOOTER_BAND_SHARE = 0.1;

/** Share of the document's pages a text must recur on to be stripped. */
export const REPEAT_PAGE_SHARE = 0.5;

/** Fewer pages than this never has a repeat: one page cannot repeat itself. */
export const MIN_REPEAT_PAGES = 2;

/** Longest normalised text that can still be a running header or footer, in characters. */
export const REPEAT_MAX_CHARS = 200;

/** Reason reported for a page that carries no blocks at all. */
export const EMPTY_PAGE_REASON = 'page:empty';

/** Reason reported when a page is read top to bottom, left to right. */
export const ROW_MAJOR_REASON = 'order:row-major';

/** Reason reported when a page is read column by column. */
export const COLUMN_MAJOR_REASON = 'order:column-major';

/** Reason reported for a removed running header. */
export const REPEATED_HEADER_REASON = 'repeated:header';

/** Reason reported for a removed running footer. */
export const REPEATED_FOOTER_REASON = 'repeated:footer';

const EPSILON = 1e-6;

const BAND_SEPARATOR = '\u0000';

/** One column of the page, as the detector found it. */
export interface ReadingColumn {
  /** 0-based column index, left to right. */
  index: number;
  /** Left edge, the previous gutter's midpoint or the text area's left edge. */
  left: number;
  /** Right edge, the next gutter's midpoint or the text area's right edge. */
  right: number;
  /** Ids of the blocks in this column, in page reading order. */
  blockIds: string[];
}

/** A page in reading order. */
export interface ReadingOrder<T extends ReadingOrderBlock> {
  /** The same blocks, in reading order; input objects are carried, never copied. */
  ordered: T[];
  /** Detected columns, left to right; empty for a page without blocks. */
  columns: ReadingColumn[];
  /** Stable, machine-readable evidence for the order; never user-facing text. */
  reasons: string[];
}

/** A block together with the page it sits on and its place in the document. */
export interface OrderedBlock<T extends ReadingOrderBlock> {
  block: T;
  /** 1-based page number. */
  page: number;
  /** Height of the block's page in points, so header/footer bands need no page list. */
  pageHeight: number;
  /** 0-based position across the whole document. */
  order: number;
  /** 0-based column index, or `null` for a spanning block. */
  column: number | null;
  /** True when the block spans the columns and closes a row band. */
  spanning: boolean;
}

/** A page as {@link orderDocument} consumed it. */
export interface ReadingOrderPage<T extends ReadingOrderBlock> {
  /** 1-based page number; a page without one is numbered by its input position. */
  page?: number;
  width: number;
  height: number;
  blocks: readonly T[];
}

/** Per-page summary of a document reading order. */
export interface PageReadingOrder {
  /** 1-based page number. */
  page: number;
  /** Blocks the page contributed, including spanning blocks. */
  blockCount: number;
  columns: ReadingColumn[];
  reasons: string[];
}

/** Reading order across the whole document. */
export interface DocumentReadingOrder<T extends ReadingOrderBlock> {
  ordered: OrderedBlock<T>[];
  /** Per-page summaries, in document page order. */
  pages: PageReadingOrder[];
  reasons: string[];
}

/** Tuning for {@link stripRepeats}; every field is optional. */
export interface StripRepeatsOptions {
  /** Share of the document's pages a text must recur on. Defaults to 0.5. */
  minPageShare?: number;
  /** Top band a header may start in, as a share of page height. Defaults to 0.1. */
  headerBand?: number;
  /** Bottom band a footer may reach, as a share of page height. Defaults to 0.1. */
  footerBand?: number;
  /** Longest normalised text still considered a header or footer. Defaults to 200. */
  maxChars?: number;
}

/** One block removed by {@link stripRepeats}. */
export interface RemovedRepeat<T extends ReadingOrderBlock> {
  block: T;
  /** 1-based page the block was on. */
  page: number;
  /** {@link REPEATED_HEADER_REASON} or {@link REPEATED_FOOTER_REASON}. */
  reason: string;
  /** Normalised text that identified the repeat. */
  key: string;
  /** Number of distinct pages the key appeared on in that band. */
  pages: number;
}

/** Result of {@link stripRepeats}. */
export interface StripRepeatsResult<T extends ReadingOrderBlock> {
  /** Surviving blocks, in the order they were given; `order` values are unchanged. */
  kept: OrderedBlock<T>[];
  /** Removed running headers and footers, in the order they were given. */
  removed: RemovedRepeat<T>[];
}

/**
 * Orders one page's blocks.
 *
 * Steps: size the text area from the blocks, detect the column gutters, mark the
 * spanning blocks, cut the page into row bands at them, order each band column by
 * column and top to bottom, and report what was found. A page without blocks returns
 * no columns and no order; a page with no accepted gutter is one column read top to
 * bottom, left to right.
 */
export function orderBlocks<T extends ReadingOrderBlock>(
  blocks: readonly T[],
  page: PageBox,
): ReadingOrder<T> {
  const layout = layoutPage(blocks, page);
  return {
    ordered: layout.ordered.map(entry => entry.block),
    columns: layout.columns,
    reasons: layout.reasons,
  };
}

/**
 * Orders a whole document, page after page.
 *
 * Pages are concatenated in ascending 1-based page number; a page without a usable
 * number is numbered by its input position, and two pages with the same number keep
 * their input order. Blocks are never interleaved between pages, so page 2 always
 * starts after the last block of page 1. Every block is annotated with its page, its
 * page height, its global `order`, its column (or `null` when it spans) and whether
 * it spans.
 */
export function orderDocument<T extends ReadingOrderBlock>(
  pages: readonly ReadingOrderPage<T>[],
): DocumentReadingOrder<T> {
  const input = Array.isArray(pages) ? pages : [];
  const rows = input.map((page, index) => ({ page, index, number: pageNumberOf(page, index) }));
  rows.sort((left, right) => {
    if (left.number !== right.number) return left.number - right.number;
    return left.index - right.index;
  });

  const ordered: OrderedBlock<T>[] = [];
  const summaries: PageReadingOrder[] = [];
  for (const row of rows) {
    const blocks: readonly T[] = Array.isArray(row.page?.blocks) ? row.page.blocks : [];
    const height = positiveOr(row.page?.height, DEFAULT_PAGE_HEIGHT);
    const layout = layoutPage(blocks, { width: positiveOr(row.page?.width, DEFAULT_PAGE_WIDTH), height });
    for (const entry of layout.ordered) {
      ordered.push({
        block: entry.block,
        page: row.number,
        pageHeight: height,
        order: ordered.length,
        column: entry.column,
        spanning: entry.spanning,
      });
    }
    summaries.push({
      page: row.number,
      blockCount: blocks.length,
      columns: layout.columns,
      reasons: layout.reasons,
    });
  }

  return {
    ordered,
    pages: summaries,
    reasons: [`document:pages=${summaries.length}`, `document:blocks=${ordered.length}`],
  };
}

/**
 * Normalises a block's text for repeat detection.
 *
 * Four documented steps, in order: collapse every whitespace run to one space and
 * trim; lowercase with `toLowerCase` (locale-independent); drop leading and trailing
 * characters that are neither letters nor numbers; replace every run of decimal
 * digits with `#`. Numeric page numbers are therefore equal, `Page 3` and `page 12`
 * share a key, and `— 3 —` and `— 7 —` share one too. Empty text normalises to the
 * empty string and is never treated as a repeat.
 */
export function normalizeRepeatText(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .replace(/\d+/gu, '#');
}

/**
 * Removes running headers and footers from an ordered document.
 *
 * A block is a candidate when it starts inside the top band of its page (a header)
 * or reaches into the bottom band (a footer) and its normalised text is non-empty
 * and no longer than `maxChars`. A candidate is removed when its band-and-text key
 * appears on at least `minPageShare` of the document's pages — at least
 * {@link MIN_REPEAT_PAGES} pages, so a one-page document never loses anything. A
 * repeated line outside both bands is body text and is kept. `kept` preserves the
 * input order and the original `order` values.
 */
export function stripRepeats<T extends ReadingOrderBlock>(
  ordered: readonly OrderedBlock<T>[],
  options: StripRepeatsOptions = {},
): StripRepeatsResult<T> {
  const settings = readRepeatSettings(options);
  const entries: readonly OrderedBlock<T>[] = Array.isArray(ordered) ? ordered : [];
  const kept: OrderedBlock<T>[] = [];
  const removed: RemovedRepeat<T>[] = [];
  if (entries.length === 0) return { kept, removed };

  const pages = new Set<number>();
  for (const entry of entries) pages.add(entry.page);
  if (pages.size < MIN_REPEAT_PAGES) return { kept: [...entries], removed: [] };

  const candidates = entries.map(entry => ({ entry, candidate: repeatCandidate(entry, settings) }));
  const pagesByKey = new Map<string, Set<number>>();
  for (const { entry, candidate } of candidates) {
    if (candidate === null) continue;
    const key = repeatKey(candidate);
    const seen = pagesByKey.get(key);
    if (seen) seen.add(entry.page);
    else pagesByKey.set(key, new Set([entry.page]));
  }

  const threshold = Math.max(MIN_REPEAT_PAGES, Math.ceil(pages.size * settings.minPageShare));
  for (const { entry, candidate } of candidates) {
    if (candidate === null) {
      kept.push(entry);
      continue;
    }
    const count = pagesByKey.get(repeatKey(candidate))?.size ?? 0;
    if (count < threshold) {
      kept.push(entry);
      continue;
    }
    removed.push({
      block: entry.block,
      page: entry.page,
      reason: candidate.band === 'header' ? REPEATED_HEADER_REASON : REPEATED_FOOTER_REASON,
      key: candidate.key,
      pages: count,
    });
  }

  return { kept, removed };
}

// --- Layout ----------------------------------------------------------------

/** A block after geometry normalisation, plus the layout verdicts written onto it. */
interface Item<T extends ReadingOrderBlock> {
  block: T;
  index: number;
  id: string;
  left: number;
  right: number;
  top: number;
  centerX: number;
  centerY: number;
  width: number;
  /** 0-based column, or `null` for a spanning block. */
  column: number | null;
  spanning: boolean;
}

/** A block as it leaves the layout, with the verdicts a caller can inspect. */
interface LayoutEntry<T extends ReadingOrderBlock> {
  block: T;
  column: number | null;
  spanning: boolean;
}

interface PageLayout<T extends ReadingOrderBlock> {
  ordered: LayoutEntry<T>[];
  columns: ReadingColumn[];
  reasons: string[];
}

interface Area {
  left: number;
  right: number;
}

interface Corridor {
  left: number;
  right: number;
}

interface ColumnDetection {
  boundaries: number[];
  /** Accepted gutters, before column boundaries are taken from their midpoints. */
  gutters: number;
}

function layoutPage<T extends ReadingOrderBlock>(
  blocks: readonly T[],
  page: PageBox,
): PageLayout<T> {
  const source: readonly T[] = Array.isArray(blocks) ? blocks : [];
  const items = source.map((block, index) => toItem(block, index));
  if (items.length === 0) return { ordered: [], columns: [], reasons: [EMPTY_PAGE_REASON] };

  const area = textArea(items, page);
  const spanningWidth = SPANNING_WIDTH_RATIO * (area.right - area.left);
  const detection = detectColumns(items, area);
  const boundaries = detection.boundaries;
  const multiColumn = boundaries.length > 0;

  const spans: Item<T>[] = [];
  for (const item of items) {
    item.spanning =
      multiColumn && spanningWidth > 0 && item.width + EPSILON >= spanningWidth;
    if (item.spanning) {
      spans.push(item);
      continue;
    }
    item.column = multiColumn ? columnAt(item.centerX, boundaries) : 0;
  }
  spans.sort(compareGeometry);

  const bandCount = spans.length + 1;
  const groups: Item<T>[][] = Array.from({ length: bandCount }, () => []);
  for (const item of items) {
    if (item.spanning) continue;
    const band = bandOf(item, spans);
    const group = groups[band] ?? groups[0];
    if (group) group.push(item);
  }
  for (const group of groups) group.sort((left, right) => compareInBand(left, right, multiColumn));

  const orderedItems: Item<T>[] = [];
  for (let band = 0; band < bandCount; band += 1) {
    const group = groups[band];
    if (group) orderedItems.push(...group);
    const span = spans[band];
    if (span !== undefined) orderedItems.push(span);
  }

  const columns = buildColumns(orderedItems, boundaries, area);
  return {
    ordered: orderedItems.map(item => ({
      block: item.block,
      column: item.column,
      spanning: item.spanning,
    })),
    columns,
    reasons: layoutReasons(items, area, detection, columns.length, spans.length, multiColumn, spanningWidth),
  };
}

function layoutReasons<T extends ReadingOrderBlock>(
  items: readonly Item<T>[],
  area: Area,
  detection: ColumnDetection,
  columnCount: number,
  spanCount: number,
  multiColumn: boolean,
  spanningWidth: number,
): string[] {
  const reasons = [
    `text-area:width=${fmt(area.right - area.left)}`,
    `column:count=${columnCount}`,
    `column:gutter=${detection.gutters}`,
    multiColumn ? COLUMN_MAJOR_REASON : ROW_MAJOR_REASON,
  ];
  if (!multiColumn) return reasons;

  reasons.push(`spanning:width=${fmt(spanningWidth)}`);
  reasons.push(`spanning:count=${spanCount}`);
  if (spanCount > 0) reasons.push(`band:count=${spanCount + 1}`);
  const straddling = items.filter(item => !item.spanning && straddles(item, detection.boundaries)).length;
  if (straddling > 0) reasons.push(`column:straddling=${straddling}`);
  return reasons;
}

function buildColumns<T extends ReadingOrderBlock>(
  ordered: readonly Item<T>[],
  boundaries: readonly number[],
  area: Area,
): ReadingColumn[] {
  const columns: ReadingColumn[] = [];
  for (let index = 0; index <= boundaries.length; index += 1) {
    const left = index === 0 ? area.left : boundaries[index - 1] ?? area.left;
    const right = index === boundaries.length ? area.right : boundaries[index] ?? area.right;
    columns.push({ index, left, right, blockIds: [] });
  }
  for (const item of ordered) {
    if (item.column === null) continue;
    columns[item.column]?.blockIds.push(item.id);
  }
  return columns;
}

/** Detects the column gutters of a page; see the module contract for the rules. */
function detectColumns<T extends ReadingOrderBlock>(
  items: readonly Item<T>[],
  area: Area,
): ColumnDetection {
  const total = items.length;
  const strips = coverageStrips(items, area);
  const accepted: Corridor[] = [];
  const limit = (1 - CORRIDOR_RESPECT_SHARE) * total;

  strips.forEach((strip, index) => {
    if (strip.crossing > limit + EPSILON) return;
    const before = strips[index - 1];
    const after = strips[index + 1];
    // A gutter is a coverage valley: a sparse column's own blocks cross its interior,
    // so a strip that is not emptier than its neighbours is column content.
    if (before !== undefined && strip.crossing >= before.crossing - EPSILON) return;
    if (after !== undefined && strip.crossing >= after.crossing - EPSILON) return;
    if (strip.right - strip.left < MIN_GUTTER_WIDTH - EPSILON) return;

    const left = items.filter(item => item.right <= strip.left + EPSILON).length;
    const right = items.filter(item => item.left >= strip.right - EPSILON).length;
    if (left < MIN_COLUMN_BLOCKS || right < MIN_COLUMN_BLOCKS) return;
    accepted.push({ left: strip.left, right: strip.right });
  });

  const merged: Corridor[] = [];
  for (const corridor of accepted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && corridor.left - last.right < MIN_COLUMN_WIDTH) {
      last.right = Math.max(last.right, corridor.right);
      continue;
    }
    merged.push({ left: corridor.left, right: corridor.right });
  }

  const gutters = merged.filter(corridor => corridor.right - corridor.left >= MIN_GUTTER_WIDTH - EPSILON);
  return {
    boundaries: gutters.map(corridor => (corridor.left + corridor.right) / 2),
    gutters: gutters.length,
  };
}

/** One strip between two consecutive block x edges, and the blocks crossing it. */
interface Strip {
  left: number;
  right: number;
  crossing: number;
}

/**
 * Cuts the text area at every block x edge and counts the blocks crossing each strip.
 * Adjacent strips with the same crossing count are merged into one, so a corridor is
 * a maximal run of equal coverage.
 */
function coverageStrips<T extends ReadingOrderBlock>(
  items: readonly Item<T>[],
  area: Area,
): Strip[] {
  const edges: number[] = [];
  for (const item of items) {
    edges.push(clamp(item.left, area.left, area.right));
    edges.push(clamp(item.right, area.left, area.right));
  }
  const sorted = [...new Set(edges)].sort((left, right) => left - right);

  const strips: Strip[] = [];
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const left = sorted[index];
    const right = sorted[index + 1];
    if (left === undefined || right === undefined || right - left <= EPSILON) continue;
    const crossing = items.filter(
      item => item.left < right - EPSILON && item.right > left + EPSILON,
    ).length;
    const last = strips[strips.length - 1];
    if (last !== undefined && last.crossing === crossing && Math.abs(last.right - left) <= EPSILON) {
      last.right = right;
      continue;
    }
    strips.push({ left, right, crossing });
  }
  return strips;
}

/**
 * The text area: the union of the blocks' rects, clamped to the page box when the
 * page has a usable width, so a block overhanging its margin cannot widen the area.
 */
function textArea<T extends ReadingOrderBlock>(items: readonly Item<T>[], page: PageBox): Area {
  const pageWidth = positiveOr(page?.width, 0);
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    if (item.right <= item.left) continue;
    left = Math.min(left, item.left);
    right = Math.max(right, item.right);
  }

  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    const width = pageWidth > 0 ? pageWidth : DEFAULT_PAGE_WIDTH;
    return { left: 0, right: width };
  }
  if (pageWidth > 0) {
    left = clamp(left, 0, pageWidth);
    right = clamp(right, 0, pageWidth);
  }
  if (right - left <= EPSILON) {
    const width = pageWidth > 0 ? pageWidth : DEFAULT_PAGE_WIDTH;
    return { left: 0, right: width };
  }
  return { left, right };
}

function columnAt(centerX: number, boundaries: readonly number[]): number {
  let column = 0;
  for (const boundary of boundaries) {
    if (centerX >= boundary) column += 1;
  }
  return column;
}

function bandOf<T extends ReadingOrderBlock>(
  item: Item<T>,
  spans: readonly Item<T>[],
): number {
  let band = 0;
  for (const span of spans) {
    if (span.centerY < item.centerY) band += 1;
  }
  return band;
}

function straddles<T extends ReadingOrderBlock>(item: Item<T>, boundaries: readonly number[]): boolean {
  return boundaries.some(
    boundary => item.left < boundary - EPSILON && item.right > boundary + EPSILON,
  );
}

function compareInBand<T extends ReadingOrderBlock>(
  left: Item<T>,
  right: Item<T>,
  multiColumn: boolean,
): number {
  if (multiColumn) {
    const leftColumn = left.column ?? 0;
    const rightColumn = right.column ?? 0;
    if (leftColumn !== rightColumn) return leftColumn - rightColumn;
  }
  return compareGeometry(left, right);
}

/** The documented tie-break: top, left, id, input position. */
function compareGeometry<T extends ReadingOrderBlock>(left: Item<T>, right: Item<T>): number {
  if (left.top !== right.top) return left.top - right.top;
  if (left.left !== right.left) return left.left - right.left;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return left.index - right.index;
}

function toItem<T extends ReadingOrderBlock>(block: T, index: number): Item<T> {
  const rect = block?.rect;
  const x = finiteOr(rect?.x, 0);
  const y = finiteOr(rect?.y, 0);
  const width = Math.max(0, finiteOr(rect?.width, 0));
  const height = Math.max(0, finiteOr(rect?.height, 0));
  return {
    block,
    index,
    id: nonEmpty(block?.id) ?? `order-b${index}`,
    left: x,
    right: x + width,
    top: y,
    centerX: x + width / 2,
    centerY: y + height / 2,
    width,
    column: null,
    spanning: false,
  };
}

// --- Repeats ---------------------------------------------------------------

interface RepeatSettings {
  minPageShare: number;
  headerBand: number;
  footerBand: number;
  maxChars: number;
}

interface RepeatCandidate {
  band: 'header' | 'footer';
  key: string;
}

function repeatCandidate<T extends ReadingOrderBlock>(
  entry: OrderedBlock<T>,
  settings: RepeatSettings,
): RepeatCandidate | null {
  const height = entry.pageHeight;
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return null;
  const rect = entry.block?.rect;
  const top = finiteOr(rect?.y, Number.NaN);
  if (!Number.isFinite(top)) return null;

  const key = normalizeRepeatText(entry.block?.text ?? '');
  if (key.length === 0 || key.length > settings.maxChars) return null;

  const bottom = top + Math.max(0, finiteOr(rect?.height, 0));
  if (top <= height * settings.headerBand + EPSILON) return { band: 'header', key };
  if (bottom >= height * (1 - settings.footerBand) - EPSILON) return { band: 'footer', key };
  return null;
}

function repeatKey(candidate: RepeatCandidate): string {
  return `${candidate.band}${BAND_SEPARATOR}${candidate.key}`;
}

function readRepeatSettings(options: StripRepeatsOptions | undefined): RepeatSettings {
  return {
    minPageShare: shareOr(options?.minPageShare, REPEAT_PAGE_SHARE),
    headerBand: Math.min(0.5, shareOr(options?.headerBand, HEADER_BAND_SHARE)),
    footerBand: Math.min(0.5, shareOr(options?.footerBand, FOOTER_BAND_SHARE)),
    maxChars: Math.max(1, Math.floor(positiveOr(options?.maxChars, REPEAT_MAX_CHARS))),
  };
}

function pageNumberOf<T extends ReadingOrderBlock>(
  page: ReadingOrderPage<T> | undefined,
  index: number,
): number {
  const number = page?.page;
  return typeof number === 'number' && Number.isInteger(number) && number >= 1 ? number : index + 1;
}

// --- Small helpers ---------------------------------------------------------

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function shareOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : fallback;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Two decimals, locale-independent, so reason strings are stable across machines. */
function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}
