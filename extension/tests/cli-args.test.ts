import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLI_COMMANDS,
  CLI_FLAGS,
  CLI_FORMATS,
  CLI_PROGRAM,
  CLI_VALUE_FLAGS,
  EXIT_CODES,
  NO_COMMAND,
  PROVIDER_KINDS,
  REQUIRED_FLAGS,
  defaultOptions,
  describe as describePlan,
  exitCodeFor,
  parseArgs,
  usage,
  type CliError,
  type CliOptions,
} from '../viewer/src/core/cli-args';

// --- Helpers ---------------------------------------------------------------

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

/** The error codes a parse produced, in the order it produced them. */
function codes(argv: readonly string[]): string[] {
  return parseArgs(argv).errors.map((error: CliError) => error.code);
}

/** The options of a parse that is expected to be clean. */
function optionsOf(argv: readonly string[]): CliOptions {
  const parsed = parseArgs(argv);
  expect(parsed.errors).toEqual([]);
  return parsed.options;
}

/**
 * Runs the real runner. The command line is only as good as the process it starts, so the
 * exit codes and the printed plan are checked by starting it, not by reading its source.
 */
function run(...args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const script = fileURLToPath(new URL('../../scripts/mirror-cli.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const temporary: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mirror-cli-'));
  temporary.push(dir);
  return dir;
}

function writePdf(dir: string, name: string, bytes = 4): void {
  writeFileSync(path.join(dir, name), 'x'.repeat(bytes));
}

