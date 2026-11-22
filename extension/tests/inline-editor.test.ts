import { describe, expect, it } from 'vitest';
import {
  INLINE_EDITOR_EXPORT_KIND,
  INLINE_EDITOR_SCHEMA_VERSION,
  InlineEditorError,
  RevisionConflictError,
  canRedo,
  canUndo,
  commitCheckpoint,
  compareWithSource,
  createEditorState,
  createEditorStateFromDocument,
  dirtyBlockIds,
  editBlock,
  exportJson,
  getAutosaveSchedule,
  getBlock,
  importJson,
  isAutosaveDue,
  isDirty,
  markSaved,
  modifiedBlockIds,
  pendingSave,
  recoverFromSnapshot,
  redo,
  resolveConflict,
  revertAll,
  revertBlock,
  revertBlocks,
  syncDocumentRevision,
  syncSourceRevision,
  undo,
  type InlineEditorState,
} from '../viewer/src/core/inline-editor';
import { addTranslation, buildDocument, type DocumentIR } from '../viewer/src/core/ir';

const SHA_A = 'a'.repeat(64);

function makeSampleDocument(revisionId = 'rev-1', ocr0 = 'Total 1O0 EUR', ocr1 = 'Due date 01/02/2026'): DocumentIR {
  let ir = buildDocument({
    documentId: 'doc-h06',
    revisionId,
    sourceSha256: SHA_A,
    language: 'en',
    pages: [{ index: 1, width: 612, height: 792 }],
    blocks: [
      { page: 1, text: ocr0, rect: { x: 72, y: 100, width: 300, height: 20 }, origin: 'ocr' },
      { page: 1, text: ocr1, rect: { x: 72, y: 140, width: 300, height: 20 }, origin: 'ocr' },
    ],
  });
  ir = addTranslation(ir, {
    blockId: 'p1-r0',
    lang: 'vi',
    engine: 'local',
    modelVersion: 'qwen3:4b',
    promptVersion: 'v1',
    text: 'Tổng cộng 1O0 EUR',
    qaStatus: 'warn',
  });
  ir = addTranslation(ir, {
    blockId: 'p1-r1',
    lang: 'vi',
    engine: 'local',
    modelVersion: 'qwen3:4b',
    promptVersion: 'v1',
    text: 'Hạn thanh toán 01/02/2026',
    qaStatus: 'pass',
  });
  return ir;
}

function expectConflictError(action: () => unknown): RevisionConflictError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RevisionConflictError);
  return caught as RevisionConflictError;
}

