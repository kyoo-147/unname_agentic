/**
 * Pure-TS visual document diff engine and unified text + visual diff (backlog item H10).
 *
 * Text-only diffing (`src/core/diff.ts`) misses edits to diagrams, stamps, signatures,
 * charts, and layout shifts where extracted text stays unchanged. Conversely, naive
 * byte-for-byte image equality flags scanner dust, JPEG compression, anti-aliasing
 * jitter, and dynamic timestamps on every re-export.
 *
 * This module implements the visual diff layer and unifies it with {@link diffDocuments}
 * from `src/core/diff.ts`:
 * - {@link diffPageImages} compares two RGBA page buffers, excludes masked dynamic zones
 *   (timestamps, watermarks, dynamic footers), computes local Rec.601 luminance SSIM
 *   window scores, filters sub-pixel intensity jitter and isolated speckle noise via
 *   connected-component area thresholds, and extracts ordered pixel bounding boxes.
 * - {@link diffDocumentVersions} combines per-page text diffs from {@link diffDocuments}
 *   with per-page visual diffs, converts changed pixel regions into PDF page-point
 *   coordinates, and correlates text `BlockDiff` records with overlapping visual regions.
 *
 * Contract:
 * - Pure and deterministic: no DOM, no Canvas, no clock, no randomness, no I/O.
 * - Strict TypeScript compatible (`strict: true`, `noUncheckedIndexedAccess: true`).
 * - Coordinates use top-left origin with y growing downwards, matching `Rect` in
 *   `src/core/types.ts` and `Polygon` in `src/core/ir.ts`.
 */

import {
  diffDocuments,
  type BlockDiff,
  type DiffSummary,
  type DocumentDiff,
  type PageDiff,
  type PageDiffStatus,
} from './diff';
import type { DocumentIR, Point } from './ir';
import type { Rect } from './types';

// --- Constants --------------------------------------------------------------

/**
 * Default per-channel intensity delta (0..255) at or below which two pixels are
 * treated as compression or sub-pixel resampling jitter rather than a visual edit.
 */
export const DEFAULT_INTENSITY_THRESHOLD = 16;

/**
 * Default minimum connected-component pixel count retained as a changed visual
 * region. Smaller isolated components are suppressed as scanner/OCR speckle noise.
 */
export const DEFAULT_MIN_COMPONENT_AREA = 4;

/** Default edge size in pixels of local SSIM windows. */
export const DEFAULT_SSIM_WINDOW_SIZE = 8;

/** Default step in pixels between adjacent SSIM windows. */
export const DEFAULT_SSIM_STRIDE = 4;

/** Wang et al. (2004) SSIM stability constants for 8-bit luminance (L = 255). */
const SSIM_C1 = (0.01 * 255) ** 2;
const SSIM_C2 = (0.03 * 255) ** 2;

const ROUND_EPSILON = 1e-9;

// --- Error types ------------------------------------------------------------

export type VisualDiffErrorCode =
  | 'invalid-image'
  | 'short-buffer'
  | 'dimension-mismatch'
  | 'invalid-options';

/** Explicit failure raised on malformed image inputs, option bounds, or strict size mismatches. */
export class VisualDiffError extends Error {
  readonly code: VisualDiffErrorCode;

  constructor(code: VisualDiffErrorCode, message: string) {
    super(message);
    this.name = 'VisualDiffError';
    this.code = code;
  }
}

// --- Public types -----------------------------------------------------------

