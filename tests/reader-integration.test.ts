import { describe, expect, it } from 'vitest';
import { clampPageNumber, dictionaryFor, documentReadingKey, languageNativeName, LOCALES } from '../src/i18n';

describe('reader page clamp', () => {
  it('keeps a page inside the document', () => {
    expect(clampPageNumber(1, 10)).toBe(1);
    expect(clampPageNumber(10, 10)).toBe(10);
    expect(clampPageNumber(11, 10)).toBe(10);
    expect(clampPageNumber(0, 10)).toBe(1);
    expect(clampPageNumber(-4, 10)).toBe(1);
    expect(clampPageNumber(3.9, 10)).toBe(3);
  });

  it('falls back to page one for an unknown document or invalid value', () => {
    expect(clampPageNumber(5, 0)).toBe(1);
    expect(clampPageNumber(Number.NaN, 7)).toBe(1);
    expect(clampPageNumber(Number.POSITIVE_INFINITY, 7)).toBe(1);
  });
});

describe('reading state key', () => {
  it('is stable for the same title and byte size', () => {
    expect(documentReadingKey('Sách.pdf', 2048)).toBe(documentReadingKey('  Sách.pdf  ', 2048));
    expect(documentReadingKey('Sách.pdf', 2048)).toBe('mirror.reading-state:Sách.pdf:2048');
  });

  it('separates different documents', () => {
    expect(documentReadingKey('Sách.pdf', 2048)).not.toBe(documentReadingKey('Sách.pdf', 2049));
    expect(documentReadingKey('Sách.pdf', 2048)).not.toBe(documentReadingKey('Khác.pdf', 2048));
    expect(documentReadingKey('Sách.pdf', 2048, 'reader')).toBe('reader:Sách.pdf:2048');
  });
});

describe('detected language label', () => {
  it('uses the native name when the detected language is supported', () => {
    expect(languageNativeName('vi')).toBe('Tiếng Việt');
    expect(languageNativeName('zh')).toBe('中文');
    expect(languageNativeName('ar')).toBe('العربية');
    expect(languageNativeName(' EN ')).toBe('English');
  });

  it('falls back to the upper-cased code', () => {
    expect(languageNativeName('he')).toBe('HE');
    expect(languageNativeName('')).toBe('');
  });

  it('provides a localized hint with the language variable in every locale', () => {
    for (const locale of LOCALES) {
      expect(dictionaryFor(locale).detectedLanguageHint).toContain('{language}');
    }
  });
});

describe('translation status copy', () => {
  it('reports both region count and character count in every locale', () => {
    for (const locale of LOCALES) {
      const copy = dictionaryFor(locale).statusTranslated;
      expect(copy).toContain('{count}');
      expect(copy).toContain('{chars}');
      expect(copy).toContain('{mode}');
      expect(copy).toContain('{provider}');
    }
  });
});
