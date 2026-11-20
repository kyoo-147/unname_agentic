/**
 * Human review queue for extracted fields (backlog K05).
 *
 * Extraction (`src/core/schema.ts`) answers with a value, the place it came
 * from, and a confidence. A confidence is not a decision, so this module keeps
 * the fields that need a person in a queue, records exactly one decision per
 * field with who made it and what changed, and applies those decisions back
 * onto the extraction result:
 *
 *     const queue = new ReviewQueue({ schema });
 *     queue.fromExtraction(extraction.fields, 0.7);
 *     queue.edit('total', '1.240,00');
 *     const applied = applyTo(extraction.fields, queue.exportDecisions());
 *
 * `fromExtraction` enqueues two kinds of field and nothing else: a field whose
 * confidence is *below* the threshold, and a field whose validation failed.
 * The reason stays on the entry (`low-confidence`, `invalid`; a field enqueued
 * by hand is `manual`). The `ambiguous:label@<blockId>` notes extraction adds
 * are not validation failures, so a value found twice at 0.9 stays out of the
 * queue — ambiguity is a review note, not a defect.
 *
 * A decision is one record, and only one:
 *
 * | Action            | Status     | `previous`      | `value`         |
 * | ----------------- | ---------- | --------------- | --------------- |
 * | `accept(id)`      | `accepted` | extracted value | extracted value |
 * | `edit(id, value)` | `edited`   | extracted value | the new value   |
 * | `reject(id)`      | `rejected` | extracted value | `null`          |
 *
 * `previous` and `value` are what make the trail readable: a reviewer can see
 * that `1234.56` became `1200`, or that a value was refused, without a second
 * store. Once a field carries a decision it is closed: a second `accept`,
 * `reject` or `edit` returns the typed {@link AlreadyDecided} result and
 * changes nothing, so a stale screen cannot overwrite a colleague's call.
 *
 * An edit is validated with the field's own `FieldSchema` through
 * `validateValue`, so a date typed as `31/02/2024` and an amount typed as `abc`
 * are refused with the problem codes extraction uses, and the queue entry is
 * left untouched. An accepted value is stored trimmed and verbatim in the
 * decision: normalising a human's answer would hide what they actually typed,
 * and `applyTo` reports the decision as it was made.
 *
 * A queue entry keeps the value extraction produced, so `decision.previous`
 * always equals the entry's `value` and the trail can be checked without a
 * second store. What the reviewer chose lives in `decision.value`, which is
 * what `applyTo` puts on the field.
 *
 * `exportDecisions()` writes a stable document — `kind`, `schemaVersion`, and
 * one record per decided field, sorted by id — so two queues that reached the
 * same decisions produce byte-identical JSON whatever order they were filled
 * in. `applyTo(fields, decisions)` accepts that JSON text, the parsed document,
 * or a bare record array, and returns one entry per input field: accepted and
 * edited fields carry the decided value, a rejected field is kept with
 * `value: ''` and `missing: true`, and an undecided field is `pending`. A
 * rejection is never a silent disappearance — the record keeps its `raw` text,
 * page, block id and rect, so a reader can still jump to what was refused.
 *
 * Boundaries that are deliberate:
 * - The queue lives in memory. Persistence is the caller's job; `exportDecisions`
 *   is the whole serialisable state, and `applyTo` is the way back.
 * - `applyTo` does not re-validate. `valid` and `problems` in its result describe
 *   the extraction, while `status` and `missing` describe the decision; a human
 *   who edits an invalid value to a good one leaves `valid: false` behind, and
 *   `status: 'edited'` is what says the value is now a person's.
 * - Without a schema, an edit can only be checked for emptiness (a blank value
 *   is `required`). A queue built with the schema that produced the extraction
 *   gets the full per-type check; that is the path the app uses.
 * - Thresholds are strict: a field exactly at the threshold is not enqueued.
 * - `enqueue` is idempotent by field id. Re-enqueueing a pending field refreshes
 *   its value and reasons; re-enqueueing a decided field returns the decision
 *   untouched, so a re-extraction cannot discard a review.
 */

