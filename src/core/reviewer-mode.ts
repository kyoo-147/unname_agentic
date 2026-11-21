/**
 * Role-based reviewer workflow for translated segments (backlog item G16).
 *
 * Manages per-segment translation review states across three distinct roles:
 * - `translator`: saves drafts and submits translations (`draft -> translated`)
 * - `editor`: reviews and refines translations, capturing word diffs (`translated -> edited`, `edited -> edited`)
 * - `approver`: signs off or rejects edited segments (`edited -> approved | rejected`),
 *   and may explicitly reopen a rejected segment for rework (`rejected -> draft`).
 *
 * Contract:
 * - Pure and deterministic: no DOM, no network, and clock reads go strictly through
 *   the injectable `now` callback (compatible with {@link AuditLog}).
 * - Strict separation of duties: role permissions and state transitions are checked
 *   before any state or audit mutation occurs.
 * - Full edit diffs: captures word-level LCS diffs without dropping short 1-char edits,
 *   alongside character/word counters.
 * - Compatible with `src/core/audit.ts`: every transition emits an immutable `'review'`
 *   event into an {@link AuditLog} hash chain, with bounded and secret-redacted details
 *   so long or sensitive document segments never break or leak into the audit log.
 */

import {
  AuditLog,
  MAX_AUDIT_DETAIL_TEXT,
  redactSecrets,
  toMarkdown,
  type AuditChainEntry,
  type AuditDetail,
  type AuditEvent,
} from './audit';
import { DIFF_MAX_DP_CELLS, type WordDiffKind, type WordDiffRun } from './diff';

// --- Public types and constants --------------------------------------------

export const REVIEWER_ROLES = ['translator', 'editor', 'approver'] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];

export const SEGMENT_REVIEW_STATES = ['draft', 'translated', 'edited', 'approved', 'rejected'] as const;
export type SegmentReviewState = (typeof SEGMENT_REVIEW_STATES)[number];

export const REVIEWER_ACTIONS = ['save-draft', 'translate', 'edit', 'approve', 'reject', 'reopen'] as const;
export type ReviewerAction = (typeof REVIEWER_ACTIONS)[number];

export const ROLE_PERMISSIONS: Readonly<Record<ReviewerRole, readonly ReviewerAction[]>> = {
  translator: ['save-draft', 'translate'],
  editor: ['edit'],
  approver: ['approve', 'reject', 'reopen'],
};

const ALLOWED_NEXT_STATES: Readonly<Record<SegmentReviewState, readonly SegmentReviewState[]>> = {
  draft: ['draft', 'translated'],
  translated: ['edited'],
  edited: ['edited', 'approved', 'rejected'],
  approved: [],
  rejected: ['draft'],
};

interface ActionTransitionSpec {
  readonly from: readonly SegmentReviewState[];
  readonly to: SegmentReviewState;
  readonly changesText: boolean;
  readonly allowEmptyText: boolean;
}

const ACTION_TRANSITIONS: Readonly<Record<ReviewerAction, ActionTransitionSpec>> = {
  'save-draft': { from: ['draft'], to: 'draft', changesText: true, allowEmptyText: true },
  translate: { from: ['draft'], to: 'translated', changesText: true, allowEmptyText: false },
  edit: { from: ['translated', 'edited'], to: 'edited', changesText: true, allowEmptyText: false },
  approve: { from: ['edited'], to: 'approved', changesText: false, allowEmptyText: true },
  reject: { from: ['edited'], to: 'rejected', changesText: false, allowEmptyText: true },
  reopen: { from: ['rejected'], to: 'draft', changesText: false, allowEmptyText: true },
};

export interface ReviewerActor {
  id: string;
  role: ReviewerRole;
}

export interface ReviewSegmentInput {
  id: string;
  source: string;
  target?: string;
  page?: number;
  blockId?: string;
}

export interface ReviewEditDiff {
  changed: boolean;
  before: string;
  after: string;
  runs: WordDiffRun[];
  addedWords: number;
  deletedWords: number;
  charsBefore: number;
  charsAfter: number;
}

