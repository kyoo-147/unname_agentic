import { describe, expect, it, vi } from 'vitest';
import { parseBibTeX } from '../viewer/src/core/bibtex';
import type { Entry } from '../viewer/src/core/bibtex';
import {
  DEFAULT_ZOTERO_ENDPOINT,
  ZoteroBridgeError,
  assertLoopbackZoteroUrl,
  bibTeXEntryToRis,
  bibTeXToCslJson,
  buildZoteroSavePayload,
  createZoteroBridge,
  cslJsonToRis,
  dedupeWithBibTeX,
  parseRis,
  risToBibTeXEntries,
  risToBibTeXEntry,
  risToCslJson,
  serializeRis,
} from '../viewer/src/core/ris-zotero';
import type { CslJsonItem, RisRecord } from '../viewer/src/core/ris-zotero';

const SAMPLE_RIS = [
  'TY  - JOUR',
  'AU  - Vaswani, Ashish',
  'AU  - Shazeer, Noam',
  'TI  - Attention Is All You Need',
  'JO  - Advances in Neural Information Processing Systems',
  'T2  - NeurIPS 2017',
  'PY  - 2017///',
  'VL  - 30',
  'IS  - 1',
  'SP  - 5998',
  'EP  - 6008',
  'DO  - https://doi.org/10.48550/arXiv.1706.03762',
  'UR  - https://proceedings.neurips.cc/paper/2017',
  'AB  - We propose a new simple network architecture, the Transformer.',
  'KW  - transformer',
  'KW  - self-attention',
  'ER  -',
  '',
  'TY  - CONF',
  'AU  - Nguyen, Linh',
  'AU  - Miller, David',
  'TI  - Layout Preserving Translation',
  'T2  - Proceedings of DocEng',
  'PY  - 2024',
  'SP  - 10',
  'EP  - 22',
  'DO  - 10.1145/3544548.3581234',
  'ER  - ',
  '',
].join('\r\n');

describe('RIS parsing and serialization', () => {
  it('parses all core RIS tags (TY, AU, TI, JO/T2, PY, VL, IS, SP, EP, DO, UR, AB, KW, ER)', () => {
    const parsed = parseRis(SAMPLE_RIS);
    expect(parsed.errors).toEqual([]);
    expect(parsed.records).toHaveLength(2);

    expect(parsed.records[0]).toEqual({
      type: 'JOUR',
      authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
      title: 'Attention Is All You Need',
      journal: 'Advances in Neural Information Processing Systems',
      secondaryTitle: 'NeurIPS 2017',
      year: '2017',
      volume: '30',
      issue: '1',
      startPage: '5998',
      endPage: '6008',
      doi: '10.48550/arXiv.1706.03762',
      url: 'https://proceedings.neurips.cc/paper/2017',
      abstract: 'We propose a new simple network architecture, the Transformer.',
      keywords: ['transformer', 'self-attention'],
    });

    expect(parsed.records[1]).toEqual({
      type: 'CONF',
      authors: ['Nguyen, Linh', 'Miller, David'],
      title: 'Layout Preserving Translation',
      secondaryTitle: 'Proceedings of DocEng',
      year: '2024',
      startPage: '10',
      endPage: '22',
      doi: '10.1145/3544548.3581234',
      keywords: [],
    });
  });

  it('handles wrapped continuation lines, BOM, and malformed/unterminated records without throwing', () => {
    const risWithIssues = [
      '\uFEFFAU  - Stray, Author',
      'TY  - JOUR',
      'TI  - Multi-line',
      '  Title Continuation',
      'AB  - First line of abstract',
      '  and second line of abstract.',
      'ER  -',
      'TY  - JOUR',
      'TI  - Unterminated Record At EOF',
    ].join('\n');

    const parsed = parseRis(risWithIssues);
    expect(parsed.errors.map(err => err.code)).toEqual([
      'tag-outside-record',
      'unterminated-record',
    ]);
    expect(parsed.errors[0]?.line).toBe(1);
    expect(parsed.errors[1]?.line).toBe(8);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]?.title).toBe('Multi-line Title Continuation');
    expect(parsed.records[0]?.abstract).toBe(
      'First line of abstract and second line of abstract.',
    );
  });

  it('serializes canonical RIS and round-trips cleanly', () => {
    const parsed = parseRis(SAMPLE_RIS);
    const serialized = serializeRis(parsed.records);
    expect(serialized).toContain('TY  - JOUR\n');
    expect(serialized).toContain('AU  - Vaswani, Ashish\n');
    expect(serialized).toContain('JO  - Advances in Neural Information Processing Systems\n');
    expect(serialized).toContain('T2  - NeurIPS 2017\n');
    expect(serialized).toContain('SP  - 5998\nEP  - 6008\n');
    expect(serialized).toContain('KW  - transformer\nKW  - self-attention\n');
    expect(serialized).toContain('ER  -\n');

    const roundTripped = parseRis(serialized);
    expect(roundTripped.errors).toEqual([]);
    expect(roundTripped.records).toEqual(parsed.records);
    expect(serializeRis([])).toBe('');
  });
});