import { AMBIGUOUS_LABEL_PREFIX, validateValue } from './schema';
import type { ExtractedField, FieldSchema } from './schema';
import type { Rect } from './types';

/** One review state a field can be in. */
export type ReviewStatus = 'pending' | 'accepted' | 'rejected' | 'edited';

/** Every status, in the order `stats()` reports them. */
export const REVIEW_STATUSES: readonly ReviewStatus[] = ['pending', 'accepted', 'rejected', 'edited'];

/** Why a field is in the queue. */
export type ReviewReason = 'low-confidence' | 'invalid' | 'manual';

/** Every reason, in the order a queue entry reports them. */
export const REVIEW_REASONS: readonly ReviewReason[] = ['low-confidence', 'invalid', 'manual'];

/** Who made a decision: a person, or a rule the caller applied. */
export type DecisionBy = 'human' | 'rule';

/** What one decision did to one field. */
export interface ReviewDecision {
  by: DecisionBy;
  /** Epoch milliseconds from the queue's clock; the module never reads a clock itself. */
  at: number;
  /** The value the field carried before this decision. */
  previous: string;
  /** The value after it; `null` when the field was rejected. */
  value: string | null;
}

/** One extraction entry under review, with its state. */
export interface ReviewItem extends ExtractedField {
  /** Why the field is queued, in canonical order; never empty. */
  reasons: ReviewReason[];
  status: ReviewStatus;
  /** Recorded decision, or `null` while pending. A decision's `value` is the decided one. */
  decision: ReviewDecision | null;
}

/** A field after decisions have been applied to it. */
export interface AppliedField extends ExtractedField {
  /** True when a rejection removed the value; the field itself is never dropped. */
  missing: boolean;
  status: ReviewStatus;
  decision: ReviewDecision | null;
}

/** Schema version written by `exportDecisions` and the only version `applyTo` reads. */
export const REVIEW_SCHEMA_VERSION = 1;

/** `kind` written into an exported decisions document. */
export const DECISIONS_KIND = 'review-decisions';

/** One decided field as it appears in an exported document. */
export interface DecisionRecord {
  id: string;
  /** A decided status; a pending field has no record. */
  status: Exclude<ReviewStatus, 'pending'>;
  decision: ReviewDecision;
}

/** The stable JSON document `exportDecisions` writes. */
export interface DecisionsDocument {
  schemaVersion: number;
  kind: typeof DECISIONS_KIND;
  /** One record per decided field, sorted by id. */
  fields: DecisionRecord[];
}

/** Accepted inputs for `applyTo`: exported JSON text, the document, or its records. */
export type DecisionsInput = string | DecisionsDocument | readonly DecisionRecord[];

/** The decision was recorded and the field is now closed. */
export interface Decided {
  kind: 'decided';
  ok: true;
  /** The queue entry after the decision, including the decision itself. */
  item: ReviewItem;
  decision: ReviewDecision;
}

/** The field already carries a decision, and a second one is refused. */
export interface AlreadyDecided {
  kind: 'already-decided';
  ok: false;
  id: string;
  /** The entry as it stands; `item.decision` is the decision that won. */
  item: ReviewItem;
}

/** No field with that id is in the queue. */
export interface UnknownField {
  kind: 'unknown-field';
  ok: false;
  id: string;
}

/** An edit the field type refused; the queue entry is unchanged. */
export interface InvalidEdit {
  kind: 'invalid-value';
  ok: false;
  id: string;
  /** Validation problem codes, in the vocabulary `schema.ts` uses. */
  problems: string[];
}

/** Every outcome of deciding one field. Narrow on `kind` or on `ok`. */
export type ReviewResult = Decided | AlreadyDecided | UnknownField | InvalidEdit;

/** Every refusal a decision can return. */
export type ReviewRefusal = AlreadyDecided | UnknownField | InvalidEdit;

