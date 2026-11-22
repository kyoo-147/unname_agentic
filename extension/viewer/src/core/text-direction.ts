export type TextDirection = 'ltr' | 'rtl' | 'neutral';

export interface DirectionSignals {
  rtl: number;
  ltr: number;
  cjk: number;
}

type CodePointRange = readonly [number, number];

const RTL_RANGES: readonly CodePointRange[] = [
  [0x0590, 0x05ff], [0xfb1d, 0xfb4f],
  [0x0600, 0x06ff], [0x0750, 0x077f], [0x08a0, 0x08ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff],
  [0x0700, 0x074f], [0x0780, 0x07bf], [0x07c0, 0x07ff], [0x0800, 0x083f], [0x0840, 0x085f],
  [0x1ee00, 0x1eeff],
];

const CJK_RANGES: readonly CodePointRange[] = [
  [0x1100, 0x11ff], [0x3130, 0x318f], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0x3040, 0x30ff], [0x31f0, 0x31ff], [0xff66, 0xff9d],
  [0x3100, 0x312f], [0x31a0, 0x31bf],
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x2fa1f],
];

// Full-width glyphs occupy one narrow-character pair, so layout can budget width per line instead of per code point.
const WIDE_RANGES: readonly CodePointRange[] = [
  [0x2e80, 0x303e], [0x3040, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe4f], [0xff01, 0xff60], [0xffe0, 0xffe6], [0x1100, 0x11ff],
  [0x20000, 0x3fffd],
];

const LETTER = /\p{L}/u;
const MARK = /\p{M}/u;

function inRanges(codePoint: number, ranges: readonly CodePointRange[]): boolean {
  for (const [start, end] of ranges) if (codePoint >= start && codePoint <= end) return true;
  return false;
}

function codePointOf(char: string): number {
  return char.codePointAt(0) ?? 0;
}

function isControl(codePoint: number): boolean {
  return codePoint < 0x20 || codePoint === 0x7f;
}

export function isRtlCodePoint(codePoint: number): boolean {
  return inRanges(codePoint, RTL_RANGES);
}

export function isCjkCodePoint(codePoint: number): boolean {
  return inRanges(codePoint, CJK_RANGES);
}

export function isWideCodePoint(codePoint: number): boolean {
  if (codePoint > 0xffff) return true;
  return inRanges(codePoint, WIDE_RANGES);
}

export function hasCjk(text: string): boolean {
  for (const char of text) if (isCjkCodePoint(codePointOf(char))) return true;
  return false;
}

/**
 * Counts strong characters only: digits, punctuation, whitespace, marks and emoji stay neutral,
 * while CJK ideographs count as left-to-right so a Han/Kana/Hangul line never reads as RTL.
 */
export function countDirectionSignals(text: string): DirectionSignals {
  const signals: DirectionSignals = { rtl: 0, ltr: 0, cjk: 0 };
  for (const char of text.normalize('NFC')) {
    const codePoint = codePointOf(char);
    if (isCjkCodePoint(codePoint)) { signals.cjk++; signals.ltr++; continue; }
    if (!LETTER.test(char)) continue;
    if (isRtlCodePoint(codePoint)) signals.rtl++; else signals.ltr++;
  }
  return signals;
}

function firstStrongDirection(text: string): TextDirection {
  for (const char of text.normalize('NFC')) {
    if (!LETTER.test(char)) continue;
    return isRtlCodePoint(codePointOf(char)) ? 'rtl' : 'ltr';
  }
  return 'neutral';
}

export function detectDirection(text: string): TextDirection {
  const { rtl, ltr } = countDirectionSignals(text);
  if (rtl === 0 && ltr === 0) return 'neutral';
  if (rtl > ltr) return 'rtl';
  if (ltr > rtl) return 'ltr';
  return firstStrongDirection(text);
}

/** A PDF producer's explicit hint wins; otherwise the block text decides, and neutral text reads as ltr. */
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur', 'yi', 'dv']);

export function isRtlLanguage(code: string | undefined): boolean {
  return RTL_LANGUAGES.has((code ?? '').toLowerCase().split('-')[0] ?? '');
}

export function resolveBlockDirection(hint: string | undefined, text: string): 'ltr' | 'rtl' {
  if (hint === 'rtl') return 'rtl';
  if (hint === 'ltr') return 'ltr';
  return detectDirection(text) === 'rtl' ? 'rtl' : 'ltr';
}

/** Width budget in narrow-character units: full-width glyphs cost 1, narrow glyphs 0.5, marks and controls cost nothing. */
export function estimateLineUnits(text: string): number {
  let units = 0;
  for (const char of text.normalize('NFC')) {
    const codePoint = codePointOf(char);
    if (isControl(codePoint) || MARK.test(char)) continue;
    units += isWideCodePoint(codePoint) ? 1 : .5;
  }
  return units;
}
