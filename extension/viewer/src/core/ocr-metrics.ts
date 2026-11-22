/**
 * OCR quality metrics (backlog N05). CER and WER are the two numbers the OCR
 * benchmark reports, so the maths lives here as pure functions with no DOM, no
 * engine and no I/O: the runner script, the tests and any later quality panel
 * call the same code and cannot disagree about what a "character error" means.
 *
 * Counting rules:
 * - Text is NFC-normalised first, so a precomposed `ế` and a decomposed
 *   `e` + circumflex + acute are the same glyph. A missing or wrong diacritic
 *   still costs a whole character, which is what makes the Vietnamese numbers
 *   mean something.
 * - Any run of whitespace collapses to one space and the edges are trimmed. The
 *   single spaces that survive count as characters and separate words.
 * - Distances are measured in code points, so an astral glyph is one error
 *   rather than two.
 * - `rate` is `errors / total`. `total = 0` means an empty reference: rate 0
 *   when the hypothesis is empty too, and rate 1 when it is not, because every
 *   character was an insertion.
 */

/** Counts behind one rate, kept together so callers never reformat a percentage by hand. */
export interface ErrorRate {
  errors: number;
  total: number;
  /** `errors / total`, or 0/1 for an empty reference (see the file comment). */
  rate: number;
}

/** One step of a word edit script, from the reference towards the hypothesis. */
export type AlignOp =
  | { op: 'match'; reference: string; hypothesis: string }
  | { op: 'substitute'; reference: string; hypothesis: string }
  | { op: 'delete'; reference: string }
  | { op: 'insert'; hypothesis: string };

export interface WordAlignment extends ErrorRate {
  /** Normalised reference words, in reading order. */
  reference: string[];
  /** Normalised hypothesis words, in reading order. */
  hypothesis: string[];
  /** Edit script that turns `reference` into `hypothesis`. */
  ops: AlignOp[];
}

// Empty reference: no errors is a perfect match, any error is an inserted character we could not avoid.
function rateOf(errors: number, total: number): number {
  if (total > 0) return errors / total;
  return errors > 0 ? 1 : 0;
}

/** NFC plus collapsed whitespace: the only form any metric here compares. */
export function normalizeOcrText(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Whitespace-separated words of the normalised text; empty text has no words. */
export function splitWords(text: string): string[] {
  const normalized = normalizeOcrText(text);
  return normalized ? normalized.split(' ') : [];
}

/** Characters that CER will divide by: normalised text measured in code points. */
export function countCharacters(text: string): number {
  return Array.from(normalizeOcrText(text)).length;
}

function codePoints(text: string): string[] {
  return Array.from(normalizeOcrText(text));
}

// Typed-array reads are `number | undefined` under noUncheckedIndexedAccess; every index
// used below is inside the allocated matrix by construction.
function cell(matrix: Int32Array, index: number): number {
  return matrix[index] as number;
}

/** Levenshtein distance with unit substitution, insertion and deletion costs, in code points. */
export function characterDistance(reference: string, hypothesis: string): number {
  const source = codePoints(reference);
  const target = codePoints(hypothesis);
  if (source.length === 0) return target.length;
  if (target.length === 0) return source.length;

  // Two rows of the DP matrix are enough: only the previous row feeds the next one.
  let previous = new Int32Array(target.length + 1);
  let current = new Int32Array(target.length + 1);
  for (let column = 0; column <= target.length; column++) previous[column] = column;

  for (let row = 1; row <= source.length; row++) {
    const character = source[row - 1];
    current[0] = row;
    for (let column = 1; column <= target.length; column++) {
      const substitute = cell(previous, column - 1) + (character === target[column - 1] ? 0 : 1);
      const remove = cell(previous, column) + 1;
      const insert = cell(current, column - 1) + 1;
      current[column] = Math.min(substitute, remove, insert);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return cell(previous, target.length);
}

/** Character error rate: `total` is the reference length in code points. */
export function characterErrorRate(reference: string, hypothesis: string): ErrorRate {
  const total = countCharacters(reference);
  const errors = characterDistance(reference, hypothesis);
  return { errors, total, rate: rateOf(errors, total) };
}

/**
 * Word-level Levenshtein with a backtracked edit script. Ties resolve
 * deterministically: a diagonal step (match or substitution) is preferred, then
 * a deletion, then an insertion, so the same input always yields the same script.
 */
export function alignWords(reference: string, hypothesis: string): WordAlignment {
  const source = splitWords(reference);
  const target = splitWords(hypothesis);
  const width = target.length + 1;
  const costs = new Int32Array((source.length + 1) * width);
  for (let column = 0; column <= target.length; column++) costs[column] = column;
  for (let row = 1; row <= source.length; row++) costs[row * width] = row;

  for (let row = 1; row <= source.length; row++) {
    const word = source[row - 1];
    for (let column = 1; column <= target.length; column++) {
      const substitute = cell(costs, (row - 1) * width + column - 1) + (word === target[column - 1] ? 0 : 1);
      const remove = cell(costs, (row - 1) * width + column) + 1;
      const insert = cell(costs, row * width + column - 1) + 1;
      costs[row * width + column] = Math.min(substitute, remove, insert);
    }
  }

  const errors = cell(costs, source.length * width + target.length);
  const ops: AlignOp[] = [];
  let row = source.length;
  let column = target.length;
  while (row > 0 || column > 0) {
    const cost = cell(costs, row * width + column);
    if (row > 0 && column > 0) {
      const word = source[row - 1] as string;
      const guess = target[column - 1] as string;
      const same = word === guess;
      if (cost === cell(costs, (row - 1) * width + column - 1) + (same ? 0 : 1)) {
        ops.push(same
          ? { op: 'match', reference: word, hypothesis: guess }
          : { op: 'substitute', reference: word, hypothesis: guess });
        row -= 1;
        column -= 1;
        continue;
      }
    }
    if (row > 0 && cost === cell(costs, (row - 1) * width + column) + 1) {
      ops.push({ op: 'delete', reference: source[row - 1] as string });
      row -= 1;
      continue;
    }
    ops.push({ op: 'insert', hypothesis: target[column - 1] as string });
    column -= 1;
  }
  ops.reverse();
  return { reference: source, hypothesis: target, ops, errors, total: source.length, rate: rateOf(errors, source.length) };
}

/** Word error rate: `total` is the reference word count. */
export function wordErrorRate(reference: string, hypothesis: string): ErrorRate {
  const { errors, total, rate } = alignWords(reference, hypothesis);
  return { errors, total, rate };
}
