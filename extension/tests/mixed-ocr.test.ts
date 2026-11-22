import { describe, expect, it } from 'vitest';
import { buildDocument, validate } from '../viewer/src/core/ir';
import {
  DEFAULT_DIGITAL_QUALITY_THRESHOLD,
  DEFAULT_OVERLAP_IOU_THRESHOLD,
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  MIXED_OCR_REASONS,
  assessDigitalTextQuality,
  computePolygonArea,
  computeRectIoU,
  computeRegionIoU,
  mergeMixedPageBlocks,
  planMixedPageOcr,
  rotatedRectPolygon,
  toIrBlockInputs,
} from '../viewer/src/core/mixed-ocr';
import type {
  CandidateImageRegionInput,
  DigitalBlockInput,
  OcrRegionBlockInput,
} from '../viewer/src/core/mixed-ocr';
import type { Rect } from '../viewer/src/core/types';

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

describe('F06 edge cases — zero-area rects, rotated rects, partial overlaps, empty pages, multi-column stability', () => {
  it('returns IoU 0 and skips zero-area, negative, or non-finite rects without NaN', () => {
    const valid = rect(40, 40, 120, 40);
    const zeroWidth = rect(40, 40, 0, 40);
    const zeroHeight = rect(40, 40, 120, 0);
    const negativeWidth = rect(40, 40, -100, 40);
    const nonFinite = rect(Number.NaN, 40, Number.POSITIVE_INFINITY, 40);
    const collinearPoly = [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 90, y: 10 },
      { x: 10, y: 10 },
    ] as const;

    expect(computeRectIoU(zeroWidth, valid)).toBe(0);
    expect(computeRectIoU(zeroWidth, zeroHeight)).toBe(0);
    expect(computeRectIoU(negativeWidth, valid)).toBe(0);
    expect(computeRectIoU(nonFinite, valid)).toBe(0);
    expect(computeRegionIoU({ polygon: collinearPoly }, { rect: valid })).toBe(0);

    const plan = planMixedPageOcr({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [
        digital('d-zero', 'Ghost zero width', zeroWidth),
        digital('d-valid', 'Real digital block', valid),
      ],
      imageRegions: [
        imageRegion('img-zero', zeroHeight),
        imageRegion('img-neg', negativeWidth),
        imageRegion('img-good', rect(40, 120, 120, 40)),
      ],
    });

    expect(plan.keptDigitalBlocks.map(b => b.id)).toEqual(['d-valid']);
    expect(plan.ocrTasks.map(t => t.regionId)).toEqual(['img-good']);
    expect(plan.decisions.find(d => d.id === 'd-zero')).toMatchObject({
      action: 'skip-invalid',
      reasons: [MIXED_OCR_REASONS.regionZeroArea],
    });
    expect(plan.decisions.find(d => d.id === 'img-zero')).toMatchObject({
      action: 'skip-invalid',
      reasons: [MIXED_OCR_REASONS.regionZeroArea],
    });
    expect(plan.decisions.find(d => d.id === 'img-neg')).toMatchObject({
      action: 'skip-invalid',
      reasons: [MIXED_OCR_REASONS.regionZeroArea],
    });

    const merged = mergeMixedPageBlocks({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [digital('d-zero', 'Zero block', zeroWidth), digital('d-valid', 'Real digital block', valid)],
      ocrBlocks: [
        ocrBlock('o-zero', 'Zero OCR', zeroHeight),
        ocrBlock('o-empty', '   ', rect(40, 120, 120, 40)),
        ocrBlock('o-valid', 'Valid OCR', rect(40, 120, 120, 40), { confidence: 88 }),
      ],
    });

    expect(merged.blocks.map(b => b.id)).toEqual(['d-valid', 'o-valid']);
    expect(merged.blocks[1]?.confidence).toBe(0.88);
    expect(merged.stats.skippedInvalidCount).toBe(3);
  });

  it('handles rotated rects and exact rotated polygon overlaps without false skipping', () => {
    // Two thin strips centered at (200, 200), rotated +45 and -45 degrees:
    // their axis-aligned bounding boxes match almost 100%, while their true rotated
    // polygons only cross in a small central diamond (IoU ≈ 0.11).
    const strip = rect(140, 190, 120, 20);
    const polyPlus45 = rotatedRectPolygon(strip, 45);
    const polyMinus45 = rotatedRectPolygon(strip, -45);

    expect(computePolygonArea(polyPlus45)).toBeCloseTo(2400, 1);
    const crossIou = computeRegionIoU({ polygon: polyPlus45 }, { polygon: polyMinus45 });
    expect(crossIou).toBeGreaterThan(0);
    expect(crossIou).toBeLessThan(0.2);

    const sameIou = computeRegionIoU({ polygon: polyPlus45 }, { polygon: [...polyPlus45].reverse() });
    expect(sameIou).toBeCloseTo(1, 5);

    const plan = planMixedPageOcr({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [
        digital('d-rot-45', 'Diagonal digital label', strip, {
          polygon: polyPlus45,
          rotation: 45,
          baseRect: strip,
        }),
        digital('d-rot-270', 'Vertical margin text', rect(20, 100, 20, 160), {
          rotation: -90,
        }),
      ],
      imageRegions: [
        // Crossing -45 polygon -> low true polygon IoU, must run OCR!
        imageRegion('img-cross', strip, { polygon: polyMinus45, rotation: -45 }),
        // Same +45 polygon -> IoU = 1, must skip!
        imageRegion('img-same-45', strip, { polygon: polyPlus45, rotation: 45 }),
        // Same vertical rect -> must skip!
        imageRegion('img-vert', rect(20, 100, 20, 160), { rotation: 270 }),
      ],
    });

    expect(plan.keptDigitalBlocks.find(b => b.id === 'd-rot-270')?.rotation).toBe(270);
    expect(plan.keptDigitalBlocks.find(b => b.id === 'd-rot-45')?.baseRect).toEqual(strip);
    expect(plan.ocrTasks.map(t => t.regionId)).toEqual(['img-cross']);
    expect(plan.decisions.find(d => d.id === 'img-same-45')?.action).toBe('skip-overlap');
    expect(plan.decisions.find(d => d.id === 'img-vert')?.action).toBe('skip-overlap');

    const merged = mergeMixedPageBlocks({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [
        digital('d-rot-45', 'Diagonal digital label', strip, { polygon: polyPlus45, rotation: 45 }),
      ],
      ocrBlocks: [
        ocrBlock('o-cross', 'Diagonal OCR label', strip, { polygon: polyMinus45, rotation: -45 }),
        ocrBlock('o-dup-45', 'Duplicate diagonal OCR', strip, { polygon: polyPlus45, rotation: 45 }),
      ],
    });

    expect(merged.blocks.map(b => b.id)).toEqual(['d-rot-45', 'o-cross']);
    expect(merged.skipped.map(s => [s.id, s.action])).toEqual([['o-dup-45', 'skip-overlap']]);
  });

  it('handles partial overlaps, multi-block digital coverage, and contained OCR fragments', () => {
    const paragraphBox = rect(56, 100, 480, 120);
    const tinyOcrInside = rect(80, 130, 80, 16); // IoU ≈ 0.022, but 100% contained inside paragraphBox
    const partialEdgeOcr = rect(56, 212, 200, 60); // overlaps bottom 8pt of paragraphBox (IoU ≈ 0.023)

    const merged = mergeMixedPageBlocks({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [digital('d-para', 'Full digital paragraph covering multiple lines.', paragraphBox)],
      ocrBlocks: [
        ocrBlock('o-inside', 'Stray OCR word', tinyOcrInside),
        ocrBlock('o-adjacent', 'Scanned caption below figure', partialEdgeOcr),
      ],
    });

    expect(merged.blocks.map(b => b.id)).toEqual(['d-para', 'o-adjacent']);
    expect(merged.blocks[1]?.reasons).toContain(MIXED_OCR_REASONS.ocrPartialOverlapBelowThreshold);
    expect(merged.skipped).toHaveLength(1);
    expect(merged.skipped[0]).toMatchObject({
      id: 'o-inside',
      action: 'skip-overlap',
      matchedId: 'd-para',
      reasons: [MIXED_OCR_REASONS.ocrContainedInDigital],
    });

    // Three adjacent good digital blocks completely tile a single image region (each IoU = 0.333 < 0.5)
    const coveredPlan = planMixedPageOcr({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [
        digital('d-c1', 'Column one text', rect(0, 0, 100, 100)),
        digital('d-c2', 'Column two text', rect(100, 0, 100, 100)),
        digital('d-c3', 'Column three text', rect(200, 0, 100, 100)),
      ],
      imageRegions: [imageRegion('img-tiled', rect(0, 0, 300, 100))],
    });

    expect(coveredPlan.needsOcr).toBe(false);
    expect(coveredPlan.decisions.find(d => d.id === 'img-tiled')).toMatchObject({
      action: 'skip-overlap',
      reasons: [MIXED_OCR_REASONS.ocrCoveredByGoodDigital],
    });
  });

  it('handles empty pages, whitespace-only digital runs, and coordinate boundaries', () => {
    const emptyPlan = planMixedPageOcr({
      page: 1,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [],
      imageRegions: [],
    });
    expect(emptyPlan.needsOcr).toBe(false);
    expect(emptyPlan.keptDigitalBlocks).toEqual([]);
    expect(emptyPlan.ocrTasks).toEqual([]);
    expect(emptyPlan.decisions).toEqual([]);
    expect(emptyPlan.reasons).toEqual([MIXED_OCR_REASONS.pageEmpty]);

    const emptyMerge = mergeMixedPageBlocks({
      page: 1,
      width: 0,
      height: -10,
      digitalBlocks: [],
      ocrBlocks: [],
    });
    expect(emptyMerge.width).toBe(DEFAULT_PAGE_WIDTH);
    expect(emptyMerge.height).toBe(DEFAULT_PAGE_HEIGHT);
    expect(emptyMerge.blocks).toEqual([]);
    expect(emptyMerge.columns).toEqual([]);
    expect(emptyMerge.reasons).toEqual([MIXED_OCR_REASONS.pageEmpty]);

    // Whitespace-only digital run should neither trigger OCR by itself nor block an image underneath
    const whitespaceBox = rect(0, 0, PAGE_WIDTH, 24);
    const wsOnlyPlan = planMixedPageOcr({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [digital('d-ws', '   \n\t  ', whitespaceBox)],
      imageRegions: [],
    });
    expect(wsOnlyPlan.needsOcr).toBe(false);
    expect(wsOnlyPlan.keptDigitalBlocks).toEqual([]);
    expect(wsOnlyPlan.decisions[0]).toMatchObject({
      id: 'd-ws',
      action: 'skip-invalid',
      reasons: [MIXED_OCR_REASONS.digitalEmptyText],
    });

    const wsOverImagePlan = planMixedPageOcr({
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [digital('d-ws', '   ', rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT))],
      imageRegions: [imageRegion('img-edge', rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT))],
    });
    expect(wsOverImagePlan.needsOcr).toBe(true);
    expect(wsOverImagePlan.ocrTasks).toHaveLength(1);
    expect(wsOverImagePlan.ocrTasks[0]?.rect).toEqual(rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT));
  });

  it('merges a two-column hybrid page in deterministic column-major reading order and bridges to DocumentIR', () => {
    const title = digital('title', 'Hybrid Two-Column Paper Title', rect(56, 48, 480, 30));
    const left1 = digital('left-1', 'Left column first digital paragraph.', rect(56, 100, 220, 80));
    const left2 = digital('left-2', 'Left column second digital paragraph.', rect(56, 200, 220, 80));
    const right1 = ocrBlock('right-1', 'Right column first scanned paragraph.', rect(316, 100, 220, 80), {
      confidence: 0.94,
    });
    const right2 = ocrBlock('right-2', 'Right column second scanned paragraph.', rect(316, 200, 220, 80), {
      confidence: 0.89,
    });
    const dupLeft = ocrBlock('dup-left-1', 'Duplicate OCR of left-1', rect(57, 101, 218, 78), {
      confidence: 0.97,
    });

    const canonical = mergeMixedPageBlocks({
      page: 3,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [title, left1, left2],
      ocrBlocks: [right1, right2, dupLeft],
    });

    // Shuffled input order must yield byte-identical output
    const shuffled = mergeMixedPageBlocks({
      page: 3,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      digitalBlocks: [left2, title, left1],
      ocrBlocks: [dupLeft, right2, right1],
    });

    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(canonical));
    expect(canonical.columns).toHaveLength(2);
    expect(canonical.blocks.map(b => b.id)).toEqual(['title', 'left-1', 'left-2', 'right-1', 'right-2']);
    expect(canonical.blocks.map(b => b.source)).toEqual([
      'pdf-text',
      'pdf-text',
      'pdf-text',
      'ocr-region',
      'ocr-region',
    ]);
    expect(canonical.blocks.map(b => [b.readingOrder, b.column, b.spanning])).toEqual([
      [0, null, true],
      [1, 0, false],
      [2, 0, false],
      [3, 1, false],
      [4, 1, false],
    ]);
    expect(canonical.skipped.map(s => s.id)).toEqual(['dup-left-1']);

    // Verify clean bridge into canonical DocumentIR with zero validation issues
    const ir = buildDocument({
      sourceSha256: 'a'.repeat(64),
      pages: [{ index: 3, width: PAGE_WIDTH, height: PAGE_HEIGHT }],
      blocks: toIrBlockInputs(canonical.blocks),
      ocrEngine: 'tesseract',
    });
    expect(validate(ir)).toEqual([]);
    // buildDocument orders row-major (y then x), so row 100 yields left-1 then right-1,
    // and row 200 yields left-2 then right-2 while preserving each block's provenance.
    expect(ir.provenance.map(p => [p.blockId, p.transform, p.ocrEngine])).toEqual([
      ['p3-r0', 'pdf-text', null],
      ['p3-r1', 'pdf-text', null],
      ['p3-r2', 'ocr', 'tesseract'],
      ['p3-r3', 'pdf-text', null],
      ['p3-r4', 'ocr', 'tesseract'],
    ]);
  });
});