describe('H06 inline block editor: OCR and translation editing with immutable state', () => {
  it('edits both OCR text and translated block text inline without mutating prior state', () => {
    const ir = makeSampleDocument();
    const s0 = createEditorStateFromDocument(ir, { targetLang: 'vi', at: 100 });
    const snapshotS0 = JSON.stringify(s0);

    expect(s0.documentId).toBe('doc-h06');
    expect(s0.sourceRevisionId).toBe('rev-1');
    expect(s0.sourceSha256).toBe(SHA_A);
    expect(getBlock(s0, 'p1-r0')?.ocrText).toBe('Total 1O0 EUR');
    expect(getBlock(s0, 'p1-r0')?.translationText).toBe('Tổng cộng 1O0 EUR');

    const s1 = editBlock(s0, {
      blockId: 'p1-r0',
      field: 'ocr',
      text: 'Total 100 EUR',
      at: 200,
    });
    const s2 = editBlock(s1, {
      blockId: 'p1-r0',
      field: 'translation',
      text: 'Tổng cộng 100 EUR',
      at: 300,
    });

    // Previous states must remain strictly immutable.
    expect(JSON.stringify(s0)).toBe(snapshotS0);
    expect(getBlock(s0, 'p1-r0')?.ocrText).toBe('Total 1O0 EUR');
    expect(getBlock(s1, 'p1-r0')?.ocrText).toBe('Total 100 EUR');
    expect(getBlock(s1, 'p1-r0')?.translationText).toBe('Tổng cộng 1O0 EUR');

    const finalBlock = getBlock(s2, 'p1-r0');
    expect(finalBlock?.ocrText).toBe('Total 100 EUR');
    expect(finalBlock?.sourceOcrText).toBe('Total 1O0 EUR');
    expect(finalBlock?.translationText).toBe('Tổng cộng 100 EUR');
    expect(finalBlock?.sourceTranslationText).toBe('Tổng cộng 1O0 EUR');
    expect(s2.revision).toBe(2);
  });

  it('rejects edits targeting an unknown block id', () => {
    const s0 = createEditorStateFromDocument(makeSampleDocument(), { targetLang: 'vi' });
    let caught: unknown;
    try {
      editBlock(s0, { blockId: 'p9-r99', field: 'ocr', text: 'abc' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InlineEditorError);
    expect((caught as InlineEditorError).code).toBe('unknown-block');
  });
});

describe('H06 inline block editor: multi-step undo/redo and checkpoints', () => {
  it('supports multi-step undo and redo, clearing redo stack upon a new edit', () => {
    const s0 = createEditorState({
      documentId: 'doc-1',
      sourceRevisionId: 'rev-1',
      blocks: [{ blockId: 'p1-r0', page: 1, ocrText: 'v0', translationText: 't0' }],
    });

    const s1 = editBlock(s0, { blockId: 'p1-r0', field: 'ocr', text: 'v1' });
    const s2 = editBlock(s1, { blockId: 'p1-r0', field: 'ocr', text: 'v2' });
    const s3 = editBlock(s2, { blockId: 'p1-r0', field: 'translation', text: 't1' });

    expect(canUndo(s0)).toBe(false);
    expect(canUndo(s3)).toBe(true);
    expect(canRedo(s3)).toBe(false);

    const u1 = undo(s3);
    expect(getBlock(u1, 'p1-r0')?.translationText).toBe('t0');
    expect(getBlock(u1, 'p1-r0')?.ocrText).toBe('v2');
    expect(canRedo(u1)).toBe(true);

    const u2 = undo(u1);
    expect(getBlock(u2, 'p1-r0')?.ocrText).toBe('v1');

    const u3 = undo(u2);
    expect(getBlock(u3, 'p1-r0')?.ocrText).toBe('v0');
    expect(canUndo(u3)).toBe(false);
    expect(undo(u3)).toBe(u3);

    const r1 = redo(u3);
    expect(getBlock(r1, 'p1-r0')?.ocrText).toBe('v1');
    const r2 = redo(r1);
    expect(getBlock(r2, 'p1-r0')?.ocrText).toBe('v2');
    expect(canRedo(r2)).toBe(true);

    // Branching with a new edit must discard the remaining redo entry ('t1').
    const branched = editBlock(r2, { blockId: 'p1-r0', field: 'translation', text: 't-branch' });
    expect(canRedo(branched)).toBe(false);
    expect(redo(branched)).toBe(branched);
    expect(getBlock(branched, 'p1-r0')?.translationText).toBe('t-branch');

    // No-op edit with identical text must not create a spurious undo step or clear redo on u2.
    const r2Again = undo(r2);
    const noopOnUndo = editBlock(r2Again, { blockId: 'p1-r0', field: 'ocr', text: 'v1' });
    expect(canRedo(noopOnUndo)).toBe(true);
    expect(noopOnUndo.undoStack.length).toBe(r2Again.undoStack.length);
  });

  it('coalesces rapid edits within window unless separated by explicit checkpoint, field switch, or window expiry', () => {
    const s0 = createEditorState({
      documentId: 'doc-1',
      sourceRevisionId: 'rev-1',
      coalesceWindowMs: 500,
      blocks: [{ blockId: 'p1-r0', page: 1, ocrText: 'H', translationText: 'Chào' }],
    });

    // Rapid typing inside 500ms window collapses into 1 undo step.
    let s = editBlock(s0, { blockId: 'p1-r0', field: 'ocr', text: 'He', at: 1000 });
    s = editBlock(s, { blockId: 'p1-r0', field: 'ocr', text: 'Hel', at: 1200 });
    s = editBlock(s, { blockId: 'p1-r0', field: 'ocr', text: 'Hell', at: 1450 });
    expect(s.undoStack).toHaveLength(1);

    // Explicit checkpoint forces a boundary even at +50ms.
    s = editBlock(s, { blockId: 'p1-r0', field: 'ocr', text: 'Hello', at: 1500, checkpoint: true });
    expect(s.undoStack).toHaveLength(2);

    // commitCheckpoint closes open frame; next edit with coalesce:true starts a new frame, then merges subsequent coalesce:true edits.
    s = commitCheckpoint(s);
    s = editBlock(s, { blockId: 'p1-r0', field: 'ocr', text: 'Hello!', at: 1510, coalesce: true });
    s = editBlock(s, { blockId: 'p1-r0', field: 'ocr', text: 'Hello!!', at: 1520, coalesce: true });
    expect(s.undoStack).toHaveLength(3);

    // Window expiry (>500ms since 1520) starts a fourth frame.
    s = editBlock(s, { blockId: 'p1-r0', field: 'ocr', text: 'Hello world', at: 2100 });
    expect(s.undoStack).toHaveLength(4);

    // Switching field starts a fifth frame immediately.
    s = editBlock(s, { blockId: 'p1-r0', field: 'translation', text: 'Xin chào', at: 2150 });
    expect(s.undoStack).toHaveLength(5);

    const back1 = undo(s);
    expect(getBlock(back1, 'p1-r0')?.translationText).toBe('Chào');
    expect(getBlock(back1, 'p1-r0')?.ocrText).toBe('Hello world');

    const back2 = undo(back1);
    expect(getBlock(back2, 'p1-r0')?.ocrText).toBe('Hello!!');

    const back3 = undo(back2);
    expect(getBlock(back3, 'p1-r0')?.ocrText).toBe('Hello');

    const back4 = undo(back3);
    expect(getBlock(back4, 'p1-r0')?.ocrText).toBe('Hell');

    const back5 = undo(back4);
    expect(getBlock(back5, 'p1-r0')?.ocrText).toBe('H');
  });
});

describe('H06 inline block editor: dirty state, debounced autosave, and crash recovery snapshot', () => {
  it('tracks dirty blocks across edits, undo, and markSaved', () => {
    const s0 = createEditorStateFromDocument(makeSampleDocument(), { targetLang: 'vi', at: 0 });
    expect(isDirty(s0)).toBe(false);
    expect(dirtyBlockIds(s0)).toEqual([]);
    expect(modifiedBlockIds(s0)).toEqual([]);
    expect(pendingSave(s0)).toBe(false);

    const s1 = editBlock(s0, { blockId: 'p1-r0', field: 'ocr', text: 'Total 100 EUR', at: 100 });
    expect(isDirty(s1)).toBe(true);
    expect(dirtyBlockIds(s1)).toEqual(['p1-r0']);
    expect(modifiedBlockIds(s1)).toEqual(['p1-r0']);
    expect(getBlock(s1, 'p1-r0')?.ocrDirty).toBe(true);
    expect(getBlock(s1, 'p1-r0')?.translationDirty).toBe(false);

    // Undoing back to initial saved text clears dirty state.
    const revertedByUndo = undo(s1);
    expect(isDirty(revertedByUndo)).toBe(false);
    expect(dirtyBlockIds(revertedByUndo)).toEqual([]);
    expect(pendingSave(revertedByUndo)).toBe(false);

    // Saving preserves source-modification awareness and undo history, while clearing unsaved dirty flags.
    const s2 = editBlock(s1, { blockId: 'p1-r1', field: 'translation', text: 'Hạn trả 01/02/2026', at: 200 });
    const saved = markSaved(s2, { at: 900 });
    expect(isDirty(saved)).toBe(false);
    expect(pendingSave(saved)).toBe(false);
    expect(dirtyBlockIds(saved)).toEqual([]);
    expect(modifiedBlockIds(saved)).toEqual(['p1-r0', 'p1-r1']);
    expect(getBlock(saved, 'p1-r0')?.ocrModifiedFromSource).toBe(true);
    expect(canUndo(saved)).toBe(true);

    // Undoing past a saved point makes the state dirty relative to the last saved snapshot.
    const undonePastSave = undo(saved, { at: 950 });
    expect(isDirty(undonePastSave)).toBe(true);
    expect(dirtyBlockIds(undonePastSave)).toEqual(['p1-r1']);
    expect(pendingSave(undonePastSave)).toBe(true);
  });

  it('implements debounced/scheduled autosave contract and crash-recovery JSON snapshot', () => {
    const s0 = createEditorStateFromDocument(makeSampleDocument(), {
      targetLang: 'vi',
      autosaveDebounceMs: 500,
      at: 1000,
    });
    expect(pendingSave(s0)).toBe(false);
    expect(isAutosaveDue(s0, 5000)).toBe(false);

    const s1 = editBlock(s0, { blockId: 'p1-r0', field: 'ocr', text: 'Total 100 EUR', at: 1100 });
    expect(pendingSave(s1)).toBe(true);
    expect(getAutosaveSchedule(s1, 1300)).toEqual({
      pendingSave: true,
      due: false,
      delayMs: 300,
      scheduledAt: 1600,
      dirtySinceAt: 1100,
      lastSavedAt: 1000,
      lastSavedRevision: 0,
    });
    expect(isAutosaveDue(s1, 1599)).toBe(false);

    // Another edit at t=1400 pushes the debounced schedule forward to 1900.
    const s2 = editBlock(s1, { blockId: 'p1-r0', field: 'translation', text: 'Tổng cộng 100 EUR', at: 1400 });
    expect(getAutosaveSchedule(s2, 1600).scheduledAt).toBe(1900);
    expect(isAutosaveDue(s2, 1600)).toBe(false);
    expect(isAutosaveDue(s2, 1900)).toBe(true);

    // Simulate crash before autosave completes: serialize snapshot and recover in fresh session.
    const crashJson = exportJson(s2);
    const parsed = JSON.parse(crashJson) as { schemaVersion: number; kind: string };
    expect(parsed.schemaVersion).toBe(INLINE_EDITOR_SCHEMA_VERSION);
    expect(parsed.kind).toBe(INLINE_EDITOR_EXPORT_KIND);

    const recovered: InlineEditorState = importJson(crashJson);
    expect(pendingSave(recovered)).toBe(true);
    expect(isDirty(recovered)).toBe(true);
    expect(getBlock(recovered, 'p1-r0')?.ocrText).toBe('Total 100 EUR');
    expect(getBlock(recovered, 'p1-r0')?.translationText).toBe('Tổng cộng 100 EUR');
    expect(getAutosaveSchedule(recovered, 1900).due).toBe(true);

    // Undo history survives crash recovery.
    const recoveredUndone = undo(recovered);
    expect(getBlock(recoveredUndone, 'p1-r0')?.translationText).toBe('Tổng cộng 1O0 EUR');

    // Flushing autosave marks state saved.
    const flushed = markSaved(recovered, { at: 1950 });
    expect(pendingSave(flushed)).toBe(false);
    expect(isDirty(flushed)).toBe(false);
    expect(getAutosaveSchedule(flushed, 2000).lastSavedAt).toBe(1950);
    expect(getAutosaveSchedule(flushed, 2000).scheduledAt).toBeNull();
  });
});

describe('H06 inline block editor: source-vs-edited word and character comparison', () => {
  it('computes word and character diffs between source and edited OCR/translation text', () => {
    const s0 = createEditorState({
      documentId: 'doc-cmp',
      sourceRevisionId: 'rev-1',
      blocks: [
        {
          blockId: 'p1-r0',
          page: 1,
          ocrText: 'Total 1O0 EUR',
          translationText: 'Xin chào thế giới',
        },
        {
          blockId: 'p1-r1',
          page: 1,
          ocrText: 'alpha  beta',
          translationText: 'alpha beta',
        },
      ],
    });

    const s1 = editBlock(s0, { blockId: 'p1-r0', field: 'ocr', text: 'Total 100 EUR' });
    const ocrCmp = compareWithSource(s1, 'p1-r0', 'ocr');
    expect(ocrCmp.changed).toBe(true);
    expect(ocrCmp.sourceText).toBe('Total 1O0 EUR');
    expect(ocrCmp.editedText).toBe('Total 100 EUR');
    expect(ocrCmp.wordRuns).toEqual([
      { kind: 'equal', text: 'Total' },
      { kind: 'delete', text: '1O0' },
      { kind: 'insert', text: '100' },
      { kind: 'equal', text: 'EUR' },
    ]);
    expect(ocrCmp.charRuns).toEqual([
      { kind: 'equal', text: 'Total 1' },
      { kind: 'delete', text: 'O' },
      { kind: 'insert', text: '0' },
      { kind: 'equal', text: '0 EUR' },
    ]);
    expect(ocrCmp.wordsAdded).toBe(1);
    expect(ocrCmp.wordsDeleted).toBe(1);
    expect(ocrCmp.charsAdded).toBe(1);
    expect(ocrCmp.charsDeleted).toBe(1);

    const s2 = editBlock(s1, { blockId: 'p1-r0', field: 'translation', text: 'Xin chào bạn mới' });
    const trCmp = compareWithSource(s2, 'p1-r0', 'translation');
    expect(trCmp.changed).toBe(true);
    expect(trCmp.wordRuns).toEqual([
      { kind: 'equal', text: 'Xin chào' },
      { kind: 'delete', text: 'thế giới' },
      { kind: 'insert', text: 'bạn mới' },
    ]);
    expect(trCmp.wordsDeleted).toBe(2);
    expect(trCmp.wordsAdded).toBe(2);

    // Whitespace-only difference is unchanged at word level yet visible at char level.
    const s3 = editBlock(s2, { blockId: 'p1-r1', field: 'ocr', text: 'alpha beta' });
    const wsCmp = compareWithSource(s3, 'p1-r1', 'ocr');
    expect(wsCmp.changed).toBe(true);
    expect(wsCmp.wordRuns).toEqual([{ kind: 'equal', text: 'alpha beta' }]);
    expect(wsCmp.charRuns).toEqual([
      { kind: 'equal', text: 'alpha ' },
      { kind: 'delete', text: ' ' },
      { kind: 'equal', text: 'beta' },
    ]);
    expect(wsCmp.charsDeleted).toBe(1);
    expect(wsCmp.charsAdded).toBe(0);
  });
});

describe('H06 inline block editor: optimistic revision conflict detection', () => {
  it('throws RevisionConflictError when expectedSourceRevisionId is stale on edit or save', () => {
    const s0 = createEditorStateFromDocument(makeSampleDocument('rev-2'), { targetLang: 'vi' });

    const editConflict = expectConflictError(() =>
      editBlock(s0, {
        blockId: 'p1-r0',
        field: 'ocr',
        text: 'Total 100 EUR',
        expectedSourceRevisionId: 'rev-1',
      }),
    );
    expect(editConflict.code).toBe('revision-conflict');
    expect(editConflict.reason).toBe('stale-source-revision');
    expect(editConflict.expectedRevisionId).toBe('rev-1');
    expect(editConflict.actualRevisionId).toBe('rev-2');

    const saveConflict = expectConflictError(() =>
      markSaved(s0, { expectedSourceRevisionId: 'rev-1', at: 500 }),
    );
    expect(saveConflict.reason).toBe('stale-source-revision');
    expect(saveConflict.actualRevisionId).toBe('rev-2');
  });

  it('throws RevisionConflictError when underlying sourceRevisionId updates a locally edited block', () => {
    const irV1 = makeSampleDocument('rev-1', 'Total 1O0 EUR', 'Due date 01/02/2026');
    const s0 = createEditorStateFromDocument(irV1, { targetLang: 'vi' });
    const s1 = editBlock(s0, { blockId: 'p1-r0', field: 'ocr', text: 'Total 100 EUR' });

    // Upstream rev-2 changes BOTH p1-r0 (conflicting!) and p1-r1 (non-conflicting).
    const irV2 = makeSampleDocument('rev-2', 'Total 1000 EUR', 'Due date 02/02/2026');
    const err = expectConflictError(() => syncDocumentRevision(s1, irV2, { targetLang: 'vi' }));

    expect(err.reason).toBe('stale-source-revision');
    expect(err.expectedRevisionId).toBe('rev-1');
    expect(err.actualRevisionId).toBe('rev-2');
    expect(err.blockIds).toEqual(['p1-r0']);
    expect(err.conflicts).toEqual([
      {
        blockId: 'p1-r0',
        field: 'ocr',
        baseText: 'Total 1O0 EUR',
        localText: 'Total 100 EUR',
        incomingText: 'Total 1000 EUR',
      },
    ]);
  });

  it('fast-forwards cleanly when sourceRevisionId changes only untouched blocks', () => {
    const irV1 = makeSampleDocument('rev-1', 'Total 1O0 EUR', 'Due date 01/02/2026');
    const s0 = createEditorStateFromDocument(irV1, { targetLang: 'vi' });
    const s1 = editBlock(s0, { blockId: 'p1-r0', field: 'ocr', text: 'Total 100 EUR' });

    // Upstream rev-2 leaves p1-r0 untouched and updates p1-r1.
    const irV2 = makeSampleDocument('rev-2', 'Total 1O0 EUR', 'Due date 05/03/2026');
    const synced = syncSourceRevision(s1, {
      sourceRevisionId: irV2.revisionId,
      sourceSha256: irV2.sourceSha256,
      blocks: irV2.blocks.map(b => ({
        blockId: b.id,
        page: b.page,
        ocrText: b.raw,
        translationText: irV2.translations.find(t => t.blockId === b.id)?.text ?? '',
      })),
    });

    expect(synced.sourceRevisionId).toBe('rev-2');
    expect(getBlock(synced, 'p1-r0')?.ocrText).toBe('Total 100 EUR');
    expect(getBlock(synced, 'p1-r0')?.dirty).toBe(true);
    expect(getBlock(synced, 'p1-r1')?.ocrText).toBe('Due date 05/03/2026');
    expect(getBlock(synced, 'p1-r1')?.dirty).toBe(false);
  });
});

function expectEditorError(action: () => unknown, code: string): InlineEditorError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InlineEditorError);
  expect((caught as InlineEditorError).code).toBe(code);
  return caught as InlineEditorError;
}

