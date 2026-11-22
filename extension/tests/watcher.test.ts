import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_WATCH_IGNORE,
  DEFAULT_WATCH_INCLUDE,
  DEFAULT_WATCH_INTERVAL_MS,
  DEFAULT_WATCH_MAX_FILES,
  MIN_WATCH_INTERVAL_MS,
  coalesce,
  diffSnapshot,
  planWatch,
  shouldProcess,
  type FileSnapshot,
  type SnapshotEntry,
  type WatchChange,
  type WatchOptions,
} from '../viewer/src/core/watcher';

/** One snapshot entry, so a test reads as the two facts a poll would have recorded. */
function file(size: number, mtimeMs: number): SnapshotEntry {
  return { size, mtimeMs };
}

function paths(entries: readonly { readonly path: string }[]): string[] {
  return entries.map(entry => entry.path);
}

describe('planWatch', () => {
  it('defaults to a one-second poll of PDFs with the ignore list, capped at five thousand files', () => {
    const plan = planWatch();

    expect(plan.intervalMs).toBe(DEFAULT_WATCH_INTERVAL_MS);
    expect(plan.intervalMs).toBeGreaterThanOrEqual(MIN_WATCH_INTERVAL_MS);
    expect(plan.include).toEqual(['*.pdf']);
    expect(plan.ignore).toEqual([...DEFAULT_WATCH_IGNORE]);
    expect(plan.maxFiles).toBe(DEFAULT_WATCH_MAX_FILES);
  });

  it('documents the three kinds of default ignore: dot-files, temp and lock names, dependency trees', () => {
    const plan = planWatch();

    // Dot-files and dot-directories.
    expect(plan.ignore).toContain('.*');
    // Temporary and lock names, including Office owner files.
    expect(plan.ignore).toContain('*.tmp');
    expect(plan.ignore).toContain('*.lock');
    expect(plan.ignore).toContain('~$*');
    // Directories of other people's files.
    expect(plan.ignore).toContain('node_modules');
    expect(plan.ignore).toContain('__pycache__');
    // And the exported default is the same list the plan carries.
    expect(DEFAULT_WATCH_INCLUDE).toEqual(['*.pdf']);
  });

  it('raises an interval below the floor and falls back for one that is not a number', () => {
    expect(planWatch({ intervalMs: 10 }).intervalMs).toBe(MIN_WATCH_INTERVAL_MS);
    expect(planWatch({ intervalMs: 2_000 }).intervalMs).toBe(2_000);
    expect(planWatch({ intervalMs: 1_234.7 }).intervalMs).toBe(1_235);
    expect(planWatch({ intervalMs: Number.NaN }).intervalMs).toBe(DEFAULT_WATCH_INTERVAL_MS);
    expect(planWatch({ intervalMs: Number.POSITIVE_INFINITY }).intervalMs).toBe(DEFAULT_WATCH_INTERVAL_MS);
  });

  it('cleans a supplied pattern list and lets it replace the default', () => {
    const plan = planWatch({ ignore: ['*.zip', '  *.ZIP ', '', '*.zip', 7 as unknown as string] });

    expect(plan.ignore).toEqual(['*.zip']);
    // A supplied include list replaces the PDF default too; empty means "no include filter".
    expect(planWatch({ include: [] }).include).toEqual([]);
  });

  it('floors maxFiles to a whole file and keeps infinity uncapped', () => {
    expect(planWatch({ maxFiles: 12.9 }).maxFiles).toBe(12);
    expect(planWatch({ maxFiles: 0 }).maxFiles).toBe(1);
    expect(planWatch({ maxFiles: -5 }).maxFiles).toBe(1);
    expect(planWatch({ maxFiles: Number.POSITIVE_INFINITY }).maxFiles).toBe(Number.POSITIVE_INFINITY);
    expect(planWatch({ maxFiles: Number.NaN }).maxFiles).toBe(DEFAULT_WATCH_MAX_FILES);
  });

  it('returns copies, so a caller cannot edit the module defaults through a plan', () => {
    const plan = planWatch();
    (plan.ignore as string[]).push('*.bak');
    (plan.include as string[]).push('*.md');

    expect(DEFAULT_WATCH_IGNORE).not.toContain('*.bak');
    expect(DEFAULT_WATCH_INCLUDE).not.toContain('*.md');
  });

  it('refuses an options value that is not an object', () => {
    expect(() => planWatch([] as unknown as WatchOptions)).toThrow(TypeError);
  });
});

