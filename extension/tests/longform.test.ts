import { describe, expect, it } from 'vitest';
import {
  CheckpointStore,
  DEFAULT_CHUNK_CHARS,
  DEFAULT_CHUNK_PAGES,
  planChunks,
  runPlan,
  type CheckpointToken,
  type Chunk,
  type ChunkCheckpoints,
  type ChunkRunner,
  type PlanPageInput,
} from '../viewer/src/core/longform';

/** Pages with a fixed character cost, numbered the way the document IR numbers them. */
function pages(count: number, chars: number): PlanPageInput[] {
  return Array.from({ length: count }, (_, position) => ({ index: position + 1, chars }));
}

/** Hand-built chunks for the runner tests; the planner is tested separately. */
function chunks(count: number): Chunk[] {
  return Array.from({ length: count }, (_, position) => ({
    index: position,
    pages: [position + 1],
    chars: 10,
    oversized: false,
  }));
}

function chunkIndexes(chunksInPlan: readonly Chunk[]): number[] {
  return chunksInPlan.map(chunk => chunk.index);
}

function pageIndexes(chunksInPlan: readonly Chunk[]): number[] {
  return chunksInPlan.flatMap(chunk => chunk.pages);
}

describe('long-form chunk planning', () => {
  it('groups 500 pages without splitting one or reordering them', () => {
    const plan = planChunks(pages(500, 1000));

    expect(DEFAULT_CHUNK_CHARS).toBe(12000);
    expect(DEFAULT_CHUNK_PAGES).toBe(25);
    expect(plan.total).toBe(500);
    expect(plan.totalChars).toBe(500_000);

    for (const chunk of plan.chunks) {
      expect(chunk.pages.length).toBeGreaterThan(0);
      expect(chunk.pages.length).toBeLessThanOrEqual(DEFAULT_CHUNK_PAGES);
      expect(chunk.chars).toBeLessThanOrEqual(DEFAULT_CHUNK_CHARS);
      expect(chunk.oversized).toBe(false);
    }
    // The character budget binds first at 1000 characters per page: 12 pages a chunk.
    expect(plan.chunks).toHaveLength(Math.ceil(500 / 12));
    expect(plan.chunks.every((chunk, position) => chunk.index === position)).toBe(true);
    expect(pageIndexes(plan.chunks)).toEqual(pages(500, 0).map(page => page.index));
  });

  it('respects the page cap when characters are not the limit', () => {
    const plan = planChunks(pages(100, 10), { maxChars: 100000 });

    expect(plan.chunks).toHaveLength(4);
    for (const chunk of plan.chunks) {
      expect(chunk.pages).toHaveLength(25);
      expect(chunk.chars).toBe(250);
    }
    expect(pageIndexes(plan.chunks)).toHaveLength(100);
  });

  it('keeps every page of a real document exactly once under both budgets', () => {
    const plan = planChunks(pages(500, 1000), { maxChars: 12000, maxPages: 25 });
    const seen = pageIndexes(plan.chunks);

    expect(seen).toHaveLength(500);
    expect(new Set(seen).size).toBe(500);
    expect([...seen].sort((left, right) => left - right)).toEqual(pages(500, 0).map(page => page.index));
  });

  it('carries an over-budget page alone and flags it instead of splitting it', () => {
    const plan = planChunks(
      [
        { index: 1, chars: 100 },
        { index: 2, chars: 20000 },
        { index: 3, chars: 100 },
      ],
      { maxChars: 1000 },
    );

    expect(plan.chunks).toHaveLength(3);
    expect(plan.chunks[0]).toEqual({ index: 0, pages: [1], chars: 100, oversized: false });
    expect(plan.chunks[1]).toEqual({ index: 1, pages: [2], chars: 20000, oversized: true });
    // The oversized page must not swallow the page after it.
    expect(plan.chunks[2]).toEqual({ index: 2, pages: [3], chars: 100, oversized: false });
    expect(plan.total).toBe(3);
    expect(plan.totalChars).toBe(20200);
  });

  it('treats a page exactly at the budget as fitting and one character over as oversized', () => {
    const fits = planChunks([{ index: 1, chars: 1000 }], { maxChars: 1000 });
    const over = planChunks([{ index: 1, chars: 1001 }], { maxChars: 1000 });

    expect(fits.chunks[0]?.oversized).toBe(false);
    expect(fits.chunks[0]?.chars).toBe(1000);
    expect(over.chunks).toHaveLength(1);
    expect(over.chunks[0]?.oversized).toBe(true);
  });

  it('measures text in code points, not UTF-16 units', () => {
    const plan = planChunks([{ index: 1, text: 'a\u{1F600}b' }], { maxChars: 3 });

    expect(plan.totalChars).toBe(3);
    expect(plan.chunks[0]?.oversized).toBe(false);
    // Four UTF-16 units would have been over budget; three code points are not.
    expect(planChunks([{ index: 1, text: 'a\u{1F600}b' }], { maxChars: 2 }).chunks[0]?.oversized).toBe(true);
  });

  it('counts zero-character pages without creating empty chunks', () => {
    const plan = planChunks(pages(3, 0), { maxChars: 10 });

    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]?.pages).toEqual([1, 2, 3]);
    expect(plan.chunks[0]?.chars).toBe(0);
  });

  it('plans an empty document as empty work', () => {
    expect(planChunks([])).toEqual({ chunks: [], total: 0, totalChars: 0 });
  });

  it('refuses pages it cannot cost, split or repeat', () => {
    expect(() => planChunks(undefined as unknown as PlanPageInput[])).toThrow(/array of pages/);
    expect(() => planChunks([null as unknown as PlanPageInput])).toThrow(/must be an object/);
    expect(() => planChunks([{ index: 1 }])).toThrow(/neither chars nor text/);
    expect(() => planChunks([{ index: 0, chars: 10 }])).toThrow(/1-based/);
    expect(() => planChunks([{ index: 1.5, chars: 10 }])).toThrow(/1-based/);
    expect(() => planChunks([{ index: 1, chars: -1 }])).toThrow(/non-negative integer/);
    expect(() => planChunks([{ index: 1, chars: 1.5 }])).toThrow(/non-negative integer/);
    expect(() => planChunks([{ index: 1, chars: 10 }, { index: 1, chars: 10 }])).toThrow(/more than once/);
    expect(() => planChunks([], { maxChars: 0 })).toThrow(/maxChars must be a positive integer/);
    expect(() => planChunks([], { maxPages: 0 })).toThrow(/maxPages must be a positive integer/);
    expect(() => planChunks([], { maxPages: 1.5 })).toThrow(/maxPages must be a positive integer/);
  });
});

