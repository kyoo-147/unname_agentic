/**
 * Hybrid retrieval over the Document IR: Okapi BM25 + deterministic local vector
 * embeddings + metadata filtering + Reciprocal Rank Fusion (backlog item I02).
 *
 * Composes {@link chunkDocument}, {@link index}, {@link search}, and {@link tokenize}
 * from `./retrieval` alongside {@link DocumentIR} and {@link Block} from `./ir`,
 * {@link normalizeLanguageCode} from `./language`, and {@link SYNONYM_PAIRS} from
 * `./query`.
 *
 * Contract:
 * - Pure, deterministic, and 100% offline: no clock, no randomness, no DOM, no network
 *   requests, and no filesystem I/O. Identical inputs produce identical vectors, scores,
 *   rankings, traces, and canonical JSON snapshots.
 * - Vectors produced by {@link createLocalEmbedder} combine folded word unigrams, word
 *   bigrams, character 3/4-grams, optional bilingual VN/EN concept anchors, and corpus
 *   TF-IDF weighting into fixed-dimension L2-normalized vectors via signed multi-probe
 *   feature hashing.
 * - Callers may plug in any synchronous {@link LocalEmbedder} adapter; the index stores
 *   normalized vectors and validates dimensionality and embedder identity across
 *   serialization boundaries.
 */

import type { Block, DocumentIR } from './ir';
import { normalizeLanguageCode } from './language';
import { SYNONYM_PAIRS } from './query';
import {
  DEFAULT_SEARCH_LIMIT,
  chunkDocument,
  index as buildBm25Index,
  search as searchBm25,
  tokenize,
  type Chunk,
  type ChunkKind,
  type RetrievalIndex,
  type SearchHit,
} from './retrieval';

// --- Public constants ------------------------------------------------------

/** Snapshot schema version written by {@link serializeHybridIndex}. */
export const HYBRID_INDEX_SCHEMA_VERSION = 1;

/** Default embedding dimensionality for {@link createLocalEmbedder}. */
export const DEFAULT_EMBEDDING_DIMENSIONS = 384;

/** Default Reciprocal Rank Fusion smoothing constant (`1 / (k + rank)`). */
export const DEFAULT_RRF_K = 60;

/** Default weight applied to BM25 reciprocal rank contributions. */
export const DEFAULT_BM25_WEIGHT = 1;

/** Default weight applied to semantic cosine reciprocal rank contributions. */
export const DEFAULT_SEMANTIC_WEIGHT = 1;

/** Default minimum cosine similarity required to enter semantic rankings. */
export const DEFAULT_MIN_SEMANTIC_SCORE = 0.08;

/** Built-in TF-IDF n-gram embedder identifier. */
export const DEFAULT_LOCAL_EMBEDDER_ID = 'local-tfidf-ngram-v1';

const SCORE_DECIMALS = 6;
const HASH_PROBES = 2;
const INV_SQRT_PROBES = 1 / Math.sqrt(HASH_PROBES);

const WEIGHT_UNIGRAM = 1;
const WEIGHT_BIGRAM = 0.65;
const WEIGHT_CHAR_NGRAM = 0.45;
const WEIGHT_BILINGUAL_CONCEPT = 1.4;

const CHUNK_KINDS: ReadonlySet<ChunkKind> = new Set(['section', 'block', 'table']);
const SECTION_PREFIX_PATTERN = /^(?:section|sec|clause|muc|phan|chuong|chapter|dieu|§)\.?\s+/iu;
const SECTION_CODE_PATTERN = /^(?:\d+(?:\.\d+)*|[ivxlcdm]+)$/iu;

// --- Error model -----------------------------------------------------------

export type HybridRetrievalErrorCode =
  | 'invalid-option'
  | 'dimension-mismatch'
  | 'malformed-json'
  | 'malformed-index'
  | 'unsupported-version'
  | 'missing-embedder'
  | 'incompatible-embedder';

/** Explicit error raised on invalid options, mismatched vector dimensions, or corrupt snapshots. */
export class HybridRetrievalError extends Error {
  readonly code: HybridRetrievalErrorCode;

  constructor(code: HybridRetrievalErrorCode, message: string) {
    super(message);
    this.name = 'HybridRetrievalError';
    this.code = code;
  }
}

// --- Public interfaces -----------------------------------------------------

/** Pluggable local embedding adapter contract. */
export interface LocalEmbedder {
  readonly id?: string;
  readonly dimensions?: number;
  embed(text: string): number[];
  embedBatch?(texts: readonly string[]): number[][];
  fit?(texts: readonly string[]): void;
}

/** Serializable corpus statistics for {@link LocalTfIdfEmbedder}. */
export interface LocalTfIdfEmbedderState {
  readonly id: string;
  readonly dimensions: number;
  readonly bilingualConceptBridge: boolean;
  readonly documentCount: number;
  readonly documentFrequencies: Readonly<Record<string, number>>;
}

/** Deterministic local char/word n-gram + TF-IDF embedder. */
export interface LocalTfIdfEmbedder extends LocalEmbedder {
  readonly id: string;
  readonly dimensions: number;
  embed(text: string): number[];
  embedBatch(texts: readonly string[]): number[][];
  fit(texts: readonly string[]): void;
  exportState(): LocalTfIdfEmbedderState;
}

export interface LocalEmbedderOptions {
  id?: string;
  dimensions?: number;
  corpus?: readonly string[];
  bilingualConceptBridge?: boolean;
  state?: LocalTfIdfEmbedderState;
}

/** Metadata tracked per chunk for filtering and provenance. */
export interface ChunkMetadata {
  documentId: string;
  page: number;
  pageEnd: number;
  kind: ChunkKind;
  headingPath: string[];
  language: string;
  languages: string[];
}

export interface PageRangeBounds {
  min?: number;
  max?: number;
  from?: number;
  to?: number;
}

export type PageRangeFilter = PageRangeBounds | readonly [number, number];

export type MetadataFilterField = 'documentId' | 'pageRange' | 'kind' | 'section' | 'language';

/** Metadata filter constraints combined with logical AND across specified fields. */
export interface MetadataFilter {
  documentId?: string;
  documentIds?: readonly string[];
  pageRange?: PageRangeFilter;
  kind?: ChunkKind | readonly ChunkKind[];
  section?: string | readonly string[];
  language?: string | readonly string[];
}

export interface MetadataFilterMatch {
  matched: boolean;
  fields: MetadataFilterField[];
}

export interface RrfSourceList {
  readonly name: string;
  readonly ids: readonly string[];
  readonly weight?: number;
}

export interface RrfOptions {
  k?: number;
}

export interface RrfResult {
  id: string;
  score: number;
  ranks: Record<string, number | null>;
}

export type HybridRetrievalMode = 'hybrid' | 'bm25' | 'semantic';

export interface HybridSearchTrace {
  bm25Rank: number | null;
  bm25Score: number;
  semanticRank: number | null;
  semanticScore: number;
  fusedScore: number;
  matchedFilter: boolean;
  matchedFilterFields: MetadataFilterField[];
}

export interface HybridSearchHit {
  chunk: Chunk;
  score: number;
  matchedTerms: string[];
  metadata: ChunkMetadata;
  trace: HybridSearchTrace;
}

