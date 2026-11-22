import { describe, expect, it } from 'vitest';
import {
  applyTo,
  DECISIONS_KIND,
  parseDecisions,
  REVIEW_SCHEMA_VERSION,
  ReviewError,
  ReviewQueue,
  type AppliedField,
  type BulkAction,
  type DecisionBy,
  type DecisionsDocument,
  type ReviewItem,
  type ReviewQueueOptions,
  type ReviewResult,
} from '../viewer/src/core/review';
import { defineSchema, extractFields } from '../viewer/src/core/schema';
import type { ExtractedField, FieldBlock, FieldSchema } from '../viewer/src/core/schema';

/** Fixed clock, so every decision record in these tests is byte-stable. */
const AT = Date.UTC(2026, 4, 20, 10, 0);

const SCHEMA: FieldSchema[] = defineSchema([
  { id: 'invoice', label: 'Invoice number', type: 'identifier', required: true },
  { id: 'issued', label: 'Issued', type: 'date' },
  { id: 'total', label: 'Total', type: 'currency' },
  { id: 'status', label: 'Status', type: 'enum', enumValues: ['Paid', 'Pending'] },
]);

/** The four extracted values most of the export/apply tests work with. */
const FIELDS: readonly ExtractedField[] = [
  field('invoice', 'INV-2024-001'),
  field('issued', '2024-03-12'),
  field('total', '1234.56'),
  field('status', 'Paid'),
];

function makeQueue(options: Partial<ReviewQueueOptions> = {}): ReviewQueue {
  return new ReviewQueue({ now: () => AT, ...options });
}

/** A complete extraction entry, so each test states only what it cares about. */
function field(id: string, value: string, overrides: Partial<ExtractedField> = {}): ExtractedField {
  return {
    id,
    value,
    raw: value,
    page: 1,
    blockId: 'p1-r0',
    rect: { x: 10, y: 20, width: 160, height: 12 },
    confidence: 0.9,
    valid: true,
    problems: [],
    ...overrides,
  };
}

function block(id: string, text: string): FieldBlock {
  return { id, page: 1, text, rect: { x: 10, y: 20, width: 200, height: 12 }, confidence: 1 };
}

function itemOf(queue: ReviewQueue, id: string): ReviewItem {
  const item = queue.list().find(entry => entry.id === id);
  if (!item) throw new Error(`expected "${id}" in the review queue`);
  return item;
}

function appliedFrom(applied: readonly AppliedField[], id: string): AppliedField {
  const entry = applied.find(item => item.id === id);
  if (!entry) throw new Error(`expected "${id}" in the applied fields`);
  return entry;
}

/** Problem codes of a refused edit, or an empty list for any other outcome. */
function problemCodes(result: ReviewResult): string[] {
  return result.kind === 'invalid-value' ? result.problems : [];
}

function reviewError(run: () => unknown): ReviewError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewError);
    return error as ReviewError;
  }
  throw new Error('expected a ReviewError');
}

describe('fromExtraction', () => {
  it('enqueues only the fields below the threshold or failing validation', () => {
    const extraction = extractFields(
      [
        block('p1-r0', 'Invoice number: INV-2024-001'),
        block('p1-r1', 'Issued\n31/02/2024'),
        block('p1-r2', 'Total: 1.234,56 ₫'),
        block('p1-r3', 'Status: Đang xử lý'),
      ],
      SCHEMA,
    );
    expect(extraction.fields.map(entry => entry.id)).toEqual(['invoice', 'issued', 'total', 'status']);

    // Inline matches score 0.9; the next-line date is 0.65 and invalid, so it
    // lands at 0.4875, while the invalid enum is 0.9 * 0.75 = 0.675.
    const queue = makeQueue({ schema: SCHEMA });
    const queued = queue.fromExtraction(extraction.fields, 0.6);

    expect(queued.map(entry => entry.id)).toEqual(['issued', 'status']);
    expect(itemOf(queue, 'issued').reasons).toEqual(['low-confidence', 'invalid']);
    expect(itemOf(queue, 'issued').confidence).toBeCloseTo(0.4875, 4);
    expect(itemOf(queue, 'status').reasons).toEqual(['invalid']);
    expect(queue.list({ status: 'pending' })).toHaveLength(2);
  });

  it('enqueues a confident value that fails validation and ignores ambiguity notes', () => {
    const queue = makeQueue();
    const queued = queue.fromExtraction(
      [
        field('total', 'ten', { confidence: 0.99, valid: false, problems: ['not-a-number'] }),
        field('invoice', 'INV-2024-001', { confidence: 0.95, problems: ['ambiguous:label@p2-r1'] }),
        field('status', 'Paid', { confidence: 0.98 }),
      ],
      0.5,
    );

    expect(queued.map(entry => entry.id)).toEqual(['total']);
    expect(itemOf(queue, 'total').reasons).toEqual(['invalid']);
    expect(queue.list()).toHaveLength(1);
  });

  it('treats the threshold as strict and refuses one outside 0..1', () => {
    const queue = makeQueue();
    const fields = [field('a', '1', { confidence: 0.5 })];
    expect(queue.fromExtraction(fields, 0.5)).toHaveLength(0);
    expect(queue.fromExtraction(fields, 0.5001)).toHaveLength(1);

    const error = reviewError(() => queue.fromExtraction(fields, 1.5));
    expect(error.code).toBe('invalid-threshold');
    expect(error.message).toContain('threshold');
  });

  it('refreshes a pending entry and never overwrites a decided one', () => {
    const queue = makeQueue();
    queue.enqueue(field('total', '1234.56'));
    queue.enqueue(field('total', '1300', { blockId: 'p2-r0' }));
    expect(queue.list()).toHaveLength(1);
    expect(itemOf(queue, 'total').value).toBe('1300');

    const decided = queue.accept('total');
    expect(decided.ok).toBe(true);

    queue.enqueue(field('total', '999', { blockId: 'p3-r0' }));
    expect(itemOf(queue, 'total').value).toBe('1300');
    expect(itemOf(queue, 'total').status).toBe('accepted');
    expect(itemOf(queue, 'total').decision?.value).toBe('1300');
  });
});

