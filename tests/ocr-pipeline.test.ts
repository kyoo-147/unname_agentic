import { describe, expect, it } from 'vitest';
import { FakeEngine, type OcrResult, type OcrWord } from '../src/ocr/engine';
import { detectDominantScript, grayscaleContrast, runOcr } from '../src/ocr/pipeline';

function word(text: string, confidence: number, x: number, y: number, width = 30): OcrWord {
  return { text, confidence, bbox: { x0: x, y0: y, x1: x + width, y1: y + 12 } };
}

function result(words: OcrWord[], text = words.map(word => word.text).join(' ')): OcrResult {
  return { text, words, lines: [], width: 800, height: 600 };
}

function image(width = 4, height = 4): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 200;
    data[index + 1] = 40;
    data[index + 2] = 10;
    data[index + 3] = 128;
  }
  return { data, width, height } as ImageData;
}

describe('OCR pipeline', () => {
  it('runs the engine and builds a PageModel', async () => {
    const engine = new FakeEngine(result([word('Xin', 95, 10, 10), word('chào', 88, 45, 10), word('bạn', 80, 90, 10)]));
    const page = await runOcr({ image: image(), engine, languages: ['vie'] });
    expect(page.number).toBe(1);
    expect(page.width).toBe(800);
    expect(page.blocks[0]?.id).toBe('ocr-p1-1');
    expect(page.blocks[0]?.text).toBe('Xin chào bạn');
    expect(page.ocr.meanConfidence).toBe(87.7);
    expect(page.ocr.droppedWords).toBe(0);
    expect(engine.calls[0]?.languages).toEqual(['vie']);
  });

  it('filters low-confidence words and counts warnings', async () => {
    const engine = new FakeEngine(result([word('tốt', 90, 10, 10), word('mờ', 20, 45, 10), word('rõ', 80, 70, 10)]));
    const page = await runOcr({ image: image(), engine, minConfidence: 35, preprocess: false });
    expect(page.blocks.map(block => block.text)).toEqual(['tốt rõ']);
    expect(page.ocr.droppedWords).toBe(1);
    expect(page.ocr.warningCount).toBe(1);
    expect(page.ocr.warnings[0]).toContain('1');
  });

  it('returns an empty PageModel with a warning when everything is below the threshold', async () => {
    const engine = new FakeEngine(result([word('mờ', 12, 10, 10)]));
    const page = await runOcr({ image: image(), engine, minConfidence: 35, preprocess: false });
    expect(page.blocks).toEqual([]);
    expect(page.ocr.warningCount).toBe(2);
    expect(page.width).toBe(800);
  });

  it('suggests Vietnamese or English from Latin text and Japanese from kana', () => {
    expect(detectDominantScript('Tôi đọc tài liệu này').code).toBe('vi');
    expect(detectDominantScript('Annual report').code).toBe('en');
    expect(detectDominantScript('こんにちは世界').code).toBe('ja');
    expect(detectDominantScript('12345').script).toBe('unknown');
  });

  it('converts to grayscale while preserving alpha', () => {
    const output = grayscaleContrast(image(), 1);
    expect(output.data[0]).toBe(output.data[1]);
    expect(output.data[1]).toBe(output.data[2]);
    expect(output.data[3]).toBe(128);
    expect(output.width).toBe(4);
  });

  it('falls back to identity preprocessing when OffscreenCanvas is unavailable', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const engine = new FakeEngine(result([]));
    await runOcr({ image: blob, engine });
    expect(engine.calls[0]?.image).toBe(blob);
  });

  it('cancels a running recognition through the signal', async () => {
    const engine = new FakeEngine(result([word('chậm', 90, 10, 10)]), { delayMs: 1000 });
    const controller = new AbortController();
    const pending = runOcr({ image: image(), engine, signal: controller.signal, preprocess: false });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
