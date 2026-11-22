/**
 * Local document-workflow contracts for structured extraction and automation.
 *
 * This module composes the existing IR, schema extractor, queue runtime, watcher
 * diff and audit log. It is deliberately a local dispatcher, not a server or RBAC
 * layer: CLI, REST and MCP adapters can share one authenticated boundary without
 * pretending that a team workspace exists.
 */

import {
  PREDEFINED_AUTOMATION_PIPELINES,
  type AutomationJobResult,
  type AutomationPipelineId,
  type AutomationReviewItem,
  type AutomationRevision,
  type DocumentAutomationRuntime,
} from './document-automation';
import { AuditLog } from './audit';
import { extractFields } from './schema';
import type { ExtractedField, FieldExtractionResult, FieldSchema } from './schema';
import type { DocumentIR } from './ir';
import type { Rect } from './types';

export const WORKFLOW_OUTPUT_SCHEMA_VERSION = 1;
export const WORKFLOW_OUTPUT_KIND = 'mirror.workflow.extraction';
export type StructuredOutputFormat = 'json' | 'csv';

export interface StructuredFieldOutput {
  readonly id: string;
  readonly value: string;
  readonly raw: string;
  readonly page: number;
  readonly blockId: string;
  readonly bbox: Rect;
  readonly confidence: number;
  readonly validator: {
    readonly valid: boolean;
    readonly problems: readonly string[];
  };
  readonly review: 'pending' | 'not-required';
}

export interface StructuredExtractionOutput {
  readonly schemaVersion: number;
  readonly kind: typeof WORKFLOW_OUTPUT_KIND;
  readonly documentId: string;
  readonly sourceSha256: string;
  readonly sourceRevisionId: string;
  readonly revisionId: string;
  readonly fields: readonly StructuredFieldOutput[];
  readonly missing: readonly { id: string; label: string }[];
  readonly reviews: readonly AutomationReviewItem[];
  readonly derivedArtifactLinks: readonly DerivedArtifactLink[];
}

export interface DerivedArtifactLink {
  readonly artifactId: string;
  readonly revisionId: string;
  readonly sourceRevisionId: string;
  readonly parentRevisionId: string | null;
  readonly jobId: string;
  readonly stage: 'import' | 'classify' | 'ocr' | 'translate' | 'extract' | 'export';
  readonly immutable: true;
}

export function createStructuredExtractionOutput(
  result: AutomationJobResult,
  revisions: readonly AutomationRevision[],
  reviews: readonly AutomationReviewItem[],
): StructuredExtractionOutput | null {
  const extraction = result.extraction;
  const revision = revisions[revisions.length - 1];
  if (!extraction || !revision) return null;

  const pending = new Set(
    reviews.filter(review => review.stage === 'extract' && review.fieldId !== undefined).map(review => review.fieldId!),
  );
  return freeze({
    schemaVersion: WORKFLOW_OUTPUT_SCHEMA_VERSION,
    kind: WORKFLOW_OUTPUT_KIND,
    documentId: revision.document.documentId,
    sourceSha256: revision.document.sourceSha256,
    sourceRevisionId: result.sourceRevisionId,
    revisionId: revision.revisionId,
    fields: extraction.fields.map(field => structuredField(field, pending.has(field.id))),
    missing: extraction.missing.map(field => ({ ...field })),
    reviews: reviews.map(review => ({ ...review })),
    derivedArtifactLinks: linkDerivedArtifacts(revisions),
  });
}

