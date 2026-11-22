/**
 * Semantic block typing (backlog item E03).
 *
 * The reader groups PDF text into geometry-only blocks. Later items — table
 * extraction (E06), formula recovery (E07), caption linking (E08) and the section
 * outline (E05) — first need to know what a block *is*. This module is that
 * judgement: one pure function per block ({@link classifyBlock}) plus a page-level
 * driver ({@link classifyBlocks}) that estimates the page body size, walks the
 * blocks in reading order and ranks headings by relative size.
 *
 * Contract:
 * - Pure and deterministic: no globals, no clock, no randomness, no DOM. The same
 *   input always yields the same type, confidence and reason list.
 * - Nothing is over-claimed. Every verdict carries a `confidence` in (0, 1] plus
 *   the evidence that produced it (`reasons`). A blob that looks like a table but
 *   has no regular column gaps is reported as `other` *with that reason*, not as a
 *   table; a display-size numbered line is a heading, not a list.
 * - Geometry is in page points, origin at the top-left corner, y growing
 *   downwards, matching `TextBlock` in `src/core/types.ts`.
 * - `classifyBlock(block, context)` splits the inputs by scope: the block carries
 *   its own text and geometry (`text`, `rect`, `fontSize`, `isBold`,
 *   `imageCoverage`); the context carries page-level state (`pageHeight`, the page
 *   median `medianFontSize`, and the other `neighbours` on the page). The page
 *   height cannot be inferred from a single block, so it lives in the context.
 */

import type { Rect } from './types';

export type SemanticBlockType =
  | 'heading'
  | 'paragraph'
  | 'list'
  | 'table'
  | 'figure'
  | 'formula'
  | 'footnote'
  | 'caption'
  | 'other';

export const SEMANTIC_BLOCK_TYPES: readonly SemanticBlockType[] = [
  'heading',
  'paragraph',
  'list',
  'table',
  'figure',
  'formula',
  'footnote',
  'caption',
  'other',
];

export type HeadingLevel = 1 | 2 | 3;

/** Deepest heading level this classifier emits; a fourth size tier also lands on 3. */
export const MAX_HEADING_LEVEL: HeadingLevel = 3;

/** Body size assumed when neither the context nor the neighbours say otherwise, in points. */
export const DEFAULT_BODY_FONT_SIZE = 10.5;

/** Page height assumed when a block does not carry one, in points (US Letter). */
export const DEFAULT_PAGE_HEIGHT = 792;

/** A heading must be at least this much larger than the page median. */
export const HEADING_MIN_FONT_SCALE = 1.15;

/** Longer text is never a heading, whatever its size. */
export const HEADING_MAX_CHARS = 120;

/** A heading that wraps is still one heading; more lines than this make it a paragraph. */
export const HEADING_MAX_LINES = 4;

/** A footnote is at most this fraction of the page median font size. */
export const FOOTNOTE_MAX_FONT_SCALE = 0.9;

/** A footnote starts in the bottom this share of the page. */
export const FOOTNOTE_BOTTOM_BAND = 0.82;

/** A figure must have at least this much of its area covered by a raster image. */
export const FIGURE_MIN_COVERAGE = 0.5;

/** Above this share of math characters a block is a formula candidate. */
export const FORMULA_MIN_MATH_RATIO = 0.18;

/** `Figure 3`, `Fig. 4`, `Table 2`, `Algorithm 1` at the very start of a block. */
const CAPTION_PATTERN = /^(?:Figure|Fig\.|Table|Algorithm)\s*\d/iu;

/** A bullet, an ordinal (`1.`, `1)`, `(1)`) or a lettered item (`a)`, `(b)`). */
const LIST_MARKER_PATTERN =
  /^\s*((?:[-•▪◦‣∙·*–—])|(?:\(?[ivxlcdmIVXLCDM]{2,5}[.)])|(?:\(?\d{1,3}[.)])|(?:\(?[a-zA-Z][.)]))\s+/u;

/** Two or more spaces, or a tab, is the only column separator a text run keeps. */
const COLUMN_GAP_PATTERN = /\t+| {2,}/u;

