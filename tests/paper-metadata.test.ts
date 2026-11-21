import { describe, expect, it } from 'vitest';
import { parseBibTeX } from '../src/core/bibtex';
import { buildDocument } from '../src/core/ir';
import type { BuildBlockInput, DocumentIR } from '../src/core/ir';
import type { DocumentMetadata } from '../src/core/metadata';
import { ScholarError } from '../src/core/scholar';
import {
  PaperMetadataError,
  applyEnrichmentReview,
  buildEnrichmentPreview,
  buildPaperLookups,
  buildReferenceLookups,
  createPaperLibrary,
  extractPaperMetadata,
  importReviewedPaper,
  paperToBibTeX,
  referencesToBibTeX,
} from '../src/core/paper-metadata';

const SAMPLE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function makeDoc(blocks: BuildBlockInput[], language = 'en'): DocumentIR {
  const maxPage = blocks.reduce((max, block) => Math.max(max, block.page), 1);
  const pages = Array.from({ length: maxPage }, (_, idx) => ({
    index: idx + 1,
    width: 612,
    height: 792,
  }));
  return buildDocument({
    sourceSha256: SAMPLE_SHA,
    language,
    pages,
    blocks,
  });
}

const CROSSREF_PAYLOAD = {
  status: 'ok',
  message: {
    DOI: '10.1145/3544548.3581234',
    title: ['Structured Document Translation with Layout Guarantees'],
    author: [
      { given: 'Linh', family: 'Nguyen' },
      { given: 'David', family: 'Miller' },
    ],
    'container-title': ['Proceedings of the ACM Conference on Document Engineering'],
    issued: { 'date-parts': [[2024, 5, 14]] },
    'is-referenced-by-count': 42,
    reference: [
      {
        unstructured: 'Vaswani, A., & Shazeer, N. (2017). Attention Is All You Need. NeurIPS.',
        DOI: '10.48550/arXiv.1706.03762',
      },
    ],
  },
};

const SEMANTIC_SCHOLAR_PAYLOAD = {
  paperId: 's2-doc-1',
  title: 'Structured Document Translation with Layout Guarantees',
  authors: [
    { authorId: '1', name: 'Linh Nguyen' },
    { authorId: '2', name: 'David Miller' },
  ],
  venue: 'DocEng',
  year: 2024,
  abstract: 'Canonical abstract from Semantic Scholar covering layout-preserving translation.',
  citationCount: 45,
  externalIds: {
    DOI: '10.1145/3544548.3581234',
    ArXiv: '2401.12345',
  },
  references: [
    { paperId: 'r1', title: 'Attention Is All You Need' },
  ],
};

