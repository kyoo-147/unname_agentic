/**
 * Glossary learning from finished translations (backlog item G05).
 *
 * `proposeTerms` reads pairs of a source segment and the translation it actually
 * received, and proposes glossary terms together with the evidence that produced
 * them. Nothing here writes a glossary: a proposal is a suggestion for the user,
 * and `mergeWithGlossary` only ever adds what the caller asks for, never editing
 * an entry that is already there.
 *
 * Candidate terms are taken from the source side only:
 *
 * - an acronym is a token of at least two characters with no lowercase letter
 *   and at least two uppercase letters (`GPU`, `MEMS`, `RAG2`);
 * - a capitalised word is a token that mixes upper and lower case
 *   (`Kubernetes`, `MirrorPDF`, `iPhone`), and only when it does not start a
 *   sentence, because a sentence capitalises its first word whatever it means.
 *   A short list of English function words is skipped as well.
 *
 * Capitalisation is a language-independent heuristic. It suits Latin-script
 * sources; languages that capitalise common nouns (German) yield more proposals,
 * and scripts without case (Chinese, Japanese) yield none. Both are reasons a
 * proposal stays a suggestion.
 *
 * Alignment. The target counterpart of a candidate is found in this order:
 *
 * 1. A context anchor always wins. When the same token occurs exactly once on
 *    each side (case-insensitively) and is informative — not a stop word, at
 *    least three characters or containing a digit — the translator left that
 *    word unchanged, so the two indices pair exactly. This is the strongest
 *    evidence available, and it is also how a term in the middle of a long
 *    paragraph is located: the anchors around it are the context words.
 * 2. A short pair is aligned by position. The pair is short when both sides have
 *    the same token count, or when their counts differ by no more than the
 *    `POSITION_RATIO` factor of 1.5. Each source index maps proportionally onto
 *    the target side, `floor(i * targetCount / sourceCount)`, which is the
 *    identity when the counts are equal.
 * 3. A long pair is aligned inside its anchors. The nearest anchor before and
 *    after the candidate delimit one segment on each side, and the candidate
 *    sits proportionally inside the aligned target segment. A long pair with no
 *    anchor at all falls back to whole-pair proportional mapping, which is weak
 *    evidence and is scored as such.
 *
 * Every aligned occurrence carries a quality between 0 and 1: exact anchor 1,
 * both anchors around the candidate 0.85, equal token counts 0.9, positional
 * scaling 0.75, one anchor 0.7, an anchorless long pair 0.4. The confidence of a
 * proposal then combines three signals:
 *
 *     confidence = 0.6 * meanQuality + 0.25 * agreement + 0.15 * frequency
 *
 * `agreement` is the share of aligned occurrences that chose the winning target
 * spelling, so a term the translator rendered three different ways is scored
 * down. `frequency` is `min(1, occurrences / 3)`, so a term seen twice earns two
 * thirds of it. The defaults keep a proposal only when it occurred at least
 * twice and reached a confidence of 0.6.
 *
 * Evidence is verbatim: every excerpt is a substring of the pair it came from,
 * cut on word boundaries around the term, so a reviewer can find the sentence a
 * term was learned from.
 */

import {
  GLOSSARY_MAX_ENTRIES,
  GLOSSARY_MAX_SOURCE_CHARS,
  GLOSSARY_MAX_TARGET_CHARS,
  type GlossaryEntry,
} from './glossary';

/** One source segment and the translation it actually received. */
export interface TermPair {
  source: string;
  target: string;
  sourceLang: string;
  targetLang: string;
}

/** The excerpts of one aligned occurrence; both are substrings of their pair. */
export interface TermEvidence {
  sourceExcerpt: string;
  targetExcerpt: string;
}

/** A term to offer the user, never applied without an explicit acceptance. */
export interface TermProposal {
  source: string;
  target: string;
  /** Aligned occurrences the proposal was built from, at least one. */
  occurrences: number;
  /** Between 0 and 1; see the module comment for the weights. */
  confidence: number;
  evidence: TermEvidence[];
}

