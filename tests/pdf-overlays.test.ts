import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { BUNDLED_FONT_NAME, FALLBACK_FACE_NAME } from '../src/export/fonts';
import {
  DEFAULT_BASELINE_RATIO,
  FONT_LIMITATION,
  PdfExportError,
} from '../src/export/pdf';
import {
  DEFAULT_ARROW_HEAD_ANGLE,
  DEFAULT_ARROW_HEAD_LENGTH,
  DEFAULT_CALLOUT_PADDING,
  DEFAULT_WATERMARK_ANGLE,
  DEFAULT_WATERMARK_OPACITY,
  composePdfOverlays,
  computeArrowGeometry,
  planPdfOverlays,
  readerPointToPdfPoint,
  readerRectToPdfRect,
  type PdfOverlay,
} from '../src/export/pdf-overlays';

const FONT_BYTES = new Uint8Array(
  readFileSync(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
);

const EXISTING_SAMPLE_PDF = new Uint8Array(
  readFileSync(new URL('./fixtures/mirror-field-notes.pdf', import.meta.url)),
);

const measureHalfEm = (text: string, size: number): number => text.length * size * 0.5;

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

function solidPng(width = 2, height = 2): Uint8Array {
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
      raw[at] = 0x2b;
      raw[at + 1] = 0x6c;
      raw[at + 2] = 0xb0;
    }
  }
  const chunks = [
    pngChunk('IHDR', header),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array(0)),
  ];
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

/** Minimal valid 1x1 grayscale baseline JPEG accepted by pdf-lib and pdfjs-dist. */
function minimalJpeg(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
    0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array<number>(64).fill(1),
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0x3f,
    0xff, 0xd9,
  ]);
}

function pageContentStream(doc: PDFDocument, pageIndex: number): string {
  const contents = doc.getPage(pageIndex).node.Contents();
  const values = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  const chunks: string[] = [];
  for (const value of values) {
    const resolved = doc.context.lookup(value);
    if (!(resolved instanceof PDFRawStream)) throw new Error('expected PDFRawStream in page contents');
    const filter = resolved.dict.lookup(PDFName.of('Filter'));
    const raw = resolved.getContents();
    const decoded = filter?.toString() === '/FlateDecode' ? new Uint8Array(inflateSync(raw)) : raw;
    chunks.push(Buffer.from(decoded).toString('latin1'));
  }
  return chunks.join('\n');
}

function pageExtGStates(doc: PDFDocument, pageIndex: number): Array<{ ca?: number; CA?: number }> {
  const resources = doc.getPage(pageIndex).node.Resources();
  const dict = resources?.lookup(PDFName.of('ExtGState'), PDFDict);
  if (!dict) return [];
  return dict.keys().map(key => {
    const entry = dict.lookup(key, PDFDict);
    const caObj = entry.get(PDFName.of('ca'));
    const strokeCaObj = entry.get(PDFName.of('CA'));
    return {
      ...(caObj instanceof PDFNumber ? { ca: caObj.asNumber() } : {}),
      ...(strokeCaObj instanceof PDFNumber ? { CA: strokeCaObj.asNumber() } : {}),
    };
  });
}

function pageImageXObjects(
  doc: PDFDocument,
  pageIndex: number,
): Array<{ width: number; height: number; filter: string }> {
  const resources = doc.getPage(pageIndex).node.Resources();
  const dict = resources?.lookup(PDFName.of('XObject'), PDFDict);
  if (!dict) return [];
  const results: Array<{ width: number; height: number; filter: string }> = [];
  for (const key of dict.keys()) {
    const stream = dict.lookup(key);
    if (!(stream instanceof PDFRawStream)) continue;
    const subtype = stream.dict.get(PDFName.of('Subtype'));
    if (subtype?.toString() !== '/Image') continue;
    const widthObj = stream.dict.get(PDFName.of('Width'));
    const heightObj = stream.dict.get(PDFName.of('Height'));
    const filterObj = stream.dict.get(PDFName.of('Filter'));
    results.push({
      width: widthObj instanceof PDFNumber ? widthObj.asNumber() : 0,
      height: heightObj instanceof PDFNumber ? heightObj.asNumber() : 0,
      filter: filterObj?.toString() ?? '',
    });
  }
  return results;
}

