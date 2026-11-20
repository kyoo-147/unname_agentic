import { describe, expect, it } from 'vitest';
import {
  GAP_MARKER,
  MATRIX_ASPECT_KINDS,
  MATRIX_EXCERPT_CHARS,
  agreeing,
  buildMatrix,
  conflicts,
  toCsv,
  toMarkdown,
  type AspectMatrix,
  type MatrixAspect,
  type MatrixCell,
  type MatrixDocument,
} from '../src/core/evidence-matrix';
import { buildDocument } from '../src/core/ir';

const SHA = 'a'.repeat(64);

interface DocLine {
  page: number;
  text: string;
}

/**
 * Builds a document through `buildDocument`, the same IR path the app uses. Blocks on
 * one page are stacked so reading order matches fixture order.
 */
function makeDocument(id: string, title: string, lines: readonly DocLine[]): MatrixDocument {
  const rowByPage = new Map<number, number>();
  const blocks = lines.map(line => {
    const row = rowByPage.get(line.page) ?? 0;
    rowByPage.set(line.page, row + 1);
    return {
      page: line.page,
      text: line.text,
      rect: { x: 72, y: 72 + row * 24, width: 468, height: 20 },
    };
  });
  const pages = [...new Set(lines.map(line => line.page))]
    .sort((left, right) => left - right)
    .map(page => ({ index: page, width: 612, height: 792 }));
  return { id, title, ir: buildDocument({ blocks, pages, sourceSha256: SHA, documentId: id }) };
}

/** Revenue as a number: the caption names the fact, the first group is its value. */
const REVENUE: MatrixAspect = {
  id: 'revenue',
  label: 'Revenue',
  kind: 'number',
  pattern: /revenue of\s+([\d.,\s\u00A0]+)/iu,
};

/** A launch date: the first group carries the date as the document wrote it. */
const LAUNCH: MatrixAspect = {
  id: 'launch',
  label: 'Launch date',
  kind: 'date',
  pattern: /launched on\s+([^.;]+)/iu,
};

/** The venue of an event, compared as folded text. */
const VENUE: MatrixAspect = {
  id: 'venue',
  label: 'Venue',
  kind: 'text',
  pattern: /held in\s+([^.;]+)/iu,
};

function cellAt(matrix: AspectMatrix, documentId: string, aspectId: string): MatrixCell | undefined {
  return matrix.cells.find(cell => cell.documentId === documentId && cell.aspectId === aspectId);
}

/** A minimal RFC 4180 reader for one line, used to prove the writer's quoting round-trips. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
        continue;
      }
      field += character;
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
      continue;
    }
    if (character === ',') {
      fields.push(field);
      field = '';
      continue;
    }
    field += character;
  }

  fields.push(field);
  return fields;
}

/** The cells of one markdown row, including the document label as its first entry. */
function markdownCells(markdown: string, rowTitle: string): string[] {
  const line = markdown.split('\n').find(entry => entry.startsWith(`| ${rowTitle} |`));
  expect(line).toBeDefined();
  // Drop the outer pipes, then split on the unescaped cell separators only.
  const inner = line!.replace(/^\| /u, '').replace(/ \|$/u, '');
  return inner.split(' | ').map(cell => cell.trim());
}

function markdownHeader(markdown: string): string[] {
  return markdownCells(markdown, 'Document');
}

/** Three reports that each state a revenue and a launch date. */
function threeFilledDocuments(): MatrixDocument[] {
  return [
    makeDocument('alpha', 'Alpha report', [
      { page: 1, text: 'Revenue of 1,200 units was reported. The Alpha report launched on 2020-04-03.' },
    ]),
    makeDocument('beta', 'Beta report', [
      { page: 1, text: 'Revenue of 1,200 units was reported. The Beta report launched on 2020-04-03.' },
    ]),
    makeDocument('gamma', 'Gamma report', [
      { page: 1, text: 'Revenue of 1,200 units was reported. The Gamma report launched on 2020-04-03.' },
    ]),
  ];
}

