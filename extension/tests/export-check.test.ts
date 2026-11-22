import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_SIZE_WARNING_BYTES,
  MIN_SOURCE_SENTENCE_CHARS,
  checkExport,
  extractPdfFacts,
  type ExportReport,
} from '../viewer/src/core/export-check';
import { registerPdfFonts } from '../viewer/src/export/fonts';

/** The real bundled face, so the "good export" below embeds and subsets like the app does. */
const NOTO_BYTES = new Uint8Array(
  readFileSync(new URL('../viewer/public/fonts/NotoSans-Regular.ttf', import.meta.url)),
);

/** Bytes of ASCII/PDF syntax. */
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * A two-page export built the way the app builds one: the bundled Unicode face, embedded
 * with a subset, and text drawn on every page.
 *
 * `objectStreams: false` writes the page tree as plain objects, which is what makes the
 * page count readable by a byte scan; the default keeps pdf-lib's packed objects, like the
 * app's own `save()`.
 */
async function completedExport(options: { objectStreams?: boolean } = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts = await registerPdfFonts(pdf, { bytes: NOTO_BYTES });
  for (const text of ['First page of the report.', 'Second page of the report.']) {
    const page = pdf.addPage([612, 792]);
    page.drawText(text, { x: 72, y: 712, size: 12, font: fonts.font });
  }
  return pdf.save({ useObjectStreams: options.objectStreams !== false });
}

/** Codes in a report, in the order produced. */
const problemCodes = (report: ExportReport): string[] => report.problems.map(problem => problem.code);
const warningCodes = (report: ExportReport): string[] => report.warnings.map(warning => warning.code);

interface FakePdfOptions {
  readonly version?: string;
  /** `/Count` on the page tree; null writes no count at all. */
  readonly count?: number | null;
  /** Extra `/Count` values in outline dictionaries — the ambiguity the heuristic has to survive. */
  readonly outlineCounts?: readonly number[];
  /** `/FontFile2` in the font descriptor, i.e. an embedded TrueType program. */
  readonly embeddedFont?: boolean;
  /** A `/Subtype /Image` XObject, i.e. a page that draws a raster. */
  readonly image?: boolean;
  /** An object stream, i.e. a file whose page tree a byte scan cannot see. */
  readonly objectStream?: boolean;
  readonly eof?: boolean;
  readonly trailingPadding?: string;
}

/**
 * A small handcrafted PDF, structurally representative but not meant to be rendered: this
 * module only ever reads bytes, and a real file for the pass case comes from `completedExport`.
 */
