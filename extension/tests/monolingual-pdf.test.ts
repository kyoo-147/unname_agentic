import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { checkExport } from '../viewer/src/core/export-check';
import { OVERFLOW_MARKER } from '../viewer/src/core/reflow';
import {
  BUNDLED_FONT_NAME,
  FALLBACK_FACE_NAME,
} from '../viewer/src/export/fonts';
import {
  BIDI_LIMITATION,
  DEFAULT_BASELINE_RATIO,
  FONT_LIMITATION,
  PAPER_COLOR,
  PdfExportError,
  UNICODE_GAP_LIMITATION,
  type PdfBlockSource,
  type PdfPageSource,
} from '../viewer/src/export/pdf';
import {
  DEFAULT_MONOLINGUAL_CREATOR,
  DEFAULT_MONOLINGUAL_PRODUCER,
  OVERFLOW_LIMITATION,
  buildMonolingualPdf,
  parsePageRange,
  planMonolingualPdf,
} from '../viewer/src/export/monolingual-pdf';

const FONT_BYTES = new Uint8Array(
  readFileSync(new URL('../viewer/public/fonts/NotoSans-Regular.ttf', import.meta.url)),
);

const measureHalfEm = (text: string, size: number): number => text.length * size * 0.5;

const block = (overrides: Partial<PdfBlockSource> & { id: string; text: string }): PdfBlockSource => ({
  rect: { x: 40, y: 60, width: 240, height: 40 },
  fontSize: 10,
  ...overrides,
});

const page = (overrides: Partial<PdfPageSource> & { number: number }): PdfPageSource => ({
  width: 612,
  height: 792,
  ...overrides,
});

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

function solidPng(width = 1, height = 1): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 2;
  const stride = 1 + width * 3;
  const raw = new Uint8Array(height * stride);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const at = row * stride + 1 + column * 3;
      raw[at] = 0xf2;
      raw[at + 1] = 0xf4;
      raw[at + 2] = 0xf7;
    }
  }
  const chunks = [pngChunk('IHDR', header), pngChunk('IDAT', new Uint8Array(deflateSync(raw))), pngChunk('IEND', new Uint8Array(0))];
  const total = signature.length + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const png = new Uint8Array(total);
  png.set(signature, 0);
  let offset = signature.length;
  for (const chunk of chunks) {
    png.set(chunk, offset);
    offset += chunk.length;
  }
  return png;
}

function pageContentStream(doc: PDFDocument, pageIndex: number): string {
  const contents = doc.getPage(pageIndex).node.Contents();
  const values = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  const chunks: string[] = [];
  for (const value of values) {
    const resolved = doc.context.lookup(value);
    if (!(resolved instanceof PDFRawStream)) throw new Error('the page content is not a raw stream');
    const filter = resolved.dict.lookup(PDFName.of('Filter'));
    const raw = resolved.getContents();
    const decoded = filter?.toString() === '/FlateDecode' ? new Uint8Array(inflateSync(raw)) : raw;
    chunks.push(Buffer.from(decoded).toString('latin1'));
  }
  return chunks.join('\n');
}

describe('parsePageRange', () => {
  it('parses single pages, ranges, arrays, and start/end objects', () => {
    expect([...parsePageRange('2-4, 1, 4')]).toEqual([2, 3, 4, 1]);
    expect([...parsePageRange([5, 2, 5])]).toEqual([5, 2]);
    expect([...parsePageRange({ start: 2, end: 4 })]).toEqual([2, 3, 4]);
  });

  it('rejects malformed or descending page ranges with PdfExportError', () => {
    expect(() => parsePageRange('0')).toThrow(PdfExportError);
    expect(() => parsePageRange('-2')).toThrow(PdfExportError);
    expect(() => parsePageRange('5-2')).toThrow(PdfExportError);
    expect(() => parsePageRange('1,,3')).toThrow(PdfExportError);
    expect(() => parsePageRange('abc')).toThrow(PdfExportError);
    expect(() => parsePageRange({ start: 4, end: 2 })).toThrow(PdfExportError);
  });
});