/** Bulk decisions a reviewer can apply without per-field values. */
export type BulkAction = 'accept' | 'reject';

/** What one `bulk` call did, in input order. */
export interface BulkReport {
  /** Ids whose decision was recorded. */
  applied: string[];
  /** One entry per refused id, in input order. */
  refused: ReviewRefusal[];
}

/** Filter accepted by `list`; `status` may be one status or several. */
export interface ReviewListFilter {
  status?: ReviewStatus | readonly ReviewStatus[];
}

/** Counts over the whole queue. */
export interface ReviewStats {
  /** Fields ever enqueued. */
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  edited: number;
  /** `total - pending`, so the audit trail can be checked at a glance. */
  decided: number;
  byReason: Record<ReviewReason, number>;
}

export interface ReviewQueueOptions {
  /** Field schemas used to validate edits, looked up by field id. */
  schema?: readonly FieldSchema[];
  /** Clock used to stamp decisions, in epoch milliseconds; defaults to `Date.now`. */
  now?: () => number;
}

export type ReviewErrorCode =
  | 'malformed-field'
  | 'invalid-threshold'
  | 'invalid-decision-by'
  | 'invalid-action'
  | 'malformed-decisions'
  | 'duplicate-decision'
  | 'unsupported-schema-version';

/**
 * A queue or decisions input that cannot be used as written. `message` starts
 * with the offending path (`fields[2].status`), so a caller can locate it.
 */
export class ReviewError extends Error {
  readonly code: ReviewErrorCode;

  constructor(code: ReviewErrorCode, message: string) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
  }
}

/** The decided statuses, in the order a refusal message lists them. */
const DECIDED_STATUSES: readonly Exclude<ReviewStatus, 'pending'>[] = ['accepted', 'rejected', 'edited'];

/** An in-memory review queue; one decision per field, recorded for the audit trail. */
export class ReviewQueue {
  private readonly items = new Map<string, ReviewItem>();
  private readonly schemaById = new Map<string, FieldSchema>();
  private readonly clock: () => number;

  constructor(options: ReviewQueueOptions = {}) {
    const schema = options.schema ?? [];
    if (!Array.isArray(schema)) {
      fail('malformed-field', 'schema', 'must be an array of field schemas.');
    }
    schema.forEach((entry, index) => {
      const field = schemaEntry(entry, `schema[${index}]`);
      this.schemaById.set(field.id, field);
    });

    const now = options.now;
    if (now !== undefined && typeof now !== 'function') {
      fail('malformed-field', 'now', 'must be a function returning epoch milliseconds.');
    }
    this.clock = now ?? (() => Date.now());
  }

  /**
   * Adds one extracted field to the queue and returns its entry.
   *
   * The entry is a copy: the caller keeps its extraction result and the queue
   * keeps the values its decisions refer to. Without explicit reasons the entry
   * is `invalid` when validation failed and `manual` otherwise. An id already in
   * the queue is not duplicated: a pending entry is refreshed, a decided entry
   * is returned untouched so a re-extraction cannot discard a review.
   */
  enqueue(field: ExtractedField, reasons?: readonly ReviewReason[]): ReviewItem {
    const copy = copyField(field);
    const existing = this.items.get(copy.id);
    const entry: ReviewItem = {
      ...copy,
      reasons: resolveReasons(reasons, copy),
      status: 'pending',
      decision: null,
    };

    if (existing) {
      if (existing.status !== 'pending') return existing;
      this.items.set(copy.id, entry);
      return entry;
    }

    this.items.set(copy.id, entry);
    return entry;
  }

