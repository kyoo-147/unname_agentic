#!/usr/bin/env node
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const gates = [
  { id: 'desktop-import', requires: ['native executable', 'PDF fixture', 'isolated profile'], acceptance: 'real desktop import with source-byte retention and native evidence' },
  { id: 'ocr-markup', requires: ['native UI driver', 'OCR fixture and deterministic assertions'], acceptance: 'OCR/markup changes and geometry verified in the desktop UI' },
  { id: 'rag-citations', requires: ['native RAG UI', 'citation fixture', 'navigation assertion adapter'], acceptance: 'citation click navigates to the cited source block' },
  { id: 'research-workspace', requires: ['research workspace UI', 'persistence assertion adapter'], acceptance: 'create/edit/reopen research workspace content' },
  { id: 'translated-pdf-save-as', requires: ['translated-PDF writer', 'native Save As automation', 'independent PDF reader'], acceptance: 'saved translated PDF bytes reopen and pass inspection' },
  { id: 'persistence-reload', requires: ['native executable', 'assertable persisted library state'], acceptance: 'close/relaunch and compare imported document state' },
  { id: 'extension-native-handoff', requires: ['built extension', 'Chrome', 'registered native host', 'matching extension origin'], acceptance: 'real Chrome nativeMessaging roundtrip' },
  { id: 'reconnect-duplicate-checksum', requires: ['real host transport fault injection', 'native event assertions'], acceptance: 'reconnect resumes, duplicate suppressed, checksum mismatch rejected' },
  { id: 'cleanup', requires: ['run-owned temp roots', 'cleanup verification'], acceptance: 'all temporary artifacts removed or retained only as requested evidence' },
];

export function discovery() {
  return {
    schemaVersion: 1,
    harness: 'native-desktop-e2e',
    mode: 'discovery-only',
    fullAcceptance: false,
    platform: process.platform,
    gates: gates.map(gate => ({ ...gate, status: 'not-run', evidence: [] })),
    existingSurfaces: {
      gpuiDevtools: 'FDL_SCRIPT is a development-only input driver; it is not itself a product assertion.',
      extensionBrowserE2e: 'extension/tests/e2e/run.mjs launches Chrome with a temporary profile; its synthetic capture is not permission proof or native-host roundtrip.',
      nativeBridgeProtocol: 'native-shell/src/native_bridge.rs has deterministic protocol tests; they do not prove Chrome registration or UI acceptance.',
    },
  };
}

export function mockContractEvidence() {
  return {
    schemaVersion: 1,
    harness: 'native-desktop-e2e',
    mode: 'mock-contract-only',
    fullAcceptance: false,
    realDesktopLaunched: false,
    realChromeLaunched: false,
    syntheticCapturePermissionProof: false,
    gates: gates.map(({ id }) => ({ id, status: 'not-run', reason: 'mock-only mode cannot satisfy product acceptance' })),
    assertions: [
      'all required acceptance stages are enumerated',
      'unavailable prerequisites are explicit, not skipped',
      'synthetic capture is not represented as OS permission proof',
      'mock-only evidence never sets fullAcceptance=true',
    ],
  };
}

export function unavailablePrerequisites(env = process.env, platform = process.platform) {
  const missing = [];
  if (platform !== 'win32' && platform !== 'darwin') missing.push('Native desktop E2E requires a supported desktop OS (Windows or macOS); this runtime is not one.');
  for (const [key, description] of [
    ['PDF_WORKSPACE_EXE', 'PDF_WORKSPACE_EXE must point to the real built native-shell executable.'],
    ['PDF_WORKSPACE_E2E_SCRIPT', 'PDF_WORKSPACE_E2E_SCRIPT must point to an authored FDL_SCRIPT scenario for the full UI journey.'],
    ['PDF_WORKSPACE_E2E_ASSERTIONS', 'PDF_WORKSPACE_E2E_ASSERTIONS must point to assertion output produced by the real UI/Chrome driver.'],
    ['CHROME_PATH', 'CHROME_PATH must point to the installed Chrome executable.'],
    ['PDF_WORKSPACE_NATIVE_HOST', 'PDF_WORKSPACE_NATIVE_HOST must point to the built native messaging host.'],
  ]) if (!env[key]) missing.push(description);
  return missing;
}

async function isFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

