import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MASK,
  DEFAULT_MIN_CONFIDENCE,
  SENSITIVE_KINDS,
  applyRedaction,
  detectSensitive,
  planRedaction,
  redactionReport,
  type PlanRedactionOptions,
  type RedactionSpan,
  type SensitiveKind,
  type SensitiveMatch,
} from '../src/core/redact';

/** Every kind the text produced, in the module's canonical order. */
function kindsOf(text: string): SensitiveKind[] {
  const found = new Set(detectSensitive(text).map(match => match.kind));
  return SENSITIVE_KINDS.filter(kind => found.has(kind));
}

/** The matches of one kind, so an overlapping rule cannot make a count assertion flaky. */
function ofKind(text: string, kind: SensitiveKind): SensitiveMatch[] {
  return detectSensitive(text).filter(match => match.kind === kind);
}

/** A span with every field filled, for tests that hand-build the plan's input. */
function span(start: number, end: number, kind: SensitiveKind): RedactionSpan {
  return {
    start,
    end,
    kind,
    kinds: [kind],
    confidence: 1,
    reason: 'phone-prefix',
    merged: false,
  };
}

describe('detectSensitive', () => {
  it('finds every identifier kind in a realistic Vietnamese sentence', () => {
    expect(kindsOf('Mọi thắc mắc xin gửi về email: nguyen.van.an@example.vn trước ngày 30/06.')).toContain(
      'email',
    );
    expect(kindsOf('Hotline hỗ trợ: 0912 345 678, gọi trong giờ hành chính.')).toContain('phone');
    expect(kindsOf('Số CCCD: 012345678901 cấp ngày 12/03/2021.')).toContain('national-id');
    expect(kindsOf('Số tài khoản: 0123456789 tại Ngân hàng Á Châu.')).toContain('bank-account');
    expect(kindsOf('Mã số thuế: 0101243150 do cơ quan thuế cấp.')).toContain('tax-code');
    expect(kindsOf('Thẻ thanh toán 4111 1111 1111 1111 đã được lưu.')).toContain('card');
    expect(
      kindsOf('Địa chỉ: Số 12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh.'),
    ).toContain('address');
    expect(kindsOf('Họ tên: Nguyễn Văn An')).toContain('person-name');
  });

  it('returns spans whose value is the exact text, in reading order', () => {
    const text = 'Liên hệ 0912 345 678 hoặc a@b.vn.';
    const matches = detectSensitive(text);

    expect(matches.map(match => match.kind)).toEqual(['phone', 'email']);
    for (const match of matches) {
      expect(text.slice(match.start, match.end)).toBe(match.value);
      expect(match.confidence).toBeGreaterThan(0);
      expect(match.confidence).toBeLessThanOrEqual(1);
      expect(match.reason.length).toBeGreaterThan(0);
    }
  });

  it('does not treat a bare 12-digit number as a citizen identity document', () => {
    const text = 'Mã hợp đồng 012345678901 đã được lưu trong hồ sơ.';

    expect(ofKind(text, 'national-id')).toEqual([]);
    // No other rule may claim it either: a contract number is not a phone, a card or an
    // address, and an unlabelled number has no evidence behind it.
    expect(detectSensitive(text)).toEqual([]);
  });

  it('accepts the phone formats a contract prints', () => {
    for (const phone of ['0912 345 678', '+84 912 345 678', '(+84) 912 345 678', '0243.123.4567']) {
      const text = `Điện thoại: ${phone}.`;
      const matches = ofKind(text, 'phone');
      expect(matches).toHaveLength(1);
      expect(matches[0]!.value).toBe(phone);
    }
  });

  it('rejects a digit run that only looks like a phone number', () => {
    expect(ofKind('Mã số 0000 000 000 nội bộ.', 'phone')).toEqual([]);
    expect(ofKind('Mã số 123456789012345 nội bộ.', 'phone')).toEqual([]);
  });

  it('labels a 12-digit CCCD and a 9-digit CMND, including grouped forms', () => {
    const twelve = ofKind('Số CCCD: 0123 4567 8901 cấp tại Hà Nội.', 'national-id');
    expect(twelve).toHaveLength(1);
    expect(twelve[0]!.value).toBe('0123 4567 8901');
    expect(twelve[0]!.reason).toBe('label-cccd');

    const nine = ofKind('CMND: 123 456 789 do Công an cấp.', 'national-id');
    expect(nine).toHaveLength(1);
    expect(nine[0]!.value).toBe('123 456 789');
    expect(nine[0]!.reason).toBe('label-cmnd');
  });

  it('requires the Luhn check for a card number', () => {
    const valid = ofKind('Thẻ 4111 1111 1111 1111 được lưu.', 'card');
    expect(valid).toHaveLength(1);
    expect(valid[0]!.confidence).toBeGreaterThan(0.9);

    // One digit away from the valid number, and the checksum rejects it.
    expect(ofKind('Thẻ 4111 1111 1111 1112 được lưu.', 'card')).toEqual([]);
  });

  it('does not read a labelled tax code as a card', () => {
    // 13 digits that happen to satisfy Luhn, but the text calls them a tax code.
    const text = 'MST: 0101243150-001 đã đăng ký.';
    expect(ofKind(text, 'card')).toEqual([]);
    expect(ofKind(text, 'tax-code')).toHaveLength(1);
  });

  it('finds a Vietnamese address and refuses to guess at prose', () => {
    const text = 'Địa chỉ: Số 12 Nguyễn Huệ, Phường Bến Nghé, Quận 1, TP. Hồ Chí Minh.';
    const addresses = ofKind(text, 'address');
    expect(addresses).toHaveLength(1);
    expect(addresses[0]!.value).toBe(text);
    expect(addresses[0]!.reason).toBe('address-admin-unit');
    expect(addresses[0]!.confidence).toBeGreaterThanOrEqual(0.8);

    // A street-shaped line without an administrative unit is a weak guess: it is
    // detected, and the plan leaves it for a human below the default floor.
    const guess = ofKind('12 Nguyễn Huệ là địa chỉ cũ.', 'address');
    expect(guess).toHaveLength(1);
    const weakText = '12 Nguyễn Huệ là địa chỉ cũ.';
    const plan = planRedaction(detectSensitive(weakText), { text: weakText });
    expect(plan.spans).toEqual([]);
    expect(plan.skipped[0]!.reason).toBe('below-threshold');
  });

  it('finds names after the labels a contract uses', () => {
    const formal = ofKind('Họ tên: Nguyễn Văn An', 'person-name');
    expect(formal).toHaveLength(1);
    expect(formal[0]!.value).toBe('Nguyễn Văn An');

    const honorific = ofKind('Ông Trần Văn Bình', 'person-name');
    expect(honorific).toHaveLength(1);
    expect(honorific[0]!.value).toBe('Trần Văn Bình');

    const english = ofKind('Mr. John Smith', 'person-name');
    expect(english).toHaveLength(1);
    expect(english[0]!.value).toBe('John Smith');
  });

  it('stops a name at the field that follows on the same line', () => {
    const text = 'Họ tên: Nguyễn Văn An. Số CCCD: 012345678901.';
    const names = ofKind(text, 'person-name');

    expect(names).toHaveLength(1);
    expect(names[0]!.value).toBe('Nguyễn Văn An');
    expect(ofKind(text, 'national-id')).toHaveLength(1);
  });

  it('treats a generic Name field as weaker evidence than Họ tên', () => {
    const matches = detectSensitive('Name: John Smith');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.kind).toBe('person-name');
    expect(matches[0]!.confidence).toBeLessThan(DEFAULT_MIN_CONFIDENCE);
    expect(matches[0]!.reason).toBe('label-name');
  });

  it('finds nothing in an empty text', () => {
    expect(detectSensitive('')).toEqual([]);
  });
});