interface PdfJsItem {
  str: string;
  x: number;
  y: number;
  fontSize: number;
  angleDeg: number;
}

interface PdfJsSnapshot {
  numPages: number;
  pageSizes: Array<{ width: number; height: number }>;
  pageTexts: string[];
  pageItems: PdfJsItem[][];
}

async function readWithPdfJs(bytes: Uint8Array): Promise<PdfJsSnapshot> {
  const task = getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const pageSizes: Array<{ width: number; height: number }> = [];
    const pageTexts: string[] = [];
    const pageItems: PdfJsItem[][] = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const pdfPage = await doc.getPage(number);
      const viewport = pdfPage.getViewport({ scale: 1 });
      pageSizes.push({ width: viewport.width, height: viewport.height });
      const content = await pdfPage.getTextContent();
      const items: PdfJsItem[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const a = item.transform[0] ?? 1;
        const b = item.transform[1] ?? 0;
        const x = item.transform[4] ?? Number.NaN;
        const y = item.transform[5] ?? Number.NaN;
        items.push({
          str: item.str,
          x,
          y,
          fontSize: Math.hypot(a, b),
          angleDeg: (Math.atan2(b, a) * 180) / Math.PI,
        });
      }
      pageItems.push(items);
      pageTexts.push(items.map(entry => entry.str).join(''));
    }
    return { numPages: doc.numPages, pageSizes, pageTexts, pageItems };
  } finally {
    await task.destroy();
  }
}

