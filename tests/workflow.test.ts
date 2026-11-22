import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/core/audit';
import { buildDocument, type DocumentIR } from '../src/core/ir';
import { DocumentAutomationRuntime } from '../src/core/document-automation';
import {
  LocalWorkflowBoundary,
  authorizeWatchPath,
  createStructuredExtractionOutput,
  planWorkflow,
  previewWorkflowRules,
  serializeStructuredExtraction,
} from '../src/core/workflow';

const SOURCE_SHA = 'b'.repeat(64);
const PAGE = { index: 1, width: 612, height: 792, rotation: 0 as const };

function source(confidence = 1): DocumentIR {
  return buildDocument({
    documentId: 'workflow-doc',
    sourceSha256: SOURCE_SHA,
    language: 'en',
    pages: [PAGE],
    blocks: [
      {
        page: 1,
        text: 'Invoice: INV-42',
        rect: { x: 72, y: 72, width: 180, height: 16 },
        confidence,
        origin: 'pdf-text',
      },
      {
        page: 1,
        text: 'Total: 1,234.50',
        rect: { x: 72, y: 96, width: 180, height: 16 },
        confidence,
        origin: 'pdf-text',
      },
    ],
  });
}

describe('workflow contracts', () => {
  it('produces reviewable structured extraction with bbox, validator and immutable links', async () => {
    const runtime = new DocumentAutomationRuntime({
      runId: 'workflow-run',
      reviewThreshold: 0.8,
      pipeline: 'extract-review-export',
    });
    runtime.add({
      id: 'invoice-job',
      source: source(0.6),
      schema: [
        { id: 'invoice', label: 'Invoice', type: 'identifier', required: true },
        { id: 'total', label: 'Total', type: 'currency', required: true },
      ],
    });

    await runtime.run();
    const result = runtime.result('invoice-job');
    const output = createStructuredExtractionOutput(result!, runtime.revisions('invoice-job'), runtime.reviewQueue('invoice-job'))!;

    expect(result?.pipelineId).toBe('extract-review-export');
    expect(output).toMatchObject({
      kind: 'mirror.workflow.extraction',
      documentId: 'workflow-doc',
      sourceSha256: SOURCE_SHA,
      sourceRevisionId: result?.sourceRevisionId,
    });
    expect(output.fields).toHaveLength(2);
    expect(output.fields[0]).toMatchObject({
      id: 'invoice',
      value: 'INV-42',
      bbox: { x: 72, y: 72, width: 180, height: 16 },
      confidence: 0.54,
      review: 'pending',
      validator: { valid: true, problems: [] },
    });
    expect(output.fields[1]?.validator.valid).toBe(true);
    expect(output.derivedArtifactLinks.every(link => link.immutable)).toBe(true);
    expect(Object.isFrozen(output)).toBe(true);
  });

  it('plans predefined pipelines and requires a schema when extraction is enabled', () => {
    expect(planWorkflow({ pipelineId: 'import-to-export', dryRun: true })).toMatchObject({
      stages: ['import', 'classify', 'export'],
      output: 'json',
      dryRun: true,
      requiresSchema: false,
    });
    expect(() => planWorkflow({ pipelineId: 'extract-review-export', schemaProvided: false })).toThrow(/requires a schema/u);
  });

  it('previews rules and lets an explicit override select a pipeline', () => {
    const document = source();
    const rules = [
      { id: 'invoice', condition: { textIncludes: 'invoice' }, action: { pipelineId: 'extract-review-export' as const, tags: ['finance'] } },
      { id: 'manual', condition: { textIncludes: 'missing' }, action: { tags: ['manual'] } },
    ];
    expect(previewWorkflowRules(document, rules).previews).toEqual([
      expect.objectContaining({ ruleId: 'invoice', matched: true, effective: true, reason: 'matched' }),
      expect.objectContaining({ ruleId: 'manual', matched: false, effective: false, reason: 'not-matched' }),
    ]);
    expect(previewWorkflowRules(document, rules, { manual: { enabled: true } })).toMatchObject({
      pipelineId: 'extract-review-export',
      tags: ['finance', 'manual'],
      previews: [
        expect.anything(),
        expect.objectContaining({ reason: 'enabled-by-override', effective: true }),
      ],
    });
  });

  it('serializes structured results as deterministic CSV without dropping missing fields', async () => {
    const runtime = new DocumentAutomationRuntime({ runId: 'csv-run', pipeline: 'extract-review-export' });
    runtime.add({ id: 'csv-job', source: source(), schema: [{ id: 'invoice', label: 'Invoice', type: 'identifier', required: true }, { id: 'missing', label: 'Missing', type: 'text', required: true }] });
    await runtime.run();
    const result = createStructuredExtractionOutput(runtime.result('csv-job')!, runtime.revisions('csv-job'), runtime.reviewQueue('csv-job'))!;
    expect(serializeStructuredExtraction(result, 'csv')).toContain('invoice,INV-42');
    expect(serializeStructuredExtraction(result, 'csv')).toContain('missing,,,,,,0,false,pending');
  });

  it('requires explicit read-only consent and keeps watch paths inside the granted root', () => {
    const consent = { root: 'D:/Inbox', explicit: true as const, mode: 'read-only' as const };
    expect(authorizeWatchPath('D:/Inbox/invoice.pdf', consent)).toMatchObject({ allowed: true, reason: 'allowed' });
    expect(authorizeWatchPath('D:/Inbox-other/invoice.pdf', consent).reason).toBe('outside-granted-folder');
    expect(authorizeWatchPath('D:/Inbox/invoice.pdf', null).reason).toBe('consent-required');
    expect(authorizeWatchPath('relative/invoice.pdf', consent).reason).toBe('invalid-path');
  });

  it('uses one authenticated local boundary for CLI, API and MCP adapters with audit and rate limits', () => {
    const audit = new AuditLog({ now: () => '2026-11-22T00:00:00.000Z' });
    const runtime = new DocumentAutomationRuntime({ runId: 'boundary-run' });
    let now = 1000;
    const boundary = new LocalWorkflowBoundary({
      runtime,
      token: 'local-secret',
      audit,
      now: () => now,
      maxRequests: 1,
      windowMs: 100,
    });

    expect(boundary.dispatch({ requestId: 'bad', token: 'wrong', transport: 'api', action: 'status' })).toMatchObject({ status: 401, error: 'unauthorized' });
    expect(boundary.dispatch({ requestId: 'one', token: 'local-secret', transport: 'mcp', action: 'workflow-plan', pipelineId: 'extract-review-export' })).toMatchObject({ ok: true, status: 200 });
    expect(boundary.dispatch({ requestId: 'two', token: 'local-secret', transport: 'cli', action: 'status' })).toMatchObject({ status: 429, error: 'rate-limited' });
    now += 101;
    expect(boundary.dispatch({ requestId: 'three', token: 'local-secret', transport: 'cli', action: 'status' })).toMatchObject({ ok: true, status: 200 });
    expect(audit.entries().map(entry => entry.details.result)).toEqual(['error:unauthorized', 'ok', 'error:rate-limited', 'ok']);
  });
});