describe('checkpoint store', () => {
  it('records done chunks, in order, and reports what is left', async () => {
    const store = new CheckpointStore<string>({ total: 3 });
    expect(store.pending()).toEqual([0, 1, 2]);
    expect(store.done()).toEqual([]);
    expect(store.stats()).toEqual({ total: 3, done: 0, pending: 3, resumed: 0 });

    await store.markDone(0, 'a');
    await store.markDone(2, 'c');

    expect(store.done()).toEqual([0, 2]);
    expect(store.pending()).toEqual([1]);
    expect(store.result(2)).toBe('c');
    expect(store.result(1)).toBeUndefined();
    expect(store.tokens()).toEqual([
      { chunkIndex: 0, result: 'a' },
      { chunkIndex: 2, result: 'c' },
    ]);
    expect(store.stats()).toEqual({ total: 3, done: 2, pending: 1, resumed: 0 });
  });

  it('persists each chunk once and only after it is durable', async () => {
    const written: CheckpointToken<string>[] = [];
    let durable = false;
    const store = new CheckpointStore<string>({
      total: 2,
      persist: async token => {
        await Promise.resolve();
        durable = true;
        written.push({ ...token });
      },
    });

    const outcome = await store.markDone(0, 'a');
    expect(durable).toBe(true);
    expect(outcome).toEqual({ status: 'done', chunkIndex: 0 });
    expect(written).toEqual([{ chunkIndex: 0, result: 'a' }]);
  });

  it('keeps the first result when markDone repeats and says already-done', async () => {
    const written: CheckpointToken<string>[] = [];
    const store = new CheckpointStore<string>({
      total: 2,
      persist: token => {
        // The store must hand out a fresh token: mutating it cannot corrupt state.
        token.result = `${token.result}!`;
        written.push({ chunkIndex: token.chunkIndex, result: token.result });
      },
    });

    const first = await store.markDone(0, 'a');
    const second = await store.markDone(0, 'b');

    expect(first).toEqual({ status: 'done', chunkIndex: 0 });
    expect(second).toEqual({ status: 'already-done', chunkIndex: 0 });
    expect(written).toHaveLength(1);
    expect(store.result(0)).toBe('a');
    expect(store.stats().done).toBe(1);
  });

  it('leaves a chunk pending when persist rejects, and lets a retry claim it', async () => {
    let attempts = 0;
    const store = new CheckpointStore<string>({
      total: 2,
      persist: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('disk full');
      },
    });

    await expect(store.markDone(0, 'a')).rejects.toThrow('disk full');
    expect(store.done()).toEqual([]);
    expect(store.pending()).toEqual([0, 1]);
    expect(store.stats()).toEqual({ total: 2, done: 0, pending: 2, resumed: 0 });

    await store.markDone(0, 'a');
    expect(store.done()).toEqual([0]);
  });

  it('adopts persisted tokens on resume without writing them again', () => {
    const written: CheckpointToken<string>[] = [];
    const store = new CheckpointStore<string>({ total: 3, persist: token => { written.push(token); } });

    const outcome = store.resume([{ chunkIndex: 1, result: 'b' }]);

    expect(outcome).toEqual({ adopted: 1, duplicates: 0, ignored: 0 });
    expect(store.done()).toEqual([1]);
    expect(store.pending()).toEqual([0, 2]);
    expect(store.result(1)).toBe('b');
    expect(store.stats()).toEqual({ total: 3, done: 1, pending: 2, resumed: 1 });
    expect(written).toEqual([]);
  });

  it('counts duplicate and unusable tokens instead of corrupting the plan', () => {
    const store = new CheckpointStore<string>({ total: 2 });
    store.resume([{ chunkIndex: 0, result: 'a' }]);

    const outcome = store.resume([
      { chunkIndex: 0, result: 'z' },
      { chunkIndex: 2, result: 'outside the plan' },
      { chunkIndex: -1, result: 'negative' },
      { chunkIndex: 1.5, result: 'fractional' },
      {} as unknown as CheckpointToken<string>,
    ]);

    expect(outcome).toEqual({ adopted: 0, duplicates: 1, ignored: 4 });
    expect(store.result(0)).toBe('a');
    expect(store.done()).toEqual([0]);
    expect(store.stats().resumed).toBe(1);
  });

  it('restores from the injected loader on demand only', async () => {
    const tokens: CheckpointToken<string>[] = [
      { chunkIndex: 0, result: 'a' },
      { chunkIndex: 1, result: 'b' },
    ];
    let loads = 0;
    const store = new CheckpointStore<string>({
      total: 3,
      load: async () => {
        loads += 1;
        return tokens;
      },
    });

    expect(loads).toBe(0);
    const outcome = await store.restore();

    expect(outcome.adopted).toBe(2);
    expect(loads).toBe(1);
    expect(store.pending()).toEqual([2]);
    expect(store.stats()).toEqual({ total: 3, done: 2, pending: 1, resumed: 2 });
    expect(await new CheckpointStore<string>({ total: 1 }).restore()).toEqual({ adopted: 0, duplicates: 0, ignored: 0 });
  });

  it('refuses work outside its plan', async () => {
    const store = new CheckpointStore<string>({ total: 2 });

    await expect(store.markDone(2, 'x')).rejects.toThrow(RangeError);
    await expect(store.markDone(-1, 'x')).rejects.toThrow(RangeError);
    await expect(store.markDone(0.5, 'x')).rejects.toThrow(RangeError);
  });

  it('handles an empty plan and validates its own options', async () => {
    const empty = new CheckpointStore<string>({ total: 0 });
    expect(empty.done()).toEqual([]);
    expect(empty.pending()).toEqual([]);
    expect(empty.tokens()).toEqual([]);
    expect(empty.stats()).toEqual({ total: 0, done: 0, pending: 0, resumed: 0 });
    await expect(empty.markDone(0, 'x')).rejects.toThrow(RangeError);

    expect(() => new CheckpointStore<string>({ total: -1 })).toThrow(RangeError);
    expect(() => new CheckpointStore<string>({ total: 1.5 })).toThrow(RangeError);
    expect(() => new CheckpointStore<string>({ total: 1, persist: 'nope' as unknown as () => void })).toThrow(/persist/);
    expect(() => new CheckpointStore<string>({ total: 1, load: 'nope' as unknown as () => [] })).toThrow(/load/);
  });
});

