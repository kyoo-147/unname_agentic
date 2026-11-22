import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const prePush = fileURLToPath(new URL('../scripts/pre-push.ps1', import.meta.url));
const releaseCheck = fileURLToPath(new URL('../scripts/release-check.mjs', import.meta.url));

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runNodeEvidence(result: { code: number; error: string | null }, output: string): Promise<Record<string, unknown>> {
  const moduleUrl = pathToFileURL(releaseCheck).href;
  const expression = [
    `import { unitTestEvidence } from ${JSON.stringify(moduleUrl)};`,
    `console.log(JSON.stringify(unitTestEvidence(${JSON.stringify(result)}, ${JSON.stringify(output)})));`,
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', expression], { cwd: repositoryRoot }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || stdout || error.message}`));
        return;
      }
      resolve(JSON.parse(stdout) as Record<string, unknown>);
    });
  });
}

async function runPrePush(pnpmScript: string): Promise<Run> {
  const fakeBin = await mkdtemp(path.join(tmpdir(), 'quality-gate-pnpm-'));
  try {
    await writeFile(path.join(fakeBin, 'pnpm.cmd'), pnpmScript, 'utf8');
    return await new Promise(resolve => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', prePush, '-Quick'],
        {
          cwd: repositoryRoot,
          env: { ...process.env, Path: `${fakeBin};${process.env.Path ?? ''}` },
          timeout: 120_000,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
}

const failedPnpmTest = `@echo off
if "%1"=="typecheck" exit /b 0
if "%1"=="test" (
  echo Tests  2 passed ^| 1 failed (3)
  exit /b 1
)
exit /b 0
`;

const successfulPnpmTest = `@echo off
if "%1"=="typecheck" exit /b 0
if "%1"=="test" (
  echo Tests  3 passed (3)
  exit /b 0
)
exit /b 0
`;

const emptySummaryPnpmTest = `@echo off
if "%1"=="typecheck" exit /b 0
if "%1"=="test" (
  echo test process finished without a Vitest summary
  exit /b 0
)
exit /b 0
`;

describe('quality gate process evidence', () => {
  it('rejects a failed test process even when output contains passing tests', async () => {
    const evidence = await runNodeEvidence(
      { code: 1, error: null },
      'Tests  2 passed (2)',
    );
    expect(evidence.processPassed).toBe(false);
    expect(evidence.ok).toBe(false);
    expect(evidence.passing).toBe(0);
  });

  it('rejects capture exceptions such as PowerShell or OOM failures', async () => {
    const evidence = await runNodeEvidence(
      { code: 1, error: 'System.OutOfMemoryException while capturing test output' },
      'Tests  3 passed (3)',
    );
    expect(evidence.processPassed).toBe(false);
    expect(evidence.ok).toBe(false);
    expect(evidence.passing).toBe(0);
  });

  it('accepts only a successful process with a non-empty passing summary', async () => {
    const evidence = await runNodeEvidence(
      { code: 0, error: null },
      'Tests  3 passed (3)',
    );
    expect(evidence.processPassed).toBe(true);
    expect(evidence.summaryPresent).toBe(true);
    expect(evidence.ok).toBe(true);
    expect(evidence.passing).toBe(3);
  });

  it('blocks a failed pnpm test in the PowerShell pre-push gate', async () => {
    const result = await runPrePush(failedPnpmTest);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('[pre-push] BLOCKED: pnpm test exited 1');
    expect(result.stdout).not.toContain('[pre-push] all gates passed');
  });

  it('blocks an empty test summary instead of treating exit 0 as green', async () => {
    const result = await runPrePush(emptySummaryPnpmTest);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('pnpm test produced no readable summary');
    expect(result.stdout).not.toContain('[pre-push] all gates passed');
  });

  it('allows a successful test process with a readable passing summary', async () => {
    const result = await runPrePush(successfulPnpmTest);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('[pre-push] Tests  3 passed');
    expect(result.stdout).toContain('[pre-push] all gates passed');
  });

  it('keeps PowerShell capture exceptions fail-closed and bounded', async () => {
    const source = await readFile(prePush, 'utf8');
    expect(source).not.toContain('Out-String');
    expect(source).toContain('output capture failed');
    expect(source).toContain('native process exit code was not available');
    expect(source).toContain('$maxCaptureBytes = 512KB');
  });
});
