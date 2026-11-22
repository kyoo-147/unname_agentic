import { describe, expect, it } from 'vitest';
import {
  READ_STATUSES,
  ResearchLibrary,
  SMART_COLLECTIONS_EXPORT_KIND,
  SMART_COLLECTIONS_SCHEMA_VERSION,
  SmartCollectionError,
  authorsMatch,
  normalizeAuthor,
  type ApplyMergeOptions,
  type SmartCollectionSnapshot,
} from '../viewer/src/core/smart-collections';

function tickingClock(start = Date.UTC(2026, 10, 21, 10, 0, 0)): () => string {
  let tick = 0;
  return () => {
    const stamp = new Date(start + tick * 1000).toISOString();
    tick += 1;
    return stamp;
  };
}

function expectError(action: () => unknown, code: string): SmartCollectionError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) {
    throw new Error(`expected SmartCollectionError(${code}) but nothing was thrown`);
  }
  expect(caught).toBeInstanceOf(SmartCollectionError);
  expect((caught as SmartCollectionError).code).toBe(code);
  return caught as SmartCollectionError;
}

describe('ResearchLibrary paper registration', () => {
  it('registers papers with normalized DOI, arXiv ID, authors, topics, tags, readStatus, and linked IDs', () => {
    const lib = new ResearchLibrary({ now: tickingClock() });

    const paper = lib.registerPaper({
      id: '  paper-attn  ',
      doi: 'https://doi.org/10.48550/arXiv.1706.03762',
      arxivId: 'https://arxiv.org/abs/1706.03762v7',
      title: '  Attention   Is All You Need  ',
      authors: ['  Vaswani,   Ashish  ', 'Shazeer, Noam', 'Vaswani, Ashish', '   '],
      year: 2017,
      venue: '  Advances in Neural Information Processing Systems (NeurIPS) ',
      abstract: 'The dominant sequence transduction models rely on attention.',
      topics: ['  Deep Learning ', 'deep learning', 'NLP'],
      tags: ['  Transformers ', 'core', 'CORE'],
      readStatus: 'read',
      noteIds: ['n-1', 'n-2', 'n-1'],
      annotationIds: ['a1', 'a2'],
      citationKeys: ['vaswani2017attention'],
      references: ['10.1145/1234.5678'],
      citationCount: 95000,
    });

    expect(paper.id).toBe('paper-attn');
    expect(paper.doi).toBe('10.48550/arxiv.1706.03762');
    expect(paper.arxivId).toBe('1706.03762');
    expect(paper.title).toBe('Attention Is All You Need');
    expect(paper.authors).toEqual(['Vaswani, Ashish', 'Shazeer, Noam']);
    expect(paper.normalizedAuthors).toEqual(['ashish vaswani', 'noam shazeer']);
    expect(paper.year).toBe(2017);
    expect(paper.venue).toBe('Advances in Neural Information Processing Systems (NeurIPS)');
    expect(paper.topics).toEqual(['Deep Learning', 'NLP']);
    expect(paper.tags).toEqual(['Transformers', 'core']);
    expect(paper.readStatus).toBe('read');
    expect(paper.noteIds).toEqual(['n-1', 'n-2']);
    expect(paper.annotationIds).toEqual(['a1', 'a2']);
    expect(paper.citationKeys).toEqual(['vaswani2017attention']);
    expect(paper.references).toEqual(['10.1145/1234.5678']);
    expect(paper.citationCount).toBe(95000);
    expect(paper.createdAt).toBe('2026-11-21T10:00:00.000Z');
    expect(paper.updatedAt).toBe(paper.createdAt);

    const minimal = lib.registerPaper({ title: 'Untitled Preprint' });
    expect(minimal.id).toBe('p1');
    expect(minimal.readStatus).toBe('unread');
    expect(minimal.authors).toEqual([]);
    expect(minimal.tags).toEqual([]);
    expect(READ_STATUSES).toEqual(['unread', 'reading', 'read', 'archived']);
  });

  it('rejects duplicate ids, invalid DOIs/arXiv IDs, invalid readStatus, and immutable patch fields', () => {
    const lib = new ResearchLibrary({ now: tickingClock() });
    lib.registerPaper({ id: 'p-fixed', title: 'Valid Paper' });

    expectError(() => lib.registerPaper({ id: 'p-fixed', title: 'Duplicate ID' }), 'duplicate-id');
    expectError(() => lib.registerPaper({ title: 'Bad DOI', doi: 'not-a-doi' }), 'invalid-field');
    expectError(() => lib.registerPaper({ title: 'Bad arXiv', arxivId: 'not-arxiv' }), 'invalid-field');
    expectError(
      () => lib.registerPaper({ title: 'Bad Status', readStatus: 'skimming-invalid' as never }),
      'invalid-field',
    );
    expectError(
      () => lib.updatePaper('p-fixed', { id: 'renamed' } as never),
      'immutable-field',
    );
  });

  it('returns defensive clones so external mutations do not corrupt stored records', () => {
    const lib = new ResearchLibrary({ now: tickingClock() });
    const added = lib.registerPaper({ id: 'p1', title: 'Immutable Copy', tags: ['alpha'] });
    added.tags.push('injected');
    added.title = 'Mutated';

    const fetched = lib.getPaper('p1');
    expect(fetched?.tags).toEqual(['alpha']);
    expect(fetched?.title).toBe('Immutable Copy');
  });
});

