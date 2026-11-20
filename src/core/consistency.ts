/**
 * Cross-block terminology consistency (backlog G08).
 *
 * A long translation fails review in one predictable way: the same term comes
 * back translated two different ways. {@link checkConsistency} reads the whole
 * document at once — every block whose source and target are known — and reports
 * each source term the document renders with more than one target spelling.
 *
 * What counts as a term, on either side:
 *
 * - A capitalised multiword phrase (`Neural Network`, `Học Máy`): two to six
 *   words whose first letters are capitals. A preposition may sit inside the
 *   phrase (`Theory of Computation`, `Ministry of the Interior`), while a
 *   conjunction breaks it, so `Research and Development` is two one-word groups
 *   and therefore no term. A leading English function word is trimmed, so a
 *   sentence that opens with `The Neural Network` reports `Neural Network`.
 * - An acronym of two to six uppercase letters, dots allowed (`API`, `A.P.I.`,
 *   `ISO9001`). Acronyms are compared by their letters, so `API` and `A.P.I.`
 *   are one source term with two target spellings; an all-caps ordinary English
 *   word (`THE`, `AND`, `WITH`) is not read as an acronym.
 * - A glossary term the caller supplies, matched as a whole word and compared
 *   against the target the glossary mandates.
 *
 * Severity is fixed, so a reviewer can triage without knowing the rules:
 *
 * | Finding                                                   | Severity |
 * | --------------------------------------------------------- | -------- |
 * | a glossary term is rendered without its mandated target    | error    |
 * | a term has two or more target spellings                    | warn     |
 * | a term appears in only one block                           | silence  |
 *
 * The last row is the deliberate floor: one observation is not a disagreement,
 * whatever the term is. A glossary term used once and mistranslated is a
 * per-pair defect that `reviewTranslation` in `qa.ts` already reports.
 *
 * How a target spelling is tied to a source term (evidence, in this order):
 *
 * 1. The glossary mandates it and the block literally carries it.
 * 2. The block repeats the source spelling verbatim, which is how an untranslated
 *    acronym or name is recognised.
 * 3. The block carries exactly one source term and one target candidate.
 * 4. The block carries the same number of source terms and target candidates;
 *    they are paired by first position, which is the order a translator follows.
 *
 * Anything else is ambiguous and contributes no variant evidence. That silence is
 * the point: a report a reviewer cannot trust is worse than a report that misses
 * a case, so the module refuses to guess between `Học Máy` and `Độ Chính Xác`
 * when both follow the term in one target sentence.
 *
 * The canonical spelling a reviewer is offered follows one order, documented on
 * {@link suggestCanonical}: the glossary target when there is one, then the
 * spelling used by the most blocks, then the longest spelling, then alphabetical.
 * The length tie-break assumes a longer term is the more explicit one (`Mạng Thần
 * Kinh` over `Mạng Nơ-Ron`), which is the usual translator preference.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no locale-sensitive
 *   comparison. The same pairs always produce the same report in the same order.
 * - Findings are plain JSON data. `applyCanonical` returns the pairs it changed
 *   and shares every untouched pair, so a caller can swap the list in place.
 * - Nothing is invented: a rewrite only replaces a spelling the document already
 *   used. A block that never named the term is left alone.
 *
 * Limitations that are deliberate:
 * - Extraction is shape-based, so it needs letter case. A target script without
 *   capitals (Han, Kana, Thai) yields no variant evidence unless the term comes
 *   from the glossary; supply a glossary for those languages.
 * - Case-only and whitespace-only differences are the same spelling, because a
 *   reviewer asking for `Machine Learning` does not mean `machine learning` is a
 *   defect. Internal punctuation is significant, so `A.P.I.` and `API` are two
 *   spellings.
 * - A single-word term is not extracted on its own (`Mạng` for `Network`); it is
 *   seen only when the glossary names it. Multiword terms are the ones a
 *   reviewer cannot police by eye.
 * - Numbers, units, negation and placeholders are per-pair checks in `qa.ts`;
 *   this module never duplicates them.
 */

import type { GlossaryEntry } from './glossary';
import type { GlossaryInput } from './qa';

// --- Public shape ----------------------------------------------------------

/** What kind of source term the finding is about. */
export type TermKind = 'glossary' | 'acronym' | 'phrase';

