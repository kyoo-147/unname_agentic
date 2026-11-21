import { describe, expect, it } from 'vitest';
import {
  NORMALIZED_COORD_MAX,
  bboxToQuad,
  clampAndOrderBBox,
  computeIoU,
  computeIoUMin,
  computePolygonArea,
  computeRotatedSize,
  fromAxisOrder,
  fromPixelBox,
  fromUnitInterval,
  mapBBoxToOriginal,
  mapPointToOriginal,
  mergeOrDeduplicateRegions,
  planGridTiles,
  polygonToBBox,
  toPixelBox,
  toUnitInterval,
  validateNormalizedBBox,
  type CropTransform,
  type GroundedRegion,
  type NormalizedBBox,
} from '../src/core/visual-grounding';

describe('visual-grounding: normalized bbox & axis validation', () => {
  it('converts between unit interval [0,1], normalized [0,1000], and pixel rects', () => {
    expect(NORMALIZED_COORD_MAX).toBe(1000);
    expect(fromUnitInterval([0.1, 0.25, 0.8, 0.9])).toEqual([100, 250, 800, 900]);
    expect(toUnitInterval([100, 250, 800, 900])).toEqual([0.1, 0.25, 0.8, 0.9]);

    const px = toPixelBox([100, 200, 600, 800], 800, 1000);
    expect(px).toEqual({ x: 80, y: 200, width: 400, height: 600 });
    expect(fromPixelBox(px, 800, 1000)).toEqual([100, 200, 600, 800]);
  });

  it('validates canonical [xMin, yMin, xMax, yMax] boxes in [0, 1000]', () => {
    expect(validateNormalizedBBox([10, 20, 300, 400])).toEqual({
      ok: true,
      bbox: [10, 20, 300, 400],
    });

    expect(validateNormalizedBBox([600, 100, 200, 400]).ok).toBe(false);
    expect(validateNormalizedBBox([100, 500, 300, 500]).ok).toBe(false);
    expect(validateNormalizedBBox([-1, 100, 300, 400]).ok).toBe(false);
    expect(validateNormalizedBBox([100, 200, 300, 1001]).ok).toBe(false);
    expect(validateNormalizedBBox([100, 200, Number.NaN, 400]).ok).toBe(false);
    expect(validateNormalizedBBox([100, 200, 300]).ok).toBe(false);
  });

  it('explicitly converts yxyx vs xyxy axis order at adapter boundaries', () => {
    expect(fromAxisOrder([100, 200, 400, 800], 'yxyx')).toEqual([200, 100, 800, 400]);
    expect(fromAxisOrder([200, 100, 800, 400], 'xyxy')).toEqual([200, 100, 800, 400]);
    expect(() => fromAxisOrder([500, 100, 200, 400], 'yxyx')).toThrow();
  });

  it('clamps, reorders, and enforces minimum span in clampAndOrderBBox', () => {
    expect(clampAndOrderBBox([-50, 800, 1200, 800])).toEqual([0, 800, 1000, 801]);
    expect(clampAndOrderBBox([700, 600, 200, 100])).toEqual([200, 100, 700, 600]);
    expect(clampAndOrderBBox([999.6, 999.8, 1000.4, 1000.2])).toEqual([999, 999, 1000, 1000]);
    expect(() => clampAndOrderBBox([Number.POSITIVE_INFINITY, 0, 100, 100])).toThrow();
  });
});