export interface SemanticSearchHit {
  chunk: Chunk;
  score: number;
  metadata: ChunkMetadata;
  matchedFilter: boolean;
}

export interface HybridSearchOptions {
  limit?: number;
  filters?: MetadataFilter;
  mode?: HybridRetrievalMode;
  rrfK?: number;
  bm25Weight?: number;
  semanticWeight?: number;
  minSemanticScore?: number;
}

export interface SemanticSearchOptions {
  limit?: number;
  filters?: MetadataFilter;
  minScore?: number;
}

export interface HybridIndexOptions {
  embedder?: LocalEmbedder;
  dimensions?: number;
  bilingualConceptBridge?: boolean;
  fitEmbedder?: boolean;
}

export interface IndexChunksOptions extends HybridIndexOptions {
  metadata?: readonly Partial<ChunkMetadata>[] | ReadonlyMap<string, Partial<ChunkMetadata>>;
}

export interface DeserializeHybridIndexOptions {
  embedder?: LocalEmbedder;
}

/** Hybrid BM25 + dense vector index over Document IR chunks. */
export interface HybridRetrievalIndex {
  readonly schemaVersion: number;
  readonly embedderId: string;
  readonly dimensions: number;
  readonly chunks: readonly Chunk[];
  readonly metadata: readonly ChunkMetadata[];
  readonly vectors: readonly (readonly number[])[];
  readonly bm25: RetrievalIndex;
  readonly embedder: LocalEmbedder;
  search(query: string, options?: HybridSearchOptions): HybridSearchHit[];
  semanticSearch(query: string, options?: SemanticSearchOptions): SemanticSearchHit[];
  serialize(): string;
}

// --- Bilingual concept rules (derived from query.ts SYNONYM_PAIRS) ---------

interface ConceptRule {
  tokens: readonly string[];
  conceptKey: string;
}

const ENGLISH_PLURAL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  contract: ['contracts'],
  clause: ['clauses'],
  value: ['values'],
  price: ['prices'],
  payment: ['payments'],
  liability: ['liabilities'],
  termination: ['terminations'],
  dispute: ['disputes'],
  warranty: ['warranties'],
  deadline: ['deadlines'],
  appendix: ['appendices'],
  tax: ['taxes'],
};

const BILINGUAL_CONCEPT_RULES: readonly ConceptRule[] = buildBilingualConceptRules();

function buildBilingualConceptRules(): ConceptRule[] {
  const rules: ConceptRule[] = [];
  for (const [viPhrase, enPhrase] of SYNONYM_PAIRS) {
    const enTokens = tokenize(enPhrase);
    const viTokens = tokenize(viPhrase);
    if (enTokens.length === 0 || viTokens.length === 0) continue;
    const conceptKey = `xling:${enTokens.join('_')}`;
    rules.push({ tokens: viTokens, conceptKey });
    rules.push({ tokens: enTokens, conceptKey });
    if (enTokens.length === 1) {
      const singular = enTokens[0] ?? '';
      const plurals = ENGLISH_PLURAL_ALIASES[singular] ?? [];
      for (const plural of plurals) {
        rules.push({ tokens: [plural], conceptKey });
      }
    }
  }
  return rules.sort(
    (left, right) =>
      right.tokens.length - left.tokens.length ||
      right.tokens.join(' ').length - left.tokens.join(' ').length,
  );
}

// --- Vector math -----------------------------------------------------------

/** Returns an L2-normalized copy of `vector`, or a zero vector when its norm is 0. */
export function l2Normalize(vector: readonly number[]): number[] {
  let sumSquares = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    if (!Number.isFinite(value)) {
      throw new HybridRetrievalError('invalid-option', `Vector contains a non-finite value at index ${index}.`);
    }
    sumSquares += value * value;
  }
  if (sumSquares === 0) {
    return new Array<number>(vector.length).fill(0);
  }
  if (Math.abs(sumSquares - 1) <= 1e-12) {
    return [...vector];
  }
  const norm = Math.sqrt(sumSquares);
  const normalized = new Array<number>(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    normalized[index] = (vector[index] ?? 0) / norm;
  }
  return normalized;
}

/**
 * Computes cosine similarity between two equal-length vectors in `[-1, 1]`.
 * Returns `0` if either vector has zero L2 norm; throws on dimension mismatch.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) {
    throw new HybridRetrievalError(
      'dimension-mismatch',
      `Vector dimension mismatch: expected ${left.length}, received ${right.length}.`,
    );
  }
  let dot = 0;
  let leftNormSq = 0;
  let rightNormSq = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new HybridRetrievalError('invalid-option', `Vector contains a non-finite value at index ${index}.`);
    }
    dot += a * b;
    leftNormSq += a * a;
    rightNormSq += b * b;
  }
  if (leftNormSq === 0 || rightNormSq === 0) return 0;
  const raw = dot / Math.sqrt(leftNormSq * rightNormSq);
  return Math.max(-1, Math.min(1, raw));
}

// --- Local deterministic TF-IDF + n-gram embedder --------------------------

/**
 * Creates a deterministic, offline char/word n-gram + TF-IDF embedder.
 *
 * When fitted on a corpus (either via `options.corpus` or `.fit(texts)`), rare features
 * receive higher IDF weights than ubiquitous terms. Unfitted embedders default all IDF
 * weights to `1.0` so standalone embedding calls remain functional and deterministic.
 */
export function createLocalEmbedder(options: LocalEmbedderOptions = {}): LocalTfIdfEmbedder {
  if (options.state !== undefined) {
    return restoreTfIdfEmbedder(options.state);
  }

  const dimensions = requirePositiveInt(
    options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
    'options.dimensions',
  );
  const id = typeof options.id === 'string' && options.id.trim().length > 0
    ? options.id.trim()
    : DEFAULT_LOCAL_EMBEDDER_ID;
  const bilingualConceptBridge = options.bilingualConceptBridge ?? true;

  const instance = buildTfIdfEmbedderInstance({
    id,
    dimensions,
    bilingualConceptBridge,
    documentCount: 0,
    documentFrequencies: new Map<string, number>(),
  });
  if (options.corpus !== undefined) {
    instance.fit(options.corpus);
  }
  return instance;
}

function restoreTfIdfEmbedder(state: LocalTfIdfEmbedderState): LocalTfIdfEmbedder {
  const dimensions = requirePositiveInt(state.dimensions, 'state.dimensions');
  const id = typeof state.id === 'string' && state.id.trim().length > 0
    ? state.id.trim()
    : DEFAULT_LOCAL_EMBEDDER_ID;
  const bilingualConceptBridge = Boolean(state.bilingualConceptBridge);
  const documentCount = Number.isInteger(state.documentCount) && state.documentCount >= 0
    ? state.documentCount
    : 0;
  const documentFrequencies = new Map<string, number>();
  for (const [key, value] of Object.entries(state.documentFrequencies ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      documentFrequencies.set(key, value);
    }
  }
  return buildTfIdfEmbedderInstance({
    id,
    dimensions,
    bilingualConceptBridge,
    documentCount,
    documentFrequencies,
  });
}

