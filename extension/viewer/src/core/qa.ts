/**
 * Translation QA for documents where a wrong number costs money (backlog G11).
 *
 * {@link reviewTranslation} compares a source and its translation for the
 * mistakes a reader of contracts and papers cannot recover from:
 *
 * - every number in the source must survive as the same value, whatever the
 *   locale spelling (`1,234.56`, `1.234,56`, `1 234,56` with a narrow or
 *   non-breaking space, and `1234.56` are the same number);
 * - a unit the source carries (`%`, `‰`, a currency symbol or an ISO currency
 *   code) must not disappear or appear out of nowhere;
 * - a negated source (`not`, `no`, `never`, `không`, `chưa`) must still be
 *   negated in the target;
 * - a glossary term required by the caller must appear with the exact target it
 *   asks for;
 * - every placeholder the source carries (`⟦1⟧`) must come back exactly once;
 * - an empty target for a non-empty source is an error.
 *
 * Severity is fixed, so a reviewer can triage without knowing the rules:
 *
 * | Finding                                    | Severity                       |
 * | ------------------------------------------ | ------------------------------ |
 * | a number changed, lost, or invented        | error                          |
 * | a negation lost                            | error                          |
 * | a placeholder lost, duplicated, or added   | error                          |
 * | an empty target                            | error                          |
 * | a glossary term missing                    | error when `strict`, else warn |
 * | a unit dropped or added                    | warn                           |
 *
 * `ok` is true when no issue has severity `error`: a warning is a judgement
 * call for a human, an error is a defect for a human to fix.
 *
 * Every issue carries a source and a target excerpt as evidence. An excerpt is
 * the empty string exactly on the side where nothing exists, so a number
 * missing from the target has a source excerpt only.
 *
 * Boundaries that are deliberate:
 * - Numbers are compared by value, never by spelling, so a locale rewrite is
 *   not reported. A single separator followed by exactly three digits (`1,234`)
 *   is read as thousands grouping, not as a decimal; write `0.125` or `1.2345`
 *   when the decimal reading is meant.
 * - A unit is compared as the literal marker, so `$` in the source and `USD` in
 *   the target report a dropped `$` and an added `USD`, both warnings.
 * - Negation markers cover English and Vietnamese by default. Pass
 *   `negationTerms` for any other target language, or the check cannot see its
 *   negation.
 * - Placeholders are matched in canonical form (`⟦1⟧`), tolerating spaces inside
 *   the brackets the way the mask/restore pipeline does.
 */

import type { GlossaryEntry } from './glossary';
import { PLACEHOLDER_CLOSE, PLACEHOLDER_OPEN } from './protect';

export type IssueKind = 'number' | 'unit' | 'negation' | 'term' | 'placeholder' | 'emptiness';

export type IssueSeverity = 'error' | 'warn';

export interface Issue {
  kind: IssueKind;
  severity: IssueSeverity;
  /** What was compared and what came out, in English and without markup. */
  detail: string;
  /** Evidence from the source; empty when the finding is on the target side only. */
  sourceExcerpt: string;
  /** Evidence from the target; empty when the finding is on the source side only. */
  targetExcerpt: string;
}

/**
 * Terms a translation must honour. Both shapes the app already uses are
 * accepted: parsed entries and the `source -> target` record in settings.
 */
export type GlossaryInput = readonly GlossaryEntry[] | Record<string, string>;

export interface ReviewOptions {
  /** Terms that must appear in the target with exactly the requested translation. */
  glossary?: GlossaryInput;
  /** Promote a missing glossary term from `warn` to `error`. Defaults to false. */
  strict?: boolean;
  /** Extra target-language negation markers, added to the default list. */
  negationTerms?: readonly string[];
  /** Placeholder numbers the target must carry; defaults to the source markers. */
  placeholders?: readonly number[];
}

export interface TranslationReview {
  issues: Issue[];
  /** True when no issue has severity `error`. */
  ok: boolean;
}

/** Negation words the default check understands: English first, then Vietnamese. */
export const DEFAULT_NEGATION_TERMS: readonly string[] = [
  'not',
  'no',
  'never',
  'none',
  'nothing',
  'neither',
  'nor',
  'without',
  'cannot',
  'không',
  'chưa',
  'chẳng',
  'chả',
  'đừng',
];

