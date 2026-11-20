import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  INFO_FIELD_KEYS,
  deriveTitle,
  normaliseAuthor,
  normaliseDate,
  normaliseKeywords,
  normaliseLanguageTag,
  parseDocumentLanguage,
  parseInfoDict,
  readMetadata,
  type DocumentMetadata,
  type MetadataProblem,
} from '../src/core/metadata';

// --- Fixtures --------------------------------------------------------------

/** Bytes of PDF syntax, one byte per character, so a high byte survives the round trip. */
function pdfBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

/** A minimal PDF whose object 3 is the Info dictionary, with `body` inside it. */
function pdfWithInfoBody(body: string): Uint8Array {
  return pdfBytes(
    '%PDF-1.7\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 0 >>\nendobj\n' +
      `3 0 obj\n<< ${body} >>\nendobj\n` +
      'trailer\n<< /Size 4 /Root 1 0 R /Info 3 0 R >>\nstartxref\n0\n%%EOF\n',
  );
}

/** A minimal PDF whose catalog carries a `/Lang` value written verbatim. */
function pdfWithLang(value: string): Uint8Array {
  return pdfBytes(
    '%PDF-1.7\n' +
      `1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Lang ${value} >>\nendobj\n` +
      '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n' +
      'trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
  );
}

/** A PDF with no information dictionary at all. */
function plainPdf(): Uint8Array {
  return pdfBytes(
    '%PDF-1.7\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n' +
      'trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
  );
}

/** A text string that needs the UTF-16BE BOM: no PDFDocEncoding byte can carry these. */
function utf16beHex(text: string): string {
  const bytes: number[] = [0xfe, 0xff];
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    bytes.push((unit >> 8) & 0xff, unit & 0xff);
  }
  return bytes.map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const problemCodes = (problems: readonly MetadataProblem[]): string[] => problems.map(problem => problem.code);

/** A metadata record with every field empty, for the title tests. */
function emptyMetadata(overrides: Partial<DocumentMetadata> = {}): DocumentMetadata {
  return {
    title: null,
    authors: [],
    subject: null,
    keywords: [],
    creator: null,
    producer: null,
    creationDate: null,
    modificationDate: null,
    language: null,
    found: [],
    ...overrides,
  };
}

// --- The information dictionary -------------------------------------------

