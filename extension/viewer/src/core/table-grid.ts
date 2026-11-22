/**
 * Table grid from a scanned table's ink profile (backlog F04).
 *
 * A table that reaches the reader as a picture is useless: its columns exist only as
 * rules drawn in ink. This module recovers the grid from that ink in three pure steps
 * that share no state:
 *
 * 1. {@link reduceProfile} turns a binary mask into two ink profiles: for every image
 *    row the share of that row's pixels that are ink, and for every image column the
 *    share of that column's pixels that are ink.
 * 2. {@link findRules} reads one profile as a signal whose tall runs are the printed
 *    rules.
 * 3. {@link buildGrid} turns the rule lists into row bands, column bands and one rect
 *    per cell, and reports how evenly the rules are spaced.
 *
 * Splitting the work this way is the point: everything after {@link reduceProfile} is
 * arithmetic on number arrays, so the grid can be tested without an image, a canvas or
 * an OCR engine, and the caller decides where the mask comes from (a thresholded luma
 * plane, a cleaned scan, a fixture). Nothing here reads a file, renders, or throws for
 * a profile that is merely empty.
 *
 * Coordinates and units:
 * - A mask is row-major, one value per pixel, and every index below is a pixel. A pixel
 *   is ink when its value is strictly greater than `inkThreshold` (default 0), so a 0/1
 *   mask and a 0/255 mask measure the same. A mask whose dark pixels mean paper must be
 *   inverted by the caller: this module has no polarity guess, because a wrong guess
 *   silently returns a grid of the white space between the rules.
 * - {@link reduceProfile} may measure a rectangular region of the mask, which is what a
 *   table inside a page margin needs. Profiles are normalised over that region rather
 *   than over the whole mask.
 * - Every other function works in pixel indices inside the measured region.
 *   {@link buildGrid} adds the caller's `originX`/`originY`, so a caller that measured a
 *   region can put the cells back into mask pixels.
 * - A cell carries the same field names as `Rect` in `src/core/types.ts` but is measured
 *   in pixels, so it is deliberately not a `Rect`.
 *
 * Normalisation, the one rule the rest of the module relies on: a profile value is
 * `ink pixels / pixels along the measured axis`, so it is always in 0..1 and 1 means "a
 * solid rule". Row profiles divide by the region width and column profiles by the region
 * height, so one documented threshold holds for both, and a horizontal rule does not
 * pretend to be a vertical one merely because the page is wider than it is tall.
 *
 * What the module will not do:
 * - It invents no rules. A profile with no run above the threshold yields no rules, and
 *   {@link buildGrid} then refuses with a reason instead of writing a grid out of nothing.
 * - It does not promote a speck: a band is a rule only when it is at least
 *   {@link MIN_RULE_THICKNESS} indices thick.
 * - It does not hide an irregular table. A grid is still built when the rules are
 *   unevenly spaced, but the spacing variation is measured, reported as a reason and
 *   lowers `confidence`, because a cell that is four times the height of its neighbour is
 *   worth a second look and not a refusal.
 *
 * Known limits, each one measurable:
 * - A rule must cover more than {@link RULE_INK_THRESHOLD} of its band. A table filling
 *   two thirds of the page width puts its horizontal rules at about 0.67 and still clears
 *   the 0.5 default, but a table inside one narrow page column needs a measured region or
 *   a lower `threshold`.
 * - A table with many column rules raises the ink floor everywhere: every non-rule row
 *   carries the column rules' ink, so a very dense table needs a threshold above that
 *   floor.
 * - Two runs separated by at most `mergeGap` indices of *faint* ink are one broken rule;
 *   two runs separated by empty pixels stay two rules. That is what keeps a one-pixel-wide
 *   column alive, and it is why the merge is ink-aware instead of a plain distance merge.
 * - Tilted rules reach the profile as smeared runs. A grid needs rules that are horizontal
 *   and vertical to within about a pixel; nothing here deskews, so a crooked page should be
 *   straightened first (see `src/core/preprocess.ts`).
 * - Spacing is measured from rule starts, so a thicker rule does not shift the pitch, but a
 *   table whose rows genuinely differ in height reports a variation even when its rules are
 *   perfectly straight.
 */

