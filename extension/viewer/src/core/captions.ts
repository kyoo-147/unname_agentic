/**
 * Caption linking (backlog item E08).
 *
 * A figure or a table is read as a rectangle of ink; the sentence that names it is a
 * separate block. This module decides which caption describes which block, so the
 * reader can focus one when the other is clicked.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM. The same blocks always
 *   produce the same links, whatever order the caller passed them in.
 * - Geometry is in page points with the origin at the top-left corner and y growing
 *   downwards, matching `Rect` in `src/core/types.ts`.
 * - A caption is a block whose type is `caption`, or whose text starts with
 *   `Figure`, `Fig.`, `Table` or `Algorithm` followed by a number. A `figure` or
 *   `table` block is always a *target*: a figure that carries its own `Figure 3`
 *   text is not also treated as a caption, so it can never link to itself.
 * - Only blocks on the caption's own page are candidates. A caption on page 3 never
 *   links to a figure on page 4; it is reported as an orphan instead.
 * - Every verdict comes with evidence (`reason`, `distance`). Nothing is guessed
 *   silently: a caption that cannot be linked says why.
 *
 * The distance rule, in full:
 * - Horizontal overlap is a hard requirement, not a weight: a caption and its target
 *   must share a horizontal band covering at least {@link CAPTION_MIN_HORIZONTAL_OVERLAP}
 *   of the narrower of the two blocks. This is the column rule — on a two-column
 *   page a caption at the foot of the left column shares no band with a figure at
 *   the head of the right column, so it can never link across the gutter. A sliver of
 *   accidental overlap is not enough to cross a column boundary either.
 * - Among the candidates that pass that gate, the vertical gap is the cost. A gap of
 *   zero (blocks overlapping vertically) scores full proximity and the score falls
 *   linearly to zero at half a page. Vertical distance therefore only ever lowers a
 *   candidate's rank; it can never buy its way past the column rule.
 * - A gap wider than {@link CAPTION_HALF_PAGE_DISTANCE} of the page height puts the
 *   candidate out of reach. If no candidate is within reach the caption is an orphan
 *   with reason `too-distant` and that gap as its `distance`.
 *
 * The score, which becomes `confidence`:
 * `0.45 * proximity + 0.25 * kindAgreement + 0.20 * numberMatch + 0.10 * directionScore`.
 * - `proximity` is `1 - gap / halfPage`, clamped to 0..1.
 * - `kindAgreement` is 1 when the caption's label names the target's kind, 0.5 when
 *   the caption carries no label (`Fig.` and `Algorithm` both count as figure), and 0
 *   when a `Table` caption meets a figure or the reverse. A disagreement loses
 *   points but does not veto the link: a misclassified figure is still the nearest
 *   thing the caption describes.
 * - `numberMatch` is 1 when the caption's number equals the target's number, else 0.
 *   A target's number is the number in its own leading label when it has one, and
 *   otherwise its 1-based ordinal among blocks of that kind in reading order. That is
 *   what makes `Figure 3` prefer the third figure even when another figure sits closer.
 * - `directionScore` is 1 for the conventional side (figure captions below the
 *   figure, table captions above the table), 0.5 for a caption drawn on top of its
 *   target, and 0 for the unconventional side. The unconventional side still links,
 *   it just ranks below an equally close candidate on the conventional side.
 *
 * Ambiguity: when the runner-up scores within {@link CAPTION_AMBIGUITY_MARGIN} of the
 * winner, the link keeps the winner but reports `confidence * {@link
 * CAPTION_AMBIGUOUS_CONFIDENCE_FACTOR}` and names the runner-up in the reason
 * (`tie=<id>`) and in `alternativeId`. Ties are broken deterministically: higher
 * score, then smaller gap, then block id, then reading order.
 *
 * A winner whose confidence falls below {@link CAPTION_MIN_CONFIDENCE} is not
 * reported as a link at all: it becomes an orphan with reason `weak-evidence`, since
 * a nearly invisible connection is worse than none.
 */

import { DEFAULT_PAGE_HEIGHT, SEMANTIC_BLOCK_TYPES, type SemanticBlockType } from './blocks';
import type { Rect } from './types';

/** A block kind a caption can describe. */
export type CaptionKind = 'figure' | 'table';

/** Where the caption sits relative to the block it describes. */
export type CaptionDirection = 'above' | 'below' | 'overlap';

