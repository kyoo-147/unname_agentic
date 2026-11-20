import { describe, expect, it } from 'vitest';
import {
  alignWords,
  characterErrorRate,
  characterDistance,
  countCharacters,
  normalizeOcrText,
  splitWords,
  wordErrorRate,
} from '../src/core/ocr-metrics';

describe('normalizeOcrText', () => {
  it('collapses any run of whitespace to one space and trims the edges', () => {
    expect(normalizeOcrText('  hello \n\t world\r\n ')).toBe('hello world');
  });

  it('composes decomposed diacritics into one code point', () => {
    const decomposed = 'Hà Nội'.normalize('NFD');
    expect(decomposed).not.toBe('Hà Nội');
    expect(normalizeOcrText(decomposed)).toBe('Hà Nội');
  });

  it('keeps diacritics instead of folding them away', () => {
    expect(normalizeOcrText('Hà Nội')).toBe('Hà Nội');
    expect(normalizeOcrText('Hà Nội')).not.toBe('Ha Noi');
  });
});

describe('countCharacters', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(countCharacters('a😀b')).toBe(3);
    expect('a😀b'.length).toBe(4);
  });

  it('counts the single spaces left by normalisation', () => {
    expect(countCharacters('a b')).toBe(3);
    expect(countCharacters('   ')).toBe(0);
  });
});

describe('characterDistance', () => {
  it('is the classic Levenshtein distance for kitten and sitting', () => {
    expect(characterDistance('kitten', 'sitting')).toBe(3);
  });

  it('charges one error for each inserted and each deleted character', () => {
    expect(characterDistance('kitten', 'kittens')).toBe(1);
    expect(characterDistance('kittens', 'kitten')).toBe(1);
    expect(characterDistance('abcd', 'abXcd')).toBe(1);
  });

  it('compares normalised text, so whitespace-only differences cost nothing', () => {
    expect(characterDistance('hello   world', 'hello world')).toBe(0);
  });
});

describe('characterErrorRate', () => {
  it('is zero for an exact match', () => {
    expect(characterErrorRate('Reading without boundaries', 'Reading without boundaries'))
      .toEqual({ errors: 0, total: 26, rate: 0 });
  });

  it('reports 0.1 for one substitution in ten characters', () => {
    const result = characterErrorRate('abcdefghij', 'abcdefghiX');
    expect(result).toEqual({ errors: 1, total: 10, rate: 0.1 });
  });

  it('counts an insertion and a deletion', () => {
    expect(characterErrorRate('kitten', 'kittens')).toEqual({ errors: 1, total: 6, rate: 1 / 6 });
    expect(characterErrorRate('kittens', 'kitten')).toEqual({ errors: 1, total: 7, rate: 1 / 7 });
  });

  it('counts both directions in one number', () => {
    // 'kitten' -> 'sitting': k->s, e->i, insert g.
    expect(characterErrorRate('kitten', 'sitting')).toEqual({ errors: 3, total: 6, rate: 0.5 });
  });

  it('is 1 when the hypothesis is empty and the reference is not', () => {
    expect(characterErrorRate('hello', '')).toEqual({ errors: 5, total: 5, rate: 1 });
  });

  it('is 0 for an empty reference and an empty hypothesis', () => {
    expect(characterErrorRate('', '')).toEqual({ errors: 0, total: 0, rate: 0 });
  });

  it('is 1 for an empty reference that the engine filled with text', () => {
    expect(characterErrorRate('   ', 'ghost text')).toEqual({ errors: 10, total: 0, rate: 1 });
  });

  it('charges every character of a hypothesis longer than the reference', () => {
    expect(characterErrorRate('abc', 'abcdef')).toEqual({ errors: 3, total: 3, rate: 1 });
  });

  it('ignores whitespace differences but not word spacing that changes the text', () => {
    expect(characterErrorRate('  reading \n without   boundaries ', 'reading without boundaries').rate).toBe(0);
    expect(characterErrorRate('a b', 'ab')).toEqual({ errors: 1, total: 3, rate: 1 / 3 });
  });

  it('changes the rate when diacritics are lost', () => {
    const exact = characterErrorRate('Hà Nội', 'Hà Nội');
    const stripped = characterErrorRate('Hà Nội', 'Ha Noi');
    expect(exact.rate).toBe(0);
    expect(stripped.errors).toBe(2);
    expect(stripped.total).toBe(6);
    expect(stripped.rate).toBeCloseTo(2 / 6, 12);
    expect(stripped.rate).toBeGreaterThan(exact.rate);
  });

  it('scores a decomposed reference the same as a precomposed one', () => {
    const precomposed = characterErrorRate('Hà Nội', 'Hà Nội');
    const decomposed = characterErrorRate('Hà Nội'.normalize('NFD'), 'Hà Nội');
    expect(decomposed).toEqual(precomposed);
  });

  it('charges one error for an astral glyph, not two UTF-16 units', () => {
    expect(characterErrorRate('a😀b', 'a😃b')).toEqual({ errors: 1, total: 3, rate: 1 / 3 });
  });
});

