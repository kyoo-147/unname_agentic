/**
 * Deterministic local cross-feature passage reranker (backlog item I12).
 *
 * BM25 retrieval in `retrieval.ts` ranks passages by length-normalised term frequency,
 * which can miss exact phrase boundaries, heading hierarchy, unit-exact quantities,
 * tight multi-term co-occurrence, and near-duplicate boilerplate across chunks. This
 * module rescores and orders BM25 candidates locally using five interpretable signals
 * plus greedy MMR-style redundancy suppression.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no network, no I/O.
 *   Equal inputs produce identical output regardless of candidate ordering.
 * - Input `hits` and `chunks` are never mutated.
 * - Repeated chunk identities (e.g. merged across multi-query retrieval) are collapsed
 *   deterministically by keeping the highest BM25 score and union of matched terms.
 * - Every returned hit preserves `baseScore`, raw `bm25Score`, and its per-feature
 *   breakdown in `[0, 1]`, so ranking decisions remain inspectable and reproducible.
 */

import { quotePhrases, rewriteQuery, type QueryContext, type QueryPlan } from './query';
import {
  DEFAULT_SEARCH_LIMIT,
  tokenize,
  type Chunk,
  type RetrievalIndex,
  type SearchHit,
} from './retrieval';

// --- Public shapes ---------------------------------------------------------

/** Relative weights for the five positive relevance signals before diversity. */
export interface RerankWeights {
  bm25: number;
  quotedSpan: number;
  headingMatch: number;
  numericUnit: number;
  multiTermDensity: number;
}

/** Decomposed feature scores in `[0, 1]` for one reranked hit. */
export interface RerankFeatures {
  /** Input BM25 score normalised against the highest candidate score. */
  bm25: number;
  /** Exact quoted span match score (exact diacritics `1.0`, folded fallback `0.65`). */
  quotedSpan: number;
  /** Heading-path keyword and section-filter match score. */
  headingMatch: number;
  /** Numeric and unit overlap, or numeric evidence for quantity queries. */
  numericUnit: number;
  /** Distinct query keyword coverage combined with minimum-span compactness. */
  multiTermDensity: number;
  /** Diversity penalty subtracted during greedy selection. */
  redundancyPenalty: number;
}

/** Options for {@link rerank}. */
export interface RerankOptions {
  /** Maximum results to return; defaults to {@link DEFAULT_RERANK_LIMIT} (`0` returns `[]`). */
  limit?: number;
  /** Optional reading session context forwarded to {@link rewriteQuery}. */
  queryContext?: QueryContext;
  /** Pre-computed query plan; computed via {@link rewriteQuery} when omitted. */
  queryPlan?: QueryPlan;
  /** Additional exact spans to boost alongside quoted spans inside `query`. */
  quotedPhrases?: readonly string[];
  /** Partial weight overrides merged onto {@link DEFAULT_RERANK_WEIGHTS}. */
  weights?: Partial<RerankWeights>;
  /**
   * Strength of greedy MMR-style redundancy suppression in `[0, 1]`.
   * Set to `0` to disable redundancy penalties; defaults to {@link DEFAULT_DIVERSITY_WEIGHT}.
   */
  diversityWeight?: number;
}

/** Options for {@link searchAndRerank}. */
export interface SearchAndRerankOptions extends RerankOptions {
  /** Candidate pool fetched from BM25 before reranking; defaults to `max(limit * 4, 24)`. */
  candidateLimit?: number;
}

/** One reranked retrieval candidate with its decomposed feature scores. */
export interface RerankHit {
  chunk: Chunk;
  /** Final score after redundancy suppression, rounded to six decimals. */
  score: number;
  /** Pre-diversity weighted relevance score in `[0, 1]`, rounded to six decimals. */
  baseScore: number;
  /** Highest raw BM25 score observed for this chunk among input hits. */
  bm25Score: number;
  /** 1-based position in the reranked result list. */
  rank: number;
  /** Sorted, deduplicated normalised query terms matched for this hit. */
  matchedTerms: string[];
  features: RerankFeatures;
}

// --- Public constants ------------------------------------------------------

/** Default maximum hits returned by {@link rerank} and {@link searchAndRerank}. */
export const DEFAULT_RERANK_LIMIT = DEFAULT_SEARCH_LIMIT;

