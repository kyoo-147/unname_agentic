/**
 * Reusable segment translation memory (backlog item G04).
 *
 * A translation memory keeps the text a human translator or an earlier engine
 * produced for a source segment, so a repeated paragraph can be reused instead
 * of translated again. Each entry also keeps its provenance: the id, the engine
 * and model that produced it, when it was created, and how often a match has
 * returned it (`uses`).
 *
 * Normalisation runs in two steps. `normalizeText` trims, collapses runs of
 * whitespace and folds curly quotes and dashes onto ASCII while keeping the
 * original letter case, so stored text stays readable. `matchKey` then
 * case-folds that result; only the key is case-insensitive, never the stored
 * text.
 *
 * Similarity is the Jaccard index over word trigrams of the two match keys:
 * the number of shared trigrams divided by the number of distinct trigrams in
 * both sets. Words are runs of Unicode letters and digits, so punctuation only
 * separates them. The word sequence is wrapped in a start and an end boundary
 * marker, which means a one- or two-word segment still produces one trigram
 * instead of an empty set:
 *
 *     trigrams("alpha beta") = { "\u0002 alpha beta", "alpha beta \u0003" }
 *
 * Identical match keys short-circuit to 1. A segment with fewer than three
 * words can therefore only match exactly. Similarity search is a linear scan
 * over the entries that pass the filters, which keeps the result deterministic
 * and is fast enough for a per-document memory.
 */

/** One reusable segment, with the provenance needed to trace where it came from. */
export interface TmEntry {
  id: string;
  source: string;
  target: string;
  sourceLang: string;
  targetLang: string;
  /** Producer of the translation, for example `human`, `deepl` or `openai`. */
  engine: string;
  /** Model identity when the engine has one. */
  model?: string;
  /** Epoch milliseconds supplied by the caller; the memory never reads the clock. */
  createdAt: number;
  /** How many matches have returned this entry. */
  uses: number;
}

/** An entry to add; `uses` defaults to 0 so a fresh entry needs no bookkeeping. */
export type TmEntryInput = Omit<TmEntry, 'uses'> & { uses?: number };

/** Schema version written by `exportJson` and the only version `importJson` reads. */
export const TM_SCHEMA_VERSION = 1;

/** Similarity floor used by `match` when no `minScore` is given. */
export const TM_DEFAULT_MIN_SCORE = 0.85;

const EXPORT_KIND = 'translation-memory';

export interface TmMatchOptions {
  /** Lowest similarity accepted for a non-exact match, between 0 and 1. */
  minScore?: number;
  /** Keep only entries whose `sourceLang` equals this tag (case-insensitive). */
  lang?: string;
  /** Keep only entries produced by this engine (case-sensitive). */
  engine?: string;
}

export type TmMatchKind = 'exact' | 'similar';

/** A reusable translation plus the score and provenance it was found with. */
export interface TmMatch {
  entry: TmEntry;
  score: number;
  kind: TmMatchKind;
}

export interface TmStats {
  entries: number;
  totalUses: number;
  bySourceLang: Record<string, number>;
  byTargetLang: Record<string, number>;
  byEngine: Record<string, number>;
}

export interface TmImportResult {
  imported: number;
  total: number;
}

export type TmErrorCode =
  | 'malformed-json'
  | 'malformed-export'
  | 'unsupported-schema-version'
  | 'duplicate-id'
  | 'missing-field'
  | 'invalid-field'
  | 'invalid-option';

/** A refused import, entry or option, located by a path such as `entries[3].target`. */
export class TmError extends Error {
  readonly code: TmErrorCode;
  readonly path: string;

  constructor(code: TmErrorCode, message: string, path = '') {
    super(path ? `${path}: ${message}` : message);
    this.name = 'TmError';
    this.code = code;
    this.path = path;
  }
}

const START_MARKER = '\u0002';
const END_MARKER = '\u0003';

/** Curly quotes, dashes and their lookalikes, folded to ASCII by `normalizeText`. */
const FOLDABLE = /[\u00AB\u00BB\u2010\u2011\u2012\u2013\u2014\u2015\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u2032\u2033\u2039\u203A\u2212]/g;

