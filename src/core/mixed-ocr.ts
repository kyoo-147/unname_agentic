/**
 * Mixed-region OCR planner and non-overlapping block merger (backlog F06).
 *
 * A hybrid or partially OCR'd PDF page mixes reliable born-digital text runs
 * with raster images or regions whose embedded text encoding is corrupted
 * (missing ToUnicode CMap, replacement glyphs, PUA tofu, CID tokens). Running
 * OCR over the whole page wastes work and creates duplicate overlapping text
 * layers above already-good native text; skipping OCR entirely leaves scanned
 * or garbled regions unreadable.
 *
 * This module splits the decision into two pure, deterministic stages:
 *
 * 1. {@link planMixedPageOcr} evaluates every native digital block's text
 *    quality and compares candidate image regions against good digital blocks
 *    using IoU and containment geometry. Good digital text is marked
 *    `keep-digital`, unrepresented or garbled regions are scheduled as
 *    `run-ocr` (with `excludedRects` masking any smaller good digital blocks
 *    inside a larger scan), and already-covered or duplicate regions are
 *    marked `skip-overlap`.
 * 2. {@link mergeMixedPageBlocks} combines surviving digital blocks
 *    (`source: 'pdf-text'`) and recognized OCR blocks (`source: 'ocr-region'`),
 *    drops any OCR block overlapping good native text or a stronger OCR block,
 *    and orders the unified non-overlapping result via `orderDocument` in
 *    `src/core/reading-order.ts`.
 *
 * Contract:
 * - Pure and deterministic: no DOM, no clock, no randomness, no I/O, no
 *   locale-dependent string comparisons. Shuffling input arrays produces the
 *   same decisions, OCR tasks, and reading order.
 * - Coordinates are top-left origin PDF points with y growing downwards,
 *   matching `Rect` in `src/core/types.ts` and `Polygon` in `src/core/ir.ts`.
 */

import { rectPolygon, type BuildBlockInput, type Point, type Polygon } from './ir';
import {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  EMPTY_PAGE_REASON,
  orderDocument,
  type ReadingColumn,
  type ReadingOrderBlock,
} from './reading-order';
import type { Rect } from './types';

// --- Constants -------------------------------------------------------------

/** Minimum Intersection-over-Union in (0, 1] treated as the same overlapping layer. */
export const DEFAULT_OVERLAP_IOU_THRESHOLD = 0.5;

/**
 * Minimum fraction in (0, 1] of a smaller region or OCR block covered by good
 * digital text (either one larger digital block or the union of multiple digital
 * blocks) before it is skipped as already covered.
 */
export const DEFAULT_CONTAINMENT_THRESHOLD = 0.85;

/** Minimum digital text quality score in [0, 1] required to trust native PDF text. */
export const DEFAULT_DIGITAL_QUALITY_THRESHOLD = 0.7;

export { DEFAULT_PAGE_HEIGHT, DEFAULT_PAGE_WIDTH };

/** Stable, machine-readable reason codes emitted by F06 planning and merging. */
export const MIXED_OCR_REASONS = {
  pageEmpty: EMPTY_PAGE_REASON,
  digitalQualityOk: 'digital:quality-ok',
  digitalExplicitScore: 'digital:explicit-score',
  digitalEmptyText: 'digital:empty-text',
  digitalReplacementChar: 'digital:garbled-replacement-char',
  digitalPrivateUse: 'digital:garbled-private-use',
  digitalControlChars: 'digital:garbled-control-chars',
  digitalCidToken: 'digital:garbled-cid-token',
  digitalLowReadability: 'digital:garbled-low-readability',
  digitalQualityBelowThreshold: 'digital:quality-below-threshold',
  ocrImageOnly: 'ocr:image-only-region',
  ocrPartialOverlapBelowThreshold: 'ocr:partial-overlap-below-threshold',
  ocrFallbackGarbledDigital: 'ocr:fallback-garbled-digital',
  ocrCoveredByGoodDigital: 'ocr:covered-by-good-digital',
  ocrContainedInDigital: 'ocr:contained-in-digital',
  ocrDuplicateRegion: 'ocr:duplicate-region',
  ocrEmptyText: 'ocr:empty-text',
  regionZeroArea: 'region:zero-area',
} as const;

export type MixedOcrReason = (typeof MIXED_OCR_REASONS)[keyof typeof MIXED_OCR_REASONS];

// --- Public types ----------------------------------------------------------

export type MixedTextSource = 'pdf-text' | 'ocr-region';

export type MixedRegionAction = 'keep-digital' | 'run-ocr' | 'skip-overlap' | 'skip-invalid';

export interface RegionGeometryInput {
  rect?: Rect;
  polygon?: readonly Point[];
  rotation?: number;
}

export interface DigitalBlockInput {
  id?: string;
  rect?: Rect;
  polygon?: readonly Point[];
  baseRect?: Rect;
  text: string;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  direction?: 'ltr' | 'rtl';
  rotation?: number;
  lines?: readonly string[];
  /** Optional caller-supplied quality score in [0, 1] (e.g. font/CMap health). */
  qualityScore?: number;
}

export interface CandidateImageRegionInput {
  id?: string;
  rect?: Rect;
  polygon?: readonly Point[];
  rotation?: number;
  kind?: string;
}

export interface OcrRegionBlockInput {
  id?: string;
  regionId?: string;
  rect?: Rect;
  polygon?: readonly Point[];
  text: string;
  /** Engine confidence in [0, 1] or [0, 100]; normalized to [0, 1]. */
  confidence?: number;
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  direction?: 'ltr' | 'rtl';
  rotation?: number;
  lines?: readonly string[];
}

export interface MixedPagePlanInput {
  page?: number;
  width: number;
  height: number;
  digitalBlocks: readonly DigitalBlockInput[];
  imageRegions: readonly CandidateImageRegionInput[];
}

export interface MixedPageMergeInput {
  page?: number;
  width: number;
  height: number;
  digitalBlocks: readonly DigitalBlockInput[];
  ocrBlocks: readonly OcrRegionBlockInput[];
}

export interface MixedOcrOptions {
  /** IoU threshold in (0, 1] to skip overlapping regions/blocks. Defaults to 0.5. */
  overlapIouThreshold?: number;
  /** Containment threshold in (0, 1] when larger/multiple digital blocks cover a region. Defaults to 0.85. */
  containmentThreshold?: number;
  /** Quality score threshold in [0, 1] to keep native digital text. Defaults to 0.7. */
  digitalQualityThreshold?: number;
}

export interface DigitalQualityAssessment {
  score: number;
  isGood: boolean;
  reasons: string[];
}

export interface PlannedRegionDecision {
  id: string;
  kind: 'digital' | 'image';
  action: MixedRegionAction;
  source: MixedTextSource | null;
  rect: Rect;
  polygon: Polygon;
  rotation: number;
  text?: string;
  qualityScore?: number;
  maxIou: number;
  matchedId?: string;
  reasons: string[];
}