describe('extractPaperMetadata', () => {
  it('extracts title, authors, venue, year, DOI, arXiv ID, abstract, keywords, and references from DocumentIR', () => {
    const ir = makeDoc([
      {
        page: 1,
        type: 'other',
        text: 'arXiv:2401.12345v2 [cs.CL] 15 Jan 2024',
        rect: { x: 40, y: 20, width: 300, height: 12 },
      },
      {
        page: 1,
        type: 'heading',
        text: 'Structured Document Translation with Layout Guarantees',
        rect: { x: 60, y: 60, width: 480, height: 28 },
      },
      {
        page: 1,
        type: 'paragraph',
        text: 'Linh Nguyen1*, David Miller2, and Hana Sato1',
        rect: { x: 80, y: 100, width: 420, height: 16 },
      },
      {
        page: 1,
        type: 'paragraph',
        text: '1 University of Science; 2 Research Institute; linh@example.edu',
        rect: { x: 80, y: 122, width: 420, height: 14 },
      },
      {
        page: 1,
        type: 'footnote',
        text: 'Published in Proceedings of the ACM Conference on Document Engineering (DocEng 2024). DOI: https://doi.org/10.1145/3544548.3581234',
        rect: { x: 40, y: 740, width: 520, height: 24 },
      },
      {
        page: 1,
        type: 'heading',
        text: 'Abstract',
        rect: { x: 60, y: 170, width: 120, height: 16 },
      },
      {
        page: 1,
        type: 'paragraph',
        text: 'We present a layout-preserving PDF translation pipeline that keeps tables and equations aligned.',
        rect: { x: 60, y: 192, width: 480, height: 48 },
      },
      {
        page: 1,
        type: 'paragraph',
        text: 'Keywords: PDF translation, layout analysis, academic documents',
        rect: { x: 60, y: 250, width: 400, height: 14 },
      },
      {
        page: 1,
        type: 'heading',
        text: '1. Introduction',
        rect: { x: 60, y: 290, width: 180, height: 16 },
      },
      {
        page: 1,
        type: 'paragraph',
        text: 'Academic PDFs mix multi-column prose with mathematical notation.',
        rect: { x: 60, y: 315, width: 480, height: 32 },
      },
      {
        page: 2,
        type: 'heading',
        text: 'References',
        rect: { x: 60, y: 60, width: 140, height: 18 },
      },
      {
        page: 2,
        type: 'list',
        text: '[1] Vaswani, A., & Shazeer, N. (2017). Attention Is All You Need. Advances in Neural Information Processing Systems. doi:10.48550/arXiv.1706.03762',
        rect: { x: 60, y: 90, width: 480, height: 32 },
      },
      {
        page: 2,
        type: 'list',
        text: '[2] J. Devlin, M. Chang, K. Lee, and K. Toutanova, "BERT: Pre-training of Deep Bidirectional Transformers," in NAACL, 2019. https://arxiv.org/abs/1810.04805',
        rect: { x: 60, y: 130, width: 480, height: 32 },
      },
      {
        page: 2,
        type: 'heading',
        text: 'Appendix A. Hyperparameters',
        rect: { x: 60, y: 200, width: 220, height: 16 },
      },
      {
        page: 2,
        type: 'paragraph',
        text: 'Learning rate was 3e-4 across all runs.',
        rect: { x: 60, y: 224, width: 300, height: 16 },
      },
    ]);

    const meta = extractPaperMetadata(ir);
    expect(meta.title).toBe('Structured Document Translation with Layout Guarantees');
    expect(meta.authors).toEqual(['Linh Nguyen', 'David Miller', 'Hana Sato']);
    expect(meta.doi).toBe('10.1145/3544548.3581234');
    expect(meta.arxiv).toBe('2401.12345');
    expect(meta.year).toBe(2024);
    expect(meta.venue).toBe('Proceedings of the ACM Conference on Document Engineering (DocEng 2024)');
    expect(meta.abstract).toBe(
      'We present a layout-preserving PDF translation pipeline that keeps tables and equations aligned.',
    );
    expect(meta.keywords).toEqual(['PDF translation', 'layout analysis', 'academic documents']);
    expect(meta.references).toHaveLength(2);
    expect(meta.references[0]).toMatchObject({
      index: 0,
      marker: '[1]',
      year: 2017,
      title: 'Attention Is All You Need',
      doi: '10.48550/arXiv.1706.03762',
      arxiv: '1706.03762',
    });
    expect(meta.references[1]).toMatchObject({
      index: 1,
      marker: '[2]',
      year: 2019,
      title: 'BERT: Pre-training of Deep Bidirectional Transformers',
      arxiv: '1810.04805',
    });
  });

  it('does not mistake a cited paper DOI or arXiv ID inside References for the paper own identifiers', () => {
    const ir = makeDoc([
      {
        page: 1,
        type: 'heading',
        text: 'An Unpublished Technical Note',
        rect: { x: 50, y: 60, width: 320, height: 24 },
      },
      {
        page: 1,
        type: 'paragraph',
        text: 'Alice Example',
        rect: { x: 50, y: 95, width: 150, height: 14 },
      },
      {
        page: 1,
        type: 'paragraph',
        text: 'Abstract: Short summary without external identifiers.',
        rect: { x: 50, y: 130, width: 400, height: 28 },
      },
      {
        page: 2,
        type: 'heading',
        text: 'References',
        rect: { x: 50, y: 60, width: 120, height: 16 },
      },
      {
        page: 2,
        type: 'paragraph',
        text: '[1] Cited Work. 2020. doi:10.1000/cited-only\n[2] Another Work. arXiv:2205.00001',
        rect: { x: 50, y: 90, width: 450, height: 48 },
      },
    ]);

    const meta = extractPaperMetadata(ir);
    expect(meta.doi).toBeUndefined();
    expect(meta.arxiv).toBeUndefined();
    expect(meta.abstract).toBe('Short summary without external identifiers.');
    expect(meta.references).toHaveLength(2);
    expect(meta.references[0]?.doi).toBe('10.1000/cited-only');
    expect(meta.references[1]?.arxiv).toBe('2205.00001');
  });

  it('keeps semicolon-separated Family, Given authors intact and falls back to non-placeholder PDF metadata', () => {
    const ir = makeDoc([
      {
        page: 1,
        type: 'paragraph',
        text: 'Just body prose on a scanned page with no heading block.',
        rect: { x: 50, y: 80, width: 400, height: 20 },
      },
    ]);

    const placeholderPdfMeta: DocumentMetadata = {
      title: 'Microsoft Word - draft-v2.docx',
      authors: ['Nguyen, Van An', 'Doe, Jane'],
      subject: null,
      keywords: ['alignment', 'ocr'],
      creator: null,
      producer: null,
      creationDate: null,
      modificationDate: null,
      language: 'en',
      found: ['Title', 'Author', 'Keywords'],
    };

    const fallbackFromFilename = extractPaperMetadata(ir, {
      pdfMetadata: placeholderPdfMeta,
      filename: 'papers/neural-ocr-survey.pdf',
    });
    expect(fallbackFromFilename.title).toBe('neural ocr survey');
    expect(fallbackFromFilename.authors).toEqual(['Nguyen, Van An', 'Doe, Jane']);
    expect(fallbackFromFilename.keywords).toEqual(['alignment', 'ocr']);

    const irWithInvertedAuthors = makeDoc([
      {
        page: 1,
        type: 'heading',
        text: 'Vietnamese Historical Texts',
        rect: { x: 50, y: 50, width: 320, height: 24 },
      },
      {
        page: 1,
        type: 'paragraph',
        text: 'Nguyen, Van An; Tran, Minh Duc',
        rect: { x: 50, y: 85, width: 280, height: 16 },
      },
    ]);
    expect(extractPaperMetadata(irWithInvertedAuthors).authors).toEqual([
      'Nguyen, Van An',
      'Tran, Minh Duc',
    ]);
  });

  it('returns an honest empty extraction on a blockless DocumentIR', () => {
    const ir = makeDoc([]);
    const meta = extractPaperMetadata(ir);
    expect(meta.title).toBeNull();
    expect(meta.authors).toEqual([]);
    expect(meta.doi).toBeUndefined();
    expect(meta.arxiv).toBeUndefined();
    expect(meta.abstract).toBeUndefined();
    expect(meta.venue).toBeUndefined();
    expect(meta.year).toBeUndefined();
    expect(meta.references).toEqual([]);
  });
});

