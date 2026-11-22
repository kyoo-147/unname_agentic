/**
 * The reader's own accessibility rules, as code (backlog N04).
 *
 * Accessibility regressions are usually found by a person noticing something is
 * hard to read, and then by nobody writing it down. This module moves three of
 * the reader's promises into executable form so a regression is a failed test:
 *
 * 1. **Contrast.** {@link contrastRatio} implements the WCAG relative-luminance
 *    formula over sRGB hex colours; {@link checkContrast} turns a batch of
 *    foreground/background pairs into failures that carry the measured ratio and
 *    the ratio the chosen level requires. {@link suggestDarken} and
 *    {@link suggestLighten} answer the follow-up question a failure produces:
 *    what is the nearest colour that passes?
 * 2. **Structure.** {@link auditStructure} reads a plain description of the
 *    rendered UI and reports the structural faults assistive technology notices:
 *    no `main` landmark, a skipped heading level, a control without a label, an
 *    image without alt text, a focusable element outside every landmark, and a
 *    duplicated id.
 * 3. **Focus order.** {@link focusOrder} derives the tab order from DOM-ish
 *    records with the browser's rules, and reports a positive `tabIndex` as the
 *    authoring warning it is.
 *
 * Contract:
 *
 * - **Pure and deterministic.** No clock, no randomness, no DOM, no I/O and no
 *   dependency, so it runs identically in the browser, in the desktop shell's
 *   renderer and in a Node test.
 * - **Codes are stable English, messages are English sentences.** A UI switches
 *   on `code`; `message` is what a log or a test reads. Neither is localised
 *   here, and the caller owns the translation.
 * - **Absence is not invented.** Every finding comes from something present in
 *   the input: a missing landmark, a heading that skips a level, a control whose
 *   label is absent or blank, an `alt` attribute that does not exist. A clean
 *   description returns an empty list, and a description that omits a section
 *   entirely is audited as a UI with no elements of that kind.
 * - **Nothing is repaired.** No colour is changed and no element is reordered.
 *   A suggestion is a value a caller may choose to apply.
 */

// --- Contrast ---------------------------------------------------------------

/**
 * Minimum contrast for normal-size text at WCAG 2.2 level AA (success
 * criterion 1.4.3). Large text, and UI components and graphical objects under
 * 1.4.11, require {@link WCAG_AA_LARGE_TEXT}.
 */
export const WCAG_AA_NORMAL_TEXT = 4.5;

/**
 * Minimum contrast for large text (at least 18 pt, or 14 pt bold) and for UI
 * components at WCAG 2.2 level AA. The two thresholds coincide at 3:1, so one
 * level covers both.
 */
export const WCAG_AA_LARGE_TEXT = 3;

/**
 * Which WCAG AA threshold a batch of colours is checked against.
 *
 * - `normal`: body text, the 4.5:1 threshold.
 * - `large`: large text, and also UI component boundaries and icons, the 3:1
 *   threshold.
 */
export type ContrastLevel = 'normal' | 'large';

/** One foreground/background pair to check, optionally named for the report. */
export interface ContrastPair {
  /** Text or component colour, as `#rgb` or `#rrggbb` (the leading `#` may be omitted). */
  readonly foreground: string;
  /** The colour the foreground is painted on. */
  readonly background: string;
  /** Shown in the failure; defaults to `"<foreground> on <background>"`. */
  readonly label?: string;
}

/**
 * One pair that missed its threshold.
 *
 * `ratio` is the measured value, unrounded, so a caller can display it or feed
 * it to a suggestion; `required` is the threshold for the level the batch was
 * checked at. The colours are echoed in canonical `#rrggbb` form.
 */
export interface ContrastFailure {
  /** Stable code; the only value a UI needs to switch on. */
  readonly code: 'contrast-below-minimum';
  /** The pair's label, or a generated one when the caller supplied none. */
  readonly label: string;
  readonly foreground: string;
  readonly background: string;
  /** Measured WCAG contrast ratio, between 1 and 21. */
  readonly ratio: number;
  /** The ratio this level requires. */
  readonly required: number;
}

