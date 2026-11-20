import { describe, expect, it } from 'vitest';
import {
  detectFurniture,
  excludeFromTranslation,
  pageNumberPattern,
  reportFurniture,
  type FurnitureBlockInput,
  type FurniturePageInput,
} from '../src/core/furniture';

// A page big enough for the 8 % bands to be unambiguous: top band ends at 64 pt on an
// 800 pt page, the bottom band starts at 736 pt.
const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 800;

function textBlock(
  id: string,
  text: string,
  x: number,
  y: number,
  width = 200,
  height = 12,
  rotation = 0,
): FurnitureBlockInput {
  return { id, text, rect: { x, y, width, height }, rotation };
}

function page(number: number, blocks: FurnitureBlockInput[]): FurniturePageInput {
  return { number, width: PAGE_WIDTH, height: PAGE_HEIGHT, blocks };
}

// A running head on every page plus one body paragraph per page.
function headedPages(count = 3): FurniturePageInput[] {
  return Array.from({ length: count }, (_, index) =>
    page(index + 1, [
      textBlock(`p${index + 1}-h`, 'Annual Report 2024', 60, 24, 220),
      textBlock(`p${index + 1}-b`, `Body paragraph number ${index + 1}.`, 60, 200, 460, 200),
    ]),
  );
}

// A running folio on every page: the numbers differ, the foot repeats.
function folioPages(count = 3): FurniturePageInput[] {
  return Array.from({ length: count }, (_, index) =>
    page(index + 1, [
      textBlock(`p${index + 1}-b`, `Body paragraph number ${index + 1}.`, 60, 200, 460, 200),
      textBlock(`p${index + 1}-f`, `Page ${index + 1} of ${count}`, 260, 760, 80),
    ]),
  );
}

// Header, body, diagonal watermark and folio on every page: one of each verdict.
function furnishedDocument(count = 3): FurniturePageInput[] {
  return Array.from({ length: count }, (_, index) =>
    page(index + 1, [
      textBlock(`p${index + 1}-h`, 'Annual Report 2024', 60, 24, 220),
      textBlock(`p${index + 1}-b`, `Body paragraph number ${index + 1}.`, 60, 200, 460, 200),
      textBlock(`p${index + 1}-w`, 'DRAFT', 180, 340, 240, 80, 45),
      textBlock(`p${index + 1}-f`, `Page ${index + 1} of ${count}`, 260, 760, 80),
    ]),
  );
}

describe('detectFurniture: headers and footers', () => {
  it('detects a header repeated on every page', () => {
    const detection = detectFurniture(headedPages(3));
    const headers = detection.classified.filter(block => block.kind === 'header');

    expect(headers.map(block => block.id)).toEqual(['p1-h', 'p2-h', 'p3-h']);
    expect(headers[0]?.confidence).toBe(0.95);
    expect(headers[0]?.reasons.some(reason => reason.startsWith('band:top='))).toBe(true);
    expect(headers[0]?.reasons).toContain('shared-pages=3/3');

    const group = detection.repeated.find(entry => entry.normalizedText === 'annual report #');
    expect(group).toMatchObject({
      kind: 'header',
      pages: [1, 2, 3],
      blockIds: ['p1-h', 'p2-h', 'p3-h'],
      share: 1,
    });
    expect(detection.reasons).toContainEqual({
      code: 'repeated-furniture',
      page: 1,
      blockId: 'p1-h',
      share: 1,
      normalizedText: 'annual report #',
    });
  });

  it('groups a footer whose page numbers change as one repeated group', () => {
    const detection = detectFurniture(folioPages(3));
    const numbers = detection.classified.filter(block => block.kind === 'page-number');

    expect(numbers).toHaveLength(3);
    expect(numbers.every(block => block.reasons.includes('page-number:pattern=page-of-total'))).toBe(true);

    const group = detection.repeated.find(entry => entry.normalizedText === 'page # of #');
    expect(group?.kind).toBe('page-number');
    expect(group?.pages).toEqual([1, 2, 3]);
    expect(group?.blockIds).toEqual(['p1-f', 'p2-f', 'p3-f']);
    expect(group?.text).toBe('Page 1 of 3');
  });

  it('groups a footer that carries a label beside changing numbers', () => {
    const pages = Array.from({ length: 4 }, (_, index) =>
      page(index + 1, [
        textBlock(`p${index + 1}-b`, `Body paragraph ${index + 1}.`, 60, 200, 460, 200),
        textBlock(`p${index + 1}-f`, `Acme Ltd · Page ${index + 1} of 4`, 200, 760, 220),
      ]),
    );

    const detection = detectFurniture(pages);
    const footers = detection.classified.filter(block => block.kind === 'footer');
    expect(footers.map(block => block.id)).toEqual(['p1-f', 'p2-f', 'p3-f', 'p4-f']);

    const group = detection.repeated.find(entry => entry.normalizedText.startsWith('acme ltd'));
    expect(group?.kind).toBe('footer');
    expect(group?.pages).toEqual([1, 2, 3, 4]);
  });

  it('needs 60 % of the pages: three of five is enough, two of four is not', () => {
    const below = Array.from({ length: 4 }, (_, index) =>
      page(
        index + 1,
        index < 2
          ? [textBlock(`p${index + 1}-h`, 'Chapter One', 60, 24, 200)]
          : [textBlock(`p${index + 1}-b`, `Body paragraph ${index + 1}.`, 60, 200, 460, 200)],
      ),
    );

    const belowDetection = detectFurniture(below);
    expect(belowDetection.classified.filter(block => block.kind === 'header')).toEqual([]);
    expect(belowDetection.repeated.some(group => group.normalizedText === 'chapter one')).toBe(false);
    expect(belowDetection.classified.find(block => block.id === 'p1-h')?.kind).toBe('content');

    const atThreshold = Array.from({ length: 5 }, (_, index) =>
      page(
        index + 1,
        index < 3
          ? [textBlock(`p${index + 1}-h`, 'Chapter One', 60, 24, 200)]
          : [textBlock(`p${index + 1}-b`, `Body paragraph ${index + 1}.`, 60, 200, 460, 200)],
      ),
    );

    const atDetection = detectFurniture(atThreshold);
    expect(atDetection.classified.filter(block => block.kind === 'header').map(block => block.id)).toEqual([
      'p1-h',
      'p2-h',
      'p3-h',
    ]);
    const group = atDetection.repeated.find(entry => entry.normalizedText === 'chapter one');
    expect(group?.pages).toEqual([1, 2, 3]);
    expect(group?.share).toBe(0.6);
  });
});

