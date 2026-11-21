import { describe, expect, it } from 'vitest';
import { detectFormulas, segmentText } from '../src/core/formulas';
import { sniffFormat } from '../src/core/import-formats';
import { extractTable } from '../src/core/tables';
import type { TableCell } from '../src/core/tables';
import { parseCsv } from '../src/core/tm-exchange';
import { planFormula, plainText } from '../src/export/tex';
import {
  CSV_MIME,
  TEX_MIME,
  XLSX_MIME,
  buildStoreZip,
  cellRef,
  columnLetter,
  crc32,
  exportDetectedFormulasToTex,
  exportFormulasBundle,
  exportFormulasToTex,
  exportSelectedTablesToCsv,
  exportTableToCsv,
  exportTableToXlsx,
  exportTablesToCsv,
  exportTablesToXlsx,
  extractExportFormulas,
  selectTables,
  type ExportableTable,
  type FormulaSourceBlock,
} from '../src/export/table-xlsx';

// --- Independent test-local CRC32, ZIP unpacker, and XML parser ----------

function independentCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (0xedb88320 ^ (crc >>> 1)) >>> 0 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface UnpackedZipEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  method: number;
  flags: number;
  localOffset: number;
}

interface UnpackedZip {
  entryNames: string[];
  entries: Map<string, UnpackedZipEntry>;
}

function unpackAndVerifyZip(archive: Uint8Array): UnpackedZip {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);

  // Scan backwards for EOCD signature PK\x05\x06.
  let eocdOffset = -1;
  for (let offset = archive.length - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('ZIP EOCD record not found.');
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const cdStartDisk = view.getUint16(eocdOffset + 6, true);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  expect(diskNumber).toBe(0);
  expect(cdStartDisk).toBe(0);
  expect(diskEntries).toBe(totalEntries);
  expect(cdOffset + cdSize).toBe(eocdOffset);

  const entryNames: string[] = [];
  const entries = new Map<string, UnpackedZipEntry>();
  let cdCursor = cdOffset;

  for (let idx = 0; idx < totalEntries; idx += 1) {
    expect(view.getUint32(cdCursor, true)).toBe(0x02014b50);
    const flags = view.getUint16(cdCursor + 8, true);
    const method = view.getUint16(cdCursor + 10, true);
    const crc = view.getUint32(cdCursor + 16, true);
    const compSize = view.getUint32(cdCursor + 20, true);
    const uncompSize = view.getUint32(cdCursor + 24, true);
    const nameLen = view.getUint16(cdCursor + 28, true);
    const extraLen = view.getUint16(cdCursor + 30, true);
    const commentLen = view.getUint16(cdCursor + 32, true);
    const localOffset = view.getUint32(cdCursor + 42, true);

    expect(method).toBe(0);
    expect(flags & 0x0800).toBe(0x0800);
    expect(compSize).toBe(uncompSize);

    const cdName = decoder.decode(archive.subarray(cdCursor + 46, cdCursor + 46 + nameLen));
    cdCursor += 46 + nameLen + extraLen + commentLen;

    // Cross-check Local File Header at localOffset.
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCrc = view.getUint32(localOffset + 14, true);
    const localCompSize = view.getUint32(localOffset + 18, true);
    const localUncompSize = view.getUint32(localOffset + 22, true);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const localName = decoder.decode(archive.subarray(localOffset + 30, localOffset + 30 + localNameLen));

    expect(localFlags).toBe(flags);
    expect(localMethod).toBe(method);
    expect(localCrc).toBe(crc);
    expect(localCompSize).toBe(compSize);
    expect(localUncompSize).toBe(uncompSize);
    expect(localName).toBe(cdName);

    const payloadStart = localOffset + 30 + localNameLen + localExtraLen;
    const payload = archive.subarray(payloadStart, payloadStart + uncompSize);
    expect(payload.length).toBe(uncompSize);
    expect(independentCrc32(payload)).toBe(crc);

    entryNames.push(cdName);
    entries.set(cdName, {
      name: cdName,
      data: payload,
      crc,
      method,
      flags,
      localOffset,
    });
  }

  expect(cdCursor).toBe(eocdOffset);
  return { entryNames, entries };
}

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

