import { describe, expect, it } from 'vitest';
import {
  COLUMN_MAJOR_REASON,
  EMPTY_PAGE_REASON,
  REPEATED_FOOTER_REASON,
  REPEATED_HEADER_REASON,
  ROW_MAJOR_REASON,
  normalizeRepeatText,
  orderBlocks,
  orderDocument,
  stripRepeats,
} from '../src/core/reading-order';
import type {
  PageBox,
  ReadingOrderBlock,
  ReadingOrderPage,
} from '../src/core/reading-order';

/** US Letter, the page box the fixtures below are laid out in. */
const PAGE: PageBox = { width: 612, height: 792 };

/** Left and right column boxes of a 500 pt text area with a 40 pt gutter. */
const LEFT_COLUMN_X = 56;
const RIGHT_COLUMN_X = 326;
const COLUMN_WIDTH = 230;

function block(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string = id,
): ReadingOrderBlock {
  return { id, rect: { x, y, width, height }, text };
}

function ids(blocks: readonly ReadingOrderBlock[]): string[] {
  return blocks.map(entry => entry.id);
}

/** Four paragraphs, two per column, both columns starting on the same line. */
function twoColumnPage(): ReadingOrderBlock[] {
  return [
    block('left-1', LEFT_COLUMN_X, 100, COLUMN_WIDTH, 60, 'Left column, first paragraph'),
    block('left-2', LEFT_COLUMN_X, 170, COLUMN_WIDTH, 60, 'Left column, second paragraph'),
    block('right-1', RIGHT_COLUMN_X, 100, COLUMN_WIDTH, 60, 'Right column, first paragraph'),
    block('right-2', RIGHT_COLUMN_X, 170, COLUMN_WIDTH, 60, 'Right column, second paragraph'),
  ];
}

function readingOrderPage(
  page: number,
  blocks: readonly ReadingOrderBlock[],
): ReadingOrderPage<ReadingOrderBlock> {
  return { page, width: PAGE.width, height: PAGE.height, blocks };
}

describe('orderBlocks column detection', () => {
  it('orders a two-column page column by column', () => {
    const result = orderBlocks(twoColumnPage(), PAGE);

    expect(ids(result.ordered)).toEqual(['left-1', 'left-2', 'right-1', 'right-2']);
    expect(result.columns).toHaveLength(2);
    expect(result.columns.map(column => column.blockIds)).toEqual([
      ['left-1', 'left-2'],
      ['right-1', 'right-2'],
    ]);
    expect(result.reasons).toContain(COLUMN_MAJOR_REASON);
    expect(result.reasons).toContain('column:count=2');
    expect(result.reasons).toContain('column:gutter=1');
    expect(result.columns[0]?.left).toBe(LEFT_COLUMN_X);
    expect(result.columns[1]?.left).toBe(306);
  });

  it('puts a spanning title before both columns', () => {
    const blocks = [
      block('title', LEFT_COLUMN_X, 60, 500, 30, 'A two-column paper'),
      ...twoColumnPage(),
    ];
    const result = orderBlocks(blocks, PAGE);

    expect(ids(result.ordered)).toEqual(['title', 'left-1', 'left-2', 'right-1', 'right-2']);
    expect(result.reasons).toContain('spanning:count=1');
    expect(result.reasons).toContain('band:count=2');
  });

  it('lets a table that spans both columns end the row band', () => {
    const blocks = [
      block('left-1', LEFT_COLUMN_X, 100, COLUMN_WIDTH, 60),
      block('right-1', RIGHT_COLUMN_X, 100, COLUMN_WIDTH, 60),
      block('table', LEFT_COLUMN_X, 200, 500, 80, 'rendered table rows'),
      block('left-2', LEFT_COLUMN_X, 320, COLUMN_WIDTH, 60),
      block('right-2', RIGHT_COLUMN_X, 320, COLUMN_WIDTH, 60),
    ];
    const result = orderBlocks(blocks, PAGE);

    expect(ids(result.ordered)).toEqual(['left-1', 'right-1', 'table', 'left-2', 'right-2']);
    expect(result.reasons).toContain('spanning:count=1');
    expect(result.reasons).toContain('band:count=2');
  });

  it('orders a three-column page column by column', () => {
    const blocks = [
      block('c1a', 56, 100, 160, 60),
      block('c1b', 56, 160, 160, 60),
      block('c2a', 232, 100, 160, 60),
      block('c2b', 232, 160, 160, 60),
      block('c3a', 408, 100, 160, 60),
      block('c3b', 408, 160, 160, 60),
    ];
    const result = orderBlocks(blocks, PAGE);

    expect(ids(result.ordered)).toEqual(['c1a', 'c1b', 'c2a', 'c2b', 'c3a', 'c3b']);
    expect(result.columns).toHaveLength(3);
    expect(result.columns.map(column => column.blockIds)).toEqual([
      ['c1a', 'c1b'],
      ['c2a', 'c2b'],
      ['c3a', 'c3b'],
    ]);
    expect(result.reasons).toContain('column:count=3');
    expect(result.reasons).toContain('column:gutter=2');
  });

  it('reads a page without a gutter top to bottom', () => {
    const blocks = [
      block('third', 56, 300, 500, 40),
      block('first', 56, 100, 500, 40),
      block('second', 56, 200, 500, 40),
    ];
    const result = orderBlocks(blocks, PAGE);

    expect(ids(result.ordered)).toEqual(['first', 'second', 'third']);
    expect(result.columns).toHaveLength(1);
    expect(result.reasons).toContain(ROW_MAJOR_REASON);
  });

  it('keeps a block that crosses a gutter below the spanning width in its column', () => {
    const blocks = [
      ...twoColumnPage(),
      block('banner', LEFT_COLUMN_X, 300, 300, 40, 'Wide but not full-width banner'),
    ];
    const result = orderBlocks(blocks, PAGE);

    expect(ids(result.ordered)).toEqual(['left-1', 'left-2', 'banner', 'right-1', 'right-2']);
    expect(result.columns[0]?.blockIds).toEqual(['left-1', 'left-2', 'banner']);
    expect(result.reasons).toContain('column:straddling=1');
    expect(result.reasons).toContain('spanning:count=0');
  });

  it('reports an empty page instead of inventing a layout', () => {
    const result = orderBlocks([], PAGE);

    expect(result.ordered).toEqual([]);
    expect(result.columns).toEqual([]);
    expect(result.reasons).toEqual([EMPTY_PAGE_REASON]);
  });

  it('breaks exact geometry ties by id, then input position', () => {
    const forward = orderBlocks([block('b', 56, 100, 200, 40), block('a', 56, 100, 200, 40)], PAGE);
    const backward = orderBlocks([block('a', 56, 100, 200, 40), block('b', 56, 100, 200, 40)], PAGE);

    expect(ids(forward.ordered)).toEqual(['a', 'b']);
    expect(ids(backward.ordered)).toEqual(['a', 'b']);
  });

  it('produces the same order for shuffled input', () => {
    const blocks = twoColumnPage();
    const forward = orderBlocks(blocks, PAGE);
    const shuffled = orderBlocks([blocks[3]!, blocks[0]!, blocks[2]!, blocks[1]!], PAGE);

    expect(ids(shuffled.ordered)).toEqual(ids(forward.ordered));
    expect(shuffled.reasons).toEqual(forward.reasons);
    expect(shuffled.columns).toEqual(forward.columns);
  });
});

