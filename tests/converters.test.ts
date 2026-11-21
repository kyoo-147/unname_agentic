import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  CONVERTIBLE_FORMATS,
  ConverterError,
  convertDocument,
  convertDocx,
  convertEpub,
  convertHtml,
  convertImage,
  convertPptx,
  convertXlsx,
  decodeHtmlEntities,
  inflateRawPure,
  parseZip,
  sha256HexBytes,
} from '../src/core/converters';
import { DOCUMENT_IR_SCHEMA_VERSION, deserialize, serialize, validate } from '../src/core/ir';

// --- Byte & ZIP fixture helpers --------------------------------------------

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16le(value: number): Uint8Array {
  const buf = new Uint8Array(2);
  buf[0] = value & 0xff;
  buf[1] = (value >>> 8) & 0xff;
  return buf;
}

function u32le(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = value & 0xff;
  buf[1] = (value >>> 8) & 0xff;
  buf[2] = (value >>> 16) & 0xff;
  buf[3] = (value >>> 24) & 0xff;
  return buf;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface FixtureZipEntry {
  readonly name: string;
  readonly data: string | Uint8Array;
  readonly method?: number;
  readonly flags?: number;
  readonly dataDescriptor?: boolean;
}

function buildZip(entries: readonly FixtureZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8(entry.name);
    const rawData = typeof entry.data === 'string' ? utf8(entry.data) : entry.data;
    const method = entry.method ?? 0;
    const compressed = method === 8 ? new Uint8Array(deflateRawSync(rawData)) : rawData;
    const crc = crc32(rawData);
    const flags = (entry.flags ?? 0x0800) | (entry.dataDescriptor ? 0x0008 : 0);

    const localHeader = concatBytes([
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      u16le(20),
      u16le(flags),
      u16le(method),
      u16le(0),
      u16le(0),
      u32le(entry.dataDescriptor ? 0 : crc),
      u32le(entry.dataDescriptor ? 0 : compressed.length),
      u32le(entry.dataDescriptor ? 0 : rawData.length),
      u16le(nameBytes.length),
      u16le(0),
      nameBytes,
      compressed,
      ...(entry.dataDescriptor
        ? [new Uint8Array([0x50, 0x4b, 0x07, 0x08]), u32le(crc), u32le(compressed.length), u32le(rawData.length)]
        : []),
    ]);

    const centralHeader = concatBytes([
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
      u16le(20),
      u16le(20),
      u16le(flags),
      u16le(method),
      u16le(0),
      u16le(0),
      u32le(crc),
      u32le(compressed.length),
      u32le(rawData.length),
      u16le(nameBytes.length),
      u16le(0),
      u16le(0),
      u16le(0),
      u16le(0),
      u32le(0),
      u32le(offset),
      nameBytes,
    ]);

    localParts.push(localHeader);
    centralParts.push(centralHeader);
    offset += localHeader.length;
  }

  const centralDir = concatBytes(centralParts);
  const eocd = concatBytes([
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
    u16le(0),
    u16le(0),
    u16le(entries.length),
    u16le(entries.length),
    u32le(centralDir.length),
    u32le(offset),
    u16le(0),
  ]);

  return concatBytes([...localParts, centralDir, eocd]);
}

function makePng(width: number, height: number): Uint8Array {
  const ihdrPayload = new Uint8Array(17);
  ihdrPayload.set([0x49, 0x48, 0x44, 0x52], 0); // IHDR
  const view = new DataView(ihdrPayload.buffer);
  view.setUint32(4, width, false);
  view.setUint32(8, height, false);
  ihdrPayload[12] = 8; // bit depth
  ihdrPayload[13] = 2; // RGB
  const ihdrCrc = crc32(ihdrPayload);

  return concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    new Uint8Array([0x00, 0x00, 0x00, 0x0d]),
    ihdrPayload,
    new Uint8Array([(ihdrCrc >>> 24) & 0xff, (ihdrCrc >>> 16) & 0xff, (ihdrCrc >>> 8) & 0xff, ihdrCrc & 0xff]),
  ]);
}

function makeJpeg(width: number, height: number, sofMarker = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, // APP0 length 16
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, sofMarker, 0x00, 0x0b, // SOF length 11
    0x08, // sample precision
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9, // EOI
  ]);
}