const MATH_SYMBOL_CHARACTERS = new Set(
  Array.from(
    '=+×÷±∓−·⋅∗*/^_<>≤≥≈≠≡∼~∑∏∫∬√∞∂∇→←↔⇒⇔∈∉⊂⊃∪∩∀∃¬∧∨()[]{}|°′″²³¹⁰⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉αβγδεζηθικλμνξπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΠΡΣΤΥΦΧΨΩ',
  ),
);

/** At least one real operator, so parentheses in prose cannot reach the symbol ratio. */
const MATH_OPERATOR_PATTERN = /[=+×÷±∓−∑∏∫√∞∂∇→←↔⇒⇔∈∉≤≥≠≈^_<>]/u;
const MATH_RELATION_PATTERN = /[=<>≈≤≥≠≡∼~]/u;
const LATEX_PATTERN = /\\[a-zA-Z]{2,}/u;

/** Minimum share of a block's lines that must be multi-cell before a table is claimed. */
const TABLE_MIN_MULTI_CELL_SHARE = 0.8;
/** Minimum agreement on the column count across those lines. */
const TABLE_MIN_COLUMN_CONSISTENCY = 0.8;
/** Minimum regularity of the gap widths between columns. */
const TABLE_MIN_GAP_REGULARITY = 0.55;
/** Lines with a gap this share of the mean are "regular enough" to count as columns. */
const TABLE_NEIGHBOUR_REGULARITY = 0.6;

const TIE_EPSILON = 1e-9;
/** A competitor this close to the winner is worth naming in the reasons. */
const CLOSE_CALL_MARGIN = 0.1;

/** A block and the geometry the reader already measured for it. */
export interface BlockFeatures {
  text: string;
  rect: Rect;
  fontSize: number;
  /** Set when the reader knows the run was drawn with a bold face. */
  isBold?: boolean;
  /** Fraction of `rect` covered by a raster image, 0..1; 0 when the block is text only. */
  imageCoverage?: number;
}

/**
 * Page-level state a block cannot carry itself.
 *
 * `pageHeight` decides the bottom band, `medianFontSize` is the body size the
 * block is compared against, and `neighbours` are the *other* blocks on the same
 * page (passing the block itself is allowed; it is ignored where it matters).
 */
export interface BlockContext {
  /** Height of the page the block sits on, in points. */
  pageHeight: number;
  /** Page median font size; computed by {@link classifyBlocks}, or by the caller. */
  medianFontSize?: number;
  /** Other blocks on the page, used for row/column and caption adjacency evidence. */
  neighbours?: readonly BlockFeatures[];
}

export interface BlockClassification {
  type: SemanticBlockType;
  /** How strongly the evidence supports `type`, in (0, 1]. */
  confidence: number;
  /** Stable, machine-readable identifiers for the evidence; never user-facing text. */
  reasons: string[];
}

/** A block as the reader holds it, plus the page metadata classification needs. */
export interface BlockInput extends BlockFeatures {
  /** Reader block id (for example `p3-r0`); only used as a reading-order tie-break. */
  id?: string;
  /** 1-based page number; blocks without one are treated as page 1. */
  page?: number;
  /** Height of the block's page in points; defaults to {@link DEFAULT_PAGE_HEIGHT}. */
  pageHeight?: number;
}

export interface ClassifiedBlock extends BlockInput, BlockClassification {
  /** 1..3 for headings only, from the relative size rank; absent for every other type. */
  headingLevel?: HeadingLevel;
}

/** Evidence for one candidate type before the winner is chosen. */
interface Candidate {
  type: SemanticBlockType;
  score: number;
  reasons: string[];
}

/** A block after defaults and sanity limits are applied. */
interface NormalizedBlock {
  text: string;
  rect: Rect;
  fontSize: number;
  isBold: boolean;
  imageCoverage: number;
}

/** One line split at its column gaps. */
interface RowSplit {
  cells: string[];
  gaps: number[];
}

interface TableSignal {
  /** Non-empty lines in the block. */
  rows: number;
  /** Lines that split into at least two cells. */
  multiCellLines: number;
  /** Most common column count across those lines. */
  columns: number;
  /** Lowest and highest column count seen, so an irregular block can report a range. */
  minColumns: number;
  maxColumns: number;
  /** Share of multi-cell lines that agree with `columns`. */
  consistency: number;
  /** How even the gap widths are per column, 0..1. */
  regularity: number;
  /** True when the block is regular enough to be called a table. */
  regular: boolean;
}