describe('stable citation keys and BibTeX deduplication', () => {
  it('generates deterministic stable citation keys for single and colliding RIS batches', () => {
    const first: RisRecord = {
      type: 'JOUR',
      authors: ['Nguyễn, Văn An'],
      title: 'Đổi mới giáo dục',
      journal: 'Journal of Education',
      year: '2021',
      keywords: [],
    };
    const second: RisRecord = {
      type: 'CONF',
      authors: ['Nguyễn, Văn An'],
      title: 'Đổi mới công nghệ',
      secondaryTitle: 'Conf Proc',
      year: '2021',
      keywords: [],
    };

    expect(risToBibTeXEntry(first).key).toBe('nguyen2021doi');

    const entries = risToBibTeXEntries([first, second]);
    expect(entries.map(entry => entry.key)).toEqual(['nguyen2021doia', 'nguyen2021doib']);
    expect(entries[0]?.type).toBe('article');
    expect(entries[1]?.type).toBe('inproceedings');
    expect(entries[1]?.fields.booktitle).toBe('Conf Proc');
  });

  it('round-trips BibTeX entries to RIS preserving pages, authors, and keywords', () => {
    const entry: Entry = {
      type: 'inproceedings',
      key: 'nguyen2024layout',
      fields: {
        author: 'Nguyen, Linh and Miller, David',
        title: 'Layout Preserving Translation',
        booktitle: 'DocEng',
        year: '2024',
        volume: '4',
        number: '2',
        pages: '10--22',
        doi: 'https://doi.org/10.1145/3544548.3581234',
        url: 'https://example.test/doceng',
        abstract: 'Summary text.',
        keywords: 'translation, layout',
      },
    };

    const ris = bibTeXEntryToRis(entry);
    expect(ris).toEqual({
      type: 'CONF',
      authors: ['Nguyen, Linh', 'Miller, David'],
      title: 'Layout Preserving Translation',
      secondaryTitle: 'DocEng',
      year: '2024',
      volume: '4',
      issue: '2',
      startPage: '10',
      endPage: '22',
      doi: '10.1145/3544548.3581234',
      url: 'https://example.test/doceng',
      abstract: 'Summary text.',
      keywords: ['translation', 'layout'],
    });
  });

  it('deduplicates RIS records against existing BibTeX by DOI and title+year while protecting conflicting keys', () => {
    const existingBib = [
      '@article{vaswani2017attention,',
      '  author = {Vaswani, Ashish and Shazeer, Noam},',
      '  title = {Attention Is All You Need},',
      '  journal = {NeurIPS},',
      '  year = {2017},',
      '  doi = {10.48550/arXiv.1706.03762},',
      '}',
      '',
      '@article{custom_key_paper,',
      '  author = {Smith, Alice},',
      '  title = {Custom Key Paper},',
      '  journal = {JMLR},',
      '  year = {2020},',
      '  doi = {10.1000/custom-doi},',
      '}',
    ].join('\n');

    const incoming: RisRecord[] = [
      // Same work as vaswani2017attention: enriches missing pages & abstract without duplicating.
      {
        type: 'JOUR',
        authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
        title: 'Attention Is All You Need',
        journal: 'NeurIPS',
        year: '2017',
        startPage: '5998',
        endPage: '6008',
        doi: '10.48550/arXiv.1706.03762',
        abstract: 'Enriched from RIS.',
        keywords: [],
      },
      // Same title+year without DOI as a second copy of a new paper -> title-year merge.
      {
        type: 'JOUR',
        authors: ['Lee, Hana'],
        title: 'Fresh Paper Title',
        journal: 'ACL',
        year: '2023',
        keywords: [],
      },
      {
        type: 'JOUR',
        authors: ['Lee, Hana'],
        title: 'Fresh Paper Title',
        journal: 'ACL',
        year: '2023',
        url: 'https://aclanthology.org/2023.acl-1.1',
        keywords: [],
      },
      // Same DOI as custom_key_paper under a different derived key -> conflict preserved.
      {
        type: 'JOUR',
        authors: ['Smith, Alice'],
        title: 'Custom Key Paper',
        journal: 'JMLR',
        year: '2020',
        doi: '10.1000/custom-doi',
        keywords: [],
      },
      // Distinct paper whose base key collides with custom/lee or another distinct work.
      {
        type: 'JOUR',
        authors: ['Lee, Hana'],
        title: 'Fresh Start Elsewhere',
        journal: 'EMNLP',
        year: '2023',
        keywords: [],
      },
    ];

    const result = dedupeWithBibTeX(incoming, existingBib);
    expect(result.parseErrors).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.winner).toBe('custom_key_paper');
    expect(result.conflicts[0]?.rejected).toBe('smith2020custom');
    expect(result.merged.some(item => item.reason === 'title-year')).toBe(true);

    const vaswani = result.entries.find(entry => entry.key === 'vaswani2017attention');
    expect(vaswani?.fields.pages).toBe('5998--6008');
    expect(vaswani?.fields.abstract).toBe('Enriched from RIS.');

    const leeKeys = result.entries
      .filter(entry => entry.fields.author === 'Lee, Hana')
      .map(entry => entry.key);
    expect(new Set(leeKeys).size).toBe(2);
    expect(parseBibTeX(result.bibtex).errors).toEqual([]);
  });
});

