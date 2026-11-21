import { describe, expect, it } from 'vitest';
import {
  MetadataCache,
  ResearchLibrary,
  ResearchNoteStore,
  buildResearchMatrix,
  buildStudyPack,
  cleanPaper,
  enrichMetadata,
  entriesFromRis,
  toRis,
  exportBibliography,
  fromResearchMatrixJson,
  fromStudyPackJson,
  importBibliography,
  matrixToMarkdown,
  parseRis,
  reflowPaper,
  researchPaperToEntry,
  toResearchMatrixJson,
  toStudyPackJson,
  zoteroItemsToPapers,
  type EvidenceBlock,
  type ResearchPaper,
} from '../src/core/research';

const blocks: EvidenceBlock[] = [
  { id: 'p1-r0', paperId: 'paper-1', page: 1, revisionId: 'rev-1', sourceSha256: 'a'.repeat(64), text: 'We use a contrastive method on the SQuAD dataset.', section: 'Method', type: 'paragraph' },
  { id: 'p1-r1', paperId: 'paper-1', page: 2, revisionId: 'rev-1', sourceSha256: 'a'.repeat(64), text: 'The formula E = mc^2 remains unchanged.', section: 'Theory', type: 'formula' },
  { id: 'p2-r0', paperId: 'paper-1', page: 3, revisionId: 'rev-1', sourceSha256: 'a'.repeat(64), text: '1. The footnote preserves its citation [3].', section: 'Notes', type: 'footnote' },
];

function paper(id = 'paper-1'): ResearchPaper {
  return {
    paperId: id,
    title: 'A paper',
    authors: ['Doe, Jane'],
    venue: 'Journal',
    year: 2024,
    doi: '10.1000/example',
    topics: ['retrieval'],
    tags: ['seed'],
    references: [],
    metadataReceipts: [],
    sourceHistory: [],
    rawImports: [],
  };
}

describe('RIS and exchange', () => {
  it('parses repeated authors, CRLF, unknown tags, and exports a canonical round trip', () => {
    const source = 'TY  - JOUR\r\nAU  - Doe, Jane\r\nAU  - Roe, John\r\nTI  - A title\r\nDO  - https://doi.org/10.1000/X\r\nZZ  - preserved\r\nER  -\r\n';
    const parsed = parseRis(source);
    expect(parsed.errors).toEqual([]);
    expect(parsed.records[0]?.fields).toContainEqual({ tag: 'ZZ', value: 'preserved' });
    const entries = entriesFromRis(source).entries;
    expect(entries[0]?.fields.author).toBe('Doe, Jane and Roe, John');
    expect(entries[0]?.fields.doi).toBe('10.1000/X');
    const reread = importBibliography(toRis(parsed.records), 'ris');
    expect(reread.entries[0]?.fields.title).toBe('A title');
  });

  it('exports a research paper without exporting evidence as bibliography fields', () => {
    const entry = researchPaperToEntry(paper());
    expect(exportBibliography([entry], 'bibtex')).toContain('10.1000/example');
    expect(exportBibliography([entry], 'ris')).toContain('DO  - 10.1000/example');
    expect(entry.fields).not.toHaveProperty('sourceSha256');
  });
});

describe('consented enrichment', () => {
  it('never calls fetch in offline mode and reports an explicit offline state', async () => {
    let calls = 0;
    const result = await enrichMetadata('10.1000/example', { mode: 'offline', fetch: async () => { calls += 1; return new Response('{}'); } });
    expect(calls).toBe(0);
    expect(result.state).toBe('offline');
    expect(result.receipts.every(receipt => receipt.status === 'offline')).toBe(true);
  });

  it('requires explicit consent before metadata network access', async () => {
    let calls = 0;
    const result = await enrichMetadata('10.1000/example', { mode: 'consent', consent: false, fetch: async () => { calls += 1; return new Response('{}'); } });
    expect(calls).toBe(0);
    expect(result.state).toBe('consent-required');
    expect(result.receipts.every(receipt => receipt.status === 'denied')).toBe(true);
  });

  it('parses both providers, records provenance, and reuses the cache offline', async () => {
    const cache = new MetadataCache();
    const calls: string[] = [];
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      calls.push(url);
      if (url.includes('crossref')) return new Response(JSON.stringify({ message: { DOI: '10.1000/example', title: ['A paper'], author: [{ family: 'Doe', given: 'Jane' }], 'container-title': ['Journal'], issued: { 'date-parts': [[2024]] } } }), { status: 200 });
      return new Response(JSON.stringify({ title: 'A paper', authors: [{ name: 'Jane Doe' }], year: 2024, abstract: 'An abstract', externalIds: { DOI: '10.1000/example' } }), { status: 200 });
    };
    const first = await enrichMetadata('10.1000/example', { mode: 'consent', consent: true, fetch: fetcher, cache, now: () => '2026-01-01T00:00:00.000Z' });
    expect(first.state).toBe('enriched');
    expect(first.record?.title).toBe('A paper');
    expect(first.receipts.filter(receipt => receipt.status === 'ok')).toHaveLength(2);
    expect(calls).toHaveLength(2);
    const second = await enrichMetadata('10.1000/example', { mode: 'offline', cache });
    expect(second.state).toBe('cached');
    expect(second.fromCache).toBe(true);
    expect(second.record?.abstract).toBe('An abstract');
    expect(calls).toHaveLength(2);
  });
});

