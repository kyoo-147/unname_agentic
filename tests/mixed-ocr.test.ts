import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIGITAL_QUALITY_THRESHOLD,
  DEFAULT_OVERLAP_IOU_THRESHOLD,
  MIXED_OCR_REASONS,
  assessDigitalTextQuality,
  computeRectIoU,
  mergeMixedPageBlocks,
  planMixedPageOcr,
} from '../src/core/mixed-ocr';
import type {
  CandidateImageRegionInput,
  DigitalBlockInput,
  OcrRegionBlockInput,
} from '../src/core/mixed-ocr';
import type { Rect } from '../src/core/types';

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

function digital(
  id: string,
  text: string,
  box: Rect,
  extra: Partial<DigitalBlockInput> = {},
): DigitalBlockInput {
  return { id, text, rect: box, ...extra };
}

function imageRegion(
  id: string,
  box: Rect,
  extra: Partial<CandidateImageRegionInput> = {},
): CandidateImageRegionInput {
  return { id, rect: box, ...extra };
}

function ocrBlock(
  id: string,
  text: string,
  box: Rect,
  extra: Partial<OcrRegionBlockInput> = {},
): OcrRegionBlockInput {
  return { id, text, rect: box, confidence: 0.92, ...extra };
}

describe('F06 mixed-region OCR planner — region classification', () => {
  it('keeps good digital text and skips an overlapping image region on the same box', () => {
    const box = rect(56, 80, 480, 60);
    const plan = planMixedPageOcr({
      page: 1,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [digital('d1', 'Clean native paragraph from PDF stream.', box)],
      imageRegions: [imageRegion('img1', rect(58, 81, 476, 58))],
    });

    expect(plan.needsOcr).toBe(false);
    expect(plan.keptDigitalBlocks).toHaveLength(1);
    expect(plan.keptDigitalBlocks[0]?.id).toBe('d1');
    expect(plan.keptDigitalBlocks[0]?.source).toBe('pdf-text');
    expect(plan.keptDigitalBlocks[0]?.reasons).toContain(MIXED_OCR_REASONS.digitalQualityOk);

    expect(plan.ocrTasks).toEqual([]);
    expect(plan.skippedRegions).toHaveLength(1);
    expect(plan.skippedRegions[0]?.id).toBe('img1');
    expect(plan.skippedRegions[0]?.action).toBe('skip-overlap');
    expect(plan.skippedRegions[0]?.matchedId).toBe('d1');
    expect(plan.skippedRegions[0]?.reasons).toContain(MIXED_OCR_REASONS.ocrCoveredByGoodDigital);

    expect(plan.decisions.map(d => [d.id, d.action])).toEqual([
      ['d1', 'keep-digital'],
      ['img1', 'skip-overlap'],
    ]);
  });

  it('schedules image-only regions for OCR while keeping separate digital blocks', () => {
    const plan = planMixedPageOcr({
      page: 2,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [digital('d-head', 'Section 1. Introduction', rect(56, 60, 480, 28))],
      imageRegions: [imageRegion('img-scan', rect(56, 120, 480, 240))],
    });

    expect(plan.needsOcr).toBe(true);
    expect(plan.keptDigitalBlocks.map(b => b.id)).toEqual(['d-head']);
    expect(plan.ocrTasks).toHaveLength(1);
    expect(plan.ocrTasks[0]).toMatchObject({
      regionId: 'img-scan',
      origin: 'image-region',
      rect: rect(56, 120, 480, 240),
      excludedRects: [],
      reasons: [MIXED_OCR_REASONS.ocrImageOnly],
    });
    expect(plan.decisions.map(d => [d.id, d.action, d.source])).toEqual([
      ['d-head', 'keep-digital', 'pdf-text'],
      ['img-scan', 'run-ocr', 'ocr-region'],
    ]);
  });

  it('keeps a large scan image scheduled while masking small good digital blocks inside it', () => {
    const headerBox = rect(56, 56, 480, 24);
    const fullScanBox = rect(20, 20, 555, 802);

    const plan = planMixedPageOcr({
      page: 1,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [digital('d-stamp', 'Journal Vol. 12 — Page 1', headerBox)],
      imageRegions: [imageRegion('img-full', fullScanBox)],
    });

    expect(plan.needsOcr).toBe(true);
    expect(plan.keptDigitalBlocks.map(b => b.id)).toEqual(['d-stamp']);
    expect(plan.ocrTasks).toHaveLength(1);
    expect(plan.ocrTasks[0]?.regionId).toBe('img-full');
    expect(plan.ocrTasks[0]?.excludedRects).toEqual([headerBox]);
    expect(plan.ocrTasks[0]?.reasons).toContain(MIXED_OCR_REASONS.ocrPartialOverlapBelowThreshold);
  });

  it('deduplicates overlapping candidate image regions so OCR runs only once per zone', () => {
    const plan = planMixedPageOcr({
      page: 1,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [],
      imageRegions: [
        imageRegion('img-outer', rect(40, 100, 300, 200)),
        imageRegion('img-dup', rect(45, 105, 290, 190)),
      ],
    });

    expect(plan.ocrTasks).toHaveLength(1);
    expect(plan.ocrTasks[0]?.regionId).toBe('img-outer');
    expect(plan.skippedRegions).toHaveLength(1);
    expect(plan.skippedRegions[0]?.id).toBe('img-dup');
    expect(plan.skippedRegions[0]?.action).toBe('skip-overlap');
    expect(plan.skippedRegions[0]?.reasons).toContain(MIXED_OCR_REASONS.ocrDuplicateRegion);
  });
});

