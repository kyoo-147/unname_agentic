import { describe, expect, it, vi } from 'vitest';
import {
  CropArtifactCache,
  buildCropCacheKey,
  isPlaceholderEvidence,
  parseActionPayload,
  quantizeBBox,
  runAgenticOcr,
  type AgenticOcrAction,
  type AgenticOcrModel,
  type AgenticOcrTurnInput,
  type CropRequest,
  type OcrAdapter,
  type OcrExtractRequest,
  type PageImageInput,
  type VisionCropper,
} from '../src/core/agentic-ocr';
import { computeRotatedSize, type CropTransform, type NormalizedBBox } from '../src/core/visual-grounding';

const SAMPLE_PAGE: PageImageInput = {
  pageId: 'doc-1-p3',
  pageIndex: 3,
  width: 2000,
  height: 3000,
  sourceRef: 'page-3-highres',
};

function makeFakeCropper(opts?: { onCrop?: (req: CropRequest) => void }): VisionCropper {
  let seq = 0;
  return {
    async renderOverview(page, maxLongestSide) {
      const scale = Math.min(1, maxLongestSide / Math.max(page.width, page.height));
      const width = Math.max(1, Math.round(page.width * scale));
      const height = Math.max(1, Math.round(page.height * scale));
      return {
        id: `overview-${page.pageId}`,
        width,
        height,
        byteLength: width * height,
        data: `overview:${width}x${height}`,
      };
    },
    async cropAndTransform(req) {
      opts?.onCrop?.(req);
      seq += 1;
      const rotatedSize = computeRotatedSize(req.cropRectPx.width, req.cropRectPx.height, req.angle);
      const paddedW = rotatedSize.width + req.paddingPx.left + req.paddingPx.right;
      const paddedH = rotatedSize.height + req.paddingPx.top + req.paddingPx.bottom;
      const scale = Math.min(1, req.targetMaxLongestSide / Math.max(paddedW, paddedH));
      const vlmW = Math.max(1, Math.round(paddedW * scale));
      const vlmH = Math.max(1, Math.round(paddedH * scale));
      const transform: CropTransform = {
        originalSize: { width: req.page.width, height: req.page.height },
        cropRectPx: { ...req.cropRectPx },
        rotationDegCCW: req.angle,
        rotatedSize,
        paddingPx: { ...req.paddingPx },
        resizedSize: { width: vlmW, height: vlmH },
      };
      const image = {
        id: `crop-${seq}`,
        width: vlmW,
        height: vlmH,
        byteLength: vlmW * vlmH,
        data: `crop:${seq}:${vlmW}x${vlmH}`,
      };
      return { ocrImage: image, vlmImage: image, transform };
    },
  };
}

describe('agentic-ocr: parseActionPayload & placeholder validation', () => {
  it('parses fenced JSON and tagged tool_call while discarding trailing hallucinated blocks', () => {
    const fenced = [
      'Let me inspect the table.',
      '```json',
      '{"type":"zoom_and_ocr","label":"table-total","bbox":[100,200,500,400],"angle":90,"mode":"table"}',
      '```',
      '<tool_response>{"text":"hallucinated response"}</tool_response>',
      '```json',
      '{"type":"zoom_and_ocr","label":"extra","bbox":[0,0,100,100],"mode":"text"}',
      '```',
    ].join('\n');

    const parsedFenced = parseActionPayload(fenced);
    expect(parsedFenced).toEqual({
      ok: true,
      action: {
        type: 'zoom_and_ocr',
        label: 'table-total',
        bbox: [100, 200, 500, 400],
        angle: 90,
        mode: 'table',
      },
    });

    const tagged =
      '<tool_call>{"type":"tile_sweep","grid":"2x2"}</tool_call>\nTrailing hallucination <tool_call>{"type":"tile_sweep","grid":"3x3"}</tool_call>';
    expect(parseActionPayload(tagged)).toEqual({
      ok: true,
      action: { type: 'tile_sweep', grid: '2x2' },
    });
  });

  it('rejects simultaneous tool_call and final_answer or invalid bbox/angle', () => {
    const dualTags =
      '<tool_call>{"type":"zoom_and_ocr","label":"x","bbox":[10,10,100,100],"mode":"text"}</tool_call>' +
      '<final_answer>{"type":"stop_with_evidence","answerable":true,"evidence":[{"content":"42","bbox":[10,10,100,100],"pageIndex":1}]}</final_answer>';
    const dualRes = parseActionPayload(dualTags);
    expect(dualRes.ok).toBe(false);
    if (!dualRes.ok) {
      expect(dualRes.code).toBe('simultaneous-actions');
    }

    const badBox = parseActionPayload({
      type: 'zoom_and_ocr',
      label: 'inverted',
      bbox: [500, 100, 200, 300],
      mode: 'text',
    });
    expect(badBox.ok).toBe(false);

    const badAngle = parseActionPayload({
      type: 'zoom_and_ocr',
      label: 'bad-angle',
      bbox: [100, 100, 200, 300],
      angle: 45,
      mode: 'text',
    });
    expect(badAngle.ok).toBe(false);
  });

  it('detects empty and placeholder evidence strings', () => {
    expect(isPlaceholderEvidence('')).toBe(true);
    expect(isPlaceholderEvidence('   ')).toBe(true);
    expect(isPlaceholderEvidence('N/A')).toBe(true);
    expect(isPlaceholderEvidence('...')).toBe(true);
    expect(isPlaceholderEvidence('[placeholder]')).toBe(true);
    expect(isPlaceholderEvidence('none')).toBe(true);
    expect(isPlaceholderEvidence('Total revenue: $1.24M')).toBe(false);
  });
});

