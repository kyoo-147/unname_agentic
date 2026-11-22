import { describe, expect, it } from 'vitest';
import {
  MAX_INTENT_GROUPS,
  RECENT_TERM_LIMIT,
  SHORT_QUESTION_MAX_TERMS,
  SYNONYM_PAIRS,
  expandAcronyms,
  quotePhrases,
  rewriteQuery,
} from '../viewer/src/core/query';

describe('rewriteQuery: question words', () => {
  it('drops Vietnamese question words and function words from the query', () => {
    const plan = rewriteQuery('Hợp đồng là gì?');

    expect(plan.queries[0]).toBe('Hợp đồng');
    expect(plan.keywords).toContain('hop');
    expect(plan.keywords).toContain('dong');
    expect(plan.keywords).not.toContain('la');
    expect(plan.keywords).not.toContain('gi');
    expect(plan.reasons).toContain('words-stripped');
  });

  it('drops English question words from the query', () => {
    const plan = rewriteQuery('What is the termination clause?');

    expect(plan.queries).toEqual(['termination clause']);
    expect(plan.keywords).toEqual(['termination', 'clause']);
    expect(plan.reasons).toContain('words-stripped');
  });

  it('strips only the question language, so Vietnamese "số" survives', () => {
    // `số` folds to `so`, which is an English stop word. A blanket bilingual list would
    // delete it; the Vietnamese list does not contain it.
    const plan = rewriteQuery('Số lượng là bao nhiêu?');

    expect(plan.queries[0]).toBe('Số lượng');
    expect(plan.keywords).toEqual(['so', 'luong']);
  });

  it('keeps a number verbatim and reads the year as a filter', () => {
    const plan = rewriteQuery('What is the price in 2024?');

    expect(plan.queries).toEqual(['price 2024']);
    expect(plan.keywords).toContain('2024');
    expect(plan.filters).toEqual({ year: 2024 });
    expect(plan.reasons).toContain('year-filter');
  });

  it('keeps a dotted section reference readable in the query', () => {
    const plan = rewriteQuery('What does clause 4.2 of the 2024 contract say?');

    expect(plan.queries[0]).toContain('4.2');
    expect(plan.filters.section).toBe('4.2');
    expect(plan.filters.year).toBe(2024);
  });

  it('maps folded offsets back through a character outside the basic plane', () => {
    // An emoji is two UTF-16 units but one character: the fold map has to stay aligned
    // or the removals below cut the wrong range.
    const plan = rewriteQuery('📄 Hợp đồng là gì?');

    expect(plan.queries[0]).toBe('📄 Hợp đồng');
    expect(plan.keywords).toEqual(['hop', 'dong', 'contract']);
  });
});

describe('rewriteQuery: quoting', () => {
  it('keeps a quoted phrase as one whole query', () => {
    const plan = rewriteQuery('What is "force majeure"?');

    expect(plan.queries).toEqual(['force majeure']);
    expect(plan.keywords).toEqual(['force', 'majeure']);
    expect(plan.reasons).toContain('quoted-phrase-kept');
  });

  it('never splits inside a quoted phrase, even on a connector', () => {
    const plan = rewriteQuery('"supply and demand" là gì?');

    expect(plan.queries).toEqual(['supply and demand']);
    expect(plan.reasons).not.toContain('intent-split');
  });

  it('returns the quoted spans, and does not treat an apostrophe as one', () => {
    expect(quotePhrases('The phrase “force majeure” and “acts of God”')).toEqual([
      'force majeure',
      'acts of God',
    ]);
    expect(quotePhrases("What is don't mean?")).toEqual([]);
    expect(quotePhrases('no quotes here')).toEqual([]);
  });
});

