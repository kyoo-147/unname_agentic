import { describe, expect, it } from 'vitest';
import { buildDocument, type Block, type DocumentIR } from '../src/core/ir';
import {
  BM25_B,
  BM25_K1,
  CHUNK_MAX_CHARS,
  DEFAULT_SEARCH_LIMIT,
  HEADING_TERM_WEIGHT,
  chunkDocument,
  index,
  search,
  tokenize,
} from '../src/core/retrieval';

interface Spec {
  text: string;
  type?: Block['type'];
  page?: number;
}

/**
 * Builds a document whose blocks stack top to bottom on the page, so the reading order
 * the IR derives is the order they were passed in and the ids are `p{page}-r{rank}`.
 */
function document(specs: readonly Spec[], documentId = 'doc-1'): DocumentIR {
  return buildDocument({
    sourceSha256: 'a'.repeat(64),
    documentId,
    language: 'en',
    pages: [1, 2, 3].map(page => ({ index: page, width: 612, height: 792 })),
    blocks: specs.map((spec, position) => ({
      page: spec.page ?? 1,
      text: spec.text,
      type: spec.type ?? 'paragraph',
      rect: { x: 72, y: 72 + position * 40, width: 468, height: 24 },
    })),
  });
}

/** Splits a passage back into sentences, which is how the overlap is checked. */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=\.)\s+/u);
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('chunkDocument: structure first', () => {
  it('makes one passage per outline section and never crosses a section boundary', () => {
    const ir = document([
      { text: '1 Introduction', type: 'heading' },
      { text: 'Opening paragraph about the problem.' },
      { text: '2 Methods', type: 'heading' },
      { text: 'Methods paragraph about the approach.' },
      { text: 'Second methods paragraph.' },
    ]);

    const chunks = chunkDocument(ir);
    expect(chunks.map(chunk => chunk.kind)).toEqual(['section', 'section']);
    expect(chunks.map(chunk => chunk.text)).toEqual([
      'Opening paragraph about the problem.',
      'Methods paragraph about the approach.\nSecond methods paragraph.',
    ]);
    // The heading is carried by the path, not repeated in the passage text.
    expect(chunks.map(chunk => chunk.headingPath)).toEqual([['1 Introduction'], ['2 Methods']]);
    expect(chunks.map(chunk => chunk.blockIds)).toEqual([['p1-r1'], ['p1-r3', 'p1-r4']]);
    expect(chunks.map(chunk => chunk.id)).toEqual(['doc-1:c1', 'doc-1:c2']);
    expect(chunks.map(chunk => chunk.page)).toEqual([1, 1]);
    expect(chunks.every(chunk => chunk.documentId === 'doc-1')).toBe(true);
    expect(chunks.every(chunk => !chunk.text.includes('1 Introduction'))).toBe(true);
  });

  it('gives content before the first heading an empty heading path', () => {
    const ir = document([
      { text: 'A preamble paragraph before any heading.' },
      { text: '1 Scope', type: 'heading' },
      { text: 'Scope paragraph.' },
    ]);

    const chunks = chunkDocument(ir);
    expect(chunks.map(chunk => chunk.headingPath)).toEqual([[], ['1 Scope']]);
    expect(chunks.map(chunk => chunk.text)).toEqual([
      'A preamble paragraph before any heading.',
      'Scope paragraph.',
    ]);
  });

  it('falls back to one passage per block when the document has no headings', () => {
    const ir = document([
      { text: 'First block.' },
      { text: 'Second block.' },
      { text: '   ' },
    ]);

    const chunks = chunkDocument(ir);
    expect(chunks.map(chunk => chunk.kind)).toEqual(['block', 'block']);
    expect(chunks.map(chunk => chunk.text)).toEqual(['First block.', 'Second block.']);
    expect(chunks.map(chunk => chunk.blockIds)).toEqual([['p1-r0'], ['p1-r1']]);
    expect(chunks.map(chunk => chunk.headingPath)).toEqual([[], []]);
  });

  it('returns no passages for a document without blocks', () => {
    expect(chunkDocument(document([]))).toEqual([]);
  });
});

