import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDocument, type Block, type DocumentIR } from '../src/core/ir';
import { createGuard } from '../src/core/network-guard';
import { chunkDocument, index as indexBm25, search as searchBm25 } from '../src/core/retrieval';
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_RRF_K,
  HYBRID_INDEX_SCHEMA_VERSION,
  HybridRetrievalError,
  cosineSimilarity,
  createLocalEmbedder,
  deserializeHybridIndex,
  hybridSearch,
  indexChunks,
  indexDocuments,
  l2Normalize,
  matchesMetadataFilter,
  reciprocalRankFusion,
  semanticSearch,
  serializeHybridIndex,
  type LocalEmbedder,
} from '../src/core/hybrid-retrieval';

interface BlockSpec {
  text: string;
  type?: Block['type'];
  page?: number;
  language?: string;
}

function makeDoc(
  specs: readonly BlockSpec[],
  options: { documentId?: string; language?: string } = {},
): DocumentIR {
  const maxPage = specs.reduce((max, spec) => Math.max(max, spec.page ?? 1), 1);
  const pages = Array.from({ length: maxPage }, (_, idx) => ({
    index: idx + 1,
    width: 612,
    height: 792,
  }));
  return buildDocument({
    sourceSha256: 'b'.repeat(64),
    documentId: options.documentId ?? 'doc-1',
    language: options.language ?? 'en',
    pages,
    blocks: specs.map((spec, position) => ({
      page: spec.page ?? 1,
      text: spec.text,
      type: spec.type ?? 'paragraph',
      language: spec.language,
      rect: { x: 72, y: 72 + position * 40, width: 468, height: 24 },
    })),
  });
}

function normOf(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local deterministic embedding generation', () => {
  it('produces identical L2-normalized vectors across repeated calls and instances', () => {
    const first = createLocalEmbedder({ dimensions: 128 });
    const second = createLocalEmbedder({ dimensions: 128 });

    const vecA = first.embed('Hybrid retrieval combines BM25 and dense vectors.');
    const vecB = second.embed('Hybrid retrieval combines BM25 and dense vectors.');
    const vecC = first.embed('Hybrid retrieval combines BM25 and dense vectors.');

    expect(vecA).toHaveLength(128);
    expect(vecA).toEqual(vecB);
    expect(vecA).toEqual(vecC);
    expect(normOf(vecA)).toBeCloseTo(1, 6);
  });

  it('uses default dimensions and returns a zero vector for empty or punctuation-only text', () => {
    const embedder = createLocalEmbedder();
    expect(embedder.dimensions).toBe(DEFAULT_EMBEDDING_DIMENSIONS);

    const emptyVec = embedder.embed('');
    const punctVec = embedder.embed('   --- !!! ???   ');
    expect(emptyVec).toHaveLength(DEFAULT_EMBEDDING_DIMENSIONS);
    expect(emptyVec.every(value => value === 0)).toBe(true);
    expect(punctVec).toEqual(emptyVec);
  });

  it('captures character/word n-gram morphological overlap where exact tokens differ', () => {
    const embedder = createLocalEmbedder({ dimensions: 384 });
    const queryVec = embedder.embed('optimize');
    const morphologicalVec = embedder.embed('optimization pipeline performance');
    const unrelatedVec = embedder.embed('schedule database backup');

    const morphSim = cosineSimilarity(queryVec, morphologicalVec);
    const unrelatedSim = cosineSimilarity(queryVec, unrelatedVec);

    expect(morphSim).toBeGreaterThan(0.1);
    expect(morphSim).toBeGreaterThan(unrelatedSim + 0.08);
  });

  it('weights rare TF-IDF terms above ubiquitous corpus terms', () => {
    const corpus = [
      'system architecture overview notes',
      'system logging monitoring trace',
      'system quorum consensus protocol',
      'system quorum raft leader election',
      'system security policy review',
    ];
    const embedder = createLocalEmbedder({ dimensions: 384, corpus });

    const target = embedder.embed('system quorum');
    const rareMatch = embedder.embed('system quorum raft');
    const commonOnly = embedder.embed('system logging');

    expect(cosineSimilarity(target, rareMatch)).toBeGreaterThan(cosineSimilarity(target, commonOnly) + 0.15);
  });
});

