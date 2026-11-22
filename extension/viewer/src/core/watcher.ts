/**
 * Folder watch planning for serverless automation (backlog K02).
 *
 * There is no daemon: the CLI polls a folder, compares the result with the snapshot it kept
 * from the previous poll, and starts work on the paths that actually changed. This module is
 * the three decisions in that loop which must not differ between callers — the CLI, the
 * extension's dropped-folder mode and a test all need the same answer to "is this file ours?"
 *
 * 1. **{@link planWatch}** — which files a poll looks at (`include`, `ignore`), how often it
 *    runs (`intervalMs`) and when it stops (`maxFiles`).
 * 2. **{@link diffSnapshot}** — what changed between two snapshots, with the one rule that
 *    matters for a watcher: a file whose mtime moved but whose size did not is a
 *    modification, flagged `maybeTouch`. A same-length overwrite and a bare `touch` are
 *    identical through size alone, so the flag says "the time moved, the bytes may not have".
 * 3. **{@link coalesce}** — which changes collapse into one unit of work, so an editor that
 *    writes a file four times in 200 ms does not queue four extractions.
 *
 * ## What this module does not do
 *
 * It never touches the filesystem, never starts a timer and never reads the clock. Every
 * input that would need one is a parameter: a plan describes a poll, a snapshot is what a
 * poll read (a record or a `Map` of path to `{ size, mtimeMs }`), and a change carries the
 * `at` stamp its observer gave it. That is what makes a report from the module reproducible
 * and the tests exact instead of timing-dependent.
 *
 * ## Rules the caller has to keep
 *
 * - **A truncated enumeration must not be diffed against a full snapshot.** If a poll stops
 *   at `maxFiles`, the next diff would report every file it did not look at as removed, and
 *   the caller would delete indexed state for files that are still there. Reuse the previous
 *   snapshot for the paths a truncated poll did not read.
 * - **`include` and `ignore` replace their defaults, they do not extend them.** Passing one
 *   extra pattern would otherwise silently drop dot-file protection. Spread
 *   {@link DEFAULT_WATCH_IGNORE} when the intent is "the defaults plus one".
 * - **Patterns are matched case-insensitively** ({@link shouldProcess} is explicit about it),
 *   and a pattern with no `/` is matched against every path segment, so `node_modules`
 *   ignores the directory and everything below it. A pattern containing a `/` is matched
 *   against the whole normalised path.
 */

// --- Limits ----------------------------------------------------------------

/**
 * Fastest poll {@link planWatch} accepts, in milliseconds.
 *
 * A poll stats every candidate file, so the floor exists to keep a watcher from spending more
 * time in the filesystem than in the work it schedules. A caller asking for less gets this.
 */
export const MIN_WATCH_INTERVAL_MS = 250;

/** Poll interval used when the caller names none, in milliseconds: one second. */
export const DEFAULT_WATCH_INTERVAL_MS = 1_000;

/** Debounce window {@link coalesce} uses when the caller names none, in milliseconds. */
export const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Files one poll enumerates before it must stop, used when the caller names no cap.
 *
 * Large enough for a shared folder of papers, small enough that a `stat` per file stays under
 * a second on a laptop. See the truncation warning in the module comment.
 */
export const DEFAULT_WATCH_MAX_FILES = 5_000;

// --- Name patterns ---------------------------------------------------------

/**
 * Names of files that are never content: an editor swap file, an unfinished copy, a partial
 * download. Matched case-insensitively against every path segment, so `*.tmp` also hides
 * `out/report.pdf.tmp` — a file whose name still says PDF while its content is half written.
 */
export const TEMP_FILE_PATTERNS: readonly string[] = [
  '*.tmp',
  '*.temp',
  '*.swp',
  '*.swx',
  '*.part',
  '*.partial',
  '*.crdownload',
  '*.download',
];

