/**
 * Image preprocessing planner for scanned pages (backlog F03).
 *
 * A page that reaches OCR as pixels is rarely the page the scanner promised: the
 * paper sat crooked, the photocopier over-exposed the ink, and the JPEG is full
 * of dust. Each defect is fixed by a different filter, and applying a filter a
 * page does not need costs both time and accuracy — a rotation resamples every
 * glyph, and a threshold throws away the grey antialiasing a small font needs.
 *
 * This module is the planner, not the executor. It reads five cheap
 * measurements and returns the ordered list of steps an executor should apply,
 * each with a sentence a UI can show. It never touches pixels, so it cannot
 * claim a result it did not measure: every decision below is traceable to one
 * number in {@link PreprocessStats} and one documented threshold.
 *
 * The measurements come from a downscaled sample, roughly 200 px on the long
 * edge. Mean luma, contrast and speckle ratio are stable at that size, and the
 * skew search costs 65 projection passes, so a full-resolution page would be
 * wasted work. {@link sampleStats} measures them from an RGBA buffer the caller
 * already has; nothing here renders, scales or decodes an image.
 *
 * Measurements, all from the same luma plane (Rec.601, rounded to 0..255):
 * - `meanLuma`: how bright the page is. A document scan sits well above the
 *   mid-point because the paper does; a dark photograph does not.
 * - `contrast`: population standard deviation of luma. This is the number that
 *   separates "faint photocopy" from "readable scan", and it is independent of
 *   how bright the scan is.
 * - `estimatedSkewDeg`: clockwise tilt of the text lines, from
 *   {@link estimateSkew}. Positive means the right end of a line sits lower on
 *   the page.
 * - `noiseRatio`: share of pixels that are isolated specks, i.e. the share a
 *   3x3 median filter would replace. Grain and edges are excluded on purpose
 *   (see {@link speckleRatioOf}); this is impulse noise, the kind that OCR
 *   mistakes for punctuation.
 * - `isColor`: whether enough pixels carry chroma that the page reads as colour
 *   rather than grey.
 *
 * Steps, in the order a plan lists them, and why that order:
 * 1. `grayscale` — drop chroma first, so every later filter works on one plane.
 * 2. `denoise` — remove specks before thresholding, while they are still grey.
 * 3. `deskew` — straighten the page before it is thresholded, so the rotation
 *    resamples grey glyphs rather than hard black ones.
 * 4. `binarize` — threshold last, on an image that is already grey, clean and
 *    straight. A page kept in colour is never binarised: a threshold would
 *    destroy the colour it was kept for.
 *
 * A plan that needs none of those carries the single step `none`.
 *
 * Skew estimation is a projection profile. The sample is reduced to a binary
 * ink mask, then for each candidate angle every ink pixel is projected onto a
 * line perpendicular to the assumed text baseline (`y' = y·cos α − x·sin α`,
 * measured from the sample centre) and collected into a histogram. When the
 * candidate matches the real tilt, all the ink of one text line lands in the
 * same few bins, so the histogram becomes a handful of tall spikes and the sum
 * of squared bin counts peaks. Candidates run from −8° to +8° in 0.25° steps,
 * searched outward from zero, so a tie keeps the smaller correction. No
 * dependency, no randomness: the same sample always yields the same angle.
 *
 * Limits worth knowing before reading a plan:
 * - Skew beyond ±8° is not searched (a photo held at 30° is a different
 *   problem, and rotating that far needs a different resampler).
 * - `contrast` is global, so a page that is half plate and half text can look
 *   "high contrast" even when its text is washed out.
 * - `noiseRatio` over-counts one-pixel diagonal strokes, so the sample must be
 *   downscaled enough that glyph strokes are two pixels wide or more.
 * - This plans; it does not predict an accuracy gain. Only a re-OCR can show
 *   whether a step helped.
 */