/** Which axis of an {@link InkProfile} a rule search reads. */
export type RuleAxis = 'rows' | 'columns';

/** A rectangular window of a mask, in pixels. Fractional values are floored. */
export interface GridRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The two ink profiles of one measured region.
 *
 * `rows[y]` is the share of row `y` that is ink and `columns[x]` is the share of column
 * `x` that is ink; both are fractions in 0..1 (see the file comment for the
 * normalisation). `inkRatio` is the share of the whole region that is ink, which is the
 * cheapest way for a caller to tell a blank measurement from a ruled one.
 */
export interface InkProfile {
  /** Width of the measured region, in pixels; equals `columns.length`. */
  readonly width: number;
  /** Height of the measured region, in pixels; equals `rows.length`. */
  readonly height: number;
  /** One ink fraction per row, top to bottom. */
  readonly rows: readonly number[];
  /** One ink fraction per column, left to right. */
  readonly columns: readonly number[];
  /** Share of the measured region that is ink, 0..1. */
  readonly inkRatio: number;
}

/** Knobs for {@link reduceProfile}. */
export interface ReduceProfileOptions {
  /**
   * A pixel is ink when its value is strictly greater than this. Defaults to 0, so any
   * non-zero value is ink. Must be finite and at least 0.
   */
  readonly inkThreshold?: number;
  /** The part of the mask to measure. Defaults to the whole mask. */
  readonly region?: GridRegion;
}

/**
 * One band of consecutive indices whose ink fraction clears the rule threshold.
 *
 * `start` and `end` are inclusive indices into the profile that produced the band.
 * `center` is `(start + end) / 2` and may end in `.5` for an even band; it is reported
 * for diagnostics, while {@link buildGrid} derives geometry and pitch from `start` and
 * `end` so a stale `center` cannot influence a grid.
 */
export interface RuleBand {
  /** First index of the band, inclusive. */
  readonly start: number;
  /** Last index of the band, inclusive. */
  readonly end: number;
  /** `end - start + 1`, i.e. the band's thickness in profile indices. */
  readonly thickness: number;
  /** Largest ink fraction inside the band. */
  readonly peak: number;
  /** `(start + end) / 2`; fractional for an even thickness. */
  readonly center: number;
}

/** Knobs for {@link findRules}. */
export interface FindRulesOptions {
  /** Profile axis to read. Defaults to `rows`. */
  readonly axis?: RuleAxis;
  /**
   * An index is inside a rule when its ink fraction is strictly above this. Defaults to
   * {@link RULE_INK_THRESHOLD}. Must be above 0 and at most 1.
   */
  readonly threshold?: number;
  /**
   * A band thinner than this is a speck and is dropped. Defaults to
   * {@link MIN_RULE_THICKNESS}. Must be a whole number of at least 1; a fractional value
   * is floored.
   */
  readonly minThickness?: number;
  /**
   * Two bands separated by at most this many indices may still be one rule. Defaults to
   * {@link MERGE_GAP}. Must be a whole number of at least 0; a fractional value is
   * floored.
   */
  readonly mergeGap?: number;
}

/**
 * One cell rect in pixel coordinates.
 *
 * `row` and `col` are band indices: row 0 and column 0 start at the first pair of rules.
 * `x`/`y` are the first pixel of the cell's interior (the pixel after the rule) plus the
 * caller's origin, and `width`/`height` count interior pixels, so a cell never includes
 * the ink of the rules that bound it.
 */
