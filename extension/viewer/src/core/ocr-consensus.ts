/**
 * Multi-engine OCR comparison and consensus selection (backlog F11).
 *
 * A single OCR engine routinely fails quietly on real PDFs: a native engine
 * drops Vietnamese tone marks on low-DPI glyphs, Tesseract hallucinates a digit
 * at 99% confidence, or a cloud call times out while local engines succeed.
 * Comparing candidates across `windows-ocr`, `tesseract`, `paddle-ocr`, and
 * `cloud-vision` lets a region settle on the reading corroborated by peers,
 * surface numeric conflicts before they reach translation, and account per-region
 * and batch spend.
 *
 * Contract:
 * - Pure and deterministic: no DOM, no network, no clock, no randomness. Equal
 *   inputs always yield identical rankings regardless of candidate array order.
 * - Text similarity reuses {@link normalizeOcrText}, {@link characterDistance},
 *   {@link countCharacters}, {@link splitWords}, and {@link alignWords} from
 *   `./ocr-metrics`, keeping NFC diacritics intact and counting code points.
 * - Consensus scoring combines peer agreement (exact + near-agreement cluster
 *   shares and pairwise text similarity), normalized engine confidence, and
 *   script/language fit; tie-breaks prefer lower cost and {@link CONSENSUS_ENGINE_ORDER}.
 * - Numeric conflicts are detected independently of overall edit similarity so
 *   a single altered digit inside a long sentence never looks unanimous.
 */

import { ENGINE_COST_MS, type Engine } from './engine-plan';
import { detectScript, normalizeLanguageCode, type ScriptName } from './language';
import {
  alignWords,
  characterDistance,
  countCharacters,
  normalizeOcrText,
  splitWords,
} from './ocr-metrics';
import type { Rect } from './types';

// --- Public shapes & constants ---------------------------------------------

/** OCR engines compared by the consensus selector. */
export type OcrConsensusEngine = 'windows-ocr' | 'tesseract' | 'paddle-ocr' | 'cloud-vision';

/** Candidate execution status after normalization. */
export type OcrCandidateStatus = 'ok' | 'empty' | 'failed';

/**
 * Deterministic tie-break order when total score, consensus, script fit,
 * confidence, and cost are equal: native/local engines precede paid cloud.
 */
export const CONSENSUS_ENGINE_ORDER: readonly OcrConsensusEngine[] = [
  'windows-ocr',
  'paddle-ocr',
  'tesseract',
  'cloud-vision',
];

/** Default marginal USD cost per region call when a candidate omits `costUsd`. */
export const DEFAULT_ENGINE_COST_USD: Record<OcrConsensusEngine, number> = {
  'windows-ocr': 0,
  'paddle-ocr': 0,
  tesseract: 0,
  'cloud-vision': 0.0015,
};

/** Reference per-page latencies (ms), aligned with `ENGINE_COST_MS` where shared. */
export const DEFAULT_ENGINE_LATENCY_MS: Record<OcrConsensusEngine, number> = {
  'windows-ocr': ENGINE_COST_MS.windows,
  'paddle-ocr': 450,
  tesseract: ENGINE_COST_MS.tesseract,
  'cloud-vision': ENGINE_COST_MS.browser,
};

/** Weights applied to candidate ranking factors (normalized by their sum). */
export interface ConsensusWeights {
  readonly consensus: number;
  readonly confidence: number;
  readonly scriptMatch: number;
}

/**
 * Default scoring weights: consensus leads so a 2-of-3 agreement overcomes an
 * overconfident outlier, while confidence and script fit break 1-vs-1 splits.
 */
export const DEFAULT_CONSENSUS_WEIGHTS: ConsensusWeights = {
  consensus: 0.6,
  confidence: 0.25,
  scriptMatch: 0.15,
};

/** Default pairwise similarity threshold for two candidates to count as agreeing. */
export const DEFAULT_AGREEMENT_THRESHOLD = 0.95;

