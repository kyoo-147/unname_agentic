/** Shared progress contract for web, extension and native surfaces.
 *
 * This is deliberately transport-neutral. A producer may be the web queue, the
 * extension bridge or the native reader, but every consumer can render the same
 * stage/percent/cancel state without inferring completion from a status string.
 */
export const JOB_STAGES = ['queued', 'import', 'classify', 'ocr', 'translate', 'extract', 'export', 'done'] as const;
export type JobStage = (typeof JOB_STAGES)[number];
export type JobState = 'queued' | 'running' | 'paused' | 'cancelled' | 'failed' | 'done';

export interface UnifiedProgress {
  readonly jobId: string;
  readonly state: JobState;
  readonly stage: JobStage;
  readonly completed: number;
  readonly total: number;
  readonly cancellable: boolean;
  readonly cancelRequested: boolean;
  readonly detail?: string;
}

export function progress(jobId: string, stage: JobStage = 'queued', total = 0): UnifiedProgress {
  const safeTotal = finiteInteger(total, 0);
  return Object.freeze({ jobId: jobId.trim(), state: stage === 'done' ? 'done' : 'queued', stage, completed: 0, total: safeTotal, cancellable: stage !== 'done', cancelRequested: false });
}

export function updateProgress(current: UnifiedProgress, update: Partial<Pick<UnifiedProgress, 'state' | 'stage' | 'completed' | 'total' | 'detail'>>): UnifiedProgress {
  const total = Math.max(0, finiteInteger(update.total ?? current.total, current.total));
  const completed = Math.min(total, Math.max(0, finiteInteger(update.completed ?? current.completed, current.completed)));
  const stage = update.stage ?? current.stage;
  const state = update.state ?? current.state;
  return Object.freeze({ ...current, ...update, stage, state, total, completed, cancellable: state === 'queued' || state === 'running' || state === 'paused', cancelRequested: current.cancelRequested || state === 'cancelled' });
}

export function requestCancel(current: UnifiedProgress): UnifiedProgress {
  if (!current.cancellable || current.state === 'done' || current.state === 'failed') return current;
  return Object.freeze({ ...current, state: 'cancelled', cancelRequested: true, cancellable: false });
}

export function percent(current: UnifiedProgress): number {
  if (current.total <= 0) return current.state === 'done' ? 100 : 0;
  return current.state === 'done' ? 100 : Math.floor((Math.min(current.completed, current.total) / current.total) * 100);
}

function finiteInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}
