/**
 * Section outline and table of contents (backlog item E05).
 *
 * `blocks.ts` decides what each block *is*; this module assembles the blocks it typed
 * as `heading` into a section tree plus the flat table of contents a reader panel
 * renders. A section records the first block *inside* it rather than its own heading,
 * so a click on a TOC entry lands on the paragraph after the title instead of on the
 * title the reader is already looking at.
 *
 * Contract:
 * - Pure and deterministic: no clock, no randomness, no DOM, no locale. The same
 *   blocks always produce the same sections, paths and report list.
 * - The input is taken in the order given and that order *is* reading order, the same
 *   order `classifyBlocks` returns. Geometry is not consulted here, so the caller is
 *   responsible for not handing over a shuffled list.
 * - A heading of level n closes every open section whose level is at least n, so
 *   `1, 2, 2, 1` nests the two level-2 headings under the first level-1 heading and
 *   starts a second top-level branch for the last one.
 * - A level jump is clamped, not trusted: a level-3 heading under a level-1 heading
 *   becomes level 2, and the requested and applied levels are recorded in
 *   {@link Outline.reports} as a `level-jump`. At the top of the document the implicit
 *   parent is level 0, so a level-2 or level-3 first heading becomes level 1.
 * - Content before the first heading becomes one synthetic section whose id is
 *   {@link UNTITLED_SECTION_ID}, whose `title` is the empty string (the reader supplies
 *   its own label for an untitled section) and whose level is {@link UNTITLED_LEVEL}.
 *   It sits with the top-level sections and never adopts a heading as a child. A
 *   document with no headings at all is therefore exactly one untitled section.
 * - Section ids are `outline-h1`, `outline-h2`, … in heading order, or
 *   {@link UNTITLED_SECTION_ID}. They depend on neither the block ids nor the page
 *   numbers, so they stay stable when a caller renumbers pages.
 * - `blockId` is an input block id, or {@link SYNTHETIC_BLOCK_ID_PREFIX} plus the
 *   block's input position when the caller supplied none; the reader needs a handle
 *   for a block it never gave an id to.
 * - An empty or missing block list produces an empty outline: no sections, no entries,
 *   no reports, no members. A position outside every section resolves via
 *   {@link sectionAt}'s page fallback instead of inventing a section.
 */

import { MAX_HEADING_LEVEL, type SemanticBlockType } from './blocks';

/** Id of the synthetic section that owns content before the first heading. */
export const UNTITLED_SECTION_ID = 'outline-untitled';

/** Level of the synthetic untitled root: above level 1, because it is not a heading. */
export const UNTITLED_LEVEL = 0;

/** Section ids for headings are this prefix plus the 1-based heading number. */
export const SECTION_ID_PREFIX = 'outline-h';

/** Prefix of the block ids the outline invents for input blocks that carry none. */
export const SYNTHETIC_BLOCK_ID_PREFIX = 'outline-b';

/** A block as this module needs it: the fields `classifyBlocks` returns for E05. */
export interface OutlineBlockInput {
  /** Reader block id (for example `p3-r0`); a block without one gets a synthetic id. */
  id?: string;
  /** 1-based page number; blocks without one are treated as page 1. */
  page?: number;
  text: string;
  /** Semantic type from `blocks.ts`; only `heading` opens a section. */
  type: SemanticBlockType;
  /** 1..3 for headings, from `blocks.ts`; a heading without one is read as level 1. */
  headingLevel?: number;
}

/** One section of the document tree. */
export interface Section {
  /** {@link UNTITLED_SECTION_ID}, or {@link SECTION_ID_PREFIX} plus the heading number. */
  id: string;
  /** Folded heading text; the empty string for the untitled root. */
  title: string;
  /** Applied heading level 1..3, or {@link UNTITLED_LEVEL} for the untitled root. */
  level: number;
  /** 1-based page the section starts on. */
  page: number;
  /**
   * First block inside the section, i.e. the jump target: the block after the heading,
   * or the heading itself when the section holds nothing else.
   */
  blockId: string;
  /** Nested sections, in reading order; empty when the section has none. */
  children: Section[];
}

/** One row of the flat table of contents. */
export interface TocEntry {
  /** Id of the section this entry describes. */
  id: string;
  title: string;
  level: number;
  page: number;
  blockId: string;
  /** Nesting depth in the tree: 0 for a root section, 1 for its children, and so on. */
  depth: number;
  /** Sibling numbering such as `3.2.1`; empty for the untitled root. */
  path: string;
}

export type OutlineReportCode = 'level-jump' | 'untitled-root';

/** One machine-readable note about how the outline had to repair the input. */
export interface OutlineReport {
  code: OutlineReportCode;
  /** Id of the block that produced the report: the heading, or the first preamble block. */
  blockId: string;
  page: number;
  /** Level the classifier asked for; only set on `level-jump`. */
  requestedLevel?: number;
  /** Level the outline applied instead; only set on `level-jump`. */
  appliedLevel?: number;
}