/** Raw output reported by one OCR engine for one region. */
export interface OcrEngineCandidate {
  readonly engine: OcrConsensusEngine;
  readonly text: string;
  /** Confidence in `[0, 1]` or percentage `(1, 100]`; normalized to `[0, 1]`. */
  readonly confidence: number;
  /** Explicit execution outcome; errors also force `'failed'`. */
  readonly status?: 'ok' | 'failed';
  /** Failure reason when the engine errored or timed out. */
  readonly error?: string;
  /** Explicit USD cost billed for this engine on this region. */
  readonly costUsd?: number;
  /** Measured latency in milliseconds. */
  readonly latencyMs?: number;
  /** Optional language tag reported by the engine. */
  readonly language?: string;
}

/** Tuning knobs for candidate comparison and region selection. */
export interface OcrComparisonOptions {
  /** Expected language code (e.g. `'vi'`, `'en'`, `'ja'`), normalized via `normalizeLanguageCode`. */
  readonly expectedLanguage?: string;
  /** Explicit expected script; overrides the script inferred from `expectedLanguage`. */
  readonly expectedScript?: ScriptName;
  /** Minimum similarity in `[0, 1]` for two candidates to agree. Defaults to {@link DEFAULT_AGREEMENT_THRESHOLD}. */
  readonly agreementThreshold?: number;
  /** Custom factor weights; normalized automatically. */
  readonly weights?: Partial<ConsensusWeights>;
}

/** Scored candidate produced by {@link compareOcrCandidates}. */
export interface ScoredOcrCandidate {
  readonly engine: OcrConsensusEngine;
  readonly status: OcrCandidateStatus;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly confidence: number;
  readonly consensusScore: number;
  readonly scriptMatchScore: number;
  readonly totalScore: number;
  readonly detectedScript: ScriptName;
  readonly numericTokens: readonly string[];
  readonly peerAgreementCount: number;
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly error?: string;
}

/** Numeric-token conflict summary across non-empty candidates. */
export interface NumericDisagreement {
  readonly hasDisagreement: boolean;
  readonly conflictingTokens: readonly string[];
  readonly tokensByEngine: Partial<Record<OcrConsensusEngine, readonly string[]>>;
}

/** Detailed comparison across all candidates for a single region. */
export interface OcrComparisonReport {
  readonly ranked: readonly ScoredOcrCandidate[];
  readonly winner: ScoredOcrCandidate | null;
  /** Share of all submitted candidates that agree with `winner` (0..1). */
  readonly agreementRatio: number;
  /** Share of non-failed candidates that agree with `winner` (0..1). */
  readonly nonFailedAgreementRatio: number;
  readonly agreeingEngines: readonly OcrConsensusEngine[];
  readonly totalCostUsd: number;
  readonly winnerCostUsd: number;
  readonly hasNumericDisagreement: boolean;
  readonly numericDisagreement: NumericDisagreement;
  readonly validCandidateCount: number;
  readonly emptyCandidateCount: number;
  readonly failedCandidateCount: number;
  readonly totalCandidateCount: number;
}

/** Input region handed to {@link selectRegionConsensus}. */
export interface OcrRegionInput {
  readonly regionId: string;
  readonly page?: number;
  readonly rect?: Rect;
  readonly expectedLanguage?: string;
  readonly expectedScript?: ScriptName;
  readonly candidates: readonly OcrEngineCandidate[];
}

/** Consensus outcome recorded for one region. */
export interface RegionConsensusResult {
  readonly regionId: string;
  readonly page?: number;
  readonly rect?: Rect;
  readonly outcome: 'selected' | 'empty' | 'failed';
  readonly winningEngine: OcrConsensusEngine | null;
  readonly selectedText: string;
  readonly winnerConfidence: number;
  readonly winnerScore: number;
  readonly agreementRatio: number;
  readonly nonFailedAgreementRatio: number;
  readonly agreeingEngines: readonly OcrConsensusEngine[];
  readonly totalCostUsd: number;
  readonly winnerCostUsd: number;
  readonly costByEngine: Partial<Record<OcrConsensusEngine, number>>;
  readonly hasNumericDisagreement: boolean;
  readonly numericDisagreement: NumericDisagreement;
  readonly candidates: readonly ScoredOcrCandidate[];
}

