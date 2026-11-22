/**
 * Priority scheduler with deduplication and real cancellation.
 *
 * Every job owns an `AbortController`. Aborting a queued job removes it before
 * `drain` can start it, so cancelled work never reaches a provider. Aborting an
 * in-flight job rejects its promise immediately with an `AbortError` and fires
 * the signal the run function was given, which is how a provider request is
 * cancelled at its source instead of merely being ignored afterwards.
 */

/**
 * The promise returned by {@link ViewportScheduler.enqueue}. It stays a plain
 * thenable, so existing `await queue.enqueue(...)` call sites keep working,
 * while the caller can also reach the job's signal.
 */
export type JobHandle<T> = Promise<T> & {
  /** Cancels the job: queued work never starts, in-flight work rejects now. */
  abort(reason?: unknown): void;
  /** Signal handed to the job's run function. */
  readonly signal: AbortSignal;
  /** Controller behind {@link JobHandle.signal}; aborting it is equivalent. */
  readonly controller: AbortController;
};

/** Kept stable because callers surface this message after a document change. */
export const SUPERSEDED_MESSAGE = 'Translation work was superseded by a new document.';

function abortFailure(message: string, reason?: unknown): Error {
  const error = new Error(message, reason === undefined ? undefined : { cause: reason });
  // `isAbortError` in ./retry recognises this name, so cancellation stays
  // distinguishable from a provider failure without a second error class.
  error.name = 'AbortError';
  return error;
}

/** The failure a cancelled job rejects with. */
export function jobAbortError(reason?: unknown): Error {
  return abortFailure('Scheduled work was aborted.', reason);
}

interface Job<T> {
  key: string;
  priority: number;
  run: (signal: AbortSignal) => Promise<T>;
  controller: AbortController;
  handle: JobHandle<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  /** True once the promise settled, whether by completion or by cancellation. */
  settled: boolean;
}

function handleFor<T>(promise: Promise<T>, controller: AbortController): JobHandle<T> {
  return Object.assign(promise, {
    signal: controller.signal,
    controller,
    abort: (reason?: unknown): void => {
      if (!controller.signal.aborted) controller.abort(reason);
    },
  });
}

export class ViewportScheduler<T> {
  private queue: Job<T>[] = [];
  private readonly jobs = new Map<string, Job<T>>();
  private readonly active = new Set<Job<T>>();
  private paused = false;

  constructor(private readonly concurrency = 2) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be positive.');
  }

  enqueue(key: string, priority: number, run: (signal: AbortSignal) => Promise<T>): JobHandle<T> {
    const existing = this.jobs.get(key);
    if (existing) {
      existing.priority = Math.min(priority, existing.priority);
      this.sort();
      return existing.handle;
    }
    const controller = new AbortController();
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    const job: Job<T> = {
      key,
      priority,
      run,
      controller,
      handle: handleFor(promise, controller),
      resolve,
      reject,
      settled: false,
    };
    controller.signal.addEventListener('abort', () => {
      // A replaced job keeps the same key, so only the current entry may cancel.
      if (this.jobs.get(key) !== job) return;
      this.cancel(job, jobAbortError(controller.signal.reason));
    }, { once: true });
    this.jobs.set(key, job);
    this.queue.push(job);
    this.sort();
    queueMicrotask(() => this.drain());
    return job.handle;
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.drain(); }

  /** Cancels everything for a document or profile change. */
  reset(): void {
    this.cancelAll(() => abortFailure(SUPERSEDED_MESSAGE));
  }

  /**
   * Cancels every job, queued or in flight. Runs already executing keep their
   * concurrency slot until they actually settle, so a teardown never doubles
   * the load on the provider.
   */
  abortAll(reason?: unknown): void {
    this.cancelAll(() => jobAbortError(reason));
  }

  get pending(): number { return this.queue.length + this.active.size; }

  private sort(): void { this.queue.sort((a, b) => a.priority - b.priority); }

  private drain(): void {
    while (!this.paused && this.active.size < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.settled) continue;
      this.active.add(job);
      Promise.resolve()
        .then(() => job.run(job.controller.signal))
        .then(
          value => this.complete(job, { value }),
          error => this.complete(job, { error }),
        );
    }
  }

  /**
   * Keeps the promise settled by {@link cancel} when the run finishes anyway:
   * the slot is freed and the late provider answer is dropped on the floor.
   */
  private complete(job: Job<T>, result: { value: T } | { error: unknown }): void {
    this.active.delete(job);
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    if (!job.settled) {
      job.settled = true;
      if ('error' in result) job.reject(result.error);
      else job.resolve(result.value);
    }
    this.drain();
  }

  private cancel(job: Job<T>, failure: Error): void {
    if (job.settled) return;
    job.settled = true;
    const position = this.queue.indexOf(job);
    if (position >= 0) this.queue.splice(position, 1);
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    job.reject(failure);
    // A queued job just freed its slot; an active one still occupies it until
    // `complete` sees the run settle.
    if (position >= 0) this.drain();
  }

  private cancelAll(failure: () => Error): void {
    const reason = failure();
    for (const job of [...this.jobs.values()]) {
      if (job.settled) continue;
      job.settled = true;
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      // Marking the job settled first keeps the abort listener from rejecting
      // it with the generic abort message instead of the caller's message.
      if (!job.controller.signal.aborted) job.controller.abort(reason);
      job.reject(failure());
    }
    this.queue = [];
    if (!this.paused) this.drain();
  }
}
