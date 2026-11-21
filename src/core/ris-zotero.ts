/**
 * RIS interchange, BibTeX deduplication, CSL-JSON mapping, and loopback Zotero bridge (backlog J02).
 *
 * Bridges Mirror's BibTeX records (`bibtex.ts`) and academic metadata (`scholar.ts`) with RIS files,
 * CSL-JSON items, and Zotero's local Connector HTTP server.
 *
 * Contract:
 * - RIS parsing and serialization, CSL-JSON mapping, and BibTeX deduplication are pure and
 *   deterministic: no clock, no randomness, no DOM, no I/O.
 * - Parsing never throws on a malformed RIS file: diagnostics carry a 1-based line number and code,
 *   and valid records continue to parse.
 * - Zotero Connector traffic is strictly restricted to loopback `127.0.0.1` or `localhost` over
 *   HTTP/HTTPS with `redirect: 'error'` and `network-guard.ts` enforcement; non-loopback hosts,
 *   private LAN ranges, embedded credentials, and non-HTTP schemes are refused before any fetch.
 */

import { dedupe, parseBibTeX, stableKey, stableKeys, toBibTeX } from './bibtex';
import type { BibTeXError, DedupeConflict, DedupeMerge, Entry } from './bibtex';
import { createGuard } from './network-guard';
import type { FetchLike } from './network-guard';
import { classifyEndpoint } from './privacy';
import { normalizeDoi } from './scholar';

// --- Constants & Mappings --------------------------------------------------

export const DEFAULT_ZOTERO_ENDPOINT = 'http://127.0.0.1:23119';

const RIS_LINE_RE = /^([A-Z0-9]{2})  -(?: (.*)|$)$/u;

const RIS_TO_BIBTEX_TYPE: Readonly<Record<string, string>> = {
  JOUR: 'article',
  CONF: 'inproceedings',
  CPAPER: 'inproceedings',
  BOOK: 'book',
  CHAP: 'incollection',
  RPRT: 'techreport',
  THES: 'phdthesis',
  GEN: 'misc',
  ELEC: 'misc',
  UNPB: 'misc',
};

const BIBTEX_TO_RIS_TYPE: Readonly<Record<string, string>> = {
  article: 'JOUR',
  inproceedings: 'CONF',
  conference: 'CONF',
  proceedings: 'CONF',
  book: 'BOOK',
  incollection: 'CHAP',
  inbook: 'CHAP',
  techreport: 'RPRT',
  phdthesis: 'THES',
  mastersthesis: 'THES',
  misc: 'GEN',
};

const RIS_TO_CSL_TYPE: Readonly<Record<string, CslItemType>> = {
  JOUR: 'article-journal',
  CONF: 'paper-conference',
  CPAPER: 'paper-conference',
  BOOK: 'book',
  CHAP: 'chapter',
  RPRT: 'report',
  THES: 'thesis',
  ELEC: 'webpage',
};

const BIBTEX_TO_CSL_TYPE: Readonly<Record<string, CslItemType>> = {
  article: 'article-journal',
  inproceedings: 'paper-conference',
  conference: 'paper-conference',
  book: 'book',
  incollection: 'chapter',
  inbook: 'chapter',
  techreport: 'report',
  phdthesis: 'thesis',
  mastersthesis: 'thesis',
};

const CSL_TO_RIS_TYPE: Readonly<Record<string, string>> = {
  'article-journal': 'JOUR',
  article: 'JOUR',
  'paper-conference': 'CONF',
  book: 'BOOK',
  chapter: 'CHAP',
  report: 'RPRT',
  thesis: 'THES',
  webpage: 'ELEC',
  document: 'GEN',
};

const RIS_TO_ZOTERO_TYPE: Readonly<Record<string, ZoteroItemType>> = {
  JOUR: 'journalArticle',
  CONF: 'conferencePaper',
  CPAPER: 'conferencePaper',
  BOOK: 'book',
  CHAP: 'bookSection',
  RPRT: 'report',
  THES: 'thesis',
};

const CSL_TO_ZOTERO_TYPE: Readonly<Record<string, ZoteroItemType>> = {
  'article-journal': 'journalArticle',
  article: 'journalArticle',
  'paper-conference': 'conferencePaper',
  book: 'book',
  chapter: 'bookSection',
  report: 'report',
  thesis: 'thesis',
};

// --- Public types: RIS -----------------------------------------------------

