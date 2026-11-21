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
  redo,
  syncDocumentRevision,
  syncSourceRevision,
  undo,
  type InlineEditorState,
} from '../src/core/inline-editor';
import { addTranslation, buildDocument, type DocumentIR } from '../src/core/ir';

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
