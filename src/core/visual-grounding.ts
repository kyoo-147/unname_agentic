/**
 * Pure polygon visual grounding and 4-corner inverse crop transforms (backlog F08).
 *
 * All page-level coordinates use a single canonical schema:
 * - {@link NormalizedBBox}: `[xMin, yMin, xMax, yMax]` in `[0, 1000]` (`xy`-first).
 * - {@link Point2D} / {@link Quad} / {@link Polygon}: top-left origin, `y` growing
 *   downwards, matching `Rect` in `./types` and `Point`/`Polygon` in `./ir`.
 *
 * When an OCR or vision model inspects a cropped, rotated, padded, and resized
 * region, {@link mapBBoxToOriginal} maps all 4 rectangle corners back through the
 * recorded {@link CropTransform} so both the exact rotated {@link Quad} and its tight
 * enclosing {@link NormalizedBBox} remain accurate for `0°`, `90°`, `180°`, `270°`,
 * and arbitrary rotation angles such as `45°`.
 *
 * Contract: pure, deterministic, zero DOM/I/O/clock dependencies.
 */

import type { Rect } from './types';

export const NORMALIZED_COORD_MAX = 1000;

/** Canonical `[xMin, yMin, xMax, yMax]` normalized to `[0, 1000]`. */
export type NormalizedBBox = [number, number, number, number];

export type BBoxAxisOrder = 'xyxy' | 'yxyx';

export interface Point2D {
  x: number;
  y: number;
}

export type Polygon = Point2D[];

/** Four corners in local top-left, top-right, bottom-right, bottom-left order. */
export type Quad = [Point2D, Point2D, Point2D, Point2D];

export interface Size2D {
  width: number;
  height: number;
}

export interface CropPadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Full provenance for a cropped, rotated, white-padded, and resized image so
 * local detections map back accurately to original normalized page space.
 */
export interface CropTransform {
  originalSize: Size2D;
  cropRectPx: Rect;
  /** Counter-clockwise rotation angle in degrees (`y` grows downwards). */
  rotationDegCCW: number;
  rotatedSize: Size2D;
  paddingPx?: CropPadding;
  resizedSize: Size2D;
}

export interface MappedBBoxResult {
  quad: Quad;
  bbox: NormalizedBBox;
}

export interface GroundedRegion {
  bbox: NormalizedBBox;
  quad?: Quad;
  score?: number;
  confidence?: number;
  content?: string;
  label?: string;
  pageIndex?: number;
}

export interface DeduplicateRegionsOptions {
  iouThreshold?: number;
  iouMinThreshold?: number;
  mode?: 'nms' | 'merge';
}

export type VisualGroundingErrorCode =
  | 'invalid-bbox'
  | 'invalid-transform'
  | 'invalid-grid'
  | 'invalid-polygon';

export class VisualGroundingError extends Error {
  readonly code: VisualGroundingErrorCode;

  constructor(code: VisualGroundingErrorCode, message: string) {
    super(message);
    this.name = 'VisualGroundingError';
    this.code = code;
  }
}

export type BBoxValidationResult =
  | { ok: true; bbox: NormalizedBBox }
  | { ok: false; code: 'invalid-shape' | 'non-finite' | 'out-of-bounds' | 'inverted-or-empty'; message: string };

const ZERO_PADDING: CropPadding = { top: 0, right: 0, bottom: 0, left: 0 };

// --- Coordinate Validation & Conversions -----------------------------------

