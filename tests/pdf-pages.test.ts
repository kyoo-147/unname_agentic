import { PDFDocument, StandardFonts, degrees, toDegrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { PdfExportError } from '../src/export/pdf';
import {
  PageThumbnailDeck,
  deletePages,
  extractPages,
  inspectPdfPages,
  mergePdfs,
  normalizePageRotation,
  reorderPages,
  rotatePages,
  splitPdf,
  type PageThumbnail,
  type ThumbnailDeckSnapshot,
} from '../src/export/pdf-pages';

interface FixturePageSpec {
  text: string;
  width?: number;
  height?: number;
  rotation?: number;
}

async function makeFixturePdf(specs: readonly FixturePageSpec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const spec of specs) {
    const width = spec.width ?? 612;
    const height = spec.height ?? 792;
    const page = doc.addPage([width, height]);
    page.drawText(spec.text, {
      x: 48,
      y: height - 72,
      size: 14,
      font,
    });
    if (spec.rotation !== undefined) {
      page.setRotation(degrees(spec.rotation));
    }
  }
  return doc.save();
}

interface ParsedPageInfo {
  pageNumber: number;
  baseWidth: number;
  baseHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  pdfLibRotation: number;
  pdfJsRotation: number;
  text: string;
}

interface RoundTripReport {
  pageCount: number;
  pages: ParsedPageInfo[];
}

