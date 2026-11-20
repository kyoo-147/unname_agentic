import { describe, expect, it } from 'vitest';
import { answerTable, checkArithmetic, parseTableNumber } from '../src/core/table-qa';
import type { TableQaInput } from '../src/core/table-qa';

function table(headers: string[], rows: string[][], cells?: TableQaInput['cells']): TableQaInput {
  return {
    headers,
    rows,
    rowCount: rows.length + 1,
    columnCount: headers.length,
    spans: [],
    confidence: 1,
    reasons: ['assumed-header'],
    ...(cells ? { cells } : {}),
  };
}

// A table that already carries its own total row, with the page of every cell.
const REVENUE = table(
  ['Region', 'Revenue'],
  [
    ['North', '1,250'],
    ['South', '980.50'],
    ['Total', '2,230.50'],
  ],
  [
    { row: 1, col: 0, page: 3 },
    { row: 1, col: 1, page: 3 },
    { row: 2, col: 0, page: 4 },
    { row: 2, col: 1, page: 4 },
    { row: 3, col: 0, page: 4 },
    { row: 3, col: 1, page: 4 },
  ],
);

describe('answerTable sums a formatted column', () => {
  it('adds a column of money and leaves the total row out of the addition', () => {
    const answer = answerTable('What is the total revenue?', REVENUE);
    expect(answer.kind).toBe('sum');
    expect(answer.answer).toBe(2230.5);
    expect(answer.sum).toBe(2230.5);
    expect(answer.count).toBeNull();
    expect(answer.compare).toBeNull();
    expect(answer.unknown).toBeNull();
    expect(answer.evidence).toEqual([
      { row: 1, col: 1, text: '1,250', page: 3 },
      { row: 2, col: 1, text: '980.50', page: 4 },
    ]);
    // The table's own Total row states a number, and counting it would double the sum.
    const skipped = answer.checks.find(check => check.name === 'total-row-skipped');
    expect(skipped?.ok).toBe(true);
    expect(answer.checks.every(check => check.ok)).toBe(true);
  });

  it('reads the largest and the smallest of the same column', () => {
    const high = answerTable('What is the highest revenue?', REVENUE);
    expect(high.kind).toBe('value');
    expect(high.answer).toBe(1250);
    expect(high.evidence).toEqual([{ row: 1, col: 1, text: '1,250', page: 3 }]);

    const low = answerTable('What is the lowest revenue?', REVENUE);
    expect(low.kind).toBe('value');
    expect(low.answer).toBe(980.5);
    expect(low.evidence).toEqual([{ row: 2, col: 1, text: '980.50', page: 4 }]);
  });
});

describe('answerTable counts rows', () => {
  const STATUS = table(['Status', 'Amount'], [
    ['Paid', '10'],
    ['Open', '20'],
    ['Paid', '30'],
  ]);

  it('counts the rows that carry one label', () => {
    const answer = answerTable('How many rows have status Paid?', STATUS);
    expect(answer.kind).toBe('count');
    expect(answer.answer).toBe(2);
    expect(answer.count).toBe(2);
    expect(answer.sum).toBeNull();
    expect(answer.compare).toBeNull();
    expect(answer.unknown).toBeNull();
    expect(answer.evidence.map(cell => cell.row)).toEqual([1, 3]);
    expect(answer.evidence.every(cell => cell.text === 'Paid')).toBe(true);
  });

  it('counts the data rows of the table when no value is named', () => {
    const answer = answerTable('How many rows are in the table?', STATUS);
    expect(answer.kind).toBe('count');
    expect(answer.count).toBe(3);
    expect(answer.evidence).toHaveLength(3);
  });
});

describe('answerTable compares and looks up cells', () => {
  it('returns the difference between two rows of one column', () => {
    const answer = answerTable('What is the difference between the revenue for North and the revenue for South?', REVENUE);
    expect(answer.kind).toBe('compare');
    expect(answer.compare).toBe(269.5);
    expect(answer.answer).toBe(269.5);
    expect(answer.sum).toBeNull();
    expect(answer.count).toBeNull();
    expect(answer.unknown).toBeNull();
    expect(answer.evidence.map(cell => cell.text)).toEqual(['1,250', '980.50']);
  });

  it('finds one cell by its row and column label and carries its page', () => {
    const answer = answerTable('What is the revenue for North?', REVENUE);
    expect(answer.kind).toBe('value');
    expect(answer.answer).toBe(1250);
    expect(answer.evidence).toEqual([{ row: 1, col: 1, text: '1,250', page: 3 }]);
    expect(answer.checks.map(check => check.name)).toContain('row-found');
  });

  it('narrows a sum to the one row the question names', () => {
    const answer = answerTable('What is the total revenue for South?', REVENUE);
    expect(answer.kind).toBe('value');
    expect(answer.answer).toBe(980.5);
    const narrowed = answer.checks.find(check => check.name === 'row-narrowed');
    expect(narrowed?.ok).toBe(true);
  });

  it('treats a question that only names a row and a column as a lookup', () => {
    const answer = answerTable('Revenue for North?', REVENUE);
    expect(answer.kind).toBe('value');
    expect(answer.answer).toBe(1250);
    expect(answer.evidence).toEqual([{ row: 1, col: 1, text: '1,250', page: 3 }]);
  });

  it('matches a Vietnamese question against Vietnamese labels', () => {
    const vietnamese = table(['Khu vực', 'Doanh thu'], [
      ['Bắc', '1,250'],
      ['Nam', '980.50'],
    ]);
    const answer = answerTable('Doanh thu của Bắc là bao nhiêu?', vietnamese);
    expect(answer.kind).toBe('value');
    expect(answer.answer).toBe(1250);
    expect(answer.evidence.map(cell => cell.text)).toEqual(['1,250']);
  });
});