export interface GridCell {
  readonly row: number;
  readonly col: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Stable identifiers for the notes {@link buildGrid} returns. */
export type GridReasonCode = 'too-few-rules' | 'non-uniform-spacing' | 'touching-rules';

/**
 * One note about a grid. `code` is safe to switch on, `message` is a complete sentence a
 * UI can show as-is, and `variation` carries the measurement behind a
 * `non-uniform-spacing` note.
 */
export interface GridReason {
  readonly code: GridReasonCode;
  /** Complete sentence, already formatted with the numbers that triggered it. */
  readonly message: string;
  /** Coefficient of variation of the rule pitch; present only on `non-uniform-spacing`. */
  readonly variation?: number;
}

/**
 * A table grid, or a refusal.
 *
 * A refusal has `rows: 0`, `columns: 0`, an empty `cells`, `confidence: 0` and at least
 * one `too-few-rules` reason. A built grid always has at least one row band and one
 * column band, and `cells.length` equals `rows * columns`.
 */
export interface TableGrid {
  /** Number of row bands; one less than the number of row rules. */
  readonly rows: number;
  /** Number of column bands; one less than the number of column rules. */
  readonly columns: number;
  /** `rows * columns` cells, row-major (row 0 left to right, then row 1, and so on). */
  readonly cells: readonly GridCell[];
  /**
   * 0..1: how confident the grid is, `1 - the worst axis's pitch variation`. Exactly 0
   * for a refusal, and 1 when every gap between neighbouring rules is the same.
   */
  readonly confidence: number;
  /**
   * Notes in a fixed order: spacing notes by axis (row before column), then touching
   * notes by axis. Empty for a uniform grid whose rules do not touch.
   */
  readonly reasons: readonly GridReason[];
}

/** Knobs for {@link buildGrid}. */
export interface BuildGridOptions {
  /** Added to every cell's `x`. Defaults to 0. */
  readonly originX?: number;
  /** Added to every cell's `y`. Defaults to 0. */
  readonly originY?: number;
  /**
   * A pitch variation above this is reported as a reason. Defaults to
   * {@link MAX_SPACING_VARIATION}. Must be in 0..1.
   */
  readonly spacingTolerance?: number;
}

/**
 * An index is inside a rule when more than this share of its band is ink.
 *
 * A printed rule covers its whole band, while a row of text covers between roughly 0.05
 * and 0.35 of it: glyphs are strokes with counters, gaps between letters and gaps between
 * words. Half is above every plausible text row and below the least complete rule a scan
 * produces, so one threshold separates the two populations without a second knob.
 */
export const RULE_INK_THRESHOLD = 0.5;

/**
 * A band must be at least this many indices thick to be a rule.
 *
 * A single index above the threshold is a dust speck, a JPEG ringing edge or one row of
 * antialiasing, and turning it into a rule would add a phantom row or column to every
 * grid that carries one. Two indices is the thinnest band that ink can cross: a rule is
 * at least a printed line wide, and a real one-pixel rule still survives as a rule when
 * the scan breaks it into fragments that {@link findRules} merges back together.
 */
export const MIN_RULE_THICKNESS = 2;

/**
 * Two bands this close together may be one rule.
 *
 * A scan breaks a rule where the paper is pale or the pen skipped, which leaves a single
 * index below the threshold in the middle of a rule. One index is exactly that kind of
 * break; two indices is already a deliberate gap.
 */
export const MERGE_GAP = 1;

/**
 * A gap index must still carry this share of the rule threshold's ink to count as a break
 * in a rule rather than white space.
 *
 * A broken rule's middle still holds most of the rule's ink (a one-pixel gap in a 300 px
 * rule reads about 0.99), while the white space between two rules of a narrow column
 * reads 0. Half the threshold is far below the first and far above the second, and it is
 * what lets a one-pixel-wide column survive as two rules instead of one thick one.
 */
export const MERGE_MIN_INK_RATIO = 0.5;

/**
 * A grid needs at least this many rules on each axis: two rules bound one band.
 *
 * One rule is a line on a page, not a table; a grid built from it would have zero cells.
 */
export const MIN_GRID_RULES = 2;

/**
 * Pitch variation above this is reported as a reason.
 *
 * Printed rules sit on a regular pitch, and real tables still vary because a header row is
 * taller than its data rows: a fifth of the mean covers that without flagging every table
 * that has a header. Beyond it the variation is structural (a merged cell that swallowed
 * a row, a table spliced from two), and worth telling the caller about.
 */
export const MAX_SPACING_VARIATION = 0.2;

/** Why a call was refused. Stable identifiers, safe to switch on. */
export type TableGridErrorCode =
  | 'empty-mask'
  | 'short-buffer'
  | 'invalid-region'
  | 'invalid-options'
  | 'invalid-profile'
  | 'invalid-rules';

/**
 * An argument this module cannot measure from: a mask with no pixels, a buffer too short
 * for its dimensions, a region outside the mask, an out-of-range option, a profile that is
 * not made of ink fractions, or a rule list that is out of order.
 *
 * These are refusals, not verdicts: a mask with no ink and a profile with no rules are
 * well formed and are answered with an empty result, while an argument that cannot
 * describe geometry at all is a caller bug that would otherwise look like a confident 0.
 */
export class TableGridError extends Error {
  readonly code: TableGridErrorCode;

