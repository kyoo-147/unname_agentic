/**
 * Inline and display formula recovery (backlog item E07).
 *
 * A PDF gives the reader text runs, not formulas: the mathematics arrives as the
 * same flat characters as the prose around it. This module separates the two so
 * the reader can show a formula untouched, offer a LaTeX form to copy, and keep
 * the formula out of machine translation.
 *
 * Three entry points, each usable on its own:
 * - {@link segmentText} splits one line into `text`, `inline-math` and
 *   `display-math` runs.
 * - {@link toLatex} converts the body of one math run to LaTeX.
 * - {@link detectFormulas} finds the blocks of a page that carry formulas, and
 *   {@link protectForTranslation} masks those runs through `protect.ts` so a
 *   translator cannot rewrite them.
 *
 * Contract:
 * - Pure and deterministic: no globals, no clock, no randomness, no locale. The
 *   same line always produces the same runs and the same LaTeX.
 * - Nothing is invented. A run's `value` is the source slice, verbatim, so the
 *   caller can always draw what the page actually holds; `latex` is a conversion
 *   of that same slice and is only present on math runs.
 * - `latex` holds the converted *body*, without delimiters: the caller wraps it
 *   as `$…$` or `$$…$$` to match how the source was set. A body that already
 *   contains LaTeX commands (`\alpha`, `\frac{a}{b}`) is passed through rather
 *   than escaped into something unreadable.
 * - Conservative about bare formulas. A run is only called math when it is
 *   built from math-shaped tokens (see {@link BARE_MIN_SYMBOL_DENSITY}) and its
 *   operator/symbol density clears the documented threshold. Prose such as
 *   `and/or` or `3/4 of the sample` therefore stays text: a slash is not an
 *   operator here, so neither token is math-shaped.
 * - Formulas are recognised from text only. A formula drawn as a glyph run with
 *   no text layer, or one the extractor shredded across lines, is out of scope.
 */

import { mask, placeholderFor, PLACEHOLDER_CLOSE, PLACEHOLDER_OPEN } from './protect';
import type { MaskResult, ProtectedToken } from './protect';

/** What one run of a line is: prose, inline math, or a display equation. */
export type SegmentKind = 'text' | 'inline-math' | 'display-math';

/** One run of a segmented line. `latex` is present on math runs only. */
export interface Segment {
  kind: SegmentKind;
  /** Source characters, verbatim, delimiters included when the source had them. */
  value: string;
  /** LaTeX for the run body, without delimiters; absent on text runs. */
  latex?: string;
}

/** A run known to be math, with its LaTeX always present. */
export interface MathSegment extends Segment {
  kind: 'inline-math' | 'display-math';
  latex: string;
}

/**
 * Lowest operator/symbol density a bare run may have, counting the characters in
 * `=+×÷±∓−∑∏∫∬√∞∂∇→←↔⇒⇔∈∉⊂⊃∪∩∀∃¬∧∨≤≥≠≈≡∼<>^_·⋅∗` over its non-space characters.
 * `x = 2` scores 0.33, `H_2O` 0.25 and `3 x 4 = 12` 0.17; a URL with one `=` scores
 * 0.05 and stays prose.
 */
export const BARE_MIN_SYMBOL_DENSITY = 0.15;

/** Longest bare run accepted as a formula; longer runs are prose with symbols in them. */
export const BARE_MAX_CHARS = 80;

/** Most whitespace-separated tokens a bare run may hold. */
export const BARE_MAX_TOKENS = 8;

/**
 * A block as this module reads it: `text` for reader blocks (`TextBlock`), `raw`
 * for Document IR blocks (`Block`). `text` wins when both are present.
 */
export interface FormulaBlockInput {
  text?: string;
  raw?: string;
  id?: string;
}

/** One block that carries at least one formula. */
export interface FormulaBlockHit {
  /** 0-based position of the block in the input array. */
  index: number;
  /** The block's id, when it has a non-empty one. */
  id?: string;
  /** Every run of the block, in reading order; line breaks are not emitted. */
  segments: Segment[];
  /** The math runs of `segments`, in reading order; never empty. */
  formulas: MathSegment[];
}

