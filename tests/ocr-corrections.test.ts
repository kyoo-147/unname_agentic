import { describe, expect, it } from 'vitest';
import {
  OCR_CORRECTIONS_EXPORT_KIND,
  OCR_CORRECTIONS_SCHEMA_VERSION,
  OcrCorrectionError,
  OcrCorrectionStore,
  sha256Hex,
} from '../src/core/ocr-corrections';
import { verifyOcrText } from '../src/core/ocr-verify';

function tickingClock(start = Date.UTC(2026, 10, 21, 0, 0, 0)): () => string {
  let tick = 0;
  return () => {
    const stamp = new Date(start + tick * 1000).toISOString();
    tick += 1;
    return stamp;
  };
}

function expectCorrectionError(action: () => unknown, code: string): OcrCorrectionError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`Expected OcrCorrectionError with code "${code}", but nothing was thrown.`);
  }
  expect(caught).toBeInstanceOf(OcrCorrectionError);
  expect((caught as OcrCorrectionError).code).toBe(code);
  return caught as OcrCorrectionError;
}

describe('OcrCorrectionStore source immutability and hash verification', () => {
  it('never modifies original source bytes and detects tampered source snapshots', () => {
    const originalBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const bytesCopy = new Uint8Array(originalBytes);
    const expectedHash = sha256Hex(originalBytes);

    const store = new OcrCorrectionStore({ now: tickingClock() });
    const snapshot = store.registerSource({
      documentId: 'doc-1',
      sourceBytes: originalBytes,
      expectedSha256: expectedHash,
    });

    expect(snapshot.sourceSha256).toBe(expectedHash);
    expect(snapshot.byteLength).toBe(originalBytes.length);
    expect(originalBytes).toEqual(bytesCopy);

    const text = 'Total is 1O0 EUR.';
    const staged = store.stage({
      documentId: 'doc-1',
      page: 1,
      start: 9,
      end: 12,
      original: '1O0',
      corrected: '100',
      sourceText: text,
    });
    store.confirm(staged.id, { confirmed: true, reviewer: 'alice' });

    const preview = store.preview({ documentId: 'doc-1', text, sourceBytes: originalBytes });
    expect(preview.previewText).toBe('Total is 100 EUR.');
    expect(originalBytes).toEqual(bytesCopy);

    const applied = store.apply({
      documentId: 'doc-1',
      text,
      confirmed: true,
      reviewer: 'alice',
      sourceBytes: originalBytes,
    });
    expect(applied.text).toBe('Total is 100 EUR.');
    expect(applied.sourceSha256).toBe(expectedHash);
    expect(originalBytes).toEqual(bytesCopy);

    const tamperedBytes = new Uint8Array(originalBytes);
    tamperedBytes[0] = 0x00;

    expect(store.verifySource('doc-1', originalBytes).ok).toBe(true);
    expect(store.verifySource('doc-1', tamperedBytes).ok).toBe(false);

    expectCorrectionError(
      () => store.registerSource({ documentId: 'doc-1', sourceBytes: tamperedBytes }),
      'source-hash-mismatch',
    );
    expectCorrectionError(
      () => store.preview({ documentId: 'doc-1', text, sourceBytes: tamperedBytes }),
      'source-hash-mismatch',
    );
    expectCorrectionError(
      () => store.rollback(applied.revisionId, { text: applied.text, sourceBytes: tamperedBytes }),
      'source-hash-mismatch',
    );
  });

  it('rejects expectedSha256 mismatch on registration', () => {
    const store = new OcrCorrectionStore({ now: tickingClock() });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expectCorrectionError(
      () =>
        store.registerSource({
          documentId: 'doc-x',
          sourceBytes: bytes,
          expectedSha256: '0'.repeat(64),
        }),
      'source-hash-mismatch',
    );
  });
});