function decodeXmlEntities(raw: string): string {
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
  });
}

function parseXml(xml: string): XmlElement {
  let cursor = 0;
  if (xml.startsWith('<?xml')) {
    const declEnd = xml.indexOf('?>');
    if (declEnd < 0) throw new Error('Unterminated XML declaration.');
    cursor = declEnd + 2;
  }

  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  while (cursor < xml.length) {
    const lt = xml.indexOf('<', cursor);
    if (lt < 0) {
      const trailing = xml.slice(cursor);
      if (trailing.trim().length > 0) throw new Error(`Unexpected trailing XML text: ${trailing}`);
      break;
    }

    if (lt > cursor) {
      const textChunk = decodeXmlEntities(xml.slice(cursor, lt));
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.text += textChunk;
      } else if (textChunk.trim().length > 0) {
        throw new Error(`Unexpected text outside root: ${textChunk}`);
      }
    }

    if (xml.startsWith('</', lt)) {
      const gt = xml.indexOf('>', lt + 2);
      if (gt < 0) throw new Error('Unterminated closing XML tag.');
      const closeName = xml.slice(lt + 2, gt).trim();
      const popped = stack.pop();
      if (!popped || popped.name !== closeName) {
        throw new Error(`Mismatched closing tag </${closeName}>, expected </${popped?.name ?? 'none'}>.`);
      }
      cursor = gt + 1;
      continue;
    }

    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) throw new Error('Unterminated opening XML tag.');
    const rawInside = xml.slice(lt + 1, gt);
    const selfClosing = rawInside.endsWith('/');
    const tagBody = (selfClosing ? rawInside.slice(0, -1) : rawInside).trim();

    const spaceIdx = tagBody.search(/\s/);
    const name = spaceIdx < 0 ? tagBody : tagBody.slice(0, spaceIdx);
    const attrPart = spaceIdx < 0 ? '' : tagBody.slice(spaceIdx + 1);
    const attrs: Record<string, string> = {};

    const attrPattern = /([^\s=]+)\s*=\s*"([^"]*)"/g;
    let match: RegExpExecArray | null = attrPattern.exec(attrPart);
    while (match !== null) {
      const attrName = match[1];
      const attrVal = match[2] ?? '';
      if (attrName) attrs[attrName] = decodeXmlEntities(attrVal);
      match = attrPattern.exec(attrPart);
    }

    const element: XmlElement = { name, attrs, children: [], text: '' };
    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(element);
    } else {
      if (root !== null) throw new Error('Multiple XML root elements.');
      root = element;
    }

    if (!selfClosing) {
      stack.push(element);
    }
    cursor = gt + 1;
  }

  if (stack.length > 0 || root === null) {
    throw new Error('Incomplete XML document.');
  }
  return root;
}

function readZipXml(unpacked: UnpackedZip, name: string): XmlElement {
  const entry = unpacked.entries.get(name);
  if (!entry) throw new Error(`Missing ZIP entry: ${name}`);
  const xmlText = new TextDecoder('utf-8', { fatal: true }).decode(entry.data);
  return parseXml(xmlText);
}

function childrenNamed(parent: XmlElement, name: string): XmlElement[] {
  return parent.children.filter(child => child.name === name);
}

function childNamed(parent: XmlElement, name: string): XmlElement | undefined {
  return parent.children.find(child => child.name === name);
}

// --- Fixtures ------------------------------------------------------------

function cell(text: string, x: number, y: number, width: number, height: number): TableCell {
  return { text, rect: { x, y, width, height } };
}

