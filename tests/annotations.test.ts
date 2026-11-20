import { describe, expect, it } from 'vitest';
import {
  ANNOTATIONS_SCHEMA_VERSION,
  AnnotationError,
  AnnotationStore,
  reanchor,
  toMarkdown,
  type Annotation,
  type AnnotationPatch,
} from '../src/core/annotations';
import { buildDocument, type DocumentIR } from '../src/core/ir';

const SHA = 'a'.repeat(64);

const HEADING = 'Chapter one introduces the lighthouse keeper and the harbour.';
const BODY = 'The keeper checks the lamp every evening before the fog rolls in over the water.';
const ANNEX = 'Appendix A lists every command the reader accepts in the terminal.';

interface BlockSpec {
  page: number;
  text: string;
  y: number;
}

/** Builds a real IR through `buildDocument`, so ids, pages and polygons are genuine. */
function documentWith(specs: readonly BlockSpec[], pages?: readonly number[]): DocumentIR {
  const indices = pages ?? [...new Set(specs.map(spec => spec.page))].sort((left, right) => left - right);
  return buildDocument({
    sourceSha256: SHA,
    documentId: 'doc-1',
    pages: indices.map(index => ({ index, width: 612, height: 792 })),
    blocks: specs.map(spec => ({
      page: spec.page,
      text: spec.text,
      rect: { x: 72, y: spec.y, width: 468, height: 18 },
    })),
  });
}

/** A clock that moves one second per read, so timestamps are valid ISO and distinct. */
function tickingClock(start = Date.UTC(2026, 10, 20, 0, 0, 0)): () => string {
  let tick = 0;
  return () => {
    const stamp = new Date(start + tick * 1000).toISOString();
    tick += 1;
    return stamp;
  };
}

const THREE_PAGES = documentWith([
  { page: 1, text: HEADING, y: 100 },
  { page: 1, text: BODY, y: 140 },
  { page: 2, text: ANNEX, y: 100 },
]);

/** Asserts that `action` throws an `AnnotationError` and returns it. */
function expectError(action: () => unknown, code: string): AnnotationError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) throw new Error(`expected an AnnotationError with code ${code}, but nothing was thrown`);
  expect(caught).toBeInstanceOf(AnnotationError);
  expect((caught as AnnotationError).code).toBe(code);
  return caught as AnnotationError;
}

