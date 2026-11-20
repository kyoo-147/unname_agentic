/**
 * What a drag and drop of files should do, decided before a byte is read (backlog L08).
 *
 * The reader takes files from two places: the picker, which declares `application/pdf`, and
 * a drop, which is whatever the reader dragged. `src/main.ts` hands both straight to the
 * PDF loader, and that is honest for one PDF and wrong for a drop, because a drop can be:
 *
 * - a folder, which the loader reads as a file and fails on;
 * - a DOCX, which fails inside the PDF parser instead of saying what it is;
 * - a document the library already holds, which becomes a second library row and a second
 *   copy of the same bytes;
 * - four hundred files, which the reader will try to load in one pass;
 * - nothing at all, because the drop carried text or an image from another application.
 *
 * This module is the decision that belongs in front of all five. Given what the platform
 * says was dropped and the library the reader already has, it returns every entry in one
 * of four buckets — accepted, refused, deferred, duplicate — with a sentence a reader can
 * act on. It reads nothing: it is the cheap answer a drop handler shows before the first
 * file is opened.
 *
 * ## The rules, and why each one
 *
 * - **The name decides format eligibility; the bytes decide later.** `allowedFormats`
 *   holds file extensions, so a drop accepts `.pdf` and refuses `.docx` without touching
 *   the file. That is the only option at this point in the flow — a `DataTransferItem`'s
 *   MIME type is frequently empty or wrong, and reading a 200 MB file to find out what it
 *   is before the reader has decided to take it is backwards. `sniffFormat` in
 *   `import-formats.ts` still decides what the bytes are once the file is read, and a file
 *   that passes this check can still be refused there. The split is deliberate: the drop
 *   decides what to attempt, the sniffer decides what it turned out to be.
 * - **A duplicate is a name plus a size, compared case-insensitively.** The same name at
 *   the same byte count is the same document, and adding it again costs storage and shows
 *   the reader two identical rows. The same name at a different size is a revision — a
 *   rebuilt or re-exported PDF — and is accepted, because the library has no other way to
 *   tell those apart. Case is folded because the platforms this app targets put
 *   `Report.pdf` and `report.pdf` on one path, and two library rows that differ only in
 *   case look like a bug. The cost of folding is real and accepted: on a case-sensitive
 *   filesystem, two genuinely different files whose names differ only in case lose one to
 *   the duplicate rule.
 * - **A folder is deferred, never expanded.** A directory entry is a place to look, not a
 *   list of files, and this module never reads the disk. So a folder is reported with
 *   `folder-needs-scan`, and the caller scans it and calls back with what it found. A
 *   caller that already had the immediate contents from the platform may pass them on the
 *   item: those are planned in the folder's slot, sorted by name, and the folder is *still*
 *   deferred, because a listing can be partial — Chromium's `readEntries` returns at most
 *   100 entries per call — and because subfolders inside it need their own scan.
 * - **Caps are greedy, and a refusal is per file.** The file cap counts accepted files,
 *   so it refuses a suffix of the drop. The byte cap is consulted per file, so one large
 *   file that would pass the budget does not stop a smaller one behind it: a 40 MB video
 *   is refused while the 2 MB PDF after it is still accepted. The alternative — refuse the
 *   whole drop when any file is over — throws away files the reader wanted, for a reason
 *   the reader fixes by dropping fewer at once. A file too large for the entire budget is
 *   refused as `too-large` rather than as `over-max-bytes`, because no smaller neighbours
 *   can make room for it and the sentence should say so.
 * - **One bad file never fails the drop.** The only whole-drop refusal is `empty-drop`,
 *   and it exists because a drop from another application can carry no files at all, which
 *   is worth saying out loud instead of showing an empty list.
 *
 * ## What it deliberately does not decide
 *
 * - **Which accepted file opens first.** `accepted` is in drop order, and the caller picks
 *   the first; this module has no opinion about the reader's opening rule.
 * - **What to do about a duplicate.** The plan refuses it and names the library entry, so
 *   a UI can offer "open the copy I already have" without this module owning that
 *   interaction.
 * - **Whether a folder is allowed.** The plan defers it with a sentence; the caller scans
 *   and plans again, and the second pass applies these same rules.
 * - **Deduplicating a library that already holds duplicates.** It compares the drop against
 *   the library as given, not the library against itself.
 *
 * ## Purity
 *
 * Pure and deterministic: no clock, no randomness, no DOM, no locale collation, no I/O,
 * no dependency. The same arguments always produce the same plan, and every list is
 * ordered by the rules above rather than by whatever the platform happened to hand over
 * first inside a folder. It never throws: a drop handler runs on a user event, where a
 * thrown exception turns "I cannot take this file" into "the app is broken".
 */