describe('planMonolingualPdf — page-range filtering', () => {
  const fourPages = (): PdfPageSource[] => [
    page({ number: 3, blocks: [block({ id: 'b3', text: 'Page three' })] }),
    page({ number: 1, image: { format: 'png', bytes: solidPng() }, blocks: [block({ id: 'b1', text: 'Page one' })] }),
    page({ number: 4, blocks: [block({ id: 'b4', text: 'Page four' })] }),
    page({ number: 2, blocks: [block({ id: 'b2', text: 'Page two' })] }),
  ];

  it('sorts and selects all pages when pageRange is omitted', () => {
    const plan = planMonolingualPdf(fourPages(), { measure: measureHalfEm });
    expect(plan.totalSourcePages).toBe(4);
    expect(plan.pageCount).toBe(4);
    expect(plan.selectedPages).toEqual([1, 2, 3, 4]);
    expect(plan.blockCount).toBe(4);
    expect(plan.imagePages).toBe(1);
  });

  it('filters pages by string range and reports only selected pages and blocks', () => {
    const plan = planMonolingualPdf(fourPages(), { pageRange: '2, 4', measure: measureHalfEm });
    expect(plan.totalSourcePages).toBe(4);
    expect(plan.pageCount).toBe(2);
    expect(plan.selectedPages).toEqual([2, 4]);
    expect(plan.pages.map(item => item.blocks[0]?.id)).toEqual(['b2', 'b4']);
    expect(plan.imagePages).toBe(0);
  });

  it('filters pages by open-ended { start, end } range', () => {
    const plan = planMonolingualPdf(fourPages(), { pageRange: { start: 3 }, measure: measureHalfEm });
    expect(plan.selectedPages).toEqual([3, 4]);
  });

  it('refuses when the document is empty or the page range matches nothing', () => {
    expect(() => planMonolingualPdf([])).toThrow(PdfExportError);
    expect(() => planMonolingualPdf(fourPages(), { pageRange: '9-10' })).toThrow(PdfExportError);
    expect(() => planMonolingualPdf(fourPages(), { pageRange: [] })).toThrow(PdfExportError);
  });
});