export function validateNormalizedBBox(
  raw: unknown,
  maxCoord: number = NORMALIZED_COORD_MAX,
): BBoxValidationResult {
  if (!Number.isFinite(maxCoord) || maxCoord <= 0) {
    return { ok: false, code: 'out-of-bounds', message: `maxCoord must be positive finite; received ${String(maxCoord)}.` };
  }
  if (!Array.isArray(raw) || raw.length !== 4) {
    return { ok: false, code: 'invalid-shape', message: 'BBox must be a 4-element tuple [xMin, yMin, xMax, yMax].' };
  }

  const xMin = raw[0] as unknown;
  const yMin = raw[1] as unknown;
  const xMax = raw[2] as unknown;
  const yMax = raw[3] as unknown;
  if (
    typeof xMin !== 'number' || !Number.isFinite(xMin) ||
    typeof yMin !== 'number' || !Number.isFinite(yMin) ||
    typeof xMax !== 'number' || !Number.isFinite(xMax) ||
    typeof yMax !== 'number' || !Number.isFinite(yMax)
  ) {
    return { ok: false, code: 'non-finite', message: 'BBox coordinates must all be finite numbers.' };
  }

  if (xMin < 0 || yMin < 0 || xMax > maxCoord || yMax > maxCoord) {
    return {
      ok: false,
      code: 'out-of-bounds',
      message: `BBox [${xMin}, ${yMin}, ${xMax}, ${yMax}] leaves [0, ${maxCoord}].`,
    };
  }

  if (xMin >= xMax || yMin >= yMax) {
    return {
      ok: false,
      code: 'inverted-or-empty',
      message: `BBox [${xMin}, ${yMin}, ${xMax}, ${yMax}] must satisfy xMin < xMax and yMin < yMax.`,
    };
  }

  return { ok: true, bbox: [xMin, yMin, xMax, yMax] };
}

/**
 * Explicitly converts an adapter bbox in `'xyxy'` or `'yxyx'` order into the
 * canonical `[xMin, yMin, xMax, yMax]` format and validates bounds and order.
 */
export function fromAxisOrder(
  raw: readonly [number, number, number, number],
  order: BBoxAxisOrder = 'xyxy',
  maxCoord: number = NORMALIZED_COORD_MAX,
): NormalizedBBox {
  const ordered: NormalizedBBox =
    order === 'yxyx'
      ? [raw[1], raw[0], raw[3], raw[2]]
      : [raw[0], raw[1], raw[2], raw[3]];
  const check = validateNormalizedBBox(ordered, maxCoord);
  if (!check.ok) {
    throw new VisualGroundingError('invalid-bbox', check.message);
  }
  return check.bbox;
}

/**
 * Reorders inverted bounds, clamps to `[0, maxCoord]`, and enforces a
 * non-zero minimum span along both axes (`>= minSpan`).
 */
export function clampAndOrderBBox(
  box: readonly [number, number, number, number],
  maxCoord: number = NORMALIZED_COORD_MAX,
  minSpan: number = 1,
): NormalizedBBox {
  assertPositiveFinite(maxCoord, 'maxCoord', 'invalid-bbox');
  assertPositiveFinite(minSpan, 'minSpan', 'invalid-bbox');
  for (const coord of box) {
    if (typeof coord !== 'number' || !Number.isFinite(coord)) {
      throw new VisualGroundingError('invalid-bbox', 'BBox coordinates must be finite numbers.');
    }
  }

  const effectiveSpan = Math.min(minSpan, maxCoord);
  const [xMin, xMax] = clampAxisPair(box[0], box[2], maxCoord, effectiveSpan);
  const [yMin, yMax] = clampAxisPair(box[1], box[3], maxCoord, effectiveSpan);
  return [xMin, yMin, xMax, yMax];
}

export function fromUnitInterval(
  box: readonly [number, number, number, number],
  maxCoord: number = NORMALIZED_COORD_MAX,
): NormalizedBBox {
  const unitCheck = validateNormalizedBBox(box, 1);
  if (!unitCheck.ok) {
    throw new VisualGroundingError('invalid-bbox', unitCheck.message);
  }
  assertPositiveFinite(maxCoord, 'maxCoord', 'invalid-bbox');
  return [
    unitCheck.bbox[0] * maxCoord,
    unitCheck.bbox[1] * maxCoord,
    unitCheck.bbox[2] * maxCoord,
    unitCheck.bbox[3] * maxCoord,
  ];
}