describe('OcrCorrectionStore explicit confirmation guard (HITL)', () => {
  it('requires confirmed: true on both confirm() and apply()', () => {
    const store = new OcrCorrectionStore({ now: tickingClock() });
    const text = 'Amount: l50 EUR.';
    store.registerSource({ documentId: 'doc-1', sourceText: text });

    const pending = store.stage({
      documentId: 'doc-1',
      page: 1,
      start: 8,
      end: 11,
      original: 'l50',
      corrected: '150',
      sourceText: text,
      reason: 'glyph-1-l-i',
    });

    expect(pending.status).toBe('pending');
    expect(pending.confirmed).toBe(false);

    // confirm() rejects anything other than strict boolean `true`.
    expectCorrectionError(() => store.confirm(pending.id, { confirmed: false }), 'confirmation-required');
    expectCorrectionError(
      () => store.confirm(pending.id, { confirmed: 'true' as unknown as boolean }),
      'confirmation-required',
    );
    expect(store.get(pending.id)?.confirmed).toBe(false);

    // apply() rejects missing or false `confirmed`.
    expectCorrectionError(
      () => store.apply({ documentId: 'doc-1', text, confirmed: false }),
      'confirmation-required',
    );
    expectCorrectionError(
      () => store.apply({ documentId: 'doc-1', text } as unknown as { documentId: string; text: string; confirmed: boolean }),
      'confirmation-required',
    );

    // apply() refuses targeting an unconfirmed correction even when confirmed: true is passed.
    expectCorrectionError(
      () => store.apply({ documentId: 'doc-1', text, confirmed: true, correctionIds: [pending.id] }),
      'confirmation-required',
    );

    // Unconfirmed edits are skipped rather than applied when no explicit correctionIds are specified.
    const skippedRun = store.apply({ documentId: 'doc-1', text, confirmed: true });
    expect(skippedRun.text).toBe(text);
    expect(skippedRun.appliedIds).toEqual([]);
    expect(skippedRun.skippedPendingIds).toEqual([pending.id]);

    // After explicit confirmation, apply succeeds.
    const confirmed = store.confirm(pending.id, { confirmed: true, reviewer: 'bob' });
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedBy).toBe('bob');

    const applied = store.apply({ documentId: 'doc-1', text, confirmed: true, reviewer: 'bob' });
    expect(applied.text).toBe('Amount: 150 EUR.');
    expect(applied.appliedIds).toEqual([pending.id]);
    expect(store.get(pending.id)?.status).toBe('applied');
  });

  it('stages directly from F13 findings and refuses span mismatches or overlaps', () => {
    const text = 'Invoice T0tal: $1,2O0.50.';
    const report = verifyOcrText(text);
    const amountFinding = report.findings.find(f => f.span.value === '1,2O0.50');
    expect(amountFinding).toBeDefined();

    const store = new OcrCorrectionStore({ now: tickingClock() });
    store.registerSource({ documentId: 'doc-f13', sourceText: text });

    const staged = store.stageFromFinding('doc-f13', amountFinding!, '1,200.50', { sourceText: text });
    expect(staged.original).toBe('1,2O0.50');
    expect(staged.corrected).toBe('1,200.50');
    expect(staged.reason).toBe('glyph-0-o');

    // Span mismatch against sourceText fails.
    expectCorrectionError(
      () =>
        store.stage({
          documentId: 'doc-f13',
          page: 1,
          start: 0,
          end: 7,
          original: 'Wrong',
          corrected: 'Invoice',
          sourceText: text,
        }),
      'span-mismatch',
    );

    // Overlapping confirmed corrections on the same document/block are refused.
    const overlap = store.stage({
      documentId: 'doc-f13',
      page: 1,
      start: 16,
      end: 21,
      original: '1,2O0',
      corrected: '1,200',
      sourceText: text,
    });
    store.confirm(staged.id, { confirmed: true });
    store.confirm(overlap.id, { confirmed: true });

    expectCorrectionError(
      () => store.apply({ documentId: 'doc-f13', text, confirmed: true }),
      'overlapping-corrections',
    );
  });
});

