import { glossaryToPrompt, type GlossaryEntry } from './glossary';

/**
 * Content-addressed translation cache (backlog item G13).
 *
 * The cache answers exactly one question: has this text already been translated
 * by this engine with this prompt? Nothing else can decide a hit:
 *
 *     key = sha256(canonical form of the source text, source and target
 *                  language, provider, model, prompt version, glossary)
 *
 * The model, the prompt version and the glossary are inside the digest, so an
 * answer written for `mirror-v2` on `qwen3:4b` with one glossary can never be
 * read back for `mirror-v3`, for `gemma3:12b`, or for a different glossary: the
 * lookup misses by construction, so no caller can forget the comparison.
 *
 * Normalisation decides the lookup, never the stored value. The source text is
 * folded — NFKC, zero-width noise, case, whitespace runs — before hashing, so a
 * paragraph that differs only by extraction spacing still hits. Identity fields
 * are folded conservatively: language tags and provider names are
 * case-insensitive, while model and prompt version are compared exactly, because
 * two model ids that differ only in case are two different names to a server.
 *
 * Every entry keeps the provenance the caller passed to `set`, its hit count,
 * when it was created and last written, and a monotonic recency stamp. `get`
 * bumps the hit count and the stamp; `set` on an existing key replaces the value,
 * keeps the hit count, and records `updatedAt`.
 *
 * `prune` evicts in two passes, so a stale answer can never survive on recency
 * alone: entries whose age has reached the TTL (30 days by default) are dropped
 * first, then the least recently used entries until `maxEntries` hold. Recency is
 * a counter rather than a timestamp, so a clock that steps backwards cannot
 * reorder it. The TTL is applied by `prune`, not by `get`: a stale entry is served
 * until a prune runs.
 *
 * `persist` writes a versioned snapshot and `restore` reads it back. A snapshot
 * from an unknown schema version is refused outright, while a malformed entry
 * inside a known version is dropped and counted, so one corrupt record cannot
 * cost the rest of the cache. A snapshot is trusted as written: its entries were
 * keyed by this cache when it wrote them, and the source text is deliberately not
 * stored, so `restore` cannot re-derive a key to check it.
 */

/** Snapshot schema written by `persist`, and the only version `restore` reads. */
export const CACHE_SCHEMA_VERSION = 1;

/** Age at which `prune` drops an entry as stale: 30 days in milliseconds. */
export const CACHE_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SNAPSHOT_KIND = 'translation-cache';

/** Domain separator, so a digest can never be confused with a digest of another purpose. */
const KEY_DOMAIN = 'mirror-translation-cache:v1';

/** A key is the lowercase hex SHA-256 digest `cacheKey` writes. */
const KEY_PATTERN = /^[0-9a-f]{64}$/;

/** Zero-width characters that PDF extraction leaves inside words. */
const ZERO_WIDTH = /[\u200B\u200C\u200D\u2060\uFEFF]/gu;

export type CacheErrorCode =
  | 'invalid-key'
  | 'invalid-value'
  | 'invalid-meta'
  | 'invalid-option'
  | 'malformed-snapshot'
  | 'unsupported-schema-version';

/** A refused key, value, option or snapshot. Never thrown for a plain miss. */
export class CacheError extends Error {
  readonly code: CacheErrorCode;

  constructor(code: CacheErrorCode, message: string) {
    super(message);
    this.name = 'CacheError';
    this.code = code;
  }
}

/** Everything that decides a hit. The source text is normalised before hashing. */
export interface CacheKeyInput {
  sourceText: string;
  sourceLang: string;
  targetLang: string;
  provider: string;
  model: string;
  promptVersion: string;
  /**
   * Terms the system prompt asks the translator to honour, as
   * `TranslationSettings.glossary` holds them. A glossary changes the prompt, so
   * it changes the answer: pass it, or the cache can serve a translation made for
   * a different glossary. Omitted or empty means "no glossary", and both produce
   * the same key.
   */
  glossary?: Record<string, string>;
}

/** Provenance stored beside an answer. It is reported, never compared. */
export interface CacheMeta {
  sourceLang: string;
  targetLang: string;
  provider: string;
  model: string;
  promptVersion: string;
}

/** A served answer, with the entry's hit count after this hit. */
export interface CacheHit {
  value: string;
  meta: CacheMeta;
  /** Hits this entry has served, including this one. */
  hits: number;
}

export interface CacheStats {
  /** Entries currently stored. */
  entries: number;
  /** Lookups that returned an entry since the last `clear()`. */
  hits: number;
  /** Lookups that found nothing since the last `clear()`. */
  misses: number;
}

