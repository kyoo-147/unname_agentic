import { describe, expect, it } from 'vitest';
import { glossaryToPrompt } from '../src/core/glossary';
import {
  CACHE_DEFAULT_TTL_MS,
  CACHE_SCHEMA_VERSION,
  CacheError,
  TranslationCache,
  cacheKey,
  type CacheKeyInput,
  type CacheMeta,
} from '../src/core/cache';

const DAY = 24 * 60 * 60 * 1000;
const BASE_TIME = Date.UTC(2026, 0, 15, 9, 30);

/** One translation request; every test states only the fields it changes. */
function identity(overrides: Partial<CacheKeyInput> = {}): CacheKeyInput {
  return {
    sourceText: 'The turbine spins at nine thousand revolutions per minute.',
    sourceLang: 'en',
    targetLang: 'vi',
    provider: 'local',
    model: 'qwen3:4b',
    promptVersion: 'mirror-v2',
    ...overrides,
  };
}

function provenance(overrides: Partial<CacheMeta> = {}): CacheMeta {
  return {
    sourceLang: 'en',
    targetLang: 'vi',
    provider: 'local',
    model: 'qwen3:4b',
    promptVersion: 'mirror-v2',
    ...overrides,
  };
}

interface Clocked {
  cache: TranslationCache;
  /** Moves the injected clock forward, so TTL behaviour needs no fake timers. */
  advance: (ms: number) => void;
  now: () => number;
}

function clockedCache(start = BASE_TIME): Clocked {
  let current = start;
  const cache = new TranslationCache({ now: () => current });
  return { cache, advance: (ms) => { current += ms; }, now: () => current };
}

function expectCacheError(run: () => unknown, code: CacheError['code']): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CacheError);
    expect((error as CacheError).code).toBe(code);
    return;
  }
  throw new Error(`expected a CacheError with code ${code}`);
}

/** The canonical form documented on `cacheKey`, rebuilt from the rules alone. */
const KEY_DOMAIN = 'mirror-translation-cache:v1';

function canonical(input: CacheKeyInput): string {
  const text = input.sourceText
    .normalize('NFKC')
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
  const glossary = glossaryToPrompt(Object.entries(input.glossary ?? {}).map(([source, target]) => ({ source, target })));
  return JSON.stringify([
    KEY_DOMAIN,
    text,
    input.sourceLang.trim().toLowerCase(),
    input.targetLang.trim().toLowerCase(),
    input.provider.trim().toLowerCase(),
    input.model.trim(),
    input.promptVersion.trim(),
    glossary,
  ]);
}

/** Hashes with the platform's own SHA-256, so the cache is not its own referee. */
async function platformDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

