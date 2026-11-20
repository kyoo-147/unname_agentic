import { describe, expect, it } from 'vitest';
import {
  MAX_SPACING_VARIATION,
  MIN_GRID_RULES,
  MIN_RULE_THICKNESS,
  RULE_INK_THRESHOLD,
  TableGridError,
  buildGrid,
  findRules,
  reduceProfile,
  type InkProfile,
  type RuleAxis,
  type RuleBand,
} from '../src/core/table-grid';

/** A blank ink mask: every pixel is paper. */
function blankMask(width: number, height: number): number[] {
  return new Array<number>(width * height).fill(0);
}

/** Paints a solid ink rectangle into a mask. */
function inkRect(mask: number[], width: number, x: number, y: number, w: number, h: number): void {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) mask[row * width + col] = 1;
  }
}

type RuleRange = readonly [number, number];

function ranges(...pairs: RuleRange[]): RuleRange[] {
  return pairs;
}

/**
 * A ruled table: horizontal rules cross the full width and vertical rules the full height,
 * which is what a real ruled table looks like and what makes both profiles measurable.
 */
function tableMask(
  width: number,
  height: number,
  rowRules: readonly RuleRange[],
  columnRules: readonly RuleRange[],
): number[] {
  const mask = blankMask(width, height);
  for (const [start, end] of rowRules) inkRect(mask, width, 0, start, width, end - start + 1);
  for (const [start, end] of columnRules) inkRect(mask, width, start, 0, end - start + 1, height);
  return mask;
}

/** A profile built by hand, for the geometry tests that need no mask. */
function profileOf(rows: readonly number[], columns: readonly number[] = []): InkProfile {
  return { width: columns.length, height: rows.length, rows: [...rows], columns: [...columns], inkRatio: 0 };
}

function band(start: number, end: number): RuleBand {
  return { start, end, thickness: end - start + 1, peak: 1, center: (start + end) / 2 };
}

/** The error code a refused call raised, so the failure mode is asserted, not just the throw. */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof TableGridError) return error.code;
    throw error;
  }
  throw new Error('expected a TableGridError');
}

const SIZE = 44;

/** Rules of a uniform 3x3 grid: four of them on each axis, two pixels thick. */
const UNIFORM_RULES: RuleRange[] = [[0, 1], [14, 15], [28, 29], [42, 43]];

function uniformProfile(): InkProfile {
  return reduceProfile(tableMask(SIZE, SIZE, UNIFORM_RULES, UNIFORM_RULES), SIZE, SIZE);
}

function uniformRules(): { rowRules: RuleBand[]; columnRules: RuleBand[] } {
  const profile = uniformProfile();
  return { rowRules: findRules(profile), columnRules: findRules(profile, { axis: 'columns' }) };
}

describe('reduceProfile', () => {
  it('measures ink shares that are normalised per axis', () => {
    const profile = uniformProfile();

    expect(profile.width).toBe(SIZE);
    expect(profile.height).toBe(SIZE);
    expect(profile.rows).toHaveLength(SIZE);
    expect(profile.columns).toHaveLength(SIZE);

    // A rule row is solid ink; a gap row carries only the eight pixels of the vertical
    // rules, so it reads 8/44 and not 8/306 or half the page.
    expect(profile.rows[0]).toBe(1);
    expect(profile.rows[7]).toBeCloseTo(8 / SIZE, 10);
    expect(profile.columns[7]).toBeCloseTo(8 / SIZE, 10);
    expect(profile.inkRatio).toBeGreaterThan(0);
    expect(profile.inkRatio).toBeLessThan(1);
  });
});

