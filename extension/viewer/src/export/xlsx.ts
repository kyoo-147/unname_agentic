import type { Table } from '../core/tables';

export interface XlsxExportResult {
  format: 'xlsx';
  bytes: Uint8Array;
  lossy: boolean;
  limitations: string[];
}

function xml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

function columnName(index: number): string {
  let value = '';
  let number = index + 1;
  while (number > 0) {
    const remainder = (number - 1) % 26;
    value = String.fromCharCode(65 + remainder) + value;
    number = Math.floor((number - 1) / 26);
  }
  return value;
}

function rowsOf(table: Table): string[][] {
  const width = Math.max(table.headers.length, ...table.rows.map(row => row.length), 0);
  if (width === 0) return [];
  const pad = (row: readonly string[]) => Array.from({ length: width }, (_, index) => row[index] ?? '');
  return [pad(table.headers), ...table.rows.map(pad)];
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): number[] { return [value & 0xff, (value >>> 8) & 0xff]; }
function u32(value: number): number[] { return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]; }

function zipStore(files: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const output: number[] = [];
  const entries: { name: Uint8Array; crc: number; size: number; offset: number }[] = [];
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const offset = output.length;
    const crc = crc32(file.data);
    output.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(file.data.length), ...u32(file.data.length), ...u16(name.length), ...u16(0), ...name, ...file.data);
    entries.push({ name, crc, size: file.data.length, offset });
  }
  const centralOffset = output.length;
  for (const entry of entries) output.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(entry.crc), ...u32(entry.size), ...u32(entry.size), ...u16(entry.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(entry.offset), ...entry.name);
  const centralSize = output.length - centralOffset;
  output.push(...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(centralSize), ...u32(centralOffset), ...u16(0));
  return Uint8Array.from(output);
}

/** Writes a minimal standards-compliant XLSX package without adding a runtime dependency. */
export function exportTableXlsx(table: Table): XlsxExportResult {
  const rows = rowsOf(table);
  const sheetRows = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => {
    const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const parts = [
    { name: '[Content_Types].xml', data: new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') },
    { name: '_rels/.rels', data: new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
    { name: 'xl/workbook.xml', data: new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Table" sheetId="1" r:id="rId1"/></sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', data: new TextEncoder().encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
    { name: 'xl/styles.xml', data: new TextEncoder().encode('<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>') },
    { name: 'xl/worksheets/sheet1.xml', data: new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`) },
  ];
  return { format: 'xlsx', bytes: zipStore(parts), lossy: table.spans.length > 0, limitations: table.spans.length > 0 ? ['Merged cells are represented as one cell; XLSX span geometry is not recreated.'] : [] };
}