  constructor(code: TableGridErrorCode, message: string) {
    super(message);
    this.name = 'TableGridError';
    this.code = code;
  }
}

/** Float slack for ink fractions: a computed share can land a hair outside 0..1. */
const EPSILON = 1e-9;

/** Decimal places kept on `confidence`, so two runs print the same number. */
const CONFIDENCE_DECIMALS = 2;

/**
 * Measures the row and column ink profiles of a mask, or of a region of it.
 *
 * `pixels` is read as row-major with `width * height` values; only values strictly above
 * `options.inkThreshold` count as ink, so both 0/1 and 0/255 masks measure the same. The
 * returned row profile has one entry per measured row and the column profile one entry
 * per measured column, each the share of that line that is ink (see the file comment for
 * the normalisation).
 *
 * A mask with no ink at all is well formed and yields profiles of zeros with
 * `inkRatio: 0`; the caller can chain {@link findRules} and {@link buildGrid} on that
 * result and receive a documented refusal rather than an exception.
 *
 * Throws {@link TableGridError} with `empty-mask` when the dimensions are not positive,
 * `short-buffer` when the buffer cannot hold `width * height` values, `invalid-region`
 * when the region does not fit the mask, and `invalid-options` for a negative
 * `inkThreshold`.
 */
export function reduceProfile(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  options: ReduceProfileOptions = {},
): InkProfile {
  if (options === null || typeof options !== 'object') {
    throw new TableGridError('invalid-options', 'reduceProfile: options must be an object.');
  }
  const mask = maskSize(pixels, width, height);
  const region = regionOf(options.region, mask);
  const inkThreshold = inkThresholdOf(options.inkThreshold);

  const rows = new Array<number>(region.height).fill(0);
  const columns = new Array<number>(region.width).fill(0);
  let ink = 0;

  for (let y = 0; y < region.height; y++) {
    const first = (region.y + y) * mask.width + region.x;
    let rowInk = 0;
    for (let x = 0; x < region.width; x++) {
      if ((pixels[first + x] ?? 0) <= inkThreshold) continue;
      rowInk += 1;
      columns[x] = (columns[x] ?? 0) + 1;
    }
    rows[y] = rowInk / region.width;
    ink += rowInk;
  }

  for (let x = 0; x < region.width; x++) columns[x] = (columns[x] ?? 0) / region.height;

  return {
    width: region.width,
    height: region.height,
    rows,
    columns,
    inkRatio: ink / (region.width * region.height),
  };
}

/**
 * Finds the rule bands of one profile axis.
 *
 * A run is every maximal stretch of indices whose ink fraction is strictly above
 * `threshold` ({@link RULE_INK_THRESHOLD} by default). Two neighbouring runs are then
 * joined when they are at most `mergeGap` indices apart *and* the indices between them
 * still carry at least {@link MERGE_MIN_INK_RATIO} of the threshold's ink: that is a rule
 * whose ink thinned out, not two rules with white space between them. Finally every band
 * thinner than `minThickness` ({@link MIN_RULE_THICKNESS} by default) is dropped, which is
 * what rejects a single-index speck.
 *
 * The profile is not modified and the result is ordered from the first index to the last.
 * An empty profile, or one with no index above the threshold, yields `[]`: having no rules
 * is a measurement, not an error, and {@link buildGrid} turns it into a refusal with a
 * reason.
 *
 * Throws {@link TableGridError} with `invalid-profile` when the selected axis is not an
 * array of fractions in 0..1, and with `invalid-options` for an axis name, threshold,
 * thickness or merge gap outside its documented range.
 */
export function findRules(profile: InkProfile, options: FindRulesOptions = {}): RuleBand[] {
  if (options === null || typeof options !== 'object') {
    throw new TableGridError('invalid-options', 'findRules: options must be an object.');
  }
  const axis = axisOf(options.axis);
  const values = profileValues(profile, axis);
  const threshold = thresholdOf(options.threshold);
  const minThickness = countOf(options.minThickness, MIN_RULE_THICKNESS, 'minThickness', 1);
  const mergeGap = countOf(options.mergeGap, MERGE_GAP, 'mergeGap', 0);
  const weakInk = threshold * MERGE_MIN_INK_RATIO;

  const bands: RuleBand[] = [];
  for (const run of mergeRuns(strongRuns(values, threshold), values, weakInk, mergeGap)) {
    const thickness = run.end - run.start + 1;
    if (thickness < minThickness) continue;
    let peak = 0;
    for (let index = run.start; index <= run.end; index++) {
      const value = values[index] ?? 0;
      if (value > peak) peak = value;
    }
    bands.push({
      start: run.start,
      end: run.end,
      thickness,
      peak,
      center: (run.start + run.end) / 2,
    });
  }
  return bands;
}

/**
 * Builds the cell grid of a table from its row rules and column rules.
 *
 * Two rules bound one band, so `n` rules on an axis make `n - 1` bands and the result has
 * `(rows - 1) * (columns - 1)` cells. A cell starts at the pixel after the rule that opens
 * its band and ends before the rule that closes it, so cell rects are disjoint and never
 * contain rule ink; `options.originX`/`originY` are added so a caller that measured a
 * region can address mask pixels.
 *
 * `confidence` is `1 - the worst axis's pitch variation`, where the pitch is the distance
 * between neighbouring rule starts and the variation is the population standard deviation
 * over the mean (the coefficient of variation). A uniform grid therefore scores 1, and a
 * grid whose pitches differ by half their mean scores 0.5. A variation above
 * `options.spacingTolerance` ({@link MAX_SPACING_VARIATION} by default) adds a
 * `non-uniform-spacing` reason whose `variation` and message carry the measured numbers,
 * and rules that touch add a `touching-rules` reason because the band between them has no
 * interior.
 *
 * Refuses, without throwing, when either axis has fewer than {@link MIN_GRID_RULES} rules:
 * the result then has no cells, `confidence: 0` and one `too-few-rules` reason per failing
 * axis. An empty rule list on both axes is a refusal too, so a blank mask ends as a reason
 * rather than as an empty table that looks measured.
 *
 * Throws {@link TableGridError} with `invalid-rules` when a rule list is not an array of
 * ordered, non-overlapping `{ start, end }` ranges, and with `invalid-options` for a
 * non-finite origin or a tolerance outside 0..1.
 */
export function buildGrid(
  rowRules: readonly RuleBand[],
  columnRules: readonly RuleBand[],
  options: BuildGridOptions = {},
): TableGrid {
  if (options === null || typeof options !== 'object') {
    throw new TableGridError('invalid-options', 'buildGrid: options must be an object.');
  }
  const rowBounds = ruleBoundsOf(rowRules, 'row');
  const columnBounds = ruleBoundsOf(columnRules, 'column');
  const origin = originOf(options);
  const tolerance = variationToleranceOf(options.spacingTolerance);

  const missing: GridReason[] = [];
  if (rowBounds.length < MIN_GRID_RULES) missing.push(missingRulesReason('row', rowBounds.length));
  if (columnBounds.length < MIN_GRID_RULES) missing.push(missingRulesReason('column', columnBounds.length));
  if (missing.length > 0) return { rows: 0, columns: 0, cells: [], confidence: 0, reasons: missing };

  const rowSpacing = spacingOf(rowBounds);
  const columnSpacing = spacingOf(columnBounds);
  const reasons: GridReason[] = [];
  if (rowSpacing.variation > tolerance) reasons.push(spacingReason('row', rowSpacing));
  if (columnSpacing.variation > tolerance) reasons.push(spacingReason('column', columnSpacing));

  const rowInteriors = adjacentInteriors(rowBounds);
  const columnInteriors = adjacentInteriors(columnBounds);

  rowInteriors.forEach((interior, row) => {
    if (interior.extent === 0) reasons.push(touchingReason('row', row));
  });
  columnInteriors.forEach((interior, column) => {
    if (interior.extent === 0) reasons.push(touchingReason('column', column));
  });

  const cells: GridCell[] = [];
  rowInteriors.forEach((vertical, row) => {
    columnInteriors.forEach((horizontal, col) => {
      cells.push({
        row,
        col,
        x: origin.x + horizontal.start,
        y: origin.y + vertical.start,
        width: horizontal.extent,
        height: vertical.extent,
      });
    });
  });

  const variation = Math.max(rowSpacing.variation, columnSpacing.variation);
  return {
    rows: rowInteriors.length,
    columns: columnInteriors.length,
    cells,
    confidence: round2(clamp01(1 - variation)),
    reasons,
  };
}

interface MaskSize {
  width: number;
  height: number;
}

interface Run {
  start: number;
  end: number;
}

/** A validated rule range: only the two fields the geometry needs. */
interface RuleBounds {
  start: number;
  end: number;
}

/** The empty space between one rule and the next, in region pixels. */
interface BandInterior {
  start: number;
  extent: number;
}

interface SpacingSummary {
  /** Mean pitch between neighbouring rule starts, in pixels. */
  mean: number;
  /** Smallest pitch, in pixels. */
  min: number;
  /** Largest pitch, in pixels. */
  max: number;
  /** Population standard deviation of the pitch over its mean. */
  variation: number;
}

/** `row` and `column` name a single axis; the profiles use the plural. */
type AxisKind = 'row' | 'column';

function maskSize(pixels: ArrayLike<number>, width: number, height: number): MaskSize {
  if (!pixels || typeof pixels !== 'object' || typeof pixels.length !== 'number') {
    throw new TableGridError('empty-mask', 'reduceProfile: a mask needs an array-like pixel buffer.');
  }
  const columns = Math.floor(width);
  const rows = Math.floor(height);
  if (!Number.isFinite(columns) || !Number.isFinite(rows) || columns <= 0 || rows <= 0) {
    throw new TableGridError(
      'empty-mask',
      `reduceProfile: a mask needs a positive width and height, got ${width}x${height}.`,
    );
  }
  const needed = columns * rows;
  if (pixels.length < needed) {
    throw new TableGridError(
      'short-buffer',
      `reduceProfile: a ${columns}x${rows} mask needs ${needed} values, got ${pixels.length}.`,
    );
  }
  return { width: columns, height: rows };
}

function regionOf(value: GridRegion | undefined, mask: MaskSize): GridRegion {
  if (value === undefined) return { x: 0, y: 0, width: mask.width, height: mask.height };
  if (!value || typeof value !== 'object') {
    throw new TableGridError('invalid-region', 'reduceProfile: region must be an object with x, y, width and height.');
  }
  const x = Math.floor(value.x);
  const y = Math.floor(value.y);
  const width = Math.floor(value.width);
  const height = Math.floor(value.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new TableGridError(
      'invalid-region',
      `reduceProfile: region values must be finite numbers, got ${String(value.x)},${String(value.y)} ${String(value.width)}x${String(value.height)}.`,
    );
  }
  if (x < 0 || y < 0 || width < 1 || height < 1) {
    throw new TableGridError(
      'invalid-region',
      `reduceProfile: region ${width}x${height} at ${x},${y} must have a positive size and a non-negative origin.`,
    );
  }
  if (x + width > mask.width || y + height > mask.height) {
    throw new TableGridError(
      'invalid-region',
      `reduceProfile: region ${width}x${height} at ${x},${y} does not fit a ${mask.width}x${mask.height} mask.`,
    );
  }
  return { x, y, width, height };
}

function inkThresholdOf(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new TableGridError(
      'invalid-options',
      `reduceProfile: inkThreshold must be a finite number of at least 0, got ${String(value)}.`,
    );
  }
  return value;
}

