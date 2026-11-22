/**
 * Long-form documents as resumable jobs (backlog item H16).
 *
 * A 500-page document is hundreds of provider calls. Until now a crash at page 400
 * threw away every call that came before it, because nothing durable recorded which
 * pages were already finished. This module owns the three pieces that fix that:
 * a chunk plan ({@link planChunks}), a checkpoint store ({@link CheckpointStore}) and
 * the driver that walks the plan and writes a checkpoint per chunk
 * ({@link runPlan}).
 *
 * Contract:
 * - `planChunks` never splits a page and never reorders one. Pages are grouped in
 *   the order they are given. A page that alone exceeds the character budget is
 *   carried as its own chunk with `oversized: true` instead of being cut silently,
 *   so the caller can decide whether to split it later.
 * - Cost is characters, not tokens: the budget is compared against a page's
 *   `chars`, and `text` is measured in code points so a CJK page counts one per
 *   character. A page with neither is an error, never a free page.
 * - `CheckpointStore` calls a chunk `done` only after `persist` resolved. A rejected
 *   `persist` leaves the chunk pending, so a write that never reached disk is redone
 *   on the next resume instead of being assumed.
 * - The first result for a chunk wins: a repeated `markDone` reports `already-done`
 *   and does not overwrite it, so a retried call cannot rewrite history.
 * - `runPlan` walks pending chunks in plan order, at concurrency 1 unless asked
 *   otherwise. A chunk whose run rejects is left pending and its error is recorded
 *   in the result: the caller learns what broke and the next resume retries exactly
 *   that chunk.
 * - Nothing here reads the clock, a global or randomness. A checkpoint's key is the
 *   chunk index from the plan, never a timestamp, so two runs of the same plan
 *   produce the same indexes.
 */

/** Default character budget for one chunk, matching {@link ChunkPlanOptions.maxChars}. */
export const DEFAULT_CHUNK_CHARS = 12000;

/** Default page cap for one chunk, matching {@link ChunkPlanOptions.maxPages}. */
export const DEFAULT_CHUNK_PAGES = 25;

export interface ChunkPlanOptions {
  /** Character budget of one chunk. Defaults to {@link DEFAULT_CHUNK_CHARS}. */
  maxChars?: number;
  /** Maximum pages in one chunk. Defaults to {@link DEFAULT_CHUNK_PAGES}. */
  maxPages?: number;
}

/**
 * One page as the planner sees it: what it costs, not what it says.
 *
 * `index` is 1-based and must match `Page.index` in the document IR. Exactly one of
 * `chars` and `text` is enough; when both are given `chars` wins, so a caller that
 * already measured a page does not pay to measure it again.
 */
export interface PlanPageInput {
  /** 1-based page number. */
  index: number;
  /** Character cost of the page. */
  chars?: number;
  /** Page text, measured in code points when `chars` is absent. */
  text?: string;
}

/** One unit of resumable work: a run of pages under both budgets. */
export interface Chunk {
  /** 0-based position in the plan; this is the checkpoint key. */
  index: number;
  /** Page numbers in this chunk, in plan order. Never empty. */
  pages: number[];
  /** Character cost of the member pages. */
  chars: number;
  /** True when one page alone is over the budget and is carried unsplit. */
  oversized: boolean;
}

export interface ChunkPlan {
  chunks: Chunk[];
  /** Number of pages the plan covers. */
  total: number;
  /** Character cost of the whole plan. */
  totalChars: number;
}

/**
 * Groups pages into chunks under a character budget and a page cap.
 *
 * A chunk is grown greedily in input order. The next page joins the open chunk only
 * while both `maxChars` and `maxPages` still hold; otherwise the open chunk is
 * closed and a new one starts with that page. Because a page is never split, a page
 * larger than `maxChars` becomes a chunk of its own with `oversized: true` and the
 * plan continues after it.
 *
 * Throws when a page has no usable cost (`chars` or `text`), when `chars` is not a
 * non-negative integer, when `index` is not a 1-based page number, when two pages
 * share an index (a plan that lists a page twice would translate it twice) or when a
 * budget is not a positive integer.
 */