export function toUnitInterval(
  box: readonly [number, number, number, number],
  maxCoord: number = NORMALIZED_COORD_MAX,
): [number, number, number, number] {
  const valid = assertValidBBox(box, maxCoord);
  return [
    valid[0] / maxCoord,
    valid[1] / maxCoord,
    valid[2] / maxCoord,
    valid[3] / maxCoord,
  ];
}

export function toPixelBox(
  box: readonly [number, number, number, number],
  width: number,
  height: number,
  maxCoord: number = NORMALIZED_COORD_MAX,
): Rect {
  const valid = assertValidBBox(box, maxCoord);
  assertPositiveFinite(width, 'width', 'invalid-bbox');
  assertPositiveFinite(height, 'height', 'invalid-bbox');
  const x = (valid[0] / maxCoord) * width;
  const y = (valid[1] / maxCoord) * height;
  return {
    x,
    y,
    width: ((valid[2] - valid[0]) / maxCoord) * width,
    height: ((valid[3] - valid[1]) / maxCoord) * height,
  };
}

export function fromPixelBox(
  rect: Rect,
  width: number,
  height: number,
  maxCoord: number = NORMALIZED_COORD_MAX,
): NormalizedBBox {
  assertPositiveFinite(width, 'width', 'invalid-bbox');
  assertPositiveFinite(height, 'height', 'invalid-bbox');
  assertPositiveFinite(maxCoord, 'maxCoord', 'invalid-bbox');
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    throw new VisualGroundingError('invalid-bbox', 'Pixel rect must have finite coordinates and positive dimensions.');
  }

  return clampAndOrderBBox(
    [
      (rect.x / width) * maxCoord,
      (rect.y / height) * maxCoord,
      ((rect.x + rect.width) / width) * maxCoord,
      ((rect.y + rect.height) / height) * maxCoord,
    ],
    maxCoord,
    1e-6,
  );
}

// --- Rotation & 4-Corner Inverse Crop Transforms ---------------------------

/**
 * Computes expanded axis-aligned bounding size after rotating a `width × height`
 * rectangle counter-clockwise by `rotationDegCCW` degrees.
 */
export function computeRotatedSize(width: number, height: number, rotationDegCCW: number): Size2D {
  assertPositiveFinite(width, 'width', 'invalid-transform');
  assertPositiveFinite(height, 'height', 'invalid-transform');
  if (!Number.isFinite(rotationDegCCW)) {
    throw new VisualGroundingError('invalid-transform', 'rotationDegCCW must be finite.');
  }
  const { cos, sin } = trigDeg(rotationDegCCW);
  const absCos = Math.abs(cos);
  const absSin = Math.abs(sin);
  return {
    width: width * absCos + height * absSin,
    height: width * absSin + height * absCos,
  };
}

/**
 * Maps a point in `transform.resizedSize` pixel coordinates back through:
 * 1. `resizedSize` -> `(rotatedSize + paddingPx)` unscale
 * 2. `(paddingPx.left, paddingPx.top)` subtraction
 * 3. inverse CCW rotation around `rotatedSize` center into `cropRectPx`
 * 4. `(cropRectPx.x, cropRectPx.y)` offset
 * 5. normalization to `[0, 1000]` on `originalSize` (clamped).
 */