describe('agentic-ocr: CropArtifactCache LRU & quantization', () => {
  it('quantizes bbox keys and evicts least-recently-used entries by byte budget', () => {
    expect(quantizeBBox([100.4, 200.6, 300.2, 400.9], 1)).toEqual([100, 201, 300, 401]);

    const keyA = buildCropCacheKey({
      pageId: 'p1',
      bbox: [100.2, 200.1, 300.4, 400.2],
      angle: 0,
      padding: { top: 10, right: 10, bottom: 10, left: 10 },
      targetMaxPixels: 1024,
      mode: 'text',
    });
    const keyA2 = buildCropCacheKey({
      pageId: 'p1',
      bbox: [100, 200, 300, 400],
      angle: 0,
      padding: { top: 10, right: 10, bottom: 10, left: 10 },
      targetMaxPixels: 1024,
      mode: 'text',
    });
    expect(keyA).toBe(keyA2);

    const cache = new CropArtifactCache({ maxCacheBytes: 250, maxEntries: 10 });
    const makeEntry = (id: string, bytes: number) => ({
      ocrImage: { id, width: 10, height: 10, byteLength: bytes, data: id },
      vlmImage: { id, width: 10, height: 10, byteLength: 0, data: id },
      transform: {
        originalSize: { width: 1000, height: 1000 },
        cropRectPx: { x: 0, y: 0, width: 100, height: 100 },
        rotationDegCCW: 0,
        rotatedSize: { width: 100, height: 100 },
        resizedSize: { width: 100, height: 100 },
      },
      ocrResult: { text: id },
    });

    cache.set('a', makeEntry('a', 100));
    cache.set('b', makeEntry('b', 100));
    // Touch 'a' so 'b' becomes LRU.
    expect(cache.get('a')?.ocrResult.text).toBe('a');
    cache.set('c', makeEntry('c', 100));

    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(cache.has('c')).toBe(true);
    expect(cache.stats().evictions).toBe(1);
    expect(cache.stats().hits).toBe(1);
  });
});

