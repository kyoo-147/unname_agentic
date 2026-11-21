import { buildLookup, mergeRecords, parseCrossref, parseSemanticScholar, type PaperRecord } from '../scholar';
import type { FetchLike } from '../network-guard';
import { RESEARCH_SCHEMA_VERSION, type MetadataReceipt, type ResearchPaper } from './types';

export type EnrichmentMode = 'offline' | 'consent' | 'enabled';
export type EnrichmentState = 'enriched' | 'cached' | 'consent-required' | 'offline' | 'timeout' | 'unavailable' | 'invalid';

export interface EnrichmentOptions {
  mode?: EnrichmentMode;
  consent?: boolean;
  timeoutMs?: number;
  fetch?: FetchLike;
  now?: () => string;
  cache?: MetadataCache;
  termsUrls?: Partial<Record<'crossref' | 'semanticscholar', string>>;
}

export interface EnrichmentResult {
  state: EnrichmentState;
  query: string;
  record?: PaperRecord;
  receipts: MetadataReceipt[];
  fromCache: boolean;
  reason?: string;
}

interface CacheValue {
  response: unknown;
  responseSha256?: string;
  retrievedAt: string;
}

export class MetadataCache {
  private readonly values = new Map<string, CacheValue>();

  get(key: string): CacheValue | undefined {
    const value = this.values.get(key);
    return value === undefined ? undefined : { ...value };
  }

  set(key: string, value: CacheValue): void {
    this.values.set(key, { ...value });
  }

  clear(): void {
    this.values.clear();
  }

  toJson(): string {
    return `${JSON.stringify({ version: RESEARCH_SCHEMA_VERSION, entries: [...this.values.entries()].sort(([left], [right]) => left.localeCompare(right)) }, null, 2)}\n`;
  }

  static fromJson(text: string): MetadataCache {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Metadata cache is not valid JSON.');
    }
    if (!isRecord(parsed) || parsed.version !== RESEARCH_SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
      throw new Error(`Metadata cache must declare version ${RESEARCH_SCHEMA_VERSION}.`);
    }
    const cache = new MetadataCache();
    for (const item of parsed.entries) {
      if (!Array.isArray(item) || typeof item[0] !== 'string' || !isRecord(item[1])) throw new Error('Metadata cache contains a malformed entry.');
      const value = item[1];
      if (typeof value.retrievedAt !== 'string' || !('response' in value)) throw new Error('Metadata cache entry is missing response provenance.');
      cache.set(item[0], { response: value.response, responseSha256: typeof value.responseSha256 === 'string' ? value.responseSha256 : undefined, retrievedAt: value.retrievedAt });
    }
    return cache;
  }
}

export async function enrichPaper(paper: ResearchPaper, options: EnrichmentOptions = {}): Promise<{ paper: ResearchPaper; result: EnrichmentResult }> {
  const query = paper.doi ?? paper.arxiv ?? '';
  const result = await enrichMetadata(query, options);
  if (result.record === undefined) return { paper: cloneResearchPaper(paper), result };
  const next = cloneResearchPaper(paper);
  applyRecord(next, result.record, result.receipts);
  return { paper: next, result };
}

