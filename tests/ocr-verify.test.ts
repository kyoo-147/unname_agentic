import { describe, expect, it } from 'vitest';
import {
  OcrVerifyError,
  verifyOcr,
  verifyOcrTable,
  verifyOcrText,
  type OcrFinding,
} from '../src/core/ocr-verify';
import type { TableQaInput } from '../src/core/table-qa';

function makeTable(
  headers: string[],
  rows: string[][],
  cells?: TableQaInput['cells'],
): TableQaInput {
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

function reasonsOf(findings: readonly OcrFinding[]): string[] {
  return findings.flatMap(finding => finding.reasons);
}

describe('verifyOcrText clean baselines', () => {
  it('passes clean English and Vietnamese text with normal codes and leap dates', () => {
    const clean = [
      'Invoice #2024-001 issued on 2024-02-29.',
      'Subtotal: $1,250.00 (15% discount applied within 15s of verification).',
      'Standard ISO 9001, CO2 and H2O metrics on B52, F13, E04, 1st floor, 8GB RAM.',
      'Tổng cộng: $1,062.50 — ngày 29 tháng 02 năm 2024.',
    ].join('\n');

    const report = verifyOcrText(clean);
    expect(report.ok).toBe(true);
    expect(report.needsReview).toBe(false);
    expect(report.findings).toEqual([]);
    expect(report.highRiskSpans).toEqual([]);
    expect(report.summary).toEqual({ total: 0, errors: 0, warnings: 0, highRisk: 0 });
  });

  it('passes empty or whitespace-only text cleanly', () => {
    expect(verifyOcrText('')).toEqual({
      ok: true,
      needsReview: false,
      findings: [],
      highRiskSpans: [],
      summary: { total: 0, errors: 0, warnings: 0, highRisk: 0 },
    });
    expect(verifyOcrText('   \n\t  ').ok).toBe(true);
  });
});

describe('verifyOcrText glyph confusions (0/O, 1/l/I, 5/S, 8/B)', () => {
  it('flags 0/O confusions in numbers, dates, and words with exact span offsets', () => {
    const text = 'T0tal on 2O25-01-15: $1,2O0.50 plus O.75 fee in 0ctober.';
    const report = verifyOcrText(text);

    expect(report.ok).toBe(false);
    expect(report.needsReview).toBe(true);

    const hits = report.findings.filter(f => f.reasons.includes('glyph-0-o'));
    expect(hits.map(f => f.span.value)).toEqual([
      'T0tal',
      '2O25-01-15',
      '1,2O0.50',
      'O.75',
      '0ctober',
    ]);
    for (const hit of hits) {
      expect(text.slice(hit.span.start, hit.span.end)).toBe(hit.span.value);
      expect(hit.highRisk).toBe(true);
      expect(hit.excerpt.length).toBeGreaterThan(0);
    }

    const amountHit = hits.find(f => f.span.value === '1,2O0.50');
    expect(amountHit?.severity).toBe('error');
    expect(amountHit?.suggestions).toContain('1,200.50');

    const zeroPoint = hits.find(f => f.span.value === 'O.75');
    expect(zeroPoint?.suggestions).toContain('0.75');
  });

  it('flags 1/l/I, 5/S, and 8/B confusions and combines multiple reasons on one span', () => {
    const text = '1nvoice tota1: l50.00, tax 5S.00, balance B00.00, code lO0, Di5count, 8alance.';
    const report = verifyOcrText(text);

    expect(report.ok).toBe(false);
    expect(reasonsOf(report.findings)).toContain('glyph-1-l-i');
    expect(reasonsOf(report.findings)).toContain('glyph-5-s');
    expect(reasonsOf(report.findings)).toContain('glyph-8-b');

    const byValue = new Map(report.findings.map(f => [f.span.value, f]));
    expect(byValue.get('1nvoice')?.reasons).toContain('glyph-1-l-i');
    expect(byValue.get('tota1')?.reasons).toContain('glyph-1-l-i');
    expect(byValue.get('l50.00')?.reasons).toContain('glyph-1-l-i');
    expect(byValue.get('l50.00')?.suggestions).toContain('150.00');
    expect(byValue.get('5S.00')?.reasons).toContain('glyph-5-s');
    expect(byValue.get('5S.00')?.suggestions).toContain('55.00');
    expect(byValue.get('B00.00')?.reasons).toContain('glyph-8-b');
    expect(byValue.get('B00.00')?.suggestions).toContain('800.00');
    expect(byValue.get('Di5count')?.reasons).toContain('glyph-5-s');
    expect(byValue.get('8alance')?.reasons).toContain('glyph-8-b');

    const combined = byValue.get('lO0');
    expect(combined?.reasons).toContain('glyph-0-o');
    expect(combined?.reasons).toContain('glyph-1-l-i');
    expect(combined?.suggestions).toContain('100');
  });

  it('does not false-positive on standalone pronouns, Roman numerals, or valid units', () => {
    const text = 'I confirm Section II lists 5l water, 15s delay, $5B cap, 100kg and 1st place.';
    const report = verifyOcrText(text);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe('verifyOcrText number format and contradiction checks', () => {
  it('flags malformed separators inside a number', () => {
    const text = 'Amount A: 1,23.45 and Amount B: 1..50 and Amount C: 1,,200.';
    const report = verifyOcrText(text);

    expect(report.ok).toBe(false);
    const malformed = report.findings.filter(f => f.reasons.includes('malformed-number-separator'));
    expect(malformed.map(f => f.span.value)).toEqual(['1,23.45', '1..50', '1,,200']);
    expect(malformed.every(f => f.severity === 'error' && f.highRisk)).toBe(true);
  });

  it('flags mixed decimal/thousand separator conventions in the same document', () => {
    const text = 'Subtotal: $1,234.56\nTax: $123,45\nTotal: $1.358,01';
    const report = verifyOcrText(text);

    expect(report.needsReview).toBe(true);
    expect(reasonsOf(report.findings)).toContain('mixed-decimal-separators');
    const mixed = report.findings.filter(f => f.reasons.includes('mixed-decimal-separators'));
    expect(mixed.length).toBeGreaterThanOrEqual(1);
    expect(mixed.every(f => f.highRisk)).toBe(true);
  });

  it('flags ambiguous 3-digit separator against document or expected locale convention', () => {
    const doc = 'Unit price: 10.50 EUR\nQuantity: 1.250 EUR';
    const docReport = verifyOcrText(doc);
    expect(reasonsOf(docReport.findings)).toContain('ambiguous-number-separator');
    expect(docReport.findings.some(f => f.span.value === '1.250')).toBe(true);

    const optReport = verifyOcrText('Fee: 1,250 EUR', { expectedDecimalSeparator: 'comma' });
    expect(reasonsOf(optReport.findings)).toContain('ambiguous-number-separator');
  });

  it('flags contradictory repeated values for the same label while ignoring page headers', () => {
    const text = [
      'Page 1',
      'Total: $1,250.00',
      'Subtotal: $1,000.00',
      'Page 2',
      'Total: $1,256.00',
    ].join('\n');

    const report = verifyOcrText(text);
    expect(report.ok).toBe(false);
    const contradictions = report.findings.filter(f => f.reasons.includes('contradictory-number'));
    expect(contradictions.length).toBeGreaterThanOrEqual(1);
    expect(contradictions.every(f => f.severity === 'error' && f.highRisk)).toBe(true);
    expect(report.findings.some(f => f.span.value.includes('Page'))).toBe(false);
  });
});

describe('verifyOcrText date verification and contradictions', () => {
  it('flags impossible calendar dates across ISO, slash, and Vietnamese forms', () => {
    const text = [
      'Date 1: 2025-02-29',
      'Date 2: 31/04/2025',
      'Date 3: 32/13/2025',
      'Date 4: ngày 30 tháng 02 năm 2025',
    ].join('\n');

    const report = verifyOcrText(text);
    expect(report.ok).toBe(false);
    const invalid = report.findings.filter(f => f.reasons.includes('invalid-date'));
    expect(invalid).toHaveLength(4);
    expect(invalid.every(f => f.severity === 'error' && f.highRisk)).toBe(true);
  });

  it('merges glyph-0-o and invalid-date on a single corrupted date span', () => {
    const text = 'Signed on 2O25-02-30.';
    const report = verifyOcrText(text);

    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.span.value).toBe('2O25-02-30');
    expect(report.findings[0]?.reasons).toContain('glyph-0-o');
    expect(report.findings[0]?.reasons).toContain('invalid-date');
  });

  it('flags mixed DMY/MDY date orders and ambiguous date against expectedDateOrder', () => {
    const mixed = 'Shipped 15/04/2025, delivered 04/20/2025, billed 04/05/2025.';
    const mixedReport = verifyOcrText(mixed);
    expect(reasonsOf(mixedReport.findings)).toContain('mixed-date-format');
    expect(reasonsOf(mixedReport.findings)).toContain('ambiguous-date-order');

    const conflictWithOption = verifyOcrText('Shipped 04/20/2025.', { expectedDateOrder: 'dmy' });
    expect(reasonsOf(conflictWithOption.findings)).toContain('mixed-date-format');
  });

  it('flags reversed date ranges and contradictory repeated date labels', () => {
    const text = [
      'From 2025-05-10 to 2025-05-01',
      'Issue Date: 2025-03-10',
      'Due Date: 2025-03-01',
      'Invoice Date: 2025-04-01',
      'Invoice Date: 2025-04-08',
    ].join('\n');

    const report = verifyOcrText(text);
    expect(report.ok).toBe(false);
    expect(reasonsOf(report.findings)).toContain('reversed-date-range');
    expect(reasonsOf(report.findings)).toContain('contradictory-date');
  });

  it('flags implausible years outside configured bounds', () => {
    const report = verifyOcrText('Issued 2925-01-10.', { minYear: 2000, maxYear: 2035 });
    expect(reasonsOf(report.findings)).toContain('implausible-date');
  });
});

describe('verifyOcrText unit verification and contradictions', () => {
  it('flags OCR-corrupted units such as o/o, m1, U5D, VNO, and S-prefixed currency', () => {
    const text = 'Interest 15 o/o, dose 100 m1, price S1,250.00, total 500 U5D or 200 VNO.';
    const report = verifyOcrText(text);

    expect(report.ok).toBe(false);
    const unitFindings = report.findings.filter(f => f.reasons.includes('corrupted-unit'));
    expect(unitFindings.length).toBeGreaterThanOrEqual(4);
    expect(unitFindings.every(f => f.severity === 'error' && f.highRisk)).toBe(true);
  });

  it('flags contradictory units on repeated labels or inline arithmetic', () => {
    const text = [
      'Weight: 10 kg',
      'Weight: 10 g',
      'Mix: 100 kg + 50 g = 150 kg',
      'Total: $500',
      'Total: €500',
    ].join('\n');

    const report = verifyOcrText(text);
    expect(report.ok).toBe(false);
    expect(reasonsOf(report.findings)).toContain('contradictory-unit');
  });
});

describe('verifyOcrTable column sum and cell checks', () => {
  it('passes a clean table whose totals, percentages, and counts add up', () => {
    const clean = makeTable(
      ['Item', 'Amount', 'Share %'],
      [
        ['North', '$1,250.00', '55%'],
        ['South', '$980.50', '45%'],
        ['Total', '$2,230.50', ''],
      ],
    );
    const report = verifyOcrTable(clean);
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('flags column sum mismatch with row/col/page provenance', () => {
    const table = makeTable(
      ['Region', 'Revenue'],
      [
        ['North', '1,250'],
        ['South', '980.50'],
        ['Total', '2,231'],
      ],
      [
        { row: 1, col: 0, page: 2 },
        { row: 1, col: 1, page: 2 },
        { row: 2, col: 0, page: 2 },
        { row: 2, col: 1, page: 2 },
        { row: 3, col: 0, page: 2 },
        { row: 3, col: 1, page: 2 },
      ],
    );

    const report = verifyOcrTable(table);
    expect(report.ok).toBe(false);
    const sumError = report.findings.find(f => f.reasons.includes('column-sum-mismatch'));
    expect(sumError).toBeDefined();
    expect(sumError?.severity).toBe('error');
    expect(sumError?.highRisk).toBe(true);
    expect(sumError?.span.row).toBe(3);
    expect(sumError?.span.col).toBe(1);
    expect(sumError?.span.page).toBe(2);
    expect(sumError?.span.value).toBe('2,231');
    expect(sumError?.detail).toContain('2230.5');
  });

  it('flags OCR glyph confusion inside a numeric cell alongside column sum error', () => {
    const table = makeTable(
      ['Item', 'Qty'],
      [
        ['Alpha', '1O0'],
        ['Beta', '200'],
        ['Total', '300'],
      ],
    );

    const report = verifyOcrTable(table);
    expect(report.ok).toBe(false);
    expect(reasonsOf(report.findings)).toContain('glyph-0-o');
    expect(reasonsOf(report.findings)).toContain('column-sum-mismatch');

    const glyphCell = report.findings.find(f => f.span.row === 1 && f.span.col === 1);
    expect(glyphCell?.span.value).toBe('1O0');
    expect(glyphCell?.suggestions).toContain('100');
  });

  it('flags percentage column mismatch, row count mismatch, mixed column units, and empty tables', () => {
    const badPercentAndUnits = makeTable(
      ['Item', 'Amount', 'Share %'],
      [
        ['A', '$100', '40%'],
        ['B', '€200', '65%'],
        ['Rows', '5', ''],
      ],
    );

    const report = verifyOcrTable(badPercentAndUnits);
    expect(report.ok).toBe(false);
    expect(reasonsOf(report.findings)).toContain('mixed-column-units');
    expect(reasonsOf(report.findings)).toContain('percentage-sum-mismatch');
    expect(reasonsOf(report.findings)).toContain('row-count-mismatch');

    const empty = verifyOcrTable(makeTable([], []));
    expect(empty.ok).toBe(false);
    expect(reasonsOf(empty.findings)).toContain('empty-table');
  });
});

describe('verifyOcr multi-block, confidence, and validation', () => {
  it('checks cross-block contradictions and preserves block/page provenance in deterministic order', () => {
    const report = verifyOcr(
      {
        blocks: [
          { id: 'p2-r0', page: 2, raw: 'Total: $1.234,56', confidence: 0.92 },
          { id: 'p1-r0', page: 1, raw: 'Total: $1,239.56', confidence: 0.55 },
        ],
      },
      { minConfidence: 0.7 },
    );

    expect(report.ok).toBe(false);
    expect(reasonsOf(report.findings)).toContain('mixed-decimal-separators');
    expect(reasonsOf(report.findings)).toContain('contradictory-number');
    expect(reasonsOf(report.findings)).toContain('low-ocr-confidence');

    // Ordered by page ascending (page 1 before page 2).
    expect(report.findings[0]?.span.page).toBe(1);
    expect(report.findings[0]?.span.blockId).toBe('p1-r0');
  });

  it('rejects invalid options with OcrVerifyError', () => {
    expect(() => verifyOcrText('ok', { minYear: 2050, maxYear: 2000 })).toThrow(OcrVerifyError);
    expect(() =>
      verifyOcrText('ok', { expectedDecimalSeparator: 'colon' as unknown as 'dot' }),
    ).toThrow(OcrVerifyError);
  });
});