const CURRENCY_SYMBOLS: readonly string[] = [
  '$', '€', '£', '¥', '₩', '₹', '₽', '₫', '₴', '₺', '₦', '₱', '฿', '¢',
];

/** ISO 4217 codes, matched case-sensitively so ordinary lowercase words stay quiet. */
const CURRENCY_CODES: readonly string[] = [
  'USD', 'EUR', 'GBP', 'JPY', 'VND', 'CHF', 'CNY', 'AUD', 'CAD', 'INR', 'KRW',
  'RUB', 'THB', 'SGD', 'HKD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'BRL', 'MXN',
  'ZAR', 'NGN', 'UAH', 'TRY', 'PHP', 'IDR', 'MYR',
];

/** Characters read as thousands grouping when they sit inside a number. */
const GROUP_SPACES = String.raw`\u00A0\u202F\u2009`;

/** One number: plain digits, optionally grouped and optionally with a decimal tail. */
const NUMBER_CORE = String.raw`\d+(?:(?:[.,]|[${GROUP_SPACES}])\d+)*`;

const EXCERPT_RADIUS = 28;

const REGEXP_SPECIAL = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|']);

function escapeRegExp(value: string): string {
  let out = '';
  for (const char of value) out += REGEXP_SPECIAL.has(char) ? `\\${char}` : char;
  return out;
}