export interface ReviewTransition {
  revision: number;
  segmentId: string;
  action: ReviewerAction;
  actorId: string;
  role: ReviewerRole;
  fromState: SegmentReviewState;
  toState: SegmentReviewState;
  at: string;
  diff: ReviewEditDiff | null;
  reason?: string;
  auditHash: string;
}

export interface ReviewSegment {
  id: string;
  source: string;
  target: string;
  page?: number;
  blockId?: string;
  state: SegmentReviewState;
  revision: number;
  updatedAt: string | null;
  updatedBy: ReviewerActor | null;
  history: readonly ReviewTransition[];
}

export interface ReviewTransitionResult {
  segment: ReviewSegment;
  transition: ReviewTransition;
  auditEvent: AuditEvent;
  auditEntry: AuditChainEntry;
}

export interface ReviewerWorkflowStats {
  total: number;
  draft: number;
  translated: number;
  edited: number;
  approved: number;
  rejected: number;
}

export interface ReviewerWorkflowOptions {
  documentId: string;
  segments?: readonly ReviewSegmentInput[];
  auditLog?: AuditLog;
  now?: () => string;
}

export type ReviewerErrorCode =
  | 'invalid-actor'
  | 'invalid-segment'
  | 'duplicate-segment'
  | 'unknown-segment'
  | 'forbidden-role'
  | 'invalid-transition'
  | 'empty-translation';

export class ReviewerError extends Error {
  readonly code: ReviewerErrorCode;
  readonly segmentId: string;

  constructor(code: ReviewerErrorCode, message: string, segmentId = '') {
    super(segmentId ? `${segmentId}: ${message}` : message);
    this.name = 'ReviewerError';
    this.code = code;
    this.segmentId = segmentId;
  }
}

// --- Pure rule and diff helpers --------------------------------------------

export function canPerformAction(role: ReviewerRole, action: ReviewerAction): boolean {
  const allowed = ROLE_PERMISSIONS[role];
  return Array.isArray(allowed) && allowed.includes(action);
}

export function allowedNextStates(state: SegmentReviewState): readonly SegmentReviewState[] {
  return ALLOWED_NEXT_STATES[state] ?? [];
}

export function isValidStateTransition(from: SegmentReviewState, to: SegmentReviewState): boolean {
  return allowedNextStates(from).includes(to);
}

function tokenizeWords(text: string): string[] {
  const trimmed = text.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/u);
}

interface TokenRun {
  kind: WordDiffKind;
  tokens: string[];
}

function pushRunTokens(runs: TokenRun[], kind: WordDiffKind, tokens: readonly string[]): void {
  if (tokens.length === 0) return;
  const last = runs[runs.length - 1];
  if (last && last.kind === kind) {
    last.tokens.push(...tokens);
    return;
  }
  runs.push({ kind, tokens: [...tokens] });
}

function lcsWordRuns(left: readonly string[], right: readonly string[]): TokenRun[] {
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
    const leftTok = left[i];
    const rightTok = right[j];
    if (leftTok !== undefined && leftTok === rightTok) {
      pushRunTokens(runs, 'equal', [leftTok]);
      i += 1;
      j += 1;
      continue;
    }
    if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + j + 1] ?? 0)) {
      if (leftTok !== undefined) pushRunTokens(runs, 'delete', [leftTok]);
      i += 1;
    } else {
      if (rightTok !== undefined) pushRunTokens(runs, 'insert', [rightTok]);
      j += 1;
    }
  }
  while (i < left.length) {
    const leftTok = left[i];
    if (leftTok !== undefined) pushRunTokens(runs, 'delete', [leftTok]);
    i += 1;
  }
  while (j < right.length) {
    const rightTok = right[j];
    if (rightTok !== undefined) pushRunTokens(runs, 'insert', [rightTok]);
    j += 1;
  }
  return runs;
}

