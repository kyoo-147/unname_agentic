import { mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { platform } from 'node:os';
import { LocalAutomationBoundary } from '../viewer/src/core/automation/boundary';
import { LocalAutomationRuntime } from '../viewer/src/core/automation/runtime';
import { ingestDocument } from '../viewer/src/core/document-runtime';
import type { RuntimeDocument } from '../viewer/src/core/document-runtime';

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
    const { runtime, root, source, output } = await makeRuntime();
    const first = await runtime.enqueue({ sourcePath: source, outputDir: output, schema: [{ id: 'invoice', label: 'Invoice', type: 'identifier', required: true }] });
    const second = await runtime.enqueue({ sourcePath: source, outputDir: output, schema: [{ id: 'invoice', label: 'Invoice', type: 'identifier', required: true }] });
    expect(second.id).toBe(first.id);
    const status = await runtime.run();
    expect(status.jobs[0]?.state).toBe('done');
    expect(status.jobs[0]?.completedStages).toEqual(['import', 'classify', 'ocr', 'extract', 'translate', 'export']);
    const committed = runtime.getJob(first.id);
    expect(committed.artifacts).toHaveLength(2);
    for (const artifact of committed.artifacts) await expect(readFile(artifact.path)).resolves.toBeDefined();
    const resultPath = runtime.status().jobs[0]!.artifacts.find(artifact => artifact.kind === 'result')!.path;
    const result = JSON.parse(await readFile(resultPath, 'utf8')) as { sourceSha256: string };
    expect(result.sourceSha256).toHaveLength(64);
    const documentId = runtime.getJob(first.id).document!.documentId;
    const versions = await runtime.listVersions(documentId);
    expect(versions).toHaveLength(2);
    expect((await readdir(join(root, 'documents'))).sort()).toEqual(versions.map(version => version.documentPath.split(/[\\/]/u).at(-1)!).sort());
    for (const version of versions) await expect(readFile(join(root, version.documentPath), 'utf8')).resolves.toBeDefined();
  }, 20_000);

  it('assigns separate default job ids to identical bytes at different source paths', async () => {
    const { runtime, root, source, output } = await makeRuntime();
    const copy = join(root, 'copy.pdf');
    await writeFile(copy, await readFile(source));

    const first = await runtime.enqueue({ sourcePath: source, outputDir: output });
    const second = await runtime.enqueue({ sourcePath: copy, outputDir: output });

    expect(second.sourceSha256).toBe(first.sourceSha256);
    expect(second.id).not.toBe(first.id);
  });

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

  it('rejects durable review edits that do not satisfy the job field schema', async () => {
    const { runtime, source, output } = await makeRuntime();
    const job = await runtime.enqueue({ sourcePath: source, outputDir: output, schema: [{ id: 'invoice', label: 'Invoice', type: 'number', required: true }] });
    await runtime.run();
    const review = runtime.getJob(job.id).reviews[0]!;

    await expect(runtime.approve(job.id, review.fieldId!, 'edit', 'not-a-number')).rejects.toMatchObject({ code: 'invalid-input' });
    expect(runtime.getJob(job.id).reviews[0]?.status).toBe('pending');
    await expect(runtime.approve(job.id, review.fieldId!, 'edit', '12.50')).resolves.toMatchObject({ status: 'edited', decidedValue: '12.50' });
  }, 20_000);

  it('authorizes output paths after resolving symlinks', async () => {
    const { runtime, root, source } = await makeRuntime();
    const outside = await mkdtemp(join(tmpdir(), 'mirror-automation-outside-'));
    const linkedOutput = join(root, 'linked-output');
    await symlink(outside, linkedOutput, platform() === 'win32' ? 'junction' : 'dir');

    await expect(runtime.enqueue({ sourcePath: source, outputDir: join(linkedOutput, 'nested') })).rejects.toMatchObject({ name: 'UnauthorizedPathError' });
  });

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

  it('cancels a queued job without cancelling its queued sibling', async () => {
    const { runtime, source, output } = await makeRuntime();
    const first = await runtime.enqueue({ id: 'queued-cancel', sourcePath: source, outputDir: join(output, 'first') });
    const second = await runtime.enqueue({ id: 'queued-keep', sourcePath: source, outputDir: join(output, 'second') });

    await runtime.cancel(first.id);
    expect(runtime.getJob(first.id).state).toBe('cancelled');
    expect(runtime.getJob(second.id).state).toBe('queued');
    await runtime.run();
    expect(runtime.getJob(second.id).state).toBe('done');
    expect(runtime.getJob(first.id).state).toBe('cancelled');
  }, 20_000);

  it('aborts only the selected running job and allows its sibling to finish', async () => {
    const { runtime: base, root, source, output } = await makeRuntime();
    const secondSource = join(root, 'sibling.pdf');
    await writeFile(secondSource, await readFile(source));
    const signals: AbortSignal[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const bothStarted = new Promise<void>(resolve => { started = resolve; });
    const runtime = new LocalAutomationRuntime({
      statePath: join(root, 'running-cancel.json'),
      authorizedRoots: [root],
      concurrency: 2,
      ocr: async (document, signal) => {
        signals.push(signal);
        if (signals.length === 2) started();
        await gate;
        return document;
      },
    });
    await runtime.open();
    const cancelled = await runtime.enqueue({ id: 'running-cancel', sourcePath: source, outputDir: join(output, 'cancelled') });
    const sibling = await runtime.enqueue({ id: 'running-keep', sourcePath: secondSource, outputDir: join(output, 'sibling') });
    const run = runtime.run();
    await bothStarted;

    await runtime.cancel(cancelled.id);
    expect(signals.filter(signal => signal.aborted)).toHaveLength(1);
    release();
    await run;
    expect(runtime.getJob(cancelled.id).state).toBe('cancelled');
    expect(runtime.getJob(sibling.id).state).toBe('done');
  }, 20_000);

  it('removes an already-written result when cancellation wins before the report write', async () => {
    const { root, source, output } = await makeRuntime();
    let release!: () => void;
    let reportStarted!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reportGate = new Promise<void>(resolve => { reportStarted = resolve; });
    const runtime = new LocalAutomationRuntime({
      statePath: join(root, 'cancel-export.json'),
      authorizedRoots: [root],
      beforeArtifactWrite: async path => {
        if (path.endsWith('.report.md')) {
          reportStarted();
          await gate;
        }
      },
    });
    await runtime.open();
    const job = await runtime.enqueue({ sourcePath: source, outputDir: output });
    const run = runtime.run();
    await reportGate;
    expect((await readdir(output)).some(name => name.endsWith('.result.json'))).toBe(true);

    await runtime.cancel(job.id);
    release();
    await run;

    expect(runtime.getJob(job.id).state).toBe('cancelled');
    expect(runtime.getJob(job.id).artifacts).toEqual([]);
    expect(await readdir(output)).toEqual(['.automation']);
  }, 20_000);

  it('retracts committed artifacts and version metadata when cancellation wins before the stop check', async () => {
    const { root, source, output } = await makeRuntime();
    let release!: () => void;
    let committed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const commitGate = new Promise<void>(resolve => { committed = resolve; });
    const runtime = new LocalAutomationRuntime({
      statePath: join(root, 'cancel-after-commit.json'),
      authorizedRoots: [root],
      afterArtifactCommit: async () => {
        committed();
        await gate;
      },
    });
    await runtime.open();
    const job = await runtime.enqueue({ sourcePath: source, outputDir: output });
    const run = runtime.run();
    await commitGate;

    const documentId = runtime.getJob(job.id).document!.documentId;
    const committedJob = runtime.getJob(job.id);
    expect(committedJob.artifacts).toHaveLength(2);
    expect(committedJob.versions.map(version => version.stage)).toContain('export');
    expect((await runtime.listVersions(documentId)).map(version => version.stage)).toContain('export');

    await runtime.cancel(job.id);
    expect(runtime.getJob(job.id).artifacts).toEqual([]);
    expect((await runtime.listVersions(documentId)).map(version => version.stage)).toEqual(['import']);
    expect((await readdir(output)).filter(name => !name.startsWith('.'))).toEqual([]);
    release();
    await run;

    const cancelled = runtime.getJob(job.id);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.artifacts).toEqual([]);
    expect(cancelled.versions.map(version => version.stage)).not.toContain('export');
    expect((await runtime.listVersions(documentId)).map(version => version.stage)).toEqual(['import']);
    expect((await readdir(output)).filter(name => !name.startsWith('.'))).toEqual([]);

    const reopened = new LocalAutomationRuntime({ statePath: join(root, 'cancel-after-commit.json'), authorizedRoots: [root] });
    await reopened.open();
    expect(reopened.getJob(job.id).artifacts).toEqual([]);
    expect(reopened.getJob(job.id).versions.map(version => version.stage)).toEqual(['import']);
    expect((await reopened.listVersions(documentId)).map(version => version.stage)).toEqual(['import']);
  }, 20_000);

  it('rolls back a version committed immediately before cancellation is checked', async () => {
    const { root, source, output } = await makeRuntime();
    const runtime = new LocalAutomationRuntime({ statePath: join(root, 'cancel-version-commit.json'), authorizedRoots: [root] });
    await runtime.open();
    const job = await runtime.enqueue({ sourcePath: source, outputDir: output });
    const store = (runtime as unknown as { versions: { put: (...args: unknown[]) => Promise<unknown> } }).versions;
    const originalPut = store.put.bind(store);
    let release!: () => void;
    let committed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const commitGate = new Promise<void>(resolve => { committed = resolve; });
    store.put = async (...args: unknown[]) => {
      const version = await originalPut(...args);
      if ((version as { stage: string }).stage === 'export') {
        committed();
        await gate;
      }
      return version;
    };
    const run = runtime.run();
    await commitGate;

    const documentId = runtime.getJob(job.id).document!.documentId;
    const committedVersions = await runtime.listVersions(documentId);
    const exportVersion = committedVersions.find(version => version.stage === 'export')!;
    expect(committedVersions.map(version => version.stage)).toContain('export');
    await expect(readFile(join(root, exportVersion.documentPath), 'utf8')).resolves.toBeDefined();
    expect(await readdir(join(root, 'documents'))).toContain(exportVersion.documentPath.split(/[\\/]/u).at(-1));
    await runtime.cancel(job.id);
    release();
    await run;

    expect(runtime.getJob(job.id).state).toBe('cancelled');
    expect(runtime.getJob(job.id).artifacts).toEqual([]);
    expect(runtime.getJob(job.id).versions.map(version => version.stage)).not.toContain('export');
    const remainingVersions = await runtime.listVersions(documentId);
    expect(remainingVersions.map(version => version.stage)).toEqual(['import']);
    expect(await readdir(join(root, 'documents'))).toEqual(remainingVersions.map(version => version.documentPath.split(/[\\/]/u).at(-1)!));
    await expect(readFile(join(root, exportVersion.documentPath), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(output)).filter(name => !name.startsWith('.'))).toEqual([]);
    const reopened = new LocalAutomationRuntime({ statePath: join(root, 'cancel-version-commit.json'), authorizedRoots: [root] });
    await reopened.open();
    expect(reopened.getJob(job.id).artifacts).toEqual([]);
    expect(reopened.getJob(job.id).versions.map(version => version.stage)).toEqual(['import']);
    const reopenedVersions = await reopened.listVersions(documentId);
    expect(reopenedVersions.map(version => version.stage)).toEqual(['import']);
    expect(await readdir(join(root, 'documents'))).toEqual(reopenedVersions.map(version => version.documentPath.split(/[\\/]/u).at(-1)!));
    await expect(readFile(join(root, exportVersion.documentPath), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 20_000);

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