describe('buildMatrix', () => {
  it('fills a three-document, two-aspect matrix completely', () => {
    const matrix = buildMatrix(threeFilledDocuments(), [REVENUE, LAUNCH]);

    expect(matrix.refusal).toBeNull();
    expect(matrix.rows.map(row => row.documentId)).toEqual(['alpha', 'beta', 'gamma']);
    expect(matrix.rows.map(row => row.title)).toEqual(['Alpha report', 'Beta report', 'Gamma report']);
    expect(matrix.columns.map(column => column.aspectId)).toEqual(['revenue', 'launch']);
    expect(matrix.columns.map(column => column.kind)).toEqual(['number', 'date']);
    expect(matrix.gaps).toEqual([]);

    // Row-major: every document against every aspect.
    expect(matrix.cells.map(cell => `${cell.documentId}:${cell.aspectId}`)).toEqual([
      'alpha:revenue',
      'alpha:launch',
      'beta:revenue',
      'beta:launch',
      'gamma:revenue',
      'gamma:launch',
    ]);

    for (const cell of matrix.cells) {
      expect(cell.page).toBe(1);
      expect(cell.blockId).toBe('p1-r0');
      expect(cell.excerpt.length).toBeGreaterThan(0);
      expect(cell.raw.length).toBeGreaterThan(0);
      expect(cell.value.length).toBeGreaterThan(0);
    }

    expect(cellAt(matrix, 'alpha', 'revenue')?.value).toBe('1200');
    expect(cellAt(matrix, 'beta', 'launch')?.value).toBe('2020-04-03');
    expect(cellAt(matrix, 'gamma', 'launch')?.excerpt).toBe('The Gamma report launched on 2020-04-03.');
  });

  it('reports a pair with no evidence as a gap, not as a cell', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'Revenue of 1,200 units was reported.' }]),
      makeDocument('beta', 'Beta report', [{ page: 1, text: 'Revenue of 1,200 units was reported.' }]),
      makeDocument('gamma', 'Gamma report', [{ page: 1, text: 'Revenue of 1,200 units was reported.' }]),
    ];

    const matrix = buildMatrix(documents, [REVENUE, LAUNCH]);

    expect(matrix.cells).toHaveLength(3);
    expect(matrix.gaps).toEqual([
      { documentId: 'alpha', aspectId: 'launch' },
      { documentId: 'beta', aspectId: 'launch' },
      { documentId: 'gamma', aspectId: 'launch' },
    ]);
    expect(cellAt(matrix, 'alpha', 'launch')).toBeUndefined();
  });

  it('keeps the first mention in reading order when a fact is stated twice', () => {
    const document = makeDocument('alpha', 'Alpha report', [
      { page: 1, text: 'Revenue of 1,000 units was reported.' },
      { page: 2, text: 'Revenue of 2,000 units was reported later.' },
    ]);

    const matrix = buildMatrix([document], [REVENUE]);
    const cell = matrix.cells[0];

    expect(matrix.cells).toHaveLength(1);
    expect(cell?.page).toBe(1);
    expect(cell?.blockId).toBe('p1-r0');
    expect(cell?.value).toBe('1000');
  });

  it('sorts blocks by reading order, not by the order they are stored in', () => {
    const built = makeDocument('alpha', 'Alpha report', [
      { page: 1, text: 'Revenue of 1,000 units was reported.' },
      { page: 2, text: 'Revenue of 2,000 units was reported.' },
    ]);
    // Storage order is not reading order: the IR's `readingOrder` is what decides.
    const shuffled: MatrixDocument = {
      ...built,
      ir: { ...built.ir, blocks: [...built.ir.blocks].reverse() },
    };

    const matrix = buildMatrix([shuffled], [REVENUE]);

    expect(matrix.cells[0]?.page).toBe(1);
    expect(matrix.cells[0]?.value).toBe('1000');
  });

  it('drops duplicates and unusable definitions instead of inventing columns', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'Revenue of 1,200 units was reported.' }]),
      makeDocument('alpha', 'Duplicate report', [{ page: 1, text: 'Revenue of 9,999 units was reported.' }]),
    ];
    const aspects: MatrixAspect[] = [
      REVENUE,
      { ...REVENUE, label: 'Revenue again' },
      { id: '  ', label: 'No id', kind: 'text', pattern: /revenue/iu },
      { id: 'broken', label: 'Broken', kind: 'text', pattern: 'not a regex' as unknown as RegExp },
    ];

    const matrix = buildMatrix(documents, aspects);

    expect(matrix.refusal).toBeNull();
    expect(matrix.rows).toHaveLength(1);
    expect(matrix.rows[0]?.title).toBe('Alpha report');
    expect(matrix.columns).toHaveLength(1);
    expect(matrix.columns[0]?.label).toBe('Revenue');
    expect(matrix.cells).toHaveLength(1);
    expect(cellAt(matrix, 'alpha', 'revenue')?.value).toBe('1200');
  });

  it('refuses an empty aspect list', () => {
    const matrix = buildMatrix(threeFilledDocuments(), []);

    expect(matrix.refusal).toBe('no-aspects');
    expect(matrix.rows).toEqual([]);
    expect(matrix.columns).toEqual([]);
    expect(matrix.cells).toEqual([]);
    expect(matrix.gaps).toEqual([]);
    expect(toMarkdown(matrix)).toBe('');
    expect(toCsv(matrix)).toBe('');
  });

  it('refuses a matrix with no usable aspect or no usable document', () => {
    const documents = threeFilledDocuments();

    expect(buildMatrix(documents, [{ id: ' ', label: 'Blank', kind: 'text', pattern: /x/u }]).refusal).toBe(
      'no-aspects',
    );
    expect(
      buildMatrix(documents, [
        { id: 'x', label: 'X', kind: 'text', pattern: 'not a regex' as unknown as RegExp },
      ]).refusal,
    ).toBe('no-aspects');
    expect(buildMatrix([], [REVENUE]).refusal).toBe('no-documents');
    expect(buildMatrix([], []).refusal).toBe('no-documents');
  });

  it('lists the supported aspect kinds', () => {
    expect(MATRIX_ASPECT_KINDS).toEqual(['text', 'number', 'date']);
  });
});