function buildTfIdfEmbedderInstance(initial: {
  id: string;
  dimensions: number;
  bilingualConceptBridge: boolean;
  documentCount: number;
  documentFrequencies: Map<string, number>;
}): LocalTfIdfEmbedder {
  const { id, dimensions, bilingualConceptBridge } = initial;
  let documentCount = initial.documentCount;
  let documentFrequencies = initial.documentFrequencies;

  const fit = (texts: readonly string[]): void => {
    const nextDf = new Map<string, number>();
    let count = 0;
    for (const text of Array.isArray(texts) ? texts : []) {
      count += 1;
      const features = extractWeightedFeatures(text, bilingualConceptBridge);
      for (const feature of features.keys()) {
        nextDf.set(feature, (nextDf.get(feature) ?? 0) + 1);
      }
    }
    documentCount = count;
    documentFrequencies = nextDf;
  };

  const embed = (text: string): number[] =>
    projectFeaturesToVector(
      extractWeightedFeatures(text, bilingualConceptBridge),
      dimensions,
      documentCount,
      documentFrequencies,
    );

  const embedBatch = (texts: readonly string[]): number[][] =>
    texts.map(text => embed(text));

  const exportState = (): LocalTfIdfEmbedderState => {
    const sortedEntries = [...documentFrequencies.entries()].sort((left, right) =>
      compareText(left[0], right[0]),
    );
    return {
      id,
      dimensions,
      bilingualConceptBridge,
      documentCount,
      documentFrequencies: Object.fromEntries(sortedEntries),
    };
  };

  return { id, dimensions, embed, embedBatch, fit, exportState };
}

interface FeatureCount {
  baseWeight: number;
  count: number;
}

function extractWeightedFeatures(
  text: string,
  bilingualConceptBridge: boolean,
): Map<string, FeatureCount> {
  const features = new Map<string, FeatureCount>();
  const tokens = tokenize(typeof text === 'string' ? text : '');
  if (tokens.length === 0) return features;

  const bump = (key: string, baseWeight: number): void => {
    const existing = features.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      features.set(key, { baseWeight, count: 1 });
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;

    bump(`w:${token}`, WEIGHT_UNIGRAM);

    const next = tokens[index + 1];
    if (next !== undefined) {
      bump(`bg:${token}|${next}`, WEIGHT_BIGRAM);
    }

    if (token.length >= 2) {
      const bounded = `^${token}$`;
      for (let size = 3; size <= 4; size += 1) {
        if (bounded.length < size) continue;
        for (let offset = 0; offset <= bounded.length - size; offset += 1) {
          bump(`c${size}:${bounded.slice(offset, offset + size)}`, WEIGHT_CHAR_NGRAM);
        }
      }
    }
  }

  if (bilingualConceptBridge) {
    const claimed = new Array<boolean>(tokens.length).fill(false);
    for (let start = 0; start < tokens.length; start += 1) {
      if (claimed[start]) continue;
      for (const rule of BILINGUAL_CONCEPT_RULES) {
        const len = rule.tokens.length;
        if (start + len > tokens.length) continue;
        if (!matchesTokenSpan(tokens, claimed, start, rule.tokens)) continue;
        for (let offset = 0; offset < len; offset += 1) {
          claimed[start + offset] = true;
        }
        bump(rule.conceptKey, WEIGHT_BILINGUAL_CONCEPT);
        break;
      }
    }
  }

  return features;
}

function matchesTokenSpan(
  tokens: readonly string[],
  claimed: readonly boolean[],
  start: number,
  target: readonly string[],
): boolean {
  for (let offset = 0; offset < target.length; offset += 1) {
    if (claimed[start + offset]) return false;
    if (tokens[start + offset] !== target[offset]) return false;
  }
  return true;
}