describe('OcrCorrectionStore preview, apply, and rollback/undo', () => {
  it('previews length-changing edits without mutating state and rolls back cleanly', () => {
    const store = new OcrCorrectionStore({ now: tickingClock() });
    const v0 = 'Rate 15 o/o and fee 2O0 EUR.';
    store.registerSource({ documentId: 'doc-1', sourceText: v0 });

    const c1 = store.stage({
      documentId: 'doc-1',
      page: 1,
      start: 5,
      end: 11,
      original: '15 o/o',
      corrected: '15%',
      sourceText: v0,
    });
    const c2 = store.stage({
      documentId: 'doc-1',
      page: 1,
      start: 20,
      end: 23,
      original: '2O0',
      corrected: '200',
      sourceText: v0,
    });

    // Preview can inspect pending edits when includePending is true without altering state.
    const pendingPreview = store.preview({ documentId: 'doc-1', text: v0, includePending: true });
    expect(pendingPreview.previewText).toBe('Rate 15% and fee 200 EUR.');
    expect(pendingPreview.patches).toHaveLength(2);
    expect(pendingPreview.changed).toBe(true);
    expect(store.ledger('doc-1')).toEqual([]);

    store.confirm(c1.id, { confirmed: true, reviewer: 'alice' });
    store.confirm(c2.id, { confirmed: true, reviewer: 'alice' });

    const batch1 = store.apply({ documentId: 'doc-1', text: v0, confirmed: true, reviewer: 'alice' });
    expect(batch1.text).toBe('Rate 15% and fee 200 EUR.');
    expect(batch1.beforeSha256).toBe(sha256Hex(v0));
    expect(batch1.afterSha256).toBe(sha256Hex('Rate 15% and fee 200 EUR.'));

    // Apply a second sequential revision on top of batch1's output.
    const c3 = store.stage({
      documentId: 'doc-1',
      page: 1,
      start: 17,
      end: 20,
      original: '200',
      corrected: '250',
      sourceText: batch1.text,
    });
    store.confirm(c3.id, { confirmed: true, reviewer: 'alice' });
    const batch2 = store.apply({
      documentId: 'doc-1',
      text: batch1.text,
      confirmed: true,
      correctionIds: [c3.id],
      reviewer: 'alice',
    });
    expect(batch2.text).toBe('Rate 15% and fee 250 EUR.');

    // Out-of-order rollback against wrong text fails safely.
    expectCorrectionError(
      () => store.rollback(batch1.revisionId, { text: batch2.text }),
      'rollback-conflict',
    );

    // Undo rolls back latest revision (batch2) -> batch1.text.
    const undone2 = store.undo('doc-1', { text: batch2.text });
    expect(undone2.revisionId).toBe(batch2.revisionId);
    expect(undone2.restoredText).toBe(batch1.text);
    expect(store.get(c3.id)?.status).toBe('rolled-back');

    // Undo again rolls back batch1 -> exact original v0 even across length-changing `15 o/o` -> `15%`.
    const undone1 = store.undo('doc-1', { text: undone2.restoredText });
    expect(undone1.revisionId).toBe(batch1.revisionId);
    expect(undone1.restoredText).toBe(v0);
    expect(store.get(c1.id)?.status).toBe('rolled-back');
    expect(store.get(c2.id)?.status).toBe('rolled-back');

    // Double rollback is refused.
    expectCorrectionError(
      () => store.rollback(batch1.revisionId, { text: v0 }),
      'already-rolled-back',
    );
  });
});