describe('shouldProcess', () => {
  it('accepts a PDF at any depth and rejects a format the include filter does not name', () => {
    expect(shouldProcess('report.pdf')).toBe(true);
    expect(shouldProcess('papers/2024/report.pdf')).toBe(true);
    expect(shouldProcess('C:\\papers\\REPORT.PDF')).toBe(true);
    expect(shouldProcess('report.txt')).toBe(false);
  });

  it('ignores dot-files and anything inside a dot-directory', () => {
    expect(shouldProcess('.hidden.pdf')).toBe(false);
    expect(shouldProcess('papers/.hidden.pdf')).toBe(false);
    expect(shouldProcess('.git/objects/a.pdf')).toBe(false);
    expect(shouldProcess('Papers/.cache/a.pdf')).toBe(false);
    expect(shouldProcess('.DS_Store.pdf', { include: [] })).toBe(false);
  });

  it('ignores temporary and lock names even when no include filter is set', () => {
    const anyFormat = { include: [] };
    for (const path of [
      'out/report.pdf.tmp',
      'report.pdf.temp',
      'report.pdf.swp',
      'report.pdf.part',
      'report.pdf.partial',
      'report.pdf.crdownload',
      'report.pdf.download',
      'paper.lock',
      'paper.lck',
      '~$report.pdf',
      '.~lock.report.pdf#',
    ]) {
      expect(shouldProcess(path, anyFormat), path).toBe(false);
    }
  });

  it('ignores a whole dependency tree, whatever the case of the folder name', () => {
    expect(shouldProcess('node_modules/pkg/docs/readme.pdf')).toBe(false);
    expect(shouldProcess('papers/NODE_MODULES/x/y.pdf')).toBe(false);
    expect(shouldProcess('py/__pycache__/x.pdf')).toBe(false);
  });

  it('applies a custom include filter, and an empty one means every non-ignored path', () => {
    expect(shouldProcess('notes.md', { include: ['*.md'] })).toBe(true);
    expect(shouldProcess('report.pdf', { include: ['*.md'] })).toBe(false);
    expect(shouldProcess('report.pdf', { include: [] })).toBe(true);
    // The ignore list still runs when the include filter is switched off.
    expect(shouldProcess('.git/a.pdf', { include: [] })).toBe(false);
  });

  it('matches a pattern containing a slash against the whole path', () => {
    const options = { include: ['papers/**'], ignore: [] };

    expect(shouldProcess('Papers/2024/report.pdf', options)).toBe(true);
    expect(shouldProcess('drafts/report.pdf', options)).toBe(false);
    expect(shouldProcess('report.pdf', options)).toBe(false);
  });

  it('lets a leading double star match a file at the root and one in a subfolder', () => {
    const options = { include: ['**/*.pdf'], ignore: [] };

    expect(shouldProcess('report.pdf', options)).toBe(true);
    expect(shouldProcess('a/b/report.pdf', options)).toBe(true);
    expect(shouldProcess('a/b/report.txt', options)).toBe(false);
  });

  it('accepts a plan as the options object', () => {
    const plan = planWatch({ include: ['*.pdf', '*.djvu'] });

    expect(shouldProcess('scan.djvu', plan)).toBe(true);
    expect(shouldProcess('scan.djvu.tmp', plan)).toBe(false);
  });

  it('never processes a path that names no file', () => {
    expect(shouldProcess('')).toBe(false);
    expect(shouldProcess('   ')).toBe(false);
    expect(shouldProcess('.')).toBe(false);
    expect(shouldProcess(42 as unknown as string)).toBe(false);
  });
});