describe('findRules', () => {
  it('finds the four rules of a uniform grid on both axes', () => {
    const profile = uniformProfile();

    expect(findRules(profile)).toEqual([
      { start: 0, end: 1, thickness: 2, peak: 1, center: 0.5 },
      { start: 14, end: 15, thickness: 2, peak: 1, center: 14.5 },
      { start: 28, end: 29, thickness: 2, peak: 1, center: 28.5 },
      { start: 42, end: 43, thickness: 2, peak: 1, center: 42.5 },
    ]);
    // The horizontal rules cross 8 of 44 column pixels, so they are not column rules.
    expect(findRules(profile, { axis: 'columns' })).toHaveLength(4);
  });

  it('rejects a single-index speck', () => {
    const profile = profileOf([0, 0, 0.9, 0, 0, 0, 0, 0]);
    expect(findRules(profile)).toEqual([]);

    // The thickness floor is the reason, so lowering it finds the same speck.
    expect(findRules(profile, { minThickness: 1 })).toHaveLength(1);
    expect(MIN_RULE_THICKNESS).toBe(2);
  });

  it('needs an index strictly above the threshold', () => {
    const profile = profileOf([RULE_INK_THRESHOLD, RULE_INK_THRESHOLD, RULE_INK_THRESHOLD]);
    expect(findRules(profile)).toEqual([]);
  });

  it('merges two runs when the ink between them is faint rather than absent', () => {
    // A rule the scan broke: both fragments are solid, and the index between them still
    // carries most of the ink, so it is one rule with a pale middle.
    const rule = findRules(profileOf([0, 0, 0.9, 0.9, 0.35, 0.9, 0.9, 0, 0]));
    expect(rule).toHaveLength(1);
    expect(rule[0]).toMatchObject({ start: 2, end: 6, thickness: 5, peak: 0.9 });
  });

  it('keeps two rules apart when the index between them is empty', () => {
    // The white space of a one-pixel-wide column: empty ink is a real gap, not a break.
    const profile = profileOf([0.9, 0.9, 0, 0.9, 0.9]);
    expect(findRules(profile).map(rule => [rule.start, rule.end])).toEqual([[0, 1], [3, 4]]);
  });

  it('keeps two rules apart when the gap is wider than the merge gap', () => {
    const profile = profileOf([0.9, 0.9, 0.4, 0.4, 0.9, 0.9]);
    expect(findRules(profile)).toHaveLength(2);
  });

  it('lowers the threshold for a table that does not fill the measured band', () => {
    const width = 40;
    const mask = blankMask(width, 20);
    // The rules span half the measured width, so a rule row reads exactly 0.5: a fraction
    // of the band, not a majority, which the default threshold deliberately refuses.
    for (const start of [2, 10, 18]) inkRect(mask, width, 0, start, 20, 2);

    const profile = reduceProfile(mask, width, 20);
    expect(findRules(profile)).toEqual([]);
    expect(findRules(profile, { threshold: 0.4 }).map(rule => rule.start)).toEqual([2, 10, 18]);
  });
});

