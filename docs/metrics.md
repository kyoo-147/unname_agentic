# Release metrics: one registry, a snapshot, a report that can fail

Date: 2026-11-21 (Asia/Saigon). Backlog: N07 — startup, OCR, translation, export and memory
numbers a release decision can cite.

Files:

- `src/core/metrics.ts`: the registry, `MetricsRecorder`, `toMarkdownReport`, `compare`.
- `tests/metrics.test.ts`: the refusals, the percentiles, the tolerance, and the sample table
  below, which the test holds against this document.
- This document: what each metric means, how it is captured, the tolerance, the sample table,
  and the limits.

`docs/performance.md` (N06) is the other half of this: it measures a synthetic corpus against
budgets and fails when a p95 budget is missed. This document is not about budgets for a
corpus — it is the shape of the report that leaves the repository with a release, and the
comparison that says whether the build in hand is worse than the one it replaces.

## What this is, and what it is not

**Is:** a registry that fixes the set of numbers a release may claim, a recorder that refuses
anything the registry cannot describe, a snapshot with p50/p95/max/min per series, a Markdown
table, and `compare`, which grades a current snapshot against a baseline.

**Is not:** a sampler, a storage layer, or a benchmark. Nothing in the application records
into this module yet — wiring the open path, the OCR pipeline and the export writer is a
separate change, and until that lands there is no device baseline to quote. The sample table
further down is produced by the test fixture, not by a machine, and it says so where it
appears.

The reason for the module before the wiring is the same one `perf.ts` gives for its own
existence: a claim nobody writes down is a claim nobody can check, and instrumentation added
after the fact is instrumentation bent to fit whatever the numbers were. The registry is the
part that has to be decided first, because it is the part a release note quotes.

## Why a registry instead of free-form names

`record(name, value, unit, tags)` is a gate with four refusals. Each one closes a way a report
can lie while looking entirely normal:

| Refusal (`MetricsError.code`) | What it prevents |
| --- | --- |
| `unknown-metric` | A typo (`startup.ms` vs `startupMs`) becoming a second series that nothing compares; or a number invented at the call site that no document defines and no reviewer sees. |
| `unit-mismatch` | `record('startup.ms', 900, 's')` — a thousand-fold error that is invisible after the fact, because a bare number in a table has no unit to contradict. |
| `invalid-value` | `NaN`, `Infinity` and negative durations. `perf.ts` clamps a broken clock to `0` because it measures; this module refuses, because it testifies. A report that reads `0 ms` must mean zero milliseconds. |
| `invalid-tags` | Tags that are not flat strings, or an empty key, which would make two different runs match — or fail to match — in a way nobody can predict from the table. |

The unit is passed by the caller even though the registry already knows it. That is the point:
the caller states what it believes it measured, and the registry refuses a disagreement. An API
that silently supplied the unit could not catch the mistake, because it would never be told
the wrong thing.

## What each metric means, and how it is captured

| Metric | Unit | Graded | What it means | How it is captured |
| --- | --- | --- | --- | --- |
| `startup.ms` | ms | yes | Time from app start to the first page the reader can scroll. | A `perf.ts` span around the open path, recorded once per launch. |
| `ocr.ms` | ms | yes | Wall time to OCR one document, every page included. | One span around the OCR pipeline run, or the sum of its per-page spans. |
| `ocr.pages` | pages | context | Pages the OCR pipeline recognised in one run. | The page count the pipeline reports when it finishes. |
| `translate.ms` | ms | yes | Wall time to translate one document through the provider. | One span around the batch translation call for a document. |
| `translate.blocks` | blocks | context | Blocks sent to the translator in one run. | The batch size the translation queue reports. |
| `export.ms` | ms | yes | Wall time to write one export. | One span around the export writer, per file written. |
| `export.bytes` | bytes | context | Bytes an export wrote. | The `byteLength` on the export record the writer produced. |
| `memory.mb` | mb | yes | Resident memory after a workload, in mebibytes. | `performance.memory.usedJSHeapSize` in the browser, or the native host’s resident set size. |
| `search.ms` | ms | yes | Time to answer one search query. | One `perf.ts` span around `retrieval.search`, per query typed. |

Two columns deserve their own paragraph.

