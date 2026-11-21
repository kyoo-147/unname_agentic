#!/usr/bin/env node
/**
 * mirror-cli — execute a local durable batch over a folder of PDFs (backlog K04).
 *
 * `src/core/cli-args.ts` decides what a line of flags means. This script keeps the fast
 * plan/check path in plain Node and delegates executable work to the TypeScript bridge through
 * the local `tsx` package. It re-implements the parse table so help and validation work before
 * the bridge starts.
 *
 * The fast help/check parser stays duplicated for a dependency-free startup path, and it is guarded:
 * `tests/cli-args.test.ts` reads both files and compares `CLI_COMMANDS`, `CLI_FLAGS`,
 * `CLI_VALUE_FLAGS`, `CLI_FORMATS`, `PROVIDER_KINDS`, `REQUIRED_FLAGS` and `EXIT_CODES`. Add
 * a flag to one file and the test names the other. The tables are on one line each so that
 * comparison is a plain read of the source.
 *
 * What it does:
 *
 * - `check` is real: it lists the PDFs in `--in` with their byte sizes. It reads and writes
 *   nothing else.
 * - `extract`, `translate` and `export` delegate non-dry runs to `mirror-cli-entry.ts`, which
 *   uses the durable local automation runtime. A review or failed job exits 7.
 * - `--format` picks the report shape: `md` is the human one (plan line, count, file list),
 *   `json` is one object on stdout, `txt` is one PDF name per line. Only `md` prints prose,
 *   so a script can read `json` and `txt` without stripping a banner.
 * - A dry run never creates `--out` or writes a byte. Reading the folder is not a change.
 * - `--lang` is validated by the TypeScript parser before the executable bridge runs.
 *
 * Usage:
 *   node scripts/mirror-cli.mjs check --in docs/pdfs
 *   node scripts/mirror-cli.mjs extract --in docs/pdfs --out build/text --dry-run
 *   node scripts/mirror-cli.mjs --help
 *   node scripts/mirror-cli.mjs --version
 *
 * Exit codes: 0 ok (help, version, a dry run, a check that passed), 2 usage error, 3 missing
 * required option, 4 unsupported value, 5 conflicting options, 6 the `--in` folder cannot be
 * used, 7 nothing ran. The numbers come from EXIT_CODES below, which mirrors the table in
 * `src/core/cli-args.ts`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROGRAM = 'mirror-cli';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAX_BATCH_FILES = 5000;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_BATCH_BYTES = 512 * 1024 * 1024;

// --- The parse table. Mirrors src/core/cli-args.ts; tests/cli-args.test.ts compares them. ---
const CLI_COMMANDS = ['extract', 'translate', 'export', 'check'];
const CLI_FLAGS = ['--in', '--out', '--lang', '--provider', '--offline', '--format', '--dry-run', '--help', '--version'];
const CLI_VALUE_FLAGS = ['--in', '--out', '--lang', '--provider', '--format'];
const CLI_FORMATS = ['md', 'json', 'txt'];
const PROVIDER_KINDS = ['google', 'deepl', 'openai', 'local'];
const REQUIRED_FLAGS = {
  extract: ['--in'],
  translate: ['--in', '--lang'],
  export: ['--in'],
  check: ['--in'],
};
const EXIT_CODES = {
  ok: 0,
  'unknown-command': 2,
  'unknown-flag': 2,
  'missing-value': 2,
  'unexpected-value': 2,
  'unexpected-argument': 2,
  'missing-command': 2,
  'missing-required': 3,
  'unsupported-format': 4,
  'unsupported-provider': 4,
  // Declared for parity with the parser. This runner passes --lang through, so it never
  // reports the code itself; see the note at the top.
  'unsupported-language': 4,
  'conflicting-options': 5,
  'input-unusable': 6,
  'planned-only': 7,
};

const FLAG_ARGUMENT = {
  '--in': '<dir>',
  '--out': '<dir>',
  '--lang': '<code>',
  '--provider': '<kind>',
  '--offline': '',
  '--format': '<md|json|txt>',
  '--dry-run': '',
  '--help': '',
  '--version': '',
};

const FLAG_SUMMARY = {
  '--in': 'Folder of PDFs to read. Required by every command.',
  '--out': 'Folder to write into. Refused by check, which writes nothing.',
  '--lang': 'Target language, for example vi, en, zh. Required by translate.',
  '--provider': 'Translation provider: google, deepl, openai, local.',
  '--offline': 'Never leave this machine. Refused with a cloud provider.',
  '--format': 'Report shape. Default: md.',
  '--dry-run': 'Print the plan and write nothing.',
  '--help': 'Print this text.',
  '--version': 'Print the version.',
};

const COMMAND_SUMMARY = {
  extract: 'Read the PDFs in --in and write their text.',
  translate: 'Translate the PDFs in --in into --lang.',
  export: 'Write the documents in --in in --format.',
  check: 'Report what --in holds. Writes nothing.',
};

/** The sentence a non-dry run prints before exiting 7. */
const PLANNED_ONLY_NOTE = 'nothing ran: the batch did not reach a completed state; inspect the persisted job state.';