function axisOf(value: RuleAxis | undefined): RuleAxis {
  if (value === undefined) return 'rows';
  if (value !== 'rows' && value !== 'columns') {
    throw new TableGridError('invalid-options', `findRules: axis must be 'rows' or 'columns', got ${String(value)}.`);
  }
  return value;
}

function thresholdOf(value: number | undefined): number {
  if (value === undefined) return RULE_INK_THRESHOLD;
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new TableGridError(
      'invalid-options',
      `findRules: threshold must be above 0 and at most 1, got ${String(value)}.`,
    );
  }
  return value;
}

function countOf(value: number | undefined, fallback: number, name: string, minimum: number): number {
  if (value === undefined) return fallback;
  const count = Math.floor(value);
  if (!Number.isFinite(count) || count < minimum) {
    throw new TableGridError(
      'invalid-options',
      `findRules: ${name} must be a whole number of at least ${minimum}, got ${String(value)}.`,
    );
  }
  return count;
}

/**
 * The selected axis as a checked array of fractions. A raw count profile or a profile with
 * a hole in it is a caller bug, so it is refused instead of being read as a huge ink share.
 */
function profileValues(profile: InkProfile, axis: RuleAxis): number[] {
  if (profile === null || typeof profile !== 'object') {
    throw new TableGridError('invalid-profile', 'findRules: a profile is needed.');
  }
  const values: unknown = axis === 'rows' ? profile.rows : profile.columns;
  if (!Array.isArray(values)) {
    throw new TableGridError('invalid-profile', `findRules: the ${axis} profile must be a number array.`);
  }
  const checked: number[] = [];
  for (let index = 0; index < values.length; index++) {
    const value: unknown = values[index];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -EPSILON || value > 1 + EPSILON) {
      throw new TableGridError(
        'invalid-profile',
        `findRules: the ${axis} profile at index ${index} must be an ink fraction in 0..1, got ${String(value)}.`,
      );
    }
    checked.push(value);
  }
  return checked;
}

