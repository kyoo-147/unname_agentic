/**
 * Shared, serializable job progress for browser, extension and native surfaces.
 *
 * The contract keeps document identity and generation attached to every snapshot.
 * A consumer can therefore reject a late result without guessing from a label or
 * progress percentage. State transitions are immutable, terminal states are settled,
 * and `done` is never produced merely because a counter reached its total.
 */
export const JOB_STAGES = ['queued', 'import', 'classify', 'ocr', 'translate', 'extract', 'export', 'done'] as const;
export type JobStage = (typeof JOB_STAGES)[number];
export type JobState = 'queued' | 'running' | 'paused' | 'cancelled' | 'aborted' | 'failed' | 'done';
export type ProgressStageState = 'pending' | 'running' | 'paused' | 'failed' | 'cancelled' | 'aborted' | 'done';

export interface ProgressIdentity {
  readonly jobId: string;
  readonly documentId: string;
  readonly sourceSha256: string;
  /** Monotonic per-document generation. Late work from another generation is stale. */
  readonly generation: number;
}

export interface StageProgress {
  readonly stage: JobStage;
  readonly state: ProgressStageState;
  readonly completed: number;
  readonly total: number;
  readonly percent: number;
}

export interface ProgressError {
  readonly name: string;
  readonly message: string;
}

export interface UnifiedProgress extends ProgressIdentity {
  readonly state: JobState;
  readonly stage: JobStage;
  readonly completed: number;
  readonly total: number;
  readonly stages: readonly StageProgress[];
  /** Monotonic snapshot version used to discard concurrent/out-of-order updates. */
  readonly revision: number;
  readonly settled: boolean;
  readonly cancellable: boolean;
  readonly cancelRequested: boolean;
  readonly retryable: boolean;
  readonly error?: ProgressError;
  readonly detail?: string;
}

export interface ProgressPatch {
  readonly state?: JobState;
  readonly stage?: JobStage;
  readonly completed?: number;
  readonly total?: number;
  readonly detail?: string;
  readonly error?: unknown;
  readonly retryable?: boolean;
  /** Updates from another generation are stale and are ignored. */
  readonly generation?: number;
  /** Updates at or below the current revision are stale and are ignored. */
  readonly revision?: number;
}

export interface UnifiedProgressOptions {
  readonly jobId: string;
  readonly documentId: string;
  readonly sourceSha256: string;
  readonly generation?: number;
  readonly initialStage?: JobStage;
  readonly total?: number;
  readonly stages?: readonly Pick<StageProgress, 'stage' | 'total'>[];
}

export interface ProgressApplyResult {
  readonly accepted: boolean;
  readonly value: UnifiedProgress;
}

export const PROGRESS_SCHEMA_VERSION = 1;

/** Creates a serializable progress snapshot with an immutable identity. */
export function createUnifiedProgress(options: UnifiedProgressOptions): UnifiedProgress {
  const jobId = nonEmpty(options.jobId, 'jobId');
  const documentId = nonEmpty(options.documentId, 'documentId');
  const sourceSha256 = nonEmpty(options.sourceSha256, 'sourceSha256');
  const generation = nonNegativeInteger(options.generation, 0);
  const stage = options.initialStage ?? 'queued';
  if (!isJobStage(stage)) throw new ProgressErrorClass(`Unknown job stage: ${String(stage)}.`);

  const totals = new Map<JobStage, number>();
  for (const item of options.stages ?? []) {
    if (!isJobStage(item.stage)) throw new ProgressErrorClass(`Unknown job stage: ${String(item.stage)}.`);
    totals.set(item.stage, nonNegativeInteger(item.total, 0));
  }
  totals.set(stage, Math.max(totals.get(stage) ?? 0, nonNegativeInteger(options.total, 0)));

  const stages = stageSnapshot(stage, totals, new Map(), 'pending');
  return freezeProgress({
    jobId,
    documentId,
    sourceSha256,
    generation,
    state: stage === 'done' ? 'done' : 'queued',
    stage,
    completed: 0,
    total: totals.get(stage) ?? 0,
    stages: stage === 'done'
      ? stageSnapshot(stage, totals, new Map(), 'done')
      : stages,
    revision: 0,
    settled: stage === 'done',
    cancellable: stage !== 'done',
    cancelRequested: false,
    retryable: false,
  });
}

