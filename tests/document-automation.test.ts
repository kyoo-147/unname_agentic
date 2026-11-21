import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit';
import { buildDocument, type DocumentIR } from '../src/core/ir';
import {
  DocumentAutomationRuntime,
  diffAutomationWatch,
  type AutomationJob,
  type DerivedRevisionRecord,
} from '../src/core/document-automation';

const SOURCE_SHA = 'a'.repeat(64);
const PAGE = { index: 1, width: 612, height: 792, rotation: 0 as const };

function documentWithBlocks(texts: readonly string[], confidence = 1): DocumentIR {
  return buildDocument({
    documentId: 'doc-automation',
    sourceSha256: SOURCE_SHA,
    language: 'en',
    pages: [PAGE],
    blocks: texts.map((text, index) => ({
      id: `source-${index}`,
      page: 1,
      text,
      rect: { x: 72, y: 72 + index * 24, width: 360, height: 16 },
      confidence,
      origin: 'pdf-text',
    })),
  });
}

function job(id: string, source: DocumentIR, overrides: Partial<AutomationJob> = {}): AutomationJob {
  return { id, source, ...overrides };
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('DocumentAutomationRuntime', () => {
  it('resolves all run waiters only after the queue records completion', async () => {
    const runtime = new DocumentAutomationRuntime({ runId: 'waiter-run' });
    runtime.add(job('waiter-job', documentWithBlocks(['Source text'])));

    const first = runtime.run();
    const second = runtime.run();
    const [firstStatus, secondStatus] = await Promise.all([first, second]);

    expect(firstStatus.queue.totals.pending).toBe(0);
    expect(secondStatus.queue.totals.pending).toBe(0);
    expect(firstStatus.jobs[0]?.state).toBe('done');
    expect(secondStatus.jobs[0]?.state).toBe('done');
  });

  it('runs the deterministic pipeline with a stable status and immutable revisions', async () => {
    const source = documentWithBlocks(['Invoice: INV-1']);
    const runtime = new DocumentAutomationRuntime({ runId: 'run-1' });
    runtime.add(job('job-1', source, {
      schema: [{ id: 'invoice', label: 'Invoice', type: 'identifier', required: true }],
    }));
    const status = await runtime.run();
    expect(status).toEqual({
      queue: {
        state: 'done',
        totals: { jobs: 1, done: 1, failed: 0, cancelled: 0, pending: 0 },
        current: [],
      },
      jobs: [{ id: 'job-1', state: 'done', attempt: 1, currentStage: null }],
    });

    expect(source.blocks[0]?.raw).toBe('Invoice: INV-1');
    source.blocks[0]!.raw = 'changed after enqueue';

    const result = runtime.result('job-1');
    expect(result?.state).toBe('done');
    expect(result?.extraction?.fields[0]?.value).toBe('INV-1');
    expect(result?.stages.map(stage => [stage.stage, stage.status])).toEqual([
      ['import', 'done'],
      ['classify', 'done'],
      ['ocr', 'skipped'],
      ['translate', 'skipped'],
      ['extract', 'done'],
      ['export', 'skipped'],
    ]);

    const revisions = runtime.revisions('job-1');
    expect(revisions).toHaveLength(4);
    expect(revisions[0]?.kind).toBe('source');
    expect(revisions[1]?.kind).toBe('derived');
    expect(revisions[1]?.document.blocks[0]?.raw).toBe('Invoice: INV-1');
    expect(revisions[1]?.document.revisionId).toContain('derived:job-1:run-1:1:import');
    expect(Object.isFrozen(revisions[0]?.document)).toBe(true);
    expect(Object.isFrozen(revisions[1]?.document.blocks)).toBe(true);
  });

  it('runs injected stages in the declared order around built-in extraction', async () => {
    const called: string[] = [];
    const handler = async ({ stage }: { stage: string }) => {
      called.push(stage);
      return { confidence: 0.9 };
    };
    const runtime = new DocumentAutomationRuntime({
      runId: 'order-run',
      handlers: {
        import: handler,
        classify: handler,
        ocr: handler,
        translate: handler,
        export: handler,
      },
    });
    runtime.add(job('order-job', documentWithBlocks(['Source text']), {
      privacy: {
        mode: 'offline',
        settings: { provider: 'local', endpoint: 'http://127.0.0.1:11434/v1', allowCloud: false },
      },
    }));

    await runtime.run();

    expect(called).toEqual(['import', 'classify', 'ocr', 'translate', 'export']);
    expect(runtime.result('order-job')?.stages.map(stage => stage.stage)).toEqual([
      'import', 'classify', 'ocr', 'translate', 'extract', 'export',
    ]);
  });

  it('queues low-confidence, invalid and missing-required extraction for review', async () => {
    const source = documentWithBlocks([
      'Issued: 12/03/2024',
      'Status: Unknown',
    ], 0.5);
    const runtime = new DocumentAutomationRuntime({ runId: 'review-run', reviewThreshold: 0.8 });
    runtime.add(job('review-job', source, {
      schema: [
        { id: 'issued', label: 'Issued', type: 'date', required: true },
        { id: 'status', label: 'Status', type: 'enum', required: true, enumValues: ['Paid', 'Unpaid'] },
        { id: 'invoice', label: 'Invoice number', type: 'identifier', required: true },
      ],
    }));

    await runtime.run();

    expect(runtime.reviewQueue('review-job').map(item => item.reason)).toEqual([
      'low-confidence',
      'low-confidence',
      'invalid',
      'missing-required',
    ]);
    expect(runtime.reviewQueue('review-job').every(item => item.detail !== undefined || item.fieldId !== undefined)).toBe(true);
  });

  it('cancels an in-flight handler and ignores its late result', async () => {
    let release!: () => void;
    let started = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const runtime = new DocumentAutomationRuntime({
      runId: 'cancel-run',
      handlers: {
        ocr: async () => {
          started = true;
          await pending;
          return { confidence: 1 };
        },
      },
    });
    runtime.add(job('cancel-job', documentWithBlocks(['Source text'])));
    const running = runtime.run();
    await tick();
    expect(started).toBe(true);

    runtime.cancel();
    const cancelled = await running;
    expect(cancelled.jobs[0]?.state).toBe('cancelled');
    expect(cancelled.queue.totals.cancelled).toBe(1);

    release();
    await tick();
    expect(runtime.result('cancel-job')?.state).toBe('cancelled');
    expect(runtime.result('cancel-job')?.stages.some(stage => stage.status === 'cancelled')).toBe(true);
    expect(runtime.revisions('cancel-job').some(revision => revision.kind === 'derived' && revision.stage === 'ocr')).toBe(false);
  });

  it('retries only failed jobs and gives the retry a new immutable attempt', async () => {
    let attempts = 0;
    const runtime = new DocumentAutomationRuntime({
      runId: 'retry-run',
      handlers: {
        ocr: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary OCR failure');
          return { confidence: 0.9 };
        },
      },
    });
    runtime.add(job('retry-job', documentWithBlocks(['Source text'])));

    const first = await runtime.run();
    expect(first.jobs[0]?.state).toBe('failed');
    expect(runtime.failures()).toEqual([{ id: 'retry-job', error: 'temporary OCR failure' }]);

    expect(runtime.retryFailed()).toEqual(['retry-job']);
    const second = await runtime.run();
    expect(second.jobs[0]).toMatchObject({ id: 'retry-job', state: 'done', attempt: 2 });
    expect(runtime.result('retry-job')?.stages.every(stage => stage.attempt === 2)).toBe(true);
    expect(runtime.revisions('retry-job').filter(revision => revision.kind === 'derived' && revision.stage === 'ocr')).toHaveLength(1);
    const ocrRevision = runtime.revisions('retry-job').find(
      (revision): revision is DerivedRevisionRecord => revision.kind === 'derived' && revision.stage === 'ocr',
    );
    expect(ocrRevision?.attempt).toBe(2);
  });

  it('dry-run executes built-ins and skips injected handlers without calling them', async () => {
    let calls = 0;
    const runtime = new DocumentAutomationRuntime({
      runId: 'dry-run',
      handlers: {
        ocr: async () => { calls += 1; return { confidence: 1 }; },
        translate: async () => { calls += 1; return { confidence: 1 }; },
        export: async () => { calls += 1; return { confidence: 1 }; },
      },
    });
    runtime.add(job('dry-job', documentWithBlocks(['Invoice: INV-2']), { dryRun: true }));

    await runtime.run();

    expect(calls).toBe(0);
    expect(runtime.result('dry-job')?.stages.filter(stage => stage.reason === 'dry-run').map(stage => stage.stage)).toEqual([
      'ocr',
      'translate',
      'export',
    ]);
  });

  it('refuses translation before calling the handler when privacy consent is absent', async () => {
    let called = false;
    const runtime = new DocumentAutomationRuntime({
      runId: 'privacy-run',
      handlers: {
        translate: async () => { called = true; return { confidence: 1 }; },
      },
    });
    runtime.add(job('privacy-job', documentWithBlocks(['Private text']), {
      privacy: {
        mode: 'cloud',
        settings: { provider: 'openai', endpoint: 'https://example.invalid/v1', allowCloud: false },
      },
    }));

    await runtime.run();

    expect(called).toBe(false);
    expect(runtime.result('privacy-job')).toMatchObject({ state: 'failed', error: expect.stringMatching(/consent/i) });
  });

  it('writes bounded audit facts without document text or paths', async () => {
    const log = new AuditLog({ now: () => '2026-11-22T00:00:00Z' });
    const runtime = new DocumentAutomationRuntime({
      runId: 'audit-run',
      audit: { log, actor: 'app', at: '2026-11-22T00:00:00Z' },
    });
    runtime.add(job('audit-job', documentWithBlocks(['Customer: Alice', 'source\\private\\invoice.pdf']), {
      schema: [{ id: 'customer', label: 'Customer', type: 'text', required: true }],
    }));

    await runtime.run();

    const persisted = log.persist();
    expect(persisted).toContain('"kind": "import"');
    expect(persisted).toContain('"kind": "extract"');
    expect(persisted).not.toContain('Alice');
    expect(persisted).not.toContain('source\\private\\invoice.pdf');
    expect(log.verifyChain()).toBeNull();
  });
});

describe('diffAutomationWatch', () => {
  it('turns the pure watcher diff into deterministic added, modified and removed work', () => {
    const result = diffAutomationWatch(
      {
        'a.pdf': { size: 10, mtimeMs: 1 },
        'b.pdf': { size: 10, mtimeMs: 1 },
        'ignored.txt': { size: 10, mtimeMs: 1 },
      },
      {
        'a.pdf': { size: 11, mtimeMs: 2 },
        'c.pdf': { size: 12, mtimeMs: 3 },
        'ignored.txt': { size: 11, mtimeMs: 2 },
      },
      { debounceMs: 0 },
    );

    expect(result.work).toEqual([
      { path: 'a.pdf', kind: 'modified', at: 2, firstAt: 2, count: 1 },
      { path: 'b.pdf', kind: 'removed', at: 1, firstAt: 1, count: 1 },
      { path: 'c.pdf', kind: 'added', at: 3, firstAt: 3, count: 1 },
    ]);
    expect(result.removedPaths).toEqual(['b.pdf']);
    expect(result.diff.added.map(entry => entry.path)).toEqual(['c.pdf']);
  });
});