export type TermRejectionCode =
  | 'below-occurrence-floor'
  | 'below-confidence'
  | 'no-target-alignment'
  | 'not-serialisable'
  | 'term-limit';

/** A candidate that was not proposed, with the reason it was dropped. */
export interface RejectedTerm {
  source: string;
  occurrences: number;
  confidence: number;
  code: TermRejectionCode;
  message: string;
}

export interface ProposeTermsOptions {
  /** Aligned occurrences a term needs, at least 1. Defaults to 2. */
  minOccurrences?: number;
  /** Confidence a term needs, between 0 and 1. Defaults to 0.6. */
  minConfidence?: number;
  /** Excerpts kept per proposal, at least 1. Defaults to 3. */
  maxEvidence?: number;
  /** Proposals kept, at least 1. Defaults to the glossary entry limit. */
  maxProposals?: number;
}

export interface ProposeTermsResult {
  /** Strongest first: confidence, then occurrences, then source spelling. */
  proposals: TermProposal[];
  rejected: RejectedTerm[];
}

export type GlossaryMergeRefusalCode = 'conflicting-target' | 'duplicate' | 'not-serialisable' | 'entry-limit';

/** A proposal the merge did not add, and the entry that blocked it when there is one. */
export interface GlossaryMergeRefusal {
  source: string;
  target: string;
  code: GlossaryMergeRefusalCode;
  /** The entry already in the glossary that refused the proposal. */
  existing?: GlossaryEntry;
  message: string;
}

export interface GlossaryMergeResult {
  /** The existing entries unchanged, followed by the accepted proposals. */
  entries: GlossaryEntry[];
  added: GlossaryEntry[];
  refused: GlossaryMergeRefusal[];
}

export type GlossaryLearnErrorCode = 'invalid-option' | 'invalid-pair';

/** A refused option or pair, located by a path such as `pairs[3].source`. */
export class GlossaryLearnError extends Error {
  readonly code: GlossaryLearnErrorCode;
  readonly path: string;

  constructor(code: GlossaryLearnErrorCode, message: string, path = '') {
    super(path ? `${path}: ${message}` : message);
    this.name = 'GlossaryLearnError';
    this.code = code;
    this.path = path;
  }
}

/** Aligned occurrences a term needs when `minOccurrences` is not given. */
export const DEFAULT_MIN_OCCURRENCES = 2;

/** Confidence a term needs when `minConfidence` is not given. */
export const DEFAULT_MIN_CONFIDENCE = 0.6;

/** Excerpts kept per proposal when `maxEvidence` is not given. */
export const DEFAULT_MAX_EVIDENCE = 3;

/** Proposals kept when `maxProposals` is not given. */
export const DEFAULT_MAX_PROPOSALS = GLOSSARY_MAX_ENTRIES;

/** Token-count ratio up to which a pair is still aligned by position. */
export const POSITION_RATIO = 1.5;

/** Characters of context kept on each side of an excerpted term. */
export const EVIDENCE_WINDOW_CHARS = 60;

const QUALITY_ANCHOR = 1;
const QUALITY_EQUAL_COUNT = 0.9;
const QUALITY_TWO_ANCHORS = 0.85;
const QUALITY_POSITIONAL = 0.75;
const QUALITY_ONE_ANCHOR = 0.7;
const QUALITY_FALLBACK = 0.4;

const WEIGHT_ALIGNMENT = 0.6;
const WEIGHT_AGREEMENT = 0.25;
const WEIGHT_FREQUENCY = 0.15;

/** Occurrences that earn the whole frequency weight. */
const FREQUENCY_FULL = 3;

/**
 * English function words that a sentence or a capitalised heading would
 * otherwise promote to a term. The list is only ever applied to the source
 * side, plus the guard that keeps a function word out of a counterpart.
 */