/** An RGBA pixel buffer as `ImageData` hands it over: row-major, four bytes per pixel. */
export interface RgbaSample {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** The five cheap measurements every decision is made from. */
export interface PreprocessStats {
  /** Mean Rec.601 luma, 0..255. */
  readonly meanLuma: number;
  /** Population standard deviation of luma, roughly 0..128. */
  readonly contrast: number;
  /** Clockwise tilt of the text lines in degrees; see {@link estimateSkew}. */
  readonly estimatedSkewDeg: number;
  /** Share of sampled pixels that are isolated specks, 0..1. */
  readonly noiseRatio: number;
  /** True when enough pixels carry chroma to read the page as colour. */
  readonly isColor: boolean;
}

/** Knobs that describe the caller's intent rather than the page. */
export interface PreprocessOptions {
  /**
   * Whether the consumer needs text only (the default) or keeps the page's
   * colour. Colour is kept only when this is exactly `false`; then the plan
   * never drops chroma and never thresholds, because both would destroy what
   * the caller asked to preserve.
   */
  readonly textOnly?: boolean;
}

/** Every step a plan can contain. `none` is the plan for a page already clean. */
export type PreprocessStepKind = 'grayscale' | 'denoise' | 'deskew' | 'binarize' | 'none';

/**
 * One step of a plan. `reason` is a complete sentence a UI can show as-is; the
 * step-specific field is everything an executor needs beyond the kind.
 */
export type PreprocessStep =
  | { readonly kind: 'deskew'; readonly angleDeg: number; readonly reason: string }
  | { readonly kind: 'denoise'; readonly reason: string }
  | { readonly kind: 'grayscale'; readonly reason: string }
  | { readonly kind: 'binarize'; readonly reason: string }
  | { readonly kind: 'none'; readonly reason: string };

/** What to do with the page, and why, in execution order. */
export interface PreprocessPlan {
  /** Steps to apply, in order; exactly `[{ kind: 'none' }]` when nothing is needed. */
  readonly steps: readonly PreprocessStep[];
  /** One sentence per step, in the same order, for a UI that lists the reasons. */
  readonly reasons: readonly string[];
}

/**
 * Skew smaller than this is left alone. Below half a degree the baseline drift
 * within one word is under a pixel, while the rotation itself resamples every
 * glyph and softens the strokes Tesseract has to segment. Half a degree is the
 * point where straightening starts to win.
 */
export const SKEW_THRESHOLD_DEG = 0.5;

/**
 * The tilt the estimator will look for. Scans sit within a few degrees; a page
 * past 8° is a hand-held photo whose perspective is wrong too, and no single
 * rotation fixes that. Searching wider would also cost accuracy, because the
 * projection profile flattens as the angle grows.
 */
export const MAX_SKEW_DEG = 8;

/**
 * Angular resolution of the search. A quarter degree is twice as fine as the
 * 0.5° decide-or-not threshold, so the estimate cannot sit on the wrong side of
 * it because of the grid alone.
 */
export const SKEW_SEARCH_STEP_DEG = 0.25;

/**
 * Samples smaller than this in either direction have too few rows for a
 * projection to peak: the profile of a 10 px tall line is noise. Such a sample
 * reports zero skew instead of an angle nobody should trust.
 */
export const MIN_SKEW_SAMPLE_EDGE = 12;

/**
 * A page with less ink than this has no text lines to fit — a blank back side,
 * a separator page. Five parts per thousand is about 100 pixels of a
 * 160x120 sample, enough for one short line of type.
 */
export const MIN_SKEW_INK_FRACTION = 0.005;

/**
 * Contrast below this is "low" and a threshold is worth planning. A clean
 * digital scan measures 60-100; a photocopy of a photocopy of faint print sits
 * under 30. At 35 the ink and paper populations still overlap enough that
 * binarising separates them, and above it the grey levels already carry the
 * glyph edges better than a hard threshold would.
 */
export const LOW_CONTRAST_THRESHOLD = 35;

/**
 * A page flatter than this has no two populations to separate: binarising would
 * only turn scanner grain into black speckle. Three luma counts is just above
 * the noise floor of an 8-bit scan of blank paper.
 */
export const MIN_BINARIZE_CONTRAST = 3;

/**
 * Paper is lighter than this, which is what makes a page document-like. A dark
 * frame is a photograph, and thresholding a photograph produces a poster, not
 * text. The mid-point of the luma range is the honest boundary.
 */
export const DOCUMENT_BRIGHTNESS_MIN = 140;

/**
 * More speckle than this and denoising is worth the pass. A median filter is
 * cheap, but it also erases genuine single-pixel details such as the dot of an
 * i at small sizes; at 2% of pixels the speckle is already dense enough to be
 * read as punctuation and diacritics.
 */
export const NOISE_RATIO_THRESHOLD = 0.02;

/**
 * How far a pixel must sit from its 3x3 median before it counts as a speck.
 * Grain moves a pixel by a few counts and an antialiased edge by more, but a
 * dust speck or a scanner dropout moves it by tens; 24 is above the first two
 * and below the third.
 */
export const NOISE_MEDIAN_DELTA = 24;

/**
 * A neighbour within this many counts shares the pixel's value, which makes the
 * pixel part of a stroke or an edge rather than an isolated speck. Eight counts
 * is comfortably above 8-bit quantisation and below one halftone cell.
 */
export const NOISE_NEIGHBOUR_TOLERANCE = 8;

/**
 * Channel spread that counts as colour rather than a grey pixel. A grey pixel
 * has identical channels; JPEG chroma noise moves them by a few counts; a real
 * tint moves them by tens. Sixteen is where a tint stops being invisible.
 */
export const COLOR_CHANNEL_SPREAD = 16;

/**
 * Share of pixels that must carry that spread before the page is called
 * colour. A coloured stamp or a single logo should not make an otherwise grey
 * scan pay for the grayscale step.
 */
export const COLOR_PIXEL_RATIO = 0.02;

/** Why a sample or a set of stats was refused. Stable identifiers, safe to switch on. */
export type PreprocessErrorCode = 'empty-sample' | 'short-buffer' | 'invalid-stats';

/**
 * A sample or a stats object this module will not plan from. Refusing is the
 * point: planning on an empty buffer or a NaN contrast would produce a plan
 * that looks confident and means nothing.
 */
export class PreprocessError extends Error {
  readonly code: PreprocessErrorCode;