describe('answerTable refuses what it cannot ground', () => {
  it('returns unknown with a reason and no invented number for a question about nothing', () => {
    const answer = answerTable('Why is the sky blue?', REVENUE);
    expect(answer.kind).toBe('unknown');
    expect(answer.answer).toBeNull();
    expect(answer.unknown?.reason).toBe('no-intent');
    expect((answer.unknown?.detail.length ?? 0) > 0).toBe(true);
    expect(answer.evidence).toEqual([]);
    expect(answer.sum).toBeNull();
    expect(answer.count).toBeNull();
    expect(answer.compare).toBeNull();
    const intent = answer.checks.find(check => check.name === 'intent');
    expect(intent?.ok).toBe(false);
  });

  it('refuses a sum when two numeric columns could be meant', () => {
    const ambiguous = table(['Month', 'Sales', 'Cost'], [
      ['Jan', '10', '4'],
      ['Feb', '20', '6'],
    ]);
    const answer = answerTable('What is the total?', ambiguous);
    expect(answer.kind).toBe('unknown');
    expect(answer.unknown?.reason).toBe('no-column');
    expect(answer.evidence).toEqual([]);
  });

  it('refuses an empty table', () => {
    const answer = answerTable('What is the total?', table([], []));
    expect(answer.kind).toBe('unknown');
    expect(answer.unknown?.reason).toBe('empty-table');
    expect(answer.evidence).toEqual([]);
  });
});

describe('checkArithmetic', () => {
  it('passes a total row that adds up', () => {
    const report = checkArithmetic(REVENUE);
    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it('fails a total row that is off by one, with expected and actual', () => {
    const wrong = table(['Region', 'Revenue'], [
      ['North', '1,250'],
      ['South', '980.50'],
      ['Total', '2,231'],
    ]);
    const report = checkArithmetic(wrong);
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toEqual({
      kind: 'total',
      row: 3,
      expected: 2230.5,
      actual: 2231,
      detail: expect.any(String),
    });
    expect(report.problems[0]?.detail).toContain('2231');
    expect(report.problems[0]?.detail).toContain('2230.5');
  });

  it('passes a percentage column that sums to 100 and fails one that is off by two', () => {
    const exact = table(['Item', 'Share'], [
      ['A', '40%'],
      ['B', '60%'],
    ]);
    expect(checkArithmetic(exact)).toEqual({ ok: true, problems: [] });

    const off = table(['Item', 'Share'], [
      ['A', '40%'],
      ['B', '62%'],
    ]);
    const report = checkArithmetic(off);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      { kind: 'percent', row: 0, expected: 100, actual: 102, detail: expect.any(String) },
    ]);
  });

  it('fails a stated row count that does not match the data rows', () => {
    const stated = table(['Metric', 'Value'], [
      ['Rows', '3'],
      ['A', '10'],
      ['B', '20'],
    ]);
    const report = checkArithmetic(stated);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      { kind: 'count', row: 1, expected: 2, actual: 3, detail: expect.any(String) },
    ]);

    const truthful = table(['Metric', 'Value'], [
      ['Rows', '2'],
      ['A', '10'],
      ['B', '20'],
    ]);
    expect(checkArithmetic(truthful)).toEqual({ ok: true, problems: [] });
  });

  it('reads a total row labelled in Vietnamese', () => {
    for (const label of ['Tổng', 'Cộng']) {
      const vietnamese = table(['Khu vực', 'Doanh thu'], [
        ['Bắc', '1,250'],
        ['Nam', '980.50'],
        [label, '2,231'],
      ]);
      const report = checkArithmetic(vietnamese);
      expect(report.ok, label).toBe(false);
      expect(report.problems[0]?.kind, label).toBe('total');
      expect(report.problems[0]?.expected, label).toBe(2230.5);
      expect(report.problems[0]?.actual, label).toBe(2231);
    }
  });

  it('refuses an empty table instead of passing it', () => {
    const report = checkArithmetic(table([], []));
    expect(report.ok).toBe(false);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.kind).toBe('empty-table');
    expect(report.problems[0]?.row).toBe(-1);
  });

  it('takes replacement labels for a language it does not list', () => {
    const localized = table(['Région', 'Montant'], [
      ['Nord', '10'],
      ['Sud', '20'],
      ['Somme', '31'],
    ]);
    const report = checkArithmetic(localized, { totalLabels: ['Somme'] });
    expect(report.ok).toBe(false);
    expect(report.problems[0]?.kind).toBe('total');
    expect(report.problems[0]?.expected).toBe(30);
    expect(report.problems[0]?.actual).toBe(31);
  });
});

describe('parseTableNumber', () => {
  it('reads the spellings a table uses for one value', () => {
    expect(parseTableNumber('1,250')).toBe(1250);
    expect(parseTableNumber('1.234,56')).toBe(1234.56);
    expect(parseTableNumber('980.50')).toBe(980.5);
    expect(parseTableNumber('12%')).toBe(12);
    expect(parseTableNumber('$ 1,250')).toBe(1250);
    expect(parseTableNumber('VND 1,250')).toBe(1250);
    expect(parseTableNumber('(1,250)')).toBe(-1250);
    expect(parseTableNumber('-4.5')).toBe(-4.5);
    expect(parseTableNumber('1 250')).toBe(1250);
  });

  it('refuses what is not a number', () => {
    expect(parseTableNumber('Total')).toBeNull();
    expect(parseTableNumber('n/a')).toBeNull();
    expect(parseTableNumber('')).toBeNull();
    expect(parseTableNumber('12 kg')).toBeNull();
    expect(parseTableNumber('—')).toBeNull();
  });
});