describe('chunkDocument: tables', () => {
  const tableText = ['Region\tRevenue\tGrowth', 'North\t120\t4.5', 'South\t90\t3.2'].join('\n');

  function tableDocument(): DocumentIR {
    return document([
      { text: 'Table 2: Turnover by region', type: 'other' },
      { text: tableText, type: 'table' },
      { text: 'The table above summarises the two regions.' },
    ]);
  }

  it('gives a table its own passage with its CSV and the caption that names it', () => {
    const chunks = chunkDocument(tableDocument());
    expect(chunks.map(chunk => chunk.kind)).toEqual(['table', 'block']);

    const table = chunks[0];
    expect(table?.text).toBe(
      'Table 2: Turnover by region\nRegion,Revenue,Growth\nNorth,120,4.5\nSouth,90,3.2',
    );
    // The caption block belongs to the table passage, not to the prose around it.
    expect(table?.blockIds).toEqual(['p1-r0', 'p1-r1']);
    expect(table?.page).toBe(1);
    expect(table?.headingPath).toEqual([]);
  });

  it('makes the table retrievable by a word only its caption carries', () => {
    const hits = search(index(chunkDocument(tableDocument())), 'turnover');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.chunk.kind).toBe('table');
    expect(hits[0]?.matchedTerms).toEqual(['turnover']);

    // And by a column header from the CSV, which no other passage holds.
    const byHeader = search(index(chunkDocument(tableDocument())), 'revenue');
    expect(byHeader).toHaveLength(1);
    expect(byHeader[0]?.chunk.kind).toBe('table');
  });

  it('keeps its own passage when the document has headings', () => {
    const ir = document([
      { text: '2 Results', type: 'heading' },
      { text: 'Table 2: Turnover by region', type: 'other' },
      { text: tableText, type: 'table' },
      { text: 'A short reading of the numbers follows.' },
    ]);

    const chunks = chunkDocument(ir);
    expect(chunks.map(chunk => chunk.kind)).toEqual(['table', 'section']);
    expect(chunks[0]?.headingPath).toEqual(['2 Results']);
    expect(chunks[0]?.text.startsWith('Table 2: Turnover by region\n')).toBe(true);
    expect(chunks[1]?.text).toBe('A short reading of the numbers follows.');
  });
});

describe('chunkDocument: long passages', () => {
  function longSentences(count: number): string[] {
    return Array.from(
      { length: count },
      (_, at) =>
        `Sentence ${at + 1} carries the argument a little further before the next one starts, and it keeps the passage long enough to matter.`,
    );
  }

  it('splits a long block on sentence boundaries with one sentence of overlap', () => {
    const sentences = longSentences(14);
    const ir = document([{ text: sentences.join(' ') }]);

    const chunks = chunkDocument(ir);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(chunk.kind).toBe('block');
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
      expect(chunk.blockIds).toEqual(['p1-r0']);
    }

    const first = sentencesOf(chunks[0]?.text ?? '');
    const second = sentencesOf(chunks[1]?.text ?? '');
    // The boundary repeats exactly one sentence: the last of the first passage.
    expect(second[0]).toBe(first[first.length - 1]);
    expect(first.length).toBeGreaterThan(1);

    // Every sentence survives, none is invented and none is dropped.
    const numbers = new Set(
      [...first, ...second].map(sentence => sentence.match(/^Sentence (\d+)/u)?.[1] ?? ''),
    );
    expect(numbers.size).toBe(14);
    expect([...first, ...second].some(sentence => sentence.includes('Sentence 15'))).toBe(false);
  });

  it('never splits inside a formula run', () => {
    const before = Array.from(
      { length: 6 },
      (_, at) =>
        `Context ${at + 1} explains at length why the measurement matters for the second stage of the pipeline, because the first stage only records what the second one later compares.`,
    );
    const after = Array.from(
      { length: 6 },
      (_, at) =>
        `Result ${at + 1} repeats the same measurement so that the comparison still holds across both stages of the run, whatever the sample looked like.`,
    );
    const formula = String.raw`\[ E = m c^2. F = m a . \]`;
    const ir = document([{ text: [...before, formula, ...after].join(' ') }]);

    const chunks = chunkDocument(ir);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // A cut inside the formula would leave one delimiter without its partner.
      expect(countOf(chunk.text, '\\[')).toBe(countOf(chunk.text, '\\]'));
      // A chunk that holds the opener holds the whole run; the one-sentence overlap
      // may legitimately repeat it in the next passage.
      if (chunk.text.includes('\\[')) expect(chunk.text).toContain('E = m c^2. F = m a');
    }
    expect(chunks.some(chunk => chunk.text.includes('E = m c^2. F = m a'))).toBe(true);
  });

  it('keeps a passage that fits exactly as the page holds it', () => {
    const text = 'We measure $E = m c^2$ and then apply it.\nA second line stays on its own line.';
    const chunks = chunkDocument(document([{ text }]));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(text);
  });
});