describe('AnnotationStore', () => {
  it('adds, lists, updates and removes annotations', () => {
    const store = new AnnotationStore({ documents: [THREE_PAGES], now: tickingClock() });

    const note = store.add({
      documentId: 'doc-1',
      page: 1,
      blockId: 'p1-r0',
      kind: 'note',
      text: '  Check the heading  ',
      color: '#ffcc00',
    });
    const bookmark = store.add({ documentId: 'doc-1', page: 2, kind: 'bookmark', text: 'Come back here' });

    expect(note.id).toBe('a1');
    expect(note.kind).toBe('note');
    expect(note.text).toBe('Check the heading');
    expect(note.quote).toBe(HEADING);
    expect(note.color).toBe('#ffcc00');
    expect(note.orphaned).toBe(false);
    expect(note.createdAt).toBe('2026-11-20T00:00:00.000Z');
    expect(note.updatedAt).toBe(note.createdAt);

    expect(bookmark.id).toBe('a2');
    expect(bookmark.page).toBe(2);
    expect(bookmark.quote).toBeUndefined();
    expect(bookmark.orphaned).toBe(false);

    expect(store.list('doc-1').map(entry => entry.id)).toEqual(['a1', 'a2']);
    expect(store.list('doc-1', { kind: 'bookmark' }).map(entry => entry.id)).toEqual(['a2']);
    expect(store.list('doc-1', { kind: ['note', 'highlight'] }).map(entry => entry.id)).toEqual(['a1']);
    expect(store.list('doc-1', { kind: [] })).toEqual([]);
    expect(store.list('another-document')).toEqual([]);
    expect(store.get('a1')).toEqual(note);
    expect(store.get('nope')).toBeUndefined();

    const updated = store.update('a1', { text: 'Reworded note', color: undefined });
    expect(updated.text).toBe('Reworded note');
    expect(updated.color).toBeUndefined();
    expect(updated.createdAt).toBe(note.createdAt);
    expect(updated.updatedAt > note.updatedAt).toBe(true);
    expect(store.get('a1')?.text).toBe('Reworded note');

    expectError(() => store.update('a1', { text: '   ' }), 'invalid-field');
    expectError(() => store.update('missing', { text: 'Hello' }), 'unknown-id');
    expectError(
      () => store.update('a1', { createdAt: '2020-01-01T00:00:00.000Z' } as unknown as AnnotationPatch),
      'immutable-field',
    );
    expectError(() => store.update('a1', { documentId: 'doc-2' } as unknown as AnnotationPatch), 'immutable-field');

    // Returned annotations are copies: a caller cannot edit the store by accident.
    const copy = store.get('a2');
    if (copy) copy.text = 'mutated outside the store';
    expect(store.get('a2')?.text).toBe('Come back here');

    expect(store.remove('a1')).toBe(true);
    expect(store.remove('a1')).toBe(false);
    expect(store.get('a1')).toBeUndefined();
    expect(store.list('doc-1').map(entry => entry.id)).toEqual(['a2']);
  });

  it('refuses an anchor the document does not have unless orphanOk is set', () => {
    const store = new AnnotationStore({ documents: [THREE_PAGES], now: tickingClock() });

    const unknownBlock = expectError(
      () => store.add({ documentId: 'doc-1', page: 1, blockId: 'p1-r9', kind: 'note', text: 'Lost' }),
      'unknown-block',
    );
    expect(unknownBlock.path).toBe('blockId');
    expect(store.list('doc-1')).toEqual([]);

    const orphan = store.add(
      { documentId: 'doc-1', page: 1, blockId: 'p1-r9', kind: 'note', text: 'Lost' },
      { orphanOk: true },
    );
    expect(orphan.orphaned).toBe(true);
    expect(orphan.blockId).toBe('p1-r9');
    expect(orphan.quote).toBeUndefined();
    // An orphaned annotation still records what it was attached to, so it is a backlink.
    expect(store.backlinks('p1-r9').map(entry => entry.id)).toEqual([orphan.id]);

    expectError(
      () => store.add({ documentId: 'doc-1', page: 2, blockId: 'p1-r0', kind: 'note', text: 'Wrong page' }),
      'anchor-page-mismatch',
    );
    expectError(
      () => store.add({ documentId: 'doc-1', page: 9, kind: 'bookmark', text: 'No such page' }),
      'unknown-page',
    );
    expectError(
      () =>
        store.add({
          documentId: 'doc-1',
          page: 1,
          kind: 'highlight',
          text: 'Off the page',
          rect: { x: 600, y: 100, width: 100, height: 18 },
        }),
      'rect-out-of-bounds',
    );
    expectError(
      () => store.add({ documentId: 'doc-1', page: 1, kind: 'note', text: 'Bad rect', rect: { x: 1, y: 2, width: -3, height: 4 } }),
      'invalid-rect',
    );

    // A document the store does not hold cannot be checked, so only the shape is read.
    const loose = new AnnotationStore({ now: tickingClock() });
    const accepted = loose.add({ documentId: 'unopened', page: 4, blockId: 'p4-r0', kind: 'note', text: 'Later' });
    expect(accepted.orphaned).toBe(false);
    expect(accepted.quote).toBeUndefined();

    // An update that re-points the anchor is validated exactly like an add.
    expectError(() => store.update(orphan.id, { blockId: 'p1-r9', page: 2 }), 'unknown-block');
    expect(store.update(orphan.id, { blockId: 'p1-r0' }).orphaned).toBe(false);
    expect(store.update(orphan.id, { blockId: 'p1-r9' }, { orphanOk: true }).orphaned).toBe(true);
  });

  it('lists the annotations that name one block as backlinks', () => {
    const store = new AnnotationStore({ documents: [THREE_PAGES], now: tickingClock() });
    const first = store.add({ documentId: 'doc-1', page: 1, blockId: 'p1-r0', kind: 'note', text: 'First note' });
    const second = store.add({ documentId: 'doc-1', page: 1, blockId: 'p1-r0', kind: 'highlight', text: 'Marked' });
    const third = store.add({ documentId: 'doc-1', page: 1, blockId: 'p1-r1', kind: 'note', text: 'Other block' });

    expect(store.backlinks('p1-r0').map(entry => entry.id)).toEqual([first.id, second.id]);
    expect(store.backlinks('p1-r1').map(entry => entry.id)).toEqual([third.id]);
    expect(store.backlinks('p1-r1', { documentId: 'other-document' })).toEqual([]);
    expect(store.backlinks('p9-r0')).toEqual([]);
  });

  it('orders one page by the top edge of each rect', () => {
    const store = new AnnotationStore({ documents: [THREE_PAGES], now: tickingClock() });
    const low = store.add({
      documentId: 'doc-1',
      page: 1,
      kind: 'note',
      text: 'low',
      rect: { x: 72, y: 400, width: 200, height: 16 },
    });
    const high = store.add({
      documentId: 'doc-1',
      page: 1,
      kind: 'note',
      text: 'high',
      rect: { x: 72, y: 200, width: 200, height: 16 },
    });
    const top = store.add({
      documentId: 'doc-1',
      page: 1,
      kind: 'note',
      text: 'top',
      rect: { x: 72, y: 60, width: 200, height: 16 },
    });
    const floating = store.add({ documentId: 'doc-1', page: 1, kind: 'bookmark', text: 'page anchor' });

    expect(store.forPage('doc-1', 1).map(entry => entry.text)).toEqual(['top', 'high', 'low', 'page anchor']);
    expect(store.forPage('doc-1', 2)).toEqual([]);
    expect([low.id, high.id, top.id, floating.id]).toEqual(['a1', 'a2', 'a3', 'a4']);
  });
});

