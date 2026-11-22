/**
 * Fitting a translation into its source box (backlog item G07).
 *
 * A translated block rarely needs the same room as the sentence it replaces. German runs
 * longer than English, Vietnamese longer than Chinese, and a two-line source line often
 * becomes three lines of target text. Drawing that text into the source rectangle without
 * a decision leaves only bad options: clip it, and the reader loses the end of a sentence
 * without ever being told; shrink it, and nobody knows how far it went. This module makes
 * the decision, in a documented order, and reports what it did.
 *
 * Order of steps, and why this order:
 *
 * 1. **Wrap** at the requested size (`fontSize`, default {@link DEFAULT_FONT_SIZE}). Wrapping is
 *    free: no glyph changes, only where the line breaks. Whitespace is the only thing it
 *    rewrites; every visible character survives.
 * 2. **Shrink** by {@link FONT_SIZE_STEP} points at a time, from the requested size down to
 *    `minFontSize` (default {@link DEFAULT_MIN_FONT_SIZE}), and stop at the largest size that
 *    fits. Points are the familiar unit; the step is small enough that the result rarely
 *    looks different from one line to the next.
 * 3. **Condense** at that floor, when `allowCondense` is not `false`: every glyph advance is
 *    multiplied by a tracking factor, starting at `1 - {@link CONDENSE_STEP}` and stopping at
 *    {@link MIN_TRACKING_FACTOR} (a 10 % tightening). Condensing buys characters per line
 *    without touching the point size, so the text stays as tall as the reader expects. A
 *    factor below {@link MIN_TRACKING_FACTOR} looks like a mistake, which is why the floor
 *    exists.
 * 4. **Overflow** when nothing fits: keep the smallest size and the tightest tracking, draw as
 *    many lines as the box holds, mark the last one with {@link OVERFLOW_MARKER}, and report
 *    the dropped characters and the dropped text. A word that cannot be broken is kept whole
 *    on its own line and reported, never cut: an invisible word break is worse than a
 *    visible overflow.
 *
 * Fit rule, in the units the estimate uses:
 *
 * - One character advances `fontSize * charWidthRatio * tracking` points. A line holds
 *   `floor(box.width / advance)` characters, and at least one even in a box narrower than a
 *   glyph.
 * - One line advances `fontSize * lineHeight` points vertically, where `lineHeight` is a
 *   multiple of the font size (1.2 = 120 % leading) and not a point value, so it scales with
 *   the size. The box holds `floor(box.height / (fontSize * lineHeight))` whole lines; a
 *   partial line does not count as fitting.
 * - `maxLines`, when supplied, caps the line count below what the height would allow. That is
 *   the cell or heading that may only show three lines however tall it is.
 * - Text fits when every line is no wider than the box and the line count is within the line
 *   budget. A line made of one unbreakable word is the only way a line can be too wide.
 *
 * Wrap rule: the text is split at its own line breaks, each paragraph is split at whitespace,
 * a run of whitespace becomes one space, and a space that sits at a line break disappears. A
 * Latin word is never broken, so a URL or a long compound stays whole; a word that does not
 * fit the line, even alone, is reported through `unbreakableWords` and `overflow`. A character
 * in a CJK block is its own wrap unit, so Chinese, Japanese and Korean paragraphs break
 * without needing spaces, while mixed text keeps its original spacing.
 *
 * Contract:
 *
 * - **Pure and deterministic.** No clock, no randomness, no DOM, no I/O, no dependency. The
 *   same text, box and options always produce the same result, field for field.
 * - **Nothing is lost silently.** When `clippedCharacters` is 0, every non-whitespace character
 *   of the input is present in `lines`; when it is greater than 0, `leftover` holds the text
 *   that was dropped and the count is the number of non-whitespace characters in it. The
 *   marker that is appended to the last kept line is an addition, never a replacement.
 * - **Nothing is over-claimed.** `strategy` names the step that succeeded, `reasons` names the
 *   evidence (stable machine-readable codes, never user-facing prose), and `overflow` says the
 *   text still does not fit after every step this module is allowed to take.
 * - **A size is never raised.** `minFontSize` above the requested size is capped at the request,
 *   because growing text to reach a floor is a surprise no caller asked for.
 * - **Unusable geometry is refused.** A box that is not an object, or whose width or height is
 *   not a positive finite number of points, throws a `RangeError`: a zero-width box has no
 *   answer this module can give, and returning text with no lines would hide the caller's bug.
 *   {@link annotateFits} refuses a whole batch the same way, naming the block.
 * - Lines are reported with at most two decimals of a point. Sizes are computed in half-point
 *   steps, so the reported value is one a writer can use directly.
 *
 * What this module does not do: it has no glyph metrics, no shaping, no kerning and no
 * hyphenation, so the character budget is an estimate and a proportional face with wide glyphs
 * needs a larger `charWidthRatio`; CJK glyphs are costed as one character unless the caller
 * raises it. It does not draw, break a word, mirror bidirectional text, or decide that a
 * translation is short enough to keep its source box. `src/pdf/layout.ts` has a `fitText` of its
 * own that measures with a caller-supplied function; that one is for drawing text whose face is
 * already loaded, this one is for deciding before a writer exists.
 */