const FOLDED: Record<string, string> = {
  '\u00AB': '"',
  '\u00BB': '"',
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2018': "'",
  '\u2019': "'",
  '\u201A': "'",
  '\u201B': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u201E': '"',
  '\u201F': '"',
  '\u2032': "'",
  '\u2033': '"',
  '\u2039': "'",
  '\u203A': "'",
  '\u2212': '-',
};

const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Trims, collapses whitespace, and folds curly quotes and dashes onto ASCII.
 * Case is preserved: only `matchKey` folds case.
 */
export function normalizeText(value: string): string {
  return value
    .replace(FOLDABLE, char => FOLDED[char] ?? char)
    .replace(/\s+/gu, ' ')
    .trim();
}

/** The case-folded, normalised key two segments are compared by. */
export function matchKey(value: string): string {
  return normalizeText(value).toLowerCase();
}

function tokensOf(key: string): string[] {
  const tokens: string[] = [START_MARKER];
  const words = key.match(WORD);
  if (words) tokens.push(...words);
  tokens.push(END_MARKER);
  return tokens;
}

function trigramsOfKey(key: string): Set<string> {
  const tokens = tokensOf(key);
  const trigrams = new Set<string>();
  for (let index = 0; index + 3 <= tokens.length; index += 1) {
    trigrams.add(`${tokens[index]!} ${tokens[index + 1]!} ${tokens[index + 2]!}`);
  }
  return trigrams;
}

/** The word-trigram set a segment contributes to the Jaccard score. */
export function wordTrigrams(text: string): Set<string> {
  return trigramsOfKey(matchKey(text));
}

function scoreKeys(leftKey: string, rightKey: string): number {
  if (leftKey === rightKey) return 1;
  const left = trigramsOfKey(leftKey);
  const right = trigramsOfKey(rightKey);
  let shared = 0;
  for (const trigram of left) {
    if (right.has(trigram)) shared += 1;
  }
  const combined = left.size + right.size - shared;
  return combined === 0 ? 0 : shared / combined;
}

/** Jaccard similarity over word trigrams, between 0 and 1. */
export function scoreSimilarity(left: string, right: string): number {
  return scoreKeys(matchKey(left), matchKey(right));
}

interface TmRecord {
  entry: TmEntry;
  key: string;
}

interface TmDocument {
  schemaVersion: number;
  kind: string;
  entries: TmEntry[];
}

function labelOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? path : path.slice(dot + 1);
}

function requireText(value: unknown, path: string): string {
  if (value === undefined || value === null) {
    throw new TmError('missing-field', `${labelOf(path)} is required.`, path);
  }
  if (typeof value !== 'string') {
    throw new TmError('invalid-field', `${labelOf(path)} must be a string.`, path);
  }
  const text = normalizeText(value);
  if (!text) {
    throw new TmError('missing-field', `${labelOf(path)} cannot be empty.`, path);
  }
  return text;
}

function optionalText(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new TmError('invalid-field', `${labelOf(path)} must be a string when present.`, path);
  }
  const text = normalizeText(value);
  if (!text) {
    throw new TmError('invalid-field', `${labelOf(path)} cannot be blank when present.`, path);
  }
  return text;
}

function requireLanguage(value: unknown, path: string): string {
  return requireText(value, path).toLowerCase();
}

function requireTimestamp(value: unknown, path: string): number {
  if (value === undefined || value === null) {
    throw new TmError('missing-field', `${labelOf(path)} is required.`, path);
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TmError('invalid-field', `${labelOf(path)} must be a non-negative integer of epoch milliseconds.`, path);
  }
  return value;
}

function requireUses(value: unknown, path: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TmError('invalid-field', `${labelOf(path)} must be a non-negative integer.`, path);
  }
  return value;
}