/** A block and the section it belongs to. */
export interface OutlineMember {
  blockId: string;
  page: number;
  sectionId: string;
}

export interface Outline {
  /** Top-level sections in reading order: the untitled root, if any, then the headings. */
  sections: Section[];
  /** Pre-order flattened sections; the same rows a TOC panel renders. */
  toc: TocEntry[];
  /** Repairs applied to the input, in reading order; empty when the input needed none. */
  reports: OutlineReport[];
  /** Every input block with its section; {@link sectionAt} resolves against this list. */
  members: OutlineMember[];
}

/** A section being built, plus the state needed to fill its jump target afterwards. */
interface OpenSection {
  section: Section;
  /** Applied level, used for the close-on-level rule. */
  level: number;
  /** First non-heading block that landed in this section. */
  firstContentId: string | null;
  /** The heading that opened it; null for the untitled root. */
  headingBlockId: string | null;
}

/** An input block after defaults are applied. */
interface ReadBlock {
  id: string;
  page: number;
  text: string;
  isHeading: boolean;
  /** Requested heading level, normalised into 1..{@link MAX_HEADING_LEVEL}. */
  level: number;
}

/**
 * Builds the section tree and its table of contents from classified blocks.
 *
 * Walks the blocks once in reading order, keeps a stack of open sections and pushes
 * each heading onto the deepest section it can legally nest under. Content blocks are
 * attached to the innermost open section, and the preamble — everything before the
 * first heading — is attached to the synthetic untitled root.
 *
 * The returned outline is a new structure; the input array and its blocks are only
 * read. See the module contract for the close-on-level, clamping and id rules.
 */
export function buildOutline(blocks: readonly OutlineBlockInput[]): Outline {
  const items = Array.isArray(blocks) ? blocks : [];
  const roots: Section[] = [];
  const reports: OutlineReport[] = [];
  const members: OutlineMember[] = [];
  const open: OpenSection[] = [];

  const stack: OpenSection[] = [];
  let untitled: OpenSection | null = null;
  let current: OpenSection | null = null;
  let headingCount = 0;

  items.forEach((block, index) => {
    const read = readBlock(block, index);

    if (read.isHeading) {
      // Close every section at or below the requested level: levels only restart a
      // branch, they never continue an older deeper one.
      while (stack.length > 0 && levelOfTop(stack) >= read.level) stack.pop();
      const parent = stack[stack.length - 1] ?? null;
      const applied = Math.min(read.level, (parent?.level ?? 0) + 1);

      if (applied !== read.level) {
        reports.push({
          code: 'level-jump',
          blockId: read.id,
          page: read.page,
          requestedLevel: read.level,
          appliedLevel: applied,
        });
      }

      headingCount += 1;
      const section: Section = {
        id: `${SECTION_ID_PREFIX}${headingCount}`,
        title: foldText(read.text),
        level: applied,
        page: read.page,
        // Filled by `resolveBlockIds`; the heading is the fallback, not the target.
        blockId: read.id,
        children: [],
      };
      const created: OpenSection = {
        section,
        level: applied,
        firstContentId: null,
        headingBlockId: read.id,
      };

      // `parent` is null exactly when the heading starts a new top-level branch.
      (parent ? parent.section.children : roots).push(section);
      stack.push(created);
      open.push(created);
      current = created;
      members.push({ blockId: read.id, page: read.page, sectionId: section.id });
      return;
    }

    if (!current) {
      // Content before the first heading: one untitled root for the whole preamble.
      if (!untitled) {
        const section: Section = {
          id: UNTITLED_SECTION_ID,
          title: '',
          level: UNTITLED_LEVEL,
          page: read.page,
          blockId: read.id,
          children: [],
        };
        untitled = {
          section,
          level: UNTITLED_LEVEL,
          firstContentId: null,
          headingBlockId: null,
        };
        roots.push(section);
        open.push(untitled);
        reports.push({ code: 'untitled-root', blockId: read.id, page: read.page });
      }
      current = untitled;
    }

    current.firstContentId ??= read.id;
    members.push({ blockId: read.id, page: read.page, sectionId: current.section.id });
  });

  resolveBlockIds(open);
  return { sections: roots, toc: flattenSections(roots), reports, members };
}

/**
 * Flattens the tree into table-of-contents rows, in pre-order.
 *
 * `depth` counts tree levels from 0. `path` is the sibling numbering joined with dots —
 * `1`, `1.2`, `1.2.3` — so a reader can show section numbers; the untitled root has no
 * number and reports the empty path, and its children (if a caller builds such a tree
 * by hand) number from 1.
 */
export function flattenOutline(outline: Outline): TocEntry[] {
  const sections = Array.isArray(outline?.sections) ? outline.sections : [];
  return flattenSections(sections);
}

