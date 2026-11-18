import { describe, expect, it } from 'vitest';
import { countDirectionSignals, detectDirection, estimateLineUnits, hasCjk, resolveBlockDirection } from '../src/core/text-direction';
import { groupTextItems } from '../src/pdf/layout';

describe('text direction detection', () => {
  it('reads Hebrew and Arabic as right-to-left', () => {
    expect(detectDirection('שלום עולם')).toBe('rtl');
    expect(detectDirection('مرحبا بالعالم')).toBe('rtl');
    expect(detectDirection('مرحبا')).toBe('rtl');
  });

  it('keeps Vietnamese with diacritics left-to-right', () => {
    expect(detectDirection('Tiếng Việt có dấu')).toBe('ltr');
    expect(detectDirection('Đường phố Hà Nội')).toBe('ltr');
  });

  it('reads Chinese, Japanese and Korean as left-to-right CJK', () => {
    for (const text of ['中文測試', '日本語のテキスト', '한국어 텍스트']) {
      expect(detectDirection(text)).toBe('ltr');
      expect(hasCjk(text)).toBe(true);
    }
  });

  it('does not report CJK for latin, Vietnamese or Arabic text', () => {
    for (const text of ['', 'Tiếng Việt', 'مرحبا']) expect(hasCjk(text)).toBe(false);
  });

  it('uses a strong-character majority for mixed text', () => {
    expect(detectDirection('PDF 中文')).toBe('ltr');
    expect(detectDirection('PDF مرحبا بالعالم')).toBe('rtl');
    expect(countDirectionSignals('PDF 中文')).toMatchObject({ rtl: 0, cjk: 2 });
    // Five strong characters each side: the first strong character breaks the tie.
    expect(countDirectionSignals('Hello مرحبا')).toMatchObject({ rtl: 5, ltr: 5 });
    expect(detectDirection('Hello مرحبا')).toBe('ltr');
    expect(detectDirection('مرحبا Hello')).toBe('rtl');
  });

  it('treats digits, punctuation and emoji as neutral', () => {
    for (const text of ['', '   ', '123 + 456 = 579', '...!?,;:()', '— 42 —', '🎉🎊', '(2024) 3.14%']) {
      expect(detectDirection(text)).toBe('neutral');
    }
    expect(countDirectionSignals('123 ... 🎉')).toEqual({ rtl: 0, ltr: 0, cjk: 0 });
  });

  it('resolves a block direction from a producer hint first, then the text', () => {
    expect(resolveBlockDirection('rtl', 'Hello world')).toBe('rtl');
    expect(resolveBlockDirection('ltr', 'مرحبا')).toBe('ltr');
    expect(resolveBlockDirection(undefined, 'مرحبا')).toBe('rtl');
    expect(resolveBlockDirection(undefined, 'Tiếng Việt')).toBe('ltr');
    expect(resolveBlockDirection(undefined, '12345')).toBe('ltr');
    expect(resolveBlockDirection('', '中文')).toBe('ltr');
  });
});

describe('line width units', () => {
  it('counts a full-width glyph as two narrow glyphs', () => {
    expect(estimateLineUnits('中')).toBe(1);
    expect(estimateLineUnits('a')).toBe(.5);
    expect(estimateLineUnits('中文测试')).toBe(4);
    expect(estimateLineUnits('test')).toBe(2);
    expect(estimateLineUnits('日本語')).toBe(3);
    expect(estimateLineUnits('한국어')).toBe(3);
    expect(estimateLineUnits('中文')).toBeGreaterThan(estimateLineUnits('ab'));
    expect(estimateLineUnits('中文')).toBe(estimateLineUnits('abcd'));
  });

  it('counts spaces as narrow and ignores empty text', () => {
    expect(estimateLineUnits('')).toBe(0);
    expect(estimateLineUnits('a b')).toBe(1.5);
    expect(estimateLineUnits('中文 abc')).toBe(4);
    expect(estimateLineUnits('ab\ncd')).toBe(2);
  });
});

describe('PDF blocks carry direction', () => {
  const viewport = [1, 0, 0, -1, 0, 200];
  const item = (str: string, dir?: string) => ({ str, transform: [12, 0, 0, 12, 20, 180], width: 80, height: 12, dir });

  it('detects RTL when the PDF producer sets no direction hint', () => {
    expect(groupTextItems([item('مرحبا بالعالم')], viewport, 1)[0]?.direction).toBe('rtl');
    expect(groupTextItems([item('שלום עולם')], viewport, 1)[0]?.direction).toBe('rtl');
  });

  it('keeps latin and CJK blocks left-to-right and honours the producer hint', () => {
    expect(groupTextItems([item('Tiếng Việt')], viewport, 1)[0]?.direction).toBe('ltr');
    expect(groupTextItems([item('中文測試')], viewport, 1)[0]?.direction).toBe('ltr');
    expect(groupTextItems([item('Hello world', 'rtl')], viewport, 1)[0]?.direction).toBe('rtl');
    expect(groupTextItems([item('12345')], viewport, 1)[0]?.direction).toBe('ltr');
  });
});