describe('decisions', () => {
  it('records accept, reject and edit with the previous value and a timestamp', () => {
    const queue = makeQueue({ schema: SCHEMA });
    queue.enqueue(field('invoice', 'INV-2024-001'));
    queue.enqueue(field('total', '1234.56'));
    queue.enqueue(field('status', 'Paid'));

    const accepted = queue.accept('invoice');
    if (!accepted.ok) throw new Error('expected the accept to be recorded');
    expect(accepted.item.status).toBe('accepted');
    expect(accepted.decision).toEqual({
      by: 'human',
      at: AT,
      previous: 'INV-2024-001',
      value: 'INV-2024-001',
    });

    const edited = queue.edit('total', '1.200,00');
    if (!edited.ok) throw new Error('expected the edit to be recorded');
    expect(edited.item.status).toBe('edited');
    // The entry keeps the extracted value as evidence; the decision carries the
    // reviewer's value, so `previous` still matches what the entry holds.
    expect(edited.item.value).toBe('1234.56');
    expect(edited.decision).toEqual({ by: 'human', at: AT, previous: '1234.56', value: '1.200,00' });

    const rejected = queue.reject('status', 'rule');
    if (!rejected.ok) throw new Error('expected the reject to be recorded');
    expect(rejected.item.status).toBe('rejected');
    expect(rejected.decision).toEqual({ by: 'rule', at: AT, previous: 'Paid', value: null });

    expect(queue.list({ status: 'accepted' }).map(entry => entry.id)).toEqual(['invoice']);
    expect(queue.list({ status: ['edited', 'rejected'] }).map(entry => entry.id)).toEqual(['total', 'status']);
    expect(queue.list({ status: 'pending' })).toHaveLength(0);
  });

  it('refuses a second decision and keeps the first one standing', () => {
    const queue = makeQueue({ schema: SCHEMA });
    queue.enqueue(field('invoice', 'INV-2024-001'));
    queue.accept('invoice');

    const attempts = [queue.accept('invoice'), queue.reject('invoice'), queue.edit('invoice', 'INV-9')];
    for (const attempt of attempts) {
      expect(attempt.ok).toBe(false);
      expect(attempt.kind).toBe('already-decided');
      if (attempt.kind !== 'already-decided') throw new Error('expected an already-decided result');
      expect(attempt.id).toBe('invoice');
      expect(attempt.item.decision?.value).toBe('INV-2024-001');
      expect(attempt.item.decision?.at).toBe(AT);
    }

    expect(itemOf(queue, 'invoice').status).toBe('accepted');
    expect(itemOf(queue, 'invoice').value).toBe('INV-2024-001');
    expect(queue.stats().decided).toBe(1);
  });

  it('refuses an edit the field type rejects and leaves the entry pending', () => {
    const queue = makeQueue({ schema: SCHEMA });
    queue.enqueue(field('total', '1234.56'));
    queue.enqueue(field('issued', '2024-03-12'));
    queue.enqueue(field('status', 'Paid'));
    queue.enqueue(field('invoice', 'INV-2024-001'));

    const amount = queue.edit('total', 'about ten');
    if (amount.kind !== 'invalid-value') throw new Error('expected a refused edit');
    expect(amount.id).toBe('total');
    expect(amount.problems).toEqual(['not-a-number']);

    expect(problemCodes(queue.edit('issued', '31/02/2024'))).toEqual(['date-format']);
    expect(problemCodes(queue.edit('status', 'Unknown'))).toEqual(['enum']);
    expect(problemCodes(queue.edit('invoice', '   '))).toEqual(['required']);

    // A refused edit decides nothing, so every field is still open.
    expect(queue.list({ status: 'pending' }).map(entry => entry.id)).toEqual([
      'total',
      'issued',
      'status',
      'invoice',
    ]);
    expect(JSON.parse(queue.exportDecisions())).toEqual({
      schemaVersion: REVIEW_SCHEMA_VERSION,
      kind: DECISIONS_KIND,
      fields: [],
    });

    expect(queue.edit('status', 'Pending').ok).toBe(true);
    expect(itemOf(queue, 'status').decision?.value).toBe('Pending');
  });

  it('checks only emptiness when the queue has no schema for the field', () => {
    const queue = makeQueue();
    queue.enqueue(field('memo', 'hello'));
    expect(problemCodes(queue.edit('memo', ''))).toEqual(['required']);
    expect(queue.edit('memo', 'anything goes').ok).toBe(true);
  });

  it('reports an unknown field and refuses a malformed caller argument', () => {
    const queue = makeQueue();
    const unknown = queue.accept('nope');
    expect(unknown.kind).toBe('unknown-field');
    expect(unknown.ok).toBe(false);

    expect(reviewError(() => queue.accept('a', 'robot' as DecisionBy)).code).toBe('invalid-decision-by');
    expect(reviewError(() => queue.bulk([], 'skip' as BulkAction)).code).toBe('invalid-action');
    expect(reviewError(() => queue.enqueue(null as unknown as ExtractedField)).code).toBe('malformed-field');
  });
});

