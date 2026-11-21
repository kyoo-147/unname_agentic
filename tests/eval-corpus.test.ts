import { describe, expect, it, vi } from 'vitest';
import { buildDocument } from '../src/core/ir';
import { createGuard } from '../src/core/network-guard';
import { rewriteQuery } from '../src/core/query';
import {
  chunkDocument,
  index,
  type Chunk,
  type ChunkKind,
  type SearchHit,
} from '../src/core/retrieval';
import {
  DEFAULT_DIVERSITY_WEIGHT,
  DEFAULT_RERANK_LIMIT,
  DEFAULT_RERANK_WEIGHTS,
  rerank,
  searchAndRerank,
  type RerankHit,
} from '../src/core/reranker';

const SHA = 'b'.repeat(64);

interface ChunkSpec {
  id: string;
  text: string;
  documentId?: string;
  page?: number;
  blockIds?: string[];
  kind?: ChunkKind;
  headingPath?: string[];
}

function makeChunk(spec: ChunkSpec): Chunk {
  return {
    id: spec.id,
    documentId: spec.documentId ?? 'doc-1',
    page: spec.page ?? 1,
    blockIds: spec.blockIds ?? [`p${spec.page ?? 1}-r0`],
    text: spec.text,
    kind: spec.kind ?? 'section',
    headingPath: spec.headingPath ?? [],
  };
}

function makeHit(
  spec: ChunkSpec,
  score: number,
  matchedTerms: string[] = [],
): SearchHit {
  return {
    chunk: makeChunk(spec),
    score,
    matchedTerms,
  };
}

function firstOf(hits: readonly RerankHit[]): RerankHit {
  const head = hits[0];
  if (head === undefined) throw new Error('expected at least one rerank hit');
  return head;
}

