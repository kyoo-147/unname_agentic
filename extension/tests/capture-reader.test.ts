import { describe, expect, it } from 'vitest';
import type { TextBlock } from '../viewer/src/core/types';
import type { OcrWord } from '../viewer/src/ocr/engine';
import {
  blockConfidences,
  blockRectPosition,
  CAPTURE_COPY_KEYS,
  captureCopy,
  captureString,
  confidenceForBlock,
  DEFAULT_CONFIDENCE_THRESHOLD,
  filterLowConfidence,
  formatConfidence,
  numberBlocks,
  resolveCaptureLocale,
  selectTranslationQueue,
  sourceLanguageLabel,
  summarizeConfidence,
  translationStatusKey,
  translationStatusText,
  type TranslationView,
} from '../viewer/src/capture/view-model';

function block(id: string, x: number, y: number, width: number, height: number, text = `text ${id}`): TextBlock {
  return {
    id,
    page: 1,
    text,
    rect: { x, y, width, height },
    fontSize: 12,
    fontFamily: 'sans-serif',
    color: '#000000',
    direction: 'ltr',
    rotation: 0,
  };
}

function word(text: string, x0: number, y0: number, x1: number, y1: number, confidence: number): OcrWord {
  return { text, confidence, bbox: { x0, y0, x1, y1 } };
}

function views(entries: Record<string, TranslationView>): Map<string, TranslationView> {
  return new Map(Object.entries(entries));
}

describe('block numbering', () => {
  it('numbers blocks from one in reading order and keeps the block reference', () => {
    const first = block('a', 0, 0, 10, 10);
    const second = block('b', 0, 20, 10, 10);
    const numbered = numberBlocks([first, second]);
    expect(numbered.map(entry => entry.number)).toEqual([1, 2]);
    expect(numbered[0]!.block).toBe(first);
    expect(numbered[1]!.block.text).toBe('text b');
  });

  it('returns no entries for an empty page', () => {
    expect(numberBlocks([])).toEqual([]);
  });
});

describe('block geometry', () => {
  it('converts block rectangles to percentages of the page', () => {
    expect(blockRectPosition(block('a', 50, 25, 200, 100), 1000, 500)).toEqual({
      left: 5,
      top: 5,
      width: 20,
      height: 20,
    });
  });

  it('clamps rectangles that extend past the page edge', () => {
    expect(blockRectPosition(block('a', -20, -10, 120, 70), 100, 50)).toEqual({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    });
  });

  it('falls back to a one-pixel page for missing dimensions', () => {
    expect(blockRectPosition(block('a', 0, 0, 10, 10), 0, Number.NaN)).toEqual({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    });
  });
});

describe('per-block confidence', () => {
  const first = block('a', 0, 0, 100, 20);
  const second = block('b', 0, 100, 100, 20);
  const words = [
    word('one', 0, 0, 100, 20, 80),
    word('two', 0, 0, 100, 20, 40),
    word('three', 0, 100, 100, 120, 90),
    word('outside', 300, 300, 400, 320, 10),
  ];

  it('averages the words that overlap a block and ignores the rest', () => {
    expect(confidenceForBlock(first, words)).toBe(60);
    expect(confidenceForBlock(second, words)).toBe(90);
  });

  it('reports zero when no word overlaps the block', () => {
    expect(confidenceForBlock(block('c', 500, 500, 10, 10), words)).toBe(0);
  });

  it('clamps confidence to the percentage range', () => {
    expect(confidenceForBlock(first, [word('high', 0, 0, 100, 20, 160)])).toBe(100);
  });

  it('maps every block identifier to its confidence', () => {
    const confidences = blockConfidences([first, second], words);
    expect([...confidences.entries()]).toEqual([['a', 60], ['b', 90]]);
  });

  it('scores a block from the words that produced its text, not the dropped ones', () => {
    const scored = block('a', 0, 0, 100, 20);
    const kept = [word('kept', 0, 0, 100, 20, 90)];
    const dropped = [word('noise', 0, 0, 100, 20, 20)];
    expect(confidenceForBlock(scored, [...kept, ...dropped])).toBe(55);
    expect(confidenceForBlock(scored, kept)).toBe(90);
  });
});