function makeTiff(width: number, height: number, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  if (littleEndian) {
    bytes.set([0x49, 0x49, 0x2a, 0x00], 0);
  } else {
    bytes.set([0x4d, 0x4d, 0x00, 0x2a], 0);
  }
  view.setUint32(4, 8, littleEndian); // IFD offset
  view.setUint16(8, 2, littleEndian); // 2 IFD entries

  // Tag 256 (ImageWidth), type LONG (4), count 1
  view.setUint16(10, 256, littleEndian);
  view.setUint16(12, 4, littleEndian);
  view.setUint32(14, 1, littleEndian);
  view.setUint32(18, width, littleEndian);

  // Tag 257 (ImageLength), type SHORT (3), count 1 (stored in first 2 bytes of value field)
  view.setUint16(22, 257, littleEndian);
  view.setUint16(24, 3, littleEndian);
  view.setUint32(26, 1, littleEndian);
  view.setUint16(30, height, littleEndian);

  // Next IFD offset = 0
  view.setUint32(34, 0, littleEndian);
  return bytes;
}

// --- Registry --------------------------------------------------------------

describe('CONVERTIBLE_FORMATS', () => {
  it('lists all eight E12 converter formats', () => {
    expect(CONVERTIBLE_FORMATS).toEqual(['docx', 'pptx', 'xlsx', 'epub', 'html', 'png', 'jpeg', 'tiff']);
  });
});

// --- DOCX ------------------------------------------------------------------

describe('convertDocx', () => {
  it('extracts headings, paragraphs, tables, metadata, and provenance into valid DocumentIR', () => {
    const docx = buildZip([
      { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
      {
        name: 'docProps/core.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Annual Report</dc:title>
  <dc:creator>Ada Lovelace</dc:creator>
  <dc:language>en-US</dc:language>
</cp:coreProperties>`,
      },
      {
        name: 'word/document.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Executive Summary</w:t></w:r>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading2"/></w:pPr>
      <w:r><w:t>Key Metrics</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Revenue grew by 25% &amp; costs declined.</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Quarter</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Total</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Q1</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>1200</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`,
      },
    ]);

    const result = convertDocx(docx);
    expect(result.format).toBe('docx');
    expect(result.metadata).toMatchObject({
      format: 'docx',
      title: 'Annual Report',
      creator: 'Ada Lovelace',
      language: 'en-US',
    });

    expect(validate(result.ir)).toEqual([]);
    expect(result.ir.schemaVersion).toBe(DOCUMENT_IR_SCHEMA_VERSION);
    expect(result.ir.sourceSha256).toBe(sha256(docx));
    expect(result.ir.language).toBe('en-US');
    expect(result.ir.pages).toHaveLength(1);
    expect(result.ir.blocks.map(b => [b.type, b.raw])).toEqual([
      ['heading', 'Executive Summary'],
      ['heading', 'Key Metrics'],
      ['paragraph', 'Revenue grew by 25% & costs declined.'],
      ['table', 'Quarter\tTotal\nQ1\t1200'],
    ]);
    expect(result.ir.provenance).toHaveLength(4);
    expect(result.ir.provenance.every(p => p.transform === 'import' && p.ocrEngine === null)).toBe(true);
    expect(serialize(convertDocument(docx).ir)).toBe(serialize(result.ir));
  });
});

// --- PPTX ------------------------------------------------------------------

describe('convertPptx', () => {
  it('orders slides numerically and extracts shape text boxes into slide pages', () => {
    const slideXml = (title: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>
        <p:txBody><a:p><a:r><a:t>${body}</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;

    const pptx = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      {
        name: 'ppt/presentation.xml',
        data: '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
      },
      {
        name: 'docProps/core.xml',
        data: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Q4 Deck</dc:title><dc:creator>Grace Hopper</dc:creator><dc:language>en</dc:language></cp:coreProperties>',
      },
      { name: 'ppt/slides/slide10.xml', data: slideXml('Slide Ten', 'Closing remarks') },
      { name: 'ppt/slides/slide2.xml', data: slideXml('Slide Two', 'Agenda details') },
      { name: 'ppt/slides/slide1.xml', data: slideXml('Slide One', 'Welcome') },
    ]);

    const result = convertPptx(pptx);
    expect(result.format).toBe('pptx');
    expect(result.metadata).toMatchObject({
      format: 'pptx',
      title: 'Q4 Deck',
      creator: 'Grace Hopper',
      language: 'en',
      slideCount: 3,
    });
    expect(validate(result.ir)).toEqual([]);
    expect(result.ir.sourceSha256).toBe(sha256(pptx));
    expect(result.ir.pages.map(p => p.index)).toEqual([1, 2, 3]);
    expect(result.ir.pages[0]).toMatchObject({ width: 960, height: 540, rotation: 0 });
    expect(result.ir.blocks.map(b => [b.page, b.type, b.raw])).toEqual([
      [1, 'heading', 'Slide One'],
      [1, 'paragraph', 'Welcome'],
      [2, 'heading', 'Slide Two'],
      [2, 'paragraph', 'Agenda details'],
      [3, 'heading', 'Slide Ten'],
      [3, 'paragraph', 'Closing remarks'],
    ]);
  });
});