async function main(args) {
  const mode = args[0];
  if (mode === '--help' || mode === '-h' || !mode) {
    console.log('Usage: node scripts/e2e/native-desktop.mjs <mode> [--evidence <file>]');
    console.log('\nModes: --list, --mock-contract, --acceptance');
    console.log('Examples:\n  node scripts/e2e/native-desktop.mjs --list\n  node scripts/e2e/native-desktop.mjs --mock-contract\n  PDF_WORKSPACE_EXE=<path> PDF_WORKSPACE_E2E_SCRIPT=<path> node scripts/e2e/native-desktop.mjs --acceptance');
    console.log('\n--acceptance fails closed unless real desktop, Chrome, host and assertion artifacts are available.');
    return mode ? 0 : 2;
  }
  const outputAt = args.indexOf('--evidence');
  const outputPath = outputAt >= 0 ? path.resolve(args[outputAt + 1] ?? '') : undefined;
  if (mode === '--list') {
    const report = discovery();
    await emit(report, outputPath);
    return 0;
  }
  if (mode === '--mock-contract') {
    const report = mockContractEvidence();
    if (report.fullAcceptance || report.realDesktopLaunched || report.syntheticCapturePermissionProof) throw new Error('mock contract improperly claims real acceptance evidence');
    await emit(report, outputPath);
    return 0;
  }
  if (mode !== '--acceptance') throw new Error(`Unknown mode: ${mode}. Use --help.`);

  const blockers = unavailablePrerequisites();
  const pdf = process.env.PDF_WORKSPACE_E2E_PDF ?? path.join(root, 'extension/tests/fixtures/mirror-field-notes.pdf');
  const extension = process.env.PDF_WORKSPACE_EXTENSION ?? path.join(root, 'dist/extension');
  const blockerList = [...blockers];
  if (!await isFile(pdf)) blockerList.push(`PDF fixture is unavailable: ${pdf}`);
  if (!await isFile(process.env.PDF_WORKSPACE_EXE ?? '')) blockerList.push('PDF_WORKSPACE_EXE is not an existing file.');
  if (!await isFile(process.env.CHROME_PATH ?? '')) blockerList.push('CHROME_PATH is not an existing file.');
  if (!await isFile(process.env.PDF_WORKSPACE_NATIVE_HOST ?? '')) blockerList.push('PDF_WORKSPACE_NATIVE_HOST is not an existing file.');
  try { await access(path.join(extension, 'manifest.json')); } catch { blockerList.push(`Built extension is unavailable at ${extension}; build it before this gate.`); }
  for (const key of ['PDF_WORKSPACE_E2E_SCRIPT', 'PDF_WORKSPACE_E2E_ASSERTIONS']) {
    if (process.env[key] && !await isFile(process.env[key])) blockerList.push(`${key} does not point to an existing file.`);
  }
  if (blockerList.length) {
    const report = { ...discovery(), mode: 'acceptance-blocked', fullAcceptance: false, blockers: [...new Set(blockerList)] };
    await emit(report, outputPath);
    console.error(`Native desktop E2E BLOCKED (${report.blockers.length} prerequisite(s)); see machine-readable evidence.`);
    for (const item of report.blockers) console.error(`- ${item}`);
    return 2;
  }

  const runRoot = await mkdtemp(path.join(tmpdir(), 'pdf-workspace-native-e2e-'));
  const profile = path.join(runRoot, 'profile');
  const chromeProfile = path.join(runRoot, 'chrome-profile');
  const inbox = path.join(runRoot, 'inbox');
  const data = path.join(runRoot, 'data');
  const shots = path.join(runRoot, 'screenshots');
  for (const dir of [profile, chromeProfile, inbox, data, shots]) await mkdir(dir, { recursive: true });
  let primaryError;
  try {
    const env = {
      ...process.env,
      PDF_WORKSPACE_HOME: profile,
      PDF_WORKSPACE_DATA: data,
      PDF_WORKSPACE_INBOX: inbox,
      PDF_WORKSPACE_LAYOUT_PREVIEW: '0',
      FDL_SCRIPT: path.resolve(process.env.PDF_WORKSPACE_E2E_SCRIPT),
      FDL_SHOTS: shots,
      FDL_TRACE: '1',
    };
    const child = spawn(path.resolve(process.env.PDF_WORKSPACE_EXE), [path.resolve(pdf)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Native desktop timed out after 180 seconds.')); }, 180_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    const logs = Buffer.concat([...stdout, ...stderr]).toString('utf8');
    await writeFile(path.join(runRoot, 'native.log'), logs);
    if (exit.code !== 0) throw new Error(`Native desktop exited with ${JSON.stringify(exit)}; log: ${path.join(runRoot, 'native.log')}`);
    const files = await readdir(shots);
    const screenshots = [];
    for (const name of files.filter(name => name.toLowerCase().endsWith('.png')).sort()) {
      const bytes = await readFile(path.join(shots, name));
      if (bytes.length < 32 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Invalid screenshot artifact: ${name}`);
      screenshots.push({ path: path.join(shots, name), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    }
    if (screenshots.length === 0) throw new Error('The native run produced no PNG evidence.');
    const chrome = spawn(path.resolve(process.env.CHROME_PATH), [
      `--user-data-dir=${chromeProfile}`,
      `--disable-extensions-except=${path.resolve(extension)}`,
      `--load-extension=${path.resolve(extension)}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--headless=new',
      '--remote-debugging-port=0', 'about:blank',
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const chromeLogs = [];
    chrome.stdout.on('data', chunk => chromeLogs.push(chunk));
    chrome.stderr.on('data', chunk => chromeLogs.push(chunk));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { chrome.kill(); reject(new Error('Chrome did not remain running for the isolated-profile startup probe.')); }, 20_000);
      chrome.once('error', error => { clearTimeout(timer); reject(error); });
      chrome.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Chrome exited during startup (${JSON.stringify({ code, signal })}).`)); });
      setTimeout(() => { clearTimeout(timer); resolve(); }, 2_000);
    });
    chrome.kill();
    await new Promise(resolve => chrome.exitCode !== null ? resolve() : chrome.once('exit', resolve));
    await writeFile(path.join(runRoot, 'chrome.log'), Buffer.concat(chromeLogs));

    const assertions = JSON.parse(await readFile(process.env.PDF_WORKSPACE_E2E_ASSERTIONS, 'utf8'));
    const evidenceDirectory = outputPath ? path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}.artifacts`) : undefined;
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      await copyFile(path.join(runRoot, 'native.log'), path.join(evidenceDirectory, 'native.log'));
      await copyFile(path.join(runRoot, 'chrome.log'), path.join(evidenceDirectory, 'chrome.log'));
      for (const image of screenshots) {
        const destination = path.join(evidenceDirectory, path.basename(image.path));
        await copyFile(image.path, destination);
        image.path = destination;
      }
    }
    const requiredIds = gates.map(gate => gate.id);
    const completed = new Set(Array.isArray(assertions.passed) ? assertions.passed : []);
    const missingAssertions = requiredIds.filter(id => !completed.has(id));
    const report = {
      schemaVersion: 1,
      harness: 'native-desktop-e2e',
      mode: 'real-execution',
      // Execution evidence and a supplied assertion file are not independent product acceptance.
      fullAcceptance: false,
      realDesktopLaunched: true,
      realChromeLaunched: true,
      chromeProfileIsolated: true,
      syntheticCapturePermissionProof: false,
      osPermissionProof: false,
      runRoot,
      exit,
      screenshots,
      assertionEvidence: assertions,
      missingAssertions,
      gates: gates.map(gate => ({ ...gate, status: completed.has(gate.id) ? 'assertion-reported' : 'not-verified', evidence: assertions.artifacts?.[gate.id] ?? [] })),
      cleanup: 'temporary profile cleanup is attempted after evidence emission; fullAcceptance remains false pending independent review',
    };
    await emit(report, outputPath);
    if (!report.fullAcceptance) return 3;
    return 0;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      if (process.env.PDF_WORKSPACE_KEEP_ARTIFACTS === '1') console.error(`Evidence retained at ${runRoot}`);
      else await rm(runRoot, { recursive: true, force: false });
    } catch (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError], 'E2E failed and isolated-profile cleanup also failed.');
      throw new Error(`E2E cleanup failed for ${runRoot}: ${cleanupError.message}`);
    }
  }
}

async function emit(value, outputPath) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, text, { flag: 'w' });
  }
  console.log(text.trimEnd());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(`Native desktop E2E failed closed: ${error.message}`);
    process.exitCode = 1;
  });
}
