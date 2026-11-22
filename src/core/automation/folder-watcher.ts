import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { coalesce, diffSnapshot, planWatch, shouldProcess, type CoalescedChange, type FileSnapshot, type WatchOptions } from '../watcher';

export interface AuthorizedFolderOptions extends WatchOptions {
  readonly authorizedRoots: readonly string[];
  readonly recursive?: boolean;
  readonly debounceMs?: number;
  /** Refuse large files before they become jobs. */
  readonly maxFileBytes?: number;
  /** Optional delay used to reject files that are still changing. */
  readonly stableForMs?: number;
}

export interface FolderPoll {
  readonly root: string;
  readonly snapshot: FileSnapshot;
  readonly work: readonly CoalescedChange[];
  readonly rejected: readonly string[];
}

export class UnauthorizedPathError extends Error {
  constructor(readonly path: string) {
    super(`path is outside the authorized automation folders: ${path}`);
    this.name = 'UnauthorizedPathError';
  }
}

export function assertAuthorizedPath(path: string, authorizedRoots: readonly string[]): string {
  if (!Array.isArray(authorizedRoots) || authorizedRoots.length === 0) throw new UnauthorizedPathError(path);
  const candidate = resolve(path);
  const allowed = authorizedRoots.some(root => {
    const base = resolve(root);
    const rest = relative(base, candidate);
    return rest === '' || (rest !== '..' && !rest.startsWith(`..${relative('', '')}`) && !isAbsolute(rest));
  });
  if (!allowed) throw new UnauthorizedPathError(path);
  return candidate;
}

export async function scanFolder(root: string, options: AuthorizedFolderOptions): Promise<{ snapshot: FileSnapshot; rejected: string[] }> {
  const directory = assertAuthorizedPath(await realpath(assertAuthorizedPath(root, options.authorizedRoots)), options.authorizedRoots);
  const plan = planWatch(options);
  const snapshot: Record<string, { size: number; mtimeMs: number }> = {};
  const rejected: string[] = [];
  const maxFileBytes = options.maxFileBytes ?? 256 * 1024 * 1024;
  const pending = [directory];
  while (pending.length > 0 && Object.keys(snapshot).length < plan.maxFiles) {
    const current = pending.shift()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      rejected.push(current);
      continue;
    }
    for (const entry of entries) {
      if (Object.keys(snapshot).length >= plan.maxFiles) break;
      const full = join(current, entry.name);
      const relativePath = relative(directory, full).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (options.recursive !== false && shouldProcess(`${relativePath}/placeholder.pdf`, { ...plan, include: [] })) pending.push(full);
        continue;
      }
      if (!entry.isFile() || !shouldProcess(relativePath, plan)) continue;
      try {
        const details = await stat(full);
        if ((options.stableForMs ?? 0) > 0) {
          await delay(options.stableForMs!);
          const afterDelay = await stat(full);
          if (afterDelay.size !== details.size || afterDelay.mtimeMs !== details.mtimeMs) {
            rejected.push(full);
            continue;
          }
        }
        if (details.size > maxFileBytes) {
          rejected.push(full);
          continue;
        }
        snapshot[relativePath] = { size: details.size, mtimeMs: details.mtimeMs };
      } catch {
        rejected.push(full);
      }
    }
  }
  return { snapshot, rejected };
}

export async function pollFolder(root: string, previous: FileSnapshot | null | undefined, options: AuthorizedFolderOptions): Promise<FolderPoll> {
  const directory = assertAuthorizedPath(root, options.authorizedRoots);
  const plan = planWatch(options);
  const current = await scanFolder(directory, options);
  const diff = diffSnapshot(previous, current.snapshot);
  const changes = [
    ...diff.added.map(entry => ({ path: entry.path, kind: 'added' as const, at: entry.mtimeMs })),
    ...diff.modified.map(entry => ({ path: entry.path, kind: 'modified' as const, at: entry.mtimeMs })),
    ...diff.removed.map(entry => ({ path: entry.path, kind: 'removed' as const, at: entry.mtimeMs })),
  ];
  return { root: directory, snapshot: current.snapshot, work: coalesce(changes, { debounceMs: options.debounceMs ?? 250 }), rejected: current.rejected };
}

export interface FolderWatcherOptions extends AuthorizedFolderOptions {
  readonly intervalMs?: number;
}

export class FolderWatcher {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private snapshot: FileSnapshot | null = null;

  constructor(private readonly root: string, private readonly options: FolderWatcherOptions) {}

  async poll(): Promise<FolderPoll> {
    const result = await pollFolder(this.root, this.snapshot, this.options);
    this.snapshot = result.snapshot;
    return result;
  }

  start(onPoll: (poll: FolderPoll) => void | Promise<void>): void {
    this.stopped = false;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      await onPoll(await this.poll());
      if (!this.stopped) this.timer = setTimeout(() => { void tick(); }, planWatch(this.options).intervalMs);
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, Math.max(0, ms)));
}