  constructor(code: PreprocessErrorCode, message: string) {
    super(message);
    this.name = 'PreprocessError';
    this.code = code;
  }
}

/** Degrees kept on a planned rotation: a hundredth of a degree is far below one pixel. */
const ANGLE_DECIMALS = 2;

/** Rec.601 weights in integers, so the plane is bit-identical in every engine. */
function lumaOf(red: number, green: number, blue: number): number {
  return Math.round((299 * red + 587 * green + 114 * blue) / 1000);
}

interface SampleDimensions {
  width: number;
  height: number;
  pixels: number;
}

function dimensionsOf(sample: RgbaSample): SampleDimensions {
  if (!sample || typeof sample !== 'object' || !sample.data) {
    throw new PreprocessError('empty-sample', 'A pixel sample needs RGBA data, a width and a height.');
  }
  const width = Math.floor(sample.width);
  const height = Math.floor(sample.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new PreprocessError(
      'empty-sample',
      `A pixel sample needs a positive width and height, got ${width}x${height}.`,
    );
  }
  const pixels = width * height;
  if (sample.data.length < pixels * 4) {
    throw new PreprocessError(
      'short-buffer',
      `A ${width}x${height} sample needs ${pixels * 4} RGBA bytes, got ${sample.data.length}.`,
    );
  }
  return { width, height, pixels };
}

function lumaPlane(data: Uint8ClampedArray, pixels: number): Uint8Array {
  const plane = new Uint8Array(pixels);
  for (let index = 0, offset = 0; index < pixels; index++, offset += 4) {
    plane[index] = lumaOf(data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0);
  }
  return plane;
}

function meanOf(plane: Uint8Array): number {
  if (plane.length === 0) return 0;
  let total = 0;
  for (let index = 0; index < plane.length; index++) total += plane[index] ?? 0;
  return total / plane.length;
}

/** Population standard deviation: the spread of the page, not of a sample of it. */
function contrastOf(plane: Uint8Array, mean: number): number {
  if (plane.length === 0) return 0;
  let squares = 0;
  for (let index = 0; index < plane.length; index++) {
    const delta = (plane[index] ?? 0) - mean;
    squares += delta * delta;
  }
  return Math.sqrt(squares / plane.length);
}

/**
 * Share of pixels a 3x3 median filter would replace by a clearly different
 * value. A pixel that has even one orthogonal neighbour of its own value is
 * part of a stroke or an edge — the median would keep it — so those are skipped
 * before the median is computed. What remains is an isolated value: dust,
 * scanner dropout, a salt pixel.
 */
function speckleRatioOf(plane: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  const window = new Uint8Array(9);
  let interior = 0;
  let specks = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      interior++;
      const centre = plane[row + x] ?? 0;
      const similar =
        Math.abs(centre - (plane[row + x - 1] ?? 0)) <= NOISE_NEIGHBOUR_TOLERANCE ||
        Math.abs(centre - (plane[row + x + 1] ?? 0)) <= NOISE_NEIGHBOUR_TOLERANCE ||
        Math.abs(centre - (plane[row - width + x] ?? 0)) <= NOISE_NEIGHBOUR_TOLERANCE ||
        Math.abs(centre - (plane[row + width + x] ?? 0)) <= NOISE_NEIGHBOUR_TOLERANCE;
      if (similar) continue;
      window[0] = plane[row - width + x - 1] ?? 0;
      window[1] = plane[row - width + x] ?? 0;
      window[2] = plane[row - width + x + 1] ?? 0;
      window[3] = plane[row + x - 1] ?? 0;
      window[4] = centre;
      window[5] = plane[row + x + 1] ?? 0;
      window[6] = plane[row + width + x - 1] ?? 0;
      window[7] = plane[row + width + x] ?? 0;
      window[8] = plane[row + width + x + 1] ?? 0;
      window.sort();
      if (Math.abs(centre - (window[4] ?? 0)) > NOISE_MEDIAN_DELTA) specks++;
    }
  }
  return interior > 0 ? specks / interior : 0;
}