**Graded** means "a rise in p95 is a release regression". Latency and memory are graded. Counts
(`ocr.pages`, `translate.blocks`) and byte sizes (`export.bytes`) are **context**: they grow
when the document grows, so grading them would fail a release because someone opened a longer
PDF. They are still recorded, because `translate.blocks` beside `translate.ms` is what turns
"translation got slower" into "translation got slower per block" or "translation got slower
because the batch doubled" — but the decision belongs to the graded rows. The registry's
`graded` flag is the only place that judgement lives.

**Captured** is a claim about wiring, and it is worth being exact: the table names the span or
the field the value must come from, so a number in a report can be traced back to code. Where
a value has two plausible sources (the OCR pipeline's own total versus the sum of its
per-page spans) the entry names both, and the tags of a run must say which one was used.

## The snapshot

`snapshot()` returns `{ metrics, recordedAt }`. Each row is one **series**: a metric name plus
one tag set.

- **A series is (metric, tags), never an average across tags.** `startup.ms{mode=cold}` and
  `startup.ms{mode=warm}` are two rows, because they answer different questions and a mean of
  the two answers neither. This is the same reason the tag set is part of the identity in
  `compare`.
- **Percentiles are `perf.ts`'s.** p50 and p95 come from `percentiles()` — nearest rank, the
  value at `ceil(p/100 × n) - 1` of the ascending samples, never an interpolation. p95 in this
  table and p95 in the budget gate are therefore the same number for the same samples; two
  implementations would be two definitions, and two definitions is how a document starts
  disagreeing with itself.
- **`max` and `min` are added here.** p95 excludes the worst run by construction (up to 5% of
  runs may sit above it), so a release report that printed only p95 would hide the one
  pathological launch everyone remembers. `max` is that launch; `min` is the floor a machine
  can reach, useful when asking whether a budget is headroom or luck.
- **Order is fixed.** Rows come in registry order, then canonical tag order; tag keys are
  sorted. Two recorders that saw the same samples in a different order produce byte-identical
  snapshots. That is what makes the table in this document reproducible rather than
  approximately reproducible.
- **Memory is bounded.** Each series keeps its most recent 10,000 samples by default
  (`capacity`); a recorder that lives for the whole application therefore cannot leak.

`recordedAt` is read from an injected clock at snapshot time, not stored per sample: a snapshot
describes when it was taken, which is the provenance a report cites. The default is the wall
clock; the test passes a fixed date so the table below can be regenerated exactly.

## Using it

```ts
import { MetricsRecorder } from './core/metrics';
import { span } from './core/perf';

const metrics = new MetricsRecorder();
const open = span('open-path');
// …open the document, render the first page…
metrics.record('startup.ms', open.end(), 'ms', { mode: 'cold', build: '2026-11-21' });

const snapshot = metrics.snapshot();
```

The tags are the provenance: a `build`, a `mode`, an `engine`, a `format` — whatever a reader
would need to decide whether two numbers belong in the same sentence. Tags are strings because
a table cell and a comparison both need one unambiguous rendering.

## The report, and the tolerance

`toMarkdownReport(snapshot)` writes the table above: metric, unit, samples, p50, p95, max, min
(the numbers are written exactly as the snapshot stores them — no thousands separators, no
locale — so the output is byte-stable on every machine).

`toMarkdownReport(snapshot, { baseline })` appends the comparison: the tolerance in force, how
many series were compared, one row per regression with its delta, and a line naming any
registry metric the baseline measured that the current run did not record at all.

`compare(baseline, current)` is the same comparison without the prose. It returns:

```ts
{ regressions, compared, missingFromCurrent, tolerancePercent }
```

Rules, all of them deliberate:

- **Tolerance: 10% on p95.** A regression is **strictly over** the tolerance: a rise of exactly
  10% passes a 10% tolerance, the same way `assertBudget` treats a p95 exactly on its budget.
  The comparison is computed by cross-multiplication (`rise > baseline × tolerance / 100`), not
  by a percentage, so a rise exactly on the line cannot be pushed over it by float error.
- **A delta is printed when it is defined.** `+25%` for a p95 that went from 1000 to 1250;
  `n/a` when the baseline p95 was `0`, because a metric measured at zero cannot rise by a
  percentage. That case is still a regression when the current p95 is above zero: an unbounded
  rise from nothing is not a pass.
- **Series are matched on name and full tag set.** A new engine is a new number, not a
  regression and not an improvement. A series absent from the baseline is new coverage, not a
  regression.