describe('planMonolingualPdf — layout, masking, reflow, and overflow warnings', () => {
  it('converts reader rects into PDF-space paper-color covers and reading-order runs', () => {
    const plan = planMonolingualPdf([
      page({
        number: 1,
        width: 600,
        height: 800,
        blocks: [
          block({ id: 'second', text: 'Second line', rect: { x: 72, y: 160, width: 200, height: 30 }, fontSize: 10 }),
          block({ id: 'first', text: 'First line', rect: { x: 72, y: 100, width: 200, height: 40 }, fontSize: 10 }),
        ],
      }),
    ], { measure: measureHalfEm, paperColor: '#faf8f5' });

    const plannedPage = plan.pages[0]!;
    expect(plannedPage.paperColor).toBe('#faf8f5');
    expect(plannedPage.blocks.map(item => item.id)).toEqual(['first', 'second']);

    const first = plannedPage.blocks[0]!;
    expect(first.cover).toEqual({ x: 72, y: 800 - 100 - 40, width: 200, height: 40 });
    expect(first.paperColor).toBe('#faf8f5');
    expect(first.runs[0]).toEqual({ text: 'First line', x: 72, y: 800 - 100 - 10 * DEFAULT_BASELINE_RATIO });
    expect(first.overflow).toBe(false);
    expect(first.truncated).toBe(false);
    expect(plan.overflowBlocks).toEqual([]);
    expect(plan.truncatedCount).toBe(0);
    expect(plan.warnings).toEqual([]);
  });

  it('defaults paperColor to PAPER_COLOR when omitted or invalid', () => {
    const plan = planMonolingualPdf([
      page({
        number: 1,
        blocks: [block({ id: 'a', text: 'Hello' })],
      }),
    ], { measure: measureHalfEm });
    expect(plan.pages[0]!.paperColor).toBe(PAPER_COLOR);
    expect(plan.pages[0]!.blocks[0]!.paperColor).toBe(PAPER_COLOR);
  });

  it('reflows longer translations via shrink and condense before declaring overflow', () => {
    // Four 10-char words: at 10pt in 100x36 box it needs 4 lines (48pt > 36pt); shrinking to 9.5pt fits 2 lines (22.8pt <= 36pt).
    const shrunk = planMonolingualPdf([
      page({
        number: 1,
        blocks: [
          block({
            id: 'shrink-fit',
            text: 'aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd',
            rect: { x: 40, y: 40, width: 100, height: 36 },
            fontSize: 10,
          }),
        ],
      }),
    ], { measure: measureHalfEm });

    const shrunkBlock = shrunk.pages[0]!.blocks[0]!;
    expect(shrunkBlock.strategy).toBe('shrink');
    expect(shrunkBlock.fontSize).toBe(9.5);
    expect(shrunkBlock.overflow).toBe(false);
    expect(shrunkBlock.truncated).toBe(false);
    expect(shrunk.overflowBlocks).toEqual([]);
    expect(shrunk.truncatedCount).toBe(0);

    // At width 96 with minFontSize 9.5, shrink alone fails and condense (trackingFactor 0.96) fits without overflow.
    const condensed = planMonolingualPdf([
      page({
        number: 1,
        blocks: [
          block({
            id: 'condense-fit',
            text: 'aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd',
            rect: { x: 40, y: 40, width: 96, height: 36 },
            fontSize: 10,
          }),
        ],
      }),
    ], { measure: measureHalfEm, minimumFontSize: 9.5 });

    const condensedBlock = condensed.pages[0]!.blocks[0]!;
    expect(condensedBlock.strategy).toBe('condense');
    expect(condensedBlock.trackingFactor).toBe(0.96);
    expect(condensedBlock.overflow).toBe(false);
    expect(condensed.overflowBlocks).toEqual([]);
  });

  it('never silently truncates: reports overflowBlocks, truncatedCount, ellipsis marker, and warnings', () => {
    const plan = planMonolingualPdf([
      page({
        number: 1,
        blocks: [
          block({
            id: 'overflow-1',
            text: 'aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee',
            rect: { x: 40, y: 40, width: 100, height: 24 },
            fontSize: 10,
          }),
        ],
      }),
    ], { measure: measureHalfEm });

    expect(plan.truncatedCount).toBe(1);
    expect(plan.overflowBlocks).toHaveLength(1);
    const report = plan.overflowBlocks[0]!;
    expect(report.id).toBe('overflow-1');
    expect(report.page).toBe(1);
    expect(report.truncated).toBe(true);
    expect(report.clippedCharacters).toBe(10);
    expect(report.leftover).toBe('eeeeeeeeee');

    const plannedBlock = plan.pages[0]!.blocks[0]!;
    expect(plannedBlock.runs.at(-1)?.text.endsWith(OVERFLOW_MARKER)).toBe(true);
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(plan.limitations).toContain(OVERFLOW_LIMITATION);
  });

  it('reports font, Unicode-gap, and bidi limitations explicitly', () => {
    const fallbackPlan = planMonolingualPdf([
      page({
        number: 1,
        blocks: [block({ id: 'vi', text: 'Tiếng Việt — kết quả 42', direction: 'rtl' })],
      }),
    ], { measure: measureHalfEm });
    expect(fallbackPlan.fontName).toBe(FALLBACK_FACE_NAME);
    expect(fallbackPlan.limitations).toContain(FONT_LIMITATION);
    expect(fallbackPlan.limitations).toContain(BIDI_LIMITATION);
    expect(fallbackPlan.pages[0]!.blocks[0]!.folded).toBe(true);

    const unicodeGapPlan = planMonolingualPdf([
      page({
        number: 1,
        blocks: [block({ id: 'mixed', text: 'Tiếng 中文 Việt' })],
      }),
    ], {
      measure: measureHalfEm,
      unicode: true,
      fontName: BUNDLED_FONT_NAME,
      prepare: input => ({
        text: input.replace(/中文/g, ''),
        changed: true,
        dropped: 2,
      }),
    });
    expect(unicodeGapPlan.fontName).toBe(BUNDLED_FONT_NAME);
    expect(unicodeGapPlan.limitations).not.toContain(FONT_LIMITATION);
    expect(unicodeGapPlan.limitations).toContain(UNICODE_GAP_LIMITATION);
  });
});