export function extractReviewableDocument(
  document: DocumentIR,
  schema: readonly FieldSchema[],
  options: { readonly jobId?: string; readonly reviewThreshold?: number } = {},
): StructuredExtractionOutput {
  const extraction = extractStructuredFields(document, schema);
  const threshold = options.reviewThreshold ?? 0.8;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('reviewThreshold must be between 0 and 1.');
  const jobId = options.jobId ?? document.documentId;
  const reviews: AutomationReviewItem[] = [];
  for (const field of extraction.fields) {
    const reasons = [
      ...(field.confidence < threshold ? ['low-confidence' as const] : []),
      ...(field.valid ? [] : ['invalid' as const]),
    ];
    for (const reason of reasons) reviews.push({
      id: `review:${jobId}:1:extract:${reviews.length}`,
      jobId,
      attempt: 1,
      stage: 'extract',
      reason,
      confidence: field.confidence,
      fieldId: field.id,
      blockId: field.blockId,
      detail: field.problems.join(','),
    });
  }
  for (const missing of extraction.missing) reviews.push({
    id: `review:${jobId}:1:extract:${reviews.length}`,
    jobId,
    attempt: 1,
    stage: 'extract',
    reason: 'missing-required',
    confidence: 0,
    fieldId: missing.id,
    detail: 'required-field-missing',
  });
  const pending = new Set(reviews.map(review => review.fieldId).filter((id): id is string => id !== undefined));
  return freeze({
    schemaVersion: WORKFLOW_OUTPUT_SCHEMA_VERSION,
    kind: WORKFLOW_OUTPUT_KIND,
    documentId: document.documentId,
    sourceSha256: document.sourceSha256,
    sourceRevisionId: `source:${jobId}:${document.sourceSha256}`,
    revisionId: document.revisionId,
    fields: extraction.fields.map(field => structuredField(field, pending.has(field.id))),
    missing: extraction.missing.map(field => ({ ...field })),
    reviews,
    derivedArtifactLinks: [],
  });
}

