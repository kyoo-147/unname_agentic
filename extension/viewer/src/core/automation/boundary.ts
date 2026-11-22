import { assertAuthorizedPath, type AuthorizedFolderOptions, pollFolder } from './folder-watcher';
import { LocalAutomationRuntime, type EnqueueJobInput } from './runtime';

export type BoundaryPermission = 'read' | 'write' | 'review' | 'admin';

export interface AutomationPrincipal {
  readonly id: string;
  readonly permissions: readonly BoundaryPermission[];
}

export type BoundaryRequest =
  | { operation: 'capabilities' }
  | { operation: 'status' }
  | { operation: 'audit.read' }
  | { operation: 'enqueue'; input: EnqueueJobInput }
  | { operation: 'run' }
  | { operation: 'pause' }
  | { operation: 'resume' }
  | { operation: 'cancel'; jobId?: string }
  | { operation: 'retry'; jobId?: string }
  | { operation: 'review.list'; jobId: string }
  | { operation: 'review.approve'; jobId: string; fieldId: string; action: 'approve' | 'reject' | 'edit'; value?: string }
  | { operation: 'version.list'; documentId: string }
  | { operation: 'version.compare'; documentId: string; beforeId: string; afterId: string }
  | { operation: 'version.restore'; documentId: string; versionId: string; destination: string }
  | { operation: 'watch.poll'; root: string; previous?: Record<string, { size: number; mtimeMs: number }>; options: AuthorizedFolderOptions };

export interface BoundaryResponse<T = unknown> {
  readonly ok: true;
  readonly operation: BoundaryRequest['operation'];
  readonly data: T;
}

export class BoundaryError extends Error {
  constructor(readonly code: 'permission-denied' | 'rate-limited' | 'unsupported' | 'invalid-request', message: string) {
    super(message);
    this.name = 'BoundaryError';
  }
}

export interface LocalAutomationBoundaryOptions {
  readonly maxRequests?: number;
  readonly windowMs?: number;
  readonly authorizedRoots: readonly string[];
}

export class LocalAutomationBoundary {
  private readonly hits = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(private readonly runtime: LocalAutomationRuntime, private readonly options: LocalAutomationBoundaryOptions) {
    this.maxRequests = options.maxRequests ?? 60;
    this.windowMs = options.windowMs ?? 60_000;
    if (!Number.isInteger(this.maxRequests) || this.maxRequests < 1) throw new BoundaryError('invalid-request', 'maxRequests must be positive.');
    if (!Number.isInteger(this.windowMs) || this.windowMs < 1) throw new BoundaryError('invalid-request', 'windowMs must be positive.');
  }

  capabilities(): Record<string, unknown> {
    return {
      localOnly: true,
      cloudAccess: false,
      authorizedRoots: [...this.options.authorizedRoots],
      operations: ['capabilities', 'status', 'audit.read', 'enqueue', 'run', 'pause', 'resume', 'cancel', 'retry', 'review.list', 'review.approve', 'version.list', 'version.compare', 'version.restore', 'watch.poll'],
    };
  }

  async invoke(request: BoundaryRequest, principal: AutomationPrincipal = { id: 'local', permissions: ['read', 'write', 'review', 'admin'] }): Promise<BoundaryResponse> {
    this.checkRate(principal.id);
    const permission = requiredPermission(request.operation);
    if (permission !== null && !principal.permissions.includes(permission) && !principal.permissions.includes('admin')) throw new BoundaryError('permission-denied', `${principal.id} lacks ${permission} permission for ${request.operation}.`);
    if (request.operation === 'capabilities') return { ok: true, operation: request.operation, data: this.capabilities() };
    if (request.operation === 'status') return { ok: true, operation: request.operation, data: this.runtime.status() };
    if (request.operation === 'audit.read') return { ok: true, operation: request.operation, data: this.runtime.audit() };
    if (request.operation === 'enqueue') return { ok: true, operation: request.operation, data: await this.runtime.enqueue(request.input) };
    if (request.operation === 'run') return { ok: true, operation: request.operation, data: await this.runtime.run() };
    if (request.operation === 'pause') { await this.runtime.pause(); return { ok: true, operation: request.operation, data: this.runtime.status() }; }
    if (request.operation === 'resume') return { ok: true, operation: request.operation, data: await this.runtime.resume() };
    if (request.operation === 'cancel') { await this.runtime.cancel(request.jobId); return { ok: true, operation: request.operation, data: this.runtime.status() }; }
    if (request.operation === 'retry') return { ok: true, operation: request.operation, data: await this.runtime.retry(request.jobId) };
    if (request.operation === 'review.list') return { ok: true, operation: request.operation, data: this.runtime.getJob(request.jobId).reviews };
    if (request.operation === 'review.approve') return { ok: true, operation: request.operation, data: await this.runtime.approve(request.jobId, request.fieldId, request.action, request.value) };
    if (request.operation === 'version.list') return { ok: true, operation: request.operation, data: await this.runtime.listVersions(request.documentId) };
    if (request.operation === 'version.compare') return { ok: true, operation: request.operation, data: await this.runtime.compareVersions(request.documentId, request.beforeId, request.afterId) };
    if (request.operation === 'version.restore') { assertAuthorizedPath(request.destination, this.options.authorizedRoots); await this.runtime.restoreVersion(request.documentId, request.versionId, request.destination); return { ok: true, operation: request.operation, data: { restored: true } }; }
    if (request.operation === 'watch.poll') {
      const root = assertAuthorizedPath(request.root, this.options.authorizedRoots);
      const options = { ...request.options, authorizedRoots: this.options.authorizedRoots };
      return { ok: true, operation: request.operation, data: await pollFolder(root, request.previous, options) };
    }
    throw new BoundaryError('unsupported', `unsupported operation ${(request as BoundaryRequest).operation}.`);
  }

  private checkRate(principalId: string): void {
    const now = Date.now();
    const recent = (this.hits.get(principalId) ?? []).filter(timestamp => now - timestamp < this.windowMs);
    if (recent.length >= this.maxRequests) throw new BoundaryError('rate-limited', `rate limit exceeded for ${principalId}.`);
    recent.push(now);
    this.hits.set(principalId, recent);
  }
}

export function createLocalAutomationApi(runtime: LocalAutomationRuntime, options: LocalAutomationBoundaryOptions): LocalAutomationBoundary {
  return new LocalAutomationBoundary(runtime, options);
}

export function createLocalAutomationMcp(runtime: LocalAutomationRuntime, options: LocalAutomationBoundaryOptions): { tools: readonly { name: string; description: string }[]; invoke: LocalAutomationBoundary['invoke'] } {
  const boundary = new LocalAutomationBoundary(runtime, options);
  return { tools: boundary.capabilities().operations instanceof Array ? (boundary.capabilities().operations as string[]).map(name => ({ name, description: `Local-only document automation operation: ${name}.` })) : [], invoke: boundary.invoke.bind(boundary) };
}

function requiredPermission(operation: BoundaryRequest['operation']): BoundaryPermission | null {
  if (operation === 'capabilities' || operation === 'status' || operation === 'audit.read' || operation === 'review.list' || operation === 'version.list' || operation === 'version.compare' || operation === 'watch.poll') return 'read';
  if (operation === 'review.approve') return 'review';
  if (operation === 'version.restore' || operation === 'cancel' || operation === 'retry' || operation === 'pause' || operation === 'resume') return 'admin';
  return 'write';
}
