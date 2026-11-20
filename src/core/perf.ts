/**
 * Measurement primitives and budget enforcement (backlog N06).
 *
 * The reader makes claims about speed — "chunking is fast", "search is instant" —
 * and a claim nobody measures is a guess. This module is the small, boring part
 * those claims need: named spans, a report of what was recorded, percentiles over
 * the recorded durations, and a budget check that fails instead of praising itself.
 *
 * Three rules shape the design:
 *
 * 1. **p95, not the mean.** A reader does not feel the average; it feels the slow
 *    call, and slow runs are exactly what a mean dilutes. {@link assertBudget}
 *    compares a row's p95 against its budget, so a tail that is slow in more than
 *    one run in twenty fails. The mean is deliberately not computed anywhere in this
 *    module: a mean invites the question "but what is a normal mean?", and the answer
 *    is always "one that passes".
 * 2. **An injectable clock.** Every span reads its start and end from a clock the
 *    caller can supply. Tests drive that clock themselves, so a percentile assertion
 *    is arithmetic rather than a race against the machine; the benchmark script
 *    passes the real monotonic clock instead.
 * 3. **No dependencies and no I/O.** Nothing here imports anything, touches the DOM,
 *    writes a file or reads a locale. It runs identically in the browser, in the
 *    desktop shell's renderer and in a plain Node script.
 *
 * Percentiles use the nearest-rank definition — the value at position
 * `ceil(p/100 * n) - 1` of the ascending samples, clamped into range — documented
 * here because "p95" is otherwise four different numbers depending on who computed
 * it. Two consequences the caller has to live with, spelled out so nobody is
 * surprised by a passing run:
 *
 * - A p95 budget is a ceiling on the tail, not on the worst case. By construction
 *   up to 5% of runs may sit above p95, so one pathological run in twenty does not
 *   fail on its own (at 20 samples p95 is the second-largest value). The benchmark
 *   therefore prints the maximum beside p50/p95: a one-off pause stays visible even
 *   when the budget holds.
 * - The estimator needs samples to mean anything. With 19 or fewer samples p95 is
 *   simply the largest value; at 20 it is the second-largest. Scenarios are run at
 *   least {@link MIN_SAMPLES_FOR_P95} times for that reason.
 */

// --- Public shape ----------------------------------------------------------

/** One completed span: its name and how long it took, in milliseconds. */
export interface SpanRecord {
  /** The label given to {@link span} or {@link measure}. */
  readonly name: string;
  /** Duration in milliseconds, never negative and never non-finite. */
  readonly ms: number;
}

/** The three numbers a timing report leads with. */
export interface Percentiles {
  /** Median. */
  readonly p50: number;
  /** 95th percentile: the slow run a reader occasionally feels. */
  readonly p95: number;
  /** 99th percentile: the worst run in a hundred. */
  readonly p99: number;
}

/** Returns the current time in milliseconds. Only differences are meaningful. */
export type Clock = () => number;

/** The handle {@link span} hands back; call `end()` exactly once to record it. */
export interface SpanHandle {
  /**
   * Stops the span, records `{ name, ms }` and returns the duration. A second call
   * records nothing and returns the same duration, so a handle can only ever count
   * one measurement.
   */
  end(): number;
}

/** One row of a timing report: everything recorded under one name. */
export interface PerfRow {
  readonly name: string;
  /** Number of samples the percentiles were computed from. */
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  /** Every duration recorded under this name, in recording order. */
  readonly samples: readonly number[];
}

/** What a recorder knows after a run. Rows keep the order their names first appeared. */
export interface PerfReport {
  readonly rows: readonly PerfRow[];
  /** Total number of spans recorded, over all names. */
  readonly totalSpans: number;
  /** Sum of every recorded duration, in milliseconds. */
  readonly totalMs: number;
}

/** A budget that was missed: the measured p95 and the number it had to stay under. */
export interface BudgetViolation {
  readonly name: string;
  readonly p95: number;
  readonly budget: number;
}

/** Per-name p95 budgets in milliseconds. A name without a measurement is not checked. */
export type Budgets = Readonly<Record<string, number>>;

