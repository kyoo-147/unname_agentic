import type { Entry } from '../bibtex';
import { stableKey } from '../bibtex';
import { normalizeDoi } from '../scholar';

export const RIS_SCHEMA_VERSION = 1;

export interface RisField {
  tag: string;
  value: string;
}

export interface RisRecord {
  type: string;
  fields: RisField[];
}

export interface RisParseError {
  line: number;
  message: string;
}

export interface RisParse {
  records: RisRecord[];
  errors: RisParseError[];
}

const TAGS = new Set(['TY', 'ER']);

export function parseRis(text: string): RisParse {
  const records: RisRecord[] = [];
  const errors: RisParseError[] = [];
  let current: RisRecord | undefined;
  const lines = String(text ?? '').split(/\r\n|\r|\n/u);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.trim().length === 0) return;
    const match = /^(\S{2})\s*[- ]\s?(.*)$/u.exec(line);
    if (!match) {
      errors.push({ line: lineNumber, message: 'RIS line must start with a two-character tag.' });
      return;
    }
    const tag = (match[1] ?? '').toUpperCase();
    const value = (match[2] ?? '').trimEnd();
    if (tag === 'TY') {
      if (current !== undefined) {
        errors.push({ line: lineNumber, message: 'A new TY appeared before the previous record ended.' });
        records.push(current);
      }
      current = { type: value || 'GEN', fields: [] };
      return;
    }
    if (current === undefined) {
      errors.push({ line: lineNumber, message: `RIS tag ${tag} appeared before TY.` });
      return;
    }
    if (tag === 'ER') {
      records.push(current);
      current = undefined;
      return;
    }
    current.fields.push({ tag, value });
  });

  if (current !== undefined) {
    errors.push({ line: lines.length, message: 'RIS record ended without ER; record was retained.' });
    records.push(current);
  }
  return { records, errors };
}

export function risToEntry(record: RisRecord, index = 0): Entry {
  const fields: Record<string, string> = {};
  const authors: string[] = [];
  const editors: string[] = [];
  const unknown: string[] = [];
  for (const field of record.fields) {
    switch (field.tag) {
      case 'AU':
      case 'A1':
        if (field.value) authors.push(field.value);
        break;
      case 'A2':
      case 'ED':
        if (field.value) editors.push(field.value);
        break;
      case 'TI':
      case 'T1':
        if (!fields.title) fields.title = field.value;
        break;
      case 'T2':
      case 'JO':
      case 'JF':
      case 'J2':
        if (!fields.journal) fields.journal = field.value;
        break;
      case 'BT':
      case 'T3':
        if (!fields.booktitle) fields.booktitle = field.value;
        break;
      case 'PY':
      case 'Y1':
      case 'DA':
        if (!fields.year) fields.year = field.value.slice(0, 4);
        break;
      case 'DO': {
        const doi = normalizeDoi(field.value);
        if (doi !== null) fields.doi = doi;
        break;
      }
      case 'UR':
      case 'L1':
        if (!fields.url) fields.url = field.value;
        break;
      case 'AB':
      case 'N2':
        if (!fields.abstract) fields.abstract = field.value;
        break;
      case 'VL':
        fields.volume = field.value;
        break;
      case 'IS':
        fields.number = field.value;
        break;
      case 'SP':
        fields.pages = field.value;
        break;
      case 'EP':
        fields.pages = fields.pages ? `${fields.pages}-${field.value}` : field.value;
        break;
      case 'KW':
        fields.keywords = fields.keywords ? `${fields.keywords}; ${field.value}` : field.value;
        break;
      default:
        unknown.push(`${field.tag}=${field.value}`);
    }
  }
  if (authors.length > 0) fields.author = authors.join(' and ');
  if (editors.length > 0) fields.editor = editors.join(' and ');
  if (unknown.length > 0) fields['ris-unknown'] = unknown.join(' | ');
  const entry: Entry = { type: risTypeToBibType(record.type), key: `ris${index + 1}`, fields };
  entry.key = stableKey(entry);
  return entry;
}

export function entriesFromRis(text: string): { entries: Entry[]; errors: RisParseError[] } {
  const parsed = parseRis(text);
  return { entries: parsed.records.map((record, index) => risToEntry(record, index)), errors: parsed.errors };
}

export function entryToRis(entry: Entry): RisRecord {
  const fields = entry.fields ?? {};
  const records: RisField[] = [{ tag: 'TY', value: bibTypeToRisType(entry.type) }];
  const authors = splitAuthors(fields.author ?? fields.editor ?? '');
  for (const author of authors) records.push({ tag: 'AU', value: author });
  if (fields.title) records.push({ tag: 'TI', value: plain(fields.title) });
  if (fields.journal) records.push({ tag: 'JO', value: plain(fields.journal) });
  if (fields.booktitle) records.push({ tag: 'T2', value: plain(fields.booktitle) });
  if (fields.year) records.push({ tag: 'PY', value: plain(fields.year) });
  if (fields.doi) records.push({ tag: 'DO', value: normalizeDoi(fields.doi) ?? plain(fields.doi) });
  if (fields.url) records.push({ tag: 'UR', value: plain(fields.url) });
  if (fields.abstract) records.push({ tag: 'AB', value: plain(fields.abstract) });
  if (fields.volume) records.push({ tag: 'VL', value: plain(fields.volume) });
  if (fields.number) records.push({ tag: 'IS', value: plain(fields.number) });
  if (fields.pages) records.push({ tag: 'SP', value: plain(fields.pages) });
  if (fields.keywords) for (const keyword of fields.keywords.split(/;\s*/u)) if (keyword) records.push({ tag: 'KW', value: keyword });
  records.push({ tag: 'ER', value: '' });
  return { type: records[0]?.value ?? 'GEN', fields: records.slice(1, -1) };
}

export function toRis(records: readonly RisRecord[]): string {
  return records.map(record => {
    const lines = [`TY  - ${record.type || 'GEN'}`];
    for (const field of record.fields) {
      if (field.tag === 'TY' || field.tag === 'ER') continue;
      lines.push(`${field.tag.padEnd(2, ' ')}  - ${field.value}`);
    }
    lines.push('ER  -', '');
    return lines.join('\n');
  }).join('\n');
}

export function entriesToRis(entries: readonly Entry[]): string {
  return toRis(entries.map(entryToRis));
}

function splitAuthors(value: string): string[] {
  return value.split(/\s+and\s+|\r\n|\r|\n/u).map(author => author.trim()).filter(Boolean);
}

function plain(value: string): string {
  return value.replace(/[{}]/gu, '').replace(/\s+/gu, ' ').trim();
}

function risTypeToBibType(type: string): string {
  switch (type.toUpperCase()) {
    case 'JOUR':
    case 'EJOUR':
      return 'article';
    case 'CONF':
      return 'inproceedings';
    case 'BOOK':
      return 'book';
    case 'THES':
      return 'phdthesis';
    case 'RPRT':
      return 'techreport';
    default:
      return 'misc';
  }
}

function bibTypeToRisType(type: string): string {
  switch (type.toLowerCase()) {
    case 'article':
      return 'JOUR';
    case 'inproceedings':
    case 'conference':
      return 'CONF';
    case 'book':
      return 'BOOK';
    case 'phdthesis':
      return 'THES';
    case 'techreport':
      return 'RPRT';
    default:
      return 'GEN';
  }
}
