import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FONT_SIZE,
  OVERFLOW_MARKER,
  annotateFits,
  fitText,
} from '../src/core/reflow';
import type { FitBlock, TextFitResult } from '../src/core/reflow';

/**
 * Fixtures below are laid out for the default width model: an advance of
 * `fontSize * 0.5` points per character and a line advance of `fontSize * 1.2`.
 *
 * At 10 pt a 100 pt box therefore holds 20 characters per line, and at 9.5 pt it holds 21.
 */

/** Four 10-character words: four lines at 20 characters per line, two at 21. */
const WORDS_FOUR = 'aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd';

/** Five 10-character words: three lines at 21 to 31 characters per line. */
const WORDS_FIVE = `${WORDS_FOUR} eeeeeeeeee`;

/** 34 characters, wider than any line these tests can offer. */
const LONG_WORD = 'supercalifragilisticexpialidocious';

/** The characters a reader can see: code points, whitespace excluded. */
function visible(text: string): string {
  return Array.from(text)
    .filter(character => !/\s/u.test(character))
    .join('');
}

/** A line with the overflow marker removed, for the preservation checks. */
function withoutMarker(line: string): string {
  return line.endsWith(OVERFLOW_MARKER) ? line.slice(0, -OVERFLOW_MARKER.length) : line;
}

/** Width the module's own model predicts for a line, in points. */
function estimatedWidth(line: string, result: TextFitResult): number {
  return Array.from(line).length * result.fontSize * 0.5 * result.trackingFactor;
}

/** A result that fit must not drop a single visible character. */
function expectNothingLost(result: TextFitResult, text: string): void {
  expect(result.clippedCharacters).toBe(0);
  expect(result.leftover).toBe('');
  expect(visible(result.lines.join(''))).toBe(visible(text));
}

describe('fitText fitting order', () => {
  it('wraps at the requested size when the text already fits', () => {
    const text = 'one two three';
    const result = fitText(text, { width: 100, height: 24 });

    expect(result).toEqual({
      fontSize: DEFAULT_FONT_SIZE,
      lines: ['one two three'],
      overflow: false,
      clippedCharacters: 0,
      strategy: 'none',
      trackingFactor: 1,
      leftover: '',
      unbreakableWords: 0,
      reasons: ['fit:none'],
    });
    expectNothingLost(result, text);
  });

  it('shrinks by half points to the largest size that fits', () => {
    const result = fitText(WORDS_FOUR, { width: 100, height: 36 });

    expect(result.strategy).toBe('shrink');
    expect(result.fontSize).toBe(9.5);
    expect(result.trackingFactor).toBe(1);
    expect(result.overflow).toBe(false);
    expect(result.lines).toEqual(['aaaaaaaaaa bbbbbbbbbb', 'cccccccccc dddddddddd']);
    expect(result.reasons).toEqual(['fit:shrink=9.5']);
    // The reported size really does fit: 21 characters at 9.5 pt on a 100 pt line.
    expect(result.lines.every(line => estimatedWidth(line, result) <= 100 + 1e-9)).toBe(true);
    expectNothingLost(result, WORDS_FOUR);
  });

  it('condenses at the smallest allowed size when shrinking alone cannot fit', () => {
    const result = fitText(WORDS_FOUR, { width: 96, height: 36 }, { minFontSize: 9.5 });

    expect(result.strategy).toBe('condense');
    expect(result.fontSize).toBe(9.5);
    expect(result.trackingFactor).toBe(0.96);
    expect(result.overflow).toBe(false);
    expect(result.lines).toEqual(['aaaaaaaaaa bbbbbbbbbb', 'cccccccccc dddddddddd']);
    expect(result.reasons).toEqual(['fit:shrink=9.5', 'fit:condense=0.96']);
    expect(result.lines.every(line => estimatedWidth(line, result) <= 96 + 1e-9)).toBe(true);
    expectNothingLost(result, WORDS_FOUR);
  });

  it('keeps the requested size instead of growing to a higher minimum', () => {
    const result = fitText('one two three', { width: 100, height: 24 }, { fontSize: 6, minFontSize: 12 });

    expect(result.strategy).toBe('none');
    expect(result.fontSize).toBe(6);
  });
});