afterAll(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

// --- The parser ------------------------------------------------------------

describe('parseArgs: the command', () => {
  it('reads each command with the options it needs', () => {
    expect(parseArgs(['extract', '--in', 'docs'])).toEqual({
      command: 'extract',
      options: { ...defaultOptions(), input: 'docs' },
      errors: [],
    });
    expect(parseArgs(['translate', '--in', 'docs', '--lang', 'vi']).command).toBe('translate');
    expect(parseArgs(['export', '--in', 'docs']).command).toBe('export');
    expect(parseArgs(['check', '--in', 'docs']).command).toBe('check');
  });

  it('takes the command wherever it appears among the flags', () => {
    const parsed = parseArgs(['--in', 'docs', 'translate', '--lang=vi']);
    expect(parsed.command).toBe('translate');
    expect(parsed.options.input).toBe('docs');
    expect(parsed.options.lang).toBe('vi');
    expect(parsed.errors).toEqual([]);
  });

  it('refuses a second command instead of running the first one twice', () => {
    const parsed = parseArgs(['extract', '--in', 'docs', 'check']);
    expect(parsed.command).toBe('extract');
    expect(parsed.errors.map(error => error.code)).toEqual(['unexpected-argument']);
    expect(parsed.errors[0]?.message).toContain('second command');
  });

  it('refuses a bare word that is not a command, and names the four that are', () => {
    const parsed = parseArgs(['delete', '--in', 'docs']);
    expect(parsed.command).toBeNull();
    expect(parsed.errors.map(error => error.code)).toEqual(['unknown-command']);
    for (const command of CLI_COMMANDS) expect(parsed.errors[0]?.message).toContain(command);
  });

  it('refuses an argument after the command', () => {
    expect(codes(['check', '--in', 'docs', 'stray'])).toEqual(['unexpected-argument']);
  });

  it('treats an empty argv as a request for help, with nothing to report', () => {
    expect(parseArgs([])).toEqual({ command: null, options: { ...defaultOptions(), help: true }, errors: [] });
  });

  it('reports a flag list with no command exactly once', () => {
    const parsed = parseArgs(['--in', 'docs']);
    expect(parsed.command).toBeNull();
    expect(parsed.errors.map(error => error.code)).toEqual(['missing-command']);
    // The unknown flag already explains the line, so no second complaint is added.
    expect(codes(['--bogus'])).toEqual(['unknown-flag']);
  });
});

describe('parseArgs: flags', () => {
  it('accepts --flag value and --flag=value as the same thing', () => {
    expect(optionsOf(['extract', '--in', 'docs']).input).toBe('docs');
    expect(optionsOf(['extract', '--in=docs']).input).toBe('docs');
    expect(optionsOf(['export', '--in', 'docs', '--format=txt']).format).toBe('txt');
  });

  it('trims a value and keeps the last one when a flag is given twice', () => {
    expect(optionsOf(['extract', '--in', '  docs  ']).input).toBe('docs');
    expect(optionsOf(['extract', '--in', 'first', '--in', 'second']).input).toBe('second');
  });

  it('defaults the format to md and reads a provider', () => {
    const options = optionsOf(['translate', '--in', 'docs', '--lang', 'vi', '--provider', 'openai']);
    expect(options.format).toBe('md');
    expect(options.provider).toBe('openai');
    expect(options.offline).toBe(false);
    expect(options.dryRun).toBe(false);
  });

  it('reads the switches as switches', () => {
    const options = optionsOf(['extract', '--in', 'docs', '--offline', '--dry-run']);
    expect(options.offline).toBe(true);
    expect(options.dryRun).toBe(true);
  });

  it('refuses an unknown flag by the token the user typed', () => {
    const parsed = parseArgs(['extract', '--in', 'docs', '--nope']);
    expect(parsed.errors.map(error => error.code)).toEqual(['unknown-flag']);
    expect(parsed.errors[0]?.token).toBe('--nope');
    expect(parsed.errors[0]?.message).toContain('--help');
    // The short forms were never promised, so they are unknown rather than guessed at.
    expect(codes(['extract', '--in', 'docs', '-h'])).toEqual(['unknown-flag']);
    expect(codes(['extract', '--in', 'docs', '--nope=1'])).toEqual(['unknown-flag']);
  });

  it('refuses a value flag with nothing to read', () => {
    expect(codes(['extract', '--in'])).toEqual(['missing-value']);
    expect(codes(['extract', '--in', '--out', 'docs'])).toEqual(['missing-value']);
    expect(codes(['extract', '--in='])).toEqual(['missing-value']);
    expect(codes(['extract', '--in', '   '])).toEqual(['missing-value']);
  });

  it('refuses a value on a switch', () => {
    const parsed = parseArgs(['extract', '--in', 'docs', '--offline=1']);
    expect(parsed.errors.map(error => error.code)).toEqual(['unexpected-value']);
    expect(parsed.options.offline).toBe(false);
  });

  it('reports flag problems in argv order, before the requirements', () => {
    const parsed = parseArgs(['translate', '--in', 'docs', '--format', 'pdf']);
    expect(parsed.errors.map(error => error.code)).toEqual(['unsupported-format', 'missing-required']);
    expect(exitCodeFor(parsed.errors)).toBe(EXIT_CODES['unsupported-format']);
  });
});

describe('parseArgs: requirements', () => {
  it('asks every command for --in', () => {
    for (const command of CLI_COMMANDS) {
      const parsed = parseArgs([command]);
      // `translate` also needs --lang, so the list is the required set in its documented order.
      expect(parsed.errors.map(error => error.token)).toEqual([...REQUIRED_FLAGS[command]]);
      expect(parsed.errors[0]?.code).toBe('missing-required');
      expect(parsed.errors[0]?.message).toContain('--in');
      expect(parsed.errors[0]?.message).toContain(command);
    }
  });

  it('asks translate for --lang as well, and reports both in the documented order', () => {
    expect(parseArgs(['translate', '--in', 'docs']).errors.map(error => error.token)).toEqual(['--lang']);
    expect(parseArgs(['translate']).errors.map(error => error.token)).toEqual(['--in', '--lang']);
  });

  it('accepts --lang on the commands that do not require it', () => {
    expect(parseArgs(['check', '--in', 'docs', '--lang', 'vi']).errors).toEqual([]);
    expect(parseArgs(['extract', '--in', 'docs', '--lang', 'vi']).errors).toEqual([]);
  });

  it('stops asking once --help is on the line, and still reports a flag it could not read', () => {
    expect(parseArgs(['translate', '--help']).errors).toEqual([]);
    expect(parseArgs(['--help']).errors).toEqual([]);
    expect(parseArgs(['--version']).errors).toEqual([]);
    // A flag that cannot be read at all is not silently dropped just because help was asked
    // for; the caller decides that help wins, and `run` below shows it does.
    expect(codes(['check', '--help', '--bogus'])).toEqual(['unknown-flag']);
  });
});

describe('parseArgs: values', () => {
  it('keeps the default format when the value is refused', () => {
    const parsed = parseArgs(['export', '--in', 'docs', '--format', 'pdf']);
    expect(parsed.errors.map(error => error.code)).toEqual(['unsupported-format']);
    expect(parsed.options.format).toBe('md');
    expect(parsed.errors[0]?.message).toContain('md, json, txt');
  });

  it('refuses a provider nobody can reach', () => {
    const parsed = parseArgs(['translate', '--in', 'docs', '--lang', 'vi', '--provider', 'azure']);
    expect(parsed.errors.map(error => error.code)).toEqual(['unsupported-provider']);
    expect(parsed.options.provider).toBeNull();
  });

  it('normalises a language code and accepts an alias', () => {
    expect(optionsOf(['translate', '--in', 'docs', '--lang', 'vi-VN']).lang).toBe('vi');
    expect(optionsOf(['translate', '--in', 'docs', '--lang', 'VN']).lang).toBe('vi');
  });

  it('refuses a language that is not a target, and refuses auto by name', () => {
    const unknown = parseArgs(['translate', '--in', 'docs', '--lang', 'xx']);
    expect(unknown.errors.map(error => error.code)).toEqual(['unsupported-language']);
    expect(unknown.options.lang).toBeNull();

    const auto = parseArgs(['translate', '--in', 'docs', '--lang', 'auto']);
    expect(auto.errors.map(error => error.code)).toEqual(['unsupported-language']);
    expect(auto.errors[0]?.message).toContain('target language');
  });
});

describe('parseArgs: conflicts', () => {
  it('refuses --offline with every cloud provider', () => {
    for (const provider of PROVIDER_KINDS.filter(kind => kind !== 'local')) {
      const parsed = parseArgs(['translate', '--in', 'docs', '--lang', 'vi', '--provider', provider, '--offline']);
      expect(parsed.errors.map(error => error.code)).toEqual(['conflicting-options']);
      expect(parsed.errors[0]?.message).toContain(provider);
      expect(parsed.errors[0]?.message).toContain('remote');
    }
  });

  it('allows --offline with the local provider, and on its own', () => {
    expect(codes(['translate', '--in', 'docs', '--lang', 'vi', '--provider', 'local', '--offline'])).toEqual([]);
    expect(codes(['extract', '--in', 'docs', '--offline'])).toEqual([]);
    expect(optionsOf(['extract', '--in', 'docs', '--offline']).offline).toBe(true);
  });

  it('refuses --out on check, which writes nothing', () => {
    const parsed = parseArgs(['check', '--in', 'docs', '--out', 'build']);
    expect(parsed.errors.map(error => error.code)).toEqual(['conflicting-options']);
    expect(parsed.errors[0]?.message).toContain('--out');
  });

  it('allows --format on check: it is the report shape', () => {
    expect(codes(['check', '--in', 'docs', '--format', 'json'])).toEqual([]);
    expect(optionsOf(['check', '--in', 'docs', '--format', 'json']).format).toBe('json');
  });
});

describe('parseArgs: totals', () => {
  it('never throws, whatever it is handed', () => {
    expect(parseArgs(null as unknown as string[]).options.help).toBe(true);
    expect(parseArgs(undefined as unknown as string[]).errors).toEqual([]);
    expect(codes(['--in', 42 as unknown as string])).toEqual(['missing-value']);
    expect(parseArgs(['extract', '--in', 'docs', '--bogus', 7 as unknown as string]).errors.length).toBe(1);
  });

  it('decides the same thing twice and hands out fresh options', () => {
    const argv = ['translate', '--in', 'docs', '--lang', 'vi'];
    expect(parseArgs(argv)).toEqual(parseArgs(argv));
    expect(parseArgs(argv).options).not.toBe(parseArgs(argv).options);
  });

  it('turns an empty error list into 0 and the first error into its family code', () => {
    expect(exitCodeFor([])).toBe(EXIT_CODES.ok);
    expect(exitCodeFor(parseArgs(['extract']).errors)).toBe(EXIT_CODES['missing-required']);
    expect(exitCodeFor(parseArgs(['check', '--in', 'docs', '--out', 'x']).errors)).toBe(
      EXIT_CODES['conflicting-options'],
    );
  });
});

// --- The plan --------------------------------------------------------------

describe('describe', () => {
  it('echoes the effective command and options in the documented order', () => {
    expect(describePlan(parseArgs(['extract', '--in', 'docs']))).toBe('extract --in docs --format md');
    expect(
      describePlan(
        parseArgs(['translate', '--in', 'docs', '--out', 'build', '--lang', 'vi', '--provider', 'local', '--offline', '--format', 'txt']),
      ),
    ).toBe('translate --in docs --out build --lang vi --provider local --offline --format txt');
    expect(describePlan(parseArgs(['check', '--in', 'docs', '--format', 'json']))).toBe(
      'check --in docs --format json',
    );
  });

  it('echoes the language it will use, not the spelling it was given', () => {
    expect(describePlan(parseArgs(['translate', '--in', 'docs', '--lang', 'vi-VN']))).toBe(
      'translate --in docs --lang vi --format md',
    );
  });

  it('leaves --dry-run out: it is how the line was called, not what the run would do', () => {
    expect(describePlan(parseArgs(['export', '--in', 'docs', '--dry-run']))).not.toContain('--dry-run');
  });

  it('says so when there is no command', () => {
    expect(describePlan({ command: null, options: defaultOptions() })).toBe(`${NO_COMMAND} --format md`);
  });

  it('echoes a value with a space as given, because it is for reading', () => {
    expect(describePlan({ command: 'export', options: { ...defaultOptions(), input: 'a b', format: 'json' } })).toBe(
      'export --in a b --format json',
    );
  });
});

// --- The help text ---------------------------------------------------------

describe('usage', () => {
  it('names every command and every flag the parser accepts', () => {
    const text = usage();
    for (const command of CLI_COMMANDS) expect(text).toContain(command);
    for (const flag of CLI_FLAGS) expect(text).toContain(flag);
    expect(text.startsWith(`${CLI_PROGRAM} —`)).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('documents exactly the exit codes the table can produce', () => {
    const text = usage();
    const section = text.slice(text.indexOf('Exit codes:'), text.indexOf('Examples:'));
    const documented = [...section.matchAll(/^\s+(\d+)\s{2}/gmu)].map(match => Number(match[1]));
    const produced = [...new Set(Object.values(EXIT_CODES))];
    expect([...documented].sort((left, right) => left - right)).toEqual(
      [...produced].sort((left, right) => left - right),
    );
  });

  it('explains that non-dry runs execute the durable local pipeline', () => {
    expect(usage()).toContain('durable local pipeline');
  });
});

// --- The runner ------------------------------------------------------------

describe('scripts/mirror-cli.mjs', () => {
  let folder = '';
  let emptyFolder = '';

  beforeAll(() => {
    folder = tempDir();
    writePdf(folder, 'b.pdf', 3);
    writePdf(folder, 'a.PDF', 4);
    writeFileSync(path.join(folder, 'notes.txt'), 'not a pdf');
    emptyFolder = tempDir();
  });

  it('prints the help with no arguments at all, and exits 0', () => {
    const result = run();
    expect(result.status).toBe(EXIT_CODES.ok);
    expect(result.stdout).toContain('Usage:');
    for (const command of CLI_COMMANDS) expect(result.stdout).toContain(command);
    for (const flag of CLI_FLAGS) expect(result.stdout).toContain(flag);
  });

  it('prints the help on --help and the version on --version', () => {
    expect(run('--help').status).toBe(EXIT_CODES.ok);
    expect(run('--help').stdout).toContain('Usage:');

    const version = run('--version');
    expect(version.status).toBe(EXIT_CODES.ok);
    const manifest = JSON.parse(read('../../package.json')) as { version: string };
    expect(version.stdout.trim()).toBe(`${CLI_PROGRAM} ${manifest.version}`);
  });

  it('lists the folder on check, by name, ignoring the file that is not a PDF', () => {
    const result = run('check', '--in', folder);
    expect(result.status).toBe(EXIT_CODES.ok);
    expect(result.stdout).toContain('2 PDFs in');
    expect(result.stdout).toContain('a.PDF');
    expect(result.stdout).toContain('b.pdf');
    expect(result.stdout).not.toContain('notes.txt');
  });

  it('reports check in json and txt without a banner in the way', () => {
    const json = run('check', '--in', folder, '--format', 'json');
    const report = JSON.parse(json.stdout) as {
      command: string;
      ran: boolean;
      count: number;
      note: string | null;
      pdfs: { name: string; bytes: number }[];
    };
    expect(json.status).toBe(EXIT_CODES.ok);
    expect(report.command).toBe('check');
    expect(report.ran).toBe(true);
    expect(report.note).toBeNull();
    expect(report.count).toBe(2);
    expect(report.pdfs.map(pdf => pdf.name)).toEqual(['a.PDF', 'b.pdf']);

    const txt = run('check', '--in', folder, '--format', 'txt');
    expect(txt.status).toBe(EXIT_CODES.ok);
    expect(txt.stdout.split(/\r?\n/u).filter(line => line !== '')).toEqual(['a.PDF', 'b.pdf']);
  });

  it('prints the plan on a dry run and writes nothing', () => {
    const before = readdirSync(folder).sort();
    const out = path.join(folder, 'out');
    const result = run('extract', '--in', folder, '--out', out, '--format', 'md', '--dry-run');

    expect(result.status).toBe(EXIT_CODES.ok);
    expect(result.stdout.split(/\r?\n/u)[0]).toBe(
      `dry run: ${describePlan(parseArgs(['extract', '--in', folder, '--out', out, '--format', 'md']))}`,
    );
    expect(result.stdout).toContain('2 PDFs in');
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(folder).sort()).toEqual(before);
  });

  it('keeps the dry-run path side-effect free', () => {
    const output = path.join(folder, 'cli-output');
    const result = run('extract', '--in', folder, '--out', output, '--dry-run');
    expect(result.status).toBe(EXIT_CODES.ok);
    expect(result.stdout).toContain('dry run: extract');
    expect(existsSync(output)).toBe(false);
  });

  it('exits 2 on a usage error and names the token', () => {
    const unknownFlag = run('extract', '--in', folder, '--nope');
    expect(unknownFlag.status).toBe(EXIT_CODES['unknown-flag']);
    expect(unknownFlag.stderr).toContain('--nope');

    const unknownCommand = run('delete', '--in', folder);
    expect(unknownCommand.status).toBe(EXIT_CODES['unknown-command']);
    expect(unknownCommand.stderr).toContain('delete');

    const noCommand = run('--dry-run');
    expect(noCommand.status).toBe(EXIT_CODES['missing-command']);
    expect(noCommand.stderr).toContain('no command');
  });

  it('refuses to run without --in, and says which option is missing', () => {
    const result = run('extract');
    expect(result.status).toBe(EXIT_CODES['missing-required']);
    expect(result.stderr).toContain('--in');
  });

  it('exits 4 on a value it cannot support and 5 on a combination it refuses', () => {
    const format = run('export', '--in', folder, '--format', 'pdf');
    expect(format.status).toBe(EXIT_CODES['unsupported-format']);
    expect(format.stderr).toContain('pdf');

    const provider = run('translate', '--in', folder, '--lang', 'vi', '--provider', 'azure');
    expect(provider.status).toBe(EXIT_CODES['unsupported-provider']);

    const conflict = run('translate', '--in', folder, '--lang', 'vi', '--provider', 'google', '--offline');
    expect(conflict.status).toBe(EXIT_CODES['conflicting-options']);
    expect(conflict.stderr).toContain('--offline');

    const checkOut = run('check', '--in', folder, '--out', 'build');
    expect(checkOut.status).toBe(EXIT_CODES['conflicting-options']);
  });

  it('exits 6 when --in cannot be used', () => {
    const missing = run('check', '--in', path.join(folder, 'nope'));
    expect(missing.status).toBe(EXIT_CODES['input-unusable']);
    expect(missing.stderr).toContain('does not exist');

    const file = run('check', '--in', path.join(folder, 'notes.txt'));
    expect(file.status).toBe(EXIT_CODES['input-unusable']);
    expect(file.stderr).toContain('not a folder');

    const empty = run('check', '--in', emptyFolder);
    expect(empty.status).toBe(EXIT_CODES['input-unusable']);
    expect(empty.stderr).toContain('no PDF files');
  });

  it('passes --lang through untouched: the language table belongs to the app core', () => {
    // The runner does not own the alias list, so it does not invent a refusal for a code it
    // cannot check. The parser in src/core/cli-args.ts does own that check.
    const result = run('check', '--in', folder, '--lang', 'not-a-code');
    expect(result.status).toBe(EXIT_CODES.ok);
    expect(result.stdout).toContain('2 PDFs in');
  });
});

// --- Drift between the two copies of the table -----------------------------

/**
 * The strings of an array literal in either file. Both tables are written on one line so this
 * is a read of the source and not a parse of a language; a helper that needed a parser would
 * be a helper that could be fooled by the parser's absence.
 */
function stringsIn(source: string, name: string): string[] {
  const match = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::[^=]*)?=\\s*\\[([^\\]]*)\\]`, 'u').exec(source);
  if (match === null) throw new Error(`no ${name} array in the source`);
  return [...(match[1] ?? '').matchAll(/'([^']*)'/gu)].map(item => item[1] ?? '');
}

/** The body of an object literal in either file. */
function objectBody(source: string, name: string): string {
  const match = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::[^=]*)?=\\s*\\{([\\s\\S]*?)\\n\\};`, 'u').exec(source);
  if (match === null) throw new Error(`no ${name} object in the source`);
  return match[1] ?? '';
}