describe('cacheKey', () => {
  it('is a stable lowercase hex digest', () => {
    const key = cacheKey(identity());
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey(identity())).toBe(key);
  });

  it('hashes the documented canonical form with SHA-256', async () => {
    const samples: CacheKeyInput[] = [
      identity(),
      identity({
        sourceText: '  Động cơ\tquay   rất nhanh.\n\n',
        sourceLang: 'VI',
        targetLang: 'EN',
        provider: 'LOCAL',
        model: ' qwen3:4b ',
        promptVersion: ' mirror-v2 ',
      }),
      identity({ sourceText: '日本語のテキストと絵文字 😀 を含む段落です。'.repeat(4), targetLang: 'ja' }),
      identity({ glossary: { turbine: 'tuabin', blade: 'cánh' } }),
    ];
    for (const sample of samples) expect(await platformDigest(canonical(sample))).toBe(cacheKey(sample));
  });

  it('folds whitespace, case, zero-width noise and compatibility forms before hashing', () => {
    const plain = cacheKey(identity());
    expect(cacheKey(identity({ sourceText: '  THE   turbine\nspins\tat nine   thousand revolutions per minute.  ' }))).toBe(plain);
    expect(cacheKey(identity({ sourceText: '\u200BThe turbine\u200B spins at nine thousand revolutions per minute.' }))).toBe(plain);
    expect(cacheKey(identity({ sourceText: 'Ｔｈｅ turbine spins at nine thousand revolutions per minute.' }))).toBe(plain);
  });

  it('covers every identity field', () => {
    const base = cacheKey(identity());
    const variants: [string, CacheKeyInput][] = [
      ['source text', identity({ sourceText: 'The compressor runs dry.' })],
      ['source language', identity({ sourceLang: 'fr' })],
      ['target language', identity({ targetLang: 'fr' })],
      ['provider', identity({ provider: 'openai' })],
      ['model', identity({ model: 'gemma3:12b' })],
      ['prompt version', identity({ promptVersion: 'mirror-v3' })],
      ['glossary', identity({ glossary: { turbine: 'tuabin' } })],
    ];
    for (const [field, variant] of variants) expect(cacheKey(variant), field).not.toBe(base);
  });

  it('folders language tags and provider names but not model or prompt version', () => {
    const base = cacheKey(identity());
    expect(cacheKey(identity({ sourceLang: 'EN', targetLang: 'VI', provider: 'LOCAL' }))).toBe(base);
    expect(cacheKey(identity({ model: ' qwen3:4b ' }))).toBe(base);
    expect(cacheKey(identity({ model: 'Qwen3:4B' }))).not.toBe(base);
    expect(cacheKey(identity({ promptVersion: ' mirror-v2 ' }))).toBe(base);
    expect(cacheKey(identity({ promptVersion: 'Mirror-v2' }))).not.toBe(base);
  });

  it('includes the glossary and ignores spacing inside it', () => {
    const base = cacheKey(identity());
    expect(cacheKey(identity({ glossary: {} }))).toBe(base);
    expect(cacheKey(identity({ glossary: { '  turbine  ': ' tuabin ' } }))).toBe(cacheKey(identity({ glossary: { turbine: 'tuabin' } })));
    expect(cacheKey(identity({ glossary: { turbine: 'tuabin' } }))).not.toBe(base);
    // The prompt keeps glossary order, so two orders are two different prompts.
    expect(cacheKey(identity({ glossary: { turbine: 'tuabin', blade: 'cánh' } }))).not.toBe(
      cacheKey(identity({ glossary: { blade: 'cánh', turbine: 'tuabin' } })),
    );
  });

  it('refuses a request it cannot key', () => {
    expectCacheError(() => cacheKey({ ...identity(), sourceText: 42 as unknown as string }), 'invalid-key');
    expectCacheError(() => cacheKey({ ...identity(), glossary: { turbine: 5 } as unknown as Record<string, string> }), 'invalid-key');
  });
});

