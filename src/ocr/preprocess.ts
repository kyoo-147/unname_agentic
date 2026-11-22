import { planDeskew, invertMap, type Matrix2D } from '../core/deskew';
import { planPreprocess, sampleStats, type PreprocessStepKind } from '../core/preprocess';
/**
 * Image-level preprocessing for screenshot OCR.
 *
 * A capture reaches the engine as raw RGBA pixels, but OCR wants dark glyphs on
 * a light page at a readable size. Dark or inverted UI, a low-contrast scan and
 * tiny text all cost accuracy before the engine ever runs, so this module fixes
 * those three at pixel level.
 *
 * It is deliberately DOM-free: every function takes and returns the
 * ImageData-shaped subset it needs, which keeps it runnable in a worker and in
 * unit tests. Alpha is carried through but never drives a decision, because
 * screenshots are opaque.
 *
 * The heuristics assume the page background covers more pixels than the glyphs,
 * which holds for document captures but not for full-bleed artwork.
 */

export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface NormalizeOptions {
  /** Share of pixels ignored at each end of the luminance histogram (0..0.49). */
  percentile?: number;
  /** Glyph height in pixels below which the capture is upscaled. */
  minGlyphHeight?: number;
  /** Largest integer upscale factor considered; clamped to 1..3. */
  maxScale?: number;
  /** Largest contrast multiplier, so a near-uniform capture cannot amplify noise. */
  maxGain?: number;
}

export interface NormalizeReport {
  inverted: boolean;
  contrastGain: number;
  scale: number;
}

export interface NormalizeResult {
  image: RgbaImage;
  report: NormalizeReport;
  transform?: OcrCoordinateTransform;
  steps?: readonly PreprocessStepKind[];
  dewarp?: DewarpProvenance;
}

export interface OcrCoordinateTransform {
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  sourceToOutput: Matrix2D;
  outputToSource: Matrix2D;
}

export type DewarpErrorCode = 'invalid-image' | 'invalid-angle' | 'unsupported-angle' | 'pixel-budget';

export class DewarpError extends Error {
  readonly code: DewarpErrorCode;

  constructor(code: DewarpErrorCode, message: string) {
    super(message);
    this.name = 'DewarpError';
    this.code = code;
  }
}

export interface DewarpOptions {
  /** Refuse a dewarped raster larger than this many pixels. */
  maxPixels?: number;
  /** Maximum measured skew accepted as a rotation-only correction. */
  maxAngleDeg?: number;
}

export interface DewarpProvenance {
  status: 'not-needed' | 'applied' | 'unknown';
  measuredSkewDeg: number;
  correctionDeg: number;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  mappedBackToSource: boolean;
  reason?: string;
}

export interface DewarpResult {
  image: RgbaImage;
  transform: OcrCoordinateTransform;
  provenance: DewarpProvenance;
}

/** Default histogram trim: enough to drop sensor specks and JPEG ringing. */
export const DEFAULT_PERCENTILE = 0.02;
/** Line boxes thinner than this are where OCR starts confusing glyphs. */
export const DEFAULT_MIN_GLYPH_HEIGHT = 18;
/** Text above this is crisp enough already; more pixels only cost memory. */
export const MAX_SCALE = 3;
export const DEFAULT_MAX_GAIN = 4;
/** Output cap, so a 4K screenshot at 3x cannot exhaust the tab. */
export const MAX_SCALED_PIXELS = 10_000_000;

/** Median at or above this reads as dark glyphs on a light page. */
const DARK_MEDIAN = 128;
/** Distance from the median before a pixel counts as the other population. */
const INK_MARGIN = 24;
/** A dark capture needs this share of bright pixels before flipping is useful. */
const MIN_INK_FRACTION = 0.005;
/** Share of a row that must be ink before the row joins a text band. */
const MIN_BAND_COVERAGE = 0.02;

interface Dimensions {
  width: number;
  height: number;
  pixels: number;
}

interface Bounds {
  low: number;
  high: number;
}