describe('value normalisation', () => {
  it('normalises a number written in different locales to one value', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'Revenue of 1,200 units was reported.' }]),
      makeDocument('beta', 'Beta report', [{ page: 1, text: 'Revenue of 1.200 units was reported.' }]),
      makeDocument('gamma', 'Gamma report', [{ page: 1, text: 'Revenue of 1 200 units was reported.' }]),
    ];

    const matrix = buildMatrix(documents, [REVENUE]);

    expect(matrix.cells.map(cell => cell.value)).toEqual(['1200', '1200', '1200']);
    expect(conflicts(matrix)).toEqual([]);
    expect(agreeing(matrix)).toHaveLength(1);

    // The raw text stays as each document wrote it: only the comparison value is normalised.
    expect(matrix.cells.map(cell => cell.raw)).toEqual(['1,200', '1.200', '1 200']);
  });

  it('reads a comma as the decimal separator, like a dot', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'Revenue of 3,14 units was reported.' }]),
      makeDocument('beta', 'Beta report', [{ page: 1, text: 'Revenue of 3.14 units was reported.' }]),
    ];

    const matrix = buildMatrix(documents, [REVENUE]);

    expect(matrix.cells.map(cell => cell.value)).toEqual(['3.14', '3.14']);
    expect(agreeing(matrix)[0]?.value).toBe('3.14');
  });

  it('drops a trailing zero that no document can disagree about', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'Revenue of 12.50 units was reported.' }]),
      makeDocument('beta', 'Beta report', [{ page: 1, text: 'Revenue of 12.5 units was reported.' }]),
    ];

    expect(buildMatrix(documents, [REVENUE]).cells.map(cell => cell.value)).toEqual(['12.5', '12.5']);
  });

  it('reads three digits after a separator as a thousands group, as documented', () => {
    // The documented reading of `1.200` is 1,200; `3.140` follows the same shape rule even
    // though it could also be a decimal with a trailing zero.
    const document = makeDocument('alpha', 'Alpha report', [
      { page: 1, text: 'Revenue of 3.140 units was reported.' },
    ]);

    expect(buildMatrix([document], [REVENUE]).cells[0]?.value).toBe('3140');
  });

  it('normalises dates written in four different forms to one value', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'It launched on 2020-04-03.' }]),
      makeDocument('beta', 'Beta report', [{ page: 1, text: 'It launched on 03/04/2020.' }]),
      makeDocument('gamma', 'Gamma report', [{ page: 1, text: 'It launched on 3 April 2020.' }]),
      makeDocument('delta', 'Delta report', [{ page: 1, text: 'It launched on April 3, 2020.' }]),
    ];

    const matrix = buildMatrix(documents, [LAUNCH]);

    expect(matrix.cells.map(cell => cell.value)).toEqual([
      '2020-04-03',
      '2020-04-03',
      '2020-04-03',
      '2020-04-03',
    ]);
    expect(matrix.cells.map(cell => cell.raw)).toEqual([
      '2020-04-03',
      '03/04/2020',
      '3 April 2020',
      'April 3, 2020',
    ]);
    expect(agreeing(matrix)).toHaveLength(1);
    expect(conflicts(matrix)).toEqual([]);
  });

  it('keeps month and year precision when the document gives no day', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'It launched on 2020-04.' }]),
      makeDocument('beta', 'Beta report', [{ page: 1, text: 'It launched on 2020.' }]),
    ];

    const matrix = buildMatrix(documents, [LAUNCH]);

    expect(matrix.cells.map(cell => cell.value)).toEqual(['2020-04', '2020']);
    expect(conflicts(matrix)).toHaveLength(1);
  });

  it('folds case and diacritics for a text aspect', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'It was held in Hà Nội.' }]),
      makeDocument('beta', 'Beta report', [{ page: 1, text: 'It was held in Ha Noi.' }]),
      makeDocument('gamma', 'Gamma report', [{ page: 1, text: 'It was held in HÀ NỘI.' }]),
    ];

    const matrix = buildMatrix(documents, [VENUE]);
    const agreement = agreeing(matrix)[0];

    expect(matrix.cells.map(cell => cell.value)).toEqual(['ha noi', 'ha noi', 'ha noi']);
    expect(agreement?.value).toBe('ha noi');
    expect(agreement?.cells).toHaveLength(3);
    expect(agreement?.cells[0]?.raw).toBe('Hà Nội');
  });

  it('does not shorten an impossible date into a year that could agree', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'It launched on 2020-02-31.' }]),
      makeDocument('beta', 'Beta report', [{ page: 1, text: 'It launched on 2020-02-03.' }]),
    ];

    const matrix = buildMatrix(documents, [LAUNCH]);

    // The impossible date keeps its own text instead of becoming `2020` or `2020-02`.
    expect(matrix.cells[0]?.value).toBe('2020-02-31');
    expect(matrix.cells[1]?.value).toBe('2020-02-03');
    expect(conflicts(matrix)).toHaveLength(1);
    expect(agreeing(matrix)).toEqual([]);
  });

  it('falls back to folded text when a date cannot be read, inventing nothing', () => {
    const document = makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'It launched on a rainy day.' }]);

    const matrix = buildMatrix([document], [LAUNCH]);

    expect(matrix.cells).toHaveLength(1);
    expect(matrix.cells[0]?.value).toBe('a rainy day');
  });
});

