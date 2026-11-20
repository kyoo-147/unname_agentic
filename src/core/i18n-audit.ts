/**
 * Locale audit: three dictionaries compared value by value (backlog N03).
 *
 * `tests/i18n.test.ts` already asserts that the three dictionaries carry the same keys
 * and no blank value. That is a key count, and a key count is not equivalence: a Chinese
 * entry can hold the English sentence, and a Vietnamese entry can carry `{total}` where
 * English carries `{page}`. Both pass a count. This module answers the narrower question
 * a reader actually feels — do the values agree everywhere the runtime would notice —
 * and returns the evidence instead of a verdict nobody can check.
 *
 * What is compared, and why each one:
 *
 * - **Keys.** English is the reference: it is the `as const` object that defines
 *   `TranslationKey`, so a key English lacks cannot be reached by `t()` at all. A key
 *   English has and a locale lacks is `missing`; a key a locale has and English lacks is
 *   `extra` — unreachable code that also proves the two sides drifted.
 * - **Placeholders.** `t()` substitutes `/\{(\w+)\}/g` by name, so the *names* are part of
 *   the contract: `Trang {page} / {trang}` renders a literal `{trang}` to a reader.
 *   {@link extractPlaceholders} reads exactly the names the runtime reads — same `\w`
 *   class — and skips doubled braces, which is how a value spells a literal brace.
 * - **Emptiness.** A whitespace-only value renders as a blank button or label, so it
 *   counts as empty rather than as a translation.
 * - **Untranslated.** A value identical to English is suspicious only when it is long
 *   enough to be a sentence; see {@link UNTRANSLATED_MAX_SAFE_LENGTH} for the number and
 *   what it deliberately does not catch.
 *
 * The module is pure: no imports, no clock, no DOM, no I/O. The unit test feeds it the
 * dictionaries TypeScript actually exports, and `scripts/i18n-matrix.mjs` feeds it copies
 * lifted out of the `src/i18n.ts` text, so both callers are judged by these same rules
 * instead of by two implementations that can drift apart.
 */

/** The three shipped locales. Order matters only in that reports follow it. */
export type Locale = 'vi' | 'en' | 'zh';

/** Every locale the audit covers, in the order each report lists them. */
export const AUDIT_LOCALES: readonly Locale[] = ['vi', 'en', 'zh'];

/**
 * The locale the other two are compared against.
 *
 * English is the reference because it is the `as const` object that defines
 * `TranslationKey`: it is the only side whose key set is enforced by the type checker,
 * so it is the one that cannot silently lose a key.
 */
export const REFERENCE_LOCALE: Locale = 'en';

/**
 * Longest value, in UTF-16 code units, that may repeat the English value without being
 * reported as untranslated.
 *
 * A blanket "identical means untranslated" rule fails on names that are legitimately the
 * same in every language: this dictionary ships `DeepL` (5) and `Google Cloud Translation`
 * (24), and the Chinese file really does keep the English product name. 24 is that longest
 * legitimate value, and the rule reports values *strictly longer*, so the product name
 * stays quiet while a sentence left in English — `PDF saved ({size} KB, {pages} pages).`
 * is 38 — does not.
 *
 * The cost of the number, stated because it is real: a short English label left in a
 * locale (`Search this document` is 19) sits under the threshold and is not reported.
 * Catching those needs a human reading the matrix. The alternative — reporting every
 * identical value — would flag product names on every run and train everyone to ignore the
 * list, which is worse than a gap that is printed here. This audit is a tripwire, not a
 * proofread: a clean run means nothing obvious is wrong, never that the prose is good.
 */
export const UNTRANSLATED_MAX_SAFE_LENGTH = 24;

/** One dictionary as this module needs it: keys to values, nothing else. */
export type Dictionary = Readonly<Record<string, string>>;

/** The three dictionaries under audit. Every locale is required. */
export interface LocaleDictionaries {
  readonly vi: Dictionary;
  readonly en: Dictionary;
  readonly zh: Dictionary;
}

/** A reference key a locale does not have. `t()` falls back to English for it. */
export interface MissingKey {
  readonly locale: Locale;
  readonly key: string;
}

/** A key a locale has and the reference does not. Nothing can reach it through `t()`. */
export interface ExtraKey {
  readonly locale: Locale;
  readonly key: string;
}

/**
 * Placeholder names that disagree between the reference and a locale.
 *
 * `expected` is the reference (`en`) value's names, `actual` is the locale's, both in
 * order of appearance and both including repetition. The locale is not carried on the
 * record because the reference is always English: `actual` identifies the side, and the
 * matrix script prints the locale it resolves to. The entry is emitted once per offending
 * locale, so a key broken in both appears twice with a different `actual` each time.
 */
export interface PlaceholderMismatch {
  readonly key: string;
  readonly expected: readonly string[];
  readonly actual: readonly string[];
}

/** A key whose value is empty, or whitespace only. */
export interface EmptyValue {
  readonly locale: Locale;
  readonly key: string;
}

/** A long value that still reads exactly like English. */
export interface Untranslated {
  readonly locale: Locale;
  readonly key: string;
}

/**
 * The five disagreements, each empty when the locales agree, plus the verdict.
 *
 * Every list is locale-major in {@link AUDIT_LOCALES} order. `missing` and
 * `placeholderMismatch` walk the reference dictionary's insertion order; `extra`,
 * `emptyValues` and `untranslated` walk each locale's own order, because a key the
 * reference lacks has no reference position to sort by.
 */