/** Row-major 4-bytes-per-pixel RGBA raster buffer (e.g., Canvas ImageData or decoded page). */
export interface RgbaImage {
  readonly data: Uint8ClampedArray | Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/** Rectangular exclusion zone (timestamps, watermarks, page counters) in pixel coordinates. */
export interface VisualMask extends Rect {
  readonly label?: string;
}

/** Policy when `before` and `after` images have different pixel dimensions. */
export type DimensionMismatchPolicy = 'report' | 'throw' | 'resample';

export interface VisualDiffOptions {
  /** Minimum per-channel difference (0..255) required to flag a pixel as changed. Default: 16. */
  readonly intensityThreshold?: number;
  /** Minimum connected-component area in pixels retained after speckle suppression. Default: 4. */
  readonly minComponentArea?: number;
  /** Maximum Chebyshev pixel gap within which adjacent regions are merged. Default: 0. */
  readonly mergeDistance?: number;
  /** Dynamic zones in pixel coordinates ignored by both region diffing and SSIM. */
  readonly exclusionMasks?: readonly VisualMask[];
  /** Edge size in pixels for local luminance SSIM windows. Default: 8. */
  readonly ssimWindowSize?: number;
  /** Step in pixels between adjacent SSIM windows. Default: 4. */
  readonly ssimStride?: number;
  /** How to handle differing dimensions between `before` and `after`. Default: `'report'`. */
  readonly onDimensionMismatch?: DimensionMismatchPolicy;
  /**
   * Optional 1-pixel bidirectional neighborhood match to suppress single-pixel glyph edge
   * shift from OCR/scan alignment jitter (`0` disables, `1` enables). Default: `0`.
   */
  readonly subpixelJitterRadius?: 0 | 1;
}

export type VisualDiffStatus = 'identical' | 'changed' | 'dimension-mismatch';

export interface VisualChangedRegion {
  /** Pixel bounding box in top-left origin coordinates. */
  readonly rect: Rect;
  /** Unmasked changed pixels belonging to this component. */
  readonly pixelCount: number;
  /** Fraction of `rect.width * rect.height` occupied by changed pixels, 0..1. */
  readonly fillRatio: number;
  /** Mean per-channel max intensity delta across pixels in the component, 0..255. */
  readonly meanDelta: number;
  /** Peak per-channel max intensity delta inside the component, 0..255. */
  readonly maxDelta: number;
  /** Mean absolute Rec.601 luminance difference inside the component, 0..255. */
  readonly meanLumaDelta: number;
}

export interface PageVisualDiff {
  readonly status: VisualDiffStatus;
  readonly identical: boolean;
  readonly dimensionMismatch: boolean;
  readonly resampled: boolean;
  readonly beforeDimensions: ImageDimensions;
  readonly afterDimensions: ImageDimensions;
  readonly width: number;
  readonly height: number;
  readonly totalPixels: number;
  readonly maskedPixelCount: number;
  readonly comparedPixelCount: number;
  readonly changedPixelCount: number;
  readonly rawChangedPixelCount: number;
  readonly suppressedSpecklePixelCount: number;
  readonly changedPixelRatio: number;
  readonly ssim: number;
  readonly minWindowSsim: number;
  readonly changedRegions: readonly VisualChangedRegion[];
  readonly normalizedRegions: readonly Rect[];
}

export type PageImageCollection =
  | ReadonlyMap<number, RgbaImage>
  | Readonly<Record<number, RgbaImage>>
  | readonly RgbaImage[];

export type PageMaskCollection =
  | ReadonlyMap<number, readonly VisualMask[]>
  | Readonly<Record<number, readonly VisualMask[]>>;

export interface DocumentVersionInput {
  readonly document: DocumentIR;
  readonly pageImages?: PageImageCollection;
}

export interface DocumentVersionDiffOptions extends VisualDiffOptions {
  /** Per-page pixel exclusion masks merged with `exclusionMasks` for that page. */
  readonly pageMasks?: PageMaskCollection;
}

export type PageVisualStatus =
  | 'identical'
  | 'changed'
  | 'dimension-mismatch'
  | 'added'
  | 'removed'
  | 'unavailable';

export interface PageVisualComparison {
  readonly status: PageVisualStatus;
  readonly diff: PageVisualDiff | null;
  /** Changed regions mapped into PDF page points when page geometry exists, else pixel coordinates. */
  readonly pointRegions: readonly Rect[];
  readonly beforeDimensions: ImageDimensions | null;
  readonly afterDimensions: ImageDimensions | null;
}

export interface CorrelatedBlockVisualChange {
  readonly change: BlockDiff;
  readonly blockRects: readonly Rect[];
  readonly visualRegionIndices: readonly number[];
}

export type PageChangeCategory = 'unchanged' | 'text-only' | 'visual-only' | 'both';

export interface CombinedPageDiff {
  readonly page: number;
  readonly changeCategory: PageChangeCategory;
  readonly text: PageDiff;
  readonly visual: PageVisualComparison;
  readonly correlatedChanges: readonly CorrelatedBlockVisualChange[];
  readonly unlinkedVisualRegions: readonly Rect[];
}

export interface VisualDiffSummary {
  readonly pagesCompared: number;
  readonly pagesIdentical: number;
  readonly pagesVisuallyChanged: number;
  readonly pagesAdded: number;
  readonly pagesRemoved: number;
  readonly pagesDimensionMismatch: number;
  readonly pagesUnavailable: number;
  readonly totalChangedRegions: number;
  readonly totalChangedPixels: number;
  readonly meanSsim: number;
  readonly minSsim: number;
}

export interface CombinedDocumentDiff {
  readonly text: DocumentDiff;
  readonly pages: readonly CombinedPageDiff[];
  readonly summary: {
    readonly text: DiffSummary;
    readonly visual: VisualDiffSummary;
    readonly hasChanges: boolean;
  };
}

// --- Internal structures ----------------------------------------------------

interface NormalizedOptions {
  readonly intensityThreshold: number;
  readonly minComponentArea: number;
  readonly mergeDistance: number;
  readonly exclusionMasks: readonly VisualMask[];
  readonly ssimWindowSize: number;
  readonly ssimStride: number;
  readonly onDimensionMismatch: DimensionMismatchPolicy;
  readonly subpixelJitterRadius: 0 | 1;
}

interface RawComponent {
  x: number;
  y: number;
  width: number;
  height: number;
  pixelCount: number;
  sumDelta: number;
  maxDelta: number;
  sumLumaDelta: number;
}

interface PixelScanResult {
  readonly lumaBefore: Uint8Array;
  readonly lumaAfter: Uint8Array;
  readonly changedFlags: Uint8Array;
  readonly deltaMap: Uint8Array;
  readonly lumaDeltaMap: Uint8Array;
  readonly rawChangedPixelCount: number;
}

// --- Public functions -------------------------------------------------------

/**
 * Converts a PDF page-point rectangle into an integer-aligned pixel {@link VisualMask}
 * for a rendered raster of `imageSize`.
 */
export function pointsRectToPixelMask(
  rect: Rect,
  pageSize: ImageDimensions,
  imageSize: ImageDimensions,
  label?: string,
): VisualMask {
  if (
    !isValidPositiveFinite(pageSize.width) ||
    !isValidPositiveFinite(pageSize.height) ||
    !isValidPositiveFinite(imageSize.width) ||
    !isValidPositiveFinite(imageSize.height) ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    throw new VisualDiffError(
      'invalid-options',
      'pointsRectToPixelMask requires finite rect coordinates and positive page/image sizes.',
    );
  }

  const x0 = Math.floor((rect.x * imageSize.width) / pageSize.width + ROUND_EPSILON);
  const y0 = Math.floor((rect.y * imageSize.height) / pageSize.height + ROUND_EPSILON);
  const x1 = Math.ceil(((rect.x + rect.width) * imageSize.width) / pageSize.width - ROUND_EPSILON);
  const y1 = Math.ceil(((rect.y + rect.height) * imageSize.height) / pageSize.height - ROUND_EPSILON);

  return {
    x: x0,
    y: y0,
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0),
    ...(label !== undefined ? { label } : {}),
  };
}

/**
 * Compares two rendered RGBA page buffers using dynamic exclusion masks, local
 * luminance SSIM scoring, speckle/jitter suppression, and connected-component
 * bounding-box extraction.
 */