function sampleTables(): ExportableTable[] {
  const revenue = extractTable([
    cell('Population by province', 0, 0, 270, 12),
    cell('Province', 0, 30, 90, 12),
    cell('Population', 180, 30, 90, 12),
    cell('Hà Nội', 0, 60, 90, 12),
    cell('8053', 180, 60, 90, 12),
    cell('Đà Nẵng', 0, 90, 90, 12),
    cell('1134', 180, 90, 90, 12),
  ]);

  const matrix: ExportableTable = {
    id: 'tbl-matrix',
    page: 2,
    title: 'Quarterly: Budget / [FY26]*?',
    headers: ['Region', 'Q1', 'Q2', 'Notes'],
    rows: [
      ['North', '1250', '-42.5', 'Line 1\nLine 2'],
      ['', '007', '2026-01-31', '日本語 & 中文'],
      ['South', '980', '0', 'A < B & "C"'],
    ],
    rowCount: 4,
    columnCount: 4,
    spans: [{ row: 1, col: 0, colSpan: 1, rowSpan: 2 }],
    confidence: 1,
    reasons: ['assumed-header', 'merged-cells'],
  };

  const emptyRefused = extractTable([]);

  return [
    { ...revenue, id: 'tbl-pop', page: 1, title: 'Dân số Việt Nam' },
    matrix,
    { ...emptyRefused, id: 'tbl-empty', page: 3, title: 'Empty' },
  ];
}

// --- Tests ---------------------------------------------------------------

describe('H08 constants and cell coordinate helpers', () => {
  it('exposes standard MIME types and Excel column references', () => {
    expect(XLSX_MIME).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(CSV_MIME).toBe('text/csv;charset=utf-8');
    expect(TEX_MIME).toBe('application/x-tex;charset=utf-8');

    expect(columnLetter(0)).toBe('A');
    expect(columnLetter(25)).toBe('Z');
    expect(columnLetter(26)).toBe('AA');
    expect(columnLetter(27)).toBe('AB');
    expect(columnLetter(701)).toBe('ZZ');
    expect(columnLetter(702)).toBe('AAA');

    expect(cellRef(0, 0)).toBe('A1');
    expect(cellRef(9, 26)).toBe('AA10');
  });
});

describe('H08 pure-TS CRC32 and STORE ZIP writer', () => {
  it('computes standard IEEE 802.3 CRC32 values', () => {
    const encoder = new TextEncoder();
    expect(crc32(new Uint8Array(0))).toBe(0x00000000);
    expect(crc32(encoder.encode('123456789'))).toBe(0xcbf43926);
  });

  it('builds a valid STORE ZIP with local headers, central directory, and EOCD', () => {
    const encoder = new TextEncoder();
    const archive = buildStoreZip([
      { name: 'hello.txt', data: encoder.encode('Xin chào 世界') },
      { name: 'nested/bài-tập.txt', data: encoder.encode('Tiếng Việt & 한국어') },
    ]);

    const unpacked = unpackAndVerifyZip(archive);
    expect(unpacked.entryNames).toEqual(['hello.txt', 'nested/bài-tập.txt']);
    expect(new TextDecoder().decode(unpacked.entries.get('hello.txt')?.data)).toBe('Xin chào 世界');
    expect(new TextDecoder().decode(unpacked.entries.get('nested/bài-tập.txt')?.data)).toBe('Tiếng Việt & 한국어');
  });
});

describe('H08 table selection', () => {
  it('filters tables by ID, page, and excludes empty/refused tables by default', () => {
    const tables = sampleTables();

    expect(selectTables(tables).map(t => t.id)).toEqual(['tbl-pop', 'tbl-matrix']);
    expect(selectTables(tables, { ids: ['tbl-matrix'] }).map(t => t.id)).toEqual(['tbl-matrix']);
    expect(selectTables(tables, { pages: [1] }).map(t => t.id)).toEqual(['tbl-pop']);
    expect(selectTables(tables, { ids: ['tbl-pop', 'tbl-matrix'], pages: [2] }).map(t => t.id)).toEqual(['tbl-matrix']);
    expect(selectTables(tables, { ids: [] })).toEqual([]);
    expect(selectTables(tables, { excludeEmpty: false }).map(t => t.id)).toEqual([
      'tbl-pop',
      'tbl-matrix',
      'tbl-empty',
    ]);
  });
});

