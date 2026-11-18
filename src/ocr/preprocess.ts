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
  if (!dimensions) return { image: emptyImage(), report: { inverted: false, contrastGain: 1, scale: 1 } };
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

  return {
    image: scaleAndStretch(image, plane, { width, height, scale, low, gain, inverted }),
    report: { inverted, contrastGain: Math.round(gain * 100) / 100, scale },
  };
}