/**
 * Names of files that mark a resource as held rather than describing it: a lock file next to
 * the document, or the owner file Word and Excel leave beside an open document (`~$paper.docx`).
 */
export const LOCK_FILE_PATTERNS: readonly string[] = ['*.lock', '*.lck', '~$*'];

/**
 * What {@link planWatch} ignores by default.
 *
 * - `.*` hides dot-files and every dot-directory, which covers `.git`, `.cache`, `.DS_Store`
 *   and the LibreOffice lock `.~lock.paper.pdf#`.
 * - `node_modules`, `bower_components` and `__pycache__` are directory trees of other people's
 *   files: a watcher that descends into them reads tens of thousands of non-documents.
 * - `Thumbs.db` and `desktop.ini` are the Windows shell's own files.
 * - Then the temporary and lock patterns above.
 *
 * Order is the order a settings dialog shows them; matching does not depend on it.
 */
export const DEFAULT_WATCH_IGNORE: readonly string[] = [
  '.*',
  'node_modules',
  'bower_components',
  '__pycache__',
  'Thumbs.db',
  'desktop.ini',
  ...TEMP_FILE_PATTERNS,
  ...LOCK_FILE_PATTERNS,
];

/**
 * What {@link planWatch} processes by default: PDFs, the only document this reader opens.
 *
 * A caller adding a second format passes `{ include: [...DEFAULT_WATCH_INCLUDE, '*.djvu'] }`,
 * because a supplied list replaces this one.
 */
export const DEFAULT_WATCH_INCLUDE: readonly string[] = ['*.pdf'];

/** Cap on the compiled-pattern memo; a caller's pattern list is short, a long session is not. */
const PATTERN_CACHE_LIMIT = 256;

// --- Inputs ----------------------------------------------------------------

/** The knobs a poll is described with. Every field is optional and has the documented default. */
export interface WatchOptions {
  /**
   * Milliseconds between polls. Defaults to {@link DEFAULT_WATCH_INTERVAL_MS} and is raised to
   * {@link MIN_WATCH_INTERVAL_MS} when smaller. A non-finite value falls back to the default
   * rather than turning into a `NaN` timer.
   */
  readonly intervalMs?: number;
  /**
   * Patterns for paths to leave alone. Defaults to {@link DEFAULT_WATCH_IGNORE}; a supplied
   * list **replaces** the default, so spread the default to extend it.
   */
  readonly ignore?: readonly string[];
  /**
   * Patterns a path must match to be processed. Defaults to {@link DEFAULT_WATCH_INCLUDE};
   * a supplied list **replaces** the default, and an empty list means "no include filter".
   */
  readonly include?: readonly string[];
  /**
   * Files one poll reads before it stops. Defaults to {@link DEFAULT_WATCH_MAX_FILES}, is
   * floored to a whole number of at least 1, and accepts `Number.POSITIVE_INFINITY` for
   * "no cap".
   */
  readonly maxFiles?: number;
}

/** What a poll does, once the defaults and the floor have been applied. */
export interface WatchPlan {
  /** Effective poll interval in milliseconds, never below {@link MIN_WATCH_INTERVAL_MS}. */
  readonly intervalMs: number;
  /** Effective ignore patterns, in the order they were supplied. */
  readonly ignore: readonly string[];
  /** Effective include patterns; empty means every path that is not ignored. */
  readonly include: readonly string[];
  /** Files one poll reads before it stops; `Number.POSITIVE_INFINITY` when uncapped. */
  readonly maxFiles: number;
}

/**
 * The `include`/`ignore` half of {@link WatchOptions}.
 *
 * A {@link WatchPlan} satisfies it structurally, so `shouldProcess(path, planWatch())` is the
 * intended call and a plan can be handed to a filter without unwrapping it.
 */
export interface WatchFilterOptions {
  readonly ignore?: readonly string[];
  readonly include?: readonly string[];
}