export function computeEditDiff(before: string, after: string): ReviewEditDiff {
  const left = tokenizeWords(before);
  const right = tokenizeWords(after);

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

  const rawRuns: TokenRun[] = [];
  pushRunTokens(rawRuns, 'equal', left.slice(0, prefix));
  for (const run of lcsWordRuns(left.slice(prefix, left.length - suffix), right.slice(prefix, right.length - suffix))) {
    pushRunTokens(rawRuns, run.kind, run.tokens);
  }
  pushRunTokens(rawRuns, 'equal', left.slice(left.length - suffix));

  let addedWords = 0;
  let deletedWords = 0;
  const runs: WordDiffRun[] = [];
  for (const run of rawRuns) {
    const text = run.tokens.join(' ');
    if (text.length === 0) continue;
    if (run.kind === 'insert') addedWords += run.tokens.length;
    if (run.kind === 'delete') deletedWords += run.tokens.length;
    const prev = runs[runs.length - 1];
    if (prev && prev.kind === run.kind) {
      runs[runs.length - 1] = { kind: prev.kind, text: `${prev.text} ${text}` };
    } else {
      runs.push({ kind: run.kind, text });
    }
  }

  return {
    changed: before !== after,
    before,
    after,
    runs,
    addedWords,
    deletedWords,
    charsBefore: Array.from(before).length,
    charsAfter: Array.from(after).length,
  };
}

// --- Internal cloning, freezing, and validation ----------------------------

function truncateCodePoints(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let end = 0;
  for (const ch of text) {
    if (end + ch.length > maxUnits) break;
    end += ch.length;
  }
  return text.slice(0, end);
}

function safeAuditDetailText(text: string, maxUnits = 160): string {
  const limit = Math.min(maxUnits, MAX_AUDIT_DETAIL_TEXT);
  const redacted = redactSecrets(text).replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  const bounded = truncateCodePoints(redacted, limit);
  return redactSecrets(bounded);
}

function validateActor(actor: ReviewerActor): ReviewerActor {
  if (typeof actor !== 'object' || actor === null || Array.isArray(actor)) {
    throw new ReviewerError('invalid-actor', 'Actor must be an object with id and role.');
  }
  if (typeof actor.id !== 'string' || actor.id.trim().length === 0) {
    throw new ReviewerError('invalid-actor', 'Actor id must be a non-empty string.');
  }
  if (!(REVIEWER_ROLES as readonly string[]).includes(actor.role)) {
    throw new ReviewerError('invalid-actor', `Unknown reviewer role "${String(actor.role)}".`);
  }
  return { id: actor.id.trim(), role: actor.role };
}

function freezeValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeValue(item);
    return Object.freeze(value);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    freezeValue(record[key]);
  }
  return Object.freeze(value);
}

function cloneDiff(diff: ReviewEditDiff | null): ReviewEditDiff | null {
  if (diff === null) return null;
  return {
    changed: diff.changed,
    before: diff.before,
    after: diff.after,
    runs: diff.runs.map(run => ({ kind: run.kind, text: run.text })),
    addedWords: diff.addedWords,
    deletedWords: diff.deletedWords,
    charsBefore: diff.charsBefore,
    charsAfter: diff.charsAfter,
  };
}

function cloneTransition(transition: ReviewTransition): ReviewTransition {
  return {
    revision: transition.revision,
    segmentId: transition.segmentId,
    action: transition.action,
    actorId: transition.actorId,
    role: transition.role,
    fromState: transition.fromState,
    toState: transition.toState,
    at: transition.at,
    diff: cloneDiff(transition.diff),
    ...(transition.reason === undefined ? {} : { reason: transition.reason }),
    auditHash: transition.auditHash,
  };
}

function cloneSegment(segment: ReviewSegment): ReviewSegment {
  return {
    id: segment.id,
    source: segment.source,
    target: segment.target,
    ...(segment.page === undefined ? {} : { page: segment.page }),
    ...(segment.blockId === undefined ? {} : { blockId: segment.blockId }),
    state: segment.state,
    revision: segment.revision,
    updatedAt: segment.updatedAt,
    updatedBy: segment.updatedBy ? { id: segment.updatedBy.id, role: segment.updatedBy.role } : null,
    history: segment.history.map(cloneTransition),
  };
}

