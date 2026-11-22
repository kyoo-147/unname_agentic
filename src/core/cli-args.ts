/**
 * Batch command line for a folder of PDFs (backlog K04).
 *
 * The app already knows how to extract, translate and export, but every one of those paths
 * starts with a window. A folder of a hundred PDFs is a job for a command line, and this
 * module is the half of that command line which can be decided without touching a disk: it
 * turns argv into a command, a set of options and a list of problems, and it renders the
 * help text and the one-line plan a dry run prints. `scripts/mirror-cli.mjs` is the other
 * half — the runner that reads the folder and exits.
 *
 * Contract:
 *
 * - {@link parseArgs} never throws and never guesses. A value it does not recognise is
 *   reported and left out of `options`, so a typo cannot become a different run.
 * - `options` holds effective values only: a language code is normalised, a format is one
 *   of {@link CLI_FORMATS}, a provider is one of {@link PROVIDER_KINDS}. When an option is
 *   absent it is `null`, which is different from "given an empty string".
 * - Every problem is reported, not just the first, and the order is fixed: flag problems in
 *   argv order, then the per-command requirements, then the conflicting combinations.
 *   {@link exitCodeFor} turns the first one into the process exit code.
 * - {@link usage} renders the commands, flags and exit codes from the tables in this file,
 *   so the help cannot forget a flag that the parser accepts.
 * - The module reads nothing: no filesystem, no clock, no randomness. It is the same code in
 *   the browser bundle and in a test.
 *
 * How argv is read:
 *
 * - The first bare word is the command. A second bare word is `unexpected-argument`; a bare
 *   word that is not a command is `unknown-command`.
 * - `--flag value` and `--flag=value` are the same thing. A value that begins with `-` is
 *   read as the next flag, so `--in` at the end of the line, or followed by another flag, is
 *   `missing-value`; write `--in=--weird` when the value really starts with a dash.
 * - A flag that takes no value (`--offline`, `--dry-run`, `--help`, `--version`) refuses an
 *   `=value` as `unexpected-value`.
 * - A flag given twice keeps the last value. Values are trimmed.
 * - `--help` and `--version` skip the requirement and conflict checks: a missing `--in` beside
 *   `--help` is not an error, because the user asked for the help. A flag that cannot be read
 *   at all — an unknown flag, a missing value — is still reported, because a parser that
 *   dropped it would be lying about what it read; the caller decides that help wins (and
 *   `scripts/mirror-cli.mjs` does exactly that). No arguments at all is also a request for
 *   help, not an error, and it sets `options.help`.
 * - A flag list with no command (`mirror-cli --in docs`) is `missing-command` — but only
 *   when nothing else already explained the line, so `mirror-cli --bogus` reports the
 *   unknown flag alone.
 *
 * Requirements and conflicts:
 *
 * | Command     | Required           |
 * | ----------- | ------------------ |
 * | `extract`   | `--in`             |
 * | `translate` | `--in`, `--lang`   |
 * | `export`    | `--in`             |
 * | `check`     | `--in`             |
 *
 * - `--offline` with a cloud provider is `conflicting-options`: `isCloudProvider` in
 *   `src/core/privacy.ts` decides which providers may reach a remote host, so the two
 *   modules cannot disagree about what "cloud" means.
 * - `check` writes nothing, so `--out` with `check` is `conflicting-options` rather than a
 *   silently ignored flag.
 * - `--lang` is required by `translate` and accepted by the others; a batch folder is
 *   normally run through all four commands with one line of flags. `--format` is the output
 *   shape for the commands that write, and the report shape for `check`.
 *
 * Checks on values:
 *
 * - `--format` must be `md`, `json` or `txt`; anything else is `unsupported-format`.
 * - `--provider` must be `google`, `deepl`, `openai` or `local`; anything else is
 *   `unsupported-provider`.
 * - `--lang` is normalised with `normalizeLanguageCode` and must then be one of the targets
 *   in `src/core/language.ts`; anything else is `unsupported-language`. `auto` is refused
 *   with its own sentence, because a translation target cannot be "detect".
 *
 * Exit codes ({@link EXIT_CODES}) — one number per family, documented in `docs/cli.md`:
 *
 * | Code | Meaning                                                                    |
 * | ---- | -------------------------------------------------------------------------- |
 * | 0    | ok: help, version, a dry run, or a check that passed                       |
 * | 2    | usage error: unknown command or flag, missing value, unexpected argument    |
 * | 3    | missing required option                                                    |
 * | 4    | unsupported value for `--format`, `--provider` or `--lang`                  |
 * | 5    | conflicting options                                                        |
 * | 6    | the `--in` folder cannot be used (missing, not a folder, no PDFs)          |
 * | 7    | nothing ran: the batch work lives in the app core (runner outcome)         |
 *
 * Codes 6 and 7 belong to the runner, not to the parser: `exitCodeFor` can only return 0 to
 * 5, but they live in the same table so the runner and this module print one list.
 */