const COMMAND_SET = new Set(CLI_COMMANDS);
const FLAG_SET = new Set(CLI_FLAGS);
const VALUE_FLAG_SET = new Set(CLI_VALUE_FLAGS);
const FORMAT_SET = new Set(CLI_FORMATS);
const PROVIDER_SET = new Set(PROVIDER_KINDS);

/** Mirror of `isCloudProvider` in src/core/privacy.ts: only `local` stays on this machine. */
function isCloudProvider(provider) {
  return provider !== 'local';
}

function defaultOptions() {
  return {
    input: null,
    output: null,
    lang: null,
    provider: null,
    offline: false,
    format: 'md',
    dryRun: false,
    help: false,
    version: false,
  };
}

/**
 * The same reading of argv as `parseArgs`, including the order the problems are reported in.
 * Every sentence says what to write instead, because the runner is the thing a user meets
 * first.
 */
function parse(argv) {
  const options = defaultOptions();
  const errors = [];
  const seen = new Set();
  let command = null;
  const tokens = Array.isArray(argv) ? argv.filter(token => typeof token === 'string') : [];

  const addError = (code, token, message) => errors.push({ code, token, message });

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.startsWith('-')) {
      const separator = token.indexOf('=');
      const flag = separator > 0 ? token.slice(0, separator) : token;
      const inline = separator > 0 ? token.slice(separator + 1) : null;

      if (!FLAG_SET.has(flag)) {
        addError('unknown-flag', token, `unknown flag "${token}": run "${PROGRAM} --help" to see the flags.`);
        continue;
      }

      seen.add(flag);

      if (!VALUE_FLAG_SET.has(flag)) {
        if (inline !== null) {
          addError('unexpected-value', token, `${flag} takes no value; write ${flag} on its own.`);
          continue;
        }
        if (flag === '--offline') options.offline = true;
        else if (flag === '--dry-run') options.dryRun = true;
        else if (flag === '--help') options.help = true;
        else if (flag === '--version') options.version = true;
        continue;
      }

      let value = inline;
      if (value === null) {
        const next = tokens[index + 1];
        if (next === undefined || next.startsWith('-')) {
          addError('missing-value', flag, `${flag} needs a value: ${flag} ${FLAG_ARGUMENT[flag]}.`);
          continue;
        }
        value = next;
        index += 1;
      }

      if (value.trim() === '') {
        addError('missing-value', flag, `${flag} needs a value: ${flag} ${FLAG_ARGUMENT[flag]}.`);
        continue;
      }

      applyValue(options, flag, value.trim(), addError);
      continue;
    }

    if (COMMAND_SET.has(token)) {
      if (command === null) {
        command = token;
        continue;
      }
      addError('unexpected-argument', token, `"${token}" is a second command: "${command}" already took that place.`);
      continue;
    }

    if (command === null) {
      addError('unknown-command', token, `unknown command "${token}": use ${CLI_COMMANDS.join(', ')}.`);
      continue;
    }

    addError('unexpected-argument', token, `unexpected argument "${token}": ${command} takes flags only.`);
  }

  if (tokens.length === 0) options.help = true;

  const answered = options.help || options.version;

  if (!answered && command === null && tokens.length > 0 && errors.length === 0) {
    addError('missing-command', null, `no command: use ${CLI_COMMANDS.join(', ')}, or "${PROGRAM} --help".`);
  }

  if (!answered && command !== null) {
    for (const flag of REQUIRED_FLAGS[command]) {
      if (seen.has(flag)) continue;
      addError('missing-required', flag, `${command} needs ${flag} ${FLAG_ARGUMENT[flag]}.`);
    }

    if (options.offline && options.provider !== null && isCloudProvider(options.provider)) {
      addError(
        'conflicting-options',
        options.provider,
        `--offline cannot be combined with --provider ${options.provider}: that provider sends text to a remote host.`,
      );
    }

    if (command === 'check' && options.output !== null) {
      addError('conflicting-options', '--out', 'check writes no files: drop --out, or use extract, translate or export.');
    }
  }

  return { command, options, errors };
}