describe('conflicts', () => {
  it('reports a disagreement with a cell from each side', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'Revenue of 1,200 units was reported.' }]),
      makeDocument('beta', 'Beta report', [{ page: 2, text: 'Revenue of 1,300 units was reported.' }]),
      makeDocument('gamma', 'Gamma report', [{ page: 3, text: 'Revenue of 1,200 units was reported.' }]),
    ];

    const found = conflicts(buildMatrix(documents, [REVENUE]));

    expect(found).toHaveLength(1);
    const conflict = found[0]!;
    expect(conflict.aspectId).toBe('revenue');
    expect(conflict.label).toBe('Revenue');
    expect(conflict.cells).toHaveLength(2);
    expect(conflict.cells.map(cell => cell.value)).toEqual(['1200', '1300']);
    expect(conflict.cells.map(cell => cell.documentId)).toEqual(['alpha', 'beta']);
    expect(conflict.cells.map(cell => cell.page)).toEqual([1, 2]);
    expect(conflict.cells.every(cell => cell.excerpt.length > 0)).toBe(true);
    expect(conflict.groups.map(group => group.value)).toEqual(['1200', '1300']);
    expect(conflict.groups[0]?.cells.map(cell => cell.documentId)).toEqual(['alpha', 'gamma']);
    expect(conflict.groups[1]?.cells.map(cell => cell.documentId)).toEqual(['beta']);
    expect(conflict.gaps).toEqual([]);
  });

  it('reports a conflict even when the disagreeing documents agree with each other', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'Revenue of 1,200 units was reported.' }]),
      makeDocument('beta', 'Beta report', [{ page: 1, text: 'Revenue of 1,300 units was reported.' }]),
      makeDocument('gamma', 'Gamma report', [{ page: 1, text: 'Revenue of 1,300 units was reported.' }]),
    ];

    const found = conflicts(buildMatrix(documents, [REVENUE]));

    expect(found).toHaveLength(1);
    expect(found[0]?.cells).toHaveLength(2);
    expect(found[0]?.groups.map(group => group.cells.length)).toEqual([1, 2]);
  });

  it('does not mistake a missing document for one side of a disagreement', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'Revenue of 1,200 units was reported.' }]),
      makeDocument('beta', 'Beta report', [{ page: 1, text: 'Revenue of 1,300 units was reported.' }]),
      makeDocument('gamma', 'Gamma report', [{ page: 1, text: 'The Gamma report covers staffing only.' }]),
    ];

    const found = conflicts(buildMatrix(documents, [REVENUE]));

    expect(found).toHaveLength(1);
    expect(found[0]?.cells.map(cell => cell.documentId)).toEqual(['alpha', 'beta']);
    expect(found[0]?.gaps).toEqual([{ documentId: 'gamma', aspectId: 'revenue' }]);
  });

  it('reports nothing for an aspect every document agrees on', () => {
    expect(conflicts(buildMatrix(threeFilledDocuments(), [REVENUE, LAUNCH]))).toEqual([]);
  });
});