describe('reanchor', () => {
  const ALPHA = 'Alpha section explains the tide tables for the northern harbour.';
  const BETA = 'Beta section describes the lamp oil delivery schedule for winter.';
  const GAMMA = 'Gamma section records the fog signal tests from the last inspection.';
  const DELTA = 'Delta section names the crew who painted the tower in the spring.';
  const INSERTED = 'Inserted paragraph about the new pier that opened last summer.';
  const REPLACED = 'Replacement paragraph about the survey boat and its crew roster.';

  it('keeps a block id, moves by similar text and orphans a vanished note', () => {
    const before = documentWith([
      { page: 1, text: ALPHA, y: 100 },
      { page: 1, text: BETA, y: 140 },
      { page: 2, text: GAMMA, y: 100 },
      { page: 3, text: DELTA, y: 100 },
    ]);
    // A paragraph inserted at the top of page 1 renumbers everything below it.
    const after = documentWith([
      { page: 1, text: INSERTED, y: 60 },
      { page: 1, text: ALPHA, y: 100 },
      { page: 1, text: BETA, y: 140 },
      { page: 2, text: REPLACED, y: 100 },
      { page: 3, text: DELTA, y: 100 },
    ]);

    const store = new AnnotationStore({ documents: [before], now: tickingClock() });
    store.add({ documentId: 'doc-1', page: 1, blockId: 'p1-r0', kind: 'note', text: 'Check the tide table' });
    store.add({ documentId: 'doc-1', page: 1, blockId: 'p1-r1', kind: 'highlight', text: 'Delivery schedule' });
    store.add({ documentId: 'doc-1', page: 2, blockId: 'p2-r0', kind: 'note', text: 'Fog signal test' });
    store.add({ documentId: 'doc-1', page: 3, blockId: 'p3-r0', kind: 'bookmark', text: 'Tower crew' });

    const notes = store.list('doc-1');
    const result = reanchor(notes, before, after);

    expect(result.kept).toEqual(['a4']);
    expect(result.moved).toEqual(['a1', 'a2']);
    expect(result.orphaned).toEqual(['a3']);
    expect(result.annotations.map(entry => entry.id)).toEqual(['a1', 'a2', 'a3', 'a4']);

    const byId = new Map(result.annotations.map(entry => [entry.id, entry]));
    expect(byId.get('a1')?.blockId).toBe('p1-r1');
    expect(byId.get('a1')?.quote).toBe(ALPHA);
    expect(byId.get('a1')?.orphaned).toBe(false);
    expect(byId.get('a2')?.blockId).toBe('p1-r2');
    expect(byId.get('a2')?.quote).toBe(BETA);
    expect(byId.get('a2')?.orphaned).toBe(false);
    expect(byId.get('a3')?.blockId).toBe('p2-r0');
    expect(byId.get('a3')?.quote).toBe(GAMMA);
    expect(byId.get('a3')?.orphaned).toBe(true);
    expect(byId.get('a4')?.blockId).toBe('p3-r0');
    expect(byId.get('a4')?.orphaned).toBe(false);

    // The input is not rewritten; a caller persists the result deliberately.
    expect(notes[0]?.blockId).toBe('p1-r0');
    expect(notes[2]?.orphaned).toBe(false);
  });

  it('follows a block whose text was edited in place', () => {
    const edited = 'The keeper checks the lamp every evening before the fog rolls in across the water.';
    const before = documentWith([
      { page: 1, text: HEADING, y: 100 },
      { page: 1, text: BODY, y: 140 },
    ]);
    const after = documentWith([{ page: 1, text: edited, y: 100 }]);

    const store = new AnnotationStore({ documents: [before], now: tickingClock() });
    const note = store.add({ documentId: 'doc-1', page: 1, blockId: 'p1-r1', kind: 'note', text: 'This sentence' });

    const result = reanchor(store.list('doc-1'), before, after);

    expect(result.kept).toEqual([]);
    expect(result.moved).toEqual([note.id]);
    expect(result.orphaned).toEqual([]);
    const [moved] = result.annotations;
    expect(moved?.blockId).toBe('p1-r0');
    expect(moved?.quote).toBe(edited);
    expect(moved?.orphaned).toBe(false);
  });

  it('rescues an annotation whose page number shifted', () => {
    const before = documentWith([{ page: 1, text: ALPHA, y: 100 }]);
    const after = documentWith([
      { page: 1, text: INSERTED, y: 100 },
      { page: 2, text: ALPHA, y: 100 },
    ]);

    const store = new AnnotationStore({ documents: [before], now: tickingClock() });
    const note = store.add({ documentId: 'doc-1', page: 1, blockId: 'p1-r0', kind: 'note', text: 'Tide tables' });

    const result = reanchor(store.list('doc-1'), before, after);

    expect(result.moved).toEqual([note.id]);
    const [moved] = result.annotations;
    expect(moved?.page).toBe(2);
    expect(moved?.blockId).toBe('p2-r0');
    expect(moved?.quote).toBe(ALPHA);
    expect(moved?.orphaned).toBe(false);
  });

  it('marks a page-only bookmark orphaned when its page is gone', () => {
    const before = documentWith([{ page: 1, text: HEADING, y: 100 }]);
    const after = documentWith([{ page: 1, text: HEADING, y: 100 }]);
    const store = new AnnotationStore({ documents: [before], now: tickingClock() });
    const bookmark = store.add({ documentId: 'doc-1', page: 1, kind: 'bookmark', text: 'Start here' });

    const kept = reanchor(store.list('doc-1'), before, after);
    expect(kept.kept).toEqual([bookmark.id]);
    expect(kept.annotations[0]?.orphaned).toBe(false);
  });
});

