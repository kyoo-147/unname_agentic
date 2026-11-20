import { describe, expect, it } from 'vitest';
import {
  DIFF_CHANGE_MIN_SIMILARITY,
  diffDocuments,
  diffWords,
  type BlockDiff,
  type DocumentDiff,
} from '../src/core/diff';
import { buildDocument, type DocumentIR } from '../src/core/ir';

interface BlockSpec {
  page: number;
  text: string;
  y: number;
}

/** Builds a real IR through `buildDocument`, so ids, order and polygons are genuine. */
function documentWith(specs: readonly BlockSpec[], pages?: readonly number[]): DocumentIR {
  const indices = pages ?? [...new Set(specs.map(spec => spec.page))].sort((left, right) => left - right);
  return buildDocument({
    sourceSha256: 'a'.repeat(64),
    pages: indices.map(index => ({ index, width: 612, height: 792 })),
    blocks: specs.map(spec => ({
      page: spec.page,
      text: spec.text,
      rect: { x: 72, y: spec.y, width: 468, height: 16 },
    })),
  });
}

function allChanges(diff: DocumentDiff): BlockDiff[] {
  return diff.pages.flatMap(page => page.changes);
}

/** Asserts the diff holds exactly one change and returns it, typed. */
function onlyChange(diff: DocumentDiff): BlockDiff {
  const changes = allChanges(diff);
  expect(changes).toHaveLength(1);
  const [change] = changes;
  if (!change) throw new Error('expected exactly one change');
  return change;
}

const INTRO = 'Introduction to the manual for the reader of the scanned report.';
const BODY = 'The reader opens a document and can read every page of the scan.';
const ANNEX = 'Appendix A lists every command the reader accepts in the terminal.';

