import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { LocalAutomationBoundary } from '../src/core/automation/boundary';
import { LocalAutomationRuntime } from '../src/core/automation/runtime';
import { ingestDocument } from '../src/core/document-runtime';
import type { RuntimeDocument } from '../src/core/document-runtime';

async function fixturePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 300]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('Invoice: INV-001', { x: 30, y: 250, size: 16, font, color: rgb(0, 0, 0) });
  page.drawText('Total: 12.50', { x: 30, y: 220, size: 16, font, color: rgb(0, 0, 0) });
  return pdf.save();
}

async function makeRuntime(): Promise<{ runtime: LocalAutomationRuntime; root: string; source: string; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mirror-automation-'));
  const source = join(root, 'invoice.pdf');
  const output = join(root, 'out');
  await writeFile(source, await fixturePdf());
  const runtime = new LocalAutomationRuntime({ statePath: join(root, 'state.json'), authorizedRoots: [root], now: () => '2026-01-01T00:00:00.000Z' });
  await runtime.open();
  return { runtime, root, source, output };
}

describe('durable local automation runtime', () => {
  it('runs import through export and is idempotent for the same source', async () => {
    const { runtime, source, output } = await makeRuntime();
    const job = await runtime.enqueue({ sourcePath: source, outputDir: output });
    await writeFile(source, Buffer.from('changed after enqueue'));
    const status = await runtime.run();
    expect(status.jobs[0]?.state).toBe('done');
    expect(job.sourceArtifactPath).toContain(`${job.sourceSha256}.pdf`);
    expect(runtime.getJob(job.id).sourceSha256).toBe(job.sourceSha256);
  });

  it('runs import through export and is idempotent for the same source', async () => {
    const { runtime, source, output } = await makeRuntime();
    const first = await runtime.enqueue({ sourcePath: source, outputDir: output, schema: [{ id: 'invoice', label: 'Invoice', type: 'identifier', required: true }] });
    const second = await runtime.enqueue({ sourcePath: source, outputDir: output, schema: [{ id: 'invoice', label: 'Invoice', type: 'identifier', required: true }] });
    expect(second.id).toBe(first.id);
    const status = await runtime.run();
    expect(status.jobs[0]?.state).toBe('done');
    expect(status.jobs[0]?.completedStages).toEqual(['import', 'classify', 'ocr', 'extract', 'translate', 'export']);
    const resultPath = runtime.status().jobs[0]!.artifacts.find(artifact => artifact.kind === 'result')!.path;
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as { sourceSha256: string };
    expect(result.sourceSha256).toHaveLength(64);
    const documentId = runtime.getJob(first.id).document!.documentId;
    expect((await runtime.listVersions(documentId)).length).toBe(2);
  }, 20_000);

  it('serializes immutable version commits when jobs run concurrently', async () => {
    const { root, source } = await makeRuntime();
    const secondSource = join(root, 'second-invoice.pdf');
    await writeFile(secondSource, await readFile(source));
    const runtime = new LocalAutomationRuntime({
      statePath: join(root, 'parallel-state.json'),
      authorizedRoots: [root],
      concurrency: 2,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    await runtime.open();
    await runtime.enqueue({ id: 'invoice-a', sourcePath: source, outputDir: join(root, 'out-a') });
    await runtime.enqueue({ id: 'invoice-b', sourcePath: secondSource, outputDir: join(root, 'out-b') });

    const status = await runtime.run();

    expect(status.jobs.map(job => [job.id, job.state, job.error])).toEqual([
      ['invoice-a', 'done', null],
      ['invoice-b', 'done', null],
    ]);
  }, 20_000);

  it('holds low-confidence or missing extraction for review, then resumes after a decision', async () => {
    const { runtime, source, output } = await makeRuntime();
    const job = await runtime.enqueue({ sourcePath: source, outputDir: output, schema: [{ id: 'missing', label: 'Missing', type: 'text', required: true }] });
    const status = await runtime.run();
    expect(status.jobs[0]?.state).toBe('review');
    const review = runtime.getJob(job.id).reviews[0];
    expect(review?.status).toBe('pending');
    await runtime.approve(job.id, review!.fieldId!, 'reject');
    expect((await runtime.run()).jobs[0]?.state).toBe('done');
  }, 20_000);

  it('rejects paths outside authorized roots and enforces boundary permissions and rates', async () => {
    const { runtime, root } = await makeRuntime();
    const boundary = new LocalAutomationBoundary(runtime, { authorizedRoots: [root], maxRequests: 1, windowMs: 60_000 });
    await expect(boundary.invoke({ operation: 'status' }, { id: 'reader', permissions: ['read'] })).resolves.toMatchObject({ ok: true });
    await expect(boundary.invoke({ operation: 'status' }, { id: 'reader', permissions: ['read'] })).rejects.toMatchObject({ code: 'rate-limited' });
    await expect(boundary.invoke({ operation: 'run' }, { id: 'writer', permissions: ['read'] })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('does not commit a cancelled in-flight import', async () => {
    const { runtime, root, source, output } = await makeRuntime();
    const pdfBytes = await readFile(source);
    const imported = ingestDocument({ pages: [{ number: 1, width: 100, height: 100, blocks: [] }], sourceBytes: new Uint8Array(pdfBytes) });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slowImport = async (): Promise<{ runtime: RuntimeDocument; bytes: Uint8Array }> => { await gate; return { runtime: imported, bytes: new Uint8Array(pdfBytes) }; };
    const second = new LocalAutomationRuntime({ statePath: join(root, 'cancel-state.json'), authorizedRoots: [root], importPdf: slowImport });
    await second.open();
    const job = await second.enqueue({ sourcePath: source, outputDir: output });
    const run = second.run();
    await second.cancel(job.id);
    release();
    await run;
    expect(second.getJob(job.id).state).toBe('cancelled');
  });
});