interface StretchPlan {
  width: number;
  height: number;
  scale: number;
  low: number;
  gain: number;
  inverted: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function numberOption(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function identityTransform(width: number, height: number): OcrCoordinateTransform {
  const matrix: Matrix2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return {
    sourceWidth: width,
    sourceHeight: height,
    outputWidth: width,
    outputHeight: height,
    sourceToOutput: matrix,
    outputToSource: matrix,
  };
}
function emptyImage(): RgbaImage {
  return { data: new Uint8ClampedArray(0), width: 0, height: 0 };
}

function dimensionsOf(image: RgbaImage): Dimensions | undefined {
  if (!image || typeof image !== 'object' || !image.data) return undefined;
  const width = Math.floor(image.width);
  const height = Math.floor(image.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  const pixels = width * height;
  if (image.data.length < pixels * 4) return undefined;
  return { width, height, pixels };
}

function strictDimensionsOf(image: RgbaImage): Dimensions {
  if (!image || typeof image !== 'object' || !(image.data instanceof Uint8ClampedArray)) {
    throw new DewarpError('invalid-image', 'dewarpForOcr needs RGBA pixel data.');
  }
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) {
    throw new DewarpError('invalid-image', `dewarpForOcr needs positive integer dimensions, got ${image.width}x${image.height}.`);
  }
  const pixels = image.width * image.height;
  if (image.data.length !== pixels * 4) {
    throw new DewarpError('invalid-image', `dewarpForOcr needs exactly ${pixels * 4} RGBA bytes, got ${image.data.length}.`);
  }
  return { width: image.width, height: image.height, pixels };
}

function medianOf(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : ((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function luma(red: number, green: number, blue: number): number {
  // Rec.601 weights in integers, so the result is bit-identical everywhere.
  return Math.round((299 * red + 587 * green + 114 * blue) / 1000);
}

/** One plane per call; the hot loops below read it instead of redoing RGB math. */
function luminancePlane(image: RgbaImage, pixels: number): Uint8Array {
  const plane = new Uint8Array(pixels);
  const data = image.data;
  for (let index = 0, offset = 0; index < pixels; index++, offset += 4) {
    plane[index] = luma(data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0);
  }
  return plane;
}

function histogramOf(plane: Uint8Array): Uint32Array {
  const histogram = new Uint32Array(256);
  for (let index = 0; index < plane.length; index++) {
    const value = plane[index] ?? 0;
    histogram[value] = (histogram[value] ?? 0) + 1;
  }
  return histogram;
}

function medianFromHistogram(histogram: Uint32Array, total: number): number {
  if (total <= 0) return 0;
  const half = total / 2;
  let seen = 0;
  for (let value = 0; value < 256; value++) {
    seen += histogram[value] ?? 0;
    if (seen > half) return value;
  }
  return 255;
}

function isInvertedPlane(histogram: Uint32Array, total: number, median: number): boolean {
  if (total <= 0 || median >= DARK_MEDIAN) return false;
  // Dark background dominating the frame only means "inverted" when bright ink
  // exists; an all-dark frame (blank tab, open menu) must stay untouched.
  const minimum = Math.max(1, Math.round(total * MIN_INK_FRACTION));
  let bright = 0;
  for (let value = Math.min(255, median + INK_MARGIN); value < 256; value++) {
    bright += histogram[value] ?? 0;
  }
  return bright >= minimum;
}

function percentileBounds(histogram: Uint32Array, total: number, percentile: number, median: number): Bounds {
  // Trim equal tails, but never more than half of either side of the median: a
  // sparse capture can hold fewer ink pixels than the percentile would eat.
  let below = 0;
  for (let value = 0; value < median; value++) below += histogram[value] ?? 0;
  const fraction = clamp(numberOption(percentile, DEFAULT_PERCENTILE), 0, 0.49);
  const trim = Math.max(0, Math.min(
    Math.floor(total * fraction),
    Math.floor(below / 2),
    Math.floor((total - below) / 2),
  ));
  let low = 0;
  let seen = 0;
  for (let value = 0; value < 256; value++) {
    seen += histogram[value] ?? 0;
    if (seen > trim) {
      low = value;
      break;
    }
  }
  let high = 255;
  seen = 0;
  for (let value = 255; value >= 0; value--) {
    seen += histogram[value] ?? 0;
    if (seen > trim) {
      high = value;
      break;
    }
  }
  return { low, high };
}

function glyphHeightOf(plane: Uint8Array, width: number, height: number, inverted: boolean, median: number): number {
  const threshold = inverted
    ? Math.min(255, median + INK_MARGIN)
    : Math.max(0, median - INK_MARGIN);
  const minimumInk = Math.max(1, Math.ceil(width * MIN_BAND_COVERAGE));
  const bands: number[] = [];
  let run = 0;
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    let ink = 0;
    for (let x = 0; x < width; x++) {
      const value = plane[rowStart + x] ?? 0;
      if (inverted ? value >= threshold : value <= threshold) ink++;
    }
    if (ink >= minimumInk) {
      run++;
      continue;
    }
    if (run > 0) bands.push(run);
    run = 0;
  }
  if (run > 0) bands.push(run);
  // The median band tracks the line box closely enough to pick an upscale.
  return bands.length ? Math.round(medianOf(bands)) : 0;
}

function chooseScale(glyphHeight: number, minGlyphHeight: number, maxScale: number, pixels: number): number {
  if (!(glyphHeight > 0) || glyphHeight >= minGlyphHeight || maxScale <= 1) return 1;
  let scale = Math.min(maxScale, Math.ceil(minGlyphHeight / glyphHeight));
  while (scale > 1 && pixels * scale * scale > MAX_SCALED_PIXELS) scale--;
  return scale;
}

function scaleAndStretch(image: RgbaImage, plane: Uint8Array, plan: StretchPlan): RgbaImage {
  const { width, height, scale, low, gain, inverted } = plan;
  const outWidth = width * scale;
  const outHeight = height * scale;
  const output = new Uint8ClampedArray(outWidth * outHeight * 4);
  const rowBytes = outWidth * 4;
  const data = image.data;
  for (let y = 0; y < height; y++) {
    const sourceRow = y * width;
    const targetRow = y * scale * rowBytes;
    for (let x = 0; x < width; x++) {
      const source = sourceRow + x;
      const stretched = clamp(Math.round(((plane[source] ?? 0) - low) * gain), 0, 255);
      const value = inverted ? 255 - stretched : stretched;
      const alpha = data[source * 4 + 3] ?? 255;
      const target = targetRow + x * scale * 4;
      for (let repeat = 0; repeat < scale; repeat++) {
        const offset = target + repeat * 4;
        output[offset] = value;
        output[offset + 1] = value;
        output[offset + 2] = value;
        output[offset + 3] = alpha;
      }
    }
    // Nearest neighbour: each processed row is copied down, never resampled.
    for (let repeat = 1; repeat < scale; repeat++) {
      output.copyWithin(targetRow + repeat * rowBytes, targetRow, targetRow + rowBytes);
    }
  }
  return { data: output, width: outWidth, height: outHeight };
}

function denoise(image: RgbaImage): RgbaImage {
  const dimensions = dimensionsOf(image);
  if (!dimensions || dimensions.width < 3 || dimensions.height < 3) return image;
  const output = new Uint8ClampedArray(image.data);
  const values = new Uint8Array(9);
  for (let y = 1; y < dimensions.height - 1; y++) {
    for (let x = 1; x < dimensions.width - 1; x++) {
      const center = (y * dimensions.width + x) * 4;
      let similar = false;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
        const neighbour = ((y + dy) * dimensions.width + x + dx) * 4;
        if (Math.abs((image.data[center] ?? 0) - (image.data[neighbour] ?? 0)) <= 8) {
          similar = true;
          break;
        }
      }
      if (similar) continue;
      let index = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          values[index++] = image.data[((y + dy) * dimensions.width + x + dx) * 4] ?? 0;
        }
      }
      values.sort();
      output[center] = values[4] ?? output[center] ?? 0;
      output[center + 1] = output[center];
      output[center + 2] = output[center];
    }
  }
  return { ...image, data: output };
}

function renderDeskewPlan(image: RgbaImage, plan: ReturnType<typeof planDeskew>): { image: RgbaImage; matrix: Matrix2D } {
  const output = new Uint8ClampedArray(plan.crop.width * plan.crop.height * 4);
  for (let offset = 0; offset < output.length; offset += 4) {
    output[offset] = 255;
    output[offset + 1] = 255;
    output[offset + 2] = 255;
    output[offset + 3] = 255;
  }
  const inverse = invertMap(plan.matrix);
  for (let y = 0; y < plan.crop.height; y++) {
    for (let x = 0; x < plan.crop.width; x++) {
      const sourceX = inverse.a * (x + 0.5) + inverse.c * (y + 0.5) + inverse.e;
      const sourceY = inverse.b * (x + 0.5) + inverse.d * (y + 0.5) + inverse.f;
      const sx = Math.round(sourceX - 0.5);
      const sy = Math.round(sourceY - 0.5);
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
      const source = (sy * image.width + sx) * 4;
      const target = (y * plan.crop.width + x) * 4;
      output[target] = image.data[source] ?? 255;
      output[target + 1] = image.data[source + 1] ?? output[target];
      output[target + 2] = image.data[source + 2] ?? output[target];
      output[target + 3] = image.data[source + 3] ?? 255;
    }
  }
  return { image: { data: output, width: plan.crop.width, height: plan.crop.height }, matrix: plan.matrix };
}

function deskew(image: RgbaImage, correctionDeg: number): { image: RgbaImage; matrix: Matrix2D } {
  if (Math.abs(correctionDeg) < 1e-9) return { image, matrix: identityTransform(image.width, image.height).sourceToOutput };
  return renderDeskewPlan(image, planDeskew(-correctionDeg, { width: image.width, height: image.height }));
}

function binarize(image: RgbaImage): RgbaImage {
  const dimensions = dimensionsOf(image);
  if (!dimensions) return image;
  const plane = luminancePlane(image, dimensions.pixels);
  const histogram = histogramOf(plane);
  const threshold = medianFromHistogram(histogram, dimensions.pixels);
  const output = new Uint8ClampedArray(image.data);
  for (let index = 0; index < dimensions.pixels; index++) {
    const value = (plane[index] ?? 0) <= threshold ? 0 : 255;
    const offset = index * 4;
    output[offset] = value;
    output[offset + 1] = value;
    output[offset + 2] = value;
  }
  return { ...image, data: output };
}

function scaleImage(image: RgbaImage, scale: number): RgbaImage {
  if (scale <= 1) return image;
  const width = image.width * scale;
  const height = image.height * scale;
  const output = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (Math.floor(y / scale) * image.width + Math.floor(x / scale)) * 4;
      const target = (y * width + x) * 4;
      output[target] = image.data[source] ?? 255;
      output[target + 1] = image.data[source + 1] ?? output[target];
      output[target + 2] = image.data[source + 2] ?? output[target];
      output[target + 3] = image.data[source + 3] ?? 255;
    }
  }
  return { data: output, width, height };
}