export interface CacheOptions {
  /** Clock for `createdAt` and `updatedAt`, epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

export interface CachePruneOptions {
  /** Entries kept after pruning; the LRU pass starts once the cache is larger. */
  maxEntries: number;
  /** Clock reading for the TTL, epoch milliseconds. Defaults to the cache clock. */
  now?: number;
  /** Age at which an entry is stale. Defaults to {@link CACHE_DEFAULT_TTL_MS}. */
  ttlMs?: number;
}

export interface CachePruneResult {
  /** Entries dropped because their age had reached the TTL. */
  removedTtl: number;
  /** Entries dropped to bring the cache down to `maxEntries`. */
  removedLru: number;
}

/** One entry in a persisted cache, with its bookkeeping made explicit. */
export interface CacheSnapshotEntry {
  key: string;
  value: string;
  meta: CacheMeta;
  hits: number;
  createdAt: number;
  updatedAt: number;
  /** Monotonic recency stamp; higher means more recently used. */
  usedAt: number;
}

export interface CacheSnapshot {
  schemaVersion: number;
  kind: 'translation-cache';
  entries: CacheSnapshotEntry[];
}

export interface CacheRestoreResult {
  /** Entries merged from the snapshot, replacing any entry with the same key. */
  loaded: number;
  /** Entries dropped because they were malformed. */
  skipped: number;
}

interface CacheRecord {
  key: string;
  value: string;
  meta: CacheMeta;
  hits: number;
  createdAt: number;
  updatedAt: number;
  usedAt: number;
}

/** FIPS 180-4 initial hash values, kept as a tuple so destructuring needs no casts. */
const SHA256_INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19] as const;

/** FIPS 180-4 round constants. */
const SHA256_ROUNDS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

/**
 * SHA-256 of the UTF-8 bytes of `value`, as lowercase hex.
 *
 * Kept here instead of `crypto.subtle` because a digest must be synchronous and
 * available in every runtime the reader runs in, including a page without a
 * secure context. The tests check it against the platform's own SHA-256.
 */
function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  // One 0x80 terminator, then zeros, then the 64-bit big-endian bit length.
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bits = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);

  const schedule = new Uint32Array(64);
  let h0: number = SHA256_INITIAL[0];
  let h1: number = SHA256_INITIAL[1];
  let h2: number = SHA256_INITIAL[2];
  let h3: number = SHA256_INITIAL[3];
  let h4: number = SHA256_INITIAL[4];
  let h5: number = SHA256_INITIAL[5];
  let h6: number = SHA256_INITIAL[6];
  let h7: number = SHA256_INITIAL[7];

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const w15 = schedule[index - 15]!;
      const w2 = schedule[index - 2]!;
      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      schedule[index] = (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choice + SHA256_ROUNDS[index]! + schedule[index]!) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map(word => word.toString(16).padStart(8, '0')).join('');
}

/** Folds the source text onto the form two identical requests are compared by. */
function normalizeSourceText(value: string): string {
  return value.normalize('NFKC').replace(ZERO_WIDTH, '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/** Language tags and provider names are case-insensitive; model names are not. */
function foldTag(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The glossary as the prompt renders it. `glossaryToPrompt` cleans terms, drops
 * empty pairs and caps the list, so two glossaries that produce the same prompt
 * lines produce the same digest; order is kept because the prompt keeps it.
 */
function glossaryText(glossary: Record<string, string> | undefined): string {
  if (glossary === undefined) return '';
  if (typeof glossary !== 'object' || glossary === null || Array.isArray(glossary)) {
    throw new CacheError('invalid-key', 'glossary must map source terms to target terms.');
  }
  const entries: GlossaryEntry[] = [];
  for (const [source, target] of Object.entries(glossary)) {
    if (typeof source !== 'string' || typeof target !== 'string') {
      throw new CacheError('invalid-key', 'glossary must map source terms to target terms.');
    }
    entries.push({ source, target });
  }
  return glossaryToPrompt(entries);
}

function requireText(value: unknown, field: string, code: CacheErrorCode): string {
  if (typeof value !== 'string') throw new CacheError(code, `${field} must be a string.`);
  return value;
}

/**
 * The stable key of one translation request. The canonical form is
 * `JSON.stringify([domain, normalised source text, sourceLang, targetLang,
 * provider, model, promptVersion, glossary lines])`, hashed with SHA-256; the
 * domain separator keeps this digest apart from any other digest of the same
 * fields.
 */
export function cacheKey(input: CacheKeyInput): string {
  if (typeof input !== 'object' || input === null) {
    throw new CacheError('invalid-key', 'cacheKey needs the source text and the identity fields of the translation.');
  }
  const canonical = JSON.stringify([
    KEY_DOMAIN,
    normalizeSourceText(requireText(input.sourceText, 'sourceText', 'invalid-key')),
    foldTag(requireText(input.sourceLang, 'sourceLang', 'invalid-key')),
    foldTag(requireText(input.targetLang, 'targetLang', 'invalid-key')),
    foldTag(requireText(input.provider, 'provider', 'invalid-key')),
    requireText(input.model, 'model', 'invalid-key').trim(),
    requireText(input.promptVersion, 'promptVersion', 'invalid-key').trim(),
    glossaryText(input.glossary),
  ]);
  return sha256Hex(canonical);
}

function requireKey(value: unknown): string {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new CacheError('invalid-key', 'A cache key must be the 64-character lowercase hex digest returned by cacheKey().');
  }
  return value;
}

function requireValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CacheError('invalid-value', 'A cached translation must be a non-empty string.');
  }
  return value;
}