export interface PlannedOcrTask {
  id: string;
  regionId: string;
  origin: 'image-region' | 'corrupted-digital';
  rect: Rect;
  polygon: Polygon;
  rotation: number;
  /** Kept digital block rects intersecting this OCR task so runners can mask them out. */
  excludedRects: Rect[];
  replacesBlockId?: string;
  reasons: string[];
}

export interface MixedDigitalBlock {
  id: string;
  page: number;
  source: 'pdf-text';
  text: string;
  rect: Rect;
  polygon: Polygon;
  baseRect?: Rect;
  fontSize: number;
  fontFamily: string;
  color: string;
  direction: 'ltr' | 'rtl';
  rotation: number;
  lines?: readonly string[];
  qualityScore: number;
  reasons: string[];
}

export interface MixedPageOcrPlan {
  page: number;
  width: number;
  height: number;
  needsOcr: boolean;
  keptDigitalBlocks: MixedDigitalBlock[];
  ocrTasks: PlannedOcrTask[];
  decisions: PlannedRegionDecision[];
  skippedRegions: PlannedRegionDecision[];
  reasons: string[];
}

export interface MergedMixedBlock extends ReadingOrderBlock {
  id: string;
  page: number;
  source: MixedTextSource;
  text: string;
  rect: Rect;
  polygon: Polygon;
  baseRect?: Rect;
  fontSize: number;
  fontFamily: string;
  color: string;
  direction: 'ltr' | 'rtl';
  rotation: number;
  confidence: number;
  readingOrder: number;
  column: number | null;
  spanning: boolean;
  reasons: string[];
}

export interface SkippedMergeBlock {
  id: string;
  source: MixedTextSource;
  action: 'skip-overlap' | 'skip-invalid';
  rect: Rect;
  matchedId?: string;
  iou: number;
  reasons: string[];
}

export interface MixedPageMergeStats {
  digitalCount: number;
  ocrCount: number;
  skippedOverlapCount: number;
  skippedInvalidCount: number;
}

export interface MixedPageMergeResult {
  page: number;
  width: number;
  height: number;
  blocks: MergedMixedBlock[];
  skipped: SkippedMergeBlock[];
  columns: ReadingColumn[];
  stats: MixedPageMergeStats;
  reasons: string[];
}

// --- Constants & Regexes (Internal) ----------------------------------------