/**
 * Default feature weights summing to `1.0`.
 *
 * BM25 anchors lexical relevance (`0.25`), quoted spans enforce explicit user phrasing
 * (`0.25`), multi-term density prefers complete dense answers over single-term repetition
 * (`0.20`), and heading-path plus numeric/unit cues resolve structural and technical
 * precision (`0.15` each).
 */
export const DEFAULT_RERANK_WEIGHTS: Readonly<RerankWeights> = {
  bm25: 0.25,
  quotedSpan: 0.25,
  headingMatch: 0.15,
  numericUnit: 0.15,
  multiTermDensity: 0.20,
};

/** Default greedy redundancy suppression multiplier subtracted per unit similarity. */
export const DEFAULT_DIVERSITY_WEIGHT = 0.25;

// --- Internal constants ----------------------------------------------------

const SCORE_DECIMALS = 6;
const FOLDED_QUOTE_FACTOR = 0.65;
const SECTION_FILTER_BONUS = 0.4;
const QUANTITY_WITH_UNIT_SCORE = 0.85;
const QUANTITY_DIGIT_ONLY_SCORE = 0.65;
const MIN_CANDIDATE_POOL = 24;
const TITLE_FALLBACK_WEIGHT = 0.15;
const SECONDARY_QUERY_WEIGHT = 0.5;

const DIGIT_PATTERN = /\p{Nd}/u;
const WORD_CHAR_PATTERN = /[\p{L}\p{N}]/u;
const LEADING_WORD_CHAR = /^[\p{L}\p{N}]/u;
const TRAILING_WORD_CHAR = /[\p{L}\p{N}]$/u;

const NUMBER_WITH_UNIT_PATTERN =
  /(?<![\p{L}\p{N}])([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:[.,]\d+)?)\s*(°\s*[cf]|%|[\p{L}€$¥£₫]{1,16})?/giu;
const PREFIX_CURRENCY_PATTERN = /([$€¥£₫])\s*(\d+(?:[.,]\d+)?)/gu;
const MULTI_WORD_UNIT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bphan\s+tram\b/gu, 'percent'],
  [/\bdo\s+c\b/gu, 'celsius'],
  [/\bdo\s+f\b/gu, 'fahrenheit'],
];

const QUANTITY_INTENT_PATTERNS: readonly RegExp[] = [
  /\bhow\s+(?:many|much|long|often|far|big|large|tall|heavy|fast|old)\b/u,
  /\bwhat\s+(?:is\s+the\s+)?(?:operating\s+)?(?:temperature|weight|mass|voltage|current|power|capacity|latency|duration|warranty|price|cost|rate|ratio|percentage|percent|total|range|limit|threshold|retention|size|length|speed)\b/u,
  /\b(?:temperature|weight|voltage|capacity|duration|latency|price|cost|rate|percentage|total|range)\s+(?:of|for|range|limit)\b/u,
  /\bbao\s+(?:nhieu|lau|xa|gio|nang|cao|dai)\b/u,
  /\b(?:nhiet\s+do|trong\s+luong|khoi\s+luong|dien\s+ap|cong\s+suat|thoi\s+gian|thoi\s+han|ty\s+le|phan\s+tram|gia\s+tri|tong\s+cong)\b/u,
  /多少|多久|多大|多长|百分之|几\s*(?:个|页|年|月|天|条|次|位|种)/u,
];

