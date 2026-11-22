/**
 * Inline OCR and translated block editor with undo/redo, debounced autosave,
 * source-vs-edited comparison, optimistic revision safety, and JSON snapshot
 * serialization (backlog item H06).
 *
 * Contract:
 * - Pure immutable state transitions: no DOM, no timers, no global clock reads,
 *   and no in-place mutation of prior `InlineEditorState` values. Every mutation
 *   returns a fresh state object so snapshots and time-travel are deterministic.
 * - Block identity and provenance align with `ir.ts` (`blockId` such as `p1-r0`,
 *   1-based `page`, `documentId`, `sourceRevisionId`, `sourceSha256`).
 * - History coalesces consecutive edits to the same `(blockId, field)` within
 *   `coalesceWindowMs` (or when `coalesce: true` is passed) unless separated by
 *   an explicit checkpoint, field/block change, save, or undo/redo.
 * - Autosave tracks unsaved dirtiness relative to the last saved baseline
 *   (`savedOcrText`/`savedTranslationText`), while source comparison and revert
 *   retain the original `sourceOcrText`/`sourceTranslationText` baseline.
 * - Optimistic revision checks throw `RevisionConflictError` when
 *   `expectedSourceRevisionId` is stale or when an upstream `sourceRevisionId`
 *   update alters a block that has un-rebased local edits (unless `onConflict: 'stage'`
 *   is chosen for interactive resolution via `resolveConflict`).
 * - `exportJson` / `importJson` round-trip canonical schema-versioned JSON for
 *   crash recovery and deterministic replay.
 */

import { DIFF_MAX_DP_CELLS } from './diff';
import type { DocumentIR, Translation } from './ir';

// --- Constants -------------------------------------------------------------

export const INLINE_EDITOR_SCHEMA_VERSION = 1;
export const INLINE_EDITOR_EXPORT_KIND = 'mirror.inline-editor';

export const DEFAULT_COALESCE_WINDOW_MS = 500;
export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 1000;
export const DEFAULT_MAX_HISTORY = 200;

export const EDITABLE_FIELDS = ['ocr', 'translation'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export const HISTORY_ENTRY_KINDS = ['edit', 'revert', 'conflict-resolution'] as const;
export type HistoryEntryKind = (typeof HISTORY_ENTRY_KINDS)[number];

export const CONFLICT_STRATEGIES = ['keep-local', 'accept-incoming', 'manual'] as const;
export type ConflictStrategy = (typeof CONFLICT_STRATEGIES)[number];

const SHA256_HEX_RE = /^[0-9a-f]{64}$/iu;

// --- Errors ----------------------------------------------------------------

export type InlineEditorErrorCode =
  | 'invalid-field'
  | 'unknown-block'
  | 'duplicate-id'
  | 'malformed-json'
  | 'malformed-export'
  | 'unsupported-schema-version'
  | 'no-conflict';

export class InlineEditorError extends Error {
  readonly code: InlineEditorErrorCode;
  readonly path: string;

  constructor(code: InlineEditorErrorCode, message: string, path = '') {
    super(path ? `${path}: ${message}` : message);
    this.name = 'InlineEditorError';
    this.code = code;
    this.path = path;
  }
}

export type RevisionConflictReason =
  | 'stale-source-revision'
  | 'unresolved-conflict'
  | 'source-hash-mismatch';

export interface BlockConflictDetail {
  readonly blockId: string;
  readonly field: EditableField;
  readonly baseText: string;
  readonly localText: string;
  readonly incomingText: string;
  readonly removedInIncoming?: boolean;
}

export interface RevisionConflictErrorParams {
  reason: RevisionConflictReason;
  expectedRevisionId: string;
  actualRevisionId: string;
  blockIds?: readonly string[];
  conflicts?: readonly BlockConflictDetail[];
  message?: string;
}

export class RevisionConflictError extends Error {
  readonly code = 'revision-conflict' as const;
  readonly reason: RevisionConflictReason;
  readonly expectedRevisionId: string;
  readonly actualRevisionId: string;
  readonly blockIds: readonly string[];
  readonly conflicts: readonly BlockConflictDetail[];

  constructor(params: RevisionConflictErrorParams) {
    const defaultMessage =
      params.reason === 'unresolved-conflict'
        ? `Unresolved revision conflict between "${params.expectedRevisionId}" and "${params.actualRevisionId}".`
        : params.reason === 'source-hash-mismatch'
          ? `Source SHA-256 mismatch while syncing revision "${params.expectedRevisionId}" -> "${params.actualRevisionId}".`
          : `Expected sourceRevisionId "${params.expectedRevisionId}", but actual is "${params.actualRevisionId}".`;
    super(params.message ?? defaultMessage);
    this.name = 'RevisionConflictError';
    this.reason = params.reason;
    this.expectedRevisionId = params.expectedRevisionId;
    this.actualRevisionId = params.actualRevisionId;
    this.blockIds = [...(params.blockIds ?? [])];
    this.conflicts = (params.conflicts ?? []).map(cloneConflictDetail);
  }
}

// --- Public state & input/output types -------------------------------------

export interface EditorBlockInput {
  blockId: string;
  page: number;
  ocrText: string;
  translationText?: string;
  targetLang?: string;
  translationEngine?: string;
}

export interface EditorBlockState {
  readonly blockId: string;
  readonly page: number;
  readonly sourceOcrText: string;
  readonly sourceTranslationText: string;
  readonly savedOcrText: string;
  readonly savedTranslationText: string;
  readonly ocrText: string;
  readonly translationText: string;
  readonly targetLang?: string;
  readonly translationEngine?: string;
  readonly sourceRevisionId: string;
  readonly ocrDirty: boolean;
  readonly translationDirty: boolean;
  readonly dirty: boolean;
  readonly ocrModifiedFromSource: boolean;
  readonly translationModifiedFromSource: boolean;
}

export interface InlineEditorConfig {
  readonly coalesceWindowMs: number;
  readonly autosaveDebounceMs: number;
  readonly maxHistory: number;
}

export interface AutosaveState {
  readonly pendingSave: boolean;
  readonly dirtySinceAt: number | null;
  readonly scheduledAt: number | null;
  readonly lastEditAt: number | null;
  readonly lastSavedAt: number | null;
  readonly lastSavedRevision: number;
}

export interface AutosaveSchedule {
  readonly pendingSave: boolean;
  readonly due: boolean;
  readonly delayMs: number | null;
  readonly scheduledAt: number | null;
  readonly dirtySinceAt: number | null;
  readonly lastSavedAt: number | null;
  readonly lastSavedRevision: number;
}

export interface BlockFieldChange {
  readonly blockId: string;
  readonly field: EditableField;
  readonly before: string;
  readonly after: string;
}

export interface HistoryEntry {
  readonly id: string;
  readonly kind: HistoryEntryKind;
  readonly changes: readonly BlockFieldChange[];
  readonly openedAt: number;
  readonly lastAt: number;
  readonly closed: boolean;
}

export interface RevisionConflictState {
  readonly baseRevisionId: string;
  readonly incomingRevisionId: string;
  readonly incomingSourceSha256?: string;
  readonly conflicts: readonly BlockConflictDetail[];
  readonly incomingBlocks: readonly EditorBlockInput[];
  readonly preservedRemovedBlockIds?: readonly string[];
}

export interface InlineEditorState {
  readonly schemaVersion: number;
  readonly documentId: string;
  readonly sourceRevisionId: string;
  readonly sourceSha256?: string;
  readonly revision: number;
  readonly nextHistorySeq: number;
  readonly createdAt: number;
  readonly config: InlineEditorConfig;
  readonly autosave: AutosaveState;
  readonly blocks: readonly EditorBlockState[];
  readonly undoStack: readonly HistoryEntry[];
  readonly redoStack: readonly HistoryEntry[];
  readonly conflict: RevisionConflictState | null;
}

export interface CreateEditorStateInput {
  documentId: string;
  sourceRevisionId: string;
  sourceSha256?: string;
  blocks: readonly EditorBlockInput[];
  coalesceWindowMs?: number;
  autosaveDebounceMs?: number;
  maxHistory?: number;
  at?: number;
}

export interface CreateFromDocumentOptions {
  targetLang?: string;
  engine?: string;
  coalesceWindowMs?: number;
  autosaveDebounceMs?: number;
  maxHistory?: number;
  at?: number;
}

export interface EditBlockInput {
  blockId: string;
  field: EditableField;
  text: string;
  at?: number;
  coalesce?: boolean;
  checkpoint?: boolean;
  expectedSourceRevisionId?: string;
}

export interface HistoryStepOptions {
  at?: number;
}

export interface MarkSavedOptions {
  at?: number;
  blockIds?: readonly string[];
  expectedSourceRevisionId?: string;
}

export interface DiffRun {
  readonly kind: 'equal' | 'insert' | 'delete';
  readonly text: string;
}

export interface CompareOptions {
  against?: 'source' | 'saved' | 'ocr';
}

export interface SourceComparison {
  readonly blockId: string;
  readonly field: EditableField;
  readonly against: 'source' | 'saved' | 'ocr';
  readonly sourceText: string;
  readonly editedText: string;
  readonly changed: boolean;
  readonly similarity: number;
  readonly wordRuns: readonly DiffRun[];
  readonly charRuns: readonly DiffRun[];
  readonly wordsAdded: number;
  readonly wordsDeleted: number;
  readonly charsAdded: number;
  readonly charsDeleted: number;
  readonly sourceWordCount: number;
  readonly editedWordCount: number;
  readonly sourceCharCount: number;
  readonly editedCharCount: number;
}

export interface SourceRevisionUpdate {
  sourceRevisionId: string;
  sourceSha256?: string;
  blocks: readonly EditorBlockInput[];
}

export interface SyncRevisionOptions {
  expectedSourceRevisionId?: string;
  onConflict?: 'throw' | 'stage';
  allowSourceHashChange?: boolean;
  at?: number;
}

export interface SyncDocumentOptions extends SyncRevisionOptions {
  targetLang?: string;
  engine?: string;
}

export interface ConflictResolution {
  blockId: string;
  field: EditableField;
  strategy: ConflictStrategy;
  text?: string;
}

export interface ResolveConflictOptions {
  at?: number;
}

export interface RevertOptions {
  field?: EditableField | 'both';
  to?: 'source' | 'saved';
  at?: number;
  expectedSourceRevisionId?: string;
}

export interface RecoverSnapshotOptions {
  document?: DocumentIR;
  sourceUpdate?: SourceRevisionUpdate;
  targetLang?: string;
  engine?: string;
  onConflict?: 'throw' | 'stage';
  allowSourceHashChange?: boolean;
  at?: number;
}

// --- State initialization & query helpers ----------------------------------

export function createEditorState(input: CreateEditorStateInput): InlineEditorState {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InlineEditorError('invalid-field', 'createEditorState expects an options object.', 'input');
  }
  const documentId = requireText(input.documentId, 'documentId');
  const sourceRevisionId = requireText(input.sourceRevisionId, 'sourceRevisionId');
  const sourceSha256 =
    input.sourceSha256 !== undefined ? requireSha256(input.sourceSha256, 'sourceSha256') : undefined;

  if (!Array.isArray(input.blocks)) {
    throw new InlineEditorError('invalid-field', 'blocks must be an array.', 'blocks');
  }

  const createdAt = input.at !== undefined ? requireTimestamp(input.at, 'at') : 0;
  const config = readConfig(input);
  const blocks = normalizeBlockInputs(input.blocks, sourceRevisionId, 'blocks');

  return {
    schemaVersion: INLINE_EDITOR_SCHEMA_VERSION,
    documentId,
    sourceRevisionId,
    ...(sourceSha256 !== undefined ? { sourceSha256 } : {}),
    revision: 0,
    nextHistorySeq: 1,
    createdAt,
    config,
    autosave: {
      pendingSave: false,
      dirtySinceAt: null,
      scheduledAt: null,
      lastEditAt: null,
      lastSavedAt: createdAt,
      lastSavedRevision: 0,
    },
    blocks,
    undoStack: [],
    redoStack: [],
    conflict: null,
  };
}

