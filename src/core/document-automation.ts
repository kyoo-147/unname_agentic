import {
  assertCanSend,
  effectiveEndpoint,
  privacyPolicy,
  type PrivacyMode,
  type PrivacySettings,
} from './privacy';
import {
  AuditLog,
  type AuditActor,
  type AuditEventKind,
} from './audit';
import { BatchQueue, type BatchQueueStatus } from './queue';
import {
  coalesce,
  diffSnapshot,
  planWatch,
  shouldProcess,
  type CoalescedChange,
  type FileSnapshot,
  type SnapshotDiff,
  type WatchOptions,
} from './watcher';
import { defineSchema, extractFields } from './schema';
import type { ExtractedField, FieldSchema, FieldBlock, FieldExtractionResult } from './schema';
import {
  DOCUMENT_IR_SCHEMA_VERSION,
  serialize,
  validate,
  type DocumentIR,
  type ExportRecord,
} from './ir';

export const AUTOMATION_STAGES = ['import', 'classify', 'ocr', 'translate', 'extract', 'export'] as const;
export type AutomationStage = (typeof AUTOMATION_STAGES)[number];

export type AutomationJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type AutomationStageState = 'done' | 'skipped' | 'failed' | 'cancelled';
export type AutomationReviewReason =
  | 'low-confidence'
  | 'invalid'
  | 'ambiguous'
  | 'missing-required'
  | 'handler';

export interface AutomationPrivacy {
  readonly mode: PrivacyMode;
  readonly settings: PrivacySettings;
}

export interface AutomationJob {
  readonly id: string;
  readonly source: DocumentIR;
  readonly schema?: unknown;
  readonly privacy?: AutomationPrivacy;
  readonly dryRun?: boolean;
}

export interface AutomationStageContext {
  readonly jobId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly stage: AutomationStage;
  readonly source: FrozenDocumentIR;
  readonly document: FrozenDocumentIR;
  readonly signal: AbortSignal;
  readonly dryRun: boolean;
  readonly privacy?: AutomationPrivacy;
}

export interface AutomationStageOutput {
  readonly document?: DocumentIR;
  readonly confidence?: number;
  readonly reviewReasons?: readonly AutomationReviewReason[];
  readonly exportRecord?: ExportRecord;
}

export type AutomationStageHandler = (
  context: AutomationStageContext,
) => AutomationStageOutput | Promise<AutomationStageOutput>;

export interface AutomationHandlers {
  readonly import?: AutomationStageHandler;
  readonly classify?: AutomationStageHandler;
  readonly ocr?: AutomationStageHandler;
  readonly translate?: AutomationStageHandler;
  readonly export?: AutomationStageHandler;
}

export interface AutomationAuditOptions {
  readonly log: AuditLog;
  readonly actor: AuditActor;
  readonly at: string;
}

export interface DocumentAutomationOptions {
  readonly runId: string;
  readonly concurrency?: number;
  readonly reviewThreshold?: number;
  readonly handlers?: AutomationHandlers;
  readonly audit?: AutomationAuditOptions;
}

export interface SourceRevisionRecord {
  readonly kind: 'source';
  readonly revisionId: string;
  readonly jobId: string;
  readonly document: FrozenDocumentIR;
}

export interface DerivedRevisionRecord {
  readonly kind: 'derived';
  readonly revisionId: string;
  readonly sourceRevisionId: string;
  readonly parentRevisionId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly stage: AutomationStage;
  readonly confidence: number | null;
  readonly document: FrozenDocumentIR;
}

export type AutomationRevision = SourceRevisionRecord | DerivedRevisionRecord;
export type FrozenDocumentIR = Readonly<DocumentIR>;

export interface AutomationReviewItem {
  readonly id: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly stage: AutomationStage;
  readonly reason: AutomationReviewReason;
  readonly confidence: number | null;
  readonly fieldId?: string;
  readonly blockId?: string;
  readonly detail?: string;
}

export interface AutomationStageRecord {
  readonly stage: AutomationStage;
  readonly attempt: number;
  readonly status: AutomationStageState;
  readonly confidence: number | null;
  readonly revisionId?: string;
  readonly reason?: 'no-handler' | 'no-schema' | 'dry-run';
  readonly reviewIds: readonly string[];
  readonly error?: string;
}