function projectFeaturesToVector(
  features: ReadonlyMap<string, FeatureCount>,
  dimensions: number,
  documentCount: number,
  documentFrequencies: ReadonlyMap<string, number>,
): number[] {
  if (features.size === 0) {
    return new Array<number>(dimensions).fill(0);
  }
  const raw = new Float64Array(dimensions);
  for (const [key, entry] of features) {
    const tf = entry.baseWeight * (1 + Math.log(entry.count));
    const df = documentFrequencies.get(key) ?? 0;
    const idf = documentCount > 0
      ? 0.5 + Math.log(1 + (documentCount - df + 0.5) / (df + 0.5))
      : 1;
    const weight = tf * idf;

    for (let probe = 0; probe < HASH_PROBES; probe += 1) {
      const bucket = fnv1a32(`${probe}:${key}`) % dimensions;
      const sign = (avalanche32(fnv1a32(`s${probe}:${key}`)) & 1) === 0 ? 1 : -1;
      raw[bucket] = (raw[bucket] ?? 0) + sign * weight * INV_SQRT_PROBES;
    }
  }

  let sumSq = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const val = raw[index] ?? 0;
    sumSq += val * val;
  }
  const output = new Array<number>(dimensions).fill(0);
  if (sumSq === 0) return output;

  const norm = Math.sqrt(sumSq);
  for (let index = 0; index < dimensions; index += 1) {
    output[index] = (raw[index] ?? 0) / norm;
  }
  return output;
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function avalanche32(value: number): number {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// --- Metadata extraction & filtering ---------------------------------------

/** Evaluates whether `metadata` satisfies every constraint in `filter`. */
export function matchesMetadataFilter(
  metadata: ChunkMetadata,
  filter?: MetadataFilter,
): MetadataFilterMatch {
  if (!filter) return { matched: true, fields: [] };
  const fields: MetadataFilterField[] = [];

  const docConstraint = resolveDocumentConstraint(filter);
  if (docConstraint !== null) {
    fields.push('documentId');
    if (!docConstraint.has(metadata.documentId)) {
      return { matched: false, fields };
    }
  }

  const pageConstraint = resolvePageRangeConstraint(filter.pageRange);
  if (pageConstraint !== null) {
    fields.push('pageRange');
    if (pageConstraint.min > pageConstraint.max) {
      return { matched: false, fields };
    }
    if (metadata.pageEnd < pageConstraint.min || metadata.page > pageConstraint.max) {
      return { matched: false, fields };
    }
  }

  const kindConstraint = resolveKindConstraint(filter.kind);
  if (kindConstraint !== null) {
    fields.push('kind');
    if (!kindConstraint.has(metadata.kind)) {
      return { matched: false, fields };
    }
  }

  const sectionConstraint = resolveSectionConstraint(filter.section);
  if (sectionConstraint !== null) {
    fields.push('section');
    if (sectionConstraint.length === 0 || !matchesAnySection(metadata.headingPath, sectionConstraint)) {
      return { matched: false, fields };
    }
  }

  const languageConstraint = resolveLanguageConstraint(filter.language);
  if (languageConstraint !== null) {
    fields.push('language');
    if (languageConstraint.size === 0 || !matchesAnyLanguage(metadata, languageConstraint)) {
      return { matched: false, fields };
    }
  }

  return { matched: true, fields };
}

function resolveDocumentConstraint(filter: MetadataFilter): Set<string> | null {
  const singleId = typeof filter.documentId === 'string' ? filter.documentId.trim() : '';
  const hasSingle = singleId.length > 0;
  const hasList = filter.documentIds !== undefined;
  if (!hasSingle && !hasList) return null;

  if (hasSingle && hasList) {
    const list = new Set(
      (filter.documentIds ?? []).map(id => (typeof id === 'string' ? id.trim() : '')).filter(Boolean),
    );
    return list.has(singleId) ? new Set([singleId]) : new Set();
  }
  if (hasSingle) {
    return new Set([singleId]);
  }
  return new Set(
    (filter.documentIds ?? []).map(id => (typeof id === 'string' ? id.trim() : '')).filter(Boolean),
  );
}

function resolvePageRangeConstraint(
  range: PageRangeFilter | undefined,
): { min: number; max: number } | null {
  if (range === undefined) return null;
  let rawMin: number | undefined;
  let rawMax: number | undefined;
  if (Array.isArray(range)) {
    rawMin = range[0];
    rawMax = range[1];
  } else if (typeof range === 'object' && range !== null) {
    const bounds = range as PageRangeBounds;
    rawMin = bounds.min ?? bounds.from;
    rawMax = bounds.max ?? bounds.to;
  } else {
    return null;
  }
  const hasMin = typeof rawMin === 'number' && Number.isFinite(rawMin);
  const hasMax = typeof rawMax === 'number' && Number.isFinite(rawMax);
  if (!hasMin && !hasMax) return null;
  return {
    min: hasMin ? Math.floor(rawMin as number) : Number.NEGATIVE_INFINITY,
    max: hasMax ? Math.floor(rawMax as number) : Number.POSITIVE_INFINITY,
  };
}

function resolveKindConstraint(kind: MetadataFilter['kind']): Set<ChunkKind> | null {
  if (kind === undefined) return null;
  if (Array.isArray(kind)) {
    return new Set(kind.filter((item): item is ChunkKind => CHUNK_KINDS.has(item)));
  }
  return CHUNK_KINDS.has(kind as ChunkKind) ? new Set([kind as ChunkKind]) : new Set();
}

function resolveSectionConstraint(section: MetadataFilter['section']): string[] | null {
  if (section === undefined) return null;
  if (Array.isArray(section)) {
    return section
      .filter((item): item is string => typeof item === 'string')
      .map(item => foldFilterText(item))
      .filter(item => item.length > 0);
  }
  if (typeof section !== 'string') return null;
  const folded = foldFilterText(section);
  return folded.length > 0 ? [folded] : null;
}

function resolveLanguageConstraint(language: MetadataFilter['language']): Set<string> | null {
  if (language === undefined) return null;
  const normalizeTag = (tag: string): string => {
    const trimmed = tag.trim();
    if (trimmed.length === 0) return '';
    return normalizeLanguageCode(trimmed);
  };
  if (Array.isArray(language)) {
    const set = new Set<string>();
    for (const item of language) {
      if (typeof item !== 'string') continue;
      const code = normalizeTag(item);
      if (code.length > 0 && code !== 'auto') set.add(code);
    }
    return set;
  }
  if (typeof language !== 'string') return null;
  const code = normalizeTag(language);
  if (code.length === 0 || code === 'auto') return null;
  return new Set([code]);
}

function matchesAnySection(headingPath: readonly string[], targets: readonly string[]): boolean {
  if (headingPath.length === 0) return false;
  for (const heading of headingPath) {
    const foldedHeading = foldFilterText(heading);
    if (foldedHeading.length === 0) continue;
    for (const rawTarget of targets) {
      if (matchesSectionHeading(foldedHeading, rawTarget)) return true;
    }
  }
  return false;
}

function matchesSectionHeading(foldedHeading: string, rawTarget: string): boolean {
  const strippedTarget = rawTarget.replace(SECTION_PREFIX_PATTERN, '').trim();
  const target = strippedTarget.length > 0 ? strippedTarget : rawTarget;
  if (foldedHeading === rawTarget || foldedHeading === target) return true;

  if (SECTION_CODE_PATTERN.test(target)) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}.])${escapeRegExp(target)}(?![\\p{L}\\p{N}.])`, 'iu');
    return pattern.test(foldedHeading);
  }
  const phrasePattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(target)}(?![\\p{L}\\p{N}])`, 'u');
  return phrasePattern.test(foldedHeading);
}

function matchesAnyLanguage(metadata: ChunkMetadata, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(metadata.language)) return true;
  for (const lang of metadata.languages) {
    if (allowed.has(lang)) return true;
  }
  return false;
}

function foldFilterText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/gu, 'd')
    .replace(/\s+/gu, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// --- Reciprocal Rank Fusion ------------------------------------------------

/**
 * Combines multiple ranked candidate id lists using Reciprocal Rank Fusion:
 * `sum_i weight_i / (k + rank_i)`.
 */
export function reciprocalRankFusion(
  sources: readonly RrfSourceList[],
  options: RrfOptions = {},
): RrfResult[] {
  const k = options.k ?? DEFAULT_RRF_K;
  if (!Number.isFinite(k) || k <= 0) {
    throw new HybridRetrievalError('invalid-option', 'RRF constant k must be a positive finite number.');
  }

  const byId = new Map<string, { score: number; ranks: Record<string, number | null> }>();
  const sourceNames = sources.map(source => source.name);

  for (const source of sources) {
    const weight = source.weight ?? 1;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new HybridRetrievalError('invalid-option', `RRF weight for "${source.name}" must be non-negative.`);
    }
    const seenInSource = new Set<string>();
    let rank = 0;
    for (const id of source.ids) {
      if (seenInSource.has(id)) continue;
      seenInSource.add(id);
      rank += 1;

      let entry = byId.get(id);
      if (!entry) {
        const ranks: Record<string, number | null> = {};
        for (const name of sourceNames) ranks[name] = null;
        entry = { score: 0, ranks };
        byId.set(id, entry);
      }
      entry.ranks[source.name] = rank;
      if (weight > 0) {
        entry.score += weight / (k + rank);
      }
    }
  }

  const results: RrfResult[] = [];
  for (const [id, entry] of byId) {
    const rounded = round(entry.score, SCORE_DECIMALS);
    if (rounded <= 0) continue;
    results.push({ id, score: rounded, ranks: entry.ranks });
  }
  results.sort((left, right) => right.score - left.score || compareText(left.id, right.id));
  return results;
}

// --- Index construction ----------------------------------------------------

/**
 * Chunks every {@link DocumentIR} via `./retrieval`, extracts per-chunk metadata
 * (including page spans and normalized language tags), builds the BM25 index, and
 * embeds every passage into normalized vectors.
 */
export function indexDocuments(
  documents: readonly DocumentIR[],
  options: HybridIndexOptions = {},
): HybridRetrievalIndex {
  const allChunks: Chunk[] = [];
  const allMetadata: ChunkMetadata[] = [];

  for (const doc of Array.isArray(documents) ? documents : []) {
    if (!doc || typeof doc !== 'object') continue;
    const chunks = chunkDocument(doc);
    const blockById = new Map<string, Block>();
    for (const block of Array.isArray(doc.blocks) ? doc.blocks : []) {
      if (block && typeof block === 'object' && typeof block.id === 'string') {
        blockById.set(block.id, block);
      }
    }
    const docLang = normalizeStoredLanguage(doc.language);
    for (const chunk of chunks) {
      allChunks.push(chunk);
      allMetadata.push(extractChunkMetadata(chunk, blockById, docLang));
    }
  }

  return buildHybridIndexFromParts(allChunks, allMetadata, options);
}