const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'all', 'also', 'an', 'and', 'another', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'between', 'both', 'but', 'by',
  'can', 'could',
  'did', 'do', 'does', 'during',
  'each', 'either', 'every',
  'for', 'from',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'his', 'how', 'however',
  'if', 'in', 'into', 'is', 'it', 'its',
  'just',
  'may', 'might', 'more', 'most', 'much', 'must', 'my',
  'no', 'nor', 'not', 'now',
  'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'out', 'over', 'own',
  'same', 'shall', 'she', 'should', 'so', 'some', 'such',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'thus', 'to', 'too',
  'under', 'until', 'up', 'upon', 'us', 'use', 'used', 'using',
  'very',
  'was', 'we', 'were', 'what', 'when', 'where', 'whether', 'which', 'while', 'who', 'whom', 'whose', 'why', 'will', 'with', 'within', 'without', 'would',
  'you', 'your',
]);

interface Token {
  text: string;
  start: number;
  end: number;
}

interface AlignedTarget {
  targetIndex: number;
  quality: number;
}

interface Anchor {
  sourceIndex: number;
  targetIndex: number;
}

interface CandidateOccurrence {
  target: string;
  quality: number;
  evidence: TermEvidence;
}

interface Candidate {
  /** Every spelling seen, in order, so the most frequent one can be reported. */
  spellings: string[];
  mentions: number;
  occurrences: CandidateOccurrence[];
}

interface Settings {
  minOccurrences: number;
  minConfidence: number;
  maxEvidence: number;
  maxProposals: number;
}

interface CountedSpelling {
  value: string;
  count: number;
  firstIndex: number;
}

const round = (value: number): number => Math.round(value * 10000) / 10000;

/** Collapses whitespace and trims, the normal form a glossary line is written in. */
function cleanTerm(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** Runs of letters and digits; punctuation only separates words. */
function tokenize(text: string): Token[] {
  const pattern = /[\p{L}\p{N}]+/gu;
  const tokens: Token[] = [];
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const value = match[0] ?? '';
    if (!value) continue;
    tokens.push({ text: value, start: match.index, end: match.index + value.length });
  }
  return tokens;
}

function isAcronym(text: string): boolean {
  if (text.length < 2) return false;
  if (text.toUpperCase() !== text) return false;
  if (text.toLowerCase() === text) return false;
  let uppercase = 0;
  for (const char of text) if (/\p{Lu}/u.test(char)) uppercase += 1;
  return uppercase >= 2;
}

function isSentenceInitial(text: string, tokens: readonly Token[], index: number): boolean {
  if (index === 0) return true;
  const previous = tokens[index - 1]!;
  const gap = text.slice(previous.end, tokens[index]!.start);
  return /[.!?]/u.test(gap);
}

/** An acronym anywhere, or a capitalised word that a sentence did not capitalise. */
function isTermCandidate(text: string, sentenceInitial: boolean): boolean {
  if (text.length < 2) return false;
  if (isAcronym(text)) return true;
  if (sentenceInitial) return false;
  if (!/\p{Lu}/u.test(text) || !/\p{Ll}/u.test(text)) return false;
  return !STOP_WORDS.has(text.toLowerCase());
}

/**
 * A counterpart must be a content word, so an aligned function word is dropped.
 * A single Latin letter is a function word; a single character of a script
 * without case (a Chinese or Japanese word) is not.
 */
function isUsableTarget(text: string): boolean {
  if (!text) return false;
  if (text.length === 1 && /\p{Script=Latin}/u.test(text)) return false;
  return !STOP_WORDS.has(text.toLowerCase());
}

function isInformativeAnchor(text: string): boolean {
  const key = text.toLowerCase();
  if (STOP_WORDS.has(key)) return false;
  return text.length >= 3 || /\d/u.test(text);
}

/** A verbatim window around `[start, end)` that starts and ends on word boundaries. */
function excerptAround(text: string, start: number, end: number): string {
  let from = Math.max(0, start - EVIDENCE_WINDOW_CHARS);
  let to = Math.min(text.length, end + EVIDENCE_WINDOW_CHARS);
  while (from > 0 && !/\s/u.test(text[from - 1]!)) from -= 1;
  while (to < text.length && !/\s/u.test(text[to]!)) to += 1;
  return text.slice(from, to).trim();
}

