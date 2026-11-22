import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  private commitChain: Promise<void> = Promise.resolve();

  constructor(private readonly root: string, private readonly now: () => string = () => new Date().toISOString()) {
    this.state = new AtomicJsonStore({ path: join(root, 'versions.json'), initial: () => ({ schemaVersion: 1, generation: 0, versions: {} }) });
  }

  async open(): Promise<void> {
    this.current = await this.state.load();
    await mkdir(join(this.root, 'documents'), { recursive: true });
  }

  async put(input: Omit<ImmutableVersion, 'documentPath' | 'createdAt'> & { document: DocumentIR }): Promise<ImmutableVersion> {
    await this.ensureOpen();
    const operation = this.commitChain.then(async () => {
      const existingVersion = this.list(input.documentId).find(version => version.id === input.id);
      if (existingVersion) {
        const existingDocument = await readFile(join(this.root, existingVersion.documentPath), 'utf8');
        if (existingVersion.sourceSha256 !== input.sourceSha256 || existingDocument !== `${serialize(input.document)}\n`) {
          throw new Error(`version ${input.documentId}/${input.id} already exists with different content.`);
        }
        return existingVersion;
      }
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
    });
    this.commitChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async remove(documentId: string, versionId: string): Promise<void> {
    await this.ensureOpen();
    const operation = this.commitChain.then(async () => {
      const versions = this.current.versions[documentId] ?? [];
      if (!versions.some(version => version.id === versionId)) return;
      const next = await this.state.update(this.current.generation, current => ({
        ...current,
        versions: { ...current.versions, [documentId]: (current.versions[documentId] ?? []).filter(version => version.id !== versionId) },
      }));
      this.current = next;
      const stillReferenced = Object.values(next.versions).some(entries => entries.some(version => version.id === versionId));
      if (!stillReferenced) {
        const removed = versions.find(version => version.id === versionId);
        if (removed) await rm(join(this.root, removed.documentPath), { force: true });
      }
    });
    this.commitChain = operation.then(() => undefined, () => undefined);
    return operation;
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