/**
 * Builds a {@link HybridRetrievalIndex} directly from pre-chunked passages and optional
 * sidecar metadata.
 */
export function indexChunks(
  chunks: readonly Chunk[],
  options: IndexChunksOptions = {},
): HybridRetrievalIndex {
  const validChunks: Chunk[] = [];
  const metadataList: ChunkMetadata[] = [];
  const metaSource = options.metadata;

  for (let index = 0; index < (Array.isArray(chunks) ? chunks.length : 0); index += 1) {
    const chunk = chunks[index];
    if (!chunk || typeof chunk !== 'object') continue;
    validChunks.push(chunk);
    const override = metaSource instanceof Map
      ? metaSource.get(chunk.id)
      : Array.isArray(metaSource)
        ? metaSource[index]
        : undefined;
    metadataList.push(normalizeChunkMetadata(chunk, override));
  }

  return buildHybridIndexFromParts(validChunks, metadataList, options);
}

function buildHybridIndexFromParts(
  chunks: readonly Chunk[],
  metadata: readonly ChunkMetadata[],
  options: HybridIndexOptions,
): HybridRetrievalIndex {
  const customEmbedder = options.embedder;
  const embedder: LocalEmbedder = customEmbedder ?? createLocalEmbedder({
    dimensions: options.dimensions,
    bilingualConceptBridge: options.bilingualConceptBridge,
  });

  const embeddingTexts = chunks.map(chunkTextForEmbedding);
  const shouldFit = options.fitEmbedder ?? (customEmbedder === undefined);
  if (shouldFit && typeof embedder.fit === 'function' && embeddingTexts.length > 0) {
    embedder.fit(embeddingTexts);
  }

  const rawVectors = embeddingTexts.length === 0
    ? []
    : typeof embedder.embedBatch === 'function'
      ? embedder.embedBatch(embeddingTexts)
      : embeddingTexts.map(text => embedder.embed(text));

  if (rawVectors.length !== chunks.length) {
    throw new HybridRetrievalError(
      'malformed-index',
      `Embedder returned ${rawVectors.length} vectors for ${chunks.length} chunks.`,
    );
  }

  const firstVec = rawVectors[0];
  const resolvedDimensions = resolveEmbedderDimensions(
    embedder,
    options.dimensions,
    firstVec?.length,
  );
  const vectors = rawVectors.map((vector, index) =>
    validateAndNormalizeVector(vector, resolvedDimensions, `chunks[${index}]`),
  );

  const embedderId = typeof embedder.id === 'string' && embedder.id.trim().length > 0
    ? embedder.id.trim()
    : DEFAULT_LOCAL_EMBEDDER_ID;

  const bm25 = buildBm25Index(chunks);
  return assembleHybridIndex({
    embedderId,
    dimensions: resolvedDimensions,
    chunks: [...chunks],
    metadata: [...metadata],
    vectors,
    bm25,
    embedder,
  });
}

function assembleHybridIndex(parts: {
  embedderId: string;
  dimensions: number;
  chunks: readonly Chunk[];
  metadata: readonly ChunkMetadata[];
  vectors: readonly (readonly number[])[];
  bm25: RetrievalIndex;
  embedder: LocalEmbedder;
}): HybridRetrievalIndex {
  const built: HybridRetrievalIndex = {
    schemaVersion: HYBRID_INDEX_SCHEMA_VERSION,
    embedderId: parts.embedderId,
    dimensions: parts.dimensions,
    chunks: parts.chunks,
    metadata: parts.metadata,
    vectors: parts.vectors,
    bm25: parts.bm25,
    embedder: parts.embedder,
    search: (query, options) => hybridSearch(built, query, options),
    semanticSearch: (query, options) => semanticSearch(built, query, options),
    serialize: () => serializeHybridIndex(built),
  };
  return built;
}

function extractChunkMetadata(
  chunk: Chunk,
  blockById: ReadonlyMap<string, Block>,
  documentLanguage: string,
): ChunkMetadata {
  let pageStart = chunk.page;
  let pageEnd = chunk.page;
  const languages: string[] = [];

  for (const blockId of chunk.blockIds) {
    const block = blockById.get(blockId);
    if (!block) continue;
    if (block.page < pageStart) pageStart = block.page;
    if (block.page > pageEnd) pageEnd = block.page;
    const lang = normalizeStoredLanguage(block.language);
    if (lang !== 'und' && !languages.includes(lang)) {
      languages.push(lang);
    }
  }

  if (languages.length === 0) {
    languages.push(documentLanguage);
  }

  return {
    documentId: chunk.documentId,
    page: pageStart,
    pageEnd: Math.max(pageStart, pageEnd),
    kind: chunk.kind,
    headingPath: [...chunk.headingPath],
    language: languages[0] ?? 'und',
    languages,
  };
}

function normalizeChunkMetadata(chunk: Chunk, override?: Partial<ChunkMetadata>): ChunkMetadata {
  const languages: string[] = [];
  if (Array.isArray(override?.languages)) {
    for (const lang of override.languages) {
      const normalized = normalizeStoredLanguage(lang);
      if (normalized !== 'und' && !languages.includes(normalized)) {
        languages.push(normalized);
      }
    }
  }
  const primary = normalizeStoredLanguage(override?.language);
  if (primary !== 'und' && !languages.includes(primary)) {
    languages.unshift(primary);
  }
  if (languages.length === 0) {
    languages.push('und');
  }

  const page = typeof override?.page === 'number' && Number.isFinite(override.page)
    ? Math.floor(override.page)
    : chunk.page;
  const pageEnd = typeof override?.pageEnd === 'number' && Number.isFinite(override.pageEnd)
    ? Math.max(page, Math.floor(override.pageEnd))
    : page;

  return {
    documentId: typeof override?.documentId === 'string' && override.documentId.length > 0
      ? override.documentId
      : chunk.documentId,
    page,
    pageEnd,
    kind: override?.kind && CHUNK_KINDS.has(override.kind) ? override.kind : chunk.kind,
    headingPath: Array.isArray(override?.headingPath)
      ? [...override.headingPath]
      : [...chunk.headingPath],
    language: languages[0] ?? 'und',
    languages,
  };
}

function normalizeStoredLanguage(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return 'und';
  const code = normalizeLanguageCode(value);
  return code === 'auto' || code.length === 0 ? 'und' : code;
}

function chunkTextForEmbedding(chunk: Chunk): string {
  const path = Array.isArray(chunk.headingPath)
    ? chunk.headingPath.filter(title => typeof title === 'string' && title.trim().length > 0)
    : [];
  if (path.length === 0) return chunk.text;
  return `${path.join(' ')}\n${chunk.text}`;
}

// --- Search ----------------------------------------------------------------