function scaleMatrix(matrix: Matrix2D, scale: number): Matrix2D {
  return { a: matrix.a * scale, b: matrix.b * scale, c: matrix.c * scale, d: matrix.d * scale, e: matrix.e * scale, f: matrix.f * scale };
}

/**
 * Applies the existing rotation-only deskew executor to a validated raster.
 * The angle is the measured clockwise skew, not a guessed perspective warp.
 * Quarter turns and large tilts are refused because they need page rotation or
 * a perspective correction, not a silent OCR transform.
 */
export function dewarpForOcr(image: RgbaImage, measuredSkewDeg: number, options: DewarpOptions = {}): DewarpResult {
  const { width, height } = strictDimensionsOf(image);
  if (typeof measuredSkewDeg !== 'number' || !Number.isFinite(measuredSkewDeg)) {
    throw new DewarpError('invalid-angle', `dewarpForOcr needs a finite skew angle, got ${String(measuredSkewDeg)}.`);
  }
  const maxAngleDeg = options.maxAngleDeg ?? 15;
  if (!Number.isFinite(maxAngleDeg) || maxAngleDeg <= 0 || maxAngleDeg >= 90) {
    throw new DewarpError('invalid-angle', `dewarpForOcr maxAngleDeg must be finite and in (0, 90), got ${String(maxAngleDeg)}.`);
  }
  const maxPixels = options.maxPixels ?? MAX_SCALED_PIXELS;
  if (!Number.isFinite(maxPixels) || maxPixels <= 0) {
    throw new DewarpError('pixel-budget', `dewarpForOcr maxPixels must be positive and finite, got ${String(maxPixels)}.`);
  }
  if (Math.abs(measuredSkewDeg) < 1e-9) {
    return {
      image,
      transform: identityTransform(width, height),
      provenance: {
        status: 'not-needed',
        measuredSkewDeg: 0,
        correctionDeg: 0,
        sourceWidth: width,
        sourceHeight: height,
        outputWidth: width,
        outputHeight: height,
        mappedBackToSource: true,
      },
    };
  }
  if (Math.abs(measuredSkewDeg) >= 90 || Math.abs(measuredSkewDeg) > maxAngleDeg) {
    throw new DewarpError(
      'unsupported-angle',
      `dewarpForOcr refuses ${measuredSkewDeg}°; use page rotation or a perspective correction for this angle.`,
    );
  }
  const plan = planDeskew(measuredSkewDeg, { width, height });
  const outputPixels = plan.crop.width * plan.crop.height;
  if (outputPixels > maxPixels) {
    throw new DewarpError('pixel-budget', `dewarpForOcr output ${outputPixels} pixels exceeds the ${maxPixels} pixel budget.`);
  }
  const rendered = renderDeskewPlan(image, plan);
  return {
    image: rendered.image,
    transform: {
      sourceWidth: width,
      sourceHeight: height,
      outputWidth: rendered.image.width,
      outputHeight: rendered.image.height,
      sourceToOutput: rendered.matrix,
      outputToSource: invertMap(rendered.matrix),
    },
    provenance: {
      status: 'applied',
      measuredSkewDeg,
      correctionDeg: plan.angle,
      sourceWidth: width,
      sourceHeight: height,
      outputWidth: rendered.image.width,
      outputHeight: rendered.image.height,
      mappedBackToSource: true,
    },
  };
}

