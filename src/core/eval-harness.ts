/**
 * A small evaluation harness for the answer pipeline (backlog I12).
 *
 * Quality that is judged from memory is not measured. This module makes the judgement
 * explicit: a fixed set of cases, each with a question, the context a runner is given, and
 * what a correct answer has to contain; a runner injected by the caller; and grades that
 * say which case failed and why. It is deliberately the smallest thing that can turn "the
 * answers feel better" into a number two people can reproduce.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no network, no I/O. A case set
 *   and a runner produce the same results every run, so a number can be quoted.
 * - `defineCase` is the only constructor and it gates the case: an id that is blank or
 *   padded with whitespace, a question with no text, a context excerpt without a 1-based
 *   page, an expectation that asserts nothing, a citation string that is not exactly one
 *   marker, and a citation whose page or block the case's own context does not carry are
 *   all refused. A case that could never pass, or could pass on any prose, is a bug in the
 *   set, not a measurement.
 * - Citations are the ones `citations.ts` already parses, so the harness grades the very
 *   syntax the app resolves, and a second marker grammar cannot drift from the first. A
 *   citation resolves here when the case's own context carries the target and the answer
 *   names it; the case holds excerpts, not a Document IR, so nothing is matched against
 *   real geometry.
 * - A phrase is found after collapsing whitespace and folding case. Diacritics are not
 *   stripped: `hai năm` and `hai nam` are different strings, because losing a mark is a
 *   content error, not typography.
 * - An abstention is an answer with no text, or one the runner declares with
 *   `abstained: true`. A runner that throws is an error, never an abstention: a crash must
 *   not earn the credit for good judgement.
 * - Rates are `number | null`. A share over zero cases is `null`, not `0%`: "no evidence"
 *   and "nothing passed" are different claims, and the second one is a measurement.
 *
 * What it does not do: generate cases, resolve citations against the document, grade the
 * prose beyond the phrases a case lists, measure latency or cost, or decide whether the
 * shipped case set is representative. `docs/evaluation.md` records those limits beside the
 * set, including that the set in this repository is small and synthetic.
 */

import { parseCitations } from './citations';
import type { CitationMarker } from './citations';

// --- Public shapes ---------------------------------------------------------

/** One excerpt a case hands to the runner, with the page a citation of it would name. */
export interface EvalContextBlock {
  /** 1-based page the excerpt came from. */
  readonly page: number;
  /** The text the runner sees, verbatim. */
  readonly text: string;
  /** Block id, when the excerpt stands for one id the runner may cite. */
  readonly blockId?: string;
}

/** What a case expects the runner to do: answer, or abstain. */
export type EvalExpectationKind = 'answer' | 'abstain';

/** What a defined case asserts, with every optional list normalised to an array. */
export interface EvalExpectation {
  readonly kind: EvalExpectationKind;
  /** Phrases the answer must contain, in the order the case lists them. */
  readonly mustContain: readonly string[];
  /**
   * Citation markers the answer must carry, written in the syntax `citations.ts` parses
   * (`[p12]`, `[p12:r3]`, `[#p12-r3]`, `(trang 12)`, `[[cite:…]]`). Empty for an abstention.
   */
  readonly citations: readonly string[];
}

/** A case as {@link defineCase} validated and normalised it. */
export interface EvalCase {
  readonly id: string;
  readonly question: string;
  readonly context: readonly EvalContextBlock[];
  readonly expected: EvalExpectation;
}

/** A case before validation; the fields a person writes. */
export interface EvalCaseInput {
  readonly id: string;
  readonly question: string;
  /**
   * The excerpts the runner is given. An answerable case needs at least one, or its
   * phrases and citations are unearned.
   */
  readonly context: readonly EvalContextBlock[];
  readonly expected: EvalExpectationInput;
}

/** The expectation as it is written; both lists may be omitted. */
export interface EvalExpectationInput {
  readonly kind: EvalExpectationKind;
  readonly mustContain?: readonly string[];
  readonly citations?: readonly string[];
}