describe('Smart collection queries and auto-updating views', () => {
  function seedLibrary(): ResearchLibrary {
    const lib = new ResearchLibrary({ now: tickingClock() });
    lib.registerPaper({
      id: 'p1',
      title: 'Sparse Attention for Long Documents',
      authors: ['Nguyễn, Văn An', 'Doe, Jane'],
      year: 2021,
      venue: 'ACL',
      topics: ['NLP', 'Long Context'],
      tags: ['attention', 'to-read', 'benchmark'],
      readStatus: 'unread',
      abstract: 'Efficient linear-time sparse attention over 16k tokens.',
    });
    lib.registerPaper({
      id: 'p2',
      title: 'Layout-Aware PDF OCR Consensus',
      authors: ['Müller, Hans', 'Nguyễn, Văn An'],
      year: 2023,
      venue: 'ICDAR',
      topics: ['Document AI', 'OCR'],
      tags: ['ocr', 'layout', 'benchmark'],
      readStatus: 'reading',
      abstract: 'Multi-engine consensus voting for noisy scanned PDFs.',
    });
    lib.registerPaper({
      id: 'p3',
      title: 'Neural Machine Translation with Glossaries',
      authors: ['Tran, Duc Thang'],
      year: 2024,
      venue: 'EMNLP',
      topics: ['NLP', 'Translation'],
      tags: ['glossary', 'translation'],
      readStatus: 'read',
      abstract: 'Terminology-constrained decoding for domain translation.',
    });
    return lib;
  }

  it('filters dynamically by topic, author, year range, venue, tagsAll/tagsAny, readStatus, and full-text', () => {
    const lib = seedLibrary();

    expect(lib.query({ topic: 'nlp' }).map(p => p.id)).toEqual(['p1', 'p3']);
    expect(lib.query({ author: 'Nguyen, Van An' }).map(p => p.id)).toEqual(['p1', 'p2']);
    expect(lib.query({ yearMin: 2022, yearMax: 2024 }).map(p => p.id)).toEqual(['p2', 'p3']);
    expect(lib.query({ venue: 'icdar' }).map(p => p.id)).toEqual(['p2']);
    expect(lib.query({ tagsAll: ['benchmark', 'ocr'] }).map(p => p.id)).toEqual(['p2']);
    expect(lib.query({ tagsAny: ['glossary', 'attention'] }).map(p => p.id)).toEqual(['p1', 'p3']);
    expect(lib.query({ readStatus: ['unread', 'reading'] }).map(p => p.id)).toEqual(['p1', 'p2']);
    expect(lib.query({ readStatus: [] })).toEqual([]);
    expect(lib.query({ text: 'consensus pdf' }).map(p => p.id)).toEqual(['p2']);
    expect(
      lib.query({ topic: 'NLP', yearMin: 2022, readStatus: 'read', text: 'terminology' }).map(p => p.id),
    ).toEqual(['p3']);
  });

  it('auto-updates saved collection views and notifies watchers on registration, metadata updates, and tag changes', () => {
    const lib = seedLibrary();
    lib.createCollection({
      id: 'nlp-queue',
      name: 'Unread NLP Papers',
      query: { topic: 'NLP', tagsAny: ['to-read', 'priority'], readStatus: 'unread' },
    });

    const snapshots: SmartCollectionSnapshot[] = [];
    const view = lib.watchCollection('nlp-queue', snapshot => snapshots.push(snapshot));

    expect(view.snapshot().papers.map(p => p.id)).toEqual(['p1']);

    // Unrelated paper does not trigger spurious notifications
    lib.registerPaper({
      id: 'p4',
      title: 'Vision Transformers',
      topics: ['Vision'],
      tags: ['to-read'],
      readStatus: 'unread',
    });
    expect(snapshots).toHaveLength(0);

    // Matching paper enters collection and fires view update
    lib.registerPaper({
      id: 'p5',
      title: 'Bilingual Retrieval Reranking',
      topics: ['NLP'],
      tags: ['priority'],
      readStatus: 'unread',
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.papers.map(p => p.id)).toEqual(['p1', 'p5']);
    expect(view.snapshot().total).toBe(2);

    // Updating readStatus removes p1 from the unread view automatically
    lib.updatePaper('p1', { readStatus: 'read' });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.papers.map(p => p.id)).toEqual(['p5']);

    // Bulk tag removal updates membership
    lib.bulkRemoveTags(['p5'], ['priority']);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[2]?.papers).toEqual([]);

    view.unsubscribe();
    lib.bulkAddTags(['p5'], ['priority']);
    expect(snapshots).toHaveLength(3);
  });
});

