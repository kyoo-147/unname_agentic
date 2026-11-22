/**
 * Batch queue with honest pause, resume and cancel semantics.
 *
 * A `BatchQueue` owns a list of jobs and runs at most `concurrency` of them at
 * once. Its status is written so a UI can trust it:
 *
 * - `done + failed + cancelled + pending` always equals `jobs`. `pending`
 *   counts work that has not settled yet, whether it is still waiting or
 *   already running, so the four counters can never disagree with the total.
 * - `current` lists only jobs whose status is running, in launch order. A
 *   cancelled job that is still winding down is not listed, because the same
 *   snapshot already counts it as cancelled.
 * - A job aborted by `cancelAll()` stays `cancelled` even if its run function
 *   ignores the signal and settles later: the user's intent outranks a late
 *   answer, and the counters keep saying so.
 *
 * `pause()` stops launching new jobs but never interrupts the ones in flight;
 * `resume()` continues in the original order. `cancelAll()` aborts every
 * in-flight signal and marks all unfinished jobs cancelled. A failing job is
 * recorded with its error and does not stop the queue.
 */

/** Overall queue state. `done` means the batch is quiescent, not that it succeeded. */
export type BatchQueueState = 'idle' | 'running' | 'paused' | 'done' | 'cancelled';

/** One unit of work: a stable id plus whatever payload the run function needs. */
export interface BatchJob<T> {
  /** Unique within the queue; used by `current`, `retryFailed` and `failures`. */
  id: string;
  /** Caller payload. The queue never inspects it. */
  payload: T;
}

export interface BatchQueueTotals {
  /** Number of distinct jobs ever added; retries never inflate it. */
  jobs: number;
  done: number;
  failed: number;
  cancelled: number;
  /** Unfinished work: waiting jobs plus jobs currently running. */
  pending: number;
}

export interface BatchQueueStatus {
  state: BatchQueueState;
  totals: BatchQueueTotals;
  /** Ids of jobs whose run function is executing right now. */
  current: string[];
}

export type BatchJobState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface BatchQueueJobStatus {
  readonly id: string;
  readonly state: BatchJobState;
  readonly progress: number;
  readonly current: boolean;
  readonly error?: unknown;
}

export interface BatchQueueView {
  readonly status: BatchQueueStatus;
  readonly progress: number;
  readonly jobs: readonly BatchQueueJobStatus[];
}

export type BatchQueueListener = (view: BatchQueueView) => void;

export interface BatchJobFailure {
  id: string;
  error: unknown;
}

export type BatchRun<T> = (job: BatchJob<T>, signal: AbortSignal) => Promise<unknown>;

export interface BatchQueueOptions<T> {
  /** Executes one job. Rejecting records a failure; the queue keeps going. */
  run: BatchRun<T>;
  /** Maximum jobs in flight. Defaults to 2. */
  concurrency?: number;
  /** Called after a job settles and queue state has been updated. */
  onSettled?: () => void;
  /** Called after any state or progress change, for UI-facing consumers. */
  onChanged?: BatchQueueListener;
  /** Receives queue snapshots for shared progress adapters. */
  onProgress?: (status: BatchQueueStatus) => void;
}

type JobStatus = BatchJobState;

interface JobRecord<T> {
  job: BatchJob<T>;
  status: JobStatus;
  /** Set while the job owns a concurrency slot. */
  controller?: AbortController;
  /** Why the job failed; kept for `failures()` and `retryFailed()`. */
  error?: unknown;
}

/** A settle callback has two shapes so a rejection with `undefined` stays a failure. */
type RunOutcome = { ok: true } | { ok: false; error: unknown };

export class BatchQueue<T> {
  private readonly run: BatchRun<T>;
  private readonly concurrency: number;
  private readonly onSettled?: () => void;
  private readonly onChanged?: BatchQueueListener;
  private readonly onProgress?: (status: BatchQueueStatus) => void;
  /** Every job ever added, in add order. Retries reuse these records. */
  private readonly records = new Map<string, JobRecord<T>>();
  /** Ids ready to start, in launch order. */
  private readonly waiting: string[] = [];
  /** Ids holding a concurrency slot, in launch order. */
  private readonly active = new Set<string>();
  private readonly progressById = new Map<string, number>();
  private readonly listeners = new Set<BatchQueueListener>();
  private paused = false;
  /** True while a batch is allowed to launch jobs. Reset when the batch drains. */
  private started = false;
  private cancelled = false;