function applyValue(options, flag, value, addError) {
  if (flag === '--in') {
    options.input = value;
    return;
  }
  if (flag === '--out') {
    options.output = value;
    return;
  }
  if (flag === '--lang') {
    // Passed through: the alias table belongs to src/core/language.ts.
    options.lang = value;
    return;
  }
  if (flag === '--provider') {
    if (!PROVIDER_SET.has(value)) {
      addError('unsupported-provider', value, `unsupported provider "${value}": use one of ${PROVIDER_KINDS.join(', ')}.`);
      return;
    }
    options.provider = value;
    return;
  }
  if (flag === '--format') {
    if (!FORMAT_SET.has(value)) {
      addError('unsupported-format', value, `unsupported format "${value}": use one of ${CLI_FORMATS.join(', ')}.`);
      return;
    }
    options.format = value;
  }
}

function exitCodeFor(errors) {
  return errors.length === 0 ? EXIT_CODES.ok : EXIT_CODES[errors[0].code];
}

/** The same line `describe` in src/core/cli-args.ts prints. */
function describe(command, options) {
  const parts = [command === null ? '(no command)' : command];
  if (options.input !== null) parts.push('--in', options.input);
  if (options.output !== null) parts.push('--out', options.output);
  if (options.lang !== null) parts.push('--lang', options.lang);
  if (options.provider !== null) parts.push('--provider', options.provider);
  if (options.offline) parts.push('--offline');
  parts.push('--format', options.format);
  return parts.join(' ');
}

function labelOf(flag) {
  return FLAG_ARGUMENT[flag] === '' ? flag : `${flag} ${FLAG_ARGUMENT[flag]}`;
}

/** The help text, rendered from the tables so it cannot forget a flag it accepts. */
function usage() {
  const commandWidth = Math.max(...CLI_COMMANDS.map(name => name.length));
  const labels = CLI_FLAGS.map(labelOf);
  const flagWidth = Math.max(...labels.map(label => label.length));

  const lines = [
    `${PROGRAM} — plan a batch over a folder of PDFs.`,
    '',
    'Usage:',
    `  ${PROGRAM} <command> [flags]`,
    '',
    'Commands:',
    ...CLI_COMMANDS.map(name => `  ${name.padEnd(commandWidth)}  ${COMMAND_SUMMARY[name]}`),
    '',
    'Flags:',
    ...CLI_FLAGS.map((flag, index) => `  ${labels[index].padEnd(flagWidth)}  ${FLAG_SUMMARY[flag]}`),
    '',
    'Exit codes:',
    `  ${String(EXIT_CODES.ok).padStart(2)}  ok: help, version, a dry run, or a check that passed`,
    `  ${String(EXIT_CODES['unknown-flag']).padStart(2)}  usage error: unknown command or flag, missing value, unexpected argument`,
    `  ${String(EXIT_CODES['missing-required']).padStart(2)}  missing required option`,
    `  ${String(EXIT_CODES['unsupported-format']).padStart(2)}  unsupported value for --format or --provider`,
    `  ${String(EXIT_CODES['conflicting-options']).padStart(2)}  conflicting options`,
    `  ${String(EXIT_CODES['input-unusable']).padStart(2)}  the --in folder cannot be used (missing, not a folder, no PDFs)`,
    `  ${String(EXIT_CODES['planned-only']).padStart(2)}  one or more jobs remain in review or failed`,
    '',
    'Examples:',
    `  ${PROGRAM} check --in docs/pdfs`,
    `  ${PROGRAM} extract --in docs/pdfs --out build/text --format md --dry-run`,
    `  ${PROGRAM} translate --in docs/pdfs --lang vi --provider local --offline`,
    '',
    'check lists the folder. extract, translate and export execute the durable local pipeline',
    'unless --dry-run is present; runtime JSON is printed after the attempt.',
  ];
  return `${lines.join('\n')}\n`;
}

