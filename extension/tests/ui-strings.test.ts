import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `scripts/check-ui-strings.mjs` is the gate for C14: the native capture picker
 * shipped English because nothing checked element text. These tests pin both
 * directions — the repository must be clean, and a fixture with one hardcoded
 * label must fail with exactly that label and line — plus the documented
 * exception path, which is only trustworthy if a missing reason is rejected.
 */

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const script = fileURLToPath(new URL('../../scripts/check-ui-strings.mjs', import.meta.url));
const fixtureRoot = fileURLToPath(new URL('./fixtures/ui-strings', import.meta.url));
const fixtureSource = 'native-shell/src/capture_picker.rs';
const fixtureLiteral = 'No capture sources found. Open a document window, then refresh.';

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd = repositoryRoot): Promise<Run> {
  return new Promise(resolve => {
    execFile(process.execPath, [script, ...args], { cwd, timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

interface Report {
  ok: boolean;
  sourceDirectory: string;
  scannedFiles: string[];
  files: number;
  literals: number;
  findings: { file: string; line: number; literal: string; reason: string | null }[];
  violations: { file: string; line: number; literal: string; reason: null }[];
  unusedAllowlist: string[];
  summary: string;
}

async function report(root = fixtureRoot): Promise<Report> {
  const result = await run(['--root', root, '--json']);
  expect(result.code, result.stderr).toBe(1);
  return JSON.parse(result.stdout) as Report;
}

describe('the repository passes the native UI string gate', () => {
  it('exits 0 and prints a summary that states nothing needs fixing', async () => {
    const result = await run([]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /^ui-strings: \d+ file\(s\) scanned, \d+ string literal\(s\), \d+ user-facing English literal\(s\), \d+ allowlisted, 0 to fix$/m,
    );
  }, 60_000);

  it('scans the capture picker, so a regression there cannot pass unnoticed', async () => {
    // The picker lives in app.rs; the source directory the script documents is
    // what decides that, so assert it is the one the gate actually reads.
    const result = await run(['--json']);
    const scanned = JSON.parse(result.stdout) as Report;
    expect(result.code).toBe(0);
    expect(scanned.sourceDirectory).toBe('native-shell/src');
    expect(scanned.scannedFiles).toContain('native-shell/src/app.rs');
    expect(scanned.files).toBeGreaterThan(30);
    expect(scanned.literals).toBeGreaterThan(1000);
  }, 60_000);
});

describe('the fixture with one hardcoded label', () => {
  it('reports exactly that literal, at its own line, and nothing else', async () => {
    const text = await readFile(path.join(fixtureRoot, fixtureSource), 'utf8');
    const expectedLine = text.split('\n').findIndex(line => line.includes(fixtureLiteral)) + 1;
    expect(expectedLine).toBeGreaterThan(0);

    const found = await report();
    expect(found.ok).toBe(false);
    expect(found.violations).toEqual([{ file: fixtureSource, line: expectedLine, literal: fixtureLiteral, reason: null }]);
    expect(found.findings).toHaveLength(1);
    expect(found.unusedAllowlist).toEqual([]);
    expect(found.summary).toMatch(
      /^ui-strings: 1 file\(s\) scanned, \d+ string literal\(s\), 1 user-facing English literal\(s\), 0 allowlisted, 1 to fix$/,
    );
  });

  it('names the offending file and literal in the human-readable output', async () => {
    const result = await run(['--root', fixtureRoot]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`${fixtureSource}:${await fixtureLine()}`);
    expect(result.stdout).toContain(`"${fixtureLiteral}"`);
    expect(result.stdout).toContain('1 to fix');
    expect(result.stderr).toContain('tr3(zh, en, vi)');
  });
});

describe('documented exceptions', () => {
  it('accepts an allowlisted literal and reports it as allowlisted', async () => {
    const root = await copyFixture();
    await writeAllowlist(root, `${fixtureSource}:${fixtureLiteral}  # fixture: accepted for this test\n`);

    const result = await run(['--root', root, '--json']);
    expect(result.code, result.stderr).toBe(0);
    const found = JSON.parse(result.stdout) as Report;
    expect(found.violations).toEqual([]);
    expect(found.findings).toHaveLength(1);
    expect(found.findings[0]?.reason).toBe('fixture: accepted for this test');
    expect(found.summary.endsWith('1 allowlisted, 0 to fix')).toBe(true);
  });

  it('rejects an entry that carries no reason', async () => {
    const root = await copyFixture();
    await writeAllowlist(root, `${fixtureSource}:${fixtureLiteral}\n`);

    const result = await run(['--root', root]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/every entry needs a reason/);
  });

  it('warns about an entry that matches nothing, without failing', async () => {
    const root = await copyFixture();
    await writeAllowlist(root, `${fixtureSource}:Some label that no longer exists  # stale fixture entry\n`);

    const result = await run(['--root', root]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('matches nothing');
    expect(result.stderr).toContain(fixtureSource);
  });
});

async function copyFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ui-strings-'));
  created.push(root);
  await cp(fixtureRoot, root, { recursive: true });
  return root;
}

async function writeAllowlist(root: string, contents: string): Promise<void> {
  const directory = path.join(root, 'scripts');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'ui-strings-allowlist.txt'), contents);
}

async function fixtureLine(): Promise<number> {
  const text = await readFile(path.join(fixtureRoot, fixtureSource), 'utf8');
  return text.split('\n').findIndex(line => line.includes(fixtureLiteral)) + 1;
}
