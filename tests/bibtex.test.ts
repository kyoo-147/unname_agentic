import { describe, expect, it } from 'vitest';
import {
  BIBTEX_ENTRY_TYPES,
  dedupe,
  formatCitation,
  parseBibTeX,
  stableKey,
  stableKeys,
  toBibTeX,
} from '../src/core/bibtex';
import type { Entry } from '../src/core/bibtex';

/** Every record a paper's .bib file is likely to carry, one of each named type. */
const SIX_TYPES = [
  '@article{art1, author = {Nguyễn, Văn An}, title = {Alpha}, journal = {J}, year = {2020}}',
  '@inproceedings{conf1, author = {Doe, Jane}, title = {Beta}, booktitle = {Proc. Conf}, year = {2018}, pages = {1--9}}',
  '@book{book1, author = {Doe, Jane}, title = {Gamma}, publisher = {Pub}, year = {2019}}',
  '@misc{web1, author = {Doe, Jane}, title = {Delta}, url = {https://example.test/d}}',
  '@techreport{tr1, author = {Doe, Jane}, title = {Epsilon}, institution = {Lab}, number = {TR-1}, year = {2017}}',
  '@phdthesis{th1, author = {Doe, Jane}, title = {Zeta}, school = {Uni}, year = {2016}}',
].join('\n\n');

function entriesOf(text: string): Entry[] {
  return parseBibTeX(text).entries;
}

function firstEntry(text: string): Entry {
  const [entry] = parseBibTeX(text).entries;
  if (entry === undefined) throw new Error(`fixture produced no entry: ${text.slice(0, 60)}`);
  return entry;
}

describe('parseBibTeX', () => {
  it('reads every named entry type', () => {
    const parsed = parseBibTeX(SIX_TYPES);
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries.map(entry => entry.type)).toEqual([...BIBTEX_ENTRY_TYPES]);
    expect(parsed.entries.map(entry => entry.key)).toEqual(['art1', 'conf1', 'book1', 'web1', 'tr1', 'th1']);
    expect(parsed.entries[1]?.fields.booktitle).toBe('Proc. Conf');
    expect(parsed.entries[3]?.fields.url).toBe('https://example.test/d');
  });

  it('keeps nested braces, escaped braces and escaped quotes', () => {
    const entry = firstEntry([
      '@article{nested,',
      '  title = {Deep {L}earning and \\{literal braces\\}},',
      '  note = "A \\"quoted\\" note",',
      '  year = 2020',
      '}',
    ].join('\n'));
    expect(entry.fields.title).toBe('Deep {L}earning and \\{literal braces\\}');
    expect(entry.fields.note).toBe('A \\"quoted\\" note');
    expect(entry.fields.year).toBe('2020');
  });

  it('collapses a value written over several lines', () => {
    const entry = firstEntry('@misc{m,\n  title = {A title\n     over two lines},\n  year = {2020}\n}');
    expect(entry.fields.title).toBe('A title over two lines');
  });

  it('folds journaltitle into journal and date into year', () => {
    const [fromAlias, withCanonical] = entriesOf([
      '@article{alias1,',
      '  title = {Alias},',
      '  journaltitle = {Journal of Tests},',
      '  date = {2020-05-01}',
      '}',
      '@article{alias2,',
      '  title = {Both},',
      '  journal = {Canonical Journal},',
      '  journaltitle = {Other Journal},',
      '  year = {2019},',
      '  date = {2019-01-01}',
      '}',
    ].join('\n'));
    expect(fromAlias?.fields.journal).toBe('Journal of Tests');
    expect(fromAlias?.fields.year).toBe('2020');
    expect(fromAlias?.fields.journaltitle).toBeUndefined();
    expect(fromAlias?.fields.date).toBeUndefined();
    expect(withCanonical?.fields.journal).toBe('Canonical Journal');
    expect(withCanonical?.fields.year).toBe('2019');
  });

  it('skips @string safely and keeps a macro use as written', () => {
    const parsed = parseBibTeX([
      '@string{acm = "ACM Press"}',
      '@preamble{"\\newcommand{\\noopsmallnote}{}"}',
      '@comment{this is prose, not a record}',
      '@article{macro1, journal = acm, title = {T}, year = {2020}}',
    ].join('\n'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.fields.journal).toBe('acm');
  });

  it('reports a malformed record by line and keeps parsing the others', () => {
    const text = [
      '@article{good1,',
      '  title = {Alpha},',
      '  year = {2020}',
      '}',
      '@article{broken,',
      '  title {Missing equals},',
      '  year = {2021}',
      '}',
      '@article{good2,',
      '  title = {Beta},',
      '  year = {2021}',
      '}',
    ].join('\n');
    const parsed = parseBibTeX(text);
    expect(parsed.entries.map(entry => entry.key)).toEqual(['good1', 'good2']);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.code).toBe('malformed-field');
    expect(parsed.errors[0]?.line).toBe(6);
    expect(parsed.errors[0]?.key).toBe('broken');
    expect(parsed.errors[0]?.entryType).toBe('article');
  });

  it('refuses # concatenation with the line of the field', () => {
    const parsed = parseBibTeX([
      '@article{joined,',
      '  title = "Alpha" # "Beta",',
      '  year = {2020}',
      '}',
      '@article{kept, title = {Fine}, year = {2021}}',
    ].join('\n'));
    expect(parsed.entries.map(entry => entry.key)).toEqual(['kept']);
    expect(parsed.errors[0]?.code).toBe('concatenation');
    expect(parsed.errors[0]?.line).toBe(2);
    expect(parsed.errors[0]?.message).toContain('#');
  });

  it('reports a record that never closes and resumes at the next line record', () => {
    const parsed = parseBibTeX([
      '@article{broken, title = {No close},',
      '@article{nextone, title = {Fine}, year = {2020}}',
    ].join('\n'));
    expect(parsed.entries.map(entry => entry.key)).toEqual(['nextone']);
    expect(parsed.errors[0]?.code).toBe('unbalanced-entry');
    expect(parsed.errors[0]?.line).toBe(1);
  });

  it('reads a parenthesised record', () => {
    const entry = firstEntry('@article(paren1, title = {Fine}, year = {2020})');
    expect(entry.key).toBe('paren1');
    expect(entry.fields.title).toBe('Fine');
  });

  it('returns no records and no errors for text that carries none', () => {
    expect(parseBibTeX('')).toEqual({ entries: [], errors: [] });
    expect(parseBibTeX('plain prose, no records here')).toEqual({ entries: [], errors: [] });
    const junk = parseBibTeX('@');
    expect(junk.entries).toEqual([]);
    expect(junk.errors[0]?.code).toBe('missing-type');
  });
});

