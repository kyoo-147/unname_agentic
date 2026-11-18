import { describe, expect, it } from 'vitest';
import { FakeEngine, isImageData, type OcrResult, type OcrWord } from '../src/ocr/engine';
import { prepareImageForOcr, runOcr } from '../src/ocr/pipeline';

interface TextImageOptions {
  width?: number;
  height?: number;
  background?: number;
  ink?: number;
  bandHeight?: number;
  gap?: number;
}

function fill(image: ImageData, x0: number, y0: number, x1: number, y1: number, value: number): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }
  }
}

/** Background plus ink bands, so the normaliser has lines to measure. */
function textImage(options: TextImageOptions = {}): ImageData {
  const width = options.width ?? 80;
  const height = options.height ?? 64;
  const background = options.background ?? 255;
  const ink = options.ink ?? 0;
  const bandHeight = options.bandHeight ?? 10;
  const gap = options.gap ?? 8;
  const image = { data: new Uint8ClampedArray(width * height * 4), width, height, colorSpace: 'srgb' } as ImageData;
  fill(image, 0, 0, width, height, background);
  const left = Math.floor(width * 0.1);
  const right = Math.floor(width * 0.4);
  for (let top = 4; top + bandHeight <= height - 4; top += bandHeight + gap) {
    fill(image, left, top, right, top + bandHeight, ink);
  }
  return image;
}

function word(text: string, confidence: number, x0: number, y0: number, x1: number, y1: number): OcrWord {
  return { text, confidence, bbox: { x0, y0, x1, y1 } };
}

function result(width: number, height: number, words: OcrWord[], text = words.map(entry => entry.text).join(' ')): OcrResult {
  return { text, words, lines: [], width, height };
}

function sentPixels(engine: FakeEngine): ImageData {
  const image = engine.calls[0]?.image;
  if (!isImageData(image)) throw new Error('the engine was not handed pixel data');
  return image;
}

describe('OCR preprocessing wiring', () => {
  it('inverts and stretches a dark capture before the engine runs', async () => {
    const dark = textImage({ width: 80, height: 80, background: 12, ink: 240, bandHeight: 24, gap: 12 });
    const engine = new FakeEngine(result(80, 80, [word('xin', 92, 10, 6, 40, 26)]));
    const page = await runOcr({ image: dark, engine });

    expect(page.ocr.normalization.inverted).toBe(true);
    expect(page.ocr.normalization.scale).toBe(1);
    expect(page.ocr.normalization.contrastGain).toBeCloseTo(1.12, 2);

    const pixels = sentPixels(engine);
    expect(pixels.width).toBe(80);
    expect(pixels.height).toBe(80);
    // White page, black ink: only the inverting normaliser can turn 12 into 255,
    // a plain grayscale pass would have left the dark background at 12.
    expect(Array.from(pixels.data.slice(0, 4))).toEqual([255, 255, 255, 255]);
    const inkOffset = (6 * pixels.width + 10) * 4;
    expect(pixels.data[inkOffset]).toBe(0);

    const raw = new FakeEngine(result(80, 80, []));
    await runOcr({ image: dark, engine: raw, preprocess: false });
    expect(raw.calls[0]?.image).toBe(dark);
    expect(sentPixels(raw).data[0]).toBe(12);
  });

  it('maps an upscaled engine result back onto original screenshot pixels', async () => {
    const original = textImage({ width: 80, height: 64 });
    const prepared = await prepareImageForOcr(original);
    expect(prepared.report).toEqual({ inverted: false, contrastGain: 1, scale: 2 });
    expect(prepared.width).toBe(160);
    expect(prepared.height).toBe(128);

    // Tesseract numbers its boxes in the canvas it was handed: the upscaled one.
    const engine = new FakeEngine(image => {
      const width = isImageData(image) ? image.width : 0;
      const height = isImageData(image) ? image.height : 0;
      return result(width, height, [word('Xin', 92, 20, 20, 60, 40), word('chào', 90, 64, 20, 120, 40)]);
    });
    const page = await runOcr({ image: original, engine });

    expect(page.ocr.normalization.scale).toBe(2);
    expect(page.width).toBe(80);
    expect(page.height).toBe(64);
    expect(page.blocks[0]?.text).toBe('Xin chào');
    // A 2x upscale moves every box; the model must undo it exactly, or the
    // overlay would sit at twice the distance from the captured image's origin.
    expect(page.blocks[0]?.rect).toEqual({ x: 10, y: 10, width: 50, height: 10 });
    expect(page.blocks[0]?.fontSize).toBe(10);
    expect(page.words.map(entry => entry.bbox)).toEqual([
      { x0: 10, y0: 10, x1: 30, y1: 20 },
      { x0: 32, y0: 10, x1: 60, y1: 20 },
    ]);
  });

  it('refuses to rescale boxes when the engine reports a different canvas', async () => {
    const original = textImage({ width: 80, height: 64 });
    const engine = new FakeEngine(result(800, 600, [word('Xin', 90, 20, 20, 60, 40)]));
    const page = await runOcr({ image: original, engine });

    // The upscale happened, but an engine that measured another canvas cannot
    // have numbered these boxes in ours, so they stay where it put them.
    expect(page.ocr.normalization.scale).toBe(2);
    expect(page.width).toBe(800);
    expect(page.blocks[0]?.rect).toEqual({ x: 20, y: 20, width: 40, height: 20 });
  });

  it('keeps the source untouched when pixels cannot be read', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const prepared = await prepareImageForOcr(blob);

    expect(prepared.image).toBe(blob);
    expect(prepared.report).toEqual({ inverted: false, contrastGain: 1, scale: 1 });
    expect(prepared.width).toBe(0);
    expect(prepared.height).toBe(0);
  });
});
