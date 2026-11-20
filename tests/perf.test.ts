import { describe, expect, it } from 'vitest';
import {
  assertBudget,
  createRecorder,
  measure,
  percentiles,
  MIN_SAMPLES_FOR_P95,
  summarize,
  UNNAMED_SPAN,
  type Budgets,
  type Clock,
  type SpanRecord,
} from '../src/core/perf';

/**
 * A clock the test drives by hand. `advance` moves it forward; the value returned
 * is the same one `span` and `end` read, so a duration is arithmetic, not a race.
 */
function manualClock(start = 0): { clock: Clock; advance: (ms: number) => void } {
  let now = start;
  return {
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('percentiles', () => {
  it('reads the nearest rank of a known sample set', () => {
    const samples = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentiles(samples)).toEqual({ p50: 50, p95: 95, p99: 99 });
  });

  it('picks a sample, never an interpolation between two of them', () => {
    expect(percentiles([1, 2, 3, 4])).toEqual({ p50: 2, p95: 4, p99: 4 });
  });

  it('makes p95 the second-largest of a 25-sample run, not the maximum', () => {
    const samples = Array.from({ length: 25 }, (_, index) => index + 1);
    expect(samples.length).toBeGreaterThan(MIN_SAMPLES_FOR_P95);
    expect(percentiles(samples)).toEqual({ p50: 13, p95: 24, p99: 25 });
  });

  it('returns zeros for an empty sample set', () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0 });
  });

  it('ignores samples a clock could not have produced', () => {
    expect(percentiles([Number.NaN, Number.POSITIVE_INFINITY, -5, -0.001])).toEqual({
      p50: 0,
      p95: 0,
      p99: 0,
    });
    expect(percentiles([10, Number.NaN, 20, -1])).toEqual({ p50: 10, p95: 20, p99: 20 });
  });

  it('sorts a copy, leaving the caller’s array in its original order', () => {
    const samples = [30, 10, 20];
    expect(percentiles(samples)).toEqual({ p50: 20, p95: 30, p99: 30 });
    expect(samples).toEqual([30, 10, 20]);
  });

  it('reports a single sample as all three percentiles', () => {
    expect(percentiles([7.5])).toEqual({ p50: 7.5, p95: 7.5, p99: 7.5 });
  });

  it('rounds to microseconds so a report reads without float noise', () => {
    expect(percentiles([1.23456, 1.2, 1.3])).toEqual({ p50: 1.235, p95: 1.3, p99: 1.3 });
  });
});

describe('span', () => {
  it('records one entry when the injected clock advances between start and end', () => {
    const { clock, advance } = manualClock(1000);
    const recorder = createRecorder({ clock });

    const handle = recorder.span('chunk');
    advance(250);
    expect(handle.end()).toBe(250);

    expect(recorder.records).toEqual([{ name: 'chunk', ms: 250 }]);
  });

  it('is deterministic: the same clock script yields the same report twice', () => {
    const run = (): SpanRecord[] => {
      const { clock, advance } = manualClock();
      const recorder = createRecorder({ clock });
      const first = recorder.span('index');
      advance(12);
      first.end();
      const second = recorder.span('search');
      advance(3);
      second.end();
      return [...recorder.records];
    };

    expect(run()).toEqual(run());
    expect(run()).toEqual([
      { name: 'index', ms: 12 },
      { name: 'search', ms: 3 },
    ]);
  });

  it('records once when end() is called twice and returns the same duration', () => {
    const { clock, advance } = manualClock();
    const recorder = createRecorder({ clock });

    const handle = recorder.span('diff');
    advance(40);
    expect(handle.end()).toBe(40);
    advance(1_000);
    expect(handle.end()).toBe(40);
    expect(recorder.records).toHaveLength(1);
  });

  it('clamps a clock that goes backwards instead of recording a negative duration', () => {
    let now = 100;
    const recorder = createRecorder({ clock: () => now });
    const handle = recorder.span('rewind');
    now = 50;
    expect(handle.end()).toBe(0);
    expect(recorder.records).toEqual([{ name: 'rewind', ms: 0 }]);
  });

  it('labels an unnamed span so a report row is never blank', () => {
    const { clock } = manualClock();
    const recorder = createRecorder({ clock });
    recorder.span('').end();
    expect(recorder.report().rows[0]?.name).toBe(UNNAMED_SPAN);
  });
});

describe('measure', () => {
  it('returns the value of the measured function and records one span', () => {
    const { clock, advance } = manualClock();
    const recorder = createRecorder({ clock });

    const value = measure(
      'chunk',
      () => {
        advance(9);
        return 'passages';
      },
      recorder,
    );

    expect(value).toBe('passages');
    expect(recorder.records).toEqual([{ name: 'chunk', ms: 9 }]);
  });

  it('records one entry when the function throws, and rethrows the same error', () => {
    const { clock, advance } = manualClock();
    const recorder = createRecorder({ clock });
    const failure = new Error('retrieval exploded');

    expect(() =>
      measure(
        'chunk',
        () => {
          advance(6);
          throw failure;
        },
        recorder,
      ),
    ).toThrow(failure);

    expect(recorder.records).toEqual([{ name: 'chunk', ms: 6 }]);
  });

  it('nests: an inner span is recorded once, and the outer duration covers it', () => {
    const { clock, advance } = manualClock();
    const recorder = createRecorder({ clock });

    recorder.measure('search', () => {
      advance(2);
      recorder.measure('index', () => {
        advance(5);
      });
    });

    const report = recorder.report();
    expect(report.totalSpans).toBe(2);
    // Rows keep first-recorded order: the inner span closes before the outer one.
    expect(report.rows.map(row => [row.name, row.p50])).toEqual([
      ['index', 5],
      ['search', 7],
    ]);
  });
});