describe('buildMonolingualPdf — writing PDF bytes, masking, Unicode, metadata', () => {
  it('writes a valid monolingual PDF for the requested page range with paper masking before text', async () => {
    const pages: PdfPageSource[] = [
      page({
        number: 1,
        image: { format: 'png', bytes: solidPng() },
        blocks: [block({ id: 'p1', text: 'Page one original block' })],
      }),
      page({
        number: 2,
        image: { format: 'png', bytes: solidPng() },
        blocks: [block({ id: 'p2', text: 'Tiếng Việt — kết quả 42' })],
      }),
      page({
        number: 3,
        blocks: [block({ id: 'p3', text: 'Trang ba giữ bố cục' })],
      }),
    ];

    const result = await buildMonolingualPdf(pages, {
      pageRange: '2-3',
      paperColor: '#f5f2eb',
      title: 'Báo cáo dịch',
      author: 'Mirror Translator',
      lang: 'vi',
      fonts: { bytes: FONT_BYTES },
    });

    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(String.fromCharCode(...result.bytes.subarray(0, 5))).toBe('%PDF-');
    expect(result.selectedPages).toEqual([2, 3]);
    expect(result.totalSourcePages).toBe(3);
    expect(result.pageCount).toBe(2);
    expect(result.imagePages).toBe(1);
    expect(result.fontName).toBe(BUNDLED_FONT_NAME);
    expect(result.limitations).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.metadata).toMatchObject({
      title: 'Báo cáo dịch',
      author: 'Mirror Translator',
      lang: 'vi',
    });

    // Verify masking rectangle operator precedes text drawing operator on page 0 (source page 2).
    const doc = await PDFDocument.load(result.bytes);
    const stream = pageContentStream(doc, 0);
    const rectIndex = stream.indexOf(' re\n');
    const textIndex = stream.indexOf('\nBT\n');
    const doIndex = stream.indexOf(' Do\n');
    expect(doIndex).toBeGreaterThan(-1);
    expect(rectIndex).toBeGreaterThan(doIndex);
    expect(textIndex).toBeGreaterThan(rectIndex);
  });

  it('surfaces overflow warnings in buildMonolingualPdf when a block overflows Noto Sans box', async () => {
    const result = await buildMonolingualPdf([
      page({
        number: 1,
        blocks: [
          block({
            id: 'tight',
            text: 'Một đoạn văn bản tiếng Việt rất dài vượt quá khung chữ nhỏ ban đầu và không thể thu gọn hết được.',
            rect: { x: 40, y: 40, width: 90, height: 22 },
            fontSize: 11,
          }),
        ],
      }),
    ], { fonts: { bytes: FONT_BYTES } });

    expect(result.truncatedCount).toBe(1);
    expect(result.overflowBlocks).toHaveLength(1);
    expect(result.overflowBlocks[0]!.id).toBe('tight');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.limitations).toContain(OVERFLOW_LIMITATION);
  });
});

interface PdfJsExtractedRun {
  str: string;
  x: number;
  y: number;
}

interface PdfJsRoundTrip {
  numPages: number;
  pageSizes: { width: number; height: number }[];
  pageTexts: string[];
  pageRuns: PdfJsExtractedRun[][];
  info: Record<string, unknown>;
}

async function readWithPdfJs(bytes: Uint8Array): Promise<PdfJsRoundTrip> {
  const task = getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const pageSizes: { width: number; height: number }[] = [];
    const pageTexts: string[] = [];
    const pageRuns: PdfJsExtractedRun[][] = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const pdfPage = await doc.getPage(number);
      const viewport = pdfPage.getViewport({ scale: 1 });
      pageSizes.push({ width: viewport.width, height: viewport.height });
      const content = await pdfPage.getTextContent();
      const runs = content.items.flatMap(item =>
        'str' in item
          ? [{
              str: item.str,
              x: item.transform[4] ?? Number.NaN,
              y: item.transform[5] ?? Number.NaN,
            }]
          : [],
      );
      pageRuns.push(runs);
      pageTexts.push(runs.map(run => run.str).join(''));
    }
    const meta = await doc.getMetadata();
    return {
      numPages: doc.numPages,
      pageSizes,
      pageTexts,
      pageRuns,
      info: (meta.info ?? {}) as Record<string, unknown>,
    };
  } finally {
    await task.destroy();
  }
}

async function type0Fonts(bytes: Uint8Array): Promise<PDFDict[]> {
  const reloaded = await PDFDocument.load(bytes);
  return reloaded.context.enumerateIndirectObjects()
    .map(([, object]) => object)
    .filter((object): object is PDFDict => object instanceof PDFDict)
    .filter(object => {
      const subtype = object.get(PDFName.of('Subtype'));
      return subtype instanceof PDFName && subtype.asString() === '/Type0';
    });
}

async function pageFontRefs(bytes: Uint8Array): Promise<string[][]> {
  const reloaded = await PDFDocument.load(bytes);
  return reloaded.getPages().map(target => {
    const fonts = target.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
    if (!fonts) return [];
    return fonts.keys().map(key => fonts.get(key)?.toString() ?? '');
  });
}