export function planChunks(pages: readonly PlanPageInput[], options: ChunkPlanOptions = {}): ChunkPlan {
  if (!Array.isArray(pages)) {
    throw new Error('planChunks needs an array of pages.');
  }
  const maxChars = positiveInteger(options.maxChars, DEFAULT_CHUNK_CHARS, 'maxChars');
  const maxPages = positiveInteger(options.maxPages, DEFAULT_CHUNK_PAGES, 'maxPages');

  const chunks: Chunk[] = [];
  const seen = new Set<number>();
  let bucket: { pages: number[]; chars: number } | null = null;
  let total = 0;
  let totalChars = 0;

  const flush = (): void => {
    if (bucket === null) return;
    chunks.push({ index: chunks.length, pages: bucket.pages, chars: bucket.chars, oversized: false });
    bucket = null;
  };

  pages.forEach((page, position) => {
    const { index, chars } = readPlanPage(page, position);
    if (seen.has(index)) {
      throw new Error(`planChunks: page ${index} appears more than once (pages[${position}]).`);
    }
    seen.add(index);
    total += 1;
    totalChars += chars;

    // One page is never split: an over-budget page travels alone and says so.
    if (chars > maxChars) {
      flush();
      chunks.push({ index: chunks.length, pages: [index], chars, oversized: true });
      return;
    }
    if (bucket !== null && (bucket.pages.length >= maxPages || bucket.chars + chars > maxChars)) {
      flush();
    }
    if (bucket === null) bucket = { pages: [], chars: 0 };
    bucket.pages.push(index);
    bucket.chars += chars;
  });
  flush();

  return { chunks, total, totalChars };
}

/** Outcome of one checkpoint write. `already-done` means the first result was kept. */
export type MarkDoneStatus = 'done' | 'already-done';

export interface MarkDoneOutcome {
  status: MarkDoneStatus;
  chunkIndex: number;
}

/** One finished chunk as the caller's own storage holds it. */
export interface CheckpointToken<T> {
  /** 0-based chunk index from {@link ChunkPlan}. */
  chunkIndex: number;
  /** Whatever the run function produced for that chunk. */
  result: T;
}

export interface CheckpointStoreOptions<T> {
  /** Number of chunks in the plan; every checkpoint index must be inside `[0, total)`. */
  total: number;
  /**
   * Called once per chunk as it becomes durable, with a fresh token object. The
   * chunk is not `done` until this resolves; a rejection leaves it pending.
   */
  persist?: (token: CheckpointToken<T>) => void | Promise<void>;
  /**
   * Previously persisted tokens, read by {@link CheckpointStore.restore}. Read on
   * demand, never in the constructor, so constructing a store cannot fail late.
   */
  load?: () => readonly CheckpointToken<T>[] | Promise<readonly CheckpointToken<T>[]>;
}

/** What one `resume` call did with the tokens it was handed. */
export interface ResumeOutcome {
  /** Tokens recorded as done by this call. */
  adopted: number;
  /** Tokens for chunks this store already had; the first result was kept. */
  duplicates: number;
  /** Tokens that are malformed or name a chunk outside the plan; nothing was recorded. */
  ignored: number;
}

export interface CheckpointStats {
  /** Chunks in the plan this store was built for. */
  total: number;
  /** Chunks with a durable result. */
  done: number;
  /** Chunks still to run: `total - done`. */
  pending: number;
  /** Tokens adopted from storage rather than produced by this process. */
  resumed: number;
}

/**
 * Durable per-chunk results for one plan.
 *
 * The store is bound to a plan: `total` is the number of chunks, and every accepted
 * checkpoint index is inside it. Results are kept in memory and mirrored through the
 * injected `persist`, so a fresh process can rebuild the same state with
 * {@link CheckpointStore.restore} (or `resume(tokens)` when the caller already holds
 * the tokens). Neither `persist` nor `load` is called anywhere else.
 */
export class CheckpointStore<T> {
  private readonly total: number;
  private readonly persistToken?: (token: CheckpointToken<T>) => void | Promise<void>;
  private readonly loadTokens?: () => readonly CheckpointToken<T>[] | Promise<readonly CheckpointToken<T>[]>;
  /** Durable results, keyed by chunk index. First write wins. */
  private readonly results = new Map<number, T>();
  /** Indexes whose `persist` is in flight; claimed so a duplicate cannot double-write. */
  private readonly writing = new Set<number>();
  private resumedCount = 0;

  constructor(options: CheckpointStoreOptions<T>) {
    if (typeof options !== 'object' || options === null) {
      throw new Error('CheckpointStore needs an options object.');
    }
    if (!Number.isInteger(options.total) || options.total < 0) {
      throw new RangeError('CheckpointStore: total must be a non-negative integer.');
    }
    if (options.persist !== undefined && typeof options.persist !== 'function') {
      throw new Error('CheckpointStore: persist must be a function.');
    }
    if (options.load !== undefined && typeof options.load !== 'function') {
      throw new Error('CheckpointStore: load must be a function.');
    }
    this.total = options.total;
    this.persistToken = options.persist;
    this.loadTokens = options.load;
  }