/** Why a caption could not be linked. */
export type CaptionOrphanReason =
  /** The caption's page holds no figure or table block. */
  | 'no-candidate'
  /** Targets exist on the page, but none shares a horizontal band with the caption. */
  | 'no-overlap'
  /** Targets share a band, but every one is more than half a page away. */
  | 'too-distant'
  /** The best candidate scored below {@link CAPTION_MIN_CONFIDENCE}. */
  | 'weak-evidence';

/**
 * A block as this module reads it. `ClassifiedBlock` from `src/core/blocks.ts` fits
 * this shape as-is, so the reader can pass `classifyBlocks(...)` straight in.
 */
export interface CaptionInputBlock {
  /** Reader block id; when absent this module derives `p{page}-r{rank}` from reading order. */
  id?: string;
  /** Semantic type; `caption` marks a caption, `figure` and `table` mark targets. */
  type: SemanticBlockType;
  /** 1-based page number; a missing or invalid page is treated as page 1. */
  page?: number;
  text: string;
  /** Text extent on the page, in points. */
  rect: Rect;
  /** Height of the block's page in points; defaults to {@link DEFAULT_PAGE_HEIGHT}. */
  pageHeight?: number;
}

/** One caption matched to the block it describes. */
export interface CaptionLink {
  captionId: string;
  /** Id of the figure or table block the caption describes. */
  targetId: string;
  /** The target's own kind; a `Table` caption matched to a figure reports `figure`. */
  kind: CaptionKind;
  /** Evidence strength in (0, 1]; lowered when a second candidate is nearly as good. */
  confidence: number;
  /**
   * Stable, machine-readable evidence joined by `;`, for example
   * `direction=below;gap=12.00;number=1;number-match`. Never UI text.
   */
  reason: string;
  /** The competing candidate named when a tie lowered `confidence`. */
  alternativeId?: string;
}

/** A caption that could not be linked, with the evidence for that verdict. */
export interface CaptionOrphan {
  captionId: string;
  reason: CaptionOrphanReason;
  /** Nearest rejected candidate's vertical gap as a fraction of the page height; 0 without one. */
  distance: number;
  /** Nearest rejected candidate, when the page holds one. */
  candidateId?: string;
}

export interface CaptionLinkResult {
  links: CaptionLink[];
  orphans: CaptionOrphan[];
}

/** A target further than this fraction of the page height is out of reach. */
export const CAPTION_HALF_PAGE_DISTANCE = 0.5;

/** Minimum horizontal overlap, as a fraction of the narrower block, before a target is considered. */
export const CAPTION_MIN_HORIZONTAL_OVERLAP = 0.2;

/** A runner-up within this score margin makes the link ambiguous. */
export const CAPTION_AMBIGUITY_MARGIN = 0.02;

/** Confidence multiplier applied to an ambiguous link. */
export const CAPTION_AMBIGUOUS_CONFIDENCE_FACTOR = 0.85;

/** Below this confidence a winner is reported as an orphan instead of a link. */
export const CAPTION_MIN_CONFIDENCE = 0.15;

/** Caption label at the start of the text: `Figure 3`, `Fig. 4`, `Table 2`, `Algorithm 1`. */
const CAPTION_LABEL_PATTERN = /^\s*(Figure|Fig\.|Table|Algorithm)\s*(\d+)/iu;

/** Conventional side for each target kind: figure captions below, table captions above. */
const PREFERRED_CAPTION_DIRECTION: Record<CaptionKind, CaptionDirection> = {
  figure: 'below',
  table: 'above',
};

const DISTANCE_WEIGHT = 0.45;
const KIND_WEIGHT = 0.25;
const NUMBER_WEIGHT = 0.2;
const DIRECTION_WEIGHT = 0.1;

/** Float slack for edge comparisons. */
const EPSILON = 1e-9;

/** A parsed caption label. */
interface CaptionLabel {
  kind: CaptionKind;
  number: number;
}

/** A block after sanitising, ordering and id derivation. */
interface PreparedBlock {
  id: string;
  page: number;
  type: SemanticBlockType;
  text: string;
  rect: Rect;
  /** Height the block declares for its page, or 0 when it declares none. */
  declaredPageHeight: number;
  /** 0-based position within its page in reading order. */
  order: number;
}

/** A figure or table block the caption may describe. */
interface CandidateRecord {
  block: PreparedBlock;
  kind: CaptionKind;
  /** Number in the block's own leading label, else its ordinal among its kind. */
  number: number;
}

/** A caption block waiting to be matched. */
interface CaptionRecord {
  block: PreparedBlock;
  label?: CaptionLabel;
}