export interface AutomationJobResult {
  readonly jobId: string;
  readonly state: AutomationJobState;
  readonly attempt: number;
  readonly sourceRevisionId: string;
  readonly stages: readonly AutomationStageRecord[];
  readonly extraction: FieldExtractionResult | null;
  readonly exportRecords: readonly ExportRecord[];
  readonly reviewIds: readonly string[];
  readonly error?: string;
}

export interface AutomationJobStatus {
  readonly id: string;
  readonly state: AutomationJobState;
  readonly attempt: number;
  readonly currentStage: AutomationStage | null;
}

export interface DocumentAutomationStatus {
  readonly queue: BatchQueueStatus;
  readonly jobs: readonly AutomationJobStatus[];
}

export interface AutomationWatchPlan {
  readonly plan: ReturnType<typeof planWatch>;
  readonly diff: SnapshotDiff;
  readonly work: readonly CoalescedChange[];
  readonly removedPaths: readonly string[];
}

export interface AutomationWatchOptions extends WatchOptions {
  readonly debounceMs?: number;
}

export type AutomationErrorCode =
  | 'invalid-run-id'
  | 'invalid-job'
  | 'duplicate-job'
  | 'invalid-document'
  | 'invalid-stage-output'
  | 'invalid-confidence'
  | 'missing-privacy'
  | 'cancelled';

export class DocumentAutomationError extends Error {
  readonly code: AutomationErrorCode;

  constructor(code: AutomationErrorCode, message: string) {
    super(message);
    this.name = 'DocumentAutomationError';
    this.code = code;
  }
}

interface JobRecord {
  readonly id: string;
  readonly source: FrozenDocumentIR;
  readonly schema: FieldSchema[] | null;
  readonly dryRun: boolean;
  readonly privacy?: AutomationPrivacy;
  readonly sourceRevision: SourceRevisionRecord;
  state: AutomationJobState;
  attempt: number;
  currentStage: AutomationStage | null;
  cancelRequested: boolean;
  stages: AutomationStageRecord[];
  revisions: AutomationRevision[];
  reviews: AutomationReviewItem[];
  extraction: FieldExtractionResult | null;
  exportRecords: ExportRecord[];
  error?: string;
  currentDocument: FrozenDocumentIR;
  currentRevisionId: string;
}

interface StageExecution {
  readonly document: FrozenDocumentIR;
  readonly confidence: number | null;
  readonly extraction?: FieldExtractionResult;
  readonly exportRecord?: ExportRecord;
  readonly reviewIds: readonly string[];
}

interface StageHandlerMap {
  readonly [key: string]: AutomationStageHandler | undefined;
}

export function diffAutomationWatch(
  previous: FileSnapshot | null | undefined,
  current: FileSnapshot | null | undefined,
  options: AutomationWatchOptions = {},
): AutomationWatchPlan {
  const plan = planWatch(options);
  const diff = diffSnapshot(previous, current);
  const changes = [
    ...diff.added.map(change => ({ path: change.path, kind: 'added' as const, at: change.mtimeMs })),
    ...diff.modified.map(change => ({ path: change.path, kind: 'modified' as const, at: change.mtimeMs })),
    ...diff.removed.map(change => ({ path: change.path, kind: 'removed' as const, at: change.mtimeMs })),
  ].filter(change => shouldProcess(change.path, plan));
  const work = coalesce(changes, { debounceMs: options.debounceMs });
  const removedPaths = work.filter(change => change.kind === 'removed').map(change => change.path);
  return {
    plan,
    diff,
    work,
    removedPaths,
  };
}

export class DocumentAutomationRuntime {
  private readonly runId: string;
  private readonly reviewThreshold: number;
  private readonly handlers: AutomationStageMap;
  private readonly auditOptions?: AutomationAuditOptions;
  private readonly records = new Map<string, JobRecord>();
  private readonly queue: BatchQueue<JobRecord>;
  private readonly waiters: Array<(status: DocumentAutomationStatus) => void> = [];