export const dewarpImageForOcr = dewarpForOcr;

export function toGrayscale(image: RgbaImage): RgbaImage {
  const dimensions = dimensionsOf(image);
  if (!dimensions) return emptyImage();
  const { width, height, pixels } = dimensions;
  const output = new Uint8ClampedArray(pixels * 4);
  const data = image.data;
  for (let index = 0, offset = 0; index < pixels; index++, offset += 4) {
    const value = luma(data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0);
    output[offset] = value;
    output[offset + 1] = value;
    output[offset + 2] = value;
    output[offset + 3] = data[offset + 3] ?? 255;
  }
  return { data: output, width, height };
}

export function detectInverted(image: RgbaImage): boolean {
  const dimensions = dimensionsOf(image);
  if (!dimensions) return false;
  const plane = luminancePlane(image, dimensions.pixels);
  const histogram = histogramOf(plane);
  const median = medianFromHistogram(histogram, dimensions.pixels);
  return isInvertedPlane(histogram, dimensions.pixels, median);
}

export function estimateGlyphHeight(image: RgbaImage): number {
  const dimensions = dimensionsOf(image);
  if (!dimensions) return 0;
  const { width, height, pixels } = dimensions;
  const plane = luminancePlane(image, pixels);
  const histogram = histogramOf(plane);
  const median = medianFromHistogram(histogram, pixels);
  return glyphHeightOf(plane, width, height, isInvertedPlane(histogram, pixels, median), median);
}