describe('detectFurniture: page numbers', () => {
  it('reads a lone Roman numeral in the bottom band as a page number', () => {
    const detection = detectFurniture([
      page(1, [
        textBlock('p1-b', 'Body text.', 60, 200, 460, 200),
        textBlock('p1-f', 'xiv', 300, 760, 40),
      ]),
    ]);

    const numbers = detection.classified.filter(block => block.kind === 'page-number');
    expect(numbers).toHaveLength(1);
    expect(numbers[0]?.reasons).toContain('page-number:pattern=roman');
    expect(numbers[0]?.confidence).toBe(0.85);
  });

  it('reads "Page 3 of 10" as a page number and a sentence as content', () => {
    const detection = detectFurniture([
      page(1, [
        textBlock('p1-f', 'Page 3 of 10', 260, 760, 80),
        textBlock('p1-b', 'See page 3 of 10 for the details of this argument.', 60, 200, 460, 200),
      ]),
    ]);

    expect(detection.classified.find(block => block.id === 'p1-f')?.kind).toBe('page-number');
    expect(detection.classified.find(block => block.id === 'p1-b')?.kind).toBe('content');
  });

  it('leaves a lone number in the middle of the page as content', () => {
    const detection = detectFurniture([page(1, [textBlock('p1-n', '3', 60, 300, 20)])]);
    expect(detection.classified[0]?.kind).toBe('content');
    expect(detection.classified[0]?.reasons).toContain('content:outside-bands');
  });
});

describe('pageNumberPattern', () => {
  it('recognises the folio shapes', () => {
    expect(pageNumberPattern('Page 3 of 10')).toBe('page-of-total');
    expect(pageNumberPattern('p. 3/10')).toBe('page-of-total');
    expect(pageNumberPattern('3 of 10')).toBe('page-of-total');
    expect(pageNumberPattern('- 3 -')).toBe('dash');
    expect(pageNumberPattern('— 12 —')).toBe('dash');
    expect(pageNumberPattern('[12]')).toBe('arabic');
    expect(pageNumberPattern('Page 7')).toBe('page-label');
    expect(pageNumberPattern('xiv')).toBe('roman');
    expect(pageNumberPattern('MCMLXXXIV')).toBe('roman');
  });

  it('refuses sentences, over-long text, multi-line blocks and mixed-case words', () => {
    expect(pageNumberPattern('Chapter 3')).toBeNull();
    expect(pageNumberPattern('See page 3 of 10 for details')).toBeNull();
    expect(pageNumberPattern('')).toBeNull();
    expect(pageNumberPattern('3\n4')).toBeNull();
    // `Mix` is not all upper or all lower case, so it is a word rather than 1009.
    expect(pageNumberPattern('Mix')).toBeNull();
  });
});