describe('F06 IoU overlap deduplication threshold', () => {
  it('computes exact IoU for overlapping, disjoint, and identical boxes', () => {
    const a = rect(0, 0, 100, 100);
    const identical = rect(0, 0, 100, 100);
    const halfBoundary = rect(100 / 3, 0, 100, 100); // overlap 2/3*100*100, union 4/3*100*100 -> IoU = 0.5
    const disjoint = rect(200, 0, 100, 100);

    expect(computeRectIoU(a, identical)).toBe(1);
    expect(computeRectIoU(a, halfBoundary)).toBeCloseTo(0.5, 6);
    expect(computeRectIoU(a, disjoint)).toBe(0);
  });

  it('skips overlap exactly at DEFAULT_OVERLAP_IOU_THRESHOLD and keeps strictly below it', () => {
    const digitalBox = rect(0, 0, 100, 100);
    // Intersection = 67 * 100 = 6700; Union = 10000 + 10000 - 6700 = 13300; IoU = 0.503759 >= 0.5
    const atOrAbove = rect(33, 0, 100, 100);
    // Intersection = 60 * 100 = 6000; Union = 14000; IoU = 0.428571 < 0.5
    const below = rect(40, 0, 100, 100);

    expect(DEFAULT_OVERLAP_IOU_THRESHOLD).toBe(0.5);

    const skippedPlan = planMixedPageOcr({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [digital('d1', 'Good digital box', digitalBox)],
      imageRegions: [imageRegion('img-hit', atOrAbove)],
    });
    expect(skippedPlan.decisions.find(d => d.id === 'img-hit')?.action).toBe('skip-overlap');

    const keptPlan = planMixedPageOcr({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [digital('d1', 'Good digital box', digitalBox)],
      imageRegions: [imageRegion('img-miss', below)],
    });
    expect(keptPlan.decisions.find(d => d.id === 'img-miss')?.action).toBe('run-ocr');
  });

  it('respects custom overlapIouThreshold in both planning and merging', () => {
    const digitalBox = rect(0, 0, 100, 100);
    const shifted = rect(40, 0, 100, 100); // IoU ≈ 0.4286

    const strictPlan = planMixedPageOcr(
      {
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        digitalBlocks: [digital('d1', 'Good digital text', digitalBox)],
        imageRegions: [imageRegion('img1', shifted)],
      },
      { overlapIouThreshold: 0.4 },
    );
    expect(strictPlan.decisions.find(d => d.id === 'img1')?.action).toBe('skip-overlap');

    const relaxedMerge = mergeMixedPageBlocks(
      {
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        digitalBlocks: [digital('d1', 'Good digital text', digitalBox)],
        ocrBlocks: [ocrBlock('o1', 'OCR overlapping text', rect(20, 0, 100, 100))], // IoU = 8000/12000 = 0.667
      },
      { overlapIouThreshold: 0.75 },
    );
    expect(relaxedMerge.blocks.map(b => b.id)).toEqual(['d1', 'o1']);
  });
});