export function diffPageImages(
  before: RgbaImage,
  after: RgbaImage,
  options: VisualDiffOptions = {},
): PageVisualDiff {
  validateImage(before, 'before');
  validateImage(after, 'after');
  const opts = normalizeOptions(options);

  const beforeDimensions: ImageDimensions = { width: before.width, height: before.height };
  const afterDimensions: ImageDimensions = { width: after.width, height: after.height };
  const dimensionMismatch = before.width !== after.width || before.height !== after.height;

  if (dimensionMismatch && opts.onDimensionMismatch === 'throw') {
    throw new VisualDiffError(
      'dimension-mismatch',
      `Image dimensions differ: before is ${before.width}x${before.height}, after is ${after.width}x${after.height}.`,
    );
  }

  let effectiveAfter = after;
  let resampled = false;
  if (dimensionMismatch && opts.onDimensionMismatch === 'resample') {
    effectiveAfter = resampleImage(after, before.width, before.height);
    resampled = true;
  }

  const isReportMismatch = dimensionMismatch && opts.onDimensionMismatch === 'report';
  const width = isReportMismatch ? Math.max(before.width, after.width) : before.width;
  const height = isReportMismatch ? Math.max(before.height, after.height) : before.height;
  const totalPixels = width * height;

  const { mask, maskedPixelCount } = buildMaskGrid(width, height, opts.exclusionMasks);
  const comparedPixelCount = totalPixels - maskedPixelCount;

  const scan = scanPixels(before, effectiveAfter, width, height, mask, opts, isReportMismatch);
  const { components, suppressedSpecklePixelCount } = extractComponents(
    scan.changedFlags,
    scan.deltaMap,
    scan.lumaDeltaMap,
    width,
    height,
    scan.rawChangedPixelCount,
    opts.minComponentArea,
  );

  const merged = opts.mergeDistance > 0 ? mergeComponents(components, opts.mergeDistance) : components;
  const changedRegions = merged.map(toVisualChangedRegion).sort(compareVisualRegions);

  let changedPixelCount = 0;
  for (const region of changedRegions) changedPixelCount += region.pixelCount;

  const changedPixelRatio = comparedPixelCount > 0 ? changedPixelCount / comparedPixelCount : 0;
  const normalizedRegions = changedRegions.map(region => ({
    x: round4(region.rect.x / width),
    y: round4(region.rect.y / height),
    width: round4(region.rect.width / width),
    height: round4(region.rect.height / height),
  }));

  const ssimScores = isReportMismatch
    ? { ssim: 0, minWindowSsim: 0 }
    : computeSsim(
        scan.lumaBefore,
        scan.lumaAfter,
        mask,
        width,
        height,
        comparedPixelCount,
        opts.ssimWindowSize,
        opts.ssimStride,
      );

  const status: VisualDiffStatus = isReportMismatch
    ? 'dimension-mismatch'
    : changedRegions.length === 0 && changedPixelCount === 0
      ? 'identical'
      : 'changed';

  return {
    status,
    identical: status === 'identical',
    dimensionMismatch,
    resampled,
    beforeDimensions,
    afterDimensions,
    width,
    height,
    totalPixels,
    maskedPixelCount,
    comparedPixelCount,
    changedPixelCount,
    rawChangedPixelCount: scan.rawChangedPixelCount,
    suppressedSpecklePixelCount,
    changedPixelRatio,
    ssim: ssimScores.ssim,
    minWindowSsim: ssimScores.minWindowSsim,
    changedRegions,
    normalizedRegions,
  };
}

/**
 * Unifies text diffing from {@link diffDocuments} (`src/core/diff.ts`) with per-page
 * visual diffing from {@link diffPageImages}, mapping pixel coordinates to PDF page
 * points and linking changed text blocks to overlapping visual regions.
 */
export function diffDocumentVersions(
  before: DocumentVersionInput,
  after: DocumentVersionInput,
  options: DocumentVersionDiffOptions = {},
): CombinedDocumentDiff {
  const text = diffDocuments(before.document, after.document);
  const beforeImages = readImageMap(before.document, before.pageImages);
  const afterImages = readImageMap(after.document, after.pageImages);
  const beforePageSizes = readPageSizeMap(before.document);
  const afterPageSizes = readPageSizeMap(after.document);
  const beforeBlockRects = readBlockRectMap(before.document);
  const afterBlockRects = readBlockRectMap(after.document);
  const pageMasksMap = readPageMasksMap(options.pageMasks);

  const textPageMap = new Map<number, PageDiff>();
  const pageNumbers = new Set<number>();
  for (const page of text.pages) {
    textPageMap.set(page.page, page);
    pageNumbers.add(page.page);
  }
  for (const page of beforeImages.keys()) pageNumbers.add(page);
  for (const page of afterImages.keys()) pageNumbers.add(page);

  const sortedPageNumbers = [...pageNumbers].sort((a, b) => a - b);
  const globalMasks = options.exclusionMasks ?? [];

  const pages: CombinedPageDiff[] = sortedPageNumbers.map(pageNumber => {
    const beforeImg = beforeImages.get(pageNumber);
    const afterImg = afterImages.get(pageNumber);
    const textPage: PageDiff = textPageMap.get(pageNumber) ?? {
      page: pageNumber,
      status: fallbackPageStatus(beforeImg !== undefined, afterImg !== undefined),
      unchanged: 0,
      changes: [],
    };

    const pageMasks = pageMasksMap.get(pageNumber) ?? [];
    const combinedMasks = globalMasks.length > 0 || pageMasks.length > 0 ? [...globalMasks, ...pageMasks] : undefined;
    const visualOptions: VisualDiffOptions =
      combinedMasks !== undefined ? { ...options, exclusionMasks: combinedMasks } : options;

    const targetPageSize = afterPageSizes.get(pageNumber) ?? beforePageSizes.get(pageNumber);
    const visual = comparePageImages(beforeImg, afterImg, visualOptions, targetPageSize);
    const { correlatedChanges, unlinkedVisualRegions } = correlatePageChanges(
      textPage.changes,
      visual.pointRegions,
      beforeBlockRects,
      afterBlockRects,
    );

    const changeCategory = classifyPageChange(textPage.changes.length > 0, visual.status);

    return {
      page: pageNumber,
      changeCategory,
      text: textPage,
      visual,
      correlatedChanges,
      unlinkedVisualRegions,
    };
  });

  const visualSummary = summarizeVisualPages(pages);
  const hasTextChanges =
    text.summary.added > 0 ||
    text.summary.removed > 0 ||
    text.summary.changed > 0 ||
    text.summary.moved > 0;
  const hasVisualChanges =
    visualSummary.pagesVisuallyChanged > 0 ||
    visualSummary.pagesAdded > 0 ||
    visualSummary.pagesRemoved > 0 ||
    visualSummary.pagesDimensionMismatch > 0;

  return {
    text,
    pages,
    summary: {
      text: text.summary,
      visual: visualSummary,
      hasChanges: hasTextChanges || hasVisualChanges,
    },
  };
}