describe('agreeing', () => {
  it('reports an aspect every document states the same way', () => {
    const matrix = buildMatrix(threeFilledDocuments(), [REVENUE, LAUNCH]);
    const found = agreeing(matrix);

    expect(found.map(entry => entry.aspectId)).toEqual(['revenue', 'launch']);
    const revenue = found[0]!;
    expect(revenue.value).toBe('1200');
    expect(revenue.cells).toHaveLength(3);
    expect(revenue.cells.map(cell => cell.blockId)).toEqual(['p1-r0', 'p1-r0', 'p1-r0']);
    expect(revenue.gaps).toEqual([]);
    expect(found[1]?.value).toBe('2020-04-03');
  });

  it('carries the gaps, because a silent document neither agrees nor disagrees', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'Revenue of 1,200 units was reported.' }]),
      makeDocument('beta', 'Beta report', [{ page: 1, text: 'Revenue of 1,200 units was reported.' }]),
      makeDocument('gamma', 'Gamma report', [{ page: 1, text: 'The Gamma report covers staffing only.' }]),
    ];

    const found = agreeing(buildMatrix(documents, [REVENUE]));

    expect(found).toHaveLength(1);
    expect(found[0]?.cells.map(cell => cell.documentId)).toEqual(['alpha', 'beta']);
    expect(found[0]?.gaps).toEqual([{ documentId: 'gamma', aspectId: 'revenue' }]);
  });

  it('does not call a single witness agreement', () => {
    const document = makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'Revenue of 1,200 units was reported.' }]);
    const matrix = buildMatrix([document], [REVENUE, LAUNCH]);

    expect(matrix.cells).toHaveLength(1);
    expect(agreeing(matrix)).toEqual([]);
    expect(conflicts(matrix)).toEqual([]);
  });
});