describe('fitText overflow', () => {
  it('accepts overflow, marks the last line and reports what it dropped', () => {
    const result = fitText(WORDS_FIVE, { width: 100, height: 24 });

    expect(result).toEqual({
      fontSize: 7,
      lines: ['aaaaaaaaaa bbbbbbbbbb', 'cccccccccc dddddddddd' + OVERFLOW_MARKER],
      overflow: true,
      clippedCharacters: 10,
      strategy: 'overflow',
      trackingFactor: 0.9,
      leftover: 'eeeeeeeeee',
      unbreakableWords: 0,
      reasons: ['fit:shrink=7', 'fit:condense=0.9', 'fit:clipped=10', 'fit:overflow=2/3'],
    });

    // Every visible character is either on a line or in the leftover: nothing vanished.
    const kept = visible(result.lines.map(withoutMarker).join(''));
    const dropped = visible(result.leftover);
    expect(kept + dropped).toBe(visible(WORDS_FIVE));
    expect(result.lines[result.lines.length - 1]?.endsWith(OVERFLOW_MARKER)).toBe(true);
  });

  it('reports a word that cannot break instead of cutting it', () => {
    const result = fitText(LONG_WORD, { width: 100, height: 40 }, { allowCondense: false });

    expect(result.strategy).toBe('overflow');
    expect(result.overflow).toBe(true);
    expect(result.unbreakableWords).toBe(1);
    expect(result.clippedCharacters).toBe(0);
    expect(result.leftover).toBe('');
    expect(result.lines).toEqual([LONG_WORD]);
    expect(result.reasons).toEqual(['fit:shrink=7', 'fit:wide=1', 'fit:unbreakable=1']);
    // The word is wider than its box at the smallest size the options allow.
    expect(estimatedWidth(LONG_WORD, result)).toBeGreaterThan(100);
  });

  it('clips to maxLines even when the box is tall enough for every line', () => {
    const result = fitText(WORDS_FIVE, { width: 100, height: 200 }, { maxLines: 2, allowCondense: false });

    expect(result.strategy).toBe('overflow');
    expect(result.fontSize).toBe(7);
    expect(result.lines).toHaveLength(2);
    expect(result.clippedCharacters).toBe(10);
    expect(result.leftover).toBe('eeeeeeeeee');
    expect(result.reasons).toEqual(['fit:shrink=7', 'fit:clipped=10', 'fit:overflow=2/3']);
  });

  it('stops at the smallest size when condensing is refused', () => {
    const result = fitText(WORDS_FOUR, { width: 96, height: 36 }, { minFontSize: 9.5, allowCondense: false });

    expect(result.strategy).toBe('overflow');
    expect(result.fontSize).toBe(9.5);
    expect(result.trackingFactor).toBe(1);
    expect(result.clippedCharacters).toBe(10);
    expect(result.leftover).toBe('dddddddddd');
    expect(result.reasons).toEqual(['fit:shrink=9.5', 'fit:clipped=10', 'fit:overflow=3/4']);
  });
});

describe('fitText wrapping model', () => {
  it('returns no lines for empty or whitespace-only text', () => {
    const empty = fitText('', { width: 100, height: 20 });
    expect(empty.lines).toEqual([]);
    expect(empty.strategy).toBe('none');
    expect(empty.clippedCharacters).toBe(0);

    const blank = fitText('   \n\t  ', { width: 100, height: 20 });
    expect(blank.lines).toEqual([]);
    expect(blank.overflow).toBe(false);
  });

  it('breaks a CJK paragraph between characters without inventing spaces', () => {
    const text = '漢'.repeat(30);
    const result = fitText(text, { width: 100, height: 24 });

    expect(result.strategy).toBe('none');
    expect(result.lines.map(line => Array.from(line).length)).toEqual([20, 10]);
    expect(result.lines.join('')).toBe(text);
    expect(result.unbreakableWords).toBe(0);

    const mixed = fitText('abc漢字', { width: 200, height: 40 });
    expect(mixed.lines).toEqual(['abc漢字']);
  });

  it('keeps a hard line break as a line break', () => {
    const result = fitText('first line\nsecond line', { width: 200, height: 60 });

    expect(result.lines).toEqual(['first line', 'second line']);
    expect(result.strategy).toBe('none');
  });
});