// --- Validation and option normalization -----------------------------------

function validateImage(image: RgbaImage, role: string): void {
  if (!image || typeof image !== 'object' || !image.data) {
    throw new VisualDiffError('invalid-image', `The ${role} image requires RGBA data, width, and height.`);
  }
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) {
    throw new VisualDiffError(
      'invalid-image',
      `The ${role} image requires positive integer width and height, got ${image.width}x${image.height}.`,
    );
  }
  const requiredBytes = image.width * image.height * 4;
  if (image.data.length < requiredBytes) {
    throw new VisualDiffError(
      'short-buffer',
      `The ${role} ${image.width}x${image.height} image needs ${requiredBytes} RGBA bytes, got ${image.data.length}.`,
    );
  }
}

function normalizeOptions(options: VisualDiffOptions): NormalizedOptions {
  const intensityThreshold = options.intensityThreshold ?? DEFAULT_INTENSITY_THRESHOLD;
  if (!Number.isFinite(intensityThreshold) || intensityThreshold < 0 || intensityThreshold > 255) {
    throw new VisualDiffError(
      'invalid-options',
      `intensityThreshold must be within 0..255, got ${intensityThreshold}.`,
    );
  }

  const minComponentArea = options.minComponentArea ?? DEFAULT_MIN_COMPONENT_AREA;
  if (!Number.isInteger(minComponentArea) || minComponentArea < 1) {
    throw new VisualDiffError(
      'invalid-options',
      `minComponentArea must be an integer >= 1, got ${minComponentArea}.`,
    );
  }

  const mergeDistance = options.mergeDistance ?? 0;
  if (!Number.isFinite(mergeDistance) || mergeDistance < 0) {
    throw new VisualDiffError(
      'invalid-options',
      `mergeDistance must be a finite number >= 0, got ${mergeDistance}.`,
    );
  }

  const ssimWindowSize = options.ssimWindowSize ?? DEFAULT_SSIM_WINDOW_SIZE;
  if (!Number.isInteger(ssimWindowSize) || ssimWindowSize < 1) {
    throw new VisualDiffError(
      'invalid-options',
      `ssimWindowSize must be an integer >= 1, got ${ssimWindowSize}.`,
    );
  }

  const ssimStride = options.ssimStride ?? DEFAULT_SSIM_STRIDE;
  if (!Number.isInteger(ssimStride) || ssimStride < 1) {
    throw new VisualDiffError(
      'invalid-options',
      `ssimStride must be an integer >= 1, got ${ssimStride}.`,
    );
  }

  const subpixelJitterRadius = options.subpixelJitterRadius ?? 0;
  if (subpixelJitterRadius !== 0 && subpixelJitterRadius !== 1) {
    throw new VisualDiffError(
      'invalid-options',
      `subpixelJitterRadius must be 0 or 1, got ${String(subpixelJitterRadius)}.`,
    );
  }

  const onDimensionMismatch = options.onDimensionMismatch ?? 'report';
  if (
    onDimensionMismatch !== 'report' &&
    onDimensionMismatch !== 'throw' &&
    onDimensionMismatch !== 'resample'
  ) {
    throw new VisualDiffError(
      'invalid-options',
      `Unknown onDimensionMismatch policy: ${String(onDimensionMismatch)}.`,
    );
  }

  return {
    intensityThreshold,
    minComponentArea,
    mergeDistance,
    exclusionMasks: options.exclusionMasks ?? [],
    ssimWindowSize,
    ssimStride,
    onDimensionMismatch,
    subpixelJitterRadius,
  };
}

// --- Pixel scanning, resampling, and masking -------------------------------

/** Rec.601 integer-rounded luma composited over white paper for partial alpha (matches `preprocess.ts` when opaque). */
function lumaRgbaOf(r: number, g: number, b: number, a: number): number {
  if (a >= 255) return Math.round((299 * r + 587 * g + 114 * b) / 1000);
  const inv = 255 - a;
  const cr = (r * a + 255 * inv) / 255;
  const cg = (g * a + 255 * inv) / 255;
  const cb = (b * a + 255 * inv) / 255;
  return Math.round((299 * cr + 587 * cg + 114 * cb) / 1000);
}

function buildMaskGrid(
  width: number,
  height: number,
  masks: readonly VisualMask[],
): { readonly mask: Uint8Array; readonly maskedPixelCount: number } {
  const mask = new Uint8Array(width * height);
  for (const rect of masks) {
    if (
      !Number.isFinite(rect.x) ||
      !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      continue;
    }
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
    for (let y = y0; y < y1; y += 1) {
      const rowOffset = y * width;
      for (let x = x0; x < x1; x += 1) {
        mask[rowOffset + x] = 1;
      }
    }
  }

  let maskedPixelCount = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] === 1) maskedPixelCount += 1;
  }
  return { mask, maskedPixelCount };
}

