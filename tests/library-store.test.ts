import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLibraryStore, LIBRARY_DB_NAME, LibraryStoreError, type LibraryRecord } from '../src/core/library-store';

type Handler = (() => void) | null;

interface SettleableRequest {
  error: Error | null;
  onerror: Handler;
}

class FakeRequest<T> {
  result: T | undefined;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
}

class FakeOpenRequest extends FakeRequest<FakeConnection> {
  onupgradeneeded: Handler = null;
}

class FakeStore {
  readonly rows = new Map<string, unknown>();
}

class FakeDatabase {
  version = 0;
  readonly stores = new Map<string, FakeStore>();
}

class FakeObjectStore {
  constructor(private readonly transaction: FakeTransaction, private readonly store: FakeStore, private readonly factory: FakeFactory) {}

  get(key: string): FakeRequest<unknown> {
    return this.transaction.request(() => this.store.rows.get(key));
  }

  getAll(): FakeRequest<unknown[]> {
    return this.transaction.request(() => [...this.store.rows.values()]);
  }

  put(value: unknown): FakeRequest<string> {
    return this.transaction.request(() => {
      if (this.factory.quotaOnPut) throw quotaError();
      const key = keyOf(value);
      this.store.rows.set(key, cloneValue(value));
      return key;
    });
  }

  delete(key: string): FakeRequest<undefined> {
    return this.transaction.request(() => {
      this.store.rows.delete(key);
      return undefined;
    });
  }

  clear(): FakeRequest<undefined> {
    return this.transaction.request(() => {
      this.store.rows.clear();
      return undefined;
    });
  }
}

class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  error: Error | null = null;
  private pending = 0;
  private settled = false;
  private readonly outstanding = new Set<SettleableRequest>();

  constructor(
    private readonly factory: FakeFactory,
    private readonly database: FakeDatabase,
    private readonly names: readonly string[],
  ) {}

  objectStore(name: string): FakeObjectStore {
    const store = this.database.stores.get(name);
    if (!store || !this.names.includes(name)) throw new Error(`NotFoundError: ${name}`);
    return new FakeObjectStore(this, store, this.factory);
  }

  request<T>(operation: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.pending += 1;
    this.outstanding.add(request);
    queueMicrotask(() => {
      if (this.settled) return;
      try {
        request.result = operation();
        this.pending -= 1;
        this.outstanding.delete(request);
        request.onsuccess?.();
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        request.error = error;
        this.pending -= 1;
        this.outstanding.delete(request);
        request.onerror?.();
        this.fail(error);
        return;
      }
      if (this.pending === 0) queueMicrotask(() => this.complete());
    });
    return request;
  }

  abort(): void {
    this.fail(this.error ?? new Error('AbortError: the transaction was aborted.'));
  }

  private complete(): void {
    if (this.settled) return;
    this.settled = true;
    this.oncomplete?.();
  }

  private fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.error = error;
    for (const request of this.outstanding) {
      request.error = error;
      request.onerror?.();
    }
    this.outstanding.clear();
    this.onerror?.();
    this.onabort?.();
  }
}

class FakeConnection {
  closed = false;
  onversionchange: Handler = null;

  constructor(private readonly factory: FakeFactory, private readonly database: FakeDatabase) {}

  get objectStoreNames(): { contains(name: string): boolean } {
    return { contains: (name: string) => this.database.stores.has(name) };
  }

  createObjectStore(name: string): void {
    if (this.database.stores.has(name)) throw new Error(`ConstraintError: ${name} already exists.`);
    this.database.stores.set(name, new FakeStore());
  }

  transaction(names: string | string[]): FakeTransaction {
    if (this.closed) throw new Error('InvalidStateError: the database connection is closed.');
    const list = Array.isArray(names) ? names : [names];
    for (const name of list) {
      if (!this.database.stores.has(name)) throw new Error(`NotFoundError: ${name}`);
    }
    return new FakeTransaction(this.factory, this.database, list);
  }

  close(): void {
    this.closed = true;
  }
}

class FakeFactory {
  readonly opens: string[] = [];
  readonly databases = new Map<string, FakeDatabase>();
  readonly connections = new Map<string, FakeConnection>();
  quotaOnPut = false;