describe('fitText refusals', () => {
  it('refuses a box with no width', () => {
    expect(() => fitText('hello', { width: 0, height: 10 })).toThrow(RangeError);
    expect(() => fitText('hello', { width: 0, height: 10 })).toThrow(/positive finite width/u);
  });

  it('refuses a box with no height, a negative side or a non-finite side', () => {
    expect(() => fitText('hello', { width: 100, height: 0 })).toThrow(/positive finite height/u);
    expect(() => fitText('hello', { width: -5, height: 10 })).toThrow(RangeError);
    expect(() => fitText('hello', { width: 100, height: Number.NaN })).toThrow(RangeError);
    expect(() => fitText('hello', undefined as unknown as { width: number; height: number })).toThrow(RangeError);
  });

  it('refuses the whole batch and names the block with no area', () => {
    const blocks: FitBlock[] = [
      { id: 'good', text: 'one two three', box: { width: 100, height: 24 } },
      { id: 'bad', text: 'hello', box: { width: 0, height: 24 } },
    ];

    expect(() => annotateFits(blocks)).toThrow(RangeError);
    expect(() => annotateFits(blocks)).toThrow(/blocks\[1\]\.box/u);
  });
});

describe('annotateFits', () => {
  function sampleBlocks(): FitBlock[] {
    return [
      { id: 'fits', text: 'one two three', box: { width: 100, height: 24 } },
      { id: 'shrinks', text: WORDS_FOUR, box: { width: 100, height: 36 } },
      { id: 'condenses', text: WORDS_FOUR, box: { width: 96, height: 36 }, options: { minFontSize: 9.5 } },
      { id: 'overflows', text: WORDS_FIVE, box: { width: 100, height: 24 } },
    ];
  }

  it('reports one result per block in input order and counts each strategy', () => {
    const annotation = annotateFits(sampleBlocks());

    expect(annotation.results.map(entry => entry.id)).toEqual(['fits', 'shrinks', 'condenses', 'overflows']);
    expect(annotation.results.map(entry => entry.index)).toEqual([0, 1, 2, 3]);
    expect(annotation.results.map(entry => entry.result.strategy)).toEqual([
      'none',
      'shrink',
      'condense',
      'overflow',
    ]);

    expect(annotation.summary).toEqual({
      blocks: 4,
      shrunk: 1,
      condensed: 1,
      overflowed: 1,
      clippedCharacters: 10,
      unbreakableWords: 0,
    });

    // Every block lands in exactly one bucket.
    const { blocks, shrunk, condensed, overflowed } = annotation.summary;
    const none = annotation.results.filter(entry => entry.result.strategy === 'none').length;
    expect(shrunk + condensed + overflowed + none).toBe(blocks);
  });

  it('sums clipped characters and unbreakable words across blocks', () => {
    const annotation = annotateFits([
      { id: 'long-word', text: LONG_WORD, box: { width: 100, height: 40 }, options: { allowCondense: false } },
      { id: 'cut', text: WORDS_FIVE, box: { width: 100, height: 24 } },
      { id: 'fine', text: 'one two', box: { width: 100, height: 24 } },
    ]);

    expect(annotation.summary.unbreakableWords).toBe(1);
    expect(annotation.summary.clippedCharacters).toBe(10);
    expect(annotation.summary.overflowed).toBe(2);
    expect(annotation.summary.blocks).toBe(3);
  });

  it('names a block without an id by its position', () => {
    const annotation = annotateFits([{ text: 'one two three', box: { width: 100, height: 24 } }]);

    expect(annotation.results[0]?.id).toBe('block-0');
  });

  it('lets a block override the shared options', () => {
    const shared = annotateFits([{ text: WORDS_FIVE, box: { width: 100, height: 24 } }], { maxLines: 1 });
    const own = annotateFits(
      [{ text: WORDS_FIVE, box: { width: 100, height: 24 }, options: { maxLines: 2 } }],
      { maxLines: 1 },
    );

    expect(shared.results[0]?.result.lines).toHaveLength(1);
    expect(own.results[0]?.result.lines).toHaveLength(2);
  });

  it('is deterministic: the same input produces the same bytes', () => {
    const first = annotateFits(sampleBlocks());
    const second = annotateFits(sampleBlocks());

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual(second);
  });
});

describe('fitText determinism', () => {
  it('returns an identical result object for identical input', () => {
    const first = fitText(WORDS_FIVE, { width: 100, height: 24 });
    const second = fitText(WORDS_FIVE, { width: 100, height: 24 });

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