describe('parseInfoDict', () => {
  it('reads a literal string field and lists the keys the dictionary carried', () => {
    const info = parseInfoDict(pdfWithInfoBody('/Title (Annual Report 2024) /Author (Alice Smith)'));

    expect(info.fields.Title).toBe('Annual Report 2024');
    expect(info.fields.Author).toBe('Alice Smith');
    expect(info.found).toEqual(['Title', 'Author']);
    expect(info.problems).toEqual([]);
  });

  it('reads a hex string that carries UTF-16BE with a BOM', () => {
    const title = 'Łódź i Warszawa';
    const info = parseInfoDict(pdfWithInfoBody(`/Title <${utf16beHex(title)}>`));

    expect(info.fields.Title).toBe(title);
    expect(info.problems).toEqual([]);
  });

  it('unescapes parentheses and backslashes, and keeps balanced parentheses', () => {
    const info = parseInfoDict(pdfWithInfoBody('/Title (Report \\(Draft\\) v2) /Subject (A (B) C)'));

    expect(info.fields.Title).toBe('Report (Draft) v2');
    expect(info.fields.Subject).toBe('A (B) C');
  });

  it('decodes PDFDocEncoding, which is Latin-1 except for a documented range', () => {
    // 0xe9 is é in both encodings; 0x80 is a bullet and 0xa0 a euro in PDFDocEncoding only.
    const info = parseInfoDict(pdfWithInfoBody('/Title (caf\xe9 \x80 \xa0)'));

    expect(info.fields.Title).toBe('café • €');
  });

  it('reports the keys it carried in canonical order, whatever order the file wrote them', () => {
    const info = parseInfoDict(pdfWithInfoBody('/Producer (Acme Tools) /Title (T) /ModDate (D:20240101)'));

    expect(info.found).toEqual(['Title', 'Producer', 'ModDate']);
    expect(info.found).not.toBe(INFO_FIELD_KEYS);
  });

  it('reports a key whose value is not a string instead of inventing one', () => {
    const info = parseInfoDict(pdfWithInfoBody('/Title /None'));

    expect(info.found).toEqual(['Title']);
    expect(info.fields.Title).toBeUndefined();
    expect(problemCodes(info.problems)).toContain('value-not-a-string');
  });

  it('keeps the later value of a duplicated key and says so', () => {
    const info = parseInfoDict(pdfWithInfoBody('/Title (First) /Title (Second)'));

    expect(info.fields.Title).toBe('Second');
    expect(problemCodes(info.problems)).toContain('duplicate-field');
  });

  it('treats an empty value as absent without calling it a problem', () => {
    const info = parseInfoDict(pdfWithInfoBody('/Title () /Author (Bob Jones)'));

    expect(info.fields.Title).toBeUndefined();
    expect(info.fields.Author).toBe('Bob Jones');
    expect(info.found).toEqual(['Title', 'Author']);
    expect(info.problems).toEqual([]);
  });

  it('returns the readable fields of a malformed dictionary, plus the damage', () => {
    // The literal string for /Author never closes and the dictionary never reaches `>>`.
    const bytes = pdfBytes(
      '%PDF-1.7\n' +
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        '3 0 obj\n<< /Title (Alpha) /Author (Beta\nendobj\n' +
        'trailer\n<< /Size 4 /Root 1 0 R /Info 3 0 R >>\n%%EOF\n',
    );

    const info = parseInfoDict(bytes);
    const codes = problemCodes(info.problems);

    expect(info.fields.Title).toBe('Alpha');
    expect(info.fields.Author).toBe('Beta');
    expect(codes).toContain('string-unterminated');
    expect(codes).toContain('info-dict-unterminated');
  });

  it('reports a trailer /Info that does not hold a dictionary', () => {
    const bytes = pdfBytes(
      '%PDF-1.7\n' +
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        '3 0 obj\n42\nendobj\n' +
        'trailer\n<< /Size 4 /Root 1 0 R /Info 3 0 R >>\n%%EOF\n',
    );

    const info = parseInfoDict(bytes);

    expect(info.fields).toEqual({});
    expect(problemCodes(info.problems)).toContain('info-dict-malformed');
  });

  it('finds the dictionary by content when the trailer names none', () => {
    // An incremental update that lost its trailer: only the dictionary itself is left.
    const bytes = pdfBytes(
      '%PDF-1.7\n' +
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        '3 0 obj\n<< /Producer (Acme) /Title (Recovered) >>\nendobj\n',
    );

    const info = parseInfoDict(bytes);

    expect(info.fields.Title).toBe('Recovered');
    expect(info.fields.Producer).toBe('Acme');
  });

  it('does not mistake a bookmark title for the document title', () => {
    // The only /Title in the file is an outline item, which has no information key.
    const bytes = pdfBytes(
      '%PDF-1.7\n' +
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R >>\nendobj\n' +
        '3 0 obj\n<< /Type /Outlines /First 4 0 R /Last 4 0 R >>\nendobj\n' +
        '4 0 obj\n<< /Title (Chapter One) /Parent 3 0 R >>\nendobj\n' +
        'trailer\n<< /Size 5 /Root 1 0 R >>\n%%EOF\n',
    );

    const info = parseInfoDict(bytes);

    expect(info.fields).toEqual({});
    expect(info.problems).toEqual([]);
  });

  it('reports nothing for a PDF that carries no metadata at all', () => {
    const info = parseInfoDict(plainPdf());

    expect(info.fields).toEqual({});
    expect(info.found).toEqual([]);
    expect(info.problems).toEqual([]);
  });

  it('refuses input that is not bytes', () => {
    const info = parseInfoDict(undefined as unknown as Uint8Array);

    expect(info.fields).toEqual({});
    expect(problemCodes(info.problems)).toEqual(['invalid-input']);
  });

  it('reads the dictionary a real producer writes, through the trailer reference', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    pdf.setTitle('Annual Report 2024');
    pdf.setAuthor('Alice Smith; Bob Jones');
    pdf.setProducer('Acme Press');
    pdf.setCreationDate(new Date(Date.UTC(2024, 2, 5, 14, 30, 0)));
    // Plain objects, so the dictionary stays where a byte scan can read it.
    const bytes = await pdf.save({ useObjectStreams: false });

    const report = readMetadata(bytes);

    expect(report.metadata.title).toBe('Annual Report 2024');
    expect(report.metadata.authors).toEqual(['Alice Smith', 'Bob Jones']);
    expect(report.metadata.producer).toBe('Acme Press');
    expect(report.metadata.creationDate?.iso).toBe('2024-03-05T14:30:00Z');
    expect(report.problems).toEqual([]);
  });

  it('reads a non-Latin-1 title a real producer stores as UTF-16 hex', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]);
    pdf.setTitle('Łódź i Warszawa');
    const bytes = await pdf.save({ useObjectStreams: false });

    expect(parseInfoDict(bytes).fields.Title).toBe('Łódź i Warszawa');
  });
});

// --- Dates ----------------------------------------------------------------

