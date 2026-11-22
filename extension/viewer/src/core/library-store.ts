/**
 * Persistent local PDF library (feature-plan item A17).
 *
 * One version-1 schema with three object stores: `documents` keeps the original
 * bytes, `meta` keeps the small summary rows the library screen can render
 * without cloning PDF bytes, and `thumbnails` keeps generated data URLs. `put`
 * rebuilds the record from the documented fields only, so credentials are never
 * persisted.
 */

export type LibraryStoreErrorCode = 'unavailable' | 'quota' | 'failed';

export class LibraryStoreError extends Error {
  readonly code: LibraryStoreErrorCode;

  constructor(code: LibraryStoreErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LibraryStoreError';
    this.code = code;
  }
}

export interface LibraryRecord {
  id: string;
  name: string;
  bytes: ArrayBuffer;
  size: number;
  addedAt: number;
  lastOpenedAt: number | null;
  pageCount: number | null;
}

export type LibrarySummary = Omit<LibraryRecord, 'bytes'>;

export interface LibraryStore {
  open(): Promise<void>;
  list(): Promise<LibrarySummary[]>;
  get(id: string): Promise<LibraryRecord | null>;
  put(record: LibraryRecord): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  putThumbnail(id: string, dataUrl: string): Promise<void>;
  getThumbnail(id: string): Promise<string | null>;
}

export interface LibraryStoreOptions {
  factory?: IDBFactory;
  dbName?: string;
}

export const LIBRARY_DB_NAME = 'mirror.library';
export const LIBRARY_SCHEMA_VERSION = 1;

const DOCUMENTS = 'documents';
const META = 'meta';
const THUMBNAILS = 'thumbnails';

export function createLibraryStore(options: LibraryStoreOptions = {}): LibraryStore {
  const providedFactory = options.factory;
  const dbName = options.dbName ?? LIBRARY_DB_NAME;
  let database: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase> | null = null;

  function requireFactory(): IDBFactory {
    const candidate = providedFactory ?? environmentFactory();
    if (!candidate || typeof candidate.open !== 'function') {
      throw new LibraryStoreError('unavailable', 'IndexedDB is not available in this environment.');
    }
    return candidate;
  }

  function upgrade(db: IDBDatabase): void {
    if (!db.objectStoreNames.contains(DOCUMENTS)) db.createObjectStore(DOCUMENTS, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(THUMBNAILS)) db.createObjectStore(THUMBNAILS, { keyPath: 'id' });
  }

  function openDatabase(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = requireFactory().open(dbName, LIBRARY_SCHEMA_VERSION);
      } catch (error) {
        reject(error instanceof LibraryStoreError ? error : new LibraryStoreError('unavailable', 'IndexedDB could not be opened.', { cause: error }));
        return;
      }
      request.onupgradeneeded = () => upgrade(request.result);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          if (database === db) database = null;
          try {
            db.close();
          } catch {
            // The connection was already closed by the browser.
          }
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new LibraryStoreError('failed', 'IndexedDB could not be opened.'));
    });
  }

  function connect(): Promise<IDBDatabase> {
    if (database) return Promise.resolve(database);
    if (opening) return opening;
    opening = openDatabase().then(
      db => {
        database = db;
        opening = null;
        return db;
      },
      (error: unknown) => {
        opening = null;
        throw toStoreError(error);
      },
    );
    return opening;
  }

  async function runTransaction<T>(
    names: string | readonly string[],
    mode: IDBTransactionMode,
    work: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const db = await connect();
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(names, mode);
    } catch (error) {
      throw toStoreError(error);
    }
    const completion = transactionCompletion(transaction);
    completion.catch(() => undefined);
    try {
      const result = await work(transaction);
      await completion;
      return result;
    } catch (error) {
      abortQuietly(transaction);
      throw toStoreError(error);
    }
  }

  async function open(): Promise<void> {
    await connect();
  }

  async function list(): Promise<LibrarySummary[]> {
    const summaries = await runTransaction(META, 'readonly', async transaction => {
      const rows: unknown[] = await requestValue(transaction.objectStore(META).getAll());
      return rows.map(toSummary).filter((row): row is LibrarySummary => row !== null);
    });
    return summaries.sort(compareSummaries);
  }

  async function get(id: string): Promise<LibraryRecord | null> {
    requireId(id);
    return runTransaction(DOCUMENTS, 'readonly', async transaction => {
      const row: unknown = await requestValue(transaction.objectStore(DOCUMENTS).get(id));
      return toRecord(row);
    });
  }

  async function put(input: LibraryRecord): Promise<void> {
    const record = normalizeForWrite(input);
    await runTransaction([DOCUMENTS, META], 'readwrite', async transaction => {
      await Promise.all([
        requestValue(transaction.objectStore(DOCUMENTS).put(record)),
        requestValue(transaction.objectStore(META).put(summarize(record))),
      ]);
    });
  }

  async function remove(id: string): Promise<void> {
    requireId(id);
    await runTransaction([DOCUMENTS, META, THUMBNAILS], 'readwrite', async transaction => {
      await Promise.all([
        requestValue(transaction.objectStore(DOCUMENTS).delete(id)),
        requestValue(transaction.objectStore(META).delete(id)),
        requestValue(transaction.objectStore(THUMBNAILS).delete(id)),
      ]);
    });
  }

  async function clear(): Promise<void> {
    await runTransaction([DOCUMENTS, META, THUMBNAILS], 'readwrite', async transaction => {
      await Promise.all([
        requestValue(transaction.objectStore(DOCUMENTS).clear()),
        requestValue(transaction.objectStore(META).clear()),
        requestValue(transaction.objectStore(THUMBNAILS).clear()),
      ]);
    });
  }

  async function putThumbnail(id: string, dataUrl: string): Promise<void> {
    requireId(id);
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      throw new LibraryStoreError('failed', 'A library thumbnail must be an image data URL.');
    }
    await runTransaction(THUMBNAILS, 'readwrite', async transaction => {
      await requestValue(transaction.objectStore(THUMBNAILS).put({ id, dataUrl }));
    });
  }

  async function getThumbnail(id: string): Promise<string | null> {
    requireId(id);
    return runTransaction(THUMBNAILS, 'readonly', async transaction => {
      const row: unknown = await requestValue(transaction.objectStore(THUMBNAILS).get(id));
      if (typeof row !== 'object' || row === null) return null;
      const dataUrl = (row as { dataUrl?: unknown }).dataUrl;
      return typeof dataUrl === 'string' ? dataUrl : null;
    });
  }

  return { open, list, get, put, remove, clear, putThumbnail, getThumbnail };
}