/** Precedence for exact score ties only: the more specific reading wins. */
const TYPE_PRIORITY: Record<SemanticBlockType, number> = {
  heading: 0,
  list: 1,
  caption: 2,
  footnote: 3,
  table: 4,
  formula: 5,
  figure: 6,
  paragraph: 7,
  other: 8,
};

/**
 * Classifies one block against its page.
 *
 * Every rule is a candidate with a score in (0, 1]; the highest score wins and
 * becomes the confidence. A rule that does not fire is not a candidate at all,
 * so the reason list always explains the verdict rather than the alternatives —
 * except for a `close-call:<type>=<score>` line, added when a second reading
 * came within {@link CLOSE_CALL_MARGIN}.
 *
 * Defaults when the context is thin: a missing `medianFontSize` falls back to the
 * neighbours' median, then to the block's own size (which disables heading
 * detection); a missing `pageHeight` falls back to {@link DEFAULT_PAGE_HEIGHT}.
 */
export function classifyBlock(block: BlockFeatures, context: BlockContext): BlockClassification {
  const features = normalizeBlock(block);
  const neighbours = Array.isArray(context?.neighbours) ? context.neighbours : [];
  const pageHeight = positiveOr(context?.pageHeight, DEFAULT_PAGE_HEIGHT);
  const median = contextMedian(context?.medianFontSize, neighbours, features.fontSize);

  if (collapsed(features.text).length === 0 && features.imageCoverage < FIGURE_MIN_COVERAGE) {
    return { type: 'other', confidence: 0.2, reasons: ['other:empty-text'] };
  }

  const scale = features.fontSize / median;
  const bottom = clamp01((features.rect.y + features.rect.height) / pageHeight);
  const table = readTableSignal(features.text);

  const candidates = [
    headingCandidate(features, scale),
    listCandidate(features, scale),
    captionCandidate(features, table, neighbours),
    footnoteCandidate(scale, bottom),
    formulaCandidate(features.text),
    tableCandidate(table, table ? rowNeighbourBoost(features, neighbours) : 0),
    figureCandidate(features),
    ambiguousTableCandidate(table),
    paragraphCandidate(features, scale),
  ].filter((candidate): candidate is Candidate => candidate !== null);

  const best = pickBest(candidates);
  const reasons = [...best.reasons];
  const runnerUp = candidates
    .filter(candidate => candidate.type !== best.type && candidate.score >= best.score - CLOSE_CALL_MARGIN)
    .sort((left, right) => right.score - left.score)[0];
  if (runnerUp) reasons.push(`close-call:${runnerUp.type}=${fmt(runnerUp.score)}`);

  return { type: best.type, confidence: round4(clamp01(best.score)), reasons };
}

/**
 * Classifies a list of blocks as one document.
 *
 * Steps, in order: sort the blocks into reading order (page, then top edge in a
 * 0.5 pt bucket so sub-point noise cannot reorder a line, then left edge, then
 * id, then input position); compute the page body size; classify each block with
 * its page context; rank the heading sizes and assign `headingLevel` 1..3 (largest
 * size is level 1, sizes within `max(0.5 pt, 4 %)` share a level, a fourth tier
 * and beyond stay at 3).
 *
 * The page body size is the font size most of the text is set in: the median of
 * the sizes weighted by each block's character count. An unweighted median breaks
 * on sparse pages — a page holding two headings and one paragraph would report the
 * smaller heading as body size, and then fail to see that heading at all.
 *
 * The result is a new array in reading order; the input blocks are not mutated.
 */