/** Characters that make a token math-shaped, and that count towards density. */
const MATH_OPERATOR_CHARACTERS = '=+×÷±∓−∑∏∫∬√∞∂∇→←↔⇒⇔∈∉⊂⊃∪∩∀∃¬∧∨≤≥≠≈≡∼<>^_·⋅∗';
const MATH_OPERATOR_SET: ReadonlySet<string> = new Set(Array.from(MATH_OPERATOR_CHARACTERS));

/** Sentence punctuation a bare run may carry at its right edge and lose. */
const TRAILING_PUNCTUATION = '.,;:!?…"\'”’»';

/** Characters that may end a bare run: a value, not a dangling operator. */
const CLOSING_BRACKETS = ')]}%';

/**
 * Characters a bare run may also start on, besides a letter or a digit: an opening
 * bracket and the prefix operators, which take their argument to the right. An
 * infix operator such as `=` may never start a run.
 */
const OPENING_CHARACTERS = '(√∑∏∫∬∂';

/** A token as it sits in a line, with its offsets, before any run is claimed. */
interface Token {
  start: number;
  end: number;
  value: string;
  math: boolean;
}

/** A claimed span of a line, before the value is sliced out of it. */
interface Run {
  start: number;
  end: number;
}

/** A delimiter pair the scanner recognised, with the body between the delimiters. */
interface Delimited {
  start: number;
  end: number;
  kind: 'inline-math' | 'display-math';
  body: string;
}

/** One Greek letter: its LaTeX name, its two code points and the capital's LaTeX. */
interface GreekEntry {
  name: string;
  lower: string;
  upper?: string;
  /** LaTeX for the capital; a bare Latin letter when the capital is a lookalike. */
  upperLatex?: string;
}

const GREEK: readonly GreekEntry[] = [
  { name: 'alpha', lower: 'α', upper: 'Α', upperLatex: 'A' },
  { name: 'beta', lower: 'β', upper: 'Β', upperLatex: 'B' },
  { name: 'gamma', lower: 'γ', upper: 'Γ', upperLatex: '\\Gamma' },
  { name: 'delta', lower: 'δ', upper: 'Δ', upperLatex: '\\Delta' },
  { name: 'epsilon', lower: 'ε', upper: 'Ε', upperLatex: 'E' },
  { name: 'zeta', lower: 'ζ', upper: 'Ζ', upperLatex: 'Z' },
  { name: 'eta', lower: 'η', upper: 'Η', upperLatex: 'H' },
  { name: 'theta', lower: 'θ', upper: 'Θ', upperLatex: '\\Theta' },
  { name: 'iota', lower: 'ι', upper: 'Ι', upperLatex: 'I' },
  { name: 'kappa', lower: 'κ', upper: 'Κ', upperLatex: 'K' },
  { name: 'lambda', lower: 'λ', upper: 'Λ', upperLatex: '\\Lambda' },
  { name: 'mu', lower: 'μ', upper: 'Μ', upperLatex: 'M' },
  { name: 'nu', lower: 'ν', upper: 'Ν', upperLatex: 'N' },
  { name: 'xi', lower: 'ξ', upper: 'Ξ', upperLatex: '\\Xi' },
  { name: 'omicron', lower: 'ο', upper: 'Ο', upperLatex: 'O' },
  { name: 'pi', lower: 'π', upper: 'Π', upperLatex: '\\Pi' },
  { name: 'rho', lower: 'ρ', upper: 'Ρ', upperLatex: 'P' },
  { name: 'sigma', lower: 'σ', upper: 'Σ', upperLatex: '\\Sigma' },
  { name: 'tau', lower: 'τ', upper: 'Τ', upperLatex: 'T' },
  { name: 'upsilon', lower: 'υ', upper: 'Υ', upperLatex: '\\Upsilon' },
  { name: 'phi', lower: 'φ', upper: 'Φ', upperLatex: '\\Phi' },
  { name: 'chi', lower: 'χ', upper: 'Χ', upperLatex: 'X' },
  { name: 'psi', lower: 'ψ', upper: 'Ψ', upperLatex: '\\Psi' },
  { name: 'omega', lower: 'ω', upper: 'Ω', upperLatex: '\\Omega' },
  { name: 'varsigma', lower: 'ς' },
];