/**
 * What a poll recorded about one file: the two numbers `stat` gives cheaply.
 *
 * Sizes are bytes and `mtimeMs` is milliseconds since the Unix epoch (the unit `Date.now()` and
 * `fs.Stats.mtimeMs` use). Both are compared exactly, never with a tolerance: a snapshot is a
 * record of what the filesystem reported, and rounding it here would hide a change the caller
 * could otherwise see.
 */
export interface SnapshotEntry {
  /** File size in bytes; negative values are refused when a snapshot is read. */
  readonly size: number;
  /** Modification time in milliseconds since the Unix epoch. */
  readonly mtimeMs: number;
}

/**
 * One poll's reading of a folder: a path-to-{@link SnapshotEntry} map.
 *
 * A plain record is the JSON-friendly form a caller persists between runs; a `Map` is what a
 * scanner builds while it walks. Both are accepted, keys are normalised the same way
 * `shouldProcess` normalises a path, and the first entry for a normalised path wins.
 */
export type FileSnapshot = Readonly<Record<string, SnapshotEntry>> | ReadonlyMap<string, SnapshotEntry>;

/** The three things that can happen to a path between two snapshots. */
export type ChangeKind = 'added' | 'modified' | 'removed';

/** One changed path, as {@link diffSnapshot} reports it and {@link coalesce} consumes it. */
export interface DiffEntry {
  /** Normalised path, `/`-separated, as the snapshot key was written. */
  readonly path: string;
  /**
   * Size in bytes: the current size for an added, modified or unchanged entry; the size the
   * file had before it vanished for a removed one.
   */
  readonly size: number;
  /**
   * Modification time in milliseconds: the current one for an added, modified or unchanged
   * entry; the last known one for a removed one.
   */
  readonly mtimeMs: number;
  /**
   * True only for a modification whose size did not change while its mtime did. The file may
   * have been rewritten with the same byte count, or only touched; from `stat` the two are
   * indistinguishable, so the caller decides whether to re-read it. Always `false` for added,
   * removed and unchanged entries, where the evidence is not ambiguous.
   */
  readonly maybeTouch: boolean;
}

/** What changed between two snapshots. Every list is sorted by path and may be empty. */
export interface SnapshotDiff {
  /** Paths present only in the current snapshot, sorted. */
  readonly added: readonly DiffEntry[];
  /** Paths in both whose size or mtime differs, sorted. */
  readonly modified: readonly DiffEntry[];
  /** Paths present only in the previous snapshot, sorted, carrying their last known numbers. */
  readonly removed: readonly DiffEntry[];
  /** Paths whose size and mtime are both identical, sorted. */
  readonly unchanged: readonly DiffEntry[];
}

/** One change as an observer reported it, before {@link coalesce} groups repeats. */
export interface WatchChange {
  /** Path the observer reported. Normalised, so `./a.pdf` and `a.pdf` are one path. */
  readonly path: string;
  /** What happened. A kind outside the three is read as `modified`. */
  readonly kind: ChangeKind;
  /**
   * When the change was observed, in milliseconds since the Unix epoch. A change without a
   * usable stamp is timed at the last stamp seen in the list, so it joins the group it
   * arrived in instead of sorting to the front.
   */
  readonly at?: number;
}

export interface CoalesceOptions {
  /**
   * Length of the debounce window in milliseconds. Defaults to {@link DEFAULT_DEBOUNCE_MS}.
   * A negative or non-finite value falls back to the default; `0` merges only changes stamped
   * at the identical instant.
   */
  readonly debounceMs?: number;
}

/** One unit of work: everything that happened to a path inside one debounce window. */
export interface CoalescedChange {
  /** Normalised path this entry is about. */
  readonly path: string;
  /** Net effect of every change folded in; see {@link coalesce} for the merge rules. */
  readonly kind: ChangeKind;
  /** Stamp of the newest change folded in, in milliseconds since the Unix epoch. */
  readonly at: number;
  /** Stamp of the first change folded in; `at - firstAt` is how long the window stayed open. */
  readonly firstAt: number;
  /** Raw changes folded in; `1` when nothing was merged. */
  readonly count: number;
}