describe('long-form run', () => {
  it('runs pending chunks in plan order at concurrency 1', async () => {
    const store = new CheckpointStore<string>({ total: 4 });
    const started: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await runPlan(chunks(4), store, async chunk => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      started.push(chunk.index);
      await new Promise(resolve => setTimeout(resolve, 0));
      inFlight -= 1;
      return `r${chunk.index}`;
    });

    expect(started).toEqual([0, 1, 2, 3]);
    expect(maxInFlight).toBe(1);
    expect(result).toEqual({ processed: 4, skipped: 0, failed: 0, stoppedEarly: false, failures: [] });
    expect(store.done()).toEqual([0, 1, 2, 3]);
    expect(store.result(3)).toBe('r3');
  });

  it('starts chunks in plan order even when several run at once', async () => {
    const store = new CheckpointStore<string>({ total: 4 });
    const started: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await runPlan(
      chunks(4),
      store,
      async chunk => {
        started.push(chunk.index);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight -= 1;
        return `r${chunk.index}`;
      },
      { concurrency: 2 },
    );

    expect(started).toEqual([0, 1, 2, 3]);
    expect(maxInFlight).toBe(2);
    expect(result.processed).toBe(4);
    expect(result.failed).toBe(0);
  });

  it('skips chunks the store already has, so a resume redoes nothing', async () => {
    const store = new CheckpointStore<string>({ total: 4 });
    await store.markDone(1, 'from the crashed run');
    const ran: number[] = [];

    const result = await runPlan(chunks(4), store, chunk => {
      ran.push(chunk.index);
      return `r${chunk.index}`;
    });

    expect(ran).toEqual([0, 2, 3]);
    expect(result).toEqual({ processed: 3, skipped: 1, failed: 0, stoppedEarly: false, failures: [] });
    expect(store.result(1)).toBe('from the crashed run');
  });

  it('records a failing chunk and keeps going', async () => {
    const store = new CheckpointStore<string>({ total: 4 });
    const ran: number[] = [];

    const result = await runPlan(chunks(4), store, chunk => {
      ran.push(chunk.index);
      if (chunk.index === 1) throw new Error('provider exploded');
      return `r${chunk.index}`;
    });

    expect(ran).toEqual([0, 1, 2, 3]);
    expect(result.processed).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.stoppedEarly).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.chunkIndex).toBe(1);
    expect(result.failures[0]?.error).toBeInstanceOf(Error);
    // The failed chunk is not a checkpoint: the next resume retries exactly it.
    expect(store.done()).toEqual([0, 2, 3]);
    expect(store.pending()).toEqual([1]);
  });

  it('halts at the first failure when stopOnError is set', async () => {
    const store = new CheckpointStore<string>({ total: 5 });
    const ran: number[] = [];

    const result = await runPlan(
      chunks(5),
      store,
      chunk => {
        ran.push(chunk.index);
        if (chunk.index === 1) throw new Error('provider exploded');
        return `r${chunk.index}`;
      },
      { stopOnError: true },
    );

    expect(ran).toEqual([0, 1]);
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.stoppedEarly).toBe(true);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.chunkIndex).toBe(1);
    expect(store.done()).toEqual([0]);
    expect(store.pending()).toEqual([1, 2, 3, 4]);
  });

  it('stops after maxChunks and continues cleanly on the next run', async () => {
    const store = new CheckpointStore<string>({ total: 5 });
    const firstRan: number[] = [];

    const first = await runPlan(
      chunks(5),
      store,
      chunk => {
        firstRan.push(chunk.index);
        return `r${chunk.index}`;
      },
      { maxChunks: 2 },
    );

    expect(firstRan).toEqual([0, 1]);
    expect(first).toEqual({ processed: 2, skipped: 0, failed: 0, stoppedEarly: true, failures: [] });
    expect(store.done()).toEqual([0, 1]);

    const second = await runPlan(chunks(5), store, chunk => `r${chunk.index}`, { maxChunks: 2 });
    expect(second).toEqual({ processed: 2, skipped: 2, failed: 0, stoppedEarly: true, failures: [] });
    expect(store.done()).toEqual([0, 1, 2, 3]);

    const third = await runPlan(chunks(5), store, chunk => `r${chunk.index}`, { maxChunks: 2 });
    expect(third).toEqual({ processed: 1, skipped: 4, failed: 0, stoppedEarly: false, failures: [] });
    expect(store.done()).toEqual([0, 1, 2, 3, 4]);
  });

  it('does not call a full run stopped early when maxChunks outlives the plan', async () => {
    const store = new CheckpointStore<string>({ total: 2 });
    const result = await runPlan(chunks(2), store, chunk => `r${chunk.index}`, { maxChunks: 99 });

    expect(result.processed).toBe(2);
    expect(result.stoppedEarly).toBe(false);
  });

  it('starts nothing when maxChunks is zero and says work was left', async () => {
    const store = new CheckpointStore<string>({ total: 2 });
    const result = await runPlan(chunks(2), store, () => 'never', { maxChunks: 0 });

    expect(result).toEqual({ processed: 0, skipped: 0, failed: 0, stoppedEarly: true, failures: [] });
    expect(store.done()).toEqual([]);
  });

  it('treats an empty plan as a no-op', async () => {
    const store = new CheckpointStore<string>({ total: 0 });
    const result = await runPlan([], store, () => 'never');

    expect(result).toEqual({ processed: 0, skipped: 0, failed: 0, stoppedEarly: false, failures: [] });
    expect(store.stats()).toEqual({ total: 0, done: 0, pending: 0, resumed: 0 });
  });

  it('keys checkpoints by the plan index, not by array position', async () => {
    const store = new CheckpointStore<string>({ total: 13 });
    const plan: Chunk[] = [
      { index: 10, pages: [11], chars: 10, oversized: false },
      { index: 11, pages: [12], chars: 10, oversized: false },
      { index: 12, pages: [13], chars: 10, oversized: false },
    ];

    const result = await runPlan(plan, store, chunk => `r${chunk.index}`);

    expect(result.processed).toBe(3);
    expect(store.done()).toEqual([10, 11, 12]);
    expect(store.pending()).toHaveLength(10);
  });

  it('counts a chunk another writer finished under it as skipped', async () => {
    const store: ChunkCheckpoints<string> = {
      done: () => [],
      markDone: async chunkIndex => ({ status: 'already-done', chunkIndex }),
    };

    const result = await runPlan(chunks(2), store, chunk => `r${chunk.index}`);

    expect(result).toEqual({ processed: 0, skipped: 2, failed: 0, stoppedEarly: false, failures: [] });
  });

  it('records a rejected checkpoint write as a chunk failure and keeps going', async () => {
    let writes = 0;
    const store = new CheckpointStore<string>({
      total: 3,
      persist: () => {
        writes += 1;
        if (writes === 2) throw new Error('disk full');
      },
    });

    const result = await runPlan(chunks(3), store, chunk => `r${chunk.index}`);

    expect(result.processed).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.stoppedEarly).toBe(false);
    expect(result.failures[0]?.chunkIndex).toBe(1);
    expect(store.done()).toEqual([0, 2]);
    expect(store.pending()).toEqual([1]);
  });

  it('refuses malformed plans and options', async () => {
    const store = new CheckpointStore<string>({ total: 3 });
    const run: ChunkRunner<string> = chunk => `r${chunk.index}`;

    await expect(runPlan(undefined as unknown as Chunk[], store, run)).rejects.toThrow(/array of chunks/);
    await expect(
      runPlan([{ index: -1, pages: [1], chars: 1, oversized: false }], store, run),
    ).rejects.toThrow(/non-negative integer/);
    await expect(
      runPlan(
        [
          { index: 0, pages: [1], chars: 1, oversized: false },
          { index: 0, pages: [2], chars: 1, oversized: false },
        ],
        store,
        run,
      ),
    ).rejects.toThrow(/more than once/);
    await expect(runPlan(chunks(1), store, undefined as unknown as ChunkRunner<string>)).rejects.toThrow(/run function/);
    await expect(
      runPlan(chunks(1), {} as unknown as ChunkCheckpoints<string>, run),
    ).rejects.toThrow(/done\(\) and markDone\(\)/);
    await expect(
      runPlan(
        chunks(1),
        { done: () => new Set([0]) as unknown as number[], markDone: async chunkIndex => ({ status: 'done', chunkIndex }) },
        run,
      ),
    ).rejects.toThrow(/as an array/);
    await expect(runPlan(chunks(1), store, run, { concurrency: 0 })).rejects.toThrow(/concurrency/);
    await expect(runPlan(chunks(1), store, run, { maxChunks: -1 })).rejects.toThrow(/maxChunks/);
    await expect(runPlan(chunks(1), store, run, { maxChunks: 1.5 })).rejects.toThrow(/maxChunks/);
  });
});