/** Reads one entry, naming the failing field with the given path prefix. */
function parseEntry(value: unknown, prefix: string): TmEntry {
  const at = (field: string): string => (prefix ? `${prefix}.${field}` : field);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TmError('malformed-export', 'a translation memory entry must be an object.', prefix || 'entry');
  }
  const record = value as Record<string, unknown>;
  const entry: TmEntry = {
    id: requireText(record.id, at('id')),
    source: requireText(record.source, at('source')),
    target: requireText(record.target, at('target')),
    sourceLang: requireLanguage(record.sourceLang, at('sourceLang')),
    targetLang: requireLanguage(record.targetLang, at('targetLang')),
    engine: requireText(record.engine, at('engine')),
    createdAt: requireTimestamp(record.createdAt, at('createdAt')),
    uses: requireUses(record.uses, at('uses')),
  };
  const model = optionalText(record.model, at('model'));
  return model === undefined ? entry : { ...entry, model };
}

/** Writes an entry with a fixed key order so exports are byte-stable. */
function serializeEntry(entry: TmEntry): TmEntry {
  return {
    id: entry.id,
    source: entry.source,
    target: entry.target,
    sourceLang: entry.sourceLang,
    targetLang: entry.targetLang,
    engine: entry.engine,
    ...(entry.model === undefined ? {} : { model: entry.model }),
    createdAt: entry.createdAt,
    uses: entry.uses,
  };
}