// --- Public shape ----------------------------------------------------------

/** A box the text has to fit into, in PDF points. A reader `Rect` is structurally compatible. */
export interface FitBox {
  width: number;
  height: number;
}

/**
 * Which step produced the result.
 *
 * - `none`: the text fit at the requested size, wrapped only.
 * - `shrink`: a smaller size within `minFontSize` fit.
 * - `condense`: only reduced tracking, at the smallest allowed size, fit.
 * - `overflow`: nothing fit; lines were clipped and marked, or a line is still too wide.
 */
export type FitStrategy = 'none' | 'shrink' | 'condense' | 'overflow';

/** Every strategy, in the order the steps are tried once wrapping has failed. */
export const FIT_STRATEGIES: readonly FitStrategy[] = ['none', 'shrink', 'condense', 'overflow'];

/**
 * The size to use when the caller names none, in points.
 *
 * Matches the body default the bilingual planner uses (`src/export/pairs.ts`), so a block
 * carrying no measured size still lands on a sane page.
 */
export const DEFAULT_FONT_SIZE = 10;

/**
 * The smallest size this module will shrink to when the caller names none, in points.
 *
 * Seven points matches the drawing-side default in `src/pdf/layout.ts`: below that a
 * translated paragraph is technically present and practically unreadable.
 */
export const DEFAULT_MIN_FONT_SIZE = 7;

/**
 * The line advance assumed when the caller names none, as a multiple of the font size.
 *
 * 1.2 is the familiar 120 % leading of a typeset body. It is a multiple rather than a point
 * value on purpose: leading has to shrink with the size, not stay at the original 12 pt
 * while the text drops to 7.
 */
export const DEFAULT_LINE_HEIGHT = 1.2;

/**
 * The average character advance assumed when the caller names none, as a fraction of the size.
 *
 * 0.5 is the same estimate `src/export/pairs.ts` uses: half an em per Latin character, which
 * is close to a text face's average once wide and narrow letters are averaged.
 */
export const DEFAULT_CHAR_WIDTH_RATIO = 0.5;

/** How much one shrink step removes, in points. */
export const FONT_SIZE_STEP = 0.5;

/** How much one condense step tightens the tracking, as a fraction of the advance. */
export const CONDENSE_STEP = 0.02;

/**
 * The tightest tracking factor this module will apply.
 *
 * 0.9 is a 10 % tightening: enough to win the last character of a line, little enough that a
 * reader still reads it as text rather than as a squeezed image.
 */
export const MIN_TRACKING_FACTOR = 0.9;

/**
 * Appended to the last kept line when text had to be dropped.
 *
 * A single ellipsis, with no space, so it reads as the cut it is. The marker itself is not
 * counted in `clippedCharacters` and never replaces a character.
 */
export const OVERFLOW_MARKER = '…';

/**
 * Most sizes the shrink walk will try, so an absurd request cannot spin forever.
 *
 * 2000 half-point steps is 1000 pt of shrinking, far past any real page; the walk then jumps
 * to `minFontSize`, which is always tried last.
 */