describe('resumable long-form job (H16)', () => {
  it('keeps the 396 pages finished before a crash at page 397', async () => {
    const plan = planChunks(pages(500, 1000));
    const crashAt = 33;
    // Chunk 33 starts at page 397 when 12 pages fit a chunk: the crash lands at the
    // page-400 mark of the backlog item.
    expect(plan.chunks[crashAt]?.pages[0]).toBe(397);

    const tokens: CheckpointToken<string>[] = [];
    const firstStore = new CheckpointStore<string>({
      total: plan.chunks.length,
      persist: token => {
        tokens.push(token);
      },
    });
    const firstRunPages: number[] = [];

    const first = await runPlan(
      plan.chunks,
      firstStore,
      chunk => {
        if (chunk.index === crashAt) throw new Error('process crashed');
        firstRunPages.push(...chunk.pages);
        return `chunk-${chunk.index}`;
      },
      { stopOnError: true },
    );

    expect(first.failed).toBe(1);
    expect(first.stoppedEarly).toBe(true);
    expect(firstRunPages).toHaveLength(396);
    expect(firstStore.done()).toEqual(chunkIndexes(plan.chunks).slice(0, crashAt));
    expect(tokens).toHaveLength(crashAt);

    // A fresh process rebuilds its checkpoints from storage and only runs what is left.
    const laterTokens: CheckpointToken<string>[] = [];
    const secondStore = new CheckpointStore<string>({
      total: plan.chunks.length,
      persist: token => {
        laterTokens.push(token);
      },
      load: () => tokens,
    });
    const restored = await secondStore.restore();
    expect(restored.adopted).toBe(crashAt);
    expect(secondStore.stats()).toEqual({ total: plan.chunks.length, done: crashAt, pending: plan.chunks.length - crashAt, resumed: crashAt });

    const secondRunPages: number[] = [];
    const second = await runPlan(plan.chunks, secondStore, chunk => {
      secondRunPages.push(...chunk.pages);
      return `chunk-${chunk.index}`;
    });

    expect(second.skipped).toBe(crashAt);
    expect(second.processed).toBe(plan.chunks.length - crashAt);
    expect(second.failed).toBe(0);
    expect(second.stoppedEarly).toBe(false);
    expect(laterTokens).toHaveLength(plan.chunks.length - crashAt);

    // Every page was translated exactly once across the two runs.
    const translated = [...firstRunPages, ...secondRunPages];
    expect(translated).toHaveLength(500);
    expect([...translated].sort((left, right) => left - right)).toEqual(pages(500, 0).map(page => page.index));
    expect(secondStore.pending()).toEqual([]);
    expect(secondStore.stats()).toEqual({ total: plan.chunks.length, done: plan.chunks.length, pending: 0, resumed: crashAt });
  });
});
