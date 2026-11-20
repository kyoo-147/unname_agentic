import { describe, expect, it } from 'vitest';
import {
  classifyBlock,
  classifyBlocks,
  DEFAULT_BODY_FONT_SIZE,
  medianFontSize,
  SEMANTIC_BLOCK_TYPES,
  type BlockContext,
  type BlockFeatures,
  type BlockInput,
} from '../src/core/blocks';

// A US Letter page in points. Every fixture sits on it at a plausible position, so
// the bottom band and the font ratios are exercised the way a real page would.
const PAGE_HEIGHT = 792;
const BODY = 10.5;

function context(overrides: Partial<BlockContext> = {}): BlockContext {
  return { pageHeight: PAGE_HEIGHT, medianFontSize: BODY, ...overrides };
}

function textBlock(text: string, overrides: Partial<BlockFeatures> = {}): BlockFeatures {
  return {
    text,
    rect: { x: 72, y: 300, width: 360, height: 14 },
    fontSize: BODY,
    ...overrides,
  };
}

// --- One realistic fixture per type ---------------------------------------

describe('classifyBlock: one fixture per type', () => {
  it('reads a section title as a heading', () => {
    const heading = textBlock('3 Method', {
      rect: { x: 72, y: 120, width: 210, height: 22 },
      fontSize: 18,
      isBold: true,
    });
    const result = classifyBlock(heading, context());

    expect(result.type).toBe('heading');
    expect(result.confidence).toBeGreaterThan(0.8);
    // 18 pt against a 10.5 pt body is 1.71x, and the title is eight characters long.
    expect(result.reasons.some(reason => reason.startsWith('heading:font-scale=1.71'))).toBe(true);
    expect(result.reasons).toContain('heading:bold');
  });

  it('reads running body copy as a paragraph', () => {
    const paragraph = textBlock(
      'Clause 4 of the agreement is binding on both parties. The remaining clauses are reproduced in the appendix for ease of reference and do not alter the terms set out above.',
      { rect: { x: 72, y: 240, width: 440, height: 60 } },
    );
    const result = classifyBlock(paragraph, context());

    expect(result.type).toBe('paragraph');
    expect(result.reasons).toContain('paragraph:body-size');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('reads a bulleted item as a list', () => {
    const item = textBlock('• Verify the coolant level against the sight glass');
    const result = classifyBlock(item, context());

    expect(result.type).toBe('list');
    expect(result.reasons).toContain('list:marker=•');
  });

  it('reads a footnote as a footnote', () => {
    const footnote = textBlock(
      '1 Supported by grant 42-1170 from the regional science fund. Views expressed are the authors own.',
      { rect: { x: 72, y: 728, width: 320, height: 9 }, fontSize: 7.5 },
    );
    const result = classifyBlock(footnote, context());

    expect(result.type).toBe('footnote');
    // 7.5 pt is 0.71x the body, and the block ends at 93 % of the page height.
    expect(result.reasons.some(reason => reason.startsWith('footnote:bottom=0.93'))).toBe(true);
  });

  it('reads a figure caption as a caption', () => {
    const caption = textBlock('Figure 3. Accuracy against temperature for the three test batches.', {
      rect: { x: 72, y: 600, width: 420, height: 12 },
      fontSize: 9,
    });
    const result = classifyBlock(caption, context());

    expect(result.type).toBe('caption');
    expect(result.reasons).toContain('caption:pattern=Figure 3');
  });

  it('reads a display equation as a formula', () => {
    const formula = textBlock('(a + b)^2 = a^2 + 2ab + b^2', {
      rect: { x: 180, y: 350, width: 300, height: 20 },
    });
    const result = classifyBlock(formula, context());

    expect(result.type).toBe('formula');
    expect(result.reasons.some(reason => reason.startsWith('formula:math-ratio='))).toBe(true);
  });

  it('reads an aligned numeric block as a table', () => {
    const table = textBlock(
      [
        'Method      Accuracy   Latency',
        'Ours        98.2%      12 ms',
        'Baseline    94.1%      20 ms',
        'Ablated     91.7%      27 ms',
      ].join('\n'),
      { rect: { x: 72, y: 320, width: 400, height: 56 } },
    );
    const result = classifyBlock(table, context());

    expect(result.type).toBe('table');
    expect(result.reasons).toContain('table:columns=3');
    expect(result.reasons).toContain('table:rows=4/4');
  });

  it('reads a page image with no text as a figure', () => {
    const figure = textBlock('', {
      rect: { x: 90, y: 240, width: 380, height: 240 },
      imageCoverage: 0.86,
    });
    const result = classifyBlock(figure, context());

    expect(result.type).toBe('figure');
    expect(result.reasons).toContain('figure:image-coverage=0.86');
  });

  it('reads a whitespace-only block as other', () => {
    const blank = textBlock('   \n  ', { rect: { x: 72, y: 400, width: 100, height: 10 } });
    const result = classifyBlock(blank, context());

    expect(result.type).toBe('other');
    expect(result.reasons).toEqual(['other:empty-text']);
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('keeps body-size text at the bottom of the page a paragraph, not a footnote', () => {
    // The last paragraph of a page sits in the bottom band at body size. Without the
    // size half of the footnote rule it would be swallowed as a note on every page.
    const lastParagraph = textBlock(
      'The appendices follow the references and are numbered separately from the main text.',
      { rect: { x: 72, y: 730, width: 440, height: 12 } },
    );
    const result = classifyBlock(lastParagraph, context());

    expect(result.type).toBe('paragraph');
    expect(result.reasons.some(reason => reason.startsWith('footnote:'))).toBe(false);
  });
});

// --- Table honesty --------------------------------------------------------

// A block that splits into cells on some lines but not on most of them is a mixed
// blob (a table fragment merged with prose, or a two-column page block). Claiming a
// table here would be worse than saying "other": E06 needs to know it is unsafe.
describe('classifyBlock: tables are not over-claimed', () => {
  it('claims a two-column table with regular gaps', () => {
    const table = textBlock(
      [
        'Parameter     Value',
        'Voltage       3.3 V',
        'Current       120 mA',
        'Temperature   25 C',
      ].join('\n'),
      { rect: { x: 72, y: 320, width: 320, height: 56 } },
    );
    const result = classifyBlock(table, context());

    expect(result.type).toBe('table');
    expect(result.reasons).toContain('table:columns=2');
  });

  it('reports a mixed two-column blob as other, with the table reason attached', () => {
    const blob = textBlock(
      ['Results summary', 'Ours   98.2%   12 ms', 'mixed values 1.2  3.4'].join('\n'),
      { rect: { x: 72, y: 320, width: 380, height: 42 } },
    );
    const result = classifyBlock(blob, context());

    expect(result.type).toBe('other');
    expect(result.reasons.some(reason => reason.startsWith('other:table-columns-irregular=2/3'))).toBe(true);
    // The column count is reported as a range: picking 2 or 3 as "the" count would
    // be exactly the over-claim this verdict exists to avoid.
    expect(result.reasons).toContain('other:columns=2-3');
    expect(result.reasons.some(reason => reason.startsWith('close-call:'))).toBe(true);
  });
});

// --- Lists ----------------------------------------------------------------

describe('classifyBlock: list markers', () => {
  const items: ReadonlyArray<readonly [string, string]> = [
    ['dash', '- Ensure the thermal probe is seated before power is applied'],
    ['bullet', '• Verify the coolant level against the sight glass'],
    ['ordinal', '1. Torque the bolts in sequence, starting from the centre'],
    ['letter', 'a) Record the final reading on the calibration sheet'],
  ];

  for (const [label, text] of items) {
    it(`reads a ${label} item as a list`, () => {
      const result = classifyBlock(textBlock(text), context());
      expect(result.type).toBe('list');
      expect(result.reasons.some(reason => reason.startsWith('list:marker='))).toBe(true);
    });
  }

  it('reads every marked line of a multi-line list as one list', () => {
    const list = textBlock(['• First test', '• Second test', '• Third test'].join('\n'), {
      rect: { x: 72, y: 300, width: 300, height: 42 },
    });
    const result = classifyBlock(list, context());

    expect(result.type).toBe('list');
    expect(result.reasons).toContain('list:all-lines-marked');
  });

  it('treats a display-size numbered title as a heading, not a list', () => {
    const title = textBlock('3. Method', {
      rect: { x: 72, y: 120, width: 200, height: 22 },
      fontSize: 18,
      isBold: true,
    });

    expect(classifyBlock(title, context()).type).toBe('heading');
    // The same marker at body size is a list; the display size is what changes the
    // verdict, so a numbered section title is not reported as list content.
    expect(classifyBlock(textBlock('3. Method'), context()).type).toBe('list');
  });
});

// --- Confidence -----------------------------------------------------------

describe('classifyBlock: confidence', () => {
  it('scores a clean heading above an ambiguous one', () => {
    const clean = classifyBlock(
      textBlock('Results', { rect: { x: 72, y: 90, width: 160, height: 26 }, fontSize: 22, isBold: true }),
      context(),
    );
    const ambiguous = classifyBlock(
      textBlock(
        'A rather long sentence that sits in display size but reads like body copy in the middle of the page',
        { rect: { x: 72, y: 500, width: 430, height: 16 }, fontSize: 12.5, isBold: false },
      ),
      context(),
    );

    expect(clean.type).toBe('heading');
    expect(ambiguous.type).toBe('heading');
    expect(clean.confidence).toBeGreaterThan(ambiguous.confidence);
  });

  it('keeps every verdict inside (0, 1] and never returns an unexplained type', () => {
    const fixtures: BlockFeatures[] = [
      textBlock('3 Method', { fontSize: 18, isBold: true }),
      textBlock('Clause 4 of the agreement is binding on both parties and their successors.'),
      textBlock('• Verify the coolant level'),
      textBlock('Figure 3. Accuracy against temperature'),
      textBlock('(a + b)^2 = a^2 + 2ab + b^2'),
      textBlock('1 Supported by grant 42-1170 from the regional fund.', {
        rect: { x: 72, y: 730, width: 300, height: 9 },
        fontSize: 7.5,
      }),
      textBlock('', { imageCoverage: 0.9 }),
      textBlock('   '),
    ];

    for (const fixture of fixtures) {
      const result = classifyBlock(fixture, context());
      expect(SEMANTIC_BLOCK_TYPES).toContain(result.type);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.reasons.length).toBeGreaterThan(0);
      for (const reason of result.reasons) expect(reason).toMatch(/^[a-z-]+:/);
    }
  });
});

// --- Page driver ----------------------------------------------------------

function pageBlocks(): BlockInput[] {
  return [
    { id: 'h1', page: 1, pageHeight: PAGE_HEIGHT, text: 'Results', fontSize: 20, isBold: true, rect: { x: 72, y: 80, width: 200, height: 24 } },
    { id: 'b1', page: 1, pageHeight: PAGE_HEIGHT, text: 'The experiment ran for six hours under controlled conditions.', fontSize: 10, rect: { x: 72, y: 130, width: 440, height: 14 } },
    { id: 'h2', page: 1, pageHeight: PAGE_HEIGHT, text: 'Sample preparation', fontSize: 15, isBold: true, rect: { x: 72, y: 200, width: 220, height: 20 } },
    { id: 'b2', page: 1, pageHeight: PAGE_HEIGHT, text: 'Reagents were stored at four degrees and equilibrated before use.', fontSize: 10, rect: { x: 72, y: 240, width: 440, height: 14 } },
    { id: 'b3', page: 1, pageHeight: PAGE_HEIGHT, text: 'Each sample was measured twice and the mean was recorded.', fontSize: 10, rect: { x: 72, y: 300, width: 440, height: 14 } },
    { id: 'h3', page: 1, pageHeight: PAGE_HEIGHT, text: 'Reagents and buffers', fontSize: 12, isBold: true, rect: { x: 72, y: 380, width: 220, height: 17 } },
    { id: 'b4', page: 1, pageHeight: PAGE_HEIGHT, text: 'Buffers were filtered through a 0.2 micron membrane before use.', fontSize: 10, rect: { x: 72, y: 420, width: 440, height: 14 } },
  ];
}

describe('classifyBlocks', () => {
  it('ranks three heading sizes into levels 1, 2 and 3', () => {
    const result = classifyBlocks(pageBlocks());
    const byId = new Map(result.map(block => [block.id, block]));

    expect(byId.get('h1')?.type).toBe('heading');
    expect(byId.get('h2')?.type).toBe('heading');
    expect(byId.get('h3')?.type).toBe('heading');
    expect(byId.get('h1')?.headingLevel).toBe(1);
    expect(byId.get('h2')?.headingLevel).toBe(2);
    expect(byId.get('h3')?.headingLevel).toBe(3);

    for (const id of ['b1', 'b2', 'b3', 'b4']) {
      expect(byId.get(id)?.type).toBe('paragraph');
      expect(byId.get(id)?.headingLevel).toBeUndefined();
    }
  });

  it('classifies in reading order whatever order the blocks arrive in', () => {
    const shuffled = [...pageBlocks()].reverse();
    const result = classifyBlocks(shuffled);

    expect(result.map(block => block.id)).toEqual(['h1', 'b1', 'h2', 'b2', 'b3', 'h3', 'b4']);
  });

  it('keeps heading levels stable across pages', () => {
    const blocks: BlockInput[] = [
      { id: 'p1h1', page: 1, pageHeight: PAGE_HEIGHT, text: 'Introduction', fontSize: 20, isBold: true, rect: { x: 72, y: 80, width: 200, height: 24 } },
      { id: 'p1h2', page: 1, pageHeight: PAGE_HEIGHT, text: 'Prior work', fontSize: 15, isBold: true, rect: { x: 72, y: 200, width: 200, height: 20 } },
      { id: 'p1b1', page: 1, pageHeight: PAGE_HEIGHT, text: 'Body copy on the first page sits at the body size of ten points.', fontSize: 10, rect: { x: 72, y: 240, width: 440, height: 14 } },
      { id: 'p2h1', page: 2, pageHeight: PAGE_HEIGHT, text: 'Method', fontSize: 15, isBold: true, rect: { x: 72, y: 100, width: 200, height: 20 } },
      { id: 'p2b1', page: 2, pageHeight: PAGE_HEIGHT, text: 'Body copy on the second page is also ten points tall.', fontSize: 10, rect: { x: 72, y: 150, width: 440, height: 14 } },
      { id: 'p2b2', page: 2, pageHeight: PAGE_HEIGHT, text: 'A second body block keeps the page median at ten points.', fontSize: 10, rect: { x: 72, y: 200, width: 440, height: 14 } },
    ];
    const result = classifyBlocks(blocks);

    expect(result.map(block => `${block.id}:${block.type}:${String(block.headingLevel)}`)).toEqual([
      'p1h1:heading:1',
      'p1h2:heading:2',
      'p1b1:paragraph:undefined',
      'p2h1:heading:2',
      'p2b1:paragraph:undefined',
      'p2b2:paragraph:undefined',
    ]);
  });

  it('does not mutate the caller blocks', () => {
    const blocks = pageBlocks();
    classifyBlocks(blocks);

    for (const block of blocks) expect('type' in block).toBe(false);
    expect(blocks.map(block => block.id)).toEqual(['h1', 'b1', 'h2', 'b2', 'b3', 'h3', 'b4']);
  });

  it('returns nothing for no blocks', () => {
    expect(classifyBlocks([])).toEqual([]);
  });
});

describe('medianFontSize', () => {
  it('returns the middle size for an odd sample and the mean of the middle pair for an even one', () => {
    expect(medianFontSize([10, 12, 14])).toBe(12);
    expect(medianFontSize([10, 12])).toBe(11);
  });

  it('drops unusable sizes and falls back to the default body size', () => {
    expect(medianFontSize([0, -3, Number.NaN, 10])).toBe(10);
    expect(medianFontSize([])).toBe(DEFAULT_BODY_FONT_SIZE);
  });
});