// --- Plan ------------------------------------------------------------------

/**
 * Resolves the defaults and the floor into the plan a poll follows.
 *
 * `intervalMs` is raised to {@link MIN_WATCH_INTERVAL_MS}; `maxFiles` is floored to a whole
 * number of at least 1 and keeps `Number.POSITIVE_INFINITY`; `include` and `ignore` replace
 * their defaults when supplied (see {@link WatchOptions.ignore}). Patterns are trimmed,
 * dropped when empty, and deduplicated case-insensitively, because `*.PDF` and `*.pdf` are one
 * rule after lowercasing and matching them twice only costs time.
 *
 * The returned lists are copies: a caller that edits the plan cannot edit the module defaults.
 */
export function planWatch(options: WatchOptions = {}): WatchPlan {
  const source = options ?? {};
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('planWatch needs an options object, or nothing for the defaults.');
  }
  return {
    intervalMs: readInterval(source.intervalMs),
    ignore: readPatterns(source.ignore, DEFAULT_WATCH_IGNORE),
    include: readPatterns(source.include, DEFAULT_WATCH_INCLUDE),
    maxFiles: readMaxFiles(source.maxFiles),
  };
}

/**
 * Decides whether one path is a candidate for processing.
 *
 * A path is processed when no ignore pattern matches it and at least one include pattern does;
 * an empty include list means "everything that is not ignored". Matching is case-insensitive
 * on both lists, so a folder renamed to `Papers` and a file renamed to `REPORT.PDF` get the
 * same answer as their lower-case spellings. Patterns are matched against the normalised path
 * (backslashes become `/`, `.` segments disappear) under the rules in the module comment.
 *
 * `options` is a {@link WatchFilterOptions}, which a {@link WatchPlan} satisfies, so
 * `shouldProcess(path, planWatch())` is the intended call. An empty or `.` path is never
 * processed: it names no file.
 */
export function shouldProcess(path: string, options: WatchFilterOptions = {}): boolean {
  if (typeof path !== 'string') return false;
  const target = targetOf(path);
  if (target.path.length === 0) return false;

  const rules = resolveRules(options);
  if (matchesAny(target, rules.ignore)) return false;
  if (rules.include.length === 0) return true;
  return matchesAny(target, rules.include);
}

// --- Snapshot diff ---------------------------------------------------------

/**
 * Compares two snapshots, path by path.
 *
 * The rules, exhaustively:
 *
 * | previous | current | result |
 * | --- | --- | --- |
 * | absent | present | `added` |
 * | present | absent | `removed`, carrying the previous size and mtime |
 * | present | present, same size and mtime | `unchanged` |
 * | present | present, size differs | `modified`, `maybeTouch: false` |
 * | present | present, size equal, mtime differs | `modified`, `maybeTouch: true` |
 *
 * The last row is the one a caller must think about: a same-length rewrite is a real change, a
 * bare `touch` is not, and `stat` cannot tell them apart. Treat it as a modification (re-read
 * the file) and let a content hash decide whether work is actually needed. Two readings that
 * report identical size *and* mtime are `unchanged`; that is what `stat` can promise, not a
 * proof that the bytes are identical.
 *
 * Every list is sorted by path using code-unit order (`<`), not `localeCompare`, so the output
 * is byte-stable regardless of the machine's locale. `null` or `undefined` is read as an empty
 * snapshot, which makes the first run report everything as added. Entries whose path is empty,
 * or whose size or mtime is not a finite non-negative number, are skipped rather than compared
 * against `NaN`.
 */
