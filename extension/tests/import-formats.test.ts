import { describe, expect, it } from 'vitest';
import {
  IMPORT_FORMATS,
  NATIVE_IMPORT_FORMATS,
  SNIFF_WINDOW_BYTES,
  planImport,
  sniffFormat,
  type ImportFormat,
  type SniffResult,
} from '../viewer/src/core/import-formats';

// --- Byte helpers ----------------------------------------------------------

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const bytesOf = (values: readonly number[]): Uint8Array => new Uint8Array(values);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

interface ZipEntry {
  readonly name: string;
  readonly data?: string;
  /** ZIP compression method; 0 (stored) is the default, which keeps the content readable. */
  readonly method?: number;
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

/**
 * A ZIP made of stored entries, which is all the sniffer needs: entry names sit in the
 * local headers in the clear, exactly as they do in a real package. The CRC is left zero
 * because nothing here extracts the archive, only reads its structure.
 */
function storedZip(entries: readonly ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];

  for (const entry of entries) {
    const name = encode(entry.name);
    const data = encode(entry.data ?? '');
    const header = new Uint8Array(30 + name.length + data.length);

    header.set([0x50, 0x4b, 0x03, 0x04], 0);
    writeU16(header, 4, 20);
    writeU16(header, 8, entry.method ?? 0);
    writeU32(header, 18, data.length);
    writeU32(header, 22, data.length);
    writeU16(header, 26, name.length);
    writeU16(header, 28, 0);
    header.set(name, 30);
    header.set(data, 30 + name.length);

    parts.push(header);
  }

  return concat(parts);
}

/** Evidence codes in the order the sniffer reported them. */
const codesOf = (result: SniffResult): string[] => result.evidence.map(row => row.code);

const codesText = (result: SniffResult): string => codesOf(result).join(',');

// --- Detection -------------------------------------------------------------

describe('sniffFormat: formats with magic bytes', () => {
  it('recognises a PDF by its header', () => {
    const result = sniffFormat(encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n'), 'report.pdf');
    expect(result.format).toBe('pdf');
    expect(result.confidence).toBe('certain');
    expect(result.supported).toBe(true);
    expect(codesText(result)).toContain('pdf-signature');
  });

  it('recognises PNG, JPEG and RTF by their signatures', () => {
    const png = sniffFormat(
      concat([bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), bytesOf([0x00, 0x00, 0x00, 0x0d])]),
      'scan.png',
    );
    expect(png.format).toBe('png');
    expect(png.confidence).toBe('certain');
    expect(png.supported).toBe(true);
    expect(codesText(png)).toContain('png-signature');

    const jpeg = sniffFormat(bytesOf([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]), 'photo.jpg');
    expect(jpeg.format).toBe('jpeg');
    expect(jpeg.confidence).toBe('certain');
    expect(jpeg.supported).toBe(true);
    expect(codesText(jpeg)).toContain('jpeg-signature');

    const rtf = sniffFormat(encode('{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times;}}}\n'), 'letter.rtf');
    expect(rtf.format).toBe('rtf');
    expect(rtf.confidence).toBe('certain');
    expect(rtf.supported).toBe(false);
    expect(codesText(rtf)).toContain('rtf-signature');
  });

  it('recognises TIFF from either endianness, and says which one', () => {
    const little = sniffFormat(bytesOf([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]), 'page.tif');
    expect(little.format).toBe('tiff');
    expect(little.confidence).toBe('certain');
    expect(little.supported).toBe(false);
    expect(codesOf(little)).toEqual(['tiff-little-endian']);

    const big = sniffFormat(bytesOf([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]), 'page.tif');
    expect(big.format).toBe('tiff');
    expect(big.confidence).toBe('certain');
    expect(codesOf(big)).toEqual(['tiff-big-endian']);
  });
});