/** How a reviewer should treat a finding. */
export type ConsistencySeverity = 'error' | 'warn';

/** One source block and the translation produced for it. */
export interface TranslationPair {
  /** Reader block id, for example `p3-r0`. */
  blockId: string;
  /** 1-based page the block sits on. */
  page: number;
  /** Source text of the block. */
  source: string;
  /** Translated text of the block. */
  target: string;
}

/** One target spelling of a term and the blocks that use it. */
export interface TermVariant {
  /** Target spelling as observed, trimmed; empty when nothing could be read. */
  target: string;
  /** Blocks that use this spelling, in document order. */
  blockIds: string[];
  /** Number of blocks that use it, always `blockIds.length`. */
  count: number;
}

/** One source term the document does not render one way. */
export interface Inconsistency {
  /** Source spelling reported: the glossary spelling, else the first one read. */
  source: string;
  /** Kind of term the finding is about. */
  kind: TermKind;
  /**
   * Target spellings, ordered by {@link suggestCanonical}: the glossary target
   * first, then by use, then longest, then alphabetical. An unread spelling sorts
   * last so it is never offered as a default.
   */
  variants: TermVariant[];
  /** `error` for a glossary violation, `warn` for two spellings of one term. */
  severity: ConsistencySeverity;
  /** Target the glossary mandates, present only for a glossary term. */
  glossaryTarget?: string;
  /**
   * Blocks that carry the term with a target the glossary does not allow. Empty
   * for a term without a glossary entry.
   */
  violatingBlockIds: string[];
}

export interface ConsistencyReport {
  inconsistencies: Inconsistency[];
  /** True when no inconsistency has severity `error`. */
  ok: boolean;
}

export interface ConsistencyOptions {
  /** Terms the translation must honour; entries and `source -> target` records are accepted. */
  glossary?: GlossaryInput;
}

/** One accepted canonical spelling for one source term. */
export interface CanonicalDecision {
  /** Source term spelling, matched case-insensitively. */
  source: string;
  /** Target spelling accepted for it. */
  target: string;
}

/** One spelling replaced inside one block. */
export interface TermReplacement {
  /** Source term the decision names. */
  source: string;
  /** Spelling the block used before the rewrite. */
  from: string;
  /** Accepted canonical spelling written in its place. */
  to: string;
  /** Occurrences replaced in this block. */
  count: number;
}

/** One block whose target text changed. */
export interface BlockRewrite {
  blockId: string;
  page: number;
  /** Target text before the rewrite. */
  before: string;
  /** Target text after every accepted rewrite. */
  after: string;
  /** What changed, one row per accepted term, in decision order. */
  replacements: TermReplacement[];
}

export interface ApplyCanonicalResult {
  /** Every pair, in input order; changed pairs are copies, untouched pairs are shared. */
  translations: TranslationPair[];
  /** Only the blocks whose target text changed, in input order. */
  changed: BlockRewrite[];
}

// --- Constants -------------------------------------------------------------

/** Blocks a term must appear in before its renderings can disagree. */
export const CONSISTENCY_MIN_BLOCKS = 2;

/** Longest capitalised group, in words, that still counts as one term. */
const TERM_MAX_WORDS = 6;

/** Most lowercase connectors allowed inside one phrase. */
const MAX_CONNECTORS = 2;

/** Most letters an acronym may have and still be read as one. */
const ACRONYM_MAX_LETTERS = 6;

/**
 * Words that open a capitalised group without being part of it: the article or
 * preposition a sentence starts with. Trimmed only while two capitalised words
 * remain, so `The Neural Network` reports `Neural Network` and `This Paper`
 * reports nothing.
 */
const PHRASE_STARTS: ReadonlySet<string> = new Set([
  'a', 'about', 'after', 'again', 'against', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'between', 'both', 'but', 'by', 'can', 'could', 'did',
  'do', 'does', 'during', 'each', 'every', 'for', 'from', 'further', 'had', 'has', 'have', 'having',
  'he', 'her', 'here', 'his', 'how', 'however', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'may',
  'might', 'more', 'most', 'must', 'no', 'not', 'of', 'on', 'once', 'only', 'or', 'other', 'our',
  'over', 'own', 'same', 'shall', 'she', 'should', 'since', 'so', 'some', 'such', 'than', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'though', 'through',
  'thus', 'to', 'too', 'under', 'until', 'very', 'was', 'we', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'whose', 'why', 'will', 'with', 'within', 'without', 'would',
  'yet', 'you', 'your',
]);