/** One bibliographic record in RIS format. */
export interface RisRecord {
  /** RIS reference type (`JOUR`, `CONF`, `BOOK`, `RPRT`, `THES`, `GEN`, ...). */
  type: string;
  title?: string;
  authors: string[];
  journal?: string;
  secondaryTitle?: string;
  year?: string;
  volume?: string;
  issue?: string;
  startPage?: string;
  endPage?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  keywords: string[];
}

export type RisErrorCode =
  | 'tag-outside-record'
  | 'missing-type'
  | 'unterminated-record'
  | 'malformed-line';

export interface RisError {
  code: RisErrorCode;
  /** 1-based line number where the problem started. */
  line: number;
  message: string;
}

export interface RisParseResult {
  records: RisRecord[];
  errors: RisError[];
}

// --- Public types: BibTeX dedupe -------------------------------------------

export interface RisBibTeXDedupeResult {
  entries: Entry[];
  merged: DedupeMerge[];
  conflicts: DedupeConflict[];
  parseErrors: BibTeXError[];
  bibtex: string;
}

// --- Public types: CSL-JSON ------------------------------------------------

export type CslItemType =
  | 'article-journal'
  | 'paper-conference'
  | 'book'
  | 'chapter'
  | 'report'
  | 'thesis'
  | 'webpage'
  | 'document';

export interface CslName {
  family?: string;
  given?: string;
  literal?: string;
}

export interface CslDate {
  'date-parts'?: number[][];
  literal?: string;
}

export interface CslJsonItem {
  id: string;
  type: CslItemType;
  title?: string;
  author?: CslName[];
  'container-title'?: string;
  issued?: CslDate;
  volume?: string;
  issue?: string;
  page?: string;
  DOI?: string;
  URL?: string;
  abstract?: string;
  keyword?: string;
}

// --- Public types: Zotero bridge -------------------------------------------

export type ZoteroItemType =
  | 'journalArticle'
  | 'conferencePaper'
  | 'book'
  | 'bookSection'
  | 'report'
  | 'thesis'
  | 'document';

export interface ZoteroCreator {
  firstName?: string;
  lastName?: string;
  name?: string;
  creatorType: 'author' | 'editor';
}

export interface ZoteroTag {
  tag: string;
}

export interface ZoteroConnectorItem {
  itemType: ZoteroItemType;
  title: string;
  creators: ZoteroCreator[];
  publicationTitle?: string;
  proceedingsTitle?: string;
  bookTitle?: string;
  date?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  DOI?: string;
  url?: string;
  abstractNote?: string;
  tags: ZoteroTag[];
}

export interface ZoteroSaveItemsPayload {
  uri: string;
  sessionID?: string;
  items: ZoteroConnectorItem[];
}

export interface ZoteroBridgeOptions {
  /** Must resolve to `127.0.0.1` or `localhost` over `http:`/`https:`. */
  endpoint?: string;
  fetch?: FetchLike;
}

export interface ZoteroSaveOptions {
  uri?: string;
  sessionId?: string;
}

export interface ZoteroPingResult {
  ok: boolean;
  endpoint: string;
  status: number;
}

export interface ZoteroSaveResult {
  saved: number;
  endpoint: string;
  status: number;
  payload: ZoteroSaveItemsPayload;
}

export interface ZoteroBridge {
  readonly endpoint: string;
  ping(): Promise<ZoteroPingResult>;
  saveItems(
    items: readonly (RisRecord | Entry | CslJsonItem)[],
    options?: ZoteroSaveOptions,
  ): Promise<ZoteroSaveResult>;
}

export type ZoteroBridgeErrorCode =
  | 'invalid-endpoint'
  | 'non-loopback-host'
  | 'http-error'
  | 'network-error';

/** Error raised by the Zotero bridge for invalid endpoints, non-loopback hosts, or HTTP failures. */
export class ZoteroBridgeError extends Error {
  readonly code: ZoteroBridgeErrorCode;

  constructor(code: ZoteroBridgeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ZoteroBridgeError';
    this.code = code;
  }
}

// --- RIS parsing & serialization -------------------------------------------

interface ActiveRisBuilder {
  startLine: number;
  record: RisRecord;
  lastTag: string;
}

/**
 * Parses a RIS document into structured records without throwing on malformed lines.
 */
