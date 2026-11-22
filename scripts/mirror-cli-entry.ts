import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, exitCodeFor } from '../extension/viewer/src/core/cli-args';
import { addTranslation, type DocumentIR } from '../extension/viewer/src/core/ir';
import { createTranslationTransport, TranslationService } from '../extension/viewer/src/core/translation';
import { defaultSettings, type ProviderKind } from '../extension/viewer/src/core/types';
import { LocalAutomationRuntime } from '../extension/viewer/src/core/automation/runtime';
import { PersistentFolderWatcher } from '../extension/viewer/src/core/automation/folder-state';

const MAX_BATCH_FILES = 5_000;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_BATCH_BYTES = 512 * 1024 * 1024;

const parsed = parseArgs(process.argv.slice(2));
if (parsed.errors.length > 0) {
  for (const error of parsed.errors) process.stderr.write(`mirror-cli: ${error.message}\n`);
  process.exitCode = exitCodeFor(parsed.errors);
} else if (!parsed.command || !parsed.options.input) {
  process.stderr.write('mirror-cli: an executable command requires --in <dir>.\n');
  process.exitCode = 3;
} else if (parsed.command === 'translate' && parsed.options.provider !== null && parsed.options.provider !== 'local') {
  process.stderr.write('mirror-cli: only the local translation provider is available in this local-only boundary.\n');
  process.exitCode = 5;
} else {
  try {
    await run(parsed.command, parsed.options.input, parsed.options.output, parsed.options.lang, parsed.options.provider);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`mirror-cli: ${message}\n`);
    process.exitCode = 6;
  }
}

async function run(command: string, input: string, requestedOutput: string | null, lang: string | null, provider: ProviderKind | null): Promise<void> {
  const sourceDir = resolve(input);
  const outputDir = resolve(requestedOutput ?? join(sourceDir, 'mirror-output'));
  await mkdir(outputDir, { recursive: true });
  const statePath = join(outputDir, '.automation', 'state.json');
  const runtime = new LocalAutomationRuntime({
    statePath,
    authorizedRoots: [sourceDir, outputDir],
    translate: command === 'translate' ? createTranslator(lang ?? 'vi', provider ?? 'local') : undefined,
  });
  await runtime.open();
  const watcher = new PersistentFolderWatcher(
    join(outputDir, '.automation', 'watch.json'),
    sourceDir,
    { authorizedRoots: [sourceDir, outputDir], recursive: true, maxFiles: MAX_BATCH_FILES, maxFileBytes: MAX_PDF_BYTES, stableForMs: 100 },
  );
  const poll = await watcher.poll({ persist: false });
  if (!poll.complete) throw new Error('folder scan was incomplete; the persisted snapshot was not advanced.');
  if (poll.rejected.length > 0) {
    throw new Error(`${poll.rejected.length} input file(s) were rejected by the local safety limits or could not be read.`);
  }
  const work = poll.work.filter(change => change.kind === 'added' || change.kind === 'modified');
  let totalBytes = 0;
  for (const change of work) {
    const sourcePath = join(sourceDir, change.path);
    const details = await stat(sourcePath);
    totalBytes += details.size;
    if (totalBytes > MAX_BATCH_BYTES) throw new Error(`batch exceeds the ${MAX_BATCH_BYTES} byte local safety cap.`);
    await runtime.enqueue({ sourcePath, outputDir, translate: command === 'translate' });
  }
  await watcher.commit(poll);
  await runtime.retry();
  const status = await runtime.run();
  const unresolved = status.jobs.filter(job => job.state !== 'done');
  process.stdout.write(`${JSON.stringify({ command, input: sourceDir, output: outputDir, status }, null, 2)}\n`);
  if (unresolved.length > 0) {
    process.stderr.write(`mirror-cli: ${unresolved.length} job(s) did not finish; inspect review or failure state.\n`);
    process.exitCode = 7;
  }
}

function createTranslator(targetLanguage: string, provider: ProviderKind): (document: DocumentIR, signal: AbortSignal) => Promise<DocumentIR> {
  const service = new TranslationService(createTranslationTransport(fetch, {}, { privacyMode: 'offline' }));
  return async (document, signal) => {
    const settings = { ...defaultSettings, provider, targetLanguage, allowCloud: false };
    let next = document;
    for (const block of document.blocks) {
      const result = await service.translate({ text: block.raw, settings, signal });
      next = addTranslation(next, { blockId: block.id, lang: targetLanguage, engine: provider, modelVersion: settings.model, promptVersion: settings.promptVersion, text: result.text, qaStatus: 'unchecked' });
    }
    return next;
  };
}