export function mapPointToOriginal(pt: Point2D, transform: CropTransform): Point2D {
  if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
    throw new VisualGroundingError('invalid-transform', 'Point coordinates must be finite.');
  }
  const padding = readValidatedTransform(transform);

  const paddedWidth = transform.rotatedSize.width + padding.left + padding.right;
  const paddedHeight = transform.rotatedSize.height + padding.top + padding.bottom;

  const xPadded = pt.x * (paddedWidth / transform.resizedSize.width);
  const yPadded = pt.y * (paddedHeight / transform.resizedSize.height);

  const xRot = xPadded - padding.left;
  const yRot = yPadded - padding.top;

  const vx = xRot - transform.rotatedSize.width / 2;
  const vy = yRot - transform.rotatedSize.height / 2;
  const { cos, sin } = trigDeg(transform.rotationDegCCW);

  // Screen-space (y-down) inverse of CCW rotation:
  // forward:  vx' =  vx*cos + vy*sin,  vy' = -vx*sin + vy*cos
  // inverse:  vx  =  vx'*cos - vy'*sin, vy  =  vx'*sin + vy'*cos
  const cropX = transform.cropRectPx.width / 2 + vx * cos - vy * sin;
  const cropY = transform.cropRectPx.height / 2 + vx * sin + vy * cos;

  const origPxX = transform.cropRectPx.x + cropX;
  const origPxY = transform.cropRectPx.y + cropY;

  return {
    x: clampNumber((origPxX / transform.originalSize.width) * NORMALIZED_COORD_MAX, 0, NORMALIZED_COORD_MAX),
    y: clampNumber((origPxY / transform.originalSize.height) * NORMALIZED_COORD_MAX, 0, NORMALIZED_COORD_MAX),
  };
}

/**
 * Convenience wrapper when the input point is normalized `[0, 1000]` within
 * `transform.resizedSize` rather than pixel units.
 */
export function mapNormalizedPointToOriginal(normPt: Point2D, transform: CropTransform): Point2D {
  readValidatedTransform(transform);
  return mapPointToOriginal(
    {
      x: (normPt.x / NORMALIZED_COORD_MAX) * transform.resizedSize.width,
      y: (normPt.y / NORMALIZED_COORD_MAX) * transform.resizedSize.height,
    },
    transform,
  );
}

/**
 * Maps a local normalized bbox `[xMin, yMin, xMax, yMax]` inside `transform.resizedSize`
 * back to original page `[0, 1000]` coordinates by projecting all 4 corners.
 */
export function mapBBoxToOriginal(
  localNormBox: readonly [number, number, number, number],
  transform: CropTransform,
): MappedBBoxResult {
  const valid = assertValidBBox(localNormBox, NORMALIZED_COORD_MAX);
  readValidatedTransform(transform);

  const x0 = (valid[0] / NORMALIZED_COORD_MAX) * transform.resizedSize.width;
  const y0 = (valid[1] / NORMALIZED_COORD_MAX) * transform.resizedSize.height;
  const x1 = (valid[2] / NORMALIZED_COORD_MAX) * transform.resizedSize.width;
  const y1 = (valid[3] / NORMALIZED_COORD_MAX) * transform.resizedSize.height;

  const quad: Quad = [
    mapPointToOriginal({ x: x0, y: y0 }, transform),
    mapPointToOriginal({ x: x1, y: y0 }, transform),
    mapPointToOriginal({ x: x1, y: y1 }, transform),
    mapPointToOriginal({ x: x0, y: y1 }, transform),
  ];

  return {
    quad,
    bbox: polygonToBBox(quad, NORMALIZED_COORD_MAX),
  };
}

/**
 * Forward-maps a normalized `[0, 1000]` original page point into `transform.resizedSize`
 * pixel coordinates. Useful for crop verification and round-trip alignment checks.
 */
export function mapOriginalPointToCrop(origNormPt: Point2D, transform: CropTransform): Point2D {
  if (!Number.isFinite(origNormPt.x) || !Number.isFinite(origNormPt.y)) {
    throw new VisualGroundingError('invalid-transform', 'Point coordinates must be finite.');
  }
  const padding = readValidatedTransform(transform);

  const origPxX = (origNormPt.x / NORMALIZED_COORD_MAX) * transform.originalSize.width;
  const origPxY = (origNormPt.y / NORMALIZED_COORD_MAX) * transform.originalSize.height;

  const cropX = origPxX - transform.cropRectPx.x;
  const cropY = origPxY - transform.cropRectPx.y;

  const vx = cropX - transform.cropRectPx.width / 2;
  const vy = cropY - transform.cropRectPx.height / 2;
  const { cos, sin } = trigDeg(transform.rotationDegCCW);

  const xRot = transform.rotatedSize.width / 2 + vx * cos + vy * sin;
  const yRot = transform.rotatedSize.height / 2 - vx * sin + vy * cos;

  const xPadded = xRot + padding.left;
  const yPadded = yRot + padding.top;

  const paddedWidth = transform.rotatedSize.width + padding.left + padding.right;
  const paddedHeight = transform.rotatedSize.height + padding.top + padding.bottom;

  return {
    x: xPadded * (transform.resizedSize.width / paddedWidth),
    y: yPadded * (transform.resizedSize.height / paddedHeight),
  };
}