/** Options for {@link summarizeBatchConsensus}. */
export interface BatchConsensusOptions {
  /** Regions strictly below this agreement ratio count as disagreement regions. Defaults to `1`. */
  readonly minAgreementRatio?: number;
}

/** Aggregated summary across a batch of region consensus results. */
export interface BatchConsensusSummary {
  readonly regionCount: number;
  readonly resolvedCount: number;
  readonly emptyCount: number;
  readonly failedCount: number;
  readonly winnerCounts: Record<OcrConsensusEngine, number>;
  readonly totalCostUsd: number;
  readonly costByEngine: Record<OcrConsensusEngine, number>;
  readonly meanAgreementRatio: number;
  readonly disagreementRegions: readonly string[];
  readonly numericConflictRegions: readonly string[];
}

// --- Constants & internal patterns -----------------------------------------

const SCORE_EPSILON = 1e-9;

const HAS_LETTER = /\p{L}/u;

/** Vietnamese-distinct letters and tone-marked vowels (NFC). */
const VIETNAMESE_MARKERS =
  /[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/u;

const NUMERIC_TOKEN_PATTERN = /(?<![\p{L}\p{N}])[-−]\d+(?:[.,]\d+)*|\d+(?:[.,]\d+)*/gu;

const LANGUAGE_TO_SCRIPTS: Record<string, readonly ScriptName[]> = {
  ja: ['kana', 'han'],
  zh: ['han'],
  ko: ['hangul'],
  ru: ['cyrillic'],
  uk: ['cyrillic'],
  ar: ['arabic'],
  hi: ['devanagari'],
  th: ['thai'],
  en: ['latin'],
  vi: ['latin'],
  fr: ['latin'],
  de: ['latin'],
  es: ['latin'],
  pt: ['latin'],
  id: ['latin'],
  it: ['latin'],
  nl: ['latin'],
  pl: ['latin'],
  tr: ['latin'],
  sv: ['latin'],
  da: ['latin'],
  fi: ['latin'],
  nb: ['latin'],
  cs: ['latin'],
  hu: ['latin'],
  ro: ['latin'],
};

const EMPTY_NUMERIC_DISAGREEMENT: NumericDisagreement = {
  hasDisagreement: false,
  conflictingTokens: [],
  tokensByEngine: {},
};

// --- Helper functions ------------------------------------------------------

function roundUsd(amount: number): number {
  return Math.round(amount * 1e8) / 1e8;
}

function emptyEngineRecord(): Record<OcrConsensusEngine, number> {
  return {
    'windows-ocr': 0,
    'paddle-ocr': 0,
    tesseract: 0,
    'cloud-vision': 0,
  };
}

/** Maps a planner `Engine` identifier to its consensus engine identifier. */
export function fromPlanEngine(engine: Engine): OcrConsensusEngine {
  switch (engine) {
    case 'windows':
      return 'windows-ocr';
    case 'tesseract':
      return 'tesseract';
    case 'browser':
      return 'cloud-vision';
  }
}

/**
 * Normalizes a confidence value into `[0, 1]`.
 *
 * Values in `(1, 100]` are treated as percentage scores (e.g. Tesseract's
 * 0–100 scale) and divided by `100`. Non-finite or non-positive values clamp to `0`.
 */
export function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value <= 1) return value;
  if (value <= 100) return value / 100;
  return 1;
}

/**
 * Extracts numeric tokens from normalized text, preserving decimal/grouping
 * separators and leading minus signs so digit or separator changes stay visible.
 */