describe('H05 coordinate transforms (reader top-left -> PDF y-up)', () => {
  it('converts reader points and rects accurately into PDF bottom-left point coordinates', () => {
    expect(readerPointToPdfPoint({ x: 72, y: 120 }, 792)).toEqual({ x: 72, y: 672 });
    expect(readerPointToPdfPoint({ x: 0, y: 0 }, 842)).toEqual({ x: 0, y: 842 });
    expect(readerPointToPdfPoint({ x: 595, y: 842 }, 842)).toEqual({ x: 595, y: 0 });

    expect(
      readerRectToPdfRect({ x: 50, y: 100, width: 200, height: 60 }, 800),
    ).toEqual({ x: 50, y: 640, width: 200, height: 60 });
  });

  it('plans text boxes, callouts, images, shapes, and watermarks in PDF space with exact coordinates', () => {
    const overlays: PdfOverlay[] = [
      {
        kind: 'textbox',
        id: 'tb-1',
        page: 1,
        rect: { x: 40, y: 60, width: 200, height: 40 },
        text: 'Hello H05',
        fontSize: 12,
      },
      {
        kind: 'callout',
        id: 'co-1',
        page: 1,
        rect: { x: 300, y: 80, width: 180, height: 50 },
        text: 'Check figure',
        fontSize: 10,
        pointer: { x: 250, y: 180 },
      },
      {
        kind: 'image',
        id: 'img-1',
        page: 1,
        rect: { x: 60, y: 300, width: 120, height: 80 },
        format: 'png',
        bytes: solidPng(),
      },
      {
        kind: 'rect',
        id: 'rect-1',
        page: 2,
        rect: { x: 30, y: 40, width: 140, height: 70 },
        strokeColor: '#1d4ed8',
        strokeWidth: 2,
      },
      {
        kind: 'ellipse',
        id: 'ell-1',
        page: 2,
        rect: { x: 200, y: 100, width: 100, height: 60 },
        fillColor: '#bbf7d0',
      },
      {
        kind: 'line',
        id: 'line-1',
        page: 2,
        start: { x: 20, y: 300 },
        end: { x: 220, y: 340 },
      },
      {
        kind: 'arrow',
        id: 'arr-1',
        page: 2,
        start: { x: 50, y: 500 },
        end: { x: 150, y: 500 },
      },
      {
        kind: 'watermark',
        id: 'wm-1',
        page: 1,
        text: 'DRAFT',
      },
    ];

    const plan = planPdfOverlays(
      [
        { number: 1, width: 612, height: 792 },
        { number: 2, width: 595, height: 842 },
      ],
      overlays,
      { measure: measureHalfEm },
    );

    expect(plan.pageCount).toBe(2);
    expect(plan.overlayCount).toBe(8);
    expect(plan.appliedCount).toBe(8);

    const page1 = plan.pages[0]!;
    const tb = page1.overlays.find(item => item.id === 'tb-1');
    expect(tb?.kind).toBe('textbox');
    if (tb?.kind === 'textbox') {
      expect(tb.pdfRect).toEqual({ x: 40, y: 792 - 60 - 40, width: 200, height: 40 });
      expect(tb.runs[0]).toEqual({
        text: 'Hello H05',
        x: 40,
        y: 792 - 60 - 12 * DEFAULT_BASELINE_RATIO,
      });
    }

    const co = page1.overlays.find(item => item.id === 'co-1');
    expect(co?.kind).toBe('callout');
    if (co?.kind === 'callout') {
      expect(co.pdfRect).toEqual({ x: 300, y: 792 - 80 - 50, width: 180, height: 50 });
      expect(co.runs[0]).toEqual({
        text: 'Check figure',
        x: 300 + DEFAULT_CALLOUT_PADDING,
        y: 792 - 80 - DEFAULT_CALLOUT_PADDING - 10 * DEFAULT_BASELINE_RATIO,
      });
      expect(co.pointer?.end).toEqual({ x: 250, y: 792 - 180 });
    }

    const img = page1.overlays.find(item => item.id === 'img-1');
    expect(img?.kind).toBe('image');
    if (img?.kind === 'image') {
      expect(img.pdfRect).toEqual({ x: 60, y: 792 - 300 - 80, width: 120, height: 80 });
    }

    const wm = page1.overlays.find(item => item.id === 'wm-1');
    expect(wm?.kind).toBe('watermark');
    if (wm?.kind === 'watermark') {
      expect(wm.center).toEqual({ x: 306, y: 396 });
      expect(wm.opacity).toBe(DEFAULT_WATERMARK_OPACITY);
      expect(wm.angle).toBe(DEFAULT_WATERMARK_ANGLE);
      expect(wm.pdfRotation).toBe(-DEFAULT_WATERMARK_ANGLE);
    }

    const page2 = plan.pages[1]!;
    const ell = page2.overlays.find(item => item.id === 'ell-1');
    expect(ell?.kind).toBe('ellipse');
    if (ell?.kind === 'ellipse') {
      expect(ell.center).toEqual({ x: 250, y: 842 - 130 });
      expect(ell.xScale).toBe(50);
      expect(ell.yScale).toBe(30);
    }

    const arr = page2.overlays.find(item => item.id === 'arr-1');
    expect(arr?.kind).toBe('arrow');
    if (arr?.kind === 'arrow') {
      expect(arr.start).toEqual({ x: 50, y: 842 - 500 });
      expect(arr.end).toEqual({ x: 150, y: 842 - 500 });
      expect(arr.headLength).toBe(DEFAULT_ARROW_HEAD_LENGTH);
      expect(arr.headAngle).toBe(DEFAULT_ARROW_HEAD_ANGLE);
    }
  });
});