function parseDocument(json: string): unknown[] {
  if (typeof json !== 'string') {
    throw new TmError('malformed-json', 'importJson needs the JSON text of an exported translation memory.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'the text could not be parsed';
    throw new TmError('malformed-json', `the text is not valid JSON (${detail}).`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TmError('malformed-export', 'a translation memory export must be a JSON object.');
  }
  const document = parsed as Record<string, unknown>;
  if (document.schemaVersion !== TM_SCHEMA_VERSION) {
    throw new TmError(
      'unsupported-schema-version',
      `schemaVersion ${String(document.schemaVersion)} is not supported; this build reads version ${TM_SCHEMA_VERSION}.`,
      'schemaVersion',
    );
  }
  if (document.kind !== undefined && document.kind !== EXPORT_KIND) {
    throw new TmError('malformed-export', `kind must be "${EXPORT_KIND}" when present.`, 'kind');
  }
  if (!Array.isArray(document.entries)) {
    throw new TmError('malformed-export', 'entries must be an array.', 'entries');
  }
  return document.entries;
}

/** Prefers the most reused entry, then the newest, then the lowest id. */
function preferredFirst(left: TmEntry, right: TmEntry): number {
  if (left.uses !== right.uses) return right.uses - left.uses;
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function matchesFilters(entry: TmEntry, lang: string | undefined, engine: string | undefined): boolean {
  if (lang !== undefined && entry.sourceLang !== lang) return false;
  if (engine !== undefined && entry.engine !== engine) return false;
  return true;
}

function readFilter(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new TmError('invalid-option', `${labelOf(path)} must be a string.`, path);
  }
  const text = normalizeText(value);
  if (!text) throw new TmError('invalid-option', `${labelOf(path)} cannot be blank.`, path);
  return text;
}

function countInto(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function toCountRecord(counts: Map<string, number>): Record<string, number> {
  const keys = [...counts.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(keys.map(key => [key, counts.get(key)!]));
}

/**
 * An in-memory translation memory. Entries are keyed by id and indexed by match
 * key; add and import keep the two indexes in step.
 */
export class TranslationMemory {
  private readonly records: TmRecord[] = [];
  private readonly byId = new Map<string, TmRecord>();
  private readonly byKey = new Map<string, TmRecord[]>();

  /**
   * Adds one entry. The source and target are stored normalised but keep their
   * case, languages are stored lower-cased so tags group together, and a
   * duplicate id is refused instead of overwriting the entry it would replace.
   */
  add(input: TmEntryInput): TmEntry {
    const entry = parseEntry(input, '');
    if (this.byId.has(entry.id)) {
      throw new TmError('duplicate-id', `id "${entry.id}" is already in the translation memory.`, 'id');
    }
    return this.index({ entry, key: matchKey(entry.source) });
  }

  /**
   * Finds the best reusable translation for `source`. An exact match wins with a
   * score of 1; otherwise the highest trigram similarity at or above `minScore`
   * is returned. `lang` filters on `sourceLang` and `engine` on `engine`, so a
   * caller can ask only for human translations or only for one engine. A
   * returned match counts as a use and comes back with `uses` already bumped.
   */
  match(source: string, options: TmMatchOptions = {}): TmMatch | null {
    if (typeof source !== 'string') {
      throw new TmError('invalid-option', 'match needs the source segment as text.', 'source');
    }
    const minScore = options.minScore ?? TM_DEFAULT_MIN_SCORE;
    if (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < 0 || minScore > 1) {
      throw new TmError('invalid-option', 'minScore must be a finite number between 0 and 1.', 'options.minScore');
    }
    const lang = readFilter(options.lang, 'options.lang')?.toLowerCase();
    const engine = readFilter(options.engine, 'options.engine');

    const key = matchKey(source);
    if (!key) return null;

    const bucket = this.byKey.get(key);
    if (bucket) {
      let exact: TmRecord | null = null;
      for (const record of bucket) {
        if (!matchesFilters(record.entry, lang, engine)) continue;
        if (exact === null || preferredFirst(record.entry, exact.entry) < 0) exact = record;
      }
      if (exact) return this.consume(exact, 1, 'exact');
    }

    let best: TmRecord | null = null;
    let bestScore = 0;
    for (const record of this.records) {
      if (!matchesFilters(record.entry, lang, engine)) continue;
      const score = scoreKeys(key, record.key);
      if (score < minScore) continue;
      if (best === null || score > bestScore || (score === bestScore && preferredFirst(record.entry, best.entry) < 0)) {
        best = record;
        bestScore = score;
      }
    }
    return best === null ? null : this.consume(best, bestScore, 'similar');
  }

  /** Entry counts and use totals, grouped by source language, target language and engine. */
  stats(): TmStats {
    const bySourceLang = new Map<string, number>();
    const byTargetLang = new Map<string, number>();
    const byEngine = new Map<string, number>();
    let totalUses = 0;
    for (const record of this.records) {
      const { entry } = record;
      totalUses += entry.uses;
      countInto(bySourceLang, entry.sourceLang);
      countInto(byTargetLang, entry.targetLang);
      countInto(byEngine, entry.engine);
    }
    return {
      entries: this.records.length,
      totalUses,
      bySourceLang: toCountRecord(bySourceLang),
      byTargetLang: toCountRecord(byTargetLang),
      byEngine: toCountRecord(byEngine),
    };
  }

  /** Serialises the memory in insertion order; the output is byte-stable. */
  exportJson(): string {
    const document: TmDocument = {
      schemaVersion: TM_SCHEMA_VERSION,
      kind: EXPORT_KIND,
      entries: this.records.map(record => serializeEntry(record.entry)),
    };
    return JSON.stringify(document, null, 2);
  }

  /**
   * Merges the entries of an export. Every entry is validated before any is
   * added, so a refused import leaves the memory exactly as it was. Unknown
   * top-level fields and unknown entry fields are ignored; ids already present
   * or repeated inside the document are refused.
   */
  importJson(json: string): TmImportResult {
    const raw = parseDocument(json);
    const incoming: TmRecord[] = [];
    const seen = new Set<string>();
    raw.forEach((value, index) => {
      const path = `entries[${index}]`;
      const entry = parseEntry(value, path);
      if (seen.has(entry.id)) {
        throw new TmError('duplicate-id', `id "${entry.id}" appears more than once in this import.`, `${path}.id`);
      }
      if (this.byId.has(entry.id)) {
        throw new TmError('duplicate-id', `id "${entry.id}" is already in the translation memory.`, `${path}.id`);
      }
      seen.add(entry.id);
      incoming.push({ entry, key: matchKey(entry.source) });
    });
    for (const record of incoming) this.index(record);
    return { imported: incoming.length, total: this.records.length };
  }

  private index(record: TmRecord): TmEntry {
    this.records.push(record);
    this.byId.set(record.entry.id, record);
    const bucket = this.byKey.get(record.key);
    if (bucket) bucket.push(record);
    else this.byKey.set(record.key, [record]);
    return { ...record.entry };
  }

  private consume(record: TmRecord, score: number, kind: TmMatchKind): TmMatch {
    record.entry = { ...record.entry, uses: record.entry.uses + 1 };
    return { entry: { ...record.entry }, score, kind };
  }
}