describe('normaliseDate', () => {
  it('parses a full date with a timezone', () => {
    const date = normaliseDate("D:20240305143000+05'30'");

    expect(date).toEqual({ iso: '2024-03-05T14:30:00+05:30', timezone: '+05:30', valid: true, reason: null });
  });

  it('parses a full date without a timezone, and one in UTC', () => {
    const local = normaliseDate('D:20240305143000');
    const utc = normaliseDate('D:20240305143000Z');

    expect(local.iso).toBe('2024-03-05T14:30:00');
    expect(local.timezone).toBeNull();
    expect(local.valid).toBe(true);

    expect(utc.iso).toBe('2024-03-05T14:30:00Z');
    expect(utc.timezone).toBe('Z');
    expect(utc.valid).toBe(true);
  });

  it('accepts the zone spellings producers write', () => {
    expect(normaliseDate('D:20240305143000-08\'00\'').iso).toBe('2024-03-05T14:30:00-08:00');
    expect(normaliseDate('D:20240305143000+0530').iso).toBe('2024-03-05T14:30:00+05:30');
    expect(normaliseDate('D:20240305143000+05:30').iso).toBe('2024-03-05T14:30:00+05:30');
    expect(normaliseDate('D:20240305143000+05').iso).toBe('2024-03-05T14:30:00+05:00');
  });

  it('keeps the precision the source states instead of filling in the rest', () => {
    expect(normaliseDate('D:2024')).toEqual({ iso: '2024', timezone: null, valid: true, reason: null });
    expect(normaliseDate('D:202403').iso).toBe('2024-03');
    expect(normaliseDate('D:20240305').iso).toBe('2024-03-05');
  });

  it('refuses an impossible date', () => {
    const refused = normaliseDate('D:20230230120000Z');

    expect(refused.valid).toBe(false);
    expect(refused.iso).toBeNull();
    expect(refused.reason).toBe('calendar');
  });

  it('refuses a month, day or time outside its range', () => {
    expect(normaliseDate('D:20241305').reason).toBe('range');
    expect(normaliseDate('D:20240300').reason).toBe('calendar');
    expect(normaliseDate('D:20240305240000').reason).toBe('range');
    expect(normaliseDate('D:20240305146000').reason).toBe('range');
  });

  it('refuses a shape it cannot read rather than guessing a century', () => {
    expect(normaliseDate('').reason).toBe('empty');
    expect(normaliseDate('D:24').reason).toBe('shape');
    expect(normaliseDate('D:20241').reason).toBe('shape');
    expect(normaliseDate('last Tuesday').reason).toBe('shape');
    expect(normaliseDate('D:20240305143000+99:00').reason).toBe('timezone');
  });
});

// --- Authors and keywords -------------------------------------------------

describe('normaliseAuthor', () => {
  it('splits multiple authors on the documented separators', () => {
    expect(normaliseAuthor('Alice Smith; Bob Jones; Carol White')).toEqual(['Alice Smith', 'Bob Jones', 'Carol White']);
    expect(normaliseAuthor('Alice Smith and Bob Jones')).toEqual(['Alice Smith', 'Bob Jones']);
    expect(normaliseAuthor('Alice Smith, Bob Jones, Carol White')).toEqual(['Alice Smith', 'Bob Jones', 'Carol White']);
    expect(normaliseAuthor('Alice Smith\nBob Jones')).toEqual(['Alice Smith', 'Bob Jones']);
  });

  it('keeps a corporate author intact when a separator word sits inside it', () => {
    expect(normaliseAuthor('Research and Development Corporation')).toEqual(['Research and Development Corporation']);
    expect(normaliseAuthor('Acme, Inc.')).toEqual(['Acme, Inc.']);
    expect(normaliseAuthor('World Health Organization')).toEqual(['World Health Organization']);
  });

  it('keeps an inverted single name intact, because the comma is not a separator there', () => {
    expect(normaliseAuthor('Smith, John')).toEqual(['Smith, John']);
  });

  it('returns nothing for an empty author field', () => {
    expect(normaliseAuthor('')).toEqual([]);
    expect(normaliseAuthor('   ')).toEqual([]);
  });
});

describe('normaliseKeywords', () => {
  it('splits a keyword list on commas, semicolons and line breaks', () => {
    expect(normaliseKeywords('alpha, beta; gamma')).toEqual(['alpha', 'beta', 'gamma']);
    expect(normaliseKeywords('alpha\nbeta')).toEqual(['alpha', 'beta']);
  });

  it('drops empty terms and keeps a term that contains a colon', () => {
    expect(normaliseKeywords('machine learning, , retrieval: lexical')).toEqual([
      'machine learning',
      'retrieval: lexical',
    ]);
  });
});