/** Parsed sRGB channels, each 0–255. */
interface RgbColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/iu;

/**
 * Returns the WCAG relative luminance of a colour, from 0 (black) to 1 (white).
 *
 * This is the sRGB linearisation from WCAG 2.2: each channel is divided by 255,
 * linearised with the 0.03928 knee, then weighted 0.2126 R + 0.7152 G +
 * 0.0722 B. The weights matter: a green and a blue of the same channel value do
 * not contribute equally to how light the colour looks, which is why a naive
 * average of the channels would approve pairs a reader cannot read.
 *
 * Throws a `TypeError` for anything that is not `#rgb` or `#rrggbb`.
 */
export function relativeLuminance(hex: string): number {
  return luminanceOf(parseHexColor(hex));
}

/**
 * Returns the WCAG contrast ratio between two colours, from 1 to 21.
 *
 * The ratio is `(lighter + 0.05) / (darker + 0.05)` over relative luminance, so
 * it is symmetric: swapping foreground and background produces the same number.
 * Black on white is exactly 21, and a colour against itself is exactly 1.
 */
export function contrastRatio(foregroundHex: string, backgroundHex: string): number {
  return contrastBetween(parseHexColor(foregroundHex), parseHexColor(backgroundHex));
}

/** The threshold for `level`. Unknown values are rejected rather than guessed. */
export function requiredContrast(level: ContrastLevel = 'normal'): number {
  if (level === 'normal') return WCAG_AA_NORMAL_TEXT;
  if (level === 'large') return WCAG_AA_LARGE_TEXT;
  throw new RangeError(`Unknown contrast level: ${String(level)}`);
}

/**
 * Checks every pair against `level` and returns the failures in input order.
 *
 * A ratio exactly equal to the threshold **passes**: WCAG states a minimum, and
 * 4.5:1 meets 4.5:1. A missing or blank `label` is replaced with
 * `"<foreground> on <background>"` so a report always names the pair.
 *
 * The level applies to the whole batch. Large text and UI components are checked
 * in their own call with `level: 'large'`; letting one call mix levels would make
 * each failure's `required` depend on a field a reader has to look up.
 */
export function checkContrast(
  pairs: readonly ContrastPair[],
  level: ContrastLevel = 'normal',
): ContrastFailure[] {
  const required = requiredContrast(level);
  if (!Array.isArray(pairs)) {
    throw new TypeError('checkContrast needs an array of { foreground, background } pairs.');
  }

  const failures: ContrastFailure[] = [];
  for (const pair of pairs) {
    if (pair === null || typeof pair !== 'object') {
      throw new TypeError('checkContrast needs an array of { foreground, background } pairs.');
    }
    const foreground = parseHexColor(pair.foreground);
    const background = parseHexColor(pair.background);
    const ratio = contrastBetween(foreground, background);
    if (ratio >= required) continue;

    const foregroundHex = formatHexColor(foreground);
    const backgroundHex = formatHexColor(background);
    const label = text(pair.label) || `${foregroundHex} on ${backgroundHex}`;
    failures.push({
      code: 'contrast-below-minimum',
      label,
      foreground: foregroundHex,
      background: backgroundHex,
      ratio,
      required,
    });
  }
  return failures;
}

/**
 * Returns the nearest colour to `foregroundHex` that passes when moved toward
 * black, or `null` when black itself cannot reach the threshold.
 *
 * "Nearest" is measured in sRGB channel space along that one direction: the
 * result is the first colour on the segment from the foreground to `#000000`
 * that passes. Because every channel changes by less than one step per unit of
 * blend, every integer colour on the segment is visited, so the first passing
 * candidate is also the closest one. If the pair already passes, the foreground
 * comes back unchanged (canonicalised); the caller does not have to check first.
 *
 * Darkening cannot always help — a mid-grey on black has nowhere darker to go —
 * and `null` says so instead of returning a colour that still fails.
 */