/** Performs pure cosine similarity search against a {@link HybridRetrievalIndex}. */
export function semanticSearch(
  target: HybridRetrievalIndex,
  query: string,
  options: SemanticSearchOptions = {},
): SemanticSearchHit[] {
  if (!target || !Array.isArray(target.chunks) || target.chunks.length === 0) return [];
  if (typeof query !== 'string' || query.trim().length === 0) return [];

  const limit = readLimit(options.limit);
  if (limit === 0) return [];

  const minScore = options.minScore ?? DEFAULT_MIN_SEMANTIC_SCORE;
  if (!Number.isFinite(minScore) || minScore < -1) {
    throw new HybridRetrievalError('invalid-option', 'minScore must be a finite number >= -1.');
  }

  const queryVec = validateAndNormalizeVector(
    target.embedder.embed(query),
    target.dimensions,
    'query',
  );
  if (isZeroVector(queryVec)) return [];

  const candidates = rankSemanticCandidates(target, queryVec, options.filters, minScore);
  return candidates.qualified.slice(0, limit).map(entry => ({
    chunk: entry.chunk,
    score: entry.score,
    metadata: entry.metadata,
    matchedFilter: entry.matchedFilter,
  }));
}

/**
 * Performs hybrid retrieval combining Okapi BM25 (`./retrieval`) and local vector cosine
 * similarity via Reciprocal Rank Fusion (RRF), with metadata filtering and per-hit trace.
 */
export function hybridSearch(
  target: HybridRetrievalIndex,
  query: string,
  options: HybridSearchOptions = {},
): HybridSearchHit[] {
  if (!target || !Array.isArray(target.chunks) || target.chunks.length === 0) return [];
  if (typeof query !== 'string' || query.trim().length === 0) return [];

  const limit = readLimit(options.limit);
  if (limit === 0) return [];

  const mode: HybridRetrievalMode = options.mode ?? 'hybrid';
  const rrfK = options.rrfK ?? DEFAULT_RRF_K;
  if (!Number.isFinite(rrfK) || rrfK <= 0) {
    throw new HybridRetrievalError('invalid-option', 'rrfK must be a positive finite number.');
  }

  const bm25Weight = options.bm25Weight ?? (mode === 'semantic' ? 0 : DEFAULT_BM25_WEIGHT);
  const semanticWeight = options.semanticWeight ?? (mode === 'bm25' ? 0 : DEFAULT_SEMANTIC_WEIGHT);
  if (!Number.isFinite(bm25Weight) || bm25Weight < 0 || !Number.isFinite(semanticWeight) || semanticWeight < 0) {
    throw new HybridRetrievalError('invalid-option', 'RRF weights must be non-negative finite numbers.');
  }
  if (bm25Weight === 0 && semanticWeight === 0) return [];

  const minSemanticScore = options.minSemanticScore ?? DEFAULT_MIN_SEMANTIC_SCORE;
  if (!Number.isFinite(minSemanticScore) || minSemanticScore < -1) {
    throw new HybridRetrievalError('invalid-option', 'minSemanticScore must be a finite number >= -1.');
  }

  const filterInfo = evaluateFilterPositions(target, options.filters);
  if (filterInfo.allowed.size === 0) return [];

  const bm25ByPos = new Map<number, { rank: number; score: number; matchedTerms: string[] }>();
  if (bm25Weight > 0) {
    const rawBm25Hits = searchBm25(target.bm25, query, {
      limit: Math.max(target.chunks.length, 1),
    });
    const filteredBm25: Array<{ pos: number; hit: SearchHit }> = [];
    for (const hit of rawBm25Hits) {
      const pos = filterInfo.chunkToPos.get(hit.chunk);
      if (pos === undefined || !filterInfo.allowed.has(pos)) continue;
      filteredBm25.push({ pos, hit });
    }
    const bm25Ranks = assignCompetitionRanks(filteredBm25, entry => entry.hit.score);
    filteredBm25.forEach((entry, idx) => {
      bm25ByPos.set(entry.pos, {
        rank: bm25Ranks[idx] ?? idx + 1,
        score: entry.hit.score,
        matchedTerms: [...entry.hit.matchedTerms],
      });
    });
  }

  const semanticByPos = new Map<number, { rank: number | null; score: number }>();
  if (semanticWeight > 0) {
    const queryVec = validateAndNormalizeVector(
      target.embedder.embed(query),
      target.dimensions,
      'query',
    );
    if (!isZeroVector(queryVec)) {
      const semResult = rankSemanticCandidates(target, queryVec, options.filters, minSemanticScore);
      for (const [pos, score] of semResult.allScores) {
        semanticByPos.set(pos, { rank: null, score });
      }
      const semRanks = assignCompetitionRanks(semResult.qualified, entry => entry.score);
      semResult.qualified.forEach((entry, idx) => {
        semanticByPos.set(entry.position, { rank: semRanks[idx] ?? idx + 1, score: entry.score });
      });
    }
  }

  const candidatePositions = new Set<number>();
  for (const pos of bm25ByPos.keys()) candidatePositions.add(pos);
  for (const [pos, entry] of semanticByPos) {
    if (entry.rank !== null) candidatePositions.add(pos);
  }
  if (candidatePositions.size === 0) return [];

  const hits: HybridSearchHit[] = [];
  for (const pos of candidatePositions) {
    const chunk = target.chunks[pos];
    const metadata = target.metadata[pos];
    const filterMatch = filterInfo.matches.get(pos);
    if (!chunk || !metadata || !filterMatch) continue;

    const bm25Entry = bm25ByPos.get(pos);
    const semEntry = semanticByPos.get(pos);

    const bm25Rank = bm25Entry ? bm25Entry.rank : null;
    const bm25Score = bm25Entry ? bm25Entry.score : 0;
    const semanticRank = semEntry ? semEntry.rank : null;
    const semanticScore = semEntry ? semEntry.score : 0;

    let rawFused = 0;
    if (bm25Rank !== null && bm25Weight > 0) {
      rawFused += bm25Weight / (rrfK + bm25Rank);
    }
    if (semanticRank !== null && semanticWeight > 0) {
      rawFused += semanticWeight / (rrfK + semanticRank);
    }
    const fusedScore = round(rawFused, SCORE_DECIMALS);
    if (fusedScore <= 0) continue;

    hits.push({
      chunk,
      score: fusedScore,
      matchedTerms: bm25Entry ? bm25Entry.matchedTerms : [],
      metadata,
      trace: {
        bm25Rank,
        bm25Score,
        semanticRank,
        semanticScore,
        fusedScore,
        matchedFilter: filterMatch.matched,
        matchedFilterFields: [...filterMatch.fields],
      },
    });
  }

  hits.sort(compareHybridHits);
  return hits.slice(0, limit);
}

interface FilterEvaluation {
  allowed: Set<number>;
  matches: Map<number, MetadataFilterMatch>;
  chunkToPos: Map<Chunk, number>;
}

function evaluateFilterPositions(
  target: HybridRetrievalIndex,
  filters?: MetadataFilter,
): FilterEvaluation {
  const allowed = new Set<number>();
  const matches = new Map<number, MetadataFilterMatch>();
  const chunkToPos = new Map<Chunk, number>();

  for (let pos = 0; pos < target.chunks.length; pos += 1) {
    const chunk = target.chunks[pos];
    const meta = target.metadata[pos];
    if (!chunk || !meta) continue;
    chunkToPos.set(chunk, pos);
    const match = matchesMetadataFilter(meta, filters);
    if (match.matched) {
      allowed.add(pos);
      matches.set(pos, match);
    }
  }
  return { allowed, matches, chunkToPos };
}