  open(name: string, version = 1): FakeOpenRequest {
    this.opens.push(name);
    const request = new FakeOpenRequest();
    queueMicrotask(() => {
      const existing = this.databases.get(name);
      const database = existing ?? new FakeDatabase();
      if (!existing) this.databases.set(name, database);
      const migration = existing === undefined || version > database.version;
      database.version = Math.max(version, database.version);
      const connection = new FakeConnection(this, database);
      request.result = connection;
      if (migration) request.onupgradeneeded?.();
      this.connections.set(name, connection);
      request.onsuccess?.();
    });
    return request;
  }

  triggerVersionChange(name: string): void {
    this.connections.get(name)?.onversionchange?.();
  }

  rows(dbName: string, storeName: string): readonly unknown[] {
    return [...(this.databases.get(dbName)?.stores.get(storeName)?.rows.values() ?? [])];
  }
}

function quotaError(): Error {
  const error = new Error('The browser storage quota was exceeded.');
  error.name = 'QuotaExceededError';
  return error;
}

function keyOf(value: unknown): string {
  const key = typeof value === 'object' && value !== null ? (value as { id?: unknown }).id : undefined;
  if (typeof key !== 'string') throw new Error('DataError: the record has no string id.');
  return key;
}

function cloneValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (Array.isArray(value)) return value.map(cloneValue);
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = cloneValue(entry);
    return copy;
  }
  return value;
}

function bytesOf(...values: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(values.length);
  new Uint8Array(buffer).set(values);
  return buffer;
}

function sample(overrides: Partial<LibraryRecord> = {}): LibraryRecord {
  return {
    id: 'doc-a',
    name: 'alice.pdf',
    bytes: bytesOf(1, 2, 3, 4),
    size: 4,
    addedAt: 1_000,
    lastOpenedAt: null,
    pageCount: 12,
    ...overrides,
  };
}

function fakeStore(factory = new FakeFactory()) {
  return { factory, store: createLibraryStore({ factory: factory as unknown as IDBFactory }) };
}