export function diffSnapshot(
  previous: FileSnapshot | null | undefined,
  current: FileSnapshot | null | undefined,
): SnapshotDiff {
  const before = readSnapshot(previous);
  const after = readSnapshot(current);
  const added: DiffEntry[] = [];
  const modified: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const unchanged: DiffEntry[] = [];

  for (const [path, entry] of after) {
    const prior = before.get(path);
    if (prior === undefined) {
      added.push({ path, size: entry.size, mtimeMs: entry.mtimeMs, maybeTouch: false });
      continue;
    }
    const sameSize = prior.size === entry.size;
    const sameTime = prior.mtimeMs === entry.mtimeMs;
    if (sameSize && sameTime) {
      unchanged.push({ path, size: entry.size, mtimeMs: entry.mtimeMs, maybeTouch: false });
      continue;
    }
    // `maybeTouch` is exactly "the time moved and the size did not": the one case where the
    // snapshot cannot say whether the bytes changed.
    modified.push({ path, size: entry.size, mtimeMs: entry.mtimeMs, maybeTouch: sameSize });
  }

  for (const [path, entry] of before) {
    if (after.has(path)) continue;
    removed.push({ path, size: entry.size, mtimeMs: entry.mtimeMs, maybeTouch: false });
  }

  return {
    added: added.sort(compareByPath),
    modified: modified.sort(compareByPath),
    removed: removed.sort(compareByPath),
    unchanged: unchanged.sort(compareByPath),
  };
}

// --- Coalescing ------------------------------------------------------------

/**
 * Folds repeated changes for one path into one unit of work.
 *
 * A group stays open while changes for that path keep arriving **no later than `debounceMs`
 * after the group's first change** — a fixed window, not a sliding one. That choice is
 * deliberate: a sliding window resets on every event, so a file being written continuously
 * would never be handed to automation at all, while a fixed window guarantees that work starts
 * within one window of the first event and at most one extra run per window after that. When
 * the window closes, the group is emitted and the next change for the same path opens a new
 * one, so two distant edits produce two entries.
 *
 * Merging is the net effect, in observation order:
 *
 * - `added` then `modified` is still `added` — the path is new, and the work is the same.
 * - `added` then `removed` is `removed`, so automation that never saw the file can still clear
 *   any state it holds for that path; the cleanup is idempotent.
 * - `removed` then `added` is `modified`: the path existed before the window, so the file that
 *   is there now replaces one the caller may already have processed.
 * - `removed` then `modified` stays `removed`. A modification of a path last seen removed means
 *   the observer missed the recreation; reporting the path as present would send the caller to
 *   read a file that may not be there, so the removal stands until an `added` says otherwise.
 *
 * Output is sorted by path, then by the group's first stamp, so two runs of the same input
 * produce the same list. Changes with no usable path are dropped; a change with no usable stamp
 * takes the previous stamp in the list (see {@link WatchChange.at}).
 */
export function coalesce(changes: readonly WatchChange[], options: CoalesceOptions = {}): CoalescedChange[] {
  if (!Array.isArray(changes)) {
    throw new TypeError('coalesce needs the array of changes a poll observed.');
  }
  const window = readDebounce(options?.debounceMs);
  const open = new Map<string, Group>();
  const closed: CoalescedChange[] = [];
  let clock = 0;

  for (const change of changes as readonly (WatchChange | null | undefined)[]) {
    const path = readPath(change?.path);
    if (path === undefined) continue;

    const stamp = readStamp(change?.at);
    if (stamp !== undefined) clock = stamp;
    const at = stamp ?? clock;
    const kind = readKind(change?.kind);

    const group = open.get(path);
    if (group === undefined) {
      open.set(path, { kind, firstAt: at, at, count: 1 });
      continue;
    }
    if (at - group.firstAt <= window) {
      group.kind = mergeKind(group.kind, kind);
      group.at = Math.max(group.at, at);
      group.count += 1;
      continue;
    }
    closed.push({ path, kind: group.kind, at: group.at, firstAt: group.firstAt, count: group.count });
    open.set(path, { kind, firstAt: at, at, count: 1 });
  }

  for (const [path, group] of open) {
    closed.push({ path, kind: group.kind, at: group.at, firstAt: group.firstAt, count: group.count });
  }

  return closed.sort((left, right) => compareByPath(left, right) || left.firstAt - right.firstAt);
}