describe('H06 inline block editor: revision conflict resolution', () => {
  it('stages conflicts and resolves incrementally with keep-local, accept-incoming, and manual strategies', () => {
    const s0 = createEditorState({
      documentId: 'doc-res',
      sourceRevisionId: 'rev-1',
      sourceSha256: SHA_A,
      blocks: [
        { blockId: 'p1-r0', page: 1, ocrText: 'Base O0', translationText: 'Bản gốc 0' },
        { blockId: 'p1-r1', page: 1, ocrText: 'Base O1', translationText: 'Bản gốc 1' },
        { blockId: 'p1-r2', page: 1, ocrText: 'Base O2', translationText: 'Bản gốc 2' },
      ],
      at: 100,
    });

    let s = editBlock(s0, { blockId: 'p1-r0', field: 'ocr', text: 'Local O0', at: 200 });
    s = editBlock(s, { blockId: 'p1-r1', field: 'ocr', text: 'Local O1', at: 300 });
    s = editBlock(s, { blockId: 'p1-r1', field: 'translation', text: 'Bản dịch local 1', at: 400 });

    const staged = syncSourceRevision(
      s,
      {
        sourceRevisionId: 'rev-2',
        sourceSha256: SHA_A,
        blocks: [
          { blockId: 'p1-r0', page: 1, ocrText: 'Incoming O0', translationText: 'Bản gốc 0' },
          { blockId: 'p1-r1', page: 1, ocrText: 'Incoming O1', translationText: 'Bản dịch incoming 1' },
          { blockId: 'p1-r2', page: 1, ocrText: 'Incoming O2', translationText: 'Bản gốc 2' },
          { blockId: 'p1-r3', page: 2, ocrText: 'New block 3', translationText: 'Khối mới 3' },
        ],
      },
      { onConflict: 'stage', at: 500 },
    );

    expect(staged.sourceRevisionId).toBe('rev-1');
    expect(staged.conflict?.incomingRevisionId).toBe('rev-2');
    expect(staged.conflict?.conflicts).toHaveLength(3);

    // Unresolved conflict blocks save, re-sync, undo, redo, and editing conflicted fields.
    expect(expectConflictError(() => markSaved(staged)).reason).toBe('unresolved-conflict');
    expect(
      expectConflictError(() =>
        syncSourceRevision(staged, { sourceRevisionId: 'rev-3', blocks: [] }),
      ).reason,
    ).toBe('unresolved-conflict');
    expect(expectConflictError(() => undo(staged)).reason).toBe('unresolved-conflict');
    expect(expectConflictError(() => redo(staged)).reason).toBe('unresolved-conflict');
    expect(
      expectConflictError(() =>
        editBlock(staged, { blockId: 'p1-r0', field: 'ocr', text: 'Blocked' }),
      ).reason,
    ).toBe('unresolved-conflict');

    // Editing an unrelated non-conflicted field remains allowed while conflict is staged.
    const editedUnconflicted = editBlock(staged, {
      blockId: 'p1-r0',
      field: 'translation',
      text: 'Bản dịch tự sửa 0',
      at: 550,
    });
    expect(getBlock(editedUnconflicted, 'p1-r0')?.translationText).toBe('Bản dịch tự sửa 0');

    // Step 1: resolve p1-r0 OCR partially -> conflict remains open for p1-r1.
    const partial = resolveConflict(
      editedUnconflicted,
      [{ blockId: 'p1-r0', field: 'ocr', strategy: 'keep-local' }],
      { at: 600 },
    );
    expect(partial.conflict?.conflicts).toHaveLength(2);
    expect(partial.sourceRevisionId).toBe('rev-1');
    expect(getBlock(partial, 'p1-r0')?.ocrText).toBe('Local O0');

    // Step 2: resolve remaining p1-r1 conflicts with accept-incoming and manual merge.
    const resolved = resolveConflict(
      partial,
      [
        { blockId: 'p1-r1', field: 'ocr', strategy: 'accept-incoming' },
        { blockId: 'p1-r1', field: 'translation', strategy: 'manual', text: 'Bản dịch hợp nhất 1' },
      ],
      { at: 700 },
    );

    expect(resolved.conflict).toBeNull();
    expect(resolved.sourceRevisionId).toBe('rev-2');
    expect(getBlock(resolved, 'p1-r0')?.ocrText).toBe('Local O0');
    expect(getBlock(resolved, 'p1-r0')?.sourceOcrText).toBe('Incoming O0');
    expect(getBlock(resolved, 'p1-r0')?.ocrDirty).toBe(true);
    expect(getBlock(resolved, 'p1-r0')?.translationText).toBe('Bản dịch tự sửa 0');

    expect(getBlock(resolved, 'p1-r1')?.ocrText).toBe('Incoming O1');
    expect(getBlock(resolved, 'p1-r1')?.ocrDirty).toBe(false);
    expect(getBlock(resolved, 'p1-r1')?.translationText).toBe('Bản dịch hợp nhất 1');
    expect(getBlock(resolved, 'p1-r1')?.sourceTranslationText).toBe('Bản dịch incoming 1');
    expect(getBlock(resolved, 'p1-r1')?.translationDirty).toBe(true);

    // Non-conflicted p1-r2 updated and p1-r3 added atomically upon finalization.
    expect(getBlock(resolved, 'p1-r2')?.ocrText).toBe('Incoming O2');
    expect(getBlock(resolved, 'p1-r2')?.dirty).toBe(false);
    expect(getBlock(resolved, 'p1-r3')?.ocrText).toBe('New block 3');

    // Undoing the conflict-resolution entry restores pre-resolution text cleanly.
    const undoneRes = undo(resolved);
    expect(getBlock(undoneRes, 'p1-r1')?.ocrText).toBe('Local O1');
    expect(getBlock(undoneRes, 'p1-r1')?.translationText).toBe('Bản dịch local 1');
    expect(undoneRes.sourceRevisionId).toBe('rev-2');
  });

  it('handles upstream block deletions across keep-local, accept-incoming, and unmodified blocks', () => {
    const s0 = createEditorState({
      documentId: 'doc-del',
      sourceRevisionId: 'rev-1',
      blocks: [
        { blockId: 'p1-r0', page: 1, ocrText: 'Keep me', translationText: 'Giữ' },
        { blockId: 'p1-r1', page: 1, ocrText: 'Drop me', translationText: 'Bỏ' },
        { blockId: 'p1-r2', page: 1, ocrText: 'Untouched gone', translationText: 'Không sửa' },
      ],
    });

    let s = editBlock(s0, { blockId: 'p1-r0', field: 'ocr', text: 'Keep me edited' });
    s = editBlock(s, { blockId: 'p1-r1', field: 'ocr', text: 'Drop me edited' });

    // Upstream rev-2 removes all 3 blocks and introduces p1-r3.
    const staged = syncSourceRevision(
      s,
      {
        sourceRevisionId: 'rev-2',
        blocks: [{ blockId: 'p1-r3', page: 1, ocrText: 'Replacement', translationText: 'Thay thế' }],
      },
      { onConflict: 'stage' },
    );

    expect(staged.conflict?.conflicts.map(c => `${c.blockId}:${c.removedInIncoming}`)).toEqual([
      'p1-r0:true',
      'p1-r1:true',
    ]);

    // Resolving across two calls verifies preservedRemovedBlockIds persists mid-resolution and across JSON export.
    const step1 = resolveConflict(staged, [{ blockId: 'p1-r0', field: 'ocr', strategy: 'keep-local' }]);
    const reimportedMid = importJson(exportJson(step1));
    const step2 = resolveConflict(reimportedMid, [{ blockId: 'p1-r1', field: 'ocr', strategy: 'accept-incoming' }]);

    expect(step2.conflict).toBeNull();
    expect(step2.sourceRevisionId).toBe('rev-2');
    expect(getBlock(step2, 'p1-r0')?.ocrText).toBe('Keep me edited');
    expect(getBlock(step2, 'p1-r1')).toBeUndefined();
    expect(getBlock(step2, 'p1-r2')).toBeUndefined();
    expect(getBlock(step2, 'p1-r3')?.ocrText).toBe('Replacement');
  });

  it('rejects source hash mismatches, mutating source without bumping revisionId, and invalid resolveConflict calls', () => {
    const s0 = createEditorState({
      documentId: 'doc-err',
      sourceRevisionId: 'rev-1',
      sourceSha256: SHA_A,
      blocks: [{ blockId: 'p1-r0', page: 1, ocrText: 'One', translationText: 'Một' }],
    });

    const hashErr = expectConflictError(() =>
      syncSourceRevision(s0, {
        sourceRevisionId: 'rev-2',
        sourceSha256: 'b'.repeat(64),
        blocks: [{ blockId: 'p1-r0', page: 1, ocrText: 'One', translationText: 'Một' }],
      }),
    );
    expect(hashErr.reason).toBe('source-hash-mismatch');

    const sameRevMutated = expectConflictError(() =>
      syncSourceRevision(s0, {
        sourceRevisionId: 'rev-1',
        sourceSha256: SHA_A,
        blocks: [{ blockId: 'p1-r0', page: 1, ocrText: 'Changed silently', translationText: 'Một' }],
      }),
    );
    expect(sameRevMutated.reason).toBe('stale-source-revision');
    expect(sameRevMutated.blockIds).toEqual(['p1-r0']);

    expectEditorError(
      () => resolveConflict(s0, [{ blockId: 'p1-r0', field: 'ocr', strategy: 'keep-local' }]),
      'no-conflict',
    );

    const edited = editBlock(s0, { blockId: 'p1-r0', field: 'ocr', text: 'Local' });
    const staged = syncSourceRevision(
      edited,
      {
        sourceRevisionId: 'rev-2',
        sourceSha256: SHA_A,
        blocks: [{ blockId: 'p1-r0', page: 1, ocrText: 'Incoming', translationText: 'Một' }],
      },
      { onConflict: 'stage' },
    );

    expectEditorError(
      () =>
        resolveConflict(staged, [
          { blockId: 'p1-r0', field: 'ocr', strategy: 'keep-local' },
          { blockId: 'p1-r0', field: 'ocr', strategy: 'accept-incoming' },
        ]),
      'duplicate-id',
    );
    expectEditorError(
      () => resolveConflict(staged, [{ blockId: 'p1-r0', field: 'ocr', strategy: 'manual' }]),
      'invalid-field',
    );
    expectEditorError(
      () => resolveConflict(staged, [{ blockId: 'p1-r0', field: 'translation', strategy: 'keep-local' }]),
      'no-conflict',
    );
  });
});

