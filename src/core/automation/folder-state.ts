import { resolve } from 'node:path';
import { AtomicJsonStore, type VersionedState } from './persistence';
import {
  assertAuthorizedPath,
  pollFolder,
  type FolderPoll,
  type FolderWatcherOptions,
} from './folder-watcher';
import type { FileSnapshot } from '../watcher';

export const FOLDER_AUTOMATION_STATE_SCHEMA_VERSION = 1;

export interface FolderAutomationState extends VersionedState {
  readonly schemaVersion: typeof FOLDER_AUTOMATION_STATE_SCHEMA_VERSION;
  readonly root: string;
  readonly snapshot: FileSnapshot | null;
  readonly lastPollAt: string | null;
  readonly rejected: readonly string[];
}

/**
 * Crash-safe watcher state. A poll commits the complete snapshot only after
 * scanning, so a process interrupted during a scan keeps the previous view and
 * will discover the change on the next run.
 */
export class PersistentFolderWatcher {
  private readonly store: AtomicJsonStore<FolderAutomationState>;
  private state!: FolderAutomationState;
  private readonly root: string;
  private readonly now: () => string;

  constructor(
    statePath: string,
    root: string,
    private readonly options: FolderWatcherOptions,
    now: () => string = () => new Date().toISOString(),
  ) {
    this.root = assertAuthorizedPath(root, options.authorizedRoots);
    const safeStatePath = assertAuthorizedPath(resolve(statePath), options.authorizedRoots);
    this.now = now;
    this.store = new AtomicJsonStore({
      path: safeStatePath,
      initial: () => ({
        schemaVersion: FOLDER_AUTOMATION_STATE_SCHEMA_VERSION,
        generation: 0,
        root: this.root,
        snapshot: null,
        lastPollAt: null,
        rejected: [],
      }),
    });
  }

  async open(): Promise<void> {
    this.state = await this.store.load();
    if (this.state.root !== this.root) {
      throw new Error(`watch state belongs to ${this.state.root}, not ${this.root}.`);
    }
  }

  async poll(): Promise<FolderPoll> {
    if (!this.state) await this.open();
    const result = await pollFolder(this.root, this.state.snapshot, this.options);
    this.state = await this.store.update(this.state.generation, current => ({
      ...current,
      root: this.root,
      snapshot: result.snapshot,
      lastPollAt: this.now(),
      rejected: [...result.rejected],
    }));
    return result;
  }

  snapshot(): FileSnapshot | null {
    return this.state?.snapshot ?? null;
  }

  status(): FolderAutomationState {
    if (!this.state) throw new Error('persistent folder watcher is not open.');
    return {
      ...this.state,
      snapshot: this.state.snapshot ? { ...this.state.snapshot } : null,
      rejected: [...this.state.rejected],
    };
  }
}