// --- Public shapes ---------------------------------------------------------

/** What a dropped entry is: a file this app can plan, or a folder it must scan first. */
export type DropKind = 'file' | 'folder';

/** One file, as the drop or a folder listing described it. */
export interface DropFile {
  /** The file name, used for the extension and for duplicate detection. */
  readonly name: string;
  /** Where the caller can find the file again; the plan only carries it through. */
  readonly path: string;
  /** Size in bytes, as reported by the platform. Zero when the platform reported none. */
  readonly size: number;
}

/**
 * One entry the platform handed over.
 *
 * `kind` is the entry's own type, not something inferred from the name: a folder named
 * `papers.pdf` is still a folder. `contents` is read only for a folder, and only when the
 * caller already had the listing; it never causes a disk read here.
 */
export interface DropItem extends DropFile {
  readonly kind: DropKind;
  /**
   * Immediate contents of a folder, when the platform had already listed them.
   *
   * Files only: a subfolder inside a folder is found by the scan that
   * `folder-needs-scan` asks for. These entries are planned as files, in the folder's
   * position in the drop, sorted by name; the folder itself is still deferred.
   */
  readonly contents?: readonly DropFile[];
}

/**
 * Why a dropped file is not in `accepted`.
 *
 * - `unsupported-format`: the name's extension is not in `allowedFormats`, or there is no
 *   extension to check.
 * - `too-large`: one file's size is past the whole `maxBytes` budget.
 * - `duplicate`: the library already holds this name at this size, or an earlier file in
 *   this same drop does.
 * - `folder-needs-scan`: not a refusal — a deferral. The caller scans the folder and plans
 *   what it holds in a second pass.
 * - `over-max-files`: the file cap is already reached.
 * - `over-max-bytes`: accepting this file would pass the byte budget.
 * - `empty-drop`: nothing plannable was handed over.
 */
export type DropRejectionCode =
  | 'unsupported-format'
  | 'too-large'
  | 'duplicate'
  | 'folder-needs-scan'
  | 'over-max-files'
  | 'over-max-bytes'
  | 'empty-drop';

/** Every rejection code, in a fixed order, for a caller that needs to enumerate them. */
export const DROP_REJECTION_CODES: readonly DropRejectionCode[] = [
  'unsupported-format',
  'too-large',
  'duplicate',
  'folder-needs-scan',
  'over-max-files',
  'over-max-bytes',
  'empty-drop',
];

/** A file the drop takes, with the sentence a reader can be shown. */
export interface DropAccepted {
  readonly name: string;
  readonly path: string;
  readonly reason: string;
}

/** A file or folder the drop does not take, with a stable code and a readable sentence. */
export interface DropRejected {
  readonly name: string;
  readonly path: string;
  readonly code: DropRejectionCode;
  readonly reason: string;
}

/**
 * A library entry as duplicate detection reads it: a name and a size, nothing else.
 *
 * `LibrarySummary` from `library-store.ts` satisfies this structurally, so a caller can
 * pass `list()` straight through. A row without a usable size is skipped, because a
 * duplicate needs both halves of the comparison.
 */
export interface DropExisting {
  readonly name: string;
  readonly size: number;
}

