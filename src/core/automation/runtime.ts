import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { sha256Hex } from '../ocr-corrections';
import { defineSchema, extractFields, type FieldExtractionResult, type FieldSchema } from '../schema';
import { serialize, type DocumentIR } from '../ir';
import type { RuntimeDocument } from '../document-runtime';
import { AuditLog, type AuditActor } from '../audit';
import { AtomicJsonStore, GenerationConflictError, type VersionedState } from './persistence';
import { evaluateRules, type AutomationRule, type RuleEvaluation, type RuleOverride } from './rules';
import { importPdfFile } from './pdf-import';
import { ImmutableVersionStore, type ImmutableVersion } from './versions';
import { assertAuthorizedPath } from './folder-watcher';

export const AUTOMATION_STATE_SCHEMA_VERSION = 1;
export const AUTOMATION_STAGE_ORDER = ['import', 'classify', 'ocr', 'extract', 'translate', 'export'] as const;
export type DurableAutomationStage = (typeof AUTOMATION_STAGE_ORDER)[number];
export type DurableJobState = 'queued' | 'running' | 'paused' | 'review' | 'done' | 'failed' | 'cancelled';

export interface DurableReviewItem {
  readonly id: string;
  readonly fieldId?: string;
  readonly stage: DurableAutomationStage;
  readonly reason: 'low-confidence' | 'invalid' | 'missing-required' | 'ambiguous' | 'handler' | 'ocr';
  readonly confidence: number | null;
  readonly detail: string;
  readonly status: 'pending' | 'approved' | 'rejected' | 'edited';
  readonly value?: string;
  readonly decidedValue?: string | null;
}

export interface DurableAutomationArtifact {
  readonly kind: 'result' | 'report' | 'document';
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface DurableAutomationJob {
  readonly id: string;
  readonly sourcePath: string;
  readonly sourceName: string;
  readonly sourceSha256: string;
  readonly outputDir: string;
  readonly schema: readonly FieldSchema[] | null;
  readonly rules: readonly AutomationRule[];
  readonly overrides: readonly RuleOverride[];
  readonly translateRequested: boolean;
  state: DurableJobState;
  stage: DurableAutomationStage | null;
  completedStages: DurableAutomationStage[];
  attempt: number;
  runtime: RuntimeDocument | null;
  document: DocumentIR | null;
  extraction: FieldExtractionResult | null;
  rulesResult: RuleEvaluation | null;
  reviews: DurableReviewItem[];
  artifacts: DurableAutomationArtifact[];
  versions: ImmutableVersion[];
  error: string | null;
  cancelRequested: boolean;
  pauseRequested: boolean;
}

export interface AutomationState extends VersionedState {
  readonly schemaVersion: typeof AUTOMATION_STATE_SCHEMA_VERSION;
  jobs: Record<string, DurableAutomationJob>;
  audit: string;
}

export interface LocalAutomationRuntimeOptions {
  readonly statePath: string;
  readonly authorizedRoots: readonly string[];
  readonly reviewThreshold?: number;
  readonly now?: () => string;
  readonly actor?: AuditActor;
  readonly ocr?: (runtime: RuntimeDocument, signal: AbortSignal) => Promise<RuntimeDocument>;
  readonly translate?: (document: DocumentIR, signal: AbortSignal) => Promise<DocumentIR>;
  readonly importPdf?: typeof importPdfFile;
}

export interface EnqueueJobInput {
  readonly id?: string;
  readonly sourcePath: string;
  readonly outputDir: string;
  readonly schema?: unknown;
  readonly rules?: readonly AutomationRule[];
  readonly overrides?: readonly RuleOverride[];
  readonly translate?: boolean;
}

export interface AutomationStatus {
  readonly generation: number;
  readonly jobs: readonly Pick<DurableAutomationJob, 'id' | 'sourcePath' | 'state' | 'stage' | 'completedStages' | 'attempt' | 'error' | 'reviews' | 'artifacts'>[];
}

export class AutomationRuntimeError extends Error {
  constructor(readonly code: 'invalid-input' | 'unauthorized' | 'duplicate' | 'not-found' | 'review-required' | 'cancelled' | 'generation-conflict', message: string) {
    super(message);
    this.name = 'AutomationRuntimeError';
  }
}

export class LocalAutomationRuntime {
  private readonly store: AtomicJsonStore<AutomationState>;
  private readonly now: () => string;
  private readonly actor: AuditActor;
  private readonly reviewThreshold: number;
  private readonly authorizedRoots: readonly string[];
  private readonly importPdf: typeof importPdfFile;
  private readonly ocr?: LocalAutomationRuntimeOptions['ocr'];
  private readonly translate?: LocalAutomationRuntimeOptions['translate'];
  private readonly versions: ImmutableVersionStore;
  private state!: AutomationState;
  private active = false;
  private paused = false;
  private controller: AbortController | undefined;
  private commitChain: Promise<void> = Promise.resolve();