describe('toMarkdown', () => {
  it('groups by page and quotes the anchored block', () => {
    const store = new AnnotationStore({ documents: [THREE_PAGES], now: tickingClock() });
    const highlight = store.add({
      documentId: 'doc-1',
      page: 1,
      blockId: 'p1-r1',
      kind: 'highlight',
      text: 'Important passage',
      color: '#ffcc00',
      rect: { x: 72, y: 140, width: 468, height: 18 },
    });
    const note = store.add({
      documentId: 'doc-1',
      page: 1,
      blockId: 'p1-r0',
      kind: 'note',
      text: 'Check  the\nheading',
      rect: { x: 72, y: 100, width: 468, height: 18 },
    });
    store.add({ documentId: 'doc-1', page: 2, kind: 'bookmark', text: 'Come back here' });
    store.update(note.id, { quote: 'Line one\n\nLine three' });

    const expected = [
      '## Page 1',
      '',
      '- **note**: Check the heading',
      '  > Line one',
      '  >',
      '  > Line three',
      '- **highlight** (#ffcc00): Important passage',
      `  > ${BODY}`,
      '',
      '## Page 2',
      '',
      '- **bookmark**: Come back here',
    ].join('\n');

    expect(toMarkdown(store.list('doc-1'))).toBe(`${expected}\n`);
    expect(highlight.quote).toBe(BODY);
    expect(toMarkdown([])).toBe('');
  });

  it('names the document when the list spans more than one', () => {
    const store = new AnnotationStore({ documents: [THREE_PAGES], now: tickingClock() });
    const note = store.add({ documentId: 'doc-1', page: 1, blockId: 'p1-r0', kind: 'note', text: 'Local note' });
    const other: Annotation = { ...note, id: 'other-1', documentId: 'doc-2', text: 'Second document' };

    const markdown = toMarkdown([other, note]);

    expect(markdown).toContain('## doc-1 - Page 1');
    expect(markdown).toContain('## doc-2 - Page 1');
  });
});