  constructor(options: BatchQueueOptions<T>) {
    this.run = options.run;
    this.onSettled = options.onSettled;
    this.onChanged = options.onChanged;
    this.onProgress = options.onProgress;
    const concurrency = options.concurrency ?? 2;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Concurrency must be a positive integer.');
    }
    this.concurrency = concurrency;
  }

  /**
   * Queues a job. It starts on the next `start()` (or immediately when the
   * batch is already running and a slot is free). Ids are unique for the life
   * of the queue so `jobs` stays a document count, not an attempt count.
   */
  add(job: BatchJob<T>): void {
    if (typeof job.id !== 'string' || job.id.length === 0) {
      throw new Error('A batch job needs a non-empty id.');
    }
    if (this.records.has(job.id)) {
      throw new Error(`Job "${job.id}" is already in the queue.`);
    }
    this.records.set(job.id, { job, status: 'pending' });
    this.progressById.set(job.id, 0);
    this.waiting.push(job.id);
    this.pump();
    this.notify();
  }

  /**
   * Starts the batch. A no-op when nothing is waiting, so calling it on an
   * empty (or already finished) queue cannot churn the reported state.
   */
  start(): void {
    if (this.waiting.length === 0) return;
    this.cancelled = false;
    this.started = true;
    this.pump();
    this.notify();
  }

  /** Stops launching new jobs; runs already in flight are left to finish. */
  pause(): void {
    this.paused = true;
    this.notify();
  }

  /** Continues a paused batch in the original order. */
  resume(): void {
    this.paused = false;
    this.pump();
    this.notify();
  }
  /**
   * Aborts every in-flight signal and marks every unfinished job cancelled.
   * Slots stay held by aborted runs until they actually settle, so a restart
   * can never exceed `concurrency`.
   */
  cancelAll(): void {
    this.cancelled = true;
    this.started = false;
    for (const id of this.waiting.splice(0)) {
      const record = this.records.get(id);
      if (record && record.status === 'pending') {
        record.status = 'cancelled';
        this.progressById.set(id, 100);
      }
    }
    for (const id of this.active) {
      const record = this.records.get(id);
      if (!record) continue;
      // Mark first: a run that rejects with an AbortError must not be counted
      // as a failure when the user cancelled the batch.
      if (record.status === 'running') {
        record.status = 'cancelled';
        this.progressById.set(id, 100);
      }
      record.controller?.abort();
    }
    this.notify();
  }

  /** A fresh snapshot. The returned object is never mutated in place. */
  status(): BatchQueueStatus {
    const totals = this.count();
    return { state: this.stateOf(totals), totals, current: this.currentIds() };
  }

  /** A UI-safe view with per-job state and progress. */
  view(): BatchQueueView {
    return { status: this.status(), progress: this.progress(), jobs: this.jobStatuses() };
  }

  /** Per-job state in original add order. */
  jobStatuses(): readonly BatchQueueJobStatus[] {
    return [...this.records].map(([id, record]) => ({
      id,
      state: record.status,
      progress: this.progressById.get(id) ?? 0,
      current: record.status === 'running',
      ...(record.error === undefined ? {} : { error: record.error }),
    }));
  }

  /** Update one job's stage-local progress without changing settlement totals. */
  setProgress(id: string, value: number): void {
    const record = this.records.get(id);
    if (!record) throw new Error(`Job "${id}" does not exist.`);
    if (!Number.isFinite(value)) throw new Error('Progress must be finite.');
    this.progressById.set(id, Math.max(0, Math.min(100, Math.floor(value))));
    this.notify();
  }

  /** Subscribe to state changes. The returned function removes the listener. */
  subscribe(listener: BatchQueueListener, emitCurrent = true): () => void {
    if (typeof listener !== 'function') throw new TypeError('Queue listener must be a function.');
    this.listeners.add(listener);
    if (emitCurrent) listener(this.view());
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Settled jobs as an integer percentage, never rounded up: 100 is reserved
   * for "every job has settled". Failed and cancelled jobs are settled, so the
   * bar completes when the batch is over rather than stalling at 80%.
   */
  progress(): number {
    const totals = this.count();
    if (totals.jobs === 0) return 0;
    const settled = totals.done + totals.failed + totals.cancelled;
    return Math.min(100, Math.floor((settled / totals.jobs) * 100));
  }

  /**
   * Re-enqueues jobs that failed, in their original order, with a clean status.
   * Only enqueues: call `start()` to run them. Returns the retried ids.
   */
  retryFailed(): string[] {
    const retried: string[] = [];
    for (const [id, record] of this.records) {
      if (record.status !== 'failed') continue;
      record.status = 'pending';
      delete record.error;
      this.progressById.set(id, 0);
      this.waiting.push(id);
      retried.push(id);
    }
    if (retried.length > 0) this.notify();
    return retried;
  }

  /** Failed jobs with the error each one was rejected with, in add order. */
  failures(): BatchJobFailure[] {
    const failures: BatchJobFailure[] = [];
    for (const [id, record] of this.records) {
      if (record.status === 'failed') failures.push({ id, error: record.error });
    }
    return failures;
  }

  /**
   * Jobs reported as running. An aborted run keeps its slot until it settles,
   * but it is already cancelled, so listing it as current would contradict the
   * totals the same snapshot shows.
   */
  private currentIds(): string[] {
    const ids: string[] = [];
    for (const id of this.active) {
      if (this.records.get(id)?.status === 'running') ids.push(id);
    }
    return ids;
  }

  private count(): BatchQueueTotals {
    let done = 0;
    let failed = 0;
    let cancelled = 0;
    let pending = 0;
    for (const record of this.records.values()) {
      switch (record.status) {
        case 'done':
          done += 1;
          break;
        case 'failed':
          failed += 1;
          break;
        case 'cancelled':
          cancelled += 1;
          break;
        // `running` is unfinished work, so it shares the pending bucket and the
        // four counters keep adding up to `jobs`.
        default:
          pending += 1;
      }
    }
    return { jobs: this.records.size, done, failed, cancelled, pending };
  }

  private stateOf(totals: BatchQueueTotals): BatchQueueState {
    if (totals.pending === 0) {
      if (this.cancelled) return 'cancelled';
      // `done` reports that the batch is over; `failed` in the totals tells
      // whether it went well, so the state never claims success.
      return totals.jobs === 0 ? 'idle' : 'done';
    }
    if (this.cancelled) return 'cancelled';
    // A pre-armed pause is reported even before `start()`: it explains why
    // nothing is launching, which is what the user asked for.
    if (this.paused) return 'paused';
    return this.started ? 'running' : 'idle';
  }

  private pump(): void {
    if (!this.started || this.paused || this.cancelled) return;
    while (this.waiting.length > 0 && this.active.size < this.concurrency) {
      const id = this.waiting.shift();
      if (id === undefined) break;
      const record = this.records.get(id);
      if (!record || record.status !== 'pending') continue;
      const controller = new AbortController();
      record.status = 'running';
      record.controller = controller;
      this.active.add(id);
      // Resolved in a microtask so `start()` returns before any run body runs,
      // which keeps the status readable at a stable point.
      void Promise.resolve()
        .then(() => this.run(record.job, controller.signal))
        .then(
          () => this.settle(id, { ok: true }),
          (error: unknown) => this.settle(id, { ok: false, error }),
        );
    }
  }

  private settle(id: string, outcome: RunOutcome): void {
    const record = this.records.get(id);
    this.active.delete(id);
    if (record) {
      delete record.controller;
      // Only a still-running job may change status. A cancelled job keeps its
      // cancelled status, and its late answer is dropped.
      if (record.status === 'running') {
        if (outcome.ok) {
          record.status = 'done';
          this.progressById.set(id, 100);
        } else {
          record.status = 'failed';
          record.error = outcome.error;
          this.progressById.set(id, 100);
        }
      }
    }
    // The batch is over once nothing waits and no slot is held: the next
    // `add()` needs an explicit `start()` instead of resuming silently.
    if (this.waiting.length === 0 && this.active.size === 0) this.started = false;
    this.pump();
    this.notify();
    this.onSettled?.();
  }

  private notify(): void {
    const view = this.view();
    this.onChanged?.(view);
    this.onProgress?.(view.status);
    for (const listener of this.listeners) listener(view);
  }
}
