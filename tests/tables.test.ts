import { describe, expect, it } from 'vitest';
import { extractTable, toCsv, toMarkdown } from '../src/core/tables';
import type { Table, TableCell } from '../src/core/tables';

function cell(text: string, x: number, y: number, width: number, height: number): TableCell {
  return { text, rect: { x, y, width, height } };
}

// Three rows by two columns: a header and two data rows.
function regionCells(): TableCell[] {
  return [
    cell('Region', 0, 0, 90, 12),
    cell('Revenue', 180, 0, 90, 12),
    cell('North', 0, 30, 90, 12),
    cell('1,250', 180, 30, 90, 12),
    cell('South', 0, 60, 90, 12),
    cell('980', 180, 60, 90, 12),
  ];
}

describe('extractTable', () => {
  it('reads a clean three-row two-column table', () => {
    const table = extractTable(regionCells());
    expect(table.headers).toEqual(['Region', 'Revenue']);
    expect(table.rows).toEqual([
      ['North', '1,250'],
      ['South', '980'],
    ]);
    expect(table.rowCount).toBe(3);
    expect(table.columnCount).toBe(2);
    expect(table.spans).toEqual([]);
    expect(table.confidence).toBe(1);
    // The first row is read as the header because nothing proves it is data.
    expect(table.reasons).toEqual(['assumed-header']);
  });

  it('gives a merged header cell a two-column span instead of dropping it', () => {
    const table = extractTable([
      cell('Population by province', 0, 0, 270, 12),
      cell('Province', 0, 30, 90, 12),
      cell('Population', 180, 30, 90, 12),
      cell('Hà Nội', 0, 60, 90, 12),
      cell('8,053', 180, 60, 90, 12),
    ]);
    expect(table.headers).toEqual(['Population by province', '']);
    expect(table.columnCount).toBe(2);
    expect(table.spans).toEqual([{ row: 0, col: 0, colSpan: 2 }]);
    expect(table.rows).toEqual([
      ['Province', 'Population'],
      ['Hà Nội', '8,053'],
    ]);
    expect(table.reasons).toContain('merged-cells');
  });

  it('keeps a wrapped two-line cell inside a single row', () => {
    const table = extractTable([
      cell('Province', 0, 0, 90, 12),
      cell('Notes', 180, 0, 90, 12),
      cell('Bac Ninh', 0, 30, 90, 12),
      // Two text lines in one cell: twice the line height, same row top.
      cell('Red River\ndelta', 180, 30, 90, 24),
    ]);
    expect(table.rowCount).toBe(2);
    expect(table.rows).toEqual([['Bac Ninh', 'Red River delta']]);
    expect(table.columnCount).toBe(2);
  });

  it('groups rows whose cells are a few points out of line vertically', () => {
    const table = extractTable([
      cell('Region', 0, 10, 90, 12),
      cell('Revenue', 180, 11, 90, 12),
      cell('North', 0, 41, 90, 12),
      cell('1,250', 180, 39, 90, 12),
      cell('South', 0, 71, 90, 12),
      cell('980', 180, 72.5, 90, 12),
    ]);
    expect(table.rowCount).toBe(3);
    expect(table.columnCount).toBe(2);
    expect(table.headers).toEqual(['Region', 'Revenue']);
    expect(table.rows).toEqual([
      ['North', '1,250'],
      ['South', '980'],
    ]);
  });

  it('refuses a block group that is not table-like', () => {
    const paragraph = [cell('line one', 0, 0, 300, 12), cell('line two', 0, 14, 300, 12), cell('line three', 0, 28, 300, 12)];
    expect(extractTable(paragraph)).toEqual({
      headers: [],
      rows: [],
      rowCount: 0,
      columnCount: 0,
      spans: [],
      confidence: 0,
      reasons: ['not-a-table'],
    });
    expect(extractTable([]).reasons).toEqual(['not-a-table']);
  });

  it('uses a row hint to join cells that geometry alone would split', () => {
    const table = extractTable([
      cell('Region', 0, 0, 90, 12),
      cell('Revenue', 180, 0, 90, 12),
      { ...cell('North', 0, 30, 90, 12), rowHint: 1 },
      { ...cell('1,250', 180, 45, 90, 12), rowHint: 1 },
      cell('South', 0, 60, 90, 12),
      cell('980', 180, 60, 90, 12),
    ]);
    expect(table.rowCount).toBe(3);
    expect(table.rows).toEqual([
      ['North', '1,250'],
      ['South', '980'],
    ]);
  });

  it('reads the same table from the same cells in any input order', () => {
    expect(extractTable([...regionCells()].reverse())).toEqual(extractTable(regionCells()));
  });
});

describe('toCsv', () => {
  it('quotes commas, doubles quotes and preserves line breaks inside a cell', () => {
    const table: Table = {
      headers: ['Name', 'Note'],
      rows: [
        ['Alice', 'said "hi", then left'],
        ['Bob', 'line one\nline two'],
      ],
      rowCount: 3,
      columnCount: 2,
      spans: [],
      confidence: 1,
      reasons: ['assumed-header'],
    };
    expect(toCsv(table)).toBe('Name,Note\nAlice,"said ""hi"", then left"\nBob,"line one\nline two"');
  });

  it('writes the extracted table row by row', () => {
    expect(toCsv(extractTable(regionCells()))).toBe('Region,Revenue\nNorth,"1,250"\nSouth,980');
  });

  it('writes nothing for a refused table', () => {
    expect(toCsv(extractTable([]))).toBe('');
  });
});

describe('toMarkdown', () => {
  it('writes a header row, a separator row and every data row', () => {
    expect(toMarkdown(extractTable(regionCells()))).toBe(
      ['| Region | Revenue |', '| --- | --- |', '| North | 1,250 |', '| South | 980 |'].join('\n'),
    );
  });

  it('escapes pipes and line breaks so a cell cannot end its row', () => {
    const table: Table = {
      headers: ['Note'],
      rows: [['a | b\nc']],
      rowCount: 2,
      columnCount: 1,
      spans: [],
      confidence: 1,
      reasons: ['assumed-header'],
    };
    expect(toMarkdown(table)).toBe('| Note |\n| --- |\n| a \\| b<br>c |');
  });

  it('writes nothing for a refused table', () => {
    expect(toMarkdown(extractTable([]))).toBe('');
  });
});