describe('buildGrid', () => {
  it('builds nine cells from the four rules of a uniform 3x3 grid', () => {
    const { rowRules, columnRules } = uniformRules();
    const grid = buildGrid(rowRules, columnRules);

    expect(grid.rows).toBe(3);
    expect(grid.columns).toBe(3);
    expect(grid.cells).toHaveLength(9);
    expect(grid.cells[0]).toEqual({ row: 0, col: 0, x: 2, y: 2, width: 12, height: 12 });
    expect(grid.cells[8]).toEqual({ row: 2, col: 2, x: 30, y: 30, width: 12, height: 12 });
    expect(grid.confidence).toBe(1);
    expect(grid.reasons).toEqual([]);
  });

  it('reports a non-uniform grid with lower confidence and the measured variation', () => {
    const rowRules = ranges([0, 1], [8, 9], [30, 31], [42, 43]);
    const profile = reduceProfile(tableMask(SIZE, SIZE, rowRules, UNIFORM_RULES), SIZE, SIZE);
    const grid = buildGrid(findRules(profile), findRules(profile, { axis: 'columns' }));

    // Rule starts 0, 8, 30, 42: pitches 8, 22 and 12 against a mean of 14.
    expect(grid.cells.filter(cell => cell.col === 0).map(cell => cell.height)).toEqual([6, 20, 10]);
    expect(grid.confidence).toBeLessThan(1);
    expect(grid.confidence).toBe(0.58);
    expect(grid.reasons).toHaveLength(1);

    const reason = grid.reasons[0];
    expect(reason?.code).toBe('non-uniform-spacing');
    expect(reason?.variation).toBeGreaterThan(0.4);
    expect(reason?.variation).toBeLessThan(0.45);
    expect(reason?.message).toContain('not evenly spaced');
    expect(reason?.message).toContain('run from 8 to 22 px around a mean of 14 px');
    expect(reason?.message).toContain('variation 42.1%');
    expect(MAX_SPACING_VARIATION).toBeLessThan(reason?.variation ?? 0);
  });

  it('refuses fewer than two rules on an axis', () => {
    const { rowRules, columnRules } = uniformRules();

    const oneRowRule = buildGrid(rowRules.slice(0, 1), columnRules);
    expect(oneRowRule).toMatchObject({ rows: 0, columns: 0, cells: [], confidence: 0 });
    expect(oneRowRule.reasons).toHaveLength(1);
    expect(oneRowRule.reasons[0]?.code).toBe('too-few-rules');
    expect(oneRowRule.reasons[0]?.message).toContain('row');

    const nothing = buildGrid([], []);
    expect(nothing.cells).toEqual([]);
    expect(nothing.confidence).toBe(0);
    expect(nothing.reasons.map(reason => reason.code)).toEqual(['too-few-rules', 'too-few-rules']);
    expect(nothing.reasons[0]?.message).toContain('row');
    expect(nothing.reasons[1]?.message).toContain('column');
    expect(MIN_GRID_RULES).toBe(2);
  });

  it('refuses the empty profile a blank mask measures', () => {
    const profile = reduceProfile(blankMask(20, 12), 20, 12);
    expect(profile.rows).toEqual(new Array<number>(12).fill(0));
    expect(profile.columns).toEqual(new Array<number>(20).fill(0));
    expect(profile.inkRatio).toBe(0);
    expect(findRules(profile)).toEqual([]);
    expect(findRules(profile, { axis: 'columns' })).toEqual([]);

    const grid = buildGrid(findRules(profile), findRules(profile, { axis: 'columns' }));
    expect(grid).toMatchObject({ rows: 0, columns: 0, cells: [], confidence: 0 });
    expect(grid.reasons.map(reason => reason.code)).toEqual(['too-few-rules', 'too-few-rules']);
  });

  it('finds the column rules of a table with one narrow column', () => {
    const width = 40;
    const height = 40;
    const mask = tableMask(
      width,
      height,
      ranges([0, 1], [19, 20], [38, 39]),
      ranges([5, 6], [15, 16], [18, 19], [30, 31]),
    );
    const profile = reduceProfile(mask, width, height);

    // The column interior at index 17 is one pixel wide and empty, so the rules on either
    // side stay separate instead of merging into one thick rule.
    const columnRules = findRules(profile, { axis: 'columns' });
    expect(columnRules.map(rule => [rule.start, rule.end])).toEqual([[5, 6], [15, 16], [18, 19], [30, 31]]);

    const grid = buildGrid(findRules(profile), columnRules);
    expect(grid.columns).toBe(3);
    expect(grid.cells.filter(cell => cell.row === 0).map(cell => cell.width)).toEqual([8, 1, 10]);
    expect(grid.cells.filter(cell => cell.col === 1).map(cell => cell.x)).toEqual([17, 17]);
    // The narrow column makes the pitch uneven, and that is reported rather than hidden.
    expect(grid.reasons.some(reason => reason.code === 'non-uniform-spacing')).toBe(true);
  });

  it('measures a region and puts its cells back with the origin', () => {
    const mask = tableMask(20, 10, ranges([2, 3], [6, 7]), ranges([5, 6], [13, 14]));
    const profile = reduceProfile(mask, 20, 10, { region: { x: 5, y: 0, width: 10, height: 10 } });

    expect(profile.width).toBe(10);
    expect(profile.height).toBe(10);
    expect(profile.rows[0]).toBe(0.4);
    expect(profile.rows[2]).toBe(1);

    const grid = buildGrid(findRules(profile), findRules(profile, { axis: 'columns' }), { originX: 5 });
    expect(grid.rows).toBe(1);
    expect(grid.columns).toBe(1);
    expect(grid.cells[0]).toEqual({ row: 0, col: 0, x: 7, y: 4, width: 6, height: 2 });
  });

  it('reports rules that touch as a band with no interior', () => {
    const grid = buildGrid([band(0, 1), band(2, 3)], [band(0, 1), band(4, 5)]);

    expect(grid.rows).toBe(1);
    expect(grid.cells).toHaveLength(1);
    expect(grid.cells[0]).toMatchObject({ x: 2, y: 2, width: 2, height: 0 });
    expect(grid.reasons.map(reason => reason.code)).toEqual(['touching-rules']);
    expect(grid.reasons[0]?.message).toContain('Row band 0');
  });

  it('is deterministic and leaves its inputs untouched', () => {
    const profile = uniformProfile();
    const snapshot = JSON.stringify(profile);
    const rowRules = findRules(profile);
    const columnRules = findRules(profile, { axis: 'columns' });

    expect(JSON.stringify(profile)).toBe(snapshot);

    const first = buildGrid(rowRules, columnRules);
    const second = buildGrid(findRules(profile), findRules(profile, { axis: 'columns' }));
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.cells).toHaveLength(first.rows * first.columns);
  });
});

