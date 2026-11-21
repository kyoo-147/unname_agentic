import { describe, expect, it } from 'vitest';
import {
  AuditLog,
  restoreAuditLog,
  toMarkdown,
  verifyAuditChain,
} from '../src/core/audit';
import {
  allowedNextStates,
  canPerformAction,
  computeEditDiff,
  isValidStateTransition,
  REVIEWER_ACTIONS,
  REVIEWER_ROLES,
  ReviewerError,
  ReviewerWorkflow,
  ROLE_PERMISSIONS,
  SEGMENT_REVIEW_STATES,
  type ReviewerActor,
  type ReviewerErrorCode,
} from '../src/core/reviewer-mode';

const BASE_AT = '2026-11-21T09:00:00.000Z';

const TRANSLATOR: ReviewerActor = { id: 'translator-linh', role: 'translator' };
const EDITOR: ReviewerActor = { id: 'editor-minh', role: 'editor' };
const APPROVER: ReviewerActor = { id: 'approver-hoa', role: 'approver' };

function makeClock(startMs = Date.parse(BASE_AT)): () => string {
  let step = 0;
  return () => {
    const iso = new Date(startMs + step * 1000).toISOString();
    step += 1;
    return iso;
  };
}

function expectReviewerError(run: () => unknown, code: ReviewerErrorCode): ReviewerError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewerError);
    const revError = error as ReviewerError;
    expect(revError.code).toBe(code);
    return revError;
  }
  throw new Error(`Expected ReviewerError(${code})`);
}

function createWorkflow(options: { auditLog?: AuditLog; now?: () => string; initialTarget?: string } = {}): ReviewerWorkflow {
  return new ReviewerWorkflow({
    documentId: 'doc-contract-01',
    now: options.now ?? makeClock(),
    auditLog: options.auditLog,
    segments: [
      { id: 'seg-1', source: 'The buyer must pay within 30 days.', target: options.initialTarget ?? '' },
      { id: 'seg-2', source: 'All disputes are settled in Hanoi.', target: '' },
    ],
  });
}

describe('roles, permissions, and state machine rules', () => {
  it('defines the three reviewer roles, five states, and strict permission matrix', () => {
    expect(REVIEWER_ROLES).toEqual(['translator', 'editor', 'approver']);
    expect(SEGMENT_REVIEW_STATES).toEqual(['draft', 'translated', 'edited', 'approved', 'rejected']);
    expect(REVIEWER_ACTIONS).toEqual(['save-draft', 'translate', 'edit', 'approve', 'reject', 'reopen']);

    expect(ROLE_PERMISSIONS.translator).toEqual(['save-draft', 'translate']);
    expect(ROLE_PERMISSIONS.editor).toEqual(['edit']);
    expect(ROLE_PERMISSIONS.approver).toEqual(['approve', 'reject', 'reopen']);

    expect(canPerformAction('translator', 'translate')).toBe(true);
    expect(canPerformAction('translator', 'edit')).toBe(false);
    expect(canPerformAction('translator', 'approve')).toBe(false);
    expect(canPerformAction('editor', 'edit')).toBe(true);
    expect(canPerformAction('editor', 'translate')).toBe(false);
    expect(canPerformAction('editor', 'reject')).toBe(false);
    expect(canPerformAction('approver', 'approve')).toBe(true);
    expect(canPerformAction('approver', 'reject')).toBe(true);
    expect(canPerformAction('approver', 'edit')).toBe(false);
  });

  it('validates allowed state transitions along draft -> translated -> edited -> approved | rejected', () => {
    expect(allowedNextStates('draft')).toEqual(['draft', 'translated']);
    expect(allowedNextStates('translated')).toEqual(['edited']);
    expect(allowedNextStates('edited')).toEqual(['edited', 'approved', 'rejected']);
    expect(allowedNextStates('approved')).toEqual([]);
    expect(allowedNextStates('rejected')).toEqual(['draft']);

    expect(isValidStateTransition('draft', 'translated')).toBe(true);
    expect(isValidStateTransition('translated', 'edited')).toBe(true);
    expect(isValidStateTransition('edited', 'approved')).toBe(true);
    expect(isValidStateTransition('edited', 'rejected')).toBe(true);
    expect(isValidStateTransition('draft', 'approved')).toBe(false);
    expect(isValidStateTransition('translated', 'approved')).toBe(false);
    expect(isValidStateTransition('approved', 'edited')).toBe(false);
  });
});

