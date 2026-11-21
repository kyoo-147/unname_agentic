import { parseBibTeX, stableKey, toBibTeX, type Entry } from '../bibtex';
import { entriesFromRis, entriesToRis } from './ris';
import { normalizeDoi } from '../scholar';
import type { ResearchPaper, ResearchReference } from './types';

export interface BibliographyImport {
  format: 'bibtex' | 'ris';
  entries: Entry[];
  errors: Array<{ line: number; message: string }>;
}

export function importBibliography(text: string, format: 'bibtex' | 'ris'): BibliographyImport {
  if (format === 'bibtex') {
    const parsed = parseBibTeX(text);
    return { format, entries: parsed.entries, errors: parsed.errors.map(error => ({ line: error.line, message: error.message })) };
  }
  const parsed = entriesFromRis(text);
  return { format, entries: parsed.entries, errors: parsed.errors };
}

export function exportBibliography(entries: readonly Entry[], format: 'bibtex' | 'ris'): string {
  return format === 'bibtex' ? toBibTeX(entries) : entriesToRis(entries);
}

export function researchPaperToEntry(paper: ResearchPaper): Entry {
  const fields: Record<string, string> = {};
  if (paper.authors.length > 0) fields.author = paper.authors.join(' and ');
  if (paper.title) fields.title = paper.title;
  if (paper.venue) fields.journal = paper.venue;
  if (paper.year !== undefined) fields.year = String(paper.year);
  if (paper.doi) fields.doi = paper.doi;
  if (paper.arxiv) {
    fields.eprint = paper.arxiv;
    fields.archiveprefix = 'arXiv';
  }
  if (paper.abstract) fields.abstract = paper.abstract;
  if (paper.tags.length > 0) fields.keywords = paper.tags.join(', ');
  const entry: Entry = { type: paper.venue ? 'article' : 'misc', key: paper.citationKey ?? '', fields };
  entry.key = entry.key || stableKey(entry);
  return entry;
}

export function zoteroItemsToPapers(json: string, importedAt = '1970-01-01T00:00:00.000Z'): ResearchPaper[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Zotero JSON is not valid JSON.');
  }
  const items = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : [];
  return items.map((value, index) => zoteroItemToPaper(value, index, importedAt)).filter((paper): paper is ResearchPaper => paper !== undefined);
}

interface ZoteroItem {
  key?: string;
  library?: { id?: number; name?: string };
  data?: Record<string, unknown>;
}

function zoteroItemToPaper(value: unknown, index: number, importedAt: string): ResearchPaper | undefined {
  if (!isRecord(value)) return undefined;
  const item = value as ZoteroItem;
  const data: Record<string, unknown> = isRecord(item.data) ? item.data : (item as unknown as Record<string, unknown>);
  const library = isRecord(item.library) ? item.library : undefined;
  const title = text(data.title);
  if (!title) return undefined;
  const authors = Array.isArray(data.creators) ? data.creators.map(creator => {
    if (!isRecord(creator)) return '';
    const name = text(creator.name);
    if (name) return name;
    const first = text(creator.firstName);
    const last = text(creator.lastName);
    return [first, last].filter(Boolean).join(' ');
  }).filter(Boolean) : [];
  const doi = normalizeDoi(text(data.DOI));
  const year = parseYear(text(data.date));
  const paper: ResearchPaper = {
    paperId: `zotero:${text(item.key) || `item-${index + 1}`}`,
    title,
    authors,
    topics: [],
    tags: Array.isArray(data.tags) ? data.tags.map(tag => isRecord(tag) ? text(tag.tag) : '').filter(Boolean) : [],
    references: [],
    metadataReceipts: [{ provider: 'zotero', status: 'ok', providerId: text(item.key) || undefined, fields: ['title', 'authors', ...(doi ? ['doi'] : []), ...(year ? ['year'] : []), ...(text(data.publicationTitle) ? ['venue'] : []), ...(text(data.abstractNote) ? ['abstract'] : [])] }],
    sourceHistory: [{ action: 'imported', at: importedAt, source: 'zotero', detail: library?.name ? `library:${String(library.name)}` : undefined }],
    rawImports: [{ format: 'zotero-json', importedAt, source: 'zotero', unknownFields: {} }],
  };
  if (doi) paper.doi = doi;
  if (year) paper.year = year;
  const venue = text(data.publicationTitle) || text(data.proceedingsTitle);
  if (venue) paper.venue = venue;
  const abstract = text(data.abstractNote);
  if (abstract) paper.abstract = abstract;
  const url = text(data.url);
  if (url) paper.rawImports[0]!.unknownFields.url = [url];
  paper.citationKey = stableKey(researchPaperToEntry(paper));
  return paper;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseYear(value: string): number | undefined {
  const year = Number(value.slice(0, 4));
  return Number.isInteger(year) && year >= 1000 && year <= 9999 ? year : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