export function createEditorStateFromDocument(
  ir: DocumentIR,
  options: CreateFromDocumentOptions = {},
): InlineEditorState {
  if (typeof ir !== 'object' || ir === null || Array.isArray(ir)) {
    throw new InlineEditorError('invalid-field', 'createEditorStateFromDocument expects a DocumentIR.', 'ir');
  }
  const settings = typeof options === 'object' && options !== null ? options : {};
  const blocks = extractBlocksFromIr(ir, settings.targetLang, settings.engine);
  return createEditorState({
    documentId: ir.documentId,
    sourceRevisionId: ir.revisionId,
    ...(typeof ir.sourceSha256 === 'string' && ir.sourceSha256.length > 0 ? { sourceSha256: ir.sourceSha256 } : {}),
    blocks,
    ...(settings.coalesceWindowMs !== undefined ? { coalesceWindowMs: settings.coalesceWindowMs } : {}),
    ...(settings.autosaveDebounceMs !== undefined ? { autosaveDebounceMs: settings.autosaveDebounceMs } : {}),
    ...(settings.maxHistory !== undefined ? { maxHistory: settings.maxHistory } : {}),
    ...(settings.at !== undefined ? { at: settings.at } : {}),
  });
}

export function getBlock(state: InlineEditorState, blockId: string): EditorBlockState | undefined {
  if (typeof blockId !== 'string') return undefined;
  const trimmed = blockId.trim();
  if (trimmed.length === 0) return undefined;
  return state.blocks.find(b => b.blockId === trimmed);
}

export function isDirty(state: InlineEditorState): boolean {
  return state.blocks.some(b => b.dirty);
}

export function dirtyBlockIds(state: InlineEditorState): string[] {
  return state.blocks.filter(b => b.dirty).map(b => b.blockId);
}

export function modifiedBlockIds(state: InlineEditorState): string[] {
  return state.blocks
    .filter(b => b.ocrModifiedFromSource || b.translationModifiedFromSource)
    .map(b => b.blockId);
}

export function canUndo(state: InlineEditorState): boolean {
  return state.undoStack.length > 0;
}

export function canRedo(state: InlineEditorState): boolean {
  return state.redoStack.length > 0;
}

export function pendingSave(state: InlineEditorState): boolean {
  return state.autosave.pendingSave;
}

export function isAutosaveDue(state: InlineEditorState, nowMs: number): boolean {
  const now = requireTimestamp(nowMs, 'nowMs');
  return state.autosave.pendingSave && state.autosave.scheduledAt !== null && now >= state.autosave.scheduledAt;
}

export function getAutosaveSchedule(state: InlineEditorState, nowMs?: number): AutosaveSchedule {
  const now = nowMs !== undefined ? requireTimestamp(nowMs, 'nowMs') : undefined;
  const scheduledAt = state.autosave.scheduledAt;
  const pending = state.autosave.pendingSave;
  const due = pending && scheduledAt !== null && now !== undefined && now >= scheduledAt;
  const delayMs =
    pending && scheduledAt !== null && now !== undefined ? Math.max(0, scheduledAt - now) : null;
  return {
    pendingSave: pending,
    due,
    delayMs,
    scheduledAt,
    dirtySinceAt: state.autosave.dirtySinceAt,
    lastSavedAt: state.autosave.lastSavedAt,
    lastSavedRevision: state.autosave.lastSavedRevision,
  };
}

// --- Inline editing & undo/redo --------------------------------------------

export function editBlock(state: InlineEditorState, input: EditBlockInput): InlineEditorState {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InlineEditorError('invalid-field', 'editBlock expects an input object.', 'input');
  }
  const blockId = requireText(input.blockId, 'blockId');
  const field = requireEditableField(input.field, 'field');
  const text = requireString(input.text, 'text');
  assertExpectedRevision(state, input.expectedSourceRevisionId);

  const blockIndex = state.blocks.findIndex(b => b.blockId === blockId);
  if (blockIndex === -1) {
    throw new InlineEditorError('unknown-block', `Block "${blockId}" was not found.`, 'blockId');
  }
  const currentBlock = state.blocks[blockIndex]!;

  if (state.conflict !== null) {
    const blocked = state.conflict.conflicts.filter(c => c.blockId === blockId && c.field === field);
    if (blocked.length > 0) {
      throw new RevisionConflictError({
        reason: 'unresolved-conflict',
        expectedRevisionId: state.conflict.baseRevisionId,
        actualRevisionId: state.conflict.incomingRevisionId,
        blockIds: [blockId],
        conflicts: blocked,
      });
    }
  }

  const currentValue = fieldValue(currentBlock, field);
  if (text === currentValue) {
    return state;
  }

  const editAt =
    input.at !== undefined
      ? requireTimestamp(input.at, 'at')
      : state.autosave.lastEditAt ?? state.autosave.lastSavedAt ?? state.createdAt;

  const updatedBlock = applyBlockFieldUpdate(currentBlock, field, text);
  const nextBlocks = state.blocks.map((b, idx) => (idx === blockIndex ? updatedBlock : b));

  const top = state.undoStack[state.undoStack.length - 1];
  const topChange = top?.changes.length === 1 ? top.changes[0] : undefined;
  const canCoalesceByWindow =
    input.at !== undefined &&
    top !== undefined &&
    input.at >= top.lastAt &&
    input.at - top.lastAt <= state.config.coalesceWindowMs;

  const shouldCoalesce =
    top !== undefined &&
    top.kind === 'edit' &&
    !top.closed &&
    topChange !== undefined &&
    topChange.blockId === blockId &&
    topChange.field === field &&
    input.checkpoint !== true &&
    (input.coalesce === true || canCoalesceByWindow);

  let nextUndoStack: HistoryEntry[];
  let nextHistorySeq = state.nextHistorySeq;

  if (shouldCoalesce && top !== undefined && topChange !== undefined) {
    if (topChange.before === text) {
      // Typing then backspacing back to the pre-frame value collapses the empty step.
      nextUndoStack = state.undoStack.slice(0, -1);
    } else {
      const mergedEntry: HistoryEntry = {
        id: top.id,
        kind: 'edit',
        changes: [{ blockId, field, before: topChange.before, after: text }],
        openedAt: top.openedAt,
        lastAt: editAt,
        closed: false,
      };
      nextUndoStack = [...state.undoStack.slice(0, -1), mergedEntry];
    }
  } else {
    const newEntry: HistoryEntry = {
      id: `h${nextHistorySeq}`,
      kind: 'edit',
      changes: [{ blockId, field, before: currentValue, after: text }],
      openedAt: editAt,
      lastAt: editAt,
      closed: false,
    };
    nextHistorySeq += 1;
    nextUndoStack = trimHistory([...closeTopEntry(state.undoStack), newEntry], state.config.maxHistory);
  }

  return commitTransition(state, {
    blocks: nextBlocks,
    undoStack: nextUndoStack,
    redoStack: [],
    nextHistorySeq,
    editAt,
  });
}

export function commitCheckpoint(state: InlineEditorState): InlineEditorState {
  const top = state.undoStack[state.undoStack.length - 1];
  if (top === undefined || top.closed) {
    return state;
  }
  return {
    ...state,
    undoStack: closeTopEntry(state.undoStack),
  };
}

export function undo(state: InlineEditorState, options: HistoryStepOptions = {}): InlineEditorState {
  return applyHistoryStep(state, 'undo', options);
}

export function redo(state: InlineEditorState, options: HistoryStepOptions = {}): InlineEditorState {
  return applyHistoryStep(state, 'redo', options);
}