/**
 * Lowercase words that may join two capitalised words inside one phrase. Only
 * prepositions and articles: `Theory of Computation` and `Ministry of the
 * Interior` are one term, while `Research and Development` deliberately breaks
 * into two one-word groups.
 */
const CONNECTORS: ReadonlySet<string> = new Set([
  'a', 'an', 'da', 'das', 'de', 'del', 'della', 'delle', 'dem', 'den', 'der', 'des', 'di', 'do',
  'dos', 'du', 'el', 'for', 'la', 'las', 'le', 'les', 'los', 'nel', 'nella', 'of', 'par', 'per',
  'pour', 'sous', 'sur', 'the', 'van', 'von',
]);

/** Ordinary English words that an all-caps heading prints as upper case. */
const COMMON_CAPS: ReadonlySet<string> = new Set([
  'ABOUT', 'AFTER', 'AGAIN', 'ALL', 'ALSO', 'AND', 'ANOTHER', 'ANY', 'ARE', 'BECAUSE', 'BEEN', 'BEFORE',
  'BEING', 'BETWEEN', 'BOTH', 'BUT', 'CAN', 'COULD', 'DID', 'DOES', 'DURING', 'EACH', 'EVERY', 'FIRST',
  'FOR', 'FROM', 'FURTHER', 'HAD', 'HAS', 'HAVE', 'HAVING', 'HERE', 'HOW', 'HOWEVER', 'INTO', 'ITS',
  'JUST', 'MAY', 'MIGHT', 'MORE', 'MOST', 'MUST', 'NEW', 'NOT', 'NOW', 'OF', 'ON', 'ONCE', 'ONLY',
  'OTHER', 'OUR', 'OUT', 'OVER', 'OWN', 'SAME', 'SHE', 'SHALL', 'SHOULD', 'SINCE', 'SOME', 'SUCH',
  'THAN', 'THAT', 'THE', 'THEIR', 'THEM', 'THEN', 'THERE', 'THESE', 'THEY', 'THIS', 'THOSE', 'THOUGH',
  'THROUGH', 'THUS', 'TOO', 'UNDER', 'UNTIL', 'VERY', 'WAS', 'WERE', 'WHAT', 'WHEN', 'WHERE', 'WHICH',
  'WHILE', 'WHO', 'WHY', 'WILL', 'WITH', 'WITHIN', 'WITHOUT', 'WOULD', 'YET', 'YOU', 'YOUR',
]);

const LETTER = /\p{L}/u;
const UPPER_LETTER = /\p{Lu}/u;
const EDGE_LETTER = /[\p{L}\p{N}]/u;
const REGEXP_SPECIAL = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|']);

/**
 * One token: a dotted acronym (`A.P.I.`) or a word that may carry apostrophes and
 * hyphens (`nơ-ron`, `don't`). Both alternatives are Unicode-aware, so a term in
 * any script is scanned by the same pass.
 */
const TOKEN_SOURCE = String.raw`(?:\p{Lu}\.){2,}\p{Lu}?\.?|[\p{L}\p{N}]+(?:['’\u2010-\u2015\-][\p{L}\p{N}]+)*`;

const tokenPattern = (): RegExp => new RegExp(TOKEN_SOURCE, 'gu');

// --- Text helpers ----------------------------------------------------------

function clean(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** Case-folded spelling used for target-variant identity: punctuation is kept. */
function variantKey(value: string): string {
  return clean(value).toLowerCase();
}

/** Case-folded term key: dots are dropped so `API` and `A.P.I.` are one term. */
function termKey(value: string): string {
  return variantKey(value).replace(/\./gu, '');
}

function escapeRegExp(value: string): string {
  let out = '';
  for (const char of value) out += REGEXP_SPECIAL.has(char) ? `\\${char}` : char;
  return out;
}

/** Escapes a spelling for a regex, tolerating a different run of whitespace. */
function escapeSpelling(value: string): string {
  return value
    .split(/\s+/u)
    .filter(part => part !== '')
    .map(escapeRegExp)
    .join(String.raw`\s+`);
}

/**
 * Finds a whole-word occurrence of `term`, case-insensitively. Edges that are not
 * letters or digits match anywhere, so `§ 4` still works as a literal term.
 */
function findTerm(text: string, term: string): number {
  const needle = term.toLowerCase();
  if (needle === '') return -1;
  const haystack = text.toLowerCase();
  const first = needle.charAt(0);
  const last = needle.charAt(needle.length - 1);
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return -1;
    const before = index === 0 ? '' : haystack.charAt(index - 1);
    const after = haystack.charAt(index + needle.length);
    const startsClean = !EDGE_LETTER.test(first) || !EDGE_LETTER.test(before);
    const endsClean = !EDGE_LETTER.test(last) || !EDGE_LETTER.test(after);
    if (startsClean && endsClean) return index;
    from = index + Math.max(1, needle.length);
  }
  return -1;
}