function resampleImage(source: RgbaImage, dstWidth: number, dstHeight: number): RgbaImage {
  const dstData = new Uint8ClampedArray(dstWidth * dstHeight * 4);
  const srcW = source.width;
  const srcH = source.height;
  const srcData = source.data;

  for (let dy = 0; dy < dstHeight; dy += 1) {
    const syRaw = ((dy + 0.5) * srcH) / dstHeight - 0.5;
    const sy = Math.max(0, Math.min(srcH - 1, syRaw));
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = sy - y0;

    for (let dx = 0; dx < dstWidth; dx += 1) {
      const sxRaw = ((dx + 0.5) * srcW) / dstWidth - 0.5;
      const sx = Math.max(0, Math.min(srcW - 1, sxRaw));
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = sx - x0;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      const dstIdx = (dy * dstWidth + dx) * 4;

      for (let c = 0; c < 4; c += 1) {
        const value =
          (srcData[i00 + c] ?? 0) * w00 +
          (srcData[i10 + c] ?? 0) * w10 +
          (srcData[i01 + c] ?? 0) * w01 +
          (srcData[i11 + c] ?? 0) * w11;
        dstData[dstIdx + c] = Math.round(value);
      }
    }
  }

  return { data: dstData, width: dstWidth, height: dstHeight };
}

function scanPixels(
  before: RgbaImage,
  after: RgbaImage,
  width: number,
  height: number,
  mask: Uint8Array,
  opts: NormalizedOptions,
  isReportMismatch: boolean,
): PixelScanResult {
  const total = width * height;
  const lumaBefore = new Uint8Array(isReportMismatch ? 0 : total);
  const lumaAfter = new Uint8Array(isReportMismatch ? 0 : total);
  const changedFlags = new Uint8Array(total);
  const deltaMap = new Uint8Array(total);
  const lumaDeltaMap = new Uint8Array(total);
  const jitterBoundsW = Math.min(before.width, after.width);
  const jitterBoundsH = Math.min(before.height, after.height);

  let rawChangedPixelCount = 0;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const idx = row + x;
      const inBefore = x < before.width && y < before.height;
      const inAfter = x < after.width && y < after.height;

      if (isReportMismatch && (!inBefore || !inAfter)) {
        if (mask[idx] === 1) continue;
        changedFlags[idx] = 1;
        deltaMap[idx] = 255;
        lumaDeltaMap[idx] = 255;
        rawChangedPixelCount += 1;
        continue;
      }

      const bOff = (y * before.width + x) * 4;
      const aOff = (y * after.width + x) * 4;
      const r1 = before.data[bOff] ?? 0;
      const g1 = before.data[bOff + 1] ?? 0;
      const b1 = before.data[bOff + 2] ?? 0;
      const a1 = before.data[bOff + 3] ?? 0;

      const r2 = after.data[aOff] ?? 0;
      const g2 = after.data[aOff + 1] ?? 0;
      const b2 = after.data[aOff + 2] ?? 0;
      const a2 = after.data[aOff + 3] ?? 0;

      const l1 = lumaRgbaOf(r1, g1, b1, a1);
      const l2 = lumaRgbaOf(r2, g2, b2, a2);
      if (!isReportMismatch) {
        lumaBefore[idx] = l1;
        lumaAfter[idx] = l2;
      }

      if (mask[idx] === 1) continue;

      const maxDiff = Math.max(
        Math.abs(r1 - r2),
        Math.abs(g1 - g2),
        Math.abs(b1 - b2),
        Math.abs(a1 - a2),
      );
      if (maxDiff <= opts.intensityThreshold) continue;
      if (
        opts.subpixelJitterRadius === 1 &&
        isBidirectionalNeighborMatch(
          before,
          after,
          mask,
          width,
          jitterBoundsW,
          jitterBoundsH,
          x,
          y,
          opts.intensityThreshold,
        )
      ) {
        continue;
      }

      changedFlags[idx] = 1;
      deltaMap[idx] = maxDiff;
      lumaDeltaMap[idx] = Math.abs(l1 - l2);
      rawChangedPixelCount += 1;
    }
  }

  return {
    lumaBefore,
    lumaAfter,
    changedFlags,
    deltaMap,
    lumaDeltaMap,
    rawChangedPixelCount,
  };
}

/**
 * Bidirectional 3x3 Hausdorff pixel tolerance: returns true only when `after(x, y)`
 * matches an unmasked 3x3 neighbor in `before` AND `before(x, y)` matches an unmasked
 * 3x3 neighbor in `after`. Suppresses 1-pixel edge alignment jitter without hiding
 * newly inserted or deleted ink strokes.
 */
function isBidirectionalNeighborMatch(
  before: RgbaImage,
  after: RgbaImage,
  mask: Uint8Array,
  maskWidth: number,
  boundW: number,
  boundH: number,
  x: number,
  y: number,
  threshold: number,
): boolean {
  const bCenter = (y * before.width + x) * 4;
  const aCenter = (y * after.width + x) * 4;

  return (
    hasMatchingNeighbor(after, aCenter, before, mask, maskWidth, boundW, boundH, x, y, threshold) &&
    hasMatchingNeighbor(before, bCenter, after, mask, maskWidth, boundW, boundH, x, y, threshold)
  );
}

function hasMatchingNeighbor(
  source: RgbaImage,
  sourceOffset: number,
  target: RgbaImage,
  mask: Uint8Array,
  maskWidth: number,
  boundW: number,
  boundH: number,
  x: number,
  y: number,
  threshold: number,
): boolean {
  const sr = source.data[sourceOffset] ?? 0;
  const sg = source.data[sourceOffset + 1] ?? 0;
  const sb = source.data[sourceOffset + 2] ?? 0;
  const sa = source.data[sourceOffset + 3] ?? 0;

  const yMin = Math.max(0, y - 1);
  const yMax = Math.min(boundH - 1, y + 1);
  const xMin = Math.max(0, x - 1);
  const xMax = Math.min(boundW - 1, x + 1);

  for (let ny = yMin; ny <= yMax; ny += 1) {
    for (let nx = xMin; nx <= xMax; nx += 1) {
      if (mask[ny * maskWidth + nx] === 1) continue;
      const tOff = (ny * target.width + nx) * 4;
      const diff = Math.max(
        Math.abs(sr - (target.data[tOff] ?? 0)),
        Math.abs(sg - (target.data[tOff + 1] ?? 0)),
        Math.abs(sb - (target.data[tOff + 2] ?? 0)),
        Math.abs(sa - (target.data[tOff + 3] ?? 0)),
      );
      if (diff <= threshold) return true;
    }
  }
  return false;
}

