import { describe, expect, it } from 'vitest';
import { diagnose, inspectPdf, type PdfInspection } from '../viewer/src/core/pdf-health';

// --- Fixtures --------------------------------------------------------------

/** One character per byte: the fixtures are ASCII, so a string and its bytes line up. */
const bytesOf = (text: string): Uint8Array => new Uint8Array(Array.from(text, character => character.charCodeAt(0)));

/** The three objects every fixture below starts with: catalog, page tree, one page. */
const DEFAULT_BODIES: readonly string[] = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
];

interface FixtureOptions {
  /** Header version; `"1.4"` unless a test is about 1.5+ files. */
  readonly version?: string;
  /** Object bodies, in object-number order. Defaults to {@link DEFAULT_BODIES}. */
  readonly bodies?: readonly string[];
  /** Write a PDF 1.5+ cross-reference stream instead of an xref table and a trailer. */
  readonly xrefStream?: boolean;
  /** Add an encryption dictionary and an `/Encrypt` entry in the trailer. */
  readonly encrypted?: boolean;
  /** Leave out the `startxref` pointer. */
  readonly omitStartXref?: boolean;
  /** Leave out the `trailer` dictionary and its entries. */
  readonly omitTrailer?: boolean;
  /** Leave out the `%%EOF` marker. */
  readonly omitEof?: boolean;
  /** Appended after the end marker, for padding a writer may leave behind. */
  readonly appended?: string;
}

/**
 * A small but structurally real PDF: header, plain objects, a cross-reference table whose
 * offsets are the offsets the objects actually have, a trailer, and `%%EOF`.
 *
 * The offsets are computed rather than faked so the fixture is a file a viewer accepts. The
 * check under test never reads them — it only asks whether the keyword is there — but a
 * fixture that could not open would make every assertion in this file a claim about a file
 * no reader would ever see.
 */