export function parseRis(text: string): RisParseResult {
  const source = typeof text === 'string' ? text.replace(/^\uFEFF/u, '') : '';
  const lines = source.split(/\r?\n/u);
  const records: RisRecord[] = [];
  const errors: RisError[] = [];

  let active: ActiveRisBuilder | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const rawLine = lines[i] ?? '';
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) continue;

    const match = RIS_LINE_RE.exec(rawLine.trimEnd());
    if (match !== null) {
      const tag = match[1] ?? '';
      const value = (match[2] ?? '').trim();

      if (tag === 'TY') {
        if (active !== null) {
          errors.push({
            code: 'unterminated-record',
            line: active.startLine,
            message: `RIS record starting at line ${active.startLine} was not closed with ER before a new TY.`,
          });
        }
        active = {
          startLine: lineNumber,
          record: {
            type: value.toUpperCase() || 'GEN',
            authors: [],
            keywords: [],
          },
          lastTag: 'TY',
        };
        continue;
      }

      if (active === null) {
        errors.push({
          code: 'tag-outside-record',
          line: lineNumber,
          message: `Tag \`${tag}\` at line ${lineNumber} appeared outside a TY..ER record.`,
        });
        continue;
      }

      if (tag === 'ER') {
        if (active.record.type.length === 0) {
          errors.push({
            code: 'missing-type',
            line: active.startLine,
            message: `RIS record at line ${active.startLine} has an empty TY tag.`,
          });
        } else {
          records.push(active.record);
        }
        active = null;
        continue;
      }

      applyRisTag(active.record, tag, value);
      active.lastTag = tag;
      continue;
    }

    if (active !== null && active.lastTag.length > 0 && active.lastTag !== 'TY') {
      appendContinuation(active.record, active.lastTag, trimmed);
      continue;
    }

    errors.push({
      code: 'malformed-line',
      line: lineNumber,
      message: `Line ${lineNumber} is not a valid RIS tag line.`,
    });
  }

  if (active !== null) {
    errors.push({
      code: 'unterminated-record',
      line: active.startLine,
      message: `RIS record starting at line ${active.startLine} reached end of file without ER.`,
    });
  }

  return { records, errors };
}

function applyRisTag(record: RisRecord, tag: string, value: string): void {
  if (value.length === 0) return;
  switch (tag) {
    case 'AU':
    case 'A1':
      record.authors.push(value);
      return;
    case 'TI':
      record.title = value;
      return;
    case 'T1':
      if (record.title === undefined) record.title = value;
      return;
    case 'JO':
      record.journal = value;
      return;
    case 'JF':
      if (record.journal === undefined) record.journal = value;
      return;
    case 'T2':
      record.secondaryTitle = value;
      return;
    case 'PY':
      record.year = normalizeRisYear(value);
      return;
    case 'Y1':
      if (record.year === undefined) record.year = normalizeRisYear(value);
      return;
    case 'VL':
      record.volume = value;
      return;
    case 'IS':
      record.issue = value;
      return;
    case 'SP':
      record.startPage = value;
      return;
    case 'EP':
      record.endPage = value;
      return;
    case 'DO':
      record.doi = normalizeDoi(value) ?? value;
      return;
    case 'UR':
      record.url = value;
      return;
    case 'AB':
      record.abstract = value;
      return;
    case 'N2':
      if (record.abstract === undefined) record.abstract = value;
      return;
    case 'KW':
      record.keywords.push(value);
      return;
    default:
      return;
  }
}

function appendContinuation(record: RisRecord, tag: string, extra: string): void {
  if (extra.length === 0) return;
  const join = (current: string | undefined): string =>
    current === undefined || current.length === 0 ? extra : `${current} ${extra}`;

  switch (tag) {
    case 'TI':
    case 'T1':
      record.title = join(record.title);
      return;
    case 'JO':
    case 'JF':
      record.journal = join(record.journal);
      return;
    case 'T2':
      record.secondaryTitle = join(record.secondaryTitle);
      return;
    case 'AB':
    case 'N2':
      record.abstract = join(record.abstract);
      return;
    default:
      return;
  }
}

function normalizeRisYear(raw: string): string {
  const match = /\b(\d{4})\b/u.exec(raw);
  return match?.[1] ?? raw.replace(/\/+$/u, '').trim();
}

/**
 * Serializes RIS records into canonical `TAG  - value` blocks separated by blank lines.
 */