describe('Bulk tag management', () => {
  it('supports atomic bulk add, remove, and rename with case-insensitive deduplication', () => {
    const lib = new ResearchLibrary({ now: tickingClock() });
    lib.registerPaper({ id: 'p1', title: 'Paper One', tags: ['ML', 'survey'] });
    lib.registerPaper({ id: 'p2', title: 'Paper Two', tags: ['vision'] });
    lib.registerPaper({ id: 'p3', title: 'Paper Three', tags: ['ml', 'machine-learning'] });

    const added = lib.bulkAddTags(['p1', 'p2'], ['To-Read', 'ml']);
    expect(added.updatedPaperIds).toEqual(['p1', 'p2']);
    expect(lib.getPaper('p1')?.tags).toEqual(['ML', 'survey', 'To-Read']);
    expect(lib.getPaper('p2')?.tags).toEqual(['vision', 'To-Read', 'ml']);

    // Atomic validation refuses unknown id before modifying any paper
    expectError(() => lib.bulkAddTags(['p1', 'missing-id'], ['urgent']), 'unknown-id');
    expect(lib.getPaper('p1')?.tags).not.toContain('urgent');

    const removed = lib.bulkRemoveTags(['p1', 'p2'], ['to-read']);
    expect(removed.updatedPaperIds).toEqual(['p1', 'p2']);
    expect(lib.getPaper('p1')?.tags).toEqual(['ML', 'survey']);

    // Renaming ml -> machine-learning deduplicates on p3 which already had machine-learning
    const renamed = lib.renameTag('ML', 'machine-learning');
    expect(renamed.updatedPaperIds).toEqual(['p1', 'p2', 'p3']);
    expect(renamed.deduplicatedPaperIds).toEqual(['p3']);
    expect(lib.getPaper('p1')?.tags).toEqual(['machine-learning', 'survey']);
    expect(lib.getPaper('p3')?.tags).toEqual(['machine-learning']);
  });
});