describe('lookup requests', () => {
  it('builds Crossref and Semantic Scholar lookup URLs via scholar.ts for DOI and arXiv identifiers', () => {
    const both = buildPaperLookups({
      title: 'T',
      authors: [],
      doi: '10.1145/3544548.3581234',
      arxiv: '2401.12345',
      keywords: [],
      references: [],
    });
    expect(both.canLookup).toBe(true);
    expect(both.primary?.kind).toBe('doi');
    expect(both.primary?.crossref).toBe('https://api.crossref.org/works/10.1145/3544548.3581234');
    expect(both.primary?.semanticScholar).toContain('/paper/DOI:10.1145/3544548.3581234?fields=');
    expect(both.fallbackArxiv?.kind).toBe('arxiv');
    expect(both.fallbackArxiv?.semanticScholar).toContain('/paper/ARXIV:2401.12345?fields=');

    const arxivOnly = buildPaperLookups({
      title: 'T',
      authors: [],
      arxiv: '1706.03762',
      keywords: [],
      references: [],
    });
    expect(arxivOnly.canLookup).toBe(true);
    expect(arxivOnly.primary?.kind).toBe('arxiv');
    expect(arxivOnly.primary?.crossref).toBeUndefined();
    expect(arxivOnly.primary?.semanticScholar).toContain('/paper/ARXIV:1706.03762?fields=');

    const none = buildPaperLookups({
      title: 'Only a Title',
      authors: ['Someone'],
      keywords: [],
      references: [],
    });
    expect(none.canLookup).toBe(false);
    expect(none.primary).toBeNull();
    expect(none.reason).toBeTruthy();
  });

  it('builds lookups only for extracted references that carry a DOI or arXiv ID', () => {
    const lookups = buildReferenceLookups([
      { index: 0, raw: 'No identifier work', title: 'No identifier work' },
      { index: 1, raw: 'With DOI', doi: '10.1000/ref-1' },
      { index: 2, raw: 'With arXiv', arxiv: '1810.04805' },
    ]);
    expect(lookups).toHaveLength(2);
    expect(lookups[0]?.referenceIndex).toBe(1);
    expect(lookups[0]?.lookup.crossref).toBe('https://api.crossref.org/works/10.1000/ref-1');
    expect(lookups[1]?.referenceIndex).toBe(2);
    expect(lookups[1]?.lookup.semanticScholar).toContain('ARXIV:1810.04805');
  });
});

