#!/usr/bin/env node
/**
 * Release gate runner (backlog N08).
 *
 * The checklist in `docs/release-checklist.md` says what a release needs; `extension/viewer/src/core/
 * release-gate.ts` says what happens when one is missing. This script is the third part:
 * it goes and looks. Every fact it hands the gate was observed — a command's exit code, a
 * count in a suite's own summary, a file on disk, a modification time — and when a command
 * fails the table says so instead of quietly reading zero.
 *
 * What it runs, and why each one is here:
 *
 * - `pnpm typecheck` — the sources compile. A release built from sources that do not
 *   typecheck is not the artifact anybody reviewed.
 * - `pnpm test:extension` - the extension-owned unit suite. Its passing count is parsed from vitest's own summary;
 *   a red run is recorded as 0 passing tests *for the release* and the real numbers are
 *   printed beside it, because a release does not rest on a suite that failed.
 * - `node scripts/check-committed-imports.mjs` — every relative import resolves against the
 *   files committed at HEAD. This gate exists because a green local build cannot catch a
 *   module that was imported but never added.
 * - externally recorded Chrome/extension browser E2E evidence. The row remains blocked
 *   until `RELEASE_BROWSER_E2E_TESTS` records a real run; this checker never invents it.
 * - the build output — `dist/extension/index.html` and its assets, produced by `pnpm build`
 *   (`--build` runs that command first; without it the row is the output already on disk).
 * - the release package — the newest commit-bound `dist/pdf-workspace-*-release-*` directory
 *   with its sibling archive and required native files.
 * - the third-party notices - every runtime dependency in `package.json` must be named in
 *   one of the notice/licence documents under `extension/viewer/public/`.
 * - the changelog — `CHANGELOG.md` must name the version being shipped.
 * - the feature inventory — a timestamp proxy: `docs/features.md` versus the newest source
 *   file. The gate warns on it, never blocks: only a person can confirm the content.
 *
 * Node loads `extension/viewer/src/core/release-gate.ts` directly (type stripping since 22.18); the resolve
 * hook below adds the extension Node's ESM resolver insists on, because the repository's
 * imports are extensionless by convention — the same trick `scripts/perf-budget.mjs` uses.
 *
 * Usage:
 *   node scripts/release-check.mjs                preflight, no build
 *   node scripts/release-check.mjs --build       the release run
 *   node scripts/release-check.mjs --json         machine-readable report
 *   node scripts/release-check.mjs --help
 *
 * Environment:
 *   RELEASE_NATIVE_TESTS   passing native tests, when the Rust gate was run separately
 *
 * Exit codes: 0 no blocker (warnings allowed), 1 at least one blocker, 2 the runner itself
 * could not run. This script does not sign anything and does not run the native suite.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const releaseGatePath = path.join(root, 'extension', 'viewer', 'src', 'core', 'release-gate.ts');
const distDir = path.join(root, 'dist');
const extensionIndex = path.join(distDir, 'extension', 'index.html');
const extensionAssets = path.join(distDir, 'extension', 'assets');
const changelogPath = path.join(root, 'CHANGELOG.md');
const featuresDoc = path.join(root, 'docs', 'features.md');

// --- Policy ----------------------------------------------------------------

/**
 * Where a notice for a runtime dependency may appear, by the name the document uses.
 *
 * The notice text names "pdf.js (PDF.js)" for the `pdfjs-dist` package, which is the only
 * mismatch between a registry name and a document name in this repository. Everything else
 * is found by its package name. `@pdf-lib/fontkit` is a separate copyright holder from
 * `pdf-lib`, so it needs its own mention rather than inheriting the parent's.
 */
const NOTICE_ALIASES = Object.freeze({
  'pdfjs-dist': ['pdf.js', 'pdfjs-dist'],
  '@pdf-lib/fontkit': ['@pdf-lib/fontkit', 'fontkit'],
});

/** Files under `extension/viewer/public/` whose name marks them as a notice or a licence text. */
const NOTICE_FILE = /(NOTICE|LICEN[CS]E|COPYING|OFL)/iu;

/** A notice document smaller than this is a placeholder, not a licence. */
const MIN_NOTICE_BYTES = 200;

/** Files newer than `docs/features.md` make the feature inventory stale. */
const SOURCE_DIRS = ['extension', 'native-shell', 'scripts'];
const IGNORED_WALK_DIRS = new Set(['.git', 'node_modules', 'target', 'dist']);

/** How much of a command's output is kept for parsing and for showing a failure. */
const OUTPUT_TAIL_CHARS = 400_000;
const FAILURE_LINES = 8;

/** Per-command timeouts, generous enough for a loaded machine. */
const TIMEOUTS = Object.freeze({
  typecheck: 5 * 60_000,
  test: 15 * 60_000,
  imports: 2 * 60_000,
  build: 10 * 60_000,
});

/** Table width for the "observed" column, so one long path cannot break the layout. */
const OBSERVED_WIDTH = 74;