export function serializeStructuredExtraction(output: StructuredExtractionOutput, format: StructuredOutputFormat = 'json'): string {
  if (format === 'json') return JSON.stringify(output, null, 2) + '\n';
  const header = ['id', 'value', 'raw', 'page', 'blockId', 'bbox', 'confidence', 'valid', 'review'];
  const rows = output.fields.map(field => [
    field.id,
    field.value,
    field.raw,
    String(field.page),
    field.blockId,
    JSON.stringify(field.bbox),
    String(field.confidence),
    String(field.validator.valid),
    field.review,
  ]);
  for (const missing of output.missing) rows.push([missing.id, '', '', '', '', '', '0', 'false', 'pending']);
  return [...[header], ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n';
}

function csvCell(value: string): string {
  return /[",\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function structuredField(field: ExtractedField, pending: boolean): StructuredFieldOutput {
  return {
    id: field.id,
    value: field.value,
    raw: field.raw,
    page: field.page,
    blockId: field.blockId,
    bbox: { ...field.rect },
    confidence: field.confidence,
    validator: { valid: field.valid, problems: [...field.problems] },
    review: pending ? 'pending' : 'not-required',
  };
}

export function linkDerivedArtifacts(revisions: readonly AutomationRevision[]): DerivedArtifactLink[] {
  return revisions.flatMap(revision => {
    if (revision.kind !== 'derived') return [];
    return [{
      artifactId: `revision:${revision.revisionId}`,
      revisionId: revision.revisionId,
      sourceRevisionId: revision.sourceRevisionId,
      parentRevisionId: revision.parentRevisionId,
      jobId: revision.jobId,
      stage: revision.stage,
      immutable: true as const,
    }];
  });
}

export interface WorkflowPlan {
  readonly pipelineId: AutomationPipelineId;
  readonly stages: readonly string[];
  readonly output: 'json' | 'csv';
  readonly dryRun: boolean;
  readonly reviewThreshold: number;
  readonly requiresSchema: boolean;
}

export function planWorkflow(options: {
  readonly pipelineId?: AutomationPipelineId;
  readonly dryRun?: boolean;
  readonly reviewThreshold?: number;
  readonly schemaProvided?: boolean;
  readonly output?: StructuredOutputFormat;
} = {}): WorkflowPlan {
  const pipelineId = options.pipelineId ?? 'extract-review-export';
  const pipeline = PREDEFINED_AUTOMATION_PIPELINES[pipelineId];
  if (!pipeline) throw new Error(`unknown pipeline "${pipelineId}".`);
  const reviewThreshold = options.reviewThreshold ?? 0.8;
  if (!Number.isFinite(reviewThreshold) || reviewThreshold < 0 || reviewThreshold > 1) {
    throw new Error('reviewThreshold must be between 0 and 1.');
  }
  const requiresSchema = pipeline.stages.includes('extract');
  if (requiresSchema && options.schemaProvided === false) {
    throw new Error(`pipeline "${pipelineId}" requires a schema.`);
  }
  return {
    pipelineId,
    stages: [...pipeline.stages],
    output: options.output ?? 'json',
    dryRun: options.dryRun === true,
    reviewThreshold,
    requiresSchema,
  };
}

export interface WorkflowRuleCondition {
  readonly textIncludes?: string;
  readonly blockType?: DocumentIR['blocks'][number]['type'];
  readonly minConfidence?: number;
}

export interface WorkflowRuleAction {
  readonly pipelineId?: AutomationPipelineId;
  readonly tags?: readonly string[];
}

export interface WorkflowRule {
  readonly id: string;
  readonly condition: WorkflowRuleCondition;
  readonly action: WorkflowRuleAction;
}

export interface WorkflowRuleOverride {
  readonly enabled?: boolean;
  readonly pipelineId?: AutomationPipelineId;
}

export interface WorkflowRulePreview {
  readonly ruleId: string;
  readonly matched: boolean;
  readonly reason: string;
  readonly effective: boolean;
  readonly effectivePipelineId: AutomationPipelineId | null;
  readonly tags: readonly string[];
}

export interface WorkflowRuleResolution {
  readonly pipelineId: AutomationPipelineId | null;
  readonly tags: readonly string[];
  readonly previews: readonly WorkflowRulePreview[];
}

export function previewWorkflowRules(
  document: DocumentIR,
  rules: readonly WorkflowRule[],
  overrides: Readonly<Record<string, WorkflowRuleOverride>> = {},
): WorkflowRuleResolution {
  const tags = new Set<string>();
  let pipelineId: AutomationPipelineId | null = null;
  const previews = rules.map(rule => {
    const override = overrides[rule.id];
    const match = matchesRule(document, rule.condition);
    const effective = override?.enabled ?? match;
    const effectivePipelineId = effective ? (override?.pipelineId ?? rule.action.pipelineId ?? null) : null;
    if (effective) {
      if (effectivePipelineId) pipelineId = effectivePipelineId;
      for (const tag of rule.action.tags ?? []) if (tag.trim()) tags.add(tag.trim());
    }
    return {
      ruleId: rule.id,
      matched: match,
      reason: override?.enabled === false ? 'disabled-by-override' : override?.enabled === true && !match ? 'enabled-by-override' : match ? 'matched' : 'not-matched',
      effective,
      effectivePipelineId,
      tags: [...(rule.action.tags ?? [])].filter(tag => tag.trim()),
    };
  });
  return { pipelineId, tags: [...tags].sort(), previews };
}

function matchesRule(document: DocumentIR, condition: WorkflowRuleCondition): boolean {
  if (condition.textIncludes !== undefined) {
    const needle = condition.textIncludes.trim().toLocaleLowerCase();
    if (!needle || !document.blocks.some(block => block.raw.toLocaleLowerCase().includes(needle))) return false;
  }
  if (condition.blockType !== undefined && !document.blocks.some(block => block.type === condition.blockType)) return false;
  if (condition.minConfidence !== undefined && !document.blocks.some(block => block.confidence >= condition.minConfidence!)) return false;
  return true;
}

export interface FolderWatchConsent {
  readonly root: string;
  readonly explicit: true;
  readonly mode: 'read-only';
}

export interface FolderWatchDecision {
  readonly allowed: boolean;
  readonly path: string;
  readonly reason: 'allowed' | 'consent-required' | 'outside-granted-folder' | 'invalid-path';
}

export function authorizeWatchPath(path: string, consent: FolderWatchConsent | null | undefined): FolderWatchDecision {
  const candidate = normalizePath(path);
  if (!consent?.explicit || consent.mode !== 'read-only') {
    return { allowed: false, path: candidate, reason: 'consent-required' };
  }
  const root = normalizePath(consent?.root ?? '');
  if (!candidate || !root || !isAbsoluteLike(candidate) || !isAbsoluteLike(root)) {
    return { allowed: false, path: candidate, reason: 'invalid-path' };
  }
  const allowed = candidate === root || candidate.startsWith(`${root}/`);
  return { allowed, path: candidate, reason: allowed ? 'allowed' : 'outside-granted-folder' };
}

function normalizePath(value: string): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+/gu, '/');
  const drive = normalized.match(/^[A-Za-z]:/u)?.[0]?.toUpperCase() ?? '';
  const body = normalized.slice(drive.length).replace(/\/\.\//gu, '/');
  if (body.split('/').some(part => part === '..')) return '';
  return `${drive}${body}`.replace(/\/$/u, '').toLocaleLowerCase();
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith('/') || /^[a-z]:\//u.test(value);
}

export type LocalBoundaryTransport = 'cli' | 'api' | 'mcp';
export type LocalBoundaryAction =
  | 'status'
  | 'review-queue'
  | 'artifacts'
  | 'workflow-plan'
  | 'start'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'retry-failed';

export interface LocalBoundaryRequest {
  readonly requestId: string;
  readonly token: string;
  readonly transport: LocalBoundaryTransport;
  readonly action: LocalBoundaryAction;
  readonly jobId?: string;
  readonly pipelineId?: AutomationPipelineId;
  readonly output?: StructuredOutputFormat;
  readonly dryRun?: boolean;
}

export interface LocalBoundaryResponse {
  readonly ok: boolean;
  readonly status: 200 | 400 | 401 | 429;
  readonly requestId: string;
  readonly data?: unknown;
  readonly error?: 'invalid-request' | 'unauthorized' | 'rate-limited';
}

export class LocalWorkflowBoundary {
  private readonly runtime: DocumentAutomationRuntime;
  private readonly token: string;
  private readonly audit: AuditLog;
  private readonly now: () => number;
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private requests: number[] = [];

  constructor(options: {
    readonly runtime: DocumentAutomationRuntime;
    readonly token: string;
    readonly audit?: AuditLog;
    readonly now?: () => number;
    readonly maxRequests?: number;
    readonly windowMs?: number;
  }) {
    if (!options.token.trim()) throw new Error('local boundary token must be non-empty.');
    this.runtime = options.runtime;
    this.token = options.token;
    this.audit = options.audit ?? new AuditLog({ now: () => new Date().toISOString() });
    this.now = options.now ?? (() => Date.now());
    this.maxRequests = options.maxRequests ?? 60;
    this.windowMs = options.windowMs ?? 60_000;
    if (!Number.isInteger(this.maxRequests) || this.maxRequests < 1 || !Number.isFinite(this.windowMs) || this.windowMs <= 0) {
      throw new Error('local boundary rate limit must be positive.');
    }
  }

  dispatch(request: LocalBoundaryRequest): LocalBoundaryResponse {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    if (!requestId || !request || !request.transport || !request.action) return this.respond(requestId, 400, 'invalid-request');
    if (request.token !== this.token) return this.respond(requestId, 401, 'unauthorized');
    if (!this.admit()) return this.respond(requestId, 429, 'rate-limited');

    let data: unknown;
    switch (request.action) {
      case 'status': data = this.runtime.status(); break;
      case 'review-queue': data = this.runtime.reviewQueue(request.jobId); break;
      case 'artifacts': data = request.jobId ? linkDerivedArtifacts(this.runtime.revisions(request.jobId)) : []; break;
      case 'workflow-plan': data = planWorkflow({ pipelineId: request.pipelineId, output: request.output, dryRun: request.dryRun }); break;
      case 'start': this.runtime.start(); data = this.runtime.status(); break;
      case 'pause': this.runtime.pause(); data = this.runtime.status(); break;
      case 'resume': this.runtime.resume(); data = this.runtime.status(); break;
      case 'cancel': this.runtime.cancel(); data = this.runtime.status(); break;
      case 'retry-failed': data = this.runtime.retryFailed(); break;
      default: return this.respond(requestId, 400, 'invalid-request');
    }
    return this.respond(requestId, 200, undefined, data);
  }

  private admit(): boolean {
    const cutoff = this.now() - this.windowMs;
    this.requests = this.requests.filter(at => at > cutoff);
    if (this.requests.length >= this.maxRequests) return false;
    this.requests.push(this.now());
    return true;
  }

  private respond(requestId: string, status: 200 | 400 | 401 | 429, error?: LocalBoundaryResponse['error'], data?: unknown): LocalBoundaryResponse {
    const event = error ? `error:${error}` : 'ok';
    this.audit.append({
      kind: 'config',
      documentId: 'automation-boundary',
      at: new Date(this.now()).toISOString(),
      actor: 'app',
      details: { requestId, status, result: event },
    });
    return error ? { ok: false, status, requestId, error } : { ok: true, status, requestId, data };
  }
}

export function extractStructuredFields(document: DocumentIR, schema: readonly FieldSchema[]): FieldExtractionResult {
  return extractFields(document.blocks.map(block => ({
    id: block.id,
    page: block.page,
    raw: block.raw,
    polygon: block.polygon,
    confidence: block.confidence,
  })), schema);
}

function freeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}