describe('F06 digital quality assessment and corrupted text OCR fallback', () => {
  it('accepts clean multilingual text and numbers above DEFAULT_DIGITAL_QUALITY_THRESHOLD', () => {
    expect(DEFAULT_DIGITAL_QUALITY_THRESHOLD).toBe(0.7);

    for (const sample of [
      'Quarterly financial results for Q4 2026 ($1,250.00).',
      'Tiếng Việt có dấu đầy đủ: ă â đ ê ô ơ ư và số 42.',
      '日本語テストと漢字の確認',
      'النص العربي 123',
      'Fig. 2',
    ]) {
      const verdict = assessDigitalTextQuality(sample);
      expect(verdict.isGood).toBe(true);
      expect(verdict.score).toBeGreaterThanOrEqual(DEFAULT_DIGITAL_QUALITY_THRESHOLD);
    }
  });

  it('flags replacement chars, PUA glyphs, CID tokens, and control chars as garbled', () => {
    const cases: Array<{ text: string; expectedReason: string }> = [
      { text: 'Th\uFFFDs t\uFFFDxt is br\uFFFDken', expectedReason: MIXED_OCR_REASONS.digitalReplacementChar },
      { text: '\uE001\uE002\uE003\uE004\uE005', expectedReason: MIXED_OCR_REASONS.digitalPrivateUse },
      { text: '(cid:42)(cid:43)(cid:44)', expectedReason: MIXED_OCR_REASONS.digitalCidToken },
      { text: 'abc\u0001\u0002\u0003def', expectedReason: MIXED_OCR_REASONS.digitalControlChars },
    ];

    for (const entry of cases) {
      const verdict = assessDigitalTextQuality(entry.text);
      expect(verdict.isGood).toBe(false);
      expect(verdict.score).toBeLessThan(DEFAULT_DIGITAL_QUALITY_THRESHOLD);
      expect(verdict.reasons).toContain(entry.expectedReason);
    }
  });

  it('schedules OCR fallback when digital text is garbled or below explicit qualityScore', () => {
    const garbledBox = rect(56, 100, 260, 40);
    const lowScoreBox = rect(56, 160, 260, 40);

    const plan = planMixedPageOcr({
      page: 1,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [
        digital('d-garbled', '\uFFFD\uFFFD\uFFFD \uFFFD\uFFFD\uFFFD', garbledBox),
        digital('d-low', 'looks okay but bad CMap', lowScoreBox, { qualityScore: 0.4 }),
      ],
      imageRegions: [],
    });

    expect(plan.needsOcr).toBe(true);
    expect(plan.keptDigitalBlocks).toEqual([]);
    expect(plan.ocrTasks).toHaveLength(2);
    expect(plan.ocrTasks[0]).toMatchObject({
      origin: 'corrupted-digital',
      replacesBlockId: 'd-garbled',
      rect: garbledBox,
    });
    expect(plan.ocrTasks[0]?.reasons).toContain(MIXED_OCR_REASONS.ocrFallbackGarbledDigital);
    expect(plan.ocrTasks[1]).toMatchObject({
      origin: 'corrupted-digital',
      replacesBlockId: 'd-low',
      rect: lowScoreBox,
    });
    expect(plan.decisions.map(d => [d.id, d.action])).toEqual([
      ['d-garbled', 'run-ocr'],
      ['d-low', 'run-ocr'],
    ]);
  });

  it('reuses a covering image region task instead of duplicating OCR for a garbled digital block', () => {
    const plan = planMixedPageOcr({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [digital('d-bad', '(cid:10)(cid:11)(cid:12)', rect(60, 120, 200, 36))],
      imageRegions: [imageRegion('img-region', rect(56, 116, 208, 44))],
    });

    expect(plan.keptDigitalBlocks).toEqual([]);
    expect(plan.ocrTasks).toHaveLength(1);
    expect(plan.ocrTasks[0]?.regionId).toBe('img-region');
    expect(plan.ocrTasks[0]?.reasons).toContain(MIXED_OCR_REASONS.ocrFallbackGarbledDigital);
    expect(plan.decisions.find(d => d.id === 'd-bad')?.action).toBe('run-ocr');
  });

  it('skips a garbled ghost run when good digital text already covers the exact same box', () => {
    const box = rect(56, 100, 300, 40);
    const plan = planMixedPageOcr({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [
        digital('d-good', 'Valid native digital heading', box),
        digital('d-ghost', '\uFFFD\uFFFD\uFFFD', box),
      ],
      imageRegions: [],
    });

    expect(plan.needsOcr).toBe(false);
    expect(plan.keptDigitalBlocks.map(b => b.id)).toEqual(['d-good']);
    expect(plan.ocrTasks).toEqual([]);
    expect(plan.decisions.find(d => d.id === 'd-ghost')?.action).toBe('skip-overlap');
  });
});