// --- Small helpers ---------------------------------------------------------

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

/** Strips ANSI colour sequences so a summary line can be parsed and printed. */
function plain(text) {
  return text.replace(/\u001b\[[0-9;]*m/gu, '');
}

/** The last `limit` characters, which is where every summary lives. */
function tail(text, limit = OUTPUT_TAIL_CHARS) {
  return text.length > limit ? text.slice(-limit) : text;
}

/** One line, collapsed and cut to `width` characters. */
function clip(text, width = OBSERVED_WIDTH) {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/** `1.2 s`, `3.4 min`. */
function duration(ms) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** `11.3 MB`, `812 B`. */
function bytes(size) {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

/** `1 test`, `0 tests`, `2 dependencies`. */
function countOf(count, noun, plural = `${noun}s`) {
  return `${count} ${count === 1 ? noun : plural}`;
}

/** A fixed-width table; every column left-aligned except the last, which is right-aligned. */
function formatTable(header, rows) {
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map(cells => (cells[index] ?? '').length)),
  );
  const line = cells =>
    cells
      .map((cell, index) =>
        index === header.length - 1 ? cell.padStart(widths[index]) : cell.padEnd(widths[index]),
      )
      .join('  ');
  return [
    line(header),
    widths.map(width => '-'.repeat(width)).join('  '),
    ...rows.map(line),
  ].join('\n');
}

/** Every regular file under `dir`, sorted, without following symlinked loops. */
function walk(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !IGNORED_WALK_DIRS.has(entry.name)) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

/** A path relative to the repository root, with forward slashes, for the table. */
function relative(full) {
  return path.relative(root, full).split(path.sep).join('/');
}

// --- Running commands ------------------------------------------------------

/**
 * Runs one command and records what it did.
 *
 * `shell` is on only for `pnpm` on Windows: pnpm is a `.cmd` shim there and Node refuses to
 * spawn a batch file directly. Everything else runs as an executable with an argument
 * vector, so no argument is ever re-parsed by a shell.
 */
function run(command, args, timeoutMs) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
    shell: process.platform === 'win32' && command === 'pnpm',
  });
  const elapsedMs = Date.now() - startedAt;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const errored = result.error !== undefined && result.error !== null;
  return {
    code: errored ? 1 : (result.status ?? 1),
    error: errored ? result.error.message : null,
    stdout: tail(plain(stdout)),
    stderr: tail(plain(stderr)),
    elapsedMs,
    label: [command, ...args].join(' '),
  };
}

/** The combined output of a run, for parsing and for showing a failure. */
function output(runResult) {
  return `${runResult.stdout}\n${runResult.stderr}`;
}

/** The lines of a failure worth printing: the tail of its output, without blank lines. */
function failureLines(runResult) {
  const lines = output(runResult)
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0);
  return lines.slice(-FAILURE_LINES);
}

// --- Parsing command output ------------------------------------------------

/**
 * The counts in vitest's own summary line, e.g. `Tests  2 failed | 375 passed (378)`.
 *
 * Read from the last line that starts with `Tests` (the `Test Files` line does not match),
 * and `null` when no such line exists — a suite that crashed prints no summary, and that
 * must read as no count, never as zero passing tests.
 */
export function parseVitest(outputText) {
  const line = outputText
    .split('\n')
    .filter(candidate => /^\s*Tests\s+\d/u.test(candidate))
    .pop();
  if (line === undefined) return null;

  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0 };
  let parsed = 0;
  for (const match of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo)\b/gu)) {
    const kind = match[2];
    const value = Number(match[1]);
    if (kind in counts && Number.isSafeInteger(value)) {
      counts[kind] = value;
      parsed += 1;
    }
  }
  return parsed === 0 ? null : counts;
}

/** A green process without a readable non-empty Vitest summary is not test evidence. */
export function unitTestEvidence(result, outputText) {
  const counts = parseVitest(outputText);
  const processPassed = result?.code === 0 && result?.error == null;
  const summaryPresent = counts !== null;
  const passing = processPassed && summaryPresent ? counts.passed : 0;
  return {
    counts,
    processPassed,
    summaryPresent,
    passing,
    ok: processPassed && summaryPresent && counts.passed >= 1 && counts.failed === 0,
  };
}

/** Positive externally recorded browser E2E count; missing evidence stays missing. */
function readBrowserE2eEvidence(floor) {
  const raw = process.env.RELEASE_BROWSER_E2E_TESTS;
  const count = raw === undefined || raw.trim() === '' ? null : Number(raw);
  const valid = Number.isFinite(count) && count >= 1 ? Math.floor(count) : null;
  return {
    observed: valid === null
      ? 'not recorded; real Chrome/extension browser E2E remains unverified'
      : `${valid} externally recorded browser E2E tests, floor ${floor}`,
    recorded: valid ?? 0,
    run: null,
  };
}

// --- Observing each check --------------------------------------------------