/** One file refused because a copy of it is already known. */
export interface DropDuplicate {
  readonly name: string;
  readonly path: string;
  /** Which side already held the file: the library the caller passed, or this same drop. */
  readonly match: 'library' | 'drop';
  /** The entry this file collided with, named so a UI can offer to open it. */
  readonly existing: DropExisting;
}

/** Counts a caller needs to show what the caps did, without re-walking the lists. */
export interface DropOverflow {
  /** Files the drop asked for: every accepted file plus every refused file. Folders are not files. */
  readonly requestedFiles: number;
  /** Files in `accepted`. */
  readonly acceptedFiles: number;
  /** Bytes in `accepted`, the running total the byte cap was compared against. */
  readonly acceptedBytes: number;
  /** Files refused by the file cap; equal to the `over-max-files` rejections. */
  readonly overFiles: number;
  /** Files refused by the byte cap; equal to the `over-max-bytes` rejections. */
  readonly overBytes: number;
}

/** The whole decision for one drop. */
export interface DropPlan {
  /** Files to import, in drop order, each folder's contents expanded in place. */
  readonly accepted: readonly DropAccepted[];
  /** Refusals and folder deferrals, in the order they were examined. */
  readonly rejected: readonly DropRejected[];
  /** Convenience view of the `duplicate` rejections, with the entry that was matched. */
  readonly duplicates: readonly DropDuplicate[];
  /** What the caps did, as counts. */
  readonly overflow: DropOverflow;
}

/**
 * What the caller will accept.
 *
 * Every limit is optional. `allowedFormats` defaults to {@link DEFAULT_DROP_FORMATS}; an
 * explicit empty array means this drop allows nothing, which is a different statement from
 * "the caller did not say" and is honoured as such.
 */
export interface DropOptions {
  /**
   * Extensions the drop takes, written with or without a leading dot, in any case:
   * `['pdf']`, `['.PDF']` and `['.pdf']` are the same list. Defaults to
   * {@link DEFAULT_DROP_FORMATS}.
   */
  readonly allowedFormats?: readonly string[];
  /**
   * Most files one drop may accept. Counts accepted files only, never folders. Defaults to
   * no cap; a value below zero is read as zero.
   */
  readonly maxFiles?: number;
  /**
   * Byte budget for one drop, compared against accepted files. Defaults to no cap; a value
   * below zero is read as zero.
   */
  readonly maxBytes?: number;
}

/** The formats a drop takes when the caller does not say, which is what the reader reads today. */
export const DEFAULT_DROP_FORMATS: readonly string[] = ['pdf'];

/** Stands in for "the caller set no cap". */
const NO_LIMIT = Number.POSITIVE_INFINITY;

/** Separates the two halves of a duplicate key; no file name can carry it. */
const KEY_SEPARATOR = '\u0000';

// --- Planning --------------------------------------------------------------

/**
 * Decides what one drop does, without reading anything.
 *
 * `items` is what the platform reported, in the order it reported it. `existing` is the
 * library the reader already holds, and only `name` and `size` are read from it. `options`
 * carries the formats and the two caps.
 *
 * Every entry lands in exactly one place: a file is either in `accepted` or in `rejected`
 * (and, when it was refused as a duplicate, also in `duplicates`); a folder always lands in
 * `rejected` with `folder-needs-scan`, after its listed contents have been planned. An
 * entry with no name is skipped, because nothing in the plan could identify it again.
 *
 * Never throws; malformed input is read defensively rather than trusted.
 */