  /**
   * Enqueues every field of one extraction that is not certain: below
   * `threshold`, or failing validation. Returns the selected entries in input
   * order, including an already-decided entry that comes back unchanged.
   *
   * A threshold outside 0..1 is refused with `invalid-threshold`, because a
   * mistyped threshold would otherwise enqueue nothing or everything in silence.
   */
  fromExtraction(fields: readonly ExtractedField[], threshold: number): ReviewItem[] {
    const limit = readThreshold(threshold);
    if (!Array.isArray(fields)) {
      fail('malformed-field', 'fields', 'must be an array of extracted fields.');
    }

    const selected: ReviewItem[] = [];
    for (const field of fields) {
      const reasons = reviewReasons(field, limit);
      if (reasons.length === 0) continue;
      selected.push(this.enqueue(field, reasons));
    }
    return selected;
  }

  /** The queue entries in enqueue order, optionally filtered by status. */
  list(filter: ReviewListFilter = {}): ReviewItem[] {
    const wanted = statusSet(filter.status);
    const items = [...this.items.values()];
    return wanted === null ? items : items.filter(item => wanted.has(item.status));
  }

  /** Accepts the extracted value as it stands. */
  accept(id: string, by: DecisionBy = 'human'): ReviewResult {
    return this.decide(id, by, item => ({ status: 'accepted', value: item.value }));
  }

  /** Refuses the extracted value; `applyTo` will mark the field missing. */
  reject(id: string, by: DecisionBy = 'human'): ReviewResult {
    return this.decide(id, by, () => ({ status: 'rejected', value: null }));
  }

  /**
   * Records a replacement value after the field's own type accepts it.
   *
   * The chosen value lives in `decision.value`; the entry keeps the extracted
   * value as evidence, so `decision.previous` stays checkable. An empty edit is
   * a real answer for an optional field and a `required` problem for a required
   * one. A refused edit records no decision, so the field stays pending and can
   * be corrected.
   */
  edit(id: string, value: string, by: DecisionBy = 'human'): ReviewResult {
    const decisionBy = readDecisionBy(by);
    const key = readId(id);
    const item = this.items.get(key);
    if (!item) return { kind: 'unknown-field', ok: false, id: key };
    if (item.status !== 'pending') return alreadyDecided(item);

    if (typeof value !== 'string') {
      return { kind: 'invalid-value', ok: false, id: key, problems: ['malformed-value'] };
    }
    const text = value.trim();
    const problems = this.problemsFor(key, text);
    if (problems.length > 0) return { kind: 'invalid-value', ok: false, id: key, problems };

    return this.close(item, 'edited', text, decisionBy);
  }

  /**
   * Applies `accept` or `reject` to several fields at once. Every id is
   * attempted, so one closed or unknown field does not stop the batch; the
   * report says which ids were applied and why the rest were refused.
   */
  bulk(ids: readonly string[], action: BulkAction, by: DecisionBy = 'human'): BulkReport {
    const decisionBy = readDecisionBy(by);
    const verb = readBulkAction(action);
    if (!Array.isArray(ids)) fail('malformed-field', 'ids', 'must be an array of field ids.');

    const applied: string[] = [];
    const refused: ReviewRefusal[] = [];
    for (const id of ids) {
      const result = verb === 'accept' ? this.accept(id, decisionBy) : this.reject(id, decisionBy);
      if (result.ok) applied.push(result.item.id);
      else refused.push(result);
    }
    return { applied, refused };
  }

  /** Counts per status plus how often each queue reason appears. */
  stats(): ReviewStats {
    const counts: Record<ReviewStatus, number> = { pending: 0, accepted: 0, rejected: 0, edited: 0 };
    const byReason: Record<ReviewReason, number> = { 'low-confidence': 0, invalid: 0, manual: 0 };
    for (const item of this.items.values()) {
      counts[item.status] += 1;
      for (const reason of item.reasons) byReason[reason] += 1;
    }

    return {
      total: this.items.size,
      pending: counts.pending,
      accepted: counts.accepted,
      rejected: counts.rejected,
      edited: counts.edited,
      decided: this.items.size - counts.pending,
      byReason,
    };
  }

  /**
   * The decided fields as stable JSON: one record per field, sorted by id, with
   * the decision's own fields in a fixed order. Pending fields are absent
   * because they have nothing to record yet.
   */
  exportDecisions(): string {
    return JSON.stringify(this.decisions(), null, 2);
  }

