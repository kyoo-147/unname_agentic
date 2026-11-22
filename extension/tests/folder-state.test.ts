import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PersistentFolderWatcher } from '../viewer/src/core/automation/folder-state';
import { LocalAutomationRuntime } from '../viewer/src/core/automation/runtime';

describe('persistent folder automation state', () => {
  it('does not persist a capped partial scan as a complete snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-folder-cap-'));
    const input = join(root, 'input');
    const statePath = join(root, 'watch.json');
    await mkdir(input, { recursive: true });
    await writeFile(join(input, 'a.pdf'), 'first');
    await writeFile(join(input, 'b.pdf'), 'second');
    const watcher = new PersistentFolderWatcher(statePath, input, { authorizedRoots: [root], recursive: true, maxFiles: 1 });

    const incomplete = await watcher.poll();
    expect(incomplete.complete).toBe(false);
    expect(incomplete.work).toEqual([]);
    expect(watcher.status().snapshot).toBeNull();
    expect(JSON.parse(await readFile(statePath, 'utf8')).snapshot).toBeNull();
  });

  it('rediscovers work when enqueue fails before the snapshot is acknowledged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-folder-recovery-'));
    const input = join(root, 'input');
    const statePath = join(root, 'watch.json');
    await mkdir(input, { recursive: true });
    await writeFile(join(input, 'paper-a.pdf'), 'first');
    await writeFile(join(input, 'paper-b.pdf'), 'second');
    const options = { authorizedRoots: [root], recursive: true, debounceMs: 0 };
    const firstWatcher = new PersistentFolderWatcher(statePath, input, options);
    const pending = await firstWatcher.poll({ persist: false });
    expect(pending.work.map(change => change.path)).toEqual(['paper-a.pdf', 'paper-b.pdf']);
    expect(firstWatcher.status().snapshot).toBeNull();

    const runtime = new LocalAutomationRuntime({ statePath: join(root, 'automation.json'), authorizedRoots: [root] });
    const output = join(root, 'output');
    const firstJob = await runtime.enqueue({ sourcePath: join(input, 'paper-a.pdf'), outputDir: output });
    await expect(runtime.enqueue({ sourcePath: join(input, 'paper-b.pdf'), outputDir: join(root, '..', 'outside') })).rejects.toMatchObject({ name: 'UnauthorizedPathError' });

    const restartedWatcher = new PersistentFolderWatcher(statePath, input, options);
    const recovered = await restartedWatcher.poll({ persist: false });
    expect(recovered.work.map(change => change.path)).toEqual(['paper-a.pdf', 'paper-b.pdf']);
    expect(restartedWatcher.status().snapshot).toBeNull();
    await expect(runtime.enqueue({ sourcePath: join(input, 'paper-a.pdf'), outputDir: output })).resolves.toMatchObject({ id: firstJob.id });
    await runtime.enqueue({ sourcePath: join(input, 'paper-b.pdf'), outputDir: output });
    await restartedWatcher.commit(recovered);
    expect(restartedWatcher.status().snapshot).toEqual({ 'paper-a.pdf': expect.any(Object), 'paper-b.pdf': expect.any(Object) });
  });

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