function environmentFactory(): IDBFactory | undefined {
  try {
    return (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  } catch {
    return undefined;
  }
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new LibraryStoreError('failed', 'An IndexedDB request failed.'));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new LibraryStoreError('failed', 'The library transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new LibraryStoreError('failed', 'The library transaction was aborted.'));
  });
}

function abortQuietly(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // The transaction already completed or aborted.
  }
}

function errorName(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : '';
}

function errorCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

function toStoreError(error: unknown): LibraryStoreError {
  if (error instanceof LibraryStoreError) return error;
  const name = errorName(error);
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || errorCode(error) === 22) {
    return new LibraryStoreError('quota', 'The browser storage quota was exceeded.', { cause: error });
  }
  const detail = error instanceof Error && error.message ? error.message : 'The library operation failed.';
  return new LibraryStoreError('failed', detail, { cause: error });
}

function requireId(id: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new LibraryStoreError('failed', 'A library record needs a non-empty id.');
  }
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pageCountOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function normalizeForWrite(input: unknown): LibraryRecord {
  if (typeof input !== 'object' || input === null) {
    throw new LibraryStoreError('failed', 'A library record is required.');
  }
  const value = input as Partial<Record<keyof LibraryRecord, unknown>>;
  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new LibraryStoreError('failed', 'A library record needs a non-empty id.');
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    throw new LibraryStoreError('failed', 'A library record needs a non-empty name.');
  }
  const bytes = value.bytes;
  if (!(bytes instanceof ArrayBuffer)) {
    throw new LibraryStoreError('failed', 'A library record needs the PDF bytes as an ArrayBuffer.');
  }
  return {
    id: value.id,
    name: value.name,
    bytes,
    size: Math.max(0, finiteOr(value.size, bytes.byteLength)),
    addedAt: finiteOr(value.addedAt, Date.now()),
    lastOpenedAt: finiteOrNull(value.lastOpenedAt),
    pageCount: pageCountOrNull(value.pageCount),
  };
}

function summarize(record: LibraryRecord): LibrarySummary {
  return {
    id: record.id,
    name: record.name,
    size: record.size,
    addedAt: record.addedAt,
    lastOpenedAt: record.lastOpenedAt,
    pageCount: record.pageCount,
  };
}

function toSummary(row: unknown): LibrarySummary | null {
  if (typeof row !== 'object' || row === null) return null;
  const value = row as Partial<Record<keyof LibrarySummary, unknown>>;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.name !== 'string') return null;
  return {
    id: value.id,
    name: value.name,
    size: finiteOr(value.size, 0),
    addedAt: finiteOr(value.addedAt, 0),
    lastOpenedAt: finiteOrNull(value.lastOpenedAt),
    pageCount: pageCountOrNull(value.pageCount),
  };
}

function toRecord(row: unknown): LibraryRecord | null {
  if (typeof row !== 'object' || row === null) return null;
  const value = row as Partial<Record<keyof LibraryRecord, unknown>>;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.name !== 'string') return null;
  const bytes = value.bytes;
  if (!(bytes instanceof ArrayBuffer)) return null;
  return {
    id: value.id,
    name: value.name,
    bytes,
    size: finiteOr(value.size, bytes.byteLength),
    addedAt: finiteOr(value.addedAt, 0),
    lastOpenedAt: finiteOrNull(value.lastOpenedAt),
    pageCount: pageCountOrNull(value.pageCount),
  };
}

function openedRank(row: LibrarySummary): number {
  return row.lastOpenedAt === null ? Number.NEGATIVE_INFINITY : row.lastOpenedAt;
}

function compareSummaries(left: LibrarySummary, right: LibrarySummary): number {
  const leftOpened = openedRank(left);
  const rightOpened = openedRank(right);
  if (leftOpened !== rightOpened) return rightOpened - leftOpened;
  if (left.addedAt !== right.addedAt) return right.addedAt - left.addedAt;
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}
