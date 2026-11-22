/**
 * Exchange formats for glossary and translation memory (backlog item G15).
 *
 * Supports lossless UTF-8 import and export across:
 * - RFC 4180 CSV (glossary and translation memory)
 * - TMX 1.4b (translation memory and glossary)
 * - TBX-Basic (glossary: LISA `<martif type="TBX-Basic">` export/import, plus TBX v3 `<tbx type="TBX-Basic">` import)
 *
 * Contract:
 * - Pure and deterministic: no DOM, no network, no system clock reads, and no
 *   external runtime dependencies.
 * - Strict UTF-8 preservation: Vietnamese diacritics, CJK characters, emoji,
 *   multiline quoted CSV fields, and XML special characters (`&`, `<`, `>`,
 *   `"`, `'`) survive round-trips intact.
 * - Strict schema and 1-based line diagnostics: malformed CSV/XML or schema
 *   violations throw {@link TmExchangeError} with machine-readable `code`,
 *   `format`, `line`, optional `column`/`path`, and all collected `issues`,
 *   without partially mutating a target {@link TranslationMemory}.
 */

import {
  GLOSSARY_MAX_ENTRIES,
  GLOSSARY_MAX_SOURCE_CHARS,
  GLOSSARY_MAX_TARGET_CHARS,
  type GlossaryEntry,
} from './glossary';
import {
  TM_SCHEMA_VERSION,
  TranslationMemory,
  type TmEntry,
  type TmImportResult,
} from './tm';

// --- Public types and errors -----------------------------------------------

export type ExchangeFormat = 'csv' | 'tmx' | 'tbx';

export type ExchangeErrorCode =
  | 'empty-input'
  | 'malformed-csv'
  | 'malformed-xml'
  | 'invalid-schema'
  | 'missing-field'
  | 'invalid-field'
  | 'duplicate-id'
  | 'duplicate-term';

export interface ExchangeIssue {
  code: ExchangeErrorCode;
  format: ExchangeFormat;
  line: number;
  column?: number;
  path?: string;
  message: string;
}

export class TmExchangeError extends Error {
  readonly code: ExchangeErrorCode;
  readonly format: ExchangeFormat;
  readonly line: number;
  readonly column: number | undefined;
  readonly path: string;
  readonly issues: readonly ExchangeIssue[];

  constructor(issues: readonly ExchangeIssue[]) {
    const primary = issues[0] ?? {
      code: 'invalid-schema' as const,
      format: 'csv' as const,
      line: 1,
      message: 'Exchange validation failed.',
    };
    const loc = primary.column !== undefined ? `line ${primary.line}, col ${primary.column}` : `line ${primary.line}`;
    const prefix = primary.path ? `${primary.format.toUpperCase()} ${loc} (${primary.path})` : `${primary.format.toUpperCase()} ${loc}`;
    super(`${prefix}: ${primary.message}`);
    this.name = 'TmExchangeError';
    this.code = primary.code;
    this.format = primary.format;
    this.line = primary.line;
    this.column = primary.column;
    this.path = primary.path ?? '';
    this.issues = issues.map(issue => ({ ...issue }));
  }
}

export interface CsvOptions {
  /** Prepends UTF-8 BOM (`\uFEFF`) when exporting; defaults to `false`. */
  bom?: boolean;
}

export interface ParsedCsvRow {
  line: number;
  values: string[];
}

export interface ParsedCsv {
  headers: string[];
  rows: ParsedCsvRow[];
}

export interface GlossaryImportOptions {
  /** Override maximum entries allowed; defaults to {@link GLOSSARY_MAX_ENTRIES}. */
  maxEntries?: number;
  /** Allow duplicate source terms (case-insensitive); defaults to `false`. */
  allowDuplicates?: boolean;
}

export interface TbxExportOptions {
  sourceLang?: string;
  targetLang?: string;
  description?: string;
}

export interface TbxImportOptions extends GlossaryImportOptions {
  sourceLang?: string;
  targetLang?: string;
}

export interface TbxGlossaryImportResult {
  entries: GlossaryEntry[];
  sourceLang: string;
  targetLang: string;
}

export type TmxSegType = 'block' | 'paragraph' | 'sentence' | 'phrase';

export interface TmxExportOptions {
  sourceLang?: string;
  creationTool?: string;
  creationToolVersion?: string;
  segType?: TmxSegType;
  adminLang?: string;
}

export interface TmExchangeImportOptions {
  defaultEngine?: string;
  defaultCreatedAt?: number;
}

export interface TmxImportOptions extends TmExchangeImportOptions {
  sourceLang?: string;
  targetLang?: string;
}

export interface GlossaryTmxExportOptions extends TmxExportOptions {
  targetLang?: string;
}

export interface GlossaryTmxImportOptions extends GlossaryImportOptions {
  sourceLang?: string;
  targetLang?: string;
}

// --- Constants -------------------------------------------------------------

const UTF8_BOM = '\uFEFF';
const GLOSSARY_CSV_REQUIRED = ['source', 'target'] as const;
const GLOSSARY_CSV_ALLOWED = new Set(['source', 'target', 'sourceLang', 'targetLang', 'note']);

const TM_CSV_ALL_HEADERS = [
  'id',
  'source',
  'target',
  'sourceLang',
  'targetLang',
  'engine',
  'model',
  'createdAt',
  'uses',
] as const;
const TM_CSV_ALLOWED = new Set<string>(TM_CSV_ALL_HEADERS);

const TMX_SEG_TYPES = new Set<string>(['block', 'paragraph', 'sentence', 'phrase']);
const TMX_REQUIRED_HEADER_ATTRS = [
  'creationtool',
  'creationtoolversion',
  'segtype',
  'o-tmf',
  'adminlang',
  'srclang',
  'datatype',
] as const;
const TMX_INLINE_TAGS = new Set(['bpt', 'ept', 'ph', 'it', 'ut', 'hi', 'sub']);

const XML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const XML_NAME_PATTERN = /^[A-Za-z_:][A-Za-z0-9._:-]*$/u;
const TMX_BASIC_DATE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u;
const ISO_DATE_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/u;

// --- Error helpers ---------------------------------------------------------

function failOne(issue: ExchangeIssue): never {
  throw new TmExchangeError([issue]);
}

function failIfAny(issues: readonly ExchangeIssue[]): void {
  if (issues.length > 0) throw new TmExchangeError(issues);
}

// --- RFC 4180 CSV formatter & parser ---------------------------------------