describe('workflow transitions and permission guards', () => {
  it('executes the happy path draft -> translated -> edited -> approved with diffs and stats', () => {
    const wf = createWorkflow({ initialTarget: 'Machine draft' });
    expect(wf.stats()).toEqual({
      total: 2,
      draft: 2,
      translated: 0,
      edited: 0,
      approved: 0,
      rejected: 0,
    });

    const draftRes = wf.saveDraft('seg-1', 'Người mua phải trả trong 30 ngày', TRANSLATOR);
    expect(draftRes.segment.state).toBe('draft');
    expect(draftRes.transition.fromState).toBe('draft');
    expect(draftRes.transition.toState).toBe('draft');

    const trRes = wf.translate('seg-1', 'Người mua phải thanh toán trong 30 ngày.', TRANSLATOR);
    expect(trRes.segment.state).toBe('translated');
    expect(trRes.segment.revision).toBe(2);
    expect(trRes.transition.diff?.changed).toBe(true);
    expect(trRes.transition.diff?.before).toBe('Người mua phải trả trong 30 ngày');
    expect(trRes.transition.diff?.after).toBe('Người mua phải thanh toán trong 30 ngày.');

    const edRes = wf.edit('seg-1', 'Bên mua phải thanh toán trong vòng 30 ngày.', EDITOR);
    expect(edRes.segment.state).toBe('edited');
    expect(edRes.segment.revision).toBe(3);
    expect(edRes.transition.diff).toMatchObject({
      changed: true,
      before: 'Người mua phải thanh toán trong 30 ngày.',
      after: 'Bên mua phải thanh toán trong vòng 30 ngày.',
    });
    expect(edRes.transition.diff?.deletedWords).toBeGreaterThan(0);
    expect(edRes.transition.diff?.addedWords).toBeGreaterThan(0);

    const apRes = wf.approve('seg-1', APPROVER, 'Terminology verified');
    expect(apRes.segment.state).toBe('approved');
    expect(apRes.segment.target).toBe('Bên mua phải thanh toán trong vòng 30 ngày.');
    expect(apRes.transition.diff).toBeNull();
    expect(apRes.transition.reason).toBe('Terminology verified');

    expect(wf.stats()).toEqual({
      total: 2,
      draft: 1,
      translated: 0,
      edited: 0,
      approved: 1,
      rejected: 0,
    });
  });

  it('supports multiple editor passes, no-op confirmation edits, rejection, and approver reopen', () => {
    const wf = createWorkflow();
    wf.translate('seg-1', 'Bản dịch ban đầu.', TRANSLATOR);
    const firstEdit = wf.edit('seg-1', 'Bản dịch đã sửa.', EDITOR);
    expect(firstEdit.segment.state).toBe('edited');

    const confirmEdit = wf.edit('seg-1', 'Bản dịch đã sửa.', EDITOR);
    expect(confirmEdit.segment.state).toBe('edited');
    expect(confirmEdit.transition.diff).toEqual({
      changed: false,
      before: 'Bản dịch đã sửa.',
      after: 'Bản dịch đã sửa.',
      runs: [{ kind: 'equal', text: 'Bản dịch đã sửa.' }],
      addedWords: 0,
      deletedWords: 0,
      charsBefore: 16,
      charsAfter: 16,
    });

    const rejected = wf.reject('seg-1', APPROVER, 'Missing legal citation');
    expect(rejected.segment.state).toBe('rejected');
    expect(rejected.transition.reason).toBe('Missing legal citation');

    // Cannot approve or edit directly from rejected
    expectReviewerError(() => wf.approve('seg-1', APPROVER), 'invalid-transition');
    expectReviewerError(() => wf.edit('seg-1', 'Sửa lại', EDITOR), 'invalid-transition');
    expectReviewerError(() => wf.translate('seg-1', 'Dịch lại', TRANSLATOR), 'invalid-transition');

    // Approver explicitly reopens rejected -> draft for rework
    const reopened = wf.reopen('seg-1', APPROVER, 'Send back for rework');
    expect(reopened.segment.state).toBe('draft');

    wf.translate('seg-1', 'Bản dịch mới có trích dẫn.', TRANSLATOR);
    wf.edit('seg-1', 'Bản dịch mới có trích dẫn đầy đủ.', EDITOR);
    const approved = wf.approve('seg-1', APPROVER);
    expect(approved.segment.state).toBe('approved');
  });

  it('enforces role permission guards and state-machine guards without mutating segment state', () => {
    const wf = createWorkflow();

    // Wrong roles at draft stage
    expectReviewerError(() => wf.edit('seg-1', 'Edited', EDITOR), 'invalid-transition');
    expectReviewerError(() => wf.translate('seg-1', 'Translated', EDITOR), 'forbidden-role');
    expectReviewerError(() => wf.translate('seg-1', 'Translated', APPROVER), 'forbidden-role');
    expectReviewerError(() => wf.approve('seg-1', TRANSLATOR), 'forbidden-role');
    expectReviewerError(() => wf.reject('seg-1', EDITOR), 'forbidden-role');

    // Translator cannot skip into edited or approved
    wf.translate('seg-1', 'Đã dịch.', TRANSLATOR);
    expectReviewerError(() => wf.translate('seg-1', 'Dịch lại.', TRANSLATOR), 'invalid-transition');
    expectReviewerError(() => wf.edit('seg-1', 'Edited by translator', TRANSLATOR), 'forbidden-role');
    expectReviewerError(() => wf.approve('seg-1', APPROVER), 'invalid-transition');
    expectReviewerError(() => wf.reject('seg-1', APPROVER), 'invalid-transition');

    // Editor edits, then approver approves; approved is strictly locked
    wf.edit('seg-1', 'Đã biên tập.', EDITOR);
    wf.approve('seg-1', APPROVER);
    expectReviewerError(() => wf.edit('seg-1', 'Post-approval edit', EDITOR), 'invalid-transition');
    expectReviewerError(() => wf.reject('seg-1', APPROVER), 'invalid-transition');
    expectReviewerError(() => wf.reopen('seg-1', APPROVER), 'invalid-transition');

    expect(wf.getSegment('seg-1').state).toBe('approved');
    expect(wf.getSegment('seg-1').target).toBe('Đã biên tập.');
  });

  it('rejects invalid actors, empty translations, unknown segments, and duplicate segment ids', () => {
    const wf = createWorkflow();

    expectReviewerError(() => wf.translate('missing-id', 'text', TRANSLATOR), 'unknown-segment');
    expectReviewerError(
      () => wf.translate('seg-1', 'text', { id: '   ', role: 'translator' }),
      'invalid-actor',
    );
    expectReviewerError(
      () => wf.translate('seg-1', 'text', { id: 'u1', role: 'admin' as unknown as ReviewerActor['role'] }),
      'invalid-actor',
    );
    expectReviewerError(() => wf.translate('seg-1', '   ', TRANSLATOR), 'empty-translation');
    expectReviewerError(() => wf.addSegment({ id: 'seg-1', source: 'Duplicate' }), 'duplicate-segment');
  });
});

