import { describe, expect, it } from 'vitest';
import type { PageModel } from '../viewer/src/core/types';
import type { OcrLine, OcrWord } from '../viewer/src/ocr/engine';
import {
  adaptOcrPageModel,
  runOcrToDocumentIR,
  type OcrPageGeometry,
  type OcrPageModelWithLines,
} from '../viewer/src/ocr/document-adapter';

const HASH = 'a'.repeat(64);
const PAGE: OcrPageGeometry = { index: 2, width: 500, height: 250, rotation: 0 };

function word(text: string, confidence: number, x0: number, y0: number, x1: number, y1: number): OcrWord {
  return { text, confidence, bbox: { x0, y0, x1, y1 } };
}

function model(words: OcrWord[], options: { width?: number; height?: number; meanConfidence?: number; droppedWords?: number; language?: string; lines?: OcrLine[] } = {}): OcrPageModelWithLines {
  const width = options.width ?? 1000;
  const height = options.height ?? 500;
  const lines = options.lines ?? [];
  const page: PageModel = { number: PAGE.index, width, height, blocks: [] };
  return {
    ...page,
    words,
    lines,
    ocr: {
      languages: ['eng'],
      sourceLanguage: { code: options.language ?? 'en', script: 'latin', confidence: 1 },
      meanConfidence: options.meanConfidence ?? (words.length ? words.reduce((sum, entry) => sum + entry.confidence, 0) / words.length : 0),
      droppedWords: options.droppedWords ?? 0,
      warnings: [],
      warningCount: 0,
      normalization: { inverted: false, contrastGain: 1, scale: 1 },
    },
  };
}

function options() {
  return { engine: 'fake-local-ocr', language: 'en' };
}

describe('OCR DocumentIR adapter', () => {
  it('groups words across lines and records typed IR geometry, language, confidence, and provenance', () => {
    const first = model([
      word('First', 96, 100, 40, 220, 60),
      word('line', 92, 230, 40, 330, 60),
      word('Second', 88, 100, 70, 240, 90),
      word('line', 84, 250, 70, 350, 90),
    ], { lines: [] });
    const second = model([...first.words]);

    const adapted = adaptOcrPageModel({ model: first, page: PAGE, sourceSha256: HASH, options: options() });
    const repeated = adaptOcrPageModel({ model: second, page: PAGE, sourceSha256: HASH, options: options() });

    expect(adapted.blocks).toHaveLength(1);
    expect(adapted.blocks[0]?.text).toBe('First line Second line');
    expect(adapted.blocks[0]?.language).toBe('en');
    expect(adapted.blocks[0]?.confidence).toBe(0.9);
    expect(adapted.blocks[0]?.polygon).toEqual([
      { x: 50, y: 20 },
      { x: 175, y: 20 },
      { x: 175, y: 45 },
      { x: 50, y: 45 },
    ]);
    expect(adapted.blocks.map(block => block.id)).toEqual(repeated.blocks.map(block => block.id));
  });

  it('falls back to OCR line boxes when word details are unavailable', () => {
    const adapted = adaptOcrPageModel({
      model: model([], {
        lines: [{
          text: 'Line-only result',
          confidence: 91,
          bbox: { x0: 100, y0: 40, x1: 400, y1: 70 },
          words: [],
        }],
      }),
      page: PAGE,
      sourceSha256: HASH,
      options: options(),
    });

    expect(adapted.blocks[0]?.text).toBe('Line-only result');
    expect(adapted.blocks[0]?.confidence).toBe(0.91);
  });

  it('scales OCR pixel boxes into the source page geometry', () => {
    const adapted = adaptOcrPageModel({
      model: model([word('Scaled', 90, 100, 50, 300, 150)]),
      page: { index: 1, width: 612, height: 792, rotation: 90 },
      sourceSha256: HASH,
      options: options(),
    });

    expect(adapted.blocks[0]?.rect).toEqual({ x: 61.2, y: 79.2, width: 122.4, height: 158.4 });
    expect(adapted.blocks[0]?.polygon).toEqual([
      { x: 61.2, y: 79.2 },
      { x: 183.6, y: 79.2 },
      { x: 183.6, y: 237.6 },
      { x: 61.2, y: 237.6 },
    ]);
  });

  it('returns review flags for low confidence and dropped words', async () => {
    const result = await runOcrToDocumentIR({
      page: PAGE,
      pageKind: 'scanned',
      sourceSha256: HASH,
      options: { ...options(), reviewConfidence: 0.8 },
      recognize: async () => model([word('uncertain', 55, 20, 20, 200, 50)], { meanConfidence: 55, droppedWords: 2 }),
    });

    expect(result.status).toBe('review');
    if (result.status !== 'review') throw new Error('expected a review outcome');
    expect(result.flags.map(flag => flag.code)).toEqual(['low-confidence', 'dropped-words']);
    expect(result.document.blocks[0]?.confidence).toBe(0.55);
    expect(result.document.provenance[0]).toMatchObject({ transform: 'ocr', ocrEngine: 'fake-local-ocr' });
  });

  it('preserves AbortSignal and stops before a later hybrid region', async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = runOcrToDocumentIR({
      page: PAGE,
      pageKind: 'scanned',
      sourceSha256: HASH,
      signal: controller.signal,
      options: options(),
      recognize: async request => {
        calls++;
        expect(request.signal).toBe(controller.signal);
        controller.abort();
        await Promise.resolve();
        request.signal?.throwIfAborted();
        return model([]);
      },
    });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('routes digital pages away from OCR', async () => {
    let called = false;
    const result = await runOcrToDocumentIR({
      page: PAGE,
      pageKind: 'digital',
      sourceSha256: HASH,
      options: options(),
      recognize: async () => {
        called = true;
        return model([]);
      },
    });

    expect(result).toEqual({ status: 'skipped', route: 'digital', reason: 'digital-page', regionsProcessed: 0 });
    expect(called).toBe(false);
  });

  it('routes hybrid pages only through planned missing regions and passes bounded preprocessing', async () => {
    const calls: Array<{ regionId?: string; preprocess: true; maxPreprocessPixels: number }> = [];
    const result = await runOcrToDocumentIR({
      page: PAGE,
      pageKind: 'hybrid',
      sourceSha256: HASH,
      digitalBlocks: [{ id: 'digital-heading', text: 'Native heading', rect: { x: 20, y: 20, width: 200, height: 25 } }],
      imageRegions: [{ id: 'missing-scan', rect: { x: 20, y: 80, width: 460, height: 130 } }],
      options: { ...options(), maxPreprocessPixels: 2_000_000 },
      recognize: async request => {
        calls.push({ regionId: request.region?.regionId, preprocess: request.preprocess, maxPreprocessPixels: request.maxPreprocessPixels });
        return model([word('Recovered', 94, 20, 20, 240, 50)], { width: 460, height: 130 });
      },
    });

    expect(calls).toEqual([{ regionId: 'missing-scan', preprocess: true, maxPreprocessPixels: 2_000_000 }]);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected a successful hybrid outcome');
    expect(result.route).toBe('hybrid');
    expect(result.document.blocks.map(block => block.raw)).toEqual(['Native heading', 'Recovered']);
    expect(result.document.provenance.map(row => row.transform)).toEqual(['pdf-text', 'ocr']);
  });

  it('reports a clear failure when OCR returns no usable text', async () => {
    const result = await runOcrToDocumentIR({
      page: PAGE,
      pageKind: 'scanned',
      sourceSha256: HASH,
      options: options(),
      recognize: async () => model([]),
    });

    expect(result).toMatchObject({ status: 'failed', route: 'scanned', code: 'empty-result' });
  });
});
