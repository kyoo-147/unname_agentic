import { describe, expect, it } from 'vitest';
import { parseBibTeX, toBibTeX } from '../src/core/bibtex';
import {
  PAPER_FIELDS,
  SEMANTIC_SCHOLAR_FIELDS,
  arxivId,
  buildLookup,
  mergeRecords,
  normalizeDoi,
  parseCrossref,
  parseSemanticScholar,
  toBibTeXEntry,
} from '../src/core/scholar';
import type { PaperRecord, ScholarErrorCode } from '../src/core/scholar';
import { ScholarError } from '../src/core/scholar';

/** A complete Crossref `/works/{doi}` body, in the shape the API returns. */
const CROSSREF_FULL = {
  status: 'ok',
  message: {
    DOI: '10.48550/arXiv.1706.03762',
    title: ['Attention Is All You Need'],
    author: [
      { given: 'Ashish', family: 'Vaswani' },
      { given: 'Noam', family: 'Shazeer' },
      { name: 'Google Brain' },
    ],
    'container-title': ['Advances in Neural Information Processing Systems'],
    issued: { 'date-parts': [[2017, 6, 12]] },
    abstract: '<jats:p>We propose the Transformer, a model &amp; architecture.</jats:p>',
    'is-referenced-by-count': 12345,
    reference: [
      { unstructured: 'Doe, J. (2019). A prior work.' },
      { 'article-title': 'A titled reference', DOI: '10.1000/XYZ' },
      { DOI: '10.1000/only-doi' },
      { nope: true },
    ],
    type: 'proceedings-article',
  },
};

/** The least a Crossref body can carry and still name a work. */
const CROSSREF_MINIMAL = {
  message: { DOI: '10.1000/abc', title: ['A minimal record'] },
};

/** A complete Semantic Scholar paper, with the `null`s the API sends for unknowns. */
const SEMANTIC_SCHOLAR_FULL = {
  paperId: 'abc123',
  title: 'Attention Is All You Need',
  authors: [
    { authorId: '1', name: 'Ashish Vaswani' },
    { authorId: '2', name: 'Noam Shazeer' },
  ],
  venue: 'NeurIPS',
  year: 2017,
  abstract: 'The dominant sequence transduction models are based on complex recurrent networks.',
  citationCount: 12345,
  externalIds: { DOI: '10.48550/arXiv.1706.03762', ArXiv: '1706.03762', CorpusId: 13756489 },
  references: [
    { paperId: 'p1', title: 'A prior work' },
    { paperId: 'p2', title: null },
    {},
  ],
};

function failureOf(run: () => unknown): ScholarError {
  try {
    run();
  } catch (error) {
    if (error instanceof ScholarError) return error;
    throw error;
  }
  throw new Error('expected a ScholarError, but nothing was thrown.');
}

function expectFailure(run: () => unknown, code: ScholarErrorCode, path: string): void {
  const error = failureOf(run);
  expect({ code: error.code, path: error.path }).toEqual({ code, path });
}

/** Runs `[input, expected]` pairs through a normaliser, reporting the input on failure. */
function expectTable(cases: ReadonlyArray<readonly [string, string | null]>, convert: (input: string) => string | null): void {
  for (const [input, expected] of cases) expect(convert(input), input).toBe(expected);
}