import { SUPPORTED_TARGETS, normalizeLanguageCode } from './language';
import { isCloudProvider } from './privacy';
import type { ProviderKind } from './types';

/** Name the help text and the error messages call the program. */
export const CLI_PROGRAM = 'mirror-cli';

/** The commands, in the order the help lists them. */
export type CliCommand = 'extract' | 'translate' | 'export' | 'check';

/** The output shapes a command can write, and the shape a `check` report takes. */
export type CliFormat = 'md' | 'json' | 'txt';

/** Every flag the parser accepts. */
export type CliFlag =
  | '--in'
  | '--out'
  | '--lang'
  | '--provider'
  | '--offline'
  | '--format'
  | '--dry-run'
  | '--help'
  | '--version';

/**
 * One family of refusal. The first seven are usage errors a shell user fixes by editing the
 * line; the value errors name the flag they belong to; the conflict errors name both sides.
 */
export type CliErrorCode =
  | 'unknown-command'
  | 'unknown-flag'
  | 'missing-value'
  | 'unexpected-value'
  | 'unexpected-argument'
  | 'missing-command'
  | 'missing-required'
  | 'unsupported-format'
  | 'unsupported-provider'
  | 'unsupported-language'
  | 'conflicting-options';

/** Every outcome the command line can end on, including the two the runner owns. */
export type CliOutcome = 'ok' | CliErrorCode | 'input-unusable' | 'planned-only';

/** The commands, in help order. `scripts/mirror-cli.mjs` repeats this list; a test holds them equal. */
export const CLI_COMMANDS: readonly CliCommand[] = ['extract', 'translate', 'export', 'check'];

/** Every accepted flag, in help order. The runner repeats this list. */
export const CLI_FLAGS: readonly CliFlag[] = [
  '--in',
  '--out',
  '--lang',
  '--provider',
  '--offline',
  '--format',
  '--dry-run',
  '--help',
  '--version',
];

/** The flags that take a value. The rest are switches. */
export const CLI_VALUE_FLAGS: readonly CliFlag[] = ['--in', '--out', '--lang', '--provider', '--format'];

/** Accepted `--format` values, in help order. */
export const CLI_FORMATS: readonly CliFormat[] = ['md', 'json', 'txt'];

/**
 * Accepted `--provider` values. `src/core/types.ts` owns the `ProviderKind` type; this is the
 * runtime copy the parser and the help need, and `as const` keeps the literal union so the
 * assertion below can check that the copy is complete.
 */
export const PROVIDER_KINDS = ['google', 'deepl', 'openai', 'local'] as const satisfies readonly ProviderKind[];

/**
 * Compile-time proof that every `ProviderKind` is named above. A member added to the type
 * without a line here leaves `MissingProvider` non-`never`, and this declaration stops
 * compiling — without it the parser would quietly refuse a provider the type allows.
 */
type MissingProvider = Exclude<ProviderKind, (typeof PROVIDER_KINDS)[number]>;
const PROVIDER_KINDS_ARE_COMPLETE: MissingProvider extends never ? true : never = true;

/** The options each command cannot run without. Order is the order they are reported in. */
export const REQUIRED_FLAGS: Readonly<Record<CliCommand, readonly CliFlag[]>> = {
  extract: ['--in'],
  translate: ['--in', '--lang'],
  export: ['--in'],
  check: ['--in'],
};