/** Backward-compatible constructor used by existing queue and reader tests. */
export function progress(jobId: string, stage: JobStage = 'queued', total = 0): UnifiedProgress {
  const normalizedJobId = typeof jobId === 'string' ? jobId.trim() : '';
  return freezeProgress({
    ...createLegacyIdentity(normalizedJobId),
    state: stage === 'done' ? 'done' : 'queued',
    stage,
    completed: 0,
    total: nonNegativeInteger(total, 0),
    stages: stageSnapshot(stage, new Map([[stage, nonNegativeInteger(total, 0)]]), new Map(), 'pending'),
    revision: 0,
    settled: stage === 'done',
    cancellable: stage !== 'done',
    cancelRequested: false,
    retryable: false,
  });
}

/**
 * Applies one immutable update. A stale generation or revision returns the current
 * snapshot unchanged, which makes it safe to feed results from concurrent workers.
 */
export function applyProgressUpdate(current: UnifiedProgress, update: ProgressPatch): ProgressApplyResult {
  if (update.generation !== undefined && update.generation !== current.generation) return { accepted: false, value: current };
  if (update.revision !== undefined && update.revision <= current.revision) return { accepted: false, value: current };
  const value = updateProgress(current, update);
  return { accepted: value !== current, value };
}

/** Updates progress while enforcing terminal and generation invariants. */
export function updateProgress(current: UnifiedProgress, update: ProgressPatch): UnifiedProgress {
  if (update.generation !== undefined && update.generation !== current.generation) return current;
  if (update.revision !== undefined && update.revision <= current.revision) return current;
  if (current.settled) return current;

  const stage = update.stage ?? current.stage;
  if (!isJobStage(stage)) return current;
  const total = nonNegativeInteger(update.total, current.total);
  const completed = Math.min(total, nonNegativeInteger(update.completed, current.completed));
  const state = update.state ?? current.state;
  const terminal = state === 'done' || state === 'failed' || state === 'cancelled' || state === 'aborted';
  const settled = terminal;
  const nextStage = state === 'done' ? 'done' : stage;
  const nextTotal = state === 'done' ? Math.max(total, completed) : total;
  const nextCompleted = state === 'done' ? nextTotal : completed;
  const nextError = state === 'failed' || state === 'aborted'
    ? serializeError(update.error ?? current.error)
    : undefined;
  const totals = new Map(current.stages.map(item => [item.stage, item.total] as const));
  totals.set(stage, nextTotal);
  if (state === 'done') totals.set('done', Math.max(totals.get('done') ?? 0, 1));
  const completedByStage = new Map(current.stages.map(item => [item.stage, item.completed] as const));
  completedByStage.set(stage, nextCompleted);
  const stageStates = new Map(current.stages.map(item => [item.stage, item.state] as const));
  if (state === 'running' || state === 'queued' || state === 'paused') {
    stageStates.set(stage, state === 'queued' ? 'pending' : state);
  } else if (state === 'done') {
    stageStates.set(stage, 'done');
    stageStates.set('done', 'done');
  } else {
    stageStates.set(stage, state);
  }
  if (current.stage !== stage && current.total > 0 && current.completed >= current.total && !current.settled) {
    stageStates.set(current.stage, 'done');
    completedByStage.set(current.stage, current.total);
  }

  const revision = Math.max(current.revision + 1, update.revision ?? 0);
  return freezeProgress({
    ...current,
    state,
    stage: nextStage,
    completed: nextCompleted,
    total: nextTotal,
    stages: stageSnapshot(nextStage, totals, completedByStage, stageStates.get(nextStage) ?? stageStates.get(stage) ?? 'pending', stageStates),
    revision,
    settled,
    cancellable: !settled,
    cancelRequested: current.cancelRequested || state === 'cancelled',
    retryable: update.retryable ?? (state === 'failed' ? current.retryable : false),
    ...(nextError ? { error: nextError } : {}),
    ...(update.detail !== undefined ? { detail: update.detail } : {}),
  });
}

/** Requests user cancellation. The state is terminal even if a provider settles later. */
export function requestCancel(current: UnifiedProgress, detail?: string): UnifiedProgress {
  if (current.settled || !current.cancellable) return current;
  return updateProgress(current, { state: 'cancelled', detail });
}

/** Records provider or transport abortion separately from an intentional user cancel. */
export function requestAbort(current: UnifiedProgress, reason?: unknown): UnifiedProgress {
  if (current.settled) return current;
  return updateProgress(current, { state: 'aborted', error: reason, detail: reason instanceof Error ? reason.message : undefined });
}

/** Records a terminal failure without fabricating a successful completion. */
export function failProgress(current: UnifiedProgress, error: unknown, retryable = false): UnifiedProgress {
  if (current.settled) return current;
  return updateProgress(current, { state: 'failed', error, retryable });
}