// --- XLSX ------------------------------------------------------------------

describe('convertXlsx', () => {
  it('resolves shared strings, inline strings, numeric cells, and worksheet pages', () => {
    const xlsx = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      {
        name: 'xl/workbook.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Summary" sheetId="1" r:id="rId1"/>
    <sheet name="Details" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`,
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
</Relationships>`,
      },
      {
        name: 'xl/sharedStrings.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <si><t>Item</t></si>
  <si><t>Qty</t></si>
  <si><r><t>Note</t></r><r><t>book</t></r></si>
</sst>`,
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>2</v></c>
      <c r="B2"><v>42</v></c>
    </row>
    <row r="3">
      <c r="A3" t="inlineStr"><is><t>Pen</t></is></c>
      <c r="B3" t="n"><v>7.5</v></c>
    </row>
  </sheetData>
</worksheet>`,
      },
      {
        name: 'xl/worksheets/sheet2.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Region</t></is></c>
      <c r="C1"><v>100</v></c>
    </row>
  </sheetData>
</worksheet>`,
      },
    ]);

    const result = convertXlsx(xlsx);
    expect(result.format).toBe('xlsx');
    expect(result.metadata.sheetNames).toEqual(['Summary', 'Details']);
    expect(validate(result.ir)).toEqual([]);
    expect(result.ir.sourceSha256).toBe(sha256(xlsx));
    expect(result.ir.pages.map(p => p.index)).toEqual([1, 2]);
    expect(result.ir.blocks.filter(b => b.type === 'table').map(b => [b.page, b.raw])).toEqual([
      [1, 'Item\tQty\nNotebook\t42\nPen\t7.5'],
      [2, 'Region\t\t100'],
    ]);
  });
});

// --- EPUB ------------------------------------------------------------------

describe('convertEpub', () => {
  it('follows container.xml and OPF spine to build chapter pages with metadata', () => {
    const epub = buildZip([
      { name: 'mimetype', data: 'application/epub+zip' },
      {
        name: 'META-INF/container.xml',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
      },
      {
        name: 'OEBPS/content.opf',
        data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Moby Test</dc:title>
    <dc:creator>Herman Tester</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`,
      },
      {
        name: 'OEBPS/Text/ch1.xhtml',
        data: `<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Chapter One</h1><p>Call me Ishmael.</p></body></html>`,
      },
      {
        name: 'OEBPS/Text/ch2.xhtml',
        data: `<html xmlns="http://www.w3.org/1999/xhtml"><body><h2>The Voyage</h2><p>Out to sea.</p></body></html>`,
      },
    ]);

    const result = convertEpub(epub);
    expect(result.format).toBe('epub');
    expect(result.metadata).toMatchObject({
      format: 'epub',
      title: 'Moby Test',
      author: 'Herman Tester',
      language: 'en',
      chapterCount: 2,
    });
    expect(validate(result.ir)).toEqual([]);
    expect(result.ir.sourceSha256).toBe(sha256(epub));
    expect(result.ir.language).toBe('en');
    expect(result.ir.pages.map(p => p.index)).toEqual([1, 2]);
    expect(result.ir.blocks.map(b => [b.page, b.type, b.raw])).toEqual([
      [1, 'heading', 'Chapter One'],
      [1, 'paragraph', 'Call me Ishmael.'],
      [2, 'heading', 'The Voyage'],
      [2, 'paragraph', 'Out to sea.'],
    ]);
  });
});

// --- HTML ------------------------------------------------------------------