export interface LocaleAudit {
  readonly missing: MissingKey[];
  readonly extra: ExtraKey[];
  readonly placeholderMismatch: PlaceholderMismatch[];
  readonly emptyValues: EmptyValue[];
  readonly untranslated: Untranslated[];
  /** True only when all five lists are empty. */
  readonly ok: boolean;
}

/**
 * The alphabet a placeholder name may use: `\w`, exactly the class `t()` substitutes.
 *
 * Declared once rather than spelled inline, so the scanner cannot drift from the runtime
 * by a character class that looks equivalent and is not.
 */
const PLACEHOLDER_NAME = /\w/u;

/**
 * The placeholder names a value carries, in order of appearance.
 *
 * The scanner accepts exactly what `t()` substitutes — `{name}` with `name` matching
 * `\w`, i.e. `[A-Za-z0-9_]` — so a token this function ignores is a token the runtime
 * would render literally, and a token it accepts is one the runtime fills. Being
 * stricter than `t()` would report placeholders that never interpolate; being looser
 * would miss the ones that do.
 *
 * A doubled brace is a literal brace, not a placeholder: `{{count}}` yields nothing and
 * `{{{x}}}` yields `x`, which is the usual ICU spelling and how a value writes a brace it
 * wants a reader to see. An unterminated or empty brace is not a placeholder either.
 *
 * Repetition is preserved (`{count} … {count}` yields `count` twice) because the runtime
 * substitutes each occurrence independently: a locale that duplicates a placeholder reads
 * the number twice, and the audit should be able to say so.
 */
export function extractPlaceholders(value: string): string[] {
  const names: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const character = value.charAt(cursor);
    if (character === '{') {
      if (value.charAt(cursor + 1) === '{') {
        cursor += 2;
        continue;
      }
      let end = cursor + 1;
      while (end < value.length && PLACEHOLDER_NAME.test(value.charAt(end))) end += 1;
      // A name needs at least one `\w` character and a closing brace; `{}` and `{a b}`
      // are not placeholders. `{{` was already consumed as an escaped brace, so a value
      // that writes `{{{x}}}` reaches this point at its inner `{x}` and reads `x`.
      if (end > cursor + 1 && value.charAt(end) === '}') {
        names.push(value.slice(cursor + 1, end));
        cursor = end + 1;
        continue;
      }
      cursor += 1;
      continue;
    }
    if (character === '}' && value.charAt(cursor + 1) === '}') {
      cursor += 2;
      continue;
    }
    cursor += 1;
  }
  return names;
}

/**
 * True when both sides carry the same placeholder names with the same repetition count.
 *
 * Order is deliberately not compared. `t()` fills by name, so a locale is free to move a
 * placeholder to where its grammar wants it (`共 {total} 页 / 第 {page} 页` is correct
 * Chinese) and reporting that as a defect would be wrong. What a locale may not do is
 * drop, rename, add or duplicate one.
 */
function samePlaceholders(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((name, index) => name === sortedRight[index]);
}

/**
 * Compares the three dictionaries and reports every disagreement.
 *
 * The reference is `dictionaries.en`, so no locale can be "ahead": a key only English has
 * is `missing` in both other locales, and one only a locale has is `extra` in that locale.
 * `emptyValues` covers all three locales — English can ship a blank label too — while
 * `untranslated` skips English, which equals itself by definition.
 *
 * The result is fresh on every call and contains no reference to the input, so callers can
 * print it, sort it or hand it to a test without aliasing the dictionaries.
 */
export function auditLocales(dictionaries: LocaleDictionaries): LocaleAudit {
  const reference = dictionaries[REFERENCE_LOCALE];
  const referenceKeys = Object.keys(reference);
  const referenceSet = new Set(referenceKeys);

  const missing: MissingKey[] = [];
  const extra: ExtraKey[] = [];
  const placeholderMismatch: PlaceholderMismatch[] = [];
  const emptyValues: EmptyValue[] = [];
  const untranslated: Untranslated[] = [];

  for (const locale of AUDIT_LOCALES) {
    const dictionary = dictionaries[locale];

    if (locale !== REFERENCE_LOCALE) {
      for (const key of referenceKeys) {
        if (!Object.hasOwn(dictionary, key)) missing.push({ locale, key });
      }
      for (const key of Object.keys(dictionary)) {
        if (!referenceSet.has(key)) extra.push({ locale, key });
      }
    }

    for (const key of Object.keys(dictionary)) {
      if ((dictionary[key] ?? '').trim().length === 0) emptyValues.push({ locale, key });
    }

    if (locale === REFERENCE_LOCALE) continue;

    for (const key of referenceKeys) {
      if (!Object.hasOwn(dictionary, key)) continue;
      const expected = extractPlaceholders(reference[key] ?? '');
      const actual = extractPlaceholders(dictionary[key] ?? '');
      if (!samePlaceholders(expected, actual)) placeholderMismatch.push({ key, expected, actual });
    }

    for (const key of Object.keys(dictionary)) {
      if (!referenceSet.has(key)) continue;
      const value = (dictionary[key] ?? '').trim();
      if (value.length <= UNTRANSLATED_MAX_SAFE_LENGTH) continue;
      if (value !== (reference[key] ?? '').trim()) continue;
      untranslated.push({ locale, key });
    }
  }

  return {
    missing,
    extra,
    placeholderMismatch,
    emptyValues,
    untranslated,
    ok:
      missing.length === 0
      && extra.length === 0
      && placeholderMismatch.length === 0
      && emptyValues.length === 0
      && untranslated.length === 0,
  };
}