/** True when enough of the sample carries chroma for the page to read as colour. */
function isColorSample(data: Uint8ClampedArray, pixels: number): boolean {
  if (pixels === 0) return false;
  let tinted = 0;
  for (let index = 0, offset = 0; index < pixels; index++, offset += 4) {
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
    if (spread > COLOR_CHANNEL_SPREAD) tinted++;
  }
  return tinted / pixels > COLOR_PIXEL_RATIO;
}

/**
 * Projection-profile skew estimate for one luma plane, in degrees, positive
 * clockwise. Exported only through {@link estimateSkew}; the plane-sharing
 * split exists so {@link sampleStats} builds the plane once.
 */
function skewOfPlane(plane: Uint8Array, width: number, height: number): number {
  if (width < MIN_SKEW_SAMPLE_EDGE || height < MIN_SKEW_SAMPLE_EDGE) return 0;
  const pixels = width * height;
  const threshold = meanOf(plane);

  let dark = 0;
  for (let index = 0; index < pixels; index++) {
    if ((plane[index] ?? 0) <= threshold) dark++;
  }
  // A white-on-black capture is the same page with the ink and paper swapped.
  const inkIsDark = dark * 2 <= pixels;
  const inkCount = inkIsDark ? dark : pixels - dark;
  if (inkCount < Math.max(1, Math.floor(pixels * MIN_SKEW_INK_FRACTION))) return 0;

  // First pass counts, second pass fills with the same predicate, so the arrays
  // are exactly filled and the projection loop below needs no bound check. The
  // cursor guard is belt and braces against a later edit to one pass only.
  const inkX = new Int32Array(inkCount);
  const inkY = new Int32Array(inkCount);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const value = plane[row + x] ?? 0;
      const isInk = inkIsDark ? value <= threshold : value > threshold;
      if (!isInk || cursor >= inkCount) continue;
      inkX[cursor] = x;
      inkY[cursor] = y;
      cursor++;
    }
  }

  const centreX = (width - 1) / 2;
  const centreY = (height - 1) / 2;
  // A projection never leaves half the diagonal, so this covers every candidate.
  const range = Math.ceil((width + height) / 2) + 2;
  const bins = new Uint32Array(range * 2 + 1);
  const maxStep = Math.round(MAX_SKEW_DEG / SKEW_SEARCH_STEP_DEG);
  let bestAngle = 0;
  let bestScore = -1;

  for (let step = 0; step <= maxStep; step++) {
    const sides = step === 0 ? 1 : 2;
    for (let side = 0; side < sides; side++) {
      const sign = step === 0 ? 0 : side === 0 ? -1 : 1;
      const angle = sign * step * SKEW_SEARCH_STEP_DEG;
      const radians = (angle * Math.PI) / 180;
      const sin = Math.sin(radians);
      const cos = Math.cos(radians);
      bins.fill(0);
      for (let index = 0; index < inkCount; index++) {
        const x = (inkX[index] ?? 0) - centreX;
        const y = (inkY[index] ?? 0) - centreY;
        const projected = Math.round(y * cos - x * sin) + range;
        bins[projected] = (bins[projected] ?? 0) + 1;
      }
      // Spikes mean aligned baselines; a smeared profile has a smaller sum of squares.
      let score = 0;
      for (let bin = 0; bin < bins.length; bin++) {
        const count = bins[bin] ?? 0;
        score += count * count;
      }
      if (score > bestScore) {
        bestScore = score;
        bestAngle = angle;
      }
    }
  }
  return bestAngle;
}

