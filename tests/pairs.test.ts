import { describe, expect, it } from 'vitest';
import {
  PAIR_MODES,
  PairPlanError,
  estimateLines,
  furnitureFor,
  interleaveFit,
  isPairMode,
  pageLabels,
  planPairs,
  type OutlinedPage,
  type PairBlock,
  type PairMode,
  type PairPage,
  type PlannedPageKind,
} from '../src/export/pairs';

const LETTER = { width: 612, height: 792 };
const SMALL = { width: 200, height: 200 };

const block = (source: string, target: string): PairBlock => ({ source, target });
const page = (pageNumber: number, blocks: PairBlock[], size = LETTER): PairPage => ({
  pageNumber,
  width: size.width,
  height: size.height,
  blocks,
});

const kinds = (plan: readonly OutlinedPage[]): PlannedPageKind[] => plan.map(entry => entry.kind);
const footers = (plan: readonly OutlinedPage[]): string[] => plan.map(entry => entry.furniture.footer);

/** Ten six-letter words, 69 half-em units: four lines in a 25-unit column. */
const longTarget = 'target '.repeat(10).trim();

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

describe('planPairs', () => {
  it('alternating emits source then target for every page, doubling the count in source order', () => {
    const plan = planPairs(
      [page(1, [block('một', 'one')]), page(2, [block('hai', 'two')]), page(3, [block('ba', 'three')])],
      'alternating',
    );

    expect(plan).toHaveLength(6);
    expect(kinds(plan)).toEqual(['source', 'target', 'source', 'target', 'source', 'target']);
    expect(plan.map(entry => entry.sourcePage)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(plan.map(entry => entry.index)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(plan.every(entry => entry.fallback === undefined)).toBe(true);
  });

  it('sorts an unsorted page list into page order before planning', () => {
    const plan = planPairs([page(2, [block('hai', 'two')]), page(1, [block('một', 'one')])], 'alternating');
    expect(plan.map(entry => entry.sourcePage)).toEqual([1, 1, 2, 2]);
  });

  it('source-only passes one page per source page through', () => {
    const plan = planPairs([page(1, [block('một', 'one')]), page(2, [block('hai', 'two')])], 'source');

    expect(plan).toHaveLength(2);
    expect(kinds(plan)).toEqual(['source', 'source']);
    expect(plan.map(entry => entry.sourcePage)).toEqual([1, 2]);
    expect(plan.map(entry => entry.index)).toEqual([1, 2]);
    expect(plan[0]?.furniture.header).toBe('Original · source 1');
    expect(plan.every(entry => entry.furniture.header.includes('Translation'))).toBe(false);
  });

  it('target-only passes one page per source page through and labels the translation', () => {
    const plan = planPairs([page(1, [block('một', 'one')]), page(2, [block('hai', 'two')])], 'target');

    expect(plan).toHaveLength(2);
    expect(kinds(plan)).toEqual(['target', 'target']);
    expect(plan.map(entry => entry.sourcePage)).toEqual([1, 2]);
    expect(plan[0]?.furniture.header).toBe('Translation · source 1');
    expect(plan[1]?.furniture.footer).toBe('Page 2 of 2');
  });

  it('is deterministic and yields the same plan for the same input', () => {
    const pages = [page(1, [block('một', 'one')]), page(2, [block('hai', 'two')])];
    expect(planPairs(pages, 'alternating')).toEqual(planPairs(pages, 'alternating'));
  });

  it('plans nothing for an empty document in every mode', () => {
    for (const mode of PAIR_MODES) {
      expect(planPairs([], mode)).toEqual([]);
    }
  });

  it('still gives a page with zero blocks its page and furniture', () => {
    const plan = planPairs([page(7, [])], 'source');

    expect(plan).toHaveLength(1);
    expect(plan[0]?.furniture.header).toBe('Original · source 7');
    expect(plan[0]?.furniture.footer).toBe('Page 1 of 1');
    expect(plan[0]?.furniture.align).toBe('right');
  });

  it('keeps both panes on one interleaved page when the text fits', () => {
    const plan = planPairs([page(1, [block('Xin chào', 'Hello')])], 'interleaved');

    expect(plan).toHaveLength(1);
    expect(plan[0]?.kind).toBe('interleaved');
    expect(plan[0]?.furniture.header).toBe('Original + translation · source 1');
    // The optional field is absent, not present and undefined, so the plan stays clean JSON.
    expect(Object.keys(plan[0] ?? {})).toEqual(['kind', 'sourcePage', 'index', 'furniture']);
  });

  it('falls back to the alternating pair when the translation does not fit the pane', () => {
    const plan = planPairs([page(1, [block('Xin chào', longTarget)], SMALL)], 'interleaved');

    expect(plan).toHaveLength(2);
    expect(kinds(plan)).toEqual(['source', 'target']);
    expect(plan.map(entry => entry.fallback)).toEqual(['target-overflow', 'target-overflow']);
    expect(plan.map(entry => entry.sourcePage)).toEqual([1, 1]);
  });

  it('reports the source pane overflowing separately from the target pane', () => {
    const plan = planPairs([page(1, [block(longTarget, 'Hi')], SMALL)], 'interleaved');
    expect(plan.map(entry => entry.fallback)).toEqual(['source-overflow', 'source-overflow']);
  });

  it('refuses to interleave a page that has no translation yet', () => {
    const plan = planPairs([page(1, [block('Xin chào', '')])], 'interleaved');
    expect(kinds(plan)).toEqual(['source', 'target']);
    expect(plan[0]?.fallback).toBe('no-target');

    const blank = planPairs([page(1, [])], 'interleaved');
    expect(blank.map(entry => entry.fallback)).toEqual(['no-target', 'no-target']);
    expect(blank.every(entry => entry.furniture.footer.length > 0)).toBe(true);
  });

  it('numbers a mixed plan continuously across interleaved, source and target pages', () => {
    const plan = planPairs(
      [
        page(1, [block('một', 'one')]),
        page(2, [block('hai', longTarget)], SMALL),
        page(3, [block('ba', 'three')]),
      ],
      'interleaved',
    );

    expect(kinds(plan)).toEqual(['interleaved', 'source', 'target', 'interleaved']);
    expect(plan.map(entry => entry.sourcePage)).toEqual([1, 2, 2, 3]);
    expect(plan.map(entry => entry.index)).toEqual([1, 2, 3, 4]);
    expect(plan.map(entry => entry.fallback)).toEqual([undefined, 'target-overflow', 'target-overflow', undefined]);
    expect(footers(plan)).toEqual(['Page 1 of 4', 'Page 2 of 4', 'Page 3 of 4', 'Page 4 of 4']);
  });

  it('refuses an unknown mode with a typed error', () => {
    const error = captureError(() => planPairs([], 'side-by-side' as PairMode));

    expect(error).toBeInstanceOf(PairPlanError);
    expect((error as PairPlanError).code).toBe('unknown-mode');
    expect(isPairMode('side-by-side')).toBe(false);
    expect(PAIR_MODES).toEqual(['source', 'target', 'alternating', 'interleaved']);
  });
});

describe('furnitureFor', () => {
  it('substitutes the folio and puts it on the outer edge of the spread', () => {
    const recto = furnitureFor('source', 2, 6);
    expect(recto).toEqual({ header: 'Original · source 2', footer: 'Page 3 of 6', align: 'right' });

    const verso = furnitureFor('target', 2, 6);
    expect(verso).toEqual({ header: 'Translation · source 2', footer: 'Page 4 of 6', align: 'left' });
  });

  it('uses the interleaved page position as its folio number', () => {
    expect(furnitureFor('interleaved', 3, 5)).toEqual({
      header: 'Original + translation · source 3',
      footer: 'Page 3 of 5',
      align: 'right',
    });
  });

  it('honours an explicit index and never numbers past the total', () => {
    expect(furnitureFor('source', 1, 6, { index: 5 }).footer).toBe('Page 5 of 6');
    expect(furnitureFor('source', 4, 2, { index: 5 }).footer).toBe('Page 5 of 5');
    expect(furnitureFor('source', 1, 0).footer).toBe('Page 1 of 1');
  });

  it('drops the separator an empty piece would leave behind', () => {
    expect(furnitureFor('source', 1, 2).header).toBe('Original · source 1');
    expect(furnitureFor('target', 1, 2, { title: 'Tài liệu' }).header).toBe('Tài liệu · Translation · source 1');
  });

  it('takes localized labels and templates from the caller', () => {
    const furniture = furnitureFor('target', 2, 6, {
      title: 'Tài liệu',
      labels: { target: 'Bản dịch' },
      footerTemplate: 'Trang {page} / {pages}',
    });

    expect(furniture.header).toBe('Tài liệu · Bản dịch · source 2');
    expect(furniture.footer).toBe('Trang 4 / 6');
  });

  it('can center the folio for a single-sided print', () => {
    expect(furnitureFor('source', 1, 2, { align: 'center' }).align).toBe('center');
  });

  it('refuses a kind this planner does not emit', () => {
    const error = captureError(() => furnitureFor('bogus' as PlannedPageKind, 1, 1));

    expect(error).toBeInstanceOf(PairPlanError);
    expect((error as PairPlanError).code).toBe('unknown-kind');
  });
});

describe('pageLabels', () => {
  it('returns one table-of-contents label per planned page, in plan order', () => {
    const plan = planPairs([page(1, [block('một', 'one')])], 'alternating');

    expect(pageLabels(plan)).toEqual(['1. Original · source 1', '2. Translation · source 1']);
  });

  it('matches the plan length for every mode', () => {
    const pages = [page(1, [block('một', 'one')]), page(2, [block('hai', longTarget)], SMALL)];

    for (const mode of PAIR_MODES) {
      const plan = planPairs(pages, mode);
      const labels = pageLabels(plan);
      expect(labels).toHaveLength(plan.length);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it('localizes the labels and accepts a caller template', () => {
    const plan = planPairs([page(1, [block('một', 'one')])], 'alternating');
    const labels = pageLabels(plan, {
      title: 'Tài liệu',
      labels: { source: 'Bản gốc', target: 'Bản dịch' },
      labelTemplate: '{title}: {label} ({index}/{pages})',
    });

    expect(labels).toEqual(['Tài liệu: Bản gốc (1/2)', 'Tài liệu: Bản dịch (2/2)']);
  });

  it('plans no labels for an empty plan', () => {
    expect(pageLabels([])).toEqual([]);
  });
});

describe('interleaveFit', () => {
  it('reports the budgets the documented fit rule uses', () => {
    const fit = interleaveFit(page(1, [block('Xin chào', 'Hello')]));

    expect(fit).toEqual({ fits: true, reason: null, charsPerLine: 108, linesPerPane: 24, sourceLines: 1, targetLines: 1 });
  });

  it('measures a page against its pane budget before refusing to interleave it', () => {
    const fit = interleaveFit(page(1, [block('Xin chào', longTarget)], SMALL));

    expect(fit.fits).toBe(false);
    expect(fit.reason).toBe('target-overflow');
    expect(fit.charsPerLine).toBe(25);
    expect(fit.linesPerPane).toBe(2);
    expect(fit.targetLines).toBeGreaterThan(fit.linesPerPane);
  });

  it('refuses a page with no room and a page with nothing to pair', () => {
    expect(interleaveFit(page(1, [block('abc', 'abc')], { width: 40, height: 40 })).reason).toBe('no-room');
    expect(interleaveFit(page(1, [block('abc', '')])).reason).toBe('no-target');
    expect(interleaveFit(page(1, [])).reason).toBe('no-target');
  });

  it('honours an explicitly requested zero margin instead of falling back to the default', () => {
    const fit = interleaveFit(page(1, [block('Xin chào', 'Hello')]), { margin: 0 });
    expect(fit.charsPerLine).toBe(122);
    expect(fit.linesPerPane).toBe(27);
  });
});

describe('estimateLines', () => {
  it('counts half-em units, so full-width characters cost two', () => {
    expect(estimateLines('a'.repeat(100), 100)).toBe(1);
    expect(estimateLines('中'.repeat(100), 100)).toBe(2);
    expect(estimateLines('a'.repeat(250), 100)).toBe(3);
  });

  it('wraps words and ignores blank paragraphs', () => {
    expect(estimateLines('one two three', 100)).toBe(1);
    expect(estimateLines('a\n\nb', 10)).toBe(2);
    expect(estimateLines('   \n\n', 10)).toBe(0);
    expect(estimateLines('', 10)).toBe(0);
  });

  it('reads a budget below one as one character per line', () => {
    expect(estimateLines('abc', 0)).toBe(3);
  });
});
