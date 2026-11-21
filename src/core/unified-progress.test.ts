import { describe, expect, it } from 'vitest';
import {
  createUnifiedProgress,
  deserializeProgress,
  failProgress,
  percent,
  progress,
  requestCancel,
  retryProgress,
  serializeProgress,
  UnifiedProgressStore,
  updateProgress,
} from './unified-progress';

describe('unified progress contract', () => {
  it('normalizes stage progress and exposes a truthful percentage', () => {
    const start = progress('job-1', 'translate', 4);
    const current = updateProgress(start, { state: 'running', completed: 2 });
    expect(current).toMatchObject({ stage: 'translate', completed: 2, total: 4, cancellable: true });
    expect(percent(current)).toBe(50);
  });

  it('cancel is terminal and never reports a completed result', () => {
    const current = updateProgress(progress('job-1', 'ocr', 3), { state: 'running', completed: 1 });
    const cancelled = requestCancel(current);
    expect(cancelled).toMatchObject({ state: 'cancelled', cancelRequested: true, cancellable: false });
    expect(percent(cancelled)).toBe(33);
    expect(requestCancel(cancelled)).toBe(cancelled);
  });

  it('a settled job can reach one hundred percent while keeping its terminal state', () => {
    const current = updateProgress(progress('job-1', 'export', 2), { state: 'failed', completed: 2 });
    expect(percent(current)).toBe(100);
    expect(percent(updateProgress(current, { state: 'done', stage: 'done' }))).toBe(100);
  });
});

describe('serializable identity and generation guards', () => {
  it('keeps document identity, per-stage progress and round-trips through JSON', () => {
    const initial = createUnifiedProgress({
      jobId: 'job-2',
      documentId: 'doc-2',
      sourceSha256: 'a'.repeat(64),
      generation: 4,
      initialStage: 'import',
      total: 2,
      stages: [{ stage: 'translate', total: 4 }, { stage: 'export', total: 1 }],
    });
    const importing = updateProgress(initial, { state: 'running', completed: 1, revision: 1 });
    const translating = updateProgress(importing, { stage: 'translate', state: 'running', total: 4, completed: 2, revision: 2 });
    const restored = deserializeProgress(serializeProgress(translating));

    expect(restored).toEqual(translating);
    expect(restored.documentId).toBe('doc-2');
    expect(restored.sourceSha256).toBe('a'.repeat(64));
    expect(restored.stages.find(stage => stage.stage === 'translate')?.percent).toBe(50);
    expect(updateProgress(restored, { generation: 3, state: 'done', stage: 'done', revision: 3 })).toBe(restored);
  });

  it('does not turn a full counter into done before settlement', () => {
    const current = updateProgress(progress('job-3', 'translate', 2), { state: 'running', completed: 2 });
    expect(current.state).toBe('running');
    expect(percent(current)).toBe(100);
    expect(current.settled).toBe(false);
    expect(updateProgress(current, { state: 'done', stage: 'done' }).settled).toBe(true);
  });

  it('retries with a new generation and rejects late terminal work', () => {
    const failed = failProgress(createUnifiedProgress({ jobId: 'job-4', documentId: 'doc-4', sourceSha256: 'b'.repeat(64), initialStage: 'translate', total: 1 }), new Error('temporary'), true);
    const retry = retryProgress(failed);
    expect(retry.generation).toBe(failed.generation + 1);
    expect(retry.state).toBe('queued');
    expect(updateProgress(retry, { generation: failed.generation, state: 'done', stage: 'done' })).toBe(retry);
  });

  it('commits cancellation to store subscribers and keeps terminal failures terminal', () => {
    const store = new UnifiedProgressStore(progress('job-5', 'ocr', 1));
    const states: string[] = [];
    store.subscribe(value => states.push(value.state));

    const cancelled = store.cancel('user requested');
    expect(cancelled.state).toBe('cancelled');
    expect(store.snapshot()).toBe(cancelled);
    expect(states).toEqual(['cancelled']);
    expect(store.update({ state: 'done', stage: 'done' })).toEqual({ accepted: false, value: cancelled });

    const failed = new UnifiedProgressStore(progress('job-6', 'ocr', 1));
    failed.fail(new Error('provider failed'));
    expect(failed.update({ state: 'done', stage: 'done' }).accepted).toBe(false);
    expect(failed.snapshot().state).toBe('failed');
  });
});