export function serializeRis(records: readonly RisRecord[]): string {
  if (!Array.isArray(records) || records.length === 0) return '';

  const blocks = records.map(record => {
    const lines: string[] = [`TY  - ${(record.type || 'GEN').trim().toUpperCase()}`];
    for (const author of record.authors) {
      const cleaned = author.trim();
      if (cleaned.length > 0) lines.push(`AU  - ${cleaned}`);
    }
    pushTag(lines, 'TI', record.title);
    pushTag(lines, 'JO', record.journal);
    pushTag(lines, 'T2', record.secondaryTitle);
    pushTag(lines, 'PY', record.year);
    pushTag(lines, 'VL', record.volume);
    pushTag(lines, 'IS', record.issue);
    pushTag(lines, 'SP', record.startPage);
    pushTag(lines, 'EP', record.endPage);
    pushTag(lines, 'DO', record.doi !== undefined ? normalizeDoi(record.doi) ?? record.doi : undefined);
    pushTag(lines, 'UR', record.url);
    pushTag(lines, 'AB', record.abstract);
    for (const kw of record.keywords) {
      const cleaned = kw.trim();
      if (cleaned.length > 0) lines.push(`KW  - ${cleaned}`);
    }
    lines.push('ER  -');
    return lines.join('\n');
  });

  return `${blocks.join('\n\n')}\n`;
}

function pushTag(lines: string[], tag: string, value: string | undefined): void {
  if (value === undefined) return;
  const cleaned = value.replace(/\s+/gu, ' ').trim();
  if (cleaned.length > 0) lines.push(`${tag}  - ${cleaned}`);
}

// --- BibTeX conversion, stable keys & deduplication ------------------------

/** Converts one `RisRecord` into a BibTeX `Entry` with a deterministic `stableKey`. */
export function risToBibTeXEntry(
  record: RisRecord,
  siblingsBefore: readonly Entry[] = [],
): Entry {
  const entry = buildUnkeyedBibTeXEntry(record);
  entry.key = stableKey(entry, siblingsBefore);
  return entry;
}

/** Converts a batch of `RisRecord`s into BibTeX entries with collision-safe `stableKeys`. */
export function risToBibTeXEntries(records: readonly RisRecord[]): Entry[] {
  const unkeyed = records.map(buildUnkeyedBibTeXEntry);
  const keys = stableKeys(unkeyed);
  return unkeyed.map((entry, idx) => ({
    ...entry,
    key: keys[idx] ?? entry.key,
  }));
}

function buildUnkeyedBibTeXEntry(record: RisRecord): Entry {
  const risType = record.type.trim().toUpperCase();
  const type = RIS_TO_BIBTEX_TYPE[risType] ?? 'misc';
  const fields: Record<string, string> = {};

  if (record.authors.length > 0) fields.author = record.authors.join(' and ');
  if (record.title !== undefined && record.title.length > 0) fields.title = record.title;

  if (type === 'inproceedings' || type === 'incollection') {
    const venue = record.secondaryTitle ?? record.journal;
    if (venue !== undefined && venue.length > 0) fields.booktitle = venue;
  } else {
    const venue = record.journal ?? record.secondaryTitle;
    if (venue !== undefined && venue.length > 0) fields.journal = venue;
  }

  if (record.year !== undefined && record.year.length > 0) {
    fields.year = normalizeRisYear(record.year);
  }
  if (record.volume !== undefined && record.volume.length > 0) fields.volume = record.volume;
  if (record.issue !== undefined && record.issue.length > 0) fields.number = record.issue;

  const pages = formatPages(record.startPage, record.endPage, '--');
  if (pages !== undefined) fields.pages = pages;

  if (record.doi !== undefined && record.doi.length > 0) {
    fields.doi = normalizeDoi(record.doi) ?? record.doi;
  }
  if (record.url !== undefined && record.url.length > 0) fields.url = record.url;
  if (record.abstract !== undefined && record.abstract.length > 0) fields.abstract = record.abstract;
  if (record.keywords.length > 0) fields.keywords = record.keywords.join(', ');

  return { type, key: '', fields };
}

/** Converts a BibTeX `Entry` back into a `RisRecord`. */
export function bibTeXEntryToRis(entry: Entry): RisRecord {
  const bibType = entry.type.trim().toLowerCase();
  const type = BIBTEX_TO_RIS_TYPE[bibType] ?? 'GEN';
  const fields = entry.fields;

  const authors = splitBibTeXAuthors(fields.author ?? fields.editor ?? '');
  const { startPage, endPage } = splitPages(fields.pages ?? '');
  const rawYear = fields.year ?? fields.date;
  const rawDoi = fields.doi;

  const record: RisRecord = {
    type,
    authors,
    keywords: splitKeywords(fields.keywords ?? ''),
  };

  if (fields.title !== undefined && fields.title.length > 0) record.title = fields.title;
  if (fields.journal !== undefined && fields.journal.length > 0) record.journal = fields.journal;
  if (fields.booktitle !== undefined && fields.booktitle.length > 0) {
    record.secondaryTitle = fields.booktitle;
  }
  if (rawYear !== undefined && rawYear.length > 0) record.year = normalizeRisYear(rawYear);
  if (fields.volume !== undefined && fields.volume.length > 0) record.volume = fields.volume;
  if (fields.number !== undefined && fields.number.length > 0) record.issue = fields.number;
  if (startPage !== undefined) record.startPage = startPage;
  if (endPage !== undefined) record.endPage = endPage;
  if (rawDoi !== undefined && rawDoi.length > 0) record.doi = normalizeDoi(rawDoi) ?? rawDoi;
  if (fields.url !== undefined && fields.url.length > 0) record.url = fields.url;
  if (fields.abstract !== undefined && fields.abstract.length > 0) record.abstract = fields.abstract;

  return record;
}

