import { describe, expect, it } from 'vitest';
import { diffTable, mergeTable, translateTable } from '../viewer/src/core/table-translate';
import { extractTable, toCsv } from '../viewer/src/core/tables';
import type { Table, TableCell } from '../viewer/src/core/tables';

function tableOf(headers: string[], rows: string[][], overrides: Partial<Table> = {}): Table {
  return {
    headers,
    rows,
    rowCount: (headers.length > 0 ? 1 : 0) + rows.length,
    columnCount: Math.max(headers.length, ...rows.map(row => row.length), 0),
    spans: [],
    confidence: 1,
    reasons: ['assumed-header'],
    ...overrides,
  };
}

function refusedTable(): Table {
  return { headers: [], rows: [], rowCount: 0, columnCount: 0, spans: [], confidence: 0, reasons: ['not-a-table'] };
}

/** A fake translator that records what it was asked and maps known cells. */
function recorder(map: Record<string, string> = {}): { calls: string[]; translate: (cell: string) => Promise<string> } {
  const calls: string[] = [];
  return {
    calls,
    translate: async (cell: string): Promise<string> => {
      calls.push(cell);
      return map[cell] ?? `[${cell}]`;
    },
  };
}

function cell(text: string, x: number, y: number, width: number, height: number): TableCell {
  return { text, rect: { x, y, width, height } };
}