// --- Internals -------------------------------------------------------------

/** One open debounce group, mutated while changes for its path keep arriving. */
interface Group {
  kind: ChangeKind;
  readonly firstAt: number;
  at: number;
  count: number;
}

/** What pattern matching runs against: the normalised path and its segments, lower-cased. */
interface PathTarget {
  readonly path: string;
  readonly segments: readonly string[];
}

interface CompiledPattern {
  readonly regex: RegExp;
  /** True when the pattern contains a slash and is therefore matched against the whole path. */
  readonly wholePath: boolean;
}

/** Compiled-pattern memo: one entry per distinct pattern seen, cleared when it grows too far. */
const PATTERN_CACHE = new Map<string, CompiledPattern>();

/** The `include`/`ignore` pair a call runs with, defaults already resolved. */
function resolveRules(options: WatchFilterOptions | null | undefined): {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
} {
  const source = options ?? {};
  return {
    include: readPatterns(source.include, DEFAULT_WATCH_INCLUDE),
    ignore: readPatterns(source.ignore, DEFAULT_WATCH_IGNORE),
  };
}

/**
 * The effective pattern list.
 *
 * Missing or non-array input takes the default; a supplied array is cleaned instead, so an
 * empty array really means "no patterns" for both fields.
 */
function readPatterns(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    patterns.push(trimmed);
  }
  return patterns;
}

/** The poll interval: defaulted when unusable, raised to the floor, rounded to whole ms. */
function readInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WATCH_INTERVAL_MS;
  return Math.max(MIN_WATCH_INTERVAL_MS, Math.round(value));
}

/** The file cap: defaulted when unusable, floored to at least 1, `Infinity` preserved. */
function readMaxFiles(value: unknown): number {
  if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_WATCH_MAX_FILES;
  return Math.max(1, Math.floor(value));
}

/** The debounce window: defaulted when unusable, `0` kept as "merge same-instant only". */
function readDebounce(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_DEBOUNCE_MS;
  return value;
}

/** A snapshot as a normalised path map; `null`/`undefined` reads as empty. */
function readSnapshot(snapshot: FileSnapshot | null | undefined): Map<string, SnapshotEntry> {
  const entries = new Map<string, SnapshotEntry>();
  if (snapshot === null || snapshot === undefined) return entries;

  // `ReadonlyMap` is not a class type, so the branch is taken on `Map` and the record case is
  // reached by elimination, the same shape `query.ts` uses for its glossary input.
  if (snapshot instanceof Map) {
    for (const [path, entry] of snapshot as ReadonlyMap<string, SnapshotEntry>) add(entries, path, entry);
    return entries;
  }
  for (const [path, entry] of Object.entries(snapshot as Readonly<Record<string, SnapshotEntry>>)) {
    add(entries, path, entry);
  }
  return entries;
}

/** Adds one snapshot entry, skipping it when its path or numbers cannot be compared. */
function add(entries: Map<string, SnapshotEntry>, path: unknown, entry: SnapshotEntry | null | undefined): void {
  const normalised = readPath(path);
  if (normalised === undefined) return;
  const size = entry?.size;
  const mtimeMs = entry?.mtimeMs;
  if (!isMeasurement(size) || !isMeasurement(mtimeMs)) return;
  // First entry wins, so the same path written twice cannot flip between snapshots.
  if (entries.has(normalised)) return;
  entries.set(normalised, { size, mtimeMs });
}