describe('detectFurniture: watermarks', () => {
  it('detects a watermark by its oblique rotation', () => {
    const detection = detectFurniture([
      page(1, [
        textBlock('p1-w', 'DRAFT', 180, 340, 240, 80, 45),
        textBlock('p1-b', 'Body text.', 60, 200, 460, 120),
      ]),
    ]);

    const watermark = detection.classified.find(block => block.id === 'p1-w');
    expect(watermark?.kind).toBe('watermark');
    expect(watermark?.rotation).toBe(45);
    expect(watermark?.reasons).toContain('watermark:rotation=45.00');
    expect(watermark?.reasons).toContain('watermark:oblique=45.00');
    expect(watermark?.confidence).toBe(0.85);
  });

  it('keeps a quarter turn out of the watermark rule', () => {
    const detection = detectFurniture([page(1, [textBlock('p1-v', 'Vertical label', 20, 200, 120, 12, 90)])]);
    expect(detection.classified[0]?.rotation).toBe(90);
    expect(detection.classified[0]?.kind).toBe('content');
  });

  it('prefers watermark over header when a diagonal line repeats in the top band', () => {
    const pages = Array.from({ length: 3 }, (_, index) =>
      page(index + 1, [textBlock(`p${index + 1}-w`, 'CONFIDENTIAL', 120, 20, 300, 60, 30)]),
    );

    const detection = detectFurniture(pages);
    expect(detection.classified.every(block => block.kind === 'watermark')).toBe(true);
    expect(detection.repeated[0]).toMatchObject({ kind: 'watermark', pages: [1, 2, 3] });
  });
});

describe('detectFurniture: content that only looks like furniture', () => {
  it('keeps a one-off line that sits low as content', () => {
    const pages = Array.from({ length: 3 }, (_, index) =>
      page(index + 1, [
        textBlock(`p${index + 1}-b`, `Body paragraph ${index + 1}.`, 60, 200, 460, 200),
        ...(index === 1 ? [textBlock('p2-note', 'A line that only appears once', 60, 760, 300)] : []),
      ]),
    );

    const detection = detectFurniture(pages);
    const note = detection.classified.find(block => block.id === 'p2-note');
    expect(note?.kind).toBe('content');
    expect(note?.reasons).toContain('content:band-only');
    expect(note?.reasons).toContain('shared-pages=1/3');
    expect(detection.reasons).toContainEqual({ code: 'band-only', page: 2, blockId: 'p2-note' });
  });

  it('does not turn a repeated mid-page line into a footer', () => {
    const pages = Array.from({ length: 4 }, (_, index) =>
      page(index + 1, [
        textBlock(`p${index + 1}-b`, `Body paragraph ${index + 1}.`, 60, 200, 460, 200),
        textBlock(`p${index + 1}-c`, '© 2024 Acme Ltd', 60, 520, 220),
      ]),
    );

    const detection = detectFurniture(pages);
    expect(detection.classified.filter(block => block.id.endsWith('-c')).every(block => block.kind === 'content')).toBe(true);

    const group = detection.repeated.find(entry => entry.normalizedText === '© # acme ltd');
    expect(group).toMatchObject({ kind: 'content', pages: [1, 2, 3, 4] });
    expect(detection.reasons.some(reason => reason.code === 'repeated-content')).toBe(true);
  });

  it('reads an empty block as content even when it is rotated', () => {
    const detection = detectFurniture([
      page(1, [{ text: '', rect: { x: 60, y: 20, width: 100, height: 12 }, rotation: 45 }]),
    ]);
    expect(detection.classified[0]?.kind).toBe('content');
    expect(detection.classified[0]?.confidence).toBe(0.2);
    expect(detection.classified[0]?.reasons).toContain('content:empty-text');
  });
});