  constructor(options: DocumentAutomationOptions) {
    if (!options || typeof options.runId !== 'string' || options.runId.trim() === '') {
      throw new DocumentAutomationError('invalid-run-id', 'runId must be a non-empty string.');
    }
    const threshold = options.reviewThreshold ?? 0.8;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new DocumentAutomationError('invalid-confidence', 'reviewThreshold must be between 0 and 1.');
    }
    this.runId = options.runId.trim();
    this.reviewThreshold = threshold;
    this.handlers = options.handlers ?? {};
    this.auditOptions = options.audit;
    this.queue = new BatchQueue<JobRecord>({
      concurrency: options.concurrency,
      run: async (job, signal) => this.process(job.payload, signal),
      onSettled: () => this.flushWaitersIfSettled(),
    });
  }

  add(input: AutomationJob): void {
    if (!input || typeof input.id !== 'string' || input.id.trim() === '') {
      throw new DocumentAutomationError('invalid-job', 'a job needs a non-empty id.');
    }
    const id = input.id.trim();
    if (this.records.has(id)) {
      throw new DocumentAutomationError('duplicate-job', `job "${id}" is already in the runtime.`);
    }
    const source = freezeDocument(input.source);
    const schema = input.schema === undefined ? null : defineSchema(input.schema);
    const sourceRevisionId = `source:${source.documentId}:${source.sourceSha256.slice(0, 16)}`;
    const sourceRevision: SourceRevisionRecord = freezeValue({
      kind: 'source',
      revisionId: sourceRevisionId,
      jobId: id,
      document: source,
    });
    const record: JobRecord = {
      id,
      source,
      schema,
      dryRun: input.dryRun === true,
      privacy: input.privacy,
      sourceRevision,
      state: 'queued',
      attempt: 0,
      currentStage: null,
      cancelRequested: false,
      stages: [],
      revisions: [sourceRevision],
      reviews: [],
      extraction: null,
      exportRecords: [],
      currentDocument: source,
      currentRevisionId: sourceRevisionId,
    };
    this.records.set(id, record);
    this.queue.add({ id, payload: record });
  }

  start(): void {
    for (const record of this.records.values()) {
      if (record.state === 'queued') record.cancelRequested = false;
    }
    this.queue.start();
    this.flushWaitersIfSettled();
  }

  pause(): void {
    this.queue.pause();
  }

  resume(): void {
    this.queue.resume();
  }

  cancel(): void {
    for (const record of this.records.values()) {
      if (record.state === 'queued' || record.state === 'running') {
        record.cancelRequested = true;
        record.state = 'cancelled';
      }
    }
    this.queue.cancelAll();
    this.flushWaitersIfSettled();
  }

  retryFailed(): string[] {
    const retried = this.queue.retryFailed();
    for (const id of retried) {
      const record = this.records.get(id);
      if (!record) continue;
      record.state = 'queued';
      record.cancelRequested = false;
      record.currentStage = null;
      record.stages = [];
      record.extraction = null;
      record.exportRecords = [];
      delete record.error;
      record.currentDocument = record.source;
      record.currentRevisionId = record.sourceRevision.revisionId;
    }
    return [...retried];
  }

  async run(): Promise<DocumentAutomationStatus> {
    this.start();
    if (this.queue.status().totals.pending === 0) return this.status();
    return new Promise(resolve => this.waiters.push(resolve));
  }

  status(): DocumentAutomationStatus {
    return freezeValue({
      queue: this.queue.status(),
      jobs: [...this.records.values()].map(record => ({
        id: record.id,
        state: record.state,
        attempt: record.attempt,
        currentStage: record.currentStage,
      })),
    });
  }

  result(jobId: string): AutomationJobResult | null {
    const record = this.records.get(jobId);
    return record ? cloneResult(record) : null;
  }

  revisions(jobId: string): readonly AutomationRevision[] {
    const record = this.records.get(jobId);
    return record ? cloneValue(record.revisions) : [];
  }

  reviewQueue(jobId?: string): readonly AutomationReviewItem[] {
    const records = jobId === undefined
      ? [...this.records.values()]
      : [this.records.get(jobId)].filter((record): record is JobRecord => record !== undefined);
    return cloneValue(records.flatMap(record => record.reviews));
  }

  failures(): readonly { id: string; error: string }[] {
    return [...this.records.values()]
      .filter(record => record.state === 'failed' && record.error !== undefined)
      .map(record => ({ id: record.id, error: record.error! }));
  }

  private async process(record: JobRecord, signal: AbortSignal): Promise<void> {
    record.attempt += 1;
    record.state = 'running';
    record.stages = [];
    record.extraction = null;
    record.exportRecords = [];
    record.currentDocument = record.source;
    record.currentRevisionId = record.sourceRevision.revisionId;
    delete record.error;

    try {
      for (const stage of AUTOMATION_STAGES) {
        this.ensureActive(record, signal);
        record.currentStage = stage;
        const execution = await this.executeStage(record, stage, signal);
        this.ensureActive(record, signal);
        if (execution.extraction !== undefined) record.extraction = execution.extraction;
        if (execution.exportRecord !== undefined) record.exportRecords.push(execution.exportRecord);
        this.appendDoneStage(record, stage, execution);
      }
      record.currentStage = null;
      record.state = 'done';
    } catch (error) {
      const failedStage = record.currentStage;
      const cancelled = error instanceof AutomationCancelledError || record.cancelRequested || signal.aborted;
      record.currentStage = null;
      if (cancelled) {
        record.state = 'cancelled';
        if (failedStage && record.stages[record.stages.length - 1]?.stage !== failedStage) {
          record.stages.push({
            stage: failedStage,
            attempt: record.attempt,
            status: 'cancelled',
            confidence: null,
            reviewIds: [],
          });
        }
        throw error;
      }
      record.state = 'failed';
      record.error = errorMessage(error);
      if (failedStage && record.stages[record.stages.length - 1]?.status !== 'failed') {
        record.stages.push({
          stage: failedStage,
          attempt: record.attempt,
          status: 'failed',
          confidence: null,
          reviewIds: [],
          error: record.error,
        });
      }
      throw error;
    }
  }

  private async executeStage(record: JobRecord, stage: AutomationStage, signal: AbortSignal): Promise<StageExecution> {
    if (stage === 'import' && !this.handlers.import) {
      const execution = { document: record.currentDocument, confidence: 1, reviewIds: [] as readonly string[] };
      this.commitRevision(record, stage, execution);
      this.audit(record, stage, 'done', execution.confidence, 0);
      return execution;
    }

    if (stage === 'classify' && !this.handlers.classify) {
      const problems = validate(record.currentDocument);
      if (problems.length > 0) {
        throw new DocumentAutomationError('invalid-document', problems.map(problem => problem.code).join(','));
      }
      const execution = {
        document: record.currentDocument,
        confidence: documentConfidence(record.currentDocument),
        reviewIds: [] as readonly string[],
      };
      this.commitRevision(record, stage, execution);
      this.audit(record, stage, 'done', execution.confidence, 0);
      return execution;
    }

    if (stage === 'extract') return this.executeExtraction(record, signal);

    const handler = this.handlers[stage];
    if (!handler) {
      const stageRecord: AutomationStageRecord = {
        stage,
        attempt: record.attempt,
        status: 'skipped',
        confidence: null,
        reason: 'no-handler',
        reviewIds: [],
      };
      record.stages.push(stageRecord);
      this.audit(record, stage, 'skipped', null, 0);
      return { document: record.currentDocument, confidence: null, reviewIds: [] };
    }

    if (record.dryRun) {
      record.stages.push({
        stage,
        attempt: record.attempt,
        status: 'skipped',
        confidence: null,
        reason: 'dry-run',
        reviewIds: [],
      });
      this.audit(record, stage, 'skipped', null, 0);
      return { document: record.currentDocument, confidence: null, reviewIds: [] };
    }

    if (stage === 'translate') {
      if (!record.privacy) throw new DocumentAutomationError('missing-privacy', 'translate requires explicit privacy settings.');
      const policy = privacyPolicy(record.privacy.mode, effectiveEndpoint(record.privacy.settings));
      assertCanSend(policy, record.privacy.settings);
    }

    const output = await handler({
      jobId: record.id,
      runId: this.runId,
      attempt: record.attempt,
      stage,
      source: record.source,
      document: record.currentDocument,
      signal,
      dryRun: record.dryRun,
      privacy: record.privacy,
    });
    this.ensureActive(record, signal);
    const normalized = normalizeOutput(output);
    const reviewIds = this.addHandlerReviews(record, stage, normalized.reviewReasons ?? [], normalized.confidence ?? null);
    const execution: StageExecution = {
      document: normalized.document ? freezeDerivedDocument(normalized.document, this.revisionId(record, stage)) : record.currentDocument,
      confidence: normalized.confidence ?? null,
      exportRecord: normalized.exportRecord,
      reviewIds,
    };
    this.commitRevision(record, stage, execution);
    this.audit(record, stage, 'done', execution.confidence, reviewIds.length);
    return execution;
  }

  private executeExtraction(record: JobRecord, signal: AbortSignal): StageExecution {
    if (!record.schema) {
      record.stages.push({
        stage: 'extract',
        attempt: record.attempt,
        status: 'skipped',
        confidence: null,
        reason: 'no-schema',
        reviewIds: [],
      });
      this.audit(record, 'extract', 'skipped', null, 0);
      return { document: record.currentDocument, confidence: null, reviewIds: [] };
    }
    this.ensureActive(record, signal);
    const blocks: FieldBlock[] = record.currentDocument.blocks.map(block => ({
      id: block.id,
      page: block.page,
      raw: block.raw,
      polygon: block.polygon,
      confidence: block.confidence,
    }));
    const extraction = extractFields(blocks, record.schema);
    const reviewIds = this.addExtractionReviews(record, extraction);
    const confidence = extraction.fields.length === 0
      ? (extraction.missing.length === 0 ? 1 : 0)
      : Math.min(...extraction.fields.map(field => field.confidence));
    const execution: StageExecution = {
      document: record.currentDocument,
      confidence,
      extraction,
      reviewIds,
    };
    this.commitRevision(record, 'extract', execution);
    this.audit(record, 'extract', 'done', confidence, reviewIds.length);
    return execution;
  }

  private appendDoneStage(record: JobRecord, stage: AutomationStage, execution: StageExecution): void {
    if (record.stages.some(item => item.stage === stage && item.attempt === record.attempt)) return;
    record.stages.push({
      stage,
      attempt: record.attempt,
      status: 'done',
      confidence: execution.confidence,
      revisionId: record.currentRevisionId,
      reviewIds: [...execution.reviewIds],
    });
  }

  private commitRevision(record: JobRecord, stage: AutomationStage, execution: StageExecution): void {
    const revisionId = this.revisionId(record, stage);
    const document = execution.document === record.currentDocument
      ? freezeDerivedDocument(record.currentDocument, revisionId)
      : freezeDerivedDocument(execution.document, revisionId);
    const revision: DerivedRevisionRecord = freezeValue({
      kind: 'derived',
      revisionId,
      sourceRevisionId: record.sourceRevision.revisionId,
      parentRevisionId: record.currentRevisionId,
      jobId: record.id,
      attempt: record.attempt,
      stage,
      confidence: execution.confidence,
      document,
    });
    record.revisions.push(revision);
    record.currentDocument = document;
    record.currentRevisionId = revisionId;
  }

  private addExtractionReviews(record: JobRecord, extraction: FieldExtractionResult): string[] {
    const ids: string[] = [];
    for (const field of extraction.fields) {
      const reasons: AutomationReviewReason[] = [];
      if (field.confidence < this.reviewThreshold) reasons.push('low-confidence');
      if (!field.valid) reasons.push('invalid');
      if (field.problems.some(problem => problem.startsWith('ambiguous:'))) reasons.push('ambiguous');
      for (const reason of reasons) {
        ids.push(this.addReview(record, 'extract', reason, field.confidence, {
          fieldId: field.id,
          blockId: field.blockId,
          detail: field.problems.join(','),
        }));
      }
    }
    for (const missing of extraction.missing) {
      ids.push(this.addReview(record, 'extract', 'missing-required', 0, {
        fieldId: missing.id,
        detail: 'required-field-missing',
      }));
    }
    return ids;
  }

  private addHandlerReviews(
    record: JobRecord,
    stage: AutomationStage,
    reasons: readonly AutomationReviewReason[],
    confidence: number | null,
  ): string[] {
    return reasons.map(reason => this.addReview(record, stage, reason, confidence, {}));
  }

  private addReview(
    record: JobRecord,
    stage: AutomationStage,
    reason: AutomationReviewReason,
    confidence: number | null,
    extra: Pick<AutomationReviewItem, 'fieldId' | 'blockId' | 'detail'>,
  ): string {
    const id = `review:${record.id}:${record.attempt}:${stage}:${record.reviews.length}`;
    record.reviews.push(freezeValue({
      id,
      jobId: record.id,
      attempt: record.attempt,
      stage,
      reason,
      confidence,
      ...extra,
    }));
    return id;
  }

  private audit(record: JobRecord, stage: AutomationStage, status: AutomationStageState, confidence: number | null, reviewCount: number): void {
    if (!this.auditOptions) return;
    const kind = auditKind(stage);
    if (!kind) return;
    this.auditOptions.log.append({
      kind,
      documentId: record.source.documentId,
      at: this.auditOptions.at,
      actor: this.auditOptions.actor,
      details: {
        stage,
        status,
        attempt: record.attempt,
        reviewCount,
        ...(confidence === null ? {} : { confidence }),
      },
    });
  }

  private ensureActive(record: JobRecord, signal: AbortSignal): void {
    if (signal.aborted || record.cancelRequested) throw new AutomationCancelledError();
  }

  private revisionId(record: JobRecord, stage: AutomationStage): string {
    return `derived:${record.id}:${this.runId}:${record.attempt}:${stage}`;
  }

  private flushWaitersIfSettled(): void {
    if (this.waiters.length === 0 || this.queue.status().totals.pending !== 0) return;
    const status = this.status();
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve(status);
  }
}