/** What a runner produced for one case. */
export interface EvalCandidate {
  /** The prose, including any citation markers it carries. */
  readonly answer: string;
  /**
   * Citation markers listed beside the answer instead of being written into it. Both
   * places are read, so a runner that returns a structured citation list needs no parsing
   * of its own.
   */
  readonly citations?: readonly string[];
  /**
   * True when the runner chose not to answer and `answer` carries the notice (or is
   * empty). Without it, an empty answer is still an abstention; prose is not.
   */
  readonly abstained?: boolean;
}

/**
 * The injected answer function. It receives exactly what the case supplies — the question
 * and the context excerpts — and may be synchronous or asynchronous, so a real model call
 * and a table of canned answers are both runners.
 */
export type EvalRunner = (
  question: string,
  context: readonly EvalContextBlock[],
) => EvalCandidate | Promise<EvalCandidate>;

/** Why a case failed. Stable, English codes; the detail lives beside them on the result. */
export type EvalFailureReason =
  /** The runner threw or returned something that is not a candidate. */
  | 'runner-error'
  /** An answerable case got no text at all. */
  | 'empty-answer'
  /** An answerable case got an answer the runner itself declared an abstention. */
  | 'unexpected-abstention'
  /** An unanswerable case got an answer. */
  | 'answered-unanswerable'
  /** The answer lacks at least one `mustContain` phrase; `missingPhrases` names them. */
  | 'missing-phrase'
  /** The answer lacks at least one expected citation; `citations.missing` names them. */
  | 'missing-citation';

/** The citation side of one result: what was asked for, what the answer honoured. */
export interface EvalCitationReport {
  /** Expected markers, as written in the case. */
  readonly expected: readonly string[];
  /** Expected markers the answer resolved, as written in the case. */
  readonly resolved: readonly string[];
  /** Expected markers the answer did not resolve; `expected` minus `resolved`. */
  readonly missing: readonly string[];
}

/** One graded case. */
export interface EvalResult {
  readonly id: string;
  /** True when `reasons` is empty: every assertion held. */
  readonly passed: boolean;
  /** Every failed assertion, in the order they were checked. Empty on a pass. */
  readonly reasons: readonly EvalFailureReason[];
  /** The answer the runner produced; `''` when it threw or returned nothing usable. */
  readonly answer: string;
  /** True when the runner abstained — by empty answer or by declaring it. */
  readonly abstained: boolean;
  /** `mustContain` phrases the answer did not carry, in the case's order. */
  readonly missingPhrases: readonly string[];
  readonly citations: EvalCitationReport;
  /** Why the runner failed, when it threw; `null` otherwise. */
  readonly error: string | null;
}

/** Counts over one run, plus the rate that refuses to be computed over nothing. */
export interface EvalSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  /** `passed / total`, rounded to three decimals, or `null` when `total` is `0`. */
  readonly passRate: number | null;
}

/** What {@link runEvals} reports. */
export interface EvalRun {
  /** One result per case, in the order the cases were given. */
  readonly results: readonly EvalResult[];
  readonly summary: EvalSummary;
}

// --- Errors ----------------------------------------------------------------

export type EvalHarnessErrorCode =
  | 'invalid-id'
  | 'duplicate-id'
  | 'invalid-question'
  | 'invalid-context'
  | 'invalid-expectation'
  | 'invalid-citation'
  | 'unresolved-citation'
  | 'invalid-runner';

/**
 * A case, a case set or a runner that cannot be measured: a blank or padded id, an id seen
 * twice, a question with no text, a context excerpt without a page, an expectation that
 * asserts nothing, a citation string that is not one marker, or a citation the case's own
 * context cannot honour.
 *
 * All of them are errors rather than warnings because each produces a result that looks
 * fine in a table and means nothing — a case that can never pass, or one that passes on any
 * prose, moves the pass rate without measuring anything.
 */
export class EvalHarnessError extends Error {
  readonly code: EvalHarnessErrorCode;
  /** The case id the refusal is about; empty when no single case is to blame. */
  readonly id: string;

  constructor(code: EvalHarnessErrorCode, id: string, message: string) {
    super(message);
    this.name = 'EvalHarnessError';
    this.code = code;
    this.id = id;
  }
}

// --- Case definition -------------------------------------------------------