/** Replaces every whole-word, case-insensitive occurrence of `needle`. */
function replaceTerm(text: string, needle: string, replacement: string): { text: string; count: number } {
  const spelling = clean(needle);
  const body = escapeSpelling(spelling);
  if (body === '' || replacement === '') return { text, count: 0 };
  const first = spelling.charAt(0);
  const last = spelling.charAt(spelling.length - 1);
  const before = EDGE_LETTER.test(first) ? String.raw`(?<![\p{L}\p{N}])` : '';
  const after = EDGE_LETTER.test(last) ? String.raw`(?![\p{L}\p{N}])` : '';
  const pattern = new RegExp(`${before}${body}${after}`, 'giu');
  let count = 0;
  const next = text.replace(pattern, () => {
    count += 1;
    return replacement;
  });
  return { text: next, count };
}

// --- Token scanning --------------------------------------------------------

interface Token {
  text: string;
  start: number;
  end: number;
  /** Starts with a capital and is not all capitals: a word a phrase can be built from. */
  capitalised: boolean;
  /** Two to six uppercase letters, dots ignored. */
  acronym: boolean;
}

function classifyToken(text: string): { capitalised: boolean; acronym: boolean } {
  const letters = [...text].filter(char => LETTER.test(char));
  if (letters.length === 0) return { capitalised: false, acronym: false };
  const allUpper = letters.every(char => char === char.toUpperCase() && char !== char.toLowerCase());
  const first = [...text][0] ?? '';
  const capitalised = UPPER_LETTER.test(first) && !allUpper;
  const acronym =
    allUpper &&
    letters.length >= 2 &&
    letters.length <= ACRONYM_MAX_LETTERS &&
    !COMMON_CAPS.has(letters.join('').toUpperCase());
  return { capitalised, acronym };
}

function scanTokens(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(tokenPattern())) {
    const raw = match[0];
    const start = match.index ?? 0;
    tokens.push({ text: raw, start, end: start + raw.length, ...classifyToken(raw) });
  }
  return tokens;
}

/** True when only whitespace separates two tokens, so a phrase may span them. */
function isSoftGap(text: string, from: number, to: number): boolean {
  return from >= 0 && to > from && /^\s+$/u.test(text.slice(from, to));
}

function isConnector(text: string): boolean {
  return CONNECTORS.has(text.toLowerCase());
}

function isStartWord(text: string): boolean {
  return PHRASE_STARTS.has(text.toLowerCase());
}

function countCapitalised(run: readonly number[], tokens: readonly Token[]): number {
  let count = 0;
  for (const at of run) if (tokens[at]?.capitalised) count += 1;
  return count;
}

/**
 * Trims a candidate run into the phrase a reviewer would recognise: leading
 * function words go, the run is capped, and a trailing connector is dropped.
 */
function trimRun(run: number[], tokens: readonly Token[]): void {
  while (run.length > 1) {
    const first = tokens[run[0] ?? 0];
    if (!first || !isStartWord(first.text)) break;
    run.shift();
  }
  while (run.length > TERM_MAX_WORDS) run.pop();
  while (run.length > 1) {
    const last = tokens[run[run.length - 1] ?? 0];
    if (!last || !isConnector(last.text)) break;
    run.pop();
  }
}

interface PhraseHit {
  text: string;
  start: number;
}

/**
 * Reads every capitalised phrase in one text. Groups are disjoint and read left to
 * right, so `Neural Network and Data Pipeline` reports two terms, not one.
 */