function rankSpellings(values: readonly string[]): CountedSpelling[] {
  const seen = new Map<string, CountedSpelling>();
  values.forEach((value, position) => {
    const found = seen.get(value);
    if (found) found.count += 1;
    else seen.set(value, { value, count: 1, firstIndex: position });
  });
  return [...seen.values()].sort((left, right) => right.count - left.count || left.firstIndex - right.firstIndex);
}

/**
 * Tokens the translator left untouched: unique on both sides, informative, and
 * kept in source order so the anchor sequence stays monotone.
 */
function findAnchors(sourceTokens: readonly Token[], targetTokens: readonly Token[]): Anchor[] {
  const targetIndexByText = new Map<string, number>();
  targetTokens.forEach((token, index) => {
    const key = token.text.toLowerCase();
    targetIndexByText.set(key, targetIndexByText.has(key) ? -1 : index);
  });
  const sourceCounts = new Map<string, number>();
  for (const token of sourceTokens) {
    const key = token.text.toLowerCase();
    sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
  }

  const anchors: Anchor[] = [];
  let lastTarget = -1;
  sourceTokens.forEach((token, sourceIndex) => {
    const key = token.text.toLowerCase();
    if (sourceCounts.get(key) !== 1) return;
    const targetIndex = targetIndexByText.get(key);
    if (targetIndex === undefined || targetIndex < 0) return;
    if (!isInformativeAnchor(token.text)) return;
    if (targetIndex <= lastTarget) return;
    anchors.push({ sourceIndex, targetIndex });
    lastTarget = targetIndex;
  });
  return anchors;
}

/**
 * Builds the source-index to target-index mapping for one pair: anchors first,
 * then position for a short pair, then the segment between two anchors for a
 * long one. Returns null when a token has no placeable counterpart.
 */
function alignmentFor(
  sourceTokens: readonly Token[],
  targetTokens: readonly Token[],
): (sourceIndex: number) => AlignedTarget | null {
  const sourceCount = sourceTokens.length;
  const targetCount = targetTokens.length;
  if (sourceCount === 0 || targetCount === 0) return () => null;

  const anchors = findAnchors(sourceTokens, targetTokens);
  const anchorTargets = new Map<number, number>();
  for (const anchor of anchors) anchorTargets.set(anchor.sourceIndex, anchor.targetIndex);

  const shorter = Math.min(sourceCount, targetCount);
  const longer = Math.max(sourceCount, targetCount);
  const positional = sourceCount === targetCount || longer / shorter <= POSITION_RATIO;
  const positionalQuality = sourceCount === targetCount ? QUALITY_EQUAL_COUNT : QUALITY_POSITIONAL;

  const byPosition = (sourceIndex: number): AlignedTarget => ({
    targetIndex: Math.min(targetCount - 1, Math.floor((sourceIndex * targetCount) / sourceCount)),
    quality: positional ? positionalQuality : QUALITY_FALLBACK,
  });

  return (sourceIndex: number): AlignedTarget | null => {
    const anchored = anchorTargets.get(sourceIndex);
    if (anchored !== undefined) return { targetIndex: anchored, quality: QUALITY_ANCHOR };
    if (positional) return byPosition(sourceIndex);

    let previous: Anchor | null = null;
    let next: Anchor | null = null;
    for (const anchor of anchors) {
      if (anchor.sourceIndex < sourceIndex) previous = anchor;
      else if (next === null) next = anchor;
    }
    if (previous === null && next === null) return byPosition(sourceIndex);

    const sourceFrom = previous === null ? 0 : previous.sourceIndex + 1;
    const sourceTo = next === null ? sourceCount : next.sourceIndex;
    const targetFrom = previous === null ? 0 : previous.targetIndex + 1;
    const targetTo = next === null ? targetCount : next.targetIndex;
    const sourceSpan = sourceTo - sourceFrom;
    const targetSpan = targetTo - targetFrom;
    if (sourceSpan <= 0 || targetSpan <= 0) return null;

    const local = sourceIndex - sourceFrom;
    const targetIndex = targetFrom + Math.min(targetSpan - 1, Math.floor((local * targetSpan) / sourceSpan));
    return { targetIndex, quality: previous !== null && next !== null ? QUALITY_TWO_ANCHORS : QUALITY_ONE_ANCHOR };
  };
}