const UNIT_ALIASES: Readonly<Record<string, string>> = {
  '%': 'percent',
  pct: 'percent',
  percent: 'percent',
  percentage: 'percent',
  '°c': 'celsius',
  celsius: 'celsius',
  '°f': 'fahrenheit',
  fahrenheit: 'fahrenheit',
  kg: 'kg',
  kilogram: 'kg',
  kilograms: 'kg',
  kilogam: 'kg',
  g: 'g',
  gram: 'g',
  grams: 'g',
  mg: 'mg',
  milligram: 'mg',
  milligrams: 'mg',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  ms: 'ms',
  millisecond: 'ms',
  milliseconds: 'ms',
  s: 'sec',
  sec: 'sec',
  secs: 'sec',
  second: 'sec',
  seconds: 'sec',
  giay: 'sec',
  min: 'min',
  mins: 'min',
  minute: 'min',
  minutes: 'min',
  phut: 'min',
  h: 'hour',
  hr: 'hour',
  hrs: 'hour',
  hour: 'hour',
  hours: 'hour',
  gio: 'hour',
  d: 'day',
  day: 'day',
  days: 'day',
  ngay: 'day',
  mo: 'month',
  month: 'month',
  months: 'month',
  thang: 'month',
  y: 'year',
  yr: 'year',
  yrs: 'year',
  year: 'year',
  years: 'year',
  nam: 'year',
  w: 'w',
  watt: 'w',
  watts: 'w',
  kw: 'kw',
  kilowatt: 'kw',
  kilowatts: 'kw',
  mw: 'mw',
  megawatt: 'mw',
  megawatts: 'mw',
  wh: 'wh',
  kwh: 'kwh',
  mwh: 'mwh',
  v: 'v',
  volt: 'v',
  volts: 'v',
  kv: 'kv',
  mv: 'mv',
  a: 'a',
  amp: 'a',
  amps: 'a',
  ampere: 'a',
  amperes: 'a',
  ma: 'ma',
  ah: 'ah',
  mah: 'mah',
  hz: 'hz',
  khz: 'khz',
  mhz: 'mhz',
  ghz: 'ghz',
  mm: 'mm',
  cm: 'cm',
  m: 'm',
  meter: 'm',
  meters: 'm',
  metre: 'm',
  metres: 'm',
  km: 'km',
  b: 'byte',
  byte: 'byte',
  bytes: 'byte',
  kb: 'kb',
  mb: 'mb',
  gb: 'gb',
  tb: 'tb',
  pt: 'pt',
  px: 'px',
  dpi: 'dpi',
  $: 'usd',
  usd: 'usd',
  dollar: 'usd',
  dollars: 'usd',
  vnd: 'vnd',
  dong: 'vnd',
  '₫': 'vnd',
  '€': 'eur',
  eur: 'eur',
  euro: 'eur',
  euros: 'eur',
  '¥': 'jpy',
  jpy: 'jpy',
  '£': 'gbp',
  gbp: 'gbp',
};

interface DeduplicatedCandidate {
  chunk: Chunk;
  bm25Score: number;
  matchedTerms: string[];
}

interface ScoredCandidate {
  chunk: Chunk;
  bm25Score: number;
  matchedTerms: string[];
  baseScore: number;
  features: Omit<RerankFeatures, 'redundancyPenalty'>;
  tokenSet: ReadonlySet<string>;
  bigramSet: ReadonlySet<string>;
  blockSet: ReadonlySet<string>;
}

interface NumericSignature {
  numbers: ReadonlySet<string>;
  units: ReadonlySet<string>;
  pairs: ReadonlySet<string>;
  targets: readonly string[];
  hasDigits: boolean;
}

// --- Entry points ----------------------------------------------------------

/**
 * Reranks `hits` against `query` using local deterministic cross-features and greedy
 * redundancy suppression.
 */
