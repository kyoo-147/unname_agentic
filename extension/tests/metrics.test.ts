import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compare,
  DEFAULT_TOLERANCE_PERCENT,
  METRIC_DEFINITIONS,
  MetricsError,
  MetricsRecorder,
  toMarkdownReport,
  type MetricName,
  type MetricsSnapshot,
  type MetricTags,
  type MetricUnit,
} from '../viewer/src/core/metrics';

/** A fixed clock: a snapshot is a document, and a document has to be reproducible. */
const FIXED_NOW = (): Date => new Date('2026-11-21T09:30:00.000Z');

function recorder(): MetricsRecorder {
  return new MetricsRecorder({ now: FIXED_NOW });
}

/** The error code a call throws, or a marker that says what went wrong instead. */
function errorCode(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof MetricsError ? error.code : `not-a-metrics-error: ${String(error)}`;
  }
  return 'no-error';
}

function unitOf(name: MetricName): MetricUnit {
  const definition = METRIC_DEFINITIONS.find(candidate => candidate.name === name);
  if (!definition) throw new Error(`no registry entry for ${name}`);
  return definition.unit;
}

/**
 * A recorder seeded with known samples. The unit comes from the registry, so a fixture cannot
 * pass a value the module would refuse in production for the wrong unit.
 */
function seeded(entries: readonly { name: MetricName; values: readonly number[]; tags?: MetricTags }[]): MetricsRecorder {
  const metrics = recorder();
  for (const entry of entries) {
    const unit = unitOf(entry.name);
    for (const value of entry.values) {
      if (entry.tags) metrics.record(entry.name, value, unit, entry.tags);
      else metrics.record(entry.name, value, unit);
    }
  }
  return metrics;
}

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('registry', () => {
  it('refuses a metric nobody defined', () => {
    const metrics = recorder();
    expect(errorCode(() => metrics.record('gpu.ms', 12, 'ms'))).toBe('unknown-metric');
    expect(metrics.snapshot().metrics).toEqual([]);
  });

  it('names the missing metric in the refusal, so the fix is obvious', () => {
    expect(() => recorder().record('gpu.ms', 12, 'ms')).toThrow(/gpu\.ms/);
  });

  it('refuses a unit that does not match the registry', () => {
    expect(errorCode(() => recorder().record('startup.ms', 900, 's'))).toBe('unit-mismatch');
    expect(errorCode(() => recorder().record('startup.ms', 900, 'ms'))).toBe('no-error');
  });

  it('refuses a value that is not a measurement instead of clamping it to zero', () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(errorCode(() => recorder().record('memory.mb', value, 'mb'))).toBe('invalid-value');
    }
    expect(errorCode(() => recorder().record('memory.mb', 0, 'mb'))).toBe('no-error');
  });

  it('refuses tags that could not be compared', () => {
    const wrongValue = { engine: 'tesseract', dpi: 300 } as unknown as MetricTags;
    const wrongShape = ['engine=tesseract'] as unknown as MetricTags;
    expect(errorCode(() => recorder().record('ocr.ms', 10, 'ms', wrongValue))).toBe('invalid-tags');
    expect(errorCode(() => recorder().record('ocr.ms', 10, 'ms', wrongShape))).toBe('invalid-tags');
  });
});

