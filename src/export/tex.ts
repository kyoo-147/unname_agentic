/**
 * Formula drawing for the PDF export (backlog H15).
 *
 * Why this module exists: `formulas.ts` recovers formulas from the source page and can hand back
 * LaTeX, but an export that drops them leaves a blank where the mathematics was, and the alternatives
 * are worse than they look. Shipping a TeX engine is megabytes of code plus a font pipeline;
 * rasterising at capture time bakes a second image into the page; writing the LaTeX source verbatim
 * puts `\frac{a}{b}` in a book. This module takes a fourth way: a planner that turns the LaTeX subset
 * `formulas.ts` produces into a short list of pdf-lib primitives — text runs, stroked lines and filled
 * rules — that the export draws itself.
 *
 * The pipeline is three pure steps and one drawing step:
 * 1. {@link planFormula} parses the LaTeX and lays out a draw plan in *plan space*.
 * 2. {@link fitFormula} scales a plan into a box without changing the layout's proportions.
 * 3. {@link toSvg} renders a plan as a standalone SVG for previews; {@link plainText} flattens the
 *    LaTeX into readable text, which is what keeps a formula searchable in a text layer.
 * 4. {@link drawFormula} writes a plan onto a pdf-lib page.
 *
 * Plan space is y-up, like PDF space: `x = 0` is the left edge of the ink, `y = 0` the bottom edge of
 * the ink, and `FormulaPlan.baseline` is the height of the main baseline above that bottom edge. A
 * text op's `y` is *its own* baseline, so a superscript has a larger `y` than the run it hangs off and
 * a subscript a smaller one. `fitFormula` multiplies every coordinate by a single factor, so those
 * baseline relations survive any fit.
 *
 * Subset, matching what `formulas.ts` emits: superscripts and subscripts, `\frac`, `\sqrt`, Greek
 * letter commands, the operator commands (`\times`, `\le`, `\sum`, `\to`, …), escaped characters
 * (`\%`, `\&`, `\_`, …), spacing commands, and the delimiter-sizing commands `\left`/`\right` (ignored:
 * they carry no glyph). Anything else is reported in `warnings` and drawn literally, so an unexpected
 * macro never fails an export. `plainText` understands the same subset, so the searchable form and the
 * drawn form never disagree about what a formula says.
 *
 * Metrics are planned, not measured: there is no font engine here, so every character advances
 * {@link CHAR_WIDTH_RATIO} em and every glyph box is {@link ASCENT_RATIO} above and
 * {@link DESCENT_RATIO} below its baseline, whatever the face actually does. `drawFormula` draws
 * through a real face, so a run can come out slightly wider or narrower than planned. Measuring
 * through pdf-lib instead would make planning async and face-bound, and nothing here needs that
 * precision: the plan is a layout, and the export is a legible formula rather than a reprint.
 */

import { LineCapStyle, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage, RGB } from 'pdf-lib';

// --- Geometry ------------------------------------------------------------

/** One primitive of a plan. Sizes and coordinates are in points, in plan space. */
export type OpKind = 'text' | 'line' | 'rule';

/**
 * One drawing primitive.
 *
 * What `x`, `y`, `size` and `thickness` mean depends on `kind`:
 * - `text`: `x` is the run's left edge, `y` its baseline, `size` the font size, `text` the run.
 * - `rule`: a filled horizontal bar — `x` its left edge, `y` its centre line, `size` its length,
 *   `thickness` its height. A fraction's bar is a rule.
 * - `line`: a stroked segment — `x`/`y` the start point, `x2`/`y2` the end point, `size` the segment
 *   length (geometry is authoritative), `thickness` the stroke width. A radical is two lines: its
 *   overbar and the small tick that rises into it.
 */
export interface Op {
  kind: OpKind;
  x: number;
  y: number;
  size: number;
  text?: string;
  thickness?: number;
  /** End point of a `line` op; absent on text and rules. */
  x2?: number;
  y2?: number;
}

/** What every planned or fitted formula can be rendered from. */
export interface FormulaLayout {
  ops: Op[];
  /** Width of the ink box, in points. */
  width: number;
  /** Height of the ink box, in points. */
  height: number;
  /** Height of the main baseline above the ink box's bottom edge, in points. */
  baseline: number;
}

/** A parsed and laid-out formula, ready to fit or draw. */
export interface FormulaPlan extends FormulaLayout {
  /** Parse and layout notes, de-duplicated, in the order they were found. */
  warnings: string[];
}

/** A plan scaled into a box. */
export interface FittedFormula extends FormulaLayout {
  /** The factor every coordinate of the plan was multiplied by. */
  scale: number;
}

/** A box in points: the space a formula may occupy. */
export interface FormulaBox {
  width: number;
  height: number;
}

/** Smallest box {@link fitFormula} will scale a formula into, in points. */
export const MIN_FIT_WIDTH = 4;
export const MIN_FIT_HEIGHT = 4;

/** Base font size used when neither a box nor an explicit size is given, in points. */
export const DEFAULT_BASE_SIZE = 12;

