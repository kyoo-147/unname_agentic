import { arxivId, normalizeDoi } from '../scholar';
import { RESEARCH_SCHEMA_VERSION, clonePaper, type ResearchPaper, type SourceHistoryEntry } from './types';

export interface CollectionFilter {
  topics?: string[];
  authors?: string[];
  years?: number[];
  tags?: string[];
  query?: string;
}

export interface ResearchCollection {
  collectionId: string;
  name: string;
  filter: CollectionFilter;
  paperIds: string[];
}

export interface DuplicateCandidate {
  paperIds: string[];
  reason: 'doi' | 'arxiv' | 'title-year';
  confirmed: false;
}

export interface MergeResult {
  merged: boolean;
  keptPaperId: string;
  removedPaperIds: string[];
  paper?: ResearchPaper;
  candidate: DuplicateCandidate;
}

export interface ResearchLibraryOptions {
  now?: () => string;
}

export class ResearchLibrary {
  private readonly papers = new Map<string, ResearchPaper>();
  private readonly collections = new Map<string, ResearchCollection>();
  private readonly clock: () => string;

  constructor(options: ResearchLibraryOptions = {}) {
    this.clock = options.now ?? (() => new Date().toISOString());
  }

  addPaper(paper: ResearchPaper): ResearchPaper {
    if (!paper || typeof paper.paperId !== 'string' || paper.paperId.trim().length === 0) throw new Error('Research paper needs a paperId.');
    if (this.papers.has(paper.paperId)) throw new Error(`Research paper ${paper.paperId} already exists.`);
    const next = clonePaper(paper);
    next.sourceHistory = [...next.sourceHistory, { action: 'created', at: this.clock(), source: 'manual' }];
    this.papers.set(next.paperId, next);
    return clonePaper(next);
  }

  getPaper(paperId: string): ResearchPaper | undefined {
    const paper = this.papers.get(paperId);
    return paper === undefined ? undefined : clonePaper(paper);
  }

  listPapers(): ResearchPaper[] {
    return [...this.papers.values()].sort((left, right) => left.paperId.localeCompare(right.paperId)).map(clonePaper);
  }

  upsertCollection(collection: ResearchCollection): ResearchCollection {
    if (!collection || !collection.collectionId || !collection.name) throw new Error('Collection needs an id and name.');
    const next = { collectionId: collection.collectionId, name: collection.name, filter: cloneFilter(collection.filter), paperIds: [...new Set(collection.paperIds.filter(id => this.papers.has(id)))] };
    this.collections.set(next.collectionId, next);
    return cloneCollection(next);
  }

  getCollection(collectionId: string): ResearchCollection | undefined {
    const collection = this.collections.get(collectionId);
    return collection === undefined ? undefined : cloneCollection(collection);
  }

  queryCollection(collectionId: string): ResearchPaper[] {
    const collection = this.collections.get(collectionId);
    if (collection === undefined) return [];
    const ids = collection.paperIds.length > 0 ? new Set(collection.paperIds) : new Set(this.papers.keys());
    return [...this.papers.values()].filter(paper => ids.has(paper.paperId) && matchesFilter(paper, collection.filter)).sort((left, right) => left.paperId.localeCompare(right.paperId)).map(clonePaper);
  }

  proposeDuplicates(): DuplicateCandidate[] {
    const groups = new Map<string, { ids: string[]; reason: DuplicateCandidate['reason'] }>();
    for (const paper of this.papers.values()) {
      const identity = identityOf(paper);
      if (identity === undefined) continue;
      const existing = groups.get(identity.key);
      if (existing) existing.ids.push(paper.paperId);
      else groups.set(identity.key, { ids: [paper.paperId], reason: identity.reason });
    }
    return [...groups.values()].filter(group => group.ids.length > 1).map(group => ({ paperIds: [...group.ids], reason: group.reason, confirmed: false as const }));
  }

  mergeDuplicate(candidate: DuplicateCandidate, confirm: boolean, requestedKeptPaperId?: string): MergeResult {
    const keptPaperId = requestedKeptPaperId ?? candidate.paperIds[0];
    if (keptPaperId === undefined || candidate.confirmed !== false || candidate.paperIds.length < 2 || !candidate.paperIds.includes(keptPaperId)) throw new Error('Duplicate merge candidate is invalid.');
    const sourcePapers = candidate.paperIds.map(id => this.papers.get(id));
    if (sourcePapers.some(paper => paper === undefined)) throw new Error('Duplicate merge references an unknown paper.');
    if (!confirm) return { merged: false, keptPaperId, removedPaperIds: candidate.paperIds.filter(id => id !== keptPaperId), candidate: { ...candidate, paperIds: [...candidate.paperIds] } };
    const first = this.papers.get(keptPaperId);
    if (first === undefined) throw new Error('Duplicate merge kept paper is unknown.');
    const merged = mergePapers(first, sourcePapers.filter((paper): paper is ResearchPaper => paper !== undefined && paper.paperId !== keptPaperId), this.clock());
    this.papers.set(keptPaperId, merged);
    for (const id of candidate.paperIds) if (id !== keptPaperId) this.papers.delete(id);
    for (const collection of this.collections.values()) {
      collection.paperIds = [...new Set(collection.paperIds.map(id => id === keptPaperId || !candidate.paperIds.includes(id) ? id : keptPaperId))].filter(id => this.papers.has(id));
    }
    return { merged: true, keptPaperId, removedPaperIds: candidate.paperIds.filter(id => id !== keptPaperId), paper: clonePaper(merged), candidate: { ...candidate, paperIds: [...candidate.paperIds] } };
  }

