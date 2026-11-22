import { readFileSync } from 'node:fs';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BIDI_LIMITATION,
  FONT_LIMITATION,
  UNICODE_GAP_LIMITATION,
  buildPdf,
  pagePlan,
  type PdfBlockSource,
  type PdfPageSource,
} from '../viewer/src/export/pdf';
import {
  BUNDLED_FONT_NAME,
  BUNDLED_FONT_URL,
  FALLBACK_FACE_NAME,
  loadBundledFontBytes,
  registerPdfFonts,
} from '../viewer/src/export/fonts';

/** The real bundled face, read from the repository the same way the browser fetches it. */
const FONT_BYTES = new Uint8Array(readFileSync(new URL('../viewer/public/fonts/NotoSans-Regular.ttf', import.meta.url)));
const OFL_TEXT = readFileSync(new URL('../viewer/public/fonts/OFL.txt', import.meta.url), 'utf8');

/** "Tiếng Việt — số 42": precomposed Vietnamese letters, an em dash and digits. */
const VIETNAMESE = 'Tiếng Việt — số 42';

const measure = (text: string, size: number): number => text.length * size * 0.5;

const block = (overrides: Partial<PdfBlockSource> & { id: string; text: string }): PdfBlockSource => ({
  rect: { x: 20, y: 20, width: 300, height: 40 },
  fontSize: 12,
  ...overrides,
});

const page = (overrides: Partial<PdfPageSource> & { width: number; height: number }): PdfPageSource => ({
  number: 1,
  ...overrides,
});

/** Extracts text per page with the project's own reader stack, so this checks the real round trip. */
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

/** Every font dictionary in the file whose subtype is Type0, i.e. one embedded composite face. */
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