function applyHistoryStep(
  state: InlineEditorState,
  direction: 'undo' | 'redo',
  options: HistoryStepOptions,
): InlineEditorState {
  assertNoUnresolvedConflict(state);
  const sourceStack = direction === 'undo' ? state.undoStack : state.redoStack;
  const targetStack = direction === 'undo' ? state.redoStack : state.undoStack;
  const entry = sourceStack[sourceStack.length - 1];
  if (entry === undefined) {
    return state;
  }

  const stepAt =
    options?.at !== undefined
      ? requireTimestamp(options.at, 'at')
      : state.autosave.lastEditAt ?? state.autosave.lastSavedAt ?? state.createdAt;

  const blockMap = new Map<string, EditorBlockState>();
  for (const b of state.blocks) blockMap.set(b.blockId, b);

  const orderedChanges = direction === 'undo' ? [...entry.changes].reverse() : entry.changes;
  for (const change of orderedChanges) {
    const existing = blockMap.get(change.blockId);
    if (existing === undefined) continue;
    const nextValue = direction === 'undo' ? change.before : change.after;
    blockMap.set(change.blockId, applyBlockFieldUpdate(existing, change.field, nextValue));
  }

  const nextBlocks = state.blocks.map(b => blockMap.get(b.blockId) ?? b);
  const closedEntry: HistoryEntry = entry.closed ? entry : { ...entry, closed: true };
  const nextSourceStack = closeTopEntry(sourceStack.slice(0, -1));
  const nextTargetStack = trimHistory([...closeTopEntry(targetStack), closedEntry], state.config.maxHistory);

  return commitTransition(state, {
    blocks: nextBlocks,
    undoStack: direction === 'undo' ? nextSourceStack : nextTargetStack,
    redoStack: direction === 'undo' ? nextTargetStack : nextSourceStack,
    nextHistorySeq: state.nextHistorySeq,
    editAt: stepAt,
  });
}

// --- Autosave --------------------------------------------------------------

export function markSaved(state: InlineEditorState, options: MarkSavedOptions = {}): InlineEditorState {
  const settings = typeof options === 'object' && options !== null ? options : {};
  assertExpectedRevision(state, settings.expectedSourceRevisionId);
  assertNoUnresolvedConflict(state);

  let selectedSet: Set<string> | undefined;
  if (settings.blockIds !== undefined) {
    if (!Array.isArray(settings.blockIds)) {
      throw new InlineEditorError('invalid-field', 'blockIds must be an array.', 'blockIds');
    }
    selectedSet = new Set<string>();
    for (let idx = 0; idx < settings.blockIds.length; idx += 1) {
      const id = requireText(settings.blockIds[idx], `blockIds[${idx}]`);
      if (!state.blocks.some(b => b.blockId === id)) {
        throw new InlineEditorError('unknown-block', `Block "${id}" was not found.`, `blockIds[${idx}]`);
      }
      selectedSet.add(id);
    }
  }

  const savedAt =
    settings.at !== undefined
      ? requireTimestamp(settings.at, 'at')
      : state.autosave.lastEditAt ?? state.autosave.lastSavedAt ?? state.createdAt;

  const nextBlocks = state.blocks.map(block => {
    if (selectedSet !== undefined && !selectedSet.has(block.blockId)) {
      return block;
    }
    return buildBlockState({
      blockId: block.blockId,
      page: block.page,
      sourceOcrText: block.sourceOcrText,
      sourceTranslationText: block.sourceTranslationText,
      savedOcrText: block.ocrText,
      savedTranslationText: block.translationText,
      ocrText: block.ocrText,
      translationText: block.translationText,
      targetLang: block.targetLang,
      translationEngine: block.translationEngine,
      sourceRevisionId: block.sourceRevisionId,
    });
  });

  const stillDirty = nextBlocks.some(b => b.dirty);

  return {
    ...state,
    blocks: nextBlocks,
    undoStack: closeTopEntry(state.undoStack),
    autosave: {
      pendingSave: stillDirty,
      dirtySinceAt: stillDirty ? state.autosave.dirtySinceAt ?? savedAt : null,
      scheduledAt: stillDirty ? savedAt + state.config.autosaveDebounceMs : null,
      lastEditAt: state.autosave.lastEditAt,
      lastSavedAt: savedAt,
      lastSavedRevision: state.revision,
    },
  };
}

// --- Source comparison (word + char diff) ----------------------------------

export function compareWithSource(
  state: InlineEditorState,
  blockId: string,
  field: EditableField = 'ocr',
  options: CompareOptions = {},
): SourceComparison {
  const key = requireText(blockId, 'blockId');
  const targetField = requireEditableField(field, 'field');
  const against = options?.against ?? 'source';
  if (against !== 'source' && against !== 'saved' && against !== 'ocr') {
    throw new InlineEditorError('invalid-field', 'against must be source | saved | ocr.', 'against');
  }

  const block = getBlock(state, key);
  if (block === undefined) {
    throw new InlineEditorError('unknown-block', `Block "${key}" was not found.`, 'blockId');
  }

  const editedText = fieldValue(block, targetField);
  const sourceText =
    against === 'saved'
      ? targetField === 'ocr'
        ? block.savedOcrText
        : block.savedTranslationText
      : against === 'ocr'
        ? block.sourceOcrText
        : targetField === 'ocr'
          ? block.sourceOcrText
          : block.sourceTranslationText;

  const sourceWords = tokenizeWords(sourceText);
  const editedWords = tokenizeWords(editedText);
  const wordDiff = computeSequenceDiff(sourceWords, editedWords);
  const wordRuns = mergeDiffRuns(wordDiff, ' ');

  const sourceChars = Array.from(sourceText);
  const editedChars = Array.from(editedText);
  const charDiff = computeSequenceDiff(sourceChars, editedChars);
  const charRuns = mergeDiffRuns(charDiff, '');

  let wordsAdded = 0;
  let wordsDeleted = 0;
  for (const run of wordDiff) {
    if (run.kind === 'insert') wordsAdded += run.tokens.length;
    else if (run.kind === 'delete') wordsDeleted += run.tokens.length;
  }

  let charsAdded = 0;
  let charsDeleted = 0;
  let equalChars = 0;
  for (const run of charDiff) {
    if (run.kind === 'insert') charsAdded += run.tokens.length;
    else if (run.kind === 'delete') charsDeleted += run.tokens.length;
    else equalChars += run.tokens.length;
  }

  const sourceCharCount = sourceChars.length;
  const editedCharCount = editedChars.length;
  const similarity =
    sourceText === editedText || (sourceCharCount === 0 && editedCharCount === 0)
      ? 1
      : sourceCharCount === 0 || editedCharCount === 0
        ? 0
        : round4((2 * equalChars) / (sourceCharCount + editedCharCount));

  return {
    blockId: block.blockId,
    field: targetField,
    against,
    sourceText,
    editedText,
    changed: sourceText !== editedText,
    similarity,
    wordRuns,
    charRuns,
    wordsAdded,
    wordsDeleted,
    charsAdded,
    charsDeleted,
    sourceWordCount: sourceWords.length,
    editedWordCount: editedWords.length,
    sourceCharCount,
    editedCharCount,
  };
}

// --- Optimistic revision sync & conflict resolution ------------------------

export function syncDocumentRevision(
  state: InlineEditorState,
  ir: DocumentIR,
  options: SyncDocumentOptions = {},
): InlineEditorState {
  if (typeof ir !== 'object' || ir === null || Array.isArray(ir)) {
    throw new InlineEditorError('invalid-field', 'syncDocumentRevision expects a DocumentIR.', 'ir');
  }
  const settings = typeof options === 'object' && options !== null ? options : {};
  if (ir.documentId !== state.documentId) {
    throw new InlineEditorError(
      'invalid-field',
      `Document id "${ir.documentId}" does not match editor state "${state.documentId}".`,
      'documentId',
    );
  }
  const blocks = extractBlocksFromIr(ir, settings.targetLang, settings.engine);
  return syncSourceRevision(
    state,
    {
      sourceRevisionId: ir.revisionId,
      ...(typeof ir.sourceSha256 === 'string' && ir.sourceSha256.length > 0 ? { sourceSha256: ir.sourceSha256 } : {}),
      blocks,
    },
    settings,
  );
}