describe('OcrCorrectionStore reusable rule extraction and guarded application', () => {
  it('extracts reusable pattern/exact rules only from confirmed edits and requires confirmation to reuse', () => {
    const store = new OcrCorrectionStore({ now: tickingClock() });
    const page1 = 'T0tal: 1O0 + 2O0, tax 15 o/o.';
    store.registerSource({ documentId: 'doc-1', sourceText: page1 });

    // Confirmed edits: two numeric O->0 edits, one unit edit, one exact word edit.
    const e1 = store.stage({
      documentId: 'doc-1',
      page: 1,
      start: 7,
      end: 10,
      original: '1O0',
      corrected: '100',
      sourceText: page1,
    });
    const e2 = store.stage({
      documentId: 'doc-1',
      page: 1,
      start: 13,
      end: 16,
      original: '2O0',
      corrected: '200',
      sourceText: page1,
    });
    const e3 = store.stage({
      documentId: 'doc-1',
      page: 1,
      start: 22,
      end: 28,
      original: '15 o/o',
      corrected: '15%',
      sourceText: page1,
    });
    const e4 = store.stage({
      documentId: 'doc-1',
      page: 1,
      start: 0,
      end: 5,
      original: 'T0tal',
      corrected: 'Total',
      sourceText: page1,
    });
    // Pending and rejected edits MUST NOT leak into rule extraction.
    store.stage({
      documentId: 'doc-1',
      page: 1,
      start: 22,
      end: 24,
      original: '15',
      corrected: '99',
      sourceText: page1,
    });
    const rejected = store.stage({
      documentId: 'doc-1',
      page: 1,
      start: 0,
      end: 5,
      original: 'T0tal',
      corrected: 'Bogus',
      sourceText: page1,
    });
    store.reject(rejected.id);

    for (const id of [e1.id, e2.id, e3.id, e4.id]) {
      store.confirm(id, { confirmed: true, reviewer: 'alice' });
    }

    const extracted = store.extractRules();
    const numericRule = extracted.find(r => r.kind === 'pattern' && r.scope === 'numeric-glyph' && r.from === 'O' && r.to === '0');
    const unitRule = extracted.find(r => r.kind === 'pattern' && r.scope === 'unit-glyph' && r.from === 'o/o' && r.to === '%');
    const exactRule = extracted.find(r => r.kind === 'exact' && r.from === 'T0tal' && r.to === 'Total');

    expect(numericRule).toBeDefined();
    expect(numericRule?.supportCount).toBe(2);
    expect(numericRule?.confirmed).toBe(false);
    expect(unitRule).toBeDefined();
    expect(exactRule).toBeDefined();
    expect(extracted.some(r => r.to === '99' || r.to === 'Bogus')).toBe(false);

    // New page text: `"Order"` contains capital `O` and MUST NOT be corrupted by the numeric O->0 rule!
    const page2 = 'Order T0tal: 3O0 + 1,5O0, fee 8 o/o.';
    store.registerSource({ documentId: 'doc-2', sourceText: page2 });

    // Preview works safely without confirmation.
    const rulePreview = store.previewRules({ documentId: 'doc-2', text: page2, includeUnconfirmed: true });
    expect(rulePreview.previewText).toBe('Order Total: 300 + 1,500, fee 8%.');

    // Applying unconfirmed rules or without confirmed: true is refused.
    expectCorrectionError(
      () => store.applyRules({ documentId: 'doc-2', text: page2, confirmed: true }),
      'rule-not-confirmed',
    );

    expectCorrectionError(
      () => store.confirmRule(numericRule!.id, { confirmed: false }),
      'confirmation-required',
    );
    store.confirmRule(numericRule!.id, { confirmed: true, reviewer: 'alice' });
    store.confirmRule(unitRule!.id, { confirmed: true, reviewer: 'alice' });
    store.confirmRule(exactRule!.id, { confirmed: true, reviewer: 'alice' });

    expectCorrectionError(
      () => store.applyRules({ documentId: 'doc-2', text: page2, confirmed: false }),
      'confirmation-required',
    );

    const applied = store.applyRules({
      documentId: 'doc-2',
      text: page2,
      confirmed: true,
      reviewer: 'alice',
    });
    expect(applied.text).toBe('Order Total: 300 + 1,500, fee 8%.');
    expect(applied.appliedIds).toHaveLength(4);

    // Rule-applied changes are in the ledger and roll back cleanly.
    const undone = store.undo('doc-2', { text: applied.text });
    expect(undone.restoredText).toBe(page2);
  });
});