/** A candidate that passed both gates, with its score. */
interface ScoredCandidate {
  candidate: CandidateRecord;
  gap: number;
  direction: CaptionDirection;
  score: number;
  numberMatch: boolean;
  /** `undefined` when the caption carries no label, so kind agreement is unknown. */
  kindMatch: boolean | undefined;
}

/** Nearest candidate on one axis of comparison, used for orphan evidence. */
interface NearestCandidate {
  distance: number;
  candidateId: string;
}

/**
 * Links every caption in `blocks` to the figure or table it describes.
 *
 * Captions are walked in reading order, so `links` and `orphans` are ordered by page,
 * then top edge, then left edge. Every caption produces exactly one entry in one of
 * the two arrays. The input array is not mutated.
 */
export function linkCaptions(blocks: readonly CaptionInputBlock[]): CaptionLinkResult {
  const prepared = prepare(blocks);
  const heights = pageHeights(prepared);
  const candidates = buildCandidates(prepared);
  const captions = prepared
    .filter(isCaptionBlock)
    .map(block => ({ block, label: captionLabel(block.text) }));

  const links: CaptionLink[] = [];
  const orphans: CaptionOrphan[] = [];

  for (const caption of captions) {
    const pageHeight = heights.get(caption.block.page) ?? DEFAULT_PAGE_HEIGHT;
    const samePage = candidates.filter(candidate => candidate.block.page === caption.block.page);
    if (samePage.length === 0) {
      orphans.push({ captionId: caption.block.id, reason: 'no-candidate', distance: 0 });
      continue;
    }

    const overlap = samePage.filter(candidate =>
      alignedHorizontally(caption.block.rect, candidate.block.rect),
    );
    if (overlap.length === 0) {
      const nearest = nearestOf(caption.block.rect, samePage, pageHeight);
      orphans.push(orphanOf(caption.block.id, 'no-overlap', nearest));
      continue;
    }

    const withinReach = overlap.filter(
      candidate => verticalRelation(caption.block.rect, candidate.block.rect).gap <= halfPage(pageHeight),
    );
    if (withinReach.length === 0) {
      const nearest = nearestOf(caption.block.rect, overlap, pageHeight);
      orphans.push(orphanOf(caption.block.id, 'too-distant', nearest));
      continue;
    }

    const scored = withinReach
      .map(candidate => scoreCandidate(caption, candidate, pageHeight))
      .sort(compareScored);
    const winner = scored[0];
    if (winner === undefined) continue;

    const runnerUp = scored[1];
    const ambiguous =
      runnerUp !== undefined && winner.score - runnerUp.score <= CAPTION_AMBIGUITY_MARGIN + EPSILON;
    let confidence = round4(clamp01(winner.score));
    if (ambiguous) confidence = round4(confidence * CAPTION_AMBIGUOUS_CONFIDENCE_FACTOR);

    if (confidence < CAPTION_MIN_CONFIDENCE) {
      const nearest = nearestOf(caption.block.rect, overlap, pageHeight);
      orphans.push(orphanOf(caption.block.id, 'weak-evidence', nearest));
      continue;
    }

    const link: CaptionLink = {
      captionId: caption.block.id,
      targetId: winner.candidate.block.id,
      kind: winner.candidate.kind,
      confidence,
      reason: reasonOf(caption, winner, ambiguous ? runnerUp : undefined),
    };
    if (ambiguous && runnerUp !== undefined) link.alternativeId = runnerUp.candidate.block.id;
    links.push(link);
  }

  return { links, orphans };
}

// --- Scoring ---------------------------------------------------------------

function scoreCandidate(
  caption: CaptionRecord,
  candidate: CandidateRecord,
  pageHeight: number,
): ScoredCandidate {
  const relation = verticalRelation(caption.block.rect, candidate.block.rect);
  const gapRatio = pageHeight > 0 ? relation.gap / pageHeight : 0;
  const proximity = clamp01(1 - gapRatio / CAPTION_HALF_PAGE_DISTANCE);

  const hint = caption.label?.kind;
  const kindMatch = hint === undefined ? undefined : hint === candidate.kind;
  const kindScore = kindMatch === undefined ? 0.5 : kindMatch ? 1 : 0;

  const numberMatch =
    caption.label !== undefined && caption.label.number === candidate.number;

  const directionScore =
    relation.direction === 'overlap'
      ? 0.5
      : relation.direction === PREFERRED_CAPTION_DIRECTION[candidate.kind]
        ? 1
        : 0;

  const score =
    DISTANCE_WEIGHT * proximity +
    KIND_WEIGHT * kindScore +
    NUMBER_WEIGHT * (numberMatch ? 1 : 0) +
    DIRECTION_WEIGHT * directionScore;

  return { candidate, gap: relation.gap, direction: relation.direction, score, numberMatch, kindMatch };
}

