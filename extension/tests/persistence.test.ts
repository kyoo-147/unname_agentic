import { mkdtemp, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AtomicJsonStore } from '../viewer/src/core/automation/persistence';

describe('atomic JSON persistence', () => {
  it('preserves the prior state when replacing the file fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-persistence-'));
    const path = join(root, 'state.json');
    let failReplacement = false;
    const store = new AtomicJsonStore({
      path,
      initial: () => ({ schemaVersion: 1, generation: 0, value: 'original' }),
      replaceFile: async (temporary, destination) => {
        if (failReplacement) throw new Error('replacement denied');
        await rename(temporary, destination);
      },
    });

    await store.load();
    failReplacement = true;
    await expect(store.update(0, state => ({ ...state, value: 'replacement' }))).rejects.toThrow('replacement denied');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ generation: 0, value: 'original' });
    expect(await store.load()).toMatchObject({ generation: 0, value: 'original' });
  });
});