export function planDrop(
  items: readonly DropItem[],
  existing: readonly DropExisting[] = [],
  options: DropOptions = {},
): DropPlan {
  const entries = Array.isArray(items) ? items : [];
  const settings = readOptions(options);
  const library = indexLibrary(existing);
  const accepted: DropAccepted[] = [];
  const rejected: DropRejected[] = [];
  const duplicates: DropDuplicate[] = [];
  /** Files this same drop has already accepted, keyed the way the library is. */
  const added = new Map<string, DropExisting>();

  let requestedFiles = 0;
  let acceptedBytes = 0;
  let overFiles = 0;
  let overBytes = 0;

  /**
   * Plans one file through every rule, in the order the sentences promise: format, then
   * duplicate, then the hard size limit, then the two caps that depend on what came before.
   */
  function planFile(name: string, path: string, size: number): void {
    requestedFiles += 1;

    const extension = extensionOf(name);

    if (settings.formats.length === 0) {
      reject(name, path, 'unsupported-format', noFormatsReason());
      return;
    }

    if (extension === '') {
      reject(name, path, 'unsupported-format', noExtensionReason(settings.formats));
      return;
    }

    if (!settings.formats.includes(extension)) {
      reject(name, path, 'unsupported-format', unsupportedReason(extension, settings.formats));
      return;
    }

    const key = duplicateKey(name, size);

    const held = library.get(key);
    if (held !== undefined) {
      duplicates.push({ name, path, match: 'library', existing: { name: held.name, size: held.size } });
      reject(name, path, 'duplicate', libraryDuplicateReason(held.name, size));
      return;
    }

    const queued = added.get(key);
    if (queued !== undefined) {
      duplicates.push({ name, path, match: 'drop', existing: { name: queued.name, size: queued.size } });
      reject(name, path, 'duplicate', dropDuplicateReason(queued.name, size));
      return;
    }

    // One file past the whole budget can never be made room for, so it is refused as too
    // large rather than as an overflow the reader could fix by dropping less.
    if (size > settings.maxBytes) {
      reject(name, path, 'too-large', tooLargeReason(size, settings.maxBytes));
      return;
    }

    if (accepted.length >= settings.maxFiles) {
      overFiles += 1;
      reject(name, path, 'over-max-files', overFilesReason(settings.maxFiles));
      return;
    }

    if (acceptedBytes + size > settings.maxBytes) {
      overBytes += 1;
      reject(name, path, 'over-max-bytes', overBytesReason(size, settings.maxBytes, acceptedBytes));
      return;
    }

    accepted.push({ name, path, reason: acceptedReason(extension) });
    acceptedBytes += size;
    added.set(key, { name, size });
  }

  /** Records one refusal, keeping the caller's name and path for the caller to act on. */
  function reject(name: string, path: string, code: DropRejectionCode, reason: string): void {
    rejected.push({ name, path, code, reason });
  }

  for (const raw of entries) {
    const item = readItem(raw);
    if (item === null) continue;

    if (item.kind === 'folder') {
      // The folder's listed contents take the folder's place in the drop, in name order,
      // then the folder itself is deferred: the plan never claims a directory is complete.
      const contents = [...item.contents].sort(compareContents);
      for (const child of contents) planFile(child.name, child.path, child.size);
      rejected.push({
        name: item.name,
        path: item.path,
        code: 'folder-needs-scan',
        reason: folderReason(contents.length),
      });
      continue;
    }

    planFile(item.name, item.path, item.size);
  }

  // A drop that carried no files at all — text, an image from another application, or a
  // platform that reported nothing — is worth saying out loud rather than showing empty.
  if (accepted.length === 0 && rejected.length === 0) {
    rejected.push({ name: '', path: '', code: 'empty-drop', reason: EMPTY_DROP_REASON });
  }

  return {
    accepted,
    rejected,
    duplicates,
    overflow: {
      requestedFiles,
      acceptedFiles: accepted.length,
      acceptedBytes,
      overFiles,
      overBytes,
    },
  };
}

// --- Input reading ---------------------------------------------------------

/** An item as the planner needs it, with every optional member resolved. */
interface ReadItem {
  readonly name: string;
  readonly path: string;
  readonly kind: DropKind;
  readonly size: number;
  readonly contents: readonly DropFile[];
}

/**
 * Reads one dropped entry, or null when it cannot be identified.
 *
 * Nothing is trusted: `kind` is a folder only when it says exactly `folder`, a missing
 * path falls back to the name so a caller that only has names still gets a usable plan,
 * and a size that is absent, negative or not a number reads as zero. An entry with no name
 * is skipped outright — it can be neither stored nor shown — which is why a drop of
 * nothing but malformed entries ends as an empty drop.
 */