describe('evidence, notes, paper mode, and study packs', () => {
  it('links every matrix cell to an exact page/block anchor and distinguishes unknown values', () => {
    const matrix = buildResearchMatrix(
      [{ paperId: 'paper-1', title: 'A paper', blocks }],
      [{ id: 'method', label: 'Method', keywords: ['contrastive'] }, { id: 'metric', label: 'Metric', keywords: ['accuracy'] }],
    );
    expect(matrix.cells[0]?.evidence).toMatchObject({ status: 'supported', anchor: { page: 1, blockId: 'p1-r0', quote: blocks[0]?.text } });
    expect(matrix.gaps[0]).toMatchObject({ status: 'unknown' });
    expect(fromResearchMatrixJson(toResearchMatrixJson(matrix))).toEqual(matrix);
    expect(matrixToMarkdown(matrix)).toContain('p.1/p1-r0');
  });

  it('keeps notes addressable by paper, block, and citation', () => {
    const store = new ResearchNoteStore({ now: () => '2026-01-01T00:00:00.000Z' });
    const note = store.add({ paperId: 'paper-1', text: 'Review this', kind: 'note', citationIds: ['cite-1'], anchors: [{ status: 'supported', anchor: { paperId: 'paper-1', page: 1, blockId: 'p1-r0', anchorKind: 'block', quote: blocks[0]?.text } }] });
    expect(store.backlinks({ blockId: 'p1-r0' })).toHaveLength(1);
    expect(store.backlinks({ citationId: 'cite-1' })[0]?.noteId).toBe(note.noteId);
    const restored = new ResearchNoteStore({ now: () => '2026-01-01T00:00:00.000Z' });
    expect(restored.importJson(store.toJson()).imported).toBe(1);
  });

  it('preserves formulas, footnotes, citations, and source anchors while reflowing', () => {
    const clean = cleanPaper(blocks, 'paper-1');
    expect(clean.preserved.formulas).toEqual(['The formula E = mc^2 remains unchanged.']);
    expect(clean.preserved.footnotes[0]).toContain('[3]');
    expect(clean.preserved.citations).toContain('[3]');
    const reflowed = reflowPaper(clean, { maxCharsPerLine: 18 });
    expect(reflowed.blocks.every(block => block.evidence.anchor?.blockId)).toBe(true);
    expect(reflowed.blocks.find(block => block.type === 'formula')?.lines.join(' ')).toContain('E = mc^2');
  });

  it('creates versioned evidence-linked study artifacts', () => {
    const pack = buildStudyPack({ packId: 'pack-1', paperId: 'paper-1', title: 'Study', blocks, maxCards: 2 });
    expect(pack.version).toBe(1);
    expect(pack.flashcards).toHaveLength(2);
    expect(pack.flashcards.every(card => card.evidence.anchor?.blockId)).toBe(true);
    expect(fromStudyPackJson(toStudyPackJson(pack))).toEqual(pack);
  });
});

describe('research library', () => {
  it('filters collections and requires confirmation before duplicate merge', () => {
    const library = new ResearchLibrary({ now: () => '2026-01-01T00:00:00.000Z' });
    library.addPaper(paper('p1'));
    library.addPaper({ ...paper('p2'), title: 'A paper copy', tags: ['other'], sourceHistory: [{ action: 'imported', at: '2025-01-01T00:00:00.000Z', source: 'bibtex' }] });
    library.upsertCollection({ collectionId: 'retrieval', name: 'Retrieval', filter: { topics: ['retrieval'] }, paperIds: [] });
    expect(library.queryCollection('retrieval')).toHaveLength(2);
    const candidate = library.proposeDuplicates()[0];
    expect(candidate).toMatchObject({ reason: 'doi', confirmed: false });
    const preview = library.mergeDuplicate(candidate!, false);
    expect(preview.merged).toBe(false);
    expect(library.listPapers()).toHaveLength(2);
    const merged = library.mergeDuplicate(candidate!, true);
    expect(merged.merged).toBe(true);
    expect(library.listPapers()).toHaveLength(1);
    expect(merged.paper?.sourceHistory.some(entry => entry.action === 'merged')).toBe(true);
    expect(merged.paper?.metadataReceipts).toEqual([]);
  });

  it('imports selected Zotero items with external provenance', () => {
    const papers = zoteroItemsToPapers(JSON.stringify([{ key: 'ABC123', library: { name: 'Research' }, data: { title: 'Zotero paper', creators: [{ firstName: 'Jane', lastName: 'Doe' }], DOI: '10.1000/zotero', date: '2023-04-01', publicationTitle: 'Venue', tags: [{ tag: 'topic' }] } }]));
    expect(papers[0]).toMatchObject({ paperId: 'zotero:ABC123', doi: '10.1000/zotero', venue: 'Venue', year: 2023, tags: ['topic'] });
    expect(papers[0]?.metadataReceipts[0]?.provider).toBe('zotero');
  });
});