describe('convertHtml', () => {
  it('parses metadata, headings, paragraphs, lists, tables, and decodes entities', () => {
    const html = utf8(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>Guide &amp; R&eacute;f&eacute;rence</title>
  <meta name="author" content="Marie Curie">
  <meta name="description" content="Notes de laboratoire &mdash; 2026">
  <style>body { color: black; }</style>
  <script>console.log("ignore me");</script>
</head>
<body>
  <h1>Introduction</h1>
  <p>Bonjour &ldquo;monde&rdquo; &#x2014; 100&#37;.</p>
  <ul>
    <li>Premier point</li>
    <li>Deuxi&egrave;me point</li>
  </ul>
  <table>
    <tr><th>Cl&eacute;</th><th>Valeur</th></tr>
    <tr><td>A</td><td>1 &lt; 2</td></tr>
  </table>
</body>
</html>`);

    const result = convertHtml(html);
    expect(result.format).toBe('html');
    expect(result.metadata).toMatchObject({
      format: 'html',
      title: 'Guide & Référence',
      author: 'Marie Curie',
      language: 'fr',
      description: 'Notes de laboratoire — 2026',
    });
    expect(validate(result.ir)).toEqual([]);
    expect(result.ir.sourceSha256).toBe(sha256(html));
    expect(result.ir.language).toBe('fr');
    expect(result.ir.blocks.map(b => [b.type, b.raw])).toEqual([
      ['heading', 'Introduction'],
      ['paragraph', 'Bonjour “monde” — 100%.'],
      ['list', 'Premier point'],
      ['list', 'Deuxième point'],
      ['table', 'Clé\tValeur\nA\t1 < 2'],
    ]);
  });

  it('decodes named and numeric entities without double-unescaping', () => {
    expect(decodeHtmlEntities('&amp;lt;tag&amp;gt; &mdash; &#65; &#x42; &nbsp;')).toBe('&lt;tag&gt; — A B \u00a0');
  });
});

// --- Images (PNG, JPEG, TIFF) ----------------------------------------------

describe('convertImage', () => {
  it('parses PNG IHDR dimensions into an OCR-ready DocumentIR page and figure block', () => {
    const png = makePng(1280, 720);
    const result = convertImage(png);
    expect(result.format).toBe('png');
    expect(result.metadata).toMatchObject({ format: 'png', imageWidth: 1280, imageHeight: 720 });
    expect(validate(result.ir)).toEqual([]);
    expect(result.ir.sourceSha256).toBe(sha256(png));
    expect(result.ir.pages).toEqual([{ index: 1, width: 1280, height: 720, rotation: 0 }]);
    expect(result.ir.blocks).toHaveLength(1);
    expect(result.ir.blocks[0]).toMatchObject({
      id: 'p1-r0',
      type: 'figure',
      page: 1,
      raw: '',
      polygon: [
        { x: 0, y: 0 },
        { x: 1280, y: 0 },
        { x: 1280, y: 720 },
        { x: 0, y: 720 },
      ],
    });
    expect(result.ir.provenance[0]).toMatchObject({ blockId: 'p1-r0', transform: 'import' });
  });

  it('parses JPEG SOF0 and SOF2 dimensions accurately', () => {
    const baseline = makeJpeg(1920, 1080, 0xc0);
    const progressive = makeJpeg(800, 600, 0xc2);

    const r0 = convertDocument(baseline);
    expect(r0.format).toBe('jpeg');
    expect(r0.metadata).toMatchObject({ imageWidth: 1920, imageHeight: 1080 });
    expect(r0.ir.pages[0]).toEqual({ index: 1, width: 1920, height: 1080, rotation: 0 });
    expect(validate(r0.ir)).toEqual([]);

    const r2 = convertImage(progressive);
    expect(r2.format).toBe('jpeg');
    expect(r2.metadata).toMatchObject({ imageWidth: 800, imageHeight: 600 });
    expect(r2.ir.pages[0]).toEqual({ index: 1, width: 800, height: 600, rotation: 0 });
    expect(validate(r2.ir)).toEqual([]);
  });

  it('parses little-endian and big-endian TIFF IFD width and height tags', () => {
    const le = makeTiff(2480, 3508, true);
    const be = makeTiff(640, 480, false);

    const rLe = convertDocument(le);
    expect(rLe.format).toBe('tiff');
    expect(rLe.metadata).toMatchObject({ imageWidth: 2480, imageHeight: 3508 });
    expect(rLe.ir.pages[0]).toEqual({ index: 1, width: 2480, height: 3508, rotation: 0 });
    expect(validate(rLe.ir)).toEqual([]);

    const rBe = convertImage(be);
    expect(rBe.format).toBe('tiff');
    expect(rBe.metadata).toMatchObject({ imageWidth: 640, imageHeight: 480 });
    expect(rBe.ir.pages[0]).toEqual({ index: 1, width: 640, height: 480, rotation: 0 });
    expect(validate(rBe.ir)).toEqual([]);
  });
});

// --- UTF-8, DEFLATE ZIP, pagination, and validateIR compliance -------------

function encodeUtf16LeWithBom(text: string): Uint8Array {
  const buf = new Uint8Array(2 + text.length * 2);
  buf[0] = 0xff;
  buf[1] = 0xfe;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    buf[2 + i * 2] = code & 0xff;
    buf[2 + i * 2 + 1] = (code >>> 8) & 0xff;
  }
  return buf;
}

function converterErrorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof ConverterError ? error.code : `other:${String(error)}`;
  }
  return 'no-error';
}

describe('E12 SHA-256, DEFLATE ZIP, and UTF-8 handling', () => {
  it('computes FIPS 180-4 SHA-256 matching Node crypto across empty, UTF-8, and binary bytes', () => {
    const samples = [
      new Uint8Array(0),
      utf8('Tiếng Việt — 日本語 📄'),
      new Uint8Array(55).fill(0x61),
      new Uint8Array(56).fill(0x62),
      new Uint8Array(64).fill(0x63),
      new Uint8Array(128).map((_, idx) => (idx * 37) & 0xff),
    ];
    for (const sample of samples) {
      expect(sha256HexBytes(sample)).toBe(sha256(sample));
    }
  });

  it('decompresses DEFLATE stored, fixed-Huffman, and dynamic-Huffman blocks with inflateRawPure', () => {
    // Stored DEFLATE block (BTYPE = 00): "hi"
    const storedDeflate = new Uint8Array([0x01, 0x02, 0x00, 0xfd, 0xff, 0x68, 0x69]);
    expect(new TextDecoder().decode(inflateRawPure(storedDeflate))).toBe('hi');

    // Short payload -> fixed Huffman (BTYPE = 01)
    const shortInput = utf8('Hello DEFLATE!');
    expect(new TextDecoder().decode(inflateRawPure(new Uint8Array(deflateRawSync(shortInput))))).toBe('Hello DEFLATE!');

    // Large repetitive XML + UTF-8 -> dynamic Huffman (BTYPE = 10)
    const largeText = Array.from({ length: 120 }, (_, i) => `<w:p><w:r><w:t>Đoạn ${i}: Tiếng Việt &amp; 日本語</w:t></w:r></w:p>`).join('\n');
    const largeCompressed = new Uint8Array(deflateRawSync(utf8(largeText)));
    expect(new TextDecoder().decode(inflateRawPure(largeCompressed))).toBe(largeText);
  });

  it('converts DEFLATE-compressed DOCX, PPTX, XLSX, and EPUB via both Node zlib and inflateRawPure', () => {
    const docx = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>', method: 8 },
      {
        name: 'docProps/core.xml',
        data: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Báo cáo 2026</dc:title><dc:creator>Nguyễn Văn A</dc:creator><dc:language>vi</dc:language></cp:coreProperties>',
        method: 8,
      },
      {
        name: 'word/styles.xml',
        data: '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="TieuDe1"><w:name w:val="heading 1"/></w:style></w:styles>',
        method: 8,
      },
      {
        name: 'word/document.xml',
        data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="TieuDe1"/></w:pPr><w:r><w:t>Tổng quan 📄</w:t></w:r></w:p>
    <w:sdt><w:sdtContent><w:p><w:r><w:t>Tiếng Việt chuẩn UTF-8 và </w:t></w:r><w:del><w:delText>bị xóa</w:delText></w:del><w:r><w:t>日本語.</w:t></w:r></w:p></w:sdtContent></w:sdt>
    <w:p><w:r><w:br w:type="page"/><w:t>Trang hai</w:t></w:r></w:p>
  </w:body>
</w:document>`,
        method: 8,
        dataDescriptor: true,
      },
    ]);

    const viaNode = convertDocx(docx);
    const viaPure = convertDocx(docx, { inflateRaw: inflateRawPure });
    expect(serialize(viaPure.ir)).toBe(serialize(viaNode.ir));
    expect(serialize(convertDocument(docx).ir)).toBe(serialize(viaNode.ir));

    // Simulate browser environment (no globalThis.process / node:zlib)
    let viaBrowserFallback: ReturnType<typeof convertDocument>;
    try {
      vi.stubGlobal('process', undefined);
      viaBrowserFallback = convertDocument(docx);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(serialize(viaBrowserFallback.ir)).toBe(serialize(viaNode.ir));

    expect(validate(viaPure.ir)).toEqual([]);
    expect(viaPure.metadata).toMatchObject({ title: 'Báo cáo 2026', creator: 'Nguyễn Văn A', language: 'vi' });
    expect(viaPure.ir.pages.map(p => p.index)).toEqual([1, 2]);
    expect(viaPure.ir.blocks.map(b => [b.page, b.type, b.raw])).toEqual([
      [1, 'heading', 'Tổng quan 📄'],
      [1, 'paragraph', 'Tiếng Việt chuẩn UTF-8 và 日本語.'],
      [2, 'paragraph', 'Trang hai'],
    ]);
    // Ensure round-trip serialization stays valid
    const roundTripped = deserialize(serialize(viaPure.ir));
    expect(validate(roundTripped)).toEqual([]);
  });

  it('handles UTF-8 ZIP filenames and DEFLATE EPUB chapters', () => {
    const epub = buildZip([
      { name: 'mimetype', data: 'application/epub+zip', method: 0 },
      {
        name: 'META-INF/container.xml',
        data: '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf"/></rootfiles></container>',
        method: 8,
      },
      {
        name: 'OEBPS/package.opf',
        data: `<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Truyện Ngắn</dc:title>
    <dc:creator>Tác Giả</dc:creator>
    <dc:language>vi</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="Chương_1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`,
        method: 8,
      },
      {
        name: 'OEBPS/Chương_1.xhtml',
        data: '<html><body><h1>Mở đầu</h1><p>Xin chào thế giới.</p></body></html>',
        method: 8,
      },
    ]);

    const result = convertEpub(epub, { inflateRaw: inflateRawPure });
    expect(validate(result.ir)).toEqual([]);
    expect(result.metadata).toMatchObject({ title: 'Truyện Ngắn', author: 'Tác Giả', language: 'vi' });
    expect(result.ir.blocks.map(b => [b.type, b.raw])).toEqual([
      ['heading', 'Mở đầu'],
      ['paragraph', 'Xin chào thế giới.'],
    ]);
  });

  it('paginates multi-page DOCX documents and clamps out-of-bounds PPTX geometry to pass validate()', () => {
    const manyParagraphs = Array.from({ length: 45 }, (_, i) => `<w:p><w:r><w:t>Paragraph ${i + 1}: steady text line</w:t></w:r></w:p>`).join('');
    const longDocx = buildZip([
      {
        name: 'word/document.xml',
        data: `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${manyParagraphs}</w:body></w:document>`,
        method: 8,
      },
    ]);
    const docxResult = convertDocx(longDocx);
    expect(docxResult.ir.pages.length).toBeGreaterThan(1);
    expect(validate(docxResult.ir)).toEqual([]);

    const pptx = buildZip([
      {
        name: 'ppt/presentation.xml',
        data: '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="12192000" cy="6858000"/></p:presentation>',
        method: 8,
      },
      {
        name: 'ppt/slides/slide1.xml',
        data: `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:grpSp>
      <p:sp>
        <p:spPr><a:xfrm><a:off x="-127000" y="6350000"/><a:ext cx="19050000" cy="3810000"/></a:xfrm></p:spPr>
        <p:txBody><a:p><a:r><a:t>Clamped grouped text</a:t></a:r></a:p></p:txBody>
      </p:sp>
    </p:grpSp>
    <p:graphicFrame>
      <a:graphic><a:graphicData><a:tbl>
        <a:tr><a:tc><a:txBody><a:p><a:r><a:t>H1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>H2</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
      </a:tbl></a:graphicData></a:graphic>
    </p:graphicFrame>
  </p:spTree></p:cSld>
</p:sld>`,
        method: 8,
      },
    ]);
    const pptxResult = convertPptx(pptx, { inflateRaw: inflateRawPure });
    expect(serialize(convertDocument(pptx).ir)).toBe(serialize(pptxResult.ir));
    expect(validate(pptxResult.ir)).toEqual([]);
    expect(pptxResult.ir.blocks.map(b => [b.type, b.raw])).toEqual([
      ['table', 'H1\tH2'],
      ['paragraph', 'Clamped grouped text'],
    ]);

    const narrowPptx = buildZip([
      {
        name: 'ppt/presentation.xml',
        data: '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="508000" cy="508000"/></p:presentation>',
        method: 8,
      },
      {
        name: 'ppt/slides/slide1.xml',
        data: '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Narrow fallback</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
        method: 8,
      },
    ]);
    const narrowResult = convertDocument(narrowPptx);
    expect(narrowResult.format).toBe('pptx');
    expect(validate(narrowResult.ir)).toEqual([]);

    const xlsxDeflate = buildZip([
      {
        name: 'xl/workbook.xml',
        data: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="Báo cáo" sheetId="1"/></sheets></workbook>',
        method: 8,
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Số lượng</t></is></c><c r="B1"><v>99</v></c></row></sheetData></worksheet>',
        method: 8,
      },
    ]);
    const xlsxResult = convertXlsx(xlsxDeflate, { inflateRaw: inflateRawPure });
    expect(serialize(convertDocument(xlsxDeflate).ir)).toBe(serialize(xlsxResult.ir));
    expect(validate(xlsxResult.ir)).toEqual([]);
    expect(xlsxResult.metadata.sheetNames).toEqual(['Báo cáo']);
    expect(xlsxResult.ir.blocks.filter(b => b.type === 'table')[0]?.raw).toBe('Số lượng\t99');
  });

  it('decodes UTF-16LE HTML, handles HTML fragments via filename, and validates empty HTML', () => {
    const utf16Html = encodeUtf16LeWithBom('<html lang="vi"><head><title>Tiêu đề</title></head><body><p>Xin ch&#224;o &#x1EC7; &#8212;</p></body></html>');
    const res16 = convertHtml(utf16Html);
    expect(validate(res16.ir)).toEqual([]);
    expect(res16.metadata.title).toBe('Tiêu đề');
    expect(res16.ir.blocks[0]?.raw).toBe('Xin chào ệ —');
    expect(serialize(convertDocument(utf16Html).ir)).toBe(serialize(res16.ir));

    const utf16Frag = convertDocument(encodeUtf16LeWithBom('<p>Đoạn UTF-16</p>'), { filename: 'utf16-frag.html' });
    expect(utf16Frag.format).toBe('html');
    expect(validate(utf16Frag.ir)).toEqual([]);
    expect(utf16Frag.ir.blocks[0]?.raw).toBe('Đoạn UTF-16');

    const frag = convertDocument(utf8('<p>Fragment &amp; test</p>'), { filename: 'snippet.html' });
    expect(frag.format).toBe('html');
    expect(validate(frag.ir)).toEqual([]);
    expect(frag.ir.blocks[0]?.raw).toBe('Fragment & test');

    const emptyHtml = convertHtml(utf8('<!DOCTYPE html><html><body></body></html>'));
    expect(validate(emptyHtml.ir)).toEqual([]);
    expect(emptyHtml.ir.pages).toHaveLength(1);
    expect(emptyHtml.ir.blocks).toEqual([]);
  });
});