// --- Polygon & Region Operations -------------------------------------------

export function bboxToQuad(box: readonly [number, number, number, number]): Quad {
  const valid = assertValidBBox(box, NORMALIZED_COORD_MAX);
  return [
    { x: valid[0], y: valid[1] },
    { x: valid[2], y: valid[1] },
    { x: valid[2], y: valid[3] },
    { x: valid[0], y: valid[3] },
  ];
}

export function polygonToBBox(
  poly: readonly Point2D[],
  maxCoord: number = NORMALIZED_COORD_MAX,
): NormalizedBBox {
  if (poly.length === 0) {
    throw new VisualGroundingError('invalid-polygon', 'Polygon must contain at least one vertex.');
  }
  let xMin = Number.POSITIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;

  for (const pt of poly) {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      throw new VisualGroundingError('invalid-polygon', 'Polygon vertices must be finite.');
    }
    if (pt.x < xMin) xMin = pt.x;
    if (pt.y < yMin) yMin = pt.y;
    if (pt.x > xMax) xMax = pt.x;
    if (pt.y > yMax) yMax = pt.y;
  }

  return clampAndOrderBBox([xMin, yMin, xMax, yMax], maxCoord, 1e-6);
}

/** Computes polygon area via the shoelace formula; returns `0` for `< 3` vertices. */
export function computePolygonArea(poly: readonly Point2D[]): number {
  if (poly.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const curr = poly[i];
    const next = poly[(i + 1) % poly.length];
    if (curr === undefined || next === undefined) continue;
    if (!Number.isFinite(curr.x) || !Number.isFinite(curr.y) || !Number.isFinite(next.x) || !Number.isFinite(next.y)) {
      throw new VisualGroundingError('invalid-polygon', 'Polygon vertices must be finite.');
    }
    sum += curr.x * next.y - next.x * curr.y;
  }
  return Math.abs(sum) * 0.5;
}

export function computeBBoxArea(box: readonly [number, number, number, number]): number {
  const width = box[2] - box[0];
  const height = box[3] - box[1];
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 0;
  }
  return width * height;
}

export function computeIntersectionArea(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): number {
  const xMin = Math.max(a[0], b[0]);
  const yMin = Math.max(a[1], b[1]);
  const xMax = Math.min(a[2], b[2]);
  const yMax = Math.min(a[3], b[3]);
  const width = xMax - xMin;
  const height = yMax - yMin;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 0;
  }
  return width * height;
}