  private decisions(): DecisionsDocument {
    const fields: DecisionRecord[] = [];
    for (const item of this.items.values()) {
      if (item.status === 'pending' || item.decision === null) continue;
      fields.push({ id: item.id, status: item.status, decision: copyDecision(item.decision) });
    }
    fields.sort(compareRecords);
    return { schemaVersion: REVIEW_SCHEMA_VERSION, kind: DECISIONS_KIND, fields };
  }

  /** Shared front half of every single-field decision: input, lookup, state. */
  private decide(
    id: string,
    by: DecisionBy,
    outcome: (item: ReviewItem) => { status: Exclude<ReviewStatus, 'pending'>; value: string | null },
  ): ReviewResult {
    const decisionBy = readDecisionBy(by);
    const key = readId(id);
    const item = this.items.get(key);
    if (!item) return { kind: 'unknown-field', ok: false, id: key };
    if (item.status !== 'pending') return alreadyDecided(item);

    const decided = outcome(item);
    return this.close(item, decided.status, decided.value, decisionBy);
  }

  private close(
    item: ReviewItem,
    status: Exclude<ReviewStatus, 'pending'>,
    value: string | null,
    by: DecisionBy,
  ): Decided {
    const decision: ReviewDecision = {
      by,
      at: this.stamp(),
      previous: item.value,
      value,
    };
    const decided: ReviewItem = { ...item, status, decision };
    this.items.set(item.id, decided);
    return { kind: 'decided', ok: true, item: decided, decision: copyDecision(decision) };
  }

  /** Validation problems for one edit, using the schema when the queue knows it. */
  private problemsFor(id: string, value: string): string[] {
    const schema = this.schemaById.get(id);
    if (schema !== undefined) return validateValue(schema, value);
    return value.trim() === '' ? ['required'] : [];
  }

  private stamp(): number {
    const at = this.clock();
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      fail('malformed-field', 'now', 'must return a finite epoch millisecond timestamp.');
    }
    return at;
  }
}

/**
 * Applies recorded decisions to the extraction entries they refer to.
 *
 * Every input field comes back, in input order: an accepted or edited field
 * carries the decided value, a rejected field carries `value: ''` and
 * `missing: true` while keeping its `raw` evidence, and a field with no
 * decision is `pending`. A decision for an id that is not among `fields` is
 * ignored, because one export can cover several documents.
 *
 * The decisions may be the exported JSON text, the parsed document, or a bare
 * record array. A document with an unknown `schemaVersion`, a wrong `kind`, two
 * records for one id, or a record whose status and value disagree is refused
 * with a {@link ReviewError} rather than applied half-way.
 */
export function applyTo(fields: readonly ExtractedField[], decisions: DecisionsInput): AppliedField[] {
  if (!Array.isArray(fields)) {
    fail('malformed-field', 'fields', 'must be an array of extracted fields.');
  }

  const records = parseDecisions(decisions);
  const byId = new Map<string, DecisionRecord>();
  records.forEach((record, index) => {
    if (byId.has(record.id)) {
      fail('duplicate-decision', `fields[${index}].id`, `field "${record.id}" is decided more than once.`);
    }
    byId.set(record.id, record);
  });

  return fields.map((field): AppliedField => {
    const copy = copyField(field);
    const record = byId.get(copy.id);
    if (!record) return { ...copy, missing: false, status: 'pending', decision: null };

    const decision = copyDecision(record.decision);
    if (record.status === 'rejected') {
      return { ...copy, value: '', missing: true, status: 'rejected', decision };
    }
    return {
      ...copy,
      value: decision.value === null ? copy.value : decision.value,
      missing: false,
      status: record.status,
      decision,
    };
  });
}

/** Reads a decisions document, its JSON text, or a bare record array. */
export function parseDecisions(input: DecisionsInput): DecisionRecord[] {
  let raw: unknown = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch (error) {
      fail('malformed-decisions', 'decisions', `is not valid JSON: ${errorMessage(error)}`);
    }
  }

  return decisionEntries(raw).map(readRecord);
}