export function extractNumericTokens(text: string): string[] {
  const normalized = normalizeOcrText(text);
  if (!normalized) return [];
  const matches = normalized.match(NUMERIC_TOKEN_PATTERN);
  if (!matches) return [];
  return matches.map(token => token.replace('−', '-'));
}

/**
 * Normalized code-point edit similarity in `[0, 1]` after NFC and whitespace
 * normalization (`1 - characterDistance(a, b) / max(len(a), len(b))`).
 */
export function normalizedEditSimilarity(a: string, b: string): number {
  const normA = normalizeOcrText(a);
  const normB = normalizeOcrText(b);
  const lenA = countCharacters(normA);
  const lenB = countCharacters(normB);
  const maxLen = Math.max(lenA, lenB);
  if (maxLen === 0) return 1;
  const dist = characterDistance(normA, normB);
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Word-level agreement in `[0, 1]` derived from `alignWords` Levenshtein edits.
 */
export function tokenAgreementScore(a: string, b: string): number {
  const wordsA = splitWords(a);
  const wordsB = splitWords(b);
  const maxWords = Math.max(wordsA.length, wordsB.length);
  if (maxWords === 0) return 1;
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  const { errors } = alignWords(a, b);
  return Math.max(0, 1 - errors / maxWords);
}

/**
 * Combined character-edit and token-level agreement similarity in `[0, 1]`.
 */
export function textAgreementSimilarity(a: string, b: string): number {
  const normA = normalizeOcrText(a);
  const normB = normalizeOcrText(b);
  if (normA === normB) return 1;
  if (!normA || !normB) return 0;
  return 0.6 * normalizedEditSimilarity(normA, normB) + 0.4 * tokenAgreementScore(normA, normB);
}

function expectedScriptsForLanguage(language: string | undefined): readonly ScriptName[] | null {
  if (!language) return null;
  const code = normalizeLanguageCode(language);
  if (code === 'auto') return null;
  return LANGUAGE_TO_SCRIPTS[code] ?? null;
}

/**
 * Scores how well `text` matches the expected script (and Vietnamese diacritic
 * cues when `expectedLanguage` normalizes to `'vi'`), or falls back to
 * `consensusScript` when no expectation was supplied.
 */
export function computeScriptMatchScore(
  text: string,
  options: {
    readonly expectedLanguage?: string;
    readonly expectedScript?: ScriptName;
    readonly consensusScript?: ScriptName;
  } = {},
): number {
  const normalized = normalizeOcrText(text);
  if (!normalized) return 0;
  if (!HAS_LETTER.test(normalized)) return 1;

  const detected = detectScript(normalized);
  const expectedLang = options.expectedLanguage ? normalizeLanguageCode(options.expectedLanguage) : undefined;
  const allowedScripts = options.expectedScript
    ? [options.expectedScript]
    : expectedScriptsForLanguage(expectedLang) ?? (options.consensusScript ? [options.consensusScript] : null);

  if (!allowedScripts) return 1;
  if (!allowedScripts.includes(detected)) return 0;

  if (expectedLang === 'vi' && detected === 'latin') {
    return VIETNAMESE_MARKERS.test(normalized) ? 1 : 0.5;
  }
  return 1;
}

function resolveWeights(weights?: Partial<ConsensusWeights>): ConsensusWeights {
  const raw: ConsensusWeights = {
    consensus: weights?.consensus ?? DEFAULT_CONSENSUS_WEIGHTS.consensus,
    confidence: weights?.confidence ?? DEFAULT_CONSENSUS_WEIGHTS.confidence,
    scriptMatch: weights?.scriptMatch ?? DEFAULT_CONSENSUS_WEIGHTS.scriptMatch,
  };
  const values = [raw.consensus, raw.confidence, raw.scriptMatch];
  if (values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('compareOcrCandidates: consensus weights must be finite non-negative numbers.');
  }
  const sum = raw.consensus + raw.confidence + raw.scriptMatch;
  if (sum <= 0) {
    throw new RangeError('compareOcrCandidates: consensus weights must sum to a positive number.');
  }
  return {
    consensus: raw.consensus / sum,
    confidence: raw.confidence / sum,
    scriptMatch: raw.scriptMatch / sum,
  };
}

function resolveThreshold(threshold: number | undefined): number {
  const value = threshold ?? DEFAULT_AGREEMENT_THRESHOLD;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`compareOcrCandidates: agreementThreshold must be in [0, 1], got ${String(value)}.`);
  }
  return value;
}