export function classifyBlocks(blocks: readonly BlockInput[]): ClassifiedBlock[] {
  const rows = blocks
    .map((block, index) => ({ block, index }))
    .sort((left, right) => compareReadingOrder(left.block, right.block, left.index, right.index));

  const medians = pageMedians(rows.map(row => row.block));
  const heights = pageHeights(rows.map(row => row.block));
  const features = rows.map(row => toFeatures(row.block));
  const classified: ClassifiedBlock[] = [];

  rows.forEach((row, position) => {
    const feature = features[position];
    if (!feature) return;
    const page = pageOf(row.block);
    const classification = classifyBlock(feature, {
      pageHeight: heights.get(page) ?? DEFAULT_PAGE_HEIGHT,
      medianFontSize: medians.get(page) ?? DEFAULT_BODY_FONT_SIZE,
      neighbours: features.filter((_, other) => other !== position),
    });
    classified.push({
      ...row.block,
      type: classification.type,
      confidence: classification.confidence,
      reasons: classification.reasons,
    });
  });

  assignHeadingLevels(classified);
  return classified;
}

/**
 * Median of an unweighted font-size sample.
 *
 * Exposed because a caller classifying one block by hand has to supply
 * `medianFontSize` itself, and this is the same arithmetic on a plain sample.
 * {@link classifyBlocks} does not use it for the page body size: it weights each
 * size by how much text is set in it (see `weightedMedian`).
 *
 * Non-finite and non-positive sizes are dropped; an empty sample returns
 * {@link DEFAULT_BODY_FONT_SIZE} rather than zero, so a caller can never divide
 * by it. An even sample averages the two middle values.
 */
export function medianFontSize(values: readonly number[]): number {
  const numbers = values
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (numbers.length === 0) return DEFAULT_BODY_FONT_SIZE;
  const middle = Math.floor(numbers.length / 2);
  if (numbers.length % 2 === 1) return numbers[middle] ?? DEFAULT_BODY_FONT_SIZE;
  const low = numbers[middle - 1] ?? DEFAULT_BODY_FONT_SIZE;
  const high = numbers[middle] ?? DEFAULT_BODY_FONT_SIZE;
  return (low + high) / 2;
}

// --- Rules ----------------------------------------------------------------

function headingCandidate(block: NormalizedBlock, scale: number): Candidate | null {
  if (scale < HEADING_MIN_FONT_SCALE) return null;
  const chars = charCount(block.text);
  if (chars === 0 || chars > HEADING_MAX_CHARS) return null;
  const lines = textLines(block.text).length;
  if (lines > HEADING_MAX_LINES) return null;

  const sizeScore = clamp01((scale - HEADING_MIN_FONT_SCALE) / 0.85);
  const lengthScore = clamp01(1 - chars / HEADING_MAX_CHARS);
  const score = 0.55 + 0.3 * sizeScore + 0.1 * lengthScore + (block.isBold ? 0.05 : 0);
  const reasons = [`heading:font-scale=${fmt(scale)}`, `heading:chars=${chars}`];
  if (block.isBold) reasons.push('heading:bold');
  if (lines > 1) reasons.push(`heading:lines=${lines}`);
  return { type: 'heading', score, reasons };
}

function listCandidate(block: NormalizedBlock, scale: number): Candidate | null {
  const lines = textLines(block.text);
  const first = lines[0];
  if (!first) return null;
  const marker = listMarkerOf(first);
  if (!marker) return null;

  const marked = lines.filter(line => listMarkerOf(line) !== null).length;
  // A display-size numbered line ("3. Method") is a section title, not a list item:
  // the size evidence outranks the marker, and losing quietly here is safer than
  // reporting a heading as list content.
  const displaySize = scale >= HEADING_MIN_FONT_SCALE;
  const allMarked = marked === lines.length;
  const score = 0.92 + (allMarked ? 0.03 : 0) - (displaySize ? 0.25 : 0);

  const reasons = [`list:marker=${marker}`, `list:lines=${marked}/${lines.length}`];
  if (allMarked) reasons.push('list:all-lines-marked');
  if (displaySize) reasons.push('list:display-size');
  return { type: 'list', score, reasons };
}