  constructor(options: LocalAutomationRuntimeOptions) {
    if (!options || typeof options.statePath !== 'string' || options.statePath.trim() === '') throw new AutomationRuntimeError('invalid-input', 'statePath is required.');
    if (!Array.isArray(options.authorizedRoots) || options.authorizedRoots.length === 0) throw new AutomationRuntimeError('invalid-input', 'at least one authorized folder is required.');
    const threshold = options.reviewThreshold ?? 0.8;
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new AutomationRuntimeError('invalid-input', 'reviewThreshold must be between 0 and 1.');
    this.now = options.now ?? (() => new Date().toISOString());
    this.actor = options.actor ?? 'app';
    this.reviewThreshold = threshold;
    this.authorizedRoots = options.authorizedRoots.map(root => resolve(root));
    this.importPdf = options.importPdf ?? importPdfFile;
    this.ocr = options.ocr;
    this.translate = options.translate;
    this.store = new AtomicJsonStore({ path: resolve(options.statePath), initial: emptyState });
    this.versions = new ImmutableVersionStore(dirname(resolve(options.statePath)), this.now);
  }

  async open(): Promise<void> {
    this.state = await this.store.load();
    await this.versions.open();
    await this.recoverInterruptedJobs();
  }

  async enqueue(input: EnqueueJobInput): Promise<DurableAutomationJob> {
    await this.ensureOpen();
    if (!input || typeof input.sourcePath !== 'string' || typeof input.outputDir !== 'string') throw new AutomationRuntimeError('invalid-input', 'sourcePath and outputDir are required.');
    const sourcePath = assertAuthorizedPath(input.sourcePath, this.authorizedRoots);
    const realSourcePath = assertAuthorizedPath(await realpath(sourcePath), this.authorizedRoots);
    const outputDir = assertAuthorizedPath(input.outputDir, this.authorizedRoots);
    const bytes = new Uint8Array(await readFile(realSourcePath));
    const sourceSha256 = sha256Hex(bytes);
    const id = input.id?.trim() || `job-${sourceSha256.slice(0, 16)}`;
    const existing = this.state.jobs[id];
    if (existing) {
      if (existing.sourceSha256 === sourceSha256 && existing.sourcePath === realSourcePath) return clone(existing);
      throw new AutomationRuntimeError('duplicate', `job ${id} already exists with a different source.`);
    }
    const schema = input.schema === undefined ? null : normalizeSchema(input.schema);
    const job: DurableAutomationJob = {
      id,
      sourcePath: realSourcePath,
      sourceName: basename(realSourcePath),
      sourceSha256,
      outputDir,
      schema,
      rules: [...(input.rules ?? [])],
      overrides: [...(input.overrides ?? [])],
      translateRequested: input.translate === true,
      state: 'queued',
      stage: null,
      completedStages: [],
      attempt: 0,
      runtime: null,
      document: null,
      extraction: null,
      rulesResult: null,
      reviews: [],
      artifacts: [],
      versions: [],
      error: null,
      cancelRequested: false,
      pauseRequested: false,
    };
    await this.commit(current => ({ ...current, jobs: { ...current.jobs, [id]: job } }), 'import', id);
    return clone(job);
  }

  async run(): Promise<AutomationStatus> {
    await this.ensureOpen();
    if (this.active) return this.status();
    this.active = true;
    this.paused = false;
    try {
      while (!this.paused) {
        const job = Object.values(this.state.jobs).find(candidate => candidate.state === 'queued');
        if (!job) break;
        await this.process(job.id);
      }
      return this.status();
    } finally {
      this.active = false;
      this.controller = undefined;
    }
  }

  async pause(): Promise<void> {
    this.paused = true;
    await this.ensureOpen();
    await this.commit(current => {
      const jobs = { ...current.jobs };
      for (const job of Object.values(jobs)) if (job.state === 'running' || job.state === 'queued') jobs[job.id] = { ...job, pauseRequested: true, state: job.state === 'queued' ? 'paused' : job.state };
      return { ...current, jobs };
    }, 'pause', 'batch');
  }

