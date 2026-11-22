import type { Entry } from '../bibtex';
import type { PaperRecord } from '../scholar';

export const RESEARCH_SCHEMA_VERSION = 1;

export type EvidenceStatus = 'supported' | 'partial' | 'unknown' | 'unverified';
export type AnchorKind = 'block' | 'selection' | 'reference' | 'metadata';
export type ResearchSource = 'local-pdf' | 'bibtex' | 'ris' | 'crossref' | 'semanticscholar' | 'zotero' | 'manual';

export interface SourceAnchor {
  paperId: string;
  documentId?: string;
  sourceSha256?: string;
  revisionId?: string;
  page?: number;
  blockId?: string;
  polygon?: readonly { x: number; y: number }[];
  quote?: string;
  anchorKind: AnchorKind;
}

export interface EvidenceRef {
  status: EvidenceStatus;
  anchor?: SourceAnchor;
  reason?: string;
}

export interface MetadataReceipt {
  provider: ResearchSource;
  status: 'ok' | 'cached' | 'denied' | 'offline' | 'timeout' | 'unavailable' | 'invalid';
  requestUrl?: string;
  providerId?: string;
  retrievedAt?: string;
  responseSha256?: string;
  fields: string[];
  termsUrl?: string;
  reason?: string;
}

export interface SourceHistoryEntry {
  action: 'created' | 'imported' | 'enriched' | 'merged' | 'edited';
  at: string;
  source: ResearchSource;
  detail?: string;
  paperIds?: string[];
}

export interface ResearchReference {
  id: string;
  title?: string;
  authors?: string[];
  year?: number;
  doi?: string;
  arxiv?: string;
  raw?: string;
  evidence?: EvidenceRef;
}

export interface ResearchPaper {
  paperId: string;
  documentId?: string;
  sourceSha256?: string;
  title: string;
  authors: string[];
  doi?: string;
  arxiv?: string;
  venue?: string;
  year?: number;
  abstract?: string;
  citationKey?: string;
  topics: string[];
  tags: string[];
  references: ResearchReference[];
  metadataReceipts: MetadataReceipt[];
  sourceHistory: SourceHistoryEntry[];
  rawImports: RawBibliographyImport[];
}

export interface RawBibliographyImport {
  format: 'bibtex' | 'ris' | 'zotero-json';
  rawSha256?: string;
  importedAt: string;
  source: ResearchSource;
  unknownFields: Record<string, string[]>;
}

export interface EvidenceBlock {
  id: string;
  paperId: string;
  documentId?: string;
  sourceSha256?: string;
  revisionId?: string;
  page: number;
  text: string;
  section?: string;
  type?: 'heading' | 'paragraph' | 'formula' | 'footnote' | 'reference' | 'other';
  polygon?: readonly { x: number; y: number }[];
}

export interface ResearchEntryBundle {
  entry: Entry;
  paper: ResearchPaper;
}

export function evidenceAnchor(block: EvidenceBlock, anchorKind: AnchorKind = 'block'): SourceAnchor {
  const anchor: SourceAnchor = {
    paperId: block.paperId,
    page: block.page,
    blockId: block.id,
    anchorKind,
    quote: block.text,
  };
  if (block.documentId !== undefined) anchor.documentId = block.documentId;
  if (block.sourceSha256 !== undefined) anchor.sourceSha256 = block.sourceSha256;
  if (block.revisionId !== undefined) anchor.revisionId = block.revisionId;
  if (block.polygon !== undefined) anchor.polygon = block.polygon.map(point => ({ x: point.x, y: point.y }));
  return anchor;
}

export function supportedEvidence(block: EvidenceBlock, anchorKind: AnchorKind = 'block'): EvidenceRef {
  return { status: 'supported', anchor: evidenceAnchor(block, anchorKind) };
}

export function unknownEvidence(reason = 'No exact page/block evidence was supplied.'): EvidenceRef {
  return { status: 'unknown', reason };
}

export function unverifiedEvidence(reason = 'Metadata exists without a local page/block confirmation.'): EvidenceRef {
  return { status: 'unverified', reason };
}

export function clonePaper(paper: ResearchPaper): ResearchPaper {
  return {
    ...paper,
    authors: [...paper.authors],
    topics: [...paper.topics],
    tags: [...paper.tags],
    references: paper.references.map(reference => ({
      ...reference,
      ...(reference.authors === undefined ? {} : { authors: [...reference.authors] }),
      ...(reference.evidence === undefined ? {} : { evidence: cloneEvidence(reference.evidence) }),
    })),
    metadataReceipts: paper.metadataReceipts.map(receipt => ({ ...receipt, fields: [...receipt.fields] })),
    sourceHistory: paper.sourceHistory.map(entry => ({ ...entry, ...(entry.paperIds ? { paperIds: [...entry.paperIds] } : {}) })),
    rawImports: paper.rawImports.map(raw => ({ ...raw, unknownFields: Object.fromEntries(Object.entries(raw.unknownFields).map(([key, values]) => [key, [...values]])) })),
  };
}

export function cloneEvidence(evidence: EvidenceRef): EvidenceRef {
  return {
    ...evidence,
    ...(evidence.anchor === undefined ? {} : {
      anchor: {
        ...evidence.anchor,
        ...(evidence.anchor.polygon === undefined ? {} : { polygon: evidence.anchor.polygon.map(point => ({ x: point.x, y: point.y })) }),
      },
    }),
  };
}

export function paperFromRecord(
  paperId: string,
  record: PaperRecord,
  options: Partial<Pick<ResearchPaper, 'documentId' | 'sourceSha256' | 'citationKey' | 'topics' | 'tags' | 'references'>> = {},
): ResearchPaper {
  const source = record.source ?? 'manual';
  const paper: ResearchPaper = {
    paperId,
    title: record.title,
    authors: [...record.authors],
    topics: [...(options.topics ?? [])],
    tags: [...(options.tags ?? [])],
    references: [...(options.references ?? [])],
    metadataReceipts: [{ provider: source, status: 'ok', fields: ['title', 'authors', ...(record.doi ? ['doi'] : []), ...(record.arxiv ? ['arxiv'] : []), ...(record.venue ? ['venue'] : []), ...(record.year ? ['year'] : []), ...(record.abstract ? ['abstract'] : []), ...(record.references ? ['references'] : [])] }],
    sourceHistory: [{ action: source === 'manual' ? 'created' : 'enriched', at: '1970-01-01T00:00:00.000Z', source }],
    rawImports: [],
  };
  if (options.documentId !== undefined) paper.documentId = options.documentId;
  if (options.sourceSha256 !== undefined) paper.sourceSha256 = options.sourceSha256;
  if (options.citationKey !== undefined) paper.citationKey = options.citationKey;
  if (record.doi !== undefined) paper.doi = record.doi;
  if (record.arxiv !== undefined) paper.arxiv = record.arxiv;
  if (record.venue !== undefined) paper.venue = record.venue;
  if (record.year !== undefined) paper.year = record.year;
  if (record.abstract !== undefined) paper.abstract = record.abstract;
  return paper;
}