describe('translateTable', () => {
  it('translates a 2x2 table cell by cell and keeps its shape', async () => {
    const table = tableOf(['Name', 'Colour'], [['Pen', 'Red']]);
    const fake = recorder({ Name: 'Tên', Colour: 'Màu', Pen: 'Bút', Red: 'Đỏ' });

    const result = await translateTable(table, fake.translate);

    expect(result.table.headers).toEqual(['Name', 'Colour']);
    expect(result.table.rows).toEqual([['Bút', 'Đỏ']]);
    expect(result.table.rowCount).toBe(2);
    expect(result.table.columnCount).toBe(2);
    expect(result.table.spans).toEqual([]);
    expect(result.table.confidence).toBe(1);
    expect(result.table.reasons).toEqual(['assumed-header']);
    // Headers are preserved by default, so only the two data cells reach the translator.
    expect(fake.calls).toEqual(['Pen', 'Red']);
    expect(result.stats).toEqual({ cells: 4, translated: 2, skipped: 2, cached: 0 });
    expect(result.failures).toEqual([]);

    // The input table is not mutated.
    expect(table.headers).toEqual(['Name', 'Colour']);
    expect(table.rows).toEqual([['Pen', 'Red']]);
  });

  it('keeps numeric cells byte-identical and never sends them to the translator', async () => {
    const table = tableOf(
      ['Region', 'Revenue'],
      [
        ['North', '1,250'],
        ['South', '980'],
      ],
    );
    const fake = recorder();

    const result = await translateTable(table, fake.translate);

    expect(result.table.rows).toEqual([
      ['[North]', '1,250'],
      ['[South]', '980'],
    ]);
    expect(fake.calls).toEqual(['North', 'South']);
    expect(result.stats).toEqual({ cells: 6, translated: 2, skipped: 4, cached: 0 });
  });

  it('keeps currency, date, time and punctuation cells identical', async () => {
    const table = tableOf(
      ['Amount', 'When'],
      [
        ['$1,250.00', '31/01/2024'],
        ['1.050.000đ', '2024-01-31T10:00:00Z'],
        ['12%', '—'],
        ['(980)', '10:30:15'],
      ],
    );
    const fake = recorder();

    const result = await translateTable(table, fake.translate);

    expect(fake.calls).toEqual([]);
    expect(result.table.rows).toEqual(table.rows);
    expect(result.stats).toEqual({ cells: 10, translated: 0, skipped: 10, cached: 0 });
    expect(result.failures).toEqual([]);
  });

  it('translates a repeated cell once and counts the cache hits', async () => {
    const table = tableOf(
      ['Label', 'Value'],
      [
        ['Total', 'Total'],
        ['Total', 'Total'],
      ],
    );
    const fake = recorder({ Total: 'Tổng' });

    const result = await translateTable(table, fake.translate);

    expect(fake.calls).toEqual(['Total']);
    expect(result.table.rows).toEqual([
      ['Tổng', 'Tổng'],
      ['Tổng', 'Tổng'],
    ]);
    expect(result.stats).toEqual({ cells: 6, translated: 1, skipped: 2, cached: 3 });
  });

  it('preserves the header row unless asked to translate it', async () => {
    const table = tableOf(['Region', 'Revenue'], [['North', '980']]);
    const fake = recorder({ Region: 'Vùng', Revenue: 'Doanh thu', North: 'Bắc' });

    const kept = await translateTable(table, fake.translate);
    expect(kept.table.headers).toEqual(['Region', 'Revenue']);
    expect(fake.calls).toEqual(['North']);

    const translated = await translateTable(table, fake.translate, { translateHeaders: true });
    expect(translated.table.headers).toEqual(['Vùng', 'Doanh thu']);
    expect(translated.table.rows).toEqual([['Bắc', '980']]);
    // North plus both headers; the numeric revenue cell stays untranslated.
    expect(translated.stats).toEqual({ cells: 4, translated: 3, skipped: 1, cached: 0 });
  });

  it('keeps the source text of a failing cell and reports it', async () => {
    const table = tableOf(
      ['Name', 'Note'],
      [
        ['Boom', 'Fine'],
        ['Boom', 'Fine'],
      ],
    );
    const translate = async (value: string): Promise<string> => {
      if (value === 'Boom') throw new Error('provider refused');
      return `[${value}]`;
    };

    const result = await translateTable(table, translate);

    expect(result.table.rows).toEqual([
      ['Boom', '[Fine]'],
      ['Boom', '[Fine]'],
    ]);
    expect(result.failures).toEqual([
      { row: 1, col: 0, source: 'Boom', error: 'provider refused' },
      { row: 2, col: 0, source: 'Boom', error: 'provider refused' },
    ]);
    // cells = translated + cached + skipped + failures
    expect(result.stats).toEqual({ cells: 6, translated: 1, skipped: 2, cached: 1 });
  });

  it('reports a translator that returns no text and keeps the source text', async () => {
    const table = tableOf(['Name'], [['Blank']]);
    const result = await translateTable(table, async () => '');

    expect(result.table.headers).toEqual(['Name']);
    expect(result.table.rows).toEqual([['Blank']]);
    expect(result.failures).toEqual([{ row: 1, col: 0, source: 'Blank', error: 'The translator returned no text.' }]);
    expect(result.stats).toEqual({ cells: 2, translated: 0, skipped: 1, cached: 0 });
  });

  it('counts empty cells as skipped without calling the translator', async () => {
    const table = tableOf(['Region', ''], [['', '']]);
    const fake = recorder();

    const result = await translateTable(table, fake.translate);

    expect(fake.calls).toEqual([]);
    expect(result.table.headers).toEqual(['Region', '']);
    expect(result.table.rows).toEqual([['', '']]);
    expect(result.stats).toEqual({ cells: 4, translated: 0, skipped: 4, cached: 0 });
  });

  it('keeps merged-cell spans when the header row is translated', async () => {
    const table = tableOf(
      ['Population by province', ''],
      [
        ['Province', 'Population'],
        ['Hà Nội', '8,053'],
      ],
      { spans: [{ row: 0, col: 0, colSpan: 2 }], confidence: 0.9, reasons: ['merged-cells', 'assumed-header'] },
    );
    const fake = recorder({
      'Population by province': 'Dân số theo tỉnh',
      Province: 'Tỉnh',
      Population: 'Dân số',
      'Hà Nội': 'Hà Nội',
    });

    const result = await translateTable(table, fake.translate, { translateHeaders: true });

    expect(result.table.headers).toEqual(['Dân số theo tỉnh', '']);
    expect(result.table.rows).toEqual([
      ['Tỉnh', 'Dân số'],
      ['Hà Nội', '8,053'],
    ]);
    expect(result.table.spans).toEqual([{ row: 0, col: 0, colSpan: 2 }]);
    expect(result.table.rowCount).toBe(3);
    expect(result.table.columnCount).toBe(2);
    expect(result.table.confidence).toBe(0.9);
    expect(result.table.reasons).toEqual(['merged-cells', 'assumed-header']);
  });

  it('keeps an extracted table exportable with the same grid', async () => {
    const extracted = extractTable([
      cell('Region', 0, 0, 90, 12),
      cell('Revenue', 180, 0, 90, 12),
      cell('North', 0, 30, 90, 12),
      cell('1,250', 180, 30, 90, 12),
    ]);
    const fake = recorder({ North: 'Bắc' });

    const result = await translateTable(extracted, fake.translate);

    expect(result.table.rowCount).toBe(extracted.rowCount);
    expect(result.table.columnCount).toBe(extracted.columnCount);
    expect(toCsv(result.table)).toBe('Region,Revenue\nBắc,"1,250"');
  });

  it('treats row 0 as data when the table has no header row', async () => {
    const table = tableOf([], [['Total'], ['Other']]);
    const translate = async (value: string): Promise<string> => {
      if (value === 'Other') throw new Error('provider refused');
      return 'Tổng';
    };

    const result = await translateTable(table, translate);

    expect(result.table.headers).toEqual([]);
    expect(result.table.rows).toEqual([['Tổng'], ['Other']]);
    // Row numbering matches diffTable: with no header row, data row 0 is row 0.
    expect(result.failures).toEqual([{ row: 1, col: 0, source: 'Other', error: 'provider refused' }]);
    expect(result.stats).toEqual({ cells: 2, translated: 1, skipped: 0, cached: 0 });
  });

  it('is a no-op for an empty table', async () => {
    const empty = refusedTable();
    const fake = recorder();

    const result = await translateTable(empty, fake.translate);

    expect(result.table).toEqual(empty);
    expect(result.stats).toEqual({ cells: 0, translated: 0, skipped: 0, cached: 0 });
    expect(result.failures).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

describe('diffTable', () => {
  it('reports exactly the changed cells in reading order', () => {
    const before = tableOf(
      ['Region', 'Revenue'],
      [
        ['North', '1,250'],
        ['South', '980'],
      ],
    );
    const after = tableOf(
      ['Region', 'Revenue'],
      [
        ['Miền Bắc', '1,250'],
        ['South', '1,000'],
      ],
    );

    expect(diffTable(before, after)).toEqual([
      { row: 1, col: 0, before: 'North', after: 'Miền Bắc' },
      { row: 2, col: 1, before: '980', after: '1,000' },
    ]);
  });

  it('reports a changed header at row 0', () => {
    const before = tableOf(['Region', 'Revenue'], [['North', '1,250']]);
    const after = tableOf(['Vùng', 'Revenue'], [['North', '1,250']]);

    expect(diffTable(before, after)).toEqual([{ row: 0, col: 0, before: 'Region', after: 'Vùng' }]);
  });

  it('reports an added row as changes against empty cells', () => {
    const before = tableOf(['Region', 'Revenue'], [['North', '1,250']]);
    const after = tableOf(
      ['Region', 'Revenue'],
      [
        ['North', '1,250'],
        ['South', '980'],
      ],
    );

    expect(diffTable(before, after)).toEqual([
      { row: 2, col: 0, before: '', after: 'South' },
      { row: 2, col: 1, before: '', after: '980' },
    ]);
  });

  it('reports nothing for two equal tables', () => {
    const table = tableOf(['Region', 'Revenue'], [['North', '1,250']]);
    expect(diffTable(table, table)).toEqual([]);
    expect(diffTable(refusedTable(), refusedTable())).toEqual([]);
  });
});

describe('mergeTable', () => {
  it('replaces only the accepted cells', () => {
    const before = tableOf(['Region', 'Revenue'], [['North', '1,250']]);
    const after = tableOf(['Vùng', 'Doanh thu'], [['Miền Bắc', '1.250']]);

    const merged = mergeTable(before, after, [{ row: 1, col: 0 }]);

    expect(merged.headers).toEqual(['Region', 'Revenue']);
    expect(merged.rows).toEqual([['Miền Bắc', '1,250']]);
    expect(merged.rowCount).toBe(2);
    expect(merged.columnCount).toBe(2);
    expect(diffTable(before, merged)).toEqual([{ row: 1, col: 0, before: 'North', after: 'Miền Bắc' }]);
  });

  it('accepts a subset of a diff', () => {
    const before = tableOf(['Region', 'Revenue'], [['North', '1,250']]);
    const after = tableOf(['Vùng', 'Revenue'], [['Miền Bắc', '1,250']]);
    const changes = diffTable(before, after);

    const merged = mergeTable(before, after, changes);
    expect(merged.headers).toEqual(['Vùng', 'Revenue']);
    expect(merged.rows).toEqual([['Miền Bắc', '1,250']]);
  });

  it('ignores keys outside either table and never mutates its inputs', () => {
    const before = tableOf(['Region', 'Revenue'], [['North', '1,250']]);
    const after = tableOf(['Region', 'Revenue'], [['Miền Bắc', '1.250']]);

    expect(mergeTable(before, after, [])).toEqual(before);
    expect(mergeTable(before, after, [{ row: 9, col: 9 }, { row: 1, col: 5 }, { row: -1, col: 0 }])).toEqual(before);
    expect(mergeTable(before, after, [{ row: 1, col: 0 }]).rows).toEqual([['Miền Bắc', '1,250']]);
    expect(before.rows).toEqual([['North', '1,250']]);
    expect(after.rows).toEqual([['Miền Bắc', '1.250']]);
  });

  it('is a no-op for an empty table', () => {
    const empty = refusedTable();
    expect(mergeTable(empty, empty, [])).toEqual(empty);
  });
});