  /**
   * Records one finished chunk. The result is durable before the chunk counts as
   * done: `persist` is awaited first, and a rejection is rethrown with the chunk left
   * pending. A repeat for an index that is already done (or being written) keeps the
   * first result and returns `already-done`.
   */
  async markDone(chunkIndex: number, result: T): Promise<MarkDoneOutcome> {
    this.assertIndex(chunkIndex);
    if (this.results.has(chunkIndex) || this.writing.has(chunkIndex)) {
      return { status: 'already-done', chunkIndex };
    }
    this.writing.add(chunkIndex);
    try {
      await this.persistToken?.({ chunkIndex, result });
    } catch (error) {
      // The write never reached storage, so the chunk stays pending and a later
      // attempt may claim it again.
      this.writing.delete(chunkIndex);
      throw error;
    }
    this.writing.delete(chunkIndex);
    this.results.set(chunkIndex, result);
    return { status: 'done', chunkIndex };
  }

  /** Done chunk indexes, ascending. */
  done(): number[] {
    return [...this.results.keys()].sort((left, right) => left - right);
  }

  /** Chunk indexes with no durable result yet, ascending. */
  pending(): number[] {
    const open: number[] = [];
    for (let index = 0; index < this.total; index += 1) {
      if (!this.results.has(index)) open.push(index);
    }
    return open;
  }

  /** The recorded result for a chunk, or `undefined` when it is not done. */
  result(chunkIndex: number): T | undefined {
    return this.results.get(chunkIndex);
  }

  /** Every durable token, ascending by chunk index; what persistence should hold. */
  tokens(): CheckpointToken<T>[] {
    const tokens: CheckpointToken<T>[] = [];
    for (const [chunkIndex, result] of this.results) tokens.push({ chunkIndex, result });
    tokens.sort((left, right) => left.chunkIndex - right.chunkIndex);
    return tokens;
  }

  /**
   * Adopts tokens already on disk, as a fresh process does after a crash.
   *
   * A token is ignored when it is malformed or names a chunk outside the plan; a
   * token for a chunk this store already has counts as a duplicate and its result is
   * left alone. `persist` is not called: those tokens are already durable.
   */
  resume(tokens: readonly CheckpointToken<T>[]): ResumeOutcome {
    if (!Array.isArray(tokens)) {
      throw new Error('CheckpointStore.resume needs an array of tokens.');
    }
    const outcome: ResumeOutcome = { adopted: 0, duplicates: 0, ignored: 0 };
    for (const token of tokens) {
      const chunkIndex = typeof token === 'object' && token !== null ? token.chunkIndex : undefined;
      if (typeof chunkIndex !== 'number' || !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= this.total) {
        outcome.ignored += 1;
        continue;
      }
      if (this.results.has(chunkIndex) || this.writing.has(chunkIndex)) {
        outcome.duplicates += 1;
        continue;
      }
      this.results.set(chunkIndex, token.result);
      this.resumedCount += 1;
      outcome.adopted += 1;
    }
    return outcome;
  }

  /** Awaits `load()` and adopts what it returns. A no-op when no loader was given. */
  async restore(): Promise<ResumeOutcome> {
    if (this.loadTokens === undefined) return { adopted: 0, duplicates: 0, ignored: 0 };
    const tokens = await this.loadTokens();
    return this.resume(tokens);
  }

  stats(): CheckpointStats {
    const done = this.results.size;
    return { total: this.total, done, pending: this.total - done, resumed: this.resumedCount };
  }

  private assertIndex(chunkIndex: number): void {
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= this.total) {
      throw new RangeError(
        `CheckpointStore: chunk ${String(chunkIndex)} is outside the plan, which has ${this.total} chunk(s).`,
      );
    }
  }
}

/** Executes one chunk. Rejecting records a failure; the plan keeps going unless asked not to. */
export type ChunkRunner<T> = (chunk: Chunk) => Promise<T> | T;

/**
 * The part of {@link CheckpointStore} `runPlan` needs. Keeping it structural lets a
 * caller hand in its own store, or a fake in a test, without subclassing.
 */
export interface ChunkCheckpoints<T> {
  /** Records a finished chunk; see {@link CheckpointStore.markDone}. */
  markDone(chunkIndex: number, result: T): Promise<MarkDoneOutcome>;
  /** Chunk indexes that already have a durable result. Indexes outside the plan are ignored. */
  done(): readonly number[];
}

export interface ChunkFailure {
  chunkIndex: number;
  error: unknown;
}

export interface RunPlanOptions {
  /** Chunks in flight. Defaults to 1, so checkpoints are written in plan order. */
  concurrency?: number;
  /** Stop after this many chunks have started. Unset means the whole plan. */
  maxChunks?: number;
  /** Stop starting new chunks after the first failure. Defaults to false. */
  stopOnError?: boolean;
}

export interface RunPlanResult {
  /** Chunks this run finished and checkpointed. */
  processed: number;
  /** Chunks that needed no run: the store already had them, or they finished under this run. */
  skipped: number;
  /** Chunks whose run (or checkpoint write) failed. They stay pending. */
  failed: number;
  /** True when a pending chunk never started: `maxChunks` ran out or a failure halted the run. */
  stoppedEarly: boolean;
  /** Every failure, in the order this run recorded it. */
  failures: ChunkFailure[];
}