describe('sniffFormat: ZIP packages', () => {
  it('recognises EPUB from its stored mimetype entry, which is a declaration in the clear', () => {
    const epub = storedZip([
      { name: 'mimetype', data: 'application/epub+zip' },
      { name: 'META-INF/container.xml', data: '<container/>' },
      { name: 'OEBPS/content.opf', data: '<package/>' },
    ]);

    const result = sniffFormat(epub, 'book.epub');
    expect(result.format).toBe('epub');
    expect(result.confidence).toBe('certain');
    expect(result.supported).toBe(false);
    expect(codesOf(result)).toEqual(['zip-signature', 'epub-mimetype']);
  });

  it('recognises EPUB from its container descriptor when the mimetype entry is unreadable', () => {
    const epub = storedZip([
      { name: 'META-INF/container.xml', data: '<container/>' },
      { name: 'mimetype', data: 'compressed', method: 8 },
      { name: 'OEBPS/content.opf', data: '<package/>' },
    ]);

    const result = sniffFormat(epub, 'book.epub');
    expect(result.format).toBe('epub');
    expect(result.confidence).toBe('likely');
    expect(codesText(result)).toContain('epub-container');
  });

  it('recognises DOCX by its first entry and its Word part', () => {
    const docx = storedZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: '_rels/.rels', data: '<Relationships/>' },
      { name: 'word/document.xml', data: '<w:document/>' },
    ]);

    const result = sniffFormat(docx, 'notes.docx');
    expect(result.format).toBe('docx');
    // A container signature plus a readable part name, not a signature of its own.
    expect(result.confidence).toBe('likely');
    expect(result.supported).toBe(false);
    expect(codesOf(result)).toEqual(['zip-signature', 'ooxml-content-types', 'ooxml-word-parts']);
  });

  it('recognises PPTX and XLSX by their part names', () => {
    const pptx = storedZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'ppt/presentation.xml', data: '<p:presentation/>' },
    ]);
    expect(sniffFormat(pptx, 'deck.pptx').format).toBe('pptx');
    expect(codesText(sniffFormat(pptx, 'deck.pptx'))).toContain('ooxml-slide-parts');

    const xlsx = storedZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'xl/workbook.xml', data: '<workbook/>' },
    ]);
    expect(sniffFormat(xlsx, 'sheet.xlsx').format).toBe('xlsx');
    expect(codesText(sniffFormat(xlsx, 'sheet.xlsx'))).toContain('ooxml-sheet-parts');
  });

  it('does not guess a format from the OPC manifest alone', () => {
    const manifestOnly = storedZip([{ name: '[Content_Types].xml', data: '<Types/>' }]);
    const result = sniffFormat(manifestOnly, 'package.docx');

    expect(result.format).toBe('unknown');
    expect(result.confidence).toBe('none');
    expect(result.supported).toBe(false);
    expect(codesText(result)).toContain('ooxml-unidentified');
  });

  it('does not treat an ordinary archive as a document', () => {
    const archive = storedZip([
      { name: 'readme.txt', data: 'hello' },
      { name: 'photos/holiday.jpg', data: '' },
    ]);
    const result = sniffFormat(archive, 'backup.zip');

    expect(result.format).toBe('unknown');
    expect(result.confidence).toBe('none');
    expect(codesText(result)).toContain('zip-unidentified');
  });
});

describe('sniffFormat: HTML', () => {
  it('recognises HTML by its doctype', () => {
    const result = sniffFormat(encode('<!DOCTYPE html>\n<html><body>Hello</body></html>'), 'page.txt');
    expect(result.format).toBe('html');
    expect(result.confidence).toBe('likely');
    expect(result.supported).toBe(false);
    expect(codesOf(result)).toEqual(['html-doctype']);
  });

  it('recognises HTML by a bare tag, more weakly', () => {
    const result = sniffFormat(encode('<html lang="en"><body>Hello</body></html>'), 'page');
    expect(result.format).toBe('html');
    expect(result.confidence).toBe('guess');
    expect(codesOf(result)).toEqual(['html-tag']);
  });

  it('looks past a byte-order mark and leading whitespace', () => {
    const result = sniffFormat(encode('\ufeff   <!DoCtYpE HTML>'), 'page.htm');
    expect(result.format).toBe('html');
    expect(result.confidence).toBe('likely');
  });

  it('reads only the first window of bytes', () => {
    const inside = sniffFormat(encode(`${' '.repeat(SNIFF_WINDOW_BYTES - 20)}<!DOCTYPE html>`), 'page');
    expect(inside.format).toBe('html');

    const outside = sniffFormat(encode(`${' '.repeat(SNIFF_WINDOW_BYTES)}<!DOCTYPE html>`), 'page');
    expect(outside.format).toBe('unknown');
  });

  it('names an .html file whose markup is not in the window', () => {
    const result = sniffFormat(encode('<p>a fragment</p>'), 'fragment.html');
    expect(result.format).toBe('unknown');
    expect(codesText(result)).toContain('html-extension');
  });
});