function captionCandidate(
  block: NormalizedBlock,
  table: TableSignal | null,
  neighbours: readonly BlockFeatures[],
): Candidate | null {
  const first = textLines(block.text)[0];
  if (!first || !CAPTION_PATTERN.test(first)) return null;

  const lines = textLines(block.text).length;
  const score = 0.88;
  const reasons = [`caption:pattern=${(first.match(CAPTION_PATTERN)?.[0] ?? '').trim()}`];

  // A caption introduces a figure or a table; it does not carry the table itself.
  if (table && table.regular) {
    reasons.push('caption:table-like-body');
    return { type: 'caption', score: score - 0.35, reasons };
  }
  if (lines > 3) {
    reasons.push(`caption:lines=${lines}`);
    return { type: 'caption', score: score - 0.15, reasons };
  }
  if (captionSitsNextToFigure(block, neighbours)) {
    reasons.push('caption:next-to-figure');
    return { type: 'caption', score: score + 0.04, reasons };
  }
  return { type: 'caption', score, reasons };
}

function footnoteCandidate(scale: number, bottom: number): Candidate | null {
  if (scale > FOOTNOTE_MAX_FONT_SCALE) return null;
  if (bottom < FOOTNOTE_BOTTOM_BAND) return null;

  const sizeScore = clamp01((FOOTNOTE_MAX_FONT_SCALE - scale) / 0.35);
  const bandScore = clamp01((bottom - FOOTNOTE_BOTTOM_BAND) / (1 - FOOTNOTE_BOTTOM_BAND));
  const score = 0.6 + 0.2 * sizeScore + 0.2 * bandScore;
  return {
    type: 'footnote',
    score,
    reasons: [`footnote:font-scale=${fmt(scale)}`, `footnote:bottom=${fmt(bottom)}`],
  };
}

function formulaCandidate(text: string): Candidate | null {
  const ratio = mathRatio(text);
  const latex = LATEX_PATTERN.test(text);
  const operator = MATH_OPERATOR_PATTERN.test(text);
  const relation = MATH_RELATION_PATTERN.test(text);
  const chars = charCount(text);

  const bySymbols = operator && ratio >= FORMULA_MIN_MATH_RATIO;
  // A short relation-heavy line ("x = 2") is a formula even below the density gate.
  const byRelation = relation && ratio >= 0.08 && chars <= 120;
  if (!bySymbols && !latex && !byRelation) return null;

  const score =
    0.55 + 0.4 * clamp01((ratio - 0.15) / 0.35) + (relation ? 0.05 : 0) + (latex ? 0.12 : 0);
  const reasons = [`formula:math-ratio=${fmt(ratio)}`];
  if (relation) reasons.push('formula:relation');
  if (latex) reasons.push('formula:latex');
  return { type: 'formula', score, reasons };
}

function tableCandidate(table: TableSignal | null, neighbourBoost: number): Candidate | null {
  if (!table || !table.regular) return null;
  const rowScore = Math.min(1, table.multiCellLines / 4);
  const score =
    0.5 +
    0.2 * table.consistency +
    0.2 * table.regularity +
    0.1 * rowScore +
    neighbourBoost;
  const reasons = [
    `table:columns=${table.columns}`,
    `table:rows=${table.multiCellLines}/${table.rows}`,
    `table:gap-regularity=${fmt(table.regularity)}`,
  ];
  if (neighbourBoost > 0) reasons.push('table:aligned-neighbours');
  return { type: 'table', score, reasons };
}

/**
 * A block that splits into cells on some lines but not on most of them is a mixed
 * blob: a table fragment merged with surrounding prose, or a two-column page
 * block. It is reported as `other` so a later table splitter (E06) can carve it,
 * and it outranks a plain paragraph only because the column evidence is real.
 */
function ambiguousTableCandidate(table: TableSignal | null): Candidate | null {
  if (!table || table.regular) return null;
  const columns =
    table.minColumns === table.maxColumns
      ? String(table.minColumns)
      : `${table.minColumns}-${table.maxColumns}`;
  return {
    type: 'other',
    score: 0.62,
    reasons: [
      `other:table-columns-irregular=${table.multiCellLines}/${table.rows}`,
      `other:columns=${columns}`,
      `other:gap-regularity=${fmt(table.regularity)}`,
    ],
  };
}

function figureCandidate(block: NormalizedBlock): Candidate | null {
  if (block.imageCoverage < FIGURE_MIN_COVERAGE) return null;
  const coverageScore = clamp01(
    (block.imageCoverage - FIGURE_MIN_COVERAGE) / (1 - FIGURE_MIN_COVERAGE),
  );
  let score = 0.6 + 0.35 * coverageScore;
  const chars = charCount(block.text);
  const reasons = [`figure:image-coverage=${fmt(block.imageCoverage)}`];
  // Text sitting on top of an image is usually a caption block or a mixed region.
  if (chars > 200) {
    score -= 0.2;
    reasons.push(`figure:text-chars=${chars}`);
  }
  return { type: 'figure', score, reasons };
}