export const MAX_FONT_SIZE_STEPS = 2000;

/** Options shared by every block of one call. Every field is optional and documented below. */
export interface FitOptions {
  /** Size the text would be set in if nothing had to give, in points. Default 10. */
  fontSize?: number;
  /** Smallest size shrinking may reach, in points. Default 7; capped at `fontSize`. */
  minFontSize?: number;
  /** Line advance as a multiple of the font size. Default 1.2. */
  lineHeight?: number;
  /** Average advance of one character as a fraction of the font size. Default 0.5. */
  charWidthRatio?: number;
  /**
   * Whether the condense step may run. Default `true`: the documented order is shrink, then
   * condense, then overflow, so a caller that wants text never tightened passes `false`.
   */
  allowCondense?: boolean;
  /**
   * Most lines the box may show, whatever its height allows. A fractional value is floored; a
   * negative one is read as 0. Absent means the height alone decides.
   */
  maxLines?: number;
}

/** What fitting one text did, in the terms a writer and a warning need. */
export interface TextFitResult {
  /** Size to draw at, in points, with at most two decimals. */
  fontSize: number;
  /** The lines to draw, in order, never empty strings. Clipped lines are absent, by design. */
  lines: string[];
  /** True when the text still does not fit: something was clipped, or a line is too wide. */
  overflow: boolean;
  /**
   * Non-whitespace code points dropped by clipping; 0 when nothing was dropped. Whitespace is
   * not counted: wrapping collapses runs of spaces and turns a space at a line break into the
   * break, which is re-flowing, not losing content.
   */
  clippedCharacters: number;
  /** The step that produced this result. */
  strategy: FitStrategy;
  /** Glyph-advance multiplier applied by the condense step; 1 when no condense ran. */
  trackingFactor: number;
  /**
   * The dropped text, its lines joined by single spaces; empty when nothing was dropped. Kept
   * so a caller can show what was cut or write it somewhere else instead of losing it.
   */
  leftover: string;
  /** Words that could not fit a line of their own, and so were kept whole and reported. */
  unbreakableWords: number;
  /**
   * Stable, machine-readable evidence; never user-facing prose. One code per observation, in
   * this order:
   *
   * - `fit:none` — nothing had to give.
   * - `fit:shrink=<pt>` — the size used is below the request.
   * - `fit:condense=<factor>` — the tracking factor applied.
   * - `fit:wide=<count>` — lines still wider than the box.
   * - `fit:unbreakable=<count>` — words kept whole because they fit no line.
   * - `fit:clipped=<count>` — characters dropped, matching `clippedCharacters`.
   * - `fit:overflow=<kept>/<needed>` — lines kept out of the lines the text needed.
   */
  reasons: string[];
}

/** One block for {@link annotateFits}: the text and the box it has to live in. */
export interface FitBlock {
  /** Reader block id (for example `p3-r0`); a block without one is reported as `block-{index}`. */
  id?: string;
  /** The translated text. A non-string is read as empty rather than trusted. */
  text: string;
  /** The source block's box in points. */
  box: FitBox;
  /** Per-block overrides, merged over the options the call was made with. */
  options?: FitOptions;
}

/** One block's fit, with the identity an export needs to point at it. */
export interface FitBlockResult {
  /** The block's id, or `block-{index}` when it carried none. */
  id: string;
  /** 0-based position in the input array; the array is never reordered. */
  index: number;
  result: TextFitResult;
}

/**
 * What a whole document's fit did, so an export can warn before it writes.
 *
 * `shrunk + condensed + overflowed + (blocks - those three)` is `blocks`: every block takes
 * exactly one strategy. The character and word totals are sums, for a single sentence such as
 * "12 characters were dropped from 3 blocks".
 */