/** Greek code point to LaTeX; capitals that look like Latin letters map to the letter. */
const GREEK_CHARACTER_LATEX = new Map<string, string>();
/** Greek name to LaTeX, in both the `alpha` and the `Alpha` spelling. */
const GREEK_NAME_LATEX = new Map<string, string>();
for (const entry of GREEK) {
  GREEK_CHARACTER_LATEX.set(entry.lower, `\\${entry.name}`);
  GREEK_NAME_LATEX.set(entry.name, `\\${entry.name}`);
  if (entry.upper !== undefined && entry.upperLatex !== undefined) {
    GREEK_CHARACTER_LATEX.set(entry.upper, entry.upperLatex);
    GREEK_NAME_LATEX.set(`${entry.name.charAt(0).toUpperCase()}${entry.name.slice(1)}`, entry.upperLatex);
  }
}

/** Longest names first, so `epsilon` is claimed before `iota`-style substrings. */
const GREEK_NAME_PATTERN = new RegExp(
  `(?<![\\\\\\p{L}])(${[...GREEK_NAME_LATEX.keys()].sort((a, b) => b.length - a.length).join('|')})(?!\\p{L})`,
  'gu',
);

/** Operators and symbols with a LaTeX spelling; `√` is handled separately. */
const OPERATOR_LATEX = new Map<string, string>([
  ['×', '\\times'],
  ['÷', '\\div'],
  ['±', '\\pm'],
  ['∓', '\\mp'],
  ['≤', '\\le'],
  ['≥', '\\ge'],
  ['≠', '\\ne'],
  ['≈', '\\approx'],
  ['≡', '\\equiv'],
  ['∼', '\\sim'],
  ['∞', '\\infty'],
  ['∂', '\\partial'],
  ['∇', '\\nabla'],
  ['→', '\\to'],
  ['←', '\\leftarrow'],
  ['↔', '\\leftrightarrow'],
  ['⇒', '\\Rightarrow'],
  ['⇔', '\\Leftrightarrow'],
  ['∑', '\\sum'],
  ['∏', '\\prod'],
  ['∫', '\\int'],
  ['∬', '\\iint'],
  ['∈', '\\in'],
  ['∉', '\\notin'],
  ['⊂', '\\subset'],
  ['⊃', '\\supset'],
  ['∪', '\\cup'],
  ['∩', '\\cap'],
  ['∀', '\\forall'],
  ['∃', '\\exists'],
  ['¬', '\\neg'],
  ['∧', '\\wedge'],
  ['∨', '\\vee'],
  ['⋅', '\\cdot'],
  ['·', '\\cdot'],
  ['∗', '\\ast'],
  ['−', '-'],
  ['°', '^{\\circ}'],
]);

const TOKEN_PATTERN = /\S+/gu;
const PLACEHOLDER_SCAN = new RegExp(
  `${PLACEHOLDER_OPEN}\\s*(\\d{1,9})\\s*${PLACEHOLDER_CLOSE}`,
  'gu',
);

/** A fraction side: a short number, a single character, or a letter with an index. */
const SIMPLE_FRACTION_SIDE = String.raw`(?:\d{1,4}|[\p{L}\p{N}]|[\p{L}]\d{1,3})`;

/** A whole token that is a simple fraction, with no spaces around the slash. */
const SIMPLE_FRACTION_TOKEN = new RegExp(
  String.raw`^(?:${SIMPLE_FRACTION_SIDE})\/(?:${SIMPLE_FRACTION_SIDE})$`,
  'u',
);

/** A simple fraction anywhere in a math run, spaces around the slash allowed. */
const SIMPLE_FRACTION = new RegExp(
  String.raw`(?<![\p{L}\p{N}^{}_])(${SIMPLE_FRACTION_SIDE})\s*\/\s*(${SIMPLE_FRACTION_SIDE})(?![\p{L}\p{N}^{}_])`,
  'gu',
);

// --- Segmentation ---------------------------------------------------------