function formatCsvField(value: string): string {
  if (/[",\r\n]/u.test(value)) {
    return `"${value.replace(/"/gu, '""')}"`;
  }
  return value;
}

export function formatCsvRow(fields: readonly string[]): string {
  return fields.map(formatCsvField).join(',');
}

export function formatCsv(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  options: CsvOptions = {},
): string {
  const lines = [formatCsvRow(headers), ...rows.map(row => formatCsvRow(row))];
  const body = `${lines.join('\r\n')}\r\n`;
  return options.bom ? `${UTF8_BOM}${body}` : body;
}

export function parseCsv(text: string): ParsedCsv {
  if (typeof text !== 'string') {
    failOne({ code: 'malformed-csv', format: 'csv', line: 1, message: 'CSV input must be a string.' });
  }
  const input = text.startsWith(UTF8_BOM) ? text.slice(1) : text;
  if (input.trim().length === 0) {
    failOne({ code: 'empty-input', format: 'csv', line: 1, message: 'CSV input is empty.' });
  }

  const rawRows: ParsedCsvRow[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const advanceLine = (ch: string): void => {
    if (ch === '\r' && input[index + 1] === '\n') {
      index += 2;
    } else {
      index += 1;
    }
    line += 1;
    column = 1;
  };

  while (index < input.length) {
    const rowStartLine = line;
    const values: string[] = [];

    while (true) {
      if (input[index] === '"') {
        const quoteLine = line;
        index += 1;
        column += 1;
        let field = '';
        let closed = false;

        while (index < input.length) {
          const ch = input[index]!;
          if (ch === '"') {
            if (input[index + 1] === '"') {
              field += '"';
              index += 2;
              column += 2;
              continue;
            }
            index += 1;
            column += 1;
            closed = true;
            break;
          }
          if (ch === '\r' || ch === '\n') {
            if (ch === '\r' && input[index + 1] === '\n') {
              field += '\r\n';
              index += 2;
            } else {
              field += ch;
              index += 1;
            }
            line += 1;
            column = 1;
            continue;
          }
          field += ch;
          index += 1;
          column += 1;
        }

        if (!closed) {
          failOne({
            code: 'malformed-csv',
            format: 'csv',
            line: quoteLine,
            message: 'Unterminated quoted CSV field.',
          });
        }
        values.push(field);

        const next = input[index];
        if (next === ',') {
          index += 1;
          column += 1;
          if (index === input.length) {
            values.push('');
            break;
          }
          continue;
        }
        if (next === '\r' || next === '\n') {
          advanceLine(next);
          break;
        }
        if (next === undefined) {
          break;
        }
        failOne({
          code: 'malformed-csv',
          format: 'csv',
          line,
          column,
          message: `Unexpected character "${next}" after closing quote.`,
        });
      } else {
        let field = '';
        while (index < input.length) {
          const ch = input[index]!;
          if (ch === ',') {
            break;
          }
          if (ch === '\r' || ch === '\n') {
            break;
          }
          if (ch === '"') {
            failOne({
              code: 'malformed-csv',
              format: 'csv',
              line,
              column,
              message: 'Unescaped quote inside unquoted CSV field.',
            });
          }
          field += ch;
          index += 1;
          column += 1;
        }
        values.push(field);

        const next = input[index];
        if (next === ',') {
          index += 1;
          column += 1;
          if (index === input.length) {
            values.push('');
            break;
          }
          continue;
        }
        if (next === '\r' || next === '\n') {
          advanceLine(next);
          break;
        }
        break;
      }
    }

    rawRows.push({ line: rowStartLine, values });
  }

  const headerRow = rawRows[0];
  if (!headerRow || headerRow.values.length === 0) {
    failOne({ code: 'empty-input', format: 'csv', line: 1, message: 'Missing CSV header row.' });
  }

  const headers = headerRow.values.map(name => name.trim());
  const rows = rawRows.slice(1);
  for (const row of rows) {
    if (row.values.length !== headers.length) {
      failOne({
        code: 'invalid-schema',
        format: 'csv',
        line: row.line,
        message: `Expected ${headers.length} columns, got ${row.values.length}.`,
      });
    }
  }

  return { headers, rows };
}

function indexCsvHeaders(
  headers: readonly string[],
  required: readonly string[],
  allowed: ReadonlySet<string>,
): Map<string, number> {
  const indexByName = new Map<string, number>();
  headers.forEach((name, idx) => {
    if (!name) {
      failOne({ code: 'invalid-schema', format: 'csv', line: 1, message: `Empty column name at column ${idx + 1}.` });
    }
    if (!allowed.has(name)) {
      failOne({ code: 'invalid-schema', format: 'csv', line: 1, path: name, message: `Unknown CSV column "${name}".` });
    }
    if (indexByName.has(name)) {
      failOne({ code: 'invalid-schema', format: 'csv', line: 1, path: name, message: `Duplicate CSV column "${name}".` });
    }
    indexByName.set(name, idx);
  });

  for (const req of required) {
    if (!indexByName.has(req)) {
      failOne({
        code: 'invalid-schema',
        format: 'csv',
        line: 1,
        path: req,
        message: `Missing required CSV column "${req}".`,
      });
    }
  }
  return indexByName;
}

// --- XML parser and escaping (UTF-8, line-tracked) -------------------------

interface XmlNodeText {
  kind: 'text';
  text: string;
  line: number;
}

interface XmlElement {
  kind: 'element';
  name: string;
  attrs: Record<string, string>;
  children: Array<XmlElement | XmlNodeText>;
  line: number;
  column: number;
}

function isValidXmlCodePoint(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function assertValidXmlChars(text: string, format: ExchangeFormat, line = 1): void {
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    if (!isValidXmlCodePoint(cp)) {
      failOne({
        code: format === 'csv' ? 'invalid-field' : 'malformed-xml',
        format,
        line,
        message: `Invalid XML 1.0 character U+${cp.toString(16).toUpperCase().padStart(4, '0')}.`,
      });
    }
    i += cp > 0xffff ? 2 : 1;
  }
}

function escapeXml(value: string, format: ExchangeFormat): string {
  assertValidXmlChars(value, format);
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

const escapeXmlText = escapeXml;
const escapeXmlAttr = escapeXml;

function decodeXmlEntities(raw: string, format: ExchangeFormat, startLine: number, startColumn: number): string {
  let out = '';
  let line = startLine;
  let column = startColumn;
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch !== '&') {
      out += ch;
      if (ch === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      i += 1;
      continue;
    }

    const semi = raw.indexOf(';', i + 1);
    if (semi < 0) {
      failOne({
        code: 'malformed-xml',
        format,
        line,
        column,
        message: 'Unterminated XML entity reference.',
      });
    }
    const ref = raw.slice(i + 1, semi);
    if (ref.startsWith('#x') || ref.startsWith('#X')) {
      const hex = ref.slice(2);
      if (!/^[0-9A-Fa-f]+$/u.test(hex)) {
        failOne({ code: 'malformed-xml', format, line, column, message: `Invalid hex character reference "&${ref};".` });
      }
      const cp = Number.parseInt(hex, 16);
      if (!Number.isSafeInteger(cp) || !isValidXmlCodePoint(cp)) {
        failOne({ code: 'malformed-xml', format, line, column, message: `Invalid XML character code point "&${ref};".` });
      }
      out += String.fromCodePoint(cp);
    } else if (ref.startsWith('#')) {
      const dec = ref.slice(1);
      if (!/^\d+$/u.test(dec)) {
        failOne({ code: 'malformed-xml', format, line, column, message: `Invalid numeric character reference "&${ref};".` });
      }
      const cp = Number.parseInt(dec, 10);
      if (!Number.isSafeInteger(cp) || !isValidXmlCodePoint(cp)) {
        failOne({ code: 'malformed-xml', format, line, column, message: `Invalid XML character code point "&${ref};".` });
      }
      out += String.fromCodePoint(cp);
    } else {
      const mapped = XML_ENTITY_MAP[ref];
      if (mapped === undefined) {
        failOne({ code: 'malformed-xml', format, line, column, message: `Unknown XML entity "&${ref};".` });
      }
      out += mapped;
    }

    const step = semi - i + 1;
    column += step;
    i = semi + 1;
  }

  return out;
}

function parseXml(xmlText: string, format: ExchangeFormat): XmlElement {
  if (typeof xmlText !== 'string') {
    failOne({ code: 'malformed-xml', format, line: 1, message: 'XML input must be a string.' });
  }
  const source = xmlText.startsWith(UTF8_BOM) ? xmlText.slice(1) : xmlText;
  if (source.trim().length === 0) {
    failOne({ code: 'empty-input', format, line: 1, message: 'XML input is empty.' });
  }

  let index = 0;
  let line = 1;
  let column = 1;

  const advance = (count = 1): void => {
    for (let n = 0; n < count; n += 1) {
      const ch = source[index];
      if (ch === undefined) return;
      index += 1;
      if (ch === '\r') {
        if (source[index] === '\n') index += 1;
        line += 1;
        column = 1;
      } else if (ch === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
  };

  const startsWith = (token: string): boolean => source.startsWith(token, index);

  const isSpace = (ch: string | undefined): boolean =>
    ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

  const skipWhitespace = (): boolean => {
    const before = index;
    while (index < source.length && isSpace(source[index])) advance();
    return index > before;
  };

  const readName = (): string => {
    const start = index;
    while (index < source.length) {
      const ch = source[index]!;
      if (isSpace(ch) || ch === '>' || ch === '/' || ch === '=' || ch === '<' || ch === '?') break;
      advance();
    }
    const name = source.slice(start, index);
    if (!XML_NAME_PATTERN.test(name)) {
      failOne({ code: 'malformed-xml', format, line, column, message: `Invalid XML name "${name}".` });
    }
    return name;
  };

  const readAttributes = (tagLine: number, stopChar: '>' | '?'): { attrs: Record<string, string>; selfClosing: boolean } => {
    const attrs: Record<string, string> = {};
    while (index < source.length) {
      const hadSpace = skipWhitespace();
      if (stopChar === '?' && startsWith('?>')) {
        advance(2);
        return { attrs, selfClosing: true };
      }
      if (stopChar === '>' && startsWith('/>')) {
        advance(2);
        return { attrs, selfClosing: true };
      }
      if (stopChar === '>' && source[index] === '>') {
        advance();
        return { attrs, selfClosing: false };
      }
      if (Object.keys(attrs).length > 0 && !hadSpace) {
        failOne({
          code: 'malformed-xml',
          format,
          line,
          column,
          message: 'Missing whitespace between XML attributes.',
        });
      }
      if (Object.keys(attrs).length === 0 && !hadSpace) {
        failOne({
          code: 'malformed-xml',
          format,
          line,
          column,
          message: 'Missing whitespace before XML attribute.',
        });
      }
      const attrName = readName();
      if (Object.prototype.hasOwnProperty.call(attrs, attrName)) {
        failOne({
          code: 'malformed-xml',
          format,
          line,
          column,
          message: `Duplicate attribute "${attrName}".`,
        });
      }
      skipWhitespace();
      if (source[index] !== '=') {
        failOne({
          code: 'malformed-xml',
          format,
          line,
          column,
          message: `Expected "=" after attribute "${attrName}".`,
        });
      }
      advance();
      skipWhitespace();
      const quote = source[index];
      if (quote !== '"' && quote !== "'") {
        failOne({
          code: 'malformed-xml',
          format,
          line,
          column,
          message: `Expected quoted value for attribute "${attrName}".`,
        });
      }
      const valLine = line;
      const valCol = column + 1;
      advance();
      const valStart = index;
      let closed = false;
      while (index < source.length) {
        const ch = source[index]!;
        if (ch === quote) {
          closed = true;
          break;
        }
        if (ch === '<') {
          failOne({
            code: 'malformed-xml',
            format,
            line,
            column,
            message: `Unescaped "<" in attribute "${attrName}".`,
          });
        }
        const cp = ch.codePointAt(0)!;
        if (!isValidXmlCodePoint(cp)) {
          failOne({
            code: 'malformed-xml',
            format,
            line,
            column,
            message: `Invalid control character in attribute "${attrName}".`,
          });
        }
        advance();
      }
      if (!closed) {
        failOne({
          code: 'malformed-xml',
          format,
          line: valLine,
          message: `Unterminated value for attribute "${attrName}".`,
        });
      }
      const rawValue = source.slice(valStart, index);
      advance();
      attrs[attrName] = decodeXmlEntities(rawValue, format, valLine, valCol);
    }

    failOne({
      code: 'malformed-xml',
      format,
      line: tagLine,
      message: 'Unterminated XML start tag.',
    });
  };

  const skipComment = (): void => {
    const startLine = line;
    advance(4); // <!--
    while (index < source.length) {
      if (startsWith('-->')) {
        advance(3);
        return;
      }
      if (startsWith('--')) {
        failOne({
          code: 'malformed-xml',
          format,
          line,
          column,
          message: '"--" is not allowed inside an XML comment.',
        });
      }
      advance();
    }
    failOne({
      code: 'malformed-xml',
      format,
      line: startLine,
      message: 'Unterminated XML comment.',
    });
  };

  const skipDoctype = (): void => {
    const startLine = line;
    advance(9); // <!DOCTYPE
    let quote: string | null = null;
    while (index < source.length) {
      const ch = source[index]!;
      if (quote) {
        if (ch === quote) quote = null;
        advance();
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        advance();
        continue;
      }
      if (ch === '[') {
        failOne({
          code: 'malformed-xml',
          format,
          line,
          column,
          message: 'Internal DTD subsets and entity declarations are not permitted.',
        });
      }
      if (ch === '>') {
        advance();
        return;
      }
      advance();
    }
    failOne({
      code: 'malformed-xml',
      format,
      line: startLine,
      message: 'Unterminated DOCTYPE declaration.',
    });
  };

  const readCdata = (): XmlNodeText => {
    const startLine = line;
    advance(9); // <![CDATA[
    const dataStart = index;
    while (index < source.length) {
      if (startsWith(']]>')) {
        const text = source.slice(dataStart, index);
        assertValidXmlChars(text, format, startLine);
        advance(3);
        return { kind: 'text', text, line: startLine };
      }
      advance();
    }
    failOne({
      code: 'malformed-xml',
      format,
      line: startLine,
      message: 'Unterminated CDATA section.',
    });
  };

  if (startsWith('<?xml')) {
    const declLine = line;
    advance(5);
    const { attrs } = readAttributes(declLine, '?');
    if (attrs.version !== undefined && attrs.version !== '1.0' && attrs.version !== '1.1') {
      failOne({
        code: 'malformed-xml',
        format,
        line: declLine,
        message: `Unsupported XML version "${attrs.version}".`,
      });
    }
    if (attrs.encoding !== undefined && attrs.encoding.toLowerCase() !== 'utf-8' && attrs.encoding.toLowerCase() !== 'utf8') {
      failOne({
        code: 'malformed-xml',
        format,
        line: declLine,
        message: `Unsupported XML encoding "${attrs.encoding}"; only UTF-8 is accepted.`,
      });
    }
  }

  let root: XmlElement | null = null;
  const stack: XmlElement[] = [];

  while (index < source.length) {
    if (source[index] !== '<') {
      const textLine = line;
      const textCol = column;
      const textStart = index;
      while (index < source.length && source[index] !== '<') {
        const ch = source[index]!;
        const cp = ch.codePointAt(0)!;
        if (!isValidXmlCodePoint(cp)) {
          failOne({
            code: 'malformed-xml',
            format,
            line,
            column,
            message: 'Invalid XML 1.0 control character in text.',
          });
        }
        advance();
      }
      const rawText = source.slice(textStart, index);
      const current = stack[stack.length - 1];
      if (!current) {
        if (rawText.trim().length > 0) {
          failOne({
            code: 'malformed-xml',
            format,
            line: textLine,
            column: textCol,
            message: 'Unexpected text outside root XML element.',
          });
        }
        continue;
      }
      const decoded = decodeXmlEntities(rawText, format, textLine, textCol);
      current.children.push({ kind: 'text', text: decoded, line: textLine });
      continue;
    }

    if (startsWith('<!--')) {
      skipComment();
      continue;
    }
    if (startsWith('<![CDATA[')) {
      const current = stack[stack.length - 1];
      if (!current) {
        failOne({
          code: 'malformed-xml',
          format,
          line,
          column,
          message: 'CDATA section is not allowed outside root element.',
        });
      }
      current.children.push(readCdata());
      continue;
    }
    if (startsWith('<!DOCTYPE')) {
      if (root !== null || stack.length > 0) {
        failOne({
          code: 'malformed-xml',
          format,
          line,
          column,
          message: 'DOCTYPE declaration must appear before the root element.',
        });
      }
      skipDoctype();
      continue;
    }
    if (startsWith('<!')) {
      failOne({
        code: 'malformed-xml',
        format,
        line,
        column,
        message: 'Unsupported XML declaration or entity construct.',
      });
    }
    if (startsWith('<?')) {
      failOne({
        code: 'malformed-xml',
        format,
        line,
        column,
        message: 'Unexpected XML processing instruction.',
      });
    }
    if (startsWith('</')) {
      const closeLine = line;
      const closeCol = column;
      advance(2);
      const name = readName();
      skipWhitespace();
      if (source[index] !== '>') {
        failOne({
          code: 'malformed-xml',
          format,
          line,
          column,
          message: `Expected ">" in closing tag "</${name}>".`,
        });
      }
      advance();
      const top = stack.pop();
      if (!top) {
        failOne({
          code: 'malformed-xml',
          format,
          line: closeLine,
          column: closeCol,
          message: `Unexpected closing tag "</${name}>".`,
        });
      }
      if (top.name !== name) {
        failOne({
          code: 'malformed-xml',
          format,
          line: closeLine,
          column: closeCol,
          message: `Mismatched closing tag "</${name}>" for "<${top.name}>" opened at line ${top.line}.`,
        });
      }
      continue;
    }

    // Start tag
    const tagLine = line;
    const tagCol = column;
    advance(); // <
    const name = readName();
    const { attrs, selfClosing } = readAttributes(tagLine, '>');
    const element: XmlElement = { kind: 'element', name, attrs, children: [], line: tagLine, column: tagCol };

    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(element);
    } else {
      if (root !== null) {
        failOne({
          code: 'malformed-xml',
          format,
          line: tagLine,
          column: tagCol,
          message: `Multiple root XML elements ("<${name}>").`,
        });
      }
      root = element;
    }
    if (!selfClosing) {
      stack.push(element);
    }
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1]!;
    failOne({
      code: 'malformed-xml',
      format,
      line: unclosed.line,
      column: unclosed.column,
      message: `Unclosed XML element "<${unclosed.name}>".`,
    });
  }
  if (!root) {
    failOne({ code: 'empty-input', format, line: 1, message: 'XML document has no root element.' });
  }
  return root;
}

function childElements(el: XmlElement, name?: string): XmlElement[] {
  const result: XmlElement[] = [];
  for (const child of el.children) {
    if (child.kind !== 'element') continue;
    if (name === undefined || child.name === name) result.push(child);
  }
  return result;
}

function textContent(el: XmlElement): string {
  let text = '';
  for (const child of el.children) {
    text += child.kind === 'text' ? child.text : textContent(child);
  }
  return text;
}

// --- Shared validation helpers ---------------------------------------------

interface LocatedGlossaryInput {
  source: string;
  target: string;
  line: number;
}

function validateGlossaryItems(
  items: readonly LocatedGlossaryInput[],
  format: ExchangeFormat,
  options: GlossaryImportOptions = {},
): GlossaryEntry[] {
  const maxEntries = options.maxEntries ?? GLOSSARY_MAX_ENTRIES;
  const allowDuplicates = options.allowDuplicates ?? false;
  const entries: GlossaryEntry[] = [];
  const issues: ExchangeIssue[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (item.source.trim().length === 0) {
      issues.push({
        code: 'missing-field',
        format,
        line: item.line,
        path: 'source',
        message: 'Glossary source term cannot be empty.',
      });
      continue;
    }
    if (item.target.trim().length === 0) {
      issues.push({
        code: 'missing-field',
        format,
        line: item.line,
        path: 'target',
        message: 'Glossary target term cannot be empty.',
      });
      continue;
    }
    if (item.source.length > GLOSSARY_MAX_SOURCE_CHARS) {
      issues.push({
        code: 'invalid-field',
        format,
        line: item.line,
        path: 'source',
        message: `Glossary source term exceeds ${GLOSSARY_MAX_SOURCE_CHARS} characters.`,
      });
      continue;
    }
    if (item.target.length > GLOSSARY_MAX_TARGET_CHARS) {
      issues.push({
        code: 'invalid-field',
        format,
        line: item.line,
        path: 'target',
        message: `Glossary target term exceeds ${GLOSSARY_MAX_TARGET_CHARS} characters.`,
      });
      continue;
    }
    const key = item.source.toLowerCase();
    if (!allowDuplicates && seen.has(key)) {
      issues.push({
        code: 'duplicate-term',
        format,
        line: item.line,
        path: 'source',
        message: `Duplicate glossary source term "${item.source}".`,
      });
      continue;
    }
    if (entries.length >= maxEntries) {
      issues.push({
        code: 'invalid-field',
        format,
        line: item.line,
        path: 'entries',
        message: `Glossary exceeds maximum of ${maxEntries} entries.`,
      });
      break;
    }
    seen.add(key);
    entries.push({ source: item.source, target: item.target });
  }

  failIfAny(issues);
  return entries;
}

function entriesFromMemoryOrArray(source: TranslationMemory | readonly TmEntry[]): TmEntry[] {
  if (source instanceof TranslationMemory) {
    const parsed = JSON.parse(source.exportJson()) as { entries: TmEntry[] };
    return parsed.entries;
  }
  return source.map(entry => ({ ...entry }));
}

function existingIdsOf(memory: TranslationMemory): Set<string> {
  const parsed = JSON.parse(memory.exportJson()) as { entries: TmEntry[] };
  return new Set(parsed.entries.map(entry => entry.id));
}

function importEntriesIntoMemory(
  memory: TranslationMemory,
  locatedEntries: ReadonlyArray<{ entry: TmEntry; line: number }>,
  format: ExchangeFormat,
): TmImportResult {
  const existing = existingIdsOf(memory);
  for (const { entry, line } of locatedEntries) {
    if (existing.has(entry.id)) {
      failOne({
        code: 'duplicate-id',
        format,
        line,
        path: 'id',
        message: `TM entry id "${entry.id}" already exists in translation memory.`,
      });
    }
  }
  const payload = JSON.stringify({
    schemaVersion: TM_SCHEMA_VERSION,
    kind: 'translation-memory',
    entries: locatedEntries.map(item => item.entry),
  });
  return memory.importJson(payload);
}

function normalizeLang(lang: string | undefined, fallback: string, format: ExchangeFormat, line = 1): string {
  const value = (lang ?? fallback).trim().toLowerCase();
  if (!value) {
    failOne({
      code: 'invalid-field',
      format,
      line,
      path: 'lang',
      message: 'Language tag cannot be blank.',
    });
  }
  return value;
}

function parseNonNegativeInt(raw: string, format: ExchangeFormat, line: number, path: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) {
    failOne({
      code: 'invalid-field',
      format,
      line,
      path,
      message: `${path} must be a non-negative integer, got "${raw}".`,
    });
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num < 0) {
    failOne({
      code: 'invalid-field',
      format,
      line,
      path,
      message: `${path} is out of safe integer range.`,
    });
  }
  return num;
}

// --- Glossary CSV ----------------------------------------------------------

export function exportGlossaryCsv(entries: readonly GlossaryEntry[], options: CsvOptions = {}): string {
  const rows = entries.map(entry => [entry.source, entry.target]);
  return formatCsv(GLOSSARY_CSV_REQUIRED, rows, options);
}

export function importGlossaryCsv(csv: string, options: GlossaryImportOptions = {}): GlossaryEntry[] {
  const parsed = parseCsv(csv);
  const colIndex = indexCsvHeaders(parsed.headers, GLOSSARY_CSV_REQUIRED, GLOSSARY_CSV_ALLOWED);
  const sourceIdx = colIndex.get('source')!;
  const targetIdx = colIndex.get('target')!;

  const items: LocatedGlossaryInput[] = parsed.rows.map(row => ({
    source: row.values[sourceIdx] ?? '',
    target: row.values[targetIdx] ?? '',
    line: row.line,
  }));

  return validateGlossaryItems(items, 'csv', options);
}

// --- Glossary TBX-Basic ----------------------------------------------------

export function exportGlossaryTbx(entries: readonly GlossaryEntry[], options: TbxExportOptions = {}): string {
  const sourceLang = normalizeLang(options.sourceLang, 'en', 'tbx');
  const targetLang = normalizeLang(options.targetLang, 'vi', 'tbx');
  const description = (options.description ?? 'MirrorPDF Glossary').trim() || 'MirrorPDF Glossary';

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<martif type="TBX-Basic" xml:lang="${escapeXmlAttr(sourceLang, 'tbx')}">`,
    '  <martifHeader>',
    '    <fileDesc>',
    '      <sourceDesc>',
    `        <p>${escapeXmlText(description, 'tbx')}</p>`,
    '      </sourceDesc>',
    '    </fileDesc>',
    '    <encodingDesc>',
    '      <p type="XCSURI">TBXBasicXCSV02.xcs</p>',
    '    </encodingDesc>',
    '  </martifHeader>',
    '  <text>',
    '    <body>',
  ];

  entries.forEach((entry, idx) => {
    lines.push(`      <termEntry id="term-${idx + 1}">`);
    lines.push(`        <langSet xml:lang="${escapeXmlAttr(sourceLang, 'tbx')}">`);
    lines.push('          <tig>');
    lines.push(`            <term>${escapeXmlText(entry.source, 'tbx')}</term>`);
    lines.push('          </tig>');
    lines.push('        </langSet>');
    lines.push(`        <langSet xml:lang="${escapeXmlAttr(targetLang, 'tbx')}">`);
    lines.push('          <tig>');
    lines.push(`            <term>${escapeXmlText(entry.target, 'tbx')}</term>`);
    lines.push('          </tig>');
    lines.push('        </langSet>');
    lines.push('      </termEntry>');
  });

  lines.push('    </body>', '  </text>', '</martif>');
  return `${lines.join('\n')}\n`;
}

function extractTbxTermText(langNode: XmlElement, isV3: boolean): string | null {
  if (isV3) {
    const termSec = childElements(langNode, 'termSec')[0];
    const term = termSec ? childElements(termSec, 'term')[0] : childElements(langNode, 'term')[0];
    return term ? textContent(term) : null;
  }
  const tig = childElements(langNode, 'tig')[0];
  if (tig) {
    const term = childElements(tig, 'term')[0];
    return term ? textContent(term) : null;
  }
  const ntig = childElements(langNode, 'ntig')[0];
  const termGrp = ntig ? childElements(ntig, 'termGrp')[0] : undefined;
  const term = termGrp ? childElements(termGrp, 'term')[0] : undefined;
  return term ? textContent(term) : null;
}

export function importGlossaryTbx(tbx: string, options: TbxImportOptions = {}): TbxGlossaryImportResult {
  const root = parseXml(tbx, 'tbx');
  const isMartif = root.name === 'martif';
  const isTbxV3 = root.name === 'tbx';
  if (!isMartif && !isTbxV3) {
    failOne({
      code: 'invalid-schema',
      format: 'tbx',
      line: root.line,
      path: root.name,
      message: `Expected root "<martif>" or "<tbx>", got "<${root.name}>".`,
    });
  }

  const rootType = root.attrs.type;
  if (rootType !== 'TBX-Basic') {
    failOne({
      code: 'invalid-schema',
      format: 'tbx',
      line: root.line,
      path: 'type',
      message: `Expected TBX type="TBX-Basic", got "${rootType ?? ''}".`,
    });
  }

  const rootLangRaw = root.attrs['xml:lang'];
  if (!rootLangRaw || !rootLangRaw.trim()) {
    failOne({
      code: 'invalid-schema',
      format: 'tbx',
      line: root.line,
      path: 'xml:lang',
      message: 'TBX root element requires an "xml:lang" attribute.',
    });
  }

  const headerName = isMartif ? 'martifHeader' : 'tbxHeader';
  const headerEl = childElements(root, headerName)[0];
  if (!headerEl) {
    failOne({
      code: 'invalid-schema',
      format: 'tbx',
      line: root.line,
      path: headerName,
      message: `Missing required "<${headerName}>" element.`,
    });
  }

  const textEl = childElements(root, 'text')[0];
  const bodyEl = textEl ? childElements(textEl, 'body')[0] : undefined;
  if (!textEl || !bodyEl) {
    failOne({
      code: 'invalid-schema',
      format: 'tbx',
      line: root.line,
      path: 'text.body',
      message: 'Missing required "<text><body>" container.',
    });
  }

  const sourceLang = normalizeLang(options.sourceLang ?? rootLangRaw, rootLangRaw, 'tbx', root.line);
  let targetLang = options.targetLang ? normalizeLang(options.targetLang, '', 'tbx', root.line) : '';

  const entryTag = isMartif ? 'termEntry' : 'conceptEntry';
  const langTag = isMartif ? 'langSet' : 'langSec';
  const seenIds = new Set<string>();
  const located: LocatedGlossaryInput[] = [];

  for (const child of childElements(bodyEl)) {
    if (child.name !== entryTag) {
      failOne({
        code: 'invalid-schema',
        format: 'tbx',
        line: child.line,
        path: child.name,
        message: `Unexpected element "<${child.name}>" inside TBX <body>; expected "<${entryTag}>".`,
      });
    }

    const entryId = child.attrs.id?.trim();
    if (child.attrs.id !== undefined && !entryId) {
      failOne({
        code: 'missing-field',
        format: 'tbx',
        line: child.line,
        path: 'id',
        message: `<${entryTag}> "id" attribute cannot be empty.`,
      });
    }
    if (entryId) {
      if (seenIds.has(entryId)) {
        failOne({
          code: 'duplicate-id',
          format: 'tbx',
          line: child.line,
          path: 'id',
          message: `Duplicate TBX ${entryTag} id "${entryId}".`,
        });
      }
      seenIds.add(entryId);
    }

    const langNodes = childElements(child, langTag);
    const termsByLang = new Map<string, { text: string; line: number }>();
    for (const langNode of langNodes) {
      const langRaw = langNode.attrs['xml:lang'];
      if (!langRaw || !langRaw.trim()) {
        failOne({
          code: 'invalid-schema',
          format: 'tbx',
          line: langNode.line,
          path: `${langTag}.xml:lang`,
          message: `<${langTag}> requires an "xml:lang" attribute.`,
        });
      }
      const lang = langRaw.trim().toLowerCase();
      const termText = extractTbxTermText(langNode, isTbxV3);
      if (termText === null) {
        failOne({
          code: 'missing-field',
          format: 'tbx',
          line: langNode.line,
          path: 'term',
          message: `<${langTag}> is missing a "<term>" element.`,
        });
      }
      termsByLang.set(lang, { text: termText, line: langNode.line });
    }

    const sourceTerm = termsByLang.get(sourceLang);
    if (!sourceTerm) {
      failOne({
        code: 'missing-field',
        format: 'tbx',
        line: child.line,
        path: sourceLang,
        message: `<${entryTag}> is missing source language "${sourceLang}".`,
      });
    }

    let targetTerm: { text: string; line: number } | undefined;
    if (targetLang) {
      targetTerm = termsByLang.get(targetLang);
    } else {
      for (const [lang, val] of termsByLang) {
        if (lang !== sourceLang) {
          targetLang = lang;
          targetTerm = val;
          break;
        }
      }
    }

    if (!targetTerm) {
      failOne({
        code: 'missing-field',
        format: 'tbx',
        line: child.line,
        path: targetLang || 'target',
        message: `<${entryTag}> is missing a target language term.`,
      });
    }

    located.push({
      source: sourceTerm.text,
      target: targetTerm.text,
      line: child.line,
    });
  }

  const entries = validateGlossaryItems(located, 'tbx', options);
  return {
    entries,
    sourceLang,
    targetLang: targetLang || (options.targetLang ?? ''),
  };
}

// --- Translation Memory CSV ------------------------------------------------

export function exportTmCsv(
  source: TranslationMemory | readonly TmEntry[],
  options: CsvOptions = {},
): string {
  const entries = entriesFromMemoryOrArray(source);
  const rows = entries.map(entry => [
    entry.id,
    entry.source,
    entry.target,
    entry.sourceLang,
    entry.targetLang,
    entry.engine,
    entry.model ?? '',
    String(entry.createdAt),
    String(entry.uses),
  ]);
  return formatCsv(TM_CSV_ALL_HEADERS, rows, options);
}

function parseTmCsvWithLines(
  csv: string,
  options: TmExchangeImportOptions = {},
): Array<{ entry: TmEntry; line: number }> {
  const parsed = parseCsv(csv);
  const required =
    options.defaultCreatedAt !== undefined
      ? ['id', 'source', 'target', 'sourceLang', 'targetLang', 'engine']
      : ['id', 'source', 'target', 'sourceLang', 'targetLang', 'engine', 'createdAt'];
  const colIndex = indexCsvHeaders(parsed.headers, required, TM_CSV_ALLOWED);

  const idIdx = colIndex.get('id')!;
  const sourceIdx = colIndex.get('source')!;
  const targetIdx = colIndex.get('target')!;
  const sourceLangIdx = colIndex.get('sourceLang')!;
  const targetLangIdx = colIndex.get('targetLang')!;
  const engineIdx = colIndex.get('engine')!;
  const modelIdx = colIndex.get('model');
  const createdAtIdx = colIndex.get('createdAt');
  const usesIdx = colIndex.get('uses');

  const seen = new Set<string>();
  const located: Array<{ entry: TmEntry; line: number }> = [];

  for (const row of parsed.rows) {
    const readRequired = (idx: number, field: string): string => {
      const val = row.values[idx] ?? '';
      if (val.trim().length === 0) {
        failOne({
          code: 'missing-field',
          format: 'csv',
          line: row.line,
          path: field,
          message: `${field} cannot be empty.`,
        });
      }
      return val;
    };

    const id = readRequired(idIdx, 'id').trim();
    if (seen.has(id)) {
      failOne({
        code: 'duplicate-id',
        format: 'csv',
        line: row.line,
        path: 'id',
        message: `Duplicate TM entry id "${id}".`,
      });
    }
    seen.add(id);

    const source = readRequired(sourceIdx, 'source');
    const target = readRequired(targetIdx, 'target');
    const sourceLang = readRequired(sourceLangIdx, 'sourceLang').trim().toLowerCase();
    const targetLang = readRequired(targetLangIdx, 'targetLang').trim().toLowerCase();
    const engine = readRequired(engineIdx, 'engine').trim();

    let createdAt: number;
    if (createdAtIdx !== undefined) {
      const rawCreated = row.values[createdAtIdx] ?? '';
      if (rawCreated.trim().length === 0) {
        failOne({
          code: 'missing-field',
          format: 'csv',
          line: row.line,
          path: 'createdAt',
          message: 'createdAt cannot be empty.',
        });
      }
      createdAt = parseNonNegativeInt(rawCreated, 'csv', row.line, 'createdAt');
    } else {
      createdAt = options.defaultCreatedAt!;
    }

    let uses = 0;
    if (usesIdx !== undefined) {
      const rawUses = row.values[usesIdx] ?? '';
      if (rawUses.trim().length > 0) {
        uses = parseNonNegativeInt(rawUses, 'csv', row.line, 'uses');
      }
    }

    const rawModel = modelIdx !== undefined ? row.values[modelIdx] ?? '' : '';
    const model = rawModel.trim().length > 0 ? rawModel.trim() : undefined;

    located.push({
      line: row.line,
      entry: {
        id,
        source,
        target,
        sourceLang,
        targetLang,
        engine,
        ...(model === undefined ? {} : { model }),
        createdAt,
        uses,
      },
    });
  }

  return located;
}

export function parseTmCsv(csv: string, options: TmExchangeImportOptions = {}): TmEntry[] {
  return parseTmCsvWithLines(csv, options).map(item => item.entry);
}

export function importTmCsv(
  memory: TranslationMemory,
  csv: string,
  options: TmExchangeImportOptions = {},
): TmImportResult {
  const located = parseTmCsvWithLines(csv, options);
  return importEntriesIntoMemory(memory, located, 'csv');
}

// --- TMX 1.4b formatter & parser (TM + Glossary) ---------------------------

function formatTmxTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function parseTmxTimestamp(raw: string, line: number): number {
  const trimmed = raw.trim();
  const basic = TMX_BASIC_DATE.exec(trimmed);
  if (basic) {
    const year = Number(basic[1]);
    const month = Number(basic[2]);
    const day = Number(basic[3]);
    const hour = Number(basic[4]);
    const minute = Number(basic[5]);
    const second = Number(basic[6]);
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    const check = new Date(ms);
    if (
      check.getUTCFullYear() === year &&
      check.getUTCMonth() + 1 === month &&
      check.getUTCDate() === day &&
      check.getUTCHours() === hour &&
      check.getUTCMinutes() === minute &&
      check.getUTCSeconds() === second
    ) {
      return ms;
    }
  }
  if (ISO_DATE_WITH_ZONE.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  failOne({
    code: 'invalid-field',
    format: 'tmx',
    line,
    path: 'creationdate',
    message: `Invalid TMX creationdate "${raw}".`,
  });
}

function inferSrcLang(entries: ReadonlyArray<{ sourceLang: string }>, explicit?: string): string {
  if (explicit) return normalizeLang(explicit, 'en', 'tmx');
  if (entries.length === 0) return '*all*';
  const first = entries[0]!.sourceLang.toLowerCase();
  return entries.every(entry => entry.sourceLang.toLowerCase() === first) ? first : '*all*';
}

function buildTmxDocument(
  units: ReadonlyArray<{
    tuid: string;
    source: string;
    target: string;
    sourceLang: string;
    targetLang: string;
    engine?: string;
    model?: string;
    createdAt?: number;
    uses?: number;
  }>,
  options: TmxExportOptions = {},
): string {
  const segType = options.segType ?? 'sentence';
  if (!TMX_SEG_TYPES.has(segType)) {
    failOne({
      code: 'invalid-field',
      format: 'tmx',
      line: 1,
      path: 'segType',
      message: `Invalid TMX segtype "${segType}".`,
    });
  }
  const srclang = inferSrcLang(units, options.sourceLang);
  const creationTool = options.creationTool ?? 'mirror-pdf';
  const creationToolVersion = options.creationToolVersion ?? '0.1.0';
  const adminLang = options.adminLang ?? 'en';

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tmx version="1.4">',
    `  <header creationtool="${escapeXmlAttr(creationTool, 'tmx')}" creationtoolversion="${escapeXmlAttr(creationToolVersion, 'tmx')}" segtype="${segType}" o-tmf="mirror-tm" adminlang="${escapeXmlAttr(adminLang, 'tmx')}" srclang="${escapeXmlAttr(srclang, 'tmx')}" datatype="plaintext"/>`,
    '  <body>',
  ];

  for (const unit of units) {
    const attrs = [`tuid="${escapeXmlAttr(unit.tuid, 'tmx')}"`];
    if (unit.createdAt !== undefined) {
      attrs.push(`creationdate="${formatTmxTimestamp(unit.createdAt)}"`);
    }
    if (unit.engine !== undefined) {
      attrs.push(`creationid="${escapeXmlAttr(unit.engine, 'tmx')}"`);
    }
    lines.push(`    <tu ${attrs.join(' ')}>`);
    if (unit.engine !== undefined) {
      lines.push(`      <prop type="x-engine">${escapeXmlText(unit.engine, 'tmx')}</prop>`);
    }
    if (unit.model !== undefined) {
      lines.push(`      <prop type="x-model">${escapeXmlText(unit.model, 'tmx')}</prop>`);
    }
    if (unit.uses !== undefined && unit.uses !== 0) {
      lines.push(`      <prop type="x-uses">${unit.uses}</prop>`);
    }
    if (unit.createdAt !== undefined && unit.createdAt % 1000 !== 0) {
      lines.push(`      <prop type="x-created-at">${unit.createdAt}</prop>`);
    }
    lines.push(`      <tuv xml:lang="${escapeXmlAttr(unit.sourceLang, 'tmx')}">`);
    lines.push(`        <seg>${escapeXmlText(unit.source, 'tmx')}</seg>`);
    lines.push('      </tuv>');
    lines.push(`      <tuv xml:lang="${escapeXmlAttr(unit.targetLang, 'tmx')}">`);
    lines.push(`        <seg>${escapeXmlText(unit.target, 'tmx')}</seg>`);
    lines.push('      </tuv>');
    lines.push('    </tu>');
  }

  lines.push('  </body>', '</tmx>');
  return `${lines.join('\n')}\n`;
}

function readTmxSegText(seg: XmlElement): string {
  let result = '';
  for (const child of seg.children) {
    if (child.kind === 'text') {
      result += child.text;
      continue;
    }
    if (!TMX_INLINE_TAGS.has(child.name)) {
      failOne({
        code: 'invalid-schema',
        format: 'tmx',
        line: child.line,
        path: `seg.${child.name}`,
        message: `Unexpected element "<${child.name}>" inside TMX "<seg>".`,
      });
    }
    result += readTmxSegText(child);
  }
  return result;
}

function parseTmxWithLines(
  tmx: string,
  options: TmxImportOptions = {},
): { entries: Array<{ entry: TmEntry; line: number }>; headerSrcLang: string } {
  const root = parseXml(tmx, 'tmx');
  if (root.name !== 'tmx') {
    failOne({
      code: 'invalid-schema',
      format: 'tmx',
      line: root.line,
      path: root.name,
      message: `Expected root "<tmx>", got "<${root.name}>".`,
    });
  }
  if (root.attrs.version !== '1.4' && root.attrs.version !== '1.4b') {
    failOne({
      code: 'invalid-schema',
      format: 'tmx',
      line: root.line,
      path: 'version',
      message: `Unsupported TMX version "${root.attrs.version ?? ''}"; expected TMX 1.4b ("1.4").`,
    });
  }

  const headers = childElements(root, 'header');
  const bodies = childElements(root, 'body');
  if (headers.length !== 1) {
    failOne({
      code: 'invalid-schema',
      format: 'tmx',
      line: root.line,
      path: 'header',
      message: 'TMX document must contain exactly one "<header>".',
    });
  }
  if (bodies.length !== 1) {
    failOne({
      code: 'invalid-schema',
      format: 'tmx',
      line: root.line,
      path: 'body',
      message: 'TMX document must contain exactly one "<body>".',
    });
  }

  const header = headers[0]!;
  for (const attr of TMX_REQUIRED_HEADER_ATTRS) {
    const val = header.attrs[attr];
    if (!val || !val.trim()) {
      failOne({
        code: 'invalid-schema',
        format: 'tmx',
        line: header.line,
        path: `header.${attr}`,
        message: `TMX "<header>" is missing required attribute "${attr}".`,
      });
    }
  }
  if (!TMX_SEG_TYPES.has(header.attrs.segtype!)) {
    failOne({
      code: 'invalid-schema',
      format: 'tmx',
      line: header.line,
      path: 'header.segtype',
      message: `Invalid TMX segtype "${header.attrs.segtype}".`,
    });
  }

  const headerSrcLang = header.attrs.srclang!.trim().toLowerCase();
  const body = bodies[0]!;
  const seenIds = new Set<string>();
  const located: Array<{ entry: TmEntry; line: number }> = [];
  const requestedSource = options.sourceLang?.trim().toLowerCase();
  const requestedTarget = options.targetLang?.trim().toLowerCase();

  let tuIndex = 0;
  for (const child of childElements(body)) {
    if (child.name !== 'tu') {
      failOne({
        code: 'invalid-schema',
        format: 'tmx',
        line: child.line,
        path: child.name,
        message: `Unexpected element "<${child.name}>" inside TMX "<body>".`,
      });
    }
    tuIndex += 1;

    let id: string;
    if (child.attrs.tuid !== undefined) {
      id = child.attrs.tuid.trim();
      if (!id) {
        failOne({
          code: 'missing-field',
          format: 'tmx',
          line: child.line,
          path: 'tuid',
          message: 'TMX "<tu>" tuid attribute cannot be empty.',
        });
      }
    } else {
      id = `tmx-${tuIndex}`;
    }
    if (seenIds.has(id)) {
      failOne({
        code: 'duplicate-id',
        format: 'tmx',
        line: child.line,
        path: 'tuid',
        message: `Duplicate TMX tuid "${id}".`,
      });
    }
    seenIds.add(id);

    let propEngine: string | undefined;
    let propModel: string | undefined;
    let propUses = 0;
    let propCreatedAt: number | undefined;

    for (const prop of childElements(child, 'prop')) {
      const propType = prop.attrs.type?.trim();
      const propVal = textContent(prop).trim();
      if (propType === 'x-engine' && propVal) propEngine = propVal;
      else if (propType === 'x-model' && propVal) propModel = propVal;
      else if (propType === 'x-uses' && propVal) propUses = parseNonNegativeInt(propVal, 'tmx', prop.line, 'prop[x-uses]');
      else if (propType === 'x-created-at' && propVal) {
        propCreatedAt = parseNonNegativeInt(propVal, 'tmx', prop.line, 'prop[x-created-at]');
      }
    }

    const createdAt =
      propCreatedAt ??
      (child.attrs.creationdate !== undefined
        ? parseTmxTimestamp(child.attrs.creationdate, child.line)
        : options.defaultCreatedAt ?? 0);

    const engine =
      propEngine ??
      (child.attrs.creationid?.trim() || options.defaultEngine || 'tmx-import');

    const tuvNodes = childElements(child, 'tuv');
    if (tuvNodes.length < 2) {
      failOne({
        code: 'missing-field',
        format: 'tmx',
        line: child.line,
        path: 'tuv',
        message: `TMX "<tu>" "${id}" must contain at least 2 "<tuv>" variants.`,
      });
    }

    const variants: Array<{ lang: string; text: string; line: number }> = [];
    const seenLangs = new Set<string>();
    for (const tuv of tuvNodes) {
      const langRaw = tuv.attrs['xml:lang'] ?? tuv.attrs.lang;
      if (!langRaw || !langRaw.trim()) {
        failOne({
          code: 'invalid-schema',
          format: 'tmx',
          line: tuv.line,
          path: 'tuv.xml:lang',
          message: 'TMX "<tuv>" requires an "xml:lang" attribute.',
        });
      }
      const lang = langRaw.trim().toLowerCase();
      if (seenLangs.has(lang)) {
        failOne({
          code: 'invalid-schema',
          format: 'tmx',
          line: tuv.line,
          path: 'tuv.xml:lang',
          message: `Duplicate language "${lang}" in TMX "<tu>" "${id}".`,
        });
      }
      seenLangs.add(lang);

      const segs = childElements(tuv, 'seg');
      if (segs.length !== 1) {
        failOne({
          code: 'missing-field',
          format: 'tmx',
          line: tuv.line,
          path: 'seg',
          message: 'TMX "<tuv>" must contain exactly one "<seg>" element.',
        });
      }
      const segText = readTmxSegText(segs[0]!);
      if (segText.trim().length === 0) {
        failOne({
          code: 'missing-field',
          format: 'tmx',
          line: segs[0]!.line,
          path: 'seg',
          message: 'TMX "<seg>" cannot be empty.',
        });
      }
      variants.push({ lang, text: segText, line: tuv.line });
    }

    const sourceLangTarget = requestedSource ?? (headerSrcLang !== '*all*' ? headerSrcLang : undefined);
    const sourceVariant = sourceLangTarget
      ? variants.find(v => v.lang === sourceLangTarget)
      : variants[0];
    if (!sourceVariant) {
      failOne({
        code: 'missing-field',
        format: 'tmx',
        line: child.line,
        path: 'sourceLang',
        message: `TMX "<tu>" "${id}" is missing source language "${sourceLangTarget}".`,
      });
    }

    const targetVariant = requestedTarget
      ? variants.find(v => v.lang === requestedTarget && v.lang !== sourceVariant.lang)
      : variants.find(v => v.lang !== sourceVariant.lang);
    if (!targetVariant) {
      failOne({
        code: 'missing-field',
        format: 'tmx',
        line: child.line,
        path: 'targetLang',
        message: `TMX "<tu>" "${id}" is missing a target language variant.`,
      });
    }

    located.push({
      line: child.line,
      entry: {
        id,
        source: sourceVariant.text,
        target: targetVariant.text,
        sourceLang: sourceVariant.lang,
        targetLang: targetVariant.lang,
        engine,
        ...(propModel === undefined ? {} : { model: propModel }),
        createdAt,
        uses: propUses,
      },
    });
  }

  return { entries: located, headerSrcLang };
}

export function exportTmTmx(
  source: TranslationMemory | readonly TmEntry[],
  options: TmxExportOptions = {},
): string {
  const entries = entriesFromMemoryOrArray(source);
  return buildTmxDocument(
    entries.map(entry => ({
      tuid: entry.id,
      source: entry.source,
      target: entry.target,
      sourceLang: entry.sourceLang,
      targetLang: entry.targetLang,
      engine: entry.engine,
      model: entry.model,
      createdAt: entry.createdAt,
      uses: entry.uses,
    })),
    options,
  );
}

export function parseTmTmx(tmx: string, options: TmxImportOptions = {}): TmEntry[] {
  return parseTmxWithLines(tmx, options).entries.map(item => item.entry);
}

export function importTmTmx(
  memory: TranslationMemory,
  tmx: string,
  options: TmxImportOptions = {},
): TmImportResult {
  const { entries } = parseTmxWithLines(tmx, options);
  return importEntriesIntoMemory(memory, entries, 'tmx');
}

export function exportGlossaryTmx(
  entries: readonly GlossaryEntry[],
  options: GlossaryTmxExportOptions = {},
): string {
  const sourceLang = normalizeLang(options.sourceLang, 'en', 'tmx');
  const targetLang = normalizeLang(options.targetLang, 'vi', 'tmx');
  return buildTmxDocument(
    entries.map((entry, idx) => ({
      tuid: `term-${idx + 1}`,
      source: entry.source,
      target: entry.target,
      sourceLang,
      targetLang,
    })),
    { ...options, sourceLang, segType: options.segType ?? 'phrase' },
  );
}

export function importGlossaryTmx(
  tmx: string,
  options: GlossaryTmxImportOptions = {},
): TbxGlossaryImportResult {
  const { entries, headerSrcLang } = parseTmxWithLines(tmx, {
    sourceLang: options.sourceLang,
    targetLang: options.targetLang,
    defaultEngine: 'glossary',
    defaultCreatedAt: 0,
  });

  const located: LocatedGlossaryInput[] = entries.map(item => ({
    source: item.entry.source,
    target: item.entry.target,
    line: item.line,
  }));

  const validated = validateGlossaryItems(located, 'tmx', options);
  const first = entries[0]?.entry;
  return {
    entries: validated,
    sourceLang: options.sourceLang?.toLowerCase() ?? first?.sourceLang ?? (headerSrcLang === '*all*' ? 'en' : headerSrcLang),
    targetLang: options.targetLang?.toLowerCase() ?? first?.targetLang ?? '',
  };
}
