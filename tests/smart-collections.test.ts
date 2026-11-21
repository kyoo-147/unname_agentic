import { describe, expect, it } from 'vitest';
import {
  READ_STATUSES,
  ResearchLibrary,
  SMART_COLLECTIONS_EXPORT_KIND,
  SMART_COLLECTIONS_SCHEMA_VERSION,
  SmartCollectionError,
  type ApplyMergeOptions,
  type SmartCollectionSnapshot,
} from '../src/core/smart-collections';

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