describe('normalizeDoi', () => {
  it('canonicalises every written form of a DOI', () => {
    expectTable(
      [
        ['10.1000/xyz123', '10.1000/xyz123'],
        ['https://doi.org/10.1000/xyz123', '10.1000/xyz123'],
        ['http://doi.org/10.1000/xyz123', '10.1000/xyz123'],
        ['https://dx.doi.org/10.1000/xyz123', '10.1000/xyz123'],
        ['http://dx.doi.org/10.1000/xyz123', '10.1000/xyz123'],
        ['HTTPS://DOI.ORG/10.1000/xyz123', '10.1000/xyz123'],
        ['doi:10.1000/xyz123', '10.1000/xyz123'],
        ['DOI: 10.1000/xyz123', '10.1000/xyz123'],
        ['(10.1000/xyz123)', '10.1000/xyz123'],
        ['[10.1000/xyz123]', '10.1000/xyz123'],
        [' 10.1000/xyz123 ', '10.1000/xyz123'],
        ['Published in Nature (doi: 10.1038/nature12373).', '10.1038/nature12373'],
        ['Cited as 10.1000/ABC.', '10.1000/ABC'],
        ['doi:10.1109/5.771073;', '10.1109/5.771073'],
        ['DOI: 10.5555/ABC.DEF', '10.5555/ABC.DEF'],
        // A SICI suffix keeps its own parentheses, angle brackets and semicolons.
        [
          '10.1002/(SICI)1097-4636(199706)35:4<423::AID-JBM4>3.0.CO;2-K',
          '10.1002/(SICI)1097-4636(199706)35:4<423::AID-JBM4>3.0.CO;2-K',
        ],
        ['see 10.1000/first and 10.1000/second', '10.1000/first'],
      ],
      normalizeDoi,
    );
  });

  it('rejects text that is not a DOI', () => {
    expectTable(
      [
        ['', null],
        ['not a doi', null],
        ['Attention Is All You Need', null],
        ['10.1000', null],
        ['10.1000/', null],
        ['10.1000/.', null],
        ['10.123/abc', null],
        ['110.1000/abc', null],
        ['x10.1000/abc', null],
        ['arXiv:2401.12345', null],
      ],
      normalizeDoi,
    );
  });
});

describe('arxivId', () => {
  it('accepts the label, the URL and the bare id, and strips the version', () => {
    expectTable(
      [
        ['2401.12345', '2401.12345'],
        ['2401.12345v2', '2401.12345'],
        ['2401.1234', '2401.1234'],
        ['  2401.12345v10  ', '2401.12345'],
        ['arXiv:2401.12345', '2401.12345'],
        ['arXiv:2401.12345v2', '2401.12345'],
        ['arxiv:2401.12345', '2401.12345'],
        ['https://arxiv.org/abs/2401.12345', '2401.12345'],
        ['https://arxiv.org/abs/2401.12345v2', '2401.12345'],
        ['http://arxiv.org/pdf/2401.12345v3.pdf', '2401.12345'],
        ['see arXiv:1706.03762 for the model', '1706.03762'],
        // The pre-2015 id shape is still a live identifier.
        ['arXiv:hep-th/9901001v1', 'hep-th/9901001'],
        ['https://arxiv.org/abs/math.GT/0309136', 'math.GT/0309136'],
      ],
      arxivId,
    );
  });

  it('rejects ids that do not validate', () => {
    expectTable(
      [
        ['', null],
        ['2401.123', null],
        ['2401.123456', null],
        ['2413.12345', null],
        ['2401.12345v2x', null],
        ['PDF 2401.12345', null],
        ['arxiv:12345', null],
        ['10.1000/abc', null],
        ['doi:10.1000/abc', null],
      ],
      arxivId,
    );
  });
});

