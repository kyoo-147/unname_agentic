/**
 * Deskew planning and coordinate mapping for scanned pages (backlog F02).
 *
 * A sheet fed crookedly through a scanner comes out a degree or two off square.
 * OCR copes badly with that: the recogniser segments text lines along the
 * assumed horizontal, so a tilted baseline splits one line in two or welds two
 * lines into one. Rotating the page before recognition fixes the text, but it
 * moves every recognised box with it, and the reader still draws on the
 * un-rotated page — so a deskew that only rotates the bitmap puts the overlay
 * in the wrong place. This module owns both halves and nothing else.
 *
 * It is a planner, not an executor: it never touches pixels, resamples or runs
 * OCR. Given the measured angle and the page size it returns the affine matrix
 * plus the crop an executor must apply, so one plan can drive a canvas, an OCR
 * worker or the native renderer.
 *
 * Coordinates and sign:
 * - Page points, origin at the top-left corner, y growing downwards, matching
 *   `TextBlock` in `src/core/types.ts` and `Page` in `src/core/ir.ts`.
 * - Angles are degrees, positive clockwise as seen on screen, matching
 *   `PreprocessStats.estimatedSkewDeg` in `src/core/preprocess.ts`: +2 means the
 *   right end of a text line sits lower than its left end. Straightening such a
 *   page rotates the content counter-clockwise, so the plan's `angle` is the
 *   signed correction `-angleDeg` (positive clockwise again), and `direction`
 *   names the way the plan turns the page.
 *
 * The plan, step by step:
 * 1. Rotate the page about its centre by the correction angle. Rotating about
 *    the centre keeps the middle of the page in the middle, so a small skew
 *    moves the far corners least.
 * 2. Translate so the rotated page's bounding box starts at (0, 0). Nothing
 *    ends up negative, which is what a renderer's bitmap needs.
 * 3. Scale, if the caller renders the deskewed bitmap larger for OCR. The
 *    scale multiplies the matrix and the crop together, so recognised boxes
 *    stay in the same coordinate space as the bitmap.
 *
 * `matrix` is a 2D affine in the `a b c d e f` layout that canvas
 * `setTransform`, SVG `matrix()` and PDF all use:
 *
 *     x' = a·x + c·y + e
 *     y' = b·x + d·y + f
 *
 * `crop` is in deskewed space and always starts at (0, 0): it is the
 * axis-aligned box that holds the whole rotated page, rounded up to whole units
 * so a fractional edge is never clipped. For any correction this planner
 * accepts the box is larger than the page — a rotated rectangle needs a bigger
 * frame — and the executor fills the difference with paper colour instead of
 * cropping content away. At exactly zero angle the crop is the page itself.
 *
 * The way back is {@link invertMap}: recognised boxes come out of OCR in
 * deskewed coordinates and the reader draws on the original page.
 * {@link invertBlocks} does that for a whole block list in one call, preserving
 * ids and order.
 *
 * {@link decision} is the policy gate, kept separate from the geometry:
 * - below {@link DESKEW_THRESHOLD_DEG} the page is left alone; half a degree of
 *   tilt is under a pixel of drift per word, and the correction resamples every
 *   glyph.
 * - within {@link PAGE_ROTATION_TOLERANCE_DEG} of a quarter turn the page is not
 *   skewed at all, it is turned. That is page rotation (`Page.rotation` in the
 *   document IR), not a scan defect, so deciding to deskew it would be wrong.
 * - beyond {@link MAX_DESKEW_ANGLE_DEG} the page is refused: a scan that far from
 *   square is a mis-loaded sheet or a hand-held capture, and un-tilting it needs
 *   a page rotation or perspective correction, not a rotation about the page
 *   centre.
 *
 * Like the rest of `src/core` this module is pure: no DOM, no canvas, no clock,
 * no randomness. Two calls with equal input return equal output, and nothing is
 * mutated in place. The matrix is always invertible for a plan built here
 * (its determinant is `scale²`), so the round trip is exact up to floating-point
 * error rather than merely approximate.
 */

import type { Point, Polygon } from './ir';
import type { Rect } from './types';

// --- Public shape ----------------------------------------------------------

/**
 * A page to deskew, in the size the viewer displays. A `/Rotate` quarter turn is
 * applied before this planner runs — a quarter turn is a page rotation, which
 * {@link decision} refuses — so `width` and `height` here are the display size.
 */
export interface DeskewPage {
  readonly width: number;
  readonly height: number;
}