/** A usable byte count or timestamp: a finite number that is not negative. */
function isMeasurement(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** A path as this module keys and matches it, or `undefined` when it names nothing. */
function readPath(path: unknown): string | undefined {
  if (typeof path !== 'string') return undefined;
  const normalised = normalizePath(path);
  return normalised.length === 0 ? undefined : normalised;
}

/** A change stamp, or `undefined` when the observer did not give a usable one. */
function readStamp(value: unknown): number | undefined {
  return isMeasurement(value) ? value : undefined;
}

/** A change kind; anything outside the three becomes `modified`, the re-read-it default. */
function readKind(value: unknown): ChangeKind {
  return value === 'added' || value === 'removed' ? value : 'modified';
}

/**
 * The net effect of `previous` and `next` inside one window. The table is in {@link coalesce};
 * this function is it. `removed` is sticky except for a following `added`, which means the path
 * existed before and exists now, so it is a modification rather than a first sighting.
 */
function mergeKind(previous: ChangeKind, next: ChangeKind): ChangeKind {
  if (previous === 'removed') return next === 'added' ? 'modified' : 'removed';
  if (next === 'removed') return 'removed';
  if (previous === 'added') return 'added';
  return 'modified';
}

/**
 * Normalises a path for keying: backslashes become `/`, `.` segments and empty segments
 * disappear, and a trailing slash is dropped. A leading `/` is preserved, because an absolute
 * path and a relative one are different files. `..` is **not** resolved: doing so is a
 * filesystem question, and this module does not touch the filesystem.
 */
function normalizePath(path: string): string {
  const slashed = path.trim().replace(/\\/g, '/');
  const absolute = slashed.startsWith('/');
  const segments = slashed.split('/').filter(segment => segment.length > 0 && segment !== '.');
  const joined = segments.join('/');
  return absolute ? `/${joined}` : joined;
}

/** The lower-cased path and segments a pattern is matched against. */
function targetOf(path: string): PathTarget {
  const normalised = normalizePath(path).toLowerCase();
  return {
    path: normalised,
    segments: normalised.split('/').filter(segment => segment.length > 0),
  };
}

/** True when any pattern matches the target, under the whole-path / per-segment rule. */
function matchesAny(target: PathTarget, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    const compiled = compilePattern(pattern);
    if (compiled.wholePath) {
      if (compiled.regex.test(target.path)) return true;
      continue;
    }
    for (const segment of target.segments) {
      if (compiled.regex.test(segment)) return true;
    }
  }
  return false;
}

/** Compiles (and memoises) a pattern. The regex is anchored; the pattern is already folded. */
function compilePattern(pattern: string): CompiledPattern {
  const key = pattern.trim().toLowerCase();
  const cached = PATTERN_CACHE.get(key);
  if (cached !== undefined) return cached;

  const compiled: CompiledPattern = {
    regex: new RegExp(`^${globSource(key)}$`),
    wholePath: key.includes('/'),
  };
  // A wholesale clear is enough: the cache is a memo for one polling run, not data.
  if (PATTERN_CACHE.size >= PATTERN_CACHE_LIMIT) PATTERN_CACHE.clear();
  PATTERN_CACHE.set(key, compiled);
  return compiled;
}

/** Characters that would otherwise be read as regex syntax. */
const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|]/;

/**
 * A glob as a regex source. `*` is any run of characters inside one segment, `?` is one such
 * character, and a double star crosses segments; when a double star is followed by a slash it
 * may also match no leading directory at all, so a pattern that starts with a double star and
 * a slash still matches a file at the root. Everything else is literal.
 */
function globSource(pattern: string): string {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) break;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:[\\s\\S]*/)?';
        } else {
          source += '[\\s\\S]*';
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    source += REGEX_SPECIAL.test(char) ? `\\${char}` : char;
  }
  return source;
}

/** Code-unit path order: stable everywhere, unlike `localeCompare`. */
function compareByPath(left: { readonly path: string }, right: { readonly path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