describe('index and search', () => {
  function corpusDocument(): DocumentIR {
    return document([
      { text: '1 Cache design', type: 'heading' },
      { text: 'A cache keeps recently used pages in memory so the next read is cheap.' },
      { text: '2 Storage', type: 'heading' },
      { text: 'Storage is persistent. A cache is not persistent; the cache loses its pages on reboot.' },
      { text: '3 Network', type: 'heading' },
      { text: 'The network carries requests between the browser and the server.' },
    ]);
  }

  it('orders BM25 results by how well the passage answers the query', () => {
    const chunks = chunkDocument(corpusDocument());
    const idx = index(chunks);

    expect(idx.averageLength).toBeGreaterThan(0);
    expect(idx.lengths).toHaveLength(chunks.length);
    expect(idx.chunks).toHaveLength(chunks.length);

    const hits = search(idx, 'cache pages');
    expect(hits.map(hit => hit.chunk.headingPath[0])).toEqual(['2 Storage', '1 Cache design']);
    expect(hits[0]?.matchedTerms).toEqual(['cache', 'pages']);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    // The passage about the network shares no query term, so it is not returned.
    expect(hits.some(hit => hit.chunk.headingPath[0] === '3 Network')).toBe(false);

    // Repeating a query term does not change the ranking: terms are scored once.
    expect(search(idx, 'cache cache pages')).toEqual(hits);
  });

  it('uses the documented BM25 constants', () => {
    expect(BM25_K1).toBe(1.5);
    expect(BM25_B).toBe(0.75);
    expect(HEADING_TERM_WEIGHT).toBe(0.5);
    expect(DEFAULT_SEARCH_LIMIT).toBe(10);
    expect(CHUNK_MAX_CHARS).toBe(1200);
  });

  it('matches an accent-less query against an accented document', () => {
    const accented = document([{ text: 'Hệ thống quản lý nhiệt độ của phòng thí nghiệm.' }]);
    const accentedIndex = index(chunkDocument(accented));

    const plain = search(accentedIndex, 'he thong quan ly');
    expect(plain).toHaveLength(1);
    expect(plain[0]?.matchedTerms).toEqual(['he', 'ly', 'quan', 'thong']);

    // The other direction folds the same way: an accented query finds unaccented text.
    const unaccented = document(
      [{ text: 'He thong quan ly nhiet do phong thi nghiem.' }],
      'doc-2',
    );
    expect(search(index(chunkDocument(unaccented)), 'hệ thống quản lý')).toHaveLength(1);

    // `đ` does not decompose under NFD and is folded by hand.
    expect(tokenize('Đường phố')).toEqual(['duong', 'pho']);
    // Punctuation goes, digits stay.
    expect(tokenize('Report 42, page 7.')).toEqual(['report', '42', 'page', '7']);
  });

  it('boosts a term that appears in the heading path', () => {
    const ir = document([
      { text: 'Signal notes', type: 'heading' },
      { text: 'The filter attenuates the signal above ten hertz.' },
      { text: 'Noise notes', type: 'heading' },
      { text: 'The filter attenuates the signal above ten hertz.' },
    ]);
    const idx = index(chunkDocument(ir));

    const hits = search(idx, 'signal');
    expect(hits).toHaveLength(2);
    expect(hits.map(hit => hit.chunk.headingPath[0])).toEqual(['Signal notes', 'Noise notes']);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);

    // A term only the heading carries still retrieves the section it names.
    const byHeading = search(idx, 'noise');
    expect(byHeading).toHaveLength(1);
    expect(byHeading[0]?.chunk.headingPath).toEqual(['Noise notes']);
    expect(byHeading[0]?.score).toBeGreaterThan(0);
  });

  it('exposes search on the index it built', () => {
    const idx = index(chunkDocument(corpusDocument()));
    const throughMethod = idx.search('cache pages', { limit: 1 });
    expect(throughMethod).toEqual(search(idx, 'cache pages', { limit: 1 }));
    expect(throughMethod).toHaveLength(1);
    expect(idx.search('nothing-matches-this')).toEqual([]);
  });

  it('returns nothing for an empty index, an empty query or an unknown term', () => {
    const empty = index([]);
    expect(empty.averageLength).toBe(0);
    expect(empty.postings.size).toBe(0);
    expect(search(empty, 'anything')).toEqual([]);

    const idx = index(chunkDocument(document([{ text: 'Some text about retrieval.' }])));
    expect(search(idx, '')).toEqual([]);
    expect(search(idx, '   !!! ')).toEqual([]);
    expect(search(idx, 'missing')).toEqual([]);
  });

  it('respects limit and defaults to ten hits', () => {
    const specs = Array.from({ length: 12 }, (_, at) => ({
      text: `Report ${at + 1} covers revenue for the period.`,
    }));
    const idx = index(chunkDocument(document(specs)));

    expect(search(idx, 'revenue')).toHaveLength(DEFAULT_SEARCH_LIMIT);
    expect(search(idx, 'revenue', { limit: 3 })).toHaveLength(3);
    expect(search(idx, 'revenue', { limit: 1 })[0]?.chunk.id).toBe('doc-1:c1');
    expect(search(idx, 'revenue', { limit: 0 })).toEqual([]);
    // A limit that makes no sense falls back to the default instead of hiding results.
    expect(search(idx, 'revenue', { limit: -5 })).toHaveLength(DEFAULT_SEARCH_LIMIT);
  });

  it('breaks score ties by page and then by chunk id', () => {
    const acrossPages = document([
      { text: 'The protocol is stable at every step.', page: 1 },
      { text: 'The protocol is stable at every step.', page: 2 },
    ]);
    const hits = search(index(chunkDocument(acrossPages)), 'protocol');
    expect(hits).toHaveLength(2);
    expect(hits[0]?.score).toBe(hits[1]?.score);
    expect(hits.map(hit => hit.chunk.page)).toEqual([1, 2]);
    expect(hits.map(hit => hit.chunk.id)).toEqual(['doc-1:c1', 'doc-1:c2']);

    const samePage = document([
      { text: 'Both halves repeat.' },
      { text: 'Both halves repeat.' },
    ]);
    const tied = search(index(chunkDocument(samePage)), 'halves');
    expect(tied[0]?.score).toBe(tied[1]?.score);
    expect(tied.map(hit => hit.chunk.id)).toEqual(['doc-1:c1', 'doc-1:c2']);
  });
});