// --- Workflow state machine ------------------------------------------------

export class ReviewerWorkflow {
  readonly documentId: string;
  private readonly auditLog: AuditLog;
  private readonly segments = new Map<string, ReviewSegment>();

  constructor(options: ReviewerWorkflowOptions) {
    this.auditLog = options.auditLog ?? new AuditLog({ now: options.now });
    // Validate documentId using AuditLog's own rules immediately at construction.
    this.auditLog.entries(options.documentId);
    this.documentId = options.documentId.trim();

    if (options.segments) {
      for (const seg of options.segments) {
        this.addSegment(seg);
      }
    }
  }

  addSegment(input: ReviewSegmentInput): ReviewSegment {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new ReviewerError('invalid-segment', 'Segment input must be an object.');
    }
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) {
      throw new ReviewerError('invalid-segment', 'Segment id must be a non-empty string.');
    }
    if (this.segments.has(id)) {
      throw new ReviewerError('duplicate-segment', `Segment "${id}" is already registered.`, id);
    }
    if (typeof input.source !== 'string' || input.source.trim().length === 0) {
      throw new ReviewerError('invalid-segment', 'Segment source text cannot be empty.', id);
    }
    if (input.target !== undefined && typeof input.target !== 'string') {
      throw new ReviewerError('invalid-segment', 'Segment target text must be a string when provided.', id);
    }

    const segment: ReviewSegment = {
      id,
      source: input.source,
      target: input.target ?? '',
      ...(input.page === undefined ? {} : { page: input.page }),
      ...(input.blockId === undefined ? {} : { blockId: input.blockId }),
      state: 'draft',
      revision: 0,
      updatedAt: null,
      updatedBy: null,
      history: [],
    };
    this.segments.set(id, segment);
    return freezeValue(cloneSegment(segment));
  }

  getSegment(segmentId: string): ReviewSegment {
    const key = typeof segmentId === 'string' ? segmentId.trim() : '';
    const segment = this.segments.get(key);
    if (!segment) {
      throw new ReviewerError('unknown-segment', `Unknown segment "${key}".`, key);
    }
    return freezeValue(cloneSegment(segment));
  }

  listSegments(filter: { state?: SegmentReviewState } = {}): ReviewSegment[] {
    const all = [...this.segments.values()];
    const selected = filter.state === undefined ? all : all.filter(seg => seg.state === filter.state);
    return freezeValue(selected.map(cloneSegment));
  }

  stats(): ReviewerWorkflowStats {
    const counts: ReviewerWorkflowStats = {
      total: this.segments.size,
      draft: 0,
      translated: 0,
      edited: 0,
      approved: 0,
      rejected: 0,
    };
    for (const seg of this.segments.values()) {
      counts[seg.state] += 1;
    }
    return counts;
  }

  saveDraft(segmentId: string, target: string, actor: ReviewerActor): ReviewTransitionResult {
    return this.applyTransition('save-draft', segmentId, actor, target);
  }

  translate(segmentId: string, target: string, actor: ReviewerActor): ReviewTransitionResult {
    return this.applyTransition('translate', segmentId, actor, target);
  }

  edit(segmentId: string, target: string, actor: ReviewerActor, reason?: string): ReviewTransitionResult {
    return this.applyTransition('edit', segmentId, actor, target, reason);
  }

  approve(segmentId: string, actor: ReviewerActor, reason?: string): ReviewTransitionResult {
    return this.applyTransition('approve', segmentId, actor, undefined, reason);
  }

  reject(segmentId: string, actor: ReviewerActor, reason?: string): ReviewTransitionResult {
    return this.applyTransition('reject', segmentId, actor, undefined, reason);
  }

  reopen(segmentId: string, actor: ReviewerActor, reason?: string): ReviewTransitionResult {
    return this.applyTransition('reopen', segmentId, actor, undefined, reason);
  }

  auditEntries(): AuditEvent[] {
    const entries = this.auditLog
      .entries(this.documentId)
      .filter(event => event.kind === 'review');
    return freezeValue(entries);
  }

  auditChain(): AuditChainEntry[] {
    return freezeValue(this.auditLog.chain());
  }

  verifyAuditChain(): number | null {
    return this.auditLog.verifyChain();
  }

  exportAuditJson(): string {
    return this.auditLog.persist();
  }

  toAuditMarkdown(): string {
    return toMarkdown(this.auditLog);
  }

  private applyTransition(
    action: ReviewerAction,
    segmentId: string,
    rawActor: ReviewerActor,
    nextTarget?: string,
    rawReason?: string,
  ): ReviewTransitionResult {
    const actor = validateActor(rawActor);
    const key = typeof segmentId === 'string' ? segmentId.trim() : '';
    const existing = this.segments.get(key);
    if (!existing) {
      throw new ReviewerError('unknown-segment', `Unknown segment "${key}".`, key);
    }

    if (!canPerformAction(actor.role, action)) {
      throw new ReviewerError(
        'forbidden-role',
        `Role "${actor.role}" is not permitted to perform "${action}".`,
        existing.id,
      );
    }

    const spec = ACTION_TRANSITIONS[action];
    if (!spec.from.includes(existing.state) || !isValidStateTransition(existing.state, spec.to)) {
      throw new ReviewerError(
        'invalid-transition',
        `Cannot perform "${action}" when segment is in state "${existing.state}".`,
        existing.id,
      );
    }

    let finalTarget = existing.target;
    let diff: ReviewEditDiff | null = null;
    if (spec.changesText) {
      if (typeof nextTarget !== 'string') {
        throw new ReviewerError('empty-translation', 'Translation text must be a string.', existing.id);
      }
      if (!spec.allowEmptyText && nextTarget.trim().length === 0) {
        throw new ReviewerError('empty-translation', 'Translation text cannot be empty.', existing.id);
      }
      finalTarget = nextTarget;
      diff = computeEditDiff(existing.target, finalTarget);
    }

    const reason = typeof rawReason === 'string' && rawReason.trim().length > 0 ? rawReason.trim() : undefined;
    const nextRevision = existing.revision + 1;

    const details: Record<string, AuditDetail> = {
      segmentId: safeAuditDetailText(existing.id, 128),
      action,
      role: actor.role,
      reviewerId: safeAuditDetailText(actor.id, 128),
      fromState: existing.state,
      toState: spec.to,
      revision: nextRevision,
    };
    if (diff !== null) {
      details.changed = diff.changed;
      details.charsBefore = diff.charsBefore;
      details.charsAfter = diff.charsAfter;
      details.addedWords = diff.addedWords;
      details.deletedWords = diff.deletedWords;
      if (diff.changed) {
        details.beforePreview = safeAuditDetailText(diff.before, 160);
        details.afterPreview = safeAuditDetailText(diff.after, 160);
      }
    }
    if (reason !== undefined) {
      details.reason = safeAuditDetailText(reason, 256);
    }

    // Append to AuditLog first; if AuditLog refuses (e.g., invalid clock), no segment state changes.
    const auditEvent = this.auditLog.append({
      kind: 'review',
      documentId: this.documentId,
      actor: 'user',
      details,
    });
    const chain = this.auditLog.chain();
    const auditEntry = chain[chain.length - 1]!;

    const transition: ReviewTransition = {
      revision: nextRevision,
      segmentId: existing.id,
      action,
      actorId: actor.id,
      role: actor.role,
      fromState: existing.state,
      toState: spec.to,
      at: auditEvent.at,
      diff,
      ...(reason === undefined ? {} : { reason }),
      auditHash: auditEntry.hash,
    };

    const updatedSegment: ReviewSegment = {
      ...existing,
      target: finalTarget,
      state: spec.to,
      revision: nextRevision,
      updatedAt: auditEvent.at,
      updatedBy: { id: actor.id, role: actor.role },
      history: [...existing.history, transition],
    };
    this.segments.set(existing.id, updatedSegment);

    return freezeValue({
      segment: cloneSegment(updatedSegment),
      transition: cloneTransition(transition),
      auditEvent,
      auditEntry,
    });
  }
}