describe('F06 non-overlapping reading-order merger', () => {
  it('merges pdf-text and ocr-region blocks in reading order without duplicate overlapping layers', () => {
    const result = mergeMixedPageBlocks({
      page: 1,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [
        digital('d-title', 'Hybrid Report Title', rect(56, 50, 480, 32)),
        digital('d-footer', 'Conclusion paragraph in digital text.', rect(56, 420, 480, 60)),
      ],
      ocrBlocks: [
        // Duplicate OCR block sitting over d-title -> must be dropped
        ocrBlock('o-dup-title', 'Hybrid Report Title (OCR)', rect(57, 51, 478, 30), { confidence: 0.99 }),
        // Genuine scanned block between title and footer -> must be kept
        ocrBlock('o-body', 'Scanned middle paragraph recognized by OCR.', rect(56, 140, 480, 200), { confidence: 0.88 }),
        // Lower-confidence duplicate OCR block overlapping o-body -> must be dropped
        ocrBlock('o-dup-body', 'Scanned middle duplicate', rect(58, 142, 476, 196), { confidence: 0.71 }),
      ],
    });

    expect(result.blocks.map(b => b.id)).toEqual(['d-title', 'o-body', 'd-footer']);
    expect(result.blocks.map(b => b.source)).toEqual(['pdf-text', 'ocr-region', 'pdf-text']);
    expect(result.blocks.map(b => b.readingOrder)).toEqual([0, 1, 2]);
    expect(result.blocks[0]?.confidence).toBe(1);
    expect(result.blocks[1]?.confidence).toBe(0.88);

    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.map(s => [s.id, s.action])).toEqual([
      ['o-dup-title', 'skip-overlap'],
      ['o-dup-body', 'skip-overlap'],
    ]);
    expect(result.stats).toEqual({
      digitalCount: 1 + 1,
      ocrCount: 1,
      skippedOverlapCount: 2,
      skippedInvalidCount: 0,
    });
  });

  it('replaces garbled digital text with the OCR fallback block at the same location', () => {
    const box = rect(56, 120, 320, 50);
    const result = mergeMixedPageBlocks({
      page: 1,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [digital('d-garbled', '\uFFFD\uFFFD\uFFFD \uFFFD\uFFFD\uFFFD', box)],
      ocrBlocks: [ocrBlock('o-recovered', 'Recovered scanned text', box, { confidence: 0.91 })],
    });

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      id: 'o-recovered',
      source: 'ocr-region',
      text: 'Recovered scanned text',
    });
    expect(result.skipped.some(s => s.id === 'd-garbled' && s.action === 'skip-invalid')).toBe(true);
  });
});