/** Knobs for {@link planDeskew}. They describe the caller's raster, not the page. */
export interface DeskewOptions {
  /**
   * Multiplier applied to the deskewed coordinates, for an executor that renders
   * the rotated bitmap larger (or smaller) than the page points. Defaults to
   * {@link DEFAULT_DESKEW_SCALE}. Must be finite and positive.
   */
  readonly scale?: number;
}

/** Policy knobs for {@link decision}. */
export interface DeskewDecisionOptions {
  /**
   * Skew below this many degrees is ignored. Defaults to
   * {@link DESKEW_THRESHOLD_DEG}.
   */
  readonly thresholdDeg?: number;
  /**
   * Largest skew the caller is willing to correct. Defaults to
   * {@link MAX_DESKEW_ANGLE_DEG}; must not exceed a quarter turn.
   */
  readonly maxAngleDeg?: number;
}

/** The direction the plan rotates the page. `none` means the correction is zero. */
export type DeskewDirection = 'clockwise' | 'counter-clockwise' | 'none';

/**
 * A 2D affine matrix in canvas/SVG/PDF order:
 * `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
 */
export interface Matrix2D {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** Everything an executor needs to rotate a page and where its boxes end up. */
export interface DeskewPlan {
  /** Signed correction in degrees, positive clockwise; `-angleDeg` of the input. */
  readonly angle: number;
  /** The same correction in radians, `angle · π / 180`. */
  readonly radians: number;
  /** The way the page is turned; `none` when the correction rounded to zero. */
  readonly direction: DeskewDirection;
  /**
   * The axis-aligned box holding the whole rotated page in deskewed space,
   * rounded up to whole units and anchored at (0, 0).
   */
  readonly crop: Rect;
  /** Scale the matrix already carries; `1` unless the caller asked otherwise. */
  readonly scale: number;
  /** Source page coordinates to deskewed coordinates. */
  readonly matrix: Matrix2D;
}

/** Whether to deskew the page, and a sentence explaining the answer. */
export interface DeskewDecision {
  readonly deskew: boolean;
  /** Complete English sentence, safe to show in a UI as-is. */
  readonly reason: string;
}

/** The minimum a block needs for {@link mapBlocks}: an id to keep and a quad. */
export interface PolygonBlock {
  readonly id: string;
  readonly polygon: Polygon;
}

/** A block after mapping: every field kept, only the polygon replaced. */
export type MappedBlock<T extends PolygonBlock> = Omit<T, 'polygon'> & { readonly polygon: Polygon };

/**
 * Skew smaller than this is left alone, in degrees. Below half a degree the
 * baseline drift within one word is under a pixel, while the correction
 * resamples every glyph and softens the strokes OCR has to segment. Half a
 * degree is where straightening starts to win.
 *
 * The same number as `SKEW_THRESHOLD_DEG` in `src/core/preprocess.ts`, which
 * plans the deskew step from a measured skew: the two must agree or a page
 * could be planned for a correction the decision then refuses. They are kept
 * as separate exports because each names its own module's policy.
 */
export const DESKEW_THRESHOLD_DEG = 0.5;

/**
 * The largest skew this planner will correct, in degrees. A scan sits within a
 * few degrees of square; past 15° the page is a hand-held photo whose
 * perspective is wrong too, and no single rotation about the centre fixes that.
 * The limit is well below a quarter turn on purpose: at 90° the page is turned,
 * not skewed, and its width and height swap.
 *
 * This is wider than the ±8° the projection-profile estimator in
 * `src/core/preprocess.ts` searches, because a caller may measure the angle
 * some other way; anything the estimator returns is inside this ceiling by
 * construction.
 */
export const MAX_DESKEW_ANGLE_DEG = 15;

/**
 * How close to a quarter turn still counts as "the page is rotated". Half a
 * degree is the threshold below which a measured angle is indistinguishable
 * from the quarter turn itself, so 90° and 89.7° are both page rotation while
 * 91° is not: it is past the turn and has to be handled as an out-of-range skew.
 */
export const PAGE_ROTATION_TOLERANCE_DEG = 0.5;

/** The render scale a plan carries when the caller does not ask for one. */
export const DEFAULT_DESKEW_SCALE = 1;

/** Why a value was refused. Stable identifiers, safe to switch on. */
export type DeskewErrorCode =
  | 'invalid-angle'
  | 'invalid-page'
  | 'invalid-scale'
  | 'invalid-option'
  | 'invalid-matrix'
  | 'invalid-point'
  | 'invalid-rect'
  | 'invalid-block'
  | 'non-invertible';

/**
 * A value this module will not plan or map from. Refusing is the point: a plan
 * built from a NaN angle or a matrix with no inverse would look authoritative
 * and put every box in the wrong place.
 */
export class DeskewError extends Error {
  readonly code: DeskewErrorCode;