describe('visual-grounding: 4-corner CropTransform inverse mapping', () => {
  const originalSize = { width: 1000, height: 1000 };
  const cropRectPx = { x: 100, y: 200, width: 400, height: 200 };
  // Target sub-region inside cropRectPx: crop-local [40..120, 20..60]
  // -> original page px [140..220, 220..260] -> normalized [140, 220, 220, 260].
  const expectedOrigBox: NormalizedBBox = [140, 220, 220, 260];

  function expectBoxClose(actual: NormalizedBBox, expected: NormalizedBBox, digits = 4): void {
    expect(actual[0]).toBeCloseTo(expected[0], digits);
    expect(actual[1]).toBeCloseTo(expected[1], digits);
    expect(actual[2]).toBeCloseTo(expected[2], digits);
    expect(actual[3]).toBeCloseTo(expected[3], digits);
  }

  it('maps 0° rotated crop with white border padding and resize back to original coords', () => {
    const transform: CropTransform = {
      originalSize,
      cropRectPx,
      rotationDegCCW: 0,
      rotatedSize: { width: 400, height: 200 },
      paddingPx: { top: 20, right: 40, bottom: 20, left: 40 },
      resizedSize: { width: 240, height: 120 },
    };

    const pt = mapPointToOriginal({ x: 40, y: 20 }, transform);
    expect(pt.x).toBeCloseTo(140, 6);
    expect(pt.y).toBeCloseTo(220, 6);

    const localNorm: NormalizedBBox = [
      (40 / 240) * 1000,
      (20 / 120) * 1000,
      (80 / 240) * 1000,
      (40 / 120) * 1000,
    ];
    const mapped = mapBBoxToOriginal(localNorm, transform);
    expectBoxClose(mapped.bbox, expectedOrigBox);
    expect(mapped.quad[0].x).toBeCloseTo(140, 5);
    expect(mapped.quad[0].y).toBeCloseTo(220, 5);
    expect(mapped.quad[2].x).toBeCloseTo(220, 5);
    expect(mapped.quad[2].y).toBeCloseTo(260, 5);
  });

  it('maps 90° CCW rotated crop with padding and upscale back accurately', () => {
    const transform: CropTransform = {
      originalSize,
      cropRectPx,
      rotationDegCCW: 90,
      rotatedSize: computeRotatedSize(400, 200, 90),
      paddingPx: { top: 20, right: 10, bottom: 20, left: 10 },
      resizedSize: { width: 440, height: 880 },
    };
    expect(transform.rotatedSize).toEqual({ width: 200, height: 400 });

    const localNorm: NormalizedBBox = [
      (60 / 440) * 1000,
      (600 / 880) * 1000,
      (140 / 440) * 1000,
      (760 / 880) * 1000,
    ];
    const mapped = mapBBoxToOriginal(localNorm, transform);
    expectBoxClose(mapped.bbox, expectedOrigBox);
    // Rotated TL (60px, 600px) corresponds to unrotated TR (220, 220).
    expect(mapped.quad[0].x).toBeCloseTo(220, 5);
    expect(mapped.quad[0].y).toBeCloseTo(220, 5);
  });

  it('maps 180° rotated crop back accurately', () => {
    const transform: CropTransform = {
      originalSize,
      cropRectPx,
      rotationDegCCW: 180,
      rotatedSize: computeRotatedSize(400, 200, 180),
      resizedSize: { width: 800, height: 400 },
    };
    expect(transform.rotatedSize).toEqual({ width: 400, height: 200 });

    const mapped = mapBBoxToOriginal([700, 700, 900, 900], transform);
    expectBoxClose(mapped.bbox, expectedOrigBox);
  });

  it('maps 270° CCW rotated crop with padding back accurately', () => {
    const transform: CropTransform = {
      originalSize,
      cropRectPx,
      rotationDegCCW: 270,
      rotatedSize: computeRotatedSize(400, 200, 270),
      paddingPx: { top: 10, right: 20, bottom: 10, left: 20 },
      resizedSize: { width: 240, height: 420 },
    };
    expect(transform.rotatedSize).toEqual({ width: 200, height: 400 });

    const localNorm: NormalizedBBox = [
      (160 / 240) * 1000,
      (50 / 420) * 1000,
      (200 / 240) * 1000,
      (130 / 420) * 1000,
    ];
    const mapped = mapBBoxToOriginal(localNorm, transform);
    expectBoxClose(mapped.bbox, expectedOrigBox);
  });

  it('maps all 4 corners on 45° rotation to recover true Quad and tight AABB', () => {
    const rotatedSize = computeRotatedSize(400, 400, 45);
    const expectedRotSide = 400 * Math.SQRT2;
    expect(rotatedSize.width).toBeCloseTo(expectedRotSide, 6);
    expect(rotatedSize.height).toBeCloseTo(expectedRotSide, 6);

    const pad = 20;
    const resizedSide = rotatedSize.width + pad * 2;
    const transform: CropTransform = {
      originalSize,
      cropRectPx: { x: 200, y: 200, width: 400, height: 400 },
      rotationDegCCW: 45,
      rotatedSize,
      paddingPx: { top: pad, right: pad, bottom: pad, left: pad },
      resizedSize: { width: resizedSide, height: resizedSide },
    };

    const centerPx = resizedSide / 2;
    const localNorm: NormalizedBBox = [
      ((centerPx - 100) / resizedSide) * 1000,
      ((centerPx - 10) / resizedSide) * 1000,
      ((centerPx + 100) / resizedSide) * 1000,
      ((centerPx + 10) / resizedSide) * 1000,
    ];

    const mapped = mapBBoxToOriginal(localNorm, transform);
    const extremaOffset = 110 / Math.SQRT2;
    // 2-corner diagonal mapping would only reach 400 +/- 90/sqrt(2) on x;
    // 4-corner mapping captures BL & TR extrema at 400 +/- 110/sqrt(2).
    expectBoxClose(mapped.bbox, [
      400 - extremaOffset,
      400 - extremaOffset,
      400 + extremaOffset,
      400 + extremaOffset,
    ]);
    // True rotated quad preserves the 200 x 20 strip area = 4000 (not AABB area 24200).
    expect(computePolygonArea(mapped.quad)).toBeCloseTo(4000, 3);
  });
});

