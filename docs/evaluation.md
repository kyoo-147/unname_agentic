# Evaluation harness: measured answers instead of remembered ones

Date: 2026-11-21 (Asia/Saigon). Backlog: I12 — a fixed set of cases, an injected runner, and
grades that say which case failed and why.

Files:

- `src/core/eval-harness.ts` — `defineCase`, `runEvals`, `abstentionAccuracy`, `citationHitRate`,
  `rate`, and the shipped case set `SHIPPED_EVAL_CASES`.
- `tests/eval-harness.test.ts` — the pass and fail rules, the validation gates, the metrics,
  the null-over-zero rule, and a reference runner that passes the shipped set.
- This document — what a case is, how to add one, the metrics, the shipped set, and the limits.

## What this is, and what it is not

**Is:** a case format that refuses to be ambiguous, a runner injected by the caller, one result per
case with a stable list of failure reasons, a summary, and two quality metrics. It is the smallest
thing that turns "the answers feel better" into a number somebody else can reproduce.

**Is not:** a benchmark of the answer pipeline on real documents. **No runner is wired into the
application in this change, and the shipped case set is small and synthetic** — four cases about a
fictional Aurora M4 battery module, written by us to exercise the format. A pass rate over that set
is a smoke test of the harness and of the pipeline's plumbing, not a quality claim about the
product, and it is not a sample of what real PDFs will ask. The next honest step is a runner over
the app's answer path and cases recorded from real documents; until that exists, `docs/metrics.md`
records performance numbers in the same spirit, and neither document should be quoted as proof that
the product works.

What it is not, more specifically: it does not generate cases, resolve citations against the
Document IR (a case has context excerpts, not geometry), grade prose beyond the phrases a case
lists, or measure latency, tokens or cost.

## What a case is

A case is a question, the excerpts a runner is given, and what a correct outcome looks like.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Join key between a case and its result. Non-empty, no leading or trailing whitespace. |
| `question` | `string` | The question, verbatim, handed to the runner. |
| `context` | `EvalContextBlock[]` | Excerpts: `{ page, text, blockId? }`. `page` is 1-based; `blockId` is optional but needed if a case expects a block citation. |
| `expected.kind` | `'answer' \| 'abstain'` | What the runner has to do. |
| `expected.mustContain` | `string[]?` | Phrases the answer must contain. |
| `expected.citations` | `string[]?` | Citation markers the answer must carry. Empty for an abstention. |

`defineCase` is the only constructor, and it normalises (phrases and markers are trimmed, the
context is copied) while refusing the ways a case can be meaningless:

| `EvalHarnessError.code` | Refusal | Why it is an error |
| --- | --- | --- |
| `invalid-id` | Blank id, padded id, non-string. | The id joins a case to its result. `"a"` and `" a"` print the same and join differently. |
| `invalid-question` | Blank question. | Nothing to ask. |
| `invalid-context` | Not an array; a block without a 1-based integer `page` or with empty `text`; a blank `blockId`; an answerable case with no context at all. | An answer with no excerpt is unearned: every phrase and citation would be unverifiable. |
| `invalid-expectation` | Unknown `kind`; a blank phrase; an answerable case that asserts no phrase and no citation; an abstention that lists citations. | A case that passes on any prose inflates a pass rate. An abstention has no answer, so a citation expectation there can never resolve. |
| `invalid-citation` | A citation string that is not exactly one marker. | `p12` is not a marker, and `[p2] [p3]` is two; a case must name one target at a time. |
| `unresolved-citation` | A marker naming a page the case context lacks, a block id the context never declares, or a block on a different page. | A case may not ask the runner to cite evidence it was never shown; that case would fail every run and teach nothing. |

Two more codes belong to the run rather than to a single case: `duplicate-id` (an id seen twice in the
set, refused before the runner is called, because results are joined on the id) and `invalid-runner`
(`runEvals` was given no function).

Citations use the marker syntax `src/core/citations.ts` already parses — `[p12]`, `[p12:r3]`,
`[#p12-r3]`, `(trang 12)`, `[[cite:{"page":12}]]` — so the harness grades the syntax the app
resolves, and a second grammar cannot drift from the first.

## How to add a case

1. Write the case with `defineCase` and append it to `SHIPPED_EVAL_CASES` if it belongs to the
   shipped set, or pass your own array to `runEvals`.
2. Point the expected citation at a page or block the case's own context carries.
3. Add the runner at the call site. It receives `(question, context)` and returns
   `{ answer, citations?, abstained? }`; it may be synchronous or asynchronous.

```ts
import { defineCase, runEvals } from './core/eval-harness';

const cases = [
  defineCase({
    id: 'manual-charge-time',
    question: 'How long does a full charge take?',
    context: [{ page: 12, blockId: 'p12-r3', text: 'A full charge takes four hours.' }],
    expected: { kind: 'answer', mustContain: ['four hours'], citations: ['[p12]'] },
  }),
];

const run = await runEvals(cases, async (question, context) => {
  // The app's answer path goes here. This change ships no runner.
  const result = await askThePipeline(question, context);
  return { answer: result.text, citations: result.markers, abstained: result.abstained };
});

console.log(run.summary.passRate); // a number in 0..1, or null over zero cases
```

A runner for the shipped set is what `tests/eval-harness.test.ts` contains: a table of canned
answers, so the case set is verified as a set rather than trusted.

## How a case is graded

A case passes only when `reasons` is empty.

