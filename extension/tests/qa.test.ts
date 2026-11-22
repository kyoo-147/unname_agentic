import { describe, expect, it } from 'vitest';
import { reviewTranslation, type Issue } from '../viewer/src/core/qa';

function byKind(issues: readonly Issue[], kind: Issue['kind']): Issue[] {
  return issues.filter(issue => issue.kind === kind);
}

describe('reviewTranslation numbers', () => {
  it('keeps a clean pair free of issues', () => {
    const review = reviewTranslation(
      'The buyer shall pay 1,234.56 EUR within 30 days.',
      'Bên mua phải thanh toán 1.234,56 EUR trong vòng 30 ngày.',
    );
    expect(review.issues).toEqual([]);
    expect(review.ok).toBe(true);
  });

  it('catches a changed number as an error with evidence on both sides', () => {
    const review = reviewTranslation('The fee is 42 EUR.', 'Phí là 43 EUR.');
    expect(review.ok).toBe(false);
    const numbers = byKind(review.issues, 'number');
    expect(numbers.map(issue => issue.detail)).toEqual([
      'Source number 42 is missing from the target.',
      'Target number 43 is not in the source.',
    ]);
    expect(numbers.every(issue => issue.severity === 'error')).toBe(true);
    expect(numbers[0]?.sourceExcerpt).toContain('42');
    expect(numbers[0]?.targetExcerpt).toBe('');
    expect(numbers[1]?.sourceExcerpt).toBe('');
    expect(numbers[1]?.targetExcerpt).toContain('43');
  });

  it('accepts the other locale separator for the same value', () => {
    const review = reviewTranslation('Total: 1,234.56 USD.', 'Tổng: 1.234,56 USD.');
    expect(byKind(review.issues, 'number')).toEqual([]);
    expect(review.ok).toBe(true);
  });

  it('handles 1.000,50 and reads plain grouping as an integer', () => {
    const decimal = reviewTranslation('Amount 1.000,50 EUR.', 'Số tiền 1,000.50 EUR.');
    expect(byKind(decimal.issues, 'number')).toEqual([]);
    expect(decimal.ok).toBe(true);

    const grouped = reviewTranslation('Pay 1,234 units.', 'Trả 1.234 đơn vị.');
    expect(byKind(grouped.issues, 'number')).toEqual([]);
    expect(grouped.ok).toBe(true);
  });

  it('reads a sign only where it belongs to the number', () => {
    const negated = reviewTranslation('A balance of -50 EUR is not allowed.', 'Số dư -50 EUR không được phép.');
    expect(byKind(negated.issues, 'number')).toEqual([]);

    const range = reviewTranslation('Pages 12-15 are missing.', 'Thiếu các trang 12-15.');
    expect(byKind(range.issues, 'number')).toEqual([]);
  });
});

describe('reviewTranslation units', () => {
  it('reports a dropped unit as a warning and keeps the review ok', () => {
    const review = reviewTranslation('Interest 5% per year.', 'Lãi suất 5 mỗi năm.');
    expect(review.issues).toHaveLength(1);
    expect(review.issues[0]).toMatchObject({
      kind: 'unit',
      severity: 'warn',
      targetExcerpt: '',
    });
    expect(review.issues[0]?.detail).toContain('%');
    expect(review.issues[0]?.sourceExcerpt).toContain('5%');
    expect(review.ok).toBe(true);
  });

  it('reports a dropped currency marker as a warning', () => {
    const review = reviewTranslation('Fee is $50.', 'Phí là 50.');
    const units = byKind(review.issues, 'unit');
    expect(units).toHaveLength(1);
    expect(units[0]?.severity).toBe('warn');
    expect(units[0]?.detail).toContain('$');
    expect(review.ok).toBe(true);
  });

  it('accepts a currency code kept in the target', () => {
    const review = reviewTranslation('Fee is 50 USD.', 'Phí là 50 USD.');
    expect(byKind(review.issues, 'unit')).toEqual([]);
    expect(review.ok).toBe(true);
  });

  it('treats the full-width percent sign as the same unit', () => {
    const review = reviewTranslation('Interest 5% per year.', 'Lãi suất 5％ mỗi năm.');
    expect(byKind(review.issues, 'unit')).toEqual([]);
    expect(review.ok).toBe(true);
  });
});

describe('reviewTranslation negation', () => {
  it('catches a dropped negation', () => {
    const review = reviewTranslation('This clause does not apply.', 'Điều khoản này được áp dụng.');
    expect(review.ok).toBe(false);
    const negations = byKind(review.issues, 'negation');
    expect(negations).toHaveLength(1);
    expect(negations[0]?.severity).toBe('error');
    expect(negations[0]?.detail).toContain('not');
    expect(negations[0]?.sourceExcerpt).toContain('not');
    expect(negations[0]?.targetExcerpt).toBe('');
  });

  it('accepts a negation kept in Vietnamese', () => {
    const review = reviewTranslation('This does not apply.', 'Điều này không áp dụng.');
    expect(review.issues).toEqual([]);
    expect(review.ok).toBe(true);
  });

  it('does not read the abbreviation "No." as a negation', () => {
    const review = reviewTranslation('See No. 5 below.', 'Xem mục 5 bên dưới.');
    expect(review.issues).toEqual([]);
    expect(review.ok).toBe(true);
  });
});