describe('stable keys', () => {
  it('builds firstAuthorYearFirstWord for a Vietnamese record', () => {
    const entry = firstEntry([
      '@article{sample,',
      '  author = {Nguyễn, Văn An and Trần, Thị Bích},',
      '  title = {Đổi mới giáo dục ở Việt Nam},',
      '  journaltitle = {Tạp chí Giáo dục},',
      '  date = {2021-06-01}',
      '}',
    ].join('\n'));
    expect(stableKey(entry)).toBe('nguyen2021doi');
  });

  it('folds accented letters and removes non-alphanumerics', () => {
    const umlaut = firstEntry('@article{m, author = {Müller, Eva}, title = {Über die Kunst}, year = {2019}}');
    expect(stableKey(umlaut)).toBe('muller2019uber');

    const hyphenated = firstEntry('@book{h, author = {Al-Sayed, Omar}, title = {Notes}, year = {2015}}');
    expect(stableKey(hyphenated)).toBe('alsayed2015notes');
  });

  it('falls back to the editor for an edited book', () => {
    const entry = firstEntry('@book{ed, editor = {Müller, Eva}, title = {Handbuch}, year = {2019}}');
    expect(stableKey(entry)).toBe('muller2019handbuch');
  });

  it('suffixes a colliding pair in input order', () => {
    const entries = entriesOf([
      '@article{c1, author = {Lê, Quý Đôn}, title = {Đạo đức học}, year = {2020}}',
      '@article{c2, author = {Lê, Quý Đôn}, title = {Đạo đức và giáo dục}, year = {2020}}',
    ].join('\n'));
    expect(stableKeys(entries)).toEqual(['le2020daoa', 'le2020daob']);
    // Alone the base is free, so stableKey reports it; the batch is what renames the pair.
    expect(stableKey(entries[0] as Entry)).toBe('le2020dao');
    expect(stableKey(entries[1] as Entry, [entries[0] as Entry])).toBe('le2020daob');
  });

  it('steps a unique base aside when a suffixed sibling took its spelling', () => {
    const entries = entriesOf([
      '@misc{x1, author = {Foo}, year = {2020}}',
      '@misc{x2, author = {Foo}, year = {2020}}',
      '@misc{x3, author = {Foo}, year = {2020}, title = {A}}',
    ].join('\n'));
    // The group takes `foo2020a`/`foo2020b`; the record whose base is `foo2020a`
    // cannot duplicate either of them.
    expect(stableKeys(entries)).toEqual(['foo2020a', 'foo2020b', 'foo2020aa']);
  });

  it('leaves a unique key unsuffixed', () => {
    const entries = entriesOf([
      '@article{u1, author = {Lê, Quý Đôn}, title = {Đạo đức học}, year = {2020}}',
      '@article{u2, author = {Lê, Quý Đôn}, title = {Một câu chuyện}, year = {2020}}',
    ].join('\n'));
    expect(stableKeys(entries)).toEqual(['le2020dao', 'le2020mot']);
  });
});