/**
 * Splits one line into text and math runs.
 *
 * Recognised delimiters, checked in this order: `$$…$$` and `\[…\]` are display
 * math, `\(…\)` and `$…$` are inline math. A `$` is only an opener when the next
 * character is neither a digit, a space nor another `$`, and only a `$` not
 * preceded by a space closes it, so `$5 and $6` stays currency. An opener with no
 * closer is left as ordinary text rather than swallowing the rest of the line.
 *
 * Text between the delimiters is then scanned for bare formulas: a maximal run of
 * math-shaped tokens that carries at least one operator, at least one letter, fits
 * within {@link BARE_MAX_CHARS} characters and {@link BARE_MAX_TOKENS} tokens, and
 * reaches {@link BARE_MIN_SYMBOL_DENSITY}. A run may start on a value or on an
 * opening bracket or prefix operator (`√`, `∑`, `∫`, …), but never on an infix
 * operator, and its right edge is cut back to the last value, so `x =` is not a
 * formula. Bare runs are reported as `inline-math`.
 *
 * An empty or non-string line returns no runs; a line with no formula returns one
 * `text` run holding the whole line, unchanged.
 */
export function segmentText(text: string): Segment[] {
  const segments: Segment[] = [];
  if (typeof text !== 'string' || text.length === 0) return segments;

  let cursor = 0;
  let index = 0;
  while (index < text.length) {
    const hit = matchDelimiter(text, index);
    if (!hit) {
      index += 1;
      continue;
    }
    pushText(segments, text.slice(cursor, hit.start));
    segments.push({
      kind: hit.kind,
      value: text.slice(hit.start, hit.end),
      latex: toLatex(hit.body),
    });
    index = hit.end;
    cursor = hit.end;
  }
  pushText(segments, text.slice(cursor));
  return segments;
}

/** Adds one stretch of plain text, carved into text and bare-math runs. */
function pushText(segments: Segment[], text: string): void {
  if (text.length === 0) return;
  const runs = bareMathRuns(text);
  if (runs.length === 0) {
    segments.push({ kind: 'text', value: text });
    return;
  }
  let cursor = 0;
  for (const run of runs) {
    if (run.start > cursor) segments.push({ kind: 'text', value: text.slice(cursor, run.start) });
    const value = text.slice(run.start, run.end);
    segments.push({ kind: 'inline-math', value, latex: toLatex(value) });
    cursor = run.end;
  }
  if (cursor < text.length) segments.push({ kind: 'text', value: text.slice(cursor) });
}

/** Returns the delimiter pair opening at `at`, or `null` when there is no valid one. */
function matchDelimiter(text: string, at: number): Delimited | null {
  const pair = text.slice(at, at + 2);
  if (pair === '$$') {
    const close = text.indexOf('$$', at + 2);
    if (close > at + 2) {
      return { start: at, end: close + 2, kind: 'display-math', body: text.slice(at + 2, close) };
    }
    return null;
  }
  if (pair === '\\[') {
    const close = text.indexOf('\\]', at + 2);
    if (close > at + 2) {
      return { start: at, end: close + 2, kind: 'display-math', body: text.slice(at + 2, close) };
    }
    return null;
  }
  if (pair === '\\(') {
    const close = text.indexOf('\\)', at + 2);
    if (close > at + 2) {
      return { start: at, end: close + 2, kind: 'inline-math', body: text.slice(at + 2, close) };
    }
    return null;
  }
  if (text.charAt(at) === '$') return matchDollar(text, at);
  return null;
}

/** Returns the `$…$` pair opening at `at`, or `null` for currency and unbalanced dollars. */
function matchDollar(text: string, at: number): Delimited | null {
  if (at > 0 && text.charAt(at - 1) === '\\') return null;
  const first = text.charAt(at + 1);
  if (first === '' || first === '$' || /[\s\d\\]/u.test(first)) return null;
  for (let index = at + 2; index < text.length; index += 1) {
    if (text.charAt(index) !== '$') continue;
    // A `$$` here opens a display equation, and a `$` after a space opens another
    // formula: either way this opener has no closer of its own, so the scan stops
    // instead of letting the pair swallow the prose between them.
    if (text.charAt(index + 1) === '$') return null;
    if (/[\s\\$]/u.test(text.charAt(index - 1))) return null;
    return { start: at, end: index + 1, kind: 'inline-math', body: text.slice(at + 1, index) };
  }
  return null;
}