describe('H05 invalid page and dimension guards', () => {
  const validPage = { number: 1, width: 612, height: 792 };

  it('rejects missing pages, invalid page sizes, and invalid source PDF bytes', async () => {
    expect(() => planPdfOverlays([], [])).toThrow(PdfExportError);
    expect(() => planPdfOverlays([{ width: 0, height: 792 }], [])).toThrow(PdfExportError);
    expect(() => planPdfOverlays([{ width: 612, height: -10 }], [])).toThrow(PdfExportError);
    expect(() => planPdfOverlays([{ width: Number.NaN, height: 792 }], [])).toThrow(PdfExportError);
    expect(() =>
      planPdfOverlays(
        [
          { number: 1, width: 612, height: 792 },
          { number: 1, width: 612, height: 792 },
        ],
        [],
      ),
    ).toThrow(PdfExportError);

    await expect(composePdfOverlays({ overlays: [] })).rejects.toThrow(PdfExportError);
    await expect(
      composePdfOverlays({ pdfBytes: new Uint8Array([1, 2, 3]), overlays: [] }),
    ).rejects.toThrow(PdfExportError);
  });

  it('rejects overlays targeting nonexistent or non-positive page numbers', () => {
    for (const badPage of [0, -1, 1.5, 2, Number.NaN]) {
      expect(() =>
        planPdfOverlays([validPage], [
          {
            kind: 'rect',
            page: badPage,
            rect: { x: 10, y: 10, width: 50, height: 50 },
          },
        ]),
      ).toThrow(PdfExportError);
    }
  });

  it('rejects non-positive rect dimensions, invalid padding, out-of-range opacity, empty images, and degenerate arrows', () => {
    expect(() =>
      planPdfOverlays([validPage], [
        { kind: 'textbox', page: 1, rect: { x: 10, y: 10, width: 0, height: 30 }, text: 'hi' },
      ]),
    ).toThrow(PdfExportError);

    expect(() =>
      planPdfOverlays([validPage], [
        { kind: 'ellipse', page: 1, rect: { x: 10, y: 10, width: 40, height: -5 } },
      ]),
    ).toThrow(PdfExportError);

    expect(() =>
      planPdfOverlays([validPage], [
        {
          kind: 'callout',
          page: 1,
          rect: { x: 10, y: 10, width: 20, height: 20 },
          padding: 10,
          text: 'tight',
        },
      ]),
    ).toThrow(PdfExportError);

    expect(() =>
      planPdfOverlays([validPage], [
        {
          kind: 'watermark',
          page: 1,
          text: 'CONFIDENTIAL',
          opacity: 1.5,
        },
      ]),
    ).toThrow(PdfExportError);

    expect(() =>
      planPdfOverlays([validPage], [
        {
          kind: 'watermark',
          page: 1,
          text: 'CONFIDENTIAL',
          opacity: -0.1,
        },
      ]),
    ).toThrow(PdfExportError);

    expect(() =>
      planPdfOverlays([validPage], [
        {
          kind: 'image',
          page: 1,
          rect: { x: 10, y: 10, width: 50, height: 50 },
          format: 'png',
          bytes: new Uint8Array(0),
        },
      ]),
    ).toThrow(PdfExportError);

    expect(() =>
      computeArrowGeometry({ x: 100, y: 100 }, { x: 100, y: 100 }),
    ).toThrow(PdfExportError);

    expect(() =>
      planPdfOverlays([validPage], [
        {
          kind: 'arrow',
          page: 1,
          start: { x: 40, y: 40 },
          end: { x: 40, y: 40 },
        },
      ]),
    ).toThrow(PdfExportError);
  });
});