  constructor(code: DeskewErrorCode, message: string) {
    super(message);
    this.name = 'DeskewError';
    this.code = code;
  }
}

// --- Constants used by the implementation ----------------------------------

/** Degrees kept on the planned correction: far below a tenth of a pixel on any page a reader handles. */
const PLAN_ANGLE_DECIMALS = 6;

/** Degrees shown in a sentence; matches `preprocess.ts` so the two read alike. */
const REASON_ANGLE_DECIMALS = 2;

/**
 * A determinant below this is treated as zero. A plan's determinant is
 * `scale²`, so this only rejects a hand-built matrix that collapses the plane.
 */
const MIN_DETERMINANT = 1e-12;

/** A page must have a positive extent; a zero-sized page has nothing to map. */
const MIN_PAGE_EXTENT = 1e-9;

/** No plan may correct a quarter turn or more: see {@link MAX_DESKEW_ANGLE_DEG}. */
const ANGLE_LIMIT_DEG = 90;

// --- Planning --------------------------------------------------------------

/**
 * Describes how to un-rotate a page whose text lines sit `angleDeg` off
 * horizontal (positive clockwise), and where a recognised box from that
 * straightened page belongs.
 *
 * The returned plan is pure data. `matrix` maps source page points to deskewed
 * points; `crop` is the box in deskewed space an executor keeps, always anchored
 * at (0, 0); `scale` is the raster multiplier baked into both. See the file
 * header for the three steps and the sign convention.
 *
 * `angleDeg` is not policy-checked here beyond sanity: {@link decision} decides
 * whether a page should be deskewed at all. A caller that follows the decision
 * never passes more than {@link MAX_DESKEW_ANGLE_DEG}, and a caller that wants a
 * different ceiling passes it to the decision.
 *
 * Throws {@link DeskewError} with `invalid-angle` when the angle is not finite or
 * at least a quarter turn, with `invalid-page` when the page has no positive
 * extent, and with `invalid-scale` when `options.scale` is not finite and
 * positive. The same input always returns an equal plan.
 */
export function planDeskew(angleDeg: number, page: DeskewPage, options: DeskewOptions = {}): DeskewPlan {
  const skew = finiteAngle(angleDeg, 'angleDeg');
  if (Math.abs(skew) >= ANGLE_LIMIT_DEG) {
    throw new DeskewError(
      'invalid-angle',
      `planDeskew: a skew of ${skew}° is a page rotation or a crop, not a deskew; angles must be under ${ANGLE_LIMIT_DEG}°.`,
    );
  }
  const width = pageExtent(page, 'width');
  const height = pageExtent(page, 'height');
  const scale = readScale(options.scale);

  const correction = clean(roundTo(-skew, PLAN_ANGLE_DECIMALS));
  const radians = (correction * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  // Rotation about the page centre, then a translation that puts the rotated
  // page's bounding box at the origin. The linear terms are for a rotation that
  // is clockwise on screen for positive degrees, which is the canvas convention.
  const centreX = width / 2;
  const centreY = height / 2;
  const a = cos;
  const b = sin;
  const c = -sin;
  const d = cos;
  const e = centreX - (a * centreX + c * centreY);
  const f = centreY - (b * centreX + d * centreY);

  const bounds = transformedPageBounds(width, height, { a, b, c, d, e, f });
  const matrix: Matrix2D = {
    a: clean(a * scale),
    b: clean(b * scale),
    c: clean(c * scale),
    d: clean(d * scale),
    e: clean(scale * (e - bounds.minX)),
    f: clean(scale * (f - bounds.minY)),
  };

  return {
    angle: correction,
    radians,
    direction: directionOf(correction),
    crop: {
      x: 0,
      y: 0,
      width: Math.max(1, Math.ceil(scale * (bounds.maxX - bounds.minX))),
      height: Math.max(1, Math.ceil(scale * (bounds.maxY - bounds.minY))),
    },
    scale,
    matrix,
  };
}

/**
 * Decides whether a page with `angleDeg` of measured skew should be deskewed,
 * and says why in one complete sentence.
 *
 * The rules, in the order they are checked (see the file header for the
 * reasoning):
 * 1. A quarter turn within {@link PAGE_ROTATION_TOLERANCE_DEG} is page rotation,
 *    never a skew: `deskew` is false.
 * 2. Beyond `maxAngleDeg` (default {@link MAX_DESKEW_ANGLE_DEG}) the page is
 *    refused: correcting it needs a page rotation or a perspective fix.
 * 3. Below `thresholdDeg` (default {@link DESKEW_THRESHOLD_DEG}) the tilt is
 *    ignored, so a page that measures 0.3° is left as it is.
 * 4. Otherwise `deskew` is true and the reason names the angle, the direction
 *    and the correction.
 *
 * Throws {@link DeskewError} with `invalid-angle` for a non-finite angle and
 * `invalid-option` for a threshold or maximum that is not finite, negative, over
 * a quarter turn, or inverted. The same input always returns an equal decision.
 */
export function decision(angleDeg: number, options: DeskewDecisionOptions = {}): DeskewDecision {
  const angle = finiteAngle(angleDeg, 'angleDeg');
  const threshold = readThreshold(options.thresholdDeg ?? DESKEW_THRESHOLD_DEG);
  const maximum = readMaximum(options.maxAngleDeg ?? MAX_DESKEW_ANGLE_DEG);
  if (threshold > maximum) {
    throw new DeskewError(
      'invalid-option',
      `decision: thresholdDeg ${threshold} cannot be larger than maxAngleDeg ${maximum}.`,
    );
  }

  const magnitude = Math.abs(angle);
  if (isPageRotation(angle)) return { deskew: false, reason: rotationReason(angle) };
  if (magnitude > maximum) return { deskew: false, reason: beyondMaximumReason(angle, maximum) };
  // A measured zero is "nothing to do" whatever threshold the caller picked, so
  // a threshold of 0 does not turn a square page into a one-degree rotation.
  if (magnitude === 0) return { deskew: false, reason: squareReason() };
  if (magnitude < threshold) return { deskew: false, reason: belowThresholdReason(angle, threshold) };
  return { deskew: true, reason: deskewReason(angle, threshold) };
}

// --- Mapping ---------------------------------------------------------------

/** Maps one point through `matrix`. Throws `invalid-point`/`invalid-matrix`. */
export function mapPoint(point: Point, matrix: Matrix2D): Point {
  const m = readMatrix(matrix);
  const x = finiteCoordinate(point?.x, 'point.x');
  const y = finiteCoordinate(point?.y, 'point.y');
  return {
    x: m.a * x + m.c * y + m.e,
    y: m.b * x + m.d * y + m.f,
  };
}

/**
 * Maps every point of a polygon through `matrix`, in the same order. Length is
 * preserved; an empty polygon maps to an empty polygon. Corner order is
 * preserved too: a rotation keeps top-left, top-right, bottom-right, bottom-left
 * in that sequence.
 */
export function mapPolygon(polygon: readonly Point[], matrix: Matrix2D): Point[] {
  const m = readMatrix(matrix);
  if (!Array.isArray(polygon)) {
    throw new DeskewError('invalid-point', 'mapPolygon: polygon must be an array of points.');
  }
  return polygon.map(point => mapPoint(point, m));
}

/**
 * Maps a four-corner polygon and keeps its tuple type, for code that holds an
 * IR `Polygon` rather than a loose point list.
 */
export function mapQuad(polygon: Polygon, matrix: Matrix2D): Polygon {
  if (!Array.isArray(polygon) || polygon.length !== 4) {
    throw new DeskewError('invalid-point', 'mapQuad: a polygon must have exactly four points.');
  }
  const [first, second, third, fourth] = mapPolygon(polygon, matrix);
  if (!first || !second || !third || !fourth) {
    throw new DeskewError('invalid-point', 'mapQuad: a polygon must have exactly four points.');
  }
  return [first, second, third, fourth];
}

/**
 * Maps a rect and returns the axis-aligned box that contains the mapped result.
 *
 * A rotation turns a rect into a quadrilateral, so the box is larger than the
 * input unless the angle is a multiple of 90°. Use {@link mapPolygon} when the
 * four corners themselves matter (for drawing or for an exact round trip); this
 * function is for the box a caller needs to reserve.
 */
export function mapRect(rect: Rect, matrix: Matrix2D): Rect {
  const m = readMatrix(matrix);
  const x = finiteCoordinate(rect?.x, 'rect.x', 'invalid-rect');
  const y = finiteCoordinate(rect?.y, 'rect.y', 'invalid-rect');
  const width = finiteCoordinate(rect?.width, 'rect.width', 'invalid-rect');
  const height = finiteCoordinate(rect?.height, 'rect.height', 'invalid-rect');
  const corners: Point[] = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
  const mapped = corners.map(point => mapPoint(point, m));
  const xs = mapped.map(point => point.x);
  const ys = mapped.map(point => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    x: clean(minX),
    y: clean(minY),
    width: clean(Math.max(...xs) - minX),
    height: clean(Math.max(...ys) - minY),
  };
}

/**
 * Returns the inverse of `matrix`, the map from deskewed coordinates back to the
 * original page. Recognised boxes live in deskewed space and the reader draws on
 * the original, so this is the transform an overlay uses.
 *
 * Throws {@link DeskewError} with `non-invertible` when the determinant is zero
 * (a matrix that collapses the plane) and `invalid-matrix` when a field is not
 * finite. Every matrix produced by {@link planDeskew} inverts: its determinant
 * is `scale²`.
 */
export function invertMap(matrix: Matrix2D): Matrix2D {
  const m = readMatrix(matrix);
  const determinant = m.a * m.d - m.b * m.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < MIN_DETERMINANT) {
    throw new DeskewError('non-invertible', `invertMap: the matrix determinant ${determinant} is zero, so it has no inverse.`);
  }
  return {
    a: clean(m.d / determinant),
    b: clean(-m.b / determinant),
    c: clean(-m.c / determinant),
    d: clean(m.a / determinant),
    e: clean((m.c * m.f - m.d * m.e) / determinant),
    f: clean((m.b * m.e - m.a * m.f) / determinant),
  };
}

/**
 * Maps a list of blocks from the original page into deskewed space. Ids, order
 * and every other field are kept; only the polygon is replaced, and the input
 * blocks are not mutated.
 *
 * This is the direction an executor uses when it wants to know where a source
 * block will sit on the straightened bitmap (to crop OCR to a known region, for
 * example). {@link invertBlocks} is the direction an overlay uses.
 */
export function mapBlocks<T extends PolygonBlock>(blocks: readonly T[], matrix: Matrix2D): MappedBlock<T>[] {
  const m = readMatrix(matrix);
  if (!Array.isArray(blocks)) {
    throw new DeskewError('invalid-block', 'mapBlocks: blocks must be an array.');
  }
  return blocks.map((block, index) => {
    if (!block || typeof block !== 'object' || typeof block.id !== 'string') {
      throw new DeskewError('invalid-block', `mapBlocks: blocks[${index}] needs a string id.`);
    }
    return { ...block, polygon: mapQuad(block.polygon, m) };
  });
}

/**
 * Maps recognised blocks from deskewed space back onto the original page:
 * `mapBlocks` through {@link invertMap}. Ids, order and every field except the
 * polygon are preserved, which is what the overlay needs to draw a recognised
 * box where the un-rotated page has it.
 */
export function invertBlocks<T extends PolygonBlock>(blocks: readonly T[], matrix: Matrix2D): MappedBlock<T>[] {
  return mapBlocks(blocks, invertMap(matrix));
}

// --- Geometry helpers ------------------------------------------------------

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Bounds of a page's four corners after mapping them with `matrix`. */
function transformedPageBounds(width: number, height: number, matrix: Matrix2D): Bounds {
  const corners: Point[] = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
  const mapped = corners.map(point => mapPoint(point, matrix));
  const xs = mapped.map(point => point.x);
  const ys = mapped.map(point => point.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function directionOf(correction: number): DeskewDirection {
  if (correction > 0) return 'clockwise';
  if (correction < 0) return 'counter-clockwise';
  return 'none';
}

/**
 * True when the measured angle is a quarter turn within
 * {@link PAGE_ROTATION_TOLERANCE_DEG}: a page that was turned, not skewed.
 * Multiples of zero are excluded — a page with no measurable skew is left to the
 * ordinary threshold rules, not called a rotation.
 */
function isPageRotation(angleDeg: number): boolean {
  const quarterTurn = Math.round(angleDeg / 90) * 90;
  if (quarterTurn === 0) return false;
  return Math.abs(angleDeg - quarterTurn) <= PAGE_ROTATION_TOLERANCE_DEG;
}

// --- Validation ------------------------------------------------------------

function finiteAngle(value: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DeskewError('invalid-angle', `${name} must be a finite number of degrees, got ${String(value)}.`);
  }
  return value;
}

function pageExtent(page: DeskewPage, field: 'width' | 'height'): number {
  if (!page || typeof page !== 'object') {
    throw new DeskewError('invalid-page', 'planDeskew: page must be an object with a width and a height.');
  }
  const value = page[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_PAGE_EXTENT) {
    throw new DeskewError('invalid-page', `planDeskew: page.${field} must be a positive number, got ${String(value)}.`);
  }
  return value;
}

function readScale(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DESKEW_SCALE;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new DeskewError('invalid-scale', `planDeskew: scale must be a positive number, got ${String(value)}.`);
  }
  return value;
}

function readThreshold(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DeskewError('invalid-option', `decision: thresholdDeg must be a finite number at least 0, got ${String(value)}.`);
  }
  return value;
}