describe('H06 inline block editor: batch revert', () => {
  it('reverts multiple blocks atomically in one undoable step and supports field and target selection', () => {
    const s0 = createEditorState({
      documentId: 'doc-rev',
      sourceRevisionId: 'rev-1',
      blocks: [
        { blockId: 'p1-r0', page: 1, ocrText: 'Src0', translationText: 'TrSrc0' },
        { blockId: 'p1-r1', page: 1, ocrText: 'Src1', translationText: 'TrSrc1' },
        { blockId: 'p1-r2', page: 1, ocrText: 'Src2', translationText: 'TrSrc2' },
      ],
      at: 100,
    });

    let s = editBlock(s0, { blockId: 'p1-r0', field: 'ocr', text: 'Saved0', at: 200 });
    s = editBlock(s, { blockId: 'p1-r0', field: 'translation', text: 'TrSaved0', at: 300 });
    s = editBlock(s, { blockId: 'p1-r1', field: 'ocr', text: 'Saved1', at: 400 });
    s = markSaved(s, { at: 500 });

    s = editBlock(s, { blockId: 'p1-r0', field: 'ocr', text: 'Draft0', at: 600 });
    s = editBlock(s, { blockId: 'p1-r1', field: 'translation', text: 'TrDraft1', at: 700 });
    s = editBlock(s, { blockId: 'p1-r2', field: 'ocr', text: 'Draft2', at: 800 });

    // Revert only OCR to 'saved' on p1-r0 and p1-r1 (p1-r1 OCR was already 'Saved1', so only p1-r0 changes).
    const revertedSavedOcr = revertBlocks(s, ['p1-r0', 'p1-r1'], { field: 'ocr', to: 'saved', at: 900 });
    expect(getBlock(revertedSavedOcr, 'p1-r0')?.ocrText).toBe('Saved0');
    expect(getBlock(revertedSavedOcr, 'p1-r0')?.translationText).toBe('TrSaved0');
    expect(getBlock(revertedSavedOcr, 'p1-r1')?.translationText).toBe('TrDraft1');

    // Revert p1-r0 and p1-r1 completely back to 'source' in ONE atomic undoable step.
    const batchReverted = revertBlocks(revertedSavedOcr, ['p1-r0', 'p1-r1'], { to: 'source', at: 1000 });
    expect(getBlock(batchReverted, 'p1-r0')?.ocrText).toBe('Src0');
    expect(getBlock(batchReverted, 'p1-r0')?.translationText).toBe('TrSrc0');
    expect(getBlock(batchReverted, 'p1-r1')?.ocrText).toBe('Src1');
    expect(getBlock(batchReverted, 'p1-r1')?.translationText).toBe('TrSrc1');
    expect(getBlock(batchReverted, 'p1-r2')?.ocrText).toBe('Draft2');
    // Reverted back to source differs from saved snapshot ('Saved0'/'Saved1'), so pendingSave must be true.
    expect(pendingSave(batchReverted)).toBe(true);

    // One undo restores ALL blocks touched by the batch revert.
    const undoneBatch = undo(batchReverted, { at: 1100 });
    expect(getBlock(undoneBatch, 'p1-r0')?.ocrText).toBe('Saved0');
    expect(getBlock(undoneBatch, 'p1-r0')?.translationText).toBe('TrSaved0');
    expect(getBlock(undoneBatch, 'p1-r1')?.ocrText).toBe('Saved1');
    expect(getBlock(undoneBatch, 'p1-r1')?.translationText).toBe('TrDraft1');

    // Redo re-applies the batch revert.
    const redoneBatch = redo(undoneBatch, { at: 1200 });
    expect(getBlock(redoneBatch, 'p1-r0')?.ocrText).toBe('Src0');
    expect(getBlock(redoneBatch, 'p1-r1')?.translationText).toBe('TrSrc1');

    // revertAll reverts remaining modified blocks (p1-r2) and becomes no-op when repeated.
    const allReverted = revertAll(redoneBatch, { to: 'source', at: 1300 });
    expect(modifiedBlockIds(allReverted)).toEqual([]);
    expect(revertAll(allReverted, { to: 'source', at: 1400 })).toBe(allReverted);

    // revertBlock single-block convenience wrapper.
    const reEdited = editBlock(allReverted, { blockId: 'p1-r2', field: 'translation', text: 'Edited2', at: 1500 });
    const singleReverted = revertBlock(reEdited, 'p1-r2', { field: 'translation', to: 'source', at: 1600 });
    expect(getBlock(singleReverted, 'p1-r2')?.translationText).toBe('TrSrc2');
  });

  it('validates batch revert atomically without partial mutation on unknown block or stale revision', () => {
    const s0 = createEditorState({
      documentId: 'doc-rev-err',
      sourceRevisionId: 'rev-2',
      blocks: [
        { blockId: 'p1-r0', page: 1, ocrText: 'A', translationText: 'a' },
        { blockId: 'p1-r1', page: 1, ocrText: 'B', translationText: 'b' },
      ],
    });
    const s1 = editBlock(s0, { blockId: 'p1-r0', field: 'ocr', text: 'A-edited' });

    expectEditorError(() => revertBlocks(s1, ['p1-r0', 'p9-missing']), 'unknown-block');
    expect(getBlock(s1, 'p1-r0')?.ocrText).toBe('A-edited');

    expect(
      expectConflictError(() => revertBlocks(s1, ['p1-r0'], { expectedSourceRevisionId: 'rev-1' })).reason,
    ).toBe('stale-source-revision');
  });
});