export function rerank(
  query: string,
  hits: readonly SearchHit[],
  options: RerankOptions = {},
): RerankHit[] {
  if (!Array.isArray(hits) || hits.length === 0) return [];
  const limit = readLimit(options.limit);
  if (limit === 0) return [];

  const safeQuery = typeof query === 'string' ? query : '';
  const plan = options.queryPlan ?? rewriteQuery(safeQuery, options.queryContext);
  const quoted = collectQuotedPhrases(safeQuery, options.quotedPhrases);
  const keywords = resolveKeywords(safeQuery, plan);
  if (keywords.length === 0 && quoted.length === 0) return [];

  const candidates = deduplicateHits(hits);
  if (candidates.length === 0) return [];

  const weights = readWeights(options.weights);
  const diversityWeight = readDiversityWeight(options.diversityWeight);
  const weightSum =
    weights.bm25 +
    weights.quotedSpan +
    weights.headingMatch +
    weights.numericUnit +
    weights.multiTermDensity;

  const maxBm25 = candidates.reduce((best, item) => Math.max(best, item.bm25Score), 0);
  const queryNumeric = extractNumericSignature(safeQuery);
  const quantityIntent = hasQuantityIntent(safeQuery);
  const sectionFilter =
    typeof plan.filters.section === 'string' && plan.filters.section.length > 0
      ? plan.filters.section
      : null;

  const scored: ScoredCandidate[] = candidates.map(candidate => {
    const bm25 = maxBm25 > 0 ? clamp01(candidate.bm25Score / maxBm25) : 0;
    const quotedSpan = scoreQuotedSpan(candidate.chunk, quoted);
    const headingMatch = scoreHeadingMatch(candidate.chunk, keywords, sectionFilter);
    const numericUnit = scoreNumericUnit(candidate.chunk, queryNumeric, quantityIntent);
    const multiTermDensity = scoreMultiTermDensity(candidate.chunk, keywords);

    const rawBase =
      weightSum > 0
        ? (weights.bm25 * bm25 +
            weights.quotedSpan * quotedSpan +
            weights.headingMatch * headingMatch +
            weights.numericUnit * numericUnit +
            weights.multiTermDensity * multiTermDensity) /
          weightSum
        : 0;

    const chunkTokens = tokenize(
      typeof candidate.chunk.text === 'string' && candidate.chunk.text.trim().length > 0
        ? candidate.chunk.text
        : headingText(candidate.chunk),
    );

    return {
      chunk: candidate.chunk,
      bm25Score: candidate.bm25Score,
      matchedTerms: candidate.matchedTerms,
      baseScore: round(clamp01(rawBase), SCORE_DECIMALS),
      features: {
        bm25: round(bm25, SCORE_DECIMALS),
        quotedSpan: round(quotedSpan, SCORE_DECIMALS),
        headingMatch: round(headingMatch, SCORE_DECIMALS),
        numericUnit: round(numericUnit, SCORE_DECIMALS),
        multiTermDensity: round(multiTermDensity, SCORE_DECIMALS),
      },
      tokenSet: new Set(chunkTokens),
      bigramSet: buildBigramSet(chunkTokens),
      blockSet: new Set(Array.isArray(candidate.chunk.blockIds) ? candidate.chunk.blockIds : []),
    };
  });

  return selectWithDiversity(scored, limit, diversityWeight);
}

/**
 * Rewrites `query`, gathers BM25 candidates across the planned queries from `target`,
 * and reranks them with {@link rerank}.
 */
export function searchAndRerank(
  target: RetrievalIndex,
  query: string,
  options: SearchAndRerankOptions = {},
): RerankHit[] {
  if (!target || typeof target.search !== 'function') return [];
  const limit = readLimit(options.limit);
  if (limit === 0) return [];

  const safeQuery = typeof query === 'string' ? query : '';
  const plan = options.queryPlan ?? rewriteQuery(safeQuery, options.queryContext);
  if (plan.queries.length === 0) return [];

  const candidateLimit = readCandidateLimit(options.candidateLimit, limit);
  const hasTitleFallback = plan.reasons.includes('title-query-added') && plan.queries.length > 1;
  const merged = new Map<string, { chunk: Chunk; score: number; matched: Set<string> }>();

  plan.queries.forEach((subQuery, position) => {
    const weight =
      position === 0
        ? 1
        : hasTitleFallback && position === plan.queries.length - 1
          ? TITLE_FALLBACK_WEIGHT
          : SECONDARY_QUERY_WEIGHT;

    for (const hit of target.search(subQuery, { limit: candidateLimit })) {
      if (!hit || !hit.chunk) continue;
      const key = chunkKey(hit.chunk, merged.size);
      const weightedScore = (Number.isFinite(hit.score) ? Math.max(0, hit.score) : 0) * weight;
      const existing = merged.get(key);
      if (existing) {
        existing.score =
          Math.max(existing.score, weightedScore) + Math.min(existing.score, weightedScore) * 0.25;
        for (const term of hit.matchedTerms) existing.matched.add(term);
      } else {
        merged.set(key, {
          chunk: hit.chunk,
          score: weightedScore,
          matched: new Set(hit.matchedTerms),
        });
      }
    }
  });

  const combinedHits: SearchHit[] = [];
  for (const entry of merged.values()) {
    combinedHits.push({
      chunk: entry.chunk,
      score: round(entry.score, SCORE_DECIMALS),
      matchedTerms: [...entry.matched].sort(compareText),
    });
  }

  return rerank(safeQuery, combinedHits, { ...options, limit, queryPlan: plan });
}