export interface FitSummary {
  /** Blocks annotated. */
  blocks: number;
  /** Blocks that fit only after shrinking the point size. */
  shrunk: number;
  /** Blocks that fit only after condensing the tracking. */
  condensed: number;
  /** Blocks that still do not fit; their results carry the clipped characters and leftover. */
  overflowed: number;
  /** Non-whitespace characters dropped across every block. */
  clippedCharacters: number;
  /** Words that could not fit a line of their own across every block. */
  unbreakableWords: number;
}

/** The result of {@link annotateFits}: one entry per block, plus the counts to warn with. */
export interface FitsAnnotation {
  /** Per-block results, in input order. */
  results: FitBlockResult[];
  summary: FitSummary;
}

// --- Fitting ---------------------------------------------------------------

/**
 * Fits one text into one box, in the documented order (wrap, shrink, condense, overflow).
 *
 * The result is the *best* outcome the order allows: the largest size that fits, then the
 * lightest tracking that fits, then — when nothing fits — the smallest size and the tightest
 * tracking, with as few characters dropped as possible. `overflow` is true in that last case,
 * and `clippedCharacters` plus `leftover` say what was lost; see {@link TextFitResult}.
 *
 * A box without a positive finite width and height is refused with a `RangeError`, and so is
 * an options object that cannot be read: this function never guesses a size for a box that has
 * no area.
 */
export function fitText(text: string, box: FitBox, options?: FitOptions): TextFitResult {
  const source = typeof text === 'string' ? text : '';
  const frame = readBox(box, 'fitText');
  const settings = readSettings(options);
  const requested = round2(settings.requested);
  const sizes = fontSizes(settings);

  let chosen: Attempt | null = null;
  let strategy: FitStrategy = 'none';

  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index];
    if (size === undefined) continue;
    const candidate = attemptFit(source, frame, size, 1, settings);
    if (!fits(candidate)) continue;
    chosen = candidate;
    strategy = index === 0 ? 'none' : 'shrink';
    break;
  }

  if (chosen === null) {
    for (const factor of trackingFactors(settings.allowCondense)) {
      const candidate = attemptFit(source, frame, settings.floor, factor, settings);
      if (!fits(candidate)) continue;
      chosen = candidate;
      strategy = 'condense';
      break;
    }
  }

  if (chosen === null) {
    // Nothing fits. Keep the least it can cost the reader: the tightest tracking allowed, even
    // though it did not make the text fit, drops fewer characters than the untracked attempt.
    const factors = trackingFactors(settings.allowCondense);
    const tightest = factors.length > 0 ? factors[factors.length - 1] ?? 1 : 1;
    chosen = attemptFit(source, frame, settings.floor, tightest, settings);
    strategy = 'overflow';
  }

  return finalize(chosen, strategy, requested);
}

/**
 * Fits every block of a document, so an export can warn before it writes.
 *
 * The blocks are annotated in input order and the input is never reordered or mutated.
 * `options` are the defaults for every block; a block's own `options` win where they name a
 * field. A block is identified by its `id`, or by `block-{index}` when it has none, which is
 * what a warning should quote.
 *
 * Refusals are not softened: a block that is not an object, or whose box has no area, makes
 * the whole call throw with the block named, because skipping it silently would let an export
 * report a clean document it never checked.
 */
export function annotateFits(blocks: readonly FitBlock[], options?: FitOptions): FitsAnnotation {
  if (!Array.isArray(blocks)) {
    throw new TypeError('annotateFits needs an array of blocks.');
  }

  const results: FitBlockResult[] = [];
  let shrunk = 0;
  let condensed = 0;
  let overflowed = 0;
  let clippedCharacters = 0;
  let unbreakableWords = 0;

  blocks.forEach((block, index) => {
    if (typeof block !== 'object' || block === null) {
      throw new TypeError(`annotateFits needs an object at blocks[${index}].`);
    }
    const box = readBox(block.box, `blocks[${index}].box`);
    const text = typeof block.text === 'string' ? block.text : '';
    const result = fitText(text, box, mergeOptions(options, block.options));

    if (result.strategy === 'shrink') shrunk += 1;
    else if (result.strategy === 'condense') condensed += 1;
    else if (result.strategy === 'overflow') overflowed += 1;
    clippedCharacters += result.clippedCharacters;
    unbreakableWords += result.unbreakableWords;

    const id = typeof block.id === 'string' && block.id.length > 0 ? block.id : `block-${index}`;
    results.push({ id, index, result });
  });

  return {
    results,
    summary: {
      blocks: results.length,
      shrunk,
      condensed,
      overflowed,
      clippedCharacters,
      unbreakableWords,
    },
  };
}