interface RankedSemanticCandidate {
  position: number;
  chunk: Chunk;
  metadata: ChunkMetadata;
  score: number;
  matchedFilter: boolean;
}

function rankSemanticCandidates(
  target: HybridRetrievalIndex,
  queryVec: readonly number[],
  filters: MetadataFilter | undefined,
  minScore: number,
): { qualified: RankedSemanticCandidate[]; allScores: Map<number, number> } {
  const qualified: RankedSemanticCandidate[] = [];
  const allScores = new Map<number, number>();

  for (let pos = 0; pos < target.chunks.length; pos += 1) {
    const chunk = target.chunks[pos];
    const metadata = target.metadata[pos];
    const vector = target.vectors[pos];
    if (!chunk || !metadata || !vector) continue;

    const filterMatch = matchesMetadataFilter(metadata, filters);
    if (!filterMatch.matched) continue;

    const rawCosine = cosineSimilarity(queryVec, vector);
    const clampedScore = round(Math.max(0, rawCosine), SCORE_DECIMALS);
    allScores.set(pos, clampedScore);

    if (rawCosine > 0 && rawCosine >= minScore) {
      qualified.push({
        position: pos,
        chunk,
        metadata,
        score: clampedScore,
        matchedFilter: true,
      });
    }
  }

  qualified.sort(
    (left, right) =>
      right.score - left.score ||
      finiteOr(left.chunk.page, 1) - finiteOr(right.chunk.page, 1) ||
      compareText(left.chunk.id, right.chunk.id),
  );
  return { qualified, allScores };
}

function assignCompetitionRanks<T>(
  sorted: readonly T[],
  scoreOf: (entry: T) => number,
): number[] {
  const ranks: number[] = [];
  let currentRank = 1;
  let previousScore: number | undefined;
  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];
    if (entry === undefined) continue;
    const score = scoreOf(entry);
    if (previousScore === undefined || score < previousScore) {
      currentRank = index + 1;
      previousScore = score;
    }
    ranks.push(currentRank);
  }
  return ranks;
}

function compareHybridHits(left: HybridSearchHit, right: HybridSearchHit): number {
  return (
    right.score - left.score ||
    right.trace.bm25Score + right.trace.semanticScore - (left.trace.bm25Score + left.trace.semanticScore) ||
    finiteOr(left.chunk.page, 1) - finiteOr(right.chunk.page, 1) ||
    compareText(left.chunk.id, right.chunk.id)
  );
}

// --- Persistence / Serialization -------------------------------------------

interface SerializedHybridIndex {
  schemaVersion: number;
  embedderId: string;
  dimensions: number;
  chunks: Chunk[];
  metadata: ChunkMetadata[];
  vectors: number[][];
  embedderState: LocalTfIdfEmbedderState | null;
}

/**
 * Writes a {@link HybridRetrievalIndex} as canonical JSON containing schema version,
 * chunks, metadata, vectors, and (when built with {@link createLocalEmbedder}) the
 * fitted TF-IDF state so restored searches produce identical scores.
 */
export function serializeHybridIndex(target: HybridRetrievalIndex): string {
  const exportable = target.embedder as Partial<LocalTfIdfEmbedder>;
  const embedderState = typeof exportable.exportState === 'function'
    ? exportable.exportState()
    : null;

  const payload: SerializedHybridIndex = {
    schemaVersion: HYBRID_INDEX_SCHEMA_VERSION,
    embedderId: target.embedderId,
    dimensions: target.dimensions,
    chunks: target.chunks.map(chunk => ({
      id: chunk.id,
      documentId: chunk.documentId,
      page: chunk.page,
      blockIds: [...chunk.blockIds],
      text: chunk.text,
      kind: chunk.kind,
      headingPath: [...chunk.headingPath],
    })),
    metadata: target.metadata.map(meta => ({
      documentId: meta.documentId,
      page: meta.page,
      pageEnd: meta.pageEnd,
      kind: meta.kind,
      headingPath: [...meta.headingPath],
      language: meta.language,
      languages: [...meta.languages],
    })),
    vectors: target.vectors.map(vec => [...vec]),
    embedderState: embedderState
      ? {
          id: embedderState.id,
          dimensions: embedderState.dimensions,
          bilingualConceptBridge: embedderState.bilingualConceptBridge,
          documentCount: embedderState.documentCount,
          documentFrequencies: embedderState.documentFrequencies,
        }
      : null,
  };

  return JSON.stringify(payload);
}

/**
 * Restores a serialized {@link HybridRetrievalIndex}. Rejects corrupt JSON, unknown schema
 * versions, vector dimension mismatches, and missing or incompatible external embedders.
 */