describe('buildLookup', () => {
  it('builds both requests for a DOI', () => {
    expect(buildLookup('https://doi.org/10.1000/XYZ')).toEqual({
      kind: 'doi',
      doi: '10.1000/XYZ',
      crossref: 'https://api.crossref.org/works/10.1000/XYZ',
      semanticScholar: `https://api.semanticscholar.org/graph/v1/paper/DOI:10.1000/XYZ?fields=${SEMANTIC_SCHOLAR_FIELDS}`,
    });
  });

  it('asks Semantic Scholar for every field the parser reads', () => {
    const requested = SEMANTIC_SCHOLAR_FIELDS.split(',');
    for (const field of ['title', 'authors', 'venue', 'year', 'abstract', 'citationCount', 'externalIds']) {
      expect(requested).toContain(field);
    }
    expect(requested).toContain('references.title');
  });

  it('builds only the Semantic Scholar request for an arXiv id', () => {
    expect(buildLookup('arXiv:2401.12345v2')).toEqual({
      kind: 'arxiv',
      arxiv: '2401.12345',
      semanticScholar: `https://api.semanticscholar.org/graph/v1/paper/ARXIV:2401.12345?fields=${SEMANTIC_SCHOLAR_FIELDS}`,
    });
    expect(buildLookup('arXiv:2401.12345v2')).not.toHaveProperty('crossref');
  });

  it('reads the arXiv id a DataCite DOI stands for', () => {
    expect(buildLookup('10.48550/arXiv.1706.03762')).toEqual({
      kind: 'doi',
      doi: '10.48550/arXiv.1706.03762',
      arxiv: '1706.03762',
      crossref: 'https://api.crossref.org/works/10.48550/arXiv.1706.03762',
      semanticScholar: `https://api.semanticscholar.org/graph/v1/paper/DOI:10.48550/arXiv.1706.03762?fields=${SEMANTIC_SCHOLAR_FIELDS}`,
    });
  });

  it('percent-encodes a DOI that would otherwise break the path', () => {
    const lookup = buildLookup('10.1002/(SICI)1097-4636(199706)35:4<423::AID-JBM4>3.0.CO;2-K');
    expect(lookup.crossref).toBe(
      'https://api.crossref.org/works/10.1002/%28SICI%291097-4636%28199706%2935:4%3C423::AID-JBM4%3E3.0.CO%3B2-K',
    );
    expect(lookup.crossref).not.toContain('<');
    expect(lookup.semanticScholar).toContain('paper/DOI:10.1002/%28SICI%29');
  });

  it('refuses a query that names neither identifier', () => {
    expectFailure(() => buildLookup('Attention Is All You Need'), 'unidentifiable-query', 'query');
    expectFailure(() => buildLookup(''), 'unidentifiable-query', 'query');
    expectFailure(() => buildLookup('10.1000'), 'unidentifiable-query', 'query');
    expect(failureOf(() => buildLookup('Attention Is All You Need')).message).toContain('Attention Is All You Need');
  });
});