// --- Steps -----------------------------------------------------------------

/** The options after defaults, bounds and units are applied. */
interface Settings {
  requested: number;
  floor: number;
  lineHeight: number;
  charWidthRatio: number;
  allowCondense: boolean;
  maxLines: number | null;
}

/** One size and tracking factor, wrapped, with the verdict computed. */
interface Attempt {
  fontSize: number;
  trackingFactor: number;
  lines: string[];
  unbreakableWords: number;
  /** Lines whose estimated width exceeds the box: a word that could not break. */
  wideLines: number;
  /** Whole lines the box (and `maxLines`) will hold at this size. */
  lineLimit: number;
}

/** A unit the wrapper can place: a word, or one character of a script written without spaces. */
interface WrapUnit {
  text: string;
  /** Length in code points, so an astral character costs one. */
  length: number;
  /** True when whitespace separated this unit from the one before it in the source. */
  space: boolean;
}

/** The wrapped lines plus the words that could not fit a line of their own. */
interface Wrapped {
  lines: string[];
  unbreakableWords: number;
}

/** The default no-op when a caller passes nothing at all. */
const NO_OPTIONS: FitOptions = {};

/** Slack for floating-point comparisons of a budget that is mathematically whole. */
const EPSILON = 1e-9;

/** One whitespace character; also matches the ideographic space. */
const WHITESPACE_PATTERN = /\s/u;

/**
 * A character a line may break after without breaking a word.
 *
 * The CJK blocks, their punctuation and the full-width forms are written without spaces, so a
 * paragraph set in them would be one endless word under a whitespace-only rule. Each of these
 * is its own wrap unit instead. Latin, Cyrillic, Arabic and the like are not listed: those
 * scripts separate words with spaces, and breaking inside one is a hyphenation decision this
 * module does not make.
 */