describe('Duplicate candidate detection and confirmed merge', () => {
  it('detects duplicates by exact DOI, exact arXiv ID, and normalized title + first author', () => {
    const lib = new ResearchLibrary({ now: tickingClock() });

    // Exact DOI pair
    lib.registerPaper({ id: 'd1', title: 'Paper Alpha', doi: '10.1145/3366423.3380001', authors: ['Alice Smith'] });
    lib.registerPaper({
      id: 'd2',
      title: 'Paper Alpha (Publisher Version)',
      doi: 'https://doi.org/10.1145/3366423.3380001',
      authors: ['Alice Smith'],
    });

    // Exact arXiv pair (with version & URL differences)
    lib.registerPaper({ id: 'a1', title: 'Preprint Beta', arxivId: 'arXiv:2401.12345v1', authors: ['Bob Lee'] });
    lib.registerPaper({
      id: 'a2',
      title: 'Preprint Beta Revised',
      arxivId: 'https://arxiv.org/abs/2401.12345v3',
      authors: ['Bob Lee'],
    });

    // Normalized title + first author pair (no DOI/arXiv)
    lib.registerPaper({
      id: 't1',
      title: 'Deep Learning for Document Layout!',
      authors: ['Nguyễn, Văn An', 'Jane Doe'],
      year: 2024,
    });
    lib.registerPaper({
      id: 't2',
      title: '  Deep   Learning for Document Layout  ',
      authors: ['Van An Nguyen'],
      year: 2024,
    });

    // Different first author on same generic title must NOT match
    lib.registerPaper({
      id: 't3',
      title: 'Deep Learning for Document Layout',
      authors: ['Carlos Ruiz'],
      year: 2024,
    });

    // Different non-arXiv DOIs on same title + author must NOT match
    lib.registerPaper({
      id: 'x1',
      title: 'Erratum Study',
      authors: ['Jane Doe'],
      doi: '10.1000/study-v1',
    });
    lib.registerPaper({
      id: 'x2',
      title: 'Erratum Study',
      authors: ['Jane Doe'],
      doi: '10.1000/study-v2',
    });

    const candidates = lib.findDuplicateCandidates();
    expect(candidates).toHaveLength(3);

    const byPair = new Map(candidates.map(c => [`${[c.survivorId, c.duplicateId].sort().join('+')}`, c]));
    expect(byPair.get('d1+d2')?.primaryReason).toBe('doi');
    expect(byPair.get('a1+a2')?.primaryReason).toBe('arxiv');
    expect(byPair.get('t1+t2')?.primaryReason).toBe('title-author');
    expect(byPair.has('t1+t3')).toBe(false);
    expect(byPair.has('x1+x2')).toBe(false);
  });

  it('requires explicit confirmed: true in two-step merge, preserves all data without loss, and persists via JSON', () => {
    const lib = new ResearchLibrary({ now: tickingClock() });

    lib.registerPaper({
      id: 'surv',
      title: 'Document Understanding Survey',
      authors: ['Nguyễn, Văn An'],
      doi: '10.1000/doc.survey',
      year: 2024,
      topics: ['Document AI'],
      tags: ['survey', 'core'],
      readStatus: 'unread',
      noteIds: ['note-1'],
      annotationIds: ['ann-1'],
      citationKeys: ['nguyen2024document'],
      references: ['ref-a'],
    });
    lib.registerPaper({
      id: 'dup',
      title: 'Document Understanding Survey (Preprint)',
      authors: ['Van An Nguyen'],
      doi: 'https://doi.org/10.1000/doc.survey',
      arxivId: '2402.00123v2',
      venue: 'IEEE TPAMI',
      abstract: 'Comprehensive overview of PDF parsing and OCR.',
      topics: ['OCR', 'Document AI'],
      tags: ['CORE', 'benchmark'],
      readStatus: 'read',
      noteIds: ['note-2', 'note-1'],
      annotationIds: ['ann-2'],
      citationKeys: ['nguyen2024preprint'],
      references: ['ref-b', 'ref-a'],
      citationCount: 42,
    });

    lib.createCollection({
      id: 'survey-col',
      name: 'Surveys',
      query: { tagsAny: ['survey'] },
    });

    const plan = lib.planDuplicateMerge('surv', ['dup']);
    expect(plan.survivorId).toBe('surv');
    expect(plan.duplicateIds).toEqual(['dup']);
    expect(plan.matchReasons).toContain('doi');
    expect(plan.addedTags).toEqual(['benchmark']);
    expect(plan.addedTopics).toEqual(['OCR']);
    expect(plan.addedNoteIds).toEqual(['note-2']);
    expect(plan.addedAnnotationIds).toEqual(['ann-2']);
    expect(plan.addedCitationKeys).toEqual(['nguyen2024preprint']);
    expect(plan.addedReferences).toEqual(['ref-b']);
    expect(plan.filledFields).toEqual(['arxivId', 'venue', 'abstract', 'citationCount']);

    // Unconfirmed merges must be rejected without mutating the library
    expectError(() => lib.applyDuplicateMerge(plan, { confirmed: false }), 'merge-not-confirmed');
    expectError(() => lib.applyDuplicateMerge(plan, {} as ApplyMergeOptions), 'merge-not-confirmed');
    expect(lib.getPaper('dup')).toBeDefined();
    expect(lib.getMergeHistory()).toEqual([]);

    // Confirmed merge succeeds and fuses all metadata without data loss
    const applied = lib.applyDuplicateMerge(plan, {
      confirmed: true,
      actor: 'reviewer',
      reason: 'Same DOI',
    });

    expect(applied.removedIds).toEqual(['dup']);
    expect(lib.getPaper('dup')).toBeUndefined();

    const merged = lib.getPaper('surv');
    expect(merged).toBeDefined();
    expect(merged?.arxivId).toBe('2402.00123');
    expect(merged?.venue).toBe('IEEE TPAMI');
    expect(merged?.abstract).toBe('Comprehensive overview of PDF parsing and OCR.');
    expect(merged?.citationCount).toBe(42);
    expect(merged?.readStatus).toBe('read');
    expect(merged?.topics).toEqual(['Document AI', 'OCR']);
    expect(merged?.tags).toEqual(['survey', 'core', 'benchmark']);
    expect(merged?.noteIds).toEqual(['note-1', 'note-2']);
    expect(merged?.annotationIds).toEqual(['ann-1', 'ann-2']);
    expect(merged?.citationKeys).toEqual(['nguyen2024document', 'nguyen2024preprint']);
    expect(merged?.references).toEqual(['ref-a', 'ref-b']);

    // Smart collection automatically reflects the merged survivor
    const collection = lib.evaluateCollection('survey-col');
    expect(collection.papers.map(p => p.id)).toEqual(['surv']);

    // Re-applying the same plan fails
    expectError(() => lib.applyDuplicateMerge(plan, { confirmed: true }), 'merge-already-applied');

    // Audit & merge history preserved
    const history = lib.getMergeHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.mergeId).toBe(applied.mergeId);
    expect(history[0]?.survivorBefore.readStatus).toBe('unread');
    expect(history[0]?.duplicatesBefore[0]?.id).toBe('dup');

    // JSON persistence round-trips papers, collections, merge history, and audit log identically
    const exported = lib.exportJson();
    const parsedExport = JSON.parse(exported) as { schemaVersion: number; kind: string };
    expect(parsedExport.schemaVersion).toBe(SMART_COLLECTIONS_SCHEMA_VERSION);
    expect(parsedExport.kind).toBe(SMART_COLLECTIONS_EXPORT_KIND);

    const restored = ResearchLibrary.fromJson(exported, { now: tickingClock() });
    expect(restored.exportJson()).toBe(exported);
    expect(restored.evaluateCollection('survey-col').papers.map(p => p.id)).toEqual(['surv']);
    expect(restored.getMergeHistory()).toHaveLength(1);
    expect(restored.getAuditLog().length).toBe(lib.getAuditLog().length);
  });
});