/** Reads `package.json`; a missing or unreadable one is the runner failing, not a blocker. */
function readPackage() {
  const file = path.join(root, 'package.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`release-check: cannot read package.json: ${error.message}`, 2);
  }
}

/** `pnpm typecheck`. */
function checkTypecheck() {
  const result = run('pnpm', ['typecheck'], TIMEOUTS.typecheck);
  return {
    state: result.code === 0 ? 'pass' : 'fail',
    observed: result.code === 0
      ? `exit 0 (${duration(result.elapsedMs)})`
      : `exit ${result.code} (${duration(result.elapsedMs)})${result.error === null ? '' : `: ${result.error}`}`,
    run: result,
  };
}

/**
 * `pnpm test:extension`, and the passing count it reported.
 *
 * The count recorded for the release is 0 unless the run was green: the row keeps the real
 * numbers either way, so nothing is hidden behind that decision.
 */
function checkUnitTests() {
  const result = run('pnpm', ['test:extension'], TIMEOUTS.test);
  const evidence = unitTestEvidence(result, output(result));
  const { counts } = evidence;
  const recorded = evidence.ok ? evidence.passing : 0;

  let observed;
  if (counts === null) {
    observed = `exit ${result.code}: no test summary (${duration(result.elapsedMs)})`;
  } else {
    const skipped = counts.skipped > 0 ? `, ${counts.skipped} skipped` : '';
    const failed = counts.failed > 0 ? `${counts.failed} failed | ` : '';
    observed = `${failed}${counts.passed} passed${skipped}, exit ${result.code} `
      + `(${duration(result.elapsedMs)})`;
    if (!evidence.ok) observed += ' - recorded 0, run was not green';
  }

  return { observed, recorded, summaryPresent: evidence.summaryPresent, evidenceOk: evidence.ok, run: result };
}

/** `node scripts/check-committed-imports.mjs`. */
function checkCommittedImports() {
  const result = run(process.execPath, ['scripts/check-committed-imports.mjs'], TIMEOUTS.imports);
  const summary = result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('committed-imports:'))
    .pop();
  const message = result.stderr
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)[0];

  return {
    state: result.code === 0 ? 'pass' : 'fail',
    observed: result.code === 0
      ? (summary ?? `exit 0 (${duration(result.elapsedMs)})`).replace('committed-imports: ', '')
      : `exit ${result.code}${message === undefined ? '' : `: ${message}`}`,
    run: result,
  };
}

/**
 * The build output, and with `--build` the command that produces it.
 *
 * The gate is about the artifact a release ships, so the output is what is read: `dist/extension`
 * must hold an index and at least one asset. Rebuilding is a flag rather than the default
 * because a preflight should not rewrite `dist/` under a running review.
 */
function checkBuild(options) {
  const command = options.build
    ? run('pnpm', ['build'], TIMEOUTS.build)
    : null;

  if (command !== null && command.code !== 0) {
    return {
      state: 'fail',
      observed: `pnpm build exited ${command.code} (${duration(command.elapsedMs)})`,
      run: command,
    };
  }

  const built = existsSync(extensionIndex) ? statSync(extensionIndex) : null;
  const assets = existsSync(extensionAssets) ? walk(extensionAssets) : [];
  if (built === null || assets.length === 0) {
    const reason = built === null ? 'dist/extension/index.html is missing' : 'dist/extension/assets is empty';
    return {
      state: 'fail',
      observed: command === null ? reason : `${reason} after pnpm build`,
      run: command,
    };
  }

  const stamp = new Date(built.mtimeMs).toISOString().replace('T', ' ').slice(0, 16);
  const prefix = command === null ? '' : `rebuilt in ${duration(command.elapsedMs)}; `;
  return {
    state: 'pass',
    observed: `${prefix}dist/extension built ${stamp}Z, ${countOf(assets.length, 'asset')}`,
    run: command,
  };
}

/**
 * Third-party notices, and which bundled dependencies no notice names.
 *
 * The set of components is the runtime `dependencies` in `package.json` — those are the
 * packages that can be bundled into the extension viewer; `devDependencies` are build tools and ship
 * nowhere. The documents are every notice/licence file under `extension/viewer/public/`, which is what the
 * build copies into `dist/extension`. A component is covered when one
 * document names it (or a documented alias); a file that exists but is a stub does not
 * count.
 */
function checkNotices(pkg) {
  const documents = [];
  for (const file of walk(path.join(root, 'extension', 'viewer', 'public'))) {
    if (!NOTICE_FILE.test(path.basename(file))) continue;
    if (statSync(file).size < MIN_NOTICE_BYTES) continue;
    documents.push(file);
  }

  let corpus = '';
  for (const file of documents) corpus += `\n${readFileSync(file, 'utf8').toLowerCase()}`;

  const bundled = Object.keys(pkg.dependencies ?? {});
  const missing = [];
  for (const name of bundled) {
    const aliases = NOTICE_ALIASES[name] ?? [name];
    const named = aliases.some(alias => corpus.includes(alias.toLowerCase()));
    if (!named) missing.push(name);
  }

  // On a failure the row counts; the findings section names each dependency, so the table
  // does not repeat a list that would not fit.
  const observed = missing.length === 0
    ? `${countOf(documents.length, 'document')} name all ${countOf(bundled.length, 'runtime dependency', 'runtime dependencies')}`
    : `${countOf(documents.length, 'document')} read, ${countOf(missing.length, 'runtime dependency', 'runtime dependencies')} unnamed`;

  return {
    observed,
    bundledNotices: documents.map(relative),
    missing,
  };
}