describe('cosineSimilarity and semanticSearch', () => {
  it('computes exact cosine similarity and rejects mismatched vector dimensions', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1, 6);
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(l2Normalize([3, 4, 0])).toEqual([0.6, 0.8, 0]);
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0]);

    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrowError(HybridRetrievalError);
    try {
      cosineSimilarity([1, 0], [1, 0, 0]);
    } catch (error) {
      expect((error as HybridRetrievalError).code).toBe('dimension-mismatch');
    }
  });

  it('ranks semantically similar passages even when BM25 has zero lexical overlap', () => {
    const doc = makeDoc([
      { text: '1 Optimization', type: 'heading' },
      { text: 'Latency optimization reduces query turnaround time across large catalogs.' },
      { text: '2 Backups', type: 'heading' },
      { text: 'Nightly snapshots replicate encrypted storage blocks to cold archives.' },
    ]);

    expect(searchBm25(indexBm25(chunkDocument(doc)), 'optimize')).toEqual([]);

    const idx = indexDocuments([doc]);
    const hits = semanticSearch(idx, 'optimize');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.chunk.headingPath).toEqual(['1 Optimization']);
    expect(hits[0]?.score).toBeGreaterThan(0.1);
  });
});

describe('pluggable external LocalEmbedder adapter', () => {
  it('uses an external LocalEmbedder via embedBatch when provided and falls back to embed otherwise', () => {
    const table: Record<string, number[]> = {
      'payment clause': [1, 0, 0],
      'Invoice settlement terms apply within thirty days.': [0.95, 0.31, 0],
      'Server rack cooling specification.': [0, 1, 0],
      'Legal indemnification notice.': [0, 0, 1],
    };
    const embedBatch = vi.fn((texts: readonly string[]) =>
      texts.map(text => {
        const key = Object.keys(table).find(candidate => text.includes(candidate));
        return key ? table[key]! : [0, 0, 0];
      }),
    );
    const externalWithBatch: LocalEmbedder = {
      id: 'stub-dense-v1',
      dimensions: 3,
      embed(text) {
        return table[text] ?? [0, 0, 0];
      },
      embedBatch,
    };

    const doc = makeDoc([
      { text: 'Invoice settlement terms apply within thirty days.' },
      { text: 'Server rack cooling specification.' },
      { text: 'Legal indemnification notice.' },
    ]);

    const idx = indexDocuments([doc], { embedder: externalWithBatch });
    expect(idx.embedderId).toBe('stub-dense-v1');
    expect(idx.dimensions).toBe(3);
    expect(embedBatch).toHaveBeenCalledTimes(1);

    const hits = hybridSearch(idx, 'payment clause', { minSemanticScore: 0 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.chunk.text).toBe('Invoice settlement terms apply within thirty days.');
    expect(hits[0]?.trace.bm25Rank).toBeNull();
    expect(hits[0]?.trace.bm25Score).toBe(0);
    expect(hits[0]?.trace.semanticRank).toBe(1);
    expect(hits[0]?.trace.semanticScore).toBeGreaterThan(0.9);

    const embedOnlyCalls: string[] = [];
    const externalEmbedOnly: LocalEmbedder = {
      id: 'stub-single-v1',
      dimensions: 3,
      embed(text) {
        embedOnlyCalls.push(text);
        const key = Object.keys(table).find(candidate => text.includes(candidate));
        return key ? table[key]! : [0, 0, 0];
      },
    };
    const idx2 = indexDocuments([doc], { embedder: externalEmbedOnly });
    expect(embedOnlyCalls).toHaveLength(3);
    expect(idx2.search('payment clause')[0]?.chunk.text).toBe(
      'Invoice settlement terms apply within thirty days.',
    );
  });
});

describe('metadata filters', () => {
  const tableCsv = ['Region\tRevenue', 'North\t120', 'South\t90'].join('\n');

  function multiDocCorpus(): DocumentIR[] {
    const docEn = makeDoc(
      [
        { text: '1 Introduction', type: 'heading', page: 1 },
        { text: 'Contract revenue overview for enterprise cloud accounts.', page: 1 },
        { text: '2 Methods', type: 'heading', page: 2 },
        { text: 'Revenue forecasting model across regional cohorts.', page: 2 },
        { text: 'Spanning revenue calculation detail on the following page.', page: 3 },
        { text: 'Table 1: Revenue by region', type: 'other', page: 3 },
        { text: tableCsv, type: 'table', page: 3 },
        { text: '20 Appendix', type: 'heading', page: 4 },
        { text: 'Revenue glossary notes in appendix.', page: 4 },
      ],
      { documentId: 'doc-en', language: 'en' },
    );

    const docVi = makeDoc(
      [
        { text: '1 Tổng quan', type: 'heading', page: 1 },
        { text: 'Báo cáo revenue và doanh thu hợp đồng theo quý.', page: 1 },
        { text: '2 Phương pháp', type: 'heading', page: 2 },
        { text: 'Phân tích doanh thu hợp đồng dịch vụ.', page: 2 },
      ],
      { documentId: 'doc-vi', language: 'vi' },
    );

    return [docEn, docVi];
  }

  it('filters by documentId and documentIds', () => {
    const idx = indexDocuments(multiDocCorpus());

    const onlyVi = idx.search('revenue', { filters: { documentId: 'doc-vi' } });
    expect(onlyVi.length).toBeGreaterThan(0);
    expect(onlyVi.every(hit => hit.chunk.documentId === 'doc-vi')).toBe(true);
    expect(onlyVi[0]?.trace.matchedFilter).toBe(true);

    const both = idx.search('revenue', { filters: { documentIds: ['doc-en', 'doc-vi'] } });
    expect(new Set(both.map(hit => hit.chunk.documentId))).toEqual(new Set(['doc-en', 'doc-vi']));
  });

  it('filters by pageRange including multi-page section chunks', () => {
    const idx = indexDocuments(multiDocCorpus());

    const page3Only = idx.search('revenue', {
      filters: { documentId: 'doc-en', pageRange: { min: 3, max: 3 } },
    });
    const kinds = new Set(page3Only.map(hit => hit.chunk.kind));
    // Section '2 Methods' starts on page 2 and ends on page 3, so it overlaps page 3 alongside the table.
    expect(kinds).toEqual(new Set(['section', 'table']));
    expect(page3Only.some(hit => hit.chunk.headingPath.includes('2 Methods'))).toBe(true);

    const tupleRange = idx.search('revenue', {
      filters: { documentId: 'doc-en', pageRange: [4, 4] },
    });
    expect(tupleRange).toHaveLength(1);
    expect(tupleRange[0]?.chunk.headingPath).toEqual(['20 Appendix']);
  });

  it('filters by chunk kind, section (without false prefix matches), and language', () => {
    const idx = indexDocuments(multiDocCorpus());

    const tablesOnly = idx.search('revenue', { filters: { kind: 'table' } });
    expect(tablesOnly).toHaveLength(1);
    expect(tablesOnly[0]?.chunk.kind).toBe('table');

    const section2 = idx.search('revenue', {
      filters: { documentId: 'doc-en', section: '2' },
    });
    expect(section2.every(hit => hit.chunk.headingPath.includes('2 Methods'))).toBe(true);
    expect(section2.some(hit => hit.chunk.headingPath.includes('20 Appendix'))).toBe(false);

    const bySectionTitle = idx.search('revenue', {
      filters: { section: 'Methods' },
    });
    expect(bySectionTitle.length).toBeGreaterThan(0);
    expect(bySectionTitle.every(hit => hit.chunk.headingPath.includes('2 Methods'))).toBe(true);

    const viOnly = idx.search('revenue', { filters: { language: 'vn' } });
    expect(viOnly.length).toBeGreaterThan(0);
    expect(viOnly.every(hit => hit.metadata.language === 'vi')).toBe(true);

    const enUs = idx.search('revenue', { filters: { language: 'en-US', kind: 'table' } });
    expect(enUs).toHaveLength(1);
    expect(enUs[0]?.chunk.documentId).toBe('doc-en');
  });

  it('exposes pure matchesMetadataFilter evaluation', () => {
    const match = matchesMetadataFilter(
      {
        documentId: 'doc-1',
        page: 2,
        pageEnd: 3,
        kind: 'section',
        headingPath: ['2 Methods'],
        language: 'en',
        languages: ['en'],
      },
      { documentId: 'doc-1', pageRange: { min: 3, max: 4 }, kind: ['section', 'table'], section: '2', language: 'en' },
    );
    expect(match.matched).toBe(true);
    expect(match.fields).toEqual(['documentId', 'pageRange', 'kind', 'section', 'language']);
  });
});

describe('Reciprocal Rank Fusion (RRF) and detailed trace', () => {
  it('computes exact RRF scores combining multiple ranked lists', () => {
    const fused = reciprocalRankFusion(
      [
        { name: 'bm25', ids: ['a', 'b', 'c'], weight: 1 },
        { name: 'semantic', ids: ['b', 'd', 'a'], weight: 1 },
      ],
      { k: DEFAULT_RRF_K },
    );

    const expectedA = Number((1 / 61 + 1 / 63).toFixed(6));
    const expectedB = Number((1 / 62 + 1 / 61).toFixed(6));
    const expectedC = Number((1 / 63).toFixed(6));
    const expectedD = Number((1 / 62).toFixed(6));

    // 'b' ranks (2, 1) -> 0.032522 > 'a' ranks (1, 3) -> 0.032266.
    expect(fused[0]?.id).toBe('b');
    expect(fused[0]?.score).toBe(expectedB);
    expect(fused.find(entry => entry.id === 'a')?.score).toBe(expectedA);
    expect(fused.find(entry => entry.id === 'b')?.ranks).toEqual({ bm25: 2, semantic: 1 });
    expect(fused.find(entry => entry.id === 'c')?.score).toBe(expectedC);
    expect(fused.find(entry => entry.id === 'd')?.score).toBe(expectedD);
  });

  it('promotes dual BM25 + semantic hits and returns complete trace fields', () => {
    const customEmbedder: LocalEmbedder = {
      id: 'trace-embedder-v1',
      dimensions: 3,
      embed(text) {
        if (text.includes('query hybrid')) return [1, 0, 0];
        if (text.includes('alpha dual')) return [0.8, 0.6, 0];
        if (text.includes('beta bm25')) return [0, 1, 0];
        if (text.includes('gamma semantic')) return [0.96, 0.28, 0];
        return [0, 0, 1];
      },
    };

    const doc = makeDoc([
      { text: 'beta bm25 keyword dense beta bm25 keyword' },
      { text: 'alpha dual keyword match' },
      { text: 'gamma semantic concept passage without lexical tokens' },
    ]);

    const idx = indexDocuments([doc], { embedder: customEmbedder });
    const hits = idx.search('query hybrid keyword beta', { rrfK: 60 });

    // 'alpha dual' appears in BOTH BM25 and semantic rankings; beta is BM25-only; gamma is semantic-only.
    expect(hits.map(hit => hit.chunk.text)).toEqual([
      'alpha dual keyword match',
      'beta bm25 keyword dense beta bm25 keyword',
      'gamma semantic concept passage without lexical tokens',
    ]);

    const dualHit = hits[0]!;
    expect(dualHit.trace.bm25Rank).toBe(2);
    expect(dualHit.trace.bm25Score).toBeGreaterThan(0);
    expect(dualHit.trace.semanticRank).toBe(2);
    expect(dualHit.trace.semanticScore).toBeCloseTo(0.8, 5);
    expect(dualHit.trace.fusedScore).toBe(dualHit.score);
    expect(dualHit.trace.fusedScore).toBeCloseTo(1 / 62 + 1 / 62, 6);
    expect(dualHit.trace.matchedFilter).toBe(true);

    const bm25OnlyHit = hits[1]!;
    expect(bm25OnlyHit.trace.bm25Rank).toBe(1);
    expect(bm25OnlyHit.trace.semanticRank).toBeNull();
    expect(bm25OnlyHit.trace.semanticScore).toBe(0);

    const semanticOnlyHit = hits[2]!;
    expect(semanticOnlyHit.trace.bm25Rank).toBeNull();
    expect(semanticOnlyHit.trace.bm25Score).toBe(0);
    expect(semanticOnlyHit.trace.semanticRank).toBe(1);
    expect(semanticOnlyHit.matchedTerms).toEqual([]);
  });

  it('supports bm25-only and semantic-only search modes', () => {
    const doc = makeDoc([
      { text: 'Latency optimization lowers p95 response delay.' },
      { text: 'Exact keyword optimize appears right here.' },
    ]);
    const idx = indexDocuments([doc]);

    const bm25Only = idx.search('optimize', { mode: 'bm25' });
    expect(bm25Only).toHaveLength(1);
    expect(bm25Only[0]?.chunk.text).toContain('Exact keyword optimize');
    expect(bm25Only[0]?.trace.semanticRank).toBeNull();

    const semanticOnly = idx.search('optimize', { mode: 'semantic' });
    expect(semanticOnly.length).toBeGreaterThanOrEqual(1);
    expect(semanticOnly.every(hit => hit.trace.bm25Rank === null)).toBe(true);
  });
});

describe('offline 0-network guarantee', () => {
  it('never triggers fetch, XMLHttpRequest, or WebSocket during embedding, indexing, search, or serialization', () => {
    const guard = createGuard({ policy: 'none' });
    vi.stubGlobal('fetch', guard.fetch);
    vi.stubGlobal('XMLHttpRequest', () => {
      throw new Error('XMLHttpRequest must never be used offline');
    });
    vi.stubGlobal('WebSocket', () => {
      throw new Error('WebSocket must never be used offline');
    });

    const doc = makeDoc([
      { text: '1 Privacy', type: 'heading' },
      { text: 'Offline retrieval runs strictly on local device memory.' },
    ]);

    const embedder = createLocalEmbedder();
    embedder.embed('local privacy');
    const idx = indexDocuments([doc]);
    const hits = idx.search('offline privacy');
    const sem = semanticSearch(idx, 'local memory');
    const json = serializeHybridIndex(idx);
    const restored = deserializeHybridIndex(json);
    const restoredHits = restored.search('offline privacy');

    expect(hits).toHaveLength(1);
    expect(sem).toHaveLength(1);
    expect(restoredHits).toEqual(hits);
    guard.assertNoCalls();
    expect(guard.calls).toHaveLength(0);
  });
});

describe('persistence and serialization', () => {
  it('serializes deterministically and restores identical search results, scores, and traces', () => {
    const doc = makeDoc([
      { text: '1 Storage', type: 'heading', page: 1 },
      { text: 'Write-ahead log durability ensures crash recovery.', page: 1 },
      { text: '2 Cache', type: 'heading', page: 2 },
      { text: 'In-memory LRU page cache avoids repeated disk reads.', page: 2 },
    ]);

    const idxA = indexDocuments([doc]);
    const idxB = indexDocuments([doc]);
    const jsonA = serializeHybridIndex(idxA);
    const jsonB = serializeHybridIndex(idxB);

    expect(jsonA).toBe(jsonB);
    expect(JSON.parse(jsonA).schemaVersion).toBe(HYBRID_INDEX_SCHEMA_VERSION);

    const restored = deserializeHybridIndex(jsonA);
    const originalHits = idxA.search('crash durability', { filters: { pageRange: [1, 2] } });
    const restoredHits = restored.search('crash durability', { filters: { pageRange: [1, 2] } });

    expect(restoredHits).toEqual(originalHits);
    expect(restored.chunks).toEqual(idxA.chunks);
    expect(restored.vectors).toEqual(idxA.vectors);
  });

  it('rejects unsupported schema versions, corrupt JSON, and mismatched external embedders', () => {
    expect(() => deserializeHybridIndex('{not-json')).toThrowError(HybridRetrievalError);

    const idx = indexDocuments([makeDoc([{ text: 'Single paragraph.' }])]);
    const parsed = JSON.parse(serializeHybridIndex(idx)) as Record<string, unknown>;
    parsed.schemaVersion = 999;

    try {
      deserializeHybridIndex(JSON.stringify(parsed));
      expect.unreachable('expected unsupported-version error');
    } catch (error) {
      expect(error).toBeInstanceOf(HybridRetrievalError);
      expect((error as HybridRetrievalError).code).toBe('unsupported-version');
    }

    const customIdx = indexChunks(chunkDocument(makeDoc([{ text: 'Custom vector text.' }])), {
      embedder: { id: 'custom-v1', dimensions: 2, embed: () => [1, 0] },
    });
    const customJson = serializeHybridIndex(customIdx);

    expect(() => deserializeHybridIndex(customJson)).toThrowError(HybridRetrievalError);
    expect(() =>
      deserializeHybridIndex(customJson, {
        embedder: { id: 'custom-v2', dimensions: 2, embed: () => [1, 0] },
      }),
    ).toThrowError(HybridRetrievalError);

    const restoredCustom = deserializeHybridIndex(customJson, {
      embedder: { id: 'custom-v1', dimensions: 2, embed: () => [1, 0] },
    });
    expect(restoredCustom.search('anything')).toHaveLength(1);
  });
});