describe('Year range edge cases', () => {
  it('enforces inclusive min/max bounds, single-year slices, missing-year exclusion, and sort order', () => {
    const lib = new ResearchLibrary({ now: tickingClock() });
    lib.registerPaper({ id: 'y2019', title: 'Early Work', year: 2019 });
    lib.registerPaper({ id: 'y2020', title: 'Boundary Start', year: 2020 });
    lib.registerPaper({ id: 'y2022', title: 'Middle Paper', year: 2022 });
    lib.registerPaper({ id: 'y2024', title: 'Boundary End', year: 2024 });
    lib.registerPaper({ id: 'undated', title: 'Undated Draft' });
    lib.registerPaper({ id: 'undated-b', title: 'Another Draft' });

    expect(lib.query({ yearMin: 2020 }).map(p => p.id)).toEqual(['y2020', 'y2022', 'y2024']);
    expect(lib.query({ yearMax: 2022 }).map(p => p.id)).toEqual(['y2019', 'y2020', 'y2022']);
    expect(lib.query({ yearMin: 2020, yearMax: 2024 }).map(p => p.id)).toEqual(['y2020', 'y2022', 'y2024']);
    expect(lib.query({ yearMin: 2022, yearMax: 2022 }).map(p => p.id)).toEqual(['y2022']);

    // Papers missing year appear when no year range constraint is active and sort last in year sorts
    expect(lib.query({ sortBy: 'year-desc' }).map(p => p.id)).toEqual([
      'y2024',
      'y2022',
      'y2020',
      'y2019',
      'undated-b',
      'undated',
    ]);
    expect(lib.query({ sortBy: 'year-asc' }).map(p => p.id)).toEqual([
      'y2019',
      'y2020',
      'y2022',
      'y2024',
      'undated-b',
      'undated',
    ]);

    // Clearing a paper's year removes it from a year-bounded collection automatically
    lib.createCollection({ id: 'recent', name: '2020+', query: { yearMin: 2020 } });
    expect(lib.evaluateCollection('recent').papers.map(p => p.id)).toEqual(['y2020', 'y2022', 'y2024']);
    lib.updatePaper('y2022', { year: undefined });
    expect(lib.evaluateCollection('recent').papers.map(p => p.id)).toEqual(['y2020', 'y2024']);

    // Inverted or malformed year ranges fail with typed errors
    expectError(() => lib.query({ yearMin: 2025, yearMax: 2020 }), 'invalid-query');
    expectError(() => lib.query({ yearMin: 2022.5 }), 'invalid-query');
    expectError(() => lib.createCollection({ name: 'Bad', query: { yearMin: 2026, yearMax: 2021 } }), 'invalid-query');
    expectError(() => lib.registerPaper({ title: 'Bad Year', year: 0 }), 'invalid-field');
  });
});