/**
 * The newest release package under `dist/`.
 *
 * A debug package is not a release package: a release is built with the release profile and
 * packaged with `scripts/package-native.ps1`, so only a `-release-` artifact counts.
 */
function checkPackageArtifact() {
  if (!existsSync(distDir)) return { observed: 'dist/ is missing', artifact: null, state: 'fail' };

  const candidates = [];
  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!/^pdf-workspace-.*-release-/u.test(entry.name) || !entry.isDirectory()) continue;
    const full = path.join(distDir, entry.name);
    candidates.push({ full, mtimeMs: statSync(full).mtimeMs, size: sizeOf(full) });
  }
  if (candidates.length === 0) return { observed: 'no native release package directory', artifact: null, state: 'fail' };

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const newest = candidates[0];
  const required = [
    'MANIFEST.json',
    'CHECKSUMS.sha256',
    'pdf_workspace.exe',
    'pdfium.dll',
    'pdf-workspace-host.exe',
    'install-native-host.ps1',
    'native-messaging/com.pdfworkspace.bridge.template.json',
    'third-party-notices/OCR-MODEL-NOTICE.txt',
  ];
  const missing = required.filter(item => !existsSync(path.join(newest.full, ...item.split('/'))));
  const zip = `${newest.full}.zip`;
  const zipChecksum = `${zip}.sha256`;
  if (!existsSync(zip)) missing.push(`${path.basename(zip)} (archive)`);
  if (!existsSync(zipChecksum)) missing.push(`${path.basename(zipChecksum)} (archive checksum)`);
  if (missing.length > 0) {
    return {
      observed: `${relative(newest.full)} incomplete: missing ${missing.join(', ')}`,
      artifact: null,
      state: 'fail',
    };
  }
  try {
    const manifest = JSON.parse(readFileSync(path.join(newest.full, 'MANIFEST.json'), 'utf8'));
    if (manifest.schema !== 1 || manifest.profile !== 'release' || typeof manifest.source?.commit !== 'string' || manifest.source.commit.trim() === '') {
      return { observed: `${relative(newest.full)} has invalid provenance manifest`, artifact: null, state: 'fail' };
    }
    if (manifest.evidence?.native_host_readiness !== 'not-run' || manifest.evidence?.chrome_host_e2e !== 'not-run' || manifest.evidence?.code_signing !== 'not-configured') {
      return { observed: `${relative(newest.full)} has invalid or overstated native/signing evidence`, artifact: null, state: 'fail' };
    }
    const packageFiles = new Map();
    for (const record of manifest.files ?? []) {
      if (typeof record.path !== 'string' || record.path.includes('..') || path.isAbsolute(record.path) || record.path.includes('\\') || packageFiles.has(record.path.toLowerCase())) {
        return { observed: `${relative(newest.full)} has unsafe or duplicate manifest path`, artifact: null, state: 'fail' };
      }
      const file = path.join(newest.full, ...record.path.split('/'));
      if (!existsSync(file) || !statSync(file).isFile()) return { observed: `${relative(newest.full)} is missing ${record.path}`, artifact: null, state: 'fail' };
      const bytes = readFileSync(file);
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (hash !== record.sha256 || bytes.length !== record.bytes) return { observed: `${relative(newest.full)} hash/size mismatch for ${record.path}`, artifact: null, state: 'fail' };
      packageFiles.set(record.path.toLowerCase(), record);
    }
    const zipChecksumLine = readFileSync(zipChecksum, 'utf8').trim();
    const zipChecksumMatch = /^([a-f0-9]{64})  (.+)$/u.exec(zipChecksumLine);
    if (!zipChecksumMatch || zipChecksumMatch[2] !== path.basename(zip) || createHash('sha256').update(readFileSync(zip)).digest('hex') !== zipChecksumMatch[1]) {
      return { observed: `${relative(newest.full)} archive checksum is invalid`, artifact: null, state: 'fail' };
    }
    const checksums = readFileSync(path.join(newest.full, 'CHECKSUMS.sha256'), 'utf8').split(/\r?\n/u).filter(Boolean);
    const checksumPaths = new Set();
    for (const line of checksums) {
      const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
      if (!match || match[2].includes('..') || path.isAbsolute(match[2]) || match[2].includes('\\') || checksumPaths.has(match[2].toLowerCase())) {
        return { observed: `${relative(newest.full)} has invalid or duplicate checksum entries`, artifact: null, state: 'fail' };
      }
      const file = path.join(newest.full, ...match[2].split('/'));
      if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== match[1]) {
        return { observed: `${relative(newest.full)} checksum mismatch for ${match[2]}`, artifact: null, state: 'fail' };
      }
      checksumPaths.add(match[2].toLowerCase());
    }
    if (checksumPaths.size !== packageFiles.size + 1 || !checksumPaths.has('manifest.json') || [...packageFiles.keys()].some(file => !checksumPaths.has(file))) {
      return { observed: `${relative(newest.full)} manifest and checksum inventories differ`, artifact: null, state: 'fail' };
    }
  } catch (error) {
    return { observed: `${relative(newest.full)} MANIFEST.json is unreadable: ${error.message}`, artifact: null, state: 'fail' };
  }
  const size = newest.size === null ? '' : ` (${bytes(newest.size)})`;
  return { observed: `${relative(newest.full)}${size}; manifest and archive present`, artifact: relative(newest.full), state: 'pass' };
}