// --- Reading fields, reasons and decisions ---------------------------------

/**
 * One schema entry, already compiled by `defineSchema`; the queue only indexes
 * it by id. `validateValue` re-checks the type itself at use, so an entry whose
 * `type` is not a known one still cannot validate anything it should refuse.
 */
function schemaEntry(entry: unknown, path: string): FieldSchema {
  if (!isRecord(entry)) fail('malformed-field', path, 'must be a field schema object.');
  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (id === '') fail('malformed-field', `${path}.id`, 'must be a non-empty string.');
  return { ...entry, id } as unknown as FieldSchema;
}

function copyField(value: ExtractedField): ExtractedField {
  if (!isRecord(value)) fail('malformed-field', 'field', 'must be an extracted field object.');
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (id === '') fail('malformed-field', 'field.id', 'must be a non-empty string.');

  const problems = problemsOf(value);
  return {
    id,
    value: typeof value.value === 'string' ? value.value : '',
    raw: typeof value.raw === 'string' ? value.raw : '',
    page: pageOf(value.page),
    blockId: typeof value.blockId === 'string' ? value.blockId : '',
    rect: rectOf(value.rect),
    confidence: confidenceOf(value.confidence),
    // `valid` means "no validation problem" in `schema.ts`; recomputing it from
    // the problems keeps a hand-built entry from claiming both at once. The
    // ambiguity notes extraction adds are not validation failures.
    valid: value.valid !== false && !hasValidationProblem(value),
    problems,
  };
}

function problemsOf(value: ExtractedField): string[] {
  const problems = Array.isArray(value.problems) ? value.problems : [];
  return problems.filter(problem => typeof problem === 'string');
}

function hasValidationProblem(value: ExtractedField): boolean {
  if (value.valid === false) return true;
  return problemsOf(value).some(problem => !problem.startsWith(AMBIGUOUS_LABEL_PREFIX));
}

function reviewReasons(field: ExtractedField, threshold: number): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  if (confidenceOf(field.confidence) < threshold) reasons.push('low-confidence');
  if (hasValidationProblem(field)) reasons.push('invalid');
  return reasons;
}

/** The reasons an entry carries: the caller's, or the defaults for its state. */
function resolveReasons(reasons: readonly ReviewReason[] | undefined, field: ExtractedField): ReviewReason[] {
  if (reasons === undefined) return defaultReasons(field);
  if (!Array.isArray(reasons)) fail('malformed-field', 'reasons', 'must be an array of review reasons.');

  const wanted = new Set<ReviewReason>();
  for (const reason of reasons) {
    if (!(REVIEW_REASONS as readonly string[]).includes(reason)) {
      fail('malformed-field', 'reasons', `unknown reason "${String(reason)}".`);
    }
    wanted.add(reason);
  }
  if (wanted.size === 0) return defaultReasons(field);
  return REVIEW_REASONS.filter(reason => wanted.has(reason));
}

function defaultReasons(field: ExtractedField): ReviewReason[] {
  return hasValidationProblem(field) ? ['invalid'] : ['manual'];
}

function statusSet(status: ReviewListFilter['status']): Set<ReviewStatus> | null {
  if (status === undefined) return null;
  if (typeof status === 'string') return new Set<ReviewStatus>([status]);
  if (!Array.isArray(status)) fail('malformed-field', 'status', 'must be a review status or an array of them.');
  return new Set<ReviewStatus>(status);
}

function alreadyDecided(item: ReviewItem): AlreadyDecided {
  return { kind: 'already-decided', ok: false, id: item.id, item };
}

function readId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('malformed-field', 'id', 'must be a non-empty field id.');
  }
  return value.trim();
}

function readThreshold(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail('invalid-threshold', 'threshold', 'must be a number between 0 and 1.');
  }
  return value;
}