describe('splitWords', () => {
  it('splits on normalised whitespace and keeps diacritics', () => {
    expect(splitWords('  Hà   Nội\n2026 ')).toEqual(['Hà', 'Nội', '2026']);
    expect(splitWords('   ')).toEqual([]);
  });
});

describe('alignWords', () => {
  it('returns a match, a substitution, a match and an insertion', () => {
    const alignment = alignWords('a b c', 'a x c d');
    expect(alignment.ops).toEqual([
      { op: 'match', reference: 'a', hypothesis: 'a' },
      { op: 'substitute', reference: 'b', hypothesis: 'x' },
      { op: 'match', reference: 'c', hypothesis: 'c' },
      { op: 'insert', hypothesis: 'd' },
    ]);
    expect(alignment).toMatchObject({ errors: 2, total: 3 });
    expect(alignment.rate).toBeCloseTo(2 / 3, 12);
  });

  it('reports a deleted word when the reference has one the hypothesis lacks', () => {
    const alignment = alignWords('one two three', 'one three');
    expect(alignment.ops).toEqual([
      { op: 'match', reference: 'one', hypothesis: 'one' },
      { op: 'delete', reference: 'two' },
      { op: 'match', reference: 'three', hypothesis: 'three' },
    ]);
    expect(alignment).toMatchObject({ errors: 1, total: 3 });
  });

  it('reports an inserted word when the hypothesis invents one', () => {
    expect(alignWords('one two', 'zero one two').ops).toEqual([
      { op: 'insert', hypothesis: 'zero' },
      { op: 'match', reference: 'one', hypothesis: 'one' },
      { op: 'match', reference: 'two', hypothesis: 'two' },
    ]);
  });

  it('aligns an empty hypothesis as all deletions and an empty reference as all insertions', () => {
    expect(alignWords('one two', '').ops).toEqual([
      { op: 'delete', reference: 'one' },
      { op: 'delete', reference: 'two' },
    ]);
    expect(alignWords('', 'one').ops).toEqual([{ op: 'insert', hypothesis: 'one' }]);
  });
});

describe('wordErrorRate', () => {
  it('is zero for an exact match, whitespace included', () => {
    expect(wordErrorRate('the  quick\nbrown fox', 'the quick brown fox'))
      .toEqual({ errors: 0, total: 4, rate: 0 });
  });

  it('reports 0.5 when two of four words change', () => {
    expect(wordErrorRate('the quick brown fox', 'the slow brown cat'))
      .toEqual({ errors: 2, total: 4, rate: 0.5 });
  });

  it('counts one inserted and one deleted word', () => {
    expect(wordErrorRate('one two', 'one two three')).toEqual({ errors: 1, total: 2, rate: 0.5 });
    expect(wordErrorRate('one two three', 'one two')).toEqual({ errors: 1, total: 3, rate: 1 / 3 });
  });

  it('is 1 when the hypothesis is empty and the reference is not', () => {
    expect(wordErrorRate('one two', '')).toEqual({ errors: 2, total: 2, rate: 1 });
  });

  it('is 0 for an empty reference and an empty hypothesis', () => {
    expect(wordErrorRate('', '   ')).toEqual({ errors: 0, total: 0, rate: 0 });
  });

  it('treats a lost diacritic as a wrong word', () => {
    expect(wordErrorRate('Hà Nội', 'Ha Noi')).toEqual({ errors: 2, total: 2, rate: 1 });
    expect(wordErrorRate('Hà Nội', 'Hà Nội')).toEqual({ errors: 0, total: 2, rate: 0 });
  });
});
