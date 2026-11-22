# Command line: run a local batch over a folder of PDFs

Date: 2026-11-21 (Asia/Saigon). Backlog: K04 — process a folder of PDFs in a batch without
opening the app.

Files:

- `src/core/cli-args.ts`: `parseArgs`, `usage`, `describe`, the flag and command tables, the
  exit-code table.
- `scripts/mirror-cli.mjs`: the runner. Reads the folder and starts the local durable runtime.
- `scripts/mirror-cli-entry.ts`: the TypeScript bridge used by the runner for import, classify, OCR boundary, extraction, optional translation and export.
- `tests/cli-args.test.ts`: every parse case, the plan, the drift guard between the two
  copies of the table, and the runner itself, started as a process.
- This document: every command, flag, exit code and example, and the boundary between what
  runs today and what does not.

## What this is, and what it is not

**Is:** a parser plus a local durable runner. A non-dry run polls the input tree, persists the folder snapshot under `<out>/.automation/watch.json`, creates one idempotent job per added or modified PDF, stores an immutable source snapshot, persists checkpoints under `<out>/.automation/state.json`, imports through PDF.js and the existing document runtime, runs classification, leaves OCR-required pages in review unless an OCR adapter is supplied, extracts optional schema fields, optionally translates through the existing local translation service, and writes immutable JSON and Markdown artifacts.

**Is not:** a cloud worker or a fabricated OCR fallback. The CLI authorizes only `--in` and `--out` roots, uses no remote provider in `extract`, and reports review or handler failures instead of silently accepting them. `check` remains a filesystem-only report.

## Commands

| Command | What it does |
| --- | --- |
| `extract` | Run import, classify, OCR boundary, extract and export locally. |
| `translate` | Run the same pipeline and call the configured local translation endpoint. |
| `export` | Run the pipeline and write the immutable JSON/Markdown export artifacts. |
| `check` | Report what `--in` holds. Reads the folder and writes nothing. |

The command may appear anywhere among the flags. A second bare word is a usage error.

## Flags

| Flag | Value | Default | Meaning |
| --- | --- | --- | --- |
| `--in` | `<dir>` | — | Folder of PDFs to read. Required by every command. |
| `--out` | `<dir>` | — | Folder to write into. Refused by `check`, which writes nothing. |
| `--lang` | `<code>` | — | Target language, for example `vi`, `en`, `zh`. Required by `translate`. |
| `--provider` | `<kind>` | app default | Parser accepts `google`, `deepl`, `openai` or `local`; this local bridge executes only `local`. |
| `--offline` | — | off | Never leave this machine. Refused with a cloud provider. |
| `--format` | `<md\|json\|txt>` | `md` | Output shape; also the report shape for `check`. |
| `--dry-run` | — | off | Print the plan and write nothing. |
| `--help` | — | — | Print the help text. |
| `--version` | — | — | Print the version from `package.json`. |

Reading rules, the same in the parser and in the runner:

- `--flag value` and `--flag=value` are the same thing. Values are trimmed.
- A value that begins with `-` is read as the next flag, so `--in` at the end of the line, or
  followed by another flag, is a missing value. Write `--in=--weird` when the value really
  starts with a dash.
- A switch (`--offline`, `--dry-run`, `--help`, `--version`) refuses an `=value`.
- A flag given twice keeps the last value.
- `--help` and `--version` are answered first: a missing `--in` beside `--help` is not an
  error. A flag that cannot be read at all (an unknown flag, a missing value) is still
  reported by the parser, because a parser that ignored it would be lying about what it read;
  the runner answers the help and exits 0 regardless.
- No arguments at all is a request for help, not an error.
- A flag list with no command (`mirror-cli --in docs`) is an error, not help — except empty
  argv, which is help.
- `--lang` is normalised by `src/core/language.ts`: `vi-VN` becomes `vi` and the alias `vn`
  becomes `vi`. A code that is not one of the targets is refused, and `auto` is refused by
  name, because a translation target cannot be "detect".
- `--offline` with a cloud provider is a conflict. `isCloudProvider` in
  `src/core/privacy.ts` decides which providers may reach a remote host: `local` stays on this
  machine, `google`, `deepl` and `openai` do not.
- `--out` with `check` is a conflict rather than an ignored flag.

## Examples

Read a folder and see what is in it:

```sh
node scripts/mirror-cli.mjs check --in docs/pdfs
```