describe('E12 corrupted archives and malformed input errors', () => {
  it('rejects empty or non-Uint8Array inputs and unsupported formats', () => {
    expect(converterErrorCode(() => convertDocument(new Uint8Array(0)))).toBe('invalid-input');
    expect(converterErrorCode(() => convertDocument(null as unknown as Uint8Array))).toBe('invalid-input');
    expect(converterErrorCode(() => convertDocument(utf8('%PDF-1.7\n'), { filename: 'doc.pdf' }))).toBe('unsupported-format');
    expect(converterErrorCode(() => convertDocument(utf8('{\\rtf1 hello}')))).toBe('unsupported-format');
    expect(converterErrorCode(() => convertDocument(new Uint8Array([0x01, 0x02, 0x03, 0x04])))).toBe('unsupported-format');
  });

  it('rejects truncated ZIPs, bad EOCD offsets, CRC mismatches, bad compression, and bad DEFLATE streams', () => {
    // Truncated ZIP (no EOCD)
    expect(converterErrorCode(() => parseZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0])))).toBe('corrupted-archive');

    // Valid ZIP whose central directory offset is corrupted
    const validZip = buildZip([{ name: 'word/document.xml', data: '<w:document/>', method: 0 }]);
    const badOffsetZip = new Uint8Array(validZip);
    badOffsetZip[badOffsetZip.length - 6] = 0xff; // corrupt cdOffset in EOCD
    expect(converterErrorCode(() => parseZip(badOffsetZip))).toBe('corrupted-archive');

    // CRC mismatch on stored payload
    const badCrcZip = new Uint8Array(validZip);
    const xmlPos = new TextDecoder().decode(badCrcZip).indexOf('<w:document/>');
    badCrcZip[xmlPos + 1] = 0x58; // mutate 'w' -> 'X'
    expect(converterErrorCode(() => parseZip(badCrcZip))).toBe('corrupted-archive');

    // Unsupported compression method (method = 99)
    const unsupportedMethodZip = buildZip([{ name: 'word/document.xml', data: '<w:document/>', method: 99 }]);
    expect(converterErrorCode(() => parseZip(unsupportedMethodZip))).toBe('unsupported-compression');

    // Encrypted entry bit (flags = 0x0001)
    const encryptedZip = buildZip([{ name: 'word/document.xml', data: '<w:document/>', flags: 0x0801 }]);
    expect(converterErrorCode(() => parseZip(encryptedZip))).toBe('unsupported-compression');

    // Corrupted DEFLATE payload tested via both default inflate and inflateRawPure
    const deflatedZip = buildZip([{ name: 'word/document.xml', data: '<w:document><w:body/></w:document>', method: 8 }]);
    const corruptedDeflate = new Uint8Array(deflatedZip);
    const corruptIdx = 30 + 'word/document.xml'.length;
    corruptedDeflate[corruptIdx] = (corruptedDeflate[corruptIdx] ?? 0) ^ 0xff;
    expect(converterErrorCode(() => convertDocx(corruptedDeflate))).toBe('decompression-failed');
    expect(converterErrorCode(() => convertDocx(corruptedDeflate, { inflateRaw: inflateRawPure }))).toBe('decompression-failed');
  });

  it('rejects missing package parts, malformed XML, and malformed image headers', () => {
    const emptyZip = buildZip([{ name: '[Content_Types].xml', data: '<Types/>' }]);
    expect(converterErrorCode(() => convertDocx(emptyZip))).toBe('missing-part');
    expect(converterErrorCode(() => convertPptx(emptyZip))).toBe('missing-part');
    expect(converterErrorCode(() => convertXlsx(emptyZip))).toBe('missing-part');
    expect(converterErrorCode(() => convertEpub(emptyZip))).toBe('missing-part');

    const badEpub = buildZip([
      { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
      { name: 'OEBPS/content.opf', data: '<package><manifest><item id="c1" href="ch1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>' },
    ]);
    expect(converterErrorCode(() => convertEpub(badEpub))).toBe('missing-part');

    const brokenXmlDocx = buildZip([{ name: 'word/document.xml', data: '<w:document><w:body><w:p></w:document>' }]);
    expect(converterErrorCode(() => convertDocx(brokenXmlDocx))).toBe('malformed-xml');

    // Malformed PNG, JPEG without SOF, and TIFF missing ImageWidth
    expect(converterErrorCode(() => convertImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))).toBe('malformed-image');
    expect(converterErrorCode(() => convertImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9])))).toBe('malformed-image');
    expect(converterErrorCode(() => convertImage(new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])))).toBe('malformed-image');
  });

  it('rejects ZIP archives that exceed entry and XML safety limits', () => {
    const tooManyEntries = buildZip(
      Array.from({ length: 4097 }, (_, index) => ({ name: `empty/${index}.xml`, data: '' })),
    );
    expect(converterErrorCode(() => parseZip(tooManyEntries))).toBe('corrupted-archive');

    const oversizedXml = buildZip([
      { name: 'word/document.xml', data: `<w:document>${'x'.repeat(16 * 1024 * 1024)}</w:document>` },
    ]);
    expect(converterErrorCode(() => convertDocx(oversizedXml))).toBe('malformed-xml');
  });
});