/**
 * Runs the plan's pending chunks, writing a checkpoint after each one.
 *
 * Chunks the store already has are skipped, so restarting a crashed job costs only
 * the chunks that were not durable. Work starts in plan order; with `concurrency`
 * above 1, that many chunks run at once and finish in whatever order they settle.
 *
 * A failure is recorded in `failures` and the chunk is left pending, so the next
 * resume retries exactly it. `stopOnError` halts new starts at the first failure;
 * chunks already in flight are still awaited and checkpointed. `maxChunks` bounds
 * how many chunks a single run starts, which is how a caller splits a long document
 * into several sessions without losing progress.
 */
export async function runPlan<T>(
  chunks: readonly Chunk[],
  store: ChunkCheckpoints<T>,
  run: ChunkRunner<T>,
  options: RunPlanOptions = {},
): Promise<RunPlanResult> {
  const plan = readChunks(chunks);
  if (typeof store !== 'object' || store === null || typeof store.markDone !== 'function' || typeof store.done !== 'function') {
    throw new Error('runPlan needs a checkpoint store with done() and markDone().');
  }
  if (typeof run !== 'function') {
    throw new Error('runPlan needs a run function.');
  }
  const concurrency = positiveInteger(options.concurrency, 1, 'concurrency');
  const maxChunks = options.maxChunks === undefined
    ? Number.POSITIVE_INFINITY
    : nonNegativeInteger(options.maxChunks, 'maxChunks');
  const stopOnError = options.stopOnError === true;

  const finished = store.done();
  if (!Array.isArray(finished)) {
    throw new Error('runPlan: the checkpoint store must report done chunks as an array.');
  }
  const done = new Set<number>(finished);
  const pending = plan.filter(chunk => !done.has(chunk.index));

  const failures: ChunkFailure[] = [];
  let processed = 0;
  let skipped = plan.length - pending.length;
  let failed = 0;
  let started = 0;
  let cursor = 0;
  let halted = false;

  // One worker per concurrency slot. Each pulls the next pending index, so chunks
  // start in plan order even when several run at once.
  const worker = async (): Promise<void> => {
    while (!halted && started < maxChunks && cursor < pending.length) {
      const chunk = pending[cursor];
      if (chunk === undefined) break;
      cursor += 1;
      started += 1;
      try {
        const result = await run(chunk);
        const outcome = await store.markDone(chunk.index, result);
        if (outcome.status === 'done') processed += 1;
        // Another writer finished this chunk under us; the first result stands.
        else skipped += 1;
      } catch (error) {
        failed += 1;
        failures.push({ chunkIndex: chunk.index, error });
        if (stopOnError) halted = true;
      }
    }
  };

  const workers = Math.min(concurrency, pending.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  return { processed, skipped, failed, stoppedEarly: started < pending.length, failures };
}

function readPlanPage(page: PlanPageInput, position: number): { index: number; chars: number } {
  const path = `pages[${position}]`;
  if (typeof page !== 'object' || page === null) {
    throw new Error(`planChunks: ${path} must be an object.`);
  }
  if (!Number.isInteger(page.index) || page.index < 1) {
    throw new Error(`planChunks: ${path}.index must be a 1-based page number.`);
  }
  let chars: number;
  if (typeof page.chars === 'number') {
    chars = page.chars;
  } else if (typeof page.text === 'string') {
    chars = Array.from(page.text).length;
  } else {
    throw new Error(`planChunks: ${path} has neither chars nor text; pass the page's character cost.`);
  }
  if (!Number.isInteger(chars) || chars < 0) {
    throw new Error(`planChunks: ${path}.chars must be a non-negative integer.`);
  }
  return { index: page.index, chars };
}

function readChunks(chunks: readonly Chunk[]): Chunk[] {
  if (!Array.isArray(chunks)) {
    throw new Error('runPlan needs an array of chunks.');
  }
  const seen = new Set<number>();
  return chunks.map((chunk, position) => {
    if (typeof chunk !== 'object' || chunk === null) {
      throw new Error(`runPlan: chunks[${position}] must be an object.`);
    }
    if (!Number.isInteger(chunk.index) || chunk.index < 0) {
      throw new Error(`runPlan: chunks[${position}].index must be a non-negative integer.`);
    }
    if (seen.has(chunk.index)) {
      throw new Error(`runPlan: chunk ${chunk.index} appears more than once.`);
    }
    seen.add(chunk.index);
    return chunk;
  });
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`longform: ${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`longform: ${name} must be a non-negative integer.`);
  }
  return value;
}