/** Font resource references a page draws with, in the order pdf-lib wrote them. */
async function pageFontRefs(bytes: Uint8Array): Promise<string[][]> {
  const reloaded = await PDFDocument.load(bytes);
  return reloaded.getPages().map(target => {
    const fonts = target.node.Resources()?.lookup(PDFName.of('Font'), PDFDict);
    if (!fonts) return [];
    return fonts.keys().map(key => fonts.get(key)?.toString() ?? '');
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bundled font asset', () => {
  it('ships Noto Sans with the licence that makes it redistributable', () => {
    // A UI-facing font would be a different trade-off; this is deliberately a text face only.
    expect(FONT_BYTES.length).toBeGreaterThan(400_000);
    // TrueType outlines: sfnt version 1.0, then a table directory. A JPEG or an HTML error page would
    // not start like this, so the file cannot silently be a failed download.
    expect([...FONT_BYTES.subarray(0, 4)]).toEqual([0x00, 0x01, 0x00, 0x00]);
    expect(OFL_TEXT).toContain('SIL OPEN FONT LICENSE');
    expect(OFL_TEXT).toContain('Noto');
    console.info(`[pdf-fonts] bundled face: ${FONT_BYTES.length} bytes`);
  });
});

describe('registerPdfFonts', () => {
  it('answers coverage from the face instead of guessing', async () => {
    const fonts = await registerPdfFonts(await PDFDocument.create(), { bytes: FONT_BYTES });
    expect(fonts.unicode).toBe(true);
    expect(fonts.name).toBe(BUNDLED_FONT_NAME);
    // Vietnamese is the reason this lane exists; CJK is explicitly out of scope for Noto Sans Latin.
    expect(fonts.canRepresent(VIETNAMESE)).toBe(true);
    expect(fonts.canRepresent('中文')).toBe(false);
    expect(fonts.canRepresent('Plain ASCII 2026')).toBe(true);
    // Text the face can draw is passed through untouched: no folding, nothing dropped.
    expect(fonts.prepare(VIETNAMESE)).toEqual({ text: VIETNAMESE, changed: false, dropped: 0 });
  });

  it('drops only the characters the face lacks, keeping the diacritics around them', async () => {
    const fonts = await registerPdfFonts(await PDFDocument.create(), { bytes: FONT_BYTES });
    const prepared = fonts.prepare('Tiếng 中文 Việt');
    expect(prepared.text).toBe('Tiếng  Việt');
    expect(prepared.changed).toBe(true);
    expect(prepared.dropped).toBe(2);
  });

  it('removes invisible marks without losing the diacritics around them', async () => {
    const fonts = await registerPdfFonts(await PDFDocument.create(), { bytes: FONT_BYTES });
    // A zero-width space from text extraction is not a coverage gap: it is dropped, nothing else is.
    const prepared = fonts.prepare('Tiếng\u200b Việt');
    expect(prepared.text).toBe('Tiếng Việt');
    expect(prepared.dropped).toBe(0);
    expect(fonts.canRepresent('Tiếng\u200b Việt')).toBe(true);
  });

  it('embeds one face per document and reuses it for every page', async () => {
    const doc = await PDFDocument.create();
    const first = registerPdfFonts(doc, { bytes: FONT_BYTES });
    const second = registerPdfFonts(doc, { bytes: FONT_BYTES });
    expect(second).toBe(first);
    const fonts = await first;
    const again = await second;
    expect(again.font).toBe(fonts.font);
  });

  it('falls back to WinAnsi instead of throwing when the bytes are not a font', async () => {
    const fonts = await registerPdfFonts(await PDFDocument.create(), { bytes: new Uint8Array([1, 2, 3, 4]) });
    expect(fonts.unicode).toBe(false);
    expect(fonts.name).toBe(FALLBACK_FACE_NAME);
    expect(fonts.canRepresent(VIETNAMESE)).toBe(false);
    expect(fonts.prepare(VIETNAMESE).text).toBe('Tieng Viet - so 42');
  });

  it('honours an explicit request to skip the Unicode face', async () => {
    const fonts = await registerPdfFonts(await PDFDocument.create(), { bytes: null });
    expect(fonts.unicode).toBe(false);
    expect(fonts.canRepresent('Plain ASCII')).toBe(true);
  });

  it('resolves the bundled URL against the document so a sub-path build still finds it', async () => {
    const requested: string[] = [];
    vi.stubGlobal('document', { baseURI: 'https://reader.test/mirror/index.html' });
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url);
      return new Response(FONT_BYTES, { status: 200 });
    });
    const bytes = await loadBundledFontBytes(BUNDLED_FONT_URL);
    expect(bytes?.length).toBe(FONT_BYTES.length);
    expect(requested).toEqual(['https://reader.test/mirror/fonts/NotoSans-Regular.ttf']);
  });

  it('fetches an asset once and caches the answer, including failures', async () => {
    const fetchMock = vi.fn(async () => new Response(FONT_BYTES, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const first = await loadBundledFontBytes('https://assets.test/fonts/once.ttf');
    const second = await loadBundledFontBytes('https://assets.test/fonts/once.ttf');
    expect(first?.length).toBe(FONT_BYTES.length);
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A missing or unreachable asset resolves to null: the export folds instead of failing.
    vi.stubGlobal('fetch', async () => new Response('missing', { status: 404 }));
    expect(await loadBundledFontBytes('https://assets.test/fonts/missing.ttf')).toBeNull();
    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    expect(await loadBundledFontBytes('https://assets.test/fonts/offline.ttf')).toBeNull();
  });

  it('plans Vietnamese runs without folding when the face can draw them', async () => {
    const fonts = await registerPdfFonts(await PDFDocument.create(), { bytes: FONT_BYTES });
    const plan = pagePlan(page({
      width: 612,
      height: 792,
      blocks: [block({ id: 'a', text: VIETNAMESE, rect: { x: 72, y: 100, width: 468, height: 40 } })],
    }), { measure, prepare: fonts.prepare });
    const planned = plan.blocks[0]!;
    expect(planned.folded).toBe(false);
    expect(planned.dropped).toBe(0);
    expect(planned.runs.map(run => run.text).join(' ')).toBe(VIETNAMESE);
  });
});