describe('enrichment review preview and library import gate', () => {
  it('merges Crossref and Semantic Scholar payloads via scholar.ts and builds an explicit review preview', () => {
    const ir = makeDoc([
      {
        page: 1,
        type: 'heading',
        text: 'Structured Document Translation (Preprint Draft)',
        rect: { x: 40, y: 50, width: 420, height: 24 },
      },
      {
        page: 1,
        type: 'paragraph',
        text: 'Linh Nguyen',
        rect: { x: 40, y: 90, width: 160, height: 16 },
      },
      {
        page: 1,
        type: 'paragraph',
        text: 'Abstract: Local PDF abstract preserved during extraction.',
        rect: { x: 40, y: 120, width: 420, height: 32 },
      },
      {
        page: 1,
        type: 'footnote',
        text: 'DOI: 10.1145/3544548.3581234',
        rect: { x: 40, y: 740, width: 240, height: 14 },
      },
    ]);
    const extracted = extractPaperMetadata(ir);

    const preview = buildEnrichmentPreview(extracted, {
      crossref: CROSSREF_PAYLOAD,
      semanticScholar: SEMANTIC_SCHOLAR_PAYLOAD,
    });

    expect(preview.requiresReview).toBe(true);
    expect(preview.proposed.title).toBe('Structured Document Translation with Layout Guarantees');
    expect(preview.proposed.authors).toEqual(['Linh Nguyen', 'David Miller']);
    expect(preview.proposed.venue).toBe('Proceedings of the ACM Conference on Document Engineering');
    expect(preview.proposed.year).toBe(2024);
    expect(preview.proposed.arxiv).toBe('2401.12345');
    expect(preview.proposed.abstract).toBe(
      'Canonical abstract from Semantic Scholar covering layout-preserving translation.',
    );

    const titleDiff = preview.changes.find(change => change.field === 'title');
    expect(titleDiff).toMatchObject({
      field: 'title',
      localValue: 'Structured Document Translation (Preprint Draft)',
      enrichedValue: 'Structured Document Translation with Layout Guarantees',
      source: 'crossref',
      status: 'updated',
      hasConflict: true,
    });

    const venueDiff = preview.changes.find(change => change.field === 'venue');
    expect(venueDiff).toMatchObject({
      field: 'venue',
      localValue: undefined,
      enrichedValue: 'Proceedings of the ACM Conference on Document Engineering',
      source: 'crossref',
      status: 'added',
      hasConflict: false,
    });

    const arxivDiff = preview.changes.find(change => change.field === 'arxiv');
    expect(arxivDiff?.source).toBe('semanticscholar');
    expect(preview.summary.conflicts).toBeGreaterThanOrEqual(2);
    expect(parseBibTeX(preview.bibtexPreview).errors).toEqual([]);
  });

  it('refuses library import when review is not approved, and applies per-field choices once approved', () => {
    const ir = makeDoc([
      {
        page: 1,
        type: 'heading',
        text: 'Draft Title',
        rect: { x: 40, y: 50, width: 200, height: 24 },
      },
      {
        page: 1,
        type: 'paragraph',
        text: 'Linh Nguyen',
        rect: { x: 40, y: 80, width: 150, height: 14 },
      },
      {
        page: 1,
        type: 'paragraph',
        text: 'Abstract: Local abstract text that the reviewer prefers.',
        rect: { x: 40, y: 110, width: 400, height: 24 },
      },
    ]);
    const extracted = extractPaperMetadata(ir);
    const preview = buildEnrichmentPreview(extracted, {
      crossref: CROSSREF_PAYLOAD,
      semanticScholar: SEMANTIC_SCHOLAR_PAYLOAD,
    });

    const library = createPaperLibrary();

    expect(() => importReviewedPaper(library, preview, { approved: false })).toThrowError(
      PaperMetadataError,
    );
    expect(library.list()).toHaveLength(0);

    expect(() => applyEnrichmentReview(preview, { approved: false })).toThrowError(
      PaperMetadataError,
    );

    const imported = importReviewedPaper(library, preview, {
      approved: true,
      fieldChoices: {
        abstract: 'local',
      },
    });

    expect(library.list()).toHaveLength(1);
    expect(imported.record.title).toBe('Structured Document Translation with Layout Guarantees');
    expect(imported.record.abstract).toBe('Local abstract text that the reviewer prefers.');
    expect(imported.entry.key).toBe('nguyen2024structured');
    expect(parseBibTeX(imported.bibtex).errors).toEqual([]);
  });

  it('propagates ScholarError on malformed Crossref or Semantic Scholar payloads', () => {
    const extracted = extractPaperMetadata(makeDoc([]));
    expect(() =>
      buildEnrichmentPreview(extracted, {
        crossref: { message: { title: 'not-valid' } },
      }),
    ).not.toThrow();

    expect(() =>
      buildEnrichmentPreview(extracted, {
        crossref: { status: 'broken' },
      }),
    ).toThrowError(ScholarError);

    expect(() =>
      buildEnrichmentPreview(extracted, {
        semanticScholar: { authors: 'wrong-type', title: 'X' },
      }),
    ).toThrowError(ScholarError);
  });
});

