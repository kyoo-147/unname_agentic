# OCR benchmark: CER and WER

Date: 2026-11-20 (Asia/Saigon). Backlog: N05 — make OCR quality measurable instead of asserted.

Status: the metrics, the runner and the fixture format are in place. There is **no checked-in
benchmark fixture yet**, so the results table at the end is empty on purpose. Nothing here is a
quality claim about the shipped OCR until that table has rows produced by the runner.

Files:

- `src/core/ocr-metrics.ts` — CER, WER and the word alignment, pure functions, no DOM or engine.
- `tests/ocr-metrics.test.ts` — the counting rules, including diacritics and whitespace.
- `scripts/ocr-benchmark.mjs` — the runner that reads fixtures and prints the table.
- This document — definitions, fixture format, how to run, and where results go.

## What is measured, and what is not

Measured per fixture: PDF page count, characters recognised, character error rate (CER) and word
error rate (WER) against a hand-checked transcript.

Not measured here: layout and reading order, table structure (TEDS), confidence calibration,
throughput, or translation quality. A low CER says the characters are right, not that the blocks
landed in the right order or that a table survived as a table.

## Metric definitions

Both rates compare normalised text and report `{ errors, total, rate }`:

- CER = Levenshtein distance in characters / characters in the reference.
- WER = Levenshtein distance in words / words in the reference. A substitution, an insertion and a
  deletion each cost 1, and `alignWords` returns that edit script.

Normalisation, applied to the reference and the hypothesis alike:

1. Unicode **NFC**. A precomposed `ế` and a decomposed `e` + circumflex + acute are the same
   character, so a recogniser cannot be scored differently because of how it serialised bytes.
   Diacritics are never stripped: losing one costs a whole character, which is what makes the
   Vietnamese number meaningful.
2. Any run of whitespace collapses to one space, and the edges are trimmed.
3. The remaining single spaces count as characters and separate words.
4. Distances are measured in code points, so an astral glyph counts once, not twice.

Empty text has no division to do, so the rule is explicit: an empty reference with an empty
hypothesis is `{ errors: 0, total: 0, rate: 0 }`, while an empty reference that met non-empty text is
`{ errors: <inserted characters>, total: 0, rate: 1 }` — every character was an insertion. A
non-empty reference with an empty hypothesis is always rate 1.

`rate` is not clamped: a short reference can be swamped by insertions, so `"a"` against `"abcdef"`
is `5 / 1 = 5.0`. Read a rate above 1 as "the engine invented much more text than the page had".

Worked numbers, all from the shipped module:

| reference | hypothesis | CER | WER |
| --- | --- | --- | --- |
| `SCANNED PAGE` | `SCANNED PAGE` | 0 / 12 = 0 | 0 / 2 = 0 |
| `abcdefghij` | `abcdefghiX` | 1 / 10 = 0.1 | 1 / 1 = 1 |
| `kitten` | `sitting` | 3 / 6 = 0.5 | 1 / 1 = 1 |
| `kitten` | `` (empty) | 6 / 6 = 1 | 1 / 1 = 1 |
| `Hà Nội` | `Ha Noi` | 2 / 6 = 0.3333 | 2 / 2 = 1 |
| `the quick brown fox` | `the slow brown cat` | 8 / 19 = 0.4211 | 2 / 4 = 0.5 |
| `a b` | `ab` | 1 / 3 = 0.3333 | 2 / 2 = 1 |

The whitespace row is deliberate: `a b` and `ab` are different text, so the lost space is charged,
while `hello   world` against `hello world` scores zero.

`alignWords` returns the script above one step at a time:

```js
alignWords('a b c', 'a x c d').ops
// [ { op: 'match', reference: 'a', hypothesis: 'a' },
//   { op: 'substitute', reference: 'b', hypothesis: 'x' },
//   { op: 'match', reference: 'c', hypothesis: 'c' },
//   { op: 'insert', hypothesis: 'd' } ]
```

Known limit: NFC unifies composition, not Vietnamese tone placement. `hòa` and `hoà` are both
accepted spellings and are not the same code point sequence, so that three-character word scores
`CER 2 / 3 = 0.6667` and `WER 1 / 1` against the other spelling. Keep the transcript in the spelling
the page actually uses; do not "fix" it, and do not be surprised by that entry in the report.

## Fixture format

The runner takes a directory of pairs — one directory per corpus is enough to start:

```text
tests/fixtures/ocr-bench/            # default --fixtures value
  scanned-page.pdf                   # required: the source document
  scanned-page.expected.txt          # required: hand-checked transcript, UTF-8
  scanned-page.pages/                # optional: page renders, page-01.png, page-02.png, ...
    page-01.png
  scanned-page.actual.txt            # optional: text from a real run of the app
```

- `{name}` is the PDF stem; every companion file repeats it.
- `{name}.expected.txt` is the truth. Transcribe the whole document in reading order, one page after
  another; blank lines between pages are fine because whitespace normalises. Keep the page's own
  spelling, diacritics, punctuation and digits — including mistakes in the source, which are part of
  what OCR has to reproduce.
- `{name}.pages/*.png` is the engine path. Any rasteriser is fine; order is by filename using numeric
  comparison, so `page-01.png`, `page-02.png`, `page-10.png` sort correctly. Render the full page at a
  resolution where the smallest body text is still legible — about 300 dpi for A4/Letter. Grayscale
  or colour both work; the runner passes the file through untouched.
- `{name}.actual.txt` is the manual path: the text a real app run produced, saved as plain UTF-8.
  This is what makes the benchmark runnable today, without a rasteriser.

Keep fixtures small: one to three pages and well under ~2 MB each. The runner is text-only, so a
dense 50-page scan buys nothing but a slow edit distance. If a real-world scan is too big to commit,
point `--fixtures` at an untracked directory and paste only the resulting row into this document.

Aim for coverage rather than volume: one Vietnamese scan, one born-digital English PDF rendered to
images, and one mixed page (text layer plus a scan stamp), if you add a third. Two languages already
show whether a change helped one and hurt the other.

## How to run it

```powershell
# whole fixture directory, table output
node scripts/ocr-benchmark.mjs

# explicit directory and language list
node scripts/ocr-benchmark.mjs --fixtures tests/fixtures/ocr-bench --lang vie+eng

# machine-readable rows for a script or a CI archive
node scripts/ocr-benchmark.mjs --fixtures tests/fixtures/ocr-bench --json

# what the runner does and does not do
node scripts/ocr-benchmark.mjs --help
```

Requires Node 22.18+ so the runner can import `src/core/ocr-metrics.ts` directly (this checkout runs
Node 24). On an older runtime, pass `--metrics <compiled module>` with the same exports. The OCR path
needs `node_modules` installed (`tesseract.js`, `pdfjs-dist`) and the vendored language data in
`public/ocr`; no network request is made, and no app or server has to be running.

Where the recognised text comes from, in order:

| source | how it is produced | when it is used |
| --- | --- | --- |
| `engine` | `{name}.pages/*.png` OCR'd by the runner with `tesseract.js` and the `public/ocr` traineddata | page renders exist and the engine ran |
| `manual-run` | `{name}.actual.txt` you exported from a run of the app | no page renders, or the engine failed |
| `no text` | nothing to read | neither exists: the row prints dashes, and the command exits 3 when no fixture at all could be measured |

The runner drives the same engine and traineddata as the app: `Tesseract.createWorker(lang,
Tesseract.OEM.LSTM_ONLY, { langPath: public/ocr, gzip: false })`, the shape `createTesseractEngine`
uses in `src/ocr/engine.ts`, with `eng+vie` — the app's `DEFAULT_OCR_LANGUAGES` — unless `--lang`
says otherwise. It does not run the app's pipeline around the engine: no pixel preprocessing, no
confidence filtering, no block merging, no geometry. Total page text is compared as one document, so
one bad page is diluted by the characters around it rather than reported per page. The one
deliberate difference is `cacheMethod: 'none'`, so a benchmark run leaves no engine cache behind.

`--json` prints one object, `{ fixtures, languages, metrics, rows, measured }`, where each row is
`{ name, pages, chars, cer, wer, source, note }`; `pages`, `chars`, `cer` and `wer` are `null` when
they were not measured, and `cer`/`wer` are the same `{ errors, total, rate }` the module returns.
The table and the JSON come from the same rows, so they cannot disagree.

What the runner cannot do: **rasterise a PDF**. `pdfjs-dist` needs a canvas to produce pixels and the
repository has no Node canvas, so the PDF→image step is yours. Page counts are still read from the
PDF, so a fixture with only the PDF and the transcript already reports `pages` and spells out which
files are missing; `chars` and the rates need text. Some options for the missing step:

- any external rasteriser, e.g. `pdftoppm -r 300 -png scanned-page.pdf scanned-page.pages/page`,
  which produces `page-1.png`, `page-2.png`, ... (rename to zero-padded `page-01.png` if you want
  clean numeric order past nine pages), or ImageMagick's `magick -density 300 scanned-page.pdf ...`;
- the app itself: run scan OCR on the document and save the recognised text as
  `{name}.actual.txt` — that measures what the app does, which is what a user experiences, at the
  cost of being manual.

Exit codes: `0` a report was produced (including the documented "no fixture yet" state), `2` bad
usage or an explicit `--fixtures` directory that does not exist, `3` fixtures exist but none could be
measured. The pre-push hook runs the unit tests (including `tests/ocr-metrics.test.ts`) but not this
script: it is a measurement tool, not a gate.

## Smoke check (not a benchmark row)

The runner was exercised on a throwaway directory built from the existing single-page fixture:
`tests/fixtures/scanned-page.pdf` plus `tests/fixtures/scan-page.png` copied to
`scanned-page.pages/page-01.png`, with `scanned-page.expected.txt` transcribed from the four lines
drawn on that page. Then:

```powershell
node scripts/ocr-benchmark.mjs --fixtures $env:TEMP\ocr-bench-smoke
```

```text
Fixtures: C:/Users/hoang/AppData/Local/Temp/ocr-bench-smoke (1 pair(s)), languages: eng+vie

name          pages  chars     CER     WER  source
------------  -----  -----  ------  ------  ------
scanned-page      1    107  0.0000  0.0000  engine

Measured 1/1: 1 by the engine, 0 from a manual run.
A dash is not a measurement. "engine" rows use tesseract.js on {name}.pages/*.png with public/ocr traineddata;
"manual-run" rows use {name}.actual.txt exported from the app. See docs/ocr-benchmark.md.
```

The transcript is the four lines drawn on `tests/fixtures/scan-page.png`, so CER 0 proves the wiring,
not the OCR quality: a screenshot with clean synthetic text is the easiest possible input. This run
is not a benchmark row and is not repeated in the table — the directory is in the temp folder and is
not checked in.

The other states were exercised the same way: an empty directory prints the documented empty state
and exits 0, a pair with no renders and no `actual.txt` prints dashes and exits 3, and an
`actual.txt` with one word changed scores `CER 6/107 = 0.0561`, `WER 1/17 = 0.0588` — the same counts
the module returns when called directly.

## Results

One row per fixture per engine version and language list. No rows yet: the repository has OCR
fixtures for other tests (`tests/fixtures/scanned-page.pdf`, `tests/fixtures/scan-page.png`,
`tests/fixtures/mirror-field-notes.pdf`) but no `{name}.pdf` + `{name}.expected.txt` benchmark pair,
so there is nothing to report.

| fixture | pages | chars | CER | WER | source | languages | engine | date |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _no fixture yet_ | – | – | – | – | – | – | – | – |

Recording a run — paste the runner's numbers, never a hand-computed rate:

1. Build the fixture as above and run `node scripts/ocr-benchmark.mjs --fixtures <dir>`.
2. Copy the row into the table and fill in the metadata: language list, `tesseract.js` version from
   `package.json`/lockfile (`^7.0.0`, 7.0.0 installed at the time of writing), Node version, and the
   date in `YYYY-MM-DD` form.
3. Keep old rows when the engine, the traineddata or the normalisation changes — the point of the
   table is the delta over time. A row whose fixture was edited is a new row; note the edit.
4. Rows with `no text`, `?` pages or dashes stay out of the table until they are real measurements.

A filled row looks like this (template, not measured):

```text
| scanned-page | 1 | 107 | 0.0000 | 0.0000 | engine | eng+vie | tesseract.js 7.0.0 | 2026-11-20 |
```

## Limits worth remembering

- Text only. Reading order, column detection and table structure need their own metrics; CER cannot
  see a paragraph that landed on the wrong page.
- Whole-document edit distance is O(n·m) in characters: about 13 ms for 2,000 characters and 240 ms
  for 10,000 on this checkout, so a 50,000-character document is a few seconds, not a blur. Split a
  corpus into per-document fixtures instead of growing one.
- The runner's numbers come from `tesseract.js` in Node with the repo's traineddata, while the app
  runs the same engine in a browser worker behind its own preprocessing. Treat a runner number as a
  reproducible baseline for the engine, not as a promise about the app's rendered output; record
  `manual-run` rows when the app's own pipeline is what you are judging.
- A single fixture is an anecdote. Two languages and two document types are the floor for claiming a
  change helped.