describe('sniffFormat: plain text and unknown bytes', () => {
  it('falls back to text by extension, with the weakest confidence', () => {
    const result = sniffFormat(encode('Chapter one\n\nIt was a dark and stormy night.\n'), 'notes.txt');
    expect(result.format).toBe('text');
    expect(result.confidence).toBe('guess');
    expect(result.supported).toBe(false);
    expect(codesOf(result)).toEqual(['text-extension', 'text-bytes']);
  });

  it('accepts the other text extensions and a path instead of a bare name', () => {
    expect(sniffFormat(encode('# Title\n'), 'C:\\docs\\README.MD').format).toBe('text');
    expect(sniffFormat(encode('line\n'), '/home/me/notes.markdown').format).toBe('text');
    expect(sniffFormat(encode('line\n'), 'server.log').format).toBe('text');
  });

  it('refuses to call binary content text just because the name says so', () => {
    const result = sniffFormat(bytesOf([0x00, 0x01, 0x02, 0x03, 0x04]), 'notes.txt');
    expect(result.format).toBe('unknown');
    expect(result.confidence).toBe('none');
    expect(codesText(result)).toContain('binary-content');
  });

  it('does not call an unnamed plain file text', () => {
    const result = sniffFormat(encode('just some words\n'), 'download');
    expect(result.format).toBe('unknown');
    expect(codesText(result)).toContain('no-signature');
  });

  it('reports an unknown binary without pretending', () => {
    const result = sniffFormat(bytesOf([0x13, 0x37, 0xc0, 0xde, 0x00, 0x42, 0x7f]), 'blob.bin');
    expect(result.format).toBe('unknown');
    expect(result.confidence).toBe('none');
    expect(result.supported).toBe(false);
    expect(result.evidence).toHaveLength(1);
  });

  it('reports an empty file as empty rather than unknown-by-accident', () => {
    const result = sniffFormat(new Uint8Array(0), 'empty.pdf');
    expect(result.format).toBe('unknown');
    expect(codesOf(result)).toEqual(['empty-file']);
  });
});

describe('sniffFormat: truncated and hostile input', () => {
  const truncations: readonly (readonly [string, Uint8Array])[] = [
    ['one byte', bytesOf([0x25])],
    ['four bytes of a PDF header', bytesOf([0x25, 0x50, 0x44, 0x46])],
    ['seven bytes of a PNG signature', bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a])],
    ['three bytes of a JPEG marker', bytesOf([0xff, 0xd8, 0xff])],
    ['two bytes of a TIFF header', bytesOf([0x49, 0x49])],
    ['four bytes of a ZIP header', bytesOf([0x50, 0x4b, 0x03, 0x04])],
    ['a ZIP cut inside its first header', bytesOf([0x50, 0x4b, 0x03, 0x04, 20, 0x00, 0x00, 0x00, 0x00, 0x00])],
  ];

  it.each(truncations)('does not throw on %s', (_label, bytes) => {
    expect(() => sniffFormat(bytes, 'cut.bin')).not.toThrow();
  });

  it('identifies a full signature and nothing more', () => {
    const result = sniffFormat(bytesOf([0xff, 0xd8, 0xff]), 'cut.jpg');
    expect(result.format).toBe('jpeg');
    expect(result.confidence).toBe('certain');
  });

  it('cannot name a package cut before its first entry name', () => {
    const result = sniffFormat(bytesOf([0x50, 0x4b, 0x03, 0x04]), 'cut.docx');
    expect(result.format).toBe('unknown');
    expect(codesText(result)).toContain('zip-signature');
  });

  it('survives a value that is not a Uint8Array', () => {
    const result = sniffFormat(null as unknown as Uint8Array, 'file.pdf');
    expect(result.format).toBe('unknown');
    expect(codesText(result)).toContain('no-signature');
  });
});

