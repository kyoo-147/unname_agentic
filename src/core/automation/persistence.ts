import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface VersionedState {
  schemaVersion: number;
  generation: number;
}

export class GenerationConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`state generation changed from ${expected} to ${actual}; reload before committing.`);
    this.name = 'GenerationConflictError';
  }
}

export interface AtomicJsonStoreOptions<T extends VersionedState> {
  readonly path: string;
  readonly initial: () => T;
  readonly staleLockMs?: number;
}

export class AtomicJsonStore<T extends VersionedState> {
  private readonly path: string;
  private readonly initial: () => T;
  private readonly staleLockMs: number;

  constructor(options: AtomicJsonStoreOptions<T>) {
    this.path = options.path;
    this.initial = options.initial;
    this.staleLockMs = options.staleLockMs ?? 30_000;
  }

  async load(): Promise<T> {
    try {
      return parseState<T>(await readFile(this.path, 'utf8'), this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const initial = clone(this.initial()) as T;
        await mkdir(dirname(this.path), { recursive: true });
        await writeAtomic(this.path, initial);
        return initial;
      }
      throw error;
    }
  }

  async update(expectedGeneration: number, mutate: (current: T) => T | Promise<T>): Promise<T> {
    return withLock(`${this.path}.lock`, this.staleLockMs, async () => {
      const current = await this.load();
      if (current.generation !== expectedGeneration) {
        throw new GenerationConflictError(expectedGeneration, current.generation);
      }
      const next = clone(await mutate(clone(current)));
      if (next.generation !== current.generation) {
        throw new Error('state mutators must not change generation directly.');
      }
      next.generation = current.generation + 1;
      await writeAtomic(this.path, next);
      return next;
    });
  }

  async replace(next: T): Promise<T> {
    return withLock(`${this.path}.lock`, this.staleLockMs, async () => {
      const current = await this.load();
      if (next.generation !== current.generation + 1) {
        throw new GenerationConflictError(current.generation + 1, next.generation);
      }
      const copy = clone(next);
      await writeAtomic(this.path, copy);
      return copy;
    });
  }
}

async function withLock<T>(lockPath: string, staleLockMs: number, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        if (age > staleLockMs) await rm(lockPath, { force: true });
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      }
      await delay(Math.min(25 + attempt, 250));
    }
  }
  if (!handle) throw new Error(`could not acquire state lock ${lockPath}.`);
  try {
    await handle.close();
    return await action();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error;
    await rm(path, { force: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseState<T extends VersionedState>(text: string, path: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`state file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || !Number.isInteger((value as VersionedState).schemaVersion) || !Number.isInteger((value as VersionedState).generation)) {
    throw new Error(`state file ${path} has no integer schemaVersion and generation.`);
  }
  return clone(value as T);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
