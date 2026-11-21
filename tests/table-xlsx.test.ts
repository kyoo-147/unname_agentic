import { describe, expect, it } from 'vitest';
import { detectFormulas } from '../src/core/formulas';
import { sniffFormat } from '../src/core/import-formats';
import { extractTable } from '../src/core/tables';
import type { TableCell } from '../src/core/tables';
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
    spans: [
      { row: 1, col: 0, colSpan: 1, rowSpan: 2 },
    ],
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
    ]);

    expect(archive[0]).toBe(0x50);
    expect(archive[1]).toBe(0x4b);
    expect(archive[2]).toBe(0x03);
    expect(archive[3]).toBe(0x04);

    // End of Central Directory signature at the end (no comment -> last 22 bytes).
    const eocdOffset = archive.length - 22;
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
    expect(view.getUint16(eocdOffset + 10, true)).toBe(1);
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
  it('formats UTF-8 Vietnamese/CJK, quotes special characters, and uses CRLF', () => {
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
  });

  it('exports selected tables to separate CSV files and combined CSV', () => {
    const tables = sampleTables();
    const files = exportSelectedTablesToCsv(tables, { selection: { pages: [1, 2] } });
    expect(files).toHaveLength(2);
    expect(files[0]?.id).toBe('tbl-pop');
    expect(files[0]?.filename).toMatch(/\.csv$/);
    expect(files[0]?.csv).toContain('Hà Nội,8053');
    expect(files[1]?.id).toBe('tbl-matrix');

    const combined = exportTablesToCsv(tables, { selection: { ids: ['tbl-pop'] } });
    expect(combined).toContain('Population by province,');
    expect(combined).toContain('Đà Nẵng,1134');
  });
});

describe('H08 OOXML XLSX export basics', () => {
  it('produces a valid XLSX archive recognised by sniffFormat', () => {
    const tables = sampleTables();
    const xlsx = exportTablesToXlsx(tables, { selection: { pages: [1, 2] } });
    expect(xlsx).toBeInstanceOf(Uint8Array);
    expect(xlsx.length).toBeGreaterThan(200);

    const sniff = sniffFormat(xlsx, 'report.xlsx');
    expect(sniff.format).toBe('xlsx');
    expect(sniff.confidence).toBe('likely');

    const single = exportTableToXlsx(tables[0]!);
    expect(sniffFormat(single, 'single.xlsx').format).toBe('xlsx');
  });
});

describe('H08 LaTeX formula export', () => {
  const blocks: FormulaSourceBlock[] = [
    { id: 'b1', page: 1, text: 'The kinetic energy is $E = mc^2$ in vacuum.' },
    { id: 'b2', page: 1, text: 'Plain text without mathematics.' },
    { id: 'b3', page: 2, raw: 'Where \\[\\frac{a}{b} + \\alpha\\] holds and H_2O freezes.' },
  ];

  it('extracts formulas with page and block provenance and exports a .tex document', () => {
    const extracted = extractExportFormulas(blocks);
    expect(extracted).toHaveLength(3);
    expect(extracted[0]).toMatchObject({
      index: 1,
      blockId: 'b1',
      page: 1,
      kind: 'inline-math',
      latex: 'E = mc^{2}',
    });
    expect(extracted[1]).toMatchObject({
      index: 2,
      blockId: 'b3',
      page: 2,
      kind: 'display-math',
      latex: '\\frac{a}{b} + \\alpha',
    });
    expect(extracted[2]).toMatchObject({
      index: 3,
      blockId: 'b3',
      page: 2,
      kind: 'inline-math',
      latex: 'H_{2}O',
    });

    const tex = exportFormulasToTex(blocks, {
      title: 'Physics & Chemistry Formulas (50%)',
      author: 'Dr. Nguyễn',
    });
    expect(tex).toContain('\\documentclass[11pt]{article}');
    expect(tex).toContain('\\usepackage{amsmath}');
    expect(tex).toContain('\\usepackage{amssymb}');
    expect(tex).toContain('\\title{Physics \\& Chemistry Formulas (50\\%)}');
    expect(tex).toContain('\\begin{document}');
    expect(tex).toContain('\\end{document}');
    expect(tex).toContain('\\(E = mc^{2}\\)');
    expect(tex).toContain('\\[\\frac{a}{b} + \\alpha\\]');
    expect(tex).toContain('\\(H_{2}O\\)');
  });

  it('supports filtering by page/blockId and exporting pre-detected FormulaBlockHit lists', () => {
    const bundle = exportFormulasBundle(blocks, { pages: [2] });
    expect(bundle.formulas).toHaveLength(2);
    expect(bundle.tex).not.toContain('E = mc^{2}');
    expect(bundle.tex).toContain('\\frac{a}{b} + \\alpha');

    const hits = detectFormulas(blocks);
    const fromHits = exportDetectedFormulasToTex(hits, { blockIds: ['b1'], standalone: false });
    expect(fromHits).not.toContain('\\documentclass');
    expect(fromHits).toContain('\\(E = mc^{2}\\)');
  });
});