// --- Bare formula detection ----------------------------------------------

/** Collects the bare-formula runs of one text stretch, in order and non-overlapping. */
function bareMathRuns(text: string): Run[] {
  const tokens = tokenize(text);
  const runs: Run[] = [];
  let index = 0;
  while (index < tokens.length) {
    const first = tokens[index];
    if (!first || !first.math) {
      index += 1;
      continue;
    }
    let stop = index;
    while (stop + 1 < tokens.length && tokens[stop + 1]?.math === true) stop += 1;
    const last = tokens[stop];
    index = stop + 1;
    if (!last) continue;

    const end = trimRunEnd(text, first.start, last.end);
    if (end <= first.start) continue;
    const value = text.slice(first.start, end);
    if (!isBareFormula(value)) continue;
    runs.push({ start: first.start, end });
  }
  return runs;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const value = match[0];
    const start = match.index ?? 0;
    tokens.push({ start, end: start + value.length, value, math: isMathShapedToken(value) });
  }
  return tokens;
}

/**
 * A token is math-shaped when it carries an operator, is a number, is a single
 * letter (Latin or Greek), is a Greek name, is a simple fraction (`a/b`, `W/Q`,
 * `3/4`), or is a function application such as `f(x)`. Anything else — `and/or`,
 * `of`, `sample.` — is prose.
 */
function isMathShapedToken(token: string): boolean {
  if (token.length === 0) return false;
  if (hasOperator(token)) return true;
  if (/^\d{1,3}(?:[.,\u00A0\u202F\u2009]\d{3})*(?:[.,]\d+)?%?$/u.test(token)) return true;
  if (/^\p{L}$/u.test(token)) return true;
  if (GREEK_NAME_LATEX.has(token)) return true;
  if (SIMPLE_FRACTION_TOKEN.test(token)) return true;
  if (/^\p{L}[\p{L}\p{N}]*(?:\([^()]*\))+$/u.test(token)) return true;
  return false;
}

/** Cuts the run back to its last value: sentence punctuation, whitespace and dangling operators fall away. */
function trimRunEnd(text: string, start: number, end: number): number {
  let stop = end;
  let changed = true;
  while (changed && stop > start) {
    changed = false;
    while (stop > start && TRAILING_PUNCTUATION.includes(text.charAt(stop - 1))) {
      stop -= 1;
      changed = true;
    }
    if (stop > start && MATH_OPERATOR_SET.has(text.charAt(stop - 1))) {
      stop -= 1;
      changed = true;
    }
    while (stop > start && /\s/u.test(text.charAt(stop - 1))) {
      stop -= 1;
      changed = true;
    }
  }
  return stop;
}

/** Applies the documented acceptance rules to one trimmed candidate run. */
function isBareFormula(run: string): boolean {
  const characters = Array.from(run);
  if (characters.length === 0 || characters.length > BARE_MAX_CHARS) return false;
  const tokens = run.split(/\s+/u).filter(token => token.length > 0);
  if (tokens.length === 0 || tokens.length > BARE_MAX_TOKENS) return false;
  if (!hasOperator(run)) return false;
  if (!/\p{L}/u.test(run)) return false;

  const first = characters[0] ?? '';
  const last = characters[characters.length - 1] ?? '';
  if (!/[\p{L}\p{N}]/u.test(first) && !OPENING_CHARACTERS.includes(first)) return false;
  if (!/[\p{L}\p{N}]/u.test(last) && !CLOSING_BRACKETS.includes(last)) return false;

  return symbolDensity(run) >= BARE_MIN_SYMBOL_DENSITY;
}

function hasOperator(text: string): boolean {
  for (const character of text) if (MATH_OPERATOR_SET.has(character)) return true;
  return false;
}