type AutomationStageMap = Partial<Record<AutomationStage, AutomationStageHandler>>;

class AutomationCancelledError extends DocumentAutomationError {
  constructor() {
    super('cancelled', 'automation was cancelled.');
  }
}

function auditKind(stage: AutomationStage): AuditEventKind | null {
  if (stage === 'import' || stage === 'extract' || stage === 'translate' || stage === 'export') return stage;
  return null;
}

function normalizeOutput(output: AutomationStageOutput | undefined): AutomationStageOutput {
  if (output === undefined) return {};
  if (typeof output !== 'object' || output === null) {
    throw new DocumentAutomationError('invalid-stage-output', 'a stage handler must return an object.');
  }
  if (output.confidence !== undefined && (!Number.isFinite(output.confidence) || output.confidence < 0 || output.confidence > 1)) {
    throw new DocumentAutomationError('invalid-confidence', 'stage confidence must be between 0 and 1.');
  }
  if (output.reviewReasons !== undefined) {
    for (const reason of output.reviewReasons) {
      if (!['low-confidence', 'invalid', 'ambiguous', 'missing-required', 'handler'].includes(reason)) {
        throw new DocumentAutomationError('invalid-stage-output', `unknown review reason ${String(reason)}.`);
      }
    }
  }
  return output;
}

