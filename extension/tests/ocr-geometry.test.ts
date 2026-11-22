import { describe, expect, it } from 'vitest';
import type { OcrWord } from '../viewer/src/ocr/engine';
import { blocksToPageModel, mergeWordsToBlocks, normalizeBbox, normalizeRect } from '../viewer/src/ocr/geometry';

function word(text: string, x: number, y: number, width: number, height = 12, confidence = 90): OcrWord {
  return { text, confidence, bbox: { x0: x, y0: y, x1: x + width, y1: y + height } };
}

describe('OCR geometry', () => {
  it('merges words on the same line into a single block', () => {
    const blocks = mergeWordsToBlocks([word('Xin', 10, 10, 20), word('chào', 34, 10, 30), word('bạn', 68, 10, 20)]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe('Xin chào bạn');
    expect(blocks[0]?.rect).toEqual({ x: 10, y: 10, width: 78, height: 12 });
  });

  it('keeps two columns in left-column-first reading order', () => {
    const words = [
      word('Left1', 10, 10, 60), word('Right1', 220, 10, 70),
      word('Left2', 10, 30, 60), word('Right2', 220, 30, 70),
      word('Left3', 10, 50, 60), word('Right3', 220, 50, 70),
    ];
    const blocks = mergeWordsToBlocks(words);
    expect(blocks.map(block => block.text)).toEqual(['Left1 Left2 Left3', 'Right1 Right2 Right3']);
    expect(blocks[0]?.direction).toBe('ltr');
  });

  it('keeps columns in order below a full-width heading', () => {
    const words = [
      word('Báo cáo thường niên', 10, 10, 280),
      word('Left1', 10, 40, 60), word('Right1', 220, 40, 70),
      word('Left2', 10, 60, 60), word('Right2', 220, 60, 70),
      word('Left3', 10, 80, 60), word('Right3', 220, 80, 70),
    ];
    const blocks = mergeWordsToBlocks(words);
    expect(blocks.map(block => block.text)).toEqual(['Báo cáo thường niên', 'Left1 Left2 Left3', 'Right1 Right2 Right3']);
  });

  it('splits blocks when the vertical gap exceeds lineGap line heights', () => {
    const blocks = mergeWordsToBlocks([word('Đoạn', 10, 10, 30), word('một', 44, 10, 24), word('Đoạn', 10, 200, 30), word('hai', 44, 200, 20)], { lineGap: 0.6 });
    expect(blocks.map(block => block.text)).toEqual(['Đoạn một', 'Đoạn hai']);
  });

  it('caps block size with maxChars', () => {
    const blocks = mergeWordsToBlocks([word('alpha', 10, 10, 40), word('beta', 10, 30, 36), word('gamma', 10, 50, 44)], { maxChars: 12 });
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.map(block => block.text).join(' ')).toContain('gamma');
  });

  it('clamps inverted and out-of-bounds boxes', () => {
    expect(normalizeBbox({ x0: 50, y0: 30, x1: 10, y1: 12 }, 40, 20)).toEqual({ x0: 10, y0: 12, x1: 40, y1: 20 });
    expect(normalizeBbox({ x0: -20, y0: -10, x1: 5, y1: 5 }, 100, 100)).toEqual({ x0: 0, y0: 0, x1: 5, y1: 5 });
    expect(normalizeBbox({ x0: 10, y0: 10, x1: 10, y1: 20 })).toBeUndefined();
    expect(normalizeRect({ x: 90, y: 90, width: 30, height: 30 }, 100, 100)).toEqual({ x: 90, y: 90, width: 10, height: 10 });
  });

  it('drops empty words and non-finite boxes', () => {
    const blocks = mergeWordsToBlocks([
      word('  ', 10, 10, 20),
      { text: 'bad', confidence: 90, bbox: { x0: Number.NaN, y0: 0, x1: 10, y1: 10 } },
      word('giữ', 10, 10, 20),
    ]);
    expect(blocks.map(block => block.text)).toEqual(['giữ']);
  });

  it('builds a PageModel with stable OCR ids and clamped geometry', () => {
    const blocks = mergeWordsToBlocks([word('Một', 10, 10, 25), word('hai', 10, 30, 22)]);
    const model = blocksToPageModel(blocks, 300, 400, 3);
    expect(model.number).toBe(3);
    expect(model.width).toBe(300);
    expect(model.height).toBe(400);
    expect(model.blocks[0]?.id).toBe('ocr-p3-1');
    expect(model.blocks[0]?.page).toBe(3);
    expect(model.blocks[0]?.rect.x).toBeGreaterThanOrEqual(0);
    expect(model.blocks[0]?.rect.width).toBeLessThanOrEqual(300);
  });

  it('falls back to content extents when image dimensions are missing', () => {
    const blocks = mergeWordsToBlocks([word('rộng', 5, 7, 100)]);
    const model = blocksToPageModel(blocks, 0, 0, 1);
    expect(model.width).toBeCloseTo(105);
    expect(model.height).toBeCloseTo(19);
  });

  it('marks right-to-left text', () => {
    const blocks = mergeWordsToBlocks([word('مرحبا', 10, 10, 40)]);
    expect(blocks[0]?.direction).toBe('rtl');
  });
});