describe('H08 RFC4180 CSV export', () => {
  it('formats UTF-8 Vietnamese/CJK, quotes special characters, uses CRLF, and round-trips through parseCsv', () => {
    const tables = sampleTables();
    const matrix = tables[1];
    expect(matrix).toBeDefined();
    if (!matrix) return;

    const csv = exportTableToCsv(matrix, { bom: true });
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const body = csv.slice(1);
    expect(body).toBe(
      [
        'Region,Q1,Q2,Notes',
        'North,1250,-42.5,"Line 1\nLine 2"',
        ',007,2026-01-31,日本語 & 中文',
        'South,980,0,"A < B & ""C"""',
      ].join('\r\n'),
    );

    const reparsed = parseCsv(csv);
    expect(reparsed.headers).toEqual(['Region', 'Q1', 'Q2', 'Notes']);
    expect(reparsed.rows.map(r => r.values)).toEqual([
      ['North', '1250', '-42.5', 'Line 1\nLine 2'],
      ['', '007', '2026-01-31', '日本語 & 中文'],
      ['South', '980', '0', 'A < B & "C"'],
    ]);
  });

  it('supports repeating merged cell values, header omission, and multi-table CSV exports', () => {
    const tables = sampleTables();
    const matrix = tables[1]!;

    const repeated = exportTableToCsv(matrix, { repeatMergedValues: true, includeHeaders: false });
    expect(repeated).toBe(
      [
        'North,1250,-42.5,"Line 1\nLine 2"',
        'North,007,2026-01-31,日本語 & 中文',
        'South,980,0,"A < B & ""C"""',
      ].join('\r\n'),
    );

    const files = exportSelectedTablesToCsv(tables, { selection: { pages: [1, 2] } });
    expect(files).toHaveLength(2);
    expect(files[0]?.id).toBe('tbl-pop');
    expect(files[0]?.filename).toMatch(/\.csv$/);
    expect(files[0]?.csv).toContain('Hà Nội,8053');
    expect(files[1]?.id).toBe('tbl-matrix');

    const combinedWithBom = exportTablesToCsv(tables, { bom: true });
    expect(combinedWithBom.startsWith('\uFEFF')).toBe(true);
    expect(combinedWithBom.slice(1)).not.toContain('\uFEFF');
    expect(combinedWithBom).toContain('Đà Nẵng,1134');
    expect(combinedWithBom).toContain('日本語 & 中文');

    expect(exportTableToCsv(extractTable([]))).toBe('');
  });
});