describe('buildPdf with the Unicode face', () => {
  it('writes Vietnamese diacritics into the extracted text', async () => {
    const result = await buildPdf([page({
      width: 612,
      height: 792,
      blocks: [block({ id: 'a', text: VIETNAMESE, rect: { x: 72, y: 100, width: 468, height: 40 } })],
    })], { fonts: { bytes: FONT_BYTES } });

    expect(result.fontName).toBe(BUNDLED_FONT_NAME);
    // No folding note and no coverage note: the document needed nothing beyond the face it got.
    expect(result.limitations).toContain('Page 1: the source page image is not embedded; its original appearance is not preserved.');
    expect(result.limitations).not.toContain(FONT_LIMITATION);
    expect(result.limitations).not.toContain(UNICODE_GAP_LIMITATION);

    const text = await extractText(result.bytes);
    const extracted = text[0] ?? '';
    // The exact string, precomposed letters and em dash included, not "Tien Viet".
    expect(extracted).toContain(VIETNAMESE);
    expect(extracted).not.toContain('Tien Viet');
    expect(extracted).toContain('42');
    console.info(`[pdf-fonts] extracted text: ${JSON.stringify(extracted)}`);
    console.info(`[pdf-fonts] PDF size: ${result.bytes.length} bytes`);
  });

  it('embeds the face once even when two pages are drawn', async () => {
    const result = await buildPdf([
      page({
        number: 1,
        width: 612,
        height: 792,
        blocks: [block({ id: 'a', text: VIETNAMESE, rect: { x: 72, y: 100, width: 468, height: 40 } })],
      }),
      page({
        number: 2,
        width: 612,
        height: 792,
        blocks: [block({ id: 'b', text: 'Bản dịch trang hai', rect: { x: 72, y: 100, width: 468, height: 40 } })],
      }),
    ], { fonts: { bytes: FONT_BYTES } });

    expect(await type0Fonts(result.bytes)).toHaveLength(1);
    const refs = await pageFontRefs(result.bytes);
    expect(refs[0]).toHaveLength(1);
    expect(refs[1]).toEqual(refs[0]);

    // One subset still covers both pages: the second page's text comes back with its own diacritics.
    const text = await extractText(result.bytes);
    expect(text[0]).toContain(VIETNAMESE);
    expect(text[1]).toContain('Bản dịch trang hai');
  });

  it('reports a glyph gap instead of drawing tofu, and keeps drawing the rest', async () => {
    const result = await buildPdf([page({
      width: 612,
      height: 792,
      blocks: [
        block({ id: 'cjk', text: '中文', rect: { x: 72, y: 200, width: 468, height: 40 } }),
        block({ id: 'mixed', text: 'Tiếng 中文 Việt', rect: { x: 72, y: 100, width: 468, height: 40 } }),
        block({ id: 'vietnamese', text: VIETNAMESE, rect: { x: 72, y: 40, width: 468, height: 30 } }),
      ],
    })], { fonts: { bytes: FONT_BYTES } });

    expect(result.blockCount).toBe(2);
    expect(result.skipped).toEqual([{ id: 'cjk', reason: 'unrepresentable' }]);
    expect(result.limitations).toContain(UNICODE_GAP_LIMITATION);
    expect(result.limitations).not.toContain(FONT_LIMITATION);

    const text = (await extractText(result.bytes))[0] ?? '';
    expect(text).not.toContain('中');
    // Unsupported characters are removed per character, and the layout then collapses the gap, so
    // the Vietnamese around them survives instead of the whole block being folded. Two occurrences:
    // the mixed block and the Vietnamese-only block both kept their diacritics.
    expect(text.match(/Tiếng Việt/g)).toHaveLength(2);
    expect(text).toContain(VIETNAMESE);
  });

  it('folds only when the face is unavailable, and never throws', async () => {
    const pages = [page({
      width: 400,
      height: 300,
      blocks: [block({ id: 'a', text: VIETNAMESE, rect: { x: 20, y: 20, width: 300, height: 40 } })],
    })];

    const disabled = await buildPdf(pages, { fonts: { bytes: null } });
    expect(disabled.fontName).toBe(FALLBACK_FACE_NAME);
    expect(disabled.limitations).toContain(FONT_LIMITATION);
    expect((await extractText(disabled.bytes))[0]).toContain('Tieng Viet - so 42');

    // A broken asset follows the same path: a valid PDF and an explicit limitation, never a throw.
    const broken = await buildPdf(pages, { fonts: { bytes: new Uint8Array([0xde, 0xad]) } });
    expect(broken.fontName).toBe(FALLBACK_FACE_NAME);
    expect(broken.limitations).toContain(FONT_LIMITATION);
    expect((await extractText(broken.bytes))[0]).toContain('Tieng Viet - so 42');
  });

  it('loads the bundled face by default, which is the path the reader takes', async () => {
    const requested: string[] = [];
    vi.stubGlobal('document', { baseURI: 'https://reader.test/default/index.html' });
    vi.stubGlobal('fetch', async (url: string) => {
      requested.push(url);
      return new Response(FONT_BYTES, { status: 200 });
    });
    // No `fonts` option at all: the same call the export button makes.
    const result = await buildPdf([page({
      width: 612,
      height: 792,
      blocks: [block({ id: 'a', text: VIETNAMESE, rect: { x: 72, y: 100, width: 468, height: 40 } })],
    })]);

    expect(requested).toEqual(['https://reader.test/default/fonts/NotoSans-Regular.ttf']);
    expect(result.fontName).toBe(BUNDLED_FONT_NAME);
    expect(result.limitations).toEqual(['Page 1: the source page image is not embedded; its original appearance is not preserved.']);
    expect((await extractText(result.bytes))[0]).toContain(VIETNAMESE);
  });

  it('keeps the RTL limitation and drops the folding note for Vietnamese', async () => {
    const result = await buildPdf([page({
      width: 612,
      height: 792,
      blocks: [block({ id: 'a', text: VIETNAMESE, direction: 'rtl', rect: { x: 72, y: 100, width: 468, height: 40 } })],
    })], { fonts: { bytes: FONT_BYTES } });
    // Exactly the limitation that is still true, and nothing that is not.
    expect(result.limitations).toEqual([
      'Page 1: the source page image is not embedded; its original appearance is not preserved.',
      BIDI_LIMITATION,
    ]);
  });
});