function phraseHits(text: string, tokens: readonly Token[]): PhraseHit[] {
  const hits: PhraseHit[] = [];
  let index = 0;
  while (index < tokens.length) {
    const start = tokens[index];
    if (!start || !start.capitalised) {
      index += 1;
      continue;
    }
    const run: number[] = [index];
    let cursor = index + 1;
    while (cursor < tokens.length) {
      const previous = tokens[cursor - 1];
      const current = tokens[cursor];
      if (!previous || !current || !isSoftGap(text, previous.end, current.start)) break;
      if (current.capitalised) {
        run.push(cursor);
        cursor += 1;
        continue;
      }
      // A phrase may continue through one or two lowercase connectors when
      // another capitalised word follows: `Ministry of the Interior`.
      let look = cursor;
      while (look < tokens.length && look - cursor < MAX_CONNECTORS) {
        const connector = tokens[look];
        if (!connector || !isConnector(connector.text)) break;
        const next = tokens[look + 1];
        if (!next || !isSoftGap(text, connector.end, next.start)) break;
        look += 1;
      }
      const follower = tokens[look];
      const lastConnector = tokens[look - 1];
      if (look > cursor && follower && lastConnector && follower.capitalised && isSoftGap(text, lastConnector.end, follower.start)) {
        for (let at = cursor; at <= look; at += 1) run.push(at);
        cursor = look + 1;
        continue;
      }
      break;
    }
    index = Math.max(cursor, index + 1);
    trimRun(run, tokens);
    if (countCapitalised(run, tokens) < 2) continue;
    const first = tokens[run[0] ?? 0];
    const last = tokens[run[run.length - 1] ?? 0];
    if (!first || !last) continue;
    hits.push({ text: text.slice(first.start, last.end), start: first.start });
  }
  return hits;
}

function acronymHits(tokens: readonly Token[]): PhraseHit[] {
  const hits: PhraseHit[] = [];
  for (const token of tokens) {
    if (token.acronym) hits.push({ text: token.text, start: token.start });
  }
  return hits;
}

// --- Term extraction -------------------------------------------------------

interface TermOccurrence {
  key: string;
  text: string;
  kind: TermKind;
  start: number;
  glossaryTarget?: string;
}

interface Candidate {
  text: string;
  /** Variant identity: case-folded, punctuation kept. */
  key: string;
  start: number;
}

function glossaryEntries(input: GlossaryInput | undefined): GlossaryEntry[] {
  if (!input) return [];
  if (isEntryList(input)) return input.map(entry => ({ source: entry.source, target: entry.target }));
  return Object.entries(input).map(([source, target]) => ({ source, target }));
}

function isEntryList(value: GlossaryInput): value is readonly GlossaryEntry[] {
  return Array.isArray(value);
}

/**
 * Reads the source terms one block carries. A glossary term wins over the phrase
 * or acronym of the same key, because its spelling is the one a reviewer agreed on.
 */
function collectSourceTerms(source: string, entries: readonly GlossaryEntry[]): TermOccurrence[] {
  const byKey = new Map<string, TermOccurrence>();
  const add = (occurrence: TermOccurrence): void => {
    const existing = byKey.get(occurrence.key);
    if (!existing) {
      byKey.set(occurrence.key, occurrence);
      return;
    }
    if (occurrence.kind === 'glossary') {
      byKey.set(occurrence.key, { ...occurrence, start: Math.min(existing.start, occurrence.start) });
    }
  };
  const tokens = scanTokens(source);
  for (const hit of phraseHits(source, tokens)) add({ key: termKey(hit.text), text: hit.text, kind: 'phrase', start: hit.start });
  for (const hit of acronymHits(tokens)) add({ key: termKey(hit.text), text: hit.text, kind: 'acronym', start: hit.start });
  for (const entry of entries) {
    if (typeof entry.source !== 'string' || typeof entry.target !== 'string') continue;
    const term = clean(entry.source);
    const target = clean(entry.target);
    if (term === '' || target === '') continue;
    const at = findTerm(source, term);
    if (at < 0) continue;
    add({ key: termKey(term), text: term, kind: 'glossary', start: at, glossaryTarget: target });
  }
  return [...byKey.values()];
}

/**
 * Reads the target spellings one block offers: its capitalised phrases, its
 * acronyms, and the glossary targets of the terms the block carries.
 */