describe('planRedaction', () => {
  it('merges overlapping matches into one span and remembers both kinds', () => {
    const text = 'Mã số thuế: 0101243150-001 đã đăng ký.';
    const matches = detectSensitive(text);
    const start = text.indexOf('0101243150');

    // The tax code also looks like a ten-digit phone number; the plan keeps one span.
    expect(matches.some(match => match.kind === 'phone')).toBe(true);
    const plan = planRedaction(matches, { text });

    expect(plan.spans).toHaveLength(1);
    const merged = plan.spans[0]!;
    expect(merged.start).toBe(start);
    expect(merged.end).toBe(start + '0101243150-001'.length);
    expect(merged.kind).toBe('tax-code');
    expect(merged.kinds).toEqual(['phone', 'tax-code']);
    expect(merged.merged).toBe(true);
    expect(plan.skipped.map(entry => entry.reason)).toContain('overlaps-span');
  });

  it('sorts spans by position whatever order the matches arrive in', () => {
    const text = 'a@b.vn và 0912 345 678';
    const matches = detectSensitive(text).reverse();

    const plan = planRedaction(matches, { text });
    expect(plan.spans.map(entry => entry.kind)).toEqual(['email', 'phone']);
    expect(plan.spans[0]!.start).toBeLessThan(plan.spans[1]!.start);
  });

  it('skips a low-confidence match with a reason and names where it stays', () => {
    const text = 'Name: John Smith';
    const matches = detectSensitive(text);
    const plan = planRedaction(matches, { text });

    expect(plan.spans).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.reason).toBe('below-threshold');
    expect(plan.skipped[0]!.detectedReason).toBe('label-name');
    expect(plan.skipped[0]!.value).toBe('John Smith');

    const weak = plan.kept.filter(range => range.reason === 'below-threshold');
    expect(weak).toHaveLength(1);
    expect(text.slice(weak[0]!.start, weak[0]!.end)).toBe('John Smith');

    const untouched = plan.kept.filter(range => range.reason === 'no-match');
    expect(untouched.map(range => text.slice(range.start, range.end)).join('')).toBe('Name: ');
  });

  it('lets a caller raise the floor and skip a match that would otherwise be redacted', () => {
    const text = 'Điện thoại: 0912 345 678';
    const plan = planRedaction(detectSensitive(text), { text, minConfidence: 0.9 });

    expect(plan.spans).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.reason).toBe('below-threshold');
    // The label stays in the clear; only the number itself is a refused weak match.
    expect(plan.kept).toEqual([
      { start: 0, end: 12, reason: 'no-match' },
      { start: 12, end: text.length, reason: 'below-threshold' },
    ]);
  });

  it('partitions the text into spans and kept ranges with no gap', () => {
    const text = 'Liên hệ 0912 345 678 hoặc a@b.vn nhé.';
    const plan = planRedaction(detectSensitive(text), { text });

    const coverage = [...plan.spans, ...plan.kept].sort((a, b) => a.start - b.start);
    expect(coverage[0]!.start).toBe(0);
    expect(coverage[coverage.length - 1]!.end).toBe(text.length);
    for (let index = 1; index < coverage.length; index += 1) {
      expect(coverage[index]!.start).toBe(coverage[index - 1]!.end);
    }
  });

  it('refuses a match with an impossible range instead of guessing', () => {
    const bogus: SensitiveMatch = {
      kind: 'phone',
      value: '0912',
      start: 2,
      end: 99,
      confidence: 0.9,
      reason: 'phone-prefix',
    };
    const plan = planRedaction([bogus], { text: 'abc' });

    expect(plan.spans).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]!.reason).toBe('invalid-range');
    expect(plan.kept).toEqual([{ start: 0, end: 3, reason: 'no-match' }]);
  });

  it('keeps the whole text when there is nothing to redact', () => {
    const text = 'Không có thông tin cá nhân.';
    const plan = planRedaction([], { text });

    expect(plan.spans).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.kept).toEqual([{ start: 0, end: text.length, reason: 'no-match' }]);
  });

  it('requires the text the matches were found in', () => {
    expect(() => planRedaction([], undefined as unknown as PlanRedactionOptions)).toThrow(TypeError);
    expect(() =>
      planRedaction([], { text: 42 } as unknown as PlanRedactionOptions),
    ).toThrow(TypeError);
  });

  it('is empty for an empty text', () => {
    expect(planRedaction([], { text: '' })).toEqual({ spans: [], kept: [], skipped: [] });
  });
});