/** A box's height maps to a base size through this ratio, before clamping. */
export const BASE_SIZE_RATIO = 0.5;

/** Bounds of the base size a reference box may ask for, in points. */
export const MIN_BASE_SIZE = 4;
export const MAX_BASE_SIZE = 24;

/** Average advance of one character, as a fraction of the font size. */
export const CHAR_WIDTH_RATIO = 0.5;

/** Glyph box above the baseline, as a fraction of the font size. */
export const ASCENT_RATIO = 0.72;

/** Glyph box below the baseline, as a fraction of the font size. */
export const DESCENT_RATIO = 0.2;

/** Advance of one explicit source space, as a fraction of the font size. */
export const SPACE_RATIO = 0.25;

/** Scripts (superscripts and subscripts) are this fraction of their base size. */
export const SCRIPT_SCALE = 0.7;

/** Smallest size a script may shrink to, in points; it never grows a smaller base. */
export const MIN_SCRIPT_SIZE = 3;

/** How far a superscript baseline is raised, as a fraction of the base size. */
export const SCRIPT_RAISE_RATIO = 0.45;

/** How far a subscript baseline is lowered, as a fraction of the base size. */
export const SCRIPT_LOWER_RATIO = 0.2;

/** A fraction's numerator and denominator are this fraction of the surrounding size. */
export const FRACTION_SIDE_SCALE = 0.85;

/** The fraction bar's height above the baseline, as a fraction of the surrounding size. */
export const FRACTION_AXIS_RATIO = 0.25;

/** Height of a rule (fraction bar, radical overbar), as a fraction of the surrounding size. */
export const RULE_THICKNESS_RATIO = 0.06;

/** Gap between a fraction bar and the side above and below it, as a fraction of the size. */
export const FRACTION_GAP_RATIO = 0.15;

/** Horizontal overhang of a fraction bar past its widest side, as a fraction of the size. */
export const FRACTION_SIDE_PAD_RATIO = 0.1;

/** Gap between a radicand and the radical's overbar, as a fraction of the size. */
export const RADICAL_GAP_RATIO = 0.12;

/** Horizontal run of a radical's tick, as a fraction of the size. */
export const RADICAL_TICK_WIDTH_RATIO = 0.5;

/** How far below the radicand's top the tick starts, as a fraction of the size. */
export const RADICAL_TICK_DROP_RATIO = 0.25;

/** Thickness used for a rule or line op that does not carry one. */
export const DEFAULT_RULE_THICKNESS = 0.5;

/** Options for {@link planFormula}; `size` wins over the reference box's hint. */
export interface FormulaPlanOptions {
  /** Base (unscripted) font size in points. */
  size?: number;
}

const EPSILON = 1e-6;
const COORDINATE_PRECISION = 10_000;

/** Carries a stable `name` so a caller can classify the refusal without matching message text. */
export class FormulaFitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormulaFitError';
  }
}

export const INVALID_BOX_MESSAGE = 'A formula box needs finite, positive width and height.';
export const TINY_BOX_MESSAGE =
  `A formula box must be at least ${MIN_FIT_WIDTH} by ${MIN_FIT_HEIGHT} points: below that its scripts fall under 2 points of type, which cannot be read.`;
export const INVALID_PLAN_MESSAGE = 'fitFormula needs a plan with an ops array.';

export const WIDER_THAN_BOX_WARNING =
  'The formula is wider than the reference box; fitFormula will scale it down.';

const UNSUPPORTED_COMMAND = (name: string): string =>
  `Unsupported command "\\${name}"; drawn as literal text.`;
const FRACTION_ARGUMENT_WARNING = '"\\frac" needs two arguments; drawn as literal text.';
const RADICAL_ARGUMENT_WARNING = '"\\sqrt" needs a radicand; drawn as literal text.';
const ROOT_INDEX_WARNING = 'The optional root index of "\\sqrt" is not drawn.';
const UNCLOSED_GROUP_WARNING = 'A "{" was never closed; its contents are drawn as they are.';
const UNMATCHED_CLOSE_WARNING = 'An unmatched "}" was skipped.';
const DANGLING_BACKSLASH_WARNING = 'A formula ended with a lone backslash; it is drawn literally.';
const SCRIPT_WITHOUT_BASE_WARNING =
  'A superscript or subscript had no base; its contents are drawn inline.';
const SCRIPT_ARGUMENT_WARNING = 'A superscript or subscript had nothing after it; it is ignored.';
const DUPLICATE_SCRIPT_WARNING =
  'A base carried two superscripts or two subscripts; the extra one is drawn inline.';

// --- LaTeX subset --------------------------------------------------------

