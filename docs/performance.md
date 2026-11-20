# Performance budgets: p50/p95 and a gate that fails

Date: 2026-11-20 (Asia/Saigon). Backlog: measure the work the reader does and fail a budget instead
of claiming it is fast. The wave G brief labels this N06; `docs/backlog-e-n.md` lists the wider
p50/p95 metric set (startup, OCR, translation, export, memory) as N07, and that set is **not** what
this document covers.

Status: the primitives, the tests and the runner are in place, and the baseline table at the end was
produced by an actual run on the machine named in that section. Nothing here is an end-to-end
product claim: the workload is a synthetic corpus, chosen because it is deterministic (see
[Limits](#limits-and-what-this-does-not-prove)).

Files:

- `src/core/perf.ts`: `span`, `measure`, `percentiles`, `assertBudget`, and a recorder with an
  injectable clock. No dependencies, no DOM, no I/O.
- `tests/perf.test.ts`: the percentile rule, budget pass and fail, the throwing `measure`, and the
  deterministic clock.
- `scripts/perf-budget.mjs`: the runner. Synthetic workload plus bundle-size check, prints the
  table, exits non-zero when a budget is missed.
- This document: the method, the budgets and why each number is what it is, how to run, the
  measured baseline, and the limits.

## Method

### What a measurement is

A **span** is a named interval. `span(name)` returns a handle; `end()` records `{ name, ms }` and
returns the duration. Calling `end()` twice records once, so a handle can never count as two
measurements. `measure(name, fn)` is the same thing for synchronous work, and it records in a
`finally`: a function that throws is still measured, and the error is rethrown unchanged, because
the work happened whether or not it succeeded.

A **recorder** owns the records. `createRecorder({ clock, capacity })` returns `{ span, measure,
records, report, clear }`; `report()` groups the records by name into rows of `{ name, count, p50,
p95, p99, samples }`. The process-wide `defaultRecorder()` is what the free `span()` and `measure()`
write into, and it keeps the most recent 4,096 spans so a long-running app does not leak.

The **clock** is injected. The default is `performance.now()` (monotonic) with `Date.now()` as the
fallback; the tests pass a manual clock, which is what makes a percentile assertion arithmetic
instead of a race against the machine. A duration is always finite and non-negative: a clock that
goes backwards records 0 rather than a negative time.

### Percentiles: nearest rank, and what p95 excludes

`percentiles(samples)` returns p50, p95 and p99 by **nearest rank**: sort ascending, take the value
at `ceil(p/100 * n) - 1`, clamped into range. The result is always one of the measurements, never an
interpolation between two of them. Values that are not finite, or are negative, are ignored.

Two consequences, documented because a passing gate is worth nothing if the number it prints is
misunderstood:

- **p95 is a ceiling on the tail, not on the worst case.** By construction up to 5% of runs may sit
  above p95. At 25 samples p95 is the second-largest value, so one pathological run in twenty does
  not fail on its own. The runner therefore prints `max` beside `p50`/`p95`: a one-off pause stays
  visible even when the budget holds.
- **The estimator needs samples to mean anything.** With 19 or fewer samples p95 is simply the
  largest value; at 20 it is the second-largest. Each scenario is run 25 times for that reason.

An empty sample set returns zeros for all three, so a scenario that measured nothing cannot look
instant: the runner also checks that every budgeted scenario produced at least one sample, and fails
when one did not.

### Why p95 and not the mean

A reader does not feel the average; it feels the slow call, and the mean is exactly the statistic
that dilutes it. `assertBudget` compares a row's p95 against its budget, and the unit test that
holds this down is a run where the **mean** sits inside the budget and the **p95** does not
(`tests/perf.test.ts`, "compares p95, not the mean"). The mean is not computed anywhere in
`perf.ts`, on purpose.

### The workload

One deterministic document, generated from a fixed seed (`mulberry32`, seed `0x5eed`), so two runs
differ only by the machine:

| Property | Value |
| --- | --- |
| Pages | 40 |
| Blocks | 1,200 (30 per page, ids `p{page}-b{rank}`) |
| Text | ~327 K characters |
| Structure | a heading at the first slot and every ninth after it; a table at every twenty-fifth rank; paragraphs elsewhere, and those at every seventh rank carry an inline `$...$` formula, so `formulas.ts` segmentation is exercised |

Five scenarios run over it, each `WARMUP_RUNS = 3` times unrecorded and `SAMPLED_RUNS = 25` times
through the recorder:

| Scenario | What it calls | What it produces |
| --- | --- | --- |
| `chunk 1,200 blocks` | `retrieval.chunkDocument(document)` | 541 passages (section/table/prose chunking) |
| `index passages` | `retrieval.index(passages)` | 237 index terms (BM25 inverted index) |
| `search 3 queries` | `retrieval.search(index, query, { limit: 10 })` × 3 | ranked hits per query |
| `diff 2 revisions` | `diff.diffDocuments(before, after)` | 60 changed, 1 moved, 1 removed, 1,138 unchanged blocks |
| `cer 100 words` | `ocr-metrics.characterErrorRate(reference, hypothesis)` | Levenshtein DP over 851 characters, every 37th character wrong |

The revised copy is built deterministically too: every twentieth block edited (similarity above the
change threshold, so the word-level diff runs), one block deleted, one moved to the last page. That
covers all four change kinds, which is the path that costs something.

The **bundle** check is separate: every `.js`, `.mjs` and `.css` file under `dist/web/assets`,
recursively, counted in raw bytes with gzip reported beside it. It is the output of the last
`pnpm build`, not of this script (see [How to run](#how-to-run)).

## Budgets and their rationale

The budgets are the `BUDGETS` constant at the top of `scripts/perf-budget.mjs`; this table is the
same set with the reasoning. The shared rule of thumb was
`budget ≈ max(2.5–3 × measured p95, absolute floor)`, with a different floor where the absolute
number matters more than the ratio.

| Budget key | Baseline p95 | Budget | Headroom | Why this number |
| --- | --- | --- | --- | --- |
| `chunk 1,200 blocks` | 3.0 ms | 15 ms | 5× | Chunking runs when a document opens. Loose in absolute terms, far below the hundreds of ms an accidental superlinear pass would cost. |
| `index passages` | 9.2 ms | 25 ms | 2.7× | Rebuilt on open/refresh. 2.7× absorbs a machine busy with a hook's build while still failing a 3× regression. |
| `search 3 queries` | 0.9 ms | 10 ms | ~11× (floor) | The keystroke path. Below ~10 ms the measurement is mostly noise, so the floor is absolute rather than relative. |
| `diff 2 revisions` | 9.7 ms (worst 13.9 across runs) | 40 ms | ~3.7× worst | Runs on a document pair, not per keystroke. Its slow path is document-wide similarity scoring, which would be seconds, not milliseconds. |
| `cer 100 words` | 9.0 ms (p50 2.0) | 20 ms | 2.2× | The p50/p95 gap is an allocator pause (two DP rows per call), not the algorithm. 20 ms clears the pause; a full matrix instead of two rows is ~100× slower and would fail. |
| `web js+css` | 2,951.3 KiB raw (1,050.9 gzip) | 3,200 KiB | +8% | The pdf.js worker (1,203 KiB) and fontkit (700 KiB) dominate. +8% fits a small feature; it does not fit another bundle-sized dependency. |

Every baseline number above was measured on the machine and at the commit state described in
[Measured baseline](#measured-baseline). If you change the corpus, the baseline is void and the
budgets have to be re-derived from a fresh run; the runner's output prints the corpus shape so a
mismatch is visible.

## How to run

```powershell
node scripts/perf-budget.mjs            # the gate: table plus PASS/FAILED
node scripts/perf-budget.mjs --json     # the same report, machine-readable
node scripts/perf-budget.mjs --help
```

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Every budget met. |
| 1 | A budget exceeded, or a budgeted scenario produced no samples. The `OVER` lines name the row, the measured p95 and the budget. |
| 2 | The script could not run (Node too old, a core module failed to import, bad arguments). |

Requirements: **Node 22.18 or newer** (native TypeScript type stripping) and **22.15 or newer**
(`module.registerHooks`). The runner loads the shipped `src/core/*.ts` directly, through a resolve
hook that adds the extension Node's ESM resolver insists on; the repository's imports are
extensionless by convention. This is the same path `scripts/ocr-benchmark.mjs` takes when it loads
`src/core/ocr-metrics.ts`, which needs no hook only because that module imports nothing.

The script **does not run `pnpm build`**: a hook runs the build first, and a build inside the gate
would blow the time budget for no new information. The consequence is explicit in the output: with
no `dist/web/assets` the size row prints `not built`, and the verdict says
`bundle size not checked (no build)` rather than inventing a pass. Run `pnpm build` yourself before
the script whenever you want the size row to mean something.

Runtime, measured: **0.65 s total** (654 ms in the baseline run, of which the bundle's gzip is a
visible share). That is well inside the 30 s a pre-push hook can afford.

Wiring, deliberately not done here: `scripts/pre-push.ps1` currently runs typecheck, tests, the
committed-import check and `pnpm build`. Because the build comes last, a natural hook point is one
more step after it: `Step 'performance budgets' { node scripts/perf-budget.mjs }`. That file is
outside this change's lane, so the wiring is left to whoever owns the hook; until then this is a
command a person runs, and the budgets still fail a regression when it is run.

## Measured baseline

Actual output of `node scripts/perf-budget.mjs`, pasted unchanged:

```text
Performance budgets - Node v24.15.0, 2026-11-20T16:36:25.877Z
Corpus: 40 pages, 1200 blocks, 327 K chars, deterministic seed
Work:   541 passages, 237 index terms, diff 60 changed / 1 moved / 1 removed / 0 added / 1138 unchanged
Runs:   3 warm-up + 25 sampled per scenario (654 ms total)

scenario             n  p50 ms  p95 ms  max ms  budget  result
------------------  --  ------  ------  ------  ------  ------
chunk 1,200 blocks  25    1.77    3.02    3.56   15.00      ok
index passages      25    8.50    9.18    9.25   25.00      ok
search 3 queries    25    0.62    0.89    1.09   10.00      ok
diff 2 revisions    25    8.62    9.72   11.32   40.00      ok
cer 100 words       25    2.03    8.96    8.97   20.00      ok

artifact                files  raw KiB  gzip KiB    budget  result
----------------------  -----  -------  --------  --------  ------
dist/web/assets js+css      7   2951.3    1050.9  3200 KiB      ok

Bundle built 2026-11-20T16:18:59.469Z (newest asset mtime).

PASS: 6/6 budgets met (p95 timing, bundle size).
```

Context for that run:

| | |
| --- | --- |
| Run at | 2026-11-20 23:36 Asia/Saigon (16:36Z) |
| Node | v24.15.0 |
| Machine | Intel Core i7-11800H @ 2.30 GHz, 16 GB RAM, Windows 11 build 22621 |
| Bundle | the `dist/web` from `pnpm build` at 23:18 Asia/Saigon, 7 JS/CSS files |
| Package manager | pnpm 10.33.2 |

The table is a measurement of *this* combination. A slower machine, a loaded machine or a cold
process cache will show different milliseconds; the budgets have enough headroom for a loaded
machine, not for a machine an order of magnitude slower. If CI hardware turns out to be much slower,
raise a budget **with a measured baseline** rather than pre-emptively: a budget nobody can hit is
the same as no budget.

## What fails, and what does not

| Situation | Result |
| --- | --- |
| A p95 above its budget | Exit 1, one `OVER {scenario}: p95 X ms > Y ms budget` line per miss, `FAILED: n/m timing budgets met`. |
| A scenario stops recording (renamed key, thrown import) | Exit 1, `No samples for: ...`. `assertBudget` alone would pass, which is why the runner checks coverage itself. |
| The bundle grows past 3,200 KiB | Exit 1, `OVER dist/web/assets: X KiB > 3200 KiB budget`. Verified by forcing the ceiling to 1,000 KiB for one run: the runner printed the `OVER` line and exited 1. |
| No `dist/web` at all | Size row `not built`, verdict `PASS: n/n timing budgets met; bundle size not checked (no build)`. Not a failure: the hook builds first. |
| A GC pause inside `cer` | p95 can rise from ~2 ms to ~9 ms; the 20 ms budget holds. A real 2× regression (~18 ms p50) would fail. |
| A single pathological run among 20 | Does not fail on its own: p95 excludes the top 5%. It is visible as `max` in the table, and two slow runs in twenty do fail. |

## Limits, and what this does not prove

- **The corpus is synthetic.** It exercises the paths that scale (section chunking, BM25 index
  build, ranking, block alignment, edit distance) and it is a tripwire for a change that makes a
  core function quadratic. It is not a real document: no PDF parsing, no PDF.js, no OCR engine, no
  network. A real-page number needs a fixture (backlog N03) and the broader N07 metric set.
- **Not measured here:** startup time, OCR throughput, translation round-trip, export, memory,
  VRAM, and anything that needs a DOM or a browser. Those need a different harness; this one runs
  headless in Node against pure functions, which is exactly why it is fast enough for a hook.
- **One machine, one run each.** There is no CI variance study and no cross-platform baseline. The
  budgets are tripwires, not service-level objectives.
- **The bundle check is a size tripwire, not a performance measurement.** A 2.9 MB bundle can still
  be slow, and a smaller one can be slower.
- **`dist/web/assets` only.** The check excludes `dist/web/ocr` (tesseract wasm loaders and
  language data, tens of MB, lazily fetched), the bundled fonts, `sample.pdf`, and the packaged
  native release under `dist/pdf-workspace-*`. Those are assets, not the app's JavaScript.
- **Measurement overhead is real but small.** A span reads the clock twice; per-call overhead is
  well below the scenarios measured here (the fastest scenario, `search 3 queries`, is ~0.9 ms for
  three queries). Do not use `span` to time sub-microsecond work.