function paragraphCandidate(block: NormalizedBlock, scale: number): Candidate {
  const chars = charCount(block.text);
  const lines = textLines(block.text).length;
  const bodySize = scale >= 0.9 && scale <= 1.1;
  const score = 0.35 + (bodySize ? 0.15 : 0) + (chars >= 160 ? 0.1 : 0) + (lines >= 3 ? 0.05 : 0);
  const reasons = [`paragraph:font-scale=${fmt(scale)}`, `paragraph:chars=${chars}`];
  if (bodySize) reasons.push('paragraph:body-size');
  if (lines >= 3) reasons.push(`paragraph:lines=${lines}`);
  return { type: 'paragraph', score, reasons };
}

// --- Table geometry --------------------------------------------------------

function readTableSignal(text: string): TableSignal | null {
  const lines = textLines(text);
  if (lines.length < 2) return null;

  const rows = lines.map(splitRow);
  const multi = rows.filter(row => row.cells.length >= 2);
  if (multi.length < 2) return null;

  const share = multi.length / rows.length;
  const counts = multi.map(row => row.cells.length);
  const columns = modalNumber(counts);
  const consistency = counts.filter(count => count === columns).length / multi.length;
  const regularity = gapRegularity(multi);
  const regular =
    share >= TABLE_MIN_MULTI_CELL_SHARE &&
    consistency >= TABLE_MIN_COLUMN_CONSISTENCY &&
    columns >= 2 &&
    regularity >= TABLE_MIN_GAP_REGULARITY;

  return {
    rows: rows.length,
    multiCellLines: multi.length,
    columns,
    minColumns: Math.min(...counts),
    maxColumns: Math.max(...counts),
    consistency,
    regularity,
    regular,
  };
}

/** Splits a line into trimmed cells and the gap widths that separated them. */
function splitRow(line: string): RowSplit {
  const parts = line.trim().split(/(\t+| {2,})/u);
  const cells: string[] = [];
  const gaps: number[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      gaps.push(part.length);
      return;
    }
    const cell = part.trim();
    if (cell.length > 0) cells.push(cell);
  });
  return { cells, gaps };
}

/** How even the gap widths are, averaged over the gap positions between columns. */
function gapRegularity(rows: readonly RowSplit[]): number {
  const byPosition = new Map<number, number[]>();
  for (const row of rows) {
    row.gaps.forEach((gap, index) => push(byPosition, index, gap));
  }
  if (byPosition.size === 0) return 0;

  let total = 0;
  let counted = 0;
  for (const gaps of byPosition.values()) {
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    if (mean <= 0) continue;
    const deviation = gaps.reduce((sum, gap) => sum + Math.abs(gap - mean), 0) / gaps.length / mean;
    total += clamp01(1 - deviation);
    counted += 1;
  }
  return counted === 0 ? 0 : total / counted;
}

/**
 * Boosts a table candidate when the row's neighbours line up as further cells:
 * blocks whose vertical centre matches and that sit to the left or right with
 * consistent gaps are the other columns of the same row.
 */