describe('CSL-JSON mapping', () => {
  it('maps RIS and BibTeX records to CSL-JSON and back cleanly', () => {
    const ris: RisRecord = {
      type: 'JOUR',
      authors: ['Vaswani, Ashish', 'Google Brain'],
      title: 'Attention Is All You Need',
      journal: 'NeurIPS',
      year: '2017',
      volume: '30',
      issue: '1',
      startPage: '5998',
      endPage: '6008',
      doi: '10.48550/arXiv.1706.03762',
      url: 'https://example.test/paper',
      abstract: 'Transformer architecture.',
      keywords: ['attention', 'nlp'],
    };

    const csl = risToCslJson(ris);
    expect(csl).toEqual({
      id: 'vaswani2017attention',
      type: 'article-journal',
      title: 'Attention Is All You Need',
      author: [
        { family: 'Vaswani', given: 'Ashish' },
        { family: 'Brain', given: 'Google' },
      ],
      'container-title': 'NeurIPS',
      issued: { 'date-parts': [[2017]] },
      volume: '30',
      issue: '1',
      page: '5998-6008',
      DOI: '10.48550/arXiv.1706.03762',
      URL: 'https://example.test/paper',
      abstract: 'Transformer architecture.',
      keyword: 'attention, nlp',
    });

    const roundTripped = cslJsonToRis(csl);
    expect(roundTripped).toEqual({
      type: 'JOUR',
      authors: ['Vaswani, Ashish', 'Brain, Google'],
      title: 'Attention Is All You Need',
      journal: 'NeurIPS',
      year: '2017',
      volume: '30',
      issue: '1',
      startPage: '5998',
      endPage: '6008',
      doi: '10.48550/arXiv.1706.03762',
      url: 'https://example.test/paper',
      abstract: 'Transformer architecture.',
      keywords: ['attention', 'nlp'],
    });

    const fromBib = bibTeXToCslJson({
      type: 'inproceedings',
      key: 'doe2022demo',
      fields: {
        author: 'Doe, Jane',
        title: 'Demo',
        booktitle: 'Workshop',
        year: '2022',
        pages: '1--5',
      },
    });
    expect(fromBib.id).toBe('doe2022demo');
    expect(fromBib.type).toBe('paper-conference');
    expect(fromBib['container-title']).toBe('Workshop');
    expect(fromBib.page).toBe('1-5');

    const cslWithLiteral: CslJsonItem = {
      id: 'org2023report',
      type: 'report',
      title: 'Annual Report',
      author: [{ literal: 'World Health Organization' }],
      issued: { 'date-parts': [[2023, 4]] },
    };
    expect(cslJsonToRis(cslWithLiteral)).toMatchObject({
      type: 'RPRT',
      authors: ['World Health Organization'],
      year: '2023',
    });
  });
});

