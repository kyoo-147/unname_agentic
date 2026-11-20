# Command line: plan a batch over a folder of PDFs

Date: 2026-11-21 (Asia/Saigon). Backlog: K04 — process a folder of PDFs in a batch without
opening the app.

Files:

- `src/core/cli-args.ts`: `parseArgs`, `usage`, `describe`, the flag and command tables, the
  exit-code table.
- `scripts/mirror-cli.mjs`: the runner. Reads the folder, prints the plan, exits.
- `tests/cli-args.test.ts`: every parse case, the plan, the drift guard between the two
  copies of the table, and the runner itself, started as a process.
- This document: every command, flag, exit code and example, and the boundary between what
  runs today and what does not.

## What this is, and what it is not

**Is:** a parser that turns a line of flags into a command, a set of effective options and a
list of problems; a help text rendered from the tables in the module; a canonical one-line
plan; and a runner that lists a folder, prints the plan and exits with a documented code.

**Is not:** the batch job. `extract`, `translate` and `export` do not do their work in this
script. The modules that would do it — `ir.ts`, `blocks.ts`, `retrieval.ts`,
`multi-document.ts`, `citations.ts`, `abstain.ts`, `schema.ts`, `review.ts`, `metrics.ts`,
`release-gate.ts`, `export-check.ts`, the translation pipeline — depend on the DOM, on
PDF.js, or on each other, and they are **not importable from Node** yet. The script plans;
the heavy work lives in the app core until those modules load outside a browser.

That is the honest state, and the runner says it in the process, not only here: a run without
`--dry-run` prints the plan and exits **7**, with `nothing ran` on stderr. A runner that
printed a plan and exited 0 would be claiming work it did not do, which is worse than a
command that does not exist yet.

`check` is the exception, because it needs nothing but the filesystem: it lists the PDFs in
`--in` with their byte sizes and exits 0. It is the one command this build can really run.

## Commands

| Command | What it does |
| --- | --- |
| `extract` | Read the PDFs in `--in` and write their text. Planned: exits 7 without `--dry-run`. |
| `translate` | Translate the PDFs in `--in` into `--lang`. Planned: exits 7 without `--dry-run`. |
| `export` | Write the documents in `--in` in `--format`. Planned: exits 7 without `--dry-run`. |
| `check` | Report what `--in` holds. Reads the folder and writes nothing. |

The command may appear anywhere among the flags. A second bare word is a usage error.

## Flags

| Flag | Value | Default | Meaning |
| --- | --- | --- | --- |
| `--in` | `<dir>` | — | Folder of PDFs to read. Required by every command. |
| `--out` | `<dir>` | — | Folder to write into. Refused by `check`, which writes nothing. |
| `--lang` | `<code>` | — | Target language, for example `vi`, `en`, `zh`. Required by `translate`. |
| `--provider` | `<kind>` | app default | `google`, `deepl`, `openai` or `local`. |
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

Read a folder and see what is in it — the one command that does its work today:

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

A run without `--dry-run` that is not `check` prints the same plan and exits 7:

```sh
$ node scripts/mirror-cli.mjs extract --in docs/pdfs
plan: extract --in docs/pdfs --format md
2 PDFs in docs/pdfs:
  - contract.pdf (184320 B)
  - invoice.pdf (90112 B)
mirror-cli: nothing ran: the batch work lives in the app core until those modules load from Node. Use --dry-run for the plan alone, or open the folder in the app.
$ # exit code: 7 (the "nothing ran" line goes to stderr)
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | ok: help, version, a dry run, or a `check` that passed |
| `2` | usage error: unknown command or flag, missing value, unexpected argument, no command |
| `3` | missing required option: `--in`, or `--lang` for `translate` |
| `4` | unsupported value for `--format`, `--provider` or `--lang` |
| `5` | conflicting options: `--offline` with a cloud provider, or `--out` with `check` |
| `6` | the `--in` folder cannot be used: it is missing, is a file, or holds no PDFs |
| `7` | nothing ran: the plan was printed, and the batch work lives in the app core |

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

The runner prefixes that line: `dry run: ` for `--dry-run`, `plan: ` for a run that will stop
after the plan, and nothing for `check`, whose line is the command it really ran.

## Reports

- `--format md` (default) is the human report: the plan line, the count, then one line per
  PDF with its byte size.
- `--format json` is one object on stdout and nothing else — `command`, `plan`, `dryRun`,
  `ran`, `input`, `count`, `pdfs` (name and bytes) and `note`. The note is the
  `nothing ran` sentence when the work was only planned, and `null` when `check` ran.
- `--format txt` is one PDF name per line and nothing else.

Only `md` prints prose, so a script can read `json` and `txt` without stripping a banner.

## One table, two copies

`scripts/mirror-cli.mjs` cannot import `src/core/cli-args.ts` — the app core does not load
from Node, which is the same reason the runner only plans. It therefore re-implements the
parse table, and `tests/cli-args.test.ts` reads both files and compares `CLI_COMMANDS`,
`CLI_FLAGS`, `CLI_VALUE_FLAGS`, `CLI_FORMATS`, `PROVIDER_KINDS`, `REQUIRED_FLAGS` and
`EXIT_CODES`. The tables are written one entry per line so that comparison is a read of the
source, not a parser of it.

The help text is rendered from those tables on both sides, so a flag that is accepted is a
flag the help names; a test asserts that too.

Adding a flag is therefore a five-place change: the two tables, the help summary in each
file, this document (the test checks that every flag and every exit code appears here), and a
parse test. Forgetting the runner is the failure the drift guard names first.

## Limits

- Only the top level of `--in` is read. Sub-folders are not walked, which is why a batch
  folder is expected to hold its PDFs flat.
- Only names ending in `.pdf` count, in any case; every other file is ignored.
- Nothing writes. Even a non-dry run creates no output folder — `--out` never comes into
  existence here.
- No provider is contacted and no key is read. `--provider` is echoed in the plan and checked
  for the offline conflict; the request that would use it is built by the app core.
- No OCR, no page range, no per-file selection yet. The flags in this document are the flags
  that exist.
- Paths are echoed as given; a path with a space is not shell-quoted in the plan line.
