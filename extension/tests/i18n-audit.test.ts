import { describe, expect, it } from 'vitest';
import {
  AUDIT_LOCALES,
  REFERENCE_LOCALE,
  UNTRANSLATED_MAX_SAFE_LENGTH,
  auditLocales,
  extractPlaceholders,
  type LocaleDictionaries,
} from '../viewer/src/core/i18n-audit';
import { dictionaryFor } from '../viewer/src/i18n';

/**
 * The three-entry fixture every test starts from.
 *
 * Its values stay under {@link UNTRANSLATED_MAX_SAFE_LENGTH} on purpose: an identical
 * dictionary whose values were long *would* be reported by the untranslated rule, which is
 * the behaviour the dedicated test below pins. These values are short labels, so "identical
 * dictionaries pass" is about keys, placeholders and emptiness and nothing else.
 */
const BASE: Readonly<Record<string, string>> = Object.freeze({
  open: 'Open',
  close: 'Close',
  page: 'Page {page} of {total}',
});

function base(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...BASE, ...overrides };
}

interface Fixture {
  vi?: Record<string, string>;
  en?: Record<string, string>;
  zh?: Record<string, string>;
}

/** Runs the audit with any locale the fixture does not override filled from {@link BASE}. */
function audit(fixture: Fixture = {}) {
  const dictionaries: LocaleDictionaries = {
    vi: fixture.vi ?? base(),
    en: fixture.en ?? base(),
    zh: fixture.zh ?? base(),
  };
  return auditLocales(dictionaries);
}

describe('auditLocales', () => {
  it('passes three identical dictionaries', () => {
    expect(audit()).toEqual({
      missing: [],
      extra: [],
      placeholderMismatch: [],
      emptyValues: [],
      untranslated: [],
      ok: true,
    });
  });

  it('names the locale and the key that a locale is missing', () => {
    const report = audit({ zh: { open: '打开', page: '第 {page} 页 / 共 {total} 页' } });
    expect(report.missing).toEqual([{ locale: 'zh', key: 'close' }]);
    expect(report.extra).toEqual([]);
    expect(report.placeholderMismatch).toEqual([]);
    expect(report.ok).toBe(false);
  });

  it('reports a key only one locale has as extra', () => {
    const report = audit({ vi: base({ legacy: 'Cũ' }) });
    expect(report.extra).toEqual([{ locale: 'vi', key: 'legacy' }]);
    expect(report.missing).toEqual([]);
    expect(report.ok).toBe(false);
  });

  it('reports a placeholder rename with both sides of the same key', () => {
    const report = audit({ vi: base({ page: 'Trang {page} / {tong}' }) });
    expect(report.placeholderMismatch).toEqual([
      { key: 'page', expected: ['page', 'total'], actual: ['page', 'tong'] },
    ]);
    expect(report.ok).toBe(false);
  });

  it('accepts a reordered placeholder but not a dropped one', () => {
    // t() fills by name, so Chinese may put {total} first; the audit must not call that
    // a defect. Dropping {page} is a defect.
    expect(audit({ zh: base({ page: '共 {total} 页 / 第 {page} 页' }) }).ok).toBe(true);
    expect(audit({ zh: base({ page: '共 {total} 页' }) }).placeholderMismatch).toEqual([
      { key: 'page', expected: ['page', 'total'], actual: ['total'] },
    ]);
  });

  it('treats a whitespace-only value as empty', () => {
    const report = audit({ vi: base({ close: '   ' }) });
    expect(report.emptyValues).toEqual([{ locale: 'vi', key: 'close' }]);
    expect(report.untranslated).toEqual([]);
    expect(report.ok).toBe(false);
  });

  it('flags a long value identical to English and leaves a short one alone', () => {
    const sentence = 'This line was never translated, it is still English.';
    const loanword = 'DeepL';
    // The fixture depends on these two sitting on opposite sides of the threshold.
    expect(sentence.length).toBeGreaterThan(UNTRANSLATED_MAX_SAFE_LENGTH);
    expect(loanword.length).toBeLessThanOrEqual(UNTRANSLATED_MAX_SAFE_LENGTH);

    const report = audit({
      en: base({ note: sentence, provider: loanword }),
      vi: base({ note: sentence, provider: loanword }),
      zh: base({ note: '这行已经翻译过了。', provider: loanword }),
    });

    expect(report.untranslated).toEqual([{ locale: 'vi', key: 'note' }]);
    expect(report.missing).toEqual([]);
    expect(report.placeholderMismatch).toEqual([]);
    expect(report.ok).toBe(false);
  });

  it('reports a locale that escaped the braces instead of translating', () => {
    const report = audit({ vi: base({ page: '{{page}} của {{total}}' }) });
    expect(report.placeholderMismatch).toEqual([
      { key: 'page', expected: ['page', 'total'], actual: [] },
    ]);
    expect(report.ok).toBe(false);
  });

  it('compares against English, the key set the type checker enforces', () => {
    expect(REFERENCE_LOCALE).toBe('en');
    expect(AUDIT_LOCALES).toEqual(['vi', 'en', 'zh']);
    expect(UNTRANSLATED_MAX_SAFE_LENGTH).toBeGreaterThanOrEqual('Google Cloud Translation'.length);
  });
});

describe('extractPlaceholders', () => {
  it('reads the names in order of appearance', () => {
    expect(extractPlaceholders('Page {page} of {total}')).toEqual(['page', 'total']);
    expect(extractPlaceholders('{count} results')).toEqual(['count']);
    expect(extractPlaceholders('no braces here')).toEqual([]);
  });

  it('treats a doubled brace as a literal brace', () => {
    expect(extractPlaceholders('{{count}} stays literal')).toEqual([]);
    expect(extractPlaceholders('{a} and {{b}} and {c}')).toEqual(['a', 'c']);
    expect(extractPlaceholders('{{{x}}}')).toEqual(['x']);
  });

  it('ignores what t() would not substitute', () => {
    expect(extractPlaceholders('{}')).toEqual([]);
    expect(extractPlaceholders('{not a name}')).toEqual([]);
    expect(extractPlaceholders('an opening { brace')).toEqual([]);
  });

  it('keeps repetition, because t() fills each occurrence', () => {
    expect(extractPlaceholders('{count} of {count}')).toEqual(['count', 'count']);
  });
});

describe('the dictionaries the reader ships', () => {
  const dictionaries: LocaleDictionaries = {
    vi: dictionaryFor('vi'),
    en: dictionaryFor('en'),
    zh: dictionaryFor('zh'),
  };

  it('pass every check, placeholders included', () => {
    const report = auditLocales(dictionaries);
    expect(report.missing, 'missing keys').toEqual([]);
    expect(report.extra, 'extra keys').toEqual([]);
    expect(report.placeholderMismatch, 'placeholder mismatches').toEqual([]);
    expect(report.emptyValues, 'empty values').toEqual([]);
    expect(report.untranslated, 'untranslated values').toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('carries real placeholders, so the check above is not vacuous', () => {
    for (const locale of AUDIT_LOCALES) {
      expect(extractPlaceholders(dictionaryFor(locale).pageStatus), locale).toEqual(['page', 'total']);
    }
  });

  it('catches a placeholder rename in a copy of a real dictionary', () => {
    const vi = { ...dictionaryFor('vi'), pageStatus: 'Trang {page} / {tong}' };
    const report = auditLocales({ vi, en: dictionaries.en, zh: dictionaries.zh });
    expect(report.placeholderMismatch).toEqual([
      { key: 'pageStatus', expected: ['page', 'total'], actual: ['page', 'tong'] },
    ]);
    expect(report.ok).toBe(false);
  });
});
