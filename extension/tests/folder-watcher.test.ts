import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FolderWatcher } from '../viewer/src/core/automation/folder-watcher';

describe('folder watcher filesystem boundary', () => {
  it('does not advance an in-memory snapshot after a capped partial scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-folder-watcher-'));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'a.pdf'), 'a');
    await writeFile(join(root, 'b.pdf'), 'b');
    const watcher = new FolderWatcher(root, { authorizedRoots: [root], recursive: false, maxFiles: 1, debounceMs: 0 });

    const incomplete = await watcher.poll();
    expect(incomplete.complete).toBe(false);
    expect(incomplete.work).toEqual([]);
    await rm(join(root, 'b.pdf'));

    const complete = await watcher.poll();
    expect(complete.complete).toBe(true);
    expect(complete.work.map(change => [change.kind, change.path])).toEqual([['added', 'a.pdf']]);
  });
});