describe('renderers', () => {
  it('writes a markdown cell that carries page, block and excerpt', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [
        { page: 1, text: 'Office notes for the quarter.' },
        { page: 2, text: 'Revenue of 1,200 units was reported for the year.' },
      ]),
    ];

    const matrix = buildMatrix(documents, [REVENUE]);
    const markdown = toMarkdown(matrix);

    expect(markdownHeader(markdown)).toEqual(['Document', 'Revenue']);
    expect(markdown).toContain('| --- | --- |');

    const cells = markdownCells(markdown, 'Alpha report');
    expect(cells).toHaveLength(2);
    expect(cells[0]).toBe('Alpha report');
    expect(cells[1]).toContain('1,200');
    expect(cells[1]).toContain('p.2');
    expect(cells[1]).toContain('p2-r0');
    expect(cells[1]).toContain('Revenue of 1,200 units was reported for the year.');
  });

  it('writes the gap marker where there is no evidence and never a zero', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'Revenue of 1,200 units was reported.' }]),
      makeDocument('gamma', 'Gamma report', [{ page: 1, text: 'The Gamma report covers staffing only.' }]),
    ];

    const matrix = buildMatrix(documents, [REVENUE]);
    const markdown = toMarkdown(matrix);
    const gamma = markdownCells(markdown, 'Gamma report');

    expect(gamma).toEqual(['Gamma report', GAP_MARKER]);
    expect(markdown).not.toContain('| 0 |');
    expect(toCsv(matrix).split('\n')[2]).toBe(`Gamma report,${GAP_MARKER}`);
  });

  it('escapes a pipe in a cell so it cannot end its row', () => {
    const aspect: MatrixAspect = {
      id: 'owner',
      label: 'Owner',
      kind: 'text',
      pattern: /owned by\s+([^.;]+)/iu,
    };
    const document = makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'It is owned by A | B.' }]);

    const markdown = toMarkdown(buildMatrix([document], [aspect]));
    const row = markdown.split('\n').find(line => line.startsWith('| Alpha report |'));

    expect(row).toBeDefined();
    expect(row).toContain('A \\| B');
    // The escaped pipe is not a separator: the row still holds exactly two cells.
    expect(markdownCells(markdown, 'Alpha report')).toHaveLength(2);
  });

  it('quotes csv fields that carry a comma or a quote, and round-trips them', () => {
    const aspect: MatrixAspect = {
      id: 'revenue',
      label: 'Revenue, net',
      kind: 'number',
      pattern: /revenue of\s+([\d.,\s]+)/iu,
    };
    const document = makeDocument('alpha', 'Alpha report', [
      { page: 1, text: 'The report says "Revenue of 1,200 units", which is up.' },
    ]);

    const csv = toCsv(buildMatrix([document], [aspect]));
    const lines = csv.split('\n');

    expect(lines).toHaveLength(2);
    expect(csv.endsWith('\n')).toBe(false);
    // The label holds a comma, so the header field it sits in has to be quoted.
    expect(lines[0]).toBe('Document,"Revenue, net"');
    expect(lines[1]).toContain('""Revenue of 1,200 units""');

    const fields = parseCsvLine(lines[1]!);
    expect(fields).toHaveLength(2);
    expect(fields[0]).toBe('Alpha report');
    expect(fields[1]).toBe(
      '1,200 — p.1 · p1-r0: The report says "Revenue of 1,200 units", which is up.',
    );
  });

  it('quotes a title that would otherwise break the csv row', () => {
    const documents = [
      makeDocument('alpha', 'Alpha, "final" report', [
        { page: 1, text: 'Revenue of 1,200 units was reported.' },
      ]),
    ];

    const csv = toCsv(buildMatrix(documents, [REVENUE]));
    const fields = parseCsvLine(csv.split('\n')[1]!);

    expect(fields[0]).toBe('Alpha, "final" report');
    expect(fields[1]).toContain('1,200 — p.1 · p1-r0');
  });

  it('renders every cell as a gap when no document mentions the aspect', () => {
    const documents = [
      makeDocument('alpha', 'Alpha report', [{ page: 1, text: 'Staffing notes only.' }]),
      makeDocument('beta', 'Beta report', [{ page: 1, text: 'Budget notes only.' }]),
    ];

    const matrix = buildMatrix(documents, [REVENUE]);
    const markdown = toMarkdown(matrix);

    expect(matrix.cells).toEqual([]);
    expect(matrix.gaps).toHaveLength(2);
    expect(conflicts(matrix)).toEqual([]);
    expect(agreeing(matrix)).toEqual([]);
    expect(markdownCells(markdown, 'Alpha report')).toEqual(['Alpha report', GAP_MARKER]);
    expect(markdownCells(markdown, 'Beta report')).toEqual(['Beta report', GAP_MARKER]);
  });

  it('caps an excerpt that does not fit a table cell', () => {
    const filler = Array.from({ length: 40 }, (_unused, index) => `word${index}`).join(' ');
    const text = `${filler} Revenue of 1,200 units ${filler}.`;
    const document = makeDocument('alpha', 'Alpha report', [{ page: 1, text }]);

    const matrix = buildMatrix([document], [REVENUE]);
    const cell = matrix.cells[0]!;

    expect(cell.excerpt).toContain('1,200');
    expect([...cell.excerpt].length).toBeLessThanOrEqual(MATRIX_EXCERPT_CHARS);
    expect(cell.excerpt.startsWith('\u2026') || cell.excerpt.endsWith('\u2026')).toBe(true);
  });

  it('writes nothing for a matrix with no evidence at all', () => {
    const empty: AspectMatrix = { rows: [], columns: [], cells: [], gaps: [], refusal: 'no-documents' };

    expect(toMarkdown(empty)).toBe('');
    expect(toCsv(empty)).toBe('');
  });
});