function collectTargetCandidates(target: string, terms: readonly TermOccurrence[]): Candidate[] {
  const byKey = new Map<string, Candidate>();
  const add = (candidate: Candidate): void => {
    const existing = byKey.get(candidate.key);
    if (!existing) {
      byKey.set(candidate.key, candidate);
      return;
    }
    byKey.set(candidate.key, { ...existing, start: Math.min(existing.start, candidate.start) });
  };
  const tokens = scanTokens(target);
  for (const hit of phraseHits(target, tokens)) add({ text: hit.text, key: variantKey(hit.text), start: hit.start });
  for (const hit of acronymHits(tokens)) add({ text: hit.text, key: variantKey(hit.text), start: hit.start });
  for (const term of terms) {
    if (term.glossaryTarget === undefined) continue;
    const at = findTerm(target, term.glossaryTarget);
    if (at < 0) continue;
    // A mandated target is a term even when the extractor would not read it as
    // one, such as a lowercase target in a script without capitals.
    add({ text: term.glossaryTarget, key: variantKey(term.glossaryTarget), start: at });
  }
  return [...byKey.values()].sort((left, right) => left.start - right.start);
}

interface Attribution {
  term: TermOccurrence;
  spelling: string;
}

/**
 * Ties target spellings to source terms with the evidence order documented at the
 * top of the module. Ambiguous blocks contribute nothing rather than a guess.
 */
function attributeBlock(terms: readonly TermOccurrence[], candidates: readonly Candidate[]): Attribution[] {
  const attributed: Attribution[] = [];
  const claimed = new Set<string>();
  const used = new Set<number>();

  // 1. A glossary target that the block literally carries.
  for (const term of terms) {
    if (term.glossaryTarget === undefined) continue;
    const wanted = variantKey(term.glossaryTarget);
    const at = candidates.findIndex((candidate, index) => !used.has(index) && candidate.key === wanted);
    if (at < 0) continue;
    used.add(at);
    claimed.add(term.key);
    const candidate = candidates[at];
    if (candidate) attributed.push({ term, spelling: candidate.text });
  }

  // 2. A spelling the block repeats verbatim, which is an untranslated name.
  for (const term of terms) {
    if (claimed.has(term.key)) continue;
    const at = candidates.findIndex((candidate, index) => !used.has(index) && termKey(candidate.text) === term.key);
    if (at < 0) continue;
    used.add(at);
    claimed.add(term.key);
    const candidate = candidates[at];
    if (candidate) attributed.push({ term, spelling: candidate.text });
  }

  // 3 and 4. What is left is paired only when the count on both sides agrees.
  const restTerms = terms.filter(term => !claimed.has(term.key)).sort((left, right) => left.start - right.start);
  const restCandidates = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(entry => !used.has(entry.index));
  if (restTerms.length === 1 && restCandidates.length === 1) {
    const only = restCandidates[0]?.candidate;
    const term = restTerms[0];
    if (term && only) attributed.push({ term, spelling: only.text });
  } else if (restTerms.length > 1 && restTerms.length === restCandidates.length) {
    restTerms.forEach((term, position) => {
      const candidate = restCandidates[position]?.candidate;
      if (candidate) attributed.push({ term, spelling: candidate.text });
    });
  }
  return attributed;
}

// --- Collection ------------------------------------------------------------

interface ObservedVariant {
  text: string;
  blockIds: string[];
}

interface TermRecord {
  key: string;
  text: string;
  kind: TermKind;
  glossaryTarget: string | undefined;
  blockIds: string[];
  variants: Map<string, ObservedVariant>;
  violatingBlockIds: string[];
}

interface CollectedTerms {
  records: Map<string, TermRecord>;
  /** blockId -> term key -> spelling the block used, in attribution order. */
  observed: Map<string, Map<string, string>>;
}