describe('edit diff capture', () => {
  it('captures exact word-level diffs including 1-character word edits and CJK/Vietnamese text', () => {
    const shortReplace = computeEditDiff('I saw a cat', 'I saw the cat');
    expect(shortReplace).toEqual({
      changed: true,
      before: 'I saw a cat',
      after: 'I saw the cat',
      runs: [
        { kind: 'equal', text: 'I saw' },
        { kind: 'delete', text: 'a' },
        { kind: 'insert', text: 'the' },
        { kind: 'equal', text: 'cat' },
      ],
      addedWords: 1,
      deletedWords: 1,
      charsBefore: 11,
      charsAfter: 13,
    });

    const viDiff = computeEditDiff('Hệ thống AI xử lý dữ liệu', 'Hệ thống AI hiện đại xử lý tài liệu');
    expect(viDiff.changed).toBe(true);
    expect(viDiff.runs).toEqual([
      { kind: 'equal', text: 'Hệ thống AI' },
      { kind: 'insert', text: 'hiện đại' },
      { kind: 'equal', text: 'xử lý' },
      { kind: 'delete', text: 'dữ' },
      { kind: 'insert', text: 'tài' },
      { kind: 'equal', text: 'liệu' },
    ]);
  });
});

describe('AuditLog compatibility and immutability', () => {
  it('emits hash-chained AuditLog events compatible with src/core/audit.ts restore and markdown', () => {
    const clock = makeClock();
    const sharedLog = new AuditLog({ now: clock });
    sharedLog.append({ kind: 'import', documentId: 'doc-contract-01', actor: 'user', details: { pages: 4 } });

    const wf = createWorkflow({ auditLog: sharedLog, now: clock });
    wf.translate('seg-1', 'Bản dịch lần một.', TRANSLATOR);
    wf.edit('seg-1', 'Bản dịch lần hai.', EDITOR);
    wf.approve('seg-1', APPROVER);

    sharedLog.append({ kind: 'export', documentId: 'doc-contract-01', actor: 'user', details: { format: 'pdf' } });

    expect(sharedLog.verifyChain()).toBeNull();
    expect(wf.verifyAuditChain()).toBeNull();

    const reviewEvents = wf.auditEntries();
    expect(reviewEvents).toHaveLength(3);
    expect(reviewEvents.every(event => event.kind === 'review' && event.actor === 'user')).toBe(true);
    expect(reviewEvents.map(event => event.details.toState)).toEqual(['translated', 'edited', 'approved']);

    const chain = wf.auditChain();
    expect(chain).toHaveLength(5);
    expect(verifyAuditChain(chain)).toBeNull();

    const persisted = wf.exportAuditJson();
    const restored = restoreAuditLog(persisted);
    expect(restored.verifyChain()).toBeNull();
    expect(restored.entries('doc-contract-01')).toHaveLength(5);

    const markdown = wf.toAuditMarkdown();
    expect(markdown).toBe(toMarkdown(sharedLog));
    expect(markdown).toContain('**review**');
    expect(markdown).toContain('role: editor');
  });

  it('safely logs segments exceeding 512 chars or containing emails/keys without breaking AuditLog', () => {
    const wf = createWorkflow();
    const longSensitive =
      `${'Đây là một đoạn văn bản dài tiếng Việt dùng để kiểm thử giới hạn độ dài chi tiết nhật ký kiểm toán. '.repeat(7)}` +
      'Contact alice@example.com or use sk-live-0123456789abcdef0123.';

    wf.translate('seg-1', longSensitive, { id: 'alice@example.com', role: 'translator' });
    wf.edit('seg-1', `${longSensitive} Đã biên tập.`, EDITOR);
    wf.approve('seg-1', APPROVER, 'Checked with bob@example.com');

    expect(wf.verifyAuditChain()).toBeNull();
    const persisted = wf.exportAuditJson();
    expect(persisted).not.toContain('alice@example.com');
    expect(persisted).not.toContain('bob@example.com');
    expect(persisted).not.toContain('sk-live-0123456789abcdef0123');
    expect(restoreAuditLog(persisted).verifyChain()).toBeNull();
  });

  it('returns immutable isolated snapshots that cannot be mutated to tamper with history or audit records', () => {
    const wf = createWorkflow();
    const tr = wf.translate('seg-1', 'Bản dịch.', TRANSLATOR);

    // Mutating returned objects should either fail (frozen) or never leak into internal workflow state
    try {
      (tr.segment as unknown as { state: string }).state = 'approved';
    } catch {
      // frozen
    }
    try {
      (tr.segment.history as unknown[]).push({ fake: true });
    } catch {
      // frozen
    }
    try {
      (tr.auditEvent.details as Record<string, unknown>).toState = 'approved';
    } catch {
      // frozen or copied
    }

    const stored = wf.getSegment('seg-1');
    expect(stored.state).toBe('translated');
    expect(stored.history).toHaveLength(1);
    expect(wf.auditEntries()[0]?.details.toState).toBe('translated');
  });
});