// --- Feature scorers -------------------------------------------------------

function scoreQuotedSpan(chunk: Chunk, quoted: readonly string[]): number {
  if (quoted.length === 0) return 0;
  const haystacks = [chunk.text, ...(Array.isArray(chunk.headingPath) ? chunk.headingPath : [])];
  const exactHaystacks = haystacks
    .map(part => normalizeSpace(part).toLowerCase())
    .filter(s => s.length > 0);
  const foldedHaystacks = exactHaystacks.map(part => foldDiacritics(part));

  let total = 0;
  for (const phrase of quoted) {
    const exactNeedle = normalizeSpace(phrase).toLowerCase();
    if (exactNeedle.length === 0) continue;
    if (exactHaystacks.some(hay => containsWithBoundary(hay, exactNeedle))) {
      total += 1;
      continue;
    }
    const foldedNeedle = foldDiacritics(exactNeedle);
    if (foldedNeedle.length > 0 && foldedHaystacks.some(hay => containsWithBoundary(hay, foldedNeedle))) {
      total += FOLDED_QUOTE_FACTOR;
    }
  }
  return clamp01(total / quoted.length);
}

function scoreHeadingMatch(
  chunk: Chunk,
  keywords: readonly string[],
  sectionFilter: string | null,
): number {
  const path = Array.isArray(chunk.headingPath) ? chunk.headingPath : [];
  if (path.length === 0) return 0;

  const joined = path.join(' ');
  const headingTokens = new Set(tokenize(joined));
  let matched = 0;
  for (const term of keywords) {
    if (headingTokens.has(term)) matched += 1;
  }
  const keywordCoverage = keywords.length > 0 ? matched / keywords.length : 0;

  if (sectionFilter !== null) {
    const foldedHeading = foldDiacritics(normalizeSpace(joined)).replace(/,/gu, '.');
    const foldedSection = foldDiacritics(sectionFilter).replace(/,/gu, '.');
    if (foldedSection.length > 0 && containsWithBoundary(foldedHeading, foldedSection)) {
      return clamp01(keywordCoverage + SECTION_FILTER_BONUS);
    }
  }

  return clamp01(keywordCoverage);
}

function scoreNumericUnit(
  chunk: Chunk,
  querySig: NumericSignature,
  quantityIntent: boolean,
): number {
  const chunkText = `${headingText(chunk)} ${typeof chunk.text === 'string' ? chunk.text : ''}`.trim();
  const chunkSig = extractNumericSignature(chunkText);

  if (querySig.targets.length > 0) {
    let matched = 0;
    for (const target of querySig.targets) {
      if (target.startsWith('n:') && chunkSig.numbers.has(target.slice(2))) matched += 1;
      else if (target.startsWith('u:') && chunkSig.units.has(target.slice(2))) matched += 1;
      else if (target.startsWith('p:') && chunkSig.pairs.has(target.slice(2))) matched += 1;
    }
    return clamp01(matched / querySig.targets.length);
  }

  if (quantityIntent && chunkSig.hasDigits) {
    return chunkSig.units.size > 0 ? QUANTITY_WITH_UNIT_SCORE : QUANTITY_DIGIT_ONLY_SCORE;
  }

  return 0;
}

function scoreMultiTermDensity(chunk: Chunk, keywords: readonly string[]): number {
  if (keywords.length === 0) return 0;
  const keywordSet = new Set(keywords);
  const tokens = tokenize(`${headingText(chunk)} ${typeof chunk.text === 'string' ? chunk.text : ''}`);
  if (tokens.length === 0) return 0;

  const positions: Array<{ term: string; index: number }> = [];
  const matched = new Set<string>();
  tokens.forEach((token, index) => {
    if (!keywordSet.has(token)) return;
    matched.add(token);
    positions.push({ term: token, index });
  });

  if (matched.size === 0) return 0;
  const coverage = matched.size / keywords.length;

  if (keywords.length === 1) {
    const concentration = Math.min(1, (positions.length * 8) / Math.max(8, tokens.length));
    return clamp01(coverage * (0.7 + 0.3 * concentration));
  }

  if (matched.size < 2) {
    return clamp01(coverage * 0.65);
  }

  const minSpan = minimumCoveringSpan(positions, matched.size);
  const compactness = minSpan > 0 ? clamp01(matched.size / minSpan) : 0;
  return clamp01(coverage * (0.65 + 0.35 * compactness));
}