- **Phrases.** Matching collapses runs of whitespace to one space, trims, and folds case. Diacritics
  are preserved, so `hai năm` and `hai nam` are different strings — losing a mark is a content
  error, not typography. A line-wrapped or upper-case answer still matches.
- **Citations.** Every expected marker must be resolved by a marker the answer carries, either
  written into the answer or listed in the runner's `citations` array. A page expectation (`[p2]`)
  is met by any citation on page 2, including a block citation (`[p2:r1]`). A block expectation
  (`[#p2-r1]`) needs that block id and is *not* met by a page-only citation: the block is the
  stronger identity. Answers may carry extra citations; they are not graded.
- **Abstention.** An answerable case fails with `empty-answer` when the answer has no text, and
  with `unexpected-abstention` when the runner declares `abstained: true` but still wrote prose. An
  unanswerable case passes on either form of abstention and fails with `answered-unanswerable`
  otherwise. A runner that throws fails with `runner-error` — a crash is never an abstention.
- **Order and detail.** `reasons` is ordered `runner-error`, then the abstention reason, then
  `missing-phrase`, then `missing-citation`. `missingPhrases` and `citations.missing` name exactly
  what was absent, so a failing case is diagnosable without re-running it by hand. When an
  answerable case gets no answer at all, only the abstention reason is reported; the two detail
  lists still carry everything the answer did not contain.

A runner that throws or returns a non-candidate fails that one case and the run continues, so a
single broken provider call does not hide the other results.

## The metrics

All three rates share one rule, `rate(part, total)`:

| Measure | Numerator / denominator | Zero cases |
| --- | --- | --- |
| `summary.passRate` | passed cases / total cases | `null` |
| `abstentionAccuracy(cases, results)` | unanswerable cases that abstained / unanswerable cases present in `results` | `null` |
| `citationHitRate(results)` | expected citations resolved / expected citations across all results | `null` |
| `rate(part, total)` | `part / total`, rounded to three decimals | `null` |

**A rate over zero cases is `null`, not `0`.** "No case measured this" and "every case failed" are
different claims, and only the second is evidence: printing `0%` for an empty run would turn the
absence of a measurement into the worst possible result. Callers check for `null` before drawing a
number, and a report that shows `0` means one case was run and it failed.

`abstentionAccuracy` grades only unanswerable cases. Over the mixed set in the tests (two
unanswerable cases, one of them answered anyway, plus two answerable cases, one of them wrongly
abstained on) it is `1 / 2 = 0.5`; the answerable abstention is a failed result in `runEvals`, not a
fall in this rate, because counting it here would let good abstention hide bad answers.

`citationHitRate` is a micro-average over expected citations, not over cases: a case that asks for
two and gets one contributes one hit out of two. A runner error or an abstention contributes its
expectations with nothing resolved, because no citation was produced.

A run over the shipped set with the reference runner reports:

| Case | Result | `reasons` |
| --- | --- | --- |
| `aurora-charge-time` | pass | — |
| `aurora-operating-range` | pass | — |
| `aurora-vi-warranty` | pass | — |
| `aurora-water-damage` | pass (abstained) | — |

`summary` is `{ total: 4, passed: 4, failed: 0, passRate: 1 }`; `abstentionAccuracy` is `1` and
`citationHitRate` is `1`. That is the whole claim: four synthetic cases grade as designed. It says
nothing about answers over a real battery manual, or any other document.

## The shipped case set

Four cases, one unanswerable, all written by hand:

| Id | Question | Expected |
| --- | --- | --- |
| `aurora-charge-time` | How long does a full charge of the Aurora M4 take? | Answer contains `four hours`, cites `[p2]`. |
| `aurora-operating-range` | What is the operating temperature range of the Aurora M4? | Answer contains `-20 °C` and `60 °C`, cites block `p3-r2` (`[#p3-r2]`). |
| `aurora-vi-warranty` | Bảo hành của Aurora M4 kéo dài bao lâu? | Answer contains `hai năm`, cites `(trang 5)`. |
| `aurora-water-damage` | Does the Aurora M4 warranty cover water damage? | Abstains. Nothing in the context says. |

They are synthetic on purpose: real documents carry the ambiguity the harness has to survive, and
none is checked in yet. The set stays small and synthetic until real documents are added — that is
the honest status of this harness, not a placeholder to forget. Adding one is the change that makes
the set worth quoting.

## Limits, stated plainly

- **Presence, not correctness.** A citation is graded by its target, not by whether the cited page
  supports the sentence. `citations.ts` resolves against a document; this harness has no Document
  IR, so it cannot. A real citation-resolution eval needs the IR and a case format that carries it.
- **Shallow prose grading.** `mustContain` is substring matching after whitespace and case folding:
  it catches a dropped figure, a changed unit and a missing term, and it catches nothing about
  negation, hedging or an answer that is wrong in a phrase it does not list. `qa.ts` is the deeper
  translation review; this is not a substitute.
- **Small and synthetic.** Four cases, no real PDFs, no runner wired. See the paragraph above.
- **No cost or latency.** A runner that takes a minute per case is not penalised here; `metrics.ts`
  and `docs/performance.md` own those numbers.
- **One runner, one set.** The harness says nothing about a different model, prompt or retrieval
  configuration until the same set is run against it and the two summaries are compared.

## Running it

```sh
pnpm vitest run tests/eval-harness.test.ts
pnpm typecheck
```