/**
 * Deduplicates incoming RIS records against an existing BibTeX library via `bibtex.ts` `dedupe`,
 * preserving existing citation keys and disambiguating colliding keys among distinct works.
 */
export function dedupeWithBibTeX(
  risRecords: readonly RisRecord[],
  existingBibTeX: readonly Entry[] | string,
): RisBibTeXDedupeResult {
  const parsed =
    typeof existingBibTeX === 'string'
      ? parseBibTeX(existingBibTeX)
      : { entries: [...existingBibTeX], errors: [] as BibTeXError[] };

  const incomingEntries = assignIncomingKeys(risRecords);
  const combined = [...parsed.entries, ...incomingEntries];
  const result = dedupe(combined);

  const disambiguated = disambiguateRemainingKeys(result.entries);

  return {
    entries: disambiguated,
    merged: result.merged,
    conflicts: result.conflicts,
    parseErrors: parsed.errors,
    bibtex: toBibTeX(disambiguated),
  };
}

function assignIncomingKeys(risRecords: readonly RisRecord[]): Entry[] {
  const unkeyed = risRecords.map(buildUnkeyedBibTeXEntry);
  const firstIndexByDoi = new Map<string, number>();
  const keyLeaders: Entry[] = [];
  const leaderIndexByEntry = new Map<number, number>();

  unkeyed.forEach((entry, idx) => {
    const rawDoi = entry.fields.doi;
    const doi = rawDoi === undefined ? null : normalizeDoi(rawDoi);
    if (doi !== null) {
      const existingLeader = firstIndexByDoi.get(doi);
      if (existingLeader !== undefined) {
        leaderIndexByEntry.set(idx, existingLeader);
        return;
      }
      firstIndexByDoi.set(doi, keyLeaders.length);
    }
    leaderIndexByEntry.set(idx, keyLeaders.length);
    keyLeaders.push(entry);
  });

  const leaderKeys = stableKeys(keyLeaders);
  return unkeyed.map((entry, idx) => ({
    ...entry,
    key: leaderKeys[leaderIndexByEntry.get(idx) ?? 0] ?? entry.key,
  }));
}

function disambiguateRemainingKeys(entries: readonly Entry[]): Entry[] {
  const used = new Set<string>();
  return entries.map(entry => {
    const copy: Entry = { type: entry.type, key: entry.key, fields: { ...entry.fields } };
    if (used.has(copy.key)) {
      let step = 0;
      let candidate = copy.key;
      do {
        candidate = `${copy.key}${letterSuffix(step)}`;
        step++;
      } while (used.has(candidate));
      copy.key = candidate;
    }
    used.add(copy.key);
    return copy;
  });
}

