import { RESEARCH_SCHEMA_VERSION, clonePaper, type EvidenceBlock, type ResearchPaper } from './types';
import type { ResearchNote } from './notes';

export const RESEARCH_WORKSPACE_STORAGE_KEY = 'mirror.research-workspace.v1';
export const RESEARCH_WORKSPACE_VERSION = 1;

export interface ResearchWorkspaceSnapshot {
  version: typeof RESEARCH_WORKSPACE_VERSION;
  papers: ResearchPaper[];
  evidenceBlocks: EvidenceBlock[];
  notes: ResearchNote[];
  activePaperId?: string;
}

export interface ResearchWorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ResearchWorkspacePersistenceOptions {
  key?: string;
  storage?: ResearchWorkspaceStorage | null;
}

export class ResearchWorkspacePersistence {
  private readonly key: string;
  private readonly storage: ResearchWorkspaceStorage | null;

  constructor(options: ResearchWorkspacePersistenceOptions = {}) {
    this.key = options.key ?? RESEARCH_WORKSPACE_STORAGE_KEY;
    this.storage = options.storage ?? safeStorage();
  }

  load(): ResearchWorkspaceSnapshot {
    if (!this.storage) return emptyResearchWorkspace();
    try {
      return normalizeSnapshot(JSON.parse(this.storage.getItem(this.key) ?? 'null'));
    } catch {
      return emptyResearchWorkspace();
    }
  }

  save(snapshot: ResearchWorkspaceSnapshot): boolean {
    if (!this.storage) return false;
    try {
      this.storage.setItem(this.key, serializeResearchWorkspace(snapshot));
      return true;
    } catch {
      return false;
    }
  }
}

export function emptyResearchWorkspace(): ResearchWorkspaceSnapshot {
  return { version: RESEARCH_WORKSPACE_VERSION, papers: [], evidenceBlocks: [], notes: [] };
}

export function serializeResearchWorkspace(snapshot: ResearchWorkspaceSnapshot): string {
  const normalized = normalizeSnapshot(snapshot);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function normalizeResearchWorkspace(value: unknown): ResearchWorkspaceSnapshot {
  return normalizeSnapshot(value);
}

export function cloneEvidenceBlock(block: EvidenceBlock): EvidenceBlock {
  return {
    ...block,
    ...(block.polygon === undefined ? {} : { polygon: block.polygon.map(point => ({ x: point.x, y: point.y })) }),
  };
}

function normalizeSnapshot(value: unknown): ResearchWorkspaceSnapshot {
  if (!isRecord(value) || value.version !== RESEARCH_WORKSPACE_VERSION) return emptyResearchWorkspace();
  const papers = Array.isArray(value.papers)
    ? value.papers.filter(isRecord).map(value => clonePaper(value as unknown as ResearchPaper)).filter(paper => paper.paperId.trim().length > 0)
    : [];
  const paperIds = new Set(papers.map(paper => paper.paperId));
  const evidenceBlocks = Array.isArray(value.evidenceBlocks)
    ? value.evidenceBlocks.filter(isRecord).map(value => cloneEvidenceBlock(value as unknown as EvidenceBlock)).filter(block => paperIds.has(block.paperId) && block.id.trim().length > 0 && block.text.trim().length > 0 && Number.isInteger(block.page) && block.page > 0)
    : [];
  const notes = Array.isArray(value.notes)
    ? value.notes.filter(isRecord).map(value => cloneNote(value as unknown as ResearchNote)).filter(note => paperIds.has(note.paperId) && note.noteId.trim().length > 0 && note.text.trim().length > 0)
    : [];
  const activePaperId = typeof value.activePaperId === 'string' && paperIds.has(value.activePaperId) ? value.activePaperId : undefined;
  return { version: RESEARCH_WORKSPACE_VERSION, papers, evidenceBlocks, notes, ...(activePaperId ? { activePaperId } : {}) };
}

function cloneNote(note: ResearchNote): ResearchNote {
  return {
    ...note,
    anchors: note.anchors.map(anchor => ({
      ...anchor,
      ...(anchor.anchor === undefined ? {} : {
        anchor: {
          ...anchor.anchor,
          ...(anchor.anchor.polygon === undefined ? {} : { polygon: anchor.anchor.polygon.map(point => ({ ...point })) }),
        },
      }),
    })),
    citationIds: [...note.citationIds],
  };
}

function safeStorage(): ResearchWorkspaceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export { RESEARCH_SCHEMA_VERSION };