function readMaximum(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > ANGLE_LIMIT_DEG) {
    throw new DeskewError(
      'invalid-option',
      `decision: maxAngleDeg must be a finite number in (0, ${ANGLE_LIMIT_DEG}], got ${String(value)}.`,
    );
  }
  return value;
}

function finiteCoordinate(value: unknown, label: string, code: 'invalid-point' | 'invalid-rect' = 'invalid-point'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DeskewError(code, `${label} must be a finite number, got ${String(value)}.`);
  }
  return value;
}

function readMatrix(matrix: Matrix2D): Matrix2D {
  if (!matrix || typeof matrix !== 'object') {
    throw new DeskewError('invalid-matrix', 'A matrix needs a, b, c, d, e and f.');
  }
  for (const field of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
    const value = matrix[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new DeskewError('invalid-matrix', `matrix.${field} must be a finite number, got ${String(value)}.`);
    }
  }
  return matrix;
}

// --- Sentence helpers ------------------------------------------------------

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Keeps `-0` out of plans, matrices and reasons; it compares and serialises oddly. */
function clean(value: number): number {
  return value === 0 ? 0 : value;
}

/** Absolute degrees for a sentence, with trailing zeros trimmed: 2.5 reads "2.5°". */
function formatDegrees(value: number): string {
  const text = Math.abs(value)
    .toFixed(REASON_ANGLE_DECIMALS)
    .replace(/\.?0+$/u, '')
    .replace(/\.$/u, '');
  return `${text}°`;
}

