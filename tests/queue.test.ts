import { describe, expect, it } from 'vitest';
import { BatchQueue, type BatchJob } from '../src/core/queue';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Flushes every pending microtask, so a launch or a settle becomes observable. */
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** Waits until nothing is left unfinished. */
async function waitForSettled(queue: BatchQueue<string>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (queue.status().totals.pending === 0) return;
    await tick();
  }
  throw new Error('The batch queue did not settle in time.');
}

function releaseGate(gates: Map<string, Deferred>, id: string): void {
  const gate = gates.get(id);
  if (!gate) throw new Error(`No gate for job "${id}".`);
  gate.resolve();
}

function failGate(gates: Map<string, Deferred>, id: string, error: Error): void {
  const gate = gates.get(id);
  if (!gate) throw new Error(`No gate for job "${id}".`);
  gate.reject(error);
}

const job = (id: string): BatchJob<string> => ({ id, payload: `payload-${id}` });

/** The invariant a UI depends on: the four counters always account for every job. */
function expectTotalsAddUp(queue: BatchQueue<string>): void {
  const { jobs, done, failed, cancelled, pending } = queue.status().totals;
  expect(done + failed + cancelled + pending).toBe(jobs);
}

describe('batch queue', () => {
  it('runs jobs in order with at most the requested concurrency in flight', async () => {
    const gates = new Map<string, Deferred>();
    const started: string[] = [];
    const finished: string[] = [];
    const signals = new Map<string, AbortSignal>();
    let inFlight = 0;
    let maxInFlight = 0;

    const queue = new BatchQueue<string>({
      concurrency: 2,
      run: async (current: BatchJob<string>, signal: AbortSignal) => {
        signals.set(current.id, signal);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started.push(current.id);
        const gate = deferred();
        gates.set(current.id, gate);
        try {
          await gate.promise;
        } finally {
          inFlight -= 1;
          finished.push(current.id);
        }
      },
    });

    const ids = ['a', 'b', 'c', 'd', 'e'];
    for (const id of ids) queue.add(job(id));
    queue.start();
    await tick();

    expect(started).toEqual(['a', 'b']);

    const snapshot = queue.status();
    console.log(`mid-run status: ${JSON.stringify(snapshot)}`);
    expect(snapshot).toEqual({
      state: 'running',
      totals: { jobs: 5, done: 0, failed: 0, cancelled: 0, pending: 5 },
      current: ['a', 'b'],
    });
    expect(queue.progress()).toBe(0);
    expectTotalsAddUp(queue);

    releaseGate(gates, 'a');
    await tick();
    expect(started).toEqual(['a', 'b', 'c']);
    expect(queue.status().current).toEqual(['b', 'c']);
    expect(queue.status().totals.done).toBe(1);

    releaseGate(gates, 'b');
    await tick();
    expect(started).toEqual(['a', 'b', 'c', 'd']);

    releaseGate(gates, 'c');
    await tick();
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e']);

    releaseGate(gates, 'd');
    await tick();
    releaseGate(gates, 'e');
    await waitForSettled(queue);

    expect(started).toEqual(ids);
    expect(finished).toEqual(ids);
    expect(maxInFlight).toBe(2);
    expect(signals.get('a')?.aborted).toBe(false);
    expect(queue.status()).toEqual({
      state: 'done',
      totals: { jobs: 5, done: 5, failed: 0, cancelled: 0, pending: 0 },
      current: [],
    });
    expect(queue.progress()).toBe(100);
  });

  it('pause lets the in-flight job finish and resume continues in the original order', async () => {
    const gates = new Map<string, Deferred>();
    const started: string[] = [];
    const queue = new BatchQueue<string>({
      concurrency: 1,
      run: async (current: BatchJob<string>) => {
        started.push(current.id);
        const gate = deferred();
        gates.set(current.id, gate);
        await gate.promise;
      },
    });

    for (const id of ['a', 'b', 'c']) queue.add(job(id));
    queue.start();
    await tick();
    expect(started).toEqual(['a']);

    queue.pause();
    expect(queue.status().state).toBe('paused');

    // The job already running is not interrupted; the queued ones must not start.
    releaseGate(gates, 'a');
    await tick();
    expect(started).toEqual(['a']);
    expect(queue.status()).toEqual({
      state: 'paused',
      totals: { jobs: 3, done: 1, failed: 0, cancelled: 0, pending: 2 },
      current: [],
    });

    queue.resume();
    await tick();
    expect(started).toEqual(['a', 'b']);
    expect(queue.status().state).toBe('running');

    releaseGate(gates, 'b');
    await tick();
    releaseGate(gates, 'c');
    await waitForSettled(queue);

    expect(started).toEqual(['a', 'b', 'c']);
    expect(queue.status().state).toBe('done');
    expectTotalsAddUp(queue);
  });

  it('cancels in-flight signals and marks every remaining job cancelled', async () => {
    const started: string[] = [];
    const signals = new Map<string, AbortSignal>();
    const queue = new BatchQueue<string>({
      concurrency: 1,
      // Never settles on its own: only the abort signal can end this job.
      run: (current: BatchJob<string>, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          started.push(current.id);
          signals.set(current.id, signal);
          signal.addEventListener('abort', () => reject(new Error('aborted by cancelAll')), { once: true });
        }),
    });

    for (const id of ['a', 'b', 'c']) queue.add(job(id));
    queue.start();
    await tick();
    expect(started).toEqual(['a']);

    queue.cancelAll();
    expect(signals.get('a')?.aborted).toBe(true);

    const cancelled = queue.status();
    console.log(`cancelled status: ${JSON.stringify(cancelled)}`);
    expect(cancelled).toEqual({
      state: 'cancelled',
      totals: { jobs: 3, done: 0, failed: 0, cancelled: 3, pending: 0 },
      current: [],
    });

    // The aborted run rejects with an ordinary Error; that must not be recorded
    // as a failure, and the queued jobs must never start.
    await tick();
    expect(started).toEqual(['a']);
    expect(queue.failures()).toEqual([]);
    expect(queue.status()).toEqual(cancelled);
    expect(queue.progress()).toBe(100);
    expectTotalsAddUp(queue);
  });

  it('records a failing job with its error and keeps the queue going', async () => {
    const ran: string[] = [];
    const queue = new BatchQueue<string>({
      concurrency: 2,
      run: async (current: BatchJob<string>) => {
        ran.push(current.id);
        if (current.id === 'b') throw new Error('boom');
      },
    });

    for (const id of ['a', 'b', 'c', 'd', 'e']) queue.add(job(id));
    queue.start();
    await waitForSettled(queue);

    expect(ran).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(queue.status()).toEqual({
      state: 'done',
      totals: { jobs: 5, done: 4, failed: 1, cancelled: 0, pending: 0 },
      current: [],
    });

    const failures = queue.failures();
    expect(failures.map(failure => failure.id)).toEqual(['b']);
    expect(failures[0]?.error).toBeInstanceOf(Error);
    const error = failures[0]?.error;
    expect((error as Error).message).toBe('boom');
    // A failure is settled work: the bar still finishes.
    expect(queue.progress()).toBe(100);
    expectTotalsAddUp(queue);
  });

  it('reports progress from settled work and reaches exactly 100', async () => {
    const gates = new Map<string, Deferred>();
    const queue = new BatchQueue<string>({
      concurrency: 2,
      run: async (current: BatchJob<string>) => {
        const gate = deferred();
        gates.set(current.id, gate);
        await gate.promise;
      },
    });

    for (const id of ['a', 'b', 'c']) queue.add(job(id));
    expect(queue.progress()).toBe(0);

    queue.start();
    await tick();
    expect(queue.progress()).toBe(0);
    expect(Number.isInteger(queue.progress())).toBe(true);

    releaseGate(gates, 'a');
    await tick();
    // Floored, never rounded: 1 of 3 must not read as 34 while 2 more are open.
    expect(queue.progress()).toBe(33);

    releaseGate(gates, 'b');
    await tick();
    expect(queue.progress()).toBe(66);
    expect(queue.progress()).toBeLessThan(100);

    releaseGate(gates, 'c');
    await waitForSettled(queue);
    expect(queue.progress()).toBe(100);
  });

  it('retryFailed re-enqueues only the failed jobs, once', async () => {
    const attempts = new Map<string, number>();
    const successes: string[] = [];
    const queue = new BatchQueue<string>({
      concurrency: 2,
      run: async (current: BatchJob<string>) => {
        const attempt = (attempts.get(current.id) ?? 0) + 1;
        attempts.set(current.id, attempt);
        if ((current.id === 'b' || current.id === 'd') && attempt === 1) {
          throw new Error(`transient ${current.id}`);
        }
        successes.push(`${current.id}#${attempt}`);
      },
    });

    for (const id of ['a', 'b', 'c', 'd', 'e']) queue.add(job(id));
    queue.start();
    await waitForSettled(queue);

    expect(queue.status().totals).toEqual({ jobs: 5, done: 3, failed: 2, cancelled: 0, pending: 0 });
    expect(queue.failures().map(failure => failure.id)).toEqual(['b', 'd']);
    expect(queue.progress()).toBe(100);

    // Original order, and the same job records: retries never inflate `jobs`.
    expect(queue.retryFailed()).toEqual(['b', 'd']);
    expect(queue.failures()).toEqual([]);
    expect(queue.status()).toEqual({
      state: 'idle',
      totals: { jobs: 5, done: 3, failed: 0, cancelled: 0, pending: 2 },
      current: [],
    });
    expect(queue.progress()).toBe(60);
    expectTotalsAddUp(queue);

    queue.start();
    await waitForSettled(queue);

    expect(queue.status().totals).toEqual({ jobs: 5, done: 5, failed: 0, cancelled: 0, pending: 0 });
    expect(successes).toEqual(['a#1', 'c#1', 'e#1', 'b#2', 'd#2']);
    expect(queue.retryFailed()).toEqual([]);
    expect(queue.progress()).toBe(100);
  });

  it('start on an empty queue is a no-op', async () => {
    const runs: string[] = [];
    const queue = new BatchQueue<string>({ run: async (current: BatchJob<string>) => { runs.push(current.id); } });

    queue.start();
    expect(queue.status()).toEqual({
      state: 'idle',
      totals: { jobs: 0, done: 0, failed: 0, cancelled: 0, pending: 0 },
      current: [],
    });
    expect(queue.progress()).toBe(0);

    queue.add(job('a'));
    queue.start();
    await waitForSettled(queue);
    const finished = queue.status();
    expect(finished.totals.done).toBe(1);

    // Nothing waiting: start must not resurrect the batch or change the report.
    queue.start();
    await tick();
    expect(queue.status()).toEqual(finished);
    expect(runs).toEqual(['a']);
  });

  it('status totals always add up to the job count', async () => {
    const gates = new Map<string, Deferred>();
    const started: string[] = [];
    const queue = new BatchQueue<string>({
      concurrency: 1,
      run: (current: BatchJob<string>, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
          started.push(current.id);
          const gate = deferred();
          gates.set(current.id, gate);
          const onAbort = (): void => reject(new Error('aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
          void gate.promise.then(
            () => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            },
            (error: unknown) => {
              signal.removeEventListener('abort', onAbort);
              reject(error);
            },
          );
        }),
    });

    for (const id of ['a', 'b', 'c', 'd']) queue.add(job(id));
    expectTotalsAddUp(queue);
    expect(queue.status().totals).toEqual({ jobs: 4, done: 0, failed: 0, cancelled: 0, pending: 4 });

    queue.start();
    await tick();
    expect(queue.status().current).toEqual(['a']);
    expectTotalsAddUp(queue);

    releaseGate(gates, 'a');
    await tick();
    expect(queue.status().totals).toEqual({ jobs: 4, done: 1, failed: 0, cancelled: 0, pending: 3 });
    expectTotalsAddUp(queue);

    failGate(gates, 'b', new Error('boom'));
    await tick();
    expect(queue.status().totals).toEqual({ jobs: 4, done: 1, failed: 1, cancelled: 0, pending: 2 });
    expect(queue.status().current).toEqual(['c']);
    expectTotalsAddUp(queue);

    queue.cancelAll();
    expect(queue.status()).toEqual({
      state: 'cancelled',
      totals: { jobs: 4, done: 1, failed: 1, cancelled: 2, pending: 0 },
      current: [],
    });
    expectTotalsAddUp(queue);

    // The aborted run settles later; nothing may be double counted.
    await tick();
    expectTotalsAddUp(queue);
    expect(queue.status().totals).toEqual({ jobs: 4, done: 1, failed: 1, cancelled: 2, pending: 0 });
    expect(queue.progress()).toBe(100);
  });

  it('rejects duplicate and empty job ids', () => {
    const queue = new BatchQueue<string>({ run: async () => undefined });
    expect(() => queue.add({ id: '', payload: 'x' })).toThrow(/non-empty id/);

    queue.add(job('a'));
    expect(() => queue.add(job('a'))).toThrow(/already in the queue/);
    expect(queue.status().totals).toEqual({ jobs: 1, done: 0, failed: 0, cancelled: 0, pending: 1 });
  });

  it('refuses an invalid concurrency', () => {
    expect(() => new BatchQueue<string>({ run: async () => undefined, concurrency: 0 })).toThrow(/positive integer/);
    expect(() => new BatchQueue<string>({ run: async () => undefined, concurrency: 1.5 })).toThrow(/positive integer/);
  });
});

describe('queue progress callbacks', () => {
  it('exposes per-job progress and change notifications without changing settlement totals', async () => {
    const changes: number[] = [];
    const queue = new BatchQueue<string>({
      run: async current => {
        queue.setProgress(current.id, 42);
      },
      onChanged: view => changes.push(view.progress),
    });
    queue.add(job('view'));
    queue.start();
    await waitForSettled(queue);
    expect(queue.view().jobs).toEqual([{ id: 'view', state: 'done', progress: 100, current: false }]);
    expect(queue.view().progress).toBe(100);
    expect(changes.length).toBeGreaterThan(0);
  });

  it('publishes state transitions without weakening settlement semantics', async () => {
    const snapshots: string[] = [];
    const queue = new BatchQueue<string>({
      onProgress: status => snapshots.push(`${status.state}:${status.totals.done}/${status.totals.jobs}`),
      run: async () => undefined,
    });
    queue.add(job('a'));
    queue.start();
    await waitForSettled(queue);
    expect(snapshots).toContain('running:0/1');
    expect(snapshots.at(-1)).toBe('done:1/1');
  });
});