describe('dedupe', () => {
  it('merges the same DOI under the same key and unions the fields', () => {
    const entries = entriesOf([
      '@article{smith2020,',
      '  author = {Smith, Ann},',
      '  title = {One Work},',
      '  year = {2020},',
      '  doi = {10.1000/XYZ},',
      '  abstract = {First}',
      '}',
      '@article{smith2020,',
      '  author = {Smith, Ann},',
      '  title = {One Work},',
      '  year = {2020},',
      '  doi = {https://doi.org/10.1000/xyz},',
      '  note = {arXiv preprint}',
      '}',
    ].join('\n'));
    const result = dedupe(entries);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.fields.abstract).toBe('First');
    expect(result.entries[0]?.fields.note).toBe('arXiv preprint');
    expect(result.merged).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('refuses the same DOI under two keys and reports the winner', () => {
    const entries = entriesOf([
      '@article{smith2020, author = {Smith, Ann}, title = {One}, year = {2020}, doi = {10.1000/x}}',
      '@article{smith2020b, author = {Smith, Ann}, title = {One}, year = {2020}, doi = {10.1000/X}}',
    ].join('\n'));
    const result = dedupe(entries);
    expect(result.entries.map(entry => entry.key)).toEqual(['smith2020', 'smith2020b']);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ winner: 'smith2020', rejected: 'smith2020b', doi: '10.1000/x' });
    expect(result.conflicts[0]?.message).toContain('smith2020');
  });

  it('merges by title and year when no DOI settles it', () => {
    const entries = entriesOf([
      '@article{alpha2020, author = {Alpha, A.}, title = {Same Title}, year = {2020}, abstract = {x}}',
      '@article{alpha2020b, author = {Alpha, A.}, title = {same  title!}, year = {2020}, note = {y}}',
    ].join('\n'));
    const result = dedupe(entries);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.key).toBe('alpha2020');
    expect(result.entries[0]?.fields.note).toBe('y');
    expect(result.merged).toEqual([{ reason: 'title-year', keptKey: 'alpha2020', droppedKeys: ['alpha2020b'] }]);
  });

  it('keeps two works with the same title and year when their DOIs differ', () => {
    const entries = entriesOf([
      '@article{ed1, author = {Alpha, A.}, title = {Editorial}, year = {2020}, doi = {10.1/one}}',
      '@article{ed2, author = {Beta, B.}, title = {Editorial}, year = {2020}, doi = {10.1/two}}',
    ].join('\n'));
    const result = dedupe(entries);
    expect(result.entries.map(entry => entry.key)).toEqual(['ed1', 'ed2']);
    expect(result.merged).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('does not modify the input records', () => {
    const entries = entriesOf([
      '@article{a, title = {Same}, year = {2020}}',
      '@article{b, title = {Same}, year = {2020}, note = {later}}',
    ].join('\n'));
    const before = JSON.stringify(entries);
    dedupe(entries);
    expect(JSON.stringify(entries)).toBe(before);
  });
});