function strongRuns(values: readonly number[], threshold: number): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let index = 0; index < values.length; index++) {
    const above = (values[index] ?? 0) > threshold;
    if (above && start < 0) start = index;
    if (!above && start >= 0) {
      runs.push({ start, end: index - 1 });
      start = -1;
    }
  }
  if (start >= 0) runs.push({ start, end: values.length - 1 });
  return runs;
}

/**
 * Joins runs that a broken rule left apart. Both the distance and the ink in the gap have
 * to agree: empty pixels are white space between two rules, whatever their distance.
 */
function mergeRuns(runs: readonly Run[], values: readonly number[], weakInk: number, mergeGap: number): Run[] {
  const merged: Run[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (
      last
      && run.start - last.end - 1 <= mergeGap
      && gapHoldsInk(values, last.end + 1, run.start - 1, weakInk)
    ) {
      last.end = run.end;
    } else {
      merged.push({ start: run.start, end: run.end });
    }
  }
  return merged;
}

function gapHoldsInk(values: readonly number[], from: number, to: number, weakInk: number): boolean {
  for (let index = from; index <= to; index++) {
    if ((values[index] ?? 0) < weakInk) return false;
  }
  return true;
}

const RULE_NOUNS: Record<AxisKind, string> = { row: 'row', column: 'column' };