function minimumCoveringSpan(
  positions: readonly { term: string; index: number }[],
  distinctTarget: number,
): number {
  const counts = new Map<string, number>();
  let left = 0;
  let covered = 0;
  let best = Number.POSITIVE_INFINITY;

  for (let right = 0; right < positions.length; right += 1) {
    const rightItem = positions[right];
    if (rightItem === undefined) continue;
    const prevCount = counts.get(rightItem.term) ?? 0;
    if (prevCount === 0) covered += 1;
    counts.set(rightItem.term, prevCount + 1);

    while (covered === distinctTarget && left <= right) {
      const leftItem = positions[left];
      if (leftItem === undefined) break;
      const span = rightItem.index - leftItem.index + 1;
      if (span < best) best = span;

      const nextCount = (counts.get(leftItem.term) ?? 1) - 1;
      counts.set(leftItem.term, nextCount);
      if (nextCount === 0) covered -= 1;
      left += 1;
    }
  }

  return Number.isFinite(best) ? best : 0;
}

// --- Diversity selection ---------------------------------------------------

function selectWithDiversity(
  candidates: readonly ScoredCandidate[],
  limit: number,
  diversityWeight: number,
): RerankHit[] {
  const remaining = [...candidates];
  const selected: Array<{ candidate: ScoredCandidate; score: number; penalty: number }> = [];

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = -1;
    let bestAdjusted = -1;
    let bestPenalty = 0;

    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      if (candidate === undefined) continue;

      let maxSimilarity = 0;
      if (diversityWeight > 0 && selected.length > 0) {
        for (const picked of selected) {
          const similarity = chunkSimilarity(candidate, picked.candidate);
          if (similarity > maxSimilarity) maxSimilarity = similarity;
        }
      }

      const penalty = round(diversityWeight * maxSimilarity, SCORE_DECIMALS);
      const adjusted = round(Math.max(0, candidate.baseScore - penalty), SCORE_DECIMALS);

      if (bestIndex === -1) {
        bestIndex = index;
        bestAdjusted = adjusted;
        bestPenalty = penalty;
        continue;
      }

      const currentBest = remaining[bestIndex];
      if (
        currentBest === undefined ||
        compareCandidateRank(candidate, adjusted, currentBest, bestAdjusted) < 0
      ) {
        bestIndex = index;
        bestAdjusted = adjusted;
        bestPenalty = penalty;
      }
    }

    if (bestIndex < 0) break;
    const chosen = remaining.splice(bestIndex, 1)[0];
    if (chosen === undefined) break;
    selected.push({ candidate: chosen, score: bestAdjusted, penalty: bestPenalty });
  }

  return selected.map((entry, index) => ({
    chunk: entry.candidate.chunk,
    score: entry.score,
    baseScore: entry.candidate.baseScore,
    bm25Score: entry.candidate.bm25Score,
    rank: index + 1,
    matchedTerms: entry.candidate.matchedTerms,
    features: {
      ...entry.candidate.features,
      redundancyPenalty: entry.penalty,
    },
  }));
}

function compareCandidateRank(
  left: ScoredCandidate,
  leftScore: number,
  right: ScoredCandidate,
  rightScore: number,
): number {
  return (
    rightScore - leftScore ||
    right.baseScore - left.baseScore ||
    right.bm25Score - left.bm25Score ||
    finiteOr(left.chunk.page, 1) - finiteOr(right.chunk.page, 1) ||
    compareText(left.chunk.documentId ?? '', right.chunk.documentId ?? '') ||
    compareText(left.chunk.id ?? '', right.chunk.id ?? '')
  );
}