describe('visual-grounding: IoU, polygon area, NMS, and grid tiling', () => {
  it('computes IoU and containment-tolerant IoUMin', () => {
    expect(computeIoU([100, 100, 300, 300], [100, 100, 300, 300])).toBeCloseTo(1, 6);
    expect(computeIoU([0, 0, 100, 100], [200, 200, 300, 300])).toBe(0);
    expect(computeIoUMin([0, 0, 100, 100], [200, 200, 300, 300])).toBe(0);

    expect(computeIoU([0, 0, 100, 100], [50, 0, 150, 100])).toBeCloseTo(1 / 3, 6);
    expect(computeIoUMin([0, 0, 100, 100], [50, 0, 150, 100])).toBeCloseTo(0.5, 6);

    // Nested small box inside large region: IoU is tiny (0.0625), IoUMin is 1.0.
    expect(computeIoU([100, 100, 500, 500], [200, 200, 300, 300])).toBeCloseTo(0.0625, 6);
    expect(computeIoUMin([100, 100, 500, 500], [200, 200, 300, 300])).toBeCloseTo(1, 6);
  });

  it('computes polygon shoelace area and enclosing bbox', () => {
    const tri = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 50 },
    ];
    expect(computePolygonArea(tri)).toBeCloseTo(2500, 6);
    expect(computePolygonArea([{ x: 0, y: 0 }, { x: 10, y: 10 }])).toBe(0);

    const quad = bboxToQuad([100, 200, 400, 500]);
    expect(computePolygonArea(quad)).toBeCloseTo(90000, 6);
    expect(polygonToBBox(quad)).toEqual([100, 200, 400, 500]);
  });

  it('deduplicates overlapping regions via NMS while preserving distinct pages', () => {
    const regions: GroundedRegion[] = [
      { bbox: [100, 100, 300, 200], confidence: 0.7, content: 'low', pageIndex: 1 },
      { bbox: [105, 102, 298, 198], confidence: 0.95, content: 'high', pageIndex: 1 },
      { bbox: [105, 102, 298, 198], confidence: 0.85, content: 'page2', pageIndex: 2 },
      { bbox: [500, 500, 700, 600], confidence: 0.6, content: 'separate', pageIndex: 1 },
    ];

    const deduped = mergeOrDeduplicateRegions(regions, 0.5);
    expect(deduped).toHaveLength(3);
    expect(deduped.map(r => r.content)).toEqual(['high', 'page2', 'separate']);

    const merged = mergeOrDeduplicateRegions(
      [
        { bbox: [100, 100, 300, 200], confidence: 0.9, content: 'a', pageIndex: 1 },
        { bbox: [120, 105, 320, 205], confidence: 0.8, content: 'b', pageIndex: 1 },
      ],
      { iouThreshold: 0.5, mode: 'merge' },
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.bbox).toEqual([100, 100, 320, 205]);
    expect(merged[0]?.content).toBe('a');
  });

  it('plans 2x2 overlapping tiles with overlapRatio and minOverlapPx floor', () => {
    const tiles = planGridTiles({ width: 1000, height: 1000 }, 2, 2, 0.08, 16);
    expect(tiles).toEqual([
      [0, 0, 540, 540],
      [460, 0, 1000, 540],
      [0, 460, 540, 1000],
      [460, 460, 1000, 1000],
    ]);

    const smallTiles = planGridTiles({ width: 100, height: 100 }, 2, 2, 0.08, 16);
    expect(smallTiles).toEqual([
      [0, 0, 580, 580],
      [420, 0, 1000, 580],
      [0, 420, 580, 1000],
      [420, 420, 1000, 1000],
    ]);
  });
});
