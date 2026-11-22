import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDocument } from '../viewer/src/core/ir';
import { AtomicJsonStore, GenerationConflictError } from '../viewer/src/core/automation/persistence';
import { scanFolder, UnauthorizedPathError } from '../viewer/src/core/automation/folder-watcher';
import { evaluateRules } from '../viewer/src/core/automation/rules';
import { ImmutableVersionStore } from '../viewer/src/core/automation/versions';

async function rootDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mirror-automation-infra-'));
}

describe('automation persistence and boundaries', () => {
  it('serializes competing generation updates instead of allowing a stale write', async () => {
    const root = await rootDir();
    const store = new AtomicJsonStore({ path: join(root, 'state.json'), initial: () => ({ schemaVersion: 1, generation: 0, value: 0 }) });
    const initial = await store.load();
    const results = await Promise.allSettled([
      store.update(initial.generation, state => ({ ...state, value: state.value + 1 })),
      store.update(initial.generation, state => ({ ...state, value: state.value + 1 })),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected' && result.reason instanceof GenerationConflictError)).toHaveLength(1);
  });

  it('scans only authorized PDF files and refuses an outside root', async () => {
    const root = await rootDir();
    await writeFile(join(root, 'a.pdf'), 'pdf');
    await writeFile(join(root, 'note.txt'), 'text');
    const result = await scanFolder(root, { authorizedRoots: [root], recursive: false });
    expect(Object.keys(result.snapshot)).toEqual(['a.pdf']);
    await expect(scanFolder(join(root, '..'), { authorizedRoots: [root] })).rejects.toBeInstanceOf(UnauthorizedPathError);
  });

  it('previews rule tags and classification without mutating the document', () => {
    const document = buildDocument({ sourceSha256: 'a'.repeat(64), blocks: [{ page: 1, text: 'Status: Paid', rect: { x: 0, y: 0, width: 100, height: 20 } }] });
    const result = evaluateRules({ document }, [{ id: 'paid', when: { operator: 'contains', value: 'paid' }, tags: ['settled'], classification: 'receipt' }]);
    expect(result.tags).toEqual(['settled']);
    expect(result.classification).toBe('receipt');
    expect(document.blocks[0]?.raw).toBe('Status: Paid');
  });

  it('stores immutable document versions and makes restore idempotent', async () => {
    const root = await rootDir();
    const store = new ImmutableVersionStore(root, () => '2026-01-01T00:00:00.000Z');
    const document = buildDocument({ sourceSha256: 'b'.repeat(64), blocks: [{ page: 1, text: 'one', rect: { x: 0, y: 0, width: 10, height: 10 } }] });
    const version = await store.put({ id: 'v1', documentId: document.documentId, sourceSha256: document.sourceSha256, parentId: null, stage: 'export', attempt: 1, document });
    const destination = join(root, 'restore');
    await store.restore(document.documentId, version.id, destination);
    await store.restore(document.documentId, version.id, destination);
    expect(store.list(document.documentId)).toHaveLength(1);
  });
});