export function computeIoU(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): number {
  const inter = computeIntersectionArea(a, b);
  if (inter <= 0) return 0;
  const union = computeBBoxArea(a) + computeBBoxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Containment-tolerant overlap: `intersection / min(areaA, areaB)`. */
export function computeIoUMin(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): number {
  const inter = computeIntersectionArea(a, b);
  if (inter <= 0) return 0;
  const minArea = Math.min(computeBBoxArea(a), computeBBoxArea(b));
  return minArea > 0 ? inter / minArea : 0;
}

/**
 * Deduplicates or merges overlapping regions across zoom rounds or adjacent tiles.
 * Regions on different `pageIndex` values are never merged or suppressed against one another.
 */
export function mergeOrDeduplicateRegions<T extends GroundedRegion>(
  regions: readonly T[],
  optionsOrThreshold: number | DeduplicateRegionsOptions = 0.5,
): T[] {
  const opts: DeduplicateRegionsOptions =
    typeof optionsOrThreshold === 'number'
      ? { iouThreshold: optionsOrThreshold }
      : optionsOrThreshold;
  const iouThreshold = opts.iouThreshold ?? 0.5;
  const iouMinThreshold = opts.iouMinThreshold;
  const mode = opts.mode ?? 'nms';

  const ranked = regions
    .map((region, index) => ({ region, index, priority: regionPriority(region) }))
    .sort((left, right) => right.priority - left.priority || left.index - right.index);

  const kept: T[] = [];
  for (const entry of ranked) {
    const candidate = entry.region;
    let matchedIndex = -1;

    for (let i = 0; i < kept.length; i += 1) {
      const existing = kept[i];
      if (existing === undefined) continue;
      if (!samePage(existing.pageIndex, candidate.pageIndex)) continue;

      const iou = computeIoU(existing.bbox, candidate.bbox);
      const iouMinHit = iouMinThreshold !== undefined && computeIoUMin(existing.bbox, candidate.bbox) >= iouMinThreshold;
      if (iou >= iouThreshold || iouMinHit) {
        matchedIndex = i;
        break;
      }
    }

    if (matchedIndex === -1) {
      kept.push({ ...candidate });
      continue;
    }

    if (mode === 'merge') {
      const target = kept[matchedIndex];
      if (target !== undefined) {
        const unionBBox: NormalizedBBox = [
          Math.min(target.bbox[0], candidate.bbox[0]),
          Math.min(target.bbox[1], candidate.bbox[1]),
          Math.max(target.bbox[2], candidate.bbox[2]),
          Math.max(target.bbox[3], candidate.bbox[3]),
        ];
        kept[matchedIndex] = {
          ...target,
          bbox: unionBBox,
          ...(target.quad !== undefined ? { quad: bboxToQuad(unionBBox) } : {}),
        };
      }
    }
  }

  return kept;
}

/**
 * Pure geometry planner producing overlapping normalized tile bboxes in row-major order.
 */
export function planGridTiles(
  size: Size2D,
  rows: number = 2,
  cols: number = 2,
  overlapRatio: number = 0.08,
  minOverlapPx: number = 16,
): NormalizedBBox[] {
  assertPositiveFinite(size.width, 'size.width', 'invalid-grid');
  assertPositiveFinite(size.height, 'size.height', 'invalid-grid');
  if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
    throw new VisualGroundingError('invalid-grid', 'rows and cols must be integers >= 1.');
  }
  if (!Number.isFinite(overlapRatio) || overlapRatio < 0 || overlapRatio >= 1) {
    throw new VisualGroundingError('invalid-grid', 'overlapRatio must be in [0, 1).');
  }
  if (!Number.isFinite(minOverlapPx) || minOverlapPx < 0) {
    throw new VisualGroundingError('invalid-grid', 'minOverlapPx must be finite >= 0.');
  }

  const xSpans = splitAxisWithOverlap(size.width, cols, overlapRatio, minOverlapPx);
  const ySpans = splitAxisWithOverlap(size.height, rows, overlapRatio, minOverlapPx);

  const tiles: NormalizedBBox[] = [];
  for (const [y0, y1] of ySpans) {
    for (const [x0, x1] of xSpans) {
      tiles.push([
        (x0 / size.width) * NORMALIZED_COORD_MAX,
        (y0 / size.height) * NORMALIZED_COORD_MAX,
        (x1 / size.width) * NORMALIZED_COORD_MAX,
        (y1 / size.height) * NORMALIZED_COORD_MAX,
      ]);
    }
  }
  return tiles;
}

// --- Internal Helpers ------------------------------------------------------