describe('supported flags', () => {
  const expectations: readonly (readonly [ImportFormat, boolean])[] = [
    ['pdf', true],
    ['png', true],
    ['jpeg', true],
    ['tiff', false],
    ['docx', false],
    ['pptx', false],
    ['xlsx', false],
    ['epub', false],
    ['html', false],
    ['rtf', false],
    ['text', false],
    ['unknown', false],
  ];

  it.each(expectations)('marks %s supported as %s', (format, supported) => {
    expect(NATIVE_IMPORT_FORMATS.includes(format)).toBe(supported);
  });

  it('agrees with the sniffer on every format it can name', () => {
    // The sniffer derives supported from the same list, so this pins the join itself.
    for (const format of NATIVE_IMPORT_FORMATS) {
      expect(IMPORT_FORMATS).toContain(format);
    }
  });
});

// --- Planning --------------------------------------------------------------

describe('planImport: chains', () => {
  it('sends a PDF straight to the reader', () => {
    const plan = planImport('pdf');

    expect(plan.format).toBe('pdf');
    expect(plan.supported).toBe(true);
    expect(plan.reason).toBeNull();
    expect(plan.converters).toEqual([]);
    expect(plan.needs).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      id: 'read-pdf',
      actor: 'reader',
      available: true,
      input: 'PDF bytes',
    });
    expect(plan.steps[0]?.output).toContain('Document IR');
  });

  it('warns about scans in a PDF when this device has no OCR engine', () => {
    const plan = planImport('pdf', { ocrAvailable: false });
    expect(plan.steps).toHaveLength(1);
    expect(plan.warnings.join(' ')).toContain('scanned page');
  });

  it('plans PNG and JPEG through the image decoder and the OCR engine', () => {
    for (const format of ['png', 'jpeg'] as const) {
      const plan = planImport(format);
      expect(plan.format).toBe(format);
      expect(plan.supported).toBe(true);
      expect(plan.reason).toBeNull();
      expect(plan.converters).toEqual([]);
      expect(plan.needs).toEqual(['ocr']);
      expect(plan.steps.map(step => step.id)).toEqual(['decode-image', 'ocr-image']);
      expect(plan.steps.every(step => step.available)).toBe(true);
      expect(plan.steps[1]?.actor).toBe('ocr');
      expect(plan.steps[1]?.output).toContain('recognized text');
    }
  });

  it('marks the OCR step unavailable when the device reports no engine', () => {
    const plan = planImport('png', { ocrAvailable: false });
    expect(plan.supported).toBe(true); // The build still supports it.
    expect(plan.steps.map(step => step.available)).toEqual([true, false]);
    expect(plan.warnings.join(' ')).toContain('No OCR engine');
  });

  it('puts an image conversion in front of the TIFF chain, because nothing here decodes TIFF', () => {
    const plan = planImport('tiff');

    expect(plan.supported).toBe(false);
    expect(plan.steps.map(step => step.id)).toEqual(['external-convert', 'decode-image', 'ocr-image']);
    expect(plan.steps[0]).toMatchObject({ input: 'TIFF image', output: 'PNG image', available: false });
    expect(plan.converters).toEqual(['ImageMagick (magick convert)']);
    expect(plan.needs).toEqual(['external-converter', 'ocr']);
    expect(plan.warnings.join(' ')).toContain('cannot run until');

    const withConverter = planImport('tiff', { converterAvailable: true });
    expect(withConverter.steps[0]?.available).toBe(true);
    expect(withConverter.warnings.join(' ')).not.toContain('cannot run until');
  });

  it('plans DOCX, PPTX and XLSX through an external converter, and says so', () => {
    const warnings: Record<'docx' | 'pptx' | 'xlsx', string> = {
      docx: 're-flows',
      pptx: 'slide',
      xlsx: 'sheet',
    };

    for (const format of ['docx', 'pptx', 'xlsx'] as const) {
      const plan = planImport(format);
      expect(plan.format).toBe(format);
      expect(plan.supported).toBe(false);
      expect(plan.reason).toBeNull();
      expect(plan.steps.map(step => step.id)).toEqual(['external-convert', 'read-pdf']);
      expect(plan.steps[0]?.actor).toBe('external');
      expect(plan.steps[0]?.output).toBe('PDF');
      expect(plan.steps[0]?.available).toBe(false);
      expect(plan.steps[1]?.available).toBe(true);
      expect(plan.converters).toEqual(['LibreOffice (soffice --headless --convert-to pdf)']);
      expect(plan.needs).toEqual(['external-converter']);
      expect(plan.warnings[0]).toContain(warnings[format]);
      expect(plan.warnings.join(' ')).toContain('No converter is installed');
    }
  });

  it('drops the missing-converter warning once the converter is reported', () => {
    const plan = planImport('docx', { converterAvailable: true });
    expect(plan.steps[0]?.available).toBe(true);
    expect(plan.warnings).toHaveLength(1);
  });

  it('plans EPUB and HTML through the converter that respects each one', () => {
    const epub = planImport('epub');
    expect(epub.steps.map(step => step.id)).toEqual(['external-convert', 'read-pdf']);
    expect(epub.converters).toEqual(['Calibre (ebook-convert)']);
    expect(epub.warnings[0]).toContain('page');

    const html = planImport('html');
    expect(html.steps.map(step => step.id)).toEqual(['external-convert', 'read-pdf']);
    expect(html.converters).toEqual(['Chromium headless (--print-to-pdf)']);
    expect(html.warnings[0]).toContain('stylesheets');
  });

  it('plans text through an importer this build does not have, and does not hide it', () => {
    const plan = planImport('text');

    expect(plan.supported).toBe(false);
    expect(plan.reason).toBeNull();
    expect(plan.steps.map(step => step.id)).toEqual(['text-to-ir']);
    expect(plan.steps[0]?.available).toBe(false);
    expect(plan.needs).toEqual(['text-importer']);
    expect(plan.warnings).toHaveLength(1);
  });
});