function fakePdf(options: FakePdfOptions = {}): Uint8Array {
  const {
    version = '1.7',
    count = 2,
    outlineCounts = [],
    embeddedFont = false,
    image = false,
    objectStream = false,
    eof = true,
    trailingPadding = '',
  } = options;

  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R]${count === null ? '' : ` /Count ${count}`} >>\nendobj`,
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>\nendobj',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj',
    '5 0 obj\n<< /Type /Font /Subtype /TrueType /BaseFont /NotoSans /FontDescriptor 6 0 R >>\nendobj',
    embeddedFont
      ? '6 0 obj\n<< /Type /FontDescriptor /FontName /NotoSans /FontFile2 7 0 R >>\nendobj'
      : '6 0 obj\n<< /Type /FontDescriptor /FontName /Helvetica >>\nendobj',
  ];

  if (embeddedFont) objects.push('7 0 obj\n<< /Length 4 >>\nstream\n0000\nendstream\nendobj');
  if (image) {
    objects.push(
      '8 0 obj\n<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray ' +
        '/BitsPerComponent 8 /Length 1 >>\nstream\n0\nendstream\nendobj',
    );
  }
  if (objectStream) {
    objects.push('9 0 obj\n<< /Type /ObjStm /N 3 /First 0 /Length 0 >>\nstream\n\nendstream\nendobj');
  }

  let nextObject = 10;
  for (const outlineCount of outlineCounts) {
    objects.push(`${nextObject} 0 obj\n<< /Type /Outlines /Count ${outlineCount} >>\nendobj`);
    nextObject += 1;
  }

  const lines = [`%PDF-${version}`, ...objects, 'trailer\n<< /Size 20 /Root 1 0 R >>', 'startxref\n0'];
  if (eof) lines.push('%%EOF');
  return encode(lines.join('\n') + trailingPadding);
}

describe('checkExport', () => {
  it('accepts a completed export that says what the caller believes', async () => {
    const report = checkExport({
      bytes: await completedExport(),
      pages: 2,
      fonts: [{ name: 'NotoSans-Regular', embedded: true, subset: true }],
      hasTextLayer: true,
      images: 0,
      expected: { textLayer: true },
    });

    expect(report).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('fails a file that does not start with the PDF header', () => {
    const report = checkExport({ bytes: encode('this was never a pdf'), pages: 1 });

    expect(report.ok).toBe(false);
    expect(problemCodes(report)).toEqual(['missing-header', 'missing-eof']);
  });

  it('fails an export whose tail was cut off', async () => {
    // Cut the last eight bytes: that takes "%%EOF" and a little of the trailer before it,
    // which is what a download that stopped early looks like.
    const bytes = (await completedExport()).slice(0, -8);
    const report = checkExport({ bytes, pages: 2, hasTextLayer: true });

    expect(report.ok).toBe(false);
    expect(problemCodes(report)).toEqual(['missing-eof']);
    expect(report.problems[0]?.message).toContain('%%EOF');
  });

  it('fails when the file states a different page count', async () => {
    // Plain objects, so the page tree is visible to a byte scan and the mismatch is provable.
    const bytes = await completedExport({ objectStreams: false });
    const report = checkExport({ bytes, pages: 3, hasTextLayer: true });

    expect(report.ok).toBe(false);
    expect(problemCodes(report)).toEqual(['page-count-mismatch']);
    expect(report.problems[0]?.message).toContain('2 pages');
    expect(report.problems[0]?.message).toContain('3 pages');
  });

  it('leaves the count unconfirmed when the file packs its page tree', async () => {
    // pdf-lib's default save packs non-stream objects, so no /Count reaches the bytes.
    const report = checkExport({ bytes: await completedExport(), pages: 2, hasTextLayer: true });

    expect(report.ok).toBe(true);
    expect(problemCodes(report)).toEqual([]);
    expect(warningCodes(report)).toEqual([]);
  });

  it('accepts the expected count when the bytes state several', () => {
    const bytes = fakePdf({ count: 2, outlineCounts: [3] });
    expect(extractPdfFacts(bytes).countCandidates).toEqual([2, 3]);

    const report = checkExport({ bytes, pages: 3 });

    expect(report.problems).toEqual([]);
  });

  it('lists every stated count when none of them is the expected one', () => {
    const report = checkExport({ bytes: fakePdf({ count: 2, outlineCounts: [3] }), pages: 5 });

    expect(problemCodes(report)).toEqual(['page-count-mismatch']);
    expect(report.problems[0]?.message).toContain('page counts of 2 and 3');
  });

  it('warns, rather than failing, when the bytes state no page count', () => {
    const report = checkExport({ bytes: fakePdf({ count: null }), pages: 1 });

    expect(report.ok).toBe(true);
    expect(warningCodes(report)).toEqual(['page-count-unreadable']);
  });

  it('does not warn when packed objects are what hides the page tree', () => {
    const bytes = fakePdf({ count: null, objectStream: true });
    expect(extractPdfFacts(bytes).hasObjectStream).toBe(true);

    const report = checkExport({ bytes, pages: 1 });

    expect(report.ok).toBe(true);
    expect(warningCodes(report)).toEqual([]);
  });

  it('warns about a font that is not embedded, naming the font', async () => {
    const report = checkExport({
      bytes: await completedExport(),
      pages: 2,
      fonts: [{ name: 'Helvetica', embedded: false }],
      hasTextLayer: true,
    });

    expect(report.ok).toBe(true);
    expect(warningCodes(report)).toEqual(['font-not-embedded']);
    expect(report.warnings[0]?.message).toContain('"Helvetica"');
  });

  it('says nothing about an embedded subset font', () => {
    const report = checkExport({
      bytes: fakePdf({ embeddedFont: true }),
      pages: 2,
      fonts: [{ name: 'ABCDEF+NotoSans-Regular', embedded: true, subset: true }],
      hasTextLayer: true,
    });

    expect(report).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('warns once for a face that appears on several pages', () => {
    const font = { name: 'Helvetica', embedded: false };
    const report = checkExport({
      bytes: fakePdf(),
      pages: 2,
      fonts: [font, font],
      hasTextLayer: true,
    });

    expect(warningCodes(report)).toEqual(['font-not-embedded']);
  });

  it('warns that a scan without a text layer cannot be copied or searched', () => {
    const report = checkExport({
      bytes: fakePdf({ image: true }),
      pages: 2,
      hasTextLayer: false,
      images: 3,
      expected: { textLayer: true },
    });

    expect(report.ok).toBe(true);
    expect(warningCodes(report)).toEqual(['no-text-layer']);
    expect(report.warnings[0]?.message).toContain('3 images');
    expect(report.warnings[0]?.message).toContain('copy, search');
  });

  it('does not ask a picture-only export for a text layer it never promised', () => {
    const report = checkExport({ bytes: fakePdf({ image: true }), pages: 2, images: 3 });

    expect(warningCodes(report)).toEqual([]);
  });

  const SOURCE_SENTENCE = 'The pump must be inspected before every start-up.';

  it('fails when a replaced source sentence is still in the exported text', () => {
    const report = checkExport({
      bytes: fakePdf(),
      pages: 2,
      hasTextLayer: true,
      expected: {
        sourceSentences: [SOURCE_SENTENCE],
        extractedText: `Máy bơm phải được kiểm tra trước mỗi lần khởi động.\n${SOURCE_SENTENCE}\n`,
      },
    });

    expect(report.ok).toBe(false);
    expect(problemCodes(report)).toEqual(['source-sentence-left']);
    expect(report.problems[0]?.message).toContain(SOURCE_SENTENCE);
  });

  it('still finds the sentence when extraction broke it across a line', () => {
    const report = checkExport({
      bytes: fakePdf(),
      pages: 2,
      expected: {
        sourceSentences: [SOURCE_SENTENCE],
        extractedText: 'The pump must be inspected before every\n  start-up.\n',
      },
    });

    expect(problemCodes(report)).toEqual(['source-sentence-left']);
  });

  it('accepts a translated export whose source sentences are gone', () => {
    const report = checkExport({
      bytes: fakePdf(),
      pages: 2,
      hasTextLayer: true,
      expected: {
        sourceSentences: [SOURCE_SENTENCE],
        extractedText: 'Máy bơm phải được kiểm tra trước mỗi lần khởi động.',
      },
    });

    expect(report).toEqual({ ok: true, problems: [], warnings: [] });
  });

  it('warns that the leftover check did not run without extracted text', () => {
    const report = checkExport({
      bytes: fakePdf(),
      pages: 2,
      expected: { sourceSentences: [SOURCE_SENTENCE] },
    });

    expect(report.ok).toBe(true);
    expect(warningCodes(report)).toEqual(['source-text-unchecked']);
  });

  it('skips a source string too short to be evidence of a leftover', () => {
    const tooShort = 'Pump';
    expect(tooShort.length).toBeLessThan(MIN_SOURCE_SENTENCE_CHARS);

    const report = checkExport({
      bytes: fakePdf(),
      pages: 2,
      expected: { sourceSentences: [tooShort], extractedText: 'Pump' },
    });

    expect(report.problems).toEqual([]);
  });

  it('warns about a file above the size cap and names the size', async () => {
    expect(EXPORT_SIZE_WARNING_BYTES).toBe(50 * 1024 * 1024);

    const report = checkExport({
      bytes: await completedExport(),
      pages: 2,
      hasTextLayer: true,
      maxBytes: 512,
    });

    expect(report.ok).toBe(true);
    expect(warningCodes(report)).toEqual(['oversized']);
    const message = report.warnings[0]?.message ?? '';
    expect(message).toMatch(/The export is \d+ KB/);
    expect(message).toContain('512 bytes');
  });

  it('does not warn about size when the caller passes no cap', async () => {
    const report = checkExport({ bytes: await completedExport(), pages: 2, hasTextLayer: true });

    expect(warningCodes(report)).toEqual([]);
  });

  it('refuses a request whose bytes are not bytes', () => {
    const report = checkExport({ bytes: 'not a file' as unknown as Uint8Array, pages: 1 });

    expect(report.ok).toBe(false);
    expect(problemCodes(report)).toEqual(['invalid-input']);
  });

  it('refuses a page count that is not a whole number and names what it got', () => {
    const report = checkExport({ bytes: fakePdf(), pages: 2.5 });

    expect(problemCodes(report)).toContain('invalid-input');
    expect(report.problems[0]?.message).toContain('2.5');
  });
});

describe('extractPdfFacts', () => {
  it('reads the version and the page count from a handcrafted PDF', () => {
    const facts = extractPdfFacts(fakePdf({ version: '1.4', count: 7 }));

    expect(facts.version).toBe('1.4');
    expect(facts.pageCount).toBe(7);
    expect(facts.countCandidates).toEqual([7]);
    expect(facts.hasHeader).toBe(true);
    expect(facts.hasEofMarker).toBe(true);
    expect(facts.hasStartXref).toBe(true);
    expect(facts.heuristic).toBe(true);
  });

  it('reports the embedded-font and image markers', () => {
    const withBoth = extractPdfFacts(fakePdf({ embeddedFont: true, image: true }));
    expect(withBoth.hasEmbeddedFont).toBe(true);
    expect(withBoth.hasImage).toBe(true);
    expect(withBoth.hasObjectStream).toBe(false);

    const textOnly = extractPdfFacts(fakePdf({ count: 1 }));
    expect(textOnly.hasEmbeddedFont).toBe(false);
    expect(textOnly.hasImage).toBe(false);
  });

  it('recognises /FontFile3 as an embedded font', () => {
    const facts = extractPdfFacts(
      encode('%PDF-1.7\n1 0 obj\n<< /FontFile3 2 0 R >>\nendobj\nstartxref\n0\n%%EOF'),
    );

    expect(facts.hasEmbeddedFont).toBe(true);
    expect(facts.hasImage).toBe(false);
  });

  it('ignores a negative outline /Count when guessing pages', () => {
    const facts = extractPdfFacts(fakePdf({ count: 4, outlineCounts: [-2] }));

    expect(facts.countCandidates).toEqual([4]);
    expect(facts.pageCount).toBe(4);
  });

  it('reports nothing it cannot see in bytes that are not a PDF', () => {
    const facts = extractPdfFacts(encode('nothing to see here'));

    expect(facts.version).toBeNull();
    expect(facts.pageCount).toBeNull();
    expect(facts.countCandidates).toEqual([]);
    expect(facts.hasEmbeddedFont).toBe(false);
    expect(facts.hasImage).toBe(false);
    expect(facts.hasStartXref).toBe(false);
    expect(facts.hasHeader).toBe(false);
    expect(facts.hasEofMarker).toBe(false);
  });

  it('tolerates trailing padding after the end marker', () => {
    expect(extractPdfFacts(fakePdf({ trailingPadding: '\n\n  ' })).hasEofMarker).toBe(true);
  });

  it('finds a match that starts at the end of a scan window', () => {
    // The scan visits 32 KiB windows with a small overlap; this puts "/Count 12" across one
    // seam, so a missing overlap would lose it.
    const head = '%PDF-1.7\n';
    const seam = 32 * 1024 - 2;
    const bytes = encode(`${head}${' '.repeat(seam - head.length)}/Count 12\nstartxref\n0\n%%EOF`);

    expect(extractPdfFacts(bytes).countCandidates).toEqual([12]);
  });

  it('reads the facts of a real export written by the app', async () => {
    const facts = extractPdfFacts(await completedExport());

    expect(facts.version).toBe('1.7');
    expect(facts.hasStartXref).toBe(true);
    expect(facts.hasHeader).toBe(true);
    expect(facts.hasEofMarker).toBe(true);
    // The writer packs its objects, so the page tree (and the font descriptors beside it)
    // is inside a compressed object stream and no byte scan can state the page count.
    expect(facts.hasObjectStream).toBe(true);
    expect(facts.pageCount).toBeNull();
    expect(facts.countCandidates).toEqual([]);
  });

  it('reads the page count of a real export whose objects are plain', async () => {
    const facts = extractPdfFacts(await completedExport({ objectStreams: false }));

    expect(facts.version).toBe('1.7');
    expect(facts.hasObjectStream).toBe(false);
    expect(facts.pageCount).toBe(2);
    expect(facts.countCandidates).toEqual([2]);
    expect(facts.hasEmbeddedFont).toBe(true);
  });
});