const CJK_UNIT_PATTERN =
  /[\u2E80-\u2EFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u31C0-\u31EF\u3200-\u32FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u;

function attemptFit(
  text: string,
  box: FitBox,
  size: number,
  tracking: number,
  settings: Settings,
): Attempt {
  const advance = size * settings.charWidthRatio * tracking;
  const budget = Math.max(1, Math.floor(box.width / advance + EPSILON));
  const wrapped = wrapText(text, budget);
  const lineHeight = size * settings.lineHeight;
  const heightLines = Math.floor(box.height / lineHeight + EPSILON);
  const lineLimit = settings.maxLines === null ? heightLines : Math.min(settings.maxLines, heightLines);
  const wideLines = wrapped.lines.filter(line => Array.from(line).length * advance > box.width + EPSILON).length;

  return {
    fontSize: round2(size),
    trackingFactor: tracking,
    lines: wrapped.lines,
    unbreakableWords: wrapped.unbreakableWords,
    wideLines,
    lineLimit,
  };
}

function fits(attempt: Attempt): boolean {
  return attempt.wideLines === 0 && attempt.lines.length <= attempt.lineLimit;
}

/**
 * Turns a chosen attempt into the reported result, clipping to the line limit.
 *
 * Clipping is the only place a character can be lost, so it is also the only place
 * `leftover` and `clippedCharacters` are filled. The marker goes on the last kept line; a box
 * with room for no line at all reports no lines and drops the whole text, which is a better
 * description than a lone marker.
 */
function finalize(chosen: Attempt, strategy: FitStrategy, requested: number): TextFitResult {
  const lines = [...chosen.lines];
  const needed = lines.length;
  let leftover = '';
  let clippedCharacters = 0;

  if (needed > chosen.lineLimit) {
    const dropped = lines.splice(chosen.lineLimit);
    leftover = dropped.join(' ');
    clippedCharacters = visibleLength(leftover);
    const last = lines.length - 1;
    if (last >= 0) lines[last] = `${lines[last] ?? ''}${OVERFLOW_MARKER}`;
  }

  const overflow = clippedCharacters > 0 || chosen.wideLines > 0;
  const reasons: string[] = [];
  if (strategy === 'none') reasons.push('fit:none');
  if (strategy !== 'none' && chosen.fontSize < requested - EPSILON) {
    reasons.push(`fit:shrink=${formatNumber(chosen.fontSize)}`);
  }
  if (chosen.trackingFactor < 1 - EPSILON) {
    reasons.push(`fit:condense=${formatNumber(chosen.trackingFactor)}`);
  }
  if (chosen.wideLines > 0) reasons.push(`fit:wide=${chosen.wideLines}`);
  if (chosen.unbreakableWords > 0) reasons.push(`fit:unbreakable=${chosen.unbreakableWords}`);
  if (clippedCharacters > 0) reasons.push(`fit:clipped=${clippedCharacters}`);
  if (needed > chosen.lineLimit) reasons.push(`fit:overflow=${lines.length}/${needed}`);

  return {
    fontSize: chosen.fontSize,
    lines,
    overflow,
    clippedCharacters,
    strategy,
    trackingFactor: chosen.trackingFactor,
    leftover,
    unbreakableWords: chosen.unbreakableWords,
    reasons,
  };
}

// --- Wrapping --------------------------------------------------------------

/**
 * Wraps a text into lines of at most `budget` code points.
 *
 * Hard line breaks start a new line; a whitespace-only paragraph is not content and is
 * dropped. Greedy left-to-right filling is deliberate: it keeps lines full, and it makes the
 * result a pure function of the text, so two runs cannot disagree about where a line broke.
 */
function wrapText(text: string, budget: number): Wrapped {
  const lines: string[] = [];
  let unbreakableWords = 0;

  for (const paragraph of text.split(/\r\n|\r|\n/u)) {
    if (paragraph.trim().length === 0) continue;
    let current = '';
    let currentLength = 0;

    for (const unit of splitUnits(paragraph)) {
      const separator = current === '' ? '' : unit.space ? ' ' : '';
      const length = currentLength + separator.length + unit.length;
      if (length <= budget) {
        current += separator + unit.text;
        currentLength = length;
        continue;
      }
      if (current !== '') {
        lines.push(current);
        current = '';
        currentLength = 0;
      }
      if (unit.length <= budget) {
        current = unit.text;
        currentLength = unit.length;
        continue;
      }
      // A word wider than a whole line cannot be wrapped, only reported. Breaking it would be
      // a silent hyphenation decision, which belongs to a typographer, not to a fitter.
      lines.push(unit.text);
      unbreakableWords += 1;
    }

    if (current !== '') lines.push(current);
  }

  return { lines, unbreakableWords };
}

/** Splits one paragraph into words and single CJK characters, with their spacing. */
function splitUnits(paragraph: string): WrapUnit[] {
  const units: WrapUnit[] = [];
  let word = '';
  let spaced = false;

  const flush = (): void => {
    if (word === '') return;
    units.push({ text: word, length: Array.from(word).length, space: spaced });
    word = '';
    spaced = false;
  };

  for (const character of paragraph) {
    if (WHITESPACE_PATTERN.test(character)) {
      flush();
      spaced = true;
      continue;
    }
    if (CJK_UNIT_PATTERN.test(character)) {
      flush();
      units.push({ text: character, length: 1, space: spaced });
      spaced = false;
      continue;
    }
    word += character;
  }
  flush();

  return units;
}

// --- Scheduling ------------------------------------------------------------

/** The sizes to try, largest first: the request, its half-point steps, then the floor. */
function fontSizes(settings: Settings): number[] {
  const sizes: number[] = [];
  let size = settings.requested;
  while (size > settings.floor + EPSILON && sizes.length < MAX_FONT_SIZE_STEPS) {
    sizes.push(round2(size));
    size -= FONT_SIZE_STEP;
  }
  // The floor is always tried, even when the walk stopped at its step cap or the two sizes are
  // closer than one step apart.
  sizes.push(round2(settings.floor));
  return sizes;
}

/**
 * The tracking factors the condense step may try, lightest first.
 *
 * Empty when condensing is not allowed, so a caller never pays for a step it refused.
 */
function trackingFactors(allowCondense: boolean): number[] {
  if (!allowCondense) return [];
  const factors: number[] = [];
  for (let step = 1; step * CONDENSE_STEP <= 1 - MIN_TRACKING_FACTOR + EPSILON; step += 1) {
    factors.push(round2(1 - step * CONDENSE_STEP));
  }
  return factors;
}

// --- Inputs ----------------------------------------------------------------

/**
 * Reads the box, refusing anything that has no area.
 *
 * A zero-width box is not "a box where nothing fits"; it is a reader that produced no
 * geometry, and answering it with text and no lines would hide the fault. A `RangeError` names
 * the input and the value, so the caller can see which block was broken.
 */
function readBox(box: unknown, label: string): FitBox {
  const record = typeof box === 'object' && box !== null
    ? (box as { width?: unknown; height?: unknown })
    : {};
  const width = record.width;
  const height = record.height;

  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
    throw new RangeError(`${label} needs a positive finite width in points; it received ${describeValue(width)}.`);
  }
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
    throw new RangeError(`${label} needs a positive finite height in points; it received ${describeValue(height)}.`);
  }
  return { width, height };
}

