import { describe, expect, it } from 'vitest';
import {
  matchKey,
  normalizeText,
  scoreSimilarity,
  TM_DEFAULT_MIN_SCORE,
  TM_SCHEMA_VERSION,
  TmError,
  TranslationMemory,
  wordTrigrams,
  type TmEntry,
} from '../src/core/tm';

const BASE_TIME = Date.UTC(2026, 0, 15, 9, 30);

/** Builds a complete entry so each test only states the fields it cares about. */
function makeEntry(spec: { id: string; source: string; target: string } & Partial<TmEntry>): TmEntry {
  const { id, source, target, ...rest } = spec;
  return {
    id,
    source,
    target,
    sourceLang: rest.sourceLang ?? 'en',
    targetLang: rest.targetLang ?? 'vi',
    engine: rest.engine ?? 'human',
    ...(rest.model === undefined ? {} : { model: rest.model }),
    createdAt: rest.createdAt ?? BASE_TIME,
    uses: rest.uses ?? 0,
  };
}

/** A raw entry in an import document; JSON drops the key when an override is undefined. */
function rawEntry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    source: `Source segment ${id}.`,
    target: `Target segment ${id}.`,
    sourceLang: 'en',
    targetLang: 'vi',
    engine: 'human',
    createdAt: BASE_TIME,
    uses: 0,
    ...overrides,
  };
}

function documentWith(entries: readonly unknown[]): string {
  return JSON.stringify({ schemaVersion: TM_SCHEMA_VERSION, kind: 'translation-memory', entries }, null, 2);
}

function expectTmError(run: () => unknown, code: TmError['code'], path: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TmError);
    const tmError = error as TmError;
    expect(tmError.code).toBe(code);
    expect(tmError.path).toBe(path);
    if (path) expect(tmError.message).toContain(path);
    return;
  }
  throw new Error(`expected a TmError with code ${code}`);
}

/** 30 words, so replacing the last one costs two trigrams out of 32. */
const PIPELINE_A =
  'The translation memory reuses segments that were previously translated by a human reviewer so that repeated paragraphs keep their approved wording across every document revision in the same project pipeline.';
const PIPELINE_B =
  'The translation memory reuses segments that were previously translated by a human reviewer so that repeated paragraphs keep their approved wording across every document revision in the same project workflow.';

/** 16 words, so replacing the last one drops the score below the default floor. */
const FOX_A = 'The quick brown fox jumps over the lazy dog near the river bank in the morning.';
const FOX_B = 'The quick brown fox jumps over the lazy dog near the river bank in the evening.';

describe('normalisation and similarity', () => {
  it('scores the documented Jaccard index over word trigrams', () => {
    expect(TM_DEFAULT_MIN_SCORE).toBe(0.85);
    expect(scoreSimilarity('alpha beta gamma', 'alpha beta gamma')).toBe(1);
    expect(scoreSimilarity('alpha beta gamma', 'delta epsilon zeta')).toBe(0);
    // "a b c d" and "a b c e" each hold four trigrams and share two of them.
    expect(scoreSimilarity('a b c d', 'a b c e')).toBeCloseTo(2 / 6, 10);
    // Boundary markers keep one- and two-word segments from having an empty set.
    expect(wordTrigrams('alpha').size).toBe(1);
    expect(wordTrigrams('alpha beta').size).toBe(2);
    expect(wordTrigrams('alpha beta gamma').size).toBe(3);
  });

  it('normalises whitespace, curly quotes and dashes but keeps case', () => {
    expect(normalizeText('  Don’t   —   “stop”  ')).toBe('Don\'t - "stop"');
    expect(normalizeText('Line one\n\tLine two')).toBe('Line one Line two');
    expect(normalizeText('Giữ–nguyên—dấu “ngoặc”')).toBe('Giữ-nguyên-dấu "ngoặc"');
    expect(matchKey('  “Export”  ')).toBe('"export"');

    const memory = new TranslationMemory();
    const stored = memory.add(
      makeEntry({
        id: 'tm-norm',
        source: '  “Export   the file”\t—  then open it…  ',
        target: '  “Xuất  tệp”  –  rồi mở nó…  ',
      }),
    );
    expect(stored.source).toBe('"Export the file" - then open it…');
    expect(stored.target).toBe('"Xuất tệp" - rồi mở nó…');

    const match = memory.match('"Export the file" - then open it…');
    expect(match).not.toBeNull();
    expect(match!.kind).toBe('exact');
    expect(match!.score).toBe(1);
    expect(match!.entry.id).toBe('tm-norm');
  });
});