describe('reviewTranslation glossary terms', () => {
  const glossary = [{ source: 'indemnity', target: 'bồi thường' }];

  it('catches a missing glossary term as an error in strict mode', () => {
    const review = reviewTranslation('The indemnity clause applies.', 'Điều khoản này áp dụng.', {
      glossary,
      strict: true,
    });
    expect(review.ok).toBe(false);
    const terms = byKind(review.issues, 'term');
    expect(terms).toHaveLength(1);
    expect(terms[0]?.severity).toBe('error');
    expect(terms[0]?.detail).toBe('Glossary term "indemnity" requires "bồi thường" in the target.');
    expect(terms[0]?.sourceExcerpt).toContain('indemnity');
    expect(terms[0]?.targetExcerpt).toBe('');
  });

  it('reports a missing glossary term as a warning without strict mode', () => {
    const review = reviewTranslation('The indemnity clause applies.', 'Điều khoản này áp dụng.', { glossary });
    const terms = byKind(review.issues, 'term');
    expect(terms).toHaveLength(1);
    expect(terms[0]?.severity).toBe('warn');
    expect(review.ok).toBe(true);
  });

  it('accepts the exact requested target term', () => {
    const review = reviewTranslation('The indemnity clause applies.', 'Điều khoản bồi thường áp dụng.', {
      glossary,
      strict: true,
    });
    expect(review.issues).toEqual([]);
    expect(review.ok).toBe(true);
  });

  it('accepts the record shape used by translation settings', () => {
    const review = reviewTranslation('The indemnity clause.', 'Điều khoản bồi thường.', {
      glossary: { indemnity: 'bồi thường' },
      strict: true,
    });
    expect(review.issues).toEqual([]);
    expect(review.ok).toBe(true);
  });

  it('does not fire on a source term that only appears inside a longer word', () => {
    const review = reviewTranslation('The contract stands.', 'Hợp đồng có hiệu lực.', {
      glossary: [{ source: 'act', target: 'hành động' }],
      strict: true,
    });
    expect(byKind(review.issues, 'term')).toEqual([]);
    expect(review.ok).toBe(true);
  });
});

describe('reviewTranslation placeholders', () => {
  it('catches a duplicated placeholder', () => {
    const review = reviewTranslation('See ⟦1⟧ and ⟦2⟧.', 'Xem ⟦1⟧ và ⟦1⟧.');
    expect(review.ok).toBe(false);
    const placeholders = byKind(review.issues, 'placeholder');
    expect(placeholders).toHaveLength(2);
    expect(placeholders[0]?.detail).toBe('Placeholder ⟦1⟧ appears 2 times in the target; it must appear exactly once.');
    expect(placeholders[0]?.severity).toBe('error');
    expect(placeholders[0]?.targetExcerpt).toContain('⟦1⟧');
    expect(placeholders[1]?.detail).toBe('Placeholder ⟦2⟧ is missing from the target.');
    expect(placeholders[1]?.sourceExcerpt).toContain('⟦2⟧');
    expect(placeholders[1]?.targetExcerpt).toBe('');
  });

  it('accepts every placeholder exactly once, even with spaces inside', () => {
    const review = reviewTranslation('See ⟦1⟧ and ⟦2⟧.', 'Xem ⟦ 1 ⟧ và ⟦2⟧.');
    expect(review.issues).toEqual([]);
    expect(review.ok).toBe(true);
  });

  it('catches a placeholder the target invents', () => {
    const review = reviewTranslation('Plain text.', 'Văn bản ⟦3⟧.');
    const placeholders = byKind(review.issues, 'placeholder');
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]?.detail).toBe('Placeholder ⟦3⟧ appears in the target but not in the source.');
    expect(placeholders[0]?.sourceExcerpt).toBe('');
    expect(review.ok).toBe(false);
  });
});

describe('reviewTranslation emptiness', () => {
  it('catches an empty target for a non-empty source', () => {
    const review = reviewTranslation('The fee is 42 EUR.', '   ');
    expect(review.issues).toHaveLength(1);
    expect(review.issues[0]).toMatchObject({
      kind: 'emptiness',
      severity: 'error',
      targetExcerpt: '',
    });
    expect(review.issues[0]?.sourceExcerpt).toContain('fee');
    expect(review.ok).toBe(false);
  });

  it('does not review an empty source', () => {
    const review = reviewTranslation('', 'anything');
    expect(review.issues).toEqual([]);
    expect(review.ok).toBe(true);
  });
});