describe('Diacritic and cross-format author matching', () => {
  it('matches Vietnamese Đ/đ, German ü/ß, Polish ł, Scandinavian ø, Spanish accents, and initials', () => {
    const viet = normalizeAuthor('{Nguyễn}, {Văn An}');
    expect(viet.raw).toBe('Nguyễn, Văn An');
    expect(viet.display).toBe('Văn An Nguyễn');
    expect(viet.normalized).toBe('van an nguyen');
    expect(viet.familyKey).toBe('nguyen');

    const pairs: ReadonlyArray<readonly [string, string, boolean]> = [
      ['Nguyễn, Văn An', 'Van An Nguyen', true],
      ['Nguyễn, Văn An', 'Nguyễn Văn An', true],
      ['Đỗ, Minh Tuấn', 'Minh Tuan Do', true],
      ['Trần, Đức Thắng', 'Duc Thang Tran', true],
      ['Müller, Hans-Peter', 'Hans-Peter Muller', true],
      ['Weiß, Stefan', 'Stefan Weiss', true],
      ['Kowalski, Łukasz', 'Lukasz Kowalski', true],
      ['Sørensen, Mikkel', 'Mikkel Sorensen', true],
      ['García-López, María', 'Maria Garcia Lopez', true],
      ['François, Jean-Luc', 'Jean-Luc Francois', true],
      ['Ærø, Bjørn', 'Bjorn Aero', true],
      ['A. Vaswani', 'Vaswani, Ashish', true],
      ['J. A. Smith', 'Jane Alice Smith', true],
      ['Alice Smith', 'Bob Smith', false],
      ['J. Smith', 'K. Smith', false],
      ['J. A. Smith', 'J. B. Smith', false],
      ['Đỗ', 'Jane Doe', false],
    ];

    for (const [left, right, want] of pairs) {
      expect(authorsMatch(left, right), `${left} <> ${right}`).toBe(want);
    }

    const lib = new ResearchLibrary({ now: tickingClock() });
    lib.registerPaper({
      id: 'vn1',
      title: 'Vietnamese Document OCR',
      authors: ['Đỗ, Minh Tuấn', 'Trần, Đức Thắng'],
    });
    lib.registerPaper({
      id: 'eu1',
      title: 'Typographic Normalization',
      authors: ['Müller, Hans', 'Kowalski, Łukasz', 'Sørensen, Mikkel', 'Weiß, Stefan'],
    });
    lib.registerPaper({
      id: 'en1',
      title: 'English Baseline',
      authors: ['Jane Doe'],
    });

    // Searching by folded `Do` finds `Đỗ, Minh Tuấn` without false-matching `Jane Doe`
    expect(lib.query({ author: 'Do' }).map(p => p.id)).toEqual(['vn1']);
    expect(lib.query({ author: 'Đỗ Minh Tuấn' }).map(p => p.id)).toEqual(['vn1']);
    expect(lib.query({ author: 'Tran' }).map(p => p.id)).toEqual(['vn1']);
    expect(lib.query({ author: 'Hans Muller' }).map(p => p.id)).toEqual(['eu1']);
    expect(lib.query({ author: 'Lukasz Kowalski' }).map(p => p.id)).toEqual(['eu1']);
    expect(lib.query({ author: 'Sorensen' }).map(p => p.id)).toEqual(['eu1']);
    expect(lib.query({ author: 'Weiss' }).map(p => p.id)).toEqual(['eu1']);
    expect(lib.query({ authorsAll: ['Minh Tuan Do', 'Duc Thang Tran'] }).map(p => p.id)).toEqual(['vn1']);

    // Duplicate detection recognizes title + diacritic-variant first author AND arXiv DataCite DOI + publisher DOI
    lib.registerPaper({
      id: 'eu1-dup',
      title: 'Typographic Normalization!',
      authors: ['Hans Muller'],
      doi: '10.48550/arXiv.2403.01234',
    });
    lib.updatePaper('eu1', { doi: '10.1145/999999.111111' });
    const dups = lib.findDuplicatesFor('eu1');
    expect(dups).toHaveLength(1);
    expect(dups[0]?.reasons).toContain('title-author');
  });
});