describe('H05 PDF overlay composer round-trip (pdf-lib + pdfjs-dist + Noto Sans)', () => {
  it('inserts Unicode text box, bordered callout, PNG & JPEG images, shapes, and watermark with exact coordinates', async () => {
    const pngBytes = solidPng(4, 3);
    const jpegBytes = minimalJpeg();

    const overlays: PdfOverlay[] = [
      {
        kind: 'textbox',
        id: 'note-vi',
        page: 1,
        rect: { x: 72, y: 80, width: 280, height: 48 },
        text: 'Ghi chú tiếng Việt — 100% chính xác',
        fontSize: 12,
        color: '#1e293b',
        backgroundColor: '#f8fafc',
        borderColor: '#94a3b8',
        borderWidth: 1,
      },
      {
        kind: 'callout',
        id: 'callout-1',
        page: 1,
        rect: { x: 360, y: 120, width: 200, height: 64 },
        text: 'Cảnh báo: kiểm tra tọa độ',
        fontSize: 11,
        backgroundColor: '#fef3c7',
        borderColor: '#b45309',
        borderWidth: 2,
        padding: 8,
        pointer: { x: 280, y: 240 },
        pointerArrow: true,
      },
      {
        kind: 'image',
        id: 'logo-png',
        page: 1,
        rect: { x: 72, y: 200, width: 96, height: 64 },
        format: 'png',
        bytes: pngBytes,
      },
      {
        kind: 'image',
        id: 'photo-jpg',
        page: 1,
        rect: { x: 200, y: 200, width: 80, height: 60 },
        format: 'jpeg',
        bytes: jpegBytes,
      },
      {
        kind: 'rect',
        id: 'box-shape',
        page: 1,
        rect: { x: 72, y: 320, width: 150, height: 50 },
        fillColor: '#dbeafe',
        strokeColor: '#1d4ed8',
        strokeWidth: 2,
      },
      {
        kind: 'ellipse',
        id: 'oval-shape',
        page: 1,
        rect: { x: 260, y: 320, width: 120, height: 60 },
        fillColor: '#dcfce7',
        strokeColor: '#15803d',
        strokeWidth: 1.5,
      },
      {
        kind: 'line',
        id: 'divider-line',
        page: 1,
        start: { x: 72, y: 420 },
        end: { x: 540, y: 420 },
        strokeColor: '#334155',
        strokeWidth: 1.5,
      },
      {
        kind: 'arrow',
        id: 'pointer-arrow',
        page: 1,
        start: { x: 100, y: 500 },
        end: { x: 240, y: 500 },
        strokeColor: '#dc2626',
        strokeWidth: 2,
        headLength: 12,
        headAngle: 30,
      },
      {
        kind: 'watermark',
        id: 'wm-draft',
        page: 1,
        text: 'BẢN NHÁP — KHÔNG PHÁT HÀNH',
        fontSize: 32,
        opacity: 0.25,
        angle: -45,
        color: '#475569',
      },
    ];

    const result = await composePdfOverlays({
      pages: [{ number: 1, width: 612, height: 792 }],
      overlays,
      fonts: { bytes: FONT_BYTES },
      title: 'H05 Overlay Test',
    });

    expect(String.fromCharCode(...result.bytes.subarray(0, 5))).toBe('%PDF-');
    expect(result.pageCount).toBe(1);
    expect(result.appliedCount).toBe(9);
    expect(result.fontName).toBe(BUNDLED_FONT_NAME);
    expect(result.limitations).toEqual([]);
    expect(result.skipped).toEqual([]);

    // Reload with pdf-lib and inspect structure, XObjects, ExtGState, and content stream.
    const reloaded = await PDFDocument.load(result.bytes);
    expect(reloaded.getPageCount()).toBe(1);
    expect(reloaded.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(reloaded.getTitle()).toBe('H05 Overlay Test');

    const images = pageImageXObjects(reloaded, 0);
    expect(images).toHaveLength(2);
    expect(images).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ width: 4, height: 3, filter: '/FlateDecode' }),
        expect.objectContaining({ width: 1, height: 1, filter: '/DCTDecode' }),
      ]),
    );

    const extGStates = pageExtGStates(reloaded, 0);
    expect(extGStates.some(gs => gs.ca !== undefined && Math.abs(gs.ca - 0.25) < 0.001)).toBe(true);

    const stream = pageContentStream(reloaded, 0);
    // PNG image placement at PDF (72, 792 - 200 - 64 = 528) with size (96, 64)
    expect(stream).toContain('72 528 translate');
    expect(stream).toContain('96 64 scale');
    // JPEG image placement at PDF (200, 792 - 200 - 60 = 532) with size (80, 60)
    expect(stream).toContain('200 532 translate');
    expect(stream).toContain('80 60 scale');
    // Divider line in PDF y-up: y = 792 - 420 = 372
    expect(stream).toContain('72 372 m');
    expect(stream).toContain('540 372 l');

    // Extract text & coordinates with pdfjs-dist.
    const pdfjs = await readWithPdfJs(result.bytes);
    expect(pdfjs.numPages).toBe(1);
    expect(pdfjs.pageTexts[0]).toContain('Ghi chú tiếng Việt — 100% chính xác');
    expect(pdfjs.pageTexts[0]).toContain('Cảnh báo: kiểm tra tọa độ');
    expect(pdfjs.pageTexts[0]).toContain('BẢN NHÁP — KHÔNG PHÁT HÀNH');

    const tbItem = pdfjs.pageItems[0]!.find(item => item.str.includes('Ghi chú tiếng Việt'))!;
    expect(tbItem.x).toBeCloseTo(72, 1);
    expect(tbItem.y).toBeCloseTo(792 - 80 - 12 * DEFAULT_BASELINE_RATIO, 1);
    expect(tbItem.angleDeg).toBeCloseTo(0, 1);

    const calloutItem = pdfjs.pageItems[0]!.find(item => item.str.includes('Cảnh báo'))!;
    expect(calloutItem.x).toBeCloseTo(360 + 8, 1);
    expect(calloutItem.y).toBeCloseTo(792 - 120 - 8 - 11 * DEFAULT_BASELINE_RATIO, 1);

    const wmItem = pdfjs.pageItems[0]!.find(item => item.str.includes('BẢN NHÁP'))!;
    expect(wmItem.fontSize).toBeCloseTo(32, 1);
    expect(wmItem.angleDeg).toBeCloseTo(45, 1);
  });

  it('overlays onto an existing PDF without losing source pages or existing text', async () => {
    const before = await readWithPdfJs(EXISTING_SAMPLE_PDF);
    expect(before.numPages).toBeGreaterThanOrEqual(1);

    const result = await composePdfOverlays({
      pdfBytes: EXISTING_SAMPLE_PDF,
      overlays: [
        {
          kind: 'textbox',
          page: 1,
          rect: { x: 48, y: 32, width: 220, height: 28 },
          text: 'H05 stamped note',
          fontSize: 11,
          backgroundColor: '#fef08a',
          borderColor: '#ca8a04',
        },
        {
          kind: 'watermark',
          page: 1,
          text: 'REVIEWED',
          opacity: 0.2,
          angle: -30,
        },
      ],
      fonts: { bytes: FONT_BYTES },
    });

    const reloaded = await PDFDocument.load(result.bytes);
    expect(reloaded.getPageCount()).toBe(before.numPages);

    const after = await readWithPdfJs(result.bytes);
    expect(after.numPages).toBe(before.numPages);
    expect(after.pageSizes).toEqual(before.pageSizes);
    expect(after.pageTexts[0]).toContain('H05 stamped note');
    expect(after.pageTexts[0]).toContain('REVIEWED');
    if (before.pageTexts[0]!.trim().length > 0) {
      expect(after.pageTexts[0]).toContain(before.pageTexts[0]!.trim().slice(0, 20));
    }
  });

  it('falls back cleanly to WinAnsi when Noto Sans bytes are absent and reports FONT_LIMITATION', async () => {
    const result = await composePdfOverlays({
      pages: [{ number: 1, width: 400, height: 400 }],
      overlays: [
        {
          kind: 'textbox',
          page: 1,
          rect: { x: 24, y: 24, width: 300, height: 40 },
          text: 'Tiếng Việt — 2026',
          fontSize: 12,
        },
      ],
      fonts: { bytes: null },
    });

    expect(result.fontName).toBe(FALLBACK_FACE_NAME);
    expect(result.limitations).toContain(FONT_LIMITATION);

    const pdfjs = await readWithPdfJs(result.bytes);
    expect(pdfjs.pageTexts[0]).toContain('Tieng Viet - 2026');
  });
});