/** Bytes for a file or the sum of a directory's files; null when it cannot be read. */
function sizeOf(full) {
  try {
    const stats = statSync(full);
    if (!stats.isDirectory()) return stats.size;
    let total = 0;
    for (const file of walk(full)) total += statSync(file).size;
    return total;
  } catch {
    return null;
  }
}

/** Whether `CHANGELOG.md` names `version` as a whole token. */
function checkChangelog(version) {
  if (!existsSync(changelogPath)) {
    return { has: false, observed: 'CHANGELOG.md is missing' };
  }

  const text = readFileSync(changelogPath, 'utf8');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // A version is a token: `0.1.0` must not be found inside `10.1.0` or `0.1.01`.
  const pattern = new RegExp(`(^|[^\\d.])${escaped}([^\\d.]|$)`, 'u');
  const has = pattern.test(text);
  return {
    has,
    observed: has
      ? `CHANGELOG.md names ${version}`
      : `CHANGELOG.md has no entry for ${version}`,
  };
}

function vitestEvidenceOk(result) {
  return unitTestEvidence(result, output(result)).ok;
}

function checkQualityEvidence(unit) {
  const testArgs = files => ['vitest', 'run', '--config', 'extension/vitest.config.ts', ...files.map(file => `extension/tests/${file}`)];
  const trustRun = run('pnpm', testArgs(['quality-gates.test.ts', 'network-guard.test.ts', 'crypto.test.ts', 'audit.test.ts', 'capabilities.test.ts', 'security-policy.test.ts', 'resource-limits.test.ts', 'evidence-contract.test.ts']), TIMEOUTS.test);
  const translationRun = run('pnpm', testArgs(['translation-core.test.ts', 'translation-batch.test.ts', 'translation-service-batch.test.ts']), TIMEOUTS.test);
  const exportRun = run('pnpm', testArgs(['export-bilingual.test.ts', 'export-check.test.ts', 'pdf-export.test.ts']), TIMEOUTS.test);
  const accessibilityRun = run('pnpm', testArgs(['a11y.test.ts']), TIMEOUTS.test);
  const ocrRun = run(process.execPath, ['scripts/ocr-benchmark.mjs', '--json'], TIMEOUTS.test);
  const perfRun = run(process.execPath, ['scripts/perf-budget.mjs', '--json'], TIMEOUTS.test);
  const i18nRun = run(process.execPath, ['scripts/i18n-matrix.mjs'], TIMEOUTS.test);
  const parseJson = result => {
    try { return JSON.parse(result.stdout); } catch { return null; }
  };
  const ocr = parseJson(ocrRun);
  const perf = parseJson(perfRun);
  const licenseRun = run(process.execPath, ['scripts/dependency-license-check.mjs'], TIMEOUTS.test);
  const license = parseJson(licenseRun);
  const sbomPass = license?.ok === true && licenseRun.code === 0;
  const core = vitestEvidenceOk(trustRun) && unit.evidenceOk ? 'pass' : 'fail';
  return {
    evidence: {
      privacy: core,
      secretBoundary: core,
      resourceLimits: core,
      consentAudit: core,
      retention: core,
      goldenDataset: ocr?.measured > 0 ? 'pass' : 'fail',
      ocrBenchmark: ocr?.measured > 0 && ocrRun.code === 0 ? 'pass' : 'fail',
      translationBenchmark: vitestEvidenceOk(translationRun) ? 'pass' : 'fail',
      exportBenchmark: vitestEvidenceOk(exportRun) ? 'pass' : 'fail',
      performanceBenchmark: perf?.violations?.length === 0 && perf?.bundle?.built === true && perfRun.code === 0 ? 'pass' : 'fail',
      i18n: i18nRun.code === 0 ? 'pass' : 'fail',
      accessibility: vitestEvidenceOk(accessibilityRun) ? 'pass' : 'fail',
      sbom: sbomPass ? 'pass' : 'fail',
    },
    observed: {
      ocr: ocrRun,
      performance: perfRun,
      i18n: i18nRun,
      trust: trustRun,
      translation: translationRun,
      export: exportRun,
      accessibility: accessibilityRun,
      licenses: licenseRun,
      sbom: sbomPass ? 'CycloneDX dependency/license check passed' : 'dependency/license check failed',
    },
  };
}