export function normalizeForOcr(image: RgbaImage, options: NormalizeOptions = {}): NormalizeResult {
  const dimensions = dimensionsOf(image);
  if (!dimensions) {
    return {
      image: emptyImage(),
      report: { inverted: false, contrastGain: 1, scale: 1 },
      dewarp: {
        status: 'unknown',
        measuredSkewDeg: 0,
        correctionDeg: 0,
        sourceWidth: 0,
        sourceHeight: 0,
        outputWidth: 0,
        outputHeight: 0,
        mappedBackToSource: false,
        reason: 'source pixel data is unavailable or malformed',
      },
    };
  }
  const { width, height, pixels } = dimensions;
  const plane = luminancePlane(image, pixels);
  const histogram = histogramOf(plane);
  const median = medianFromHistogram(histogram, pixels);
  const inverted = isInvertedPlane(histogram, pixels, median);

  const percentile = clamp(numberOption(options.percentile, DEFAULT_PERCENTILE), 0, 0.49);
  const minGlyphHeight = Math.max(1, numberOption(options.minGlyphHeight, DEFAULT_MIN_GLYPH_HEIGHT));
  const maxScale = Math.round(clamp(numberOption(options.maxScale, MAX_SCALE), 1, MAX_SCALE));
  const maxGain = Math.max(1, numberOption(options.maxGain, DEFAULT_MAX_GAIN));

  const glyphHeight = glyphHeightOf(plane, width, height, inverted, median);
  const scale = chooseScale(glyphHeight, minGlyphHeight, maxScale, pixels);
  const bounds = percentileBounds(histogram, pixels, percentile, median);
  const span = bounds.high - bounds.low;
  // A flat capture has no range to stretch; mapping from zero keeps it intact.
  const gain = span > 0 ? Math.min(maxGain, 255 / span) : 1;
  const low = span > 0 ? bounds.low : 0;

  const stretched = scaleAndStretch(image, plane, { width, height, scale: 1, low, gain, inverted });
  const stats = sampleStats(image);
  const plan = planPreprocess(stats);
  let spatial = stretched;
  let spatialMatrix: Matrix2D = identityTransform(width, height).sourceToOutput;
  const steps: PreprocessStepKind[] = [];
  let dewarp: DewarpProvenance = {
    status: 'not-needed',
    measuredSkewDeg: 0,
    correctionDeg: 0,
    sourceWidth: width,
    sourceHeight: height,
    outputWidth: width,
    outputHeight: height,
    mappedBackToSource: true,
  };
  for (const step of plan.steps) {
    if (step.kind === 'none') continue;
    steps.push(step.kind);
    if (step.kind === 'grayscale') continue;
    if (step.kind === 'denoise') {
      spatial = denoise(spatial);
      continue;
    }
    if (step.kind === 'deskew') {
      const corrected = deskew(spatial, step.angleDeg);
      spatial = corrected.image;
      spatialMatrix = corrected.matrix;
      dewarp = {
        status: 'applied',
        measuredSkewDeg: -step.angleDeg,
        correctionDeg: step.angleDeg,
        sourceWidth: width,
        sourceHeight: height,
        outputWidth: spatial.width,
        outputHeight: spatial.height,
        mappedBackToSource: true,
      };
      continue;
    }
    if (step.kind === 'binarize') spatial = binarize(spatial);
  }
  const output = scaleImage(spatial, scale);
  const sourceToOutput = scaleMatrix(spatialMatrix, scale);
  return {
    image: output,
    report: { inverted, contrastGain: Math.round(gain * 100) / 100, scale },
    transform: {
      sourceWidth: width,
      sourceHeight: height,
      outputWidth: output.width,
      outputHeight: output.height,
      sourceToOutput,
      outputToSource: invertMap(sourceToOutput),
    },
    steps,
    dewarp,
  };
}