describe('bulk', () => {
  it('applies a bulk action and reports every refusal', () => {
    const queue = makeQueue();
    for (const id of ['a', 'b', 'c', 'd']) queue.enqueue(field(id, `${id}-value`));
    queue.accept('b');

    const report = queue.bulk(['a', 'b', 'c', 'missing'], 'accept');
    expect(report.applied).toEqual(['a', 'c']);
    expect(report.refused.map(entry => entry.kind)).toEqual(['already-decided', 'unknown-field']);
    expect(queue.list({ status: 'accepted' }).map(entry => entry.id)).toEqual(['a', 'b', 'c']);

    const rejected = queue.bulk(['d'], 'reject', 'rule');
    expect(rejected.applied).toEqual(['d']);
    expect(itemOf(queue, 'd').decision).toEqual({ by: 'rule', at: AT, previous: 'd-value', value: null });
    expect(queue.stats()).toMatchObject({ total: 4, pending: 0, accepted: 3, rejected: 1, decided: 4 });
  });
});

describe('stats', () => {
  it('counts statuses and the reason each field is queued', () => {
    const queue = makeQueue();
    queue.fromExtraction(
      [
        field('a', '1', { confidence: 0.2 }),
        field('b', '2', { confidence: 0.3, valid: false, problems: ['pattern'] }),
        field('c', '3', { confidence: 0.95 }),
      ],
      0.5,
    );
    expect(queue.stats()).toMatchObject({ total: 2, pending: 2, decided: 0 });

    queue.accept('a');
    queue.reject('b');
    queue.enqueue(field('d', '4'));
    queue.edit('d', 'five');

    expect(queue.stats()).toEqual({
      total: 3,
      pending: 0,
      accepted: 1,
      rejected: 1,
      edited: 1,
      decided: 3,
      byReason: { 'low-confidence': 2, invalid: 1, manual: 1 },
    });
  });
});