/**
 * The exit code per outcome. Two numbers are shared on purpose: every way of writing a wrong
 * line is a usage error, and every unusable value is a value error.
 */
export const EXIT_CODES: Readonly<Record<CliOutcome, number>> = {
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
  'unsupported-language': 4,
  'conflicting-options': 5,
  'input-unusable': 6,
  'planned-only': 7,
};

/** Effective options. `null` means "not given", which is not the same as an empty string. */
export interface CliOptions {
  /** Folder of PDFs to read. */
  input: string | null;
  /** Folder to write into. Refused by `check`, which writes nothing. */
  output: string | null;
  /** Target language, normalised to a code in `src/core/language.ts`. */
  lang: string | null;
  /** Translation provider. `null` means the app's configured default. */
  provider: ProviderKind | null;
  /** Never leave this machine: only a local provider may run. */
  offline: boolean;
  /** Output shape, always in effect, so the plan can always be echoed. */
  format: CliFormat;
  /** Print the plan and write nothing. */
  dryRun: boolean;
  /** Print the help text. Also set by an empty argv. */
  help: boolean;
  /** Print the version. */
  version: boolean;
}

/** One problem with one line of argv. `message` is a complete English sentence. */
export interface CliError {
  code: CliErrorCode;
  /** The flag or argument at fault, as written; `null` when the line as a whole is at fault. */
  token: string | null;
  message: string;
}

/** What argv turned into: a command (or `null`), effective options, and every problem. */
export interface ParsedArgs {
  command: CliCommand | null;
  options: CliOptions;
  errors: CliError[];
}

/** What {@link describe} needs: a command and its options. A `ParsedArgs` fits directly. */
export interface CliInvocation {
  command: CliCommand | null;
  options: CliOptions;
}

/** The word {@link describe} prints when no command was given. */
export const NO_COMMAND = '(no command)';

const COMMAND_SET = new Set<string>(CLI_COMMANDS);
const FLAG_SET = new Set<string>(CLI_FLAGS);
const VALUE_FLAG_SET = new Set<string>(CLI_VALUE_FLAGS);
const FORMAT_SET = new Set<string>(CLI_FORMATS);
const PROVIDER_SET = new Set<string>(PROVIDER_KINDS);
const TARGET_CODES = new Set<string>(SUPPORTED_TARGETS.map(target => target.code));

