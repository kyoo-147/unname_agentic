import { describe, expect, it } from 'vitest';
import { mapOcrBlocksToPage, scanLanguages } from '../viewer/src/ocr/scan';

describe('mapOcrBlocksToPage', () => {
  it('scales image-pixel boxes into page coordinates and drops empty text', () => {
    const blocks = mapOcrBlocksToPage([
      { text: '  Reading   without boundaries ', rect: { x: 10, y: 20, width: 200, height: 30 } },
      { text: '   ', rect: { x: 0, y: 0, width: 10, height: 10 } },
    ], 1000, 500, 500, 250, 3);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ id: 'ocr-p3-1', page: 3, text: 'Reading without boundaries' });
    expect(blocks[0]!.rect).toEqual({ x: 5, y: 10, width: 100, height: 15 });
    expect(blocks[0]!.fontSize).toBeGreaterThan(8);
  });

  it('returns nothing for a zero-sized image', () => {
    expect(mapOcrBlocksToPage([{ text: 'x', rect: { x: 0, y: 0, width: 1, height: 1 } }], 0, 0, 100, 100, 1)).toEqual([]);
  });

  it('selects OCR languages from the source language and falls back to eng+vie', () => {
    expect(scanLanguages('zh')).toEqual(['chi_sim', 'eng']);
    expect(scanLanguages('ja-JP')).toEqual(['jpn', 'eng']);
    expect(scanLanguages('ko')).toEqual(['kor', 'eng']);
    expect(scanLanguages('vi')).toEqual(['vie', 'eng']);
    expect(scanLanguages('auto')).toEqual(['eng', 'vie']);
    expect(scanLanguages(undefined)).toEqual(['eng', 'vie']);
  });
});