describe('snapshot', () => {
  it('reports p50, p95, max and min of one series', () => {
    const metrics = recorder();
    for (let ms = 1; ms <= 25; ms += 1) metrics.record('search.ms', ms, 'ms');

    const snapshot = metrics.snapshot();
    expect(snapshot.metrics).toHaveLength(1);
    const row = snapshot.metrics[0];
    expect(row).toMatchObject({
      name: 'search.ms',
      unit: 'ms',
      count: 25,
      p50: 13,
      p95: 24,
      max: 25,
      min: 1,
    });
    // p95 is the second-largest value on purpose: the worst run stays visible in `max` only.
    expect(row?.p95).toBeLessThan(row?.max ?? 0);
  });

  it('keeps a separate series per tag set instead of averaging them together', () => {
    const metrics = seeded([
      { name: 'startup.ms', values: [900], tags: { mode: 'cold' } },
      { name: 'startup.ms', values: [200], tags: { mode: 'warm' } },
    ]);

    const snapshot = metrics.snapshot();
    expect(snapshot.metrics.map(row => row.tags)).toEqual([{ mode: 'cold' }, { mode: 'warm' }]);
    expect(snapshot.metrics.map(row => row.p50)).toEqual([900, 200]);
  });

  it('sorts tag keys and row order so the same samples always serialize the same way', () => {
    const first = recorder();
    first.record('ocr.ms', 120, 'ms', { dpi: '300', engine: 'tesseract' });
    first.record('startup.ms', 900, 'ms', { mode: 'cold' });
    first.record('ocr.ms', 140, 'ms', { engine: 'tesseract', dpi: '300' });

    const second = recorder();
    second.record('ocr.ms', 140, 'ms', { engine: 'tesseract', dpi: '300' });
    second.record('startup.ms', 900, 'ms', { mode: 'cold' });
    second.record('ocr.ms', 120, 'ms', { dpi: '300', engine: 'tesseract' });

    expect(JSON.stringify(first.snapshot())).toBe(JSON.stringify(second.snapshot()));
    expect(Object.keys(first.snapshot().metrics[1]?.tags ?? {})).toEqual(['dpi', 'engine']);
  });

  it('reports an empty snapshot with the injected timestamp', () => {
    expect(recorder().snapshot()).toEqual({ metrics: [], recordedAt: '2026-11-21T09:30:00.000Z' });
  });

  it('keeps the newest samples when a series reaches its capacity', () => {
    const metrics = new MetricsRecorder({ now: FIXED_NOW, capacity: 3 });
    for (let ms = 1; ms <= 5; ms += 1) metrics.record('export.ms', ms, 'ms');

    const row = metrics.snapshot().metrics[0];
    expect(row?.count).toBe(3);
    expect(row?.min).toBe(3);
    expect(row?.max).toBe(5);
  });
});

describe('markdown report', () => {
  it('lists every metric that was recorded', () => {
    const metrics = recorder();
    for (const definition of METRIC_DEFINITIONS) metrics.record(definition.name, 1, definition.unit);

    const markdown = toMarkdownReport(metrics.snapshot());
    expect(markdown).toContain('### Metrics snapshot');
    for (const definition of METRIC_DEFINITIONS) {
      expect(markdown, `the report skips ${definition.name}`).toContain(`| \`${definition.name}\` |`);
    }
  });

  it('writes a snapshot with no samples without breaking the table', () => {
    const markdown = toMarkdownReport(recorder().snapshot());
    expect(markdown).toContain('no samples recorded');
    expect(markdown).toContain('0 series, 0 samples');
  });

  it('prints the delta beside each regression when a baseline is given', () => {
    const baseline = seeded([{ name: 'translate.ms', values: [800, 900, 1000] }]).snapshot();
    const current = seeded([{ name: 'translate.ms', values: [1000, 1100, 1250] }]).snapshot();

    const markdown = toMarkdownReport(current, { baseline });
    expect(markdown).toContain('| `translate.ms` | ms | 1000 | 1250 | +25% | — |');
    expect(markdown).toContain('1 regression over the 10% p95 tolerance (1 series compared)');
    expect(toMarkdownReport(current, { baseline: current })).toContain('No regressions over the 10% p95 tolerance');
  });
});