// --- Connected components and region merging --------------------------------

const NEIGHBOR_DX = [-1, 0, 1, -1, 1, -1, 0, 1] as const;
const NEIGHBOR_DY = [-1, -1, -1, 0, 0, 1, 1, 1] as const;

function extractComponents(
  changedFlags: Uint8Array,
  deltaMap: Uint8Array,
  lumaDeltaMap: Uint8Array,
  width: number,
  height: number,
  rawChangedPixelCount: number,
  minComponentArea: number,
): { readonly components: RawComponent[]; readonly suppressedSpecklePixelCount: number } {
  if (rawChangedPixelCount === 0) {
    return { components: [], suppressedSpecklePixelCount: 0 };
  }

  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(rawChangedPixelCount);
  const components: RawComponent[] = [];
  let suppressedSpecklePixelCount = 0;

  for (let startIdx = 0; startIdx < total; startIdx += 1) {
    if (changedFlags[startIdx] !== 1 || visited[startIdx] === 1) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = startIdx;
    visited[startIdx] = 1;

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let pixelCount = 0;
    let sumDelta = 0;
    let maxDelta = 0;
    let sumLumaDelta = 0;

    while (head < tail) {
      const idx = queue[head++] ?? 0;
      const px = idx % width;
      const py = (idx - px) / width;

      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;

      const delta = deltaMap[idx] ?? 0;
      const lumaDelta = lumaDeltaMap[idx] ?? 0;
      pixelCount += 1;
      sumDelta += delta;
      if (delta > maxDelta) maxDelta = delta;
      sumLumaDelta += lumaDelta;

      for (let d = 0; d < 8; d += 1) {
        const nx = px + (NEIGHBOR_DX[d] ?? 0);
        const ny = py + (NEIGHBOR_DY[d] ?? 0);
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (changedFlags[nIdx] === 1 && visited[nIdx] !== 1) {
          visited[nIdx] = 1;
          queue[tail++] = nIdx;
        }
      }
    }

    if (pixelCount < minComponentArea) {
      suppressedSpecklePixelCount += pixelCount;
      continue;
    }

    components.push({
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      pixelCount,
      sumDelta,
      maxDelta,
      sumLumaDelta,
    });
  }

  return { components, suppressedSpecklePixelCount };
}

function mergeComponents(components: readonly RawComponent[], mergeDistance: number): RawComponent[] {
  const count = components.length;
  if (count <= 1) return [...components];

  const parent = new Int32Array(count);
  for (let i = 0; i < count; i += 1) parent[i] = i;

  const find = (index: number): number => {
    let cur = index;
    while ((parent[cur] ?? cur) !== cur) {
      const next = parent[cur] ?? cur;
      parent[cur] = parent[next] ?? next;
      cur = next;
    }
    return cur;
  };

  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };

  for (let i = 0; i < count; i += 1) {
    const compA = components[i];
    if (!compA) continue;
    for (let j = i + 1; j < count; j += 1) {
      const compB = components[j];
      if (!compB) continue;
      if (boxGap(compA, compB) <= mergeDistance) union(i, j);
    }
  }

  const groups = new Map<number, RawComponent>();
  for (let i = 0; i < count; i += 1) {
    const comp = components[i];
    if (!comp) continue;
    const root = find(i);
    const existing = groups.get(root);
    if (!existing) {
      groups.set(root, { ...comp });
      continue;
    }
    const minX = Math.min(existing.x, comp.x);
    const minY = Math.min(existing.y, comp.y);
    const maxX = Math.max(existing.x + existing.width, comp.x + comp.width);
    const maxY = Math.max(existing.y + existing.height, comp.y + comp.height);
    existing.x = minX;
    existing.y = minY;
    existing.width = maxX - minX;
    existing.height = maxY - minY;
    existing.pixelCount += comp.pixelCount;
    existing.sumDelta += comp.sumDelta;
    existing.maxDelta = Math.max(existing.maxDelta, comp.maxDelta);
    existing.sumLumaDelta += comp.sumLumaDelta;
  }

  return [...groups.values()];
}

function boxGap(a: Rect, b: Rect): number {
  const gapX = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const gapY = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return Math.max(gapX, gapY);
}

function toVisualChangedRegion(component: RawComponent): VisualChangedRegion {
  const area = component.width * component.height;
  return {
    rect: {
      x: component.x,
      y: component.y,
      width: component.width,
      height: component.height,
    },
    pixelCount: component.pixelCount,
    fillRatio: area > 0 ? round4(component.pixelCount / area) : 0,
    meanDelta: round4(component.sumDelta / component.pixelCount),
    maxDelta: component.maxDelta,
    meanLumaDelta: round4(component.sumLumaDelta / component.pixelCount),
  };
}

function compareVisualRegions(left: VisualChangedRegion, right: VisualChangedRegion): number {
  if (left.rect.y !== right.rect.y) return left.rect.y - right.rect.y;
  if (left.rect.x !== right.rect.x) return left.rect.x - right.rect.x;
  if (left.rect.height !== right.rect.height) return left.rect.height - right.rect.height;
  return left.rect.width - right.rect.width;
}

// --- SSIM window scoring ----------------------------------------------------

function windowPositions(limit: number, windowSize: number, stride: number): number[] {
  if (limit <= windowSize) return [0];
  const positions: number[] = [];
  const maxStart = limit - windowSize;
  for (let pos = 0; pos < maxStart; pos += stride) positions.push(pos);
  positions.push(maxStart);
  return positions;
}