describe('reduceProfile options and refusals', () => {
  it('counts a pixel as ink only above the ink threshold', () => {
    const width = 4;
    const mask = blankMask(width, 4);
    for (let x = 0; x < width; x++) mask[width + x] = 128;

    const grey = reduceProfile(mask, width, 4);
    expect(grey.rows[1]).toBe(1);
    expect(grey.inkRatio).toBe(0.25);

    const blackOnly = reduceProfile(mask, width, 4, { inkThreshold: 200 });
    expect(blackOnly.rows).toEqual([0, 0, 0, 0]);
    expect(blackOnly.inkRatio).toBe(0);
  });

  it('refuses arguments it cannot measure from', () => {
    expect(codeOf(() => reduceProfile([], 0, 0))).toBe('empty-mask');
    expect(codeOf(() => reduceProfile([1, 0], 2, 2))).toBe('short-buffer');
    expect(codeOf(() => reduceProfile(blankMask(4, 4), 4, 4, { region: { x: 3, y: 0, width: 2, height: 2 } })))
      .toBe('invalid-region');
    expect(codeOf(() => reduceProfile(blankMask(4, 4), 4, 4, { inkThreshold: -1 }))).toBe('invalid-options');
    expect(codeOf(() => findRules(uniformProfile(), { axis: 'diagonals' as RuleAxis }))).toBe('invalid-options');
    expect(codeOf(() => findRules(uniformProfile(), { threshold: 0 }))).toBe('invalid-options');
    expect(codeOf(() => findRules(profileOf([1.5, 1.5])))).toBe('invalid-profile');
    expect(codeOf(() => buildGrid([band(2, 1)], [band(0, 1)]))).toBe('invalid-rules');
    expect(codeOf(() => buildGrid([band(0, 1), band(1, 2)], [band(0, 1)]))).toBe('invalid-rules');
    expect(codeOf(() => buildGrid([band(0, 1)], [band(0, 1)], { originX: Number.NaN }))).toBe('invalid-options');
  });
});