/** Starts a new attempt while preserving document identity and rejecting old results. */
export function retryProgress(current: UnifiedProgress, stage = current.stage): UnifiedProgress {
  if (!isJobStage(stage) || stage === 'done') return current;
  const totals = new Map(current.stages.map(item => [item.stage, item.total] as const));
  const completedByStage = new Map(current.stages.map(item => [item.stage, item.completed] as const));
  const states = new Map(current.stages.map(item => [item.stage, item.state] as const));
  totals.set(stage, current.total);
  completedByStage.set(stage, 0);
  states.set(stage, 'pending');
  return freezeProgress({
    ...current,
    generation: current.generation + 1,
    revision: current.revision + 1,
    state: 'queued',
    stage,
    completed: 0,
    total: current.total,
    stages: stageSnapshot(stage, totals, completedByStage, 'pending', states),
    settled: false,
    cancellable: true,
    cancelRequested: false,
    retryable: false,
    error: undefined,
    detail: undefined,
  });
}

/** Whole-job percentage. A terminal done state is the only unconditional 100. */
export function percent(current: UnifiedProgress): number {
  if (current.state === 'done') return 100;
  const measurable = current.stages.filter(stage => stage.total > 0 && stage.stage !== 'done');
  if (measurable.length > 0) {
    const total = measurable.reduce((sum, stage) => sum + stage.total, 0);
    const completed = measurable.reduce((sum, stage) => sum + Math.min(stage.completed, stage.total), 0);
    return total > 0 ? Math.floor((completed / total) * 100) : 0;
  }
  if (current.total <= 0) return 0;
  return Math.floor((Math.min(current.completed, current.total) / current.total) * 100);
}

export function stagePercent(stage: StageProgress): number {
  return stage.total > 0 ? Math.floor((Math.min(stage.completed, stage.total) / stage.total) * 100) : 0;
}

/** Versioned JSON suitable for bridge/native persistence. */
export function serializeProgress(value: UnifiedProgress): string {
  return JSON.stringify({ version: PROGRESS_SCHEMA_VERSION, ...value, stages: value.stages.map(stage => ({ ...stage })) });
}

/** Parses and validates a serialized snapshot. It never guesses missing identity fields. */
export function deserializeProgress(raw: string): UnifiedProgress {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ProgressErrorClass('Progress JSON is malformed.', error);
  }
  if (!isRecord(value) || value.version !== PROGRESS_SCHEMA_VERSION) throw new ProgressErrorClass('Unsupported progress schema version.');
  const stages = Array.isArray(value.stages) ? value.stages : [];
  const identity = {
    jobId: stringField(value.jobId, 'jobId'),
    documentId: stringField(value.documentId, 'documentId'),
    sourceSha256: stringField(value.sourceSha256, 'sourceSha256'),
    generation: integerField(value.generation, 'generation'),
  };
  const state = value.state;
  const stage = value.stage;
  if (!isJobState(state) || !isJobStage(stage)) throw new ProgressErrorClass('Progress state or stage is invalid.');
  const parsedStages = stages.map((item, index) => {
    if (!isRecord(item) || !isJobStage(item.stage) || !isStageState(item.state)) throw new ProgressErrorClass(`Progress stage ${index} is invalid.`);
    const total = integerField(item.total, `stages[${index}].total`);
    const completed = Math.min(total, integerField(item.completed, `stages[${index}].completed`));
    return { stage: item.stage, state: item.state, completed, total, percent: stagePercent({ stage: item.stage, state: item.state, completed, total, percent: 0 }) };
  });
  const terminal = state === 'done' || state === 'failed' || state === 'cancelled' || state === 'aborted';
  const settled = value.settled === true;
  const cancellable = value.cancellable === true;
  const cancelRequested = value.cancelRequested === true;
  const completed = integerField(value.completed, 'completed');
  const total = integerField(value.total, 'total');
  if (completed > total) throw new ProgressErrorClass('Progress completed count exceeds total.');
  if (settled !== terminal) throw new ProgressErrorClass('Progress settled flag does not match its state.');
  if (cancellable === terminal) throw new ProgressErrorClass('Progress cancellable flag does not match its state.');
  if (cancelRequested !== (state === 'cancelled')) throw new ProgressErrorClass('Progress cancellation flag does not match its state.');
  if ((state === 'done') !== (stage === 'done')) throw new ProgressErrorClass('A done progress snapshot must use the done stage.');
  const parsed: UnifiedProgress = {
    ...identity,
    state,
    stage,
    completed,
    total,
    stages: Object.freeze(parsedStages),
    revision: integerField(value.revision, 'revision'),
    settled,
    cancellable,
    cancelRequested,
    retryable: value.retryable === true,
    ...(value.error === undefined ? {} : { error: parseError(value.error) }),
    ...(value.detail === undefined ? {} : { detail: stringField(value.detail, 'detail') }),
  };
  return freezeProgress(parsed);
}