function computeSsim(
  lumaBefore: Uint8Array,
  lumaAfter: Uint8Array,
  mask: Uint8Array,
  width: number,
  height: number,
  comparedPixelCount: number,
  requestedWindowSize: number,
  stride: number,
): { readonly ssim: number; readonly minWindowSsim: number } {
  if (comparedPixelCount === 0) return { ssim: 1, minWindowSsim: 1 };

  const winW = Math.min(requestedWindowSize, width);
  const winH = Math.min(requestedWindowSize, height);
  const xs = windowPositions(width, winW, stride);
  const ys = windowPositions(height, winH, stride);

  let sumSsim = 0;
  let minSsim = 1;
  let evaluatedWindows = 0;

  for (const wy of ys) {
    for (const wx of xs) {
      let n = 0;
      let sumX = 0;
      let sumY = 0;
      let allEqual = true;

      for (let dy = 0; dy < winH; dy += 1) {
        const row = (wy + dy) * width + wx;
        for (let dx = 0; dx < winW; dx += 1) {
          const idx = row + dx;
          if (mask[idx] === 1) continue;
          const xVal = lumaBefore[idx] ?? 0;
          const yVal = lumaAfter[idx] ?? 0;
          if (xVal !== yVal) allEqual = false;
          sumX += xVal;
          sumY += yVal;
          n += 1;
        }
      }

      if (n === 0) continue;

      let windowSsim = 1;
      if (!allEqual) {
        const muX = sumX / n;
        const muY = sumY / n;
        let varXSum = 0;
        let varYSum = 0;
        let covSum = 0;

        for (let dy = 0; dy < winH; dy += 1) {
          const row = (wy + dy) * width + wx;
          for (let dx = 0; dx < winW; dx += 1) {
            const idx = row + dx;
            if (mask[idx] === 1) continue;
            const dxVal = (lumaBefore[idx] ?? 0) - muX;
            const dyVal = (lumaAfter[idx] ?? 0) - muY;
            varXSum += dxVal * dxVal;
            varYSum += dyVal * dyVal;
            covSum += dxVal * dyVal;
          }
        }

        const varX = varXSum / n;
        const varY = varYSum / n;
        const covXY = covSum / n;
        const numerator = (2 * muX * muY + SSIM_C1) * (2 * covXY + SSIM_C2);
        const denominator = (muX * muX + muY * muY + SSIM_C1) * (varX + varY + SSIM_C2);
        windowSsim = denominator > 0 ? clamp(numerator / denominator, -1, 1) : 1;
      }

      sumSsim += windowSsim;
      if (windowSsim < minSsim) minSsim = windowSsim;
      evaluatedWindows += 1;
    }
  }

  if (evaluatedWindows === 0) return { ssim: 1, minWindowSsim: 1 };
  return {
    ssim: clamp(sumSsim / evaluatedWindows, -1, 1),
    minWindowSsim: minSsim,
  };
}

// --- Unified document diff helpers -----------------------------------------

function readImageMap(doc: DocumentIR, collection: PageImageCollection | undefined): Map<number, RgbaImage> {
  const map = new Map<number, RgbaImage>();
  if (!collection) return map;

  if (collection instanceof Map) {
    for (const [page, img] of collection.entries()) {
      if (Number.isInteger(page) && page > 0) map.set(page, img);
    }
    return map;
  }

  if (Array.isArray(collection)) {
    const pages = Array.isArray(doc?.pages) ? doc.pages : [];
    collection.forEach((img, index) => {
      const pageIndex = pages[index]?.index;
      const page = typeof pageIndex === 'number' && Number.isInteger(pageIndex) && pageIndex > 0
        ? pageIndex
        : index + 1;
      map.set(page, img);
    });
    return map;
  }

  const record = collection as Readonly<Record<string, RgbaImage>>;
  for (const key of Object.keys(record)) {
    const page = Number(key);
    const img = record[key];
    if (Number.isInteger(page) && page > 0 && img) map.set(page, img);
  }
  return map;
}

function readPageMasksMap(collection: PageMaskCollection | undefined): Map<number, readonly VisualMask[]> {
  const map = new Map<number, readonly VisualMask[]>();
  if (!collection) return map;

  if (collection instanceof Map) {
    for (const [page, masks] of collection.entries()) {
      if (Number.isInteger(page) && page > 0) map.set(page, masks);
    }
    return map;
  }

  const record = collection as Readonly<Record<string, readonly VisualMask[]>>;
  for (const key of Object.keys(record)) {
    const page = Number(key);
    const masks = record[key];
    if (Number.isInteger(page) && page > 0 && Array.isArray(masks)) map.set(page, masks);
  }
  return map;
}

function readPageSizeMap(doc: DocumentIR): Map<number, ImageDimensions> {
  const map = new Map<number, ImageDimensions>();
  const pages = Array.isArray(doc?.pages) ? doc.pages : [];
  for (const page of pages) {
    if (!page || typeof page !== 'object') continue;
    if (
      Number.isInteger(page.index) &&
      page.index > 0 &&
      isValidPositiveFinite(page.width) &&
      isValidPositiveFinite(page.height)
    ) {
      map.set(page.index, { width: page.width, height: page.height });
    }
  }
  return map;
}

function readBlockRectMap(doc: DocumentIR): Map<string, Rect> {
  const map = new Map<string, Rect>();
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || typeof block.id !== 'string' || map.has(block.id)) continue;
    const rect = polygonToRect(block.polygon);
    if (rect) map.set(block.id, rect);
  }
  return map;
}

function polygonToRect(polygon: readonly Point[] | undefined): Rect | null {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of polygon) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

