import { describe, expect, it } from 'vitest';
import {
  DESKEW_THRESHOLD_DEG,
  DeskewError,
  MAX_DESKEW_ANGLE_DEG,
  decision,
  invertBlocks,
  invertMap,
  mapBlocks,
  mapPoint,
  mapPolygon,
  mapQuad,
  mapRect,
  planDeskew,
  type PolygonBlock,
} from '../src/core/deskew';
import type { Point, Polygon } from '../src/core/ir';
import type { Rect } from '../src/core/types';

/** A square page keeps the documented coordinate arithmetic easy to follow. */
const PAGE = { width: 100, height: 100 };

/** Four corners of a rect in the reader's order: TL, TR, BR, BL. */
function rectCorners(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

/** A ten-point-tall block at `top`, so block order stays obvious in mapped space. */
function block(id: string, top: number): PolygonBlock {
  return {
    id,
    polygon: [
      { x: 12, y: top },
      { x: 88, y: top },
      { x: 88, y: top + 10 },
      { x: 12, y: top + 10 },
    ],
  };
}

/** The error code a refused call raised, so the failure mode is asserted, not just the throw. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof DeskewError) return error.code;
    throw error;
  }
  throw new Error('expected a DeskewError');
}

describe('deskew planning', () => {
  it('maps a known point under a two-degree correction to the documented coordinate', () => {
    const plan = planDeskew(2, PAGE);
    expect(plan.angle).toBe(-2);
    expect(plan.direction).toBe('counter-clockwise');
    expect(plan.scale).toBe(1);
    expect(plan.radians).toBeCloseTo((-2 * Math.PI) / 180, 12);

    // Documented: rotate 2° counter-clockwise about the page centre (50, 50),
    // then shift the rotated page's bounding box to the origin. On a 100x100
    // page the right-edge midpoint lands at (101.6841, 49.9695).
    const mapped = mapPoint({ x: 100, y: 50 }, plan.matrix);
    expect(mapped.x).toBeCloseTo(101.684, 3);
    expect(mapped.y).toBeCloseTo(49.9695, 3);

    // The same point from the documented steps, computed without the planner.
    const radians = (-2 * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const dx = 100 - PAGE.width / 2;
    const dy = 50 - PAGE.height / 2;
    const halfWidth = (PAGE.width * Math.abs(cos) + PAGE.height * Math.abs(sin)) / 2;
    const halfHeight = (PAGE.width * Math.abs(sin) + PAGE.height * Math.abs(cos)) / 2;
    expect(mapped.x).toBeCloseTo(cos * dx - sin * dy + halfWidth, 9);
    expect(mapped.y).toBeCloseTo(sin * dx + cos * dy + halfHeight, 9);
  });

  it('maps a rect and round-trips its corners through the inverse within 0.01', () => {
    const plan = planDeskew(2, PAGE);
    const rect: Rect = { x: 20, y: 30, width: 60, height: 12 };
    const corners = rectCorners(rect);
    const mapped = mapPolygon(corners, plan.matrix);
    const restored = mapPolygon(mapped, invertMap(plan.matrix));

    // The axis-aligned box of a rotated rect is larger, and holds every corner.
    const box = mapRect(rect, plan.matrix);
    expect(box.width).toBeGreaterThan(rect.width);
    expect(box.height).toBeGreaterThan(rect.height);
    mapped.forEach((point, index) => {
      expect(point.x).toBeGreaterThanOrEqual(box.x);
      expect(point.x).toBeLessThanOrEqual(box.x + box.width);
      expect(point.y).toBeGreaterThanOrEqual(box.y);
      expect(point.y).toBeLessThanOrEqual(box.y + box.height);
      expect(restored[index]?.x).toBeCloseTo(corners[index]?.x ?? Number.NaN, 2);
      expect(restored[index]?.y).toBeCloseTo(corners[index]?.y ?? Number.NaN, 2);
    });
  });

  it('keeps the order of a four-point polygon', () => {
    const polygon: Polygon = [
      { x: 10, y: 20 },
      { x: 90, y: 20 },
      { x: 90, y: 32 },
      { x: 10, y: 32 },
    ];
    const plan = planDeskew(2, PAGE);
    const mapped = mapQuad(polygon, plan.matrix);
    expect(mapped).toHaveLength(4);

    mapped.forEach((point, index) => {
      const direct = mapPoint(polygon[index] ?? { x: Number.NaN, y: Number.NaN }, plan.matrix);
      expect(point.x).toBeCloseTo(direct.x, 12);
      expect(point.y).toBeCloseTo(direct.y, 12);
    });

    // Still top-left, top-right, bottom-right, bottom-left: no corner swapped.
    expect(mapped[0]?.x).toBeLessThan(mapped[1]?.x ?? Number.NaN);
    expect(mapped[3]?.x).toBeLessThan(mapped[2]?.x ?? Number.NaN);
    expect(mapped[0]?.y).toBeLessThan(mapped[3]?.y ?? Number.NaN);
    expect(mapped[1]?.y).toBeLessThan(mapped[2]?.y ?? Number.NaN);
  });

  it('keeps the crop box inside the page at zero angle and around the rotated page otherwise', () => {
    const square = planDeskew(0, PAGE);
    expect(square.matrix).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(square.crop).toEqual({ x: 0, y: 0, width: PAGE.width, height: PAGE.height });

    const plan = planDeskew(2, PAGE);
    const rotatedCorners = rectCorners({ x: 0, y: 0, width: PAGE.width, height: PAGE.height })
      .map(point => mapPoint(point, plan.matrix));
    for (const corner of rotatedCorners) {
      expect(corner.x).toBeGreaterThanOrEqual(0);
      expect(corner.y).toBeGreaterThanOrEqual(0);
      expect(corner.x).toBeLessThanOrEqual(plan.crop.width);
      expect(corner.y).toBeLessThanOrEqual(plan.crop.height);
    }
    expect(plan.crop.width).toBeGreaterThanOrEqual(PAGE.width);
    expect(plan.crop.height).toBeGreaterThanOrEqual(PAGE.height);
    // ceil(100 * (cos 2° + sin 2°)) = ceil(103.4290)
    expect(plan.crop.width).toBe(104);
  });

  it('bakes the render scale into the matrix and the crop', () => {
    const identity = planDeskew(0, PAGE, { scale: 2 });
    expect(identity.scale).toBe(2);
    expect(identity.crop).toEqual({ x: 0, y: 0, width: 200, height: 200 });
    expect(mapPoint({ x: 10, y: 20 }, identity.matrix)).toEqual({ x: 20, y: 40 });

    const scaled = planDeskew(2, PAGE, { scale: 2 });
    const point = mapPoint({ x: 100, y: 50 }, scaled.matrix);
    expect(point.x).toBeCloseTo(2 * 101.684, 2);
    expect(point.y).toBeCloseTo(2 * 49.9695, 2);

    const back = mapPoint(point, invertMap(scaled.matrix));
    expect(back.x).toBeCloseTo(100, 9);
    expect(back.y).toBeCloseTo(50, 9);
  });

  it('is deterministic', () => {
    expect(planDeskew(2.345, PAGE)).toEqual(planDeskew(2.345, PAGE));
    expect(decision(1.234)).toEqual(decision(1.234));
    const blocks = [block('p1-r0', 20)];
    const matrix = planDeskew(2, PAGE).matrix;
    expect(mapBlocks(blocks, matrix)).toEqual(mapBlocks(blocks, planDeskew(2, PAGE).matrix));
  });
});

describe('deskew decisions', () => {
  it('leaves a 0.3-degree tilt alone', () => {
    const decided = decision(0.3);
    expect(decided.deskew).toBe(false);
    expect(decided.reason).toMatch(/below the 0\.5° threshold/);
  });

  it('deskews at the threshold and names the correction', () => {
    expect(decision(DESKEW_THRESHOLD_DEG).deskew).toBe(true);
    expect(decision(-DESKEW_THRESHOLD_DEG).deskew).toBe(true);

    const decided = decision(2);
    expect(decided.deskew).toBe(true);
    expect(decided.reason).toMatch(/2° clockwise/);
    expect(decided.reason).toMatch(/2° counter-clockwise/);
  });

  it('refuses a 91-degree tilt with a reason', () => {
    const decided = decision(91);
    expect(decided.deskew).toBe(false);
    expect(decided.reason).toMatch(/past the 15° maximum/);
    expect(decided.reason).toMatch(/re-scan|page rotation/);
  });

  it('describes a 90-degree page as a rotation', () => {
    const quarter = decision(90);
    expect(quarter.deskew).toBe(false);
    expect(quarter.reason).toMatch(/quarter turn/);
    expect(quarter.reason).toMatch(/page rotation/);

    const other = decision(-90);
    expect(other.deskew).toBe(false);
    expect(other.reason).toMatch(/page rotation/);
  });

  it('honours caller thresholds', () => {
    const beyond = decision(3, { maxAngleDeg: 2 });
    expect(beyond.deskew).toBe(false);
    expect(beyond.reason).toMatch(/past the 2° maximum/);

    const below = decision(1.5, { thresholdDeg: 2 });
    expect(below.deskew).toBe(false);
    expect(below.reason).toMatch(/below the 2° threshold/);

    expect(decision(1.5, { thresholdDeg: 1 }).deskew).toBe(true);
  });

  it('reports a square page as nothing to do', () => {
    const decided = decision(0, { thresholdDeg: 0 });
    expect(decided.deskew).toBe(false);
    expect(decided.reason).toMatch(/0° of skew/);
  });
});

describe('deskew block mapping', () => {
  it('keeps ids and order when mapping blocks and brings them back', () => {
    const blocks = [block('p1-r0', 20), block('p1-r1', 40), block('p1-r2', 60)];
    const plan = planDeskew(2, PAGE);
    const mapped = mapBlocks(blocks, plan.matrix);

    expect(mapped.map(entry => entry.id)).toEqual(['p1-r0', 'p1-r1', 'p1-r2']);
    expect(mapped[0]?.polygon[0]?.y).toBeLessThan(mapped[1]?.polygon[0]?.y ?? Number.NaN);
    expect(mapped[1]?.polygon[0]?.y).toBeLessThan(mapped[2]?.polygon[0]?.y ?? Number.NaN);
    expect(mapped[0]?.polygon[0]).not.toEqual(blocks[0]?.polygon[0]);

    const restored = invertBlocks(mapped, plan.matrix);
    expect(restored.map(entry => entry.id)).toEqual(['p1-r0', 'p1-r1', 'p1-r2']);
    restored.forEach((entry, index) => {
      entry.polygon.forEach((point, corner) => {
        expect(point.x).toBeCloseTo(blocks[index]?.polygon[corner]?.x ?? Number.NaN, 2);
        expect(point.y).toBeCloseTo(blocks[index]?.polygon[corner]?.y ?? Number.NaN, 2);
      });
    });

    // Mapping copies: the caller's blocks are untouched.
    expect(blocks[0]?.polygon[0]).toEqual({ x: 12, y: 20 });
  });
});

describe('deskew refusals', () => {
  it('refuses angles that are not finite or are a quarter turn', () => {
    expect(codeOf(() => planDeskew(Number.NaN, PAGE))).toBe('invalid-angle');
    expect(codeOf(() => planDeskew(-90, PAGE))).toBe('invalid-angle');
    expect(codeOf(() => planDeskew(2, { width: 0, height: 100 }))).toBe('invalid-page');
    expect(codeOf(() => planDeskew(2, PAGE, { scale: 0 }))).toBe('invalid-scale');
  });

  it('refuses decision options that cannot be honoured', () => {
    expect(codeOf(() => decision(Number.POSITIVE_INFINITY))).toBe('invalid-angle');
    expect(codeOf(() => decision(2, { thresholdDeg: -1 }))).toBe('invalid-option');
    expect(codeOf(() => decision(2, { maxAngleDeg: 120 }))).toBe('invalid-option');
    expect(codeOf(() => decision(2, { thresholdDeg: 5, maxAngleDeg: 1 }))).toBe('invalid-option');
  });

  it('refuses a matrix with no inverse', () => {
    expect(codeOf(() => invertMap({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }))).toBe('non-invertible');
    expect(codeOf(() => mapPoint({ x: 1, y: 1 }, { a: Number.NaN, b: 0, c: 0, d: 1, e: 0, f: 0 }))).toBe('invalid-matrix');
    expect(codeOf(() => mapRect({ x: Number.NaN, y: 0, width: 1, height: 1 }, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }))).toBe('invalid-rect');
  });

  it('keeps the documented limits exported', () => {
    expect(DESKEW_THRESHOLD_DEG).toBe(0.5);
    expect(MAX_DESKEW_ANGLE_DEG).toBe(15);
  });
});