describe('summarize', () => {
  it('groups by name in first-seen order and counts every record', () => {
    const report = summarize([
      { name: 'chunk', ms: 10 },
      { name: 'index', ms: 1 },
      { name: 'chunk', ms: 20 },
    ]);

    expect(report.totalSpans).toBe(3);
    expect(report.totalMs).toBe(31);
    expect(report.rows.map(row => row.name)).toEqual(['chunk', 'index']);
    expect(report.rows[0]).toEqual({
      name: 'chunk',
      count: 2,
      p50: 10,
      p95: 20,
      p99: 20,
      samples: [10, 20],
    });
  });

  it('reads a record with an impossible duration as zero rather than NaN', () => {
    const report = summarize([
      { name: 'broken', ms: Number.NaN },
      { name: 'broken', ms: -4 },
    ]);
    expect(report.rows[0]?.samples).toEqual([0, 0]);
    expect(report.totalMs).toBe(0);
  });
});

describe('assertBudget', () => {
  const budgets: Budgets = { chunk: 40, index: 20 };

  it('passes when every measured p95 is inside its budget', () => {
    const { clock, advance } = manualClock();
    const recorder = createRecorder({ clock });
    for (let run = 0; run < 20; run += 1) {
      const handle = recorder.span('chunk');
      advance(10);
      handle.end();
    }
    expect(assertBudget(recorder.report(), budgets)).toEqual([]);
  });

  it('fails on a p95 above the budget and names both numbers', () => {
    const report = summarize([
      ...Array.from({ length: 18 }, () => ({ name: 'chunk', ms: 5 })),
      { name: 'chunk', ms: 90 },
      { name: 'chunk', ms: 120 },
    ]);

    // 20 samples: rank ceil(0.95 * 20) - 1 = 18, so p95 is the second-largest.
    expect(assertBudget(report, budgets)).toEqual([{ name: 'chunk', p95: 90, budget: 40 }]);
  });

  it('treats a p95 exactly on the budget as passing, because the budget is a ceiling', () => {
    const report = summarize(Array.from({ length: 20 }, () => ({ name: 'chunk', ms: 40 })));
    expect(assertBudget(report, budgets)).toEqual([]);
  });

  it('compares p95, not the mean: a diluted average does not hide a slow tail', () => {
    const samples = [
      ...Array.from({ length: 19 }, () => ({ name: 'chunk', ms: 1 })),
      { name: 'chunk', ms: 300 },
      { name: 'chunk', ms: 400 },
    ];
    const report = summarize(samples);
    const row = report.rows[0];
    const mean = samples.reduce((sum, sample) => sum + sample.ms, 0) / samples.length;

    expect(row?.p50).toBe(1);
    expect(row?.p95).toBe(300);
    // The mean sits inside the budget; only the tail exposes what a reader feels.
    expect(mean).toBeLessThan(budgets.chunk ?? 0);
    expect(assertBudget(report, budgets)).toHaveLength(1);
  });

  it('skips a row without a budget and a budget without a measurement', () => {
    const report = summarize([
      { name: 'chunk', ms: 10 },
      { name: 'unbudgeted', ms: 10_000 },
    ]);
    expect(assertBudget(report, budgets)).toEqual([]);
    expect(assertBudget(report, { missing: 1 })).toEqual([]);
  });

  it('returns violations in report row order', () => {
    const report = summarize([
      { name: 'index', ms: 100 },
      { name: 'chunk', ms: 100 },
    ]);
    expect(assertBudget(report, budgets).map(violation => violation.name)).toEqual(['index', 'chunk']);
  });
});

describe('recorder', () => {
  it('starts empty and clears back to empty', () => {
    const { clock, advance } = manualClock();
    const recorder = createRecorder({ clock });
    expect(recorder.records).toEqual([]);
    expect(recorder.report().rows).toEqual([]);

    const handle = recorder.span('chunk');
    advance(5);
    handle.end();
    expect(recorder.records).toHaveLength(1);

    recorder.clear();
    expect(recorder.records).toEqual([]);
    expect(recorder.report().totalSpans).toBe(0);
  });

  it('drops the oldest records once it is over capacity', () => {
    const { clock } = manualClock();
    const recorder = createRecorder({ clock, capacity: 2 });
    for (const name of ['a', 'b', 'c']) recorder.span(name).end();

    expect(recorder.records.map(record => record.name)).toEqual(['b', 'c']);
    expect(recorder.report().rows.map(row => row.name)).toEqual(['b', 'c']);
  });

  it('exposes its records as a live read-only view', () => {
    const { clock } = manualClock();
    const recorder = createRecorder({ clock });
    const view = recorder.records;
    recorder.span('chunk').end();
    expect(view).toHaveLength(1);
  });
});