export function deserializeHybridIndex(
  json: string,
  options: DeserializeHybridIndexOptions = {},
): HybridRetrievalIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new HybridRetrievalError(
      'malformed-json',
      `Hybrid index JSON is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HybridRetrievalError('malformed-index', 'Hybrid index snapshot must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;

  if (typeof record.schemaVersion !== 'number' || !Number.isInteger(record.schemaVersion)) {
    throw new HybridRetrievalError('malformed-index', 'Hybrid index snapshot requires integer schemaVersion.');
  }
  if (record.schemaVersion !== HYBRID_INDEX_SCHEMA_VERSION) {
    throw new HybridRetrievalError(
      'unsupported-version',
      `Unsupported hybrid index schemaVersion ${record.schemaVersion}; expected ${HYBRID_INDEX_SCHEMA_VERSION}.`,
    );
  }

  const embedderId = readNonEmptyString(record.embedderId, 'embedderId');
  const dimensions = requirePositiveInt(record.dimensions, 'dimensions');
  const rawChunks = readArrayField(record.chunks, 'chunks');
  const rawMetadata = readArrayField(record.metadata, 'metadata');
  const rawVectors = readArrayField(record.vectors, 'vectors');

  if (rawMetadata.length !== rawChunks.length || rawVectors.length !== rawChunks.length) {
    throw new HybridRetrievalError(
      'malformed-index',
      'Hybrid index chunks, metadata, and vectors arrays must have equal length.',
    );
  }

  const chunks = rawChunks.map((item, idx) => readChunk(item, `chunks[${idx}]`));
  const metadata = rawMetadata.map((item, idx) => readChunkMetadata(item, `metadata[${idx}]`));
  const vectors = rawVectors.map((item, idx) =>
    validateAndNormalizeVector(readVector(item, `vectors[${idx}]`), dimensions, `vectors[${idx}]`),
  );

  const embedder = resolveRestoredEmbedder(record.embedderState, embedderId, dimensions, options.embedder);
  const bm25 = buildBm25Index(chunks);

  return assembleHybridIndex({
    embedderId,
    dimensions,
    chunks,
    metadata,
    vectors,
    bm25,
    embedder,
  });
}

function resolveRestoredEmbedder(
  rawState: unknown,
  embedderId: string,
  dimensions: number,
  provided?: LocalEmbedder,
): LocalEmbedder {
  if (provided !== undefined) {
    if (provided.id !== undefined && provided.id.trim() !== embedderId) {
      throw new HybridRetrievalError(
        'incompatible-embedder',
        `Provided embedder "${provided.id}" does not match snapshot embedder "${embedderId}".`,
      );
    }
    if (provided.dimensions !== undefined && provided.dimensions !== dimensions) {
      throw new HybridRetrievalError(
        'incompatible-embedder',
        `Provided embedder dimensions ${provided.dimensions} do not match snapshot dimensions ${dimensions}.`,
      );
    }
    return provided;
  }

  if (rawState !== null && rawState !== undefined) {
    const state = readEmbedderState(rawState);
    if (state.id !== embedderId || state.dimensions !== dimensions) {
      throw new HybridRetrievalError(
        'incompatible-embedder',
        'Snapshot embedderState does not match snapshot embedderId or dimensions.',
      );
    }
    return createLocalEmbedder({ state });
  }

  throw new HybridRetrievalError(
    'missing-embedder',
    `Snapshot requires external LocalEmbedder "${embedderId}" (${dimensions}d) on deserialize.`,
  );
}

// --- Validation & small helpers --------------------------------------------

function requirePositiveInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new HybridRetrievalError('invalid-option', `${path} must be a positive integer.`);
  }
  return value;
}

function resolveEmbedderDimensions(
  embedder: LocalEmbedder,
  explicit: number | undefined,
  sampleLength: number | undefined,
): number {
  if (embedder.dimensions !== undefined) {
    return requirePositiveInt(embedder.dimensions, 'embedder.dimensions');
  }
  if (sampleLength !== undefined && sampleLength > 0) {
    return sampleLength;
  }
  if (explicit !== undefined) {
    return requirePositiveInt(explicit, 'options.dimensions');
  }
  return DEFAULT_EMBEDDING_DIMENSIONS;
}

function validateAndNormalizeVector(
  vector: readonly number[],
  expectedDimensions: number,
  path: string,
): number[] {
  if (!Array.isArray(vector) || vector.length !== expectedDimensions) {
    throw new HybridRetrievalError(
      'dimension-mismatch',
      `${path}: expected ${expectedDimensions} dimensions, received ${Array.isArray(vector) ? vector.length : 'non-array'}.`,
    );
  }
  return l2Normalize(vector);
}

function isZeroVector(vector: readonly number[]): boolean {
  for (let index = 0; index < vector.length; index += 1) {
    if ((vector[index] ?? 0) !== 0) return false;
  }
  return true;
}

function readLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SEARCH_LIMIT;
  const limit = Math.floor(value);
  return limit < 0 ? DEFAULT_SEARCH_LIMIT : limit;
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HybridRetrievalError('malformed-index', `${path} must be a non-empty string.`);
  }
  return value;
}

function readArrayField(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new HybridRetrievalError('malformed-index', `${path} must be an array.`);
  }
  return value;
}

function readChunk(value: unknown, path: string): Chunk {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HybridRetrievalError('malformed-index', `${path} must be an object.`);
  }
  const obj = value as Record<string, unknown>;
  const kind = obj.kind as ChunkKind;
  if (!CHUNK_KINDS.has(kind)) {
    throw new HybridRetrievalError('malformed-index', `${path}.kind is invalid.`);
  }
  if (typeof obj.page !== 'number' || !Number.isFinite(obj.page)) {
    throw new HybridRetrievalError('malformed-index', `${path}.page must be a finite number.`);
  }
  if (typeof obj.text !== 'string') {
    throw new HybridRetrievalError('malformed-index', `${path}.text must be a string.`);
  }
  return {
    id: readNonEmptyString(obj.id, `${path}.id`),
    documentId: readNonEmptyString(obj.documentId, `${path}.documentId`),
    page: obj.page,
    blockIds: readArrayField(obj.blockIds, `${path}.blockIds`).map((item, i) =>
      readNonEmptyString(item, `${path}.blockIds[${i}]`),
    ),
    text: obj.text,
    kind,
    headingPath: readArrayField(obj.headingPath, `${path}.headingPath`).map(item =>
      typeof item === 'string' ? item : '',
    ),
  };
}

function readChunkMetadata(value: unknown, path: string): ChunkMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HybridRetrievalError('malformed-index', `${path} must be an object.`);
  }
  const obj = value as Record<string, unknown>;
  const kind = obj.kind as ChunkKind;
  if (!CHUNK_KINDS.has(kind)) {
    throw new HybridRetrievalError('malformed-index', `${path}.kind is invalid.`);
  }
  if (typeof obj.page !== 'number' || !Number.isFinite(obj.page)) {
    throw new HybridRetrievalError('malformed-index', `${path}.page must be a finite number.`);
  }
  if (typeof obj.pageEnd !== 'number' || !Number.isFinite(obj.pageEnd)) {
    throw new HybridRetrievalError('malformed-index', `${path}.pageEnd must be a finite number.`);
  }
  return {
    documentId: readNonEmptyString(obj.documentId, `${path}.documentId`),
    page: obj.page,
    pageEnd: obj.pageEnd,
    kind,
    headingPath: readArrayField(obj.headingPath, `${path}.headingPath`).map(item =>
      typeof item === 'string' ? item : '',
    ),
    language: typeof obj.language === 'string' && obj.language.length > 0 ? obj.language : 'und',
    languages: readArrayField(obj.languages, `${path}.languages`).map(item =>
      typeof item === 'string' && item.length > 0 ? item : 'und',
    ),
  };
}

function readVector(value: unknown, path: string): number[] {
  const arr = readArrayField(value, path);
  return arr.map((item, idx) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new HybridRetrievalError('malformed-index', `${path}[${idx}] must be a finite number.`);
    }
    return item;
  });
}

function readEmbedderState(value: unknown): LocalTfIdfEmbedderState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HybridRetrievalError('malformed-index', 'embedderState must be an object.');
  }
  const obj = value as Record<string, unknown>;
  const id = readNonEmptyString(obj.id, 'embedderState.id');
  const dimensions = requirePositiveInt(obj.dimensions, 'embedderState.dimensions');
  if (typeof obj.bilingualConceptBridge !== 'boolean') {
    throw new HybridRetrievalError('malformed-index', 'embedderState.bilingualConceptBridge must be boolean.');
  }
  if (typeof obj.documentCount !== 'number' || !Number.isInteger(obj.documentCount) || obj.documentCount < 0) {
    throw new HybridRetrievalError('malformed-index', 'embedderState.documentCount must be a non-negative integer.');
  }
  if (typeof obj.documentFrequencies !== 'object' || obj.documentFrequencies === null || Array.isArray(obj.documentFrequencies)) {
    throw new HybridRetrievalError('malformed-index', 'embedderState.documentFrequencies must be an object.');
  }
  const freqs: Record<string, number> = {};
  for (const [key, val] of Object.entries(obj.documentFrequencies as Record<string, unknown>)) {
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) {
      throw new HybridRetrievalError('malformed-index', `embedderState.documentFrequencies[${key}] is invalid.`);
    }
    freqs[key] = val;
  }
  return {
    id,
    dimensions,
    bilingualConceptBridge: obj.bilingualConceptBridge,
    documentCount: obj.documentCount,
    documentFrequencies: freqs,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
