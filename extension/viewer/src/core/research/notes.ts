import { RESEARCH_SCHEMA_VERSION, cloneEvidence, type EvidenceRef, type SourceAnchor } from './types';

export type ResearchNoteKind = 'note' | 'highlight' | 'question' | 'claim' | 'bookmark';

export interface ResearchNote {
  noteId: string;
  paperId: string;
  text: string;
  kind: ResearchNoteKind;
  anchors: EvidenceRef[];
  citationIds: string[];
  createdAt: string;
  updatedAt: string;
  orphaned: boolean;
}

export interface AddResearchNoteInput {
  paperId: string;
  text: string;
  kind: ResearchNoteKind;
  anchors: EvidenceRef[];
  citationIds?: string[];
}

export interface ResearchNoteStoreOptions {
  now?: () => string;
}

export interface ResearchBacklinkQuery {
  paperId?: string;
  page?: number;
  blockId?: string;
  citationId?: string;
  hasPolygon?: boolean;
}

export class ResearchNoteStore {
  private readonly records = new Map<string, ResearchNote>();
  private readonly clock: () => string;
  private sequence = 0;

  constructor(options: ResearchNoteStoreOptions = {}) {
    this.clock = options.now ?? (() => new Date().toISOString());
  }

  add(input: AddResearchNoteInput, id?: string): ResearchNote {
    const paperId = required(input?.paperId, 'paperId');
    const text = required(input?.text, 'text');
    const kind = validKind(input?.kind);
    const anchors = readAnchors(input?.anchors);
    const noteId = id === undefined ? this.nextId() : required(id, 'noteId');
    if (this.records.has(noteId)) throw new Error(`Research note ${noteId} already exists.`);
    const stamp = this.stamp();
    const note: ResearchNote = {
      noteId,
      paperId,
      text,
      kind,
      anchors,
      citationIds: uniqueStrings(input?.citationIds ?? []),
      createdAt: stamp,
      updatedAt: stamp,
      orphaned: anchors.some(anchor => anchor.status === 'unknown'),
    };
    this.records.set(noteId, note);
    return cloneNote(note);
  }

  get(noteId: string): ResearchNote | undefined {
    const note = this.records.get(noteId);
    return note === undefined ? undefined : cloneNote(note);
  }

  list(paperId?: string): ResearchNote[] {
    return [...this.records.values()]
      .filter(note => paperId === undefined || note.paperId === paperId)
      .sort(compareNotes)
      .map(cloneNote);
  }

  update(noteId: string, patch: Partial<Pick<ResearchNote, 'text' | 'kind' | 'anchors' | 'citationIds' | 'orphaned'>>): ResearchNote {
    const current = this.records.get(noteId);
    if (current === undefined) throw new Error(`Research note ${noteId} does not exist.`);
    const next = cloneNote(current);
    if (patch.text !== undefined) next.text = required(patch.text, 'text');
    if (patch.kind !== undefined) next.kind = validKind(patch.kind);
    if (patch.anchors !== undefined) next.anchors = readAnchors(patch.anchors);
    if (patch.citationIds !== undefined) next.citationIds = uniqueStrings(patch.citationIds);
    if (patch.orphaned !== undefined) next.orphaned = patch.orphaned === true;
    next.updatedAt = this.stamp();
    this.records.set(noteId, next);
    return cloneNote(next);
  }

  remove(noteId: string): boolean {
    return this.records.delete(noteId);
  }

  backlinks(query: ResearchBacklinkQuery): ResearchNote[] {
    return this.list().filter(note => noteMatches(note, query));
  }

  toJson(): string {
    return `${JSON.stringify({ version: RESEARCH_SCHEMA_VERSION, notes: this.list() }, null, 2)}\n`;
  }

  importJson(text: string): { imported: number; total: number } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Research notes are not valid JSON.');
    }
    if (!isRecord(parsed) || parsed.version !== RESEARCH_SCHEMA_VERSION || !Array.isArray(parsed.notes)) throw new Error(`Research notes must declare version ${RESEARCH_SCHEMA_VERSION}.`);
    const incoming = parsed.notes.map((value, index) => readNote(value, `notes[${index}]`));
    const ids = new Set<string>();
    for (const note of incoming) {
      if (ids.has(note.noteId) || this.records.has(note.noteId)) throw new Error(`Research note ${note.noteId} is duplicated.`);
      ids.add(note.noteId);
    }
    for (const note of incoming) this.records.set(note.noteId, note);
    return { imported: incoming.length, total: this.records.size };
  }

  private nextId(): string {
    let id = '';
    do {
      this.sequence += 1;
      id = `rn${this.sequence}`;
    } while (this.records.has(id));
    return id;
  }

  private stamp(): string {
    const value = this.clock();
    if (typeof value !== 'string' || value.trim().length === 0) throw new Error('Research note clock must return a timestamp.');
    return value.trim();
  }
}

export function sourceAnchorForNote(note: ResearchNote, index = 0): SourceAnchor | undefined {
  return note.anchors[index]?.anchor;
}

function readAnchors(value: unknown): EvidenceRef[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('A research note needs at least one evidence reference.');
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.status !== 'string' || !['supported', 'partial', 'unknown', 'unverified'].includes(item.status)) throw new Error(`Invalid evidence reference at anchors[${index}].`);
    return cloneEvidence(item as unknown as EvidenceRef);
  });
}

function readNote(value: unknown, path: string): ResearchNote {
  if (!isRecord(value)) throw new Error(`${path} is not a note.`);
  const note: ResearchNote = {
    noteId: required(value.noteId, `${path}.noteId`),
    paperId: required(value.paperId, `${path}.paperId`),
    text: required(value.text, `${path}.text`),
    kind: validKind(value.kind),
    anchors: readAnchors(value.anchors),
    citationIds: uniqueStrings(Array.isArray(value.citationIds) ? value.citationIds : []),
    createdAt: required(value.createdAt, `${path}.createdAt`),
    updatedAt: required(value.updatedAt, `${path}.updatedAt`),
    orphaned: value.orphaned === true,
  };
  return note;
}

function cloneNote(note: ResearchNote): ResearchNote {
  return { ...note, anchors: note.anchors.map(cloneEvidence), citationIds: [...note.citationIds] };
}

function compareNotes(left: ResearchNote, right: ResearchNote): number {
  return left.paperId < right.paperId ? -1 : left.paperId > right.paperId ? 1 : left.noteId < right.noteId ? -1 : left.noteId > right.noteId ? 1 : 0;
}

function noteMatches(note: ResearchNote, query: ResearchBacklinkQuery): boolean {
  if (query.paperId !== undefined && note.paperId !== query.paperId) return false;
  if (query.citationId !== undefined && !note.citationIds.includes(query.citationId)) return false;
  if (query.page !== undefined && !note.anchors.some(anchor => anchor.anchor?.page === query.page)) return false;
  if (query.blockId !== undefined && !note.anchors.some(anchor => anchor.anchor?.blockId === query.blockId)) return false;
  if (query.hasPolygon !== undefined && !note.anchors.some(anchor => (anchor.anchor?.polygon !== undefined) === query.hasPolygon)) return false;
  return true;
}

function required(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${path} must be non-empty text.`);
  return value.trim();
}

function validKind(value: unknown): ResearchNoteKind {
  if (value === 'note' || value === 'highlight' || value === 'question' || value === 'claim' || value === 'bookmark') return value;
  throw new Error('Research note kind is invalid.');
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map(value => value.trim()))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