describe('planImport: refusals', () => {
  it('refuses RTF with an empty plan and a reason', () => {
    const plan = planImport('rtf');

    expect(plan.format).toBe('rtf');
    expect(plan.supported).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(plan.converters).toEqual([]);
    expect(plan.needs).toEqual([]);
    expect(plan.reason).toContain('RTF is recognized');
  });

  it('refuses an unknown file with an empty plan and a reason', () => {
    const plan = planImport('unknown');

    expect(plan.steps).toEqual([]);
    expect(plan.supported).toBe(false);
    expect(plan.reason).toContain('no format this build recognizes');
  });

  it('refuses a format string it does not know rather than throwing', () => {
    const plan = planImport('odt' as ImportFormat);

    expect(plan.format).toBe('unknown');
    expect(plan.steps).toEqual([]);
    expect(plan.reason).not.toBeNull();
  });
});

describe('planImport: invariants', () => {
  it('keeps steps and reason mutually exclusive for every format', () => {
    for (const format of IMPORT_FORMATS) {
      const plan = planImport(format);
      expect(plan.format).toBe(format);
      expect(plan.steps.length === 0).toBe(plan.reason !== null);
      expect(plan.supported).toBe(NATIVE_IMPORT_FORMATS.includes(format));

      for (const step of plan.steps) {
        expect(step.input.length).toBeGreaterThan(0);
        expect(step.output.length).toBeGreaterThan(0);
        expect(['reader', 'ocr', 'external']).toContain(step.actor);
      }

      // A chain that needs an external program must name one.
      if (plan.needs.includes('external-converter')) {
        expect(plan.converters.length).toBeGreaterThan(0);
      }
      // Every step is either runnable or explained by a warning or a need.
      if (plan.steps.some(step => !step.available)) {
        expect(plan.warnings.length + plan.needs.length).toBeGreaterThan(0);
      }
    }
  });

  it('behaves identically without an options object', () => {
    expect(planImport('png', {})).toEqual(planImport('png'));
  });
});