describe('toBibTeX', () => {
  it('writes a fixed field order with two-space indent and a trailing comma', () => {
    const entry = firstEntry(
      '@book{knuth1984, author = {Knuth, Donald E.}, title = {The {TeX}book}, publisher = {Addison-Wesley}, year = {1984}}',
    );
    expect(toBibTeX([entry])).toBe([
      '@book{knuth1984,',
      '  author = {Knuth, Donald E.},',
      '  title = {The {TeX}book},',
      '  publisher = {Addison-Wesley},',
      '  year = {1984},',
      '}',
      '',
    ].join('\n'));
  });

  it('round-trips parse(toBibTeX(entries)) without changing a record', () => {
    const entries = entriesOf([
      '@article{one,',
      '  author = {Nguyễn, Văn An},',
      '  title = {The {TeX}book of {Đổi}},',
      '  journal = {J},',
      '  year = {2021},',
      '  volume = {2},',
      '  number = {1},',
      '  pages = {3--4},',
      '  doi = {10.1/x}',
      '}',
      '@book{two, author = {Knuth, Donald E.}, title = {Concrete Mathematics}, publisher = {AW}, year = {1994}}',
      '@misc{three, author = {Doe, Jane}, title = {A "strange" title}, url = {https://example.test}}',
    ].join('\n'));
    const written = toBibTeX(entries);
    const reread = parseBibTeX(written);
    expect(reread.errors).toEqual([]);
    expect(reread.entries).toEqual(entries);
  });

  it('escapes a brace that could not balance', () => {
    // Parsed values always balance: an unescaped brace would have closed the record.
    // A caller-supplied value need not, and the writer has to keep the record readable.
    const entry: Entry = { type: 'misc', key: 'odd', fields: { title: 'A } brace', year: '2020' } };
    const written = toBibTeX([entry]);
    expect(written).toContain('\\}');
    const reread = parseBibTeX(written);
    expect(reread.errors).toEqual([]);
    expect(reread.entries[0]?.fields.title).toBe('A \\} brace');
  });

  it('writes nothing for no records', () => {
    expect(toBibTeX([])).toBe('');
  });
});

describe('formatCitation', () => {
  const one = firstEntry('@article{n, author = {Nguyễn, Văn An}, title = {T}, year = {2021}}');
  const two = firstEntry(
    '@article{n2, author = {Nguyễn, Văn An and Trần, Thị Bích}, title = {T}, year = {2021}}',
  );
  const three = firstEntry(
    '@article{n3, author = {Nguyễn, Văn An and Trần, Thị Bích and Lê, Quý Đôn}, title = {T}, year = {2021}}',
  );

  it('prints the numeric position, defaulting to the first', () => {
    expect(formatCitation(one, 'numeric')).toBe('[1]');
    expect(formatCitation(one, 'numeric', { number: 4 })).toBe('[4]');
  });

  it('prints author-year for one, two and three authors', () => {
    expect(formatCitation(one, 'author-year')).toBe('(Nguyễn, 2021)');
    expect(formatCitation(two, 'author-year')).toBe('(Nguyễn & Trần, 2021)');
    expect(formatCitation(three, 'author-year')).toBe('(Nguyễn et al., 2021)');
  });

  it('prints n.d. when the record has no year and Anon. when it has no author', () => {
    const undated = firstEntry('@misc{u, author = {Nguyễn, Văn An}, title = {T}}');
    expect(formatCitation(undated, 'author-year')).toBe('(Nguyễn, n.d.)');
    const anonymous = firstEntry('@misc{a, title = {T}, year = {2020}}');
    expect(formatCitation(anonymous, 'author-year')).toBe('(Anon., 2020)');
  });

  it('prints an APA-lite journal reference', () => {
    const entry = firstEntry([
      '@article{sample,',
      '  author = {Nguyễn, Văn An and Trần, Thị Bích},',
      '  title = {Đổi mới giáo dục ở Việt Nam},',
      '  journaltitle = {Tạp chí Giáo dục},',
      '  date = {2021-06-01},',
      '  volume = {12},',
      '  number = {3},',
      '  pages = {45--67},',
      '  doi = {10.1234/abc}',
      '}',
    ].join('\n'));
    expect(formatCitation(entry, 'apa')).toBe(
      'Nguyễn, V. A., & Trần, T. B. (2021). Đổi mới giáo dục ở Việt Nam. Tạp chí Giáo dục, 12(3), 45–67. https://doi.org/10.1234/abc',
    );
  });

  it('prints an APA-lite book and conference paper', () => {
    const book = firstEntry('@book{b, author = {Knuth, Donald E.}, title = {The {TeX}book}, publisher = {Addison-Wesley}, year = {1984}}');
    expect(formatCitation(book, 'apa')).toBe('Knuth, D. E. (1984). The TeXbook. Addison-Wesley.');

    const paper = firstEntry(
      '@inproceedings{p, author = {Doe, Jane}, title = {Paper}, booktitle = {Proc. X}, year = {2018}, pages = {1--9}}',
    );
    expect(formatCitation(paper, 'apa')).toBe('Doe, J. (2018). Paper. In Proc. X, 1–9.');
  });
});