/** Higher score first; ties fall back to distance, then id, then reading order. */
function compareScored(left: ScoredCandidate, right: ScoredCandidate): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.gap !== right.gap) return left.gap - right.gap;
  if (left.candidate.block.id !== right.candidate.block.id) {
    return left.candidate.block.id < right.candidate.block.id ? -1 : 1;
  }
  return left.candidate.block.order - right.candidate.block.order;
}

/** Vertical gap and side of the caption relative to its target. */
function verticalRelation(caption: Rect, target: Rect): { gap: number; direction: CaptionDirection } {
  const captionTop = caption.y;
  const captionBottom = caption.y + caption.height;
  const targetTop = target.y;
  const targetBottom = target.y + target.height;

  if (captionTop >= targetBottom - EPSILON) {
    return { gap: Math.max(0, captionTop - targetBottom), direction: 'below' };
  }
  if (captionBottom <= targetTop + EPSILON) {
    return { gap: Math.max(0, targetTop - captionBottom), direction: 'above' };
  }
  return { gap: 0, direction: 'overlap' };
}

/**
 * True when the two rects share enough of a horizontal band to be in one column.
 * The overlap is measured against the narrower block, so a short caption centred
 * under a wide figure passes while a caption that merely clips a neighbouring
 * column does not.
 */
function alignedHorizontally(caption: Rect, target: Rect): boolean {
  const overlap = horizontalOverlap(caption, target);
  if (overlap <= 0) return false;
  const narrower = Math.min(caption.width, target.width);
  if (narrower <= 0) return false;
  return overlap >= narrower * CAPTION_MIN_HORIZONTAL_OVERLAP;
}

function horizontalOverlap(left: Rect, right: Rect): number {
  const start = Math.max(left.x, right.x);
  const end = Math.min(left.x + left.width, right.x + right.width);
  return Math.max(0, end - start);
}

function halfPage(pageHeight: number): number {
  return pageHeight * CAPTION_HALF_PAGE_DISTANCE;
}

/** The candidate with the smallest vertical gap, as orphan evidence. */
function nearestOf(
  caption: Rect,
  candidates: readonly CandidateRecord[],
  pageHeight: number,
): NearestCandidate | undefined {
  let best: { gap: number; id: string } | undefined;
  for (const candidate of candidates) {
    const gap = verticalRelation(caption, candidate.block.rect).gap;
    const id = candidate.block.id;
    if (best === undefined || gap < best.gap - EPSILON || (Math.abs(gap - best.gap) <= EPSILON && id < best.id)) {
      best = { gap, id };
    }
  }
  if (best === undefined) return undefined;
  return {
    distance: round4(pageHeight > 0 ? best.gap / pageHeight : 0),
    candidateId: best.id,
  };
}

function orphanOf(
  captionId: string,
  reason: CaptionOrphanReason,
  nearest: NearestCandidate | undefined,
): CaptionOrphan {
  if (nearest === undefined) return { captionId, reason, distance: 0 };
  return { captionId, reason, distance: nearest.distance, candidateId: nearest.candidateId };
}

function reasonOf(
  caption: CaptionRecord,
  winner: ScoredCandidate,
  alternative: ScoredCandidate | undefined,
): string {
  const segments = [`direction=${winner.direction}`, `gap=${fmt(winner.gap)}`];
  const label = caption.label;
  if (label !== undefined) {
    segments.push(`number=${label.number}`);
    if (winner.numberMatch) segments.push('number-match');
    else segments.push(`number-mismatch=${winner.candidate.number}`);
  }
  if (winner.kindMatch === false) segments.push(`kind-mismatch=${winner.candidate.kind}`);
  if (alternative !== undefined) segments.push(`tie=${alternative.candidate.block.id}`);
  return segments.join(';');
}

// --- Blocks ----------------------------------------------------------------

function isCaptionBlock(block: PreparedBlock): boolean {
  // A figure or table block is always a target: its own `Figure 3` text is the label
  // of the target, not a second caption that could link to itself.
  if (candidateKind(block) !== undefined) return false;
  if (block.type === 'caption') return true;
  return CAPTION_LABEL_PATTERN.test(firstLine(block.text));
}