export async function enrichMetadata(query: string, options: EnrichmentOptions = {}): Promise<EnrichmentResult> {
  const mode = options.mode ?? 'consent';
  const input = typeof query === 'string' ? query.trim() : '';
  const cache = options.cache ?? new MetadataCache();
  const now = options.now ?? (() => new Date().toISOString());
  const receipts: MetadataReceipt[] = [];
  if (input.length === 0) return { state: 'invalid', query: input, receipts, fromCache: false, reason: 'A DOI or arXiv identifier is required.' };

  let lookup;
  try {
    lookup = buildLookup(input);
  } catch (error) {
    return { state: 'invalid', query: input, receipts, fromCache: false, reason: error instanceof Error ? error.message : 'Identifier was not valid.' };
  }

  const requests: Array<{ provider: 'crossref' | 'semanticscholar'; url: string; parse: (body: unknown) => PaperRecord }> = [];
  if (lookup.crossref !== undefined) requests.push({ provider: 'crossref', url: lookup.crossref, parse: parseCrossref });
  requests.push({ provider: 'semanticscholar', url: lookup.semanticScholar, parse: parseSemanticScholar });

  const records: PaperRecord[] = [];
  let cachedCount = 0;
  let failedCount = 0;
  let timeoutCount = 0;
  for (const request of requests) {
    const key = `${request.provider}:${request.url}`;
    const cached = cache.get(key);
    if (cached !== undefined) {
      try {
        records.push(request.parse(cached.response));
        cachedCount += 1;
        receipts.push({ provider: request.provider, status: 'cached', requestUrl: request.url, retrievedAt: cached.retrievedAt, responseSha256: cached.responseSha256, fields: ['cached'], termsUrl: termsUrl(request.provider, options) });
        continue;
      } catch {
        // Invalid cache entries are ignored and replaced only after a consented request.
      }
    }
    if (mode === 'offline') {
      receipts.push({ provider: request.provider, status: 'offline', requestUrl: request.url, fields: [], termsUrl: termsUrl(request.provider, options), reason: 'Offline mode never calls the network.' });
      continue;
    }
    if (mode === 'consent' && options.consent !== true || mode === 'enabled' && options.consent !== true) {
      receipts.push({ provider: request.provider, status: 'denied', requestUrl: request.url, fields: [], termsUrl: termsUrl(request.provider, options), reason: 'Explicit metadata network consent is required.' });
      continue;
    }
    const fetcher = options.fetch ?? ((inputUrl, init) => globalThis.fetch(inputUrl, init));
    try {
      const response = await fetchWithTimeout(fetcher, request.url, options.timeoutMs ?? 8000);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json() as unknown;
      const record = request.parse(body);
      const responseText = JSON.stringify(body);
      const responseSha256 = await sha256(responseText);
      cache.set(key, { response: body, responseSha256, retrievedAt: now() });
      records.push(record);
      receipts.push({ provider: request.provider, status: 'ok', requestUrl: request.url, retrievedAt: now(), responseSha256, fields: ['title', 'authors', 'venue', 'year', 'abstract', 'citationCount', 'references'], termsUrl: termsUrl(request.provider, options) });
    } catch (error) {
      failedCount += 1;
      if (error instanceof TimeoutError) timeoutCount += 1;
      receipts.push({ provider: request.provider, status: error instanceof TimeoutError ? 'timeout' : 'unavailable', requestUrl: request.url, fields: [], termsUrl: termsUrl(request.provider, options), reason: error instanceof Error ? error.message : 'Provider unavailable.' });
    }
  }

  if (records.length === 0) {
    if (cachedCount > 0) return { state: 'cached', query: input, receipts, fromCache: true };
    if (mode === 'offline') return { state: 'offline', query: input, receipts, fromCache: false, reason: 'No cached metadata was available.' };
    if (receipts.some(receipt => receipt.status === 'denied')) return { state: 'consent-required', query: input, receipts, fromCache: false, reason: 'Explicit metadata network consent is required.' };
    return { state: timeoutCount === failedCount && timeoutCount > 0 ? 'timeout' : 'unavailable', query: input, receipts, fromCache: false, reason: 'No metadata provider returned a valid record.' };
  }
  const record = records.slice(1).reduce((left, right) => mergeRecords(left, right), records[0] as PaperRecord);
  return { state: cachedCount === records.length ? 'cached' : 'enriched', query: input, record, receipts, fromCache: cachedCount > 0 };
}