describe('applyRedaction', () => {
  const text = 'Liên hệ 0912 345 678 hoặc a@b.vn nhé.';

  it('replaces the spans and leaves every other character identical', () => {
    const plan = planRedaction(detectSensitive(text), { text });
    const result = applyRedaction(text, plan.spans, DEFAULT_MASK);

    expect(result.replaced).toBe(plan.spans.length);
    expect(result.text).toBe('Liên hệ [REDACTED] hoặc [REDACTED] nhé.');
  });

  it('proves the rest is byte-identical by deleting the spans', () => {
    const plan = planRedaction(detectSensitive(text), { text });
    const result = applyRedaction(text, plan.spans, '');

    expect(result.text).toBe('Liên hệ  hoặc  nhé.');
    expect(result.replaced).toBe(2);
  });

  it('takes a per-kind mask and falls back to the default for the rest', () => {
    const plan = planRedaction(detectSensitive(text), { text });
    const result = applyRedaction(text, plan.spans, { phone: '[PHONE]' });

    expect(result.text).toBe('Liên hệ [PHONE] hoặc [REDACTED] nhé.');
  });

  it('refuses overlapping and out-of-range spans rather than corrupt the output', () => {
    const result = applyRedaction('0123456789', [span(0, 5, 'phone'), span(3, 8, 'email'), span(20, 99, 'card')], '#');

    expect(result.text).toBe('#56789');
    expect(result.replaced).toBe(1);
  });

  it('leaves the text alone when there is nothing to replace', () => {
    expect(applyRedaction(text, [])).toEqual({ text, replaced: 0 });
    expect(applyRedaction('', [])).toEqual({ text: '', replaced: 0 });
  });
});