function collect(translations: readonly TranslationPair[], entries: readonly GlossaryEntry[]): CollectedTerms {
  const records = new Map<string, TermRecord>();
  const observed = new Map<string, Map<string, string>>();

  for (const pair of translations) {
    if (!pair || typeof pair.source !== 'string' || typeof pair.target !== 'string') continue;
    const terms = collectSourceTerms(pair.source, entries);
    if (terms.length === 0) continue;

    for (const term of terms) {
      let record = records.get(term.key);
      if (!record) {
        record = {
          key: term.key,
          text: term.text,
          kind: term.kind,
          glossaryTarget: term.glossaryTarget,
          blockIds: [],
          variants: new Map(),
          violatingBlockIds: [],
        };
        records.set(term.key, record);
      }
      if (!record.blockIds.includes(pair.blockId)) record.blockIds.push(pair.blockId);
      if (record.glossaryTarget === undefined && term.glossaryTarget !== undefined) record.glossaryTarget = term.glossaryTarget;
      if (record.kind !== 'glossary' && term.kind === 'glossary') record.kind = 'glossary';
    }

    // A blank target is emptiness, which `reviewTranslation` reports per pair;
    // there is no spelling to read here.
    if (pair.target.trim() === '') continue;

    for (const term of terms) {
      if (term.glossaryTarget === undefined) continue;
      if (findTerm(pair.target, term.glossaryTarget) >= 0) continue;
      const record = records.get(term.key);
      if (record && !record.violatingBlockIds.includes(pair.blockId)) record.violatingBlockIds.push(pair.blockId);
    }

    for (const attribution of attributeBlock(terms, collectTargetCandidates(pair.target, terms))) {
      const record = records.get(attribution.term.key);
      if (!record) continue;
      const key = variantKey(attribution.spelling);
      let variant = record.variants.get(key);
      if (!variant) {
        variant = { text: attribution.spelling, blockIds: [] };
        record.variants.set(key, variant);
      }
      if (!variant.blockIds.includes(pair.blockId)) variant.blockIds.push(pair.blockId);
      let perBlock = observed.get(pair.blockId);
      if (!perBlock) {
        perBlock = new Map();
        observed.set(pair.blockId, perBlock);
      }
      if (!perBlock.has(attribution.term.key)) perBlock.set(attribution.term.key, attribution.spelling);
    }
  }

  return { records, observed };
}

// --- Report ----------------------------------------------------------------

function compareVariants(left: TermVariant, right: TermVariant, glossaryTarget: string | undefined): number {
  const mandated = glossaryTarget === undefined ? '' : variantKey(glossaryTarget);
  const leftMandated = mandated !== '' && variantKey(left.target) === mandated;
  const rightMandated = mandated !== '' && variantKey(right.target) === mandated;
  if (leftMandated !== rightMandated) return leftMandated ? -1 : 1;
  const leftKnown = left.target !== '';
  const rightKnown = right.target !== '';
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  if (left.count !== right.count) return right.count - left.count;
  if (left.target.length !== right.target.length) return right.target.length - left.target.length;
  return left.target < right.target ? -1 : left.target > right.target ? 1 : 0;
}

function buildInconsistency(record: TermRecord): Inconsistency {
  const variants: TermVariant[] = [...record.variants.values()].map(variant => ({
    target: variant.text,
    blockIds: [...variant.blockIds],
    count: variant.blockIds.length,
  }));
  const mandated = record.glossaryTarget;
  if (mandated !== undefined && !variants.some(variant => variantKey(variant.target) === variantKey(mandated))) {
    // The mandated spelling is always listed, even when the document never uses
    // it: a reviewer needs to see what the requirement is next to what was written.
    variants.push({ target: mandated, blockIds: [], count: 0 });
  }
  variants.sort((left, right) => compareVariants(left, right, mandated));
  const severity: ConsistencySeverity = mandated === undefined ? 'warn' : 'error';
  return {
    source: record.text,
    kind: record.kind,
    variants,
    severity,
    ...(mandated === undefined ? {} : { glossaryTarget: mandated }),
    violatingBlockIds: [...record.violatingBlockIds],
  };
}

/** Blocks a finding touches, used only to order the report. */
function affectedBlocks(inconsistency: Inconsistency): number {
  const ids = new Set<string>();
  for (const variant of inconsistency.variants) {
    for (const blockId of variant.blockIds) ids.add(blockId);
  }
  for (const blockId of inconsistency.violatingBlockIds) ids.add(blockId);
  return ids.size;
}

function compareInconsistencies(left: Inconsistency, right: Inconsistency): number {
  if (left.severity !== right.severity) return left.severity === 'error' ? -1 : 1;
  const byBlocks = affectedBlocks(right) - affectedBlocks(left);
  if (byBlocks !== 0) return byBlocks;
  const leftKey = termKey(left.source);
  const rightKey = termKey(right.source);
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  return left.source < right.source ? -1 : left.source > right.source ? 1 : 0;
}