function chunkSimilarity(left: ScoredCandidate, right: ScoredCandidate): number {
  const tokenSim = jaccard(left.tokenSet, right.tokenSet);
  const bigramSim =
    left.bigramSet.size > 0 && right.bigramSet.size > 0
      ? jaccard(left.bigramSet, right.bigramSet)
      : tokenSim;
  const textSim = 0.65 * tokenSim + 0.35 * bigramSim;
  const blockSim =
    left.chunk.documentId === right.chunk.documentId &&
    left.blockSet.size > 0 &&
    right.blockSet.size > 0
      ? jaccard(left.blockSet, right.blockSet)
      : 0;
  return clamp01(Math.max(textSim, 0.5 * textSim + 0.5 * blockSim));
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  for (const item of smaller) {
    if (larger.has(item)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function buildBigramSet(tokens: readonly string[]): Set<string> {
  const bigrams = new Set<string>();
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const first = tokens[index];
    const second = tokens[index + 1];
    if (first === undefined || second === undefined) continue;
    bigrams.add(`${first}\u0000${second}`);
  }
  return bigrams;
}

// --- Numeric and query helpers ---------------------------------------------

function extractNumericSignature(text: string): NumericSignature {
  const numbers = new Set<string>();
  const units = new Set<string>();
  const pairs = new Set<string>();
  const normalized = normalizeSpace(text);
  const hasDigits = DIGIT_PATTERN.test(normalized);

  if (normalized.length > 0) {
    for (const match of normalized.matchAll(NUMBER_WITH_UNIT_PATTERN)) {
      const rawNum = match[1];
      if (rawNum === undefined) continue;
      const num = normalizeNumber(rawNum);
      if (num === null) continue;
      numbers.add(num);

      const rawUnit = match[2];
      const canonicalUnit = rawUnit !== undefined ? canonicalizeUnit(rawUnit) : null;
      if (canonicalUnit !== null) {
        units.add(canonicalUnit);
        pairs.add(`${num}:${canonicalUnit}`);
      }
    }

    for (const match of normalized.matchAll(PREFIX_CURRENCY_PATTERN)) {
      const rawCurrency = match[1];
      const rawNum = match[2];
      if (rawCurrency === undefined || rawNum === undefined) continue;
      const num = normalizeNumber(rawNum);
      const unit = canonicalizeUnit(rawCurrency);
      if (num !== null && unit !== null) {
        numbers.add(num);
        units.add(unit);
        pairs.add(`${num}:${unit}`);
      }
    }

    const folded = foldDiacritics(normalized);
    for (const [pattern, canonical] of MULTI_WORD_UNIT_PATTERNS) {
      if (pattern.test(folded)) units.add(canonical);
      pattern.lastIndex = 0;
    }

    for (const token of tokenize(normalized)) {
      const canonical = UNIT_ALIASES[token];
      if (canonical !== undefined && !DIGIT_PATTERN.test(token)) {
        units.add(canonical);
      }
    }
  }

  const targets: string[] = [];
  for (const num of numbers) targets.push(`n:${num}`);
  for (const unit of units) targets.push(`u:${unit}`);
  for (const pair of pairs) targets.push(`p:${pair}`);

  return { numbers, units, pairs, targets, hasDigits };
}

function normalizeNumber(raw: string): string | null {
  const stripped = raw.replace(/^\+/u, '').trim();
  if (stripped.length === 0) return null;
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(stripped)) {
    return stripped.replace(/,/gu, '');
  }
  return stripped.replace(/,/gu, '.');
}

function canonicalizeUnit(raw: string): string | null {
  const compact = foldDiacritics(raw).replace(/\s+/gu, '').replace(/[.,;:!?)]+$/u, '');
  if (compact.length === 0) return null;
  return UNIT_ALIASES[compact] ?? null;
}

function hasQuantityIntent(query: string): boolean {
  const folded = foldDiacritics(normalizeSpace(query));
  if (folded.length === 0) return false;
  return QUANTITY_INTENT_PATTERNS.some(pattern => pattern.test(folded));
}

function collectQuotedPhrases(query: string, extra?: readonly string[]): string[] {
  const phrases: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    const trimmed = normalizeSpace(value);
    const key = trimmed.toLowerCase();
    if (trimmed.length === 0 || seen.has(key)) return;
    seen.add(key);
    phrases.push(trimmed);
  };
  for (const span of quotePhrases(query)) push(span);
  if (Array.isArray(extra)) {
    for (const span of extra) {
      if (typeof span === 'string') push(span);
    }
  }
  return phrases;
}