function readItem(raw: unknown): ReadItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as { name?: unknown; path?: unknown; kind?: unknown; size?: unknown; contents?: unknown };
  const name = readString(value.name);
  if (name.length === 0) return null;
  return {
    name,
    path: readString(value.path) || name,
    kind: value.kind === 'folder' ? 'folder' : 'file',
    size: readSize(value.size),
    contents: readContents(value.contents),
  };
}

/** A string, or an empty string for anything else. */
function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A byte count: a finite, non-negative integer, or zero when the platform did not say. */
function readSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** The files a folder listing carried, each cleaned the same way a dropped file is. */
function readContents(value: unknown): readonly DropFile[] {
  if (!Array.isArray(value)) return [];
  const files: DropFile[] = [];
  for (const row of value) {
    if (typeof row !== 'object' || row === null) continue;
    const entry = row as { name?: unknown; path?: unknown; size?: unknown };
    const name = readString(entry.name);
    if (name.length === 0) continue;
    files.push({
      name,
      path: readString(entry.path) || name,
      size: readSize(entry.size),
    });
  }
  return files;
}

/** Options as the planner needs them, with defaults and clamps applied. */
interface ReadOptions {
  readonly formats: readonly string[];
  readonly maxFiles: number;
  readonly maxBytes: number;
}

/** Resolves the options, keeping "the caller did not say" distinct from "the caller said none". */
function readOptions(options: DropOptions): ReadOptions {
  const value = typeof options === 'object' && options !== null ? options : {};
  return {
    formats: readFormats(value.allowedFormats),
    maxFiles: readLimit(value.maxFiles),
    maxBytes: readLimit(value.maxBytes),
  };
}

/**
 * Normalises the allowed formats to bare lowercase extensions.
 *
 * An absent or non-array value keeps {@link DEFAULT_DROP_FORMATS}; an explicit empty array
 * stays empty, because "this drop allows nothing" is a decision a caller is allowed to make
 * and silently replacing it with the default would accept files the caller refused.
 */
function readFormats(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return DEFAULT_DROP_FORMATS;
  const formats = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalized = entry.trim().replace(/^\.+/u, '').toLowerCase();
    if (normalized.length > 0) formats.add(normalized);
  }
  return [...formats];
}

/** A cap as a whole non-negative number; anything unusable means no cap. */
function readLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NO_LIMIT;
  return Math.max(0, Math.floor(value));
}

/** The library keyed by name and size, first row winning when the library already repeats itself. */
function indexLibrary(existing: unknown): ReadonlyMap<string, DropExisting> {
  const index = new Map<string, DropExisting>();
  if (!Array.isArray(existing)) return index;
  for (const row of existing) {
    if (typeof row !== 'object' || row === null) continue;
    const value = row as { name?: unknown; size?: unknown };
    const name = readString(value.name);
    if (name.trim().length === 0) continue;
    // A duplicate needs both halves. A row whose size is unknown cannot be compared
    // meaningfully, so it is left out rather than matched against a guessed zero.
    if (typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size < 0) continue;
    const size = Math.floor(value.size);
    const key = duplicateKey(name, size);
    if (!index.has(key)) index.set(key, { name, size });
  }
  return index;
}

// --- Names and keys --------------------------------------------------------

/**
 * The lowercase extension of a file name, or an empty string when it has none.
 *
 * A leading dot marks a hidden file (`.gitignore`), not an extension, and a trailing dot
 * is not one either. Windows separators are handled too, because a desktop drop reports
 * paths rather than names on some platforms.
 */