/**
 * Measures the five statistics of {@link PreprocessStats} from an RGBA sample.
 *
 * `sample` must be the caller's downscaled view of the page; this function does
 * not scale anything. The buffer is read as-is, alpha is ignored (a scanned
 * page is opaque), and the returned numbers are plain doubles: rounding is a
 * presentation concern, so a plan compares the measured value, not a
 * formatted one.
 *
 * Throws {@link PreprocessError} with `empty-sample` when the sample has no
 * pixels and with `short-buffer` when the buffer cannot hold its dimensions.
 */
export function sampleStats(sample: RgbaSample): PreprocessStats {
  const { width, height, pixels } = dimensionsOf(sample);
  const plane = lumaPlane(sample.data, pixels);
  const mean = meanOf(plane);
  return {
    meanLuma: mean,
    contrast: contrastOf(plane, mean),
    estimatedSkewDeg: skewOfPlane(plane, width, height),
    noiseRatio: speckleRatioOf(plane, width, height),
    isColor: isColorSample(sample.data, pixels),
  };
}

/**
 * Estimates how far the text lines of a sample are tilted, in degrees, positive
 * clockwise: at +2 the right end of a line sits lower than its left end, and
 * rotating the page 2° counter-clockwise levels it.
 *
 * The sample is reduced to a binary ink mask at the mean luma (the minority
 * class is the ink, so an inverted capture measures the same tilt), projected
 * onto a line perpendicular to the assumed baseline for each candidate angle,
 * and scored by the sum of squared bin counts — the angle whose profile is most
 * spiky wins. The full algorithm and its ±8° range are documented in the file
 * header.
 *
 * Returns 0 when there is no measurable tilt: fewer than
 * {@link MIN_SKEW_SAMPLE_EDGE} pixels across, or too little ink for a text line
 * (a blank page, a full-bleed photo). Throws {@link PreprocessError} with
 * `empty-sample` or `short-buffer` for a sample that cannot be read at all.
 */