/**
 * Reports every source term the document renders in more than one way.
 *
 * `ok` is true when no finding has severity `error`, the same convention as
 * `reviewTranslation`: a warning is a judgement call for a human, an error is a
 * defect. A term seen in fewer than {@link CONSISTENCY_MIN_BLOCKS} blocks is never
 * reported, and findings come back errors first, then by how much of the document
 * they touch, then alphabetically.
 */
export function checkConsistency(
  translations: readonly TranslationPair[],
  options: ConsistencyOptions = {},
): ConsistencyReport {
  const { records } = collect(translations, glossaryEntries(options.glossary));
  const inconsistencies: Inconsistency[] = [];
  for (const record of records.values()) {
    if (record.blockIds.length < CONSISTENCY_MIN_BLOCKS) continue;
    if (record.glossaryTarget !== undefined) {
      if (record.violatingBlockIds.length > 0) inconsistencies.push(buildInconsistency(record));
      continue;
    }
    if (record.variants.size >= 2) inconsistencies.push(buildInconsistency(record));
  }
  inconsistencies.sort(compareInconsistencies);
  return { inconsistencies, ok: inconsistencies.every(inconsistency => inconsistency.severity !== 'error') };
}

/**
 * The default spelling a reviewer should accept for one finding.
 *
 * The variants of a finding are already ordered for this call, so the first one
 * with a known spelling wins: the glossary target when the term has one (the
 * requirement beats the majority), else the spelling used by the most blocks, then
 * the longest spelling, then alphabetical. `null` means the document never offered
 * a spelling that could be read, so there is nothing to accept.
 */
export function suggestCanonical(inconsistency: Inconsistency): TermVariant | null {
  for (const variant of inconsistency.variants) {
    if (variant.target !== '') return { target: variant.target, blockIds: [...variant.blockIds], count: variant.count };
  }
  return null;
}

/**
 * Rewrites the blocks that still disagree with an accepted canonical spelling.
 *
 * A decision is keyed by the source term and carries the spelling to accept. Only
 * blocks the report already attributed to that term are touched, and only where
 * their spelling differs beyond case: a block that already uses the accepted
 * spelling, or that never named the term, is returned unchanged and shared with
 * the input. Every whole-word occurrence of the rejected spelling is replaced.
 *
 * Decisions are applied in the order given; the first decision for a source term
 * wins. A decision with a blank target, or for a term the document never used, is
 * ignored. `options.glossary` is accepted so a glossary target can be recognised
 * as a variant even when it is not phrase-shaped.
 */
export function applyCanonical(
  translations: readonly TranslationPair[],
  decisions: readonly CanonicalDecision[],
  options: ConsistencyOptions = {},
): ApplyCanonicalResult {
  const accepted = new Map<string, string>();
  for (const decision of decisions) {
    if (!decision || typeof decision.source !== 'string' || typeof decision.target !== 'string') continue;
    const target = clean(decision.target);
    if (target === '') continue;
    const key = termKey(decision.source);
    if (key === '' || accepted.has(key)) continue;
    accepted.set(key, target);
  }

  const changed: BlockRewrite[] = [];
  if (accepted.size === 0) return { translations: [...translations], changed };

  const { records, observed } = collect(translations, glossaryEntries(options.glossary));

  const rewritten = translations.map(pair => {
    const perBlock = observed.get(pair.blockId);
    if (!perBlock || perBlock.size === 0) return pair;
    let text = pair.target;
    const replacements: TermReplacement[] = [];
    for (const [key, target] of accepted) {
      const spelling = perBlock.get(key);
      if (spelling === undefined) continue;
      if (variantKey(spelling) === variantKey(target)) continue;
      const result = replaceTerm(text, spelling, target);
      if (result.count === 0) continue;
      text = result.text;
      const source = records.get(key)?.text ?? spelling;
      replacements.push({ source, from: spelling, to: target, count: result.count });
    }
    if (replacements.length === 0) return pair;
    changed.push({ blockId: pair.blockId, page: pair.page, before: pair.target, after: text, replacements });
    return { ...pair, target: text };
  });

  return { translations: rewritten, changed };
}