/** Placeholder shown in messages and in the help, per flag. */
const FLAG_ARGUMENT: Readonly<Record<CliFlag, string>> = {
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

/** One line of help per flag. */
const FLAG_SUMMARY: Readonly<Record<CliFlag, string>> = {
  '--in': 'Folder of PDFs to read. Required by every command.',
  '--out': 'Folder to write into. Refused by check, which writes nothing.',
  '--lang': 'Target language, for example vi, en, zh. Required by translate.',
  '--provider': 'Translation provider: google, deepl, openai, local.',
  '--offline': 'Never leave this machine. Refused with a cloud provider.',
  '--format': 'Output shape. Default: md.',
  '--dry-run': 'Print the plan and write nothing.',
  '--help': 'Print this text.',
  '--version': 'Print the version.',
};

/** One line of help per command. */
const COMMAND_SUMMARY: Readonly<Record<CliCommand, string>> = {
  extract: 'Read the PDFs in --in and write their text.',
  translate: 'Translate the PDFs in --in into --lang.',
  export: 'Write the documents in --in in --format.',
  check: 'Report what --in holds. Writes nothing.',
};

/** A fresh set of defaults. Never share one object between parses. */
export function defaultOptions(): CliOptions {
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
 * Reads argv and returns the command, the effective options and every problem found.
 *
 * Never throws: something that is not an array is read as an empty argv (which is a help
 * request), and a token that is not a string is dropped from the line, because a command line
 * is the last place that should crash on bad input.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const options = defaultOptions();
  const errors: CliError[] = [];
  const seen = new Set<string>();
  let command: CliCommand | null = null;

  const tokens = Array.isArray(argv) ? argv.filter((token): token is string => typeof token === 'string') : [];

  const addError = (code: CliErrorCode, token: string | null, message: string): void => {
    errors.push({ code, token, message });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';

    if (token.startsWith('-')) {
      const separator = token.indexOf('=');
      const flag = separator > 0 ? token.slice(0, separator) : token;
      const inline = separator > 0 ? token.slice(separator + 1) : null;

      if (!FLAG_SET.has(flag)) {
        addError('unknown-flag', token, `unknown flag "${token}": run "${CLI_PROGRAM} --help" to see the flags.`);
        continue;
      }

      const name = flag as CliFlag;
      seen.add(name);

      if (!VALUE_FLAG_SET.has(name)) {
        if (inline !== null) {
          addError('unexpected-value', token, `${name} takes no value; write ${name} on its own.`);
          continue;
        }
        applySwitch(options, name);
        continue;
      }

      let value: string | null = inline;
      if (value === null) {
        const next = tokens[index + 1];
        if (next === undefined || next.startsWith('-')) {
          addError('missing-value', name, `${name} needs a value: ${name} ${FLAG_ARGUMENT[name]}.`);
          continue;
        }
        value = next;
        index += 1;
      }

      if (value.trim() === '') {
        addError('missing-value', name, `${name} needs a value: ${name} ${FLAG_ARGUMENT[name]}.`);
        continue;
      }

      applyValue(options, name, value.trim(), addError);
      continue;
    }

    if (COMMAND_SET.has(token)) {
      if (command === null) {
        command = token as CliCommand;
        continue;
      }
      addError(
        'unexpected-argument',
        token,
        `"${token}" is a second command: "${command}" already took that place.`,
      );
      continue;
    }

    if (command === null) {
      addError('unknown-command', token, `unknown command "${token}": use ${CLI_COMMANDS.join(', ')}.`);
      continue;
    }

    addError('unexpected-argument', token, `unexpected argument "${token}": ${command} takes flags only.`);
  }

  // No arguments at all is a request for help, not an error.
  if (tokens.length === 0) options.help = true;

  const answered = options.help || options.version;

  if (!answered && command === null && tokens.length > 0 && errors.length === 0) {
    addError('missing-command', null, `no command: use ${CLI_COMMANDS.join(', ')}, or "${CLI_PROGRAM} --help".`);
  }

  if (!answered && command !== null) {
    for (const flag of REQUIRED_FLAGS[command]) {
      // A flag that was given with a bad value has already been reported; asking for it
      // again would blame the wrong thing.
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

/** The exit code the first problem selects, or 0 when there is none. */
export function exitCodeFor(errors: readonly CliError[]): number {
  const first = errors[0];
  return first === undefined ? EXIT_CODES.ok : EXIT_CODES[first.code];
}

/**
 * One line for a dry run: the effective command and options, in the order
 * `command --in --out --lang --provider --offline --format`, skipping what was not given.
 * `--format` is always printed because it is always in effect. `--dry-run` itself is not
 * printed: it is how the line was called, not what the run would do.
 *
 * The line is meant to be read and, when no value holds a space, pasted back. Values are
 * echoed as given, so a path with a space is not shell-quoted.
 */
export function describe(invocation: CliInvocation): string {
  const options = invocation.options;
  const parts: string[] = [invocation.command ?? NO_COMMAND];
  if (options.input !== null) parts.push('--in', options.input);
  if (options.output !== null) parts.push('--out', options.output);
  if (options.lang !== null) parts.push('--lang', options.lang);
  if (options.provider !== null) parts.push('--provider', options.provider);
  if (options.offline) parts.push('--offline');
  parts.push('--format', options.format);
  return parts.join(' ');
}

/** The English help text. Rendered from the tables above, so it cannot miss a flag. */
export function usage(): string {
  const commandWidth = Math.max(...CLI_COMMANDS.map(name => name.length));
  const labels = CLI_FLAGS.map(labelOf);
  const flagWidth = Math.max(...labels.map(label => label.length));

  const lines: string[] = [
    `${CLI_PROGRAM} — plan a batch over a folder of PDFs.`,
    '',
    'Usage:',
    `  ${CLI_PROGRAM} <command> [flags]`,
    '',
    'Commands:',
    ...CLI_COMMANDS.map(name => `  ${name.padEnd(commandWidth)}  ${COMMAND_SUMMARY[name]}`),
    '',
    'Flags:',
    ...CLI_FLAGS.map((flag, index) => `  ${(labels[index] ?? '').padEnd(flagWidth)}  ${FLAG_SUMMARY[flag]}`),
    '',
    'Exit codes:',
    ...EXIT_GROUPS.map(group => `  ${String(group.code).padStart(2)}  ${group.text}`),
    '',
    'Examples:',
    `  ${CLI_PROGRAM} check --in docs/pdfs`,
    `  ${CLI_PROGRAM} extract --in docs/pdfs --out build/text --format md --dry-run`,
    `  ${CLI_PROGRAM} translate --in docs/pdfs --lang vi --provider local --offline`,
    '',
    'A dry run prints the plan and writes nothing. Without --dry-run the runner executes the',
    'durable local pipeline and prints runtime status JSON after the attempt.',
  ];
  return `${lines.join('\n')}\n`;
}

// --- Parsing helpers -------------------------------------------------------

function applySwitch(options: CliOptions, flag: CliFlag): void {
  switch (flag) {
    case '--offline':
      options.offline = true;
      break;
    case '--dry-run':
      options.dryRun = true;
      break;
    case '--help':
      options.help = true;
      break;
    case '--version':
      options.version = true;
      break;
    default:
      // Unreachable: the value flags are routed to `applyValue` first.
      break;
  }
}

function applyValue(
  options: CliOptions,
  flag: CliFlag,
  value: string,
  addError: (code: CliErrorCode, token: string | null, message: string) => void,
): void {
  switch (flag) {
    case '--in':
      options.input = value;
      break;
    case '--out':
      options.output = value;
      break;
    case '--lang': {
      const normalized = normalizeLanguageCode(value);
      if (normalized === 'auto') {
        addError(
          'unsupported-language',
          value,
          `--lang auto is not a target language: name the language to translate into (${targetList()}).`,
        );
        break;
      }
      if (!TARGET_CODES.has(normalized)) {
        addError('unsupported-language', value, `unsupported language "${value}": use one of ${targetList()}.`);
        break;
      }
      options.lang = normalized;
      break;
    }
    case '--provider':
      if (!PROVIDER_SET.has(value)) {
        addError(
          'unsupported-provider',
          value,
          `unsupported provider "${value}": use one of ${PROVIDER_KINDS.join(', ')}.`,
        );
        break;
      }
      options.provider = value as ProviderKind;
      break;
    case '--format':
      if (!FORMAT_SET.has(value)) {
        addError('unsupported-format', value, `unsupported format "${value}": use one of ${CLI_FORMATS.join(', ')}.`);
        break;
      }
      options.format = value as CliFormat;
      break;
    default:
      // Unreachable: the switches are routed to `applySwitch` first.
      break;
  }
}

function labelOf(flag: CliFlag): string {
  const argument = FLAG_ARGUMENT[flag];
  return argument === '' ? flag : `${flag} ${argument}`;
}

/** The target codes in one phrase, used by the `--lang` messages. */
function targetList(): string {
  return SUPPORTED_TARGETS.map(target => target.code).join(', ');
}

/** One line per exit-code family, built from {@link EXIT_CODES} so the numbers cannot drift. */
const EXIT_GROUPS: readonly { readonly code: number; readonly text: string }[] = [
  { code: EXIT_CODES.ok, text: 'ok: help, version, a dry run, or a check that passed' },
  {
    code: EXIT_CODES['unknown-flag'],
    text: 'usage error: unknown command or flag, missing value, unexpected argument',
  },
  { code: EXIT_CODES['missing-required'], text: 'missing required option' },
  { code: EXIT_CODES['unsupported-format'], text: 'unsupported value for --format, --provider or --lang' },
  { code: EXIT_CODES['conflicting-options'], text: 'conflicting options' },
  { code: EXIT_CODES['input-unusable'], text: 'the --in folder cannot be used (missing, not a folder, no PDFs)' },
  { code: EXIT_CODES['planned-only'], text: 'one or more jobs remain in review or failed' },
];