/** Greek letter commands, and the letter each one names. */
const GREEK_COMMANDS: ReadonlyMap<string, string> = new Map<string, string>([
  ['alpha', 'α'], ['beta', 'β'], ['gamma', 'γ'], ['delta', 'δ'], ['epsilon', 'ε'],
  ['zeta', 'ζ'], ['eta', 'η'], ['theta', 'θ'], ['iota', 'ι'], ['kappa', 'κ'],
  ['lambda', 'λ'], ['mu', 'μ'], ['nu', 'ν'], ['xi', 'ξ'], ['omicron', 'ο'],
  ['pi', 'π'], ['rho', 'ρ'], ['sigma', 'σ'], ['tau', 'τ'], ['upsilon', 'υ'],
  ['phi', 'φ'], ['chi', 'χ'], ['psi', 'ψ'], ['omega', 'ω'], ['varsigma', 'ς'],
  ['Gamma', 'Γ'], ['Delta', 'Δ'], ['Theta', 'Θ'], ['Lambda', 'Λ'], ['Xi', 'Ξ'],
  ['Pi', 'Π'], ['Sigma', 'Σ'], ['Upsilon', 'Υ'], ['Phi', 'Φ'], ['Psi', 'Ψ'],
  ['Omega', 'Ω'],
]);

/** Operator and punctuation commands, and the character each one names. */
const SYMBOL_COMMANDS: ReadonlyMap<string, string> = new Map<string, string>([
  ['times', '×'], ['div', '÷'], ['pm', '±'], ['mp', '∓'],
  ['le', '≤'], ['ge', '≥'], ['ne', '≠'], ['approx', '≈'], ['equiv', '≡'], ['sim', '∼'],
  ['infty', '∞'], ['partial', '∂'], ['nabla', '∇'],
  ['to', '→'], ['leftarrow', '←'], ['leftrightarrow', '↔'],
  ['Rightarrow', '⇒'], ['Leftrightarrow', '⇔'],
  ['sum', '∑'], ['prod', '∏'], ['int', '∫'], ['iint', '∬'],
  ['in', '∈'], ['notin', '∉'], ['subset', '⊂'], ['supset', '⊃'], ['cup', '∪'], ['cap', '∩'],
  ['forall', '∀'], ['exists', '∃'], ['neg', '¬'], ['wedge', '∧'], ['vee', '∨'],
  ['cdot', '⋅'], ['ast', '∗'], ['circ', '∘'], ['degree', '°'], ['ldots', '…'], ['dots', '…'],
  ['%', '%'], ['&', '&'], ['#', '#'], ['$', '$'], ['_', '_'], ['{', '{'], ['}', '}'],
]);

/** Commands that only advance the cursor by a small space. */
const SPACE_COMMANDS: ReadonlySet<string> = new Set([' ', ',', ';', ':', '!', 'quad', 'qquad', 'enspace', 'thinspace']);

/** Commands that carry no glyph and no size change this planner models. */
const IGNORED_COMMANDS: ReadonlySet<string> = new Set(['left', 'right', 'displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits']);

/**
 * The parsed formula. `atom` is one drawn character (or a literal unsupported command), `space` one
 * explicit source space, `row` a sequence, and the rest the constructs the layout knows how to place.
 */
type Node =
  | { kind: 'atom'; text: string }
  | { kind: 'space' }
  | { kind: 'row'; items: Node[] }
  | { kind: 'script'; base: Node; sup: Node | null; sub: Node | null }
  | { kind: 'frac'; numerator: Node; denominator: Node }
  | { kind: 'sqrt'; body: Node };

/** A parser position plus its warnings, so parsing stays a set of plain functions. */
interface Cursor {
  readonly source: string;
  index: number;
  readonly warnings: Set<string>;
}