function rowNeighbourBoost(block: NormalizedBlock, neighbours: readonly BlockFeatures[]): number {
  const centre = block.rect.y + block.rect.height / 2;
  const tolerance = Math.max(2, block.rect.height * 0.6);
  const left = block.rect.x;
  const right = block.rect.x + block.rect.width;
  const gaps: number[] = [];

  for (const neighbour of neighbours) {
    const other = normalizeBlock(neighbour);
    const otherCentre = other.rect.y + other.rect.height / 2;
    if (Math.abs(otherCentre - centre) > tolerance) continue;
    const otherLeft = other.rect.x;
    const otherRight = other.rect.x + other.rect.width;
    const gap = otherLeft >= right ? otherLeft - right : left - otherRight;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;

  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  if (mean <= 0) return 0;
  const deviation = gaps.reduce((sum, gap) => sum + Math.abs(gap - mean), 0) / gaps.length / mean;
  return clamp01(1 - deviation) >= TABLE_NEIGHBOUR_REGULARITY ? 0.06 : 0;
}

/** True when a figure-sized block sits directly above or below the caption. */
function captionSitsNextToFigure(block: NormalizedBlock, neighbours: readonly BlockFeatures[]): boolean {
  const limit = Math.max(24, block.rect.height * 3);
  return neighbours.some(neighbour => {
    const other = normalizeBlock(neighbour);
    if (other.imageCoverage < FIGURE_MIN_COVERAGE) return false;
    const below = Math.abs(other.rect.y - (block.rect.y + block.rect.height));
    const above = Math.abs(block.rect.y - (other.rect.y + other.rect.height));
    return Math.min(below, above) <= limit;
  });
}

// --- Page-level drivers ----------------------------------------------------

function pageMedians(blocks: readonly BlockInput[]): Map<number, number> {
  const samples = new Map<number, SizeSample[]>();
  for (const block of blocks) {
    const size = block?.fontSize;
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) continue;
    // One weight per character of text, so the size most of the page is set in wins.
    // An empty block still counts once, so a page of images has a sample at all.
    push(samples, pageOf(block), { size, weight: Math.max(1, charCount(block.text)) });
  }

  const medians = new Map<number, number>();
  for (const [page, group] of samples) {
    const median = weightedMedian(group);
    if (median !== undefined) medians.set(page, median);
  }
  return medians;
}

interface SizeSample {
  size: number;
  weight: number;
}

/**
 * The size at which the accumulated weight first reaches half of the total. The
 * result is always one of the observed sizes, never an interpolation, so a page
 * set in 10 pt and 10.5 pt reports one of those two and not 10.25.
 */
function weightedMedian(samples: readonly SizeSample[]): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((left, right) => left.size - right.size);
  const total = sorted.reduce((sum, sample) => sum + sample.weight, 0);
  let running = 0;
  for (const sample of sorted) {
    running += sample.weight;
    if (running * 2 >= total) return sample.size;
  }
  return sorted[sorted.length - 1]?.size;
}

function pageHeights(blocks: readonly BlockInput[]): Map<number, number> {
  const heights = new Map<number, number>();
  for (const block of blocks) {
    const height = block?.pageHeight;
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) continue;
    const page = pageOf(block);
    heights.set(page, Math.max(heights.get(page) ?? 0, height));
  }
  return heights;
}

/**
 * Ranks heading sizes into levels 1..3. Sizes are clustered top-down with a
 * `max(0.5 pt, 4 %)` tolerance, so 18 pt and 18.4 pt are the same tier; the
 * largest tier is level 1 and anything past the third tier stays at 3.
 */
function assignHeadingLevels(blocks: ClassifiedBlock[]): void {
  const anchors = sizeAnchors(blocks.filter(block => block.type === 'heading').map(block => block.fontSize));
  if (anchors.length === 0) return;

  for (const block of blocks) {
    if (block.type !== 'heading') continue;
    const level = levelForSize(block.fontSize, anchors);
    if (level !== undefined) block.headingLevel = level;
  }
}

function sizeAnchors(sizes: readonly number[]): number[] {
  const unique = [...new Set(sizes.filter(size => Number.isFinite(size) && size > 0))].sort(
    (left, right) => right - left,
  );
  const anchors: number[] = [];
  for (const size of unique) {
    const last = anchors[anchors.length - 1];
    if (last !== undefined && Math.abs(size - last) <= sizeTolerance(last)) continue;
    anchors.push(size);
  }
  return anchors;
}

function levelForSize(size: number, anchors: readonly number[]): HeadingLevel | undefined {
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    if (anchor === undefined) continue;
    if (Math.abs(size - anchor) > sizeTolerance(anchor)) continue;
    const level = Math.min(index + 1, MAX_HEADING_LEVEL);
    return level as HeadingLevel;
  }
  return undefined;
}

function sizeTolerance(anchor: number): number {
  return Math.max(0.5, anchor * 0.04);
}

// --- Inputs, ordering, small helpers --------------------------------------