describe('matching', () => {
  it('returns score 1 for an exact hit and counts the use', () => {
    const memory = new TranslationMemory();
    memory.add(
      makeEntry({
        id: 'tm-exact',
        source: 'The quick brown fox jumps over the lazy dog.',
        target: 'Con cáo nâu nhanh nhẹn nhảy qua con chó lười.',
      }),
    );

    const first = memory.match('  The   quick brown fox JUMPS over the lazy dog.  ');
    expect(first).not.toBeNull();
    expect(first!.kind).toBe('exact');
    expect(first!.score).toBe(1);
    expect(first!.entry.id).toBe('tm-exact');
    expect(first!.entry.uses).toBe(1);

    const second = memory.match('the quick brown fox jumps over the lazy dog.');
    expect(second!.entry.uses).toBe(2);
    expect(memory.stats().totalUses).toBe(2);
  });

  it('prefers an exact hit over a similar one', () => {
    const memory = new TranslationMemory();
    memory.add(makeEntry({ id: 'a-similar', source: PIPELINE_A, target: 'Bộ nhớ dịch dùng lại các đoạn đã dịch.' }));
    memory.add(makeEntry({ id: 'b-exact', source: PIPELINE_B, target: 'Bộ nhớ dịch tái sử dụng các đoạn đã dịch.' }));

    const match = memory.match(PIPELINE_B);
    expect(match).not.toBeNull();
    expect(match!.kind).toBe('exact');
    expect(match!.score).toBe(1);
    expect(match!.entry.id).toBe('b-exact');
  });

  it('matches a near duplicate above the default threshold', () => {
    const expected = scoreSimilarity(PIPELINE_A, PIPELINE_B);
    expect(expected).toBeGreaterThan(TM_DEFAULT_MIN_SCORE);
    expect(expected).toBeLessThan(1);

    const memory = new TranslationMemory();
    memory.add(makeEntry({ id: 'tm-near', source: PIPELINE_A, target: 'Bộ nhớ dịch dùng lại các đoạn đã dịch.' }));

    const match = memory.match(PIPELINE_B);
    expect(match).not.toBeNull();
    expect(match!.kind).toBe('similar');
    expect(match!.score).toBeCloseTo(expected, 10);
    expect(match!.entry.id).toBe('tm-near');

    // A stricter floor rejects the same pair, which proves the floor is applied.
    expect(memory.match(PIPELINE_B, { minScore: 0.99 })).toBeNull();
  });

  it('does not match a pair below the default threshold unless the caller lowers it', () => {
    const expected = scoreSimilarity(FOX_A, FOX_B);
    expect(expected).toBeLessThan(TM_DEFAULT_MIN_SCORE);

    const memory = new TranslationMemory();
    memory.add(makeEntry({ id: 'tm-far', source: FOX_A, target: 'Con cáo nâu nhảy qua con chó lười.' }));

    expect(memory.match(FOX_B)).toBeNull();
    const lowered = memory.match(FOX_B, { minScore: expected });
    expect(lowered).not.toBeNull();
    expect(lowered!.kind).toBe('similar');
    expect(lowered!.score).toBeCloseTo(expected, 10);
  });

  it('honours the language and engine filters', () => {
    const memory = new TranslationMemory();
    const source = 'Please restart the application before exporting again.';
    memory.add(
      makeEntry({
        id: 'en-1',
        source,
        target: 'Vui lòng khởi động lại ứng dụng trước khi xuất lại.',
        sourceLang: 'en',
        engine: 'human',
      }),
    );
    memory.add(
      makeEntry({
        id: 'fr-1',
        source,
        target: 'Veuillez redémarrer l’application avant de réexporter.',
        sourceLang: 'fr',
        targetLang: 'fr',
        engine: 'machine',
      }),
    );

    expect(memory.match(source, { lang: 'fr' })!.entry.id).toBe('fr-1');
    expect(memory.match(source, { lang: 'en' })!.entry.id).toBe('en-1');
    expect(memory.match(source, { lang: 'FR' })!.entry.id).toBe('fr-1');
    expect(memory.match(source, { lang: 'de' })).toBeNull();
    expect(memory.match(source, { engine: 'machine' })!.entry.id).toBe('fr-1');
    expect(memory.match(source, { engine: 'human' })!.entry.id).toBe('en-1');
    expect(memory.match(source, { engine: 'openai' })).toBeNull();
    expect(memory.match(source)).not.toBeNull();
  });

  it('stores language tags lower-cased so tags group together', () => {
    const memory = new TranslationMemory();
    const stored = memory.add(makeEntry({ id: 'tag', source: 'Alpha.', target: 'Alpha.', sourceLang: 'EN', targetLang: 'VI' }));
    expect(stored.sourceLang).toBe('en');
    expect(stored.targetLang).toBe('vi');
    expect(memory.stats().bySourceLang).toEqual({ en: 1 });
  });

  it('refuses a duplicate id on add and returns null for an unrelated segment', () => {
    const memory = new TranslationMemory();
    memory.add(makeEntry({ id: 'dup', source: 'Hello there.', target: 'Xin chào.' }));
    expectTmError(
      () => memory.add(makeEntry({ id: 'dup', source: 'Different text.', target: 'Khác.' })),
      'duplicate-id',
      'id',
    );
    expect(memory.stats().entries).toBe(1);
    expect(memory.match('Completely different words about weather and mountains')).toBeNull();
  });
});