describe('local cross-feature reranker (I12)', () => {
  describe('exact quoted span boost', () => {
    it('promotes an exact quoted phrase match above a higher-BM25 scattered hit', () => {
      const scattered = makeHit(
        {
          id: 'doc-1:c1',
          page: 1,
          text: 'The force of external events and majeure claims may force delays in force schedules.',
        },
        4.2,
        ['force', 'majeure'],
      );
      const exactPhrase = makeHit(
        {
          id: 'doc-1:c2',
          page: 4,
          text: 'Clause 11 defines "force majeure" as natural disasters or grid failures.',
        },
        2.5,
        ['force', 'majeure'],
      );

      const ranked = rerank('What does "force majeure" cover?', [scattered, exactPhrase]);

      expect(ranked.map(hit => hit.chunk.id)).toEqual(['doc-1:c2', 'doc-1:c1']);
      expect(firstOf(ranked).features.quotedSpan).toBe(1);
      expect(ranked[1]?.features.quotedSpan).toBe(0);
    });

    it('prefers an exact Vietnamese diacritic quoted match over a diacritic-stripped match', () => {
      const stripped = makeHit(
        {
          id: 'doc-1:c1',
          page: 2,
          text: 'Thoi han bao hanh hai nam ap dung cho pin chinh hang.',
        },
        3.4,
        ['bao', 'hanh', 'hai', 'nam'],
      );
      const exact = makeHit(
        {
          id: 'doc-1:c2',
          page: 5,
          text: 'Sản phẩm được bảo hành hai năm kể từ ngày mua.',
        },
        3.0,
        ['bao', 'hanh', 'hai', 'nam'],
      );

      const ranked = rerank('Điều kiện «bảo hành hai năm» là gì?', [stripped, exact]);

      expect(firstOf(ranked).chunk.id).toBe('doc-1:c2');
      expect(firstOf(ranked).features.quotedSpan).toBeGreaterThan(
        ranked[1]?.features.quotedSpan ?? 1,
      );
    });

    it('respects word boundaries so a quoted word does not match inside a longer word', () => {
      const substringOnly = makeHit(
        {
          id: 'doc-1:c1',
          page: 1,
          text: 'Taxonomy rules classify documents by folder.',
        },
        2.0,
        ['taxonomy'],
      );
      const exactWord = makeHit(
        {
          id: 'doc-1:c2',
          page: 2,
          text: 'Corporate tax obligations apply annually.',
        },
        1.8,
        ['tax'],
      );

      const ranked = rerank('Explain "tax" obligations', [substringOnly, exactWord]);

      expect(firstOf(ranked).chunk.id).toBe('doc-1:c2');
      expect(firstOf(ranked).features.quotedSpan).toBe(1);
      expect(ranked[1]?.features.quotedSpan).toBe(0);
    });
  });

  describe('heading-path match', () => {
    it('promotes a chunk whose headingPath matches query keywords and section filter', () => {
      const bodyMentionOnly = makeHit(
        {
          id: 'doc-1:c1',
          page: 1,
          headingPath: ['1 Overview', 'Product Summary'],
          text: 'Thermal runaway protection is referenced briefly in appendix notes on thermal protection.',
        },
        3.3,
        ['protection', 'runaway', 'thermal'],
      );
      const matchingHeading = makeHit(
        {
          id: 'doc-1:c2',
          page: 6,
          headingPath: ['3 Safety', '3.2 Thermal Runaway Protection'],
          text: 'The fuse disconnects cells within 12 ms during runaway events.',
        },
        2.7,
        ['runaway'],
      );

      const ranked = rerank('Section 3.2 thermal runaway protection', [
        bodyMentionOnly,
        matchingHeading,
      ]);

      expect(firstOf(ranked).chunk.id).toBe('doc-1:c2');
      expect(firstOf(ranked).features.headingMatch).toBeGreaterThan(
        ranked[1]?.features.headingMatch ?? 1,
      );
    });

    it('matches cross-lingual headings when queryContext triggers synonym expansion', () => {
      const genericHeading = makeHit(
        {
          id: 'doc-1:c1',
          page: 1,
          headingPath: ['Introduction'],
          text: 'Aurora M4 includes battery cells and warranty notes.',
        },
        2.6,
        ['aurora', 'm4', 'warranty'],
      );
      const warrantyHeading = makeHit(
        {
          id: 'doc-1:c2',
          page: 4,
          headingPath: ['Aurora M4 Warranty Policy'],
          text: 'Coverage lasts 24 months from invoice date.',
        },
        2.3,
        ['aurora', 'm4'],
      );

      const ranked = rerank('Chính sách bảo hành Aurora M4?', [genericHeading, warrantyHeading], {
        queryContext: { language: 'en' },
      });

      expect(firstOf(ranked).chunk.id).toBe('doc-1:c2');
      expect(firstOf(ranked).features.headingMatch).toBeGreaterThan(
        ranked[1]?.features.headingMatch ?? 1,
      );
    });
  });

  describe('numeric and unit overlap', () => {
    it('prefers a chunk matching exact numbers and units over a higher-BM25 wrong-unit chunk', () => {
      const wrongUnit = makeHit(
        {
          id: 'doc-1:c1',
          page: 2,
          text: 'The inverter manual spans 500 pages covering inverter wiring and inverter ratings.',
        },
        3.5,
        ['500', 'inverter', 'rating'],
      );
      const exactNumberAndUnit = makeHit(
        {
          id: 'doc-1:c2',
          page: 5,
          text: 'Continuous inverter rating is 500 kW at nominal bus voltage.',
        },
        2.7,
        ['500', 'inverter', 'kw', 'rating'],
      );

      const ranked = rerank('What is the 500 kW inverter rating?', [wrongUnit, exactNumberAndUnit]);

      expect(firstOf(ranked).chunk.id).toBe('doc-1:c2');
      expect(firstOf(ranked).features.numericUnit).toBeGreaterThan(
        ranked[1]?.features.numericUnit ?? 1,
      );
    });

    it('normalises unit synonyms such as kg vs kilograms and % vs percent', () => {
      const noUnitMatch = makeHit(
        {
          id: 'doc-1:c1',
          page: 1,
          text: 'The battery module weighs 2.4 pounds in shipping trim.',
        },
        2.8,
        ['2', '4', 'battery', 'module'],
      );
      const canonicalUnitMatch = makeHit(
        {
          id: 'doc-1:c2',
          page: 3,
          text: 'The battery module weighs 2.4 kilograms net.',
        },
        2.4,
        ['2', '4', 'battery', 'module'],
      );

      const ranked = rerank('Verify 2.4 kg battery module weight', [noUnitMatch, canonicalUnitMatch]);

      expect(firstOf(ranked).chunk.id).toBe('doc-1:c2');
      expect(firstOf(ranked).features.numericUnit).toBe(1);
      expect(ranked[1]?.features.numericUnit).toBeLessThan(1);
    });

    it('boosts digit-and-unit chunks for quantity questions that carry no explicit digits', () => {
      const proseOnly = makeHit(
        {
          id: 'doc-1:c1',
          page: 1,
          text: 'The operating temperature range of the module is listed in the datasheet table.',
        },
        3.2,
        ['module', 'operating', 'range', 'temperature'],
      );
      const concreteFigures = makeHit(
        {
          id: 'doc-1:c2',
          page: 3,
          text: 'Operating temperature range is -20 °C to 60 °C.',
        },
        2.6,
        ['operating', 'range', 'temperature'],
      );

      const ranked = rerank('What is the operating temperature range?', [proseOnly, concreteFigures]);

      expect(firstOf(ranked).chunk.id).toBe('doc-1:c2');
      expect(firstOf(ranked).features.numericUnit).toBeGreaterThan(0);
      expect(ranked[1]?.features.numericUnit).toBe(0);
    });

    it('keeps numericUnit at zero for purely conceptual queries without digits or quantity intent', () => {
      const hit = makeHit(
        {
          id: 'doc-1:c1',
          page: 1,
          text: 'Section 99 defines confidentiality obligations for 10 years.',
        },
        2.0,
        ['confidentiality', 'obligations'],
      );

      const ranked = rerank('Explain confidentiality obligations', [hit]);

      expect(firstOf(ranked).features.numericUnit).toBe(0);
    });
  });

  describe('multi-term density', () => {
    it('prefers full dense keyword coverage over repeated single-term matches', () => {
      const repetitivePartial = makeHit(
        {
          id: 'doc-1:c1',
          page: 1,
          text: 'Lithium chemistry requires lithium monitoring. Lithium cells use lithium separators and lithium vents.',
        },
        3.8,
        ['lithium'],
      );
      const sparseAllTerms = makeHit(
        {
          id: 'doc-1:c2',
          page: 2,
          text: 'Lithium modules undergo extensive factory qualification across multiple regional assembly lines while thermal sensors monitor internal bus bars before any discharge limit triggers.',
        },
        2.4,
        ['discharge', 'limit', 'lithium', 'thermal'],
      );
      const denseAllTerms = makeHit(
        {
          id: 'doc-1:c3',
          page: 3,
          text: 'The lithium thermal discharge limit prevents cell degradation.',
        },
        2.3,
        ['discharge', 'limit', 'lithium', 'thermal'],
      );

      const ranked = rerank('lithium thermal discharge limit', [
        repetitivePartial,
        sparseAllTerms,
        denseAllTerms,
      ]);

      expect(ranked.map(hit => hit.chunk.id)).toEqual(['doc-1:c3', 'doc-1:c2', 'doc-1:c1']);
      expect(firstOf(ranked).features.multiTermDensity).toBeGreaterThan(
        ranked[1]?.features.multiTermDensity ?? 1,
      );
      expect(ranked[1]?.features.multiTermDensity ?? 0).toBeGreaterThan(
        ranked[2]?.features.multiTermDensity ?? 1,
      );
    });
  });

  describe('redundancy suppression and diversity', () => {
    it('suppresses near-duplicate boilerplate hits so complementary evidence reaches top-2', () => {
      const primary = makeHit(
        {
          id: 'doc-a:c1',
          documentId: 'doc-a',
          page: 1,
          blockIds: ['docA-p1-r0'],
          text: 'Aurora M4 warranty lasts two years from the original purchase date.',
        },
        3.4,
        ['aurora', 'm4', 'warranty'],
      );
      const nearDuplicate = makeHit(
        {
          id: 'doc-a:c2',
          documentId: 'doc-a',
          page: 2,
          blockIds: ['docA-p2-r0'],
          text: 'Aurora M4 warranty lasts two years from the original purchase date for defects.',
        },
        3.3,
        ['aurora', 'm4', 'warranty'],
      );
      const complementary = makeHit(
        {
          id: 'doc-b:c1',
          documentId: 'doc-b',
          page: 4,
          blockIds: ['docB-p4-r1'],
          text: 'Aurora M4 warranty excludes water damage and unauthorized cell disassembly.',
        },
        2.8,
        ['aurora', 'm4', 'warranty'],
      );

      const ranked = rerank('Aurora M4 warranty terms and exclusions', [
        primary,
        nearDuplicate,
        complementary,
      ]);

      expect(ranked.slice(0, 2).map(hit => hit.chunk.id)).toEqual(['doc-a:c1', 'doc-b:c1']);
      expect(ranked[2]?.chunk.id).toBe('doc-a:c2');
      expect(ranked[0]?.features.redundancyPenalty).toBe(0);
      expect(ranked[2]?.features.redundancyPenalty).toBeGreaterThan(
        ranked[1]?.features.redundancyPenalty ?? 1,
      );
      expect(ranked[0]?.score ?? -1).toBeGreaterThanOrEqual(ranked[1]?.score ?? 0);
      expect(ranked[1]?.score ?? -1).toBeGreaterThanOrEqual(ranked[2]?.score ?? 0);
    });

    it('allows diversityWeight 0 to disable redundancy penalties', () => {
      const first = makeHit(
        { id: 'doc-1:c1', page: 1, text: 'Retention period is 30 days for access logs.' },
        3.0,
        ['days', 'logs', 'period', 'retention'],
      );
      const duplicate = makeHit(
        { id: 'doc-1:c2', page: 2, text: 'Retention period is 30 days for access logs.' },
        2.9,
        ['days', 'logs', 'period', 'retention'],
      );
      const secondary = makeHit(
        { id: 'doc-1:c3', page: 3, text: 'Backup archive retention extends to 90 days.' },
        2.3,
        ['days', 'retention'],
      );

      const ranked = rerank('retention period for access logs', [first, duplicate, secondary], {
        diversityWeight: 0,
      });

      expect(ranked.map(hit => hit.chunk.id)).toEqual(['doc-1:c1', 'doc-1:c2', 'doc-1:c3']);
      expect(ranked.every(hit => hit.features.redundancyPenalty === 0)).toBe(true);
    });
  });

  describe('zero network, determinism, and contracts', () => {
    it('executes completely locally with zero network calls', () => {
      const guard = createGuard({ policy: 'none' });
      vi.stubGlobal('fetch', guard.fetch);
      try {
        const ir = buildDocument({
          documentId: 'manual',
          sourceSha256: SHA,
          language: 'en',
          pages: [
            { index: 1, width: 612, height: 792 },
            { index: 2, width: 612, height: 792 },
          ],
          blocks: [
            {
              page: 1,
              type: 'heading',
              text: '1 Charging Specification',
              rect: { x: 72, y: 72, width: 468, height: 24 },
            },
            {
              page: 1,
              type: 'paragraph',
              text: 'Fast charging reaches 80% in 45 minutes using a 65 W USB-C adapter.',
              rect: { x: 72, y: 112, width: 468, height: 24 },
            },
            {
              page: 2,
              type: 'heading',
              text: '2 Standard Charging',
              rect: { x: 72, y: 40, width: 468, height: 24 },
            },
            {
              page: 2,
              type: 'paragraph',
              text: 'Standard charging takes four hours from empty.',
              rect: { x: 72, y: 72, width: 468, height: 24 },
            },
          ],
        });
        const idx = index(chunkDocument(ir));
        const hits = searchAndRerank(idx, 'How long does 65 W fast charging take?', { limit: 2 });

        expect(hits).toHaveLength(2);
        expect(firstOf(hits).chunk.page).toBe(1);
        guard.assertNoCalls();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('is deterministic regardless of input ordering and never mutates inputs', () => {
      const hits: SearchHit[] = [
        makeHit(
          {
            id: 'doc-1:c2',
            page: 2,
            headingPath: ['Thermal Limits'],
            text: 'Shutdown occurs at 65 °C.',
          },
          2.1,
          ['thermal'],
        ),
        makeHit(
          {
            id: 'doc-1:c1',
            page: 1,
            headingPath: ['Summary'],
            text: 'Thermal performance is rated across climates.',
          },
          2.1,
          ['thermal'],
        ),
      ];
      const snapshot = structuredClone(hits);

      const forward = rerank('What is the thermal shutdown temperature?', hits);
      const reversed = rerank('What is the thermal shutdown temperature?', [...hits].reverse());

      expect(forward).toEqual(reversed);
      expect(hits).toEqual(snapshot);
      expect(forward.map((item, idx) => item.rank === idx + 1)).toEqual([true, true]);
    });

    it('deduplicates repeated chunk ids, respects limit, and handles empty or malformed edges', () => {
      const hitA = makeHit({ id: 'doc-1:c1', page: 1, text: 'Warranty lasts 2 years.' }, 1.5, ['warranty']);
      const hitADup = makeHit({ id: 'doc-1:c1', page: 1, text: 'Warranty lasts 2 years.' }, 2.4, ['years']);
      const hitB = makeHit({ id: 'doc-1:c2', page: 2, text: 'Warranty excludes water.' }, 1.9, ['warranty']);

      const deduped = rerank('warranty years', [hitA, hitADup, hitB], {
        queryPlan: rewriteQuery('warranty years'),
      });
      expect(deduped).toHaveLength(2);
      expect(firstOf(deduped).bm25Score).toBe(2.4);
      expect(firstOf(deduped).matchedTerms).toEqual(['warranty', 'years']);

      expect(rerank('warranty', [])).toEqual([]);
      expect(rerank('   ', [hitA])).toEqual([]);
      expect(rerank('warranty', [hitA], { limit: 0 })).toEqual([]);
      expect(DEFAULT_RERANK_LIMIT).toBeGreaterThan(0);
      expect(DEFAULT_DIVERSITY_WEIGHT).toBeGreaterThan(0);
      expect(DEFAULT_RERANK_WEIGHTS.bm25 + DEFAULT_RERANK_WEIGHTS.quotedSpan).toBeGreaterThan(0);
    });
  });
});