describe('BibTeX emission', () => {
  it('emits valid BibTeX for extracted metadata and extracted bibliography references', () => {
    const ir = makeDoc([
      {
        page: 1,
        type: 'heading',
        text: 'Attention Is All You Need',
        rect: { x: 40, y: 50, width: 320, height: 24 },
      },
      {
        page: 1,
        type: 'paragraph',
        text: 'Ashish Vaswani, Noam Shazeer',
        rect: { x: 40, y: 85, width: 260, height: 14 },
      },
      {
        page: 1,
        type: 'footnote',
        text: 'Advances in Neural Information Processing Systems (NeurIPS 2017). doi:10.48550/arXiv.1706.03762',
        rect: { x: 40, y: 740, width: 480, height: 16 },
      },
      {
        page: 2,
        type: 'heading',
        text: 'References',
        rect: { x: 40, y: 50, width: 120, height: 16 },
      },
      {
        page: 2,
        type: 'list',
        text: '[1] Hochreiter, S., & Schmidhuber, J. (1997). Long Short-Term Memory. Neural Computation.',
        rect: { x: 40, y: 80, width: 480, height: 20 },
      },
      {
        page: 2,
        type: 'list',
        text: '[2] Bahdanau, D., Cho, K., & Bengio, Y. (2015). Neural Machine Translation by Jointly Learning to Align and Translate. ICLR. arXiv:1409.0473',
        rect: { x: 40, y: 110, width: 480, height: 24 },
      },
    ]);

    const extracted = extractPaperMetadata(ir);
    const paperBib = paperToBibTeX(extracted);
    const parsedPaper = parseBibTeX(paperBib);
    expect(parsedPaper.errors).toEqual([]);
    expect(parsedPaper.entries).toHaveLength(1);
    expect(parsedPaper.entries[0]?.key).toBe('vaswani2017attention');
    expect(parsedPaper.entries[0]?.fields.doi).toBe('10.48550/arXiv.1706.03762');
    expect(parsedPaper.entries[0]?.fields.eprint).toBe('1706.03762');
    expect(parsedPaper.entries[0]?.fields.archiveprefix).toBe('arXiv');

    const refsBib = referencesToBibTeX(extracted.references);
    const parsedRefs = parseBibTeX(refsBib);
    expect(parsedRefs.errors).toEqual([]);
    expect(parsedRefs.entries).toHaveLength(2);
    expect(parsedRefs.entries[0]?.fields.year).toBe('1997');
    expect(parsedRefs.entries[1]?.fields.eprint).toBe('1409.0473');
  });
});