describe('agentic-ocr: loop execution, dual-res crops, caching, memory, and guards', () => {
  it('executes dual-res overview -> rotated zoom_and_ocr -> 4-corner grounded stop_with_evidence', async () => {
    const capturedCrops: CropRequest[] = [];
    const cropper = makeFakeCropper({ onCrop: req => capturedCrops.push(req) });
    const ocrCalls: OcrExtractRequest[] = [];
    const ocr: OcrAdapter = {
      async extract(req) {
        ocrCalls.push(req);
        if (req.mode === 'table') {
          return {
            text: 'Net Income: $420M',
            confidence: 0.96,
            elements: [
              {
                text: 'Net Income: $420M',
                localBBox: [200, 300, 800, 700],
                confidence: 0.96,
                kind: 'table',
              },
            ],
          };
        }
        return { text: '' };
      },
    };

    const turns: AgenticOcrTurnInput[] = [];
    const model: AgenticOcrModel = {
      async nextStep(input) {
        turns.push(input);
        if (input.round === 1) {
          return {
            type: 'zoom_and_ocr',
            label: 'income-table',
            bbox: [100, 200, 500, 400],
            angle: 90,
            mode: 'table',
          };
        }
        if (input.round === 2) {
          return {
            type: 'zoom_and_ocr',
            label: 'diagram',
            bbox: [600, 600, 900, 900],
            angle: 0,
            mode: 'image',
          };
        }
        return {
          type: 'stop_with_evidence',
          answerable: true,
          evidence: [
            {
              content: 'Net Income: $420M',
              bbox: [100, 200, 500, 400],
              pageIndex: 3,
              confidence: 0.96,
            },
          ],
        };
      },
    };

    const result = await runAgenticOcr({
      page: SAMPLE_PAGE,
      query: 'What is Net Income?',
      cropper,
      ocr,
      model,
      budget: { maxOverviewLongestSide: 1024 },
    });

    expect(result.status).toBe('completed');
    expect(result.answerable).toBe(true);
    expect(result.evidence[0]?.content).toBe('Net Income: $420M');
    expect(turns[0]?.images).toHaveLength(1);
    expect(turns[0]?.images[0]?.role).toBe('overview');
    expect(Math.max(turns[0]?.images[0]?.image.width ?? 0, turns[0]?.images[0]?.image.height ?? 0)).toBeLessThanOrEqual(
      1024,
    );

    // Table crop received 15% padding, image crop received 0 padding and skipped OCR.
    expect(capturedCrops).toHaveLength(2);
    expect(capturedCrops[0]?.paddingPx.left).toBeGreaterThan(0);
    expect(capturedCrops[1]?.paddingPx).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(ocrCalls).toHaveLength(1);
    expect(result.metrics.cropCalls).toBe(2);
    expect(result.metrics.ocrCalls).toBe(1);
  });

  it('supports judgeRelevance fast-path skip', async () => {
    const cropper = makeFakeCropper();
    const ocrExtract = vi.fn(async () => ({ text: 'should not run' }));
    const nextStep = vi.fn(async (): Promise<AgenticOcrAction> => ({
      type: 'stop_with_evidence',
      answerable: false,
      evidence: [],
    }));

    const result = await runAgenticOcr({
      page: SAMPLE_PAGE,
      query: 'Irrelevant appendix',
      cropper,
      ocr: { extract: ocrExtract },
      model: {
        async judgeRelevance() {
          return { relevant: false, reason: 'Blank cover page' };
        },
        nextStep,
      },
    });

    expect(result.status).toBe('irrelevant');
    expect(result.answerable).toBe(false);
    expect(result.evidence).toEqual([]);
    expect(ocrExtract).not.toHaveBeenCalled();
    expect(nextStep).not.toHaveBeenCalled();
  });

  it('supports tile_sweep 2x2 grid fallback and deduplicates overlapping tile hits', async () => {
    const cropper = makeFakeCropper();
    let tileSeq = 0;
    const ocr: OcrAdapter = {
      async extract() {
        tileSeq += 1;
        return { text: `Tile ${tileSeq} text`, confidence: 0.9 };
      },
    };
    const turns: AgenticOcrTurnInput[] = [];
    const model: AgenticOcrModel = {
      async nextStep(input) {
        turns.push(input);
        if (input.round === 1) {
          return { type: 'tile_sweep', grid: '2x2' };
        }
        return {
          type: 'stop_with_evidence',
          answerable: true,
          evidence: [{ content: 'Tile 1 text', bbox: [0, 0, 540, 540], pageIndex: 3 }],
        };
      },
    };

    const result = await runAgenticOcr({
      page: SAMPLE_PAGE,
      query: 'Scan whole page',
      cropper,
      ocr,
      model,
      budget: { maxActiveCropImages: 3 },
    });

    expect(result.status).toBe('completed');
    expect(result.metrics.cropCalls).toBe(4);
    expect(result.metrics.ocrCalls).toBe(4);
    // Window cap enforces overview + 3 active tiles even after a 4-tile sweep,
    // while memory holds all 4 tile summaries.
    expect(turns[1]?.images).toHaveLength(4);
    expect(turns[1]?.memory).toHaveLength(4);
  });

  it('reuses cached crops and OCR across queries via CropArtifactCache', async () => {
    const cropSpy = vi.fn();
    const cropper = makeFakeCropper({ onCrop: cropSpy });
    const ocrExtract = vi.fn(async () => ({ text: 'Cached clause 7.2', confidence: 0.95 }));
    const sharedCache = new CropArtifactCache();

    const makeModel = (): AgenticOcrModel => ({
      async nextStep(input) {
        if (input.round === 1) {
          return {
            type: 'zoom_and_ocr',
            label: 'clause',
            bbox: [100, 100, 400, 250],
            angle: 0,
            mode: 'text',
          };
        }
        return {
          type: 'stop_with_evidence',
          answerable: true,
          evidence: [{ content: 'Cached clause 7.2', bbox: [100, 100, 400, 250], pageIndex: 3 }],
        };
      },
    });

    const first = await runAgenticOcr({
      page: SAMPLE_PAGE,
      query: 'Query 1',
      cropper,
      ocr: { extract: ocrExtract },
      model: makeModel(),
      cache: sharedCache,
    });
    expect(first.metrics.cacheMisses).toBe(1);
    expect(first.metrics.cropCalls).toBe(1);
    expect(first.metrics.ocrCalls).toBe(1);

    const second = await runAgenticOcr({
      page: SAMPLE_PAGE,
      query: 'Query 2',
      cropper,
      ocr: { extract: ocrExtract },
      model: makeModel(),
      cache: sharedCache,
    });
    expect(second.metrics.cacheHits).toBe(1);
    expect(second.metrics.cropCalls).toBe(0);
    expect(second.metrics.ocrCalls).toBe(0);
    expect(cropSpy).toHaveBeenCalledTimes(1);
    expect(ocrExtract).toHaveBeenCalledTimes(1);
  });

  it('caps active crop image window and retains older rounds in structured text reflection memory', async () => {
    const cropper = makeFakeCropper();
    const ocr: OcrAdapter = {
      async extract(req) {
        return { text: `Extracted from ${req.label ?? 'crop'}`, confidence: 0.9 };
      },
    };
    const seenImageCounts: number[] = [];
    const seenMemoryLengths: number[] = [];
    let finalMemorySnap: AgenticOcrTurnInput['memory'] = [];

    const boxes: NormalizedBBox[] = [
      [50, 50, 200, 150],
      [250, 50, 400, 150],
      [450, 50, 600, 150],
      [650, 50, 800, 150],
    ];

    const model: AgenticOcrModel = {
      async nextStep(input) {
        seenImageCounts.push(input.images.length);
        seenMemoryLengths.push(input.memory.length);
        finalMemorySnap = input.memory;
        const box = boxes[input.round - 1];
        if (box !== undefined) {
          return {
            type: 'zoom_and_ocr',
            label: `r${input.round}`,
            bbox: box,
            mode: 'text',
          };
        }
        return {
          type: 'stop_with_evidence',
          answerable: true,
          evidence: [{ content: 'Extracted from r4', bbox: boxes[3]!, pageIndex: 3 }],
        };
      },
    };

    const result = await runAgenticOcr({
      page: SAMPLE_PAGE,
      query: 'Multi-region lookup',
      cropper,
      ocr,
      model,
      budget: { maxRounds: 6, maxActiveCropImages: 2 },
    });

    expect(result.status).toBe('completed');
    // Round 1: overview (1); Round 2: 2; Round 3..5: capped at overview + 2 crops = 3!
    expect(seenImageCounts).toEqual([1, 2, 3, 3, 3]);
    expect(seenMemoryLengths).toEqual([0, 1, 2, 3, 4]);
    expect(finalMemorySnap[0]?.extractedTextSummary).toContain('Extracted from r1');
  });

  it('rejects duplicate calls and placeholder evidence with corrective notices', async () => {
    const cropSpy = vi.fn();
    const cropper = makeFakeCropper({ onCrop: cropSpy });
    const ocrExtract = vi.fn(async () => ({ text: 'Revenue: $99M', confidence: 0.95 }));
    const notices: Array<string | undefined> = [];

    const model: AgenticOcrModel = {
      async nextStep(input) {
        notices.push(input.systemNotice);
        if (input.round === 1) {
          return {
            type: 'zoom_and_ocr',
            label: 'rev',
            bbox: [100, 100, 300, 200],
            angle: 0,
            mode: 'text',
          };
        }
        if (input.round === 2) {
          // Duplicate quantized bbox/angle/mode -> must be rejected without calling cropper/OCR!
          return {
            type: 'zoom_and_ocr',
            label: 'rev-again',
            bbox: [100.2, 99.8, 300.1, 200.2],
            angle: 0,
            mode: 'text',
          };
        }
        if (input.round === 3) {
          // Placeholder evidence -> must be rejected!
          return {
            type: 'stop_with_evidence',
            answerable: true,
            evidence: [{ content: 'N/A', bbox: [100, 100, 300, 200], pageIndex: 3 }],
          };
        }
        return {
          type: 'stop_with_evidence',
          answerable: true,
          evidence: [{ content: 'Revenue: $99M', bbox: [100, 100, 300, 200], pageIndex: 3 }],
        };
      },
    };

    const result = await runAgenticOcr({
      page: SAMPLE_PAGE,
      query: 'Find revenue',
      cropper,
      ocr: { extract: ocrExtract },
      model,
      budget: { maxRounds: 6, maxRetriesPerTool: 3 },
    });

    expect(result.status).toBe('completed');
    expect(cropSpy).toHaveBeenCalledTimes(1);
    expect(ocrExtract).toHaveBeenCalledTimes(1);
    expect(result.metrics.rejectedCalls).toBe(2);
    expect(notices[2]).toMatch(/already inspected|duplicate/i);
    expect(notices[3]).toMatch(/placeholder|empty|evidence/i);
  });

  it('enforces maxRounds, windDownAtRound, and maxTotalPixels with graceful partial evidence', async () => {
    const cropper = makeFakeCropper();
    const ocr: OcrAdapter = {
      async extract() {
        return {
          text: 'Partial line item: $12.50',
          confidence: 0.88,
          elements: [{ text: 'Partial line item: $12.50', localBBox: [200, 200, 800, 600], confidence: 0.88 }],
        };
      },
    };

    // Case 1: maxRounds + windDownAtRound disables zoom on wind-down round and returns partial evidence.
    const windDownFlags: boolean[] = [];
    const roundRes = await runAgenticOcr({
      page: SAMPLE_PAGE,
      query: 'Keep zooming forever',
      cropper,
      ocr,
      model: {
        async nextStep(input) {
          windDownFlags.push(input.windDown);
          return {
            type: 'zoom_and_ocr',
            label: `loop-${input.round}`,
            bbox: [100 * input.round, 100, 100 * input.round + 80, 200],
            mode: 'text',
          };
        },
      },
      budget: { maxRounds: 3, windDownAtRound: 2 },
    });

    expect(windDownFlags).toEqual([false, true, true]);
    expect(roundRes.status).toBe('budget_exhausted');
    // Only round 1 ran crop/OCR; rounds 2 & 3 were in windDown so zoom was blocked.
    expect(roundRes.metrics.cropCalls).toBe(1);
    expect(roundRes.evidence.length).toBeGreaterThan(0);
    expect(roundRes.evidence[0]?.content).toContain('Partial line item');
    expect(roundRes.evidence[0]?.bbox[0]).toBeGreaterThanOrEqual(100);
    expect(roundRes.evidence[0]?.bbox[2]).toBeLessThanOrEqual(180);

    // Case 2: maxTotalPixels adaptively scales targetMaxLongestSide down and stops cleanly when exhausted.
    const seenTargets: number[] = [];
    const adaptiveCropper = makeFakeCropper({
      onCrop: req => seenTargets.push(req.targetMaxLongestSide),
    });

    const pixelRes = await runAgenticOcr({
      page: SAMPLE_PAGE,
      query: 'Check tight pixel budget',
      cropper: adaptiveCropper,
      ocr,
      model: {
        async nextStep(input) {
          return {
            type: 'zoom_and_ocr',
            label: `px-${input.round}`,
            bbox: [50 * input.round, 100, 750 + 50 * input.round, 800],
            mode: 'text',
            targetResolution: 'high',
          };
        },
      },
      budget: {
        maxRounds: 6,
        maxOverviewLongestSide: 500, // ~ 333 * 500 = 166_500 px
        maxCropLongestSide: 1000,
        maxHighResCropLongestSide: 1200,
        minCropLongestSide: 224,
        maxTotalPixels: 320_000, // leaves ~153_500 px -> forces 1/sqrt(factor) adaptive scale-down on round 1, then wind-down!
      },
    });

    expect(seenTargets[0]).toBeLessThan(1200);
    expect(seenTargets[0]).toBeGreaterThanOrEqual(224);
    expect(pixelRes.metrics.totalPixelsUsed).toBeLessThanOrEqual(320_000);
    expect(pixelRes.status).toBe('budget_exhausted');
    expect(pixelRes.evidence.length).toBeGreaterThan(0);
  });

  it('runs optional verifyEvidence pass and handles reject -> revise -> accept', async () => {
    const cropper = makeFakeCropper();
    const ocr: OcrAdapter = {
      async extract(req) {
        return { text: req.label === 'corrected' ? 'Exact total: 550' : 'Draft: 500', confidence: 0.92 };
      },
    };
    let verifyCount = 0;

    const result = await runAgenticOcr({
      page: SAMPLE_PAGE,
      query: 'Verify exact total',
      cropper,
      ocr,
      model: {
        async nextStep(input) {
          if (input.round === 1) {
            return {
              type: 'stop_with_evidence',
              answerable: true,
              evidence: [{ content: 'Draft: 500', bbox: [100, 100, 300, 200], pageIndex: 3 }],
            };
          }
          if (input.round === 2) {
            return {
              type: 'zoom_and_ocr',
              label: 'corrected',
              bbox: [150, 250, 450, 350],
              mode: 'text',
            };
          }
          return {
            type: 'stop_with_evidence',
            answerable: true,
            evidence: [{ content: 'Exact total: 550', bbox: [150, 250, 450, 350], pageIndex: 3 }],
          };
        },
        async verifyEvidence({ evidence }) {
          verifyCount += 1;
          if (evidence[0]?.content === 'Draft: 500') {
            return { verdict: 'reject', reason: 'Number 500 mismatches table row' };
          }
          return { verdict: 'accept' };
        },
      },
    });

    expect(verifyCount).toBe(2);
    expect(result.status).toBe('completed');
    expect(result.verified).toBe(true);
    expect(result.evidence[0]?.content).toBe('Exact total: 550');
  });

  it('aborts immediately when AbortSignal is pre-aborted or aborted mid-flight', async () => {
    const cropper = makeFakeCropper();
    const ocr: OcrAdapter = { async extract() { return { text: 'ok' }; } };

    // Pre-aborted
    const preController = new AbortController();
    preController.abort();
    const nextStepPre = vi.fn();
    await expect(
      runAgenticOcr({
        page: SAMPLE_PAGE,
        query: 'Aborted before start',
        cropper,
        ocr,
        model: { nextStep: nextStepPre },
        signal: preController.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(nextStepPre).not.toHaveBeenCalled();

    // Mid-flight abort while awaiting model
    const midController = new AbortController();
    let resolvePending!: (val: AgenticOcrAction) => void;
    const pendingModel = new Promise<AgenticOcrAction>(resolve => {
      resolvePending = resolve;
    });
    const cache = new CropArtifactCache();
    const runPromise = runAgenticOcr({
      page: SAMPLE_PAGE,
      query: 'Aborted mid-flight',
      cropper,
      ocr,
      cache,
      model: {
        nextStep: () => pendingModel,
      },
      signal: midController.signal,
    });

    const rejected = expect(runPromise).rejects.toMatchObject({ name: 'AbortError' });
    midController.abort();
    await rejected;

    // Resolve stale promise late; cache must remain untouched.
    resolvePending({
      type: 'stop_with_evidence',
      answerable: true,
      evidence: [{ content: 'stale', bbox: [10, 10, 50, 50], pageIndex: 3 }],
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(cache.stats().size).toBe(0);
  });
});