describe('export and apply', () => {
  /** The same four fields, reviewed the same way. */
  function decidedQueue(): ReviewQueue {
    const queue = makeQueue({ schema: SCHEMA });
    queue.fromExtraction(FIELDS, 1);
    queue.accept('invoice');
    queue.edit('total', '1200');
    queue.reject('status');
    return queue;
  }

  it('exports a stable document sorted by id', () => {
    const queue = decidedQueue();
    const document = JSON.parse(queue.exportDecisions()) as DecisionsDocument;

    expect(document.schemaVersion).toBe(REVIEW_SCHEMA_VERSION);
    expect(document.kind).toBe(DECISIONS_KIND);
    expect(document.fields).toEqual([
      {
        id: 'invoice',
        status: 'accepted',
        decision: { by: 'human', at: AT, previous: 'INV-2024-001', value: 'INV-2024-001' },
      },
      {
        id: 'status',
        status: 'rejected',
        decision: { by: 'human', at: AT, previous: 'Paid', value: null },
      },
      {
        id: 'total',
        status: 'edited',
        decision: { by: 'human', at: AT, previous: '1234.56', value: '1200' },
      },
    ]);

    // Enqueue order is not part of the document: filling the same queue in
    // reverse and deciding the same way produces the same bytes.
    const reversed = makeQueue({ schema: SCHEMA });
    for (const entry of [...FIELDS].reverse()) reversed.enqueue(entry);
    reversed.accept('invoice');
    reversed.edit('total', '1200');
    reversed.reject('status');
    expect(reversed.exportDecisions()).toBe(queue.exportDecisions());
  });

  it('applies exported decisions and never drops a rejected field', () => {
    const queue = decidedQueue();
    const exported = queue.exportDecisions();
    const applied = applyTo(FIELDS, exported);

    expect(applied.map(entry => entry.id)).toEqual(['invoice', 'issued', 'total', 'status']);
    expect(applied).toHaveLength(FIELDS.length);

    expect(appliedFrom(applied, 'invoice')).toMatchObject({
      value: 'INV-2024-001',
      missing: false,
      status: 'accepted',
    });
    expect(appliedFrom(applied, 'issued')).toMatchObject({
      value: '2024-03-12',
      missing: false,
      status: 'pending',
      decision: null,
    });
    expect(appliedFrom(applied, 'total')).toMatchObject({ value: '1200', missing: false, status: 'edited' });

    const rejected = appliedFrom(applied, 'status');
    expect(rejected.status).toBe('rejected');
    expect(rejected.missing).toBe(true);
    expect(rejected.value).toBe('');
    expect(rejected.raw).toBe('Paid'); // the printed evidence survives the rejection
    expect(rejected.decision).toEqual({ by: 'human', at: AT, previous: 'Paid', value: null });

    // The parsed document and its records apply exactly like the JSON text.
    const document = JSON.parse(exported) as DecisionsDocument;
    expect(applyTo(FIELDS, document)).toEqual(applied);
    expect(applyTo(FIELDS, parseDecisions(exported))).toEqual(applied);
  });

  it('ignores a decision for a field outside the document', () => {
    const queue = makeQueue();
    queue.enqueue(field('other', 'x'));
    queue.reject('other');

    const applied = applyTo([field('invoice', 'INV-1')], queue.exportDecisions());
    expect(applied).toHaveLength(1);
    expect(appliedFrom(applied, 'invoice').status).toBe('pending');
  });

  it('refuses malformed or contradictory decisions', () => {
    const fields = [field('invoice', 'INV-1')];
    expect(reviewError(() => applyTo(fields, '{')).code).toBe('malformed-decisions');
    expect(reviewError(() => applyTo(null as unknown as ExtractedField[], '[]')).code).toBe('malformed-field');

    expect(
      reviewError(() => parseDecisions({ schemaVersion: 99, kind: DECISIONS_KIND, fields: [] })).code,
    ).toBe('unsupported-schema-version');
    expect(
      reviewError(() =>
        parseDecisions(JSON.stringify({ schemaVersion: REVIEW_SCHEMA_VERSION, kind: 'translation-memory', fields: [] })),
      ).code,
    ).toBe('malformed-decisions');

    const duplicate = JSON.stringify({
      schemaVersion: REVIEW_SCHEMA_VERSION,
      kind: DECISIONS_KIND,
      fields: [
        { id: 'invoice', status: 'accepted', decision: { by: 'human', at: AT, previous: 'INV-1', value: 'INV-1' } },
        { id: 'invoice', status: 'rejected', decision: { by: 'human', at: AT, previous: 'INV-1', value: null } },
      ],
    });
    expect(reviewError(() => applyTo(fields, duplicate)).code).toBe('duplicate-decision');

    const contradictory = JSON.stringify({
      schemaVersion: REVIEW_SCHEMA_VERSION,
      kind: DECISIONS_KIND,
      fields: [
        { id: 'invoice', status: 'rejected', decision: { by: 'human', at: AT, previous: 'INV-1', value: 'INV-1' } },
      ],
    });
    expect(reviewError(() => parseDecisions(contradictory)).code).toBe('malformed-decisions');
  });
});