/** Operator characters over non-space characters; 0 for a run of nothing but spaces. */
function symbolDensity(text: string): number {
  let symbols = 0;
  let total = 0;
  for (const character of text) {
    if (/\s/u.test(character)) continue;
    total += 1;
    if (MATH_OPERATOR_SET.has(character)) symbols += 1;
  }
  return total === 0 ? 0 : symbols / total;
}

// --- Block-level drivers --------------------------------------------------

/**
 * Returns the blocks that carry at least one formula, each with its index and its
 * runs. Blocks without a formula are left out, so the result is already filtered
 * for the reader. Block text is segmented line by line; the concatenated
 * `segments` do not contain the line breaks themselves.
 *
 * Accepts the reader's `TextBlock` list (text in `text`) and the Document IR's
 * `Block` list (text in `raw`) alike.
 */
export function detectFormulas(blocks: readonly FormulaBlockInput[]): FormulaBlockHit[] {
  const hits: FormulaBlockHit[] = [];
  if (!Array.isArray(blocks)) return hits;
  blocks.forEach((block, index) => {
    const segments = segmentBlock(block);
    const formulas = segments.filter(isMathSegment);
    if (formulas.length === 0) return;
    const hit: FormulaBlockHit = { index, segments, formulas };
    if (typeof block?.id === 'string' && block.id.length > 0) hit.id = block.id;
    hits.push(hit);
  });
  return hits;
}

/**
 * Masks a block for translation, locking every formula run as one token.
 *
 * The block is segmented like {@link detectFormulas}. Each math run becomes one
 * `formula` placeholder holding the source run verbatim, so no translator can
 * change a symbol, a subscript or a delimiter. Each text run goes through
 * `protect.ts` unchanged, so numbers, URLs, citations and the rest keep the
 * protection they already had. Placeholders are numbered from 1 in reading order,
 * and line breaks are kept, so the result can be translated line by line and put
 * back with `restore` from `protect.ts`.
 */
export function protectForTranslation(block: FormulaBlockInput): MaskResult {
  const text = blockText(block);
  if (text.length === 0) return { masked: '', tokens: [] };

  const tokens: ProtectedToken[] = [];
  let masked = '';
  text.split(/\r?\n/u).forEach((line, position) => {
    if (position > 0) masked += '\n';
    masked += maskLine(line, tokens);
  });
  return { masked, tokens };
}

/** Masks one line, appending its tokens to `tokens` and returning the masked text. */
function maskLine(line: string, tokens: ProtectedToken[]): string {
  let masked = '';
  for (const segment of segmentText(line)) {
    if (segment.kind === 'text') {
      const result = mask(segment.value);
      const renumbered = new Map<number, number>();
      for (const token of result.tokens) {
        const index = tokens.length + 1;
        renumbered.set(token.index, index);
        tokens.push({ index, value: token.value, kind: token.kind });
      }
      masked += renumberPlaceholders(result.masked, renumbered);
      continue;
    }
    const index = tokens.length + 1;
    tokens.push({ index, value: segment.value, kind: 'formula' });
    masked += placeholderFor(index);
  }
  return masked;
}

function renumberPlaceholders(masked: string, renumbered: ReadonlyMap<number, number>): string {
  let out = '';
  let cursor = 0;
  for (const match of masked.matchAll(PLACEHOLDER_SCAN)) {
    const start = match.index ?? 0;
    out += masked.slice(cursor, start);
    const observed = Number.parseInt(match[1] ?? '', 10);
    const mapped = renumbered.get(observed);
    out += mapped === undefined ? match[0] : placeholderFor(mapped);
    cursor = start + match[0].length;
  }
  return out + masked.slice(cursor);
}

function segmentBlock(block: FormulaBlockInput): Segment[] {
  const text = blockText(block);
  if (text.length === 0) return [];
  const segments: Segment[] = [];
  for (const line of text.split(/\r?\n/u)) {
    for (const segment of segmentText(line)) segments.push(segment);
  }
  return segments;
}

function blockText(block: FormulaBlockInput): string {
  if (typeof block?.text === 'string') return block.text;
  if (typeof block?.raw === 'string') return block.raw;
  return '';
}

function isMathSegment(segment: Segment): segment is MathSegment {
  return segment.kind !== 'text' && typeof segment.latex === 'string';
}