describe('Merge rollback, stale plan protection, and conflict reporting', () => {
  it('rolls back multi-paper merges cleanly, restores auto-updating views, and works across JSON persistence', () => {
    const lib = new ResearchLibrary({ now: tickingClock() });
    lib.registerPaper({
      id: 'p1',
      title: 'Multilingual OCR',
      authors: ['Nguyễn, Văn An'],
      doi: '10.1000/multi.ocr',
      year: 2022,
      topics: ['OCR'],
      tags: ['ocr'],
      readStatus: 'unread',
      noteIds: ['n1'],
      annotationIds: ['a1'],
      citationKeys: ['nguyen2022ocr'],
      references: ['r1'],
    });
    lib.registerPaper({
      id: 'p2',
      title: 'Multilingual OCR (arXiv)',
      authors: ['Van An Nguyen'],
      arxivId: '2205.00001v2',
      year: 2021,
      venue: 'arXiv',
      topics: ['Document AI'],
      tags: ['preprint'],
      readStatus: 'reading',
      noteIds: ['n2'],
      annotationIds: ['a2'],
      citationKeys: ['nguyen2021arxiv'],
      references: ['r2'],
    });
    lib.registerPaper({
      id: 'p3',
      title: 'Multilingual OCR (Camera Ready)',
      authors: ['Nguyễn, Văn An'],
      doi: '10.1000/multi.ocr',
      venue: 'ICDAR',
      tags: ['published'],
      readStatus: 'read',
      noteIds: ['n3'],
      annotationIds: ['a3'],
      citationKeys: ['nguyen2022icdar'],
    });

    lib.createCollection({ id: 'all-ocr', name: 'OCR Library', query: { text: 'Multilingual OCR' } });
    const watcherEvents: SmartCollectionSnapshot[] = [];
    const view = lib.watchCollection('all-ocr', s => watcherEvents.push(s));
    expect(view.snapshot().total).toBe(3);

    const plan = lib.planDuplicateMerge('p1', ['p2', 'p3']);
    expect(plan.conflicts.map(c => `${c.field}:${c.duplicateId}`)).toContain('year:p2');
    expect(plan.conflicts.map(c => `${c.field}:${c.duplicateId}`)).toContain('venue:p3');
    expect(plan.conflicts.map(c => `${c.field}:${c.duplicateId}`)).toContain('title:p2');

    // Plan detects staleness if a participating paper changes before confirmation
    lib.updatePaper('p2', { venue: 'arXiv cs.CV' });
    expectError(() => lib.applyDuplicateMerge(plan, { confirmed: true }), 'stale-merge-plan');

    // Fresh plan succeeds cleanly
    const freshPlan = lib.planDuplicateMerge('p1', ['p2', 'p3']);
    const merged = lib.applyDuplicateMerge(freshPlan, {
      confirmed: true,
      actor: 'curator',
      reason: 'Consolidate preprint and proceedings versions',
    });

    expect(view.snapshot().papers.map(p => p.id)).toEqual(['p1']);
    expect(lib.getPaper('p1')?.tags).toEqual(['ocr', 'preprint', 'published']);
    expect(lib.getPaper('p1')?.noteIds).toEqual(['n1', 'n2', 'n3']);
    expect(lib.getPaper('p1')?.annotationIds).toEqual(['a1', 'a2', 'a3']);
    expect(lib.getPaper('p1')?.citationKeys).toEqual(['nguyen2022ocr', 'nguyen2021arxiv', 'nguyen2022icdar']);
    expect(lib.getPaper('p1')?.readStatus).toBe('read');
    expect(lib.findDuplicateCandidates()).toEqual([]);

    // Round-trip through JSON after merge and execute rollback on the restored library
    const postMergeJson = lib.exportJson();
    const restoredLib = ResearchLibrary.fromJson(postMergeJson, { now: tickingClock() });
    const restoredView = restoredLib.watchCollection('all-ocr');

    const rollback = restoredLib.rollbackMerge(merged.mergeId, {
      actor: 'curator',
      reason: 'Separate proceedings vs preprint notes',
    });

    expect(rollback.restoredSurvivor.id).toBe('p1');
    expect(rollback.restoredSurvivor.tags).toEqual(['ocr']);
    expect(rollback.restoredSurvivor.readStatus).toBe('unread');
    expect(rollback.restoredSurvivor.noteIds).toEqual(['n1']);
    expect(rollback.restoredDuplicates.map(p => p.id)).toEqual(['p2', 'p3']);
    expect(restoredLib.getPaper('p2')?.venue).toBe('arXiv cs.CV');
    expect(restoredLib.getPaper('p3')?.venue).toBe('ICDAR');
    expect(restoredView.snapshot().papers.map(p => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(restoredLib.findDuplicateCandidates().length).toBeGreaterThan(0);

    // Audit history retains both the merge record (marked rolled back) and the rollback audit event
    const history = restoredLib.getMergeHistory();
    expect(history).toHaveLength(1);
    expect(history[0]?.rolledBackAt).toBe(rollback.rolledBackAt);
    expect(history[0]?.rolledBackBy).toBe('curator');
    expect(history[0]?.rollbackReason).toBe('Separate proceedings vs preprint notes');
    expect(restoredLib.getAuditLog().map(e => e.action).slice(-2)).toEqual(['merge-applied', 'merge-rolled-back']);

    // Double rollback or unknown merge ID fails
    expectError(() => restoredLib.rollbackMerge(merged.mergeId), 'merge-already-rolled-back');
    expectError(() => restoredLib.rollbackMerge('merge-999'), 'unknown-merge');

    view.unsubscribe();
  });

  it('prevents out-of-order rollback conflicts and rejects malformed JSON imports atomically', () => {
    const lib = new ResearchLibrary({ now: tickingClock() });
    lib.registerPaper({ id: 'p1', title: 'Base Paper', doi: '10.1000/chain' });
    lib.registerPaper({ id: 'p2', title: 'Copy One', doi: '10.1000/chain', tags: ['from-p2'] });
    lib.registerPaper({ id: 'p3', title: 'Copy Two', doi: '10.1000/chain', tags: ['from-p3'] });

    const m1 = lib.applyDuplicateMerge(lib.planDuplicateMerge('p1', ['p2']), { confirmed: true });
    const m2 = lib.applyDuplicateMerge(lib.planDuplicateMerge('p1', ['p3']), { confirmed: true });

    // Rolling back m1 before m2 is refused because m2 depends on p1's post-m1 state
    expectError(() => lib.rollbackMerge(m1.mergeId), 'rollback-conflict');

    // Rolling back newest-first succeeds cleanly
    lib.rollbackMerge(m2.mergeId);
    expect(lib.getPaper('p1')?.tags).toEqual(['from-p2']);
    expect(lib.getPaper('p3')?.tags).toEqual(['from-p3']);

    // If p2's id is reused before m1 rollback, rollback refuses rather than overwriting the new paper
    lib.registerPaper({ id: 'p2', title: 'Unrelated New Paper' });
    expectError(() => lib.rollbackMerge(m1.mergeId), 'rollback-conflict');
    lib.removePaper('p2');

    lib.rollbackMerge(m1.mergeId);
    expect(lib.getPaper('p1')?.tags).toEqual([]);
    expect(lib.getPaper('p2')?.tags).toEqual(['from-p2']);

    // Malformed / unsupported JSON exports never corrupt existing library state
    expectError(() => lib.importJson('{not-json'), 'malformed-json');
    expectError(
      () =>
        lib.importJson(
          JSON.stringify({
            schemaVersion: 99,
            kind: SMART_COLLECTIONS_EXPORT_KIND,
            papers: [],
            collections: [],
            mergeHistory: [],
            auditLog: [],
          }),
        ),
      'unsupported-schema-version',
    );
    expectError(
      () =>
        lib.importJson(
          JSON.stringify({
            schemaVersion: SMART_COLLECTIONS_SCHEMA_VERSION,
            kind: 'wrong.kind',
            papers: [],
            collections: [],
            mergeHistory: [],
            auditLog: [],
          }),
        ),
      'malformed-export',
    );
    expect(lib.listPapers().map(p => p.id)).toEqual(['p1', 'p3', 'p2']);
  });
});
