import { describe, expect, it } from 'vitest';
import { percent, progress, requestCancel, updateProgress } from './unified-progress';

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