  async resume(): Promise<AutomationStatus> {
    await this.ensureOpen();
    this.paused = false;
    await this.commit(current => {
      const jobs = { ...current.jobs };
      for (const job of Object.values(jobs)) if (job.state === 'paused') jobs[job.id] = { ...job, state: 'queued', pauseRequested: false };
      return { ...current, jobs };
    }, 'resume', 'batch');
    return this.run();
  }

  async cancel(jobId?: string): Promise<void> {
    await this.ensureOpen();
    const ids = jobId ? [jobId] : Object.keys(this.state.jobs);
    await this.commit(current => {
      const jobs = { ...current.jobs };
      for (const id of ids) {
        const job = jobs[id];
        if (!job || ['done', 'failed', 'cancelled'].includes(job.state)) continue;
        jobs[id] = { ...job, state: 'cancelled', cancelRequested: true, pauseRequested: false };
      }
      return { ...current, jobs };
    }, 'cancel', jobId ?? 'batch');
    this.controller?.abort();
  }

  async retry(jobId?: string): Promise<string[]> {
    await this.ensureOpen();
    const ids = Object.values(this.state.jobs).filter(job => (!jobId || job.id === jobId) && job.state === 'failed').map(job => job.id);
    if (ids.length === 0) return [];
    await this.commit(current => {
      const jobs = { ...current.jobs };
      for (const id of ids) {
        const job = jobs[id]!;
        jobs[id] = { ...job, state: 'queued', stage: null, completedStages: [], error: null, cancelRequested: false, pauseRequested: false, reviews: job.reviews.map(review => ({ ...review, status: 'pending', decidedValue: undefined })) };
      }
      return { ...current, jobs };
    }, 'retry', ids.join(','));
    return ids;
  }

  async approve(jobId: string, fieldId: string, action: 'approve' | 'reject' | 'edit', value?: string): Promise<DurableReviewItem> {
    await this.ensureOpen();
    const job = this.requireJob(jobId);
    const review = job.reviews.find(item => (item.fieldId === fieldId || item.id === fieldId) && item.status === 'pending');
    if (!review) throw new AutomationRuntimeError('not-found', `pending review for ${jobId}/${fieldId} does not exist.`);
    const nextStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'edited';
    if (action === 'edit' && typeof value !== 'string') throw new AutomationRuntimeError('invalid-input', 'edit review requires a value.');
    const updated = { ...review, status: nextStatus, decidedValue: action === 'reject' ? null : action === 'edit' ? value!.trim() : review.value } as DurableReviewItem;
    await this.commit(current => {
      const currentJob = current.jobs[jobId]!;
      const reviews = currentJob.reviews.map(item => item.id === review.id ? updated : item);
      const unresolved = reviews.some(item => item.status === 'pending');
      return { ...current, jobs: { ...current.jobs, [jobId]: { ...currentJob, reviews, state: unresolved ? 'review' : 'queued', pauseRequested: false, error: null } } };
    }, 'review', jobId);
    return clone(updated);
  }

  audit(): string {
    return this.state?.audit ?? emptyState().audit;
  }

  status(): AutomationStatus {
    return {
      generation: this.state?.generation ?? 0,
      jobs: Object.values(this.state?.jobs ?? {}).map(job => ({
        id: job.id,
        sourcePath: job.sourcePath,
        state: job.state,
        stage: job.stage,
        completedStages: [...job.completedStages],
        attempt: job.attempt,
        error: job.error,
        reviews: clone(job.reviews),
        artifacts: clone(job.artifacts),
      })),
    };
  }

  getJob(jobId: string): DurableAutomationJob {
    return clone(this.requireJob(jobId));
  }

  async listVersions(documentId: string): Promise<readonly ImmutableVersion[]> {
    await this.ensureOpen();
    return this.versions.list(documentId);
  }

  async restoreVersion(documentId: string, versionId: string, destination: string): Promise<void> {
    assertAuthorizedPath(destination, this.authorizedRoots);
    await this.versions.restore(documentId, versionId, destination);
  }

  async compareVersions(documentId: string, beforeId: string, afterId: string) {
    await this.ensureOpen();
    return this.versions.compare(documentId, beforeId, afterId);
  }

