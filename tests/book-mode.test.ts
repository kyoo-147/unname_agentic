import { describe, expect, it } from 'vitest';
import {
  BookModeError,
  isSpreadOrder,
  planBook,
  spreadFor,
  visibilityFor,
} from '../src/core/book-mode';
import type {
  BookPageInput,
  BookPlan,
  BookSpread,
  SpreadKind,
  SpreadOrder,
} from '../src/core/book-mode';

/** Page boxes that are cheap to read in a failure message: a small portrait page. */
const PAGE_WIDTH = 400;
const PAGE_HEIGHT = 600;

function bookPages(count: number): BookPageInput[] {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
  }));
}

/** `[left number | null, right number | null, kind]` per spread, the fastest thing to read. */
function shape(plan: BookPlan): [number | null, number | null, SpreadKind][] {
  return plan.spreads.map((spread): [number | null, number | null, SpreadKind] => [
    spread.left?.number ?? null,
    spread.right?.number ?? null,
    spread.kind,
  ]);
}

function spreadAt(plan: BookPlan, index: number): BookSpread {
  const spread = plan.spreads[index];
  if (spread === undefined) throw new Error(`plan has no spread ${index}`);
  return spread;
}

/** Numbers of the panes a visibility lets through, left to right. */
function paneNumbers(spread: BookSpread, currentPage: number): number[] {
  return visibilityFor(spread, currentPage).panes.map(pane => pane.page.number);
}

