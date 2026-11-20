import { deflateSync, inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { foldSearchText } from '../src/pdf/layout';
import {
  DEFAULT_BASELINE_RATIO,
  FONT_LIMITATION,
  OVERFLOW_LIMITATION,
  SearchablePdfError,
  buildSearchablePdf,
  layoutTextRun,
  type RunFont,
  type SearchableBlockSource,
  type SearchablePageSource,
  type TextRunLayout,
} from '../src/export/searchable';

/** Deterministic stand-in for real font metrics: every character is half an em. */
const halfEm: RunFont = { widthOfTextAtSize: (text, size) => text.length * size * 0.5 };

/** The face the writer embeds, so build expectations use real metrics rather than the stand-in. */
async function helvetica(): Promise<RunFont> {
  return (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
}

const BOX = { width: 612, height: 792 };

/** A real 1x1 PNG, built here so the test needs no binary fixture and no image library. */
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
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
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

/** A fresh 1-page scanned document: full-page raster plus three OCR line boxes, two on one line. */
const scanPage = (): SearchablePageSource => ({
  number: 1,
  width: BOX.width,
  height: BOX.height,
  image: { format: 'png', bytes: solidPng() },
});

const scanBlocks = (): SearchableBlockSource[] => [
  { id: 'b1', page: 1, text: 'First line', rect: { x: 72, y: 100, width: 200, height: 12 } },
  { id: 'b2', page: 1, text: 'Second run', rect: { x: 300, y: 100, width: 200, height: 12 } },
  { id: 'b3', page: 1, text: 'Third line', rect: { x: 72, y: 130, width: 240, height: 12 } },
];

const layoutsOf = (blocks: readonly SearchableBlockSource[], font: RunFont): TextRunLayout[] =>
  blocks.map(block => layoutTextRun(block, BOX, font)!);

/**
 * The page's content stream, decompressed. pdf-lib writes it Flate-compressed, so the test inflates
 * with node's own zlib rather than borrowing pdf-lib's decoder: the bytes asserted on are exactly
 * what a reader will parse.
 */
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

interface ShownText {
  /** Last `Tr` operand seen before this show operator, or null when no mode was ever set. */
  renderMode: number | null;
  /** Raw hex of the shown string. */
  hex: string;
  /** Text matrix translation, i.e. the baseline origin. */
  x: number;
  y: number;
}

/** Walks the content stream operators in order and records each text-show with the state it saw. */
function readShownText(stream: string): ShownText[] {
  const shown: ShownText[] = [];
  let renderMode: number | null = null;
  let origin = { x: Number.NaN, y: Number.NaN };
  const number = '(-?\\d+(?:\\.\\d+)?)';
  const modePattern = new RegExp(`^${number} Tr$`);
  const matrixPattern = new RegExp(`^${number} ${number} ${number} ${number} ${number} ${number} Tm$`);
  const showPattern = /^<([0-9A-Fa-f]+)> Tj$/;
  for (const rawLine of stream.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const mode = modePattern.exec(line);
    if (mode) {
      renderMode = Number(mode[1]);
      continue;
    }
    const matrix = matrixPattern.exec(line);
    if (matrix) {
      origin = { x: Number(matrix[5]), y: Number(matrix[6]) };
      continue;
    }
    const show = showPattern.exec(line);
    if (show) shown.push({ renderMode, hex: show[1]!, x: origin.x, y: origin.y });
  }
  return shown;
}

interface ExtractedItem {
  str: string;
  /** Baseline origin in PDF space, as the reader reports it. */
  x: number;
  y: number;
}

/** Reads the text layer per page with the project's own PDF reader stack (pdfjs). */
async function extractPages(bytes: Uint8Array): Promise<ExtractedItem[][]> {
  // pdfjs transfers the buffer it is given, so the caller's copy stays readable afterwards.
  const task = getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const document = await task.promise;
  try {
    const pages: ExtractedItem[][] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const content = await (await document.getPage(number)).getTextContent();
      pages.push(content.items.flatMap(item => ('str' in item
        ? [{ str: item.str, x: item.transform[4] ?? Number.NaN, y: item.transform[5] ?? Number.NaN }]
        : [])));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

async function extractText(bytes: Uint8Array): Promise<string[]> {
  return (await extractPages(bytes)).map(items => items.map(item => item.str).join(''));
}

describe('layoutTextRun', () => {
  const page = { width: 600, height: 800 };
  const line = (overrides: Partial<SearchableBlockSource> = {}): SearchableBlockSource => ({
    id: 'a',
    page: 1,
    text: 'Xin chao',
    rect: { x: 72, y: 100, width: 200, height: 12 },
    ...overrides,
  });

  it('starts at the block left edge with the glyph height matched to the block height', () => {
    const run = layoutTextRun(line(), page, halfEm)!;
    expect(run.text).toBe('Xin chao');
    expect(run.x).toBe(72);
    // 12pt-tall box, em treated as the glyph box: 12pt glyphs.
    expect(run.size).toBe(12);
  });

  it('flips the reader-space top into a PDF baseline inside the block', () => {
    const run = layoutTextRun(line(), page, halfEm)!;
    // Runner space top is y=100 in an 800pt page, so the PDF top edge is 700; the baseline sits
    // DEFAULT_BASELINE_RATIO of the size below it.
    expect(run.y).toBeCloseTo(800 - 100 - 12 * DEFAULT_BASELINE_RATIO, 6);
    expect(run.y).toBeLessThan(700);
    expect(run.y + 12 * DEFAULT_BASELINE_RATIO).toBeCloseTo(700, 6);
    // The baseline is inside the page box.
    expect(run.y).toBeGreaterThan(0);
    expect(run.y).toBeLessThan(page.height);
  });

  it('shrinks the size until the run fits the block width and keeps the baseline inside it', () => {
    const run = layoutTextRun(line({ text: 'a line much wider than its box', rect: { x: 72, y: 100, width: 60, height: 12 } }), page, halfEm)!;
    expect(run.size).toBeLessThan(12);
    expect(halfEm.widthOfTextAtSize(run.text, run.size)).toBeLessThanOrEqual(60 + 0.01);
    const top = 700;
    expect(run.y).toBeLessThan(top);
    expect(run.y).toBeGreaterThan(top - 12);
  });

  it('lays two blocks on one line side by side without overlapping', () => {
    const left = layoutTextRun(line({ id: 'left' }), page, halfEm)!;
    const right = layoutTextRun(line({
      id: 'right',
      text: 'second run',
      rect: { x: 300, y: 100, width: 200, height: 12 },
    }), page, halfEm)!;
    expect(left.y).toBeCloseTo(right.y, 6);
    const leftRight = left.x + halfEm.widthOfTextAtSize(left.text, left.size);
    expect(leftRight).toBeLessThanOrEqual(right.x);
  });

  it('folds the text into the WinAnsi repertoire it will be written in', () => {
    const run = layoutTextRun(line({ text: 'Tiếng Việt 2026' }), page, halfEm)!;
    expect(run.text).toBe('Tieng Viet 2026');
    expect(run.text).toContain('2026');
  });

  it('collapses line breaks and padding into one run', () => {
    const run = layoutTextRun(line({ text: '  first\n second\t third  ' }), page, halfEm)!;
    expect(run.text).toBe('first second third');
    expect(run.text).not.toContain('\n');
  });

  it('has no run for a block with nothing to write or no box on the page', () => {
    expect(layoutTextRun(line({ text: '   ' }), page, halfEm)).toBeNull();
    expect(layoutTextRun(line({ text: '中文' }), page, halfEm)).toBeNull();
    expect(layoutTextRun(line({ rect: { x: Number.NaN, y: 100, width: 40, height: 12 } }), page, halfEm)).toBeNull();
    expect(layoutTextRun(line({ rect: { x: -40, y: 100, width: 30, height: 12 } }), page, halfEm)).toBeNull();
    expect(layoutTextRun(line(), { width: 0, height: 800 }, halfEm)).toBeNull();
  });

  it('clamps a box that starts outside the page instead of losing it', () => {
    const run = layoutTextRun(line({ text: 'ab', rect: { x: -20, y: -10, width: 100, height: 50 } }), page, halfEm)!;
    expect(run.x).toBe(0);
    // Clamped to 80x40: the glyph height still matches the clamped box height.
    expect(run.size).toBe(40);
    expect(run.y).toBeCloseTo(800 - 0 - 40 * DEFAULT_BASELINE_RATIO, 6);
  });
});

describe('buildSearchablePdf', () => {
  it('keeps the scan as a full-bleed image XObject', async () => {
    const result = await buildSearchablePdf({ pages: [scanPage()], blocks: scanBlocks() });
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: BOX.width, height: BOX.height });

    const resources = doc.getPage(0).node.Resources();
    const xobjects = resources?.lookup(PDFName.of('XObject'), PDFDict);
    expect(xobjects).toBeDefined();
    const entries = xobjects!.entries();
    expect(entries).toHaveLength(1);
    const image = doc.context.lookup(entries[0]![1]);
    expect(image).toBeInstanceOf(PDFRawStream);
    expect((image as PDFRawStream).dict.lookup(PDFName.of('Subtype'))?.toString()).toBe('/Image');

    // The layer needs its font resource; without it the text would be unselectable.
    const fonts = resources?.lookup(PDFName.of('Font'), PDFDict);
    expect(fonts?.keys()).toHaveLength(1);
    expect(result.imagePages).toBe(1);

    // The raster covers the whole page (612x792 at the origin) and is drawn before the text layer.
    const stream = pageContentStream(doc, 0);
    expect(stream).toContain('612 0 0 792 0 0 cm');
    expect(stream.indexOf(' Do')).toBeGreaterThan(-1);
    expect(stream.indexOf(' Do')).toBeLessThan(stream.indexOf(' Tj'));
  });

  it('writes every run in the decoded content stream with render mode 3 set before it', async () => {
    const blocks = scanBlocks();
    const result = await buildSearchablePdf({ pages: [scanPage()], blocks });
    const shown = readShownText(pageContentStream(await PDFDocument.load(result.bytes), 0));

    expect(shown).toHaveLength(blocks.length);
    for (const text of shown) expect(text.renderMode).toBe(3);
    // The shown strings are the layout's runs, in source order, and nothing was drawn white-on-white.
    const written = shown.map(text => Buffer.from(text.hex, 'hex').toString('latin1'));
    expect(written).toEqual(layoutsOf(blocks, halfEm).map(run => run.text));
  });

  it('places each baseline at the laid-out origin inside the page box', async () => {
    const blocks = scanBlocks();
    const result = await buildSearchablePdf({ pages: [scanPage()], blocks });
    const shown = readShownText(pageContentStream(await PDFDocument.load(result.bytes), 0));
    const layouts = layoutsOf(blocks, await helvetica());
    expect(shown).toHaveLength(layouts.length);

    for (let index = 0; index < layouts.length; index++) {
      const layout = layouts[index]!;
      const text = shown[index]!;
      expect(text.x).toBe(layout.x);
      expect(text.y).toBeCloseTo(layout.y, 6);
      // Inside the page box, and on the source line rather than somewhere else on the page.
      expect(text.y).toBeGreaterThan(0);
      expect(text.y).toBeLessThan(BOX.height);
      const source = blocks[index]!;
      const top = BOX.height - source.rect.y;
      expect(text.y).toBeLessThan(top);
      expect(text.y).toBeGreaterThan(top - source.rect.height);
    }
  });

  it('keeps two blocks on the same line from overlapping', async () => {
    const blocks = scanBlocks();
    const metrics = await helvetica();
    const result = await buildSearchablePdf({ pages: [scanPage()], blocks });
    const [left, right] = layoutsOf(blocks, metrics);
    expect(left!.y).toBeCloseTo(right!.y, 6);
    expect(left!.x + metrics.widthOfTextAtSize(left!.text, left!.size)).toBeLessThanOrEqual(right!.x);

    // Same conclusion from the written stream: the runs are separated horizontally.
    const shown = readShownText(pageContentStream(await PDFDocument.load(result.bytes), 0));
    const leftShown = shown[0]!;
    const rightShown = shown[1]!;
    expect(leftShown.y).toBeCloseTo(rightShown.y, 6);
    expect(leftShown.x).toBeLessThan(rightShown.x);
    expect(leftShown.x + metrics.widthOfTextAtSize(Buffer.from(leftShown.hex, 'hex').toString('latin1'), left!.size))
      .toBeLessThanOrEqual(rightShown.x);
  });

  it('still produces a valid PDF when there are no blocks', async () => {
    const result = await buildSearchablePdf({ pages: [scanPage()], blocks: [] });
    expect(result.runCount).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.bytes.length).toBeGreaterThan(0);

    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: BOX.width, height: BOX.height });
    const stream = pageContentStream(doc, 0);
    expect(stream).not.toContain('Tj');
    expect(stream).not.toContain('Tr');
    // The scan is still there: an empty text layer never drops the image.
    const xobjects = doc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    expect(xobjects?.keys()).toHaveLength(1);
    expect((await extractText(result.bytes))[0]!.trim()).toBe('');
  });

  it('extracts the block text at the laid-out position with the reader stack', async () => {
    const blocks = scanBlocks();
    const layouts = layoutsOf(blocks, await helvetica());
    const result = await buildSearchablePdf({ pages: [scanPage()], blocks });
    const pages = await extractPages(result.bytes);
    expect(pages).toHaveLength(1);
    // pdfjs also reports a synthetic space item for the gap between runs on one baseline; it is
    // spacing, not a source box, so the position assertions look at the real runs only.
    const items = pages[0]!.filter(item => item.str.trim().length > 0);
    expect(items).toHaveLength(layouts.length);

    for (let index = 0; index < layouts.length; index++) {
      const layout = layouts[index]!;
      const item = items[index]!;
      expect(item.str).toBe(layout.text);
      // The reader reports the same baseline the layer was written at, i.e. the source box.
      expect(item.x).toBeCloseTo(layout.x, 1);
      expect(item.y).toBeCloseTo(layout.y, 1);
    }
    console.info(`[searchable-pdf] 1-page invisible layer over a scan: ${result.bytes.length} bytes`);
    console.info(`[searchable-pdf] pdfjs extracted: ${JSON.stringify(pages[0]!.map(item => item.str).join(''))}`);
  });

  it('puts each block on the page it belongs to', async () => {
    const result = await buildSearchablePdf({
      pages: [
        { number: 1, width: 300, height: 400, image: { format: 'png', bytes: solidPng() } },
        { number: 2, width: 400, height: 500, image: { format: 'png', bytes: solidPng() } },
      ],
      blocks: [{ id: 'late', page: 2, text: 'Page two', rect: { x: 40, y: 60, width: 200, height: 14 } }],
    });
    expect(result.pageCount).toBe(2);
    expect(result.imagePages).toBe(2);
    expect(result.runCount).toBe(1);

    const text = await extractText(result.bytes);
    expect(text[0]!.trim()).toBe('');
    expect(text[1]).toContain('Page two');

    // The run sits on page 2's own box: a 500pt page, block top at 60.
    const doc = await PDFDocument.load(result.bytes);
    expect(pageContentStream(doc, 0)).not.toContain('Tj');
    const shown = readShownText(pageContentStream(doc, 1));
    expect(shown).toHaveLength(1);
    expect(shown[0]!.y).toBeGreaterThan(500 - 60 - 14);
    expect(shown[0]!.y).toBeLessThan(500 - 60);
  });

  it('writes the folded spelling into the layer and reports the limitation', async () => {
    const result = await buildSearchablePdf({
      pages: [scanPage()],
      blocks: [{ id: 'vi', page: 1, text: 'Tiếng Việt 2026', rect: { x: 72, y: 100, width: 300, height: 12 } }],
    });
    expect(result.limitations).toContain(FONT_LIMITATION);
    expect((await extractText(result.bytes))[0]).toContain('Tieng Viet 2026');
  });

  it('stays findable by the app search even when the query carries diacritics', async () => {
    const result = await buildSearchablePdf({
      pages: [scanPage()],
      blocks: [{ id: 'vi', page: 1, text: 'Tiếng Việt 2026', rect: { x: 72, y: 100, width: 300, height: 12 } }],
    });
    // The reader folds diacritics on both sides, so a "Tiếng Việt" query matches the folded layer.
    const layer = (await extractText(result.bytes))[0]!;
    expect(foldSearchText(layer).text).toContain(foldSearchText('Tiếng Việt').text);
  });

  it('reports the blocks it could not draw instead of dropping them quietly', async () => {
    const result = await buildSearchablePdf({
      pages: [scanPage()],
      blocks: [
        { id: 'blank', page: 1, text: '   ', rect: { x: 72, y: 100, width: 200, height: 12 } },
        { id: 'cjk', page: 1, text: '中文', rect: { x: 72, y: 130, width: 200, height: 12 } },
        { id: 'nan', page: 1, text: 'broken', rect: { x: Number.NaN, y: 160, width: 200, height: 12 } },
        { id: 'elsewhere', page: 9, text: 'page nine', rect: { x: 72, y: 190, width: 200, height: 12 } },
      ],
    });
    expect(result.runCount).toBe(0);
    expect(result.skipped).toEqual([
      { id: 'blank', page: 1, reason: 'empty' },
      { id: 'cjk', page: 1, reason: 'unrepresentable' },
      { id: 'nan', page: 1, reason: 'invalid' },
      { id: 'elsewhere', page: 9, reason: 'no-page' },
    ]);
  });

  it('flags a run that cannot shrink into its box', async () => {
    const result = await buildSearchablePdf({
      pages: [scanPage()],
      blocks: [{ id: 'tiny', page: 1, text: 'a line far too long for this box', rect: { x: 72, y: 100, width: 5, height: 12 } }],
    });
    expect(result.runCount).toBe(1);
    expect(result.overflowing).toBe(1);
    expect(result.limitations).toContain(OVERFLOW_LIMITATION);
    // The run is still on the page, just wider than its box.
    const shown = readShownText(pageContentStream(await PDFDocument.load(result.bytes), 0));
    expect(shown).toHaveLength(1);
    expect(shown[0]!.renderMode).toBe(3);
    expect(shown[0]!.y).toBeGreaterThan(0);
    expect(shown[0]!.y).toBeLessThan(BOX.height);
  });

  it('needs at least one page and a text face', async () => {
    await expect(buildSearchablePdf({ pages: [], blocks: [] })).rejects.toBeInstanceOf(SearchablePdfError);
    await expect(buildSearchablePdf({
      pages: [scanPage()],
      blocks: [],
      font: StandardFonts.ZapfDingbats,
    })).rejects.toBeInstanceOf(SearchablePdfError);
    await expect(buildSearchablePdf({
      pages: [{ number: 1, width: 0, height: 100 }],
      blocks: [],
    })).rejects.toBeInstanceOf(SearchablePdfError);
  });
});
