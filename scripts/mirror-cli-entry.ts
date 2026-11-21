import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, exitCodeFor } from '../src/core/cli-args';
import { addTranslation, type DocumentIR } from '../src/core/ir';
import { createTranslationTransport, TranslationService } from '../src/core/translation';
import { defaultSettings, type ProviderKind } from '../src/core/types';
import { LocalAutomationRuntime } from '../src/core/automation/runtime';

const parsed = parseArgs(process.argv.slice(2));
if (parsed.errors.length > 0) {
  for (const error of parsed.errors) process.stderr.write(`mirror-cli: ${error.message}\n`);
  process.exitCode = exitCodeFor(parsed);
} else if (!parsed.command || !parsed.options.input) {
  process.stderr.write('mirror-cli: an executable command requires --in <dir>.\n');
  process.exitCode = 3;
} else if (parsed.command === 'translate' && parsed.options.provider !== null && parsed.options.provider !== 'local') {
  process.stderr.write('mirror-cli: only the local translation provider is available in this local-only boundary.\n');
  process.exitCode = 5;
} else {
  await run(parsed.command, parsed.options.input, parsed.options.output, parsed.options.lang, parsed.options.provider);
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
  const entries = (await readdir(sourceDir, { withFileTypes: true })).filter(entry => entry.isFile() && /\.pdf$/iu.test(entry.name));
  for (const entry of entries) {
    await runtime.enqueue({ sourcePath: join(sourceDir, entry.name), outputDir, translate: command === 'translate' });
  }
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