  private async process(jobId: string): Promise<void> {
    let job = this.requireJob(jobId);
    this.controller = new AbortController();
    await this.commit(current => ({ ...current, jobs: { ...current.jobs, [jobId]: { ...current.jobs[jobId]!, state: 'running', attempt: current.jobs[jobId]!.attempt + 1, error: null, cancelRequested: false } } }), 'start', jobId);
    job = this.requireJob(jobId);
    try {
      for (const stage of AUTOMATION_STAGE_ORDER) {
        job = this.requireJob(jobId);
        if (job.completedStages.includes(stage)) continue;
        this.throwIfStopped(job);
        await this.runStage(job, stage, this.controller.signal);
        job = this.requireJob(jobId);
        if (job.pauseRequested || this.paused) {
          await this.commit(current => ({ ...current, jobs: { ...current.jobs, [jobId]: { ...current.jobs[jobId]!, state: 'paused' } } }), 'pause', jobId);
          return;
        }
        if (job.reviews.some(review => review.status === 'pending')) {
          await this.commit(current => ({ ...current, jobs: { ...current.jobs, [jobId]: { ...current.jobs[jobId]!, state: 'review' } } }), 'review', jobId);
          return;
        }
      }
      await this.commit(current => ({ ...current, jobs: { ...current.jobs, [jobId]: { ...current.jobs[jobId]!, state: 'done', stage: null } } }), 'done', jobId);
    } catch (error) {
      const current = this.requireJob(jobId);
      if (current.cancelRequested || this.controller.signal.aborted || error instanceof AutomationRuntimeError && error.code === 'cancelled') {
        await this.commit(state => ({ ...state, jobs: { ...state.jobs, [jobId]: { ...state.jobs[jobId]!, state: 'cancelled', stage: null } } }), 'cancel', jobId);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.commit(state => ({ ...state, jobs: { ...state.jobs, [jobId]: { ...state.jobs[jobId]!, state: 'failed', error: message, stage: null } } }), 'failure', jobId);
    }
  }

  private async runStage(job: DurableAutomationJob, stage: DurableAutomationStage, signal: AbortSignal): Promise<void> {
    await this.commit(current => ({ ...current, jobs: { ...current.jobs, [job.id]: { ...current.jobs[job.id]!, stage } } }), 'stage-start', job.id);
    let next = this.requireJob(job.id);
    if (stage === 'import') {
      const imported = await this.importPdf(next.sourcePath, { signal });
      if (imported.runtime.source.sha256 !== next.sourceSha256) throw new Error('source changed after enqueue; refusing a mixed-revision job.');
      this.throwIfStopped(this.requireJob(job.id));
      const sourceVersion = await this.versions.put({ id: `${next.id}-source-attempt-${next.attempt}`, documentId: imported.runtime.ir.documentId, sourceSha256: next.sourceSha256, parentId: null, stage: 'import', attempt: next.attempt, document: imported.runtime.ir });
      this.throwIfStopped(this.requireJob(job.id));
      await this.commit(current => ({ ...current, jobs: { ...current.jobs, [job.id]: { ...current.jobs[job.id]!, runtime: imported.runtime, document: imported.runtime.ir, versions: [...current.jobs[job.id]!.versions, sourceVersion], completedStages: [...current.jobs[job.id]!.completedStages, stage] } } }), stage, job.id);
      return;
    }
    if (stage === 'classify') {
      next = this.requireJob(job.id);
      if (!next.runtime) throw new Error('classify requires the imported runtime.');
      const lowConfidence = next.runtime.pageClassifications.filter(page => page.kind !== 'born-digital');
      const reviews = lowConfidence.length > 0 && !this.ocr
        ? [...next.reviews, { id: `review:${job.id}:ocr`, stage, reason: 'ocr' as const, confidence: 0, detail: `${lowConfidence.length} page(s) need an OCR adapter.`, status: 'pending' as const }]
        : next.reviews;
      await this.commit(current => ({ ...current, jobs: { ...current.jobs, [job.id]: { ...current.jobs[job.id]!, reviews, completedStages: [...current.jobs[job.id]!.completedStages, stage] } } }), stage, job.id);
      return;
    }
    if (stage === 'ocr') {
      next = this.requireJob(job.id);
      if (this.ocr && next.runtime) {
        const runtime = await this.ocr(next.runtime, signal);
        this.throwIfStopped(this.requireJob(job.id));
        await this.commit(current => ({ ...current, jobs: { ...current.jobs, [job.id]: { ...current.jobs[job.id]!, runtime, document: runtime.ir, completedStages: [...current.jobs[job.id]!.completedStages, stage] } } }), stage, job.id);
      } else {
        await this.commit(current => ({ ...current, jobs: { ...current.jobs, [job.id]: { ...current.jobs[job.id]!, completedStages: [...current.jobs[job.id]!.completedStages, stage] } } }), stage, job.id);
      }
      return;
    }
    if (stage === 'extract') {
      next = this.requireJob(job.id);
      const extraction = next.schema && next.document
        ? extractFields(next.document.blocks.map(block => ({ id: block.id, page: block.page, raw: block.raw, polygon: block.polygon, confidence: block.confidence })), next.schema)
        : null;
      const reviews = extraction ? [...next.reviews, ...reviewItems(job.id, extraction, this.reviewThreshold)] : next.reviews;
      const rulesResult = next.document ? evaluateRules({ document: next.document, extraction }, next.rules, next.overrides) : null;
      await this.commit(current => ({ ...current, jobs: { ...current.jobs, [job.id]: { ...current.jobs[job.id]!, extraction, rulesResult, reviews, completedStages: [...current.jobs[job.id]!.completedStages, stage] } } }), stage, job.id);
      return;
    }
    if (stage === 'translate') {
      next = this.requireJob(job.id);
      if (next.translateRequested) {
        if (!this.translate || !next.document) throw new Error('translation was requested but no local translation adapter was provided.');
        const document = await this.translate(next.document, signal);
        this.throwIfStopped(this.requireJob(job.id));
        await this.commit(current => ({ ...current, jobs: { ...current.jobs, [job.id]: { ...current.jobs[job.id]!, document, runtime: current.jobs[job.id]!.runtime ? { ...current.jobs[job.id]!.runtime!, ir: document } : null, completedStages: [...current.jobs[job.id]!.completedStages, stage] } } }), stage, job.id);
      } else {
        await this.commit(current => ({ ...current, jobs: { ...current.jobs, [job.id]: { ...current.jobs[job.id]!, completedStages: [...current.jobs[job.id]!.completedStages, stage] } } }), stage, job.id);
      }
      return;
    }
    next = this.requireJob(job.id);
    if (!next.document) throw new Error('export requires a document.');
    const versionId = `${next.id}-attempt-${next.attempt}-rev-${next.completedStages.length}`;
    const version = await this.versions.put({ id: versionId, documentId: next.document.documentId, sourceSha256: next.sourceSha256, parentId: next.versions.at(-1)?.id ?? null, stage, attempt: next.attempt, document: next.document });
    const result = { schemaVersion: 1, jobId: next.id, sourcePath: next.sourcePath, sourceSha256: next.sourceSha256, document: next.document, extraction: next.extraction, rules: next.rulesResult, reviews: next.reviews, version };
    this.throwIfStopped(this.requireJob(job.id));
    const resultArtifact = await writeArtifact(next.outputDir, `${next.id}.${versionId}.result.json`, JSON.stringify(result, null, 2));
    const report = renderReport(result);
    const reportArtifact = await writeArtifact(next.outputDir, `${next.id}.${versionId}.report.md`, report);
    await this.commit(current => ({ ...current, jobs: { ...current.jobs, [job.id]: { ...current.jobs[job.id]!, versions: [...current.jobs[job.id]!.versions, version], artifacts: [...current.jobs[job.id]!.artifacts, resultArtifact, reportArtifact], completedStages: [...current.jobs[job.id]!.completedStages, stage] } } }), stage, job.id);
  }

  private commit(mutator: (state: AutomationState) => AutomationState, action: string, jobId: string): Promise<void> {
    const operation = this.commitChain.then(async () => {
      try {
        this.state = await this.store.update(this.state.generation, current => {
          const next = mutator(current);
          const log = AuditLog.restore(current.audit, { now: this.now });
          log.append({ kind: action === 'review' ? 'review' : action === 'export' || action === 'done' ? 'export' : action === 'translate' ? 'translate' : action === 'import' ? 'import' : 'config', documentId: jobId, at: this.now(), actor: this.actor, details: { action } });
          return { ...next, audit: log.persist() };
        });
      } catch (error) {
        if (error instanceof GenerationConflictError) {
          this.state = await this.store.load();
          throw new AutomationRuntimeError('generation-conflict', error.message);
        }
        throw error;
      }
    });
    this.commitChain = operation.catch(() => undefined);
    return operation;
  }

  private async recoverInterruptedJobs(): Promise<void> {
    const interrupted = Object.values(this.state.jobs).filter(job => job.state === 'running').map(job => job.id);
    if (interrupted.length === 0) return;
    await this.commit(current => {
      const jobs = { ...current.jobs };
      for (const id of interrupted) jobs[id] = { ...jobs[id]!, state: 'queued', pauseRequested: false, cancelRequested: false, error: 'recovered after interrupted run' };
      return { ...current, jobs };
    }, 'recover', interrupted.join(','));
  }

  private requireJob(jobId: string): DurableAutomationJob {
    const job = this.state?.jobs[jobId];
    if (!job) throw new AutomationRuntimeError('not-found', `job ${jobId} does not exist.`);
    return job;
  }

  private async ensureOpen(): Promise<void> {
    if (!this.state) await this.open();
  }

  private throwIfStopped(job: DurableAutomationJob): void {
    if (job.cancelRequested || this.controller?.signal.aborted) throw new AutomationRuntimeError('cancelled', 'automation was cancelled.');
  }
}

function emptyState(): AutomationState {
  return { schemaVersion: AUTOMATION_STATE_SCHEMA_VERSION, generation: 0, jobs: {}, audit: JSON.stringify({ schemaVersion: 1, kind: 'mirror.audit', chain: [] }) };
}

function normalizeSchema(value: unknown): FieldSchema[] {
  const module = value as { fields?: unknown };
  const fields = Array.isArray(value) ? value : module && Array.isArray(module.fields) ? module.fields : null;
  if (!fields) throw new AutomationRuntimeError('invalid-input', 'schema must be an array or an object with fields.');
  return defineSchema(fields);
  return defineSchema(fields);
}

function reviewItems(jobId: string, extraction: FieldExtractionResult, threshold: number): DurableReviewItem[] {
  const items: DurableReviewItem[] = [];
  for (const field of extraction.fields) {
    const reasons = [
      ...(field.confidence < threshold ? ['low-confidence' as const] : []),
      ...(!field.valid ? ['invalid' as const] : []),
      ...(field.problems.some(problem => problem.startsWith('ambiguous:')) ? ['ambiguous' as const] : []),
    ];
    for (const reason of reasons) items.push({ id: `review:${jobId}:${field.id}:${reason}`, fieldId: field.id, stage: 'extract', reason, confidence: field.confidence, detail: field.problems.join(','), status: 'pending', value: field.value });
  }
  for (const missing of extraction.missing) items.push({ id: `review:${jobId}:${missing.id}:missing-required`, fieldId: missing.id, stage: 'extract', reason: 'missing-required', confidence: 0, detail: 'required-field-missing', status: 'pending' });
  return items;
}

async function writeArtifact(outputDir: string, name: string, content: string): Promise<DurableAutomationArtifact> {
  await mkdir(outputDir, { recursive: true });
  const path = join(outputDir, name);
  const bytes = new TextEncoder().encode(content);
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
  try {
    await rename(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    await rm(path, { force: true });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
  return { kind: name.endsWith('.md') ? 'report' : 'result', path, sha256: sha256Hex(bytes), byteLength: bytes.byteLength };
}

function renderReport(result: { jobId: string; sourcePath: string; sourceSha256: string; document: DocumentIR; extraction: FieldExtractionResult | null; rules: RuleEvaluation | null; reviews: readonly DurableReviewItem[]; version: ImmutableVersion }): string {
  const lines = [`# ${result.jobId}`, '', `- Source SHA-256: \`${result.sourceSha256}\``, `- Source path: \`${result.sourcePath}\``, `- Document revision: \`${result.document.revisionId}\``, `- Version: \`${result.version.id}\``, ''];
  if (result.rules) lines.push(`- Tags: ${result.rules.tags.join(', ') || 'none'}`, `- Classification: ${result.rules.classification ?? 'none'}`, '');
  lines.push('## Extracted fields', '');
  for (const field of result.extraction?.fields ?? []) lines.push(`- ${field.id}: ${field.value} (${Math.round(field.confidence * 100)}%, ${field.valid ? 'valid' : 'invalid'})`);
  for (const field of result.extraction?.missing ?? []) lines.push(`- ${field.id}: missing`);
  lines.push('', '## Review', '');
  for (const review of result.reviews) lines.push(`- ${review.id}: ${review.status} (${review.reason})`);
  return `${lines.join('\n')}\n`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