describe('H06 inline block editor: snapshot recovery and boundary edge cases', () => {
  it('round-trips byte-identical canonical JSON and recovers against newer DocumentIR', () => {
    const irV1 = makeSampleDocument('rev-1', 'Total 1O0 EUR', 'Due date 01/02/2026');
    const s0 = createEditorStateFromDocument(irV1, { targetLang: 'vi', at: 100 });
    const s1 = editBlock(s0, { blockId: 'p1-r0', field: 'ocr', text: 'Total 100 EUR', at: 200 });
    const s2 = editBlock(s1, { blockId: 'p1-r1', field: 'translation', text: 'Hạn mới 01/02/2026', at: 300 });
    const s3 = undo(s2, { at: 400 });

    const json1 = exportJson(s3);
    const restored = importJson(json1);
    const json2 = exportJson(restored);
    expect(json2).toBe(json1);
    expect(canUndo(restored)).toBe(true);
    expect(canRedo(restored)).toBe(true);
    expect(pendingSave(restored)).toBe(true);

    // Recovering against rev-2 with an upstream change to p1-r0 stages conflict automatically.
    const irV2Conflict = makeSampleDocument('rev-2', 'Total 200 EUR', 'Due date 01/02/2026');
    const recoveredConflict = recoverFromSnapshot(json1, {
      document: irV2Conflict,
      targetLang: 'vi',
      at: 500,
    });
    expect(recoveredConflict.conflict?.incomingRevisionId).toBe('rev-2');
    expect(recoveredConflict.conflict?.conflicts).toEqual([
      {
        blockId: 'p1-r0',
        field: 'ocr',
        baseText: 'Total 1O0 EUR',
        localText: 'Total 100 EUR',
        incomingText: 'Total 200 EUR',
      },
    ]);

    // Recovering against rev-2 where only p1-r1 OCR changed fast-forwards cleanly and keeps p1-r0 local edit.
    const irV2Clean = makeSampleDocument('rev-2', 'Total 1O0 EUR', 'Due date 09/09/2026');
    const recoveredClean = recoverFromSnapshot(json1, {
      document: irV2Clean,
      targetLang: 'vi',
      at: 500,
    });
    expect(recoveredClean.conflict).toBeNull();
    expect(recoveredClean.sourceRevisionId).toBe('rev-2');
    expect(getBlock(recoveredClean, 'p1-r0')?.ocrText).toBe('Total 100 EUR');
    expect(getBlock(recoveredClean, 'p1-r1')?.ocrText).toBe('Due date 09/09/2026');
  });

  it('rejects malformed, unsupported-version, and duplicate-id snapshots and reconciles stale derived flags', () => {
    expectEditorError(() => importJson('{not valid json'), 'malformed-json');
    expectEditorError(() => importJson('[]'), 'malformed-export');

    const baseJson = exportJson(
      editBlock(
        createEditorState({
          documentId: 'doc-snap',
          sourceRevisionId: 'rev-1',
          blocks: [{ blockId: 'p1-r0', page: 1, ocrText: 'Orig', translationText: 'Gốc' }],
        }),
        { blockId: 'p1-r0', field: 'ocr', text: 'Edited' },
      ),
    );
    const parsed = JSON.parse(baseJson) as Record<string, unknown>;

    expectEditorError(
      () => importJson(JSON.stringify({ ...parsed, schemaVersion: 99 })),
      'unsupported-schema-version',
    );
    expectEditorError(
      () => importJson(JSON.stringify({ ...parsed, kind: 'wrong.kind' })),
      'malformed-export',
    );
    expectEditorError(
      () => importJson(JSON.stringify({ ...parsed, sourceSha256: 'not-hex' })),
      'invalid-field',
    );

    const blocksArr = parsed.blocks as Record<string, unknown>[];
    expectEditorError(
      () => importJson(JSON.stringify({ ...parsed, blocks: [blocksArr[0], blocksArr[0]] })),
      'duplicate-id',
    );

    // If autosave.pendingSave was stale false in a crashed snapshot while text != savedText, importJson reconciles it.
    const staleAutosave = {
      ...parsed,
      autosave: { ...(parsed.autosave as Record<string, unknown>), pendingSave: false, scheduledAt: null },
    };
    const reconciled = importJson(JSON.stringify(staleAutosave));
    expect(pendingSave(reconciled)).toBe(true);
    expect(isDirty(reconciled)).toBe(true);
    expect(getBlock(reconciled, 'p1-r0')?.dirty).toBe(true);
  });

  it('enforces maxHistory cap and handles compareWithSource against saved, ocr, and oversized text', () => {
    const s0 = createEditorState({
      documentId: 'doc-edge',
      sourceRevisionId: 'rev-1',
      maxHistory: 2,
      blocks: [{ blockId: 'p1-r0', page: 1, ocrText: 'OCR zero', translationText: 'TR zero' }],
    });

    let s = editBlock(s0, { blockId: 'p1-r0', field: 'ocr', text: 'OCR one' });
    s = editBlock(s, { blockId: 'p1-r0', field: 'ocr', text: 'OCR two' });
    s = editBlock(s, { blockId: 'p1-r0', field: 'ocr', text: 'OCR three' });
    expect(s.undoStack).toHaveLength(2);
    expect(getBlock(undo(undo(s)), 'p1-r0')?.ocrText).toBe('OCR one');

    const saved = markSaved(s, { at: 100 });
    const afterSave = editBlock(saved, { blockId: 'p1-r0', field: 'ocr', text: 'OCR four', at: 200 });
    const vsSaved = compareWithSource(afterSave, 'p1-r0', 'ocr', { against: 'saved' });
    expect(vsSaved.sourceText).toBe('OCR three');
    expect(vsSaved.editedText).toBe('OCR four');
    expect(vsSaved.wordsDeleted).toBe(1);
    expect(vsSaved.wordsAdded).toBe(1);

    const trEdited = editBlock(afterSave, { blockId: 'p1-r0', field: 'translation', text: 'OCR four' });
    const vsOcr = compareWithSource(trEdited, 'p1-r0', 'translation', { against: 'ocr' });
    expect(vsOcr.sourceText).toBe('OCR zero');
    expect(vsOcr.editedText).toBe('OCR four');

    // Oversized middle (> DIFF_MAX_DP_CELLS) falls back safely without throwing or allocating huge DP tables.
    const bigLeft = `prefix ${'a'.repeat(1200)} suffix`;
    const bigRight = `prefix ${'b'.repeat(1200)} suffix`;
    const bigState = editBlock(
      createEditorState({
        documentId: 'doc-big',
        sourceRevisionId: 'rev-1',
        blocks: [{ blockId: 'p1-r0', page: 1, ocrText: bigLeft, translationText: '' }],
      }),
      { blockId: 'p1-r0', field: 'ocr', text: bigRight },
    );
    const bigCmp = compareWithSource(bigState, 'p1-r0', 'ocr');
    expect(bigCmp.changed).toBe(true);
    expect(bigCmp.charRuns[0]).toEqual({ kind: 'equal', text: 'prefix ' });
    expect(bigCmp.charRuns[bigCmp.charRuns.length - 1]).toEqual({ kind: 'equal', text: ' suffix' });
  });
});