function clean(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function excerpt(text: string, index: number, length = 1): string {
  if (text === '' || index < 0 || index > text.length) return '';
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + Math.max(1, length) + EXCERPT_RADIUS);
  const body = text.slice(start, end).replace(/\s+/gu, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

function excerptAt(text: string, index: number | undefined): string {
  return index === undefined ? '' : excerpt(text, index);
}

// --- Placeholders ---------------------------------------------------------

const PLACEHOLDER_SOURCE = `${PLACEHOLDER_OPEN}\\s*(\\d{1,9})\\s*${PLACEHOLDER_CLOSE}`;

const placeholderPattern = (): RegExp => new RegExp(PLACEHOLDER_SOURCE, 'gu');

interface PlaceholderHit {
  index: number;
  length: number;
  number: number;
}

function placeholderHits(text: string): PlaceholderHit[] {
  const hits: PlaceholderHit[] = [];
  for (const match of text.matchAll(placeholderPattern())) {
    hits.push({
      index: match.index ?? 0,
      length: match[0].length,
      number: Number.parseInt(match[1] ?? '', 10),
    });
  }
  return hits;
}

/**
 * Replaces placeholders with a space so a marker number (`⟦12⟧`) is never read
 * as a document number and never hides the word next to it.
 */
function blankPlaceholders(text: string): string {
  return text.replace(placeholderPattern(), ' ');
}

// --- Numbers --------------------------------------------------------------

const numberPattern = (): RegExp =>
  new RegExp(String.raw`(?<![\p{L}\p{N}])[-−]?(${NUMBER_CORE})(?:st|nd|rd|th)?(?![\p{L}\p{N}])`, 'giu');

/** Canonical digit string for a number with either separator convention. */
function normalizeInteger(digits: string): string {
  const stripped = digits.replace(/^0+(?=\d)/u, '');
  return stripped === '' ? '0' : stripped;
}

function canonicalNumber(raw: string): string | null {
  const value = raw.replace(/[\s\u00A0\u202F\u2009'’]/gu, '');
  if (!/^\d[\d.,]*$/u.test(value)) return null;
  const separators = [...value].filter(char => char === ',' || char === '.');
  if (separators.length === 0) return normalizeInteger(value);
  const groups = value.split(/[.,]/u);
  const kinds = new Set(separators);
  const head = groups[0] ?? '';
  const tail = groups[groups.length - 1] ?? '';
  let integerPart: string;
  let fraction = '';
  if (kinds.size > 1) {
    // Two kinds can only mean the last one is the decimal separator.
    integerPart = groups.slice(0, -1).join('');
    fraction = tail;
  } else if (groups.length === 2) {
    // `1,234` is grouping; `1,5` and `0,125` are decimals.
    if (tail.length === 3 && head.length <= 3 && !/^0/u.test(head)) {
      integerPart = groups.join('');
    } else {
      integerPart = head;
      fraction = tail;
    }
  } else if (tail.length === 3) {
    // `1,234,567` and the Indian `1,23,456` both read as integers.
    integerPart = groups.join('');
  } else {
    integerPart = groups.slice(0, -1).join('');
    fraction = tail;
  }
  const integer = normalizeInteger(integerPart);
  const decimal = fraction.replace(/0+$/u, '');
  return `${integer}${decimal === '' ? '' : `.${decimal}`}`;
}

interface NumberHit {
  /** Spelling shown to the reviewer, without an ordinal suffix. */
  raw: string;
  /** Value used for comparison. */
  value: string;
  index: number;
  length: number;
}

function numberHits(text: string): NumberHit[] {
  const hits: NumberHit[] = [];
  for (const match of text.matchAll(numberPattern())) {
    const core = match[1] ?? '';
    const canonical = canonicalNumber(core);
    if (canonical === null) continue;
    const negative = /^[-−]/u.test(match[0]);
    const value = negative && canonical !== '0' ? `-${canonical}` : canonical;
    hits.push({
      raw: `${negative ? '-' : ''}${core}`,
      value,
      index: match.index ?? 0,
      length: match[0].length,
    });
  }
  return hits;
}

interface NumberGroup {
  count: number;
  first: NumberHit;
}

function groupNumbers(hits: readonly NumberHit[]): Map<string, NumberGroup> {
  const groups = new Map<string, NumberGroup>();
  for (const hit of hits) {
    const group = groups.get(hit.value);
    if (group) group.count += 1;
    else groups.set(hit.value, { count: 1, first: hit });
  }
  return groups;
}

function numberIssues(source: string, target: string): Issue[] {
  const sourceGroups = groupNumbers(numberHits(blankPlaceholders(source)));
  const targetGroups = groupNumbers(numberHits(blankPlaceholders(target)));
  const issues: Issue[] = [];
  for (const [value, group] of sourceGroups) {
    const available = targetGroups.get(value)?.count ?? 0;
    if (available >= group.count) continue;
    const { raw, index, length } = group.first;
    issues.push({
      kind: 'number',
      severity: 'error',
      detail:
        available === 0
          ? `Source number ${raw} is missing from the target.`
          : `Source number ${raw} appears ${group.count} times but the target has ${available}.`,
      sourceExcerpt: excerpt(source, index, length),
      targetExcerpt: '',
    });
  }
  for (const [value, group] of targetGroups) {
    const expected = sourceGroups.get(value)?.count ?? 0;
    if (group.count <= expected) continue;
    const { raw, index, length } = group.first;
    issues.push({
      kind: 'number',
      severity: 'error',
      detail:
        expected === 0
          ? `Target number ${raw} is not in the source.`
          : `Target number ${raw} appears ${group.count} times but the source has ${expected}.`,
      sourceExcerpt: '',
      targetExcerpt: excerpt(target, index, length),
    });
  }
  return issues;
}

// --- Units ----------------------------------------------------------------

interface UnitMarker {
  label: string;
  pattern: () => RegExp;
}

function buildUnitMarkers(): UnitMarker[] {
  const markers: UnitMarker[] = [
    { label: '%', pattern: () => /[%％]/gu },
    { label: '‰', pattern: () => /‰/gu },
  ];
  for (const label of CURRENCY_SYMBOLS) {
    markers.push({ label, pattern: () => new RegExp(escapeRegExp(label), 'gu') });
  }
  for (const label of CURRENCY_CODES) {
    markers.push({ label, pattern: () => new RegExp(String.raw`\b${label}\b`, 'gu') });
  }
  return markers;
}

const UNIT_MARKERS: readonly UnitMarker[] = buildUnitMarkers();

function markerIndices(text: string, pattern: RegExp): number[] {
  const indices: number[] = [];
  for (const match of text.matchAll(pattern)) indices.push(match.index ?? 0);
  return indices;
}

function unitIssues(source: string, target: string): Issue[] {
  const sourceBody = blankPlaceholders(source);
  const targetBody = blankPlaceholders(target);
  const issues: Issue[] = [];
  for (const marker of UNIT_MARKERS) {
    const sourceIndices = markerIndices(sourceBody, marker.pattern());
    const targetIndices = markerIndices(targetBody, marker.pattern());
    if (sourceIndices.length === targetIndices.length) continue;
    const missing = sourceIndices.length > targetIndices.length;
    const detail = sourceIndices.length === 0
      ? `Unit ${marker.label} appears ${targetIndices.length} time(s) in the target but never in the source.`
      : targetIndices.length === 0
        ? `Unit ${marker.label} appears ${sourceIndices.length} time(s) in the source but never in the target.`
        : missing
          ? `Unit ${marker.label} appears ${sourceIndices.length} time(s) in the source and ${targetIndices.length} time(s) in the target.`
          : `Unit ${marker.label} appears ${targetIndices.length} time(s) in the target and ${sourceIndices.length} time(s) in the source.`;
    issues.push({
      kind: 'unit',
      severity: 'warn',
      detail,
      sourceExcerpt: excerptAt(source, sourceIndices[0]),
      targetExcerpt: excerptAt(target, targetIndices[0]),
    });
  }
  return issues;
}

// --- Negation -------------------------------------------------------------

const contractionPattern = (): RegExp => /(?<![\p{L}])\p{L}+n['’]t(?![\p{L}])/giu;

function negationPattern(terms: readonly string[]): RegExp {
  const alternatives = terms.map(escapeRegExp).join('|');
  return new RegExp(String.raw`(?<![\p{L}])(?:${alternatives})(?![\p{L}])`, 'giu');
}

interface NegationHit {
  word: string;
  index: number;
}

function negationHits(text: string, terms: readonly string[]): NegationHit[] {
  const hits: NegationHit[] = [];
  for (const match of text.matchAll(negationPattern(terms))) {
    const index = match.index ?? 0;
    const word = match[0];
    // "No." in front of a number is a numbering abbreviation, not a negation.
    if (/^no$/iu.test(word) && /^\s*\./u.test(text.slice(index + word.length))) continue;
    hits.push({ word: word.toLowerCase(), index });
  }
  for (const match of text.matchAll(contractionPattern())) {
    hits.push({ word: match[0].toLowerCase(), index: match.index ?? 0 });
  }
  return hits.sort((a, b) => a.index - b.index);
}

function negationIssues(source: string, target: string, extraTerms: readonly string[]): Issue[] {
  const terms = [...DEFAULT_NEGATION_TERMS, ...extraTerms];
  const sourceHits = negationHits(blankPlaceholders(source), terms);
  if (sourceHits.length === 0) return [];
  if (negationHits(blankPlaceholders(target), terms).length > 0) return [];
  const reported = new Set<string>();
  const issues: Issue[] = [];
  for (const hit of sourceHits) {
    if (reported.has(hit.word)) continue;
    reported.add(hit.word);
    issues.push({
      kind: 'negation',
      severity: 'error',
      detail: `Source negation "${hit.word}" has no negation marker in the target.`,
      sourceExcerpt: excerpt(source, hit.index, hit.word.length),
      targetExcerpt: '',
    });
  }
  return issues;
}

// --- Glossary terms -------------------------------------------------------

function isGlossaryList(value: GlossaryInput): value is readonly GlossaryEntry[] {
  return Array.isArray(value);
}

function glossaryEntries(input: GlossaryInput | undefined): GlossaryEntry[] {
  if (!input) return [];
  if (isGlossaryList(input)) return input.map(entry => ({ source: entry.source, target: entry.target }));
  return Object.entries(input).map(([source, target]) => ({ source, target }));
}

/**
 * Finds a term only where it stands as a word: a glossary entry for `act` must
 * not fire on `contract`. Non-letter edges skip the check, so a term such as
 * `§ 4` still matches literally.
 */
function findTermIndex(text: string, term: string): number {
  const haystack = text.toLowerCase();
  const needle = term.toLowerCase();
  const first = needle.charAt(0);
  const last = needle.charAt(needle.length - 1);
  const edgeIsLetter = /[\p{L}\p{N}]/u;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return -1;
    const before = index === 0 ? '' : haystack.charAt(index - 1);
    const after = haystack.charAt(index + needle.length);
    const startsClean = !edgeIsLetter.test(first) || !edgeIsLetter.test(before);
    const endsClean = !edgeIsLetter.test(last) || !edgeIsLetter.test(after);
    if (startsClean && endsClean) return index;
    from = index + Math.max(1, needle.length);
  }
  return -1;
}

function termIssues(source: string, target: string, options: ReviewOptions): Issue[] {
  const entries = glossaryEntries(options.glossary);
  if (entries.length === 0) return [];
  const severity: IssueSeverity = options.strict ? 'error' : 'warn';
  const sourceBody = blankPlaceholders(source);
  const targetBody = blankPlaceholders(target);
  const issues: Issue[] = [];
  for (const entry of entries) {
    const sourceTerm = clean(entry.source);
    const targetTerm = clean(entry.target);
    if (sourceTerm === '' || targetTerm === '') continue;
    const sourceIndex = findTermIndex(sourceBody, sourceTerm);
    if (sourceIndex < 0) continue;
    if (findTermIndex(targetBody, targetTerm) >= 0) continue;
    issues.push({
      kind: 'term',
      severity,
      detail: `Glossary term "${sourceTerm}" requires "${targetTerm}" in the target.`,
      sourceExcerpt: excerpt(source, sourceIndex, sourceTerm.length),
      targetExcerpt: '',
    });
  }
  return issues;
}

// --- Review ---------------------------------------------------------------

function dedupePlaceholders(numbers: readonly number[]): number[] {
  const unique: number[] = [];
  const seen = new Set<number>();
  for (const number of numbers) {
    if (!Number.isInteger(number) || number <= 0 || seen.has(number)) continue;
    seen.add(number);
    unique.push(number);
  }
  return unique;
}

function expectedPlaceholders(source: string, provided: readonly number[] | undefined): number[] {
  const numbers = provided ?? placeholderHits(source).map(hit => hit.number);
  return dedupePlaceholders(numbers);
}

function placeholderIssues(source: string, target: string, expected: readonly number[]): Issue[] {
  const sourceHits = placeholderHits(source);
  const targetHits = placeholderHits(target);
  const byNumber = new Map<number, PlaceholderHit[]>();
  for (const hit of targetHits) {
    const list = byNumber.get(hit.number);
    if (list) list.push(hit);
    else byNumber.set(hit.number, [hit]);
  }
  const issues: Issue[] = [];
  for (const number of expected) {
    const hits = byNumber.get(number) ?? [];
    if (hits.length === 1) continue;
    const marker = `${PLACEHOLDER_OPEN}${number}${PLACEHOLDER_CLOSE}`;
    const inSource = sourceHits.find(hit => hit.number === number);
    const inTarget = hits[0];
    issues.push({
      kind: 'placeholder',
      severity: 'error',
      detail:
        hits.length === 0
          ? `Placeholder ${marker} is missing from the target.`
          : `Placeholder ${marker} appears ${hits.length} times in the target; it must appear exactly once.`,
      sourceExcerpt: inSource ? excerpt(source, inSource.index, inSource.length) : '',
      targetExcerpt: inTarget ? excerpt(target, inTarget.index, inTarget.length) : '',
    });
  }
  const expectedSet = new Set(expected);
  for (const [number, hits] of byNumber) {
    if (expectedSet.has(number)) continue;
    const first = hits[0];
    if (!first) continue;
    const marker = `${PLACEHOLDER_OPEN}${number}${PLACEHOLDER_CLOSE}`;
    issues.push({
      kind: 'placeholder',
      severity: 'error',
      detail: `Placeholder ${marker} appears in the target but not in the source.`,
      sourceExcerpt: '',
      targetExcerpt: excerpt(target, first.index, first.length),
    });
  }
  return issues;
}

/**
 * Reviews one translated pair and returns the findings with their evidence.
 *
 * An empty source is not reviewed: there is nothing to compare. An empty target
 * for a non-empty source is the only finding, because every other check would
 * repeat the same fact.
 */
export function reviewTranslation(source: string, target: string, options: ReviewOptions = {}): TranslationReview {
  const issues: Issue[] = [];
  if (source.trim() === '') return { issues, ok: true };
  if (target.trim() === '') {
    issues.push({
      kind: 'emptiness',
      severity: 'error',
      detail: 'The target is empty while the source has text.',
      sourceExcerpt: excerpt(source.trim(), 0, 0),
      targetExcerpt: '',
    });
    return { issues, ok: false };
  }
  issues.push(
    ...numberIssues(source, target),
    ...unitIssues(source, target),
    ...negationIssues(source, target, options.negationTerms ?? []),
    ...placeholderIssues(source, target, expectedPlaceholders(source, options.placeholders)),
    ...termIssues(source, target, options),
  );
  return { issues, ok: issues.every(issue => issue.severity !== 'error') };
}