describe('import and export', () => {
  it('round-trips through exportJson and importJson without loss', () => {
    const memory = new TranslationMemory();
    memory.add(
      makeEntry({
        id: 'alpha',
        source: 'Alpha segment.',
        target: 'Đoạn alpha.',
        model: 'hau-1',
        createdAt: 1_700_000_000_000,
        uses: 2,
      }),
    );
    memory.add(
      makeEntry({
        id: 'beta',
        source: '“Beta” — segment.',
        target: '“Đoạn” — beta.',
        sourceLang: 'fr',
        engine: 'deepl',
        createdAt: 1_700_000_100_000,
        uses: 0,
      }),
    );
    memory.match('Alpha segment.');

    const exported = memory.exportJson();
    const before = memory.stats();
    const parsed = JSON.parse(exported) as { schemaVersion: number; entries: Array<Record<string, unknown>> };
    expect(parsed.schemaVersion).toBe(TM_SCHEMA_VERSION);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]!.model).toBe('hau-1');
    expect(parsed.entries[0]!.uses).toBe(3);
    expect(parsed.entries[1]!.model).toBeUndefined();

    const restored = new TranslationMemory();
    const result = restored.importJson(exported);
    expect(result).toEqual({ imported: 2, total: 2 });
    expect(restored.exportJson()).toBe(exported);
    expect(restored.stats()).toEqual(before);
    expect(restored.match('alpha SEGMENT.')!.entry.uses).toBe(4);
  });

  it('refuses duplicate ids inside one import', () => {
    const memory = new TranslationMemory();
    expectTmError(
      () => memory.importJson(documentWith([rawEntry('dup'), rawEntry('dup')])),
      'duplicate-id',
      'entries[1].id',
    );
    expect(memory.stats().entries).toBe(0);
  });

  it('refuses an id that the memory already holds', () => {
    const memory = new TranslationMemory();
    memory.add(makeEntry({ id: 'taken', source: 'Alpha.', target: 'Alpha.' }));
    expectTmError(() => memory.importJson(documentWith([rawEntry('taken')])), 'duplicate-id', 'entries[0].id');
    expect(memory.stats().entries).toBe(1);
  });

  it('names the path of an entry that is missing source or target', () => {
    const memory = new TranslationMemory();
    const entries = [rawEntry('a'), rawEntry('b'), rawEntry('c'), rawEntry('d', { target: undefined })];
    expectTmError(() => memory.importJson(documentWith(entries)), 'missing-field', 'entries[3].target');

    expectTmError(
      () => memory.importJson(documentWith([rawEntry('a'), rawEntry('b'), rawEntry('c'), rawEntry('d', { source: '   ' })])),
      'missing-field',
      'entries[3].source',
    );
    expect(memory.stats().entries).toBe(0);
  });

  it('refuses an unknown schema version', () => {
    const memory = new TranslationMemory();
    expectTmError(
      () => memory.importJson(JSON.stringify({ schemaVersion: 99, entries: [] })),
      'unsupported-schema-version',
      'schemaVersion',
    );
    expectTmError(
      () => memory.importJson(JSON.stringify({ entries: [] })),
      'unsupported-schema-version',
      'schemaVersion',
    );
  });

  it('refuses malformed JSON and a document with the wrong shape', () => {
    const memory = new TranslationMemory();
    expectTmError(() => memory.importJson('{ "schemaVersion": 1,'), 'malformed-json', '');
    expectTmError(() => memory.importJson('[]'), 'malformed-export', '');
    expectTmError(
      () => memory.importJson(JSON.stringify({ schemaVersion: TM_SCHEMA_VERSION, entries: {} })),
      'malformed-export',
      'entries',
    );
    expectTmError(
      () => memory.importJson(JSON.stringify({ schemaVersion: TM_SCHEMA_VERSION, kind: 'glossary', entries: [] })),
      'malformed-export',
      'kind',
    );
  });

  it('refuses an invalid field value and leaves the memory untouched', () => {
    const memory = new TranslationMemory();
    expectTmError(
      () => memory.importJson(documentWith([rawEntry('a'), rawEntry('b', { uses: 'many' })])),
      'invalid-field',
      'entries[1].uses',
    );
    expectTmError(
      () => memory.importJson(documentWith([rawEntry('a', { createdAt: -1 })])),
      'invalid-field',
      'entries[0].createdAt',
    );
    expectTmError(
      () => memory.importJson(documentWith([rawEntry('a', { engine: 42 })])),
      'invalid-field',
      'entries[0].engine',
    );
    expect(memory.stats().entries).toBe(0);
  });
});

describe('stats', () => {
  it('counts entries by source language, target language and engine', () => {
    const memory = new TranslationMemory();
    memory.add(makeEntry({ id: 'a', source: 'One.', target: 'Một.', sourceLang: 'en', engine: 'human' }));
    memory.add(makeEntry({ id: 'b', source: 'Two.', target: 'Hai.', sourceLang: 'en', engine: 'human' }));
    memory.add(makeEntry({ id: 'c', source: 'Trois.', target: 'Ba.', sourceLang: 'fr', engine: 'deepl' }));
    memory.add(
      makeEntry({ id: 'd', source: 'Vier.', target: 'Bốn.', sourceLang: 'de', engine: 'deepl', uses: 4 }),
    );

    expect(memory.stats()).toEqual({
      entries: 4,
      totalUses: 4,
      bySourceLang: { de: 1, en: 2, fr: 1 },
      byTargetLang: { vi: 4 },
      byEngine: { deepl: 2, human: 2 },
    });
  });
});
