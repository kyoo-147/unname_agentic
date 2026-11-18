import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES, LOCALE_STORAGE_KEY, dictionaryFor, getLocale, initLocale, localeLabel, setLocale, subscribe, t, type Locale, type LocaleStorage, type TranslationKey } from '../src/i18n';

function memoryStorage(initial: Record<string, string> = {}): LocaleStorage & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => { values[key] = value; },
  };
}

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function reset(): void {
  initLocale(memoryStorage());
}

describe('dictionary', () => {
  it('keeps the same non-empty keys across Vietnamese, English and Chinese', () => {
    const baseline = Object.keys(dictionaryFor('en')).sort();
    expect(baseline.length).toBeGreaterThan(90);
    for (const locale of LOCALES) {
      const dictionary = dictionaryFor(locale);
      expect(Object.keys(dictionary).sort()).toEqual(baseline);
      for (const value of Object.values(dictionary)) expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it('interpolates variables in every locale', () => {
    reset();
    expect(t('pageStatus', { page: 3, total: 9 })).toBe('Trang 3 / 9');
    setLocale('en');
    expect(t('pageStatus', { page: 3, total: 9 })).toBe('Page 3 of 9');
    expect(t('pageStatus', { page: 3 })).toBe('Page 3 of {total}');
    setLocale('zh');
    expect(t('statusPageError', { page: 4, message: 'boom' })).toBe('第 4 页：boom');
  });

  it('falls back to the key for an unknown translation', () => {
    reset();
    expect(t('no.such.key' as TranslationKey)).toBe('no.such.key');
  });

  it('labels every locale with its short code', () => {
    expect(LOCALES.map(localeLabel)).toEqual(['VI', 'EN', 'ZH']);
    expect(DEFAULT_LOCALE).toBe('vi');
  });
});

describe('locale persistence', () => {
  it('starts in Vietnamese with a fresh storage', () => {
    expect(initLocale(memoryStorage())).toBe('vi');
    expect(getLocale()).toBe('vi');
  });

  it('persists the selected locale and restores it on the next init', () => {
    const storage = memoryStorage();
    initLocale(storage);
    setLocale('en');
    expect(storage.values[LOCALE_STORAGE_KEY]).toBe('en');
    expect(initLocale(storage)).toBe('en');
    setLocale('zh');
    expect(storage.values[LOCALE_STORAGE_KEY]).toBe('zh');
    expect(initLocale(storage)).toBe('zh');
    reset();
  });

  it('uses Vietnamese for a missing or invalid saved value', () => {
    expect(initLocale(memoryStorage())).toBe('vi');
    expect(initLocale(memoryStorage({ [LOCALE_STORAGE_KEY]: 'fr' }))).toBe('vi');
    expect(getLocale()).toBe('vi');
  });

  it('survives storage that refuses to read or write', () => {
    const broken: LocaleStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(initLocale(broken)).toBe('vi');
    expect(() => setLocale('en')).not.toThrow();
    expect(getLocale()).toBe('en');
    reset();
  });

  it('notifies subscribers until they unsubscribe', () => {
    initLocale(memoryStorage());
    const seen: Locale[] = [];
    const stop = subscribe(locale => seen.push(locale));
    setLocale('en');
    stop();
    setLocale('zh');
    expect(seen).toEqual(['en']);
    reset();
  });
});

describe('source coverage', () => {
  const keys = new Set(Object.keys(dictionaryFor('en')));

  it('resolves every literal t() call in the reader and popup', () => {
    for (const file of ['../src/main.ts', '../extension/popup.ts']) {
      const source = read(file);
      const matches = [...source.matchAll(/\bt\(\s*'([^']+)'/g)];
      expect(matches.length).toBeGreaterThan(5);
      for (const match of matches) expect(keys.has(match[1]!), `${file}: ${match[1]}`).toBe(true);
    }
  });

  it('resolves every data-i18n key in the markup', () => {
    for (const file of ['../src/main.ts', '../index.html', '../extension/popup.html']) {
      const source = read(file);
      for (const match of source.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
        expect(keys.has(match[1]!), `${file}: ${match[1]}`).toBe(true);
      }
    }
  });
});