function letterSuffix(step: number): string {
  let value = step;
  let suffix = '';
  do {
    suffix = `${String.fromCharCode(97 + (value % 26))}${suffix}`;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return suffix;
}

// --- CSL-JSON mapping ------------------------------------------------------

/** Maps a `RisRecord` to a CSL-JSON bibliographic item. */
export function risToCslJson(record: RisRecord, id?: string): CslJsonItem {
  const risType = record.type.trim().toUpperCase();
  const cslType: CslItemType = RIS_TO_CSL_TYPE[risType] ?? 'document';
  const entry = risToBibTeXEntry(record);

  const item: CslJsonItem = {
    id: id ?? entry.key,
    type: cslType,
  };

  if (record.title !== undefined && record.title.length > 0) item.title = record.title;
  if (record.authors.length > 0) item.author = record.authors.map(authorToCslName);

  const container =
    risType === 'CONF' || risType === 'CPAPER' || risType === 'CHAP'
      ? record.secondaryTitle ?? record.journal
      : record.journal ?? record.secondaryTitle;
  if (container !== undefined && container.length > 0) item['container-title'] = container;

  if (record.year !== undefined) {
    const issued = toCslDate(record.year);
    if (issued !== undefined) item.issued = issued;
  }
  if (record.volume !== undefined && record.volume.length > 0) item.volume = record.volume;
  if (record.issue !== undefined && record.issue.length > 0) item.issue = record.issue;

  const page = formatPages(record.startPage, record.endPage, '-');
  if (page !== undefined) item.page = page;

  if (record.doi !== undefined && record.doi.length > 0) {
    item.DOI = normalizeDoi(record.doi) ?? record.doi;
  }
  if (record.url !== undefined && record.url.length > 0) item.URL = record.url;
  if (record.abstract !== undefined && record.abstract.length > 0) item.abstract = record.abstract;
  if (record.keywords.length > 0) item.keyword = record.keywords.join(', ');

  return item;
}

/** Maps a BibTeX `Entry` to a CSL-JSON bibliographic item. */
export function bibTeXToCslJson(entry: Entry): CslJsonItem {
  const ris = bibTeXEntryToRis(entry);
  const item = risToCslJson(ris, entry.key);
  const bibType = entry.type.trim().toLowerCase();
  const cslType = BIBTEX_TO_CSL_TYPE[bibType];
  if (cslType !== undefined) item.type = cslType;
  return item;
}

/** Maps a CSL-JSON bibliographic item back into a `RisRecord`. */
export function cslJsonToRis(item: CslJsonItem): RisRecord {
  const risType = CSL_TO_RIS_TYPE[item.type] ?? 'GEN';
  const authors = (item.author ?? []).map(cslNameToDisplay).filter(name => name.length > 0);
  const { startPage, endPage } = splitPages(item.page ?? '');

  const record: RisRecord = {
    type: risType,
    authors,
    keywords: splitKeywords(item.keyword ?? ''),
  };

  if (item.title !== undefined && item.title.length > 0) record.title = item.title;

  if (item['container-title'] !== undefined && item['container-title'].length > 0) {
    if (risType === 'CONF' || risType === 'CPAPER' || risType === 'CHAP') {
      record.secondaryTitle = item['container-title'];
    } else {
      record.journal = item['container-title'];
    }
  }

  const year = cslDateYear(item.issued);
  if (year !== undefined) record.year = year;
  if (item.volume !== undefined && item.volume.length > 0) record.volume = item.volume;
  if (item.issue !== undefined && item.issue.length > 0) record.issue = item.issue;
  if (startPage !== undefined) record.startPage = startPage;
  if (endPage !== undefined) record.endPage = endPage;
  if (item.DOI !== undefined && item.DOI.length > 0) {
    record.doi = normalizeDoi(item.DOI) ?? item.DOI;
  }
  if (item.URL !== undefined && item.URL.length > 0) record.url = item.URL;
  if (item.abstract !== undefined && item.abstract.length > 0) record.abstract = item.abstract;

  return record;
}

function authorToCslName(author: string): CslName {
  const trimmed = author.trim();
  const comma = trimmed.indexOf(',');
  if (comma >= 0) {
    const family = trimmed.slice(0, comma).trim();
    const given = trimmed.slice(comma + 1).trim();
    const out: CslName = {};
    if (family.length > 0) out.family = family;
    if (given.length > 0) out.given = given;
    return out;
  }
  const parts = trimmed.split(/\s+/u).filter(Boolean);
  if (parts.length >= 2) {
    return {
      family: parts[parts.length - 1],
      given: parts.slice(0, -1).join(' '),
    };
  }
  return { literal: trimmed };
}

function cslNameToDisplay(name: CslName): string {
  if (name.literal !== undefined && name.literal.trim().length > 0) return name.literal.trim();
  const family = name.family?.trim() ?? '';
  const given = name.given?.trim() ?? '';
  if (family.length > 0 && given.length > 0) return `${family}, ${given}`;
  return family || given;
}

function toCslDate(yearRaw: string): CslDate | undefined {
  const match = /\b(\d{4})\b/u.exec(yearRaw);
  if (match?.[1] !== undefined) return { 'date-parts': [[Number(match[1])]] };
  const trimmed = yearRaw.trim();
  return trimmed.length > 0 ? { literal: trimmed } : undefined;
}

function cslDateYear(issued: CslDate | undefined): string | undefined {
  const firstYear = issued?.['date-parts']?.[0]?.[0];
  if (typeof firstYear === 'number' && Number.isFinite(firstYear)) {
    return String(Math.trunc(firstYear));
  }
  if (issued?.literal !== undefined) return normalizeRisYear(issued.literal);
  return undefined;
}

// --- Zotero local connector loopback guard & bridge ------------------------

/**
 * Validates that a Zotero endpoint targets strictly loopback `127.0.0.1` or `localhost`
 * over `http:`/`https:`, with no embedded credentials or remote/LAN/wildcard hostnames.
 */
export function assertLoopbackZoteroUrl(rawUrl: string): URL {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new ZoteroBridgeError('invalid-endpoint', 'Zotero endpoint URL must be a non-empty string.');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new ZoteroBridgeError('invalid-endpoint', `Invalid Zotero endpoint URL: ${rawUrl}`, {
      cause: error,
    });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ZoteroBridgeError(
      'invalid-endpoint',
      `Zotero endpoint must use http or https, found ${parsed.protocol}`,
    );
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new ZoteroBridgeError(
      'non-loopback-host',
      'Zotero endpoint URL must not carry userinfo credentials.',
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (classifyEndpoint(rawUrl) !== 'loopback' || (host !== '127.0.0.1' && host !== 'localhost')) {
    throw new ZoteroBridgeError(
      'non-loopback-host',
      `Refused non-loopback Zotero host \`${parsed.hostname}\`; only 127.0.0.1 and localhost are allowed.`,
    );
  }

  return parsed;
}

/** Converts RIS, BibTeX, or CSL-JSON items into Zotero `/connector/saveItems` JSON payload. */
export function buildZoteroSavePayload(
  items: readonly (RisRecord | Entry | CslJsonItem)[],
  options: ZoteroSaveOptions = {},
): ZoteroSaveItemsPayload {
  const zoteroItems = items.map(toZoteroConnectorItem);
  const payload: ZoteroSaveItemsPayload = {
    uri: options.uri ?? 'https://localhost/mirror-pdf',
    items: zoteroItems,
  };
  if (options.sessionId !== undefined) payload.sessionID = options.sessionId;
  return payload;
}

function toZoteroConnectorItem(source: RisRecord | Entry | CslJsonItem): ZoteroConnectorItem {
  if (isBibTeXEntry(source)) {
    return risToZoteroItem(bibTeXEntryToRis(source));
  }
  if (isCslJsonItem(source)) {
    return cslToZoteroItem(source);
  }
  return risToZoteroItem(source);
}

function risToZoteroItem(record: RisRecord): ZoteroConnectorItem {
  const risType = record.type.trim().toUpperCase();
  const itemType: ZoteroItemType = RIS_TO_ZOTERO_TYPE[risType] ?? 'document';
  const venue =
    itemType === 'conferencePaper' || itemType === 'bookSection'
      ? record.secondaryTitle ?? record.journal
      : record.journal ?? record.secondaryTitle;

  return buildZoteroItem({
    itemType,
    title: record.title,
    creators: record.authors.map(author => cslNameToZoteroCreator(authorToCslName(author))),
    venue,
    date: record.year,
    volume: record.volume,
    issue: record.issue,
    pages: formatPages(record.startPage, record.endPage, '-'),
    doi: record.doi,
    url: record.url,
    abstract: record.abstract,
    keywords: record.keywords,
  });
}

function cslToZoteroItem(csl: CslJsonItem): ZoteroConnectorItem {
  const itemType: ZoteroItemType = CSL_TO_ZOTERO_TYPE[csl.type] ?? 'document';
  return buildZoteroItem({
    itemType,
    title: csl.title,
    creators: (csl.author ?? []).map(cslNameToZoteroCreator),
    venue: csl['container-title'],
    date: cslDateYear(csl.issued),
    volume: csl.volume,
    issue: csl.issue,
    pages: csl.page,
    doi: csl.DOI,
    url: csl.URL,
    abstract: csl.abstract,
    keywords: splitKeywords(csl.keyword ?? ''),
  });
}

function buildZoteroItem(input: {
  itemType: ZoteroItemType;
  title?: string;
  creators: ZoteroCreator[];
  venue?: string;
  date?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  keywords: string[];
}): ZoteroConnectorItem {
  const item: ZoteroConnectorItem = {
    itemType: input.itemType,
    title: input.title ?? 'Untitled',
    creators: input.creators,
    tags: input.keywords.map(tag => ({ tag })),
  };

  if (input.venue !== undefined) {
    if (input.itemType === 'conferencePaper') item.proceedingsTitle = input.venue;
    else if (input.itemType === 'bookSection') item.bookTitle = input.venue;
    else item.publicationTitle = input.venue;
  }

  if (input.date !== undefined) item.date = input.date;
  if (input.volume !== undefined) item.volume = input.volume;
  if (input.issue !== undefined) item.issue = input.issue;
  if (input.pages !== undefined) item.pages = input.pages;
  if (input.doi !== undefined) item.DOI = normalizeDoi(input.doi) ?? input.doi;
  if (input.url !== undefined) item.url = input.url;
  if (input.abstract !== undefined) item.abstractNote = input.abstract;
  return item;
}

function cslNameToZoteroCreator(name: CslName): ZoteroCreator {
  if (name.literal !== undefined) {
    return { name: name.literal, creatorType: 'author' };
  }
  const creator: ZoteroCreator = { creatorType: 'author' };
  if (name.given !== undefined) creator.firstName = name.given;
  if (name.family !== undefined) creator.lastName = name.family;
  return creator;
}

function isBibTeXEntry(value: RisRecord | Entry | CslJsonItem): value is Entry {
  return 'key' in value && 'fields' in value;
}

function isCslJsonItem(value: RisRecord | Entry | CslJsonItem): value is CslJsonItem {
  return 'id' in value;
}

/**
 * Creates a Zotero local connector client locked to `127.0.0.1` / `localhost`.
 */
export function createZoteroBridge(options: ZoteroBridgeOptions = {}): ZoteroBridge {
  const validated = assertLoopbackZoteroUrl(options.endpoint ?? DEFAULT_ZOTERO_ENDPOINT);
  const origin = validated.origin;
  const guard = createGuard({
    policy: 'loopback',
    fetch: options.fetch,
  });

  async function sendLoopback(path: string, init: RequestInit): Promise<Response> {
    const target = `${origin}${path}`;
    assertLoopbackZoteroUrl(target);
    let response: Response;
    try {
      response = await guard.fetch(target, {
        ...init,
        redirect: 'error',
      });
    } catch (error) {
      if (error instanceof ZoteroBridgeError) throw error;
      throw new ZoteroBridgeError(
        'network-error',
        `Failed to reach local Zotero connector at ${target}.`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new ZoteroBridgeError(
        'http-error',
        `Local Zotero connector returned HTTP ${response.status} for ${path}.`,
      );
    }
    return response;
  }

  return {
    endpoint: origin,

    async ping(): Promise<ZoteroPingResult> {
      const response = await sendLoopback('/connector/ping', { method: 'GET' });
      return {
        ok: response.ok,
        endpoint: origin,
        status: response.status,
      };
    },

    async saveItems(
      items: readonly (RisRecord | Entry | CslJsonItem)[],
      saveOptions: ZoteroSaveOptions = {},
    ): Promise<ZoteroSaveResult> {
      const payload = buildZoteroSavePayload(items, saveOptions);
      const response = await sendLoopback('/connector/saveItems', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return {
        saved: payload.items.length,
        endpoint: origin,
        status: response.status,
        payload,
      };
    },
  };
}

// --- Small pure helpers ----------------------------------------------------

function formatPages(
  startPage: string | undefined,
  endPage: string | undefined,
  separator: string,
): string | undefined {
  const start = startPage?.trim() ?? '';
  const end = endPage?.trim() ?? '';
  if (start.length > 0 && end.length > 0) return `${start}${separator}${end}`;
  if (start.length > 0) return start;
  if (end.length > 0) return end;
  return undefined;
}

function splitPages(raw: string): { startPage?: string; endPage?: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  const match = /^(.+?)\s*(?:--|\u2013|-)\s*(.+)$/u.exec(trimmed);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { startPage: match[1].trim(), endPage: match[2].trim() };
  }
  return { startPage: trimmed };
}

function splitKeywords(raw: string): string[] {
  return raw
    .split(/[,;]+/u)
    .map(part => part.trim())
    .filter(part => part.length > 0);
}

function splitBibTeXAuthors(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let pos = 0;

  while (pos < trimmed.length) {
    const ch = trimmed.charAt(pos);
    if (ch === '{') {
      depth++;
      pos++;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) depth--;
      pos++;
      continue;
    }
    if (depth === 0 && /\s/u.test(ch)) {
      const sep = /^\s+and\s+/iu.exec(trimmed.slice(pos));
      if (sep !== null) {
        parts.push(trimmed.slice(start, pos));
        pos += sep[0].length;
        start = pos;
        continue;
      }
    }
    pos++;
  }
  parts.push(trimmed.slice(start));
  return parts.map(part => part.trim()).filter(part => part.length > 0);
}