describe('TranslationCache lookups', () => {
  it('serves identical inputs and counts the hits', () => {
    const { cache } = clockedCache();
    const key = cacheKey(identity());
    expect(cache.get(key)).toBeNull();
    expect(cache.stats()).toEqual({ entries: 0, hits: 0, misses: 1 });

    cache.set(key, 'Tuabin quay chín nghìn vòng mỗi phút.', provenance());
    expect(cache.get(key)).toEqual({ value: 'Tuabin quay chín nghìn vòng mỗi phút.', meta: provenance(), hits: 1 });
    expect(cache.get(key)?.hits).toBe(2);
    expect(cache.stats()).toEqual({ entries: 1, hits: 2, misses: 1 });
  });

  it('misses when any identity field differs', () => {
    const { cache } = clockedCache();
    cache.set(cacheKey(identity()), 'Tuabin quay chín nghìn vòng mỗi phút.', provenance());
    const variants: [string, CacheKeyInput][] = [
      ['source text', identity({ sourceText: 'The compressor runs dry.' })],
      ['source language', identity({ sourceLang: 'fr' })],
      ['target language', identity({ targetLang: 'fr' })],
      ['provider', identity({ provider: 'openai' })],
      ['model', identity({ model: 'gemma3:12b' })],
      ['prompt version', identity({ promptVersion: 'mirror-v3' })],
      ['glossary', identity({ glossary: { turbine: 'tuabin' } })],
    ];
    for (const [field, variant] of variants) expect(cache.get(cacheKey(variant)), field).toBeNull();
    expect(cache.stats()).toEqual({ entries: 1, hits: 0, misses: variants.length });
  });

  it('reports provenance as a copy', () => {
    const { cache } = clockedCache();
    const key = cacheKey(identity());
    cache.set(key, 'Tuabin quay.', provenance());
    const hit = cache.get(key)!;
    hit.meta.model = 'tampered';
    expect(cache.get(key)?.meta.model).toBe('qwen3:4b');
  });

  it('keeps the hit count when an answer is refreshed and restarts its age', () => {
    const { cache, advance } = clockedCache();
    const key = cacheKey(identity());
    cache.set(key, 'first answer', provenance());
    cache.get(key);
    cache.get(key);

    advance(10 * DAY);
    cache.set(key, 'second answer', provenance());
    const refreshed = cache.get(key)!;
    expect(refreshed.value).toBe('second answer');
    expect(refreshed.hits).toBe(3);

    // Thirty days after the first write but twenty after the refresh: fresh.
    advance(20 * DAY);
    expect(cache.prune({ maxEntries: 10 })).toEqual({ removedTtl: 0, removedLru: 0 });
    expect(cache.get(key)?.value).toBe('second answer');

    // Thirty days after the refresh: stale.
    advance(10 * DAY);
    expect(cache.prune({ maxEntries: 10 })).toEqual({ removedTtl: 1, removedLru: 0 });
  });
});

describe('prune', () => {
  it('drops entries that reached the TTL before counting evictions', () => {
    const { cache, advance, now } = clockedCache();
    const stale = cacheKey(identity({ sourceText: 'Stale block.' }));
    cache.set(stale, 'old answer', provenance());
    advance(20 * DAY);
    const fresh = cacheKey(identity({ sourceText: 'Fresh block.' }));
    cache.set(fresh, 'new answer', provenance());
    advance(15 * DAY);

    expect(cache.prune({ maxEntries: 10, now: now() })).toEqual({ removedTtl: 1, removedLru: 0 });
    expect(cache.stats().entries).toBe(1);
    expect(cache.get(stale)).toBeNull();
    expect(cache.get(fresh)?.value).toBe('new answer');
  });

  it('evicts the least recently used entry when the cache is over the limit', () => {
    const { cache, now } = clockedCache();
    const a = cacheKey(identity({ sourceText: 'Block A.' }));
    const b = cacheKey(identity({ sourceText: 'Block B.' }));
    const c = cacheKey(identity({ sourceText: 'Block C.' }));
    cache.set(a, 'A', provenance());
    cache.set(b, 'B', provenance());
    cache.set(c, 'C', provenance());
    // Reading A makes B the least recently used entry.
    cache.get(a);

    expect(cache.prune({ maxEntries: 2, now: now() })).toEqual({ removedTtl: 0, removedLru: 1 });
    expect(cache.get(a)?.value).toBe('A');
    expect(cache.get(b)).toBeNull();
    expect(cache.get(c)?.value).toBe('C');
  });

  it('counts the TTL pass and the LRU pass separately', () => {
    const { cache, advance, now } = clockedCache();
    const stale = cacheKey(identity({ sourceText: 'Stale block.' }));
    cache.set(stale, 'stale', provenance());
    advance(31 * DAY);
    const older = cacheKey(identity({ sourceText: 'Fresh block one.' }));
    const newer = cacheKey(identity({ sourceText: 'Fresh block two.' }));
    cache.set(older, 'one', provenance());
    cache.set(newer, 'two', provenance());

    expect(cache.prune({ maxEntries: 1, now: now() })).toEqual({ removedTtl: 1, removedLru: 1 });
    expect(cache.stats().entries).toBe(1);
    expect(cache.get(older)).toBeNull();
    expect(cache.get(newer)?.value).toBe('two');
  });

  it('keeps the cache when nothing is stale and it fits', () => {
    const { cache, now } = clockedCache();
    cache.set(cacheKey(identity()), 'Tuabin quay.', provenance());
    expect(cache.prune({ maxEntries: 5, now: now() })).toEqual({ removedTtl: 0, removedLru: 0 });
    expect(cache.stats().entries).toBe(1);
  });

  it('treats an entry as stale at exactly the default TTL', () => {
    const { cache, advance, now } = clockedCache();
    cache.set(cacheKey(identity()), 'Tuabin quay.', provenance());
    advance(CACHE_DEFAULT_TTL_MS - 1);
    expect(cache.prune({ maxEntries: 5, now: now() })).toEqual({ removedTtl: 0, removedLru: 0 });
    advance(1);
    expect(cache.prune({ maxEntries: 5, now: now() })).toEqual({ removedTtl: 1, removedLru: 0 });
  });

  it('honours a custom TTL', () => {
    const { cache, advance, now } = clockedCache();
    cache.set(cacheKey(identity()), 'Tuabin quay.', provenance());
    advance(2000);
    expect(cache.prune({ maxEntries: 5, now: now(), ttlMs: 5000 })).toEqual({ removedTtl: 0, removedLru: 0 });
    expect(cache.prune({ maxEntries: 5, now: now(), ttlMs: 1000 })).toEqual({ removedTtl: 1, removedLru: 0 });
  });

  it('refuses an invalid limit', () => {
    const { cache } = clockedCache();
    expectCacheError(() => cache.prune({ maxEntries: -1 }), 'invalid-option');
    expectCacheError(() => cache.prune({ maxEntries: 1.5 }), 'invalid-option');
  });
});