function checkFeaturesDoc() {
  if (!existsSync(featuresDoc)) {
    return { updated: false, observed: 'docs/features.md is missing' };
  }

  const inventoryMs = statSync(featuresDoc).mtimeMs;
  let newestMs = 0;
  let newestFile = null;
  for (const dir of SOURCE_DIRS) {
    for (const file of walk(path.join(root, dir))) {
      const stats = statSync(file);
      if (stats.mtimeMs > newestMs) {
        newestMs = stats.mtimeMs;
        newestFile = file;
      }
    }
  }

  if (newestFile === null || inventoryMs >= newestMs) {
    return { updated: true, observed: 'docs/features.md is at least as new as the sources' };
  }

  const age = newestMs - inventoryMs;
  const older = age >= 3_600_000
    ? `${(age / 3_600_000).toFixed(1)} h`
    : `${Math.round(age / 60_000)} min`;
  return {
    updated: false,
    observed: `mtime: docs/features.md ${older} behind ${relative(newestFile)}`,
  };
}

function evidenceStatus(raw, fallback = 'unknown') {
  const value = raw?.trim().toLowerCase();
  return value === 'pass' || value === 'blocked' || value === 'unknown' ? value : fallback;
}

/** Native evidence is pass only when a positive count came from a real native run. */
export function readNativeEvidence() {
  const rawCount = process.env.RELEASE_NATIVE_TESTS;
  const count = rawCount === undefined || rawCount.trim() === '' ? null : Number(rawCount);
  const validCount = Number.isFinite(count) && count >= 1 ? Math.floor(count) : null;
  const explicit = evidenceStatus(process.env.RELEASE_NATIVE_STATUS);
  if (explicit === 'blocked') {
    return { status: 'blocked', count: null, observed: process.env.RELEASE_NATIVE_BLOCKER?.trim() || 'native run is blocked; no native pass is claimed' };
  }
  if (explicit === 'pass') {
    if (validCount === null) return { status: 'blocked', count: null, observed: 'RELEASE_NATIVE_STATUS=pass requires RELEASE_NATIVE_TESTS >= 1' };
    return { status: 'pass', count: validCount, observed: `${validCount} passing native tests recorded from a native run` };
  }
  if (explicit === 'unknown' && validCount === null) return { status: 'unknown', count: null, observed: 'native evidence explicitly marked unknown' };
  if (validCount !== null) return { status: 'blocked', count: null, observed: 'positive RELEASE_NATIVE_TESTS is insufficient without RELEASE_NATIVE_STATUS=pass from a real native run' };
  if (rawCount !== undefined && rawCount.trim() !== '') return { status: 'unknown', count: null, observed: `RELEASE_NATIVE_TESTS="${rawCount}" is not a positive count` };
  return { status: 'unknown', count: null, observed: 'not recorded; native build/test did not execute or its evidence was not supplied' };
}

/** CI evidence is reported separately so a billing/runner lock is never printed as green. */
function readCiEvidence() {
  const status = evidenceStatus(process.env.RELEASE_CI_STATUS);
  if (status === 'pass') return { status, observed: 'CI pass explicitly recorded' };
  if (status === 'blocked') return { status, observed: process.env.RELEASE_CI_BLOCKER?.trim() || 'CI is blocked' };
  if (status === 'unknown') return { status, observed: 'CI evidence explicitly marked unknown' };
  return { status: 'unknown', observed: 'CI status not recorded; no green CI claim is made' };
}

// --- Loading the gate module ----------------------------------------------

/**
 * Node's ESM resolver needs an extension; the repository's imports do not use one. The hook
 * only rewrites relative specifiers that have no extension and resolve to a `.ts` file.
 */
