import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { diffDocuments, type DocumentDiff } from '../diff';
import { serialize, type DocumentIR } from '../ir';
import { AtomicJsonStore, type VersionedState } from './persistence';

export interface ImmutableVersion {
  readonly id: string;
  readonly documentId: string;
  readonly sourceSha256: string;
  readonly parentId: string | null;
  readonly stage: string;
  readonly attempt: number;
  readonly documentPath: string;
  readonly createdAt: string;
}

interface VersionState extends VersionedState {
  readonly schemaVersion: 1;
  versions: Record<string, ImmutableVersion[]>;
}

export class ImmutableVersionStore {
  private readonly state: AtomicJsonStore<VersionState>;
  private current!: VersionState;

  constructor(private readonly root: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.state = new AtomicJsonStore({ path: join(root, 'versions.json'), initial: () => ({ schemaVersion: 1, generation: 0, versions: {} }) });
  }

  async open(): Promise<void> {
    this.current = await this.state.load();
    await mkdir(join(this.root, 'documents'), { recursive: true });
  }

  async put(input: Omit<ImmutableVersion, 'documentPath' | 'createdAt'> & { document: DocumentIR }): Promise<ImmutableVersion> {
    await this.ensureOpen();
    const documentPath = join('documents', `${safe(input.id)}.json`);
    const absolute = join(this.root, documentPath);
    try {
      await readFile(absolute, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(absolute, `${serialize(input.document)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
    const version: ImmutableVersion = { ...input, documentPath, createdAt: this.now() };
    const next = await this.state.update(this.current.generation, current => ({
      ...current,
      versions: { ...current.versions, [input.documentId]: [...(current.versions[input.documentId] ?? []), version] },
    }));
    this.current = next;
    return version;
  }

  list(documentId: string): readonly ImmutableVersion[] {
    return [...(this.current?.versions[documentId] ?? [])];
  }

  async read(documentId: string, versionId: string): Promise<DocumentIR> {
    await this.ensureOpen();
    const version = this.list(documentId).find(candidate => candidate.id === versionId);
    if (!version) throw new Error(`version ${documentId}/${versionId} does not exist.`);
    return JSON.parse(await readFile(join(this.root, version.documentPath), 'utf8')) as DocumentIR;
  }

  async compare(documentId: string, beforeId: string, afterId: string): Promise<DocumentDiff> {
    return diffDocuments(await this.read(documentId, beforeId), await this.read(documentId, afterId));
  }

  async restore(documentId: string, versionId: string, destination: string): Promise<void> {
    const document = await this.read(documentId, versionId);
    await mkdir(destination, { recursive: true });
    const target = join(destination, `${safe(documentId)}-${safe(versionId)}.json`);
    const content = `${serialize(document)}\n`;
    try {
      const existing = await readFile(target, 'utf8');
      if (existing !== content) throw new Error(`restore target ${target} already contains different content.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeFile(target, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
  }

  private async ensureOpen(): Promise<void> {
    if (!this.current) await this.open();
  }
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '_');
}