describe('compare', () => {
  it('flags a p95 rise over the tolerance and reports the delta', () => {
    const baseline = seeded([{ name: 'translate.ms', values: [800, 900, 1000] }]).snapshot();
    const current = seeded([{ name: 'translate.ms', values: [1000, 1100, 1250] }]).snapshot();

    const comparison = compare(baseline, current);
    expect(comparison.compared).toBe(1);
    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0]).toMatchObject({
      name: 'translate.ms',
      baselineP95: 1000,
      currentP95: 1250,
      deltaPercent: 25,
      tolerancePercent: DEFAULT_TOLERANCE_PERCENT,
    });
  });

  it('ignores a rise under the tolerance, and one exactly on it', () => {
    const baseline = seeded([{ name: 'translate.ms', values: [800, 900, 1000] }]).snapshot();
    const under = seeded([{ name: 'translate.ms', values: [1000, 1050, 1090] }]).snapshot();
    const exactly = seeded([{ name: 'translate.ms', values: [900, 1000, 1100] }]).snapshot();

    expect(compare(baseline, under).regressions).toEqual([]);
    expect(compare(baseline, exactly).regressions).toEqual([]);
  });

  it('never grades a count that grew with the document', () => {
    const baseline = seeded([{ name: 'ocr.pages', values: [10] }]).snapshot();
    const current = seeded([{ name: 'ocr.pages', values: [40] }]).snapshot();

    const comparison = compare(baseline, current);
    expect(comparison.compared).toBe(1);
    expect(comparison.regressions).toEqual([]);
  });

  it('treats a different tag set as a different number', () => {
    const baseline = seeded([{ name: 'translate.ms', values: [1000], tags: { engine: 'stub' } }]).snapshot();
    const current = seeded([{ name: 'translate.ms', values: [3000], tags: { engine: 'gpt' } }]).snapshot();

    const comparison = compare(baseline, current);
    expect(comparison.compared).toBe(0);
    expect(comparison.regressions).toEqual([]);
    // The metric is still recorded, just under another engine: a relabel, not a gap.
    expect(comparison.missingFromCurrent).toEqual([]);
  });

  it('names a metric the current run stopped recording', () => {
    const baseline = seeded([
      { name: 'startup.ms', values: [900] },
      { name: 'memory.mb', values: [420] },
    ]).snapshot();
    const current = seeded([{ name: 'startup.ms', values: [900] }]).snapshot();

    const comparison = compare(baseline, current);
    expect(comparison.compared).toBe(1);
    expect(comparison.missingFromCurrent).toEqual(['memory.mb']);
  });

  it('reports a rise from a zero baseline as a regression without a percentage', () => {
    const baseline = seeded([{ name: 'search.ms', values: [0] }]).snapshot();
    const current = seeded([{ name: 'search.ms', values: [5] }]).snapshot();

    const regression = compare(baseline, current).regressions[0];
    expect(regression?.currentP95).toBe(5);
    expect(regression?.deltaPercent).toBeNull();
  });

  it('honours an explicit tolerance', () => {
    const baseline = seeded([{ name: 'export.ms', values: [640, 688, 705] }]).snapshot();
    const current = seeded([{ name: 'export.ms', values: [700, 760, 800] }]).snapshot();

    expect(compare(baseline, current).regressions).toHaveLength(1);
    expect(compare(baseline, current, { tolerancePercent: 25 }).regressions).toEqual([]);
  });

  it('passes nothing and compares nothing when the current run recorded no metrics', () => {
    const baseline = seeded([{ name: 'startup.ms', values: [900] }]).snapshot();
    const comparison = compare(baseline, recorder().snapshot());

    expect(comparison.compared).toBe(0);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.missingFromCurrent).toEqual(['startup.ms']);
  });
});

describe('docs/metrics.md', () => {
  it('documents every registry metric with the row the sample fixture produces', () => {
    const report = toMarkdownReport(sampleSnapshot(), { title: 'Sample snapshot' });
    const doc = read('../../docs/metrics.md');

    for (const definition of METRIC_DEFINITIONS) {
      const row = report.split('\n').find(line => line.startsWith(`| \`${definition.name}\` |`));
      expect(row, `the sample fixture produced no row for ${definition.name}`).toBeDefined();
      expect(doc, `docs/metrics.md is missing the ${definition.name} row of the sample table`).toContain(row ?? '');
      expect(doc, `docs/metrics.md never says what ${definition.name} means`).toContain(definition.summary);
    }
  });
});

/**
 * The fixture behind the sample table in `docs/metrics.md`: fixed values and a fixed clock,
 * with every registry metric recorded. The numbers are invented on purpose — they exist to
 * show the shape of a report, not to describe a machine. `docs/metrics.md` says so as well.
 */
function sampleSnapshot(): MetricsSnapshot {
  const metrics = new MetricsRecorder({ now: () => new Date('2026-11-21T09:30:00.000Z') });

  for (const ms of [812, 845, 801, 903, 1204]) metrics.record('startup.ms', ms, 'ms', { mode: 'cold' });
  for (const ms of [214, 208, 231, 226, 219]) metrics.record('startup.ms', ms, 'ms', { mode: 'warm' });
  for (const ms of [3241, 3510, 2988]) metrics.record('ocr.ms', ms, 'ms', { dpi: '300', engine: 'tesseract' });
  for (const pages of [12, 12, 12]) metrics.record('ocr.pages', pages, 'pages', { engine: 'tesseract' });
  for (const ms of [4210, 5002, 4788, 6110]) metrics.record('translate.ms', ms, 'ms', { engine: 'stub' });
  for (const blocks of [1180, 1180, 1195, 1190]) metrics.record('translate.blocks', blocks, 'blocks', { engine: 'stub' });
  for (const ms of [640, 705, 688]) metrics.record('export.ms', ms, 'ms', { format: 'pdf' });
  for (const bytes of [1843200, 1843200, 1850112]) metrics.record('export.bytes', bytes, 'bytes', { format: 'pdf' });
  for (const megabytes of [412.5, 418.25, 431]) metrics.record('memory.mb', megabytes, 'mb', { phase: 'after-export' });
  for (const ms of [0.9, 1.1, 1.4, 2.6, 1.2]) metrics.record('search.ms', ms, 'ms');

  return metrics.snapshot();
}
