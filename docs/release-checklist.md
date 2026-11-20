# Release checklist

The release ritual, written down as a gate a script runs: **`node scripts/release-check.mjs`**.
Nothing ships on memory — every row below is either observed by that script or recorded in it,
and every row it cannot observe is named as a limit at the bottom of this page.

- Rules and codes: `src/core/release-gate.ts`
- Runner: `scripts/release-check.mjs`
- Tests for both: `tests/release-gate.test.ts` — `pnpm vitest run tests/release-gate.test.ts`

## Run the gate

```powershell
node scripts/release-check.mjs                  # preflight: cheap checks; the e2e suite is listed, not run
node scripts/release-check.mjs --build --e2e    # the release run: rebuilds, then runs end-to-end
node scripts/release-check.mjs --json           # machine-readable report
```

Flags: `--build` runs `pnpm build` before reading the build output, `--e2e` runs the Playwright
suite instead of listing it, `--json` prints the same report as JSON, `--help` prints usage.

Exit codes: `0` every check passed or only warned, `1` at least one blocker, `2` the runner
itself could not run (a missing module, an unreadable `package.json`). A blocker is never
printed as anything else: when a command fails, the runner records that failure and the table
says so.

## Items

| # | Item | What satisfies it | Exact command |
| --- | --- | --- | --- |
| 1 | Version | `version` in `package.json`, the same string the package name and the checksum are filed under | `node -p "JSON.parse(require('node:fs').readFileSync('package.json','utf8')).version"` |
| 2 | Changelog entry | a heading for that version in `CHANGELOG.md` (e.g. `## 0.1.0`) | `Select-String -Path CHANGELOG.md -Pattern '^## '` |
| 3 | Unit suite | `pnpm test` green; at least one passing unit test is recorded | `pnpm test` |
| 4 | End-to-end suite | at least `E2E_TEST_FLOOR` (40) declared or passing tests | `pnpm exec playwright test --retries=0` |
| 5 | Native suite (warning) | the Rust workspace gate, recorded through `RELEASE_NATIVE_TESTS` (see below) | `pwsh -File scripts/build-windows.ps1 -Action test` |
| 6 | Typecheck | `pnpm typecheck` exits 0 | `pnpm typecheck` |
| 7 | Build output | `dist/web/index.html` and its assets exist, produced by the sources being released | `pnpm build` |
| 8 | Committed imports | every relative import resolves against the files committed at `HEAD` | `node scripts/check-committed-imports.mjs` |
| 9 | Third-party notices | a notice naming every bundled runtime dependency, plus its licence text, under `public/` | `Get-ChildItem public -Recurse -File -Include NOTICE*,LICENSE*,OFL.txt` |
| 10 | Release package | `dist/pdf-workspace-windows-x64-release-<stamp>` and its `.zip` | `pwsh -File scripts/package-native.ps1` |
| 11 | Feature inventory (warning) | `docs/features.md` updated for this release | edit `docs/features.md` |
| 12 | The whole gate | items 1–11 in one command, on the tree that is about to ship | `node scripts/release-check.mjs --build --e2e` |

Items 1–4, 6–10 are blockers; items 5 and 11 are warnings. Item 12 is the gate itself.

## Blocker codes

Each row names the code the report prints, what it means, and the item that clears it. A
blocker stops the release: the script exits 1 and the table marks the row `BLOCKED`.

| Code | What it means | Cleared by |
| --- | --- | --- |
| `version-missing` | no usable version was recorded; a blank or missing version is not a release | item 1 |
| `changelog-missing-version` | no changelog entry names this version, so the release note would be written from memory | item 2 |
| `unit-tests-empty` | the unit suite recorded no passing test — it failed, did not run, or ran nothing | item 3 |
| `e2e-tests-below-floor` | the end-to-end count is below the documented floor; coverage has been lost | item 4 |
| `gate-typecheck-failed` | `pnpm typecheck` did not pass | item 6 |
| `gate-build-failed` | `pnpm build` did not pass, or produced no `dist/web` to ship | item 7 |
| `gate-imports-failed` | a committed file imports a module that is not committed, so a fresh clone cannot build | item 8 |
| `license-notice-missing` | a bundled dependency has no third-party notice; one blocker per dependency, named in the sentence | item 9 |
| `package-artifact-missing` | there is no release package to hand over under a name and a checksum | item 10 |