describe('detectFurniture: input handling', () => {
  it('gives synthetic ids in document order to blocks that have none', () => {
    const detection = detectFurniture([
      page(1, [
        { text: 'DRAFT', rect: { x: 180, y: 340, width: 240, height: 80 }, rotation: 45 },
        { text: '', rect: { x: 60, y: 20, width: 100, height: 12 }, rotation: 45 },
      ]),
    ]);

    expect(detection.classified.map(block => block.id)).toEqual(['furniture-b0', 'furniture-b1']);
    expect(detection.classified[0]?.kind).toBe('content');
    expect(detection.classified[1]?.kind).toBe('watermark');
  });

  it('keeps the first occurrence of a duplicated page number', () => {
    const detection = detectFurniture([
      page(1, [textBlock('p1-a', 'First', 60, 24, 100)]),
      page(1, [textBlock('p1-b', 'Second', 60, 24, 100)]),
    ]);
    expect(detection.classified.map(block => block.id)).toEqual(['p1-a']);
  });

  it('derives the page size from the blocks when the page reports none', () => {
    const detection = detectFurniture([
      {
        number: 1,
        width: 0,
        height: 0,
        blocks: [textBlock('p1-h', 'Header', 60, 10, 100), textBlock('p1-b', 'Body', 60, 100, 100, 400)],
      },
    ]);

    // The union of the blocks is 500 pt tall, so both blocks sit in a band and neither
    // repeats: content, with the band evidence recorded.
    expect(detection.classified.every(block => block.kind === 'content')).toBe(true);
    expect(detection.classified.every(block => block.reasons.includes('content:band-only'))).toBe(true);
  });

  it('does not depend on the order pages or blocks are listed in', () => {
    const pages = furnishedDocument(3);
    const reversed = [...pages].reverse().map(entry => ({ ...entry, blocks: [...entry.blocks].reverse() }));

    const forward = detectFurniture(pages);
    const backward = detectFurniture(reversed);
    expect(backward.classified.map(block => block.id)).toEqual(forward.classified.map(block => block.id));
    expect(backward.classified.map(block => block.kind)).toEqual(forward.classified.map(block => block.kind));
    expect(backward.repeated).toEqual(forward.repeated);
  });
});

describe('excludeFromTranslation', () => {
  it('skips headers and watermarks and keeps page numbers for re-emission', () => {
    const detection = detectFurniture(furnishedDocument(3));
    const exclusion = excludeFromTranslation(detection);

    expect(exclusion.skip).toEqual(['p1-h', 'p1-w', 'p2-h', 'p2-w', 'p3-h', 'p3-w']);
    expect(exclusion.pageNumbers).toEqual([
      { page: 1, blockId: 'p1-f', text: 'Page 1 of 3' },
      { page: 2, blockId: 'p2-f', text: 'Page 2 of 3' },
      { page: 3, blockId: 'p3-f', text: 'Page 3 of 3' },
    ]);
    expect(exclusion.skippedKinds).toEqual(['header', 'watermark']);
    expect(exclusion.pageNumberPolicy).toBe('reemit');
  });

  it('skips the page numbers too when re-emission is off', () => {
    const detection = detectFurniture(furnishedDocument(3));
    const exclusion = excludeFromTranslation(detection, { keepPageNumbers: false });

    expect(exclusion.skip).toEqual([
      'p1-h',
      'p1-w',
      'p1-f',
      'p2-h',
      'p2-w',
      'p2-f',
      'p3-h',
      'p3-w',
      'p3-f',
    ]);
    expect(exclusion.pageNumbers).toEqual([]);
    expect(exclusion.skippedKinds).toEqual(['header', 'page-number', 'watermark']);
    expect(exclusion.pageNumberPolicy).toBe('skip');
  });

  it('accepts a bare classified list', () => {
    const detection = detectFurniture(furnishedDocument(2));
    const exclusion = excludeFromTranslation(detection.classified);
    expect(exclusion.skip).toHaveLength(4);
    expect(exclusion.pageNumbers).toHaveLength(2);
  });
});

describe('reportFurniture', () => {
  it('counts every kind and writes a stable audit line', () => {
    const detection = detectFurniture(furnishedDocument(3));
    const report = reportFurniture(detection);

    expect(report.counts).toEqual({ header: 3, footer: 0, 'page-number': 3, watermark: 3, content: 3 });
    expect(report.total).toBe(12);
    expect(report.furniture).toBe(9);
    expect(report.line).toBe('furniture header=3 footer=0 page-number=3 watermark=3 content=3 total=12');
  });

  it('summarises an empty document', () => {
    const report = reportFurniture([]);
    expect(report.counts).toEqual({ header: 0, footer: 0, 'page-number': 0, watermark: 0, content: 0 });
    expect(report.total).toBe(0);
    expect(report.line).toBe('furniture header=0 footer=0 page-number=0 watermark=0 content=0 total=0');
  });
});

describe('detectFurniture: empty document', () => {
  it('returns no blocks and a single no-pages reason', () => {
    const detection = detectFurniture([]);

    expect(detection).toEqual({
      classified: [],
      repeated: [],
      reasons: [{ code: 'no-pages', page: null, blockId: null }],
    });
    expect(reportFurniture(detection).line).toBe(
      'furniture header=0 footer=0 page-number=0 watermark=0 content=0 total=0',
    );
    expect(excludeFromTranslation(detection)).toEqual({
      skip: [],
      pageNumbers: [],
      skippedKinds: [],
      pageNumberPolicy: 'reemit',
    });
  });

  it('reports a document with pages but no blocks', () => {
    const detection = detectFurniture([page(1, [])]);
    expect(detection.reasons).toEqual([{ code: 'no-blocks', page: null, blockId: null }]);
    expect(detection.classified).toEqual([]);
  });
});