describe('parseCrossref', () => {
  it('maps a full work into a record', () => {
    expect(parseCrossref(CROSSREF_FULL)).toEqual({
      doi: '10.48550/arXiv.1706.03762',
      arxiv: '1706.03762',
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer', 'Google Brain'],
      venue: 'Advances in Neural Information Processing Systems',
      year: 2017,
      abstract: 'We propose the Transformer, a model & architecture.',
      citationCount: 12345,
      references: ['Doe, J. (2019). A prior work.', 'A titled reference', '10.1000/only-doi'],
      source: 'crossref',
    });
  });

  it('leaves every missing field undefined', () => {
    const record = parseCrossref(CROSSREF_MINIMAL);
    expect(record).toEqual({
      doi: '10.1000/abc',
      title: 'A minimal record',
      authors: [],
      source: 'crossref',
    });
    expect(record.venue).toBeUndefined();
    expect(record.year).toBeUndefined();
    expect(record.abstract).toBeUndefined();
    expect(record.citationCount).toBeUndefined();
    expect(record.references).toBeUndefined();
    expect(record.arxiv).toBeUndefined();
  });

  it('reads null members as absent', () => {
    const record = parseCrossref({
      message: {
        DOI: null,
        title: ['A record with nulls'],
        author: null,
        'container-title': null,
        issued: null,
        abstract: null,
        'is-referenced-by-count': null,
        reference: null,
      },
    });
    expect(record).toEqual({ title: 'A record with nulls', authors: [], source: 'crossref' });
  });

  it('reads a year written as a string and ignores a non-year', () => {
    expect(parseCrossref({ message: { title: ['X'], issued: { 'date-parts': [['2019']] } } }).year).toBe(2019);
    expect(parseCrossref({ message: { title: ['X'], issued: { 'date-parts': [[0]] } } }).year).toBeUndefined();
    expect(parseCrossref({ message: { title: ['X'], issued: { 'date-parts': [[2017.5]] } } }).year).toBeUndefined();
  });

  it('drops a DOI that does not validate instead of carrying it', () => {
    expect(parseCrossref({ message: { title: ['X'], DOI: 'not-a-doi' } }).doi).toBeUndefined();
  });

  it('names the path of a malformed payload', () => {
    expectFailure(() => parseCrossref('nope'), 'malformed-payload', '');
    expectFailure(() => parseCrossref(null), 'malformed-payload', '');
    expectFailure(() => parseCrossref({}), 'malformed-payload', 'message');
    expectFailure(() => parseCrossref({ message: [] }), 'malformed-payload', 'message');
    expectFailure(() => parseCrossref({ message: { title: 7 } }), 'malformed-payload', 'message.title');
    expectFailure(() => parseCrossref({ message: { title: [] } }), 'malformed-payload', 'message.title');
    expectFailure(() => parseCrossref({ message: { title: ['X'], DOI: 1 } }), 'malformed-payload', 'message.DOI');
    expectFailure(
      () => parseCrossref({ message: { title: ['X'], author: [{ family: 3 }] } }),
      'malformed-payload',
      'message.author[0].family',
    );
    expectFailure(
      () => parseCrossref({ message: { title: ['X'], 'is-referenced-by-count': 'many' } }),
      'malformed-payload',
      'message.is-referenced-by-count',
    );
    expectFailure(
      () => parseCrossref({ message: { title: ['X'], issued: { 'date-parts': 'soon' } } }),
      'malformed-payload',
      'message.issued.date-parts',
    );
    expectFailure(
      () => parseCrossref({ message: { title: ['X'], issued: { 'date-parts': ['2017'] } } }),
      'malformed-payload',
      'message.issued.date-parts[0]',
    );
    expect(failureOf(() => parseCrossref({ message: { title: 7 } })).message).toContain('message.title');
  });
});

describe('parseSemanticScholar', () => {
  it('maps a full paper into a record', () => {
    expect(parseSemanticScholar(SEMANTIC_SCHOLAR_FULL)).toEqual({
      doi: '10.48550/arXiv.1706.03762',
      arxiv: '1706.03762',
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      venue: 'NeurIPS',
      year: 2017,
      abstract: 'The dominant sequence transduction models are based on complex recurrent networks.',
      citationCount: 12345,
      references: ['A prior work'],
      source: 'semanticscholar',
    });
  });

  it('leaves every missing field undefined', () => {
    const record = parseSemanticScholar({ title: 'A minimal record', authors: [] });
    expect(record).toEqual({ title: 'A minimal record', authors: [], source: 'semanticscholar' });
    expect(record.doi).toBeUndefined();
    expect(record.arxiv).toBeUndefined();
    expect(record.venue).toBeUndefined();
    expect(record.year).toBeUndefined();
    expect(record.abstract).toBeUndefined();
    expect(record.citationCount).toBeUndefined();
    expect(record.references).toBeUndefined();
  });

  it('reads the null members the API sends as absent', () => {
    const record = parseSemanticScholar({
      title: 'A record with nulls',
      authors: [],
      venue: null,
      year: null,
      abstract: null,
      citationCount: null,
      externalIds: null,
      references: null,
    });
    expect(record).toEqual({ title: 'A record with nulls', authors: [], source: 'semanticscholar' });
  });

  it('reads an empty venue and an unversioned arXiv id', () => {
    const record = parseSemanticScholar({
      title: 'X',
      authors: [{ name: 'Ada Lovelace' }],
      venue: '',
      externalIds: { ArXiv: '2401.12345v2' },
    });
    expect(record.venue).toBeUndefined();
    expect(record.arxiv).toBe('2401.12345');
    expect(record.authors).toEqual(['Ada Lovelace']);
  });

  it('names the path of a malformed payload', () => {
    expectFailure(() => parseSemanticScholar(null), 'malformed-payload', '');
    expectFailure(() => parseSemanticScholar([]), 'malformed-payload', '');
    expectFailure(() => parseSemanticScholar({ authors: [] }), 'malformed-payload', 'title');
    expectFailure(() => parseSemanticScholar({ title: 7 }), 'malformed-payload', 'title');
    expectFailure(
      () => parseSemanticScholar({ title: 'X', authors: 'Vaswani' }),
      'malformed-payload',
      'authors',
    );
    expectFailure(
      () => parseSemanticScholar({ title: 'X', authors: [{ name: 3 }] }),
      'malformed-payload',
      'authors[0].name',
    );
    expectFailure(
      () => parseSemanticScholar({ title: 'X', authors: [], year: 'soon' }),
      'malformed-payload',
      'year',
    );
    expectFailure(
      () => parseSemanticScholar({ title: 'X', authors: [], externalIds: [] }),
      'malformed-payload',
      'externalIds',
    );
    expect(failureOf(() => parseSemanticScholar({ title: 7 })).message).toContain('title');
  });
});