export function syncSourceRevision(
  state: InlineEditorState,
  incoming: SourceRevisionUpdate,
  options: SyncRevisionOptions = {},
): InlineEditorState {
  if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
    throw new InlineEditorError('invalid-field', 'syncSourceRevision expects an update object.', 'incoming');
  }
  const settings = typeof options === 'object' && options !== null ? options : {};
  assertExpectedRevision(state, settings.expectedSourceRevisionId);
  assertNoUnresolvedConflict(state);

  const incomingRevisionId = requireText(incoming.sourceRevisionId, 'sourceRevisionId');
  const incomingSha =
    incoming.sourceSha256 !== undefined ? requireSha256(incoming.sourceSha256, 'sourceSha256') : undefined;

  if (
    settings.allowSourceHashChange !== true &&
    state.sourceSha256 !== undefined &&
    incomingSha !== undefined &&
    incomingSha !== state.sourceSha256
  ) {
    throw new RevisionConflictError({
      reason: 'source-hash-mismatch',
      expectedRevisionId: state.sourceRevisionId,
      actualRevisionId: incomingRevisionId,
    });
  }

  if (!Array.isArray(incoming.blocks)) {
    throw new InlineEditorError('invalid-field', 'incoming.blocks must be an array.', 'blocks');
  }
  const normalizedIncoming = normalizeBlockInputs(incoming.blocks, incomingRevisionId, 'incoming.blocks');

  if (incomingRevisionId === state.sourceRevisionId) {
    if (sameBlockSources(state.blocks, normalizedIncoming)) {
      return state;
    }
    throw new RevisionConflictError({
      reason: 'stale-source-revision',
      expectedRevisionId: state.sourceRevisionId,
      actualRevisionId: incomingRevisionId,
      blockIds: changedSourceBlockIds(state.blocks, normalizedIncoming),
    });
  }

  const incomingById = new Map<string, EditorBlockState>();
  for (const b of normalizedIncoming) incomingById.set(b.blockId, b);

  const conflicts: BlockConflictDetail[] = [];
  for (const existing of state.blocks) {
    const next = incomingById.get(existing.blockId);
    const ocrLocallyModified =
      existing.ocrText !== existing.sourceOcrText || existing.savedOcrText !== existing.sourceOcrText;
    const trLocallyModified =
      existing.translationText !== existing.sourceTranslationText ||
      existing.savedTranslationText !== existing.sourceTranslationText;

    if (next === undefined) {
      if (ocrLocallyModified) {
        conflicts.push({
          blockId: existing.blockId,
          field: 'ocr',
          baseText: existing.sourceOcrText,
          localText: existing.ocrText,
          incomingText: '',
          removedInIncoming: true,
        });
      }
      if (trLocallyModified) {
        conflicts.push({
          blockId: existing.blockId,
          field: 'translation',
          baseText: existing.sourceTranslationText,
          localText: existing.translationText,
          incomingText: '',
          removedInIncoming: true,
        });
      }
      continue;
    }

    if (
      next.sourceOcrText !== existing.sourceOcrText &&
      ocrLocallyModified &&
      next.sourceOcrText !== existing.ocrText
    ) {
      conflicts.push({
        blockId: existing.blockId,
        field: 'ocr',
        baseText: existing.sourceOcrText,
        localText: existing.ocrText,
        incomingText: next.sourceOcrText,
      });
    }
    if (
      next.sourceTranslationText !== existing.sourceTranslationText &&
      trLocallyModified &&
      next.sourceTranslationText !== existing.translationText
    ) {
      conflicts.push({
        blockId: existing.blockId,
        field: 'translation',
        baseText: existing.sourceTranslationText,
        localText: existing.translationText,
        incomingText: next.sourceTranslationText,
      });
    }
  }

  if (conflicts.length > 0) {
    const mode = settings.onConflict ?? 'throw';
    if (mode !== 'throw' && mode !== 'stage') {
      throw new InlineEditorError('invalid-field', 'onConflict must be "throw" or "stage".', 'onConflict');
    }
    if (mode === 'throw') {
      throw new RevisionConflictError({
        reason: 'stale-source-revision',
        expectedRevisionId: state.sourceRevisionId,
        actualRevisionId: incomingRevisionId,
        blockIds: uniqueBlockIds(conflicts),
        conflicts,
      });
    }
    return {
      ...state,
      undoStack: closeTopEntry(state.undoStack),
      conflict: {
        baseRevisionId: state.sourceRevisionId,
        incomingRevisionId,
        ...(incomingSha !== undefined ? { incomingSourceSha256: incomingSha } : {}),
        conflicts: conflicts.map(cloneConflictDetail),
        incomingBlocks: normalizedIncoming.map(toBlockInput),
      },
    };
  }

  const syncAt =
    settings.at !== undefined
      ? requireTimestamp(settings.at, 'at')
      : state.autosave.lastEditAt ?? state.autosave.lastSavedAt ?? state.createdAt;

  return finalizeSync(state, normalizedIncoming, incomingRevisionId, incomingSha, syncAt);
}

export function resolveConflict(
  state: InlineEditorState,
  resolutions: readonly ConflictResolution[],
  options: ResolveConflictOptions = {},
): InlineEditorState {
  if (state.conflict === null) {
    throw new InlineEditorError('no-conflict', 'There is no active revision conflict to resolve.', 'conflict');
  }
  if (!Array.isArray(resolutions) || resolutions.length === 0) {
    throw new InlineEditorError('invalid-field', 'resolutions must be a non-empty array.', 'resolutions');
  }

  const conflictState = state.conflict;
  const activeByKey = new Map<string, BlockConflictDetail>();
  for (const item of conflictState.conflicts) {
    activeByKey.set(conflictKey(item.blockId, item.field), item);
  }

  const seenKeys = new Set<string>();
  const resolutionByKey = new Map<string, { detail: BlockConflictDetail; strategy: ConflictStrategy; text: string }>();

  resolutions.forEach((res, idx) => {
    const path = `resolutions[${idx}]`;
    if (typeof res !== 'object' || res === null || Array.isArray(res)) {
      throw new InlineEditorError('invalid-field', `${path} must be an object.`, path);
    }
    const blockId = requireText(res.blockId, `${path}.blockId`);
    const field = requireEditableField(res.field, `${path}.field`);
    if (!(CONFLICT_STRATEGIES as readonly string[]).includes(res.strategy)) {
      throw new InlineEditorError(
        'invalid-field',
        `${path}.strategy must be one of ${CONFLICT_STRATEGIES.join(' | ')}.`,
        `${path}.strategy`,
      );
    }
    const key = conflictKey(blockId, field);
    if (seenKeys.has(key)) {
      throw new InlineEditorError('duplicate-id', `Duplicate resolution for "${blockId}" (${field}).`, path);
    }
    const detail = activeByKey.get(key);
    if (detail === undefined) {
      throw new InlineEditorError('no-conflict', `No active conflict for "${blockId}" (${field}).`, path);
    }

    let resolvedText: string;
    if (res.strategy === 'keep-local') {
      resolvedText = detail.localText;
    } else if (res.strategy === 'accept-incoming') {
      resolvedText = detail.incomingText;
    } else {
      resolvedText = requireString(res.text, `${path}.text`);
    }

    seenKeys.add(key);
    resolutionByKey.set(key, { detail, strategy: res.strategy, text: resolvedText });
  });

  const resolveAt =
    options?.at !== undefined
      ? requireTimestamp(options.at, 'at')
      : state.autosave.lastEditAt ?? state.autosave.lastSavedAt ?? state.createdAt;

  const historyChanges: BlockFieldChange[] = [];
  const nextBlocks = state.blocks.map(block => {
    let ocrText = block.ocrText;
    let sourceOcrText = block.sourceOcrText;
    let savedOcrText = block.savedOcrText;
    let translationText = block.translationText;
    let sourceTranslationText = block.sourceTranslationText;
    let savedTranslationText = block.savedTranslationText;
    let touched = false;

    const ocrRes = resolutionByKey.get(conflictKey(block.blockId, 'ocr'));
    if (ocrRes !== undefined) {
      touched = true;
      if (ocrRes.text !== ocrText) {
        historyChanges.push({ blockId: block.blockId, field: 'ocr', before: ocrText, after: ocrRes.text });
      }
      ocrText = ocrRes.text;
      sourceOcrText = ocrRes.detail.incomingText;
      if (ocrRes.strategy === 'accept-incoming' && savedOcrText === ocrRes.detail.baseText) {
        savedOcrText = ocrRes.detail.incomingText;
      }
    }

    const trRes = resolutionByKey.get(conflictKey(block.blockId, 'translation'));
    if (trRes !== undefined) {
      touched = true;
      if (trRes.text !== translationText) {
        historyChanges.push({
          blockId: block.blockId,
          field: 'translation',
          before: translationText,
          after: trRes.text,
        });
      }
      translationText = trRes.text;
      sourceTranslationText = trRes.detail.incomingText;
      if (trRes.strategy === 'accept-incoming' && savedTranslationText === trRes.detail.baseText) {
        savedTranslationText = trRes.detail.incomingText;
      }
    }

    if (!touched) return block;
    return buildBlockState({
      blockId: block.blockId,
      page: block.page,
      sourceOcrText,
      sourceTranslationText,
      savedOcrText,
      savedTranslationText,
      ocrText,
      translationText,
      targetLang: block.targetLang,
      translationEngine: block.translationEngine,
      sourceRevisionId: block.sourceRevisionId,
    });
  });

  const preservedRemovedSet = new Set<string>(conflictState.preservedRemovedBlockIds ?? []);
  for (const item of resolutionByKey.values()) {
    if (item.detail.removedInIncoming === true && item.strategy !== 'accept-incoming') {
      preservedRemovedSet.add(item.detail.blockId);
    }
  }
  const preservedRemovedBlockIds = [...preservedRemovedSet];

  const remainingConflicts = conflictState.conflicts
    .filter(item => !seenKeys.has(conflictKey(item.blockId, item.field)))
    .map(cloneConflictDetail);

  let nextUndoStack = state.undoStack;
  let nextRedoStack = state.redoStack;
  let nextHistorySeq = state.nextHistorySeq;
  if (historyChanges.length > 0) {
    const entry: HistoryEntry = {
      id: `h${nextHistorySeq}`,
      kind: 'conflict-resolution',
      changes: historyChanges,
      openedAt: resolveAt,
      lastAt: resolveAt,
      closed: true,
    };
    nextHistorySeq += 1;
    nextUndoStack = trimHistory([...closeTopEntry(state.undoStack), entry], state.config.maxHistory);
    nextRedoStack = [];
  }

  const intermediate = commitTransition(state, {
    blocks: nextBlocks,
    undoStack: nextUndoStack,
    redoStack: nextRedoStack,
    nextHistorySeq,
    editAt: resolveAt,
  });

  if (remainingConflicts.length > 0) {
    return {
      ...intermediate,
      conflict: {
        ...conflictState,
        conflicts: remainingConflicts,
        ...(preservedRemovedBlockIds.length > 0 ? { preservedRemovedBlockIds } : {}),
      },
    };
  }

  // All conflicts resolved — finalize advancing non-conflicting and new incoming blocks.
  const normalizedIncoming = normalizeBlockInputs(
    conflictState.incomingBlocks,
    conflictState.incomingRevisionId,
    'conflict.incomingBlocks',
  );
  const incomingIds = new Set(normalizedIncoming.map(b => b.blockId));

  // Preserve blocks removed upstream only when the user kept/merged local edits for them.
  const preservedRemoved = intermediate.blocks.filter(
    b => !incomingIds.has(b.blockId) && preservedRemovedSet.has(b.blockId),
  );
  const finalized = finalizeSync(
    intermediate,
    normalizedIncoming,
    conflictState.incomingRevisionId,
    conflictState.incomingSourceSha256,
    resolveAt,
  );

  if (preservedRemoved.length === 0) {
    return { ...finalized, conflict: null };
  }

  const mergedBlocks = [
    ...finalized.blocks,
    ...preservedRemoved.map(b =>
      buildBlockState({
        blockId: b.blockId,
        page: b.page,
        sourceOcrText: b.sourceOcrText,
        sourceTranslationText: b.sourceTranslationText,
        savedOcrText: b.savedOcrText,
        savedTranslationText: b.savedTranslationText,
        ocrText: b.ocrText,
        translationText: b.translationText,
        targetLang: b.targetLang,
        translationEngine: b.translationEngine,
        sourceRevisionId: conflictState.incomingRevisionId,
      }),
    ),
  ];

  return commitTransition(
    { ...finalized, conflict: null },
    {
      blocks: mergedBlocks,
      undoStack: finalized.undoStack,
      redoStack: finalized.redoStack,
      nextHistorySeq: finalized.nextHistorySeq,
      editAt: resolveAt,
    },
  );
}

