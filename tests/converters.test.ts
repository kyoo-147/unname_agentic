import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONVERTIBLE_FORMATS,
  convertDocument,
  convertDocx,
  convertEpub,
  convertHtml,
  convertImage,
  convertPptx,
  convertXlsx,
  decodeHtmlEntities,
} from '../src/core/converters';
import { DOCUMENT_IR_SCHEMA_VERSION, serialize, validate } from '../src/core/ir';

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
}

function buildZip(entries: readonly FixtureZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8(entry.name);
    const rawData = typeof entry.data === 'string' ? utf8(entry.data) : entry.data;
    const crc = crc32(rawData);
    const flags = 0x0800; // UTF-8 filename bit

    const localHeader = concatBytes([
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      u16le(20),
      u16le(flags),
      u16le(0), // STORE
      u16le(0),
      u16le(0),
      u32le(crc),
      u32le(rawData.length),
      u32le(rawData.length),
      u16le(nameBytes.length),
      u16le(0),
      nameBytes,
      rawData,
    ]);

    const centralHeader = concatBytes([
      new Uint8Array([0x50, 0x4b, 0x01, 0x02]),
      u16le(20),
      u16le(20),
      u16le(flags),
      u16le(0),
      u16le(0),
      u16le(0),
      u32le(crc),
      u32le(rawData.length),
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