export function estimateSkew(sample: RgbaSample): number {
  const { width, height, pixels } = dimensionsOf(sample);
  return skewOfPlane(lumaPlane(sample.data, pixels), width, height);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Degrees for a sentence: the sign is dropped because the words carry the
 * direction, and trailing zeros are trimmed so 2 reads as "2.0°" and 1.25 as
 * "1.25°" rather than both at the raw two-decimal width.
 */
function formatDegrees(value: number): string {
  const text = Math.abs(value)
    .toFixed(ANGLE_DECIMALS)
    .replace(/0+$/u, '')
    .replace(/\.$/u, '.0');
  return `${text}°`;
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function grayscaleReason(): string {
  return 'The page is in colour; text-only OCR drops the chroma so every later step works on one grey plane.';
}

function denoiseReason(ratio: number): string {
  return `${formatPercent(ratio)} of the sampled pixels are isolated specks, above the `
    + `${formatPercent(NOISE_RATIO_THRESHOLD)} limit; a median denoise pass removes them before OCR reads them as punctuation.`;
}

function deskewReason(skew: number): string {
  const tilt = skew > 0 ? 'clockwise' : 'counter-clockwise';
  const correction = skew > 0 ? 'counter-clockwise' : 'clockwise';
  return `Text lines are tilted ${formatDegrees(skew)} ${tilt}, above the ${SKEW_THRESHOLD_DEG.toFixed(1)}° limit; `
    + `the deskew step rotates the page ${formatDegrees(skew)} ${correction} to level them.`;
}

function binarizeReason(contrast: number): string {
  return `Contrast is ${contrast.toFixed(1)} out of 255 on a light page, below the ${LOW_CONTRAST_THRESHOLD} limit; `
    + 'binarising separates the ink from the paper before OCR.';
}

function cleanReason(stats: PreprocessStats): string {
  return `Nothing needs fixing: skew ${formatDegrees(stats.estimatedSkewDeg)}, `
    + `contrast ${stats.contrast.toFixed(1)}, speckle ${formatPercent(stats.noiseRatio)}. `
    + 'No preprocessing step is planned.';
}

function invalidStats(detail: string): never {
  throw new PreprocessError('invalid-stats', `planPreprocess: ${detail}.`);
}

function finiteOrThrow(value: number, name: string): number {
  if (!Number.isFinite(value)) invalidStats(`${name} must be a finite number, got ${String(value)}`);
  return value;
}

function validateStats(stats: PreprocessStats): void {
  if (!stats || typeof stats !== 'object') invalidStats('stats must be an object');
  const meanLuma = finiteOrThrow(stats.meanLuma, 'meanLuma');
  if (meanLuma < 0 || meanLuma > 255) invalidStats(`meanLuma must be in 0..255, got ${meanLuma}`);
  const contrast = finiteOrThrow(stats.contrast, 'contrast');
  if (contrast < 0) invalidStats(`contrast must not be negative, got ${contrast}`);
  const skew = finiteOrThrow(stats.estimatedSkewDeg, 'estimatedSkewDeg');
  if (Math.abs(skew) > 90) invalidStats(`estimatedSkewDeg must be within -90..90, got ${skew}`);
  const noise = finiteOrThrow(stats.noiseRatio, 'noiseRatio');
  if (noise < 0 || noise > 1) invalidStats(`noiseRatio must be in 0..1, got ${noise}`);
  if (typeof stats.isColor !== 'boolean') invalidStats('isColor must be a boolean');
}

/**
 * Decides which preprocessing steps a scanned page needs, and why.
 *
 * The decision is a table, one row per documented threshold:
 * - `grayscale` when the page is colour and the caller wants text only.
 * - `denoise` when `noiseRatio` is above {@link NOISE_RATIO_THRESHOLD}.
 * - `deskew` when `|estimatedSkewDeg|` is at least {@link SKEW_THRESHOLD_DEG};
 *   the planned `angleDeg` is the correction, i.e. `-estimatedSkewDeg`, positive
 *   clockwise, which is the value a canvas rotation takes directly.
 * - `binarize` when the page is document-like (light, above
 *   {@link DOCUMENT_BRIGHTNESS_MIN}), its contrast is low but not flat (from
 *   {@link MIN_BINARIZE_CONTRAST} up to {@link LOW_CONTRAST_THRESHOLD}), and the
 *   pipeline will be grey by then — a page kept in colour is not thresholded.
 *
 * The steps are returned in execution order (see the file header), and a page
 * that needs nothing gets the single step `none`. Every step carries a complete
 * sentence for the UI; `reasons` repeats them in the same order.
 *
 * Throws {@link PreprocessError} with `invalid-stats` when a value is out of
 * range or not finite: a plan built from a NaN would look authoritative and be
 * meaningless.
 */
export function planPreprocess(stats: PreprocessStats, options: PreprocessOptions = {}): PreprocessPlan {
  validateStats(stats);
  const textOnly = options.textOnly ?? true;
  const steps: PreprocessStep[] = [];

  const grayscale = stats.isColor && textOnly;
  if (grayscale) steps.push({ kind: 'grayscale', reason: grayscaleReason() });

  if (stats.noiseRatio > NOISE_RATIO_THRESHOLD) {
    steps.push({ kind: 'denoise', reason: denoiseReason(stats.noiseRatio) });
  }

  if (Math.abs(stats.estimatedSkewDeg) >= SKEW_THRESHOLD_DEG) {
    steps.push({
      kind: 'deskew',
      angleDeg: roundTo(-stats.estimatedSkewDeg, ANGLE_DECIMALS),
      reason: deskewReason(stats.estimatedSkewDeg),
    });
  }

  // A threshold needs a grey image and two populations to separate: flat pages
  // and pages kept in colour are excluded, not silently thresholded.
  const greyOutput = !stats.isColor || grayscale;
  const lowContrast = stats.contrast >= MIN_BINARIZE_CONTRAST
    && stats.contrast < LOW_CONTRAST_THRESHOLD;
  if (greyOutput && lowContrast && stats.meanLuma >= DOCUMENT_BRIGHTNESS_MIN) {
    steps.push({ kind: 'binarize', reason: binarizeReason(stats.contrast) });
  }

  if (steps.length === 0) steps.push({ kind: 'none', reason: cleanReason(stats) });
  return { steps, reasons: steps.map(step => step.reason) };
}