describe('summary confidence', () => {
  it('computes the mean and counts low-confidence blocks', () => {
    const summary = summarizeConfidence([80, 40, 95]);
    expect(summary.mean).toBe(71.7);
    expect(summary.total).toBe(3);
    expect(summary.lowCount).toBe(1);
    expect(summary.threshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
  });

  it('uses a custom threshold and treats unusable values as zero', () => {
    const summary = summarizeConfidence([90, Number.NaN, 75], 80);
    expect(summary.mean).toBe(55);
    expect(summary.lowCount).toBe(2);
    expect(summary.threshold).toBe(80);
  });

  it('returns a zero summary for an empty page', () => {
    expect(summarizeConfidence([])).toEqual({ mean: 0, total: 0, lowCount: 0, threshold: 60 });
  });

  it('formats confidence for display', () => {
    expect(formatConfidence(66.66)).toBe('66.7%');
    expect(formatConfidence(100.4)).toBe('100%');
    expect(formatConfidence(-4)).toBe('0%');
    expect(formatConfidence(undefined)).toBe('—');
  });
});

describe('low-confidence filtering', () => {
  const blocks = [block('a', 0, 0, 10, 10), block('b', 0, 0, 10, 10), block('c', 0, 0, 10, 10)];

  it('returns numbered blocks below the threshold, including unknown scores', () => {
    const confidences = new Map([['a', 90], ['b', 42]]);
    expect(filterLowConfidence(blocks, confidences).map(entry => entry.number)).toEqual([2, 3]);
  });

  it('honours a custom threshold', () => {
    const confidences = new Map([['a', 70], ['b', 72], ['c', 20]]);
    expect(filterLowConfidence(blocks, confidences, 75).map(entry => entry.number)).toEqual([1, 2, 3]);
    expect(filterLowConfidence(blocks, confidences, 50).map(entry => entry.number)).toEqual([3]);
  });
});

describe('translation status', () => {
  it('maps every state to a copy key and a readable label', () => {
    expect(translationStatusKey('idle')).toBe('pending');
    expect(translationStatusKey('queued')).toBe('queued');
    expect(translationStatusKey('loading')).toBe('translating');
    expect(translationStatusKey('done')).toBe('translated');
    expect(translationStatusKey('error')).toBe('failed');
    expect(translationStatusText('loading', 'vi')).toBe('Đang dịch…');
    expect(translationStatusText('loading', 'en')).toBe('Translating…');
    expect(translationStatusText('loading', 'zh')).toBe('正在翻译…');
  });
});

describe('translation queue selection', () => {
  const blocks = [block('a', 0, 0, 1, 1), block('b', 0, 0, 1, 1), block('c', 0, 0, 1, 1), block('d', 0, 0, 1, 1)];

  it('selects idle and never-seen blocks in reading order', () => {
    const states = views({ b: { status: 'done' }, c: { status: 'loading' }, d: { status: 'queued' } });
    expect(selectTranslationQueue(blocks, states).map(entry => entry.id)).toEqual(['a']);
  });

  it('can include failed blocks for a retry-all action', () => {
    const states = views({
      a: { status: 'idle' },
      b: { status: 'error' },
      c: { status: 'done' },
      d: { status: 'loading' },
    });
    expect(selectTranslationQueue(blocks, states, { includeErrors: true }).map(entry => entry.id)).toEqual(['a', 'b']);
  });

  it('applies a positive limit after filtering', () => {
    const states = views({ b: { status: 'error' } });
    expect(selectTranslationQueue(blocks, states, { includeErrors: true, limit: 2 }).map(entry => entry.id)).toEqual(['a', 'b']);
    expect(selectTranslationQueue(blocks, states, { limit: 0 }).map(entry => entry.id)).toEqual(['a', 'c', 'd']);
  });
});

describe('source language summary', () => {
  it('names languages in the active locale', () => {
    expect(sourceLanguageLabel('vi', 'vi')).toBe('Tiếng Việt');
    expect(sourceLanguageLabel('en', 'vi')).toBe('Tiếng Anh');
    expect(sourceLanguageLabel('zh-CN', 'en')).toBe('Chinese');
    expect(sourceLanguageLabel('ja', 'zh')).toBe('日语');
  });

  it('falls back to the uppercase code or an unknown label', () => {
    expect(sourceLanguageLabel('fr', 'en')).toBe('FR');
    expect(sourceLanguageLabel('', 'vi')).toBe('Chưa xác định');
    expect(sourceLanguageLabel(undefined, 'en')).toBe('Not detected');
  });

  it('resolves the capture locale from a document language tag', () => {
    expect(resolveCaptureLocale('vi-VN')).toBe('vi');
    expect(resolveCaptureLocale('en-US')).toBe('en');
    expect(resolveCaptureLocale('zh-Hans')).toBe('zh');
    expect(resolveCaptureLocale('fr')).toBe('vi');
    expect(resolveCaptureLocale(undefined)).toBe('vi');
  });
});

describe('capture copy', () => {
  it('keeps the same non-empty keys in Vietnamese, English and Chinese', () => {
    expect(CAPTURE_COPY_KEYS.length).toBeGreaterThan(40);
    const baseline = [...CAPTURE_COPY_KEYS].sort();
    for (const locale of ['vi', 'en', 'zh'] as const) {
      const copy = captureCopy[locale];
      expect(Object.keys(copy).sort()).toEqual(baseline);
      for (const value of Object.values(copy)) expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it('interpolates variables and leaves unknown placeholders intact', () => {
    expect(captureString('vi', 'summary', { blocks: 3, confidence: '70%' })).toBe('3 khối chữ · độ tin cậy trung bình 70%');
    expect(captureString('en', 'regionLabel', { number: 2, text: 'Hello' })).toBe('Block 2: Hello');
    expect(captureString('vi', 'summary', { blocks: 1 })).toContain('{confidence}');
  });
});