/** Records spans and turns them into a report. */
export interface Recorder {
  /** Everything recorded so far, oldest first. Read-only view of the live list. */
  readonly records: readonly SpanRecord[];
  /** Starts a span; the record lands in this recorder. */
  span(name: string): SpanHandle;
  /** Runs `fn` as one span. The record survives a throw: `end()` runs in a `finally`. */
  measure<T>(name: string, fn: () => T): T;
  /** Percentiles per name over what has been recorded so far. */
  report(): PerfReport;
  /** Drops every record so the recorder can be reused for the next phase. */
  clear(): void;
}

export interface RecorderOptions {
  /** Time source. Defaults to a monotonic clock ({@link defaultClock}). */
  clock?: Clock;
  /**
   * Most records to keep; the oldest are dropped first. Defaults to `Infinity` for a
   * recorder the caller owns, which is what a test or a benchmark phase wants.
   */
  capacity?: number;
}

// --- Public constants ------------------------------------------------------

/**
 * Samples a scenario needs before p95 is more than "the largest sample". Below
 * this the benchmark reports the row but the budget is still checked, so a short
 * run can never quietly pass by having too little data to show a slow tail.
 */
export const MIN_SAMPLES_FOR_P95 = 20;

/** Precision of every duration this module writes, in decimal places (µs resolution). */
export const PERCENTILE_DECIMALS = 3;

/** Records the process-wide default recorder keeps before dropping the oldest. */
export const DEFAULT_SPAN_CAPACITY = 4096;

/** Label used for a span started without a name, so a row is never blank. */
export const UNNAMED_SPAN = '(unnamed)';

// --- Percentiles -----------------------------------------------------------

/**
 * p50, p95 and p99 of `samples`, by nearest rank.
 *
 * Samples are copied, sorted ascending, and read at `ceil(p/100 * n) - 1` clamped
 * into range, so the answer is always one of the measurements — never an
 * interpolation between two of them. Values that are not finite numbers, or are
 * negative, are ignored: a broken clock must not turn a report into `NaN`, and a
 * duration below zero is a clock going backwards, not a fast call. An empty (or
 * entirely unusable) sample set returns zeros, so a missing measurement and an
 * instant one are still distinguishable through {@link PerfRow.count}.
 */
export function percentiles(samples: readonly number[]): Percentiles {
  const sorted = usableSamples(samples).sort(compareNumbers);
  if (sorted.length === 0) return { p50: 0, p95: 0, p99: 0 };
  return {
    p50: round(nearestRank(sorted, 50)),
    p95: round(nearestRank(sorted, 95)),
    p99: round(nearestRank(sorted, 99)),
  };
}

// --- Report ----------------------------------------------------------------

/**
 * Groups records by name and computes one {@link PerfRow} each.
 *
 * Row order is first appearance, which is the order the benchmark ran in and
 * therefore the order a reader expects to read. Nothing is mutated: the records
 * array is only read, and each row gets its own copy of that name's samples.
 */
export function summarize(records: readonly SpanRecord[]): PerfReport {
  const samplesByName = new Map<string, number[]>();
  let totalSpans = 0;
  let totalMs = 0;

  for (const record of records) {
    if (typeof record !== 'object' || record === null) continue;
    const ms = readDuration(record.ms);
    const name = readName(record.name);
    const samples = samplesByName.get(name);
    if (samples) samples.push(ms);
    else samplesByName.set(name, [ms]);
    totalSpans += 1;
    totalMs += ms;
  }

  const rows: PerfRow[] = [];
  for (const [name, samples] of samplesByName) {
    const p = percentiles(samples);
    rows.push({ name, count: samples.length, p50: p.p50, p95: p.p95, p99: p.p99, samples });
  }
  return { rows, totalSpans, totalMs: round(totalMs) };
}

/**
 * Compares each row's p95 against its budget and returns the misses.
 *
 * A violation is recorded only when `row.p95 > budget`; a p95 exactly on the budget
 * passes, because the budget is a ceiling and not a target. Rows without a budget,
 * and budgets without a measurement, are both skipped: there is nothing to compare.
 * That last point is a real caveat rather than an oversight — a scenario that
 * silently stopped being measured cannot fail here, so a caller that needs
 * coverage has to assert its row set itself (the benchmark script does exactly
 * that with its expected scenario names).
 *
 * Violations come back in report row order, so the output of a failing run is
 * stable and diffable.
 */