The same folder as one JSON object, with no banner in the way:

```sh
node scripts/mirror-cli.mjs check --in docs/pdfs --format json
```

Plan an extract and touch nothing:

```sh
node scripts/mirror-cli.mjs extract --in docs/pdfs --out build/text --format md --dry-run
```

Plan a translation that never leaves the machine:

```sh
node scripts/mirror-cli.mjs translate --in docs/pdfs --lang vi --provider local --offline --dry-run
```

Ask what the flags are, or which build this is:

```sh
node scripts/mirror-cli.mjs --help
node scripts/mirror-cli.mjs --version
```

A non-dry run executes the durable pipeline and prints its JSON status. Existing failed jobs are
retried once per invocation; review jobs remain review jobs until explicitly approved:

```sh
$ node scripts/mirror-cli.mjs extract --in docs/pdfs --out build/text
{ "command": "extract", "status": { "jobs": [{ "state": "done" }] } }
$ # exit code: 0
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | ok: help, version, dry run, check, or all jobs completed |
| `2` | usage error: unknown command or flag, missing value, unexpected argument, no command |
| `3` | missing required option: `--in`, or `--lang` for `translate` |
| `4` | unsupported value for `--format`, `--provider` or `--lang` |
| `5` | conflicting options: `--offline` with a cloud provider, or `--out` with `check` |
| `6` | the `--in` folder cannot be used: it is missing, is a file, or holds no PDFs |
| `7` | one or more jobs remain in review or failed |

When a line has more than one problem the **first** one decides the exit code, and the order
is fixed: flag problems in argv order, then the per-command requirements, then the conflicts.

`0` to `5` come from `EXIT_CODES` in `src/core/cli-args.ts`; `6` and `7` are runner outcomes
and live in the same table so both files print one list.

## The plan, and what a dry run prints

`describe` returns one line: the command, then `--in`, `--out`, `--lang`, `--provider`,
`--offline`, `--format`, skipping what was not given. The format is always printed because it
is always in effect; `--dry-run` is not printed, because it is how the line was called and not
what the run would do. Values are echoed as given, without shell quoting, so a line whose
values hold a space is for reading rather than for pasting back.

Dry runs print `dry run: `. Executable runs print runtime status JSON instead of a plan.

## Reports

- `--format md` (default) is the dry-run human report. Executable runs print runtime JSON and
  write `<job>.result.json` plus `<job>.report.md` under `--out`.
- `--format json` remains the check report shape. Runtime status is always JSON.
- `--format txt` is one PDF name per line and nothing else.

Only `md` prints prose, so a script can read `json` and `txt` without stripping a banner.

## One table, two copies

`scripts/mirror-cli.mjs` keeps a fast duplicated parse table and delegates non-dry runs to
the TypeScript bridge, while `tests/cli-args.test.ts` reads both files and compares `CLI_COMMANDS`,
`CLI_FLAGS`, `CLI_VALUE_FLAGS`, `CLI_FORMATS`, `PROVIDER_KINDS`, `REQUIRED_FLAGS` and
`EXIT_CODES`. The tables are written one entry per line so that comparison is a read of the
source, not a parser of it.

The help text is rendered from those tables on both sides, so a flag that is accepted is a
flag the help names; a test asserts that too.

Adding a flag is therefore a five-place change: the two tables, the help summary in each
file, this document (the test checks that every flag and every exit code appears here), and a
parse test. Forgetting the runner is the failure the drift guard names first.

## Limits

- The input tree is walked recursively, excluding dot-directories and the existing watcher ignore
  rules. Changes are coalesced before jobs are created.
- Only names ending in `.pdf` count, in any case; every other file is ignored.
- At most 5,000 files and 512 MiB per batch are accepted. A single PDF may be at most 256 MiB.
  Oversized or unreadable inputs are rejected before processing; no placeholder data is created.
- Non-dry runs write only below the authorized `--out` folder and persist state there.
- `extract` never contacts a provider. `translate` uses only the explicit local provider contract;
  cloud providers are refused by the bridge, and an unavailable loopback service fails without
  fabricated translation.
- OCR is an explicit adapter boundary. A scanned page without an adapter is held for review.
- Deleted source files do not delete prior state or artifacts. The durable snapshot records the
  next poll and retries failed jobs without duplicating completed jobs.
- Paths are echoed as given; a path with a space is not shell-quoted in the plan line.