describe('rewriteQuery: intents', () => {
  it('produces one query per intent of a compound question', () => {
    const plan = rewriteQuery('What is the delivery window and what is the review process?');

    expect(plan.queries).toEqual(['delivery window', 'review process']);
    expect(plan.reasons).toContain('intent-split');
  });

  it('never turns a run of connectors into more than MAX_INTENT_GROUPS searches', () => {
    const plan = rewriteQuery(
      'delivery window and review process and payment schedule and tax rate and audit right',
    );

    expect(plan.queries).toHaveLength(MAX_INTENT_GROUPS);
    expect(plan.reasons).toContain('intent-split');
  });
});

describe('rewriteQuery: synonyms', () => {
  it('adds the English counterpart of a Vietnamese term', () => {
    const plan = rewriteQuery('Giá của hợp đồng là gì?');

    expect(plan.queries[0]).toBe('Giá hợp đồng');
    expect(plan.queries).toContain('price contract');
    expect(plan.keywords).toContain('price');
    expect(plan.keywords).toContain('contract');
    expect(plan.reasons).toContain('synonym-expanded');
  });

  it('does not add a variant when the document is already in the question language', () => {
    const plan = rewriteQuery('Giá hợp đồng là gì?', { language: 'vi' });

    expect(plan.queries).toEqual(['Giá hợp đồng']);
    expect(plan.keywords).not.toContain('price');
    expect(plan.reasons).not.toContain('synonym-expanded');
  });

  it('reads the table longest first, so "giá trị" is not read as "giá"', () => {
    const plan = rewriteQuery('Giá trị hợp đồng là gì?', { language: 'en' });

    expect(plan.queries).toContain('value contract');
    expect(plan.queries).not.toContain('price trị contract');
  });

  it('keeps a bilingual table that is worth reading', () => {
    const seen = new Set<string>();
    for (const [vi, en] of SYNONYM_PAIRS) {
      expect(vi.trim().length).toBeGreaterThan(0);
      expect(en.trim().length).toBeGreaterThan(0);
      expect(vi.toLowerCase()).not.toBe(en.toLowerCase());
      for (const side of [vi.toLowerCase(), en.toLowerCase()]) {
        expect(seen.has(side)).toBe(false);
        seen.add(side);
      }
    }
  });
});

describe('rewriteQuery: acronyms', () => {
  it('expands a known acronym next to the acronym itself', () => {
    const expanded = expandAcronyms('What is RAG?', { RAG: 'Retrieval-Augmented Generation' });

    expect(expanded).toBe('What is RAG (Retrieval-Augmented Generation)?');
  });

  it('is idempotent and only expands the first occurrence', () => {
    const glossary = { RAG: 'Retrieval-Augmented Generation' };
    const once = expandAcronyms('RAG and RAG', glossary);

    expect(once).toBe('RAG (Retrieval-Augmented Generation) and RAG');
    expect(expandAcronyms(once, glossary)).toBe(once);
  });

  it('ignores a map entry that is not acronym-shaped', () => {
    const question = 'hợp đồng là gì';

    expect(expandAcronyms(question, { 'hợp đồng': 'contract' })).toBe(question);
  });

  it('accepts a Map and glossary entries as well as a record', () => {
    expect(expandAcronyms('GDP growth', new Map([['GDP', 'Gross Domestic Product']]))).toBe(
      'GDP (Gross Domestic Product) growth',
    );
    expect(
      expandAcronyms('The API is down', [{ source: 'API', target: 'Application Programming Interface' }]),
    ).toBe('The API (Application Programming Interface) is down');
  });

  it('feeds the expanded words into the plan', () => {
    const expanded = expandAcronyms('What is RAG?', { RAG: 'Retrieval-Augmented Generation' });
    const plan = rewriteQuery(expanded);

    expect(plan.queries[0]).toBe('RAG (Retrieval-Augmented Generation)');
    expect(plan.keywords).toContain('retrieval');
    expect(plan.reasons).toContain('acronym-expanded');
  });
});