describe('mergeRecords', () => {
  const left: PaperRecord = {
    title: 'Left title',
    authors: ['Ada Lovelace'],
    doi: '10.1000/left',
    year: 2017,
    source: 'crossref',
  };
  const right: PaperRecord = {
    title: 'Right title',
    authors: [],
    venue: 'Right venue',
    abstract: 'Right abstract',
    citationCount: 7,
    references: ['r1', 'r2'],
    arxiv: '2401.12345',
    source: 'semanticscholar',
  };

  it('prefers the record that carries each field and records which one it was', () => {
    expect(mergeRecords(left, right)).toEqual({
      title: 'Left title',
      authors: ['Ada Lovelace'],
      doi: '10.1000/left',
      year: 2017,
      venue: 'Right venue',
      abstract: 'Right abstract',
      citationCount: 7,
      references: ['r1', 'r2'],
      arxiv: '2401.12345',
      sources: {
        title: 'crossref',
        authors: 'crossref',
        doi: 'crossref',
        year: 'crossref',
        venue: 'semanticscholar',
        abstract: 'semanticscholar',
        citationCount: 'semanticscholar',
        references: 'semanticscholar',
        arxiv: 'semanticscholar',
      },
    });
  });

  it('accounts for every field of the record and nothing else', () => {
    const merged = mergeRecords(left, right);
    expect(Object.keys(merged.sources).sort()).toEqual([...PAPER_FIELDS].sort());
  });

  it('copies the lists it read and leaves its inputs alone', () => {
    const merged = mergeRecords(left, right);
    expect(merged.authors).not.toBe(left.authors);
    expect(merged.references).not.toBe(right.references);
    expect(merged.authors).toEqual(['Ada Lovelace']);
    expect(merged.references).toEqual(['r1', 'r2']);
    expect(left.title).toBe('Left title');
    expect(right.authors).toEqual([]);
  });

  it('falls back to the argument side when a record names no source', () => {
    const merged = mergeRecords(
      { title: '', authors: [] },
      { title: 'From the right', authors: ['Marie Curie'], venue: 'A venue' },
    );
    expect(merged).toEqual({
      title: 'From the right',
      authors: ['Marie Curie'],
      venue: 'A venue',
      sources: { title: 'right', authors: 'right', venue: 'right' },
    });
  });

  it('takes the left value when both records carry the field', () => {
    const merged = mergeRecords(
      { title: 'Left wins', authors: [], source: 'crossref' },
      { title: 'Right loses', authors: ['Right author'] },
    );
    expect(merged.title).toBe('Left wins');
    expect(merged.authors).toEqual(['Right author']);
    expect(merged.sources).toEqual({ title: 'crossref', authors: 'right' });
  });

  it('merges what the two APIs actually answered', () => {
    const merged = mergeRecords(parseCrossref(CROSSREF_MINIMAL), parseSemanticScholar(SEMANTIC_SCHOLAR_FULL));
    expect(merged.doi).toBe('10.1000/abc');
    expect(merged.title).toBe('A minimal record');
    expect(merged.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer']);
    expect(merged.venue).toBe('NeurIPS');
    expect(merged.year).toBe(2017);
    expect(merged.references).toEqual(['A prior work']);
    expect(merged.sources).toEqual({
      doi: 'crossref',
      title: 'crossref',
      authors: 'semanticscholar',
      venue: 'semanticscholar',
      year: 'semanticscholar',
      abstract: 'semanticscholar',
      citationCount: 'semanticscholar',
      references: 'semanticscholar',
      arxiv: 'semanticscholar',
    });
  });
});

describe('toBibTeXEntry', () => {
  it('writes the fields a citation renders, under a stable key', () => {
    const entry = toBibTeXEntry(parseCrossref(CROSSREF_FULL));
    expect(entry.type).toBe('article');
    expect(entry.key).toBe('vaswani2017attention');
    expect(entry.fields).toEqual({
      author: 'Ashish Vaswani and Noam Shazeer and Google Brain',
      title: 'Attention Is All You Need',
      journal: 'Advances in Neural Information Processing Systems',
      year: '2017',
      doi: '10.48550/arXiv.1706.03762',
      eprint: '1706.03762',
      archiveprefix: 'arXiv',
      abstract: 'We propose the Transformer, a model & architecture.',
    });
  });

  it('round-trips through parseBibTeX', () => {
    const entry = toBibTeXEntry(parseSemanticScholar(SEMANTIC_SCHOLAR_FULL));
    const parsed = parseBibTeX(toBibTeX([entry]));

    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toEqual({ type: entry.type, key: entry.key, fields: entry.fields });

    const [roundTripped] = parsed.entries;
    expect(roundTripped?.key).toBe(entry.key);
    expect(roundTripped?.fields.title).toBe('Attention Is All You Need');
    expect(roundTripped?.fields.author).toBe('Ashish Vaswani and Noam Shazeer');
    expect(roundTripped?.fields.year).toBe('2017');
    expect(roundTripped?.fields.doi).toBe('10.48550/arXiv.1706.03762');
  });

  it('keeps the same key for the same record every time', () => {
    const first = toBibTeXEntry(parseCrossref(CROSSREF_FULL)).key;
    const second = toBibTeXEntry(parseCrossref(CROSSREF_FULL)).key;
    expect(first).toBe(second);
    expect(first).toBe('vaswani2017attention');
  });

  it('writes a record without a venue as @misc and keeps its braces', () => {
    const entry = toBibTeXEntry({ title: 'The {TeX}book', authors: ['Donald Knuth'], year: 1984 });
    expect(entry.type).toBe('misc');
    // The key is bibtex.ts's `firstAuthorYearFirstWord`; the first word here is `The`.
    expect(entry.key).toBe('knuth1984the');
    expect(entry.fields).toEqual({
      author: 'Donald Knuth',
      title: 'The {TeX}book',
      year: '1984',
    });

    const [roundTripped] = parseBibTeX(toBibTeX([entry])).entries;
    expect(roundTripped?.fields.title).toBe('The {TeX}book');
  });

  it('still produces a key for a record that names almost nothing', () => {
    const entry = toBibTeXEntry({ title: 'Untitled work', authors: [] });
    expect(entry.key).toBe('anonuntitled');
    expect(entry.fields).toEqual({ title: 'Untitled work' });
  });
});