describe('OcrCorrectionStore versioned JSON export and import', () => {
  it('round-trips sources, corrections, rules, and ledger byte-identically', () => {
    const store = new OcrCorrectionStore({ now: tickingClock() });
    const bytes = new Uint8Array([10, 20, 30, 40]);
    const text = 'Total 1O0 EUR.';
    store.registerSource({ documentId: 'doc-1', sourceBytes: bytes });

    const c1 = store.stage({
      documentId: 'doc-1',
      page: 1,
      start: 6,
      end: 9,
      original: '1O0',
      corrected: '100',
      sourceText: text,
    });
    store.confirm(c1.id, { confirmed: true, reviewer: 'alice' });
    const applied = store.apply({ documentId: 'doc-1', text, confirmed: true, reviewer: 'alice' });
    const rules = store.extractRules();
    store.confirmRule(rules[0]!.id, { confirmed: true, reviewer: 'alice' });

    const json = store.exportJson();
    expect(store.exportJson()).toBe(json);

    const parsed = JSON.parse(json) as { schemaVersion: number; kind: string };
    expect(parsed.schemaVersion).toBe(OCR_CORRECTIONS_SCHEMA_VERSION);
    expect(parsed.kind).toBe(OCR_CORRECTIONS_EXPORT_KIND);

    const restored = new OcrCorrectionStore({ now: tickingClock() });
    const summary = restored.importJson(json);
    expect(summary).toEqual({
      sources: 1,
      corrections: 1,
      rules: rules.length,
      ledger: 1,
    });
    expect(restored.exportJson()).toBe(json);
    expect(restored.verifySource('doc-1', bytes).ok).toBe(true);

    // Subsequent IDs do not collide and undo works on the restored store.
    const next = restored.stage({
      documentId: 'doc-1',
      page: 1,
      start: 0,
      end: 5,
      original: 'Total',
      corrected: 'Sum',
      sourceText: applied.text,
    });
    expect(next.id).not.toBe(c1.id);

    const undone = restored.undo('doc-1', { text: applied.text });
    expect(undone.restoredText).toBe(text);
  });

  it('rejects malformed JSON, unsupported schema versions, duplicates, and tampered state atomically', () => {
    const store = new OcrCorrectionStore({ now: tickingClock() });
    const bytes = new Uint8Array([1, 2, 3]);
    store.registerSource({ documentId: 'doc-1', sourceBytes: bytes });
    const c1 = store.stage({
      documentId: 'doc-1',
      page: 1,
      start: 0,
      end: 3,
      original: '1O0',
      corrected: '100',
    });
    const json = store.exportJson();

    expectCorrectionError(() => store.importJson('{bad json'), 'malformed-json');
    expectCorrectionError(() => store.importJson('[]'), 'malformed-export');
    expectCorrectionError(
      () =>
        store.importJson(
          JSON.stringify({
            schemaVersion: OCR_CORRECTIONS_SCHEMA_VERSION + 1,
            kind: OCR_CORRECTIONS_EXPORT_KIND,
            sources: [],
            corrections: [],
            rules: [],
            ledger: [],
          }),
        ),
      'unsupported-schema-version',
    );

    // Duplicate ID against existing store leaves store unchanged.
    expectCorrectionError(() => store.importJson(json), 'duplicate-id');
    expect(store.list('doc-1')).toHaveLength(1);
    expect(store.list('doc-1')[0]?.id).toBe(c1.id);

    // Inconsistent unconfirmed-but-applied entry is refused.
    const doc = JSON.parse(json) as {
      corrections: { status: string; confirmed: boolean }[];
    };
    doc.corrections[0]!.status = 'applied';
    doc.corrections[0]!.confirmed = false;
    const fresh = new OcrCorrectionStore({ now: tickingClock() });
    expectCorrectionError(() => fresh.importJson(JSON.stringify(doc)), 'invalid-field');
    expect(fresh.list('doc-1')).toEqual([]);
  });
});