- **Only graded metrics are graded.** The rest are counted in `compared` and otherwise ignored,
  for the reason in the table above.
- **A bad tolerance falls back to 10%.** `Infinity`, `NaN` and negative values are replaced by
  the default rather than accepted: an `Infinity` tolerance would compare every series and
  never flag one, which is the failure mode that looks most like success.

`compared` exists because the most dangerous result this function can return is an empty
`regressions` list. "No regressions" and "nothing was compared" print the same if the count is
hidden, and a run that stopped recording its metrics would otherwise pass every gate. The same
concern is why `missingFromCurrent` is reported: coverage that disappeared is a finding, not an
absence of findings.

## Sample snapshot (not a device benchmark)

The table below is generated by `tests/metrics.test.ts` from a fixture with fixed inputs and a
fixed clock. **It is a sample of the format, not a measurement of any machine**: the numbers
are invented to exercise every column, including two tag sets of one metric and a search
latency small enough to need a decimal point. The test fails if this table and the fixture
drift apart, and if a registry metric is added without a documented meaning.

<!-- Generated by toMarkdownReport(sampleSnapshot()). Regenerate by running the test and
     reading its diff, not by editing numbers by hand. -->

### Sample snapshot

Recorded at `2026-11-21T09:30:00.000Z` — 10 series, 38 samples.

| Metric | Unit | Samples | p50 | p95 | Max | Min | Tags |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `startup.ms` | ms | 5 | 845 | 1204 | 1204 | 801 | `mode=cold` |
| `startup.ms` | ms | 5 | 219 | 231 | 231 | 208 | `mode=warm` |
| `ocr.ms` | ms | 3 | 3241 | 3510 | 3510 | 2988 | `dpi=300, engine=tesseract` |
| `ocr.pages` | pages | 3 | 12 | 12 | 12 | 12 | `engine=tesseract` |
| `translate.ms` | ms | 4 | 4788 | 6110 | 6110 | 4210 | `engine=stub` |
| `translate.blocks` | blocks | 4 | 1180 | 1195 | 1195 | 1180 | `engine=stub` |
| `export.ms` | ms | 3 | 688 | 705 | 705 | 640 | `format=pdf` |
| `export.bytes` | bytes | 3 | 1843200 | 1850112 | 1850112 | 1843200 | `format=pdf` |
| `memory.mb` | mb | 3 | 418.25 | 431 | 431 | 412.5 | `phase=after-export` |
| `search.ms` | ms | 5 | 1.2 | 2.6 | 2.6 | 0.9 | — |

How to read it: two `startup.ms` rows, because cold and warm launches are different numbers;
`ocr.pages` flat at 12, because the fixture runs one 12-page document three times;
`translate.blocks` at 1180–1195, which beside `translate.ms` is what lets a later run say
whether translation slowed down or the batch got bigger; `search.ms` p95 of 2.6 ms with a p50 of
1.2, a tail more than twice the median and exactly why p95 is the number the gate reads.

## Limits, and what this does not prove

- **Nothing is wired yet.** The registry, the recorder, the report and the comparison are here;
  the application does not call them. Until it does, this document describes a shape, and the
  sample table describes a fixture.
- **The unit gate checks the string, not the physical quantity.** `record('memory.mb', 430,
  'mb')` cannot know whether 430 is mebibytes or megabytes. A source that reports another unit
  has to convert before recording; the registry can only refuse a disagreement it can see.
- **No history, no storage, no aggregation.** A snapshot is in memory. Comparing releases means
  keeping two snapshots — as JSON, in a release artifact, wherever the release process puts
  such things — and passing both to `compare`. Nothing here decides where that lives.
- **One machine is not a distribution.** A p95 over five samples means little on its own; the
  percentiles inherit `perf.ts`'s rule that with 19 or fewer samples p95 is simply the largest
  value. Record at least `perf.ts`'s `MIN_SAMPLES_FOR_P95` (20) samples per series before
  quoting a p95 as a tail.
- **CPU model, GPU and VRAM are context, not metrics.** They belong in tags (`cpu=…`,
  `gpu=…`) or in the provenance line of whatever document quotes the table. They are not
  series, because they do not vary within a run and comparing them says nothing about the build.
- **No claim about translation quality.** `translate.ms` says how long the provider took, not
  whether the output was right; that is `ocr-metrics.ts` and `qa.ts`, and the two must be read
  together before a release note calls a build better.