function resolveCostUsd(candidate: OcrEngineCandidate, status: OcrCandidateStatus): number {
  if (candidate.costUsd !== undefined) {
    if (!Number.isFinite(candidate.costUsd) || candidate.costUsd < 0) {
      throw new RangeError(`compareOcrCandidates: costUsd must be a finite non-negative number, got ${String(candidate.costUsd)}.`);
    }
    return candidate.costUsd;
  }
  return status === 'failed' ? 0 : DEFAULT_ENGINE_COST_USD[candidate.engine];
}

function resolveLatencyMs(candidate: OcrEngineCandidate, status: OcrCandidateStatus): number {
  if (candidate.latencyMs !== undefined) {
    if (!Number.isFinite(candidate.latencyMs) || candidate.latencyMs < 0) {
      throw new RangeError(`compareOcrCandidates: latencyMs must be a finite non-negative number, got ${String(candidate.latencyMs)}.`);
    }
    return candidate.latencyMs;
  }
  return status === 'failed' ? 0 : DEFAULT_ENGINE_LATENCY_MS[candidate.engine];
}

interface NormalizedCandidate {
  readonly engine: OcrConsensusEngine;
  readonly status: OcrCandidateStatus;
  readonly rawText: string;
  readonly normalizedText: string;
  readonly confidence: number;
  readonly detectedScript: ScriptName;
  readonly numericTokens: readonly string[];
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly error?: string;
}

function normalizeCandidate(candidate: OcrEngineCandidate): NormalizedCandidate {
  const hasError = candidate.error !== undefined && candidate.error.trim().length > 0;
  const isFailed = candidate.status === 'failed' || hasError;
  const normalizedText = normalizeOcrText(candidate.text);
  const status: OcrCandidateStatus = isFailed ? 'failed' : normalizedText ? 'ok' : 'empty';
  return {
    engine: candidate.engine,
    status,
    rawText: candidate.text,
    normalizedText,
    confidence: status === 'failed' ? 0 : normalizeConfidence(candidate.confidence),
    detectedScript: status === 'ok' && HAS_LETTER.test(normalizedText) ? detectScript(normalizedText) : 'unknown',
    numericTokens: status === 'ok' ? extractNumericTokens(normalizedText) : [],
    costUsd: resolveCostUsd(candidate, status),
    latencyMs: resolveLatencyMs(candidate, status),
    ...(hasError ? { error: candidate.error } : {}),
  };
}

function numericTokensEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function candidatesAgree(
  a: NormalizedCandidate,
  b: NormalizedCandidate,
  threshold: number,
): boolean {
  if (a.normalizedText === b.normalizedText) return true;
  if (!numericTokensEqual(a.numericTokens, b.numericTokens)) return false;
  return textAgreementSimilarity(a.normalizedText, b.normalizedText) >= threshold;
}