function requireMeta(value: unknown): CacheMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CacheError('invalid-meta', 'A cached translation needs its provenance as an object.');
  }
  const record = value as Record<string, unknown>;
  const field = (name: keyof CacheMeta): string => {
    const item = record[name];
    if (typeof item !== 'string') throw new CacheError('invalid-meta', `Cache provenance field "${name}" must be a string.`);
    return item;
  };
  return {
    sourceLang: field('sourceLang'),
    targetLang: field('targetLang'),
    provider: field('provider'),
    model: field('model'),
    promptVersion: field('promptVersion'),
  };
}

function requireCount(value: unknown, field: string, code: CacheErrorCode): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new CacheError(code, `${field} must be a non-negative integer.`);
  }
  return value;
}

function requireTime(value: unknown, field: string, code: CacheErrorCode): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CacheError(code, `${field} must be a non-negative epoch time in milliseconds.`);
  }
  return value;
}

/** Reads one persisted entry; a malformed field throws and `restore` drops the entry. */
function readRecord(value: unknown): CacheRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CacheError('malformed-snapshot', 'A snapshot entry must be an object.');
  }
  const record = value as Record<string, unknown>;
  return {
    key: requireKey(record.key),
    value: requireValue(record.value),
    meta: requireMeta(record.meta),
    hits: requireCount(record.hits, 'hits', 'malformed-snapshot'),
    createdAt: requireTime(record.createdAt, 'createdAt', 'malformed-snapshot'),
    updatedAt: requireTime(record.updatedAt, 'updatedAt', 'malformed-snapshot'),
    usedAt: requireCount(record.usedAt, 'usedAt', 'malformed-snapshot'),
  };
}

/** Validates the snapshot envelope; a top-level problem refuses the whole restore. */
function readSnapshot(snapshot: unknown): unknown[] {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new CacheError('malformed-snapshot', 'restore needs the snapshot object returned by persist().');
  }
  const record = snapshot as Record<string, unknown>;
  if (record.schemaVersion !== CACHE_SCHEMA_VERSION) {
    throw new CacheError(
      'unsupported-schema-version',
      `schemaVersion ${String(record.schemaVersion)} is not supported; this build reads version ${CACHE_SCHEMA_VERSION}.`,
    );
  }
  if (record.kind !== undefined && record.kind !== SNAPSHOT_KIND) {
    throw new CacheError('malformed-snapshot', `kind must be "${SNAPSHOT_KIND}" when present.`);
  }
  if (!Array.isArray(record.entries)) {
    throw new CacheError('malformed-snapshot', 'entries must be an array.');
  }
  return record.entries;
}