export function suggestDarken(
  foregroundHex: string,
  backgroundHex: string,
  level: ContrastLevel = 'normal',
): string | null {
  return suggestToward(foregroundHex, backgroundHex, level, 0);
}

/**
 * Returns the nearest colour to `foregroundHex` that passes when moved toward
 * white, or `null` when white itself cannot reach the threshold.
 *
 * This is the direction to try for light text on a dark surface, where
 * darkening would only make the pair worse. Everything {@link suggestDarken}
 * documents about "nearest", unchanged passing pairs and `null` applies here.
 */
export function suggestLighten(
  foregroundHex: string,
  backgroundHex: string,
  level: ContrastLevel = 'normal',
): string | null {
  return suggestToward(foregroundHex, backgroundHex, level, 255);
}

// --- Structure --------------------------------------------------------------

/**
 * A landmark in the description. `role` is the ARIA landmark role, for example
 * `main`, `navigation` or `banner`, and is matched case-insensitively.
 */
export interface LandmarkDescription {
  /** Unique id, used for duplicate detection and for placing controls inside it. */
  readonly id?: string;
  /** ARIA landmark role. */
  readonly role: string;
  /** Accessible name, for example the visible navigation heading. */
  readonly label?: string;
}

/** One heading, in document order. */
export interface HeadingDescription {
  readonly level: number;
  /** Visible heading text; used to name the issue. */
  readonly text?: string;
  readonly id?: string;
}

/** One focusable control. */
export interface InteractiveDescription {
  readonly id?: string;
  /** Role or control type, for example `button` or `searchbox`; used in fallback names. */
  readonly role?: string;
  /** Accessible label. Absent, empty or whitespace-only means "unlabelled". */
  readonly label?: string;
  /** Id of the landmark containing this control; omitted means outside every landmark. */
  readonly landmarkId?: string;
  /** A disabled control is not focusable, so it is exempt from the landmark rule. */
  readonly disabled?: boolean;
}

/** One image in the description. */
export interface ImageDescription {
  readonly id?: string;
  /**
   * Alt text. A missing field is reported unless the image is decorative; an
   * empty string is a deliberate decorative marker and is accepted.
   */
  readonly alt?: string;
  /** Marks an image that carries no information, exempting it from alt text. */
  readonly decorative?: boolean;
}

/** The plain description of the UI that {@link auditStructure} reads. */
export interface StructureDescription {
  readonly landmarks?: readonly LandmarkDescription[];
  readonly headings?: readonly HeadingDescription[];
  readonly interactive?: readonly InteractiveDescription[];
  readonly images?: readonly ImageDescription[];
}

/**
 * The structural faults {@link auditStructure} can report.
 *
 * - `missing-main-landmark`: there is no `main` landmark, so there is no way to
 *   skip to the primary content.
 * - `heading-level-skip`: a heading jumps more than one level deeper than the
 *   previous heading, for example `h1` followed by `h3`.
 * - `interactive-without-label`: a control has no accessible label.
 * - `image-without-alt`: an image is neither given alt text nor marked
 *   decorative.
 * - `focusable-outside-landmark`: a focusable control is not inside any landmark,
 *   so landmark navigation cannot reach it.
 * - `duplicate-id`: the same id is used by more than one element.
 */
export type A11yIssueCode =
  | 'missing-main-landmark'
  | 'heading-level-skip'
  | 'interactive-without-label'
  | 'image-without-alt'
  | 'focusable-outside-landmark'
  | 'duplicate-id';

/** One structural finding: a stable code, the element it is about, and a sentence. */
export interface A11yIssue {
  readonly code: A11yIssueCode;
  /** Element name: an id, a heading text, or a generated `interactive[index]` fallback. */
  readonly element: string;
  /** Stable English sentence for logs and tests. */
  readonly message: string;
}