describe('orderDocument', () => {
  it('concatenates pages in ascending page number', () => {
    const page1 = readingOrderPage(1, [
      block('p1-top', 56, 100, 500, 60),
      block('p1-bottom', 56, 170, 500, 60),
    ]);
    const page2 = readingOrderPage(2, [
      block('p2-top', 56, 100, 500, 60),
      block('p2-bottom', 56, 170, 500, 60),
    ]);
    const result = orderDocument([page2, page1]);

    expect(result.ordered.map(entry => entry.block.id)).toEqual([
      'p1-top',
      'p1-bottom',
      'p2-top',
      'p2-bottom',
    ]);
    expect(result.ordered.map(entry => entry.page)).toEqual([1, 1, 2, 2]);
    expect(result.ordered.map(entry => entry.order)).toEqual([0, 1, 2, 3]);
    expect(result.ordered.every(entry => entry.column === 0 && !entry.spanning)).toBe(true);
    expect(result.pages.map(page => page.page)).toEqual([1, 2]);
    expect(result.reasons).toContain('document:pages=2');
    expect(result.reasons).toContain('document:blocks=4');
  });

  it('keeps two fragments of one page in input order', () => {
    const first = readingOrderPage(3, [block('a', 56, 100, 500, 60)]);
    const second = readingOrderPage(3, [block('b', 56, 100, 500, 60)]);
    const result = orderDocument([first, second]);

    expect(result.ordered.map(entry => entry.block.id)).toEqual(['a', 'b']);
    expect(result.ordered.map(entry => entry.order)).toEqual([0, 1]);
  });

  it('marks the spanning blocks and their columns across a document', () => {
    const page = readingOrderPage(1, [
      block('title', LEFT_COLUMN_X, 60, 500, 30),
      ...twoColumnPage(),
    ]);
    const result = orderDocument([page]);

    expect(result.ordered.map(entry => entry.block.id)).toEqual([
      'title',
      'left-1',
      'left-2',
      'right-1',
      'right-2',
    ]);
    expect(result.ordered[0]?.spanning).toBe(true);
    expect(result.ordered[0]?.column).toBeNull();
    expect(result.ordered.slice(1).map(entry => entry.column)).toEqual([0, 0, 1, 1]);
    expect(result.pages[0]?.blockCount).toBe(5);
  });
});