describe('H08 OOXML XLSX ZIP structure, CRC32 integrity, XML cells, and merged cells', () => {
  it('unzips and parses all OOXML XML parts, preserving multi-sheet structure, UTF-8, numeric types, and colSpan/rowSpan merges', () => {
    const tables = sampleTables();
    const xlsx = exportTablesToXlsx(tables, {
      selection: { pages: [1, 2] },
      freezeHeader: true,
    });

    expect(sniffFormat(xlsx, 'export.xlsx')).toMatchObject({ format: 'xlsx', confidence: 'likely' });

    const unpacked = unpackAndVerifyZip(xlsx);
    expect(unpacked.entryNames[0]).toBe('[Content_Types].xml');
    expect(unpacked.entryNames).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/styles.xml',
      'xl/sharedStrings.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);

    // 1. [Content_Types].xml
    const contentTypes = readZipXml(unpacked, '[Content_Types].xml');
    expect(contentTypes.name).toBe('Types');
    const overrides = childrenNamed(contentTypes, 'Override').map(el => el.attrs.PartName);
    expect(overrides).toEqual([
      '/xl/workbook.xml',
      '/xl/worksheets/sheet1.xml',
      '/xl/worksheets/sheet2.xml',
      '/xl/styles.xml',
      '/xl/sharedStrings.xml',
    ]);

    // 2. _rels/.rels and xl/_rels/workbook.xml.rels
    const rootRels = readZipXml(unpacked, '_rels/.rels');
    const docRel = childNamed(rootRels, 'Relationship');
    expect(docRel?.attrs.Target).toBe('xl/workbook.xml');

    const wbRels = readZipXml(unpacked, 'xl/_rels/workbook.xml.rels');
    const relTargets = new Map<string, string>();
    for (const rel of childrenNamed(wbRels, 'Relationship')) {
      if (rel.attrs.Id && rel.attrs.Target) {
        relTargets.set(rel.attrs.Id, rel.attrs.Target);
        expect(unpacked.entries.has(`xl/${rel.attrs.Target}`)).toBe(true);
      }
    }

    // 3. xl/workbook.xml (sheet names sanitized from forbidden chars)
    const workbook = readZipXml(unpacked, 'xl/workbook.xml');
    const sheetsEl = childNamed(workbook, 'sheets');
    expect(sheetsEl).toBeDefined();
    const sheetNodes = childrenNamed(sheetsEl!, 'sheet');
    expect(sheetNodes).toHaveLength(2);
    expect(sheetNodes[0]?.attrs.name).toBe('Dân số Việt Nam');
    expect(sheetNodes[1]?.attrs.name).toBe('Quarterly Budget FY26');
    expect(relTargets.get(sheetNodes[0]?.attrs['r:id'] ?? '')).toBe('worksheets/sheet1.xml');
    expect(relTargets.get(sheetNodes[1]?.attrs['r:id'] ?? '')).toBe('worksheets/sheet2.xml');

    // 4. xl/styles.xml
    const styles = readZipXml(unpacked, 'xl/styles.xml');
    for (const sectionName of ['fonts', 'fills', 'borders', 'cellStyleXfs', 'cellXfs', 'cellStyles']) {
      const section = childNamed(styles, sectionName);
      expect(section).toBeDefined();
      expect(Number(section?.attrs.count)).toBe(section?.children.length);
    }

    // 5. xl/sharedStrings.xml
    const sstXml = readZipXml(unpacked, 'xl/sharedStrings.xml');
    const siNodes = childrenNamed(sstXml, 'si');
    expect(Number(sstXml.attrs.uniqueCount)).toBe(siNodes.length);
    const sharedStrings = siNodes.map(si => childNamed(si, 't')?.text ?? '');
    expect(sharedStrings).toContain('Population by province');
    expect(sharedStrings).toContain('Hà Nội');
    expect(sharedStrings).toContain('Đà Nẵng');
    expect(sharedStrings).toContain('日本語 & 中文');
    expect(sharedStrings).toContain('A < B & "C"');
    expect(sharedStrings).toContain('007');
    expect(sharedStrings).toContain('2026-01-31');
    expect(sharedStrings).toContain('Line 1\nLine 2');

    // 6. xl/worksheets/sheet1.xml (extracted from src/core/tables.ts with colSpan: 2)
    const sheet1 = readZipXml(unpacked, 'xl/worksheets/sheet1.xml');
    expect(childNamed(sheet1, 'dimension')?.attrs.ref).toBe('A1:B4');
    const sheetView1 = childNamed(childNamed(sheet1, 'sheetViews')!, 'sheetView');
    const pane1 = childNamed(sheetView1!, 'pane');
    expect(pane1?.attrs).toMatchObject({ ySplit: '1', topLeftCell: 'A2', state: 'frozen' });

    const merge1 = childNamed(sheet1, 'mergeCells');
    expect(merge1?.attrs.count).toBe('1');
    expect(childrenNamed(merge1!, 'mergeCell').map(m => m.attrs.ref)).toEqual(['A1:B1']);

    const readSheetCells = (sheet: XmlElement): Map<string, { type: string; style: string; value: string | number }> => {
      const result = new Map<string, { type: string; style: string; value: string | number }>();
      const sheetData = childNamed(sheet, 'sheetData')!;
      for (const row of childrenNamed(sheetData, 'row')) {
        for (const cellNode of childrenNamed(row, 'c')) {
          const ref = cellNode.attrs.r ?? '';
          const type = cellNode.attrs.t ?? 'n';
          const style = cellNode.attrs.s ?? '0';
          const rawV = childNamed(cellNode, 'v')?.text ?? '';
          const value = type === 's' ? (sharedStrings[Number(rawV)] ?? '') : Number(rawV);
          result.set(ref, { type, style, value });
        }
      }
      return result;
    };

    const s1Cells = readSheetCells(sheet1);
    expect(s1Cells.get('A1')).toEqual({ type: 's', style: '3', value: 'Population by province' });
    expect(s1Cells.has('B1')).toBe(false); // covered by A1:B1 colSpan merge
    expect(s1Cells.get('A2')).toEqual({ type: 's', style: '0', value: 'Province' });
    expect(s1Cells.get('B2')).toEqual({ type: 's', style: '0', value: 'Population' });
    expect(s1Cells.get('A3')).toEqual({ type: 's', style: '0', value: 'Hà Nội' });
    expect(s1Cells.get('B3')).toEqual({ type: 'n', style: '0', value: 8053 });
    expect(s1Cells.get('A4')).toEqual({ type: 's', style: '0', value: 'Đà Nẵng' });
    expect(s1Cells.get('B4')).toEqual({ type: 'n', style: '0', value: 1134 });

    // 7. xl/worksheets/sheet2.xml (rowSpan: 2, multiline wrap, negative/zero numbers, leading zero string)
    const sheet2 = readZipXml(unpacked, 'xl/worksheets/sheet2.xml');
    expect(childNamed(sheet2, 'dimension')?.attrs.ref).toBe('A1:D4');
    const merge2 = childNamed(sheet2, 'mergeCells');
    expect(merge2?.attrs.count).toBe('1');
    expect(childrenNamed(merge2!, 'mergeCell').map(m => m.attrs.ref)).toEqual(['A2:A3']);

    const s2Cells = readSheetCells(sheet2);
    expect(s2Cells.get('A2')).toEqual({ type: 's', style: '0', value: 'North' });
    expect(s2Cells.has('A3')).toBe(false); // covered by A2:A3 rowSpan merge
    expect(s2Cells.get('B2')).toEqual({ type: 'n', style: '0', value: 1250 });
    expect(s2Cells.get('C2')).toEqual({ type: 'n', style: '0', value: -42.5 });
    expect(s2Cells.get('D2')).toEqual({ type: 's', style: '2', value: 'Line 1\nLine 2' });
    expect(s2Cells.get('B3')).toEqual({ type: 's', style: '0', value: '007' });
    expect(s2Cells.get('C3')).toEqual({ type: 's', style: '0', value: '2026-01-31' });
    expect(s2Cells.get('D3')).toEqual({ type: 's', style: '0', value: '日本語 & 中文' });
    expect(s2Cells.get('C4')).toEqual({ type: 'n', style: '0', value: 0 });
    expect(s2Cells.get('D4')).toEqual({ type: 's', style: '0', value: 'A < B & "C"' });
  });

  it('handles combined colSpan + rowSpan block merges, wide (>26 cols) references, sheet name deduplication, and number modes', () => {
    const wideHeaders = Array.from({ length: 28 }, (_u, idx) => `Col${idx + 1}`);
    const wideRow = Array.from({ length: 28 }, (_u, idx) => String(idx + 1));

    const t1: ExportableTable = {
      id: 'dup-1',
      title: 'Very Long Sheet Name Exceeding Thirty One Chars [1]',
      headers: wideHeaders,
      rows: [
        wideRow,
        ['Block', '', '', '1,250', '12345678901234567', ...Array.from({ length: 23 }, () => '')],
        ['ignored', 'ignored', 'ignored', 'keep', '', ...Array.from({ length: 23 }, () => '')],
      ],
      spans: [
        { row: 0, col: 26, colSpan: 2, rowSpan: 1 }, // AA1:AB1
        { row: 2, col: 0, colSpan: 3, rowSpan: 2 }, // A3:C4 (overlaps next attempt)
        { row: 2, col: 1, colSpan: 2, rowSpan: 1 }, // overlaps A3:C4 -> must be ignored
      ],
    };

    const t2: ExportableTable = {
      id: 'dup-2',
      title: 'Very Long Sheet Name Exceeding Thirty One Chars [1]',
      headers: ['K', 'V'],
      rows: [['x', '42']],
    };

    const groupedXlsx = exportTablesToXlsx([t1, t2], { numberDetection: 'grouped' });
    const unpacked = unpackAndVerifyZip(groupedXlsx);

    const wb = readZipXml(unpacked, 'xl/workbook.xml');
    const sheetNames = childrenNamed(childNamed(wb, 'sheets')!, 'sheet').map(s => s.attrs.name ?? '');
    expect(sheetNames).toHaveLength(2);
    expect(sheetNames[0]?.length).toBeLessThanOrEqual(31);
    expect(sheetNames[1]?.length).toBeLessThanOrEqual(31);
    expect(sheetNames[0]?.toLowerCase()).not.toBe(sheetNames[1]?.toLowerCase());

    const sst = childrenNamed(readZipXml(unpacked, 'xl/sharedStrings.xml'), 'si').map(
      si => childNamed(si, 't')?.text ?? '',
    );
    const sheet1 = readZipXml(unpacked, 'xl/worksheets/sheet1.xml');
    const mergeRefs = childrenNamed(childNamed(sheet1, 'mergeCells')!, 'mergeCell').map(m => m.attrs.ref);
    expect(mergeRefs).toEqual(['AA1:AB1', 'A3:C4']);

    const cells = new Map<string, { type: string; val: string }>();
    for (const row of childrenNamed(childNamed(sheet1, 'sheetData')!, 'row')) {
      for (const c of childrenNamed(row, 'c')) {
        cells.set(c.attrs.r ?? '', { type: c.attrs.t ?? 'n', val: childNamed(c, 'v')?.text ?? '' });
      }
    }

    // D3 = '1,250' parsed as numeric 1250 in 'grouped' mode; E3 = 17-digit ID stays string.
    expect(cells.get('D3')).toEqual({ type: 'n', val: '1250' });
    expect(cells.get('E3')?.type).toBe('s');
    expect(sst[Number(cells.get('E3')?.val)]).toBe('12345678901234567');
    // Covered cells inside A3:C4 merge must not emit values.
    expect(cells.has('B3')).toBe(false);
    expect(cells.has('A4')).toBe(false);
    expect(cells.has('C4')).toBe(false);

    // Empty selection fallback produces valid 1-sheet workbook.
    const emptyFallback = exportTablesToXlsx([t1], { selection: { ids: ['missing'] } });
    const unpackedEmpty = unpackAndVerifyZip(emptyFallback);
    expect(readZipXml(unpackedEmpty, 'xl/workbook.xml').children[0]?.children[0]?.attrs.name).toBe('Sheet1');
    expect(readZipXml(unpackedEmpty, 'xl/sharedStrings.xml').attrs.uniqueCount).toBe('0');

    // Single table export with numberDetection: 'none' keeps numbers as strings.
    const textOnly = unpackAndVerifyZip(exportTableToXlsx(t2, { numberDetection: 'none' }));
    const s2 = readZipXml(textOnly, 'xl/worksheets/sheet1.xml');
    const v2 = childNamed(childrenNamed(childNamed(s2, 'sheetData')!, 'row')[1]!, 'c');
    const v2Next = childrenNamed(childrenNamed(childNamed(s2, 'sheetData')!, 'row')[1]!, 'c')[1];
    expect(v2?.attrs.t).toBe('s');
    expect(v2Next?.attrs.t).toBe('s');
  });
});