// --- LaTeX conversion -----------------------------------------------------

/**
 * Converts the body of one math run to LaTeX.
 *
 * Order, and what each step does:
 * 1. Whitespace collapses to single spaces.
 * 2. Greek *names* (`alpha`, `Omega`) become commands; the capital of a lookalike
 *    letter (`Alpha`, `Chi`) becomes the Latin letter, which is what LaTeX has.
 * 3. `√` becomes `\sqrt{…}`, taking the braced group, the parenthesised group or
 *    the next token as its argument.
 * 4. Unicode operators gain their commands (`×` → `\times`, `≤` → `\le`, `∑` →
 *    `\sum`, …) and Greek code points their letters.
 * 5. Scripts are braced: `x^2` → `x^{2}`, `x_1` → `x_{1}`, so `H_2O` → `H_{2}O`.
 *    An already braced script such as `a^{n+1}` is kept, only re-spaced.
 * 6. A slash becomes `\frac` only when both sides are simple tokens: a short
 *    number, a single character, or a letter with a numeric index. `a/b` becomes
 *    `\frac{a}{b}`; `and/or` keeps its slash because both of its sides are longer
 *    than one character.
 * 7. A `%` that is not already escaped becomes `\%`.
 *
 * LaTeX already present in the body (`\frac{a}{b}`, `\alpha + \beta`) passes
 * through: names preceded by a backslash are not re-converted and an escaped `%`
 * is left alone.
 */
export function toLatex(math: string): string {
  if (typeof math !== 'string' || math.length === 0) return '';
  let body = collapseSpaces(math);
  body = replaceGreekNames(body);
  body = replaceSquareRoots(body);
  body = mapCharacters(body, OPERATOR_LATEX);
  body = replaceGreekCharacters(body);
  body = wrapScripts(body);
  body = convertFractions(body);
  body = escapePercent(body);
  return collapseSpaces(body);
}

function replaceGreekNames(body: string): string {
  // The pattern spells out both the `alpha` and the `Alpha` key, so the lookup is direct.
  return body.replace(GREEK_NAME_PATTERN, (match: string) => GREEK_NAME_LATEX.get(match) ?? match);
}

const SQRT_BRACED = /√\s*\{([^{}]*)\}/gu;
const SQRT_PARENTHESISED = /√\s*\(([^()]*)\)/gu;
const SQRT_BARE = /√\s*(-?[\p{L}\p{N}][\p{L}\p{N}]*)/gu;

function replaceSquareRoots(body: string): string {
  let out = body.replace(SQRT_BRACED, (_match: string, inner: string) => `\\sqrt{${inner.trim()}}`);
  out = out.replace(SQRT_PARENTHESISED, (_match: string, inner: string) => `\\sqrt{${inner.trim()}}`);
  out = out.replace(SQRT_BARE, (_match: string, radicand: string) => `\\sqrt{${radicand}}`);
  return out.replace(/√/gu, '\\sqrt');
}

function mapCharacters(body: string, table: ReadonlyMap<string, string>): string {
  let out = '';
  for (const character of body) out += table.get(character) ?? character;
  return out;
}

function replaceGreekCharacters(body: string): string {
  return mapCharacters(body, GREEK_CHARACTER_LATEX);
}

const SCRIPT_BRACED = /([_^])\s*\{([^{}]*)\}/gu;
const SCRIPT_BARE = /([_^])\s*(-?[\p{L}\p{N}][\p{N}]*)/gu;

function wrapScripts(body: string): string {
  const braced = body.replace(
    SCRIPT_BRACED,
    (_match: string, marker: string, inner: string) => `${marker}{${inner.trim()}}`,
  );
  return braced.replace(
    SCRIPT_BARE,
    (_match: string, marker: string, value: string) => `${marker}{${value}}`,
  );
}

function convertFractions(body: string): string {
  return body.replace(
    SIMPLE_FRACTION,
    (_match: string, numerator: string, denominator: string) =>
      `\\frac{${numerator}}{${denominator}}`,
  );
}

function escapePercent(body: string): string {
  return body.replace(/(?<!\\)%/gu, '\\%');
}

function collapseSpaces(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}