function ruleBoundsOf(bands: readonly RuleBand[], kind: AxisKind): RuleBounds[] {
  if (!Array.isArray(bands)) {
    throw new TableGridError('invalid-rules', `buildGrid: ${RULE_NOUNS[kind]} rules must be an array.`);
  }
  const bounds: RuleBounds[] = [];
  let previousEnd = -1;
  for (let index = 0; index < bands.length; index++) {
    const band: unknown = bands[index];
    if (band === null || typeof band !== 'object') {
      throw new TableGridError(
        'invalid-rules',
        `buildGrid: ${RULE_NOUNS[kind]} rule ${index} must be an object with start and end.`,
      );
    }
    const candidate = band as Partial<RuleBand>;
    const start = candidate.start;
    const end = candidate.end;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new TableGridError(
        'invalid-rules',
        `buildGrid: ${RULE_NOUNS[kind]} rule ${index} needs finite start and end indices.`,
      );
    }
    if (start < 0) {
      throw new TableGridError(
        'invalid-rules',
        `buildGrid: ${RULE_NOUNS[kind]} rule ${index} starts at ${start}, but indices are not negative.`,
      );
    }
    if (end < start) {
      throw new TableGridError(
        'invalid-rules',
        `buildGrid: ${RULE_NOUNS[kind]} rule ${index} ends at ${end} before it starts at ${start}.`,
      );
    }
    if (start <= previousEnd) {
      throw new TableGridError(
        'invalid-rules',
        `buildGrid: ${RULE_NOUNS[kind]} rule ${index} starts at ${start}, which is not after the previous rule ends at ${previousEnd}.`,
      );
    }
    previousEnd = end;
    bounds.push({ start, end });
  }
  return bounds;
}