function resolveKeywords(query: string, plan: QueryPlan): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const source =
    Array.isArray(plan?.keywords) && plan.keywords.length > 0 ? plan.keywords : tokenize(query);
  for (const term of source) {
    if (typeof term !== 'string' || term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    result.push(term);
  }
  return result;
}

function deduplicateHits(hits: readonly SearchHit[]): DeduplicatedCandidate[] {
  const byId = new Map<string, { chunk: Chunk; score: number; terms: Set<string> }>();
  hits.forEach((hit, position) => {
    if (!hit || typeof hit !== 'object' || !hit.chunk || typeof hit.chunk.text !== 'string') return;
    const key = chunkKey(hit.chunk, position);
    const score = Number.isFinite(hit.score) ? Math.max(0, hit.score) : 0;
    const matched = Array.isArray(hit.matchedTerms) ? hit.matchedTerms : [];
    const existing = byId.get(key);
    if (existing) {
      if (score > existing.score) existing.score = score;
      for (const term of matched) {
        if (typeof term === 'string' && term.length > 0) existing.terms.add(term);
      }
    } else {
      const terms = new Set<string>();
      for (const term of matched) {
        if (typeof term === 'string' && term.length > 0) terms.add(term);
      }
      byId.set(key, { chunk: hit.chunk, score, terms });
    }
  });

  const candidates: DeduplicatedCandidate[] = [];
  for (const entry of byId.values()) {
    candidates.push({
      chunk: entry.chunk,
      bm25Score: entry.score,
      matchedTerms: [...entry.terms].sort(compareText),
    });
  }
  return candidates;
}

// --- Small helpers ---------------------------------------------------------

function containsWithBoundary(haystack: string, needle: string): boolean {
  if (needle.length === 0 || haystack.length < needle.length) return false;
  const chars = [...needle];
  const firstChar = chars[0] ?? '';
  const lastChar = chars[chars.length - 1] ?? '';
  const needStartBoundary = WORD_CHAR_PATTERN.test(firstChar);
  const needEndBoundary = WORD_CHAR_PATTERN.test(lastChar);

  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const end = at + needle.length;
    const startOk = !needStartBoundary || at === 0 || !TRAILING_WORD_CHAR.test(haystack.slice(0, at));
    const endOk =
      !needEndBoundary || end >= haystack.length || !LEADING_WORD_CHAR.test(haystack.slice(end));
    if (startOk && endOk) return true;
    from = at + 1;
  }
  return false;
}

function headingText(chunk: Chunk): string {
  return Array.isArray(chunk.headingPath) ? chunk.headingPath.join(' ') : '';
}

function chunkKey(chunk: Chunk, fallback: number): string {
  const id = typeof chunk.id === 'string' ? chunk.id : '';
  if (id.length === 0) return `idx:${fallback}`;
  const docId = typeof chunk.documentId === 'string' ? chunk.documentId : '';
  return `${docId}\u0000${id}`;
}

function foldDiacritics(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/gu, 'd');
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function readLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_RERANK_LIMIT;
  const floored = Math.floor(value);
  return floored < 0 ? DEFAULT_RERANK_LIMIT : floored;
}

function readCandidateLimit(value: unknown, limit: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= limit) {
    return Math.floor(value);
  }
  return Math.max(limit * 4, MIN_CANDIDATE_POOL);
}

function readWeights(overrides: Partial<RerankWeights> | undefined): RerankWeights {
  if (!overrides || typeof overrides !== 'object') return { ...DEFAULT_RERANK_WEIGHTS };
  return {
    bm25: nonNegativeOr(overrides.bm25, DEFAULT_RERANK_WEIGHTS.bm25),
    quotedSpan: nonNegativeOr(overrides.quotedSpan, DEFAULT_RERANK_WEIGHTS.quotedSpan),
    headingMatch: nonNegativeOr(overrides.headingMatch, DEFAULT_RERANK_WEIGHTS.headingMatch),
    numericUnit: nonNegativeOr(overrides.numericUnit, DEFAULT_RERANK_WEIGHTS.numericUnit),
    multiTermDensity: nonNegativeOr(
      overrides.multiTermDensity,
      DEFAULT_RERANK_WEIGHTS.multiTermDensity,
    ),
  };
}

function readDiversityWeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DIVERSITY_WEIGHT;
  return clamp01(value);
}

function nonNegativeOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