function candidateKind(block: PreparedBlock): CaptionKind | undefined {
  if (block.type === 'figure') return 'figure';
  if (block.type === 'table') return 'table';
  return undefined;
}

/** Reads the number and kind from a leading caption label, if there is one. */
function captionLabel(text: string): CaptionLabel | undefined {
  const match = firstLine(text).match(CAPTION_LABEL_PATTERN);
  if (match === null) return undefined;
  const word = (match[1] ?? '').toLowerCase();
  const number = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isInteger(number)) return undefined;
  return { kind: word.startsWith('table') ? 'table' : 'figure', number };
}

/**
 * Numbers every figure and table. A block that carries its own leading label keeps
 * that number; otherwise it takes its 1-based ordinal among blocks of its kind in
 * reading order, which is the figure number a document without labels implies.
 */
function buildCandidates(prepared: readonly PreparedBlock[]): CandidateRecord[] {
  const counters = new Map<CaptionKind, number>();
  const candidates: CandidateRecord[] = [];

  for (const block of prepared) {
    const kind = candidateKind(block);
    if (kind === undefined) continue;
    const ordinal = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, ordinal);

    const label = captionLabel(block.text);
    const number = label !== undefined && label.kind === kind ? label.number : ordinal;
    candidates.push({ block, kind, number });
  }
  return candidates;
}

// --- Page-level drivers ----------------------------------------------------

function prepare(blocks: readonly CaptionInputBlock[]): PreparedBlock[] {
  const rows = (Array.isArray(blocks) ? blocks : []).map((block, index) => ({ block, index }));
  rows.sort((left, right) =>
    compareReadingOrder(orderKeyOf(left.block, left.index), orderKeyOf(right.block, right.index)),
  );

  const rankByPage = new Map<number, number>();
  return rows.map(row => {
    const block = row.block;
    const page = pageOf(block);
    const order = rankByPage.get(page) ?? 0;
    rankByPage.set(page, order + 1);
    const explicitId = typeof block?.id === 'string' && block.id.length > 0 ? block.id : undefined;
    return {
      id: explicitId ?? `p${page}-r${order}`,
      page,
      type: semanticTypeOf(block?.type),
      text: typeof block?.text === 'string' ? block.text : '',
      rect: toRect(block?.rect),
      declaredPageHeight: positiveOr(block?.pageHeight, 0),
      order,
    };
  });
}

/** Largest page height any block on a page declares; pages without one get the default. */
function pageHeights(prepared: readonly PreparedBlock[]): Map<number, number> {
  const heights = new Map<number, number>();
  for (const block of prepared) {
    if (block.declaredPageHeight <= 0) continue;
    heights.set(block.page, Math.max(heights.get(block.page) ?? 0, block.declaredPageHeight));
  }
  return heights;
}

interface OrderKey {
  page: number;
  row: number;
  x: number;
  id: string;
  index: number;
}

function orderKeyOf(block: CaptionInputBlock, index: number): OrderKey {
  return {
    page: pageOf(block),
    // The 0.5 pt row bucket keeps sub-point baseline noise from reordering a line.
    row: Math.round(finiteOr(block?.rect?.y, 0) * 2) / 2,
    x: finiteOr(block?.rect?.x, 0),
    id: typeof block?.id === 'string' ? block.id : '',
    index,
  };
}

function compareReadingOrder(left: OrderKey, right: OrderKey): number {
  if (left.page !== right.page) return left.page - right.page;
  if (left.row !== right.row) return left.row - right.row;
  if (left.x !== right.x) return left.x - right.x;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return left.index - right.index;
}

// --- Small helpers ---------------------------------------------------------

function firstLine(text: string): string {
  if (typeof text !== 'string') return '';
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

function pageOf(block: CaptionInputBlock | undefined): number {
  const page = block?.page;
  return typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : 1;
}

function semanticTypeOf(type: SemanticBlockType | undefined): SemanticBlockType {
  return typeof type === 'string' && (SEMANTIC_BLOCK_TYPES as readonly string[]).includes(type)
    ? type
    : 'other';
}

function toRect(rect: Rect | undefined): Rect {
  return {
    x: finiteOr(rect?.x, 0),
    y: finiteOr(rect?.y, 0),
    width: Math.max(0, finiteOr(rect?.width, 0)),
    height: Math.max(0, finiteOr(rect?.height, 0)),
  };
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