function version() {
  try {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function runExecutable(argv) {
  const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const entry = path.join(ROOT, 'scripts', 'mirror-cli-entry.ts');
  const result = spawnSync(process.execPath, [tsx, entry, ...argv], { cwd: ROOT, stdio: 'inherit', env: process.env });
  return typeof result.status === 'number' ? result.status : EXIT_CODES['planned-only'];
}

/** PDFs under `dir`, sorted by relative name, with bounded local enumeration. */
function listPdfs(dir) {
  const pdfs = [];
  const pending = [{ absolute: dir, relative: '' }];
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.shift();
    const entries = readdirSync(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(current.absolute, entry.name);
      const relative = current.relative ? path.join(current.relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        pending.push({ absolute, relative });
        continue;
      }
      if (!entry.isFile() || !/\.pdf$/iu.test(entry.name)) continue;
      if (pdfs.length >= MAX_BATCH_FILES) throw new Error(`batch exceeds the ${MAX_BATCH_FILES} file local safety cap.`);
      const bytes = statSync(absolute).size;
      if (bytes > MAX_PDF_BYTES) throw new Error(`PDF exceeds the ${MAX_PDF_BYTES} byte local safety cap: ${relative}`);
      totalBytes += bytes;
      if (totalBytes > MAX_BATCH_BYTES) throw new Error(`batch exceeds the ${MAX_BATCH_BYTES} byte local safety cap.`);
      pdfs.push({ name: relative.split(path.sep).join('/'), bytes });
    }
  }
  return pdfs.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

function printHumanPlan(prefix, command, options, pdfs) {
  process.stdout.write(`${prefix}${describe(command, options)}\n`);
  process.stdout.write(`${pdfs.length} PDF${pdfs.length === 1 ? '' : 's'} in ${options.input}:\n`);
  for (const pdf of pdfs) process.stdout.write(`  - ${pdf.name} (${pdf.bytes} B)\n`);
}

function main(argv) {
  const parsed = parse(argv);
  const options = parsed.options;

  // --help and --version are answered first: the user asked for them, so nothing else is
  // worth refusing. Empty argv also lands here because parse() sets `help`.
  if (options.help) {
    process.stdout.write(usage());
    return EXIT_CODES.ok;
  }
  if (options.version) {
    process.stdout.write(`${PROGRAM} ${version()}\n`);
    return EXIT_CODES.ok;
  }

  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) process.stderr.write(`${PROGRAM}: ${error.message}\n`);
    process.stderr.write(`Run "${PROGRAM} --help" for the supported commands and flags.\n`);
    return exitCodeFor(parsed.errors);
  }

  if (parsed.command === null) {
    process.stdout.write(usage());
    return EXIT_CODES.ok;
  }

  const command = parsed.command;
  const input = options.input;

  if (input === null) {
    // Unreachable: every command requires --in and parse() would have reported it.
    process.stderr.write(`${PROGRAM}: ${command} needs --in <dir>.\n`);
    return EXIT_CODES['missing-required'];
  }

  if (!existsSync(input)) {
    process.stderr.write(`${PROGRAM}: --in "${input}" does not exist.\n`);
    return EXIT_CODES['input-unusable'];
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(input).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    process.stderr.write(`${PROGRAM}: --in "${input}" is not a folder.\n`);
    return EXIT_CODES['input-unusable'];
  }

  let pdfs;
  try {
    pdfs = listPdfs(input);
  } catch (error) {
    process.stderr.write(`${PROGRAM}: --in "${input}" cannot be read: ${error.message}\n`);
    return EXIT_CODES['input-unusable'];
  }
  if (pdfs.length === 0) {
    process.stderr.write(`${PROGRAM}: --in "${input}" holds no PDF files.\n`);
    return EXIT_CODES['input-unusable'];
  }

  const ran = command === 'check';

  if (!ran && !options.dryRun) return runExecutable(process.argv.slice(2));

  if (options.format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          command,
          plan: describe(command, options),
          dryRun: options.dryRun,
          ran,
          input,
          count: pdfs.length,
          pdfs,
          note: ran ? null : PLANNED_ONLY_NOTE,
        },
        null,
        2,
      )}\n`,
    );
  } else if (options.format === 'txt') {
    for (const pdf of pdfs) process.stdout.write(`${pdf.name}\n`);
  } else {
    printHumanPlan(options.dryRun ? 'dry run: ' : ran ? '' : 'plan: ', command, options, pdfs);
  }

  if (ran) return EXIT_CODES.ok;

  if (options.dryRun) return EXIT_CODES.ok;

  process.stderr.write(`${PROGRAM}: ${PLANNED_ONLY_NOTE}\n`);
  return EXIT_CODES['planned-only'];
}

process.exitCode = main(process.argv.slice(2));