function extensionOf(name: string): string {
  const base = name.split(/[\\/]/u).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * The identity duplicate detection compares: folded name plus exact size.
 *
 * The name is trimmed and lowercased, which is the documented case-insensitivity; the size
 * is exact, so a revised file of the same name is a different document. The separator is a
 * NUL, which no file name can contain, so two different pairs can never share a key.
 */
function duplicateKey(name: string, size: number): string {
  return `${name.trim().toLowerCase()}${KEY_SEPARATOR}${size}`;
}

/** Orders a folder's listed contents by name, then path and size, all by code unit. */
function compareContents(left: DropFile, right: DropFile): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  if (left.size !== right.size) return left.size - right.size;
  return 0;
}

// --- Sentences -------------------------------------------------------------

/** Why a file was accepted: the format is allowed and both caps still had room. */
function acceptedReason(extension: string): string {
  return `The .${extension} format is allowed and the drop has room for this file.`;
}

/** Why a file with no extension cannot be checked against the list. */
function noExtensionReason(formats: readonly string[]): string {
  return `The file name has no extension, so its format cannot be checked against ${formatList(formats)}.`;
}

/** Why a file's extension is not one the drop takes. */
function unsupportedReason(extension: string, formats: readonly string[]): string {
  return `The file ends in ".${extension}", which this drop does not take: it accepts ${formatList(formats)}.`;
}

/** Why a drop that allows no format refuses everything. */
function noFormatsReason(): string {
  return 'This drop allows no file format, so no file in it can be accepted.';
}

/** Why one file is larger than the whole budget. */
function tooLargeReason(size: number, maxBytes: number): string {
  return `The file is ${formatBytes(size)}, larger than the whole ${formatBytes(maxBytes)} budget for this drop, so no smaller drop could make room for it.`;
}

/** Why a file duplicates a library entry, naming the entry so a UI can offer to open it. */
function libraryDuplicateReason(name: string, size: number): string {
  return `The library already holds "${name}" at the same size (${formatBytes(size)}), so this file would be a second copy.`;
}

/** Why a file duplicates an earlier one in the same drop. */
function dropDuplicateReason(name: string, size: number): string {
  return `This drop already holds "${name}" at the same size (${formatBytes(size)}).`;
}

/** Why a folder is deferred rather than planned, and what happened to what it listed. */
function folderReason(listed: number): string {
  if (listed === 0) {
    return 'A folder needs a scan before it can be added: this decision never reads the disk, so the caller reads the folder and plans what it holds in a second pass.';
  }
  return `A folder needs a scan before it is complete: the ${fileCount(listed)} it listed here are planned in name order, and the scan finds the rest, including subfolders.`;
}

/** Why the file cap refused a file. */
function overFilesReason(maxFiles: number): string {
  return `The drop already holds its limit of ${fileCount(maxFiles)}, so this file was left out.`;
}

/** Why the byte cap refused a file that a smaller drop could have taken. */
function overBytesReason(size: number, maxBytes: number, acceptedBytes: number): string {
  return `Adding this ${formatBytes(size)} file would pass the ${formatBytes(maxBytes)} budget, with ${formatBytes(acceptedBytes)} already accepted.`;
}

/** Why a drop carried nothing plannable. */
const EMPTY_DROP_REASON =
  'Nothing was dropped, so there is no file to plan: a drop from another application can carry text or an image without a file.';

// --- Formatting ------------------------------------------------------------

/** A count of files, with the plural a sentence needs. */
function fileCount(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

/**
 * An extension list a person reads: `.pdf`, or `.pdf and .png`, or `.pdf, .png and .jpg`.
 *
 * Built here rather than with `Intl.ListFormat`, because the plan must not depend on a
 * locale: the same drop always produces the same sentence.
 */
function formatList(formats: readonly string[]): string {
  const labels = formats.map(format => `.${format}`);
  if (labels.length === 0) return 'no format';
  if (labels.length === 1) return labels[0] ?? '';
  const head = labels.slice(0, -1);
  const last = labels[labels.length - 1] ?? '';
  return `${head.join(', ')} and ${last}`;
}

/**
 * A byte count a person can read at a glance.
 *
 * Adaptive for the same reason `export-check.ts` formats its cap adaptively: a budget in
 * the hundreds of bytes should still read as a size a person recognises, not "0.0 MB".
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}
