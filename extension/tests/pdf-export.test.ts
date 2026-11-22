import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import {
  BIDI_LIMITATION,
  DEFAULT_BASELINE_RATIO,
  FONT_LIMITATION,
  PdfExportError,
  buildPdf,
  canvasToPng,
  compareReadingOrder,
  foldToWinAnsi,
  isWinAnsiText,
  pagePlan,
  translatedOcrPageNumbers,
  type PdfBlockSource,
  type PdfPageSource,
} from '../viewer/src/export/pdf';

/** Deterministic stand-in for real font metrics: every character is half an em. */
const measure = (text: string, size: number): number => text.length * size * 0.5;

const block = (overrides: Partial<PdfBlockSource> & { id: string; text: string }): PdfBlockSource => ({
  rect: { x: 20, y: 20, width: 200, height: 30 },
  fontSize: 10,
  ...overrides,
});

const page = (overrides: Partial<PdfPageSource> & { width: number; height: number }): PdfPageSource => ({
  number: 1,
  ...overrides,
});

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

/** Extracts text per page with the project's own PDF reader stack (pdfjs), not by guessing bytes. */
async function extractText(bytes: Uint8Array): Promise<string[]> {
  // pdfjs transfers the buffer it is given, so the caller's copy stays readable afterwards.
  const task = getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const document = await task.promise;
  try {
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const content = await (await document.getPage(number)).getTextContent();
      pages.push(content.items.map(item => ('str' in item ? item.str : '')).join(''));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

const VIETNAMESE = 'Doanh thu quý 3 năm 2026: 1.5 tỷ đồng (42%)';

describe('WinAnsi folding', () => {
  it('leaves digits exactly as they were', () => {
    const digits = (value: string): string[] => value.match(/\d+(?:[.,]\d+)?/g) ?? [];
    const folded = foldToWinAnsi(VIETNAMESE);
    expect(digits(folded.text)).toEqual(digits(VIETNAMESE));
    expect(folded.text).toContain('2026');
    expect(folded.text).toContain('1.5');
    expect(folded.text).toContain('42%');
  });

  it('folds Vietnamese letters to their Latin base and keeps WinAnsi letters', () => {
    // "quý" survives: y with an acute is already inside WinAnsi. "ă", "ỷ", "đ" and "ồ" are not,
    // so only their base letters remain.
    const folded = foldToWinAnsi(VIETNAMESE).text;
    expect(folded).toBe('Doanh thu quý 3 nam 2026: 1.5 ty dong (42%)');
    expect(folded).toContain('quý');
    expect(folded).toContain('nam');
    expect(folded).toContain('ty dong');
    expect(foldToWinAnsi('café – “quoted”').text).toBe('café - "quoted"');
  });

  it('reports characters it had to drop instead of emitting tofu', () => {
    const folded = foldToWinAnsi('中文 42');
    expect(folded.text.trim()).toBe('42');
    expect(folded.dropped).toBe(2);
    expect(folded.changed).toBe(true);
  });

  it('leaves fully WinAnsi text untouched', () => {
    const folded = foldToWinAnsi('Plain ASCII 2026');
    expect(folded).toEqual({ text: 'Plain ASCII 2026', changed: false, dropped: 0 });
  });

  it('answers whether text is directly writable in WinAnsi', () => {
    expect(isWinAnsiText('Tieng Viet 2026')).toBe(true);
    expect(isWinAnsiText('Tiếng Việt')).toBe(false);
  });
});

describe('reading order', () => {
  it('orders top to bottom, then left to right inside a band', () => {
    const blocks = [
      block({ id: 'bottom', text: 'b', rect: { x: 0, y: 400, width: 100, height: 20 } }),
      block({ id: 'right', text: 'r', rect: { x: 300, y: 100, width: 100, height: 20 } }),
      block({ id: 'left', text: 'l', rect: { x: 100, y: 100.5, width: 100, height: 20 } }),
    ];
    expect([...blocks].sort(compareReadingOrder).map(item => item.id)).toEqual(['left', 'right', 'bottom']);
  });

  it('reverses the horizontal order when both neighbours are right-to-left', () => {
    const blocks = [
      block({ id: 'west', text: 'w', rect: { x: 100, y: 100, width: 80, height: 20 }, direction: 'rtl' }),
      block({ id: 'east', text: 'e', rect: { x: 300, y: 100, width: 80, height: 20 }, direction: 'rtl' }),
    ];
    expect([...blocks].sort(compareReadingOrder).map(item => item.id)).toEqual(['east', 'west']);
  });
});

describe('pagePlan', () => {
  it('reports the page size and a full-bleed image placement', () => {
    const plan = pagePlan(page({ width: 612, height: 792, image: { format: 'png', bytes: solidPng() } }), { measure });
    expect(plan.width).toBe(612);
    expect(plan.height).toBe(792);
    expect(plan.image).toEqual({ x: 0, y: 0, width: 612, height: 792 });
    expect(pagePlan(page({ width: 612, height: 792 }), { measure }).image).toBeNull();
  });

  it('converts the reader rect into a PDF-space cover', () => {
    const plan = pagePlan(page({
      width: 600,
      height: 800,
      blocks: [block({ id: 'a', text: 'Xin chao', rect: { x: 72, y: 100, width: 200, height: 40 } })],
    }), { measure });
    // y grows down in reader space and up in PDF space: 800 - 100 - 40 = 660.
    expect(plan.blocks[0]?.cover).toEqual({ x: 72, y: 660, width: 200, height: 40 });
  });

  it('places the first baseline inside the cover using the reader font size', () => {
    const plan = pagePlan(page({
      width: 600,
      height: 800,
      blocks: [block({ id: 'a', text: 'Xin chao', rect: { x: 72, y: 100, width: 200, height: 40 }, fontSize: 10 })],
    }), { measure });
    const planned = plan.blocks[0]!;
    const baseline = planned.runs[0]!;
    expect(baseline).toEqual({ text: 'Xin chao', x: 72, y: 800 - 100 - 10 * DEFAULT_BASELINE_RATIO });
    expect(baseline.y).toBeGreaterThan(planned.cover.y);
    expect(baseline.y).toBeLessThan(planned.cover.y + planned.cover.height);
  });

  it('wraps a block into several runs that stay inside the cover', () => {
    const plan = pagePlan(page({
      width: 400,
      height: 400,
      blocks: [block({ id: 'a', text: 'alpha beta gamma', rect: { x: 10, y: 10, width: 30, height: 200 }, fontSize: 10 })],
    }), { measure });
    const planned = plan.blocks[0]!;
    expect(planned.runs.length).toBeGreaterThan(1);
    expect(planned.runs.map(run => run.text).join(' ')).toBe('alpha beta gamma');
    for (const run of planned.runs) expect(run.y).toBeLessThan(planned.cover.y + planned.cover.height + 0.01);
  });

  it('drops lines that would print outside the cover and says so', () => {
    const plan = pagePlan(page({
      width: 400,
      height: 400,
      blocks: [block({ id: 'a', text: 'one two three four five six seven eight', rect: { x: 10, y: 10, width: 40, height: 14 }, fontSize: 10 })],
    }), { measure });
    const planned = plan.blocks[0]!;
    expect(planned.truncated).toBe(true);
    for (const run of planned.runs) {
      expect(run.y).toBeGreaterThanOrEqual(planned.cover.y);
      expect(run.y).toBeLessThanOrEqual(planned.cover.y + planned.cover.height + 0.01);
    }
  });

  it('sorts planned blocks into reading order regardless of input order', () => {
    const plan = pagePlan(page({
      width: 600,
      height: 800,
      blocks: [
        block({ id: 'last', text: 'last', rect: { x: 60, y: 500, width: 200, height: 24 } }),
        block({ id: 'first', text: 'first', rect: { x: 60, y: 60, width: 200, height: 24 } }),
        block({ id: 'second', text: 'second', rect: { x: 60, y: 120, width: 200, height: 24 } }),
      ],
    }), { measure });
    expect(plan.blocks.map(planned => planned.id)).toEqual(['first', 'second', 'last']);
  });

  it('classifies blocks it cannot draw instead of drawing nothing quietly', () => {
    const plan = pagePlan(page({
      width: 400,
      height: 400,
      blocks: [
        block({ id: 'blank', text: '   ' }),
        block({ id: 'cjk', text: '中文' }),
        block({ id: 'nan', text: 'x', rect: { x: Number.NaN, y: 10, width: 10, height: 10 } }),
        block({ id: 'good', text: 'ok' }),
      ],
    }), { measure });
    expect(plan.blocks.map(planned => planned.id)).toEqual(['good']);
    // Skipped entries follow source order, not the reading order the drawn blocks use.
    expect(plan.skipped).toEqual([
      { id: 'blank', reason: 'empty' },
      { id: 'cjk', reason: 'unrepresentable' },
      { id: 'nan', reason: 'invalid' },
    ]);
  });

  it('flags folded text and keeps the original digit groups', () => {
    const plan = pagePlan(page({
      width: 612,
      height: 792,
      blocks: [block({ id: 'a', text: VIETNAMESE, rect: { x: 72, y: 100, width: 468, height: 40 }, fontSize: 12 })],
    }), { measure });
    const planned = plan.blocks[0]!;
    expect(planned.folded).toBe(true);
    expect(planned.dropped).toBe(0);
    expect(planned.runs.map(run => run.text).join(' ')).toBe('Doanh thu quý 3 nam 2026: 1.5 ty dong (42%)');
  });

  it('rotates a run around its own rect instead of leaving the page', () => {
    const plan = pagePlan(page({
      width: 600,
      height: 800,
      blocks: [block({ id: 'a', text: 'sideways', rect: { x: 100, y: 100, width: 120, height: 20 }, rotation: 90 })],
    }), { measure });
    const run = plan.blocks[0]!.runs[0]!;
    expect(Number.isFinite(run.x)).toBe(true);
    expect(Number.isFinite(run.y)).toBe(true);
    expect(plan.blocks[0]!.rotation).toBe(90);
    expect(plan.blocks[0]!.cover).toEqual({ x: 100, y: 680, width: 120, height: 20 });
  });

  it('clamps a rect that starts outside the page', () => {
    const plan = pagePlan(page({
      width: 300,
      height: 300,
      blocks: [block({ id: 'a', text: 'clipped', rect: { x: -20, y: -10, width: 100, height: 50 }, fontSize: 8 })],
    }), { measure });
    expect(plan.blocks[0]?.cover).toEqual({ x: 0, y: 260, width: 80, height: 40 });
  });

  it('rejects a page with no usable size', () => {
    expect(() => pagePlan(page({ width: 0, height: 400 }))).toThrow(PdfExportError);
    expect(() => pagePlan(page({ width: 400, height: Number.NaN }))).toThrow(PdfExportError);
  });
});

describe('buildPdf', () => {
  const twoPages = (): PdfPageSource[] => [
    {
      number: 1,
      width: 300,
      height: 400,
      image: { format: 'png', bytes: solidPng() },
      blocks: [block({ id: 'p1', text: 'Page one translated 100%', rect: { x: 20, y: 50, width: 260, height: 30 }, fontSize: 12 })],
    },
    {
      number: 2,
      width: 612,
      height: 792,
      blocks: [block({ id: 'p2', text: VIETNAMESE, rect: { x: 72, y: 100, width: 468, height: 40 }, fontSize: 12, direction: 'rtl' })],
    },
  ];

  it('writes a real PDF with one page per source page at the source size', async () => {
    const result = await buildPdf(twoPages(), { title: 'Mirror export' });
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(String.fromCharCode(...result.bytes.subarray(0, 5))).toBe('%PDF-');
    expect(result.pageCount).toBe(2);
    expect(result.blockCount).toBe(2);

    const reloaded = await PDFDocument.load(result.bytes);
    expect(reloaded.getPageCount()).toBe(2);
    expect(reloaded.getPage(0).getSize()).toEqual({ width: 300, height: 400 });
    expect(reloaded.getPage(1).getSize()).toEqual({ width: 612, height: 792 });
    expect(reloaded.getTitle()).toBe('Mirror export');
  });

  it('embeds the page image only where a raster was supplied', async () => {
    const result = await buildPdf(twoPages());
    expect(result.imagePages).toBe(1);
    const reloaded = await PDFDocument.load(result.bytes);
    const xobjects = (target: number): number => {
      const resources = reloaded.getPage(target).node.Resources();
      const dictionary = resources?.lookup(PDFName.of('XObject'), PDFDict);
      return dictionary?.keys().length ?? 0;
    };
    expect(xobjects(0)).toBe(1);
    expect(xobjects(1)).toBe(0);
  });

  it('produces a page 2 whose extracted text is the translated string', async () => {
    const result = await buildPdf(twoPages());
    // Extract with pdfjs: the same reader stack the app uses, not a byte-level guess.
    const text = await extractText(result.bytes);
    expect(text).toHaveLength(2);
    expect(text[0]).toContain('Page one translated 100%');
    expect(text[1]).toContain('Doanh thu quý 3 nam 2026: 1.5 ty dong (42%)');
    expect(text[1]).not.toContain('Page one');
    expect(text[1]).toContain('2026');
    expect(text[1]).toContain('42%');
    console.info(`[pdf-export] 2-page PDF: ${result.bytes.length} bytes`);
  });

  it('reports the font limitation instead of silently producing tofu', async () => {
    const result = await buildPdf(twoPages());
    expect(result.fontName).toBe('Helvetica (WinAnsi)');
    expect(result.limitations).toContain(FONT_LIMITATION);
    expect(result.limitations).toContain(BIDI_LIMITATION);
    expect(FONT_LIMITATION).toContain('tofu');
  });

  it('surfaces skipped and truncated blocks as export limitations', async () => {
    const result = await buildPdf([{
      number: 4,
      width: 300,
      height: 300,
      blocks: [
        block({ id: 'missing-glyph', text: '中文' }),
        block({ id: 'too-tall', text: 'one two three four five six seven eight', rect: { x: 10, y: 10, width: 40, height: 14 }, fontSize: 10 }),
      ],
    }]);
    expect(result.skipped).toEqual([{ id: 'missing-glyph', reason: 'unrepresentable' }]);
    expect(result.limitations.some(item => item.includes('missing-glyph') && item.includes('unrepresentable'))).toBe(true);
    expect(result.limitations.some(item => item.includes('too-tall') && item.includes('truncated'))).toBe(true);
  });

  it('reports when a scanned page image is missing rather than implying source fidelity', async () => {
    const result = await buildPdf([{ number: 7, width: 300, height: 300, blocks: [] }]);
    expect(result.limitations.some(item => item.includes('Page 7') && item.includes('image'))).toBe(true);
  });

  it('does not draw a block it cannot represent', async () => {
    const onlyCjk: PdfPageSource[] = [{
      number: 1,
      width: 200,
      height: 200,
      blocks: [block({ id: 'cjk', text: '中文', rect: { x: 10, y: 10, width: 180, height: 30 }, fontSize: 12 })],
    }];
    const result = await buildPdf(onlyCjk);
    expect(result.blockCount).toBe(0);
    expect(result.skipped).toEqual([{ id: 'cjk', reason: 'unrepresentable' }]);
    expect((await extractText(result.bytes))[0]?.trim()).toBe('');
  });

  it('survives a corrupt page image by keeping the text', async () => {
    const broken: PdfPageSource[] = [{
      number: 1,
      width: 300,
      height: 300,
      image: { format: 'png', bytes: new Uint8Array([1, 2, 3, 4]) },
      blocks: [block({ id: 'a', text: 'still here', rect: { x: 10, y: 10, width: 260, height: 30 }, fontSize: 12 })],
    }];
    const result = await buildPdf(broken);
    expect(result.imagePages).toBe(0);
    expect(result.limitations.some(limit => limit.includes('Page 1'))).toBe(true);
    expect((await extractText(result.bytes))[0]).toContain('still here');
  });

  it('needs at least one page', async () => {
    await expect(buildPdf([])).rejects.toBeInstanceOf(PdfExportError);
  });
});

describe('scanned-page export semantics', () => {
  it('keeps OCR-only translations out of the overlay PDF and identifies the original-image pages', () => {
    const pages = [
      { number: 2, blocks: [{ id: 'ocr-2-a', translated: true }, { id: 'ocr-2-b', translated: false }] },
      { number: 3, blocks: [{ id: 'text-3-a', translated: true }] },
      { number: 4, blocks: [{ id: 'ocr-4-a', translated: false }] },
    ];
    expect(translatedOcrPageNumbers(pages)).toEqual([2]);
  });
});

describe('reader wiring', () => {
  const source = readFileSync(new URL('../viewer/src/main.ts', import.meta.url), 'utf8');

  it('puts the real PDF action immediately after the print action', () => {
    expect(source).toMatch(/<button id="export-print"[^>]*>[^<]*<\/button><button id="export-pdf" data-i18n="exportPdf">/);
  });

  it('adds no second toolbar style', () => {
    const attributes = source.match(/<button id="export-pdf"([^>]*)>/)?.[1] ?? '';
    // Styling comes from `.toolbar-actions button`, exactly like the control it follows.
    expect(attributes).not.toContain('class=');
    expect(attributes).not.toContain('style=');
  });

  it('reports PDF limitations and preserves the scanned-source boundary', () => {
    expect(source).toContain("status('exportPdfReady',false,{size,pages:result.pageCount})");
    expect(source).toContain('with limitations: ${warnings.join(\' \')}');
    expect(source).toContain('the original scanned image remains and its translation was not written into the PDF');
    expect(source).toContain("if(block.id.startsWith('ocr-')) return []");
    expect(source).toContain('pages:result.pageCount');
    expect(source).toContain("status('exportPdfFailed',true,{message:errorMessage(error)})");
  });
});

describe('canvasToPng', () => {
  it('reads a toBlob canvas', async () => {
    const bytes = solidPng();
    const canvas = { toBlob: (callback: (blob: Blob) => void) => callback(new Blob([new Uint8Array(bytes)], { type: 'image/png' })) };
    const source = await canvasToPng(canvas as unknown as HTMLCanvasElement);
    expect(source.format).toBe('png');
    expect(source.bytes.length).toBe(bytes.length);
  });

  it('falls back to a data URL when toBlob is missing', async () => {
    const base64 = Buffer.from('png-bytes').toString('base64');
    const canvas = { toDataURL: () => `data:image/png;base64,${base64}` };
    const source = await canvasToPng(canvas as unknown as HTMLCanvasElement);
    expect(new TextDecoder().decode(source.bytes)).toBe('png-bytes');
  });

  it('names the failure when there is no canvas API at all', async () => {
    await expect(canvasToPng({} as HTMLCanvasElement)).rejects.toBeInstanceOf(PdfExportError);
  });
});