export function assertBudget(report: PerfReport, budgets: Budgets): BudgetViolation[] {
  const violations: BudgetViolation[] = [];
  const rows = Array.isArray(report?.rows) ? report.rows : [];

  for (const row of rows) {
    if (!hasOwn(budgets, row.name)) continue;
    const budget = budgets[row.name];
    if (typeof budget !== 'number' || !Number.isFinite(budget)) continue;
    if (row.p95 > budget) violations.push({ name: row.name, p95: row.p95, budget });
  }
  return violations;
}

// --- Recorder --------------------------------------------------------------

/**
 * Creates a recorder.
 *
 * Pass a `clock` to make the durations deterministic (a test drives it; the
 * benchmark script leaves it on the monotonic default). Pass `capacity` to bound
 * memory: a long-lived recorder that records forever is a leak, so the process-wide
 * default keeps the most recent {@link DEFAULT_SPAN_CAPACITY} spans and drops the
 * oldest.
 */
export function createRecorder(options: RecorderOptions = {}): Recorder {
  const clock = typeof options.clock === 'function' ? options.clock : defaultClock;
  const capacity = readCapacity(options.capacity);
  const records: SpanRecord[] = [];

  const record = (entry: SpanRecord): void => {
    records.push(entry);
    if (records.length > capacity) records.splice(0, records.length - capacity);
  };

  return {
    get records(): readonly SpanRecord[] {
      return records;
    },
    span: (name: string) => startSpan(name, clock, record),
    measure<T>(name: string, fn: () => T): T {
      const handle = startSpan(name, clock, record);
      try {
        return fn();
      } finally {
        handle.end();
      }
    },
    report: () => summarize(records),
    clear: () => {
      records.length = 0;
    },
  };
}

/**
 * The process-wide recorder the free functions use.
 *
 * Created on first use and bounded by {@link DEFAULT_SPAN_CAPACITY}. Nothing is
 * recorded into it unless code calls {@link span} or {@link measure} without a
 * recorder, so it costs one small object until then.
 */
export function defaultRecorder(): Recorder {
  shared ??= createRecorder({ capacity: DEFAULT_SPAN_CAPACITY });
  return shared;
}

let shared: Recorder | undefined;

/** Starts a span on `recorder`, or on the default recorder when none is given. */
export function span(name: string, recorder: Recorder = defaultRecorder()): SpanHandle {
  return recorder.span(name);
}

/**
 * Runs `fn` as one span and returns its value.
 *
 * The record is written even when `fn` throws — the work still happened — and the
 * error is rethrown unchanged, so measuring a failing path never hides the failure.
 */
export function measure<T>(name: string, fn: () => T, recorder: Recorder = defaultRecorder()): T {
  return recorder.measure(name, fn);
}

/** Milliseconds from a monotonic clock when the host has one, else the wall clock. */
export function defaultClock(): number {
  if (typeof performance === 'object' && performance !== null && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

// --- Internals -------------------------------------------------------------

/** Starts the timer and hands back a handle that records once. */
function startSpan(name: string, clock: Clock, record: (entry: SpanRecord) => void): SpanHandle {
  const label = readName(name);
  const start = clock();
  let duration: number | undefined;

  return {
    end(): number {
      if (duration !== undefined) return duration;
      duration = readDuration(clock() - start);
      record({ name: label, ms: duration });
      return duration;
    },
  };
}

/** Nearest rank: the sample at `ceil(p/100 * n) - 1`, clamped into range. */
function nearestRank(sorted: readonly number[], percentile: number): number {
  const rank = Math.ceil((percentile / 100) * sorted.length) - 1;
  const index = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[index] ?? 0;
}

/** Finite, non-negative samples only; the input array is never touched. */
function usableSamples(samples: readonly number[]): number[] {
  const usable: number[] = [];
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (typeof sample === 'number' && Number.isFinite(sample) && sample >= 0) usable.push(sample);
  }
  return usable;
}

/** A duration: finite and non-negative, or 0 when the clock could not measure. */
function readDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function readName(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : UNNAMED_SPAN;
}

function readCapacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(value));
}

function hasOwn(target: object | undefined, key: string): boolean {
  return target !== undefined && Object.hasOwn(target, key);
}

function compareNumbers(left: number, right: number): number {
  return left - right;
}

/** Rounds to {@link PERCENTILE_DECIMALS} places so a report reads in whole µs. */
function round(value: number): number {
  const factor = 10 ** PERCENTILE_DECIMALS;
  return Math.round(value * factor) / factor;
}