describe('diffSnapshot', () => {
  it('reports a file that appeared since the previous poll', () => {
    const diff = diffSnapshot({}, { 'papers/new.pdf': file(1_200, 1_700_000_000_000) });

    expect(diff.added).toEqual([
      { path: 'papers/new.pdf', size: 1_200, mtimeMs: 1_700_000_000_000, maybeTouch: false },
    ]);
    expect(diff.modified).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it('reports a file whose size changed as modified, not as a possible touch', () => {
    const diff = diffSnapshot({ 'a.pdf': file(100, 5) }, { 'a.pdf': file(200, 9) });

    expect(diff.modified).toEqual([{ path: 'a.pdf', size: 200, mtimeMs: 9, maybeTouch: false }]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it('reports a removed file with the numbers it had before it vanished', () => {
    const diff = diffSnapshot({ 'a.pdf': file(100, 5) }, {});

    expect(diff.removed).toEqual([{ path: 'a.pdf', size: 100, mtimeMs: 5, maybeTouch: false }]);
    expect(diff.added).toEqual([]);
    expect(diff.modified).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it('reports an unchanged file when size and mtime both match', () => {
    const diff = diffSnapshot({ 'a.pdf': file(100, 5) }, { 'a.pdf': file(100, 5) });

    expect(diff.unchanged).toEqual([{ path: 'a.pdf', size: 100, mtimeMs: 5, maybeTouch: false }]);
    expect(diff.added.length + diff.modified.length + diff.removed.length).toBe(0);
  });

  it('flags an mtime-only change as a modification that may only be a touch', () => {
    const diff = diffSnapshot({ 'a.pdf': file(100, 5) }, { 'a.pdf': file(100, 9) });

    expect(diff.modified).toEqual([{ path: 'a.pdf', size: 100, mtimeMs: 9, maybeTouch: true }]);
    expect(diff.unchanged).toEqual([]);
    // A size change is real evidence, so the same mtime move is not flagged as a maybe-touch.
    expect(diffSnapshot({ 'a.pdf': file(100, 5) }, { 'a.pdf': file(101, 9) }).modified[0]?.maybeTouch).toBe(false);
  });

  it('sorts every list by path instead of keeping input order', () => {
    const diff = diffSnapshot(
      {
        'd.pdf': file(1, 1),
        'c.pdf': file(1, 1),
        'b.pdf': file(1, 1),
        'a.pdf': file(1, 1),
      },
      {
        'z.pdf': file(2, 2),
        'm.pdf': file(2, 2),
        'a.pdf': file(3, 3),
        'b.pdf': file(1, 1),
      },
    );

    expect(paths(diff.added)).toEqual(['m.pdf', 'z.pdf']);
    expect(paths(diff.modified)).toEqual(['a.pdf']);
    expect(paths(diff.removed)).toEqual(['c.pdf', 'd.pdf']);
    expect(paths(diff.unchanged)).toEqual(['b.pdf']);
  });

  it('reports nothing when both snapshots are empty', () => {
    const empty = { added: [], modified: [], removed: [], unchanged: [] };

    expect(diffSnapshot({}, {})).toEqual(empty);
    expect(diffSnapshot(null, null)).toEqual(empty);
    expect(diffSnapshot(undefined, undefined)).toEqual(empty);
  });

  it('reads a missing previous snapshot as a first run, so everything is added', () => {
    const diff = diffSnapshot(null, { 'b.pdf': file(1, 1), 'a.pdf': file(2, 2) });

    expect(paths(diff.added)).toEqual(['a.pdf', 'b.pdf']);
    expect(diff.modified).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it('normalises separators and dot segments before comparing', () => {
    const diff = diffSnapshot(
      { '.\\papers\\a.pdf': file(1, 1), './b.pdf': file(4, 4) },
      { 'papers/a.pdf': file(2, 2), 'b.pdf': file(4, 4) },
    );

    expect(paths(diff.modified)).toEqual(['papers/a.pdf']);
    expect(paths(diff.unchanged)).toEqual(['b.pdf']);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('reads a Map snapshot as well as a record and skips entries it cannot compare', () => {
    const previous = new Map<string, SnapshotEntry>([
      ['a.pdf', file(1, 1)],
      ['nan.pdf', { size: Number.NaN, mtimeMs: 1 }],
      ['negative.pdf', { size: -1, mtimeMs: 1 }],
    ]);
    const diff = diffSnapshot(previous, { 'a.pdf': file(1, 1) });

    expect(paths(diff.unchanged)).toEqual(['a.pdf']);
    expect(diff.removed).toEqual([]);

    const ignored = diffSnapshot({}, { '': file(1, 1), 'ok.pdf': file(1, 1) });
    expect(paths(ignored.added)).toEqual(['ok.pdf']);
  });

  it('uses byte order rather than a locale so the lists are reproducible', () => {
    const previous: FileSnapshot = { 'Z.pdf': file(1, 1), 'a.pdf': file(1, 1) };
    const diff = diffSnapshot(previous, {});

    // Upper case sorts before lower case in code-unit order; a locale sort would reverse them.
    expect(paths(diff.removed)).toEqual(['Z.pdf', 'a.pdf']);
  });
});

describe('coalesce', () => {
  it('merges two changes for the same path inside the debounce window', () => {
    const changes: WatchChange[] = [
      { path: 'papers/a.pdf', kind: 'added', at: 1_000 },
      { path: 'papers/a.pdf', kind: 'modified', at: 1_100 },
    ];

    expect(coalesce(changes, { debounceMs: 250 })).toEqual([
      { path: 'papers/a.pdf', kind: 'added', at: 1_100, firstAt: 1_000, count: 2 },
    ]);
  });

  it('keeps changes that arrive after the window as separate work', () => {
    const merged = coalesce(
      [
        { path: 'a.pdf', kind: 'modified', at: 1_000 },
        { path: 'a.pdf', kind: 'modified', at: 1_400 },
      ],
      { debounceMs: 250 },
    );

    expect(merged).toEqual([
      { path: 'a.pdf', kind: 'modified', at: 1_000, firstAt: 1_000, count: 1 },
      { path: 'a.pdf', kind: 'modified', at: 1_400, firstAt: 1_400, count: 1 },
    ]);
  });

  it('measures the window from the first change, so a steady stream still gets processed', () => {
    const merged = coalesce(
      [
        { path: 'a.pdf', kind: 'modified', at: 0 },
        { path: 'a.pdf', kind: 'modified', at: 200 },
        { path: 'a.pdf', kind: 'modified', at: 400 },
      ],
      { debounceMs: 250 },
    );

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ firstAt: 0, at: 200, count: 2 });
    expect(merged[1]).toMatchObject({ firstAt: 400, at: 400, count: 1 });
  });

  it('merges a create and a delete inside the window into a removal', () => {
    const merged = coalesce(
      [
        { path: 'a.pdf', kind: 'added', at: 0 },
        { path: 'a.pdf', kind: 'removed', at: 10 },
      ],
      { debounceMs: 250 },
    );

    expect(merged[0]).toMatchObject({ kind: 'removed', count: 2 });
  });

  it('merges a delete and a recreate inside the window into a modification', () => {
    const merged = coalesce(
      [
        { path: 'a.pdf', kind: 'removed', at: 0 },
        { path: 'a.pdf', kind: 'added', at: 10 },
      ],
      { debounceMs: 250 },
    );

    expect(merged[0]).toMatchObject({ kind: 'modified', count: 2 });
  });

  it('does not resurrect a path whose removal is the last thing seen', () => {
    const merged = coalesce(
      [
        { path: 'a.pdf', kind: 'removed', at: 0 },
        { path: 'a.pdf', kind: 'modified', at: 10 },
      ],
      { debounceMs: 250 },
    );

    expect(merged[0]).toMatchObject({ kind: 'removed' });
  });

  it('keeps separate paths apart and sorts the result by path', () => {
    const merged = coalesce([
      { path: 'b.pdf', kind: 'added', at: 0 },
      { path: 'a.pdf', kind: 'added', at: 5 },
      { path: 'a.pdf', kind: 'modified', at: 6 },
    ]);

    expect(merged.map(entry => entry.path)).toEqual(['a.pdf', 'b.pdf']);
    expect(merged.map(entry => entry.count)).toEqual([2, 1]);
  });

  it('normalises paths, drops a change with no path, and carries a missing stamp forward', () => {
    const merged = coalesce([
      { path: '', kind: 'added', at: 0 },
      { path: 'a.pdf', kind: 'added', at: 100 },
      { path: './a.pdf', kind: 'modified' },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ path: 'a.pdf', kind: 'added', at: 100, count: 2 });
  });

  it('merges only same-instant changes when the window is zero', () => {
    expect(
      coalesce(
        [
          { path: 'a.pdf', kind: 'modified', at: 5 },
          { path: 'a.pdf', kind: 'modified', at: 5 },
        ],
        { debounceMs: 0 },
      ),
    ).toHaveLength(1);
    expect(
      coalesce(
        [
          { path: 'a.pdf', kind: 'modified', at: 5 },
          { path: 'a.pdf', kind: 'modified', at: 6 },
        ],
        { debounceMs: 0 },
      ),
    ).toHaveLength(2);
  });

  it('uses the documented default window and treats an empty list as no work', () => {
    const merged = coalesce([
      { path: 'a.pdf', kind: 'modified', at: 0 },
      { path: 'a.pdf', kind: 'modified', at: DEFAULT_DEBOUNCE_MS / 2 },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.count).toBe(2);
    expect(coalesce([])).toEqual([]);
  });

  it('refuses a changes value that is not an array', () => {
    expect(() => coalesce(null as unknown as WatchChange[])).toThrow(TypeError);
  });
});