describe('stripRepeats', () => {
  /** Six pages: a running header on pages 1-5, a footer with the page number on all. */
  function repeatedPages(): ReadingOrderPage<ReadingOrderBlock>[] {
    return Array.from({ length: 6 }, (_, index) => {
      const page = index + 1;
      const header =
        page <= 5
          ? block(`header-${page}`, 56, 30, 300, 12, 'Journal of Tests')
          : block('once-only', 56, 30, 300, 12, 'Once only line');
      return readingOrderPage(page, [
        header,
        block(`body-${page}`, 56, 300, 500, 40, `Body text page ${page}`),
        block(`footer-${page}`, 250, 750, 120, 12, `Page ${page}`),
      ]);
    });
  }

  it('removes a header that recurs on five of six pages', () => {
    const document = orderDocument(repeatedPages());
    const result = stripRepeats(document.ordered);

    const headers = result.removed.filter(entry => entry.reason === REPEATED_HEADER_REASON);
    const footers = result.removed.filter(entry => entry.reason === REPEATED_FOOTER_REASON);
    expect(headers.map(entry => entry.block.id)).toEqual([
      'header-1',
      'header-2',
      'header-3',
      'header-4',
      'header-5',
    ]);
    expect(headers.every(entry => entry.key === 'journal of tests')).toBe(true);
    expect(headers.every(entry => entry.pages === 5)).toBe(true);
    expect(footers).toHaveLength(6);
    expect(footers.every(entry => entry.key === 'page #')).toBe(true);
    expect(footers.every(entry => entry.pages === 6)).toBe(true);
  });

  it('keeps a once-only line and the repeated body text', () => {
    const document = orderDocument(repeatedPages());
    const result = stripRepeats(document.ordered);
    const kept = result.kept.map(entry => entry.block.id);

    expect(kept).toHaveLength(7);
    expect(kept).toContain('once-only');
    for (let page = 1; page <= 6; page += 1) expect(kept).toContain(`body-${page}`);
    // Body text repeats across pages once page numbers are normalised, but it is not
    // in the header or footer band, so it is content and never removed.
    expect(kept.filter(id => id.startsWith('body-'))).toHaveLength(6);
  });

  it('keeps the surviving order values so callers can map back', () => {
    const document = orderDocument(repeatedPages());
    const result = stripRepeats(document.ordered);
    const orders = result.kept.map(entry => entry.order);

    expect([...orders].sort((left, right) => left - right)).toEqual(orders);
    expect(orders[0]).toBe(1);
    expect(orders).toHaveLength(7);
  });

  it('treats page-number variants as one footer', () => {
    const pages = ['Page 3', 'Page 7', 'page 12'].map((label, index) =>
      readingOrderPage(index + 1, [
        block(`body-${index + 1}`, 56, 300, 500, 40, `Body ${index + 1}`),
        block(`footer-${index + 1}`, 250, 750, 120, 12, label),
      ]),
    );
    const result = stripRepeats(orderDocument(pages).ordered);

    expect(result.removed).toHaveLength(3);
    expect(result.removed.every(entry => entry.key === 'page #')).toBe(true);
    expect(result.removed.every(entry => entry.reason === REPEATED_FOOTER_REASON)).toBe(true);
    expect(result.kept.map(entry => entry.block.id)).toEqual(['body-1', 'body-2', 'body-3']);
  });

  it('never removes anything from a single page', () => {
    const result = stripRepeats(orderDocument([readingOrderPage(1, [block('only', 56, 30, 300, 12)])]).ordered);

    expect(result.removed).toEqual([]);
    expect(result.kept).toHaveLength(1);
  });

  it('honours a stricter repeat share', () => {
    const document = orderDocument(repeatedPages());
    const result = stripRepeats(document.ordered, { minPageShare: 0.9 });

    // Five of six pages is below 90 %, so the header survives; the footer still goes.
    expect(result.removed.every(entry => entry.reason === REPEATED_FOOTER_REASON)).toBe(true);
    expect(result.removed).toHaveLength(6);
    expect(result.kept.map(entry => entry.block.id)).toContain('header-1');
  });
});

describe('normalizeRepeatText', () => {
  it('folds numeric page numbers', () => {
    expect(normalizeRepeatText('Page 3')).toBe('page #');
    expect(normalizeRepeatText('page 12')).toBe('page #');
    expect(normalizeRepeatText('PAGE 7 OF 12')).toBe('page # of #');
  });

  it('folds case, whitespace and edge punctuation', () => {
    expect(normalizeRepeatText('  JOURNAL   of Tests ')).toBe('journal of tests');
    expect(normalizeRepeatText('— 3 —')).toBe('#');
    expect(normalizeRepeatText('— 7 —')).toBe('#');
    expect(normalizeRepeatText('\n\nJournal of Tests.\n')).toBe('journal of tests');
  });

  it('returns an empty key for empty or punctuation-only text', () => {
    expect(normalizeRepeatText('')).toBe('');
    expect(normalizeRepeatText('   ')).toBe('');
    expect(normalizeRepeatText('***')).toBe('');
  });
});