/** Mutable-by-operation controller with immutable snapshots for UI subscribers. */
export class UnifiedProgressStore {
  private current: UnifiedProgress;
  private readonly listeners = new Set<(value: UnifiedProgress) => void>();

  constructor(initial: UnifiedProgress) {
    this.current = initial;
  }

  snapshot(): UnifiedProgress { return this.current; }

  subscribe(listener: (value: UnifiedProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch: ProgressPatch): ProgressApplyResult {
    const result = applyProgressUpdate(this.current, patch);
    if (result.accepted) {
      this.current = result.value;
      for (const listener of this.listeners) listener(this.current);
    }
    return result;
  }

  pause(detail?: string): UnifiedProgress { return this.update({ state: 'paused', detail }).value; }
  resume(detail?: string): UnifiedProgress { return this.update({ state: 'running', detail }).value; }
  cancel(detail?: string): UnifiedProgress { return this.commit(requestCancel(this.current, detail)); }
  abort(reason?: unknown): UnifiedProgress { return this.commit(requestAbort(this.current, reason)); }
  fail(error: unknown, retryable = false): UnifiedProgress { return this.commit(failProgress(this.current, error, retryable)); }
  retry(stage = this.current.stage): UnifiedProgress { return this.commit(retryProgress(this.current, stage)); }
  complete(detail?: string): UnifiedProgress { return this.update({ state: 'done', stage: 'done', detail }).value; }

  private commit(next: UnifiedProgress): UnifiedProgress {
    if (next === this.current) return next;
    this.current = next;
    for (const listener of this.listeners) listener(this.current);
    return next;
  }
}

export class ProgressErrorClass extends Error {
  constructor(message: string, options?: unknown) {
    super(message, options === undefined ? undefined : { cause: options });
    this.name = 'ProgressError';
  }
}

function stageSnapshot(
  activeStage: JobStage,
  totals: Map<JobStage, number>,
  completed: Map<JobStage, number>,
  activeState: ProgressStageState,
  states: Map<JobStage, ProgressStageState> = new Map(),
): readonly StageProgress[] {
  return Object.freeze(JOB_STAGES.map(stage => {
    const total = nonNegativeInteger(totals.get(stage), 0);
    const done = Math.min(total, nonNegativeInteger(completed.get(stage), 0));
    const state = stage === activeStage ? activeState : states.get(stage) ?? (done >= total && total > 0 ? 'done' : 'pending');
    return Object.freeze({ stage, state, completed: done, total, percent: stagePercent({ stage, state, completed: done, total, percent: 0 }) });
  }));
}

function freezeProgress(value: UnifiedProgress): UnifiedProgress {
  return Object.freeze({ ...value, stages: Object.freeze(value.stages.map(stage => Object.freeze({ ...stage }))) });
}

function createLegacyIdentity(jobId: string): ProgressIdentity {
  return { jobId, documentId: '', sourceSha256: '', generation: 0 };
}

function serializeError(error: unknown): ProgressError | undefined {
  if (error === undefined) return undefined;
  if (error && typeof error === 'object') {
    const candidate = error as { name?: unknown; message?: unknown };
    return { name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : 'Error', message: typeof candidate.message === 'string' ? candidate.message : String(error) };
  }
  return { name: 'Error', message: String(error) };
}

function parseError(value: unknown): ProgressError {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.message !== 'string') throw new ProgressErrorClass('Progress error is invalid.');
  return { name: value.name, message: value.message };
}

function isJobStage(value: unknown): value is JobStage { return typeof value === 'string' && (JOB_STAGES as readonly string[]).includes(value); }
function isJobState(value: unknown): value is JobState { return value === 'queued' || value === 'running' || value === 'paused' || value === 'cancelled' || value === 'aborted' || value === 'failed' || value === 'done'; }
function isStageState(value: unknown): value is ProgressStageState { return value === 'pending' || value === 'running' || value === 'paused' || value === 'failed' || value === 'cancelled' || value === 'aborted' || value === 'done'; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function nonEmpty(value: unknown, field: string): string { if (typeof value !== 'string' || value.trim() === '') throw new ProgressErrorClass(`${field} must be a non-empty string.`); return value.trim(); }
function stringField(value: unknown, field: string): string { if (typeof value !== 'string') throw new ProgressErrorClass(`${field} must be a string.`); return value; }
function integerField(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProgressErrorClass(`${field} must be a non-negative integer.`); return value as number; }
function nonNegativeInteger(value: unknown, fallback: number): number { return Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : fallback; }