/**
 * Validates one case and returns the normalised shape {@link runEvals} grades.
 *
 * Refused, with the code recorded on {@link EvalHarnessError}:
 * - `invalid-id`: `id` is not a string, is blank, or carries leading/trailing whitespace
 *   (the id is the join key between a case and its result; `"a"` and `" a"` would print the
 *   same and join differently);
 * - `invalid-question`: `question` is blank;
 * - `invalid-context`: `context` is not an array, a block has no 1-based integer `page` or
 *   no text, a block id is blank, or an answerable case was given no context at all;
 * - `invalid-expectation`: `kind` is neither `answer` nor `abstain`, a phrase is blank, an
 *   answerable case asserts no phrase and no citation (it would pass on any prose, which
 *   inflates a pass rate), or an abstention case lists citations (a correct abstention has
 *   no answer, so the citation could never resolve);
 * - `invalid-citation`: a citation string does not parse to exactly one marker;
 * - `unresolved-citation`: the marker names a page or a block id that the case's own
 *   context does not carry. A case cannot ask the runner to cite evidence it was never
 *   shown, so that expectation is refused instead of failing every run.
 */
export function defineCase(input: EvalCaseInput): EvalCase {
  if (!isRecord(input)) {
    throw new EvalHarnessError('invalid-id', '', 'A case must be an object with an id, a question, a context and an expected block.');
  }
  const id = readId(input.id);
  const question = readQuestion(input.question, id);
  const context = readContext(input.context, id);
  const expected = readExpectation(input.expected, id, context);
  return { id, question, context, expected };
}

