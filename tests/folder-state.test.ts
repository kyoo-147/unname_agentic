import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PersistentFolderWatcher } from '../src/core/automation/folder-state';

describe('persistent folder automation state', () => {
  it('persists a snapshot, coalesces the next poll, and reports modifications', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-folder-state-'));
    const input = join(root, 'input');
    const statePath = join(root, 'watch.json');
    await mkdir(input, { recursive: true });
    await writeFile(join(input, 'paper.pdf'), 'first');

    const watcher = new PersistentFolderWatcher(statePath, input, {
      authorizedRoots: [root],
      recursive: true,
      debounceMs: 0,
    });
    const first = await watcher.poll();
    expect(first.work.map(change => [change.kind, change.path])).toEqual([['added', 'paper.pdf']]);
    expect(JSON.parse(await readFile(statePath, 'utf8')).schemaVersion).toBe(1);

    const second = await watcher.poll();
    expect(second.work).toEqual([]);

    await writeFile(join(input, 'paper.pdf'), 'changed');
    const third = await watcher.poll();
    expect(third.work.map(change => [change.kind, change.path])).toEqual([['modified', 'paper.pdf']]);
  });
});