/**
 * Returns the section a position belongs to, or null when the outline is empty.
 *
 * Resolution order: the section recorded for `blockId` (a table cell or any block the
 * outline walked), then the last section that starts on or before `page`. A block id
 * the outline never saw is therefore still placed on the page it is read on instead of
 * being dropped. A page that is not a finite number is read as page 1. When the page
 * precedes every section, the first section is returned, so a reader always has a
 * current section to highlight.
 */
export function sectionAt(outline: Outline, page: number, blockId: string): Section | null {
  const sections = Array.isArray(outline?.sections) ? outline.sections : [];
  if (sections.length === 0) return null;

  const byId = indexSections(sections);
  const members = Array.isArray(outline?.members) ? outline.members : [];
  const wanted = typeof blockId === 'string' ? blockId : '';
  if (wanted.length > 0) {
    const member = members.find(entry => entry?.blockId === wanted);
    const owned = member ? byId.get(member.sectionId) : undefined;
    if (owned) return owned;
  }

  const toc = Array.isArray(outline?.toc) && outline.toc.length > 0
    ? outline.toc
    : flattenSections(sections);
  const target = finiteOr(page, 1);

  let candidate: Section | null = null;
  for (const entry of toc) {
    if (!entry || !Number.isFinite(entry.page) || entry.page > target) continue;
    candidate = byId.get(entry.id) ?? candidate;
  }
  if (candidate) return candidate;

  const first = toc[0];
  const fallback = first ? byId.get(first.id) : undefined;
  return fallback ?? sections[0] ?? null;
}

// --- Building -------------------------------------------------------------

/**
 * Fills every section's jump target: the block after its heading, or, for a section
 * that holds no content of its own, the first target of its first child, or finally
 * the heading itself. Children are resolved first so a parent can borrow theirs.
 */
function resolveBlockIds(open: readonly OpenSection[]): void {
  const byId = new Map<string, OpenSection>();
  const childIds = new Set<string>();
  for (const entry of open) {
    byId.set(entry.section.id, entry);
    for (const child of entry.section.children) childIds.add(child.id);
  }

  const resolve = (entry: OpenSection): void => {
    for (const child of entry.section.children) {
      const childOpen = byId.get(child.id);
      if (childOpen) resolve(childOpen);
    }
    const firstChild = entry.section.children[0];
    entry.section.blockId =
      entry.firstContentId ?? firstChild?.blockId ?? entry.headingBlockId ?? entry.section.blockId;
  };

  // Every non-root section is visited through its parent, so walking the roots reaches
  // the whole tree exactly once.
  for (const entry of open) {
    if (!childIds.has(entry.section.id)) resolve(entry);
  }
}

function flattenSections(sections: readonly Section[]): TocEntry[] {
  const entries: TocEntry[] = [];

  const visit = (siblings: readonly Section[], depth: number, parentPath: string): void => {
    let numbered = 0;
    for (const section of siblings) {
      if (!section || typeof section !== 'object') continue;

      let path = '';
      if (section.level > UNTITLED_LEVEL) {
        numbered += 1;
        path = parentPath.length > 0 ? `${parentPath}.${numbered}` : String(numbered);
      }

      entries.push({
        id: section.id,
        title: typeof section.title === 'string' ? section.title : '',
        level: section.level,
        page: section.page,
        blockId: section.blockId,
        depth,
        path,
      });

      const children = Array.isArray(section.children) ? section.children : [];
      visit(children, depth + 1, path);
    }
  };

  visit(sections, 0, '');
  return entries;
}

function indexSections(sections: readonly Section[]): Map<string, Section> {
  const byId = new Map<string, Section>();
  const visit = (siblings: readonly Section[]): void => {
    for (const section of siblings) {
      if (!section || typeof section !== 'object') continue;
      byId.set(section.id, section);
      visit(Array.isArray(section.children) ? section.children : []);
    }
  };
  visit(sections);
  return byId;
}

function readBlock(block: OutlineBlockInput, index: number): ReadBlock {
  const page = block?.page;
  const id = block?.id;
  const isHeading = block?.type === 'heading';
  return {
    id: typeof id === 'string' && id.length > 0 ? id : `${SYNTHETIC_BLOCK_ID_PREFIX}${index}`,
    page: typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : 1,
    text: typeof block?.text === 'string' ? block.text : '',
    isHeading,
    level: isHeading ? headingLevelOf(block?.headingLevel) : 1,
  };
}

/**
 * Reads a heading level: a fractional value is rounded, a missing one is 1 (a heading
 * with no level is safer at the top than buried), and anything past the deepest level
 * `blocks.ts` emits is capped rather than rejected.
 */
function headingLevelOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.min(MAX_HEADING_LEVEL, Math.max(1, Math.round(value)));
}

function levelOfTop(stack: readonly OpenSection[]): number {
  const top = stack[stack.length - 1];
  return top ? top.level : UNTITLED_LEVEL;
}

function foldText(text: string): string {
  return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