describe('library persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips binary PDF bytes through the document store', async () => {
    const { store } = fakeStore();
    await store.put(sample());

    const loaded = await store.get('doc-a');
    expect(loaded).toMatchObject({ id: 'doc-a', name: 'alice.pdf', size: 4, pageCount: 12, lastOpenedAt: null });
    expect(loaded?.bytes).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(loaded!.bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('lists summaries without cloning or exposing PDF bytes', async () => {
    const { factory, store } = fakeStore();
    await store.put(sample());

    const [summary] = await store.list();
    expect(summary).toBeDefined();
    expect(Object.keys(summary!).sort()).toEqual(['addedAt', 'id', 'lastOpenedAt', 'name', 'pageCount', 'size']);
    expect(summary).not.toHaveProperty('bytes');
    expect(factory.rows(LIBRARY_DB_NAME, 'documents')[0]).toHaveProperty('bytes');
  });

  it('sorts by last opened descending, then added descending, then name', async () => {
    const { store } = fakeStore();
    await store.put(sample({ id: 'a', name: 'a.pdf', addedAt: 10, lastOpenedAt: 300 }));
    await store.put(sample({ id: 'b', name: 'b.pdf', addedAt: 900, lastOpenedAt: null }));
    await store.put(sample({ id: 'c', name: 'c.pdf', addedAt: 20, lastOpenedAt: 500 }));
    await store.put(sample({ id: 'd', name: 'd.pdf', addedAt: 800, lastOpenedAt: null }));
    await store.put(sample({ id: 'e', name: 'e.pdf', addedAt: 950, lastOpenedAt: null }));

    const order = (await store.list()).map(row => row.id);
    expect(order).toEqual(['c', 'a', 'e', 'b', 'd']);
  });

  it('removes a document together with its summary and thumbnail', async () => {
    const { factory, store } = fakeStore();
    await store.put(sample({ id: 'a', name: 'a.pdf' }));
    await store.put(sample({ id: 'b', name: 'b.pdf' }));
    await store.putThumbnail('a', 'data:image/jpeg;base64,AAA');

    await store.remove('a');

    expect((await store.list()).map(row => row.id)).toEqual(['b']);
    expect(await store.get('a')).toBeNull();
    expect(await store.getThumbnail('a')).toBeNull();
    expect(factory.rows(LIBRARY_DB_NAME, 'documents')).toHaveLength(1);
    expect(factory.rows(LIBRARY_DB_NAME, 'meta')).toHaveLength(1);
  });

  it('clears documents, summaries and thumbnails', async () => {
    const { factory, store } = fakeStore();
    await store.put(sample());
    await store.putThumbnail('doc-a', 'data:image/png;base64,AAA');

    await store.clear();

    expect(await store.list()).toEqual([]);
    expect(await store.get('doc-a')).toBeNull();
    expect(await store.getThumbnail('doc-a')).toBeNull();
    expect(factory.rows(LIBRARY_DB_NAME, 'documents')).toHaveLength(0);
    expect(factory.rows(LIBRARY_DB_NAME, 'thumbnails')).toHaveLength(0);
  });

  it('round-trips thumbnails and rejects non data URLs', async () => {
    const { store } = fakeStore();
    expect(await store.getThumbnail('doc-a')).toBeNull();

    await store.putThumbnail('doc-a', 'data:image/jpeg;base64,QUJD');
    expect(await store.getThumbnail('doc-a')).toBe('data:image/jpeg;base64,QUJD');

    await expect(store.putThumbnail('doc-a', 'https://example.test/thumb.png')).rejects.toMatchObject({ code: 'failed' });
  });

  it('opens IndexedDB once for concurrent callers', async () => {
    const { factory, store } = fakeStore();
    await Promise.all([store.open(), store.open()]);
    expect(factory.opens).toHaveLength(1);
  });

  it('closes the connection on versionchange and reopens on the next call', async () => {
    const { factory, store } = fakeStore();
    await store.put(sample());
    expect(await store.list()).toHaveLength(1);
    expect(factory.opens).toHaveLength(1);

    factory.triggerVersionChange(LIBRARY_DB_NAME);
    expect(factory.connections.get(LIBRARY_DB_NAME)?.closed).toBe(true);

    expect(await store.list()).toHaveLength(1);
    expect(factory.opens).toHaveLength(2);
  });

  it('stores only the documented fields so credentials never reach disk', async () => {
    const { factory, store } = fakeStore();
    await store.put({ ...sample(), apiKey: 'sk-do-not-store' } as LibraryRecord);

    const [row] = factory.rows(LIBRARY_DB_NAME, 'documents');
    expect(Object.keys(row as Record<string, unknown>).sort()).toEqual(['addedAt', 'bytes', 'id', 'lastOpenedAt', 'name', 'pageCount', 'size']);
    expect(JSON.stringify(factory.rows(LIBRARY_DB_NAME, 'documents'))).not.toContain('sk-do-not-store');
    expect(await store.get('doc-a')).not.toHaveProperty('apiKey');
  });

  it('reports a missing IndexedDB as a typed unavailable error', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const failure: unknown = await createLibraryStore().list().catch(error => error);

    expect(failure).toBeInstanceOf(LibraryStoreError);
    expect(failure).toMatchObject({ code: 'unavailable' });
  });

  it('maps a factory that cannot open to unavailable', async () => {
    const refusing = {
      open() {
        throw new Error('SecurityError: IndexedDB is blocked by the browser.');
      },
    } as unknown as IDBFactory;
    const failure: unknown = await createLibraryStore({ factory: refusing }).open().catch(error => error);

    expect(failure).toBeInstanceOf(LibraryStoreError);
    expect(failure).toMatchObject({ code: 'unavailable' });
  });

  it('maps quota failures to the quota code', async () => {
    const { factory, store } = fakeStore();
    factory.quotaOnPut = true;
    const failure: unknown = await store.put(sample()).catch(error => error);

    expect(failure).toBeInstanceOf(LibraryStoreError);
    expect(failure).toMatchObject({ code: 'quota' });
    expect(await store.list()).toEqual([]);
  });
});