// --- Batch revert ----------------------------------------------------------

export function revertBlock(state: InlineEditorState, blockId: string, options: RevertOptions = {}): InlineEditorState {
  return revertBlocks(state, [blockId], options);
}

export function revertBlocks(
  state: InlineEditorState,
  blockIds: readonly string[],
  options: RevertOptions = {},
): InlineEditorState {
  const settings = typeof options === 'object' && options !== null ? options : {};
  assertExpectedRevision(state, settings.expectedSourceRevisionId);
  if (!Array.isArray(blockIds)) {
    throw new InlineEditorError('invalid-field', 'blockIds must be an array.', 'blockIds');
  }

  const fieldOption = settings.field ?? 'both';
  if (fieldOption !== 'ocr' && fieldOption !== 'translation' && fieldOption !== 'both') {
    throw new InlineEditorError('invalid-field', 'field must be ocr | translation | both.', 'field');
  }
  const to = settings.to ?? 'source';
  if (to !== 'source' && to !== 'saved') {
    throw new InlineEditorError('invalid-field', 'to must be source | saved.', 'to');
  }

  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  blockIds.forEach((rawId, idx) => {
    const id = requireText(rawId, `blockIds[${idx}]`);
    if (!state.blocks.some(b => b.blockId === id)) {
      throw new InlineEditorError('unknown-block', `Block "${id}" was not found.`, `blockIds[${idx}]`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  });

  if (uniqueIds.length === 0) {
    return state;
  }

  const fieldsToRevert: readonly EditableField[] =
    fieldOption === 'both' ? ['ocr', 'translation'] : [fieldOption];

  if (state.conflict !== null) {
    const blocked = state.conflict.conflicts.filter(
      c => seen.has(c.blockId) && fieldsToRevert.includes(c.field),
    );
    if (blocked.length > 0) {
      throw new RevisionConflictError({
        reason: 'unresolved-conflict',
        expectedRevisionId: state.conflict.baseRevisionId,
        actualRevisionId: state.conflict.incomingRevisionId,
        blockIds: uniqueBlockIds(blocked),
        conflicts: blocked,
      });
    }
  }

  const revertAt =
    settings.at !== undefined
      ? requireTimestamp(settings.at, 'at')
      : state.autosave.lastEditAt ?? state.autosave.lastSavedAt ?? state.createdAt;

  const changes: BlockFieldChange[] = [];
  const nextBlocks = state.blocks.map(block => {
    if (!seen.has(block.blockId)) return block;

    let nextOcr = block.ocrText;
    let nextTr = block.translationText;
    if (fieldsToRevert.includes('ocr')) {
      const target = to === 'saved' ? block.savedOcrText : block.sourceOcrText;
      if (block.ocrText !== target) {
        changes.push({ blockId: block.blockId, field: 'ocr', before: block.ocrText, after: target });
        nextOcr = target;
      }
    }
    if (fieldsToRevert.includes('translation')) {
      const target = to === 'saved' ? block.savedTranslationText : block.sourceTranslationText;
      if (block.translationText !== target) {
        changes.push({ blockId: block.blockId, field: 'translation', before: block.translationText, after: target });
        nextTr = target;
      }
    }

    if (nextOcr === block.ocrText && nextTr === block.translationText) {
      return block;
    }

    return buildBlockState({
      blockId: block.blockId,
      page: block.page,
      sourceOcrText: block.sourceOcrText,
      sourceTranslationText: block.sourceTranslationText,
      savedOcrText: block.savedOcrText,
      savedTranslationText: block.savedTranslationText,
      ocrText: nextOcr,
      translationText: nextTr,
      targetLang: block.targetLang,
      translationEngine: block.translationEngine,
      sourceRevisionId: block.sourceRevisionId,
    });
  });

  if (changes.length === 0) {
    return state;
  }

  const entry: HistoryEntry = {
    id: `h${state.nextHistorySeq}`,
    kind: 'revert',
    changes,
    openedAt: revertAt,
    lastAt: revertAt,
    closed: true,
  };

  return commitTransition(state, {
    blocks: nextBlocks,
    undoStack: trimHistory([...closeTopEntry(state.undoStack), entry], state.config.maxHistory),
    redoStack: [],
    nextHistorySeq: state.nextHistorySeq + 1,
    editAt: revertAt,
  });
}

export function revertAll(state: InlineEditorState, options: RevertOptions = {}): InlineEditorState {
  return revertBlocks(
    state,
    state.blocks.map(b => b.blockId),
    options,
  );
}

// --- Snapshot serialization & crash recovery -------------------------------

export function exportJson(state: InlineEditorState): string {
  const payload = {
    schemaVersion: INLINE_EDITOR_SCHEMA_VERSION,
    kind: INLINE_EDITOR_EXPORT_KIND,
    documentId: state.documentId,
    sourceRevisionId: state.sourceRevisionId,
    ...(state.sourceSha256 !== undefined ? { sourceSha256: state.sourceSha256 } : {}),
    revision: state.revision,
    nextHistorySeq: state.nextHistorySeq,
    createdAt: state.createdAt,
    config: {
      coalesceWindowMs: state.config.coalesceWindowMs,
      autosaveDebounceMs: state.config.autosaveDebounceMs,
      maxHistory: state.config.maxHistory,
    },
    autosave: {
      pendingSave: state.autosave.pendingSave,
      dirtySinceAt: state.autosave.dirtySinceAt,
      scheduledAt: state.autosave.scheduledAt,
      lastEditAt: state.autosave.lastEditAt,
      lastSavedAt: state.autosave.lastSavedAt,
      lastSavedRevision: state.autosave.lastSavedRevision,
    },
    blocks: state.blocks.map(serializeBlockState),
    undoStack: state.undoStack.map(serializeHistoryEntry),
    redoStack: state.redoStack.map(serializeHistoryEntry),
    conflict: state.conflict === null ? null : serializeConflictState(state.conflict),
  };
  return JSON.stringify(payload, null, 2);
}

export function importJson(json: string): InlineEditorState {
  if (typeof json !== 'string') {
    throw new InlineEditorError('malformed-json', 'importJson expects a JSON string.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid JSON';
    throw new InlineEditorError('malformed-json', `JSON parse failed (${detail}).`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InlineEditorError('malformed-export', 'Export snapshot must be a JSON object.');
  }

  const doc = parsed as Record<string, unknown>;
  if (doc.schemaVersion !== INLINE_EDITOR_SCHEMA_VERSION) {
    throw new InlineEditorError(
      'unsupported-schema-version',
      `schemaVersion ${String(doc.schemaVersion)} is not supported; expected ${INLINE_EDITOR_SCHEMA_VERSION}.`,
      'schemaVersion',
    );
  }
  if (doc.kind !== INLINE_EDITOR_EXPORT_KIND) {
    throw new InlineEditorError('malformed-export', `kind must be "${INLINE_EDITOR_EXPORT_KIND}".`, 'kind');
  }

  const documentId = requireText(doc.documentId, 'documentId');
  const sourceRevisionId = requireText(doc.sourceRevisionId, 'sourceRevisionId');
  const sourceSha256 =
    doc.sourceSha256 !== undefined ? requireSha256(doc.sourceSha256, 'sourceSha256') : undefined;
  const revision = requireNonNegativeInt(doc.revision, 'revision');
  const nextHistorySeq = requirePositiveInt(doc.nextHistorySeq, 'nextHistorySeq');
  const createdAt = requireTimestamp(doc.createdAt, 'createdAt');
  const config = readExportConfig(doc.config, 'config');
  const autosave = readExportAutosave(doc.autosave, 'autosave');

  if (!Array.isArray(doc.blocks)) {
    throw new InlineEditorError('malformed-export', 'blocks must be an array.', 'blocks');
  }
  const seenBlockIds = new Set<string>();
  const blocks: EditorBlockState[] = doc.blocks.map((entry, idx) => {
    const block = readExportBlock(entry, `blocks[${idx}]`);
    if (seenBlockIds.has(block.blockId)) {
      throw new InlineEditorError(
        'duplicate-id',
        `Duplicate blockId "${block.blockId}" in snapshot.`,
        `blocks[${idx}].blockId`,
      );
    }
    seenBlockIds.add(block.blockId);
    return block;
  });

  if (!Array.isArray(doc.undoStack)) {
    throw new InlineEditorError('malformed-export', 'undoStack must be an array.', 'undoStack');
  }
  if (!Array.isArray(doc.redoStack)) {
    throw new InlineEditorError('malformed-export', 'redoStack must be an array.', 'redoStack');
  }

  const seenHistoryIds = new Set<string>();
  const undoStack = doc.undoStack.map((entry, idx) => {
    const parsedEntry = readExportHistoryEntry(entry, `undoStack[${idx}]`);
    if (seenHistoryIds.has(parsedEntry.id)) {
      throw new InlineEditorError('duplicate-id', `Duplicate history entry id "${parsedEntry.id}".`, `undoStack[${idx}].id`);
    }
    seenHistoryIds.add(parsedEntry.id);
    return parsedEntry;
  });
  const redoStack = doc.redoStack.map((entry, idx) => {
    const parsedEntry = readExportHistoryEntry(entry, `redoStack[${idx}]`);
    if (seenHistoryIds.has(parsedEntry.id)) {
      throw new InlineEditorError('duplicate-id', `Duplicate history entry id "${parsedEntry.id}".`, `redoStack[${idx}].id`);
    }
    seenHistoryIds.add(parsedEntry.id);
    return parsedEntry;
  });

  const conflict =
    doc.conflict === null || doc.conflict === undefined
      ? null
      : readExportConflict(doc.conflict, 'conflict');

  const anyDirty = blocks.some(b => b.dirty);
  const reconciledAutosave: AutosaveState = {
    pendingSave: anyDirty,
    dirtySinceAt: anyDirty ? autosave.dirtySinceAt ?? autosave.lastEditAt ?? createdAt : null,
    scheduledAt: anyDirty
      ? autosave.scheduledAt ?? (autosave.lastEditAt ?? createdAt) + config.autosaveDebounceMs
      : null,
    lastEditAt: autosave.lastEditAt,
    lastSavedAt: autosave.lastSavedAt,
    lastSavedRevision: autosave.lastSavedRevision,
  };

  return {
    schemaVersion: INLINE_EDITOR_SCHEMA_VERSION,
    documentId,
    sourceRevisionId,
    ...(sourceSha256 !== undefined ? { sourceSha256 } : {}),
    revision,
    nextHistorySeq,
    createdAt,
    config,
    autosave: reconciledAutosave,
    blocks,
    undoStack,
    redoStack,
    conflict,
  };
}

export function recoverFromSnapshot(json: string, options: RecoverSnapshotOptions = {}): InlineEditorState {
  const restored = importJson(json);
  const settings = typeof options === 'object' && options !== null ? options : {};
  const onConflict = settings.onConflict ?? 'stage';

  if (settings.document !== undefined) {
    return syncDocumentRevision(restored, settings.document, {
      onConflict,
      ...(settings.targetLang !== undefined ? { targetLang: settings.targetLang } : {}),
      ...(settings.engine !== undefined ? { engine: settings.engine } : {}),
      ...(settings.allowSourceHashChange !== undefined
        ? { allowSourceHashChange: settings.allowSourceHashChange }
        : {}),
      ...(settings.at !== undefined ? { at: settings.at } : {}),
    });
  }

  if (settings.sourceUpdate !== undefined) {
    return syncSourceRevision(restored, settings.sourceUpdate, {
      onConflict,
      ...(settings.allowSourceHashChange !== undefined
        ? { allowSourceHashChange: settings.allowSourceHashChange }
        : {}),
      ...(settings.at !== undefined ? { at: settings.at } : {}),
    });
  }

  return restored;
}

// --- Internal state & diff helpers -----------------------------------------

function extractBlocksFromIr(ir: DocumentIR, targetLang?: string, engine?: string): EditorBlockInput[] {
  if (!Array.isArray(ir.blocks)) {
    throw new InlineEditorError('invalid-field', 'DocumentIR.blocks must be an array.', 'blocks');
  }
  const translations = Array.isArray(ir.translations) ? ir.translations : [];
  const langFilter = targetLang !== undefined ? requireText(targetLang, 'targetLang') : undefined;
  const engineFilter = engine !== undefined ? requireText(engine, 'engine') : undefined;

  return ir.blocks.map((block, idx) => {
    if (typeof block !== 'object' || block === null) {
      throw new InlineEditorError('invalid-field', `blocks[${idx}] must be an object.`, `blocks[${idx}]`);
    }
    const matching = selectTranslation(translations, block.id, langFilter, engineFilter);
    return {
      blockId: block.id,
      page: block.page,
      ocrText: block.raw,
      translationText: matching?.text ?? '',
      ...(matching?.lang !== undefined ? { targetLang: matching.lang } : {}),
      ...(matching?.engine !== undefined ? { translationEngine: matching.engine } : {}),
    };
  });
}

function selectTranslation(
  translations: readonly Translation[],
  blockId: string,
  targetLang?: string,
  engine?: string,
): Translation | undefined {
  for (const t of translations) {
    if (t.blockId !== blockId) continue;
    if (targetLang !== undefined && t.lang !== targetLang) continue;
    if (engine !== undefined && t.engine !== engine) continue;
    return t;
  }
  return undefined;
}

function normalizeBlockInputs(
  inputs: readonly EditorBlockInput[],
  sourceRevisionId: string,
  pathPrefix: string,
): EditorBlockState[] {
  const seen = new Set<string>();
  return inputs.map((item, idx) => {
    const path = `${pathPrefix}[${idx}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new InlineEditorError('invalid-field', `${path} must be an object.`, path);
    }
    const blockId = requireText(item.blockId, `${path}.blockId`);
    if (seen.has(blockId)) {
      throw new InlineEditorError('duplicate-id', `Duplicate blockId "${blockId}".`, `${path}.blockId`);
    }
    seen.add(blockId);

    const page = requirePositiveInt(item.page, `${path}.page`);
    const ocrText = requireString(item.ocrText, `${path}.ocrText`);
    const translationText =
      item.translationText !== undefined ? requireString(item.translationText, `${path}.translationText`) : '';
    const targetLang = optionalText(item.targetLang, `${path}.targetLang`);
    const translationEngine = optionalText(item.translationEngine, `${path}.translationEngine`);

    return buildBlockState({
      blockId,
      page,
      sourceOcrText: ocrText,
      sourceTranslationText: translationText,
      savedOcrText: ocrText,
      savedTranslationText: translationText,
      ocrText,
      translationText,
      targetLang,
      translationEngine,
      sourceRevisionId,
    });
  });
}

function buildBlockState(fields: {
  blockId: string;
  page: number;
  sourceOcrText: string;
  sourceTranslationText: string;
  savedOcrText: string;
  savedTranslationText: string;
  ocrText: string;
  translationText: string;
  targetLang?: string;
  translationEngine?: string;
  sourceRevisionId: string;
}): EditorBlockState {
  const ocrDirty = fields.ocrText !== fields.savedOcrText;
  const translationDirty = fields.translationText !== fields.savedTranslationText;
  return {
    blockId: fields.blockId,
    page: fields.page,
    sourceOcrText: fields.sourceOcrText,
    sourceTranslationText: fields.sourceTranslationText,
    savedOcrText: fields.savedOcrText,
    savedTranslationText: fields.savedTranslationText,
    ocrText: fields.ocrText,
    translationText: fields.translationText,
    ...(fields.targetLang !== undefined ? { targetLang: fields.targetLang } : {}),
    ...(fields.translationEngine !== undefined ? { translationEngine: fields.translationEngine } : {}),
    sourceRevisionId: fields.sourceRevisionId,
    ocrDirty,
    translationDirty,
    dirty: ocrDirty || translationDirty,
    ocrModifiedFromSource: fields.ocrText !== fields.sourceOcrText,
    translationModifiedFromSource: fields.translationText !== fields.sourceTranslationText,
  };
}

function fieldValue(block: EditorBlockState, field: EditableField): string {
  return field === 'ocr' ? block.ocrText : block.translationText;
}

function applyBlockFieldUpdate(block: EditorBlockState, field: EditableField, text: string): EditorBlockState {
  return buildBlockState({
    blockId: block.blockId,
    page: block.page,
    sourceOcrText: block.sourceOcrText,
    sourceTranslationText: block.sourceTranslationText,
    savedOcrText: block.savedOcrText,
    savedTranslationText: block.savedTranslationText,
    ocrText: field === 'ocr' ? text : block.ocrText,
    translationText: field === 'translation' ? text : block.translationText,
    targetLang: block.targetLang,
    translationEngine: block.translationEngine,
    sourceRevisionId: block.sourceRevisionId,
  });
}

function commitTransition(
  state: InlineEditorState,
  next: {
    blocks: readonly EditorBlockState[];
    undoStack: readonly HistoryEntry[];
    redoStack: readonly HistoryEntry[];
    nextHistorySeq: number;
    editAt: number;
  },
): InlineEditorState {
  const anyDirty = next.blocks.some(b => b.dirty);
  const nextAutosave: AutosaveState = anyDirty
    ? {
        pendingSave: true,
        dirtySinceAt: state.autosave.dirtySinceAt ?? next.editAt,
        scheduledAt: next.editAt + state.config.autosaveDebounceMs,
        lastEditAt: next.editAt,
        lastSavedAt: state.autosave.lastSavedAt,
        lastSavedRevision: state.autosave.lastSavedRevision,
      }
    : {
        pendingSave: false,
        dirtySinceAt: null,
        scheduledAt: null,
        lastEditAt: next.editAt,
        lastSavedAt: state.autosave.lastSavedAt,
        lastSavedRevision: state.autosave.lastSavedRevision,
      };

  return {
    ...state,
    revision: state.revision + 1,
    nextHistorySeq: next.nextHistorySeq,
    autosave: nextAutosave,
    blocks: next.blocks,
    undoStack: next.undoStack,
    redoStack: next.redoStack,
  };
}

function closeTopEntry(stack: readonly HistoryEntry[]): HistoryEntry[] {
  if (stack.length === 0) return [];
  const last = stack[stack.length - 1]!;
  if (last.closed) return [...stack];
  return [...stack.slice(0, -1), { ...last, closed: true }];
}

function trimHistory(stack: readonly HistoryEntry[], maxHistory: number): HistoryEntry[] {
  if (stack.length <= maxHistory) return [...stack];
  return stack.slice(stack.length - maxHistory);
}

function assertExpectedRevision(state: InlineEditorState, expected?: string): void {
  if (expected === undefined) return;
  const trimmed = requireText(expected, 'expectedSourceRevisionId');
  if (trimmed !== state.sourceRevisionId) {
    throw new RevisionConflictError({
      reason: 'stale-source-revision',
      expectedRevisionId: trimmed,
      actualRevisionId: state.sourceRevisionId,
    });
  }
}

function assertNoUnresolvedConflict(state: InlineEditorState): void {
  if (state.conflict !== null) {
    throw new RevisionConflictError({
      reason: 'unresolved-conflict',
      expectedRevisionId: state.conflict.baseRevisionId,
      actualRevisionId: state.conflict.incomingRevisionId,
      blockIds: uniqueBlockIds(state.conflict.conflicts),
      conflicts: state.conflict.conflicts,
    });
  }
}

function finalizeSync(
  state: InlineEditorState,
  normalizedIncoming: readonly EditorBlockState[],
  incomingRevisionId: string,
  incomingSha: string | undefined,
  syncAt: number,
): InlineEditorState {
  const existingById = new Map<string, EditorBlockState>();
  for (const b of state.blocks) existingById.set(b.blockId, b);

  const nextBlocks = normalizedIncoming.map(incomingBlock => {
    const existing = existingById.get(incomingBlock.blockId);
    if (existing === undefined) return incomingBlock;

    const ocrLocallyModified =
      existing.ocrText !== existing.sourceOcrText || existing.savedOcrText !== existing.sourceOcrText;
    const trLocallyModified =
      existing.translationText !== existing.sourceTranslationText ||
      existing.savedTranslationText !== existing.sourceTranslationText;

    const nextOcr = ocrLocallyModified ? existing.ocrText : incomingBlock.sourceOcrText;
    const nextSavedOcr =
      ocrLocallyModified && existing.savedOcrText !== existing.sourceOcrText
        ? existing.savedOcrText
        : incomingBlock.sourceOcrText;

    const nextTr = trLocallyModified ? existing.translationText : incomingBlock.sourceTranslationText;
    const nextSavedTr =
      trLocallyModified && existing.savedTranslationText !== existing.sourceTranslationText
        ? existing.savedTranslationText
        : incomingBlock.sourceTranslationText;

    return buildBlockState({
      blockId: incomingBlock.blockId,
      page: incomingBlock.page,
      sourceOcrText: incomingBlock.sourceOcrText,
      sourceTranslationText: incomingBlock.sourceTranslationText,
      savedOcrText: nextSavedOcr,
      savedTranslationText: nextSavedTr,
      ocrText: nextOcr,
      translationText: nextTr,
      targetLang: incomingBlock.targetLang ?? existing.targetLang,
      translationEngine: incomingBlock.translationEngine ?? existing.translationEngine,
      sourceRevisionId: incomingRevisionId,
    });
  });

  const anyDirty = nextBlocks.some(b => b.dirty);
  return {
    ...state,
    sourceRevisionId: incomingRevisionId,
    ...(incomingSha !== undefined
      ? { sourceSha256: incomingSha }
      : state.sourceSha256 !== undefined
        ? { sourceSha256: state.sourceSha256 }
        : {}),
    revision: state.revision + 1,
    blocks: nextBlocks,
    undoStack: closeTopEntry(state.undoStack),
    conflict: null,
    autosave: {
      pendingSave: anyDirty,
      dirtySinceAt: anyDirty ? state.autosave.dirtySinceAt ?? syncAt : null,
      scheduledAt: anyDirty
        ? state.autosave.scheduledAt ?? syncAt + state.config.autosaveDebounceMs
        : null,
      lastEditAt: state.autosave.lastEditAt,
      lastSavedAt: state.autosave.lastSavedAt,
      lastSavedRevision: state.autosave.lastSavedRevision,
    },
  };
}

function sameBlockSources(existing: readonly EditorBlockState[], incoming: readonly EditorBlockState[]): boolean {
  if (existing.length !== incoming.length) return false;
  for (let idx = 0; idx < existing.length; idx += 1) {
    const a = existing[idx]!;
    const b = incoming[idx]!;
    if (
      a.blockId !== b.blockId ||
      a.page !== b.page ||
      a.sourceOcrText !== b.sourceOcrText ||
      a.sourceTranslationText !== b.sourceTranslationText
    ) {
      return false;
    }
  }
  return true;
}

function changedSourceBlockIds(existing: readonly EditorBlockState[], incoming: readonly EditorBlockState[]): string[] {
  const existingMap = new Map<string, EditorBlockState>();
  for (const b of existing) existingMap.set(b.blockId, b);
  const incomingMap = new Map<string, EditorBlockState>();
  for (const b of incoming) incomingMap.set(b.blockId, b);

  const ids = new Set<string>();
  for (const b of existing) {
    const inc = incomingMap.get(b.blockId);
    if (
      inc === undefined ||
      inc.page !== b.page ||
      inc.sourceOcrText !== b.sourceOcrText ||
      inc.sourceTranslationText !== b.sourceTranslationText
    ) {
      ids.add(b.blockId);
    }
  }
  for (const b of incoming) {
    if (!existingMap.has(b.blockId)) ids.add(b.blockId);
  }
  return [...ids];
}

// --- LCS diff engine (shared for word & char comparison) -------------------

interface TokenRun {
  readonly kind: 'equal' | 'insert' | 'delete';
  readonly tokens: string[];
}

function tokenizeWords(text: string): string[] {
  const trimmed = text.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/u);
}

function computeSequenceDiff(left: readonly string[], right: readonly string[]): TokenRun[] {
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const runs: TokenRun[] = [];
  pushRunTokens(runs, 'equal', left.slice(0, prefix));
  const midLeft = left.slice(prefix, left.length - suffix);
  const midRight = right.slice(prefix, right.length - suffix);
  for (const run of lcsMiddleRuns(midLeft, midRight)) {
    pushRunTokens(runs, run.kind, run.tokens);
  }
  pushRunTokens(runs, 'equal', left.slice(left.length - suffix));
  return runs;
}

function lcsMiddleRuns(left: readonly string[], right: readonly string[]): TokenRun[] {
  if (left.length === 0) return right.length === 0 ? [] : [{ kind: 'insert', tokens: [...right] }];
  if (right.length === 0) return [{ kind: 'delete', tokens: [...left] }];
  if (left.length * right.length > DIFF_MAX_DP_CELLS) {
    return [
      { kind: 'delete', tokens: [...left] },
      { kind: 'insert', tokens: [...right] },
    ];
  }

  const width = right.length + 1;
  const dp = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      const idx = i * width + j;
      if (left[i] === right[j]) {
        dp[idx] = (dp[(i + 1) * width + j + 1] ?? 0) + 1;
      } else {
        dp[idx] = Math.max(dp[(i + 1) * width + j] ?? 0, dp[i * width + j + 1] ?? 0);
      }
    }
  }

  const runs: TokenRun[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const lTok = left[i];
    const rTok = right[j];
    if (lTok !== undefined && lTok === rTok) {
      pushRunTokens(runs, 'equal', [lTok]);
      i += 1;
      j += 1;
      continue;
    }
    if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
      if (lTok !== undefined) pushRunTokens(runs, 'delete', [lTok]);
      i += 1;
    } else {
      if (rTok !== undefined) pushRunTokens(runs, 'insert', [rTok]);
      j += 1;
    }
  }
  while (i < left.length) {
    const lTok = left[i];
    if (lTok !== undefined) pushRunTokens(runs, 'delete', [lTok]);
    i += 1;
  }
  while (j < right.length) {
    const rTok = right[j];
    if (rTok !== undefined) pushRunTokens(runs, 'insert', [rTok]);
    j += 1;
  }
  return runs;
}

function pushRunTokens(runs: TokenRun[], kind: 'equal' | 'insert' | 'delete', tokens: readonly string[]): void {
  if (tokens.length === 0) return;
  const last = runs[runs.length - 1];
  if (last !== undefined && last.kind === kind) {
    last.tokens.push(...tokens);
    return;
  }
  runs.push({ kind, tokens: [...tokens] });
}

function mergeDiffRuns(runs: readonly TokenRun[], separator: string): DiffRun[] {
  const out: DiffRun[] = [];
  for (const run of runs) {
    const text = run.tokens.join(separator);
    if (text.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.kind === run.kind) {
      out[out.length - 1] = { kind: prev.kind, text: `${prev.text}${separator}${text}` };
    } else {
      out.push({ kind: run.kind, text });
    }
  }
  return out;
}

// --- Serialization & validation helpers ------------------------------------

function serializeBlockState(b: EditorBlockState): Record<string, unknown> {
  const out: Record<string, unknown> = {
    blockId: b.blockId,
    page: b.page,
    sourceOcrText: b.sourceOcrText,
    sourceTranslationText: b.sourceTranslationText,
    savedOcrText: b.savedOcrText,
    savedTranslationText: b.savedTranslationText,
    ocrText: b.ocrText,
    translationText: b.translationText,
  };
  if (b.targetLang !== undefined) out.targetLang = b.targetLang;
  if (b.translationEngine !== undefined) out.translationEngine = b.translationEngine;
  out.sourceRevisionId = b.sourceRevisionId;
  return out;
}

function serializeHistoryEntry(entry: HistoryEntry): Record<string, unknown> {
  return {
    id: entry.id,
    kind: entry.kind,
    changes: entry.changes.map(c => ({
      blockId: c.blockId,
      field: c.field,
      before: c.before,
      after: c.after,
    })),
    openedAt: entry.openedAt,
    lastAt: entry.lastAt,
    closed: entry.closed,
  };
}

function serializeConflictState(c: RevisionConflictState): Record<string, unknown> {
  const out: Record<string, unknown> = {
    baseRevisionId: c.baseRevisionId,
    incomingRevisionId: c.incomingRevisionId,
  };
  if (c.incomingSourceSha256 !== undefined) out.incomingSourceSha256 = c.incomingSourceSha256;
  out.conflicts = c.conflicts.map(serializeConflictDetail);
  out.incomingBlocks = c.incomingBlocks.map(toBlockInput);
  if (c.preservedRemovedBlockIds !== undefined && c.preservedRemovedBlockIds.length > 0) {
    out.preservedRemovedBlockIds = [...c.preservedRemovedBlockIds];
  }
  return out;
}

function serializeConflictDetail(item: BlockConflictDetail): Record<string, unknown> {
  const out: Record<string, unknown> = {
    blockId: item.blockId,
    field: item.field,
    baseText: item.baseText,
    localText: item.localText,
    incomingText: item.incomingText,
  };
  if (item.removedInIncoming === true) out.removedInIncoming = true;
  return out;
}

function toBlockInput(b: EditorBlockInput | EditorBlockState): EditorBlockInput {
  return {
    blockId: b.blockId,
    page: b.page,
    ocrText: b.ocrText,
    translationText: b.translationText ?? '',
    ...(b.targetLang !== undefined ? { targetLang: b.targetLang } : {}),
    ...(b.translationEngine !== undefined ? { translationEngine: b.translationEngine } : {}),
  };
}

function readConfig(input: CreateEditorStateInput): InlineEditorConfig {
  const coalesceWindowMs =
    input.coalesceWindowMs !== undefined
      ? requireNonNegativeFinite(input.coalesceWindowMs, 'coalesceWindowMs')
      : DEFAULT_COALESCE_WINDOW_MS;
  const autosaveDebounceMs =
    input.autosaveDebounceMs !== undefined
      ? requireNonNegativeFinite(input.autosaveDebounceMs, 'autosaveDebounceMs')
      : DEFAULT_AUTOSAVE_DEBOUNCE_MS;
  const maxHistory =
    input.maxHistory !== undefined ? requirePositiveInt(input.maxHistory, 'maxHistory') : DEFAULT_MAX_HISTORY;
  return { coalesceWindowMs, autosaveDebounceMs, maxHistory };
}

function readExportConfig(value: unknown, path: string): InlineEditorConfig {
  const rec = requireObject(value, path);
  return {
    coalesceWindowMs: requireNonNegativeFinite(rec.coalesceWindowMs, `${path}.coalesceWindowMs`),
    autosaveDebounceMs: requireNonNegativeFinite(rec.autosaveDebounceMs, `${path}.autosaveDebounceMs`),
    maxHistory: requirePositiveInt(rec.maxHistory, `${path}.maxHistory`),
  };
}

function readExportAutosave(value: unknown, path: string): AutosaveState {
  const rec = requireObject(value, path);
  return {
    pendingSave: requireBoolean(rec.pendingSave, `${path}.pendingSave`),
    dirtySinceAt: requireNullableTimestamp(rec.dirtySinceAt, `${path}.dirtySinceAt`),
    scheduledAt: requireNullableTimestamp(rec.scheduledAt, `${path}.scheduledAt`),
    lastEditAt: requireNullableTimestamp(rec.lastEditAt, `${path}.lastEditAt`),
    lastSavedAt: requireNullableTimestamp(rec.lastSavedAt, `${path}.lastSavedAt`),
    lastSavedRevision: requireNonNegativeInt(rec.lastSavedRevision, `${path}.lastSavedRevision`),
  };
}

function readExportBlock(value: unknown, path: string): EditorBlockState {
  const rec = requireObject(value, path);
  return buildBlockState({
    blockId: requireText(rec.blockId, `${path}.blockId`),
    page: requirePositiveInt(rec.page, `${path}.page`),
    sourceOcrText: requireString(rec.sourceOcrText, `${path}.sourceOcrText`),
    sourceTranslationText: requireString(rec.sourceTranslationText, `${path}.sourceTranslationText`),
    savedOcrText: requireString(rec.savedOcrText, `${path}.savedOcrText`),
    savedTranslationText: requireString(rec.savedTranslationText, `${path}.savedTranslationText`),
    ocrText: requireString(rec.ocrText, `${path}.ocrText`),
    translationText: requireString(rec.translationText, `${path}.translationText`),
    targetLang: optionalText(rec.targetLang, `${path}.targetLang`),
    translationEngine: optionalText(rec.translationEngine, `${path}.translationEngine`),
    sourceRevisionId: requireText(rec.sourceRevisionId, `${path}.sourceRevisionId`),
  });
}

function readExportHistoryEntry(value: unknown, path: string): HistoryEntry {
  const rec = requireObject(value, path);
  const id = requireText(rec.id, `${path}.id`);
  const kind = requireEnum(rec.kind, `${path}.kind`, HISTORY_ENTRY_KINDS);
  if (!Array.isArray(rec.changes)) {
    throw new InlineEditorError('malformed-export', `${path}.changes must be an array.`, `${path}.changes`);
  }
  const changes: BlockFieldChange[] = rec.changes.map((c, idx) => {
    const cPath = `${path}.changes[${idx}]`;
    const cObj = requireObject(c, cPath);
    return {
      blockId: requireText(cObj.blockId, `${cPath}.blockId`),
      field: requireEditableField(cObj.field, `${cPath}.field`),
      before: requireString(cObj.before, `${cPath}.before`),
      after: requireString(cObj.after, `${cPath}.after`),
    };
  });
  return {
    id,
    kind,
    changes,
    openedAt: requireTimestamp(rec.openedAt, `${path}.openedAt`),
    lastAt: requireTimestamp(rec.lastAt, `${path}.lastAt`),
    closed: requireBoolean(rec.closed, `${path}.closed`),
  };
}

function readExportConflict(value: unknown, path: string): RevisionConflictState {
  const rec = requireObject(value, path);
  const baseRevisionId = requireText(rec.baseRevisionId, `${path}.baseRevisionId`);
  const incomingRevisionId = requireText(rec.incomingRevisionId, `${path}.incomingRevisionId`);
  const incomingSourceSha256 =
    rec.incomingSourceSha256 !== undefined
      ? requireSha256(rec.incomingSourceSha256, `${path}.incomingSourceSha256`)
      : undefined;

  if (!Array.isArray(rec.conflicts) || !Array.isArray(rec.incomingBlocks)) {
    throw new InlineEditorError('malformed-export', `${path}.conflicts and incomingBlocks must be arrays.`, path);
  }

  const conflicts: BlockConflictDetail[] = rec.conflicts.map((item, idx) => {
    const cPath = `${path}.conflicts[${idx}]`;
    const obj = requireObject(item, cPath);
    const removed =
      obj.removedInIncoming !== undefined ? requireBoolean(obj.removedInIncoming, `${cPath}.removedInIncoming`) : undefined;
    return {
      blockId: requireText(obj.blockId, `${cPath}.blockId`),
      field: requireEditableField(obj.field, `${cPath}.field`),
      baseText: requireString(obj.baseText, `${cPath}.baseText`),
      localText: requireString(obj.localText, `${cPath}.localText`),
      incomingText: requireString(obj.incomingText, `${cPath}.incomingText`),
      ...(removed === true ? { removedInIncoming: true } : {}),
    };
  });

  const normalizedIncoming = normalizeBlockInputs(
    rec.incomingBlocks as EditorBlockInput[],
    incomingRevisionId,
    `${path}.incomingBlocks`,
  );

  const preservedRemovedBlockIds =
    rec.preservedRemovedBlockIds !== undefined
      ? (() => {
          if (!Array.isArray(rec.preservedRemovedBlockIds)) {
            throw new InlineEditorError(
              'malformed-export',
              `${path}.preservedRemovedBlockIds must be an array.`,
              `${path}.preservedRemovedBlockIds`,
            );
          }
          return rec.preservedRemovedBlockIds.map((id, idx) =>
            requireText(id, `${path}.preservedRemovedBlockIds[${idx}]`),
          );
        })()
      : undefined;

  return {
    baseRevisionId,
    incomingRevisionId,
    ...(incomingSourceSha256 !== undefined ? { incomingSourceSha256 } : {}),
    conflicts,
    incomingBlocks: normalizedIncoming.map(b => ({
      blockId: b.blockId,
      page: b.page,
      ocrText: b.ocrText,
      translationText: b.translationText,
      ...(b.targetLang !== undefined ? { targetLang: b.targetLang } : {}),
      ...(b.translationEngine !== undefined ? { translationEngine: b.translationEngine } : {}),
    })),
    ...(preservedRemovedBlockIds !== undefined && preservedRemovedBlockIds.length > 0
      ? { preservedRemovedBlockIds }
      : {}),
  };
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InlineEditorError('malformed-export', `${path} must be an object.`, path);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new InlineEditorError('invalid-field', `${path} must be a string.`, path);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InlineEditorError('invalid-field', `${path} must not be blank.`, path);
  }
  return trimmed;
}

function optionalText(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireText(value, path);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new InlineEditorError('invalid-field', `${path} must be a string.`, path);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    throw new InlineEditorError('invalid-field', `${path} must be a boolean.`, path);
  }
  return value;
}

function requirePositiveInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new InlineEditorError('invalid-field', `${path} must be a positive integer.`, path);
  }
  return value;
}

function requireNonNegativeInt(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InlineEditorError('invalid-field', `${path} must be a non-negative integer.`, path);
  }
  return value;
}

function requireNonNegativeFinite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new InlineEditorError('invalid-field', `${path} must be a non-negative finite number.`, path);
  }
  return value;
}

function requireTimestamp(value: unknown, path: string): number {
  return requireNonNegativeFinite(value, path);
}

function requireNullableTimestamp(value: unknown, path: string): number | null {
  if (value === null) return null;
  return requireTimestamp(value, path);
}

function requireSha256(value: unknown, path: string): string {
  const text = requireText(value, path).toLowerCase();
  if (!SHA256_HEX_RE.test(text)) {
    throw new InlineEditorError('invalid-field', `${path} must be a 64-character SHA-256 hex digest.`, path);
  }
  return text;
}

function requireEditableField(value: unknown, path: string): EditableField {
  return requireEnum(value, path, EDITABLE_FIELDS);
}

function requireEnum<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  const text = requireText(value, path);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new InlineEditorError('invalid-field', `${path} must be one of ${allowed.join(' | ')}.`, path);
  }
  return text as T;
}

function cloneConflictDetail(item: BlockConflictDetail): BlockConflictDetail {
  return {
    blockId: item.blockId,
    field: item.field,
    baseText: item.baseText,
    localText: item.localText,
    incomingText: item.incomingText,
    ...(item.removedInIncoming === true ? { removedInIncoming: true } : {}),
  };
}

function conflictKey(blockId: string, field: EditableField): string {
  return `${blockId}\u0000${field}`;
}

function uniqueBlockIds(conflicts: readonly BlockConflictDetail[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of conflicts) {
    if (!seen.has(item.blockId)) {
      seen.add(item.blockId);
      out.push(item.blockId);
    }
  }
  return out;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