function freezeDocument(document: DocumentIR): FrozenDocumentIR {
  if (!document || typeof document !== 'object' || document.schemaVersion !== DOCUMENT_IR_SCHEMA_VERSION) {
    throw new DocumentAutomationError('invalid-document', 'source must be a Document IR with a supported schema version.');
  }
  const problems = validate(document);
  if (problems.length > 0) throw new DocumentAutomationError('invalid-document', problems.map(problem => problem.code).join(','));
  return freezeValue(JSON.parse(serialize(document)) as DocumentIR);
}

function freezeDerivedDocument(document: DocumentIR, revisionId: string): FrozenDocumentIR {
  const source = freezeDocument(document);
  if (source.documentId !== document.documentId || source.sourceSha256 !== document.sourceSha256) {
    throw new DocumentAutomationError('invalid-stage-output', 'a derived document must preserve documentId and sourceSha256.');
  }
  const copy = JSON.parse(serialize(source)) as DocumentIR;
  copy.revisionId = revisionId;
  return freezeValue(copy);
}

function documentConfidence(document: FrozenDocumentIR): number {
  if (document.blocks.length === 0) return 1;
  return Math.min(...document.blocks.map(block => clamp01(block.confidence)));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function cloneResult(record: JobRecord): AutomationJobResult {
  return freezeValue({
    jobId: record.id,
    state: record.state,
    attempt: record.attempt,
    sourceRevisionId: record.sourceRevision.revisionId,
    stages: record.stages,
    extraction: record.extraction,
    exportRecords: record.exportRecords,
    reviewIds: record.reviews.map(review => review.id),
    ...(record.error === undefined ? {} : { error: record.error }),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function freezeValue<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeValue(child);
  return Object.freeze(value);
}

function cloneValue<T>(value: T): T {
  return freezeValue(JSON.parse(JSON.stringify(value)) as T);
}