function buildPdfText(options: FixtureOptions = {}): string {
  const version = options.version ?? '1.4';
  const bodies = [...(options.bodies ?? DEFAULT_BODIES)];
  const encryptEntry = options.encrypted === true ? ` /Encrypt ${bodies.length + 1} 0 R` : '';
  if (options.encrypted === true) {
    bodies.push('<< /Filter /Standard /V 2 /R 3 /Length 40 /P -4 /O <00> /U <00> >>');
  }

  const size = bodies.length + 1;
  let text = `%PDF-${version}\n`;
  const offsets: number[] = [];
  for (const [index, body] of bodies.entries()) {
    offsets.push(text.length);
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = text.length;
  if (options.xrefStream === true) {
    text +=
      `${size} 0 obj\n` +
      `<< /Type /XRef /Size ${size + 1} /W [1 4 2] /Root 1 0 R${encryptEntry} /Length 8 >>\n` +
      'stream\n\0\0\0\0\0\0\0\0\nendstream\nendobj\n';
  } else {
    const entries = [
      '0000000000 65535 f ',
      ...offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n `),
    ];
    text += `xref\n0 ${size}\n${entries.join('\n')}\ntrailer\n<< /Size ${size} /Root 1 0 R${encryptEntry} >>\n`;
  }

  let assembled = `${text}startxref\n${xrefOffset}\n%%EOF\n`;
  if (options.omitStartXref === true) assembled = assembled.replace(/startxref\n\d+\n/u, '');
  if (options.omitTrailer === true) assembled = assembled.replace(/trailer\n<<.*?>>\n/su, '');
  if (options.omitEof === true) assembled = assembled.replace(/%%EOF\n/u, '');

  return assembled + (options.appended ?? '');
}

/** {@link buildPdfText} as bytes, ready for `inspectPdf`. */
const buildPdf = (options: FixtureOptions = {}): Uint8Array => bytesOf(buildPdfText(options));

/** Codes in a report, in the order produced. */
const codesOf = (inspection: PdfInspection): string[] => inspection.problems.map(problem => problem.code);

// --- A file that will open -------------------------------------------------

describe('a healthy PDF', () => {
  it('passes every check and is recommended to open as it is', () => {
    const inspection = inspectPdf(buildPdf());

    expect(inspection.healthy).toBe(true);
    expect(inspection.version).toBe('1.4');
    expect(inspection.encrypted).toBe(false);
    expect(inspection.problems).toEqual([]);
    expect(inspection.confidence).toBe('high');
    expect(inspection.hasStartXref).toBe(true);
    expect(inspection.hasTrailer).toBe(true);
    expect(inspection.hasEof).toBe(true);
    expect(inspection.xrefStream).toBe(false);
    expect(inspection.revisions).toBe(1);
    expect(inspection.incremental).toBe(false);

    const diagnosis = diagnose(inspection);
    expect(diagnosis.level).toBe('ok');
    expect(diagnosis.action).toBe('open');
    expect(diagnosis.recommendation).toMatch(/Open it normally/u);
  });

  it('reads the version from the header it was built with', () => {
    expect(inspectPdf(buildPdf({ version: '1.7' })).version).toBe('1.7');
  });

  it('tolerates the padding some writers leave after the end marker', () => {
    const inspection = inspectPdf(buildPdf({ appended: '\n\n\0\0' }));
    expect(inspection.hasEof).toBe(true);
    expect(inspection.problems).toEqual([]);
  });
});

// --- A file that will probably open, with one caveat ------------------------

describe('a file with a damaged tail', () => {
  it('warns when the startxref pointer is missing, and still calls the file healthy', () => {
    const inspection = inspectPdf(buildPdf({ omitStartXref: true }));

    expect(codesOf(inspection)).toEqual(['missing-startxref']);
    expect(inspection.healthy).toBe(true);
    expect(inspection.confidence).toBe('medium');

    const diagnosis = diagnose(inspection);
    expect(diagnosis.level).toBe('warning');
    expect(diagnosis.action).toBe('open-with-fallback-engine');
    expect(diagnosis.recommendation).toMatch(/different PDF engine/u);
  });

  it('warns when the trailer is missing but the pointer survives', () => {
    const inspection = inspectPdf(buildPdf({ omitTrailer: true }));

    expect(codesOf(inspection)).toEqual(['missing-trailer']);
    expect(inspection.hasStartXref).toBe(true);
    expect(inspection.hasTrailer).toBe(false);
    expect(inspection.healthy).toBe(true);
    expect(diagnose(inspection).action).toBe('open-with-fallback-engine');
  });

  it('warns, rather than fails, when only the end marker is gone', () => {
    const inspection = inspectPdf(buildPdf({ omitEof: true }));

    expect(codesOf(inspection)).toEqual(['missing-eof']);
    expect(inspection.hasEof).toBe(false);
    expect(inspection.revisions).toBe(0);
    expect(inspection.healthy).toBe(true);

    const diagnosis = diagnose(inspection);
    expect(diagnosis.level).toBe('warning');
    expect(diagnosis.action).toBe('open-with-fallback-engine');
    expect(diagnosis.recommendation).toMatch(/different PDF engine/u);
  });
});

// --- A file that will not open ---------------------------------------------

describe('a broken file', () => {
  it('calls a cut-off download broken and recommends repair', () => {
    const text = buildPdfText();
    const cut = text.indexOf('\nxref\n') + 1;
    expect(cut).toBeGreaterThan(0);

    const inspection = inspectPdf(bytesOf(text.slice(0, cut)));

    expect(codesOf(inspection)).toEqual(['truncated']);
    expect(inspection.healthy).toBe(false);
    expect(inspection.hasStartXref).toBe(false);
    expect(inspection.hasEof).toBe(false);
    expect(inspection.confidence).toBe('low');
    // The objects that made it into the file are still countable; that is what a repair
    // tool would salvage.
    expect(inspection.objects).toBe(DEFAULT_BODIES.length);

    const diagnosis = diagnose(inspection);
    expect(diagnosis.level).toBe('broken');
    expect(diagnosis.action).toBe('repair');
    expect(diagnosis.recommendation).toMatch(/repair/u);
    expect(diagnosis.recommendation).toMatch(/PDF repair tool/u);
  });

  it('refuses an empty buffer instead of throwing', () => {
    const inspection = inspectPdf(new Uint8Array(0));

    expect(inspection.healthy).toBe(false);
    expect(inspection.version).toBeNull();
    expect(inspection.encrypted).toBe(false);
    expect(inspection.objects).toBe(0);
    expect(inspection.size).toBe(0);
    expect(inspection.confidence).toBe('low');
    expect(codesOf(inspection)).toEqual(['empty-file']);

    const diagnosis = diagnose(inspection);
    expect(diagnosis.level).toBe('broken');
    expect(diagnosis.action).toBe('redownload');
    expect(diagnosis.recommendation).toMatch(/Download or copy it again/u);
  });

  it('refuses bytes that are not a PDF at all', () => {
    const inspection = inspectPdf(bytesOf('This is a text file, despite its extension.\n'));

    expect(codesOf(inspection)).toEqual(['missing-header']);
    expect(inspection.version).toBeNull();
    expect(inspection.objects).toBe(0);
    expect(diagnose(inspection).level).toBe('broken');
    expect(diagnose(inspection).action).toBe('repair');
  });

  it('repairs before it unlocks, and says the password will still be needed', () => {
    // A header, a trailer with an encryption entry, and no object at all: the file cannot
    // be read, and once repaired it will still ask for a password.
    const inspection = inspectPdf(
      bytesOf('%PDF-1.4\ntrailer\n<< /Size 1 /Root 1 0 R /Encrypt 2 0 R >>\nstartxref\n0\n%%EOF\n'),
    );

    expect(codesOf(inspection)).toEqual(['no-objects', 'encrypted']);
    expect(inspection.healthy).toBe(false);

    const diagnosis = diagnose(inspection);
    expect(diagnosis.level).toBe('broken');
    expect(diagnosis.action).toBe('repair');
    expect(diagnosis.recommendation).toMatch(/repair/u);
    expect(diagnosis.recommendation).toMatch(/password/u);
  });
});

// --- Password-protected ----------------------------------------------------

describe('an encrypted file', () => {
  it('is healthy to open but asks for the password', () => {
    const inspection = inspectPdf(buildPdf({ encrypted: true }));

    expect(inspection.encrypted).toBe(true);
    expect(codesOf(inspection)).toEqual(['encrypted']);
    expect(inspection.healthy).toBe(true);
    expect(inspection.confidence).toBe('medium');

    const diagnosis = diagnose(inspection);
    expect(diagnosis.level).toBe('warning');
    expect(diagnosis.action).toBe('ask-password');
    expect(diagnosis.recommendation).toMatch(/password/u);
  });

  it('asks for the password before it suggests OCR', () => {
    const inspection = inspectPdf(buildPdf({ encrypted: true }));
    expect(diagnose(inspection, { textExtraction: 'none' }).action).toBe('ask-password');
  });
});

// --- Object count ----------------------------------------------------------

describe('the object count', () => {
  it('counts object definitions and nothing from the cross-reference table', () => {
    expect(inspectPdf(buildPdf()).objects).toBe(DEFAULT_BODIES.length);
    expect(inspectPdf(buildPdf({ encrypted: true })).objects).toBe(DEFAULT_BODIES.length + 1);
  });

  it('counts the objects a file defines, including a packed object stream', () => {
    const inspection = inspectPdf(
      buildPdf({ bodies: [...DEFAULT_BODIES, '<< /Type /ObjStm /N 2 /First 0 >>'] }),
    );

    expect(inspection.objects).toBe(DEFAULT_BODIES.length + 1);
    expect(inspection.objectStream).toBe(true);
    // Objects packed inside that stream are invisible to a byte scan, so the count is a
    // floor and the report says so rather than claiming a total.
    expect(inspection.confidence).toBe('medium');
    expect(inspection.problems).toEqual([]);
  });

  it('counts an incremental update as more definitions, not more objects', () => {
    const text = buildPdfText();
    const firstEnd = text.indexOf('%%EOF\n') + '%%EOF\n'.length;
    const updated = `${text.slice(0, firstEnd)}4 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n` +
      `startxref\n0\n%%EOF\n`;

    const inspection = inspectPdf(bytesOf(updated));

    expect(inspection.objects).toBe(DEFAULT_BODIES.length + 1);
    expect(inspection.revisions).toBe(2);
    expect(inspection.incremental).toBe(true);
    expect(inspection.confidence).toBe('medium');
  });
});

// --- PDF 1.5 and later -----------------------------------------------------

describe('a PDF 1.5 cross-reference stream', () => {
  it('is noted, and its missing trailer is not held against it', () => {
    const inspection = inspectPdf(buildPdf({ version: '1.5', xrefStream: true }));

    expect(inspection.version).toBe('1.5');
    expect(inspection.xrefStream).toBe(true);
    // A cross-reference stream replaces the trailer dictionary; the absence is the format
    // speaking, not a fault.
    expect(inspection.hasTrailer).toBe(false);
    expect(inspection.problems).toEqual([]);
    expect(inspection.healthy).toBe(true);
    expect(inspection.confidence).toBe('medium');

    const diagnosis = diagnose(inspection);
    expect(diagnosis.level).toBe('ok');
    expect(diagnosis.action).toBe('open');
  });
});

// --- OCR, from the caller's own result -------------------------------------

describe('text extraction', () => {
  it('recommends OCR only when extraction really produced nothing', () => {
    const inspection = inspectPdf(buildPdf());

    const scanned = diagnose(inspection, { textExtraction: 'none' });
    expect(scanned.level).toBe('ok');
    expect(scanned.action).toBe('ocr');
    expect(scanned.recommendation).toMatch(/OCR/u);

    expect(diagnose(inspection, { textExtraction: 'text' }).action).toBe('open');
    expect(diagnose(inspection).action).toBe('open');
  });
});

// --- Contract --------------------------------------------------------------

describe('the report contract', () => {
  it('is deterministic for the same bytes', () => {
    const bytes = buildPdf({ encrypted: true, appended: '\n' });

    expect(JSON.stringify(inspectPdf(bytes.slice()))).toBe(JSON.stringify(inspectPdf(bytes)));
    expect(diagnose(inspectPdf(bytes))).toEqual(diagnose(inspectPdf(bytes)));
  });

  it('gives every finding a code, a severity and one English sentence', () => {
    const text = buildPdfText();
    const cutOff = bytesOf(text.slice(0, text.indexOf('\nxref\n') + 1));
    const reproductions: readonly Uint8Array[] = [
      buildPdf({ omitStartXref: true }),
      buildPdf({ omitTrailer: true }),
      buildPdf({ omitEof: true }),
      buildPdf({ encrypted: true }),
      cutOff,
    ];

    for (const bytes of reproductions) {
      const inspection = inspectPdf(bytes);
      expect(inspection.problems.length).toBeGreaterThan(0);

      for (const problem of inspection.problems) {
        expect(problem.code).toMatch(/^[a-z-]+$/u);
        expect(['warning', 'error']).toContain(problem.severity);
        expect(problem.message.length).toBeGreaterThan(20);
        expect(problem.message.endsWith('.')).toBe(true);
      }
    }
  });
});