describe('persist and restore', () => {
  it('writes a versioned snapshot ordered by key', () => {
    const { cache } = clockedCache();
    const a = cacheKey(identity({ sourceText: 'Block A.' }));
    const b = cacheKey(identity({ sourceText: 'Block B.' }));
    cache.set(b, 'B', provenance());
    cache.set(a, 'A', provenance());

    const snapshot = cache.persist();
    expect(snapshot.schemaVersion).toBe(CACHE_SCHEMA_VERSION);
    expect(snapshot.kind).toBe('translation-cache');
    expect(snapshot.entries.map(entry => entry.key)).toEqual([a, b].sort());
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('round-trips values, provenance and hit counts', () => {
    const { cache } = clockedCache();
    const key = cacheKey(identity());
    cache.set(key, 'Tuabin quay.', provenance());
    cache.get(key);
    cache.get(key);

    const restored = new TranslationCache();
    expect(restored.restore(cache.persist())).toEqual({ loaded: 1, skipped: 0 });
    expect(restored.get(key)).toEqual({ value: 'Tuabin quay.', meta: provenance(), hits: 3 });
    expect(restored.stats()).toEqual({ entries: 1, hits: 1, misses: 0 });
  });

  it('restores the least-recently-used order', () => {
    const { cache, now } = clockedCache();
    const a = cacheKey(identity({ sourceText: 'Block A.' }));
    const b = cacheKey(identity({ sourceText: 'Block B.' }));
    const c = cacheKey(identity({ sourceText: 'Block C.' }));
    cache.set(a, 'A', provenance());
    cache.set(b, 'B', provenance());
    cache.get(a);

    const restored = new TranslationCache();
    restored.restore(cache.persist());
    restored.set(c, 'C', provenance());
    expect(restored.prune({ maxEntries: 2, now: now() })).toEqual({ removedTtl: 0, removedLru: 1 });
    expect(restored.get(b)).toBeNull();
    expect(restored.get(a)?.value).toBe('A');
  });

  it('refuses a snapshot from an unknown schema version', () => {
    const { cache } = clockedCache();
    cache.set(cacheKey(identity()), 'Tuabin quay.', provenance());
    const snapshot = { ...cache.persist(), schemaVersion: CACHE_SCHEMA_VERSION + 1 };

    const restored = new TranslationCache();
    expectCacheError(() => restored.restore(snapshot), 'unsupported-schema-version');
    expect(restored.stats().entries).toBe(0);
  });

  it('skips malformed entries and counts them', () => {
    const good = cacheKey(identity());
    const other = cacheKey(identity({ sourceText: 'Another block.' }));
    const entry = { key: other, value: 'other', meta: provenance(), hits: 0, createdAt: BASE_TIME, updatedAt: BASE_TIME, usedAt: 1 };
    const snapshot = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      kind: 'translation-cache',
      entries: [
        { key: good, value: 'Tuabin quay.', meta: provenance(), hits: 2, createdAt: BASE_TIME, updatedAt: BASE_TIME, usedAt: 7 },
        { ...entry, key: 'not-a-digest' },
        { ...entry, value: '' },
        { ...entry, meta: { ...provenance(), model: 7 } },
        { ...entry, hits: -1 },
        { ...entry, createdAt: 'yesterday' },
        { key: other, value: 'other', meta: provenance(), hits: 0, createdAt: BASE_TIME, updatedAt: BASE_TIME },
        null,
        ['not an object'],
      ],
    };

    const restored = new TranslationCache();
    expect(restored.restore(snapshot)).toEqual({ loaded: 1, skipped: 8 });
    expect(restored.stats().entries).toBe(1);
    expect(restored.get(good)?.value).toBe('Tuabin quay.');
  });

  it('refuses a snapshot that is not a cache document', () => {
    const cache = new TranslationCache();
    expectCacheError(() => cache.restore(null), 'malformed-snapshot');
    expectCacheError(() => cache.restore('{"schemaVersion":1}'), 'malformed-snapshot');
    expectCacheError(() => cache.restore({ schemaVersion: CACHE_SCHEMA_VERSION, entries: 'nope' }), 'malformed-snapshot');
  });
});

describe('clear', () => {
  it('empties the entries and the lookup counters', () => {
    const { cache } = clockedCache();
    const key = cacheKey(identity());
    cache.set(key, 'Tuabin quay.', provenance());
    cache.get(key);
    cache.get(cacheKey(identity({ model: 'gemma3:12b' })));
    expect(cache.stats()).toEqual({ entries: 1, hits: 1, misses: 1 });

    cache.clear();
    expect(cache.stats()).toEqual({ entries: 0, hits: 0, misses: 0 });
    expect(cache.get(key)).toBeNull();
    expect(cache.stats()).toEqual({ entries: 0, hits: 0, misses: 1 });
  });
});

describe('refusals', () => {
  it('refuses a key that is not a digest from cacheKey', () => {
    const { cache } = clockedCache();
    expectCacheError(() => cache.get('not-a-digest'), 'invalid-key');
    expectCacheError(() => cache.set('not-a-digest', 'value', provenance()), 'invalid-key');
    expectCacheError(() => cache.set(cacheKey(identity()).toUpperCase(), 'value', provenance()), 'invalid-key');
    expect(cache.stats().entries).toBe(0);
  });

  it('refuses an empty answer and incomplete provenance', () => {
    const { cache } = clockedCache();
    const key = cacheKey(identity());
    expectCacheError(() => cache.set(key, '', provenance()), 'invalid-value');
    expectCacheError(() => cache.set(key, 'value', { ...provenance(), model: undefined } as unknown as CacheMeta), 'invalid-meta');
    expect(cache.stats().entries).toBe(0);
  });
});