function readId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new EvalHarnessError('invalid-id', '', `A case id must be a string, got ${describe(value)}.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new EvalHarnessError('invalid-id', value, 'A case id must contain at least one non-space character.');
  }
  if (trimmed !== value) {
    throw new EvalHarnessError('invalid-id', value, `Case id ${JSON.stringify(value)} has leading or trailing whitespace.`);
  }
  return value;
}

function readQuestion(value: unknown, id: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EvalHarnessError('invalid-question', id, `${id} needs a question with at least one non-space character.`);
  }
  return value;
}

function readContext(value: unknown, id: string): EvalContextBlock[] {
  if (!Array.isArray(value)) {
    throw new EvalHarnessError('invalid-context', id, `${id} needs a context array; pass [] for a case with no excerpts.`);
  }
  const blocks: EvalContextBlock[] = [];
  value.forEach((entry, position) => {
    if (!isRecord(entry)) {
      throw new EvalHarnessError('invalid-context', id, `${id} context entry ${position} is not an object.`);
    }
    const page = entry.page;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) {
      throw new EvalHarnessError('invalid-context', id, `${id} context entry ${position} needs a 1-based integer page.`);
    }
    const text = entry.text;
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new EvalHarnessError('invalid-context', id, `${id} context entry ${position} needs non-empty text.`);
    }
    const blockId = entry.blockId;
    if (blockId !== undefined && (typeof blockId !== 'string' || blockId.trim().length === 0)) {
      throw new EvalHarnessError('invalid-context', id, `${id} context entry ${position} has a blank block id.`);
    }
    if (typeof blockId === 'string') blocks.push({ page, text, blockId: blockId.trim() });
    else blocks.push({ page, text });
  });
  return blocks;
}

function readExpectation(value: unknown, id: string, context: readonly EvalContextBlock[]): EvalExpectation {
  if (!isRecord(value)) {
    throw new EvalHarnessError('invalid-expectation', id, `${id} needs an expected block with a kind.`);
  }
  const kind = value.kind;
  if (kind !== 'answer' && kind !== 'abstain') {
    throw new EvalHarnessError('invalid-expectation', id, `${id} has kind ${describe(kind)}; a case is 'answer' or 'abstain'.`);
  }
  const mustContain = readPhrases(value.mustContain, id);
  const citations = readCitationMarkers(value.citations, id, context);

  if (kind === 'answer' && context.length === 0) {
    throw new EvalHarnessError('invalid-context', id, `${id} expects an answer but has no context; the runner would be asked to answer from nothing.`);
  }
  if (kind === 'abstain' && citations.length > 0) {
    throw new EvalHarnessError('invalid-expectation', id, `${id} expects an abstention but lists citations; an abstention carries no answer, so no citation could resolve.`);
  }
  if (kind === 'answer' && mustContain.length === 0 && citations.length === 0) {
    throw new EvalHarnessError('invalid-expectation', id, `${id} expects an answer but asserts no phrase and no citation; such a case passes on any prose.`);
  }

  return { kind, mustContain, citations };
}

function readPhrases(value: unknown, id: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new EvalHarnessError('invalid-expectation', id, `${id} has a mustContain that is not an array.`);
  }
  const phrases: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new EvalHarnessError('invalid-expectation', id, `${id} has a blank mustContain phrase.`);
    }
    phrases.push(entry.trim());
  }
  return phrases;
}

function readCitationMarkers(value: unknown, id: string, context: readonly EvalContextBlock[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new EvalHarnessError('invalid-citation', id, `${id} has a citations list that is not an array.`);
  }
  const markers: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new EvalHarnessError('invalid-citation', id, `${id} has a citation that is not a string: ${describe(entry)}.`);
    }
    const text = entry.trim();
    const parsed = parseCitations(text).citations;
    if (parsed.length !== 1) {
      throw new EvalHarnessError(
        'invalid-citation',
        id,
        `${id} expects ${JSON.stringify(entry)}, which is ${parsed.length === 0 ? 'not a citation marker' : 'more than one marker'}; give exactly one marker such as [p12] or [p12:r3].`,
      );
    }
    const target = parsed[0] === undefined ? null : targetOf(parsed[0]);
    if (target === null) {
      throw new EvalHarnessError('invalid-citation', id, `${id} could not read the target of ${JSON.stringify(entry)}.`);
    }
    resolveInContext(target, context, id);
    markers.push(text);
  }
  return markers;
}

/**
 * Refuses an expectation naming evidence the case does not supply. Page-only expectations
 * accept any citation on that page; a block expectation needs the block id the context
 * declared, on the page the context put it on.
 */
function resolveInContext(target: CitationTarget, context: readonly EvalContextBlock[], id: string): void {
  if (target.blockId !== null) {
    const block = context.find(entry => entry.blockId === target.blockId);
    if (block === undefined) {
      throw new EvalHarnessError(
        'unresolved-citation',
        id,
        `${id} expects a citation to block ${target.blockId}, but no context block declares that id.`,
      );
    }
    if (target.page !== null && target.page !== block.page) {
      throw new EvalHarnessError(
        'unresolved-citation',
        id,
        `${id} expects page ${target.page} for block ${target.blockId}, but the context puts that block on page ${block.page}.`,
      );
    }
    return;
  }
  const pages = new Set(context.map(entry => entry.page));
  if (target.page === null || !pages.has(target.page)) {
    throw new EvalHarnessError(
      'unresolved-citation',
      id,
      `${id} expects a citation to page ${target.page === null ? 'none' : String(target.page)}, which the context does not carry.`,
    );
  }
}

// --- Running ---------------------------------------------------------------

/**
 * Grades every case against the runner.
 *
 * Cases are validated as a set first: a duplicate id is refused with `duplicate-id` before
 * the runner is called at all, because results are joined on the id and one case would
 * otherwise be graded twice. Cases then run one at a time, in the order given, so a
 * synchronous runner produces a deterministic order and an async one is not raced against
 * itself.
 *
 * A runner that throws or returns something that is not a candidate fails the case with
 * `runner-error`; the run continues, so one broken case does not hide the other twenty.
 * The answer is graded by {@link gradeResult}: an answerable case needs every phrase, every
 * expected citation, and an actual answer; an unanswerable case needs an abstention.
 */
export async function runEvals(cases: readonly EvalCase[], runner: EvalRunner): Promise<EvalRun> {
  if (typeof runner !== 'function') {
    throw new EvalHarnessError('invalid-runner', '', 'runEvals needs a runner function: (question, context) => candidate.');
  }
  const list: readonly EvalCase[] = Array.isArray(cases) ? cases : [];
  const seen = new Set<string>();
  for (const item of list) {
    const id = typeof item?.id === 'string' ? item.id : '';
    if (id.trim().length === 0) {
      throw new EvalHarnessError('invalid-id', id, 'Every case in the set needs a non-empty id.');
    }
    if (seen.has(id)) {
      throw new EvalHarnessError(
        'duplicate-id',
        id,
        `Case id ${JSON.stringify(id)} appears more than once; results are joined on the id, so a duplicate would grade one case twice.`,
      );
    }
    seen.add(id);
  }

  const results: EvalResult[] = [];
  for (const item of list) results.push(await gradeCase(item, runner));

  const passed = results.filter(result => result.passed).length;
  const total = results.length;
  return { results, summary: { total, passed, failed: total - passed, passRate: rate(passed, total) } };
}

/** Runs one case, turns whatever the runner did into a candidate or an error, and grades it. */
async function gradeCase(item: EvalCase, runner: EvalRunner): Promise<EvalResult> {
  let candidate: EvalCandidate | null = null;
  let error: string | null = null;

  try {
    const produced: unknown = await runner(item.question, item.context);
    candidate = readCandidate(produced);
    if (candidate === null) error = 'the runner returned no candidate answer';
  } catch (thrown) {
    error = messageOf(thrown);
  }

  const answer = candidate === null ? '' : candidate.answer;
  const empty = answer.trim().length === 0;
  const declared = candidate !== null && candidate.abstained === true;
  // A throw is not a decision not to answer, so it never counts as an abstention.
  const abstained = error === null && (declared || empty);

  const found: CitationTarget[] = [];
  for (const marker of parseCitations(answer).citations) found.push(targetOf(marker));
  appendStatedCitations(found, candidate === null ? undefined : candidate.citations);

  return gradeResult(item, { answer, abstained, empty, error, found });
}

/** Reads whatever the runner returned as a candidate, or `null` when it is not one. */
function readCandidate(value: unknown): EvalCandidate | null {
  if (!isRecord(value) || typeof value.answer !== 'string') return null;
  const citations = Array.isArray(value.citations)
    ? value.citations.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const base: EvalCandidate = citations === undefined ? { answer: value.answer } : { answer: value.answer, citations };
  return value.abstained === true ? { ...base, abstained: true } : base;
}

/** The numbers one case is graded from, after the runner's output was read. */
interface GradedInput {
  readonly answer: string;
  readonly abstained: boolean;
  readonly empty: boolean;
  readonly error: string | null;
  readonly found: readonly CitationTarget[];
}

function gradeResult(item: EvalCase, input: GradedInput): EvalResult {
  const expectedCitations = item.expected.citations;
  const reasons: EvalFailureReason[] = [];
  const missingPhrases: string[] = [];
  const resolved: string[] = [];
  const missing: string[] = [];

  if (input.error !== null) {
    reasons.push('runner-error');
    missingPhrases.push(...item.expected.mustContain);
    missing.push(...expectedCitations);
  } else if (item.expected.kind === 'abstain') {
    if (!input.abstained) {
      reasons.push('answered-unanswerable');
    } else {
      collectMissingPhrases(input.answer, item.expected.mustContain, missingPhrases);
      if (missingPhrases.length > 0) reasons.push('missing-phrase');
    }
  } else if (input.abstained) {
    // The case wanted an answer and got a decision not to give one. Every phrase and
    // citation is missing by construction, so only the decision is reported.
    reasons.push(input.empty ? 'empty-answer' : 'unexpected-abstention');
    missingPhrases.push(...item.expected.mustContain);
    missing.push(...expectedCitations);
  } else {
    collectMissingPhrases(input.answer, item.expected.mustContain, missingPhrases);
    if (missingPhrases.length > 0) reasons.push('missing-phrase');
    for (const marker of expectedCitations) {
      const target = targetOfMarker(marker);
      if (target !== null && input.found.some(citation => sameTarget(target, citation))) resolved.push(marker);
      else missing.push(marker);
    }
    if (missing.length > 0) reasons.push('missing-citation');
  }

  return {
    id: item.id,
    passed: reasons.length === 0,
    reasons,
    answer: input.answer,
    abstained: input.abstained,
    missingPhrases,
    citations: { expected: [...expectedCitations], resolved, missing },
    error: input.error,
  };
}

// --- Metrics ---------------------------------------------------------------

/** Precision every rate in this module reports, in decimal places. */
const RATE_SCALE = 1000;

/**
 * A share in `0..1`, rounded to three decimals, or `null` when there is nothing to divide.
 *
 * This is the aggregation rule the whole harness uses: {@link EvalSummary.passRate},
 * {@link abstentionAccuracy} and {@link citationHitRate} all go through it. A rate over
 * zero cases is `null` rather than `0`, because "no case measured this" and "every case
 * failed" are different facts and only the second one is evidence. `part` is clamped to
 * `0..total`, so a double count cannot report more than everything.
 */
export function rate(part: number, total: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || part < 0 || total <= 0) return null;
  return Math.round((Math.min(part, total) / total) * RATE_SCALE) / RATE_SCALE;
}

/**
 * The share of unanswerable cases where the runner abstained.
 *
 * The denominator is the unanswerable cases present in `results`, not the cases handed in:
 * a case that was never run cannot be credited or blamed. An answerable case is ignored
 * here even when the runner abstained on it — that failure is a failed result in
 * {@link runEvals}, not a fall in abstention accuracy, and mixing the two would let good
 * abstention hide bad answers.
 *
 * Returns `null` when no unanswerable case has a result.
 */
export function abstentionAccuracy(cases: readonly EvalCase[], results: readonly EvalResult[]): number | null {
  const unanswerable = new Set<string>();
  for (const item of Array.isArray(cases) ? cases : []) {
    if (item?.expected?.kind === 'abstain') unanswerable.add(item.id);
  }
  const observed = new Set<string>();
  let abstained = 0;

  for (const result of Array.isArray(results) ? results : []) {
    const id = typeof result?.id === 'string' ? result.id : '';
    if (!unanswerable.has(id) || observed.has(id)) continue;
    observed.add(id);
    if (result.abstained === true) abstained += 1;
  }

  return rate(abstained, observed.size);
}

/**
 * The share of expected citations the answers resolved, over every result.
 *
 * Micro-average, not per case: a case that asks for two citations and gets one contributes
 * one hit out of two, so a missing citation in a well-cited answer still moves the number.
 * The count comes from the `citations` report on each result, so a runner error or an
 * abstention contributes its expectations with nothing resolved.
 *
 * Returns `null` when no result expected a citation at all.
 */
export function citationHitRate(results: readonly EvalResult[]): number | null {
  let expected = 0;
  let resolved = 0;
  for (const result of Array.isArray(results) ? results : []) {
    const report = result?.citations;
    if (report === undefined || report === null) continue;
    expected += Array.isArray(report.expected) ? report.expected.length : 0;
    resolved += Array.isArray(report.resolved) ? report.resolved.length : 0;
  }
  return rate(resolved, expected);
}

// --- Citations -------------------------------------------------------------

/** A citation target: the page and/or block id a marker names. */
interface CitationTarget {
  readonly page: number | null;
  readonly blockId: string | null;
}

function targetOf(marker: CitationMarker): CitationTarget {
  const blockId = typeof marker.blockId === 'string' && marker.blockId.length > 0 ? marker.blockId : null;
  const page = typeof marker.page === 'number' && Number.isInteger(marker.page) ? marker.page : null;
  return { page, blockId };
}

/** The one target a marker string names, or `null` when it is not exactly one marker. */
function targetOfMarker(text: string): CitationTarget | null {
  const parsed = parseCitations(text).citations;
  if (parsed.length !== 1) return null;
  const only = parsed[0];
  return only === undefined ? null : targetOf(only);
}

/**
 * True when an answer's citation honours an expectation.
 *
 * A block expectation needs that block id; a page the answer also names must agree, but a
 * block-only answer marker resolves, because the id is the stronger identity. A page
 * expectation is met by any citation on that page, including one that also names a block.
 */
function sameTarget(expected: CitationTarget, actual: CitationTarget): boolean {
  if (expected.blockId !== null) {
    if (actual.blockId !== expected.blockId) return false;
    return expected.page === null || actual.page === null || actual.page === expected.page;
  }
  return expected.page !== null && actual.page === expected.page;
}

/** Reads citation markers listed beside the answer into targets, ignoring unreadable ones. */
function appendStatedCitations(targets: CitationTarget[], citations: unknown): void {
  if (!Array.isArray(citations)) return;
  for (const entry of citations) {
    if (typeof entry !== 'string') continue;
    const target = targetOfMarker(entry);
    if (target !== null) targets.push(target);
  }
}

// --- Phrases ---------------------------------------------------------------

const WHITESPACE = /\s+/gu;

/**
 * Normalises one side of a phrase check: runs of whitespace become one space, the edges are
 * trimmed, and case is folded. Diacritics stay, so a wrong accent is still a wrong phrase.
 */
function normalizeForMatch(text: string): string {
  return text.replace(WHITESPACE, ' ').trim().toLowerCase();
}

/**
 * True when `answer` contains `phrase` after {@link normalizeForMatch}. A phrase that
 * normalises to nothing is never found; `defineCase` refuses blank phrases, so this only
 * guards a hand-built case.
 */
function containsPhrase(answer: string, phrase: string): boolean {
  const needle = normalizeForMatch(phrase);
  if (needle.length === 0) return false;
  return normalizeForMatch(answer).includes(needle);
}

function collectMissingPhrases(answer: string, mustContain: readonly string[], missing: string[]): void {
  for (const phrase of mustContain) {
    if (!containsPhrase(answer, phrase)) missing.push(phrase);
  }
}

// --- Small helpers ---------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message.length > 0 ? thrown.message : thrown.name;
  return String(thrown);
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

// --- The shipped case set --------------------------------------------------

/**
 * The cases this repository measures itself on.
 *
 * Small and synthetic on purpose: four cases about the fictional Aurora M4 battery module,
 * written to exercise an answer with a page citation, an answer with several expected
 * phrases, a Vietnamese answer with a `(trang 5)` marker, and an unanswerable question that
 * must abstain. They are a fixed set to keep the harness honest while real documents are
 * missing — not a sample of the product's difficulty, and not evidence that the pipeline is
 * good. `docs/evaluation.md` says so where a reader will see it.
 */
export const SHIPPED_EVAL_CASES: readonly EvalCase[] = [
  defineCase({
    id: 'aurora-charge-time',
    question: 'How long does a full charge of the Aurora M4 take?',
    context: [
      {
        page: 2,
        blockId: 'p2-r1',
        text: 'A full charge of the Aurora M4 takes four hours from empty to 100 percent.',
      },
    ],
    expected: { kind: 'answer', mustContain: ['four hours'], citations: ['[p2]'] },
  }),
  defineCase({
    id: 'aurora-operating-range',
    question: 'What is the operating temperature range of the Aurora M4?',
    context: [
      {
        page: 3,
        blockId: 'p3-r2',
        text: 'The Aurora M4 operates between -20 °C and 60 °C. Above 60 °C the output power is derated.',
      },
    ],
    expected: { kind: 'answer', mustContain: ['-20 °C', '60 °C'], citations: ['[#p3-r2]'] },
  }),
  defineCase({
    id: 'aurora-vi-warranty',
    question: 'Bảo hành của Aurora M4 kéo dài bao lâu?',
    context: [
      {
        page: 5,
        blockId: 'p5-r1',
        text: 'Aurora M4 được bảo hành hai năm kể từ ngày mua.',
      },
    ],
    expected: { kind: 'answer', mustContain: ['hai năm'], citations: ['(trang 5)'] },
  }),
  defineCase({
    id: 'aurora-water-damage',
    question: 'Does the Aurora M4 warranty cover water damage?',
    context: [
      {
        page: 2,
        blockId: 'p2-r1',
        text: 'A full charge of the Aurora M4 takes four hours from empty to 100 percent.',
      },
      {
        page: 5,
        blockId: 'p5-r1',
        text: 'Aurora M4 được bảo hành hai năm kể từ ngày mua.',
      },
    ],
    expected: { kind: 'abstain' },
  }),
];