/**
 * Audits a plain description of the UI and returns its structural issues.
 *
 * Rules, in the order issues are appended (so the output is deterministic):
 *
 * 1. The description needs one landmark whose role is `main`; otherwise one
 *    `missing-main-landmark` issue names `main`.
 * 2. Headings are walked in document order. A heading whose level is more than
 *    one deeper than the previous valid heading is a `heading-level-skip`. A
 *    first heading at any level is not a skip: there is no previous level to skip
 *    from. Levels outside 1–6 are ignored rather than guessed.
 * 3. Every interactive element must have a non-blank label; otherwise
 *    `interactive-without-label`. Disabled controls still need labels.
 * 4. An image whose `alt` field is missing is reported unless `decorative` is
 *    true. `alt: ''` is accepted as an explicit decorative marker.
 * 5. Each enabled control must name, through `landmarkId`, a landmark id present
 *    in the description; otherwise `focusable-outside-landmark`. An id that
 *    points at no landmark counts as outside.
 * 6. Ids are compared after trimming and are case-sensitive, as in HTML. A
 *    repeated id produces one `duplicate-id` issue per id, in first-seen order.
 *
 * A missing section is treated as a UI with no elements of that kind: omitting
 * `images` does not raise alt-text issues, while omitting `landmarks` does raise
 * the missing-`main` issue.
 */
export function auditStructure(description: StructureDescription): A11yIssue[] {
  if (description === null || typeof description !== 'object') {
    throw new TypeError('auditStructure needs a description object.');
  }
  const landmarks = readList(description.landmarks, 'landmarks');
  const headings = readList(description.headings, 'headings');
  const interactive = readList(description.interactive, 'interactive');
  const images = readList(description.images, 'images');
  const issues: A11yIssue[] = [];

  // 1. A main landmark is required. Whether there is more than one is a
  // separate concern from this audit, which only asks whether the reader can
  // reach the primary content.
  const hasMain = landmarks.some((landmark) => text(landmark.role).toLowerCase() === 'main');
  if (!hasMain) {
    issues.push({
      code: 'missing-main-landmark',
      element: 'main',
      message: 'The page has no main landmark, so assistive technology cannot skip to the primary content.',
    });
  }

  // 2. Heading outline.
  let previousLevel: number | undefined;
  for (const heading of headings) {
    if (!isHeadingLevel(heading.level)) continue;
    const level = heading.level;
    const element = nameOr(heading.text, `h${level}`);
    if (previousLevel !== undefined && level - previousLevel > 1) {
      issues.push({
        code: 'heading-level-skip',
        element,
        message: `Heading "${element}" jumps from level ${previousLevel} to ${level}, skipping a level in the outline.`,
      });
    }
    previousLevel = level;
  }

  // 3. Accessible names for controls.
  for (const [index, element] of interactive.entries()) {
    if (text(element.label)) continue;
    const name = nameOr(element.id, nameOr(element.role, `interactive[${index}]`));
    issues.push({
      code: 'interactive-without-label',
      element: name,
      message: `Interactive element "${name}" has no accessible label.`,
    });
  }

  // 4. Alt text.
  for (const [index, image] of images.entries()) {
    if (typeof image.alt === 'string' || image.decorative === true) continue;
    const name = nameOr(image.id, `image[${index}]`);
    issues.push({
      code: 'image-without-alt',
      element: name,
      message: `Image "${name}" has no alt text and is not marked decorative.`,
    });
  }

  // 5. Every enabled control has to live inside a landmark that exists.
  const landmarkIds = new Set<string>();
  for (const landmark of landmarks) {
    const id = text(landmark.id);
    if (id) landmarkIds.add(id);
  }
  for (const [index, element] of interactive.entries()) {
    if (element.disabled === true) continue;
    const owner = text(element.landmarkId);
    if (owner && landmarkIds.has(owner)) continue;
    const name = nameOr(element.id, nameOr(element.role, `interactive[${index}]`));
    issues.push({
      code: 'focusable-outside-landmark',
      element: name,
      message: `Focusable element "${name}" is outside every landmark, so landmark navigation cannot reach it.`,
    });
  }

  // 6. Duplicate ids, across every element family, in first-seen order.
  const seen = new Map<string, number>();
  for (const id of collectIds(landmarks, headings, interactive, images)) {
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1) {
      issues.push({
        code: 'duplicate-id',
        element: id,
        message: `The id "${id}" is used ${count} times; ids must be unique.`,
      });
    }
  }

  return issues;
}