describe('H08 LaTeX formula export and round-trip verification', () => {
  const blocks: FormulaSourceBlock[] = [
    { id: 'b1\ninjected', page: 1, text: 'The kinetic energy is $E = mc^2$ and $\\alpha + \\beta$.' },
    { id: 'b2', page: 1, text: 'Results improve and/or degrade in 3/4 of cases; cost is $5 and $6.' },
    { id: 'b3', page: 2, raw: 'Where \\[\\frac{a}{b} + \\alpha\\] holds, √(x+1) ≤ 2, and H_2O freezes.' },
    { id: 'b4', page: 2, text: 'Repeated: $E = mc^2$ and $$\\sum_{i}^{n} x_i$$.' },
  ];

  it('extracts formulas with provenance and exports a compilable .tex document that round-trips through formulas.ts and tex.ts', () => {
    const bundle = exportFormulasBundle(blocks, {
      title: 'Physics & Chemistry Formulas (50%)',
      author: 'Dr. Nguyễn',
    });

    expect(bundle.formulas.length).toBeGreaterThanOrEqual(5);
    expect(bundle.tex).toContain('\\documentclass[11pt]{article}');
    expect(bundle.tex).toContain('\\usepackage[utf8]{inputenc}');
    expect(bundle.tex).toContain('\\usepackage{amsmath}');
    expect(bundle.tex).toContain('\\title{Physics \\& Chemistry Formulas (50\\%)}');
    expect(bundle.tex).toContain('\\begin{document}');
    expect(bundle.tex).toContain('\\end{document}');

    // Comment-breakout injection guard: multiline blockId stays on one `% ...` comment line.
    expect(bundle.tex).toContain('% Formula 1, Page 1, Block b1 injected, inline-math');
    expect(bundle.tex).not.toContain('\ninjected');

    // Round-trip: parse exported formula lines (excluding preamble/comments/\begin/\end/\title/\author)
    // back through segmentText from src/core/formulas.ts.
    const bodyStart = bundle.tex.indexOf('\\begin{document}');
    const bodyEnd = bundle.tex.indexOf('\\end{document}');
    const bodyLines = bundle.tex
      .slice(bodyStart, bodyEnd)
      .split('\n')
      .filter(line => {
        const t = line.trim();
        return t.length > 0 && !t.startsWith('%') && t !== '\\begin{document}' && t !== '\\maketitle';
      });

    expect(bodyLines).toHaveLength(bundle.formulas.length);

    bodyLines.forEach((line, idx) => {
      const original = bundle.formulas[idx]!;
      const resegmented = segmentText(line);
      const mathRuns = resegmented.filter(seg => seg.kind !== 'text');
      expect(mathRuns).toHaveLength(1);
      expect(mathRuns[0]?.kind).toBe(original.kind);
      expect(mathRuns[0]?.latex).toBe(original.latex);

      // Verify src/export/tex.ts planner accepts every exported formula cleanly.
      const plan = planFormula(original.latex);
      expect(plan.ops.length).toBeGreaterThan(0);
      expect(plainText(original.latex).length).toBeGreaterThan(0);
    });
  });

  it('supports deduplication, kind/page/blockId filtering, display environments, and pre-detected hits', () => {
    const deduped = extractExportFormulas(blocks, { deduplicate: true, kinds: ['inline-math'] });
    expect(deduped.some(f => f.kind === 'display-math')).toBe(false);
    expect(deduped.filter(f => f.latex === 'E = mc^{2}')).toHaveLength(1);

    const eqTex = exportFormulasToTex(blocks, {
      pages: [2],
      kinds: ['display-math'],
      displayEnvironment: 'equation',
    });
    expect(eqTex).toContain('\\begin{equation}\n\\frac{a}{b} + \\alpha\n\\end{equation}');
    expect(eqTex).toContain('\\begin{equation}\n\\sum_{i}^{n} x_{i}\n\\end{equation}');

    const hits = detectFormulas(blocks);
    const fromHits = exportDetectedFormulasToTex(hits, {
      blockIds: ['b3'],
      standalone: false,
      displayEnvironment: 'equation*',
    });
    expect(fromHits).not.toContain('\\documentclass');
    expect(fromHits).toContain('\\begin{equation*}\n\\frac{a}{b} + \\alpha\n\\end{equation*}');
    expect(fromHits).toContain('\\(H_{2}O\\)');

    const emptyTex = exportFormulasToTex([{ id: 'plain', page: 1, text: 'No formulas here.' }]);
    expect(emptyTex).toContain('% No formulas detected.');
    expect(emptyTex).toContain('\\end{document}');
  });
});