function readDecisionBy(value: unknown): DecisionBy {
  if (value !== 'human' && value !== 'rule') {
    fail('invalid-decision-by', 'by', 'must be "human" or "rule".');
  }
  return value;
}

function readBulkAction(value: unknown): BulkAction {
  if (value !== 'accept' && value !== 'reject') {
    fail('invalid-action', 'action', 'must be "accept" or "reject".');
  }
  return value;
}

// --- Reading a decisions document ------------------------------------------

function decisionEntries(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.fields)) {
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== REVIEW_SCHEMA_VERSION) {
      fail('unsupported-schema-version', 'schemaVersion', `must be ${REVIEW_SCHEMA_VERSION}.`);
    }
    if (raw.kind !== undefined && raw.kind !== DECISIONS_KIND) {
      fail('malformed-decisions', 'kind', `must be "${DECISIONS_KIND}".`);
    }
    return raw.fields;
  }
  fail(
    'malformed-decisions',
    'decisions',
    'must be an exported decisions document, an array of decision records, or its JSON text.',
  );
}

function readRecord(entry: unknown, index: number): DecisionRecord {
  const path = `fields[${index}]`;
  if (!isRecord(entry)) fail('malformed-decisions', path, 'must be an object.');

  const id = typeof entry.id === 'string' ? entry.id.trim() : '';
  if (id === '') fail('malformed-decisions', `${path}.id`, 'must be a non-empty string.');

  const status = readRecordStatus(entry.status, `${path}.status`);
  const decision = readDecision(entry.decision, `${path}.decision`);
  if (status === 'rejected' && decision.value !== null) {
    fail('malformed-decisions', `${path}.decision.value`, 'a rejected field must have a null value.');
  }
  if (status !== 'rejected' && typeof decision.value !== 'string') {
    fail('malformed-decisions', `${path}.decision.value`, `a ${status} field needs the decided value as a string.`);
  }

  return { id, status, decision };
}

function readRecordStatus(value: unknown, path: string): Exclude<ReviewStatus, 'pending'> {
  if (typeof value !== 'string' || !(DECIDED_STATUSES as readonly string[]).includes(value)) {
    fail('malformed-decisions', path, `must be one of ${DECIDED_STATUSES.join(' | ')}.`);
  }
  return value as Exclude<ReviewStatus, 'pending'>;
}

function readDecision(value: unknown, path: string): ReviewDecision {
  if (!isRecord(value)) fail('malformed-decisions', path, 'must be an object.');

  const by = value.by;
  if (by !== 'human' && by !== 'rule') {
    fail('malformed-decisions', `${path}.by`, 'must be "human" or "rule".');
  }
  const at = value.at;
  if (typeof at !== 'number' || !Number.isFinite(at)) {
    fail('malformed-decisions', `${path}.at`, 'must be epoch milliseconds.');
  }
  const previous = value.previous;
  if (typeof previous !== 'string') {
    fail('malformed-decisions', `${path}.previous`, 'must be a string.');
  }
  const decided = value.value;
  if (decided !== null && typeof decided !== 'string') {
    fail('malformed-decisions', `${path}.value`, 'must be a string or null.');
  }

  return { by, at, previous, value: decided };
}

function copyDecision(decision: ReviewDecision): ReviewDecision {
  return { by: decision.by, at: decision.at, previous: decision.previous, value: decision.value };
}

function compareRecords(left: DecisionRecord, right: DecisionRecord): number {
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

// --- Small helpers ---------------------------------------------------------

function pageOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
}

function rectOf(value: Rect): Rect {
  if (!isRecord(value)) return { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: finiteOr(value.x, 0),
    y: finiteOr(value.y, 0),
    width: Math.max(0, finiteOr(value.width, 0)),
    height: Math.max(0, finiteOr(value.height, 0)),
  };
}

function confidenceOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(code: ReviewErrorCode, path: string, message: string): never {
  throw new ReviewError(code, `${path}: ${message}`);
}