// --- Focus order ------------------------------------------------------------

/** One element as a DOM-ish record: enough to derive its place in the tab order. */
export interface FocusElement {
  /** Identifier returned in the tab order. */
  readonly id: string;
  /**
   * The `tabindex` attribute. Omitted or non-finite means `0`, the browser's
   * default for natively focusable elements. Negative values remove the element
   * from the tab order.
   */
  readonly tabIndex?: number;
  /** Document order. Omitted means the element's position in the input array. */
  readonly order?: number;
  /** A disabled control cannot be focused and is left out of the order. */
  readonly disabled?: boolean;
}

/** A positive `tabIndex` found while deriving the order. */
export interface FocusOrderWarning {
  readonly code: 'positive-tabindex';
  readonly element: string;
  readonly tabIndex: number;
  readonly message: string;
}

/** The tab order and the authoring warnings that came with it. */
export interface FocusOrderResult {
  /** Element ids in the order Tab visits them. */
  readonly ids: readonly string[];
  /** One warning per enabled element with a positive `tabIndex`, in input order. */
  readonly warnings: readonly FocusOrderWarning[];
}

/**
 * Derives the tab order from DOM-ish records.
 *
 * Rules, matching the browser's sequential focus navigation:
 *
 * 1. Elements with `tabIndex > 0` are visited first, in ascending `tabIndex`.
 *    Ties are broken by document order, then by input order.
 * 2. Elements with `tabIndex === 0` follow, in document order. Document order is
 *    `order` when it is a finite number, otherwise the element's index in the
 *    input array; ties fall back to input order.
 * 3. Elements with `tabIndex < 0` are excluded: they can be focused by script
 *    but Tab never reaches them.
 * 4. Disabled elements are excluded and do not warn, because they are not
 *    focusable at all.
 *
 * A positive `tabIndex` is legal but discouraged: it overrides the natural
 * order and makes a page fragile when content moves. Each enabled element that
 * uses one produces a `positive-tabindex` warning, in input order, while the
 * element still appears at its overridden place in `ids` — the warning describes
 * the markup, it does not change the order the browser would use.
 */
export function focusOrder(elements: readonly FocusElement[]): FocusOrderResult {
  if (!Array.isArray(elements)) {
    throw new TypeError('focusOrder needs an array of { id, tabIndex, order, disabled } records.');
  }

  const entries = elements.map((element, index) => {
    const rawTabIndex = element.tabIndex;
    const tabIndex = typeof rawTabIndex === 'number' && Number.isFinite(rawTabIndex) ? rawTabIndex : 0;
    const rawOrder = element.order;
    const documentOrder = typeof rawOrder === 'number' && Number.isFinite(rawOrder) ? rawOrder : index;
    return {
      id: element.id,
      index,
      tabIndex,
      documentOrder,
      disabled: element.disabled === true,
    };
  });

  const warnings: FocusOrderWarning[] = [];
  for (const entry of entries) {
    if (entry.disabled || !(entry.tabIndex > 0)) continue;
    warnings.push({
      code: 'positive-tabindex',
      element: entry.id,
      tabIndex: entry.tabIndex,
      message: `Element "${entry.id}" has a positive tabIndex (${entry.tabIndex}), which overrides the natural focus order.`,
    });
  }

  const focusable = entries.filter((entry) => !entry.disabled && entry.tabIndex >= 0);
  const positive = focusable
    .filter((entry) => entry.tabIndex > 0)
    .sort(
      (a, b) =>
        a.tabIndex - b.tabIndex || a.documentOrder - b.documentOrder || a.index - b.index,
    );
  const zero = focusable
    .filter((entry) => entry.tabIndex === 0)
    .sort((a, b) => a.documentOrder - b.documentOrder || a.index - b.index);

  return { ids: [...positive, ...zero].map((entry) => entry.id), warnings };
}