function splitAxisWithOverlap(
  length: number,
  segments: number,
  overlapRatio: number,
  minOverlapPx: number,
): Array<[number, number]> {
  if (segments === 1) return [[0, length]];
  const cell = length / segments;
  // Cap overlap strictly below cell width so adjacent tiles never collapse onto each other.
  const overlap = Math.min(cell * 0.99, Math.max(minOverlapPx, length * overlapRatio));
  const halfOverlap = overlap / 2;

  const spans: Array<[number, number]> = [];
  for (let i = 0; i < segments; i += 1) {
    const start = i === 0 ? 0 : Math.max(0, i * cell - halfOverlap);
    const end = i === segments - 1 ? length : Math.min(length, (i + 1) * cell + halfOverlap);
    spans.push([start, end]);
  }
  return spans;
}

function clampAxisPair(
  rawA: number,
  rawB: number,
  maxCoord: number,
  minSpan: number,
): [number, number] {
  let lo = clampNumber(Math.min(rawA, rawB), 0, maxCoord);
  let hi = clampNumber(Math.max(rawA, rawB), 0, maxCoord);
  if (hi - lo < minSpan) {
    if (lo + minSpan <= maxCoord) {
      hi = lo + minSpan;
    } else {
      hi = maxCoord;
      lo = Math.max(0, maxCoord - minSpan);
    }
  }
  return [lo, hi];
}

function trigDeg(deg: number): { cos: number; sin: number } {
  const normalized = ((deg % 360) + 360) % 360;
  if (normalized === 0) return { cos: 1, sin: 0 };
  if (normalized === 90) return { cos: 0, sin: 1 };
  if (normalized === 180) return { cos: -1, sin: 0 };
  if (normalized === 270) return { cos: 0, sin: -1 };
  const rad = (deg * Math.PI) / 180;
  return { cos: Math.cos(rad), sin: Math.sin(rad) };
}

function readValidatedTransform(transform: CropTransform): CropPadding {
  assertPositiveFinite(transform.originalSize.width, 'originalSize.width', 'invalid-transform');
  assertPositiveFinite(transform.originalSize.height, 'originalSize.height', 'invalid-transform');
  assertPositiveFinite(transform.cropRectPx.width, 'cropRectPx.width', 'invalid-transform');
  assertPositiveFinite(transform.cropRectPx.height, 'cropRectPx.height', 'invalid-transform');
  if (!Number.isFinite(transform.cropRectPx.x) || !Number.isFinite(transform.cropRectPx.y)) {
    throw new VisualGroundingError('invalid-transform', 'cropRectPx.x and cropRectPx.y must be finite.');
  }
  if (!Number.isFinite(transform.rotationDegCCW)) {
    throw new VisualGroundingError('invalid-transform', 'rotationDegCCW must be finite.');
  }
  assertPositiveFinite(transform.rotatedSize.width, 'rotatedSize.width', 'invalid-transform');
  assertPositiveFinite(transform.rotatedSize.height, 'rotatedSize.height', 'invalid-transform');
  assertPositiveFinite(transform.resizedSize.width, 'resizedSize.width', 'invalid-transform');
  assertPositiveFinite(transform.resizedSize.height, 'resizedSize.height', 'invalid-transform');

  const pad = transform.paddingPx ?? ZERO_PADDING;
  for (const edge of [pad.top, pad.right, pad.bottom, pad.left]) {
    if (!Number.isFinite(edge) || edge < 0) {
      throw new VisualGroundingError('invalid-transform', 'paddingPx edges must be finite and >= 0.');
    }
  }
  return pad;
}

function assertValidBBox(box: readonly [number, number, number, number], maxCoord: number): NormalizedBBox {
  const check = validateNormalizedBBox(box, maxCoord);
  if (!check.ok) {
    throw new VisualGroundingError('invalid-bbox', check.message);
  }
  return check.bbox;
}

function assertPositiveFinite(
  value: number,
  name: string,
  code: VisualGroundingErrorCode,
): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new VisualGroundingError(code, `${name} must be a positive finite number; received ${String(value)}.`);
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function regionPriority(region: GroundedRegion): number {
  if (typeof region.score === 'number' && Number.isFinite(region.score)) return region.score;
  if (typeof region.confidence === 'number' && Number.isFinite(region.confidence)) return region.confidence;
  return 1;
}

function samePage(a: number | undefined, b: number | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}