function collectFromPair(pair: TermPair, candidates: Map<string, Candidate>): void {
  const sourceTokens = tokenize(pair.source);
  if (sourceTokens.length === 0) return;
  const targetTokens = tokenize(pair.target);
  if (targetTokens.length === 0) return;
  const align = alignmentFor(sourceTokens, targetTokens);

  sourceTokens.forEach((token, index) => {
    if (!isTermCandidate(token.text, isSentenceInitial(pair.source, sourceTokens, index))) return;
    const key = token.text.toLowerCase();
    let candidate = candidates.get(key);
    if (!candidate) {
      candidate = { spellings: [], mentions: 0, occurrences: [] };
      candidates.set(key, candidate);
    }
    candidate.spellings.push(token.text);
    candidate.mentions += 1;

    const aligned = align(index);
    if (aligned === null) return;
    const counterpart = targetTokens[aligned.targetIndex]!;
    if (!isUsableTarget(counterpart.text)) return;
    candidate.occurrences.push({
      target: counterpart.text,
      quality: aligned.quality,
      evidence: {
        sourceExcerpt: excerptAround(pair.source, token.start, token.end),
        targetExcerpt: excerptAround(pair.target, counterpart.start, counterpart.end),
      },
    });
  });
}

function readPair(value: unknown, index: number): TermPair {
  const path = `pairs[${index}]`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GlossaryLearnError('invalid-pair', 'a pair must be an object.', path);
  }
  const record = value as Record<string, unknown>;
  const text = (field: unknown, fieldPath: string): string => {
    if (typeof field !== 'string') {
      throw new GlossaryLearnError('invalid-pair', `${fieldPath.slice(path.length + 1)} must be a string.`, fieldPath);
    }
    return field;
  };
  const language = (field: unknown, fieldPath: string): string => {
    if (field === undefined || field === null) return '';
    return text(field, fieldPath).trim().toLowerCase();
  };
  return {
    source: text(record.source, `${path}.source`),
    target: text(record.target, `${path}.target`),
    sourceLang: language(record.sourceLang, `${path}.sourceLang`),
    targetLang: language(record.targetLang, `${path}.targetLang`),
  };
}

function readNumberOption(
  value: unknown,
  fallback: number,
  path: string,
  accept: (candidate: number) => boolean,
  expectation: string,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || !accept(value)) {
    throw new GlossaryLearnError('invalid-option', `${path} must be ${expectation}.`, path);
  }
  return value;
}

function readSettings(options: ProposeTermsOptions): Settings {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new GlossaryLearnError('invalid-option', 'options must be an object.', 'options');
  }
  const positiveInteger = (candidate: number): boolean => Number.isInteger(candidate) && candidate >= 1;
  return {
    minOccurrences: readNumberOption(
      options.minOccurrences,
      DEFAULT_MIN_OCCURRENCES,
      'options.minOccurrences',
      positiveInteger,
      'an integer of at least 1',
    ),
    minConfidence: readNumberOption(
      options.minConfidence,
      DEFAULT_MIN_CONFIDENCE,
      'options.minConfidence',
      candidate => candidate >= 0 && candidate <= 1,
      'a number between 0 and 1',
    ),
    maxEvidence: readNumberOption(
      options.maxEvidence,
      DEFAULT_MAX_EVIDENCE,
      'options.maxEvidence',
      positiveInteger,
      'an integer of at least 1',
    ),
    maxProposals: readNumberOption(
      options.maxProposals,
      DEFAULT_MAX_PROPOSALS,
      'options.maxProposals',
      positiveInteger,
      'an integer of at least 1',
    ),
  };
}