describe('G01 monolingual PDF round-trip via pdfjs-dist and pdf-lib', () => {
  it('verifies %PDF- header, selected page count, page dimensions, metadata, Noto Sans embedding, and Vietnamese diacritics', async () => {
    const pages: PdfPageSource[] = [
      page({
        number: 1,
        width: 400,
        height: 500,
        blocks: [block({ id: 'skip-1', text: 'Source page one excluded by range' })],
      }),
      page({
        number: 2,
        width: 612,
        height: 792,
        image: { format: 'png', bytes: solidPng() },
        blocks: [
          block({
            id: 'vi-main',
            text: 'Tiếng Việt — kết quả 42',
            rect: { x: 72, y: 120, width: 320, height: 36 },
            fontSize: 12,
          }),
        ],
      }),
      page({
        number: 3,
        width: 500,
        height: 700,
        blocks: [block({ id: 'skip-3', text: 'Source page three excluded by range' })],
      }),
      page({
        number: 4,
        width: 595,
        height: 842,
        blocks: [
          block({
            id: 'vi-p4',
            text: 'Bản dịch trang bốn — giữ nguyên bố cục',
            rect: { x: 64, y: 96, width: 360, height: 32 },
            fontSize: 11,
          }),
        ],
      }),
    ];

    const result = await buildMonolingualPdf(pages, {
      pageRange: '2, 4',
      paperColor: '#faf8f5',
      title: 'Báo cáo tài chính — Bản dịch',
      author: 'Mirror PDF',
      lang: 'vi',
      metadata: {
        subject: 'Monolingual Vietnamese Export',
        keywords: ['pdf', 'translation'],
      },
      fonts: { bytes: FONT_BYTES },
    });

    // 1. Raw PDF markers
    expect(String.fromCharCode(...result.bytes.subarray(0, 5))).toBe('%PDF-');
    expect(new TextDecoder().decode(result.bytes.subarray(-32))).toContain('%%EOF');

    // 2. Round-trip through pdf-lib (updateMetadata: false preserves original Producer)
    const reloaded = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(reloaded.getPageCount()).toBe(2);
    expect(reloaded.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(reloaded.getPage(1).getSize()).toEqual({ width: 595, height: 842 });
    expect(reloaded.getTitle()).toBe('Báo cáo tài chính — Bản dịch');
    expect(reloaded.getAuthor()).toBe('Mirror PDF');
    expect(reloaded.getSubject()).toBe('Monolingual Vietnamese Export');
    expect(reloaded.getKeywords()).toContain('pdf');
    expect(reloaded.getKeywords()).toContain('translation');
    expect(reloaded.getCreator()).toBe(DEFAULT_MONOLINGUAL_CREATOR);
    expect(reloaded.getProducer()).toBe(DEFAULT_MONOLINGUAL_PRODUCER);
    const catalogLang = reloaded.catalog.lookup(PDFName.of('Lang'));
    expect(catalogLang).toBeInstanceOf(PDFString);
    expect((catalogLang as PDFString).decodeText()).toBe('vi');

    // Single shared Type0 Unicode font embedded across both pages
    expect(await type0Fonts(result.bytes)).toHaveLength(1);
    const refs = await pageFontRefs(result.bytes);
    expect(refs[0]).toHaveLength(1);
    expect(refs[1]).toEqual(refs[0]);

    // Verify paper-color masking rectangle (#faf8f5) & order on page 0
    const stream0 = pageContentStream(reloaded, 0);
    expect(stream0).toContain('72 636 320 36 re');
    expect(stream0).toContain('0.9803921568627451 0.9725490196078431 0.9607843137254902 rg');
    expect(stream0.indexOf('72 636 320 36 re')).toBeLessThan(stream0.indexOf(' Tj'));

    // 3. Round-trip through pdfjs-dist
    const pdfjs = await readWithPdfJs(result.bytes);
    expect(pdfjs.numPages).toBe(2);
    expect(pdfjs.pageSizes).toEqual([
      { width: 612, height: 792 },
      { width: 595, height: 842 },
    ]);
    expect(pdfjs.info['Title']).toBe('Báo cáo tài chính — Bản dịch');
    expect(pdfjs.info['Author']).toBe('Mirror PDF');
    expect(pdfjs.info['Subject']).toBe('Monolingual Vietnamese Export');
    expect(pdfjs.info['Language']).toBe('vi');
    expect(pdfjs.info['Creator']).toBe(DEFAULT_MONOLINGUAL_CREATOR);
    expect(pdfjs.info['Producer']).toBe(DEFAULT_MONOLINGUAL_PRODUCER);

    expect(pdfjs.pageTexts[0]).toContain('Tiếng Việt — kết quả 42');
    expect(pdfjs.pageTexts[0]).not.toContain('Tieng Viet');
    expect(pdfjs.pageTexts[0]).not.toContain('Source page one');
    expect(pdfjs.pageTexts[1]).toContain('Bản dịch trang bốn — giữ nguyên bố cục');
    expect(pdfjs.pageTexts[1]).not.toContain('Source page three');

    // Extracted baseline sits inside the source block cover in PDF space
    const firstRun = pdfjs.pageRuns[0]!.find(run => run.str.trim().length > 0)!;
    expect(firstRun.x).toBeCloseTo(72, 1);
    expect(firstRun.y).toBeCloseTo(792 - 120 - 12 * DEFAULT_BASELINE_RATIO, 1);
    expect(firstRun.y).toBeGreaterThan(636);
    expect(firstRun.y).toBeLessThan(636 + 36);

    // Cross-check with the repo's pre-hand-over export validator
    const validation = checkExport({
      bytes: result.bytes,
      pages: 2,
      fonts: [{ name: 'NotoSans-Regular', embedded: true, subset: true }],
      hasTextLayer: true,
      images: 1,
      expected: {
        textLayer: true,
        sourceSentences: ['Source page one excluded by range', 'Source page three excluded by range'],
        extractedText: pdfjs.pageTexts.join('\n'),
      },
    });
    expect(validation).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('preserves overflow marker and reports overflow warnings on pdfjs-dist round-trip', async () => {
    const result = await buildMonolingualPdf([
      page({
        number: 1,
        blocks: [
          block({
            id: 'overflow-vi',
            text: 'Tiếng Việt — kết quả 42 cho đoạn văn bản quá dài so với hộp chữ ban đầu nên phần cuối sẽ tràn.',
            rect: { x: 40, y: 50, width: 96, height: 22 },
            fontSize: 11,
          }),
        ],
      }),
    ], { fonts: { bytes: FONT_BYTES } });

    expect(result.truncatedCount).toBe(1);
    expect(result.overflowBlocks).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.limitations).toContain(OVERFLOW_LIMITATION);

    const pdfjs = await readWithPdfJs(result.bytes);
    expect(pdfjs.numPages).toBe(1);
    expect(pdfjs.pageTexts[0]).toContain('Tiếng Việt');
    expect(pdfjs.pageTexts[0]).toContain(OVERFLOW_MARKER);
  });

  it('emits horizontal squeeze (Tz) when condense reflow triggers and remains readable in pdfjs-dist', async () => {
    // 10pt -> 7pt floor still leaves a slightly wide line unless condensed by trackingFactor < 1
    const result = await buildMonolingualPdf([
      page({
        number: 1,
        blocks: [
          block({
            id: 'condense-vi',
            text: 'Tiếng Việt — kết quả 42',
            rect: { x: 40, y: 50, width: 100, height: 14 },
            fontSize: 10,
          }),
        ],
      }),
    ], {
      minimumFontSize: 9.5,
      fonts: { bytes: FONT_BYTES },
    });

    expect(result.overflowBlocks).toEqual([]);
    const reloaded = await PDFDocument.load(result.bytes);
    const stream = pageContentStream(reloaded, 0);
    expect(stream).toMatch(/\d+(?:\.\d+)? Tz/);

    const pdfjs = await readWithPdfJs(result.bytes);
    expect(pdfjs.pageTexts[0]).toContain('Tiếng Việt — kết quả 42');
  });

  it('falls back cleanly to WinAnsi when Noto Sans bytes are absent and reports FONT_LIMITATION', async () => {
    const result = await buildMonolingualPdf([
      page({
        number: 1,
        blocks: [block({ id: 'vi-fallback', text: 'Tiếng Việt — kết quả 42' })],
      }),
    ], { fonts: { bytes: null } });

    expect(result.fontName).toBe(FALLBACK_FACE_NAME);
    expect(result.limitations).toContain(FONT_LIMITATION);

    const pdfjs = await readWithPdfJs(result.bytes);
    expect(pdfjs.numPages).toBe(1);
    expect(pdfjs.pageTexts[0]).toContain('Tieng Viet - ket qua 42');
  });
});