async function inspectRoundTrip(bytes: Uint8Array): Promise<RoundTripReport> {
  expect(String.fromCharCode(...bytes.subarray(0, 5))).toBe('%PDF-');
  expect(new TextDecoder().decode(bytes.subarray(-32))).toContain('%%EOF');

  const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
  const task = getDocument({
    data: bytes.slice(),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const pdfJsDoc = await task.promise;

  try {
    expect(pdfJsDoc.numPages).toBe(reloaded.getPageCount());
    const pages: ParsedPageInfo[] = [];

    for (let index = 0; index < pdfJsDoc.numPages; index++) {
      const pdfLibPage = reloaded.getPage(index);
      const size = pdfLibPage.getSize();
      const pdfLibRotation = ((Math.round(toDegrees(pdfLibPage.getRotation())) % 360) + 360) % 360;

      const pdfJsPage = await pdfJsDoc.getPage(index + 1);
      const viewport = pdfJsPage.getViewport({ scale: 1 });
      const content = await pdfJsPage.getTextContent();
      const text = content.items
        .map(item => ('str' in item ? item.str : ''))
        .join('')
        .trim();

      pages.push({
        pageNumber: index + 1,
        baseWidth: size.width,
        baseHeight: size.height,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        pdfLibRotation,
        pdfJsRotation: pdfJsPage.rotate,
        text,
      });
    }

    return {
      pageCount: pdfJsDoc.numPages,
      pages,
    };
  } finally {
    await task.destroy();
  }
}

function assertContiguousThumbnails(thumbnails: readonly PageThumbnail[]): void {
  thumbnails.forEach((thumb, idx) => {
    expect(thumb.index).toBe(idx);
    expect(thumb.pageNumber).toBe(idx + 1);
  });
}

describe('normalizePageRotation', () => {
  it('normalizes positive and negative multiples of 90 into 0 | 90 | 180 | 270', () => {
    expect(normalizePageRotation(0)).toBe(0);
    expect(normalizePageRotation(-0)).toBe(0);
    expect(normalizePageRotation(90)).toBe(90);
    expect(normalizePageRotation(180)).toBe(180);
    expect(normalizePageRotation(270)).toBe(270);
    expect(normalizePageRotation(360)).toBe(0);
    expect(normalizePageRotation(450)).toBe(90);
    expect(normalizePageRotation(-90)).toBe(270);
    expect(normalizePageRotation(-180)).toBe(180);
    expect(normalizePageRotation(-270)).toBe(90);
  });

  it('rejects non-90 multiples and non-finite angles with PdfExportError', () => {
    expect(() => normalizePageRotation(45)).toThrow(PdfExportError);
    expect(() => normalizePageRotation(91)).toThrow(PdfExportError);
    expect(() => normalizePageRotation(Number.NaN)).toThrow(PdfExportError);
    expect(() => normalizePageRotation(Number.POSITIVE_INFINITY)).toThrow(PdfExportError);
  });
});

describe('splitPdf', () => {
  it('splits a PDF by explicit page ranges and preserves page dimensions, text, and rotations', async () => {
    const source = await makeFixturePdf([
      { text: 'DOC-P1', width: 612, height: 792 },
      { text: 'DOC-P2', width: 595, height: 842, rotation: 90 },
      { text: 'DOC-P3', width: 500, height: 700 },
      { text: 'DOC-P4', width: 400, height: 600, rotation: 180 },
    ]);

    const result = await splitPdf(source, {
      ranges: ['1-2', [4, 3]],
    });

    expect(result.sourcePageCount).toBe(4);
    expect(result.chunks).toHaveLength(2);

    const chunk0 = result.chunks[0]!;
    expect(chunk0.chunkIndex).toBe(0);
    expect(chunk0.sourcePages).toEqual([1, 2]);
    expect(chunk0.pageCount).toBe(2);

    const report0 = await inspectRoundTrip(chunk0.bytes);
    expect(report0.pageCount).toBe(2);
    expect(report0.pages.map(p => p.text)).toEqual(['DOC-P1', 'DOC-P2']);
    expect(report0.pages[0]!).toMatchObject({
      baseWidth: 612,
      baseHeight: 792,
      viewportWidth: 612,
      viewportHeight: 792,
      pdfLibRotation: 0,
      pdfJsRotation: 0,
    });
    expect(report0.pages[1]!).toMatchObject({
      baseWidth: 595,
      baseHeight: 842,
      viewportWidth: 842,
      viewportHeight: 595,
      pdfLibRotation: 90,
      pdfJsRotation: 90,
    });

    const chunk1 = result.chunks[1]!;
    expect(chunk1.chunkIndex).toBe(1);
    expect(chunk1.sourcePages).toEqual([4, 3]);
    expect(chunk1.pageCount).toBe(2);

    const report1 = await inspectRoundTrip(chunk1.bytes);
    expect(report1.pageCount).toBe(2);
    expect(report1.pages.map(p => p.text)).toEqual(['DOC-P4', 'DOC-P3']);
    expect(report1.pages[0]!).toMatchObject({
      baseWidth: 400,
      baseHeight: 600,
      pdfLibRotation: 180,
      pdfJsRotation: 180,
    });
    expect(report1.pages[1]!).toMatchObject({
      baseWidth: 500,
      baseHeight: 700,
      pdfLibRotation: 0,
      pdfJsRotation: 0,
    });
  });

  it('splits a PDF by fixed chunk size including a trailing partial chunk', async () => {
    const source = await makeFixturePdf([
      { text: 'CHUNK-1' },
      { text: 'CHUNK-2' },
      { text: 'CHUNK-3' },
      { text: 'CHUNK-4' },
      { text: 'CHUNK-5' },
    ]);

    const result = await splitPdf(source, { chunkSize: 2 });

    expect(result.sourcePageCount).toBe(5);
    expect(result.chunks).toHaveLength(3);
    expect(result.chunks.map(c => c.sourcePages)).toEqual([[1, 2], [3, 4], [5]]);

    const texts = await Promise.all(
      result.chunks.map(async chunk => {
        const parsed = await inspectRoundTrip(chunk.bytes);
        return parsed.pages.map(p => p.text);
      }),
    );
    expect(texts).toEqual([['CHUNK-1', 'CHUNK-2'], ['CHUNK-3', 'CHUNK-4'], ['CHUNK-5']]);
  });
});

describe('mergePdfs', () => {
  it('merges 2+ PDFs preserving page order, distinct dimensions, and existing rotations', async () => {
    const docA = await makeFixturePdf([
      { text: 'A-1', width: 612, height: 792 },
      { text: 'A-2', width: 612, height: 792, rotation: 90 },
    ]);
    const docB = await makeFixturePdf([
      { text: 'B-1', width: 595, height: 842 },
    ]);
    const docC = await makeFixturePdf([
      { text: 'C-1', width: 842, height: 595, rotation: 270 },
    ]);

    const merged = await mergePdfs([docA, docB, docC]);

    expect(merged.pageCount).toBe(4);
    expect(merged.pages.map(p => ({ doc: p.sourceDocIndex, src: p.sourcePageNumber, num: p.pageNumber }))).toEqual([
      { doc: 0, src: 1, num: 1 },
      { doc: 0, src: 2, num: 2 },
      { doc: 1, src: 1, num: 3 },
      { doc: 2, src: 1, num: 4 },
    ]);

    const report = await inspectRoundTrip(merged.bytes);
    expect(report.pageCount).toBe(4);
    expect(report.pages.map(p => p.text)).toEqual(['A-1', 'A-2', 'B-1', 'C-1']);
    expect(report.pages[0]!).toMatchObject({ baseWidth: 612, baseHeight: 792, pdfJsRotation: 0 });
    expect(report.pages[1]!).toMatchObject({ baseWidth: 612, baseHeight: 792, viewportWidth: 792, viewportHeight: 612, pdfJsRotation: 90 });
    expect(report.pages[2]!).toMatchObject({ baseWidth: 595, baseHeight: 842, pdfJsRotation: 0 });
    expect(report.pages[3]!).toMatchObject({ baseWidth: 842, baseHeight: 595, viewportWidth: 595, viewportHeight: 842, pdfJsRotation: 270 });
  });
});

describe('reorderPages', () => {
  it('reorders all pages according to the 1-based permutation and keeps original bytes immutable', async () => {
    const source = await makeFixturePdf([
      { text: 'ORDER-1', width: 400, height: 500 },
      { text: 'ORDER-2', width: 500, height: 600, rotation: 90 },
      { text: 'ORDER-3', width: 600, height: 700 },
      { text: 'ORDER-4', width: 700, height: 800, rotation: 180 },
    ]);
    const originalCopy = source.slice();

    const reordered = await reorderPages(source, [3, 1, 4, 2]);
    expect(source).toEqual(originalCopy);
    expect(reordered.pageCount).toBe(4);
    expect(reordered.pages.map(p => p.sourcePageNumber)).toEqual([3, 1, 4, 2]);
    expect(reordered.pages.map(p => p.pageNumber)).toEqual([1, 2, 3, 4]);

    const report = await inspectRoundTrip(reordered.bytes);
    expect(report.pageCount).toBe(4);
    expect(report.pages.map(p => p.text)).toEqual(['ORDER-3', 'ORDER-1', 'ORDER-4', 'ORDER-2']);
    expect(report.pages.map(p => [p.baseWidth, p.baseHeight, p.pdfJsRotation])).toEqual([
      [600, 700, 0],
      [400, 500, 0],
      [700, 800, 180],
      [500, 600, 90],
    ]);
  });
});

describe('rotatePages', () => {
  it('applies 90/180/270 cumulative normalization across repeated rotations and negative deltas', async () => {
    const source = await makeFixturePdf([
      { text: 'ROT-1', width: 612, height: 792 },
      { text: 'ROT-2', width: 595, height: 842, rotation: 90 },
      { text: 'ROT-3', width: 500, height: 700, rotation: 270 },
    ]);

    const step1 = await rotatePages(source, { pages: [1, 2], angle: 90 });
    expect(step1.pages.map(p => p.rotation)).toEqual([90, 180, 270]);

    const step2 = await rotatePages(step1.bytes, { pages: [2, 3], angle: 180 });
    // page 2: 180 + 180 = 360 -> 0; page 3: 270 + 180 = 450 -> 90
    expect(step2.pages.map(p => p.rotation)).toEqual([90, 0, 90]);

    const step3 = await rotatePages(step2.bytes, { pages: '1', angle: -90 });
    // page 1: 90 - 90 = 0
    expect(step3.pages.map(p => p.rotation)).toEqual([0, 0, 90]);

    const step4 = await rotatePages(step3.bytes, { pages: [1, 2], angle: 270 });
    expect(step4.pages.map(p => p.rotation)).toEqual([270, 270, 90]);

    const report = await inspectRoundTrip(step4.bytes);
    expect(report.pageCount).toBe(3);
    expect(report.pages.map(p => p.text)).toEqual(['ROT-1', 'ROT-2', 'ROT-3']);
    expect(report.pages.map(p => p.pdfLibRotation)).toEqual([270, 270, 90]);
    expect(report.pages.map(p => p.pdfJsRotation)).toEqual([270, 270, 90]);
    expect(report.pages[0]!).toMatchObject({ viewportWidth: 792, viewportHeight: 612 });
    expect(report.pages[1]!).toMatchObject({ viewportWidth: 842, viewportHeight: 595 });
    expect(report.pages[2]!).toMatchObject({ viewportWidth: 700, viewportHeight: 500 });
  });

  it('supports absolute rotation mode and defaults to rotating all pages when pages is omitted', async () => {
    const source = await makeFixturePdf([
      { text: 'ABS-1', rotation: 90 },
      { text: 'ABS-2', rotation: 270 },
    ]);

    const abs = await rotatePages(source, { angle: 180, mode: 'absolute' });
    expect(abs.pages.map(p => p.rotation)).toEqual([180, 180]);

    const report = await inspectRoundTrip(abs.bytes);
    expect(report.pages.map(p => p.pdfJsRotation)).toEqual([180, 180]);
  });
});

describe('deletePages and extractPages', () => {
  it('deletes specified pages and preserves order, dimensions, and text of surviving pages', async () => {
    const source = await makeFixturePdf([
      { text: 'KEEP-1', width: 612, height: 792 },
      { text: 'DROP-2', width: 500, height: 500 },
      { text: 'KEEP-3', width: 595, height: 842, rotation: 180 },
      { text: 'DROP-4', width: 400, height: 400 },
      { text: 'KEEP-5', width: 700, height: 900 },
    ]);

    const deleted = await deletePages(source, '2, 4');
    expect(deleted.pageCount).toBe(3);
    expect(deleted.pages.map(p => p.pageNumber)).toEqual([1, 2, 3]);
    expect(deleted.pages.map(p => p.sourcePageNumber)).toEqual([1, 3, 5]);

    const report = await inspectRoundTrip(deleted.bytes);
    expect(report.pageCount).toBe(3);
    expect(report.pages.map(p => p.text)).toEqual(['KEEP-1', 'KEEP-3', 'KEEP-5']);
    expect(report.pages[1]!).toMatchObject({ baseWidth: 595, baseHeight: 842, pdfJsRotation: 180 });
  });

  it('extracts specified pages in requested order and verifies via pdf-lib and pdfjs-dist', async () => {
    const source = await makeFixturePdf([
      { text: 'EX-1', width: 400, height: 600 },
      { text: 'EX-2', width: 500, height: 700, rotation: 90 },
      { text: 'EX-3', width: 612, height: 792 },
      { text: 'EX-4', width: 595, height: 842, rotation: 270 },
    ]);

    const extracted = await extractPages(source, [4, 2]);
    expect(extracted.pageCount).toBe(2);
    expect(extracted.pages.map(p => p.sourcePageNumber)).toEqual([4, 2]);

    const report = await inspectRoundTrip(extracted.bytes);
    expect(report.pageCount).toBe(2);
    expect(report.pages.map(p => p.text)).toEqual(['EX-4', 'EX-2']);
    expect(report.pages[0]!).toMatchObject({ viewportWidth: 842, viewportHeight: 595, pdfJsRotation: 270 });
    expect(report.pages[1]!).toMatchObject({ viewportWidth: 700, viewportHeight: 500, pdfJsRotation: 90 });
  });
});

describe('invalid page and empty-result guards', () => {
  it('rejects empty or malformed PDF bytes with PdfExportError', async () => {
    await expect(inspectPdfPages(new Uint8Array())).rejects.toThrow(PdfExportError);
    await expect(inspectPdfPages(new TextEncoder().encode('not-a-pdf'))).rejects.toThrow(PdfExportError);
    await expect(extractPages(new Uint8Array(), '1')).rejects.toThrow(PdfExportError);
  });

  it('rejects invalid page indices, descending ranges, and empty results across all PDF operations', async () => {
    const threePages = await makeFixturePdf([
      { text: 'G-1' },
      { text: 'G-2' },
      { text: 'G-3' },
    ]);

    // splitPdf guards
    await expect(splitPdf(threePages, {})).rejects.toThrow(PdfExportError);
    await expect(splitPdf(threePages, { ranges: ['1'], chunkSize: 1 })).rejects.toThrow(PdfExportError);
    await expect(splitPdf(threePages, { ranges: [] })).rejects.toThrow(PdfExportError);
    await expect(splitPdf(threePages, { ranges: ['1-4'] })).rejects.toThrow(PdfExportError);
    await expect(splitPdf(threePages, { chunkSize: 0 })).rejects.toThrow(PdfExportError);
    await expect(splitPdf(threePages, { chunkSize: 1.5 })).rejects.toThrow(PdfExportError);

    // mergePdfs guards
    await expect(mergePdfs([])).rejects.toThrow(PdfExportError);
    await expect(mergePdfs([threePages])).rejects.toThrow(PdfExportError);
    await expect(mergePdfs([threePages, { bytes: threePages, pages: '9' }])).rejects.toThrow(PdfExportError);
    await expect(mergePdfs([threePages, { bytes: threePages, pages: [] }])).rejects.toThrow(PdfExportError);

    // reorderPages guards
    await expect(reorderPages(threePages, [])).rejects.toThrow(PdfExportError);
    await expect(reorderPages(threePages, [1, 2])).rejects.toThrow(PdfExportError);
    await expect(reorderPages(threePages, [1, 1, 2])).rejects.toThrow(PdfExportError);
    await expect(reorderPages(threePages, [1, 2, 4])).rejects.toThrow(PdfExportError);
    await expect(reorderPages(threePages, [0, 1, 2])).rejects.toThrow(PdfExportError);

    // rotatePages guards
    await expect(rotatePages(threePages, { angle: 45 })).rejects.toThrow(PdfExportError);
    await expect(rotatePages(threePages, { pages: [], angle: 90 })).rejects.toThrow(PdfExportError);
    await expect(rotatePages(threePages, { pages: [4], angle: 90 })).rejects.toThrow(PdfExportError);

    // deletePages guards (including deleting all pages)
    await expect(deletePages(threePages, [])).rejects.toThrow(PdfExportError);
    await expect(deletePages(threePages, '4')).rejects.toThrow(PdfExportError);
    await expect(deletePages(threePages, '1-3')).rejects.toThrow(PdfExportError);

    // extractPages guards
    await expect(extractPages(threePages, '')).rejects.toThrow(PdfExportError);
    await expect(extractPages(threePages, [])).rejects.toThrow(PdfExportError);
    await expect(extractPages(threePages, '3-1')).rejects.toThrow(PdfExportError);
    await expect(extractPages(threePages, [1, 4])).rejects.toThrow(PdfExportError);
  });
});

describe('PageThumbnailDeck state manager and undo sync', () => {
  it('reflects every edit immediately with zero stale indices and supports undo/redo', async () => {
    const source = await makeFixturePdf([
      { text: 'DECK-1', width: 612, height: 792 },
      { text: 'DECK-2', width: 595, height: 842 },
      { text: 'DECK-3', width: 500, height: 700, rotation: 90 },
      { text: 'DECK-4', width: 400, height: 600 },
    ]);

    const deck = await PageThumbnailDeck.fromPdf(source);
    const events: ThumbnailDeckSnapshot[] = [];
    const unsubscribe = deck.subscribe(snapshot => events.push(snapshot));

    expect(deck.pageCount).toBe(4);
    expect(deck.canUndo).toBe(false);
    expect(deck.canRedo).toBe(false);
    assertContiguousThumbnails(deck.getThumbnails());
    expect(deck.getThumbnail(3)).toMatchObject({
      pageNumber: 3,
      index: 2,
      sourcePageNumber: 3,
      baseWidth: 500,
      baseHeight: 700,
      width: 700,
      height: 500,
      rotation: 90,
    });

    // Track active page and selection across delete and reorder: zero stale indices!
    deck.setActivePage(3);
    deck.selectPages([2, 3]);
    expect(deck.activePage).toBe(3);
    expect(deck.selectedPages).toEqual([2, 3]);

    // 1. Delete page 2 -> DECK-3 moves to pageNumber 2, index 1
    deck.delete([2]);
    expect(deck.pageCount).toBe(3);
    assertContiguousThumbnails(deck.getThumbnails());
    expect(deck.getThumbnails().map(t => t.sourcePageNumber)).toEqual([1, 3, 4]);
    expect(deck.activePage).toBe(2);
    expect(deck.selectedPages).toEqual([2]);
    expect(deck.canUndo).toBe(true);

    // 2. Rotate page 2 (DECK-3, currently 90) by 180 -> 270, and page 1 by 90 -> 90
    deck.rotate([1], 90);
    deck.rotate([2], 180);
    expect(deck.getThumbnail(1)).toMatchObject({ rotation: 90, width: 792, height: 612 });
    expect(deck.getThumbnail(2)).toMatchObject({ rotation: 270, width: 700, height: 500 });

    // 3. Reorder [3, 1, 2] -> sourcePageNumbers [4, 1, 3]
    deck.reorder([3, 1, 2]);
    assertContiguousThumbnails(deck.getThumbnails());
    expect(deck.getThumbnails().map(t => t.sourcePageNumber)).toEqual([4, 1, 3]);
    expect(deck.activePage).toBe(3);
    expect(deck.selectedPages).toEqual([3]);

    // 4. Undo reorder -> back to [1, 3, 4], activePage 2
    expect(deck.undo()).toBe(true);
    assertContiguousThumbnails(deck.getThumbnails());
    expect(deck.getThumbnails().map(t => t.sourcePageNumber)).toEqual([1, 3, 4]);
    expect(deck.activePage).toBe(2);
    expect(deck.canRedo).toBe(true);

    // 5. Redo reorder -> back to [4, 1, 3], activePage 3
    expect(deck.redo()).toBe(true);
    assertContiguousThumbnails(deck.getThumbnails());
    expect(deck.getThumbnails().map(t => t.sourcePageNumber)).toEqual([4, 1, 3]);
    expect(deck.activePage).toBe(3);
    expect(deck.canRedo).toBe(false);

    // 6. New edit clears redo stack after undo
    expect(deck.undo()).toBe(true);
    expect(deck.canRedo).toBe(true);
    deck.movePage(1, 3);
    expect(deck.canRedo).toBe(false);
    assertContiguousThumbnails(deck.getThumbnails());
    expect(deck.getThumbnails().map(t => t.sourcePageNumber)).toEqual([3, 4, 1]);

    // 7. Extract subset [2, 3]
    deck.extract([2, 3]);
    assertContiguousThumbnails(deck.getThumbnails());
    expect(deck.getThumbnails().map(t => t.sourcePageNumber)).toEqual([4, 1]);

    // 8. Subscribers received immediate snapshots on every change
    expect(events.length).toBeGreaterThanOrEqual(9);
    for (const snap of events) {
      assertContiguousThumbnails(snap.thumbnails);
      expect(snap.pageCount).toBe(snap.thumbnails.length);
    }

    unsubscribe();
  });

  it('guards against invalid deck mutations atomically without corrupting state or undo stack', () => {
    const deck = PageThumbnailDeck.fromPages([
      { width: 612, height: 792 },
      { width: 595, height: 842 },
    ]);

    expect(() => PageThumbnailDeck.fromPages([])).toThrow(PdfExportError);
    expect(() => deck.delete('1-2')).toThrow(PdfExportError);
    expect(() => deck.rotate([1], 45)).toThrow(PdfExportError);
    expect(() => deck.reorder([1, 1])).toThrow(PdfExportError);
    expect(() => deck.movePage(1, 3)).toThrow(PdfExportError);
    expect(() => deck.extract([])).toThrow(PdfExportError);
    expect(() => deck.merge([])).toThrow(PdfExportError);
    expect(() => deck.getThumbnail(0)).toThrow(PdfExportError);
    expect(() => deck.getThumbnail(3)).toThrow(PdfExportError);
    expect(() => deck.setActivePage(3)).toThrow(PdfExportError);
    expect(() => deck.selectPages([3])).toThrow(PdfExportError);

    expect(deck.pageCount).toBe(2);
    expect(deck.canUndo).toBe(false);
    expect(deck.undo()).toBe(false);
    expect(deck.redo()).toBe(false);
    assertContiguousThumbnails(deck.getThumbnails());
  });
});

describe('H07 expanded round-trip verification — multi-doc merge, cumulative rotations, and thumbnail parity', () => {
  it('merges selective page ranges from 3+ heterogeneous PDFs with mixed orientations and pre-existing rotations', async () => {
    const doc1 = await makeFixturePdf([
      { text: 'M1-P1', width: 612, height: 792, rotation: 0 },
      { text: 'M1-P2-SKIP', width: 612, height: 792 },
      { text: 'M1-P3', width: 420, height: 595, rotation: 90 },
    ]);
    const doc2 = await makeFixturePdf([
      { text: 'M2-P1', width: 595, height: 842, rotation: 180 },
      { text: 'M2-P2', width: 792, height: 612, rotation: 270 },
    ]);
    const doc3 = await makeFixturePdf([
      { text: 'M3-P1-SKIP', width: 500, height: 500 },
      { text: 'M3-P2', width: 842, height: 595, rotation: -90 },
    ]);

    const merged = await mergePdfs([
      { bytes: doc1, pages: '3, 1' },
      doc2,
      { bytes: doc3, pages: { start: 2, end: 2 } },
    ]);

    expect(merged.pageCount).toBe(5);
    expect(merged.pages.map(p => ({ doc: p.sourceDocIndex, src: p.sourcePageNumber, rot: p.rotation }))).toEqual([
      { doc: 0, src: 3, rot: 90 },
      { doc: 0, src: 1, rot: 0 },
      { doc: 1, src: 1, rot: 180 },
      { doc: 1, src: 2, rot: 270 },
      { doc: 2, src: 2, rot: 270 },
    ]);

    const report = await inspectRoundTrip(merged.bytes);
    expect(report.pageCount).toBe(5);
    expect(report.pages.map(p => p.text)).toEqual(['M1-P3', 'M1-P1', 'M2-P1', 'M2-P2', 'M3-P2']);
    expect(report.pages.map(p => p.pdfJsRotation)).toEqual([90, 0, 180, 270, 270]);
    expect(report.pages.map(p => p.pdfLibRotation)).toEqual([90, 0, 180, 270, 270]);
    expect(report.pages.map(p => [p.viewportWidth, p.viewportHeight])).toEqual([
      [595, 420],
      [612, 792],
      [595, 842],
      [612, 792],
      [595, 842],
    ]);
  });

  it('preserves cumulative rotation normalization across chained merge -> rotate -> reorder -> delete -> extract -> split', async () => {
    const docA = await makeFixturePdf([
      { text: 'CHAIN-A1', width: 612, height: 792 },
      { text: 'CHAIN-A2', width: 595, height: 842, rotation: 90 },
    ]);
    const docB = await makeFixturePdf([
      { text: 'CHAIN-B1', width: 500, height: 700, rotation: 180 },
      { text: 'CHAIN-B2', width: 400, height: 600, rotation: 270 },
    ]);

    // Step 1: merge -> [A1(0), A2(90), B1(180), B2(270)]
    const s1 = await mergePdfs([docA, docB]);
    // Step 2: rotate pages 2-3 by +90 -> [A1(0), A2(180), B1(270), B2(270)]
    const s2 = await rotatePages(s1.bytes, { pages: '2-3', angle: 90 });
    // Step 3: rotate pages 1,2 by +270 -> [A1(270), A2(90), B1(270), B2(270)]
    const s3 = await rotatePages(s2.bytes, { pages: [1, 2], angle: 270 });
    // Step 4: rotate pages 3,4 by -180 -> [A1(270), A2(90), B1(90), B2(90)]
    const s4 = await rotatePages(s3.bytes, { pages: [3, 4], angle: -180 });
    // Step 5: reorder [4, 2, 1, 3] -> [B2(90), A2(90), A1(270), B1(90)]
    const s5 = await reorderPages(s4.bytes, [4, 2, 1, 3]);
    // Step 6: delete page 2 (A2) -> [B2(90), A1(270), B1(90)]
    const s6 = await deletePages(s5.bytes, [2]);
    // Step 7: extract [3, 1, 2] -> [B1(90), B2(90), A1(270)]
    const s7 = await extractPages(s6.bytes, [3, 1, 2]);
    // Step 8: split chunkSize 2 -> [[B1(90), B2(90)], [A1(270)]]
    const s8 = await splitPdf(s7.bytes, { chunkSize: 2 });

    expect(s8.chunks).toHaveLength(2);

    const chunk0 = await inspectRoundTrip(s8.chunks[0]!.bytes);
    expect(chunk0.pages.map(p => ({ text: p.text, rot: p.pdfJsRotation, w: p.viewportWidth, h: p.viewportHeight }))).toEqual([
      { text: 'CHAIN-B1', rot: 90, w: 700, h: 500 },
      { text: 'CHAIN-B2', rot: 90, w: 600, h: 400 },
    ]);

    const chunk1 = await inspectRoundTrip(s8.chunks[1]!.bytes);
    expect(chunk1.pages.map(p => ({ text: p.text, rot: p.pdfJsRotation, w: p.viewportWidth, h: p.viewportHeight }))).toEqual([
      { text: 'CHAIN-A1', rot: 270, w: 792, h: 612 },
    ]);
  });

  it('maintains 1:1 parity between PageThumbnailDeck edits/splits and pdf-lib/pdfjs-dist PDF bytes', async () => {
    const pdfA = await makeFixturePdf([
      { text: 'PARITY-A1', width: 612, height: 792 },
      { text: 'PARITY-A2', width: 595, height: 842, rotation: 90 },
      { text: 'PARITY-A3', width: 500, height: 700 },
    ]);
    const pdfB = await makeFixturePdf([
      { text: 'PARITY-B1', width: 420, height: 595, rotation: 180 },
      { text: 'PARITY-B2', width: 400, height: 600 },
    ]);

    const deck = await PageThumbnailDeck.fromPdf(pdfA, 0);
    const deckB = await PageThumbnailDeck.fromPdf(pdfB, 0);

    // Merge deckB -> [A1, A2(90), A3, B1(180), B2]
    deck.merge(deckB);
    deck.selectPages('2, 4');
    deck.setActivePage(5);

    // Rotate pages 2, 3, 5 by +90, then page 2 by +180 (cumulative on A2: 90 + 90 + 180 = 360 -> 0)
    // Resulting rotations: [A1:0, A2:0, A3:90, B1:180, B2:90]
    deck.rotate([2, 3, 5], 90);
    deck.rotate([2], 180);

    // Move page 5 (B2) to position 1 -> [B2(90), A1(0), A2(0), A3(90), B1(180)]
    deck.movePage(5, 1);

    // Delete page 3 (A2), undo, redo -> [B2(90), A1(0), A3(90), B1(180)]
    deck.delete([3]);
    expect(deck.undo()).toBe(true);
    expect(deck.pageCount).toBe(5);
    expect(deck.redo()).toBe(true);
    expect(deck.pageCount).toBe(4);

    // Reorder [4, 2, 1, 3] -> [B1(180), A1(0), B2(90), A3(90)]
    deck.reorder([4, 2, 1, 3]);
    expect(deck.activePage).toBe(3); // B2 moved from 1 to 3
    expect(deck.selectedPages).toEqual([1]); // B1 moved from 4 to 1 (A2 was deleted)

    // Materialize deck to PDF bytes and compare directly with standalone operations
    const deckResult = await deck.exportPdf([pdfA, pdfB]);

    let ops = await mergePdfs([pdfA, pdfB]);
    ops = await rotatePages(ops.bytes, { pages: [2, 3, 5], angle: 90 });
    ops = await rotatePages(ops.bytes, { pages: [2], angle: 180 });
    ops = await reorderPages(ops.bytes, [5, 1, 2, 3, 4]);
    ops = await deletePages(ops.bytes, [3]);
    ops = await reorderPages(ops.bytes, [4, 2, 1, 3]);

    const deckReport = await inspectRoundTrip(deckResult.bytes);
    const opsReport = await inspectRoundTrip(ops.bytes);
    const thumbnails = deck.getThumbnails();

    expect(deckReport.pageCount).toBe(4);
    expect(opsReport.pageCount).toBe(4);
    expect(deckReport.pages.map(p => p.text)).toEqual(['PARITY-B1', 'PARITY-A1', 'PARITY-B2', 'PARITY-A3']);
    expect(opsReport.pages.map(p => p.text)).toEqual(deckReport.pages.map(p => p.text));

    thumbnails.forEach((thumb, idx) => {
      const deckPage = deckReport.pages[idx]!;
      const opsPage = opsReport.pages[idx]!;
      const resultMeta = deckResult.pages[idx]!;

      expect(thumb.pageNumber).toBe(idx + 1);
      expect(thumb.index).toBe(idx);
      expect(thumb.rotation).toBe(deckPage.pdfJsRotation);
      expect(thumb.rotation).toBe(deckPage.pdfLibRotation);
      expect(thumb.rotation).toBe(opsPage.pdfJsRotation);
      expect(thumb.width).toBe(deckPage.viewportWidth);
      expect(thumb.height).toBe(deckPage.viewportHeight);
      expect(thumb.width).toBe(opsPage.viewportWidth);
      expect(thumb.height).toBe(opsPage.viewportHeight);
      expect(thumb.baseWidth).toBe(deckPage.baseWidth);
      expect(thumb.baseHeight).toBe(deckPage.baseHeight);
      expect(resultMeta).toMatchObject({
        pageNumber: thumb.pageNumber,
        index: thumb.index,
        rotation: thumb.rotation,
        width: thumb.width,
        height: thumb.height,
        baseWidth: thumb.baseWidth,
        baseHeight: thumb.baseHeight,
      });
    });

    // Verify deck.split parity against splitPdf on exported bytes
    const deckChunks = deck.split({ chunkSize: 2 });
    const pdfChunks = await splitPdf(deckResult.bytes, { chunkSize: 2 });
    expect(deckChunks).toHaveLength(pdfChunks.chunks.length);

    for (let i = 0; i < deckChunks.length; i++) {
      const chunkBytes = await deckChunks[i]!.exportPdf([pdfA, pdfB]);
      const chunkReport = await inspectRoundTrip(chunkBytes.bytes);
      const splitReport = await inspectRoundTrip(pdfChunks.chunks[i]!.bytes);

      expect(chunkReport.pages).toEqual(splitReport.pages);
      expect(deckChunks[i]!.getThumbnails().map(t => ({
        pageNumber: t.pageNumber,
        rotation: t.rotation,
        width: t.width,
        height: t.height,
      }))).toEqual(
        splitReport.pages.map(p => ({
          pageNumber: p.pageNumber,
          rotation: p.pdfJsRotation,
          width: p.viewportWidth,
          height: p.viewportHeight,
        })),
      );
    }
  });

  it('clamps activePage safely when deleting the active last page and rejects missing exportPdf sources', async () => {
    const pdf = await makeFixturePdf([
      { text: 'LAST-1' },
      { text: 'LAST-2' },
      { text: 'LAST-3' },
    ]);

    const deck = await PageThumbnailDeck.fromPdf(pdf);
    deck.setActivePage(3);
    expect(deck.activePage).toBe(3);

    deck.delete([3]);
    expect(deck.pageCount).toBe(2);
    expect(deck.activePage).toBe(2);

    expect(deck.undo()).toBe(true);
    expect(deck.pageCount).toBe(3);
    expect(deck.activePage).toBe(3);

    await expect(deck.exportPdf([])).rejects.toThrow(PdfExportError);
    const mergedDeck = PageThumbnailDeck.fromPages([{ width: 612, height: 792 }]);
    deck.merge(mergedDeck);
    await expect(deck.exportPdf([pdf])).rejects.toThrow(PdfExportError);
  });
});