describe('diffDocuments', () => {
  it('reports no changes for two identical documents', () => {
    const before = documentWith([
      { page: 1, text: INTRO, y: 100 },
      { page: 1, text: BODY, y: 140 },
      { page: 2, text: ANNEX, y: 100 },
    ]);
    const after = documentWith([
      { page: 1, text: INTRO, y: 100 },
      { page: 1, text: BODY, y: 140 },
      { page: 2, text: ANNEX, y: 100 },
    ]);

    const diff = diffDocuments(before, after);

    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 0, moved: 0, unchanged: 3 });
    expect(diff.pages.map(page => page.page)).toEqual([1, 2]);
    expect(allChanges(diff)).toEqual([]);
    expect(diff.pages.map(page => page.unchanged)).toEqual([2, 1]);
  });

  it('reports one added paragraph', () => {
    const before = documentWith([
      { page: 1, text: INTRO, y: 100 },
      { page: 1, text: BODY, y: 140 },
    ]);
    const added = 'A new paragraph the second revision added to the introduction.';
    const after = documentWith([
      { page: 1, text: INTRO, y: 100 },
      { page: 1, text: BODY, y: 140 },
      { page: 1, text: added, y: 180 },
    ]);

    const diff = diffDocuments(before, after);

    expect(diff.summary).toEqual({ added: 1, removed: 0, changed: 0, moved: 0, unchanged: 2 });
    const change = onlyChange(diff);
    expect(change.kind).toBe('added');
    if (change.kind !== 'added') throw new Error('expected an added block');
    expect(change.page).toBe(1);
    expect(change.after).toBe(added);
    expect(diff.pages).toHaveLength(1);
  });

  it('reports one removed paragraph', () => {
    const gone = 'An obsolete paragraph that the second revision deleted from the page.';
    const before = documentWith([
      { page: 1, text: INTRO, y: 100 },
      { page: 1, text: gone, y: 140 },
      { page: 1, text: BODY, y: 180 },
    ]);
    const after = documentWith([
      { page: 1, text: INTRO, y: 100 },
      { page: 1, text: BODY, y: 140 },
    ]);

    const diff = diffDocuments(before, after);

    expect(diff.summary).toEqual({ added: 0, removed: 1, changed: 0, moved: 0, unchanged: 2 });
    const change = onlyChange(diff);
    expect(change.kind).toBe('removed');
    if (change.kind !== 'removed') throw new Error('expected a removed block');
    expect(change.page).toBe(1);
    expect(change.before).toBe(gone);
  });

  it('reports one changed sentence with its insert and delete runs', () => {
    const beforeText = 'The quick brown fox jumps over the lazy dog while the reader watches.';
    const afterText = 'The quick brown fox leaps over the lazy dog while the reader watches.';
    const before = documentWith([
      { page: 1, text: INTRO, y: 100 },
      { page: 1, text: beforeText, y: 140 },
    ]);
    const after = documentWith([
      { page: 1, text: INTRO, y: 100 },
      { page: 1, text: afterText, y: 140 },
    ]);

    const diff = diffDocuments(before, after);

    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 1, moved: 0, unchanged: 1 });
    const change = onlyChange(diff);
    expect(change.kind).toBe('changed');
    if (change.kind !== 'changed') throw new Error('expected a changed block');
    expect(change.before).toBe(beforeText);
    expect(change.after).toBe(afterText);
    expect(change.similarity).toBeGreaterThanOrEqual(DIFF_CHANGE_MIN_SIMILARITY);
    expect(change.words).toEqual([
      { kind: 'equal', text: 'The quick brown fox' },
      { kind: 'delete', text: 'jumps' },
      { kind: 'insert', text: 'leaps' },
      { kind: 'equal', text: 'over the lazy dog while the reader watches.' },
    ]);
  });

  it('reports a paragraph moved to another page as moved', () => {
    const note = 'A note that is quoted verbatim in the appendix section of the manual.';
    const before = documentWith([
      { page: 1, text: INTRO, y: 100 },
      { page: 1, text: note, y: 140 },
      { page: 2, text: ANNEX, y: 100 },
    ]);
    const after = documentWith([
      { page: 1, text: INTRO, y: 100 },
      { page: 2, text: ANNEX, y: 100 },
      { page: 2, text: note, y: 140 },
    ]);

    const diff = diffDocuments(before, after);

    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 0, moved: 1, unchanged: 2 });
    const change = onlyChange(diff);
    expect(change.kind).toBe('moved');
    if (change.kind !== 'moved') throw new Error('expected a moved block');
    // A move belongs to the page the block arrived on, and names the page it left.
    expect(change.page).toBe(2);
    expect(change.fromPage).toBe(1);
    expect(change.text).toBe(note);
    expect(diff.pages.map(page => page.page)).toEqual([1, 2]);
    expect(diff.pages[1]?.changes).toEqual([change]);
  });

  it('ignores a whitespace-only difference', () => {
    const spaced = 'The  report\nis  ready for the reader.';
    const smooth = 'The report is ready for the reader.';
    const before = documentWith([{ page: 1, text: spaced, y: 100 }]);
    const after = documentWith([{ page: 1, text: smooth, y: 100 }]);

    const diff = diffDocuments(before, after);

    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 0, moved: 0, unchanged: 1 });
    expect(allChanges(diff)).toEqual([]);
    expect(diffWords(spaced, smooth)).toEqual([{ kind: 'equal', text: smooth }]);
  });

  it('collapses a one-character OCR jitter instead of reporting an edit', () => {
    const beforeText = 'Chapter 5 explains the method in detail for every reader of this manual';
    const afterText = 'Chapter 6 explains the method in detail for every reader of this manual';

    // The one-character insert folds into the equal runs: nothing to show inline.
    expect(diffWords(beforeText, afterText)).toEqual([{ kind: 'equal', text: afterText }]);

    const diff = diffDocuments(
      documentWith([{ page: 1, text: beforeText, y: 100 }]),
      documentWith([{ page: 1, text: afterText, y: 100 }]),
    );

    // The block is still the same block — neither removed nor re-added.
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 1, moved: 0, unchanged: 0 });
    const change = onlyChange(diff);
    if (change.kind !== 'changed') throw new Error('expected a changed block');
    expect(change.words).toEqual([{ kind: 'equal', text: afterText }]);
  });

  it('keeps the summary equal to the sum over the page diffs', () => {
    const bodyOld = 'The quick brown fox jumps over the lazy dog while the reader watches.';
    const bodyNew = 'The quick brown fox leaps over the lazy dog while the reader watches.';
    const note = 'A note that is quoted verbatim in the appendix section of the manual.';
    const added = 'A new paragraph the second revision added to the introduction.';
    const gone = 'Obsolete paragraph that the second revision deleted from the appendix.';

    const before = documentWith([
      { page: 1, text: INTRO, y: 100 },
      { page: 1, text: bodyOld, y: 140 },
      { page: 1, text: note, y: 180 },
      { page: 2, text: gone, y: 100 },
      { page: 2, text: ANNEX, y: 140 },
    ]);
    const after = documentWith([
      { page: 1, text: INTRO, y: 100 },
      { page: 1, text: bodyNew, y: 140 },
      { page: 1, text: added, y: 180 },
      { page: 2, text: ANNEX, y: 140 },
      { page: 2, text: note, y: 180 },
    ]);

    const diff = diffDocuments(before, after);

    const counts = { added: 0, removed: 0, changed: 0, moved: 0 };
    let unchanged = 0;
    for (const page of diff.pages) {
      unchanged += page.unchanged;
      for (const change of page.changes) {
        if (change.kind === 'added') counts.added += 1;
        if (change.kind === 'removed') counts.removed += 1;
        if (change.kind === 'changed') counts.changed += 1;
        if (change.kind === 'moved') counts.moved += 1;
      }
    }

    expect(counts).toEqual({ added: 1, removed: 1, changed: 1, moved: 1 });
    expect(unchanged).toBe(2);
    expect(diff.summary).toEqual({ ...counts, unchanged });
    expect(diff.pages.map(page => page.status)).toEqual(['both', 'both']);
  });

  it('marks a page that only one revision has', () => {
    const appended = 'A page appended by the second revision.';
    const single = documentWith([{ page: 1, text: INTRO, y: 100 }], [1]);
    const withExtraPage = documentWith(
      [
        { page: 1, text: INTRO, y: 100 },
        { page: 3, text: appended, y: 100 },
      ],
      [1, 3],
    );

    const grown = diffDocuments(single, withExtraPage);
    expect(grown.pages.map(page => [page.page, page.status])).toEqual([
      [1, 'both'],
      [3, 'added'],
    ]);
    expect(grown.summary).toMatchObject({ added: 1, removed: 0, moved: 0, unchanged: 1 });

    const dropped = documentWith(
      [
        { page: 1, text: INTRO, y: 100 },
        { page: 2, text: appended, y: 100 },
      ],
      [1, 2],
    );
    const shrunk = diffDocuments(dropped, single);
    expect(shrunk.pages.map(page => [page.page, page.status])).toEqual([
      [1, 'both'],
      [2, 'removed'],
    ]);
    expect(shrunk.summary).toMatchObject({ added: 0, removed: 1, moved: 0, unchanged: 1 });
  });
});