/** Least recently used first, with the key as a deterministic tie-break. */
function olderFirst(left: CacheRecord, right: CacheRecord): number {
  if (left.usedAt !== right.usedAt) return left.usedAt - right.usedAt;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function byKey(left: CacheSnapshotEntry, right: CacheSnapshotEntry): number {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/**
 * An in-memory translation cache whose keys are digests of the request identity,
 * so a stale or mismatched answer cannot be served. See the module note for the
 * identity, eviction and persistence rules.
 */
export class TranslationCache {
  private readonly clock: () => number;
  private readonly records = new Map<string, CacheRecord>();
  private hits = 0;
  private misses = 0;
  /** Monotonic recency stamp; every access gets the next number. */
  private sequence = 0;

  /**
   * @param options.now Clock for `createdAt` and `updatedAt`; defaults to
   * `Date.now`. Injecting it keeps TTL behaviour testable without fake timers.
   */
  constructor(options: CacheOptions = {}) {
    this.clock = options.now ?? Date.now;
  }

  /**
   * Serves the answer stored under `key`, or null. A hit bumps the entry's hit
   * counter and its recency stamp; a miss is counted and changes nothing else.
   * The returned provenance is a copy, so a caller cannot alter the entry.
   */
  get(key: string): CacheHit | null {
    const digest = requireKey(key);
    const record = this.records.get(digest);
    if (record === undefined) {
      this.misses += 1;
      return null;
    }
    record.hits += 1;
    record.usedAt = this.nextStamp();
    this.hits += 1;
    return { value: record.value, meta: { ...record.meta }, hits: record.hits };
  }

  /**
   * Stores one answer. An existing key keeps its `createdAt` and hit count but
   * takes the new value, provenance, `updatedAt` and recency stamp, so a refreshed
   * answer is never the next eviction candidate.
   */
  set(key: string, value: string, meta: CacheMeta): void {
    const digest = requireKey(key);
    const text = requireValue(value);
    const provenance = requireMeta(meta);
    const now = this.clock();
    const existing = this.records.get(digest);
    this.records.set(digest, {
      key: digest,
      value: text,
      meta: provenance,
      hits: existing?.hits ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      usedAt: this.nextStamp(),
    });
  }

  /** Entry count and lookups served since the last `clear()`. */
  stats(): CacheStats {
    return { entries: this.records.size, hits: this.hits, misses: this.misses };
  }

  /**
   * Drops every entry whose age has reached `ttlMs`, then the least recently used
   * entries until at most `maxEntries` remain. Both passes are counted, and the
   * stale pass runs first so an old answer is always reported as a TTL removal.
   */
  prune(options: CachePruneOptions): CachePruneResult {
    if (typeof options !== 'object' || options === null) {
      throw new CacheError('invalid-option', 'prune needs an options object with maxEntries.');
    }
    const maxEntries = requireCount(options.maxEntries, 'maxEntries', 'invalid-option');
    const now = options.now === undefined ? this.clock() : requireTime(options.now, 'now', 'invalid-option');
    const ttlMs = options.ttlMs === undefined ? CACHE_DEFAULT_TTL_MS : requireTime(options.ttlMs, 'ttlMs', 'invalid-option');

    let removedTtl = 0;
    for (const [key, record] of this.records) {
      if (now - record.updatedAt >= ttlMs) {
        this.records.delete(key);
        removedTtl += 1;
      }
    }

    let removedLru = 0;
    const overflow = this.records.size - maxEntries;
    if (overflow > 0) {
      const victims = [...this.records.values()].sort(olderFirst).slice(0, overflow);
      for (const victim of victims) {
        this.records.delete(victim.key);
        removedLru += 1;
      }
    }
    return { removedTtl, removedLru };
  }

  /** Forgets every entry and resets the lookup counters. */
  clear(): void {
    this.records.clear();
    this.hits = 0;
    this.misses = 0;
    this.sequence = 0;
  }

  /** A JSON-safe, versioned copy of the cache. Entries are ordered by key. */
  persist(): CacheSnapshot {
    const entries: CacheSnapshotEntry[] = [...this.records.values()]
      .map(record => ({
        key: record.key,
        value: record.value,
        meta: { ...record.meta },
        hits: record.hits,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        usedAt: record.usedAt,
      }))
      .sort(byKey);
    return { schemaVersion: CACHE_SCHEMA_VERSION, kind: SNAPSHOT_KIND, entries };
  }

  /**
   * Merges a snapshot into this cache. An entry with the same key is replaced by
   * the snapshot's copy; every other entry stays. A malformed entry is dropped and
   * counted, and the recency stamps it carried are restored so the LRU order
   * survives a restart.
   */
  restore(snapshot: unknown): CacheRestoreResult {
    const raw = readSnapshot(snapshot);
    let loaded = 0;
    let skipped = 0;
    for (const value of raw) {
      let record: CacheRecord;
      try {
        record = readRecord(value);
      } catch {
        skipped += 1;
        continue;
      }
      this.records.set(record.key, record);
      if (record.usedAt > this.sequence) this.sequence = record.usedAt;
      loaded += 1;
    }
    return { loaded, skipped };
  }

  private nextStamp(): number {
    this.sequence += 1;
    return this.sequence;
  }
}