function installTypeScriptResolver() {
  if (typeof registerHooks !== 'function') {
    fail(
      `release-check: Node 22.15 or newer is required for module.registerHooks; this is Node ${process.version}.`,
      2,
    );
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && path.extname(specifier) === '') {
        const parent = context.parentURL;
        if (parent && parent.startsWith('file:')) {
          const candidate = path.resolve(path.dirname(fileURLToPath(parent)), `${specifier}.ts`);
          if (existsSync(candidate)) return nextResolve(`${specifier}.ts`, context);
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

async function loadGate() {
  const file = releaseGatePath;
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(
      `release-check: cannot import ${relative(releaseGatePath)}.\n`
      + 'The runner loads the shipped TypeScript directly, which needs Node 22.18 or newer '
      + `(type stripping) and 22.15 or newer (module.registerHooks). This is Node ${process.version}.\n`
      + `Cause: ${reason}`,
      2,
    );
  }
}

// --- Reporting -------------------------------------------------------------

const USAGE = `Usage: node scripts/release-check.mjs [--build] [--require-native] [--require-ci] [--json] [--help]

Reads the evidence a release needs - typecheck, extension unit suite, committed imports,
the externally recorded browser E2E count, the build output, the release package, the
third-party notices, the changelog and the feature inventory - and asks
extension/viewer/src/core/release-gate.ts whether the release may ship.

  --build   run \`pnpm build\` before reading the build output (otherwise the output already
            on disk is read, and the row says when it was built)
  --require-native  accepted for compatibility; native pass evidence is always required
  --require-ci      fail unless CI status is explicitly recorded as pass
  --json    machine-readable report
  --help    this text

Environment: RELEASE_NATIVE_TESTS records the positive native test count from a separate Rust run.
RELEASE_NATIVE_STATUS=pass is also required; a count alone is not evidence. Status may be blocked or unknown;
RELEASE_NATIVE_BLOCKER records the reason.
RELEASE_BROWSER_E2E_TESTS records a real Chrome/extension browser E2E count; without it the
browser E2E gate remains blocked.
RELEASE_CI_STATUS may be pass, blocked or unknown; RELEASE_CI_BLOCKER records the reason.

Floors: at least one passing unit test and at least E2E_TEST_FLOOR externally recorded browser
E2E tests (see extension/viewer/src/core/release-gate.ts and docs/release-checklist.md).

Exit codes: 0 no blocker, 1 at least one blocker, 2 the runner could not run.`;

function parseArgs(argv) {
  const options = { build: false, requireNative: false, requireCi: false, json: false };
  for (const argument of argv) {
    if (argument === '--build') options.build = true;
    else if (argument === '--require-native') options.requireNative = true;
    else if (argument === '--require-ci') options.requireCi = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${argument}`);
      console.error(USAGE);
      process.exit(2);
    }
  }
  return options;
}

/** Prints the failure output of a command that broke the release, so nothing is hidden. */
function printFailures(failed) {
  if (failed.length === 0) return;
  console.log('');
  console.log(`failed commands (${failed.length})`);
  for (const entry of failed) {
    const reason = entry.run.error === null ? `exit ${entry.run.code}` : entry.run.error;
    console.log(`  ${entry.check}: ${entry.run.label} -> ${reason}`);
    for (const line of failureLines(entry.run)) console.log(`    ${line}`);
  }
}

function printFindings(report) {
  if (report.blockers.length > 0) {
    console.log('');
    console.log(`blockers (${report.blockers.length})`);
    for (const blocker of report.blockers) {
      console.log(`  ${blocker.code}`);
      console.log(`    ${blocker.message}`);
    }
  }
  if (report.warnings.length > 0) {
    console.log('');
    console.log(`warnings (${report.warnings.length})`);
    for (const warning of report.warnings) {
      console.log(`  ${warning.code}`);
      console.log(`    ${warning.message}`);
    }
  }
}

// --- Main ------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  installTypeScriptResolver();

  const gate = await loadGate();
  const pkg = readPackage();
  const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
  if (version === '') fail('release-check: package.json has no version.', 2);

  const startedAt = new Date().toISOString();
  const heading = `Release gate - ${pkg.name ?? 'package'} ${version} - Node ${process.version} - ${startedAt}`;

  // --- Observable checks, each one recorded as it happened.
  const typecheck = checkTypecheck();
  const unit = checkUnitTests();
  const imports = checkCommittedImports();
  const e2e = readBrowserE2eEvidence(gate.E2E_TEST_FLOOR);
  const build = checkBuild(options);
  const notices = checkNotices(pkg);
  const artifact = checkPackageArtifact();
  const changelog = checkChangelog(version);
  const features = checkFeaturesDoc();
  const quality = checkQualityEvidence(unit);
  const native = readNativeEvidence();
  const ci = readCiEvidence();

  const input = {
    version,
    changelogHasVersion: changelog.has,
    featuresDocUpdated: features.updated,
    tests: { unit: unit.recorded, e2e: e2e.recorded, native: native.count },
    gates: {
      typecheck: typecheck.state,
      build: build.state,
      imports: imports.state,
    },
    licenses: { bundledNotices: notices.bundledNotices, missing: notices.missing },
    quality: quality.evidence,
    packageArtifact: artifact.artifact,
  };
  const report = gate.evaluate(input);
  const extensionBlockerCodes = new Set(report.blockers.map(blocker => blocker.code).filter(code => code !== 'package-artifact-missing' && code !== 'license-notice-missing'));
  const releaseStatus = {
    extension: extensionBlockerCodes.size === 0 ? 'pass' : 'blocked',
    native: native.status,
    license: notices.missing.length === 0 ? 'pass' : 'blocked',
    ci: ci.status,
  };
  const requiredEvidenceFailures = [];
  if (native.status !== 'pass') requiredEvidenceFailures.push(`native evidence is ${native.status}`);
  if (options.requireCi && ci.status !== 'pass') requiredEvidenceFailures.push(`CI evidence is ${ci.status}`);

  // --- The table: what was checked, what was seen, what it means.
  const rows = [
    { check: 'extension surface', observed: `typecheck/build/imports/evidence: ${releaseStatus.extension}`, codes: [], fixedVerdict: releaseStatus.extension === 'pass' ? 'PASS' : 'BLOCKED' },
    { check: 'version', observed: version, codes: ['version-missing'] },
    { check: 'changelog', observed: changelog.observed, codes: ['changelog-missing-version'] },
    { check: 'unit suite', observed: unit.observed, codes: ['unit-tests-empty'], run: unit.run },
    {
      check: 'e2e suite',
      observed: e2e.observed,
      codes: ['e2e-tests-below-floor'],
      run: e2e.run,
    },
    { check: 'native suite', observed: native.observed, codes: ['native-tests-unknown'], fixedVerdict: native.status === 'pass' ? 'PASS' : native.status.toUpperCase() },
    { check: 'typecheck', observed: typecheck.observed, codes: ['gate-typecheck-failed'], run: typecheck.run },
    { check: 'build output', observed: build.observed, codes: ['gate-build-failed'], run: build.run },
    {
      check: 'committed imports',
      observed: imports.observed,
      codes: ['gate-imports-failed'],
      run: imports.run,
    },
    { check: 'third-party notices', observed: notices.observed, codes: ['license-notice-missing'], fixedVerdict: releaseStatus.license === 'pass' ? 'PASS' : 'BLOCKED' },
    { check: 'release package', observed: artifact.observed, codes: ['package-artifact-missing'] },
    { check: 'feature inventory', observed: features.observed, codes: ['features-doc-stale'] },
    { check: 'CI evidence', observed: ci.observed, codes: [], fixedVerdict: ci.status === 'pass' ? 'PASS' : ci.status.toUpperCase() },
    { check: 'quality evidence', observed: quality.observed.sbom, codes: [
      'quality-privacy-failed', 'quality-secret-boundary-failed', 'quality-resource-limits-failed',
      'quality-consent-audit-failed', 'quality-retention-failed', 'quality-golden-dataset-failed',
      'quality-ocr-benchmark-failed', 'quality-translation-benchmark-failed', 'quality-export-benchmark-failed',
      'quality-performance-benchmark-failed', 'quality-i18n-failed', 'quality-accessibility-failed', 'quality-sbom-failed',
    ] },
  ];

  const blockerCodes = new Set(report.blockers.map(blocker => blocker.code));
  const warningCodes = new Set(report.warnings.map(warning => warning.code));
  const failed = [];

  for (const row of rows) {
    const blocked = row.codes.some(code => blockerCodes.has(code));
    const warned = row.codes.some(code => warningCodes.has(code));
    row.verdict = row.fixedVerdict ?? (blocked ? 'BLOCKED' : warned ? 'WARN' : 'ok');
    if (row.run !== undefined && row.run !== null && row.run.code !== 0) {
      failed.push({ check: row.check, run: row.run });
    }
  }

  const exitCode = report.ok && requiredEvidenceFailures.length === 0 ? 0 : 1;
  if (options.json) {
    console.log(JSON.stringify({
      name: pkg.name ?? null,
      version,
      node: process.version,
      startedAt,
      options,
      checks: rows.map(row => ({
        check: row.check,
        observed: row.observed,
        verdict: row.verdict,
        codes: row.codes,
      })),
      input,
      report,
      releaseStatus,
      requiredEvidenceFailures,
      quality: quality.observed,
      exitCode,
    }, null, 2));
    process.exit(exitCode);
  }

  console.log(heading);
  console.log('');
  console.log(
    formatTable(
      ['check', 'observed', 'verdict'],
      rows.map(row => [row.check, clip(row.observed), row.verdict]),
    ),
  );

  printFailures(failed);
  printFindings(report);
  if (requiredEvidenceFailures.length > 0) {
    console.log('');
    console.log(`required evidence failures (${requiredEvidenceFailures.length})`);
    for (const failure of requiredEvidenceFailures) console.log(`  ${failure}`);
  }

  console.log('');
  if (exitCode === 0) {
    console.log(
      report.warnings.length === 0
        ? 'PASS: no blocker, no warning.'
        : `PASS: no blocker; ${countOf(report.warnings.length, 'warning')} to weigh.`,
    );
    if (!options.build) {
      console.log('The build row is the output already on disk: release with --build.');
    }
  } else {
    console.log(
      `FAIL: ${countOf(report.blockers.length + requiredEvidenceFailures.length, 'blocker')}`
      + `${report.warnings.length === 0 ? '' : `, ${countOf(report.warnings.length, 'warning')}`}`
      + '. Each code is an item in docs/release-checklist.md.',
    );
  }

  process.exit(exitCode);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(
      'release-check run failed:',
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(2);
  });
}