describe('Zotero local connector loopback guard', () => {
  it('accepts 127.0.0.1 and localhost URLs and rejects every non-loopback or unsafe host', () => {
    expect(assertLoopbackZoteroUrl(DEFAULT_ZOTERO_ENDPOINT).origin).toBe('http://127.0.0.1:23119');
    expect(assertLoopbackZoteroUrl('http://localhost:23119/connector/saveItems').hostname).toBe(
      'localhost',
    );
    expect(assertLoopbackZoteroUrl('https://127.0.0.1:23119').origin).toBe(
      'https://127.0.0.1:23119',
    );

    const rejectedHosts = [
      'https://api.zotero.org',
      'https://zotero.org/connector/saveItems',
      'http://192.168.1.50:23119',
      'http://10.0.0.5:23119',
      'http://172.16.0.1:23119',
      'http://0.0.0.0:23119',
      'http://localhost.evil.com:23119',
      'http://127.0.0.1.nip.io:23119',
      'http://127.0.0.1@evil.com:23119',
      'http://[::1]:23119',
      'http://user:pass@127.0.0.1:23119',
      'ftp://127.0.0.1:23119',
      'javascript:alert(1)',
      'not-a-url',
      '',
    ];

    for (const candidate of rejectedHosts) {
      expect(() => assertLoopbackZoteroUrl(candidate), candidate).toThrowError(ZoteroBridgeError);
      expect(() => createZoteroBridge({ endpoint: candidate }), candidate).toThrowError(
        ZoteroBridgeError,
      );
    }
  });

  it('never invokes fetch when given a non-loopback host, and sends Zotero payloads only to loopback', async () => {
    const spyFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 201 }),
    );

    expect(() =>
      createZoteroBridge({ endpoint: 'https://api.zotero.org', fetch: spyFetch }),
    ).toThrowError(ZoteroBridgeError);
    expect(spyFetch).not.toHaveBeenCalled();

    const bridge = createZoteroBridge({
      endpoint: 'http://localhost:23119',
      fetch: spyFetch,
    });

    const pingResult = await bridge.ping();
    expect(pingResult).toEqual({
      ok: true,
      endpoint: 'http://localhost:23119',
      status: 201,
    });

    const ris: RisRecord = {
      type: 'JOUR',
      authors: ['Nguyen, Linh'],
      title: 'Loopback Zotero Test',
      journal: 'Journal of Local Tests',
      year: '2024',
      doi: '10.1000/local-test',
      keywords: ['zotero', 'loopback'],
    };

    const payload = buildZoteroSavePayload([ris], { uri: 'https://local.paper/1' });
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      itemType: 'journalArticle',
      title: 'Loopback Zotero Test',
      publicationTitle: 'Journal of Local Tests',
      date: '2024',
      DOI: '10.1000/local-test',
      creators: [{ firstName: 'Linh', lastName: 'Nguyen', creatorType: 'author' }],
      tags: [{ tag: 'zotero' }, { tag: 'loopback' }],
    });

    const saveResult = await bridge.saveItems([ris], { uri: 'https://local.paper/1' });
    expect(saveResult.saved).toBe(1);
    expect(saveResult.status).toBe(201);
    expect(spyFetch).toHaveBeenCalledTimes(2);
    expect(spyFetch.mock.calls[0]?.[0]).toBe('http://localhost:23119/connector/ping');
    expect(spyFetch.mock.calls[1]?.[0]).toBe('http://localhost:23119/connector/saveItems');
    expect((spyFetch.mock.calls[1]?.[1] as RequestInit | undefined)?.redirect).toBe('error');
  });
});