function detectNumericDisagreement(valid: readonly NormalizedCandidate[]): NumericDisagreement {
  if (valid.length < 2) return EMPTY_NUMERIC_DISAGREEMENT;

  const tokensByEngine: Partial<Record<OcrConsensusEngine, readonly string[]>> = {};
  for (const candidate of valid) {
    tokensByEngine[candidate.engine] = candidate.numericTokens;
  }

  const first = valid[0];
  if (!first) return EMPTY_NUMERIC_DISAGREEMENT;
  const allEqual = valid.every(candidate => numericTokensEqual(candidate.numericTokens, first.numericTokens));
  if (allEqual) {
    return {
      hasDisagreement: false,
      conflictingTokens: [],
      tokensByEngine,
    };
  }

  const maxLen = Math.max(...valid.map(candidate => candidate.numericTokens.length));
  const conflicts: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < maxLen; index++) {
    const firstToken = first.numericTokens[index];
    const unanimous = firstToken !== undefined && valid.every(candidate => candidate.numericTokens[index] === firstToken);
    if (unanimous) continue;
    for (const candidate of valid) {
      const token = candidate.numericTokens[index];
      if (token !== undefined && !seen.has(token)) {
        seen.add(token);
        conflicts.push(token);
      }
    }
  }

  return {
    hasDisagreement: true,
    conflictingTokens: conflicts,
    tokensByEngine,
  };
}