// --- Language -------------------------------------------------------------

describe('language', () => {
  it('reads the catalog /Lang and canonicalises its case', () => {
    expect(parseDocumentLanguage(pdfWithLang('(en-GB)')).language).toBe('en-GB');
    expect(parseDocumentLanguage(pdfWithLang('(PT-br)')).language).toBe('pt-BR');
    expect(parseDocumentLanguage(pdfWithLang('/EN_us')).language).toBe('en-US');
  });

  it('reports a /Lang that is not a language tag', () => {
    const read = parseDocumentLanguage(pdfWithLang('(English)'));

    expect(read.language).toBeNull();
    expect(problemCodes(read.problems)).toEqual(['language-invalid']);
  });

  it('returns nothing when the catalog states no language', () => {
    expect(parseDocumentLanguage(plainPdf())).toEqual({ language: null, problems: [] });
  });

  it('canonicalises a tag the way BCP-47 writes it', () => {
    expect(normaliseLanguageTag('zh-Hant-TW')).toBe('zh-Hant-TW');
    expect(normaliseLanguageTag('EN')).toBe('en');
    expect(normaliseLanguageTag('not a tag')).toBeNull();
  });
});

// --- The normalised record -------------------------------------------------

describe('readMetadata', () => {
  it('joins the dictionary fields with the language and the parsed dates', () => {
    const report = readMetadata(
      pdfWithInfoBody(
        '/Title (Annual Report) /Author (Alice Smith; Bob Jones) /Keywords (finance, audit) ' +
          "/CreationDate (D:20240305143000+05'30') /Producer (Acme Press)",
      ),
    );

    expect(report.metadata.title).toBe('Annual Report');
    expect(report.metadata.authors).toEqual(['Alice Smith', 'Bob Jones']);
    expect(report.metadata.keywords).toEqual(['finance', 'audit']);
    expect(report.metadata.producer).toBe('Acme Press');
    expect(report.metadata.creationDate?.iso).toBe('2024-03-05T14:30:00+05:30');
    expect(report.metadata.modificationDate).toBeNull();
    expect(report.problems).toEqual([]);
  });

  it('reports a date field that is present but impossible, and keeps the refusal', () => {
    const report = readMetadata(pdfWithInfoBody('/ModDate (D:20230230)'));

    expect(report.metadata.modificationDate?.valid).toBe(false);
    expect(report.metadata.modificationDate?.iso).toBeNull();
    expect(problemCodes(report.problems)).toContain('date-invalid');
  });
});

// --- Titles ---------------------------------------------------------------

describe('deriveTitle', () => {
  it('takes the title from the metadata when the dictionary carries one', () => {
    const derived = deriveTitle(emptyMetadata({ title: 'Annual Report 2024' }), [{ text: 'Introduction', type: 'heading' }], {
      filename: 'report.pdf',
    });

    expect(derived).toEqual({ title: 'Annual Report 2024', source: 'metadata' });
  });

  it('falls back to the first heading when the metadata has no title', () => {
    const derived = deriveTitle(
      emptyMetadata(),
      [
        { text: 'A first paragraph, not a title.', type: 'paragraph' },
        { text: 'Chapter One', type: 'heading' },
        { text: 'Chapter Two', type: 'heading' },
      ],
      { filename: 'report.pdf' },
    );

    expect(derived).toEqual({ title: 'Chapter One', source: 'heading' });
  });

  it('falls back to the filename stem as the last resort', () => {
    const derived = deriveTitle(emptyMetadata(), [], { filename: 'C:\\docs\\annual-report-2024.pdf' });

    expect(derived).toEqual({ title: 'annual report 2024', source: 'filename' });
  });

  it('leaves a filename stem that is already a written title alone', () => {
    expect(deriveTitle(emptyMetadata(), [], { filename: 'Annual Report (draft).pdf' })).toEqual({
      title: 'Annual Report (draft)',
      source: 'filename',
    });
  });

  it('does not present a producer placeholder as the document title', () => {
    const blocks = [{ text: 'Real Heading', type: 'heading' as const }];

    expect(deriveTitle(emptyMetadata({ title: 'Untitled' }), blocks)).toEqual({ title: 'Real Heading', source: 'heading' });
    expect(deriveTitle(emptyMetadata({ title: 'Microsoft Word - report.doc' }), blocks)).toEqual({
      title: 'Real Heading',
      source: 'heading',
    });
  });

  it('says when there is no title at all instead of inventing one', () => {
    expect(deriveTitle(emptyMetadata())).toEqual({ title: null, source: 'none' });
    expect(deriveTitle(null, [])).toEqual({ title: null, source: 'none' });
  });
});