// --- Internals --------------------------------------------------------------

/** Trims a value into either a usable string or an empty one. */
function text(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A non-empty value, else the fallback. */
function nameOr(value: string | undefined, fallback: string): string {
  return text(value) || fallback;
}

/** A heading level this audit can compare: an integer from 1 to 6. */
function isHeadingLevel(level: number): boolean {
  return Number.isInteger(level) && level >= 1 && level <= 6;
}

/** Reads an optional description section, rejecting a present non-array. */
function readList<T>(value: readonly T[] | undefined, field: string): readonly T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError(`auditStructure needs "${field}" to be an array when it is present.`);
  }
  return value;
}

/** Walks every element family in the documented order and yields non-blank ids. */
function* collectIds(
  landmarks: readonly LandmarkDescription[],
  headings: readonly HeadingDescription[],
  interactive: readonly InteractiveDescription[],
  images: readonly ImageDescription[],
): Generator<string> {
  for (const landmark of landmarks) {
    const id = text(landmark.id);
    if (id) yield id;
  }
  for (const heading of headings) {
    const id = text(heading.id);
    if (id) yield id;
  }
  for (const element of interactive) {
    const id = text(element.id);
    if (id) yield id;
  }
  for (const image of images) {
    const id = text(image.id);
    if (id) yield id;
  }
}

/** Parses `#rgb` or `#rrggbb` into channels, with a clear failure for anything else. */
function parseHexColor(value: string): RgbColor {
  if (typeof value !== 'string') {
    throw new TypeError('Expected a hex colour string such as "#1a2b3c".');
  }
  const match = HEX_COLOR.exec(value.trim());
  const digits = match?.[1];
  if (!digits) {
    throw new TypeError(`"${value}" is not a #rgb or #rrggbb colour.`);
  }
  const expanded =
    digits.length === 3
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits;
  return {
    red: Number.parseInt(expanded.slice(0, 2), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    blue: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

/** Canonical lowercase `#rrggbb`. */
function formatHexColor(color: RgbColor): string {
  return `#${[color.red, color.green, color.blue]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** WCAG linearisation of one 0–255 sRGB channel. */
function linearChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of parsed channels. */
function luminanceOf(color: RgbColor): number {
  return (
    0.2126 * linearChannel(color.red) +
    0.7152 * linearChannel(color.green) +
    0.0722 * linearChannel(color.blue)
  );
}

/** Contrast ratio between two parsed colours. */
function contrastBetween(first: RgbColor, second: RgbColor): number {
  const firstLuminance = luminanceOf(first);
  const secondLuminance = luminanceOf(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Moves `color` a fraction of the way to `target`, rounded to whole channels. */
function mixToward(color: RgbColor, target: number, step: number): RgbColor {
  const fraction = step / 255;
  return {
    red: Math.round(color.red + (target - color.red) * fraction),
    green: Math.round(color.green + (target - color.green) * fraction),
    blue: Math.round(color.blue + (target - color.blue) * fraction),
  };
}

/** Shared body of the two suggestion directions. */
function suggestToward(
  foregroundHex: string,
  backgroundHex: string,
  level: ContrastLevel,
  target: number,
): string | null {
  const required = requiredContrast(level);
  const foreground = parseHexColor(foregroundHex);
  const background = parseHexColor(backgroundHex);
  if (contrastBetween(foreground, background) >= required) return formatHexColor(foreground);

  // 255 steps reach the target exactly. Each step moves every channel by at most
  // one integer, so every colour on the segment is visited and the first passing
  // candidate is the nearest one in that direction.
  for (let step = 1; step <= 255; step += 1) {
    const candidate = mixToward(foreground, target, step);
    if (contrastBetween(candidate, background) >= required) return formatHexColor(candidate);
  }
  return null;
}