function inferConsensusScript(valid: readonly NormalizedCandidate[]): ScriptName | undefined {
  const counts = new Map<ScriptName, number>();
  for (const candidate of valid) {
    if (candidate.detectedScript === 'unknown') continue;
    counts.set(candidate.detectedScript, (counts.get(candidate.detectedScript) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  let winner: ScriptName | undefined;
  let bestCount = 0;
  for (const [script, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      winner = script;
    }
  }
  return winner;
}

function compareRank(
  a: ScoredOcrCandidate,
  b: ScoredOcrCandidate,
  inputOrder: Map<ScoredOcrCandidate, number>,
): number {
  const statusRank = (status: OcrCandidateStatus): number => (status === 'ok' ? 0 : status === 'empty' ? 1 : 2);
  const statusDiff = statusRank(a.status) - statusRank(b.status);
  if (statusDiff !== 0) return statusDiff;

  if (Math.abs(b.totalScore - a.totalScore) > SCORE_EPSILON) {
    return b.totalScore - a.totalScore;
  }
  if (Math.abs(b.consensusScore - a.consensusScore) > SCORE_EPSILON) {
    return b.consensusScore - a.consensusScore;
  }
  if (Math.abs(b.scriptMatchScore - a.scriptMatchScore) > SCORE_EPSILON) {
    return b.scriptMatchScore - a.scriptMatchScore;
  }
  if (Math.abs(b.confidence - a.confidence) > SCORE_EPSILON) {
    return b.confidence - a.confidence;
  }
  if (Math.abs(a.costUsd - b.costUsd) > SCORE_EPSILON) {
    return a.costUsd - b.costUsd;
  }
  const orderDiff = CONSENSUS_ENGINE_ORDER.indexOf(a.engine) - CONSENSUS_ENGINE_ORDER.indexOf(b.engine);
  if (orderDiff !== 0) return orderDiff;

  if (a.normalizedText !== b.normalizedText) {
    return a.normalizedText < b.normalizedText ? -1 : 1;
  }
  return (inputOrder.get(a) ?? 0) - (inputOrder.get(b) ?? 0);
}

// --- Public comparison & consensus functions -------------------------------

/**
 * Compares OCR candidates from multiple engines and ranks them using weighted
 * consensus, normalized confidence, and script fit.
 */
export function compareOcrCandidates(
  candidates: readonly OcrEngineCandidate[],
  options: OcrComparisonOptions = {},
): OcrComparisonReport {
  const weights = resolveWeights(options.weights);
  const threshold = resolveThreshold(options.agreementThreshold);
  const normalized = candidates.map(normalizeCandidate);

  const valid = normalized.filter(candidate => candidate.status === 'ok');
  const emptyCandidateCount = normalized.filter(candidate => candidate.status === 'empty').length;
  const failedCandidateCount = normalized.filter(candidate => candidate.status === 'failed').length;
  const totalCandidateCount = normalized.length;
  const nonFailedCount = totalCandidateCount - failedCandidateCount;

  const totalCostUsd = roundUsd(normalized.reduce((sum, candidate) => sum + candidate.costUsd, 0));
  const consensusScript =
    options.expectedScript || expectedScriptsForLanguage(options.expectedLanguage)
      ? undefined
      : inferConsensusScript(valid);
  const numericDisagreement = detectNumericDisagreement(valid);

  const scored: ScoredOcrCandidate[] = [];
  const inputOrder = new Map<ScoredOcrCandidate, number>();

  for (let i = 0; i < normalized.length; i++) {
    const candidate = normalized[i];
    if (!candidate) continue;
    if (candidate.status !== 'ok') {
      const entry: ScoredOcrCandidate = {
        ...candidate,
        consensusScore: 0,
        scriptMatchScore: 0,
        totalScore: 0,
        peerAgreementCount: 0,
      };
      scored.push(entry);
      inputOrder.set(entry, i);
      continue;
    }

    let exactMatches = 0;
    let nearMatches = 0;
    let peerSimSum = 0;

    for (const peer of valid) {
      if (peer.normalizedText === candidate.normalizedText) {
        exactMatches += 1;
      }
      if (candidatesAgree(candidate, peer, threshold)) {
        nearMatches += 1;
      }
      if (peer !== candidate) {
        peerSimSum += textAgreementSimilarity(candidate.normalizedText, peer.normalizedText);
      }
    }

    const validCount = valid.length;
    const exactShare = exactMatches / validCount;
    const nearShare = nearMatches / validCount;
    const meanPeerSim = validCount > 1 ? peerSimSum / (validCount - 1) : 1;

    // Combine exact cluster share, near-agreement share, and mean peer similarity
    // so a 2-of-3 majority still beats a single overconfident near-typo outlier.
    const consensusScore = 0.4 * exactShare + 0.3 * nearShare + 0.3 * meanPeerSim;
    const scriptMatchScore = computeScriptMatchScore(candidate.normalizedText, {
      expectedLanguage: options.expectedLanguage,
      expectedScript: options.expectedScript,
      consensusScript,
    });
    const totalScore =
      weights.consensus * consensusScore +
      weights.confidence * candidate.confidence +
      weights.scriptMatch * scriptMatchScore;

    const entry: ScoredOcrCandidate = {
      ...candidate,
      consensusScore,
      scriptMatchScore,
      totalScore,
      peerAgreementCount: nearMatches,
    };
    scored.push(entry);
    inputOrder.set(entry, i);
  }

  const ranked = [...scored].sort((a, b) => compareRank(a, b, inputOrder));
  const top = ranked[0];
  const winner = top && top.status === 'ok' ? top : null;

  let agreeingEngines: OcrConsensusEngine[] = [];
  if (winner) {
    agreeingEngines = ranked
      .filter(
        entry =>
          entry.status === 'ok' &&
          candidatesAgree(entry, winner, threshold),
      )
      .map(entry => entry.engine);
  }

  const agreementRatio = winner && totalCandidateCount > 0 ? agreeingEngines.length / totalCandidateCount : 0;
  const nonFailedAgreementRatio = winner && nonFailedCount > 0 ? agreeingEngines.length / nonFailedCount : 0;

  return {
    ranked,
    winner,
    agreementRatio,
    nonFailedAgreementRatio,
    agreeingEngines,
    totalCostUsd,
    winnerCostUsd: winner ? roundUsd(winner.costUsd) : 0,
    hasNumericDisagreement: numericDisagreement.hasDisagreement,
    numericDisagreement,
    validCandidateCount: valid.length,
    emptyCandidateCount,
    failedCandidateCount,
    totalCandidateCount,
  };
}

/**
 * Selects the winning OCR output for a single document region and records its
 * agreement ratio, cost breakdown, and numeric conflict flags.
 */
export function selectRegionConsensus(
  region: OcrRegionInput,
  options: OcrComparisonOptions = {},
): RegionConsensusResult {
  const report = compareOcrCandidates(region.candidates, {
    ...options,
    expectedLanguage: options.expectedLanguage ?? region.expectedLanguage,
    expectedScript: options.expectedScript ?? region.expectedScript,
  });

  const costByEngine: Partial<Record<OcrConsensusEngine, number>> = {};
  for (const candidate of report.ranked) {
    costByEngine[candidate.engine] = roundUsd((costByEngine[candidate.engine] ?? 0) + candidate.costUsd);
  }

  const outcome: RegionConsensusResult['outcome'] = report.winner
    ? 'selected'
    : report.totalCandidateCount === 0 || report.emptyCandidateCount > 0
      ? 'empty'
      : 'failed';

  return {
    regionId: region.regionId,
    ...(region.page !== undefined ? { page: region.page } : {}),
    ...(region.rect !== undefined ? { rect: region.rect } : {}),
    outcome,
    winningEngine: report.winner ? report.winner.engine : null,
    selectedText: report.winner ? report.winner.normalizedText : '',
    winnerConfidence: report.winner ? report.winner.confidence : 0,
    winnerScore: report.winner ? report.winner.totalScore : 0,
    agreementRatio: report.agreementRatio,
    nonFailedAgreementRatio: report.nonFailedAgreementRatio,
    agreeingEngines: report.agreeingEngines,
    totalCostUsd: report.totalCostUsd,
    winnerCostUsd: report.winnerCostUsd,
    costByEngine,
    hasNumericDisagreement: report.hasNumericDisagreement,
    numericDisagreement: report.numericDisagreement,
    candidates: report.ranked,
  };
}

/**
 * Summarizes consensus outcomes across a batch of regions: per-engine win
 * counts, total spend, mean agreement ratio, and regions requiring review.
 */
export function summarizeBatchConsensus(
  regions: readonly RegionConsensusResult[],
  options: BatchConsensusOptions = {},
): BatchConsensusSummary {
  const minAgreementRatio = options.minAgreementRatio ?? 1;
  if (!Number.isFinite(minAgreementRatio) || minAgreementRatio < 0 || minAgreementRatio > 1) {
    throw new RangeError(
      `summarizeBatchConsensus: minAgreementRatio must be in [0, 1], got ${String(minAgreementRatio)}.`,
    );
  }

  const winnerCounts = emptyEngineRecord();
  const costByEngine = emptyEngineRecord();
  const disagreementRegions: string[] = [];
  const numericConflictRegions: string[] = [];

  let resolvedCount = 0;
  let emptyCount = 0;
  let failedCount = 0;
  let totalCostUsd = 0;
  let agreementSum = 0;

  for (const region of regions) {
    if (region.outcome === 'selected') resolvedCount += 1;
    else if (region.outcome === 'empty') emptyCount += 1;
    else failedCount += 1;

    if (region.winningEngine) {
      winnerCounts[region.winningEngine] += 1;
    }

    totalCostUsd += region.totalCostUsd;
    agreementSum += region.agreementRatio;

    for (const engine of CONSENSUS_ENGINE_ORDER) {
      const engineCost = region.costByEngine[engine];
      if (engineCost !== undefined) {
        costByEngine[engine] = roundUsd(costByEngine[engine] + engineCost);
      }
    }

    if (region.hasNumericDisagreement) {
      numericConflictRegions.push(region.regionId);
    }

    if (
      region.outcome !== 'selected' ||
      region.hasNumericDisagreement ||
      region.agreementRatio + SCORE_EPSILON < minAgreementRatio
    ) {
      disagreementRegions.push(region.regionId);
    }
  }

  return {
    regionCount: regions.length,
    resolvedCount,
    emptyCount,
    failedCount,
    winnerCounts,
    totalCostUsd: roundUsd(totalCostUsd),
    costByEngine,
    meanAgreementRatio: regions.length > 0 ? agreementSum / regions.length : 0,
    disagreementRegions,
    numericConflictRegions,
  };
}