describe('rewriteQuery: the title fallback', () => {
  it('adds the document title as a weak query for a short question', () => {
    const plan = rewriteQuery('What is RAG?', { documentTitle: 'Retrieval Practice' });

    expect(plan.queries).toEqual(['RAG', 'Retrieval Practice']);
    expect(plan.reasons).toContain('title-query-added');
  });

  it('does not add the title to the keywords or to a long question', () => {
    const short = rewriteQuery('What is RAG?', { documentTitle: 'Retrieval Practice' });
    expect(short.keywords).toEqual(['rag']);

    const terms = 'liability caps for delayed delivery in 2024';
    expect(terms.split(' ').length).toBeGreaterThan(SHORT_QUESTION_MAX_TERMS);

    const long = rewriteQuery('What are the liability caps for delayed delivery in 2024?', {
      documentTitle: 'Retrieval Practice',
    });
    expect(long.queries).not.toContain('Retrieval Practice');
    expect(long.reasons).not.toContain('title-query-added');
  });
});

describe('rewriteQuery: nothing to search', () => {
  it('reports no terms instead of searching for question words', () => {
    const plan = rewriteQuery('What is it?');

    expect(plan.queries).toEqual([]);
    expect(plan.keywords).toEqual([]);
    expect(plan.reasons).toContain('no-terms');
  });

  it('reports an empty question separately', () => {
    const plan = rewriteQuery('   ');

    expect(plan.queries).toEqual([]);
    expect(plan.reasons).toEqual(['empty-question']);
  });

  it('falls back to the reader\'s recent terms', () => {
    const plan = rewriteQuery('What is it?', { recentTerms: ['Hợp đồng', 'giá'] });

    expect(plan.queries).toEqual(['Hợp đồng giá']);
    expect(plan.keywords).toEqual(['hop', 'dong', 'gia']);
    expect(plan.reasons).toContain('recent-terms-used');
    expect(plan.reasons).not.toContain('no-terms');
  });

  it('uses at most RECENT_TERM_LIMIT of the newest terms', () => {
    const recentTerms = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
    const plan = rewriteQuery('What is it?', { recentTerms });

    expect(plan.keywords).toHaveLength(RECENT_TERM_LIMIT);
  });
});

describe('rewriteQuery: filters', () => {
  it('reads page, year and section from the question', () => {
    const plan = rewriteQuery(
      'What is the termination clause on page 12 of the 2024 contract, section 3.2?',
    );

    expect(plan.filters).toEqual({ page: 12, year: 2024, section: '3.2' });
    expect(plan.reasons).toContain('page-filter');
    expect(plan.reasons).toContain('year-filter');
    expect(plan.reasons).toContain('section-filter');
  });

  it('reads a Vietnamese page and a Roman section', () => {
    const plan = rewriteQuery('Điều khoản ở trang 7 của chương IV là gì?');

    expect(plan.filters.page).toBe(7);
    expect(plan.filters.section).toBe('IV');
  });

  it('reports no filter for a question that names none', () => {
    expect(rewriteQuery('What is the delivery window?').filters).toEqual({});
  });
});

describe('rewriteQuery: contract', () => {
  it('is deterministic and leaves its arguments alone', () => {
    const context = Object.freeze({
      language: 'en',
      recentTerms: Object.freeze(['giá']),
    });

    const first = rewriteQuery('Giá hợp đồng là gì?', context);
    first.queries.push('scribbled over');
    const second = rewriteQuery('Giá hợp đồng là gì?', context);

    expect(second.queries).toEqual(['Giá hợp đồng', 'price contract']);
    expect(second.queries).not.toContain('scribbled over');
    expect(second).toEqual(rewriteQuery('Giá hợp đồng là gì?', context));
  });

  it('keeps queries[0] the best single search for the question', () => {
    const plan = rewriteQuery('Giá của hợp đồng là gì?');

    expect(plan.queries[0]).toBe('Giá hợp đồng');
  });

  it('returns fresh arrays on every call', () => {
    const plan = rewriteQuery('Hợp đồng là gì?');
    const other = rewriteQuery('Hợp đồng là gì?');

    expect(plan.queries).not.toBe(other.queries);
    expect(plan.keywords).not.toBe(other.keywords);
    expect(plan.reasons).not.toBe(other.reasons);
  });
});