## Warning codes

Warnings do not change the exit code. They are facts this gate reports and a person decides.

| Code | What it means | Cleared by |
| --- | --- | --- |
| `native-tests-unknown` | no native test count was recorded, or zero were; the Rust surface is outside this gate | item 5 |
| `features-doc-stale` | the feature inventory was not updated for this release; it may describe an older product | item 11 |

## Floors, and where the numbers come from

Both live in `src/core/release-gate.ts` as `E2E_TEST_FLOOR` and `MIN_UNIT_TESTS`; changing one
is a policy change and belongs in the same commit as this page.

- **`MIN_UNIT_TESTS` = 1.** Not a coverage target: zero means the suite did not run, failed, or
  collected nothing, and each of those ships a release with no unit evidence at all.
- **`E2E_TEST_FLOOR` = 40.** The suite declared 49 tests in 15 files at the 2026-11-20 audit
  (`docs/features.md`). The floor sits about a fifth below that, so a legitimate merge of a few
  specs does not fail the gate while losing a whole file of journeys does. It is a floor on the
  *count*, which is the only thing a runner measures without a browser matrix: a tripwire
  against coverage disappearing, not proof that what remains is good.

## Recording the native test count

This gate does not run the Rust workspace: it needs an MSVC developer environment, and a
native failure is not a reason to hold a JavaScript release that has nothing to do with it. Run
the native gate, then pass its count in when you run the script:

```powershell
pwsh -File scripts/build-windows.ps1 -Action test
$env:RELEASE_NATIVE_TESTS = '92'   # the passing count the run above printed
node scripts/release-check.mjs --build --e2e
```

Without that variable the row reads "not recorded" and the report carries the
`native-tests-unknown` warning — which is the honest state, not a failure.

## How the runner fills each field

Nothing is guessed:

- **Counts** are parsed from the output of the command that produced them. `pnpm test` must exit
  0 for its passing count to be recorded; when it fails, the row prints the real numbers and the
  gate input records `0`, because a release does not rest on a red suite. `--e2e` parses the
  passing count of a real run; without it, the row is the count `playwright test --list` reports
  and is labelled "declared".
- **The build gate** is the output, not a memory: `dist/web/index.html` and at least one asset
  under `dist/web/assets`. `--build` runs `pnpm build` first and records a failure if it fails.
- **The release package** is a `dist/pdf-workspace-*-release-*` directory or archive, newest by
  modification time.
- **The notices** are the files under `public/` whose names look like a notice or a licence; each
  runtime dependency in `package.json` must be named in one of them (`pdfjs-dist` is named as
  "pdf.js" in the notice text).
- **The changelog** is `CHANGELOG.md` containing the version as a whole token.
- **The feature inventory** is a timestamp proxy: `docs/features.md` must not be older than the
  newest file under `src/`, `extension/` or `tests/`. The gate warns rather than blocks precisely
  because a timestamp is a proxy no person has confirmed.

## Known state on 2026-11-20

The gate was written on a tree that had never been asked these questions, and on its
first run it named three real gaps. They are recorded here so a red run is not mistaken
for a broken script; re-run the gate, it is the current answer.

- `changelog-missing-version` — there is no `CHANGELOG.md` in the repository at all.
- `license-notice-missing` (twice) — `pdf-lib` and `@pdf-lib/fontkit` are bundled into the
  web reader (`src/export/pdf.ts`, `src/export/fonts.ts`, `src/export/searchable.ts`) and
  `public/third-party/NOTICE.txt` names neither. Both are MIT; `pdf-lib` ships its text at
  `node_modules/pdf-lib/LICENSE.md`, and `@pdf-lib/fontkit` (a fork of foliojs/fontkit)
  declares the licence in its `package.json` without shipping a text file. Copy the first,
  and write the second's attribution, in the way `LICENSE-pdfjs.txt` was copied.

## What this gate does not cover

Named here so nobody reads a green run as more than it is:

- It does not run the native suite (item 5) and does not verify that any recorded number is true.
- The preflight lists the end-to-end suite instead of running it; a release run must pass `--e2e`.
- It does not run the performance budgets (`node scripts/perf-budget.mjs`), the artifact structure
  gate (`pwsh -File scripts/verify-release.ps1`), or any signing step.
- It says nothing about translation quality, OCR accuracy, or whether the changelog entry is
  honest — only that one exists.