/** `KEY: 2` pairs of a flat object literal. */
function numbersIn(source: string, name: string): Record<string, number> {
  const pairs: Record<string, number> = {};
  for (const match of objectBody(source, name).matchAll(/(?:'([^']+)'|([A-Za-z][\w-]*))\s*:\s*(\d+)/gu)) {
    pairs[match[1] ?? match[2] ?? ''] = Number(match[3]);
  }
  return pairs;
}

/** `command: ['--flag']` entries of an object literal. */
function listsIn(source: string, name: string): Record<string, string[]> {
  const entries: Record<string, string[]> = {};
  for (const match of objectBody(source, name).matchAll(/([A-Za-z][\w-]*)\s*:\s*\[([^\]]*)\]/gu)) {
    entries[match[1] ?? ''] = [...(match[2] ?? '').matchAll(/'([^']*)'/gu)].map(item => item[1] ?? '');
  }
  return entries;
}

describe('the parse table has one meaning in both files', () => {
  const moduleSource = read('../viewer/src/core/cli-args.ts');
  const runnerSource = read('../../scripts/mirror-cli.mjs');

  it('declares the same commands', () => {
    expect(stringsIn(runnerSource, 'CLI_COMMANDS')).toEqual([...CLI_COMMANDS]);
  });

  it('declares the same flags, and the same value flags', () => {
    expect(stringsIn(runnerSource, 'CLI_FLAGS')).toEqual([...CLI_FLAGS]);
    expect(stringsIn(runnerSource, 'CLI_VALUE_FLAGS')).toEqual([...CLI_VALUE_FLAGS]);
  });

  it('declares the same formats and providers', () => {
    expect(stringsIn(runnerSource, 'CLI_FORMATS')).toEqual([...CLI_FORMATS]);
    expect(stringsIn(runnerSource, 'PROVIDER_KINDS')).toEqual([...PROVIDER_KINDS]);
  });

  it('requires the same options per command', () => {
    expect(listsIn(runnerSource, 'REQUIRED_FLAGS')).toEqual(REQUIRED_FLAGS);
  });

  it('exits with the same code per outcome', () => {
    expect(numbersIn(runnerSource, 'EXIT_CODES')).toEqual(EXIT_CODES);
  });

  it('has the runner help name every flag and command it accepts', () => {
    const help = run('--help').stdout;
    for (const command of CLI_COMMANDS) expect(help).toContain(command);
    for (const flag of CLI_FLAGS) expect(help).toContain(flag);
    for (const format of CLI_FORMATS) expect(help).toContain(format);
    for (const provider of PROVIDER_KINDS) expect(help).toContain(provider);
  });

  it('keeps the runner from importing the TypeScript it cannot load', () => {
    expect(runnerSource).not.toMatch(/from\s+['"]\.\.\/src\//u);
    expect(runnerSource).not.toMatch(/import\s+['"]\.\.\/src\//u);
  });

  it('reads the same table the module exported, not a shorter one', () => {
    // If a flag were added to the module alone, this is the assertion that names the runner.
    expect(stringsIn(moduleSource, 'CLI_FLAGS')).toEqual([...CLI_FLAGS]);
  });
});

// --- Documentation and purity ----------------------------------------------

describe('docs/cli.md', () => {
  const document = read('../../docs/cli.md');

  it('names every command', () => {
    for (const command of CLI_COMMANDS) expect(document).toContain(`| \`${command}\` |`);
  });

  it('names every flag', () => {
    for (const flag of CLI_FLAGS) expect(document).toContain(`| \`${flag}\``);
  });

  it('names every exit code', () => {
    for (const code of new Set(Object.values(EXIT_CODES))) expect(document).toContain(`| \`${code}\` |`);
  });

  it('states that the heavy work runs through the local TypeScript bridge', () => {
    expect(document).toContain('TypeScript bridge');
  });
});

describe('purity', () => {
  /** Comments describe the rule; only code may be searched for a violation of it. */
  function withoutComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .split('\n')
      .map(line => line.replace(/(^|[^:])\/\/.*$/u, '$1'))
      .join('\n');
  }

  it('reads no file, no clock and no randomness: the same argv gives the same answer', () => {
    const code = withoutComments(read('../viewer/src/core/cli-args.ts'));
    expect(code).not.toMatch(/\bnode:/u);
    expect(code).not.toMatch(/\brequire\s*\(/u);
    expect(code).not.toMatch(/\bprocess\./u);
    expect(code).not.toMatch(/\bnew Date\b/u);
    expect(code).not.toMatch(/\bMath\.random\b/u);
    expect(code).not.toMatch(/\breadFile|\bwriteFile|\breaddir/u);
  });

  it('imports only the language and privacy tables it reasons about', () => {
    const code = withoutComments(read('../viewer/src/core/cli-args.ts'));
    const imports = [...code.matchAll(/^import[\s\S]*?from\s+'([^']+)';/gmu)].map(match => match[1]);
    expect(imports.sort()).toEqual(['./language', './privacy', './types']);
  });
});