const EPSILON = 1e-9;
const CONTAINMENT_AREA_RATIO = 1.25;
const RTL_CHAR_PATTERN = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u;
const CID_TOKEN_PATTERN = /\(cid:\d+\)/giu;
const ALNUM_CHAR_PATTERN = /[\p{L}\p{N}]/u;
const COMMON_PUNCT_PATTERN = /[.,;:!?'"()[\]{}\-–—_/\\@#$%&*+=<>~`^°•·€£¥₫₹₩₽฿§¶†‡©®™«»‹›“”‘’…|]/u;
const NOISE_PUNCT_PATTERN = /[~^`\\|@#$%&*{}<>?]/u;
const SIMPLE_RULE_PATTERN = /^[-–—_=.*•·|()[\]{}:;,/+]+$/u;
const NUMERIC_MATH_PATTERN = /^[\d\s.,;:+\-*/=()[\]{}%$€£¥₫°<>]+$/u;

// --- Geometry Helpers ------------------------------------------------------

/** Normalizes a `Rect` to finite non-negative dimensions; invalid/negative dimensions become 0. */
export function normalizeMixedRect(rect: Rect | undefined): Rect {
  if (!rect || typeof rect !== 'object') {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const x = finiteOr(rect.x, 0);
  const y = finiteOr(rect.y, 0);
  const width = finiteOr(rect.width, 0);
  const height = finiteOr(rect.height, 0);
  if (width <= 0 || height <= 0) {
    return { x, y, width: 0, height: 0 };
  }
  return { x, y, width, height };
}

/**
 * Builds the 4 rotated corners of `rect` about its center in clockwise screen
 * degrees (+x right, +y down), matching `[top-left, top-right, bottom-right, bottom-left]`.
 */
export function rotatedRectPolygon(rect: Rect, angleDeg: number): Polygon {
  const safe = normalizeMixedRect(rect);
  const angle = finiteOr(angleDeg, 0);
  if (safe.width <= 0 || safe.height <= 0 || Math.abs(angle % 360) <= EPSILON) {
    return rectPolygon(safe);
  }
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = safe.x + safe.width / 2;
  const cy = safe.y + safe.height / 2;
  const hx = safe.width / 2;
  const hy = safe.height / 2;

  const rotateOffset = (dx: number, dy: number): Point => ({
    x: roundCoord(cx + dx * cos - dy * sin),
    y: roundCoord(cy + dx * sin + dy * cos),
  });

  return [
    rotateOffset(-hx, -hy),
    rotateOffset(hx, -hy),
    rotateOffset(hx, hy),
    rotateOffset(-hx, hy),
  ];
}

/** Unsigned area of a polygon via the shoelace formula; returns 0 for < 3 valid points. */
export function computePolygonArea(polygon: readonly Point[]): number {
  if (!Array.isArray(polygon) || polygon.length < 3) return 0;
  for (const pt of polygon) {
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return 0;
  }
  return Math.abs(signedPolygonArea(polygon));
}

/** Intersection-over-Union of two axis-aligned rects; returns 0 if either has zero area. */
export function computeRectIoU(a: Rect, b: Rect): number {
  const ra = normalizeMixedRect(a);
  const rb = normalizeMixedRect(b);
  const areaA = ra.width * ra.height;
  const areaB = rb.width * rb.height;
  if (areaA <= 0 || areaB <= 0) return 0;
  const inter = rectIntersectionArea(ra, rb);
  if (inter <= 0) return 0;
  const union = areaA + areaB - inter;
  if (union <= 0) return 0;
  return clamp01(inter / union);
}

/** Intersection-over-Union supporting either axis-aligned `rect` or 4-point `polygon`. */
export function computeRegionIoU(a: RegionGeometryInput, b: RegionGeometryInput): number {
  const ga = resolveGeometry(a);
  const gb = resolveGeometry(b);
  if (ga.area <= 0 || gb.area <= 0) return 0;
  const inter = geometryIntersectionArea(ga, gb);
  if (inter <= 0) return 0;
  const union = ga.area + gb.area - inter;
  if (union <= 0) return 0;
  return clamp01(inter / union);
}

interface ResolvedGeometry {
  rect: Rect;
  polygon: Polygon;
  area: number;
  axisAligned: boolean;
  rotation: number;
}

function resolveGeometry(input: RegionGeometryInput): ResolvedGeometry {
  const rotation = normalizeAngle(input.rotation);
  const explicitPoly = readValidPolygon(input.polygon);
  if (explicitPoly) {
    const area = computePolygonArea(explicitPoly);
    const bounds = polygonBoundsRect(explicitPoly);
    const rect = hasPositiveArea(input.rect) ? normalizeMixedRect(input.rect) : bounds;
    return {
      rect,
      polygon: explicitPoly,
      area,
      axisAligned: isAxisAlignedPolygon(explicitPoly),
      rotation,
    };
  }
  const rect = normalizeMixedRect(input.rect);
  const area = rect.width * rect.height;
  return {
    rect,
    polygon: rectPolygon(rect),
    area,
    axisAligned: true,
    rotation,
  };
}

function hasPositiveArea(rect: Rect | undefined): boolean {
  if (!rect) return false;
  return Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0;
}

function readValidPolygon(points: readonly Point[] | undefined): Polygon | undefined {
  if (!Array.isArray(points) || points.length !== 4) return undefined;
  const [p0, p1, p2, p3] = points;
  if (!isFinitePoint(p0) || !isFinitePoint(p1) || !isFinitePoint(p2) || !isFinitePoint(p3)) {
    return undefined;
  }
  return [
    { x: p0.x, y: p0.y },
    { x: p1.x, y: p1.y },
    { x: p2.x, y: p2.y },
    { x: p3.x, y: p3.y },
  ];
}

function isFinitePoint(point: Point | undefined): point is Point {
  return point !== undefined && typeof point === 'object' && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function polygonBoundsRect(polygon: readonly Point[]): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const pt of polygon) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  return normalizeMixedRect({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
}

function isAxisAlignedPolygon(polygon: Polygon): boolean {
  const [p0, p1, p2, p3] = polygon;
  const xs = new Set([p0.x, p1.x, p2.x, p3.x].map(v => Math.round(v * 1e6)));
  const ys = new Set([p0.y, p1.y, p2.y, p3.y].map(v => Math.round(v * 1e6)));
  return xs.size <= 2 && ys.size <= 2;
}

function rectIntersectionArea(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function geometryIntersectionArea(a: ResolvedGeometry, b: ResolvedGeometry): number {
  if (a.area <= 0 || b.area <= 0) return 0;
  if (a.axisAligned && b.axisAligned) {
    const ra = isAxisAlignedPolygon(a.polygon) ? polygonBoundsRect(a.polygon) : a.rect;
    const rb = isAxisAlignedPolygon(b.polygon) ? polygonBoundsRect(b.polygon) : b.rect;
    return rectIntersectionArea(ra, rb);
  }
  const clipped = clipConvexPolygon(ensurePositiveWinding(a.polygon), ensurePositiveWinding(b.polygon));
  if (clipped.length < 3) return 0;
  return Math.min(a.area, b.area, computePolygonArea(clipped));
}

function signedPolygonArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const curr = points[i];
    const next = points[(i + 1) % points.length];
    if (!curr || !next) continue;
    sum += curr.x * next.y - next.x * curr.y;
  }
  return sum / 2;
}

function ensurePositiveWinding(points: readonly Point[]): Point[] {
  return signedPolygonArea(points) < 0 ? [...points].reverse() : [...points];
}

/** Sutherland-Hodgman convex polygon clipping (positive winding in y-down screen coordinates). */
function clipConvexPolygon(subject: readonly Point[], clipper: readonly Point[]): Point[] {
  let output: Point[] = [...subject];
  for (let i = 0; i < clipper.length; i += 1) {
    if (output.length === 0) return [];
    const edgeStart = clipper[i];
    const edgeEnd = clipper[(i + 1) % clipper.length];
    if (!edgeStart || !edgeEnd) continue;

    const input = output;
    output = [];
    for (let j = 0; j < input.length; j += 1) {
      const current = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      if (!current || !prev) continue;
      const currentInside = edgeCross(edgeStart, edgeEnd, current) >= -EPSILON;
      const prevInside = edgeCross(edgeStart, edgeEnd, prev) >= -EPSILON;
      if (currentInside) {
        if (!prevInside) {
          output.push(segmentEdgeIntersection(prev, current, edgeStart, edgeEnd));
        }
        output.push(current);
      } else if (prevInside) {
        output.push(segmentEdgeIntersection(prev, current, edgeStart, edgeEnd));
      }
    }
  }
  return output;
}

function edgeCross(a: Point, b: Point, p: Point): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

function segmentEdgeIntersection(s: Point, e: Point, a: Point, b: Point): Point {
  const d1 = edgeCross(a, b, s);
  const d2 = edgeCross(a, b, e);
  const denom = d1 - d2;
  if (Math.abs(denom) <= 1e-12) return { x: s.x, y: s.y };
  const t = d1 / denom;
  return {
    x: s.x + t * (e.x - s.x),
    y: s.y + t * (e.y - s.y),
  };
}

/** Computes the exact union area of `covers` clipped inside `target` when axis-aligned. */
function coveredUnionArea(target: ResolvedGeometry, covers: readonly ResolvedGeometry[]): number {
  if (target.area <= 0 || covers.length === 0) return 0;
  if (!target.axisAligned || covers.some(c => !c.axisAligned)) {
    let total = 0;
    for (const cover of covers) {
      total += geometryIntersectionArea(target, cover);
    }
    return Math.min(target.area, total);
  }

  const tb = polygonBoundsRect(target.polygon);
  const clipped: Rect[] = [];
  for (const cover of covers) {
    const cb = polygonBoundsRect(cover.polygon);
    const left = Math.max(tb.x, cb.x);
    const top = Math.max(tb.y, cb.y);
    const right = Math.min(tb.x + tb.width, cb.x + cb.width);
    const bottom = Math.min(tb.y + tb.height, cb.y + cb.height);
    if (right > left && bottom > top) {
      clipped.push({ x: left, y: top, width: right - left, height: bottom - top });
    }
  }
  if (clipped.length === 0) return 0;

  const xs = [...new Set(clipped.flatMap(r => [r.x, r.x + r.width]))].sort((a, b) => a - b);
  let totalArea = 0;
  for (let i = 0; i + 1 < xs.length; i += 1) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    if (x0 === undefined || x1 === undefined || x1 - x0 <= EPSILON) continue;

    const yIntervals: Array<[number, number]> = [];
    for (const r of clipped) {
      if (r.x <= x0 + EPSILON && r.x + r.width >= x1 - EPSILON) {
        yIntervals.push([r.y, r.y + r.height]);
      }
    }
    if (yIntervals.length === 0) continue;
    yIntervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);

    let mergedHeight = 0;
    let curStart = yIntervals[0]![0];
    let curEnd = yIntervals[0]![1];
    for (let j = 1; j < yIntervals.length; j += 1) {
      const interval = yIntervals[j];
      if (!interval) continue;
      if (interval[0] <= curEnd) {
        curEnd = Math.max(curEnd, interval[1]);
      } else {
        mergedHeight += curEnd - curStart;
        curStart = interval[0];
        curEnd = interval[1];
      }
    }
    mergedHeight += curEnd - curStart;
    totalArea += (x1 - x0) * mergedHeight;
  }
  return Math.min(target.area, totalArea);
}

// --- Digital Text Quality Assessment ---------------------------------------

/**
 * Evaluates whether extracted native PDF text is trustworthy or garbled.
 *
 * Empty/whitespace strings always score 0. When `explicitScore` is provided,
 * that score is checked directly against `threshold`. Otherwise, the heuristic
 * inspects replacement characters (`\uFFFD`), Private Use Area glyphs, control
 * characters, unresolved `(cid:N)` font tokens, box tofu, and symbol noise.
 */
export function assessDigitalTextQuality(
  text: string,
  explicitScore?: number,
  threshold: number = DEFAULT_DIGITAL_QUALITY_THRESHOLD,
): DigitalQualityAssessment {
  const qualityThreshold = shareOr(threshold, DEFAULT_DIGITAL_QUALITY_THRESHOLD);
  const safeText = typeof text === 'string' ? text : '';
  const nonSpaceChars = Array.from(safeText.replace(/\s+/gu, ''));
  if (nonSpaceChars.length === 0) {
    return { score: 0, isGood: false, reasons: [MIXED_OCR_REASONS.digitalEmptyText] };
  }

  if (typeof explicitScore === 'number' && Number.isFinite(explicitScore)) {
    const score = roundScore(clamp01(explicitScore));
    const isGood = score >= qualityThreshold;
    return {
      score,
      isGood,
      reasons: [isGood ? MIXED_OCR_REASONS.digitalExplicitScore : MIXED_OCR_REASONS.digitalQualityBelowThreshold],
    };
  }

  const n = nonSpaceChars.length;
  let replacementCount = 0;
  let puaCount = 0;
  let controlCount = 0;
  let boxTofuCount = 0;
  let alnumCount = 0;
  let questionCount = 0;
  let noisePunctCount = 0;
  let unusualSymbolCount = 0;

  for (const ch of nonSpaceChars) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0xfffd) {
      replacementCount += 1;
      continue;
    }
    if (isPuaCodePoint(cp)) {
      puaCount += 1;
      continue;
    }
    if ((cp >= 0x0000 && cp <= 0x001f) || (cp >= 0x007f && cp <= 0x009f)) {
      controlCount += 1;
      continue;
    }
    if (cp >= 0x25a0 && cp <= 0x25ff) {
      boxTofuCount += 1;
      continue;
    }
    if (ALNUM_CHAR_PATTERN.test(ch)) {
      alnumCount += 1;
      continue;
    }
    if (ch === '?') questionCount += 1;
    if (NOISE_PUNCT_PATTERN.test(ch)) noisePunctCount += 1;
    if (!COMMON_PUNCT_PATTERN.test(ch)) unusualSymbolCount += 1;
  }

  const cidMatches = safeText.match(CID_TOKEN_PATTERN);
  const cidCharCount = cidMatches ? cidMatches.reduce((sum, token) => sum + token.length, 0) : 0;

  let score = 1;
  const reasons: string[] = [];

  if (replacementCount > 0) {
    reasons.push(MIXED_OCR_REASONS.digitalReplacementChar);
    score -= Math.min(1, (replacementCount / n) * 3 + 0.35);
  }
  if (puaCount > 0) {
    reasons.push(MIXED_OCR_REASONS.digitalPrivateUse);
    score -= Math.min(1, (puaCount / n) * 3 + 0.35);
  }
  if (controlCount > 0) {
    reasons.push(MIXED_OCR_REASONS.digitalControlChars);
    score -= Math.min(1, (controlCount / n) * 3 + 0.35);
  }
  if (cidCharCount > 0) {
    reasons.push(MIXED_OCR_REASONS.digitalCidToken);
    score -= Math.min(1, (cidCharCount / n) * 2 + 0.4);
  }
  if (boxTofuCount > 0 && (boxTofuCount / n >= 0.25 || (alnumCount === 0 && boxTofuCount >= 2))) {
    reasons.push(MIXED_OCR_REASONS.digitalLowReadability);
    score -= Math.min(1, (boxTofuCount / n) * 2 + 0.35);
  }
  if (/\?{3,}/u.test(safeText) || (questionCount / n >= 0.4 && alnumCount < n * 0.5)) {
    reasons.push(MIXED_OCR_REASONS.digitalLowReadability);
    score -= Math.min(1, (questionCount / n) * 2 + 0.35);
  }
  if (unusualSymbolCount / n > 0.35) {
    reasons.push(MIXED_OCR_REASONS.digitalLowReadability);
    score -= Math.min(1, (unusualSymbolCount / n) * 1.5 + 0.25);
  }
  const joinedNonSpace = nonSpaceChars.join('');
  if (
    (noisePunctCount / n >= 0.5 && n >= 4) ||
    (alnumCount === 0 && n >= 4 && !SIMPLE_RULE_PATTERN.test(joinedNonSpace)) ||
    (n >= 6 && alnumCount / n < 0.35 && !NUMERIC_MATH_PATTERN.test(safeText))
  ) {
    reasons.push(MIXED_OCR_REASONS.digitalLowReadability);
    score -= 0.6;
  }

  const finalScore = roundScore(clamp01(score));
  const isGood = finalScore >= qualityThreshold;
  const dedupedReasons = [...new Set(reasons)];
  if (dedupedReasons.length === 0) {
    dedupedReasons.push(isGood ? MIXED_OCR_REASONS.digitalQualityOk : MIXED_OCR_REASONS.digitalQualityBelowThreshold);
  }
  return { score: finalScore, isGood, reasons: dedupedReasons };
}

function isPuaCodePoint(cp: number): boolean {
  return (
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    (cp >= 0xf0000 && cp <= 0xffffd) ||
    (cp >= 0x100000 && cp <= 0x10fffd)
  );
}

// --- Planning Stage --------------------------------------------------------

interface NormalizedDigitalCandidate {
  id: string;
  input: DigitalBlockInput;
  geom: ResolvedGeometry;
  quality: DigitalQualityAssessment;
  sourceIndex: number;
}

interface NormalizedImageCandidate {
  id: string;
  input: CandidateImageRegionInput;
  geom: ResolvedGeometry;
  sourceIndex: number;
}

interface NormalizedOcrCandidate {
  id: string;
  input: OcrRegionBlockInput;
  geom: ResolvedGeometry;
  text: string;
  confidence: number;
  sourceIndex: number;
}

interface ThresholdSettings {
  overlapIouThreshold: number;
  containmentThreshold: number;
  digitalQualityThreshold: number;
}

/**
 * Classifies native digital text blocks and candidate image regions on a page,
 * deciding what native text to keep (`keep-digital`), what regions to schedule
 * for OCR (`run-ocr`), and what redundant regions to skip (`skip-overlap`).
 */
export function planMixedPageOcr(
  input: MixedPagePlanInput,
  options: MixedOcrOptions = {},
): MixedPageOcrPlan {
  const page = pageNumberOr(input?.page);
  const width = positiveOr(input?.width, DEFAULT_PAGE_WIDTH);
  const height = positiveOr(input?.height, DEFAULT_PAGE_HEIGHT);
  const settings = readThresholds(options);

  const rawDigitals = Array.isArray(input?.digitalBlocks) ? input.digitalBlocks : [];
  const rawImages = Array.isArray(input?.imageRegions) ? input.imageRegions : [];

  const digitalCandidates = normalizeDigitalCandidates(rawDigitals, page, settings.digitalQualityThreshold);
  const imageCandidates = normalizeImageCandidates(rawImages, page);

  if (digitalCandidates.length === 0 && imageCandidates.length === 0) {
    return {
      page,
      width,
      height,
      needsOcr: false,
      keptDigitalBlocks: [],
      ocrTasks: [],
      decisions: [],
      skippedRegions: [],
      reasons: [MIXED_OCR_REASONS.pageEmpty],
    };
  }

  const goodDigitals: NormalizedDigitalCandidate[] = [];
  const garbledDigitals: NormalizedDigitalCandidate[] = [];
  const invalidDigitals: NormalizedDigitalCandidate[] = [];

  for (const cand of digitalCandidates) {
    if (cand.geom.area <= 0) {
      invalidDigitals.push(cand);
    } else if (cand.quality.isGood) {
      goodDigitals.push(cand);
    } else if (cand.input.text.trim().length === 0) {
      invalidDigitals.push(cand);
    } else {
      garbledDigitals.push(cand);
    }
  }

  const keptDigitalBlocks: MixedDigitalBlock[] = goodDigitals.map(cand => toMixedDigitalBlock(cand, page));
  const digitalDecisions: PlannedRegionDecision[] = [];

  for (const cand of invalidDigitals) {
    digitalDecisions.push({
      id: cand.id,
      kind: 'digital',
      action: 'skip-invalid',
      source: null,
      rect: cand.geom.rect,
      polygon: cand.geom.polygon,
      rotation: cand.geom.rotation,
      text: cand.input.text,
      qualityScore: cand.quality.score,
      maxIou: 0,
      reasons: cand.geom.area <= 0 ? [MIXED_OCR_REASONS.regionZeroArea] : cand.quality.reasons,
    });
  }

  for (const cand of goodDigitals) {
    digitalDecisions.push({
      id: cand.id,
      kind: 'digital',
      action: 'keep-digital',
      source: 'pdf-text',
      rect: cand.geom.rect,
      polygon: cand.geom.polygon,
      rotation: cand.geom.rotation,
      text: cand.input.text,
      qualityScore: cand.quality.score,
      maxIou: 0,
      reasons: cand.quality.reasons,
    });
  }

  // Evaluate image regions: larger regions first for deterministic duplicate resolution.
  const imagePriority = [...imageCandidates].sort(compareByAreaThenGeometry);
  const scheduledTaskEntries: Array<{ task: PlannedOcrTask; geom: ResolvedGeometry }> = [];
  const imageDecisions: PlannedRegionDecision[] = [];

  for (const img of imagePriority) {
    if (img.geom.area <= 0) {
      imageDecisions.push({
        id: img.id,
        kind: 'image',
        action: 'skip-invalid',
        source: null,
        rect: img.geom.rect,
        polygon: img.geom.polygon,
        rotation: img.geom.rotation,
        maxIou: 0,
        reasons: [MIXED_OCR_REASONS.regionZeroArea],
      });
      continue;
    }

    const digitalMatch = findCoveringMatch(
      img.geom,
      goodDigitals.map(d => ({ id: d.id, geom: d.geom })),
      settings,
      'digital',
    );
    if (digitalMatch.skip) {
      imageDecisions.push({
        id: img.id,
        kind: 'image',
        action: 'skip-overlap',
        source: null,
        rect: img.geom.rect,
        polygon: img.geom.polygon,
        rotation: img.geom.rotation,
        maxIou: digitalMatch.maxIou,
        matchedId: digitalMatch.matchedId,
        reasons: [digitalMatch.reason],
      });
      continue;
    }

    const taskMatch = findCoveringMatch(
      img.geom,
      scheduledTaskEntries.map(entry => ({ id: entry.task.regionId, geom: entry.geom })),
      settings,
      'duplicate',
    );
    if (taskMatch.skip) {
      imageDecisions.push({
        id: img.id,
        kind: 'image',
        action: 'skip-overlap',
        source: null,
        rect: img.geom.rect,
        polygon: img.geom.polygon,
        rotation: img.geom.rotation,
        maxIou: taskMatch.maxIou,
        matchedId: taskMatch.matchedId,
        reasons: [MIXED_OCR_REASONS.ocrDuplicateRegion],
      });
      continue;
    }

    const excludedRects = digitalMatch.intersectingCovers.map(item => item.geom.rect);
    const taskReasons = [
      excludedRects.length > 0
        ? MIXED_OCR_REASONS.ocrPartialOverlapBelowThreshold
        : MIXED_OCR_REASONS.ocrImageOnly,
    ];
    const task: PlannedOcrTask = {
      id: `ocr-task-p${page}-${scheduledTaskEntries.length + 1}`,
      regionId: img.id,
      origin: 'image-region',
      rect: img.geom.rect,
      polygon: img.geom.polygon,
      rotation: img.geom.rotation,
      excludedRects,
      reasons: taskReasons,
    };
    scheduledTaskEntries.push({ task, geom: img.geom });
    imageDecisions.push({
      id: img.id,
      kind: 'image',
      action: 'run-ocr',
      source: 'ocr-region',
      rect: img.geom.rect,
      polygon: img.geom.polygon,
      rotation: img.geom.rotation,
      maxIou: digitalMatch.maxIou,
      reasons: taskReasons,
    });
  }

  // Evaluate garbled digital blocks (largest first): skip if covered by good digital text,
  // reuse an existing image OCR task if covered, otherwise schedule a fallback OCR task.
  for (const bad of [...garbledDigitals].sort(compareByAreaThenGeometry)) {
    const goodMatch = findCoveringMatch(
      bad.geom,
      goodDigitals.map(d => ({ id: d.id, geom: d.geom })),
      settings,
      'digital',
    );
    if (goodMatch.skip) {
      digitalDecisions.push({
        id: bad.id,
        kind: 'digital',
        action: 'skip-overlap',
        source: null,
        rect: bad.geom.rect,
        polygon: bad.geom.polygon,
        rotation: bad.geom.rotation,
        text: bad.input.text,
        qualityScore: bad.quality.score,
        maxIou: goodMatch.maxIou,
        matchedId: goodMatch.matchedId,
        reasons: [goodMatch.reason],
      });
      continue;
    }

    const taskMatch = findCoveringMatch(
      bad.geom,
      scheduledTaskEntries.map(entry => ({ id: entry.task.regionId, geom: entry.geom })),
      settings,
      'duplicate',
    );
    if (taskMatch.skip && taskMatch.matchedId !== undefined) {
      const coveredEntry = scheduledTaskEntries.find(entry => entry.task.regionId === taskMatch.matchedId);
      if (coveredEntry && !coveredEntry.task.reasons.includes(MIXED_OCR_REASONS.ocrFallbackGarbledDigital)) {
        coveredEntry.task.reasons.push(MIXED_OCR_REASONS.ocrFallbackGarbledDigital);
      }
      digitalDecisions.push({
        id: bad.id,
        kind: 'digital',
        action: 'run-ocr',
        source: 'ocr-region',
        rect: bad.geom.rect,
        polygon: bad.geom.polygon,
        rotation: bad.geom.rotation,
        text: bad.input.text,
        qualityScore: bad.quality.score,
        maxIou: taskMatch.maxIou,
        matchedId: taskMatch.matchedId,
        reasons: [...bad.quality.reasons, MIXED_OCR_REASONS.ocrFallbackGarbledDigital],
      });
      continue;
    }

    const excludedRects = goodMatch.intersectingCovers.map(item => item.geom.rect);
    const taskReasons = [...bad.quality.reasons, MIXED_OCR_REASONS.ocrFallbackGarbledDigital];
    const task: PlannedOcrTask = {
      id: `ocr-task-p${page}-${scheduledTaskEntries.length + 1}`,
      regionId: bad.id,
      origin: 'corrupted-digital',
      rect: bad.geom.rect,
      polygon: bad.geom.polygon,
      rotation: bad.geom.rotation,
      excludedRects,
      replacesBlockId: bad.id,
      reasons: taskReasons,
    };
    scheduledTaskEntries.push({ task, geom: bad.geom });
    digitalDecisions.push({
      id: bad.id,
      kind: 'digital',
      action: 'run-ocr',
      source: 'ocr-region',
      rect: bad.geom.rect,
      polygon: bad.geom.polygon,
      rotation: bad.geom.rotation,
      text: bad.input.text,
      qualityScore: bad.quality.score,
      maxIou: goodMatch.maxIou,
      reasons: taskReasons,
    });
  }

  digitalDecisions.sort(compareDecisionGeometry);
  imageDecisions.sort(compareDecisionGeometry);

  const ocrTasks = scheduledTaskEntries
    .map(entry => entry.task)
    .sort((left, right) => compareRectGeometry(left.rect, right.rect, left.regionId, right.regionId))
    .map((task, index) => ({ ...task, id: `ocr-task-p${page}-${index + 1}` }));

  const decisions = [...digitalDecisions, ...imageDecisions];
  const skippedRegions = decisions.filter(d => d.action === 'skip-overlap');
  const keepCount = keptDigitalBlocks.length;
  const ocrCount = ocrTasks.length;
  const skipCount = skippedRegions.length;

  return {
    page,
    width,
    height,
    needsOcr: ocrTasks.length > 0,
    keptDigitalBlocks,
    ocrTasks,
    decisions,
    skippedRegions,
    reasons: [
      `mixed:keep-digital=${keepCount}`,
      `mixed:run-ocr=${ocrCount}`,
      `mixed:skip-overlap=${skipCount}`,
    ],
  };
}

// --- Merging Stage ---------------------------------------------------------

/**
 * Combines native PDF text blocks (`source: 'pdf-text'`) and recognized OCR
 * region blocks (`source: 'ocr-region'`) on a page without creating overlapping
 * text layers, then orders the surviving blocks using canonical reading order.
 */
export function mergeMixedPageBlocks(
  input: MixedPageMergeInput,
  options: MixedOcrOptions = {},
): MixedPageMergeResult {
  const page = pageNumberOr(input?.page);
  const width = positiveOr(input?.width, DEFAULT_PAGE_WIDTH);
  const height = positiveOr(input?.height, DEFAULT_PAGE_HEIGHT);
  const settings = readThresholds(options);

  const rawDigitals = Array.isArray(input?.digitalBlocks) ? input.digitalBlocks : [];
  const rawOcr = Array.isArray(input?.ocrBlocks) ? input.ocrBlocks : [];

  const digitalCandidates = normalizeDigitalCandidates(rawDigitals, page, settings.digitalQualityThreshold);
  const ocrCandidates = normalizeOcrCandidates(rawOcr, page);

  const skipped: SkippedMergeBlock[] = [];
  const keptDigitals: NormalizedDigitalCandidate[] = [];

  for (const cand of digitalCandidates) {
    if (cand.geom.area <= 0) {
      skipped.push({
        id: cand.id,
        source: 'pdf-text',
        action: 'skip-invalid',
        rect: cand.geom.rect,
        iou: 0,
        reasons: [MIXED_OCR_REASONS.regionZeroArea],
      });
      continue;
    }
    if (!cand.quality.isGood) {
      skipped.push({
        id: cand.id,
        source: 'pdf-text',
        action: 'skip-invalid',
        rect: cand.geom.rect,
        iou: 0,
        reasons: cand.quality.reasons,
      });
      continue;
    }
    keptDigitals.push(cand);
  }

  // Deduplicate OCR blocks against kept digital blocks and previously accepted OCR blocks.
  const ocrPriority = [...ocrCandidates].sort(compareOcrPriority);
  const acceptedOcr: Array<{ cand: NormalizedOcrCandidate; reasons: string[] }> = [];

  for (const cand of ocrPriority) {
    if (cand.geom.area <= 0) {
      skipped.push({
        id: cand.id,
        source: 'ocr-region',
        action: 'skip-invalid',
        rect: cand.geom.rect,
        iou: 0,
        reasons: [MIXED_OCR_REASONS.regionZeroArea],
      });
      continue;
    }
    if (cand.text.length === 0) {
      skipped.push({
        id: cand.id,
        source: 'ocr-region',
        action: 'skip-invalid',
        rect: cand.geom.rect,
        iou: 0,
        reasons: [MIXED_OCR_REASONS.ocrEmptyText],
      });
      continue;
    }

    const digitalMatch = findCoveringMatch(
      cand.geom,
      keptDigitals.map(d => ({ id: d.id, geom: d.geom })),
      settings,
      'digital',
    );
    if (digitalMatch.skip) {
      skipped.push({
        id: cand.id,
        source: 'ocr-region',
        action: 'skip-overlap',
        rect: cand.geom.rect,
        matchedId: digitalMatch.matchedId,
        iou: digitalMatch.maxIou,
        reasons: [digitalMatch.reason],
      });
      continue;
    }

    const ocrMatch = findCoveringMatch(
      cand.geom,
      acceptedOcr.map(entry => ({ id: entry.cand.id, geom: entry.cand.geom })),
      settings,
      'duplicate',
    );
    if (ocrMatch.skip) {
      skipped.push({
        id: cand.id,
        source: 'ocr-region',
        action: 'skip-overlap',
        rect: cand.geom.rect,
        matchedId: ocrMatch.matchedId,
        iou: ocrMatch.maxIou,
        reasons: [MIXED_OCR_REASONS.ocrDuplicateRegion],
      });
      continue;
    }

    const acceptReasons = [
      digitalMatch.intersectingCovers.length > 0
        ? MIXED_OCR_REASONS.ocrPartialOverlapBelowThreshold
        : MIXED_OCR_REASONS.ocrImageOnly,
    ];
    acceptedOcr.push({ cand, reasons: acceptReasons });
  }

  interface WorkingMergedBlock extends ReadingOrderBlock {
    source: MixedTextSource;
    polygon: Polygon;
    baseRect?: Rect;
    fontSize: number;
    fontFamily: string;
    color: string;
    direction: 'ltr' | 'rtl';
    rotation: number;
    confidence: number;
    reasons: string[];
  }

  const working: WorkingMergedBlock[] = [
    ...keptDigitals.map(cand => {
      const base = toMixedDigitalBlock(cand, page);
      return {
        id: base.id,
        rect: base.rect,
        text: base.text,
        fontSize: base.fontSize,
        lines: base.lines,
        source: 'pdf-text' as const,
        polygon: base.polygon,
        baseRect: base.baseRect,
        fontFamily: base.fontFamily,
        color: base.color,
        direction: base.direction,
        rotation: base.rotation,
        confidence: 1,
        reasons: base.reasons,
      };
    }),
    ...acceptedOcr.map(({ cand, reasons }) => ({
      id: cand.id,
      rect: cand.geom.rect,
      text: cand.text,
      fontSize: positiveOr(cand.input.fontSize, estimateFontSize(cand.geom.rect.height)),
      lines: cand.input.lines ? [...cand.input.lines] : undefined,
      source: 'ocr-region' as const,
      polygon: cand.geom.polygon,
      fontFamily: nonEmpty(cand.input.fontFamily) ?? 'sans-serif',
      color: nonEmpty(cand.input.color) ?? '#202724',
      direction: resolveDirection(cand.input.direction, cand.text),
      rotation: cand.geom.rotation,
      confidence: cand.confidence,
      reasons,
    })),
  ];

  const docOrder = orderDocument([{ page, width, height, blocks: working }]);
  const pageSummary = docOrder.pages[0];
  const columns = pageSummary?.columns ?? [];
  const orderReasons = pageSummary?.reasons ?? [EMPTY_PAGE_REASON];

  const blocks: MergedMixedBlock[] = docOrder.ordered.map(entry => ({
    id: entry.block.id,
    page,
    source: entry.block.source,
    text: entry.block.text,
    rect: entry.block.rect,
    polygon: entry.block.polygon,
    ...(entry.block.baseRect ? { baseRect: entry.block.baseRect } : {}),
    fontSize: entry.block.fontSize,
    fontFamily: entry.block.fontFamily,
    color: entry.block.color,
    direction: entry.block.direction,
    rotation: entry.block.rotation,
    ...(entry.block.lines ? { lines: entry.block.lines } : {}),
    confidence: entry.block.confidence,
    readingOrder: entry.order,
    column: entry.column,
    spanning: entry.spanning,
    reasons: entry.block.reasons,
  }));

  skipped.sort((left, right) => {
    if (left.source !== right.source) return left.source === 'pdf-text' ? -1 : 1;
    return compareRectGeometry(left.rect, right.rect, left.id, right.id);
  });

  const stats: MixedPageMergeStats = {
    digitalCount: keptDigitals.length,
    ocrCount: acceptedOcr.length,
    skippedOverlapCount: skipped.filter(s => s.action === 'skip-overlap').length,
    skippedInvalidCount: skipped.filter(s => s.action === 'skip-invalid').length,
  };

  const reasons =
    blocks.length === 0
      ? [MIXED_OCR_REASONS.pageEmpty]
      : [
          ...orderReasons,
          `mixed:digital=${stats.digitalCount}`,
          `mixed:ocr=${stats.ocrCount}`,
          `mixed:skipped-overlap=${stats.skippedOverlapCount}`,
        ];

  return {
    page,
    width,
    height,
    blocks,
    skipped,
    columns,
    stats,
    reasons,
  };
}

/**
 * Converts merged blocks into `BuildBlockInput[]` suitable for `buildDocument` in
 * `src/core/ir.ts`, mapping `source` to `origin: 'pdf-text' | 'ocr'`.
 */
export function toIrBlockInputs(blocks: readonly MergedMixedBlock[]): BuildBlockInput[] {
  return blocks.map(block => ({
    id: block.id,
    page: block.page,
    text: block.text,
    rect: block.rect,
    polygon: block.polygon,
    confidence: block.confidence,
    origin: block.source === 'pdf-text' ? 'pdf-text' : 'ocr',
  }));
}

// --- Overlap & Coverage Logic ----------------------------------------------

interface CoverCandidate {
  id: string;
  geom: ResolvedGeometry;
}

interface CoverMatchResult {
  skip: boolean;
  maxIou: number;
  matchedId?: string;
  reason: string;
  intersectingCovers: CoverCandidate[];
}

function findCoveringMatch(
  target: ResolvedGeometry,
  covers: readonly CoverCandidate[],
  settings: ThresholdSettings,
  mode: 'digital' | 'duplicate',
): CoverMatchResult {
  let maxIou = 0;
  let bestIouId: string | undefined;
  let bestContainment = 0;
  let bestContainmentId: string | undefined;
  const intersectingCovers: CoverCandidate[] = [];

  for (const cover of covers) {
    if (cover.geom.area <= 0) continue;
    const inter = geometryIntersectionArea(target, cover.geom);
    if (inter <= 0) continue;
    intersectingCovers.push(cover);

    const union = target.area + cover.geom.area - inter;
    const iou = union > 0 ? clamp01(inter / union) : 0;
    if (iou > maxIou) {
      maxIou = iou;
      bestIouId = cover.id;
    }

    const coveredFraction = clamp01(inter / target.area);
    if (
      cover.geom.area >= target.area * CONTAINMENT_AREA_RATIO &&
      coveredFraction > bestContainment
    ) {
      bestContainment = coveredFraction;
      bestContainmentId = cover.id;
    }
  }

  const roundedMaxIou = roundScore(maxIou);

  if (maxIou + EPSILON >= settings.overlapIouThreshold) {
    return {
      skip: true,
      maxIou: roundedMaxIou,
      matchedId: bestIouId,
      reason:
        mode === 'digital'
          ? MIXED_OCR_REASONS.ocrCoveredByGoodDigital
          : MIXED_OCR_REASONS.ocrDuplicateRegion,
      intersectingCovers,
    };
  }

  if (bestContainment + EPSILON >= settings.containmentThreshold) {
    return {
      skip: true,
      maxIou: roundedMaxIou,
      matchedId: bestContainmentId,
      reason:
        mode === 'digital'
          ? MIXED_OCR_REASONS.ocrContainedInDigital
          : MIXED_OCR_REASONS.ocrDuplicateRegion,
      intersectingCovers,
    };
  }

  if (intersectingCovers.length >= 2) {
    const unionArea = coveredUnionArea(
      target,
      intersectingCovers.map(item => item.geom),
    );
    const unionShare = clamp01(unionArea / target.area);
    if (unionShare + EPSILON >= settings.containmentThreshold) {
      return {
        skip: true,
        maxIou: roundedMaxIou,
        matchedId: intersectingCovers[0]?.id,
        reason:
          mode === 'digital'
            ? MIXED_OCR_REASONS.ocrCoveredByGoodDigital
            : MIXED_OCR_REASONS.ocrDuplicateRegion,
        intersectingCovers,
      };
    }
  }

  return {
    skip: false,
    maxIou: roundedMaxIou,
    reason: '',
    intersectingCovers,
  };
}

// --- Normalization & Sorting Helpers ---------------------------------------

function normalizeDigitalCandidates(
  blocks: readonly DigitalBlockInput[],
  page: number,
  qualityThreshold: number,
): NormalizedDigitalCandidate[] {
  const pre = blocks.map((input, index) => ({
    input,
    index,
    explicitId: nonEmpty(input?.id),
    geom: resolveGeometry({ rect: input?.rect, polygon: input?.polygon, rotation: input?.rotation }),
    quality: assessDigitalTextQuality(
      typeof input?.text === 'string' ? input.text : '',
      input?.qualityScore,
      qualityThreshold,
    ),
  }));
  pre.sort((left, right) =>
    compareRectGeometry(
      left.geom.rect,
      right.geom.rect,
      left.explicitId ?? '',
      right.explicitId ?? '',
      left.index,
      right.index,
    ),
  );
  return pre.map((item, sortedIndex) => ({
    id: item.explicitId ?? `pdf-p${page}-r${sortedIndex}`,
    input: item.input,
    geom: item.geom,
    quality: item.quality,
    sourceIndex: item.index,
  }));
}

function normalizeImageCandidates(
  regions: readonly CandidateImageRegionInput[],
  page: number,
): NormalizedImageCandidate[] {
  const pre = regions.map((input, index) => ({
    input,
    index,
    explicitId: nonEmpty(input?.id),
    geom: resolveGeometry({ rect: input?.rect, polygon: input?.polygon, rotation: input?.rotation }),
  }));
  pre.sort((left, right) =>
    compareRectGeometry(
      left.geom.rect,
      right.geom.rect,
      left.explicitId ?? '',
      right.explicitId ?? '',
      left.index,
      right.index,
    ),
  );
  return pre.map((item, sortedIndex) => ({
    id: item.explicitId ?? `img-p${page}-r${sortedIndex}`,
    input: item.input,
    geom: item.geom,
    sourceIndex: item.index,
  }));
}

function normalizeOcrCandidates(
  blocks: readonly OcrRegionBlockInput[],
  page: number,
): NormalizedOcrCandidate[] {
  const pre = blocks.map((input, index) => ({
    input,
    index,
    explicitId: nonEmpty(input?.id),
    geom: resolveGeometry({ rect: input?.rect, polygon: input?.polygon, rotation: input?.rotation }),
    text: typeof input?.text === 'string' ? input.text.replace(/\s+/gu, ' ').trim() : '',
    confidence: normalizeConfidence(input?.confidence),
  }));
  pre.sort((left, right) =>
    compareRectGeometry(
      left.geom.rect,
      right.geom.rect,
      left.explicitId ?? '',
      right.explicitId ?? '',
      left.index,
      right.index,
    ),
  );
  return pre.map((item, sortedIndex) => ({
    id: item.explicitId ?? `ocr-p${page}-r${sortedIndex}`,
    input: item.input,
    geom: item.geom,
    text: item.text,
    confidence: item.confidence,
    sourceIndex: item.index,
  }));
}

function toMixedDigitalBlock(cand: NormalizedDigitalCandidate, page: number): MixedDigitalBlock {
  const text = cand.input.text;
  return {
    id: cand.id,
    page,
    source: 'pdf-text',
    text,
    rect: cand.geom.rect,
    polygon: cand.geom.polygon,
    ...(cand.input.baseRect ? { baseRect: normalizeMixedRect(cand.input.baseRect) } : {}),
    fontSize: positiveOr(cand.input.fontSize, estimateFontSize(cand.geom.rect.height)),
    fontFamily: nonEmpty(cand.input.fontFamily) ?? 'sans-serif',
    color: nonEmpty(cand.input.color) ?? '#202724',
    direction: resolveDirection(cand.input.direction, text),
    rotation: cand.geom.rotation,
    ...(cand.input.lines ? { lines: [...cand.input.lines] } : {}),
    qualityScore: cand.quality.score,
    reasons: cand.quality.reasons,
  };
}

function compareByAreaThenGeometry(
  left: { id: string; geom: ResolvedGeometry; sourceIndex: number },
  right: { id: string; geom: ResolvedGeometry; sourceIndex: number },
): number {
  if (Math.abs(right.geom.area - left.geom.area) > EPSILON) {
    return right.geom.area - left.geom.area;
  }
  return compareRectGeometry(left.geom.rect, right.geom.rect, left.id, right.id, left.sourceIndex, right.sourceIndex);
}

function compareOcrPriority(left: NormalizedOcrCandidate, right: NormalizedOcrCandidate): number {
  if (Math.abs(right.confidence - left.confidence) > EPSILON) {
    return right.confidence - left.confidence;
  }
  if (Math.abs(right.geom.area - left.geom.area) > EPSILON) {
    return right.geom.area - left.geom.area;
  }
  return compareRectGeometry(left.geom.rect, right.geom.rect, left.id, right.id, left.sourceIndex, right.sourceIndex);
}

function compareDecisionGeometry(left: PlannedRegionDecision, right: PlannedRegionDecision): number {
  return compareRectGeometry(left.rect, right.rect, left.id, right.id);
}

function compareRectGeometry(
  left: Rect,
  right: Rect,
  leftId: string,
  rightId: string,
  leftIndex = 0,
  rightIndex = 0,
): number {
  if (left.y !== right.y) return left.y - right.y;
  if (left.x !== right.x) return left.x - right.x;
  if (leftId !== rightId) return leftId < rightId ? -1 : 1;
  return leftIndex - rightIndex;
}

function readThresholds(options: MixedOcrOptions | undefined): ThresholdSettings {
  return {
    overlapIouThreshold: positiveThresholdOr(options?.overlapIouThreshold, DEFAULT_OVERLAP_IOU_THRESHOLD),
    containmentThreshold: positiveThresholdOr(options?.containmentThreshold, DEFAULT_CONTAINMENT_THRESHOLD),
    digitalQualityThreshold: shareOr(options?.digitalQualityThreshold, DEFAULT_DIGITAL_QUALITY_THRESHOLD),
  };
}

function estimateFontSize(height: number): number {
  return height > 0 ? Math.max(8, Math.round(height * 0.72 * 10) / 10) : 10.5;
}

function resolveDirection(explicit: 'ltr' | 'rtl' | undefined, text: string): 'ltr' | 'rtl' {
  if (explicit === 'ltr' || explicit === 'rtl') return explicit;
  return RTL_CHAR_PATTERN.test(text) ? 'rtl' : 'ltr';
}

function normalizeConfidence(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  if (value > 1 && value <= 100) return roundScore(value / 100);
  return roundScore(clamp01(value));
}

function normalizeAngle(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const wrapped = ((value % 360) + 360) % 360;
  return wrapped === 0 ? 0 : roundCoord(wrapped);
}

function pageNumberOr(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : 1;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function shareOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : fallback;
}

function positiveThresholdOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(1, value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value);
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundCoord(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return rounded === 0 ? 0 : rounded;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