  toJson(): string {
    return `${JSON.stringify({ version: RESEARCH_SCHEMA_VERSION, papers: this.listPapers(), collections: [...this.collections.values()].sort((left, right) => left.collectionId.localeCompare(right.collectionId)).map(cloneCollection) }, null, 2)}\n`;
  }
}

function mergePapers(kept: ResearchPaper, others: ResearchPaper[], at: string): ResearchPaper {
  const merged = clonePaper(kept);
  for (const other of others) {
    if (merged.title.trim().length === 0 && other.title.trim().length > 0) merged.title = other.title;
    if (merged.authors.length === 0 && other.authors.length > 0) merged.authors = [...other.authors];
    for (const field of ['doi', 'arxiv', 'venue', 'year', 'abstract', 'citationKey'] as const) {
      if (merged[field] === undefined && other[field] !== undefined) merged[field] = other[field] as never;
    }
    merged.topics = unique([...merged.topics, ...other.topics]);
    merged.tags = unique([...merged.tags, ...other.tags]);
    merged.references = uniqueById([...merged.references, ...other.references]);
    merged.metadataReceipts.push(...other.metadataReceipts.map(receipt => ({ ...receipt, fields: [...receipt.fields] })));
    merged.rawImports.push(...other.rawImports.map(raw => ({ ...raw, unknownFields: Object.fromEntries(Object.entries(raw.unknownFields).map(([key, values]) => [key, [...values]])) })));
    merged.sourceHistory.push(...other.sourceHistory.map(entry => ({ ...entry, paperIds: [...(entry.paperIds ?? []), other.paperId] })));
  }
  const history: SourceHistoryEntry = { action: 'merged', at, source: 'manual', detail: 'Confirmed duplicate merge.', paperIds: [kept.paperId, ...others.map(other => other.paperId)] };
  merged.sourceHistory.push(history);
  return merged;
}

function identityOf(paper: ResearchPaper): { key: string; reason: DuplicateCandidate['reason'] } | undefined {
  const doi = normalizeDoi(paper.doi ?? '');
  if (doi) return { key: `doi:${doi.toLowerCase()}`, reason: 'doi' };
  const arxiv = arxivId(paper.arxiv ?? '');
  if (arxiv) return { key: `arxiv:${arxiv.toLowerCase()}`, reason: 'arxiv' };
  const title = fold(paper.title);
  if (title && paper.year !== undefined) return { key: `title-year:${title}:${paper.year}`, reason: 'title-year' };
  return undefined;
}

function matchesFilter(paper: ResearchPaper, filter: CollectionFilter): boolean {
  if (filter.topics?.length && !filter.topics.every(topic => paper.topics.includes(topic))) return false;
  if (filter.tags?.length && !filter.tags.every(tag => paper.tags.includes(tag))) return false;
  if (filter.authors?.length && !filter.authors.every(author => paper.authors.some(value => fold(value).includes(fold(author))))) return false;
  if (filter.years?.length && (paper.year === undefined || !filter.years.includes(paper.year))) return false;
  if (filter.query && !fold([paper.title, ...paper.authors, paper.venue ?? '', ...paper.tags].join(' ')).includes(fold(filter.query))) return false;
  return true;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim().length > 0))];
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter(value => !seen.has(value.id) && seen.add(value.id));
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function cloneFilter(filter: CollectionFilter): CollectionFilter {
  return { ...(filter.topics ? { topics: [...filter.topics] } : {}), ...(filter.authors ? { authors: [...filter.authors] } : {}), ...(filter.years ? { years: [...filter.years] } : {}), ...(filter.tags ? { tags: [...filter.tags] } : {}), ...(filter.query ? { query: filter.query } : {}) };
}

function cloneCollection(collection: ResearchCollection): ResearchCollection {
  return { collectionId: collection.collectionId, name: collection.name, filter: cloneFilter(collection.filter), paperIds: [...collection.paperIds] };
}