function buildProposals(candidates: Map<string, Candidate>, settings: Settings): ProposeTermsResult {
  const proposals: TermProposal[] = [];
  const rejected: RejectedTerm[] = [];

  for (const candidate of candidates.values()) {
    const source = rankSpellings(candidate.spellings)[0]!.value;
    const occurrences = candidate.occurrences.length;
    if (occurrences === 0) {
      rejected.push({
        source,
        occurrences: 0,
        confidence: 0,
        code: 'no-target-alignment',
        message: `"${source}" was mentioned ${candidate.mentions} time(s) but no target counterpart could be aligned.`,
      });
      continue;
    }

    const best = rankSpellings(candidate.occurrences.map(occurrence => occurrence.target))[0]!;
    const agreement = best.count / occurrences;
    const meanQuality =
      candidate.occurrences.reduce((total, occurrence) => total + occurrence.quality, 0) / occurrences;
    const frequency = Math.min(1, occurrences / FREQUENCY_FULL);
    const confidence = round(
      WEIGHT_ALIGNMENT * meanQuality + WEIGHT_AGREEMENT * agreement + WEIGHT_FREQUENCY * frequency,
    );

    if (occurrences < settings.minOccurrences) {
      rejected.push({
        source,
        occurrences,
        confidence,
        code: 'below-occurrence-floor',
        message: `"${source}" occurred ${occurrences} time(s); at least ${settings.minOccurrences} are needed.`,
      });
      continue;
    }
    if (confidence < settings.minConfidence) {
      rejected.push({
        source,
        occurrences,
        confidence,
        code: 'below-confidence',
        message: `"${source}" reached a confidence of ${confidence}; at least ${settings.minConfidence} is needed.`,
      });
      continue;
    }
    if (!isSerialisable(source, best.value)) {
      rejected.push({
        source,
        occurrences,
        confidence,
        code: 'not-serialisable',
        message: `"${source}" cannot be written in the glossary format.`,
      });
      continue;
    }

    proposals.push({
      source,
      target: best.value,
      occurrences,
      confidence,
      evidence: candidate.occurrences.slice(0, settings.maxEvidence).map(occurrence => occurrence.evidence),
    });
  }

  proposals.sort(
    (left, right) =>
      right.confidence - left.confidence ||
      right.occurrences - left.occurrences ||
      (left.source < right.source ? -1 : left.source > right.source ? 1 : 0),
  );

  for (const proposal of proposals.slice(settings.maxProposals)) {
    rejected.push({
      source: proposal.source,
      occurrences: proposal.occurrences,
      confidence: proposal.confidence,
      code: 'term-limit',
      message: `Only the ${settings.maxProposals} strongest proposals are kept.`,
    });
  }

  rejected.sort((left, right) => (left.source < right.source ? -1 : left.source > right.source ? 1 : 0));
  return { proposals: proposals.slice(0, settings.maxProposals), rejected };
}

/**
 * Proposes glossary terms from translation pairs. Terms seen fewer than
 * `minOccurrences` times, or whose evidence scores below `minConfidence`, are
 * reported under `rejected` rather than proposed. Nothing is applied: the caller
 * decides what to accept.
 */
export function proposeTerms(
  pairs: readonly TermPair[],
  options: ProposeTermsOptions = {},
): ProposeTermsResult {
  const settings = readSettings(options ?? {});
  if (!Array.isArray(pairs)) {
    throw new GlossaryLearnError('invalid-pair', 'proposeTerms needs an array of pairs.', 'pairs');
  }
  const candidates = new Map<string, Candidate>();
  pairs.forEach((value, index) => collectFromPair(readPair(value, index), candidates));
  return buildProposals(candidates, settings);
}