function originOf(options: BuildGridOptions): { x: number; y: number } {
  const x = options.originX ?? 0;
  const y = options.originY ?? 0;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TableGridError(
      'invalid-options',
      `buildGrid: originX and originY must be finite numbers, got ${String(options.originX)},${String(options.originY)}.`,
    );
  }
  return { x, y };
}

function variationToleranceOf(value: number | undefined): number {
  if (value === undefined) return MAX_SPACING_VARIATION;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TableGridError(
      'invalid-options',
      `buildGrid: spacingTolerance must be in 0..1, got ${String(value)}.`,
    );
  }
  return value;
}

function adjacentInteriors(bounds: readonly RuleBounds[]): BandInterior[] {
  const interiors: BandInterior[] = [];
  for (let index = 0; index + 1 < bounds.length; index++) {
    const previous = bounds[index];
    const next = bounds[index + 1];
    if (!previous || !next) continue;
    const start = previous.end + 1;
    interiors.push({ start, extent: Math.max(0, next.start - start) });
  }
  return interiors;
}

/** Pitch between rule starts, so a thicker rule does not shift the measured spacing. */
function spacingOf(bounds: readonly RuleBounds[]): SpacingSummary {
  const pitches: number[] = [];
  for (let index = 0; index + 1 < bounds.length; index++) {
    const current = bounds[index];
    const next = bounds[index + 1];
    if (!current || !next) continue;
    pitches.push(next.start - current.start);
  }
  if (pitches.length === 0) return { mean: 0, min: 0, max: 0, variation: 0 };

  const mean = pitches.reduce((total, pitch) => total + pitch, 0) / pitches.length;
  let min = pitches[0] ?? mean;
  let max = min;
  for (const pitch of pitches) {
    if (pitch < min) min = pitch;
    if (pitch > max) max = pitch;
  }
  if (mean <= 0) return { mean, min, max, variation: 0 };
  const variance = pitches.reduce((total, pitch) => total + (pitch - mean) ** 2, 0) / pitches.length;
  return { mean, min, max, variation: Math.sqrt(variance) / mean };
}

function missingRulesReason(kind: AxisKind, count: number): GridReason {
  const noun = RULE_NOUNS[kind];
  const message = count === 0
    ? `No ${noun} rules were found in the ink profile, and a grid needs at least ${MIN_GRID_RULES} to bound one ${noun}.`
    : `Only one ${noun} rule was found, and a grid needs at least ${MIN_GRID_RULES} to bound one ${noun}.`;
  return { code: 'too-few-rules', message };
}

function spacingReason(kind: AxisKind, spacing: SpacingSummary): GridReason {
  const noun = RULE_NOUNS[kind];
  return {
    code: 'non-uniform-spacing',
    message: `The ${noun} rules are not evenly spaced: the gaps between rule starts run from `
      + `${formatPixels(spacing.min)} to ${formatPixels(spacing.max)} px around a mean of `
      + `${formatPixels(spacing.mean)} px (variation ${formatPercent(spacing.variation)} of the mean).`,
    variation: spacing.variation,
  };
}

function touchingReason(kind: AxisKind, band: number): GridReason {
  const noun = RULE_NOUNS[kind];
  const label = noun.charAt(0).toUpperCase() + noun.slice(1);
  const dimension = kind === 'row' ? 'height' : 'width';
  return {
    code: 'touching-rules',
    message: `${label} band ${band} has no interior: its bounding rules touch, so its cells are 0 px in ${dimension}.`,
  };
}

/** Pixels with one decimal at most, so a message reads "12 px" and not "12.0 px". */
function formatPixels(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  const factor = 10 ** CONFIDENCE_DECIMALS;
  return Math.round(value * factor) / factor;
}