function applyRecord(paper: ResearchPaper, record: PaperRecord, receipts: MetadataReceipt[]): void {
  if (record.doi !== undefined) paper.doi = record.doi;
  if (record.arxiv !== undefined) paper.arxiv = record.arxiv;
  if (record.title.trim().length > 0) paper.title = record.title;
  if (record.authors.length > 0) paper.authors = [...record.authors];
  if (record.venue !== undefined) paper.venue = record.venue;
  if (record.year !== undefined) paper.year = record.year;
  if (record.abstract !== undefined) paper.abstract = record.abstract;
  paper.metadataReceipts.push(...receipts.map(receipt => ({ ...receipt, fields: [...receipt.fields] })));
  paper.sourceHistory.push({ action: 'enriched', at: receipts.find(receipt => receipt.retrievedAt)?.retrievedAt ?? '1970-01-01T00:00:00.000Z', source: record.source ?? 'manual' });
}

function cloneResearchPaper(paper: ResearchPaper): ResearchPaper {
  return JSON.parse(JSON.stringify(paper)) as ResearchPaper;
}

function termsUrl(provider: 'crossref' | 'semanticscholar', options: EnrichmentOptions): string | undefined {
  return options.termsUrls?.[provider] ?? (provider === 'crossref' ? 'https://www.crossref.org/documentation/retrieve-metadata/' : 'https://api.semanticscholar.org/license/');
}

async function fetchWithTimeout(fetcher: FetchLike, url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await fetcher(url, { method: 'GET', signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new TimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

class TimeoutError extends Error {
  constructor() {
    super('Metadata request timed out.');
    this.name = 'TimeoutError';
  }
}

async function sha256(value: string): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return undefined;
  const bytes = new TextEncoder().encode(value);
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface EnrichmentProposal {
  proposalVersion: 1;
  paperId: string;
  baseFingerprint: string;
  query: string;
  before: ResearchPaper;
  after: ResearchPaper;
  changedFields: string[];
  result: EnrichmentResult;
  requiresConfirmation: true;
}

export interface ApplyProposalResult {
  applied: boolean;
  paper: ResearchPaper;
  reason?: string;
}

/** Fetches metadata into a reviewable proposal without mutating the paper. */
export async function proposePaperEnrichment(paper: ResearchPaper, options: EnrichmentOptions = {}): Promise<EnrichmentProposal> {
  const before = cloneResearchPaper(paper);
  const result = await enrichMetadata(before.doi ?? before.arxiv ?? '', options);
  const after = cloneResearchPaper(before);
  if (result.record !== undefined) applyRecord(after, result.record, result.receipts);
  return {
    proposalVersion: 1,
    paperId: before.paperId,
    baseFingerprint: fingerprint(before),
    query: before.doi ?? before.arxiv ?? '',
    before,
    after,
    changedFields: changedPaperFields(before, after),
    result,
    requiresConfirmation: true,
  };
}

/** Applies only a confirmed proposal created from the same paper revision. */
export function applyEnrichmentProposal(paper: ResearchPaper, proposal: EnrichmentProposal, confirm: boolean): ApplyProposalResult {
  if (!confirm) return { applied: false, paper: cloneResearchPaper(paper), reason: 'Metadata proposal was not confirmed.' };
  if (proposal.proposalVersion !== 1 || proposal.requiresConfirmation !== true) return { applied: false, paper: cloneResearchPaper(paper), reason: 'Metadata proposal version is unsupported.' };
  if (proposal.paperId !== paper.paperId || proposal.baseFingerprint !== fingerprint(paper)) return { applied: false, paper: cloneResearchPaper(paper), reason: 'Metadata proposal is stale and no longer matches the paper revision.' };
  return { applied: true, paper: cloneResearchPaper(proposal.after) };
}

function fingerprint(paper: ResearchPaper): string {
  const value = cloneResearchPaper(paper);
  value.sourceHistory = [];
  value.metadataReceipts = [];
  return JSON.stringify(value);
}

function changedPaperFields(before: ResearchPaper, after: ResearchPaper): string[] {
  const fields = ['title', 'authors', 'doi', 'arxiv', 'venue', 'year', 'abstract', 'references', 'topics', 'tags', 'citationKey'] as const;
  return fields.filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
}