describe('planBook: the cover', () => {
  it('puts the cover alone on the right', () => {
    const plan = planBook(bookPages(5), { firstPageIsCover: true });

    expect(shape(plan)).toEqual([
      [null, 1, 'cover'],
      [2, 3, 'spread'],
      [4, 5, 'spread'],
    ]);
    // The cover is a leaf of its own: its empty left side is not an inserted page.
    expect(plan.blanks).toEqual([]);
  });

  it('carries the page boxes through to the plan', () => {
    const plan = planBook(bookPages(2), { firstPageIsCover: true });

    expect(spreadAt(plan, 0).right).toEqual({ number: 1, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  });

  it('prints no folio on the cover and a centred folio on a lone page', () => {
    const plan = planBook(bookPages(3), { firstPageIsCover: true });

    expect(spreadAt(plan, 0).folios).toEqual([
      { page: 1, number: null, placement: 'center', side: 'right' },
    ]);
    expect(spreadAt(plan, 1).folios).toEqual([
      { page: 2, number: 2, placement: 'outer', side: 'left' },
      { page: 3, number: 3, placement: 'outer', side: 'right' },
    ]);
  });

  it('stands the page after a left-side cover alone until the parity meets it', () => {
    const plan = planBook(bookPages(3), { firstPageIsCover: true, startOnRight: false });

    // A mirrored binding: the cover is a verso, so page 2 has no left page to face either.
    expect(shape(plan)).toEqual([
      [1, null, 'cover'],
      [null, 2, 'single'],
      [3, null, 'single'],
    ]);
    expect(plan.blanks).toEqual([
      { side: 'left', spread: 1 },
      { side: 'right', spread: 2 },
    ]);
  });

  it('leaves no parity blank behind a cover with an odd last page', () => {
    const plan = planBook(bookPages(3), { firstPageIsCover: true });

    expect(shape(plan)).toEqual([
      [null, 1, 'cover'],
      [2, 3, 'spread'],
    ]);
    expect(plan.blanks).toEqual([]);
  });
});

describe('planBook: parity blanks', () => {
  it('inserts one blank at the front of a three-page book', () => {
    const plan = planBook(bookPages(3));

    // Page 1 must be a recto, so the left slot of the first spread has to be empty.
    expect(shape(plan)).toEqual([
      [null, 1, 'single'],
      [2, 3, 'spread'],
    ]);
    expect(plan.blanks).toEqual([{ side: 'left', spread: 0 }]);
  });

  it('leaves a trailing blank when the last page is a verso', () => {
    const plan = planBook(bookPages(3), { startOnRight: false });

    expect(shape(plan)).toEqual([
      [1, 2, 'spread'],
      [3, null, 'single'],
    ]);
    expect(plan.blanks).toEqual([{ side: 'right', spread: 1 }]);
  });

  it('records both blanks of a two-page book that starts on the right', () => {
    const plan = planBook(bookPages(2));

    expect(shape(plan)).toEqual([
      [null, 1, 'single'],
      [2, null, 'single'],
    ]);
    expect(plan.blanks).toEqual([
      { side: 'left', spread: 0 },
      { side: 'right', spread: 1 },
    ]);
  });

  it('adds no parity blank behind a cover with an even last page', () => {
    const plan = planBook(bookPages(4), { firstPageIsCover: true });

    expect(shape(plan)).toEqual([
      [null, 1, 'cover'],
      [2, 3, 'spread'],
      [4, null, 'single'],
    ]);
    expect(plan.blanks).toEqual([{ side: 'right', spread: 2 }]);
  });
});

describe('planBook: folio parity', () => {
  it('keeps every page number and puts the folio on the outer edge of a spread', () => {
    const plan = planBook(bookPages(6), { firstPageIsCover: true });

    for (const spread of plan.spreads) {
      for (const folio of spread.folios) {
        expect(folio.page).toBe(folio.number === null ? 1 : folio.number);
        expect(folio.placement).toBe(spread.kind === 'spread' ? 'outer' : 'center');
      }
    }
    // Odd pages are recto, even pages verso: the side and the number agree everywhere.
    for (const spread of plan.spreads) {
      const left = spread.folios.find(folio => folio.side === 'left');
      const right = spread.folios.find(folio => folio.side === 'right');
      if (left?.number != null) expect(left.number % 2).toBe(0);
      if (right?.number != null) expect(right.number % 2).toBe(1);
    }
  });

  it('flips the folio parity when the binding starts on the left', () => {
    const plan = planBook(bookPages(4), { startOnRight: false });

    const byNumber = new Map<number, string>();
    for (const spread of plan.spreads) {
      for (const folio of spread.folios) {
        if (folio.number !== null) byNumber.set(folio.number, folio.side);
      }
    }
    expect([...byNumber.entries()]).toEqual([
      [1, 'left'],
      [2, 'right'],
      [3, 'left'],
      [4, 'right'],
    ]);
  });
});

describe('spreadFor', () => {
  it('maps a page to the spread and the side it sits on', () => {
    const plan = planBook(bookPages(5), { firstPageIsCover: true });

    expect(spreadFor(plan, 1)).toMatchObject({ index: 0, side: 'right' });
    expect(spreadFor(plan, 2)).toMatchObject({ index: 1, side: 'left' });
    expect(spreadFor(plan, 3)).toMatchObject({ index: 1, side: 'right' });
    expect(spreadFor(plan, 4)).toMatchObject({ index: 2, side: 'left' });
    expect(spreadFor(plan, 5)).toMatchObject({ index: 2, side: 'right' });
    expect(spreadFor(plan, 2)?.spread).toBe(spreadAt(plan, 1));
  });

  it('returns null for a page the plan never placed', () => {
    const plan = planBook(bookPages(3));

    expect(spreadFor(plan, 6)).toBeNull();
    expect(spreadFor(plan, 0)).toBeNull();
    expect(spreadFor(plan, 1.5)).toBeNull();
    expect(spreadFor(plan, Number.NaN)).toBeNull();
  });

  it('follows the plan when the spreads are listed backwards', () => {
    const plan = planBook(bookPages(5), { firstPageIsCover: true, spreadOrder: 'reverse' });

    expect(spreadFor(plan, 1)).toMatchObject({ index: 2, side: 'right' });
    expect(spreadFor(plan, 4)).toMatchObject({ index: 0, side: 'left' });
    expect(spreadFor(plan, 5)).toMatchObject({ index: 0, side: 'right' });
  });

  it('locates a page on either side of a spread', () => {
    const plan = planBook(bookPages(2), { startOnRight: false });

    expect(spreadFor(plan, 1)?.side).toBe('left');
    expect(spreadFor(plan, 2)?.side).toBe('right');
  });
});

describe('visibilityFor', () => {
  it('shows exactly two panes for a spread', () => {
    const plan = planBook(bookPages(5), { firstPageIsCover: true });
    const spread = spreadAt(plan, 1);
    const visibility = visibilityFor(spread, 2);

    expect(visibility.panes).toHaveLength(2);
    expect(paneNumbers(spread, 2)).toEqual([2, 3]);
    expect(visibility.current?.page.number).toBe(2);
    expect(visibility.current?.side).toBe('left');
    expect(visibility.current?.current).toBe(true);
    expect(visibility.facing?.page.number).toBe(3);
    expect(visibility.facing?.side).toBe('right');
    expect(visibility.facing?.facing).toBe(true);
  });

  it('shows the same pair when the reader is on the right page', () => {
    const plan = planBook(bookPages(5), { firstPageIsCover: true });
    const spread = spreadAt(plan, 1);
    const visibility = visibilityFor(spread, 3);

    expect(visibility.current?.side).toBe('right');
    expect(visibility.facing?.page.number).toBe(2);
    expect(visibility.facing?.side).toBe('left');
  });

  it('shows one pane for a cover', () => {
    const plan = planBook(bookPages(3), { firstPageIsCover: true });
    const visibility = visibilityFor(spreadAt(plan, 0), 1);

    expect(visibility.panes).toHaveLength(1);
    expect(visibility.current?.page.number).toBe(1);
    expect(visibility.facing).toBeNull();
  });

  it('shows one pane for a page with a blank slot beside it', () => {
    const plan = planBook(bookPages(3));
    const spread = spreadAt(plan, 0);
    const visibility = visibilityFor(spread, 1);

    expect(visibility.panes).toHaveLength(1);
    expect(visibility.current?.side).toBe('right');
    expect(visibility.facing).toBeNull();
  });

  it('reports a stale page without inventing a companion for it', () => {
    const plan = planBook(bookPages(5), { firstPageIsCover: true });
    const spread = spreadAt(plan, 1);

    const visibility = visibilityFor(spread, 9);
    expect(visibility.panes.map(pane => pane.page.number)).toEqual([2, 3]);
    expect(visibility.current).toBeNull();
    expect(visibility.facing).toBeNull();
    expect(visibility.panes.every(pane => !pane.current && !pane.facing)).toBe(true);
  });

  it('shows nothing for a spread that is not there', () => {
    const visibility = visibilityFor(undefined as unknown as BookSpread, 1);

    expect(visibility.panes).toEqual([]);
    expect(visibility.current).toBeNull();
    expect(visibility.facing).toBeNull();
  });
});

describe('planBook: edges and options', () => {
  it('returns an empty plan for an empty document', () => {
    const plan = planBook([]);

    expect(plan.spreads).toEqual([]);
    expect(plan.blanks).toEqual([]);
  });

  it('gives a lone page a spread of its own', () => {
    const plan = planBook(bookPages(1));

    expect(shape(plan)).toEqual([[null, 1, 'single']]);
    expect(plan.blanks).toEqual([{ side: 'left', spread: 0 }]);
    expect(visibilityFor(spreadAt(plan, 0), 1).panes).toHaveLength(1);
  });

  it('treats a lone page as the cover when asked to', () => {
    const plan = planBook(bookPages(1), { firstPageIsCover: true });

    expect(shape(plan)).toEqual([[null, 1, 'cover']]);
    expect(plan.blanks).toEqual([]);
  });

  it('flips the parity when the binding does not start on the right', () => {
    const west = planBook(bookPages(2));
    const east = planBook(bookPages(2), { startOnRight: false });

    expect(shape(west)).toEqual([
      [null, 1, 'single'],
      [2, null, 'single'],
    ]);
    expect(shape(east)).toEqual([[1, 2, 'spread']]);
    expect(spreadFor(west, 1)?.side).toBe('right');
    expect(spreadFor(east, 1)?.side).toBe('left');
  });

  it('lists the plan backwards without changing its geometry', () => {
    const forward = planBook(bookPages(4), { firstPageIsCover: true });
    const reverse = planBook(bookPages(4), { firstPageIsCover: true, spreadOrder: 'reverse' });

    expect(shape(reverse)).toEqual([...shape(forward)].reverse());
    expect(reverse.spreads.map(spread => spread.index)).toEqual([0, 1, 2]);
    expect(reverse.spreads[0]?.folios).toEqual(forward.spreads[2]?.folios);
    // The blank follows its spread into the new order and is still listed ascending.
    expect(forward.blanks).toEqual([{ side: 'right', spread: 2 }]);
    expect(reverse.blanks).toEqual([{ side: 'right', spread: 0 }]);
  });

  it('refuses an unknown spread order', () => {
    const options = { spreadOrder: 'sideways' as unknown as SpreadOrder };

    expect(() => planBook(bookPages(1), options)).toThrow(BookModeError);
    expect(() => planBook(bookPages(1), options)).toThrow(/Unknown spread order: sideways/u);
    expect(isSpreadOrder('reverse')).toBe(true);
    expect(isSpreadOrder('sideways')).toBe(false);
  });

  it('reads the pages in number order whatever order they arrive in', () => {
    const ordered = bookPages(4);
    const shuffled = [ordered[2]!, ordered[0]!, ordered[3]!, ordered[1]!];

    expect(planBook(shuffled, { firstPageIsCover: true })).toEqual(
      planBook(ordered, { firstPageIsCover: true }),
    );
  });

  it('keeps the first of two pages that share a number', () => {
    const plan = planBook([
      { number: 1, width: 300, height: 400 },
      { number: 1, width: 500, height: 700 },
      { number: 2, width: 300, height: 400 },
    ]);

    expect(plan.spreads.flatMap(spread => spread.folios).map(folio => folio.page)).toEqual([1, 2]);
    expect(spreadAt(plan, 0).right?.width).toBe(300);
  });

  it('numbers pages without a usable number by their input position', () => {
    const plan = planBook([
      { number: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT },
      { number: Number.NaN, width: PAGE_WIDTH, height: PAGE_HEIGHT },
    ]);

    expect(plan.spreads.flatMap(spread => spread.folios).map(folio => folio.page)).toEqual([1, 2]);
  });

  it('falls back to US Letter for a page with no usable size', () => {
    const plan = planBook([{ number: 1, width: 0, height: Number.NaN }]);

    expect(spreadAt(plan, 0).right).toEqual({ number: 1, width: 612, height: 792 });
  });

  it('tolerates a page list that is not an array', () => {
    const plan = planBook(undefined as unknown as BookPageInput[]);

    expect(plan).toEqual({ spreads: [], blanks: [] });
  });
});