describe('diffWords', () => {
  it('returns nothing for two empty texts', () => {
    expect(diffWords('', '   ')).toEqual([]);
  });

  it('reads a replaced word as one delete run then one insert run', () => {
    expect(diffWords('alpha beta gamma delta', 'alpha beta epsilon delta')).toEqual([
      { kind: 'equal', text: 'alpha beta' },
      { kind: 'delete', text: 'gamma' },
      { kind: 'insert', text: 'epsilon' },
      { kind: 'equal', text: 'delta' },
    ]);
  });

  it('marks a pure insertion and a pure deletion', () => {
    expect(diffWords('alpha beta', 'alpha new beta')).toEqual([
      { kind: 'equal', text: 'alpha' },
      { kind: 'insert', text: 'new' },
      { kind: 'equal', text: 'beta' },
    ]);
    expect(diffWords('alpha old beta', 'alpha beta')).toEqual([
      { kind: 'equal', text: 'alpha' },
      { kind: 'delete', text: 'old' },
      { kind: 'equal', text: 'beta' },
    ]);
  });

  it('keeps a short delete out of the runs and folds a short insert into the text', () => {
    // "2" is below the noise floor on both sides: the new text survives as equal.
    expect(diffWords('see page 2 for details', 'see page 3 for details')).toEqual([
      { kind: 'equal', text: 'see page 3 for details' },
    ]);
    // A lone short delete is simply absent from the new text.
    expect(diffWords('see a page for details', 'see page for details')).toEqual([
      { kind: 'equal', text: 'see page for details' },
    ]);
  });

  it('collapses a repeated whitespace-only difference into one equal run', () => {
    expect(diffWords('one   two\nthree', 'one two three')).toEqual([
      { kind: 'equal', text: 'one two three' },
    ]);
  });
});