/** A term `toGlossaryText` can write and `parseGlossary` will read back unchanged. */
function isSerialisable(source: string, target: string): boolean {
  if (!source || !target) return false;
  if (source.length > GLOSSARY_MAX_SOURCE_CHARS) return false;
  if (target.length > GLOSSARY_MAX_TARGET_CHARS) return false;
  const breaksFormat = (value: string): boolean => value.includes('=') || /[\r\n]/u.test(value);
  return !breaksFormat(source) && !breaksFormat(target);
}

/**
 * Merges proposals into a glossary. A proposal is taken as it comes because it
 * already carries a `source` and a `target`. An entry that is already there is
 * never changed: a proposal for the same source with a different target is
 * refused and reported as `conflicting-target`, and one that repeats the
 * existing target is refused as `duplicate`. Accepted proposals join the same
 * index, so a later proposal for the same source is checked against them too.
 */
export function mergeWithGlossary(
  glossary: readonly GlossaryEntry[],
  proposals: readonly GlossaryEntry[],
): GlossaryMergeResult {
  if (!Array.isArray(glossary)) {
    throw new GlossaryLearnError('invalid-pair', 'mergeWithGlossary needs an array of entries.', 'glossary');
  }
  if (!Array.isArray(proposals)) {
    throw new GlossaryLearnError('invalid-pair', 'mergeWithGlossary needs an array of proposals.', 'proposals');
  }

  const entries: GlossaryEntry[] = [];
  const bySource = new Map<string, GlossaryEntry>();
  for (const entry of glossary) {
    // Existing entries are copied verbatim, even when malformed; they simply do
    // not take part in the conflict index.
    entries.push({ source: entry.source, target: entry.target });
    const source = cleanTerm(entry.source);
    const key = source.toLowerCase();
    if (!source || bySource.has(key)) continue;
    bySource.set(key, { source, target: cleanTerm(entry.target) });
  }

  const added: GlossaryEntry[] = [];
  const refused: GlossaryMergeRefusal[] = [];

  for (const proposal of proposals) {
    const source = cleanTerm(proposal.source);
    const target = cleanTerm(proposal.target);
    if (!isSerialisable(source, target)) {
      refused.push({
        source,
        target,
        code: 'not-serialisable',
        message: `"${source}" cannot be written in the glossary format.`,
      });
      continue;
    }
    const existing = bySource.get(source.toLowerCase());
    if (existing) {
      const duplicate = cleanTerm(existing.target).toLowerCase() === target.toLowerCase();
      refused.push({
        source,
        target,
        code: duplicate ? 'duplicate' : 'conflicting-target',
        existing,
        message: duplicate
          ? `"${source}" is already defined as "${existing.target}".`
          : `"${source}" is already defined as "${existing.target}"; "${target}" was refused.`,
      });
      continue;
    }
    if (entries.length >= GLOSSARY_MAX_ENTRIES) {
      refused.push({
        source,
        target,
        code: 'entry-limit',
        message: `The glossary keeps at most ${GLOSSARY_MAX_ENTRIES} terms.`,
      });
      continue;
    }
    const entry: GlossaryEntry = { source, target };
    entries.push(entry);
    added.push(entry);
    bySource.set(source.toLowerCase(), entry);
  }

  return { entries, added, refused };
}

/**
 * Writes terms in the glossary file format: one `source = target` line each.
 * Duplicates, terms the format cannot carry and entries past the glossary limit
 * are skipped, so the output always round-trips through `parseGlossary`.
 */
export function toGlossaryText(items: readonly GlossaryEntry[]): string {
  if (!Array.isArray(items)) {
    throw new GlossaryLearnError('invalid-pair', 'toGlossaryText needs an array of terms.', 'items');
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (lines.length >= GLOSSARY_MAX_ENTRIES) break;
    const source = cleanTerm(item.source);
    const target = cleanTerm(item.target);
    if (!isSerialisable(source, target)) continue;
    const key = source.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${source} = ${target}`);
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