describe('annotation export and import', () => {
  function filledStore(): AnnotationStore {
    const store = new AnnotationStore({ documents: [THREE_PAGES], now: tickingClock() });
    store.add({
      documentId: 'doc-1',
      page: 1,
      blockId: 'p1-r0',
      kind: 'note',
      text: 'Check the heading',
      color: '#ffcc00',
      rect: { x: 72, y: 100, width: 468, height: 18 },
    });
    store.add({ documentId: 'doc-1', page: 2, kind: 'bookmark', text: 'Come back here' });
    return store;
  }

  it('round-trips through canonical JSON', () => {
    const store = filledStore();
    const json = store.exportJson();

    expect(store.exportJson()).toBe(json);
    const document = JSON.parse(json) as { schemaVersion: number; kind: string; annotations: unknown[] };
    expect(document.schemaVersion).toBe(ANNOTATIONS_SCHEMA_VERSION);
    expect(document.kind).toBe('annotations');
    expect(document.annotations).toHaveLength(2);

    const restored = new AnnotationStore({ now: tickingClock() });
    expect(restored.importJson(json)).toEqual({ imported: 2, total: 2 });
    expect(restored.list('doc-1')).toEqual(store.list('doc-1'));
    expect(restored.exportJson()).toBe(json);

    // An id assigned after an import does not collide with the ids the import restored.
    const added = restored.add({ documentId: 'doc-1', page: 1, kind: 'note', text: 'Fresh note' });
    expect(added.id).toBe('a3');

    const wrongVersion = JSON.stringify({
      schemaVersion: ANNOTATIONS_SCHEMA_VERSION + 1,
      kind: 'annotations',
      annotations: [],
    });
    expectError(() => restored.importJson(wrongVersion), 'unsupported-schema-version');
  });

  it('refuses an id that is already in the store', () => {
    const store = filledStore();
    const json = store.exportJson();
    const before = store.list('doc-1');

    expectError(() => store.importJson(json), 'duplicate-id');
    expect(store.list('doc-1')).toEqual(before);
  });

  it('refuses duplicate ids inside one import and leaves the store untouched', () => {
    const store = filledStore();
    const document = JSON.parse(store.exportJson()) as { annotations: unknown[] };
    const entry = document.annotations[0];
    const duplicated = JSON.stringify({
      schemaVersion: ANNOTATIONS_SCHEMA_VERSION,
      kind: 'annotations',
      annotations: [entry, entry],
    });

    const target = new AnnotationStore({ now: tickingClock() });
    expectError(() => target.importJson(duplicated), 'duplicate-id');
    expect(target.list('doc-1')).toEqual([]);
  });

  it('refuses malformed and unsupported documents', () => {
    const store = new AnnotationStore({ now: tickingClock() });

    expectError(() => store.importJson('{not json'), 'malformed-json');
    expectError(() => store.importJson('[]'), 'malformed-export');
    expectError(
      () => store.importJson(JSON.stringify({ schemaVersion: ANNOTATIONS_SCHEMA_VERSION, annotations: {} })),
      'malformed-export',
    );
    expectError(
      () =>
        store.importJson(
          JSON.stringify({
            schemaVersion: ANNOTATIONS_SCHEMA_VERSION,
            kind: 'annotations',
            annotations: [
              { id: 'x1', documentId: 'doc-1', page: 1, kind: 'note', text: 'No timestamps', orphaned: false },
            ],
          }),
        ),
      'invalid-field',
    );
  });
});
