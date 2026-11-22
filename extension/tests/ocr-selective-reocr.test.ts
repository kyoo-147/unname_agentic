import { describe, expect, it } from 'vitest';
import type { PageModel } from '../viewer/src/core/types';
import type { OcrResult, OcrWord } from '../viewer/src/ocr/engine';
import { planSelectiveReOcr, runSelectiveReOcr } from '../viewer/src/ocr/selective-reocr';
import type { OcrPageGeometry } from '../viewer/src/ocr/document-adapter';

const PAGE: OcrPageGeometry = { index: 1, width: 500, height: 300, rotation: 0 };
const HASH = 'b'.repeat(64);

function word(text: string, confidence: number, x: number, y: number): OcrWord {
  return { text, confidence, bbox: { x0: x, y0: y, x1: x + 70, y1: y + 18 } };
}

function model(words: OcrWord[], droppedWords = 0) {
  const page: PageModel = { number: PAGE.index, width: 1000, height: 600, blocks: [] };
  return {
    ...page,
    words,
    ocr: {
      languages: ['eng'],
      sourceLanguage: { code: 'en', script: 'latin' as const, confidence: 1 },
      meanConfidence: words.length ? words.reduce((sum, entry) => sum + entry.confidence, 0) / words.length : 0,
      droppedWords,
      warnings: [],
      warningCount: droppedWords > 0 ? 1 : 0,
      normalization: { inverted: false, contrastGain: 1, scale: 1 },
    },
  };
}

function output(text: string): ReturnType<typeof model> {
  return model([word(text, 94, 10, 10)]);
}

describe('selective OCR re-run planning and execution', () => {
  it('plans deterministic padded regions only for low-confidence observed geometry', () => {
    const input = {
      page: PAGE,
      model: model([
        word('uncertain', 40, 0, 0),
        word('clear', 96, 300, 200),
      ]),
      options: { confidenceThreshold: 0.75, paddingRatio: 0.1, maxPreprocessPixels: 2_000_000 },
    };

    const first = planSelectiveReOcr(input);
    const second = planSelectiveReOcr(input);

    expect(first).toEqual(second);
    expect(first.status).toBe('planned');
    expect(first.regions).toHaveLength(1);
    expect(first.regions[0]).toMatchObject({
      id: 'reocr-p1-r1',
      rect: { x: 0, y: 0 },
      confidence: 0.4,
      reasons: ['low-confidence'],
    });
    expect(first.tasks[0]?.origin).toBe('corrupted-digital');
    expect(first.tasks[0]?.excludedRects).toEqual([]);
  });

  it('abstains when dropped words have no recoverable region geometry', () => {
    const plan = planSelectiveReOcr({ page: PAGE, model: model([], 3) });

    expect(plan.status).toBe('abstain');
    expect(plan.abstention).toEqual({
      code: 'no-region-geometry',
      message: 'OCR reported dropped words, but no retained word geometry identifies a safe crop.',
      observed: 'droppedWords=3; retainedWords=0',
    });
    expect(plan.trace.at(-1)?.status).toBe('abstained');
  });

  it('re-OCRs planned regions only and records truthful empty-result trace events', async () => {
    const calls: Array<{ regionId?: string; maxPreprocessPixels: number; signal?: AbortSignal }> = [];
    const result = await runSelectiveReOcr({
      page: PAGE,
      model: model([word('uncertain', 40, 100, 100), word('also', 35, 400, 250)]),
      options: { confidenceThreshold: 0.75, maxRegions: 2, maxPreprocessPixels: 2_000_000, languages: ['eng'], engine: 'fake-local' },
      signal: new AbortController().signal,
      recognize: async request => {
        calls.push({ regionId: request.region?.regionId, maxPreprocessPixels: request.maxPreprocessPixels, signal: request.signal });
        return request.region?.regionId.endsWith('r1') ? output('recovered') : model([]);
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls.every(call => call.regionId && call.maxPreprocessPixels === 2_000_000)).toBe(true);
    expect(calls.every(call => call.signal !== undefined)).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.results.map(entry => entry.model.words[0]?.text)).toEqual(['recovered']);
    expect(result.trace.some(event => event.status === 'abstained' && event.regionId?.endsWith('r2'))).toBe(true);
  });

  it('refuses a cloud adapter in offline-only mode before recognition', async () => {
    let called = false;
    const result = await runSelectiveReOcr({
      page: PAGE,
      model: model([word('uncertain', 40, 50, 50)]),
      options: { execution: 'cloud', engine: 'remote-ocr' },
      recognize: async () => {
        called = true;
        return output('must-not-run');
      },
    });

    expect(called).toBe(false);
    expect(result).toMatchObject({ status: 'abstain', abstention: { code: 'offline-engine-unavailable' } });
  });

  it('propagates abort instead of returning a partial success as if complete', async () => {
    const controller = new AbortController();
    await expect(runSelectiveReOcr({
      page: PAGE,
      model: model([word('uncertain', 40, 50, 50)]),
      signal: controller.signal,
      recognize: async request => {
        controller.abort();
        request.signal?.throwIfAborted();
        return output('should-not-commit');
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