function toFeatures(block: BlockInput): BlockFeatures {
  return {
    text: typeof block?.text === 'string' ? block.text : '',
    rect: {
      x: finiteOr(block?.rect?.x, 0),
      y: finiteOr(block?.rect?.y, 0),
      width: Math.max(0, finiteOr(block?.rect?.width, 0)),
      height: Math.max(0, finiteOr(block?.rect?.height, 0)),
    },
    fontSize: positiveOr(block?.fontSize, DEFAULT_BODY_FONT_SIZE),
    isBold: block?.isBold === true,
    imageCoverage: clamp01(finiteOr(block?.imageCoverage, 0)),
  };
}

function normalizeBlock(block: BlockFeatures): NormalizedBlock {
  const empty: BlockFeatures = {
    text: '',
    rect: { x: 0, y: 0, width: 0, height: 0 },
    fontSize: DEFAULT_BODY_FONT_SIZE,
  };
  const features = toFeatures(block ?? empty);
  // `toFeatures` always fills both fields; the assertions keep the shape explicit.
  return { ...features, isBold: features.isBold === true, imageCoverage: features.imageCoverage ?? 0 };
}

function contextMedian(
  median: number | undefined,
  neighbours: readonly BlockFeatures[],
  own: number,
): number {
  if (typeof median === 'number' && Number.isFinite(median) && median > 0) return median;
  const sizes = neighbours
    .map(neighbour => neighbour?.fontSize)
    .filter((size): size is number => typeof size === 'number' && Number.isFinite(size) && size > 0);
  if (sizes.length > 0) return medianFontSize(sizes);
  return own;
}

function pageOf(block: BlockInput): number {
  const page = block?.page;
  return typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : 1;
}

function compareReadingOrder(
  left: BlockInput,
  right: BlockInput,
  leftIndex: number,
  rightIndex: number,
): number {
  const leftPage = pageOf(left);
  const rightPage = pageOf(right);
  if (leftPage !== rightPage) return leftPage - rightPage;

  // The 0.5 pt row bucket keeps sub-point baseline noise from reordering a line.
  const leftRow = Math.round(finiteOr(left?.rect?.y, 0) * 2) / 2;
  const rightRow = Math.round(finiteOr(right?.rect?.y, 0) * 2) / 2;
  if (leftRow !== rightRow) return leftRow - rightRow;

  const leftX = finiteOr(left?.rect?.x, 0);
  const rightX = finiteOr(right?.rect?.x, 0);
  if (leftX !== rightX) return leftX - rightX;

  const leftId = left.id ?? '';
  const rightId = right.id ?? '';
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  return leftIndex - rightIndex;
}

function pickBest(candidates: readonly Candidate[]): Candidate {
  const first = candidates[0];
  if (!first) return { type: 'paragraph', score: 0.3, reasons: ['paragraph:no-evidence'] };

  let best = first;
  for (const candidate of candidates.slice(1)) {
    if (candidate.score > best.score + TIE_EPSILON) {
      best = candidate;
      continue;
    }
    if (
      Math.abs(candidate.score - best.score) <= TIE_EPSILON &&
      TYPE_PRIORITY[candidate.type] < TYPE_PRIORITY[best.type]
    ) {
      best = candidate;
    }
  }
  return best;
}

function listMarkerOf(line: string): string | null {
  const match = line.match(LIST_MARKER_PATTERN);
  const marker = match?.[1]?.trim();
  return marker && marker.length > 0 ? marker : null;
}

function mathRatio(text: string): number {
  let symbols = 0;
  let total = 0;
  for (const character of text) {
    if (/\s/u.test(character)) continue;
    total += 1;
    if (MATH_SYMBOL_CHARACTERS.has(character)) symbols += 1;
  }
  return total === 0 ? 0 : symbols / total;
}

function charCount(text: string): number {
  return Array.from(collapsed(text)).length;
}

function collapsed(text: string): string {
  return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
}

function textLines(text: string): string[] {
  return typeof text === 'string'
    ? text
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(line => line.length > 0)
    : [];
}

function modalNumber(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

  let best = values[0] ?? 0;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && value > best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Two decimals, locale-independent, so reason strings are stable across machines. */
function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