function comparePageImages(
  beforeImg: RgbaImage | undefined,
  afterImg: RgbaImage | undefined,
  options: VisualDiffOptions,
  targetPageSize: ImageDimensions | undefined,
): PageVisualComparison {
  if (beforeImg && afterImg) {
    const diff = diffPageImages(beforeImg, afterImg, options);
    const pointRegions = diff.changedRegions.map(region =>
      scalePixelRectToPoints(region.rect, diff.width, diff.height, targetPageSize),
    );
    return {
      status: diff.status,
      diff,
      pointRegions,
      beforeDimensions: diff.beforeDimensions,
      afterDimensions: diff.afterDimensions,
    };
  }

  if (!beforeImg && afterImg) {
    validateImage(afterImg, 'after');
    return {
      status: 'added',
      diff: null,
      pointRegions: [],
      beforeDimensions: null,
      afterDimensions: { width: afterImg.width, height: afterImg.height },
    };
  }

  if (beforeImg && !afterImg) {
    validateImage(beforeImg, 'before');
    return {
      status: 'removed',
      diff: null,
      pointRegions: [],
      beforeDimensions: { width: beforeImg.width, height: beforeImg.height },
      afterDimensions: null,
    };
  }

  return {
    status: 'unavailable',
    diff: null,
    pointRegions: [],
    beforeDimensions: null,
    afterDimensions: null,
  };
}

function scalePixelRectToPoints(
  rect: Rect,
  imageWidth: number,
  imageHeight: number,
  pageSize: ImageDimensions | undefined,
): Rect {
  if (!pageSize || imageWidth <= 0 || imageHeight <= 0) return { ...rect };
  return {
    x: round4((rect.x * pageSize.width) / imageWidth),
    y: round4((rect.y * pageSize.height) / imageHeight),
    width: round4((rect.width * pageSize.width) / imageWidth),
    height: round4((rect.height * pageSize.height) / imageHeight),
  };
}

function correlatePageChanges(
  changes: readonly BlockDiff[],
  pointRegions: readonly Rect[],
  beforeBlockRects: ReadonlyMap<string, Rect>,
  afterBlockRects: ReadonlyMap<string, Rect>,
): {
  readonly correlatedChanges: CorrelatedBlockVisualChange[];
  readonly unlinkedVisualRegions: Rect[];
} {
  const linkedIndices = new Set<number>();
  const correlatedChanges: CorrelatedBlockVisualChange[] = [];

  for (const change of changes) {
    const blockRects = rectsForChange(change, beforeBlockRects, afterBlockRects);
    const visualRegionIndices: number[] = [];

    for (let i = 0; i < pointRegions.length; i += 1) {
      const region = pointRegions[i];
      if (!region) continue;
      if (blockRects.some(blockRect => rectsIntersect(blockRect, region))) {
        visualRegionIndices.push(i);
        linkedIndices.add(i);
      }
    }

    correlatedChanges.push({
      change,
      blockRects,
      visualRegionIndices,
    });
  }

  const unlinkedVisualRegions: Rect[] = [];
  for (let i = 0; i < pointRegions.length; i += 1) {
    const region = pointRegions[i];
    if (region && !linkedIndices.has(i)) unlinkedVisualRegions.push(region);
  }

  return { correlatedChanges, unlinkedVisualRegions };
}

function rectsForChange(
  change: BlockDiff,
  beforeBlockRects: ReadonlyMap<string, Rect>,
  afterBlockRects: ReadonlyMap<string, Rect>,
): Rect[] {
  const rects: Rect[] = [];
  if (change.kind === 'added' || change.kind === 'moved') {
    const rect = afterBlockRects.get(change.afterBlockId);
    if (rect) rects.push(rect);
    return rects;
  }
  if (change.kind === 'removed') {
    const rect = beforeBlockRects.get(change.beforeBlockId);
    if (rect) rects.push(rect);
    return rects;
  }
  const beforeRect = beforeBlockRects.get(change.beforeBlockId);
  const afterRect = afterBlockRects.get(change.afterBlockId);
  if (beforeRect) rects.push(beforeRect);
  if (afterRect) rects.push(afterRect);
  return rects;
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function classifyPageChange(hasTextChanges: boolean, visualStatus: PageVisualStatus): PageChangeCategory {
  const hasVisualChanges =
    visualStatus === 'changed' ||
    visualStatus === 'added' ||
    visualStatus === 'removed' ||
    visualStatus === 'dimension-mismatch';

  if (hasTextChanges && hasVisualChanges) return 'both';
  if (hasTextChanges) return 'text-only';
  if (hasVisualChanges) return 'visual-only';
  return 'unchanged';
}

function fallbackPageStatus(inBefore: boolean, inAfter: boolean): PageDiffStatus {
  if (inBefore && inAfter) return 'both';
  return inBefore ? 'removed' : 'added';
}

function summarizeVisualPages(pages: readonly CombinedPageDiff[]): VisualDiffSummary {
  let pagesCompared = 0;
  let pagesIdentical = 0;
  let pagesVisuallyChanged = 0;
  let pagesAdded = 0;
  let pagesRemoved = 0;
  let pagesDimensionMismatch = 0;
  let pagesUnavailable = 0;
  let totalChangedRegions = 0;
  let totalChangedPixels = 0;
  let ssimSum = 0;
  let minSsim = 1;

  for (const page of pages) {
    const { status, diff } = page.visual;
    switch (status) {
      case 'identical':
        pagesCompared += 1;
        pagesIdentical += 1;
        break;
      case 'changed':
        pagesCompared += 1;
        pagesVisuallyChanged += 1;
        break;
      case 'dimension-mismatch':
        pagesCompared += 1;
        pagesDimensionMismatch += 1;
        break;
      case 'added':
        pagesAdded += 1;
        break;
      case 'removed':
        pagesRemoved += 1;
        break;
      case 'unavailable':
        pagesUnavailable += 1;
        break;
    }

    if (diff) {
      totalChangedRegions += diff.changedRegions.length;
      totalChangedPixels += diff.changedPixelCount;
      ssimSum += diff.ssim;
      if (diff.ssim < minSsim) minSsim = diff.ssim;
    }
  }

  return {
    pagesCompared,
    pagesIdentical,
    pagesVisuallyChanged,
    pagesAdded,
    pagesRemoved,
    pagesDimensionMismatch,
    pagesUnavailable,
    totalChangedRegions,
    totalChangedPixels,
    meanSsim: pagesCompared > 0 ? ssimSum / pagesCompared : 1,
    minSsim: pagesCompared > 0 ? minSsim : 1,
  };
}

// --- Small utilities --------------------------------------------------------

function isValidPositiveFinite(value: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