describe('redactionReport', () => {
  it('counts spans and characters per kind without leaking a value', () => {
    const text = 'Liên hệ 0912 345 678 hoặc a@b.vn nhé.';
    const plan = planRedaction(detectSensitive(text), { text });
    const report = redactionReport(plan.spans);

    expect(report.spans).toBe(2);
    expect(report.counts.email).toBe(1);
    expect(report.counts.phone).toBe(1);
    expect(report.counts.address).toBe(0);
    expect(report.characters).toBe('0912 345 678'.length + 'a@b.vn'.length);

    expect(report.line).toContain('2 spans');
    expect(report.line).toContain('phone');
    expect(report.line).not.toContain('0912');
    expect(report.line).not.toContain('a@b.vn');
  });

  it('reports the winning kind of a merged span once', () => {
    const text = 'Mã số thuế: 0101243150-001 đã đăng ký.';
    const plan = planRedaction(detectSensitive(text), { text });
    const report = redactionReport(plan.spans);

    expect(report.spans).toBe(1);
    expect(report.counts['tax-code']).toBe(1);
    expect(report.counts.phone).toBe(0);
  });

  it('says there is nothing to redact for an empty plan', () => {
    const report = redactionReport([]);

    expect(report.spans).toBe(0);
    expect(report.characters).toBe(0);
    expect(SENSITIVE_KINDS.every(kind => report.counts[kind] === 0)).toBe(true);
    expect(report.line).toBe('Redaction plan: no redactions.');
  });
});