function round(value: number): number {
  return Math.round(value * COORDINATE_PRECISION) / COORDINATE_PRECISION;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isSpace(character: string): boolean {
  return character.length > 0 && /\s/u.test(character);
}

/** The code point at `index`, as a string; `''` past the end. */
function characterAt(source: string, index: number): string {
  const code = source.codePointAt(index);
  return code === undefined ? '' : String.fromCodePoint(code);
}

function warn(cursor: Cursor, message: string): void {
  cursor.warnings.add(message);
}

/**
 * Plans one formula as a draw plan.
 *
 * `box`, when given, is a size hint, not a fit: the base (unscripted) font size becomes
 * `box.height * BASE_SIZE_RATIO`, clamped to `[MIN_BASE_SIZE, MAX_BASE_SIZE]`, so the plan comes out
 * close to the space it will occupy. A plan still wider than that box adds
 * {@link WIDER_THAN_BOX_WARNING}; {@link fitFormula} is what actually makes it fit. An explicit
 * `options.size` overrides the hint and is taken as given.
 *
 * The result is independent of any face, so it can be fitted, previewed as SVG and unit-tested
 * without a canvas or an embedded font.
 */
export function planFormula(latex: string, box?: FormulaBox, options: FormulaPlanOptions = {}): FormulaPlan {
  const source = typeof latex === 'string' ? latex : '';
  const cursor: Cursor = { source, index: 0, warnings: new Set<string>() };
  const root: Node = { kind: 'row', items: parseSequence(cursor, false) };
  const baseSize = resolveBaseSize(box, options.size);
  const laid = layoutNode(root, baseSize);
  const baseline = laid.depth;
  const ops = finaliseOps(laid.ops, baseline);
  const warnings = [...cursor.warnings];
  if (box && Number.isFinite(box.width) && box.width > 0 && laid.width > box.width + EPSILON) {
    warnings.push(WIDER_THAN_BOX_WARNING);
  }
  return {
    ops,
    width: round(laid.width),
    height: round(laid.height + baseline),
    baseline: round(baseline),
    warnings,
  };
}

function resolveBaseSize(box: FormulaBox | undefined, size: number | undefined): number {
  // An explicit size is taken as given: the caller knows the point size it wants. Only the box's
  // hint is bounded, because a box is a space, not a typographic decision.
  if (typeof size === 'number' && Number.isFinite(size) && size > 0) return size;
  if (box && Number.isFinite(box.height) && box.height > 0) {
    return clamp(box.height * BASE_SIZE_RATIO, MIN_BASE_SIZE, MAX_BASE_SIZE);
  }
  return DEFAULT_BASE_SIZE;
}

// --- Parsing -------------------------------------------------------------

/** Parses a sequence, stopping after the `}` that closes the group when `stopAtClose` is set. */
function parseSequence(cursor: Cursor, stopAtClose: boolean): Node[] {
  const items: Node[] = [];
  while (cursor.index < cursor.source.length) {
    const character = characterAt(cursor.source, cursor.index);
    if (character === '}') {
      cursor.index += 1;
      if (stopAtClose) return trimTrailingSpace(items);
      // At the top level a closing brace closes nothing: skipping it keeps the rest of the formula
      // rather than dropping everything to its right.
      warn(cursor, UNMATCHED_CLOSE_WARNING);
      continue;
    }
    if (isSpace(character)) {
      while (cursor.index < cursor.source.length && isSpace(characterAt(cursor.source, cursor.index))) {
        cursor.index += characterAt(cursor.source, cursor.index).length;
      }
      pushSpace(items);
      continue;
    }
    if (character === '^' || character === '_') {
      cursor.index += 1;
      attachScript(cursor, items, character);
      continue;
    }
    const before = cursor.index;
    const atom = parseAtom(cursor);
    if (atom) {
      items.push(atom);
      continue;
    }
    // A rejected character still has to be consumed, or the loop would spin on it.
    if (cursor.index === before) cursor.index += character.length;
  }
  if (stopAtClose) warn(cursor, UNCLOSED_GROUP_WARNING);
  return trimTrailingSpace(items);
}

/** A group's or a formula's trailing space adds advance with nothing in it; drop it. */
function trimTrailingSpace(items: Node[]): Node[] {
  const last = items[items.length - 1];
  if (last !== undefined && last.kind === 'space') items.pop();
  return items;
}

function pushSpace(items: Node[]): void {
  const last = items[items.length - 1];
  if (last === undefined || last.kind === 'space') return;
  items.push({ kind: 'space' });
}

function parseAtom(cursor: Cursor): Node | null {
  const character = characterAt(cursor.source, cursor.index);
  if (character === '') return null;
  if (character === '{') {
    cursor.index += 1;
    return { kind: 'row', items: parseSequence(cursor, true) };
  }
  if (character === '\\') return parseCommand(cursor);
  if (character === '}' || character === '^' || character === '_') return null;
  cursor.index += character.length;
  return { kind: 'atom', text: character };
}

/** Reads one macro name (letters, or a single non-letter) and the node it stands for. */
function parseCommand(cursor: Cursor): Node | null {
  const source = cursor.source;
  cursor.index += 1;
  if (cursor.index >= source.length) {
    warn(cursor, DANGLING_BACKSLASH_WARNING);
    return { kind: 'atom', text: '\\' };
  }
  const start = cursor.index;
  let name: string;
  if (/[A-Za-z]/.test(characterAt(source, cursor.index))) {
    while (cursor.index < source.length && /[A-Za-z]/.test(characterAt(source, cursor.index))) {
      cursor.index += 1;
    }
    name = source.slice(start, cursor.index);
  } else {
    const character = characterAt(source, cursor.index);
    cursor.index += character.length;
    name = character;
  }

  if (name === 'frac') return parseFraction(cursor);
  if (name === 'sqrt') return parseRoot(cursor);

  const greek = GREEK_COMMANDS.get(name);
  if (greek !== undefined) return { kind: 'atom', text: greek };
  const symbol = SYMBOL_COMMANDS.get(name);
  if (symbol !== undefined) return { kind: 'atom', text: symbol };
  if (SPACE_COMMANDS.has(name)) return { kind: 'space' };
  if (IGNORED_COMMANDS.has(name)) return null;

  warn(cursor, UNSUPPORTED_COMMAND(name));
  return { kind: 'atom', text: `\\${name}` };
}

function parseFraction(cursor: Cursor): Node {
  const numerator = readArgument(cursor);
  if (!numerator) {
    warn(cursor, FRACTION_ARGUMENT_WARNING);
    return { kind: 'atom', text: '\\frac' };
  }
  const denominator = readArgument(cursor);
  if (!denominator) {
    warn(cursor, FRACTION_ARGUMENT_WARNING);
    // Keep the side that parsed, so a half-written fraction still shows what the source held.
    return { kind: 'row', items: [{ kind: 'atom', text: '\\frac' }, numerator] };
  }
  return { kind: 'frac', numerator, denominator };
}

function parseRoot(cursor: Cursor): Node {
  skipSpaces(cursor);
  if (characterAt(cursor.source, cursor.index) === '[') {
    const close = cursor.source.indexOf(']', cursor.index);
    if (close > cursor.index) {
      cursor.index = close + 1;
      warn(cursor, ROOT_INDEX_WARNING);
    }
  }
  const body = readArgument(cursor);
  if (!body) {
    warn(cursor, RADICAL_ARGUMENT_WARNING);
    return { kind: 'atom', text: '√' };
  }
  return { kind: 'sqrt', body };
}

/** Reads one argument: a braced group, or a single token as LaTeX allows. */
function readArgument(cursor: Cursor): Node | null {
  skipSpaces(cursor);
  if (cursor.index >= cursor.source.length) return null;
  const character = characterAt(cursor.source, cursor.index);
  if (character === '{') {
    cursor.index += 1;
    return { kind: 'row', items: parseSequence(cursor, true) };
  }
  if (character === '}' || character === '^' || character === '_') return null;
  return parseAtom(cursor);
}

function skipSpaces(cursor: Cursor): void {
  while (cursor.index < cursor.source.length && isSpace(characterAt(cursor.source, cursor.index))) {
    cursor.index += characterAt(cursor.source, cursor.index).length;
  }
}

/** Attaches a `^` or `_` argument to the item before it, creating or extending a script node. */
function attachScript(cursor: Cursor, items: Node[], marker: string): void {
  const argument = readArgument(cursor);
  if (!argument) {
    warn(cursor, SCRIPT_ARGUMENT_WARNING);
    return;
  }
  const last = items[items.length - 1];
  if (last === undefined || last.kind === 'space') {
    warn(cursor, SCRIPT_WITHOUT_BASE_WARNING);
    items.push(argument);
    return;
  }
  if (last.kind === 'script') {
    if (marker === '^' && last.sup === null) {
      last.sup = argument;
      return;
    }
    if (marker === '_' && last.sub === null) {
      last.sub = argument;
      return;
    }
    warn(cursor, DUPLICATE_SCRIPT_WARNING);
    items.push(argument);
    return;
  }
  items[items.length - 1] = marker === '^'
    ? { kind: 'script', base: last, sup: argument, sub: null }
    : { kind: 'script', base: last, sup: null, sub: argument };
}

// --- Layout --------------------------------------------------------------

/** One op in a box-local frame: `y` is measured from that box's baseline. */
interface LocalOp {
  kind: OpKind;
  x: number;
  y: number;
  size: number;
  text?: string;
  thickness?: number;
  x2?: number;
  y2?: number;
}

/** A laid-out box: its width, its ink above and below its own baseline, and its ops. */
interface Box {
  width: number;
  height: number;
  depth: number;
  ops: LocalOp[];
}

function textWidth(text: string, size: number): number {
  return [...text].length * size * CHAR_WIDTH_RATIO;
}

function textBox(text: string, size: number): Box {
  return {
    width: textWidth(text, size),
    height: ASCENT_RATIO * size,
    depth: DESCENT_RATIO * size,
    ops: [{ kind: 'text', x: 0, y: 0, size, text }],
  };
}

function shiftOps(ops: readonly LocalOp[], dx: number, dy: number): LocalOp[] {
  return ops.map(op => {
    const shifted: LocalOp = { kind: op.kind, x: op.x + dx, y: op.y + dy, size: op.size };
    if (op.text !== undefined) shifted.text = op.text;
    if (op.thickness !== undefined) shifted.thickness = op.thickness;
    if (op.x2 !== undefined) shifted.x2 = op.x2 + dx;
    if (op.y2 !== undefined) shifted.y2 = op.y2 + dy;
    return shifted;
  });
}

function rowBox(boxes: readonly Box[]): Box {
  const ops: LocalOp[] = [];
  let x = 0;
  let height = 0;
  let depth = 0;
  for (const box of boxes) {
    ops.push(...shiftOps(box.ops, x, 0));
    x += box.width;
    height = Math.max(height, box.height);
    depth = Math.max(depth, box.depth);
  }
  return { width: x, height, depth, ops };
}

/** Size of a script hanging off a run of `size`: shrink, but never below `MIN_SCRIPT_SIZE`. */
function scriptSize(size: number): number {
  return Math.min(size, Math.max(size * SCRIPT_SCALE, MIN_SCRIPT_SIZE));
}

function scriptBox(base: Box, sup: Box | null, sub: Box | null, size: number): Box {
  const raise = SCRIPT_RAISE_RATIO * size;
  const drop = SCRIPT_LOWER_RATIO * size;
  let width = base.width;
  let height = base.height;
  let depth = base.depth;
  let ops = base.ops.slice();
  if (sup) {
    ops = ops.concat(shiftOps(sup.ops, base.width, raise));
    width = Math.max(width, base.width + sup.width);
    height = Math.max(height, raise + sup.height);
  }
  if (sub) {
    ops = ops.concat(shiftOps(sub.ops, base.width, -drop));
    width = Math.max(width, base.width + sub.width);
    depth = Math.max(depth, drop + sub.depth);
  }
  return { width, height, depth, ops };
}

/**
 * A fraction: one rule on the maths axis, the numerator above it and the denominator below, both
 * centred on the rule so the two sides share an `x`. The rule always spans the wider side, which is
 * what makes the result read as a fraction rather than as two stacked runs.
 */
function fractionBox(numerator: Box, denominator: Box, size: number): Box {
  const thickness = RULE_THICKNESS_RATIO * size;
  const gap = FRACTION_GAP_RATIO * size;
  const sidePad = FRACTION_SIDE_PAD_RATIO * size;
  const axis = FRACTION_AXIS_RATIO * size;
  const barLength = Math.max(numerator.width, denominator.width) + 2 * sidePad;
  const numeratorBaseline = axis + thickness / 2 + gap + numerator.depth;
  const denominatorBaseline = axis - thickness / 2 - gap - denominator.height;
  const numeratorX = (barLength - numerator.width) / 2;
  const denominatorX = (barLength - denominator.width) / 2;
  const height = numeratorBaseline + numerator.height;
  const depth = -axis + thickness / 2 + gap + denominator.height + denominator.depth;
  const ops: LocalOp[] = [{ kind: 'rule', x: 0, y: axis, size: barLength, thickness }];
  ops.push(...shiftOps(numerator.ops, numeratorX, numeratorBaseline));
  ops.push(...shiftOps(denominator.ops, denominatorX, denominatorBaseline));
  return { width: barLength, height, depth, ops };
}

/**
 * A square root: a tick rising from the radicand's lower left into the overbar's left end, the
 * radicand itself, and the overbar above it. Both strokes are `line` ops — the overbar horizontal, the
 * tick diagonal — so a reader of the plan sees the radical as the two strokes it is drawn with.
 */
function sqrtBox(body: Box, size: number): Box {
  const thickness = RULE_THICKNESS_RATIO * size;
  const gap = RADICAL_GAP_RATIO * size;
  const tickWidth = RADICAL_TICK_WIDTH_RATIO * size;
  const tickDrop = RADICAL_TICK_DROP_RATIO * size;
  const barCenter = body.height + gap + thickness / 2;
  const barLength = body.width + gap;
  // An empty radicand has no height to hang the tick off; keeping the start at the baseline stops
  // the tick from poking below the ink box.
  const tickStart = Math.max(0, body.height - tickDrop);
  const tickLength = Math.hypot(tickWidth, barCenter - tickStart);
  const ops: LocalOp[] = [
    { kind: 'line', x: 0, y: tickStart, x2: tickWidth, y2: barCenter, size: tickLength, thickness },
    ...shiftOps(body.ops, tickWidth, 0),
    { kind: 'line', x: tickWidth, y: barCenter, x2: tickWidth + barLength, y2: barCenter, size: barLength, thickness },
  ];
  return { width: tickWidth + barLength, height: barCenter + thickness / 2, depth: body.depth, ops };
}

function layoutNode(node: Node, size: number): Box {
  switch (node.kind) {
    case 'atom':
      return textBox(node.text, size);
    case 'space':
      return { width: SPACE_RATIO * size, height: 0, depth: 0, ops: [] };
    case 'row':
      return rowBox(node.items.map(item => layoutNode(item, size)));
    case 'script': {
      const base = layoutNode(node.base, size);
      const sup = node.sup ? layoutNode(node.sup, scriptSize(size)) : null;
      const sub = node.sub ? layoutNode(node.sub, scriptSize(size)) : null;
      return scriptBox(base, sup, sub, size);
    }
    case 'frac': {
      const side = size * FRACTION_SIDE_SCALE;
      return fractionBox(layoutNode(node.numerator, side), layoutNode(node.denominator, side), size);
    }
    case 'sqrt':
      return sqrtBox(layoutNode(node.body, size), size);
  }
}

/** Lifts every box-local op onto the plan frame, rounds it and joins runs that touch. */
function finaliseOps(ops: readonly LocalOp[], baseline: number): Op[] {
  const lifted = ops.map(op => {
    const out: Op = { kind: op.kind, x: round(op.x), y: round(op.y + baseline), size: round(op.size) };
    if (op.kind === 'text') out.text = op.text ?? '';
    if (op.thickness !== undefined) out.thickness = round(op.thickness);
    if (op.x2 !== undefined) out.x2 = round(op.x2);
    if (op.y2 !== undefined) out.y2 = round(op.y2 + baseline);
    return out;
  });
  return coalesceRuns(lifted);
}

/**
 * Joins consecutive text ops that share a baseline and size and touch end to start, so a word is one
 * run in the plan, the SVG and the PDF content stream. Any rule or line between them keeps them apart,
 * which is why a fraction's two sides stay separate: they never share a baseline anyway.
 */
function coalesceRuns(ops: readonly Op[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (
      op.kind === 'text'
      && last !== undefined
      && last.kind === 'text'
      && Math.abs(last.size - op.size) < EPSILON
      && Math.abs(last.y - op.y) < EPSILON
      && Math.abs(last.x + textWidth(last.text ?? '', last.size) - op.x) < EPSILON
    ) {
      last.text = `${last.text ?? ''}${op.text ?? ''}`;
      continue;
    }
    out.push({ ...op });
  }
  return out;
}

// --- Fitting -------------------------------------------------------------

/**
 * Scales a plan into `box` by one factor, so widths, heights, rule thicknesses and every baseline
 * relation keep their proportions. The factor is the smaller of the two ratios: the result fills one
 * dimension of the box exactly and leaves slack in the other.
 *
 * Refuses a non-finite box or one below {@link MIN_FIT_WIDTH} by {@link MIN_FIT_HEIGHT} with a
 * {@link FormulaFitError}. An empty plan (no ink) fits any box and comes back at scale 1.
 */
export function fitFormula(layout: FormulaLayout, box: FormulaBox): FittedFormula {
  if (!layout || !Array.isArray(layout.ops)) throw new FormulaFitError(INVALID_PLAN_MESSAGE);
  if (
    !box
    || !Number.isFinite(box.width)
    || !Number.isFinite(box.height)
    || box.width <= 0
    || box.height <= 0
  ) {
    throw new FormulaFitError(INVALID_BOX_MESSAGE);
  }
  if (box.width < MIN_FIT_WIDTH || box.height < MIN_FIT_HEIGHT) {
    throw new FormulaFitError(TINY_BOX_MESSAGE);
  }

  const width = Math.max(0, Number.isFinite(layout.width) ? layout.width : 0);
  const height = Math.max(0, Number.isFinite(layout.height) ? layout.height : 0);
  const scaleX = width > 0 ? box.width / width : Number.POSITIVE_INFINITY;
  const scaleY = height > 0 ? box.height / height : Number.POSITIVE_INFINITY;
  const scale = Math.min(scaleX, scaleY);
  if (!Number.isFinite(scale) || scale <= 0) {
    return { ops: [], scale: 1, width: 0, height: 0, baseline: 0 };
  }
  return {
    ops: layout.ops.map(op => scaleOp(op, scale)),
    scale,
    width: round(width * scale),
    height: round(height * scale),
    baseline: round((Number.isFinite(layout.baseline) ? layout.baseline : 0) * scale),
  };
}

function scaleOp(op: Op, scale: number): Op {
  const out: Op = { kind: op.kind, x: round(op.x * scale), y: round(op.y * scale), size: round(op.size * scale) };
  if (op.kind === 'text') out.text = op.text ?? '';
  if (op.thickness !== undefined) out.thickness = round(op.thickness * scale);
  if (op.x2 !== undefined) out.x2 = round(op.x2 * scale);
  if (op.y2 !== undefined) out.y2 = round(op.y2 * scale);
  return out;
}

// --- Text and SVG renderings ---------------------------------------------

/**
 * Flattens a formula to readable plain text, for a text layer or a search index: Greek becomes its
 * Unicode letter, `\times` its sign, a fraction its two sides around a slash, a script its `^` or `_`
 * marker, and a radical `√(…)`. A side or script that spans more than one character and contains an
 * operator is parenthesised, so `\frac{a+b}{2}` reads `(a+b)/2` and not `a+b/2`.
 */
export function plainText(latex: string): string {
  const source = typeof latex === 'string' ? latex : '';
  const cursor: Cursor = { source, index: 0, warnings: new Set<string>() };
  const root: Node = { kind: 'row', items: parseSequence(cursor, false) };
  return renderPlain(root);
}

const PLAIN_OPERATOR = /[\s+\-−×÷±=<>^_/]/u;

function groupPlain(text: string): string {
  if (text.length <= 1) return text;
  if (text.startsWith('(') && text.endsWith(')')) return text;
  return PLAIN_OPERATOR.test(text) ? `(${text})` : text;
}

function renderPlain(node: Node): string {
  switch (node.kind) {
    case 'atom':
      return node.text;
    case 'space':
      return ' ';
    case 'row':
      return node.items.map(renderPlain).join('');
    case 'script': {
      const base = renderPlain(node.base);
      const sub = node.sub ? `_${groupPlain(renderPlain(node.sub))}` : '';
      const sup = node.sup ? `^${groupPlain(renderPlain(node.sup))}` : '';
      return `${base}${sub}${sup}`;
    }
    case 'frac':
      return `${groupPlain(renderPlain(node.numerator))}/${groupPlain(renderPlain(node.denominator))}`;
    case 'sqrt':
      return `√(${renderPlain(node.body)})`;
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function numberString(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/**
 * Renders a plan as a standalone SVG document for a preview pane or a test fixture.
 *
 * SVG's y axis grows down and plan space's grows up, so every `y` is flipped through the layout's
 * height. The text is escaped and the only font reference is the generic `serif` family: nothing here
 * asks for a font file, a web font or a machine-specific face, so the same string renders anywhere.
 */
export function toSvg(layout: FormulaLayout): string {
  const width = Math.max(0, Number.isFinite(layout.width) ? layout.width : 0);
  const height = Math.max(0, Number.isFinite(layout.height) ? layout.height : 0);
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${numberString(width)}" height="${numberString(height)}" viewBox="0 0 ${numberString(width)} ${numberString(height)}" role="img">`,
  );
  // A role without a name is ignored by assistive technology; a preview still deserves one.
  parts.push('<title>Formula</title>');
  parts.push('<g fill="#111111">');
  for (const op of layout.ops) {
    if (op.kind === 'text') {
      const text = op.text ?? '';
      if (text.length === 0) continue;
      parts.push(
        `<text x="${numberString(op.x)}" y="${numberString(height - op.y)}" font-family="serif" font-size="${numberString(op.size)}">${escapeXml(text)}</text>`,
      );
      continue;
    }
    const stroke = op.thickness ?? DEFAULT_RULE_THICKNESS;
    if (op.kind === 'rule') {
      parts.push(
        `<rect x="${numberString(op.x)}" y="${numberString(height - op.y - stroke / 2)}" width="${numberString(op.size)}" height="${numberString(stroke)}"/>`,
      );
      continue;
    }
    const endX = op.x2 ?? op.x + op.size;
    const endY = op.y2 ?? op.y;
    parts.push(
      `<line x1="${numberString(op.x)}" y1="${numberString(height - op.y)}" x2="${numberString(endX)}" y2="${numberString(height - endY)}" stroke="#111111" stroke-width="${numberString(stroke)}"/>`,
    );
  }
  parts.push('</g>');
  parts.push('</svg>');
  return parts.join('');
}

// --- Drawing -------------------------------------------------------------

/** Where and with what {@link drawFormula} writes a plan. */
export interface FormulaDrawOptions {
  /** Left edge of the formula in PDF space, in points. */
  x: number;
  /** Where the formula's main baseline sits in PDF space, in points. */
  y: number;
  /** The face that draws the runs. */
  font: PDFFont;
  /** Ink colour; black when omitted. */
  color?: RGB;
  /** Rewrites a run for the face; the default passes text through unchanged. */
  prepare?: (text: string) => string;
}

export interface FormulaDrawResult {
  /** Ops that reached the page. */
  drawn: number;
  /** Text ops left out because the face could not draw them. */
  skipped: number;
}

/**
 * Writes a plan onto a pdf-lib page at `options.x`/`options.y`, which address the plan's left edge and
 * main baseline, so a formula can sit on the same baseline as the text beside it.
 *
 * Text that the face cannot encode is counted in `skipped` rather than throwing: pdf-lib rejects a
 * WinAnsi write of a Greek letter, and a formula with one unsupported run should still draw the rest.
 * Pass `prepare` (a `PdfFontSet.prepare` from `./fonts`) to fold or drop such characters up front.
 */
export function drawFormula(page: PDFPage, layout: FormulaLayout, options: FormulaDrawOptions): FormulaDrawResult {
  const ink = options.color ?? rgb(0, 0, 0);
  const baselineOffset = options.y - layout.baseline;
  let drawn = 0;
  let skipped = 0;

  for (const op of layout.ops) {
    if (op.kind === 'text') {
      const source = typeof op.text === 'string' ? op.text : '';
      const text = options.prepare ? options.prepare(source) : source;
      if (text.trim().length === 0) {
        skipped++;
        continue;
      }
      try {
        page.drawText(text, {
          x: options.x + op.x,
          y: baselineOffset + op.y,
          size: op.size,
          font: options.font,
          color: ink,
        });
        drawn++;
      } catch {
        skipped++;
      }
      continue;
    }

    const thickness = op.thickness ?? DEFAULT_RULE_THICKNESS;
    if (op.kind === 'rule') {
      page.drawRectangle({
        x: options.x + op.x,
        y: baselineOffset + op.y - thickness / 2,
        width: op.size,
        height: thickness,
        color: ink,
      });
      drawn++;
      continue;
    }

    page.drawLine({
      start: { x: options.x + op.x, y: baselineOffset + op.y },
      end: { x: options.x + (op.x2 ?? op.x + op.size), y: baselineOffset + (op.y2 ?? op.y) },
      thickness,
      color: ink,
      lineCap: LineCapStyle.Butt,
    });
    drawn++;
  }

  return { drawn, skipped };
}