/** Applies the documented defaults and the one bound this module enforces (never grow). */
function readSettings(options: FitOptions | undefined): Settings {
  const source: FitOptions = typeof options === 'object' && options !== null ? options : NO_OPTIONS;
  const requested = positiveOr(source.fontSize, DEFAULT_FONT_SIZE);
  const wantedFloor = positiveOr(source.minFontSize, DEFAULT_MIN_FONT_SIZE);

  return {
    requested,
    floor: Math.min(wantedFloor, requested),
    lineHeight: positiveOr(source.lineHeight, DEFAULT_LINE_HEIGHT),
    charWidthRatio: positiveOr(source.charWidthRatio, DEFAULT_CHAR_WIDTH_RATIO),
    allowCondense: source.allowCondense !== false,
    maxLines: readMaxLines(source.maxLines),
  };
}

/** A line cap: floored, never negative, and absent for anything that is not a finite number. */
function readMaxLines(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

/** Merges a block's own options over the call's, field by field; `false` is a value, not a gap. */
function mergeOptions(shared: FitOptions | undefined, own: FitOptions | undefined): FitOptions {
  const merged: FitOptions = {};
  const fontSize = own?.fontSize ?? shared?.fontSize;
  const minFontSize = own?.minFontSize ?? shared?.minFontSize;
  const lineHeight = own?.lineHeight ?? shared?.lineHeight;
  const charWidthRatio = own?.charWidthRatio ?? shared?.charWidthRatio;
  const allowCondense = own?.allowCondense ?? shared?.allowCondense;
  const maxLines = own?.maxLines ?? shared?.maxLines;
  if (fontSize !== undefined) merged.fontSize = fontSize;
  if (minFontSize !== undefined) merged.minFontSize = minFontSize;
  if (lineHeight !== undefined) merged.lineHeight = lineHeight;
  if (charWidthRatio !== undefined) merged.charWidthRatio = charWidthRatio;
  if (allowCondense !== undefined) merged.allowCondense = allowCondense;
  if (maxLines !== undefined) merged.maxLines = maxLines;
  return merged;
}

// --- Small helpers ---------------------------------------------------------

/** Characters a reader can see: code points, whitespace excluded. */
function visibleLength(text: string): number {
  let count = 0;
  for (const character of text) {
    if (!WHITESPACE_PATTERN.test(character)) count += 1;
  }
  return count;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Two decimals, so a size or a factor is stable in a result and in a test. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A number without trailing zeros, locale-independent, so a reason code is byte-stable. */
function formatNumber(value: number): string {
  return String(round2(value));
}

/** A short, safe stand-in for a value a refusal message has to name. */
function describeValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return typeof value;
}