function tiltWord(angleDeg: number): string {
  return angleDeg > 0 ? 'clockwise' : 'counter-clockwise';
}

function rotationReason(angleDeg: number): string {
  const magnitude = Math.abs(angleDeg);
  const quarterTurns = Math.round(magnitude / 90);
  const turnWord = quarterTurns === 1 ? 'a quarter turn' : `${quarterTurns} quarter turns`;
  const wording = magnitude === quarterTurns * 90
    ? `${formatDegrees(angleDeg)}, ${turnWord}`
    : `${formatDegrees(angleDeg)}, within ${formatDegrees(PAGE_ROTATION_TOLERANCE_DEG)} of ${turnWord}`;
  return `The page is turned by ${wording} rather than skewed; set the page rotation (in the document IR) instead, `
    + 'because a quarter turn swaps the page dimensions and the reading order, and undoing it is rotation metadata '
    + 'rather than scan correction.';
}

function beyondMaximumReason(angleDeg: number, maximumDeg: number): string {
  return `The measured tilt is ${formatDegrees(angleDeg)}, past the ${formatDegrees(maximumDeg)} maximum for a deskew; `
    + 'a page that far from square is a mis-loaded sheet or a hand-held capture with wrong perspective, '
    + 'so record the page rotation (or re-scan it) and correct the remaining skew only if it is small.';
}

function squareReason(): string {
  return 'The page measures 0° of skew; there is nothing to deskew.';
}

function belowThresholdReason(angleDeg: number, thresholdDeg: number): string {
  return `The text lines are tilted ${formatDegrees(angleDeg)} ${tiltWord(angleDeg)}, below the `
    + `${formatDegrees(thresholdDeg)} threshold; a correction this small moves a word by under a pixel, `
    + 'while rotating the page resamples every glyph, so the page is left as it is.';
}

function deskewReason(angleDeg: number, thresholdDeg: number): string {
  const tilt = tiltWord(angleDeg);
  const correction = angleDeg > 0 ? 'counter-clockwise' : 'clockwise';
  return `The text lines are tilted ${formatDegrees(angleDeg)} ${tilt}, above the ${formatDegrees(thresholdDeg)} threshold; `
    + `the page is rotated ${formatDegrees(angleDeg)} ${correction} before OCR, and the recognised boxes are mapped `
    + 'back onto the original page so the overlay lands where the text is.';
}
