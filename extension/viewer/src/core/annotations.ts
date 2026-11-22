/**
 * Bookmarks, notes and highlights anchored to the Document IR (backlog H04 + J05).
 *
 * A reader's annotations must outlive the block list they were made on. This module
 * owns that: a store keyed by document, an anchor that names a page and optionally one
 * IR block (`p{page}-r{rank}` from `ir.ts`), and a re-anchoring pass that runs after the
 * document is parsed again.
 *
 * Contract:
 * - An anchor is a page plus, optionally, a block id and a selection rect. When the
 *   store holds the document, `add` and `update` validate the anchor against it; when it
 *   does not, only the shape is checked, because there is nothing to check against and
 *   guessing would be worse than admitting it. `orphanOk` keeps an annotation whose
 *   anchor cannot be resolved, marked `orphaned: true`, instead of refusing it.
 * - `createdAt` is written once and never changes; `updatedAt` moves with every update.
 *   The clock is injected so tests and replays are deterministic; the store never reads
 *   the clock itself.
 * - `quote` is the anchored block's text as it read when the anchor was last confirmed.
 *   It is a snapshot, not a live reference: it is what lets `reanchor` find the block
 *   again after a re-parse renumbered the ids, and it is what a Markdown export quotes.
 * - `reanchor` resolves in three passes and never deletes: block id first (confirmed by
 *   the quoted text), then the best similar text on the same page, then a block whose
 *   text matches the quote exactly and appears only once in the new document (which
 *   rescues an annotation when a page was inserted). Anything still unresolved comes
 *   back with `orphaned: true` and its old anchor kept, for the reader to review.
 * - Ordering is always deterministic: document id, page, the top edge of the rect, its
 *   left edge, then id. An annotation without a rect sorts after the ones with one.
 * - Exports are schema-versioned canonical JSON. An import is all-or-nothing and refuses
 *   an id that is already in the store or repeated inside the document.
 * - Pure data otherwise: no DOM, no network, no locale, no clock beyond the injected one.
 */

import { POLYGON_BOUNDS_TOLERANCE, type Block, type DocumentIR } from './ir';
import { matchKey, scoreSimilarity } from './tm';
import type { Rect } from './types';

// --- Public shape ----------------------------------------------------------

/** What a reader left on the page. */
export type AnnotationKind = 'bookmark' | 'note' | 'highlight';

export const ANNOTATION_KINDS: readonly AnnotationKind[] = ['bookmark', 'note', 'highlight'];

/** Schema version written by `exportJson` and the only version `importJson` reads. */
export const ANNOTATIONS_SCHEMA_VERSION = 1;

/**
 * Lowest word-trigram similarity, from `tm.ts`, at which `reanchor` accepts a block as
 * the one a note quoted. Below it the block is not considered a match.
 */
export const REANCHOR_MIN_SIMILARITY = 0.6;

/** One bookmark, note or highlight. */
export interface Annotation {
  /** Store-unique id; `a{n}` when the store assigned it. */
  id: string;
  /** Id of the document the anchor was made in. */
  documentId: string;
  /** 1-based page the annotation is shown on. */
  page: number;
  /** Id of the block the annotation is anchored to, when it has one. */
  blockId?: string;
  /** Selection on the page, in points; its top edge is what the list orders by. */
  rect?: Rect;
  /** The reader's own words: a note body, a bookmark label, a highlight caption. */
  text: string;
  kind: AnnotationKind;
  /** Highlight colour, stored verbatim: a CSS colour or a palette token. */
  color?: string;
  /** Text of the anchored block as it read when the anchor was last confirmed. */
  quote?: string;
  /** Written once, when the annotation is created; never rewritten. */
  createdAt: string;
  /** Rewritten on every update, from the store clock. */
  updatedAt: string;
  /** True when the anchor could not be resolved against the document. */
  orphaned: boolean;
}

/** What `add` needs. The store assigns the id, the timestamps and the quote. */
export interface AddAnnotationInput {
  documentId: string;
  page: number;
  blockId?: string;
  rect?: Rect;
  /** Trimmed on the way in; inner whitespace is kept. */
  text: string;
  kind: AnnotationKind;
  color?: string;
}

/**
 * Alias for callers that also import the IR's own `Annotation` from `ir.ts`; the two
 * shapes are different records, and a reader annotation is the one this module stores.
 */
export type ReaderAnnotation = Annotation;

/** Options shared by the operations that resolve an anchor. */
export interface AnchorOptions {
  /** Keep the annotation even when its anchor cannot be resolved. */
  orphanOk?: boolean;
}

export interface AddAnnotationOptions extends AnchorOptions {
  /** Store under this id instead of the assigned `a{n}`; refuses an id in use. */
  id?: string;
}

/**
 * Fields `update` may change. `id`, `documentId` and `createdAt` are absent on purpose:
 * the store refuses them at runtime too, so a spread of a whole annotation cannot
 * silently rewrite its history. An `undefined` value clears an optional field.
 */
export interface AnnotationPatch {
  page?: number;
  blockId?: string | undefined;
  rect?: Rect | undefined;
  text?: string;
  kind?: AnnotationKind;
  color?: string | undefined;
  quote?: string | undefined;
  orphaned?: boolean;
}

export interface ListAnnotationsOptions {
  /** Keep only this kind, or these kinds; omitted means every kind. */
  kind?: AnnotationKind | readonly AnnotationKind[];
}

export interface BacklinkOptions {
  /** Only annotations of this document; omitted means every document. */
  documentId?: string;
}

export interface AnnotationStoreOptions {
  /** Documents the store can validate anchors against. More can be added later. */
  documents?: readonly DocumentIR[];
  /**
   * Clock for `createdAt` and `updatedAt`, returning an ISO-8601 string. Defaults to the
   * system clock, which is why it is injectable: tests and replays pass a fixed one.
   */
  now?: () => string;
}

/** What an import added, and how many annotations the store holds afterwards. */
export interface AnnotationImportResult {
  imported: number;
  total: number;
}

// --- Errors ----------------------------------------------------------------

export type AnnotationErrorCode =
  | 'invalid-field'
  | 'invalid-rect'
  | 'rect-out-of-bounds'
  | 'unknown-page'
  | 'unknown-block'
  | 'anchor-page-mismatch'
  | 'duplicate-id'
  | 'unknown-id'
  | 'immutable-field'
  | 'malformed-json'
  | 'malformed-export'
  | 'unsupported-schema-version';

/**
 * A refused annotation operation. `code` is the machine-readable reason and `path` names
 * the field that failed, for example `annotations[2].rect.x`.
 */
export class AnnotationError extends Error {
  readonly code: AnnotationErrorCode;
  readonly path: string;

  constructor(code: AnnotationErrorCode, message: string, path = '') {
    super(path ? `${path}: ${message}` : message);
    this.name = 'AnnotationError';
    this.code = code;
    this.path = path;
  }
}

// --- Store -----------------------------------------------------------------

/**
 * In-memory annotation store for one or more documents.
 *
 * Annotations are kept in insertion order internally and always returned in the
 * documented order — document, page, rect top, rect left, id — so two stores holding
 * the same set produce the same list and the same export. Returned objects are copies:
 * mutating one does not change the store, and a stored annotation is only changed
 * through `update` or `reanchor`.
 */
export class AnnotationStore {
  private readonly records: Annotation[] = [];
  private readonly byId = new Map<string, Annotation>();
  private readonly irByDocument = new Map<string, DocumentIR>();
  private readonly clock: () => string;
  private sequence = 0;

  constructor(options: AnnotationStoreOptions = {}) {
    const settings: AnnotationStoreOptions = typeof options === 'object' && options !== null ? options : {};
    this.clock = typeof settings.now === 'function' ? settings.now : SYSTEM_CLOCK;
    for (const ir of Array.isArray(settings.documents) ? settings.documents : []) this.register(ir);
  }

  /**
   * Makes a document available for anchor validation. Registering the same document id
   * again replaces the document: a re-parse is the caller's cue to register the new IR.
   */
  register(ir: DocumentIR): void {
    if (typeof ir !== 'object' || ir === null) {
      throw new AnnotationError('invalid-field', 'register needs a Document IR.', 'ir');
    }
    this.irByDocument.set(requireText(ir.documentId, 'documentId'), ir);
  }

  /**
   * Stores one annotation and returns a copy of it.
   *
   * The anchor is checked against the document when the store holds it: a block id that
   * does not exist, a block that sits on another page, a page the document does not
   * have, or a rect outside its page is refused with an `AnnotationError` unless
   * `orphanOk` is set, in which case the annotation is kept with `orphaned: true`. A
   * document the store does not hold is not validated beyond the shape of the fields.
   *
   * The annotation's `quote` is the anchored block's text at this moment; a page-only
   * annotation has none.
   */
  add(input: AddAnnotationInput, options: AddAnnotationOptions = {}): Annotation {
    if (typeof input !== 'object' || input === null) {
      throw new AnnotationError('invalid-field', 'add needs an annotation object.', 'annotation');
    }
    const documentId = requireText(input.documentId, 'documentId');
    const page = requirePage(input.page, 'page');
    const kind = requireKind(input.kind, 'kind');
    const text = requireText(input.text, 'text');
    const blockId = optionalText(input.blockId, 'blockId');
    const color = optionalText(input.color, 'color');
    const rect = input.rect === undefined || input.rect === null ? undefined : readRect(input.rect, 'rect');
    const orphanOk = options?.orphanOk === true;

    const id = options?.id === undefined ? this.nextId() : requireText(options.id, 'id');
    if (this.byId.has(id)) {
      throw new AnnotationError('duplicate-id', `id "${id}" is already in the annotation store.`, 'id');
    }

    const resolution = this.resolve(documentId, page, blockId, rect);
    if (resolution.problem !== undefined && !orphanOk) throw resolutionError(resolution.problem);

    const stamp = this.stamp();
    const annotation: Annotation = {
      id,
      documentId,
      page,
      kind,
      text,
      createdAt: stamp,
      updatedAt: stamp,
      orphaned: resolution.problem !== undefined,
    };
    if (blockId !== undefined) annotation.blockId = blockId;
    if (rect !== undefined) annotation.rect = rect;
    if (color !== undefined) annotation.color = color;
    if (resolution.quote !== undefined) annotation.quote = resolution.quote;

    this.records.push(annotation);
    this.byId.set(id, annotation);
    return clone(annotation);
  }

  /** One annotation by id, or `undefined` when the store does not hold it. */
  get(id: string): Annotation | undefined {
    if (typeof id !== 'string') return undefined;
    const record = this.byId.get(id);
    return record === undefined ? undefined : clone(record);
  }

  /**
   * Every annotation of one document, in page order and then top to bottom.
   *
   * `kind` keeps one kind or a set of them; an empty list therefore matches nothing.
   * An unknown document id returns an empty list, not an error.
   */
  list(documentId: string, options: ListAnnotationsOptions = {}): Annotation[] {
    const document = requireText(documentId, 'documentId');
    const kinds = readKindFilter(options?.kind);
    const matching = this.records.filter(
      annotation => annotation.documentId === document && (kinds === undefined || kinds.has(annotation.kind)),
    );
    return matching.sort(compareAnnotations).map(clone);
  }

  /**
   * Changes the given fields of one annotation and returns a copy of the new state.
   *
   * `createdAt`, `id` and `documentId` are immutable, and a patch that carries one of
   * them is refused instead of ignored. `updatedAt` always moves to the store clock. An
   * empty patch only refreshes `updatedAt`.
   *
   * Changing `page`, `blockId` or `rect` re-resolves the anchor, exactly as `add` does:
   * a new anchor that cannot be resolved is refused unless `orphanOk` is set, the quote
   * is refreshed from the resolved block, and a quote supplied in the same patch is
   * replaced by that block's text.
   */
  update(id: string, patch: AnnotationPatch, options: AnchorOptions = {}): Annotation {
    const key = requireText(id, 'id');
    const current = this.byId.get(key);
    if (current === undefined) {
      throw new AnnotationError('unknown-id', `annotation "${key}" is not in the annotation store.`, 'id');
    }

    const source = patchObject(patch);
    for (const field of ['id', 'documentId', 'createdAt'] as const) {
      if (hasOwn(source, field)) {
        throw new AnnotationError('immutable-field', `${field} is written once and cannot be changed.`, field);
      }
    }

    const next: Annotation = clone(current);
    let anchorChanged = false;

    if (hasOwn(source, 'text')) next.text = requireText(source.text, 'text');
    if (hasOwn(source, 'kind')) next.kind = requireKind(source.kind, 'kind');

    if (hasOwn(source, 'color')) {
      const color = optionalText(source.color, 'color');
      if (color === undefined) delete next.color;
      else next.color = color;
    }

    if (hasOwn(source, 'page')) {
      const page = requirePage(source.page, 'page');
      if (page !== next.page) anchorChanged = true;
      next.page = page;
    }

    if (hasOwn(source, 'blockId')) {
      const blockId = optionalText(source.blockId, 'blockId');
      if (blockId !== next.blockId) anchorChanged = true;
      if (blockId === undefined) delete next.blockId;
      else next.blockId = blockId;
    }

    if (hasOwn(source, 'rect')) {
      const rect = source.rect === undefined || source.rect === null ? undefined : readRect(source.rect, 'rect');
      if (!sameRect(rect, next.rect)) anchorChanged = true;
      if (rect === undefined) delete next.rect;
      else next.rect = rect;
    }

    if (hasOwn(source, 'quote')) {
      if (source.quote === undefined || source.quote === null) delete next.quote;
      else next.quote = readQuote(source.quote, 'quote');
    }

    if (hasOwn(source, 'orphaned') && source.orphaned !== undefined) {
      if (typeof source.orphaned !== 'boolean') {
        throw new AnnotationError('invalid-field', 'orphaned must be a boolean when present.', 'orphaned');
      }
      next.orphaned = source.orphaned;
    }

    if (anchorChanged) {
      const resolution = this.resolve(next.documentId, next.page, next.blockId, next.rect);
      if (resolution.problem !== undefined && options?.orphanOk !== true) throw resolutionError(resolution.problem);
      if (resolution.problem !== undefined) {
        delete next.quote;
        next.orphaned = true;
      } else {
        if (resolution.quote === undefined) delete next.quote;
        else next.quote = resolution.quote;
        next.orphaned = false;
      }
    }

    next.updatedAt = this.stamp();
    const at = this.records.indexOf(current);
    this.records[at] = next;
    this.byId.set(next.id, next);
    return clone(next);
  }

  /**
   * Deletes one annotation. Returns whether it was there; removing an id twice is not an
   * error, so a caller can retry a delete it is not sure about.
   */
  remove(id: string): boolean {
    if (typeof id !== 'string') {
      throw new AnnotationError('invalid-field', 'remove needs the id of an annotation.', 'id');
    }
    const record = this.byId.get(id.trim());
    if (record === undefined) return false;
    this.byId.delete(record.id);
    const at = this.records.indexOf(record);
    if (at >= 0) this.records.splice(at, 1);
    return true;
  }

  /**
   * Annotations that name one block, including ones whose anchor is orphaned: an
   * orphaned annotation still records what it was attached to, and a caller showing
   * backlinks can filter on `orphaned` when that matters.
   */
  backlinks(blockId: string, options: BacklinkOptions = {}): Annotation[] {
    const target = requireText(blockId, 'blockId');
    const document = options?.documentId === undefined ? undefined : requireText(options.documentId, 'documentId');
    const matching = this.records.filter(
      annotation => annotation.blockId === target && (document === undefined || annotation.documentId === document),
    );
    return matching.sort(compareAnnotations).map(clone);
  }

  /** Annotations of one page, ordered by the top edge of their rect, top first. */
  forPage(documentId: string, page: number): Annotation[] {
    const document = requireText(documentId, 'documentId');
    const number = requirePage(page, 'page');
    const matching = this.records.filter(annotation => annotation.documentId === document && annotation.page === number);
    return matching.sort(compareAnnotations).map(clone);
  }

  /**
   * Writes every annotation as canonical JSON: fixed key order, two-space indentation,
   * and a canonical annotation order, so two stores with the same set write identical
   * bytes. Optional fields that are absent are left out rather than written as null.
   */
  exportJson(): string {
    const document = {
      schemaVersion: ANNOTATIONS_SCHEMA_VERSION,
      kind: EXPORT_KIND,
      annotations: [...this.records].sort(compareAnnotations).map(serializeAnnotation),
    };
    return JSON.stringify(document, null, 2);
  }

  /**
   * Merges the annotations of an export. Everything is validated before anything is
   * inserted, so a refused import leaves the store exactly as it was; ids that already
   * exist — in the store or repeated inside the import — are refused.
   *
   * Imported anchors are not re-validated against the documents the store happens to
   * hold: an export may come from a session that opened a document this one has not, and
   * a restored note is better kept than dropped. `orphaned` is restored as recorded.
   */
  importJson(json: string): AnnotationImportResult {
    const incoming = readAnnotationsDocument(json);
    const seen = new Set<string>();
    const parsed: Annotation[] = [];

    incoming.forEach((value, index) => {
      const path = `annotations[${index}]`;
      const annotation = readAnnotationRecord(value, path);
      if (seen.has(annotation.id)) {
        throw new AnnotationError('duplicate-id', `id "${annotation.id}" appears more than once in this import.`, `${path}.id`);
      }
      if (this.byId.has(annotation.id)) {
        throw new AnnotationError('duplicate-id', `id "${annotation.id}" is already in the annotation store.`, `${path}.id`);
      }
      seen.add(annotation.id);
      parsed.push(annotation);
    });

    for (const annotation of parsed) {
      this.records.push(annotation);
      this.byId.set(annotation.id, annotation);
    }
    return { imported: parsed.length, total: this.records.length };
  }

  /**
   * Resolves an anchor against the document the store holds, when it holds one.
   *
   * A missing document is not a problem: it is the difference between "this anchor is
   * wrong" and "this store cannot tell". The returned quote is the block's text.
   */
  private resolve(documentId: string, page: number, blockId: string | undefined, rect: Rect | undefined): Resolution {
    const ir = this.irByDocument.get(documentId);
    if (ir === undefined) return {};

    const pages = pageMapOf(ir);
    const size = pages.get(page);
    if (size === undefined && pages.size > 0) {
      return {
        problem: {
          code: 'unknown-page',
          message: `page ${page} is not in document "${documentId}".`,
          path: 'page',
        },
      };
    }

    if (rect !== undefined && size !== undefined && !rectFits(rect, size)) {
      return {
        problem: {
          code: 'rect-out-of-bounds',
          message: `rect (${rect.x}, ${rect.y}, ${rect.width}x${rect.height}) is outside page ${page} (${size.width}x${size.height}).`,
          path: 'rect',
        },
      };
    }

    if (blockId === undefined) return {};
    const block = blockById(ir, blockId);
    if (block === undefined) {
      return {
        problem: {
          code: 'unknown-block',
          message: `block "${blockId}" is not in document "${documentId}".`,
          path: 'blockId',
        },
      };
    }
    if (block.page !== page) {
      return {
        problem: {
          code: 'anchor-page-mismatch',
          message: `block "${blockId}" is on page ${block.page}, not page ${page}.`,
          path: 'page',
        },
      };
    }
    return { quote: blockText(block) };
  }

  /** Assigned id: `a1`, `a2`, … skipping any id already in use. */
  private nextId(): string {
    let candidate = '';
    do {
      this.sequence += 1;
      candidate = `a${this.sequence}`;
    } while (this.byId.has(candidate));
    return candidate;
  }

  /** Reads the clock once, refusing a value that is not an ISO timestamp string. */
  private stamp(): string {
    const value = this.clock();
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new AnnotationError('invalid-field', 'the store clock must return a non-empty ISO-8601 timestamp.', 'now');
    }
    return value.trim();
  }
}

// --- Markdown --------------------------------------------------------------

/**
 * Writes a page-grouped Markdown view of `annotations`, quoting the block each one is
 * attached to.
 *
 * Pages are ordered ascending and, inside a page, top to bottom like `forPage`. When the
 * list spans more than one document the page heading also names the document, because
 * page 3 of one document is not page 3 of another. The quote is a nested blockquote
 * under its bullet; a note's own text is folded onto one line so a bullet never breaks.
 * An empty list produces an empty string.
 *
 * This is an export, not a renderer: no escaping is applied to the reader's own text.
 */
export function toMarkdown(annotations: readonly Annotation[]): string {
  if (!Array.isArray(annotations)) {
    throw new AnnotationError('invalid-field', 'toMarkdown needs an array of annotations.', 'annotations');
  }
  const usable = annotations.filter(
    (annotation): annotation is Annotation =>
      typeof annotation === 'object' && annotation !== null && typeof annotation.page === 'number' && Number.isFinite(annotation.page),
  );
  if (usable.length === 0) return '';

  const ordered = [...usable].sort(compareAnnotations);
  const documents = new Set(ordered.map(annotation => annotation.documentId));
  const lines: string[] = [];
  let lastPage: number | undefined;
  let lastDocument: string | undefined;

  for (const annotation of ordered) {
    const pageChanged = annotation.page !== lastPage;
    const documentChanged = annotation.documentId !== lastDocument;
    if (pageChanged || (documents.size > 1 && documentChanged)) {
      if (lines.length > 0) lines.push('');
      const heading = documents.size > 1
        ? `## ${annotation.documentId} - Page ${annotation.page}`
        : `## Page ${annotation.page}`;
      lines.push(heading, '');
      lastPage = annotation.page;
      lastDocument = annotation.documentId;
    }

    lines.push(bullet(annotation));
    const quote = typeof annotation.quote === 'string' ? annotation.quote.trim() : '';
    if (quote.length > 0) {
      for (const quoteLine of quote.split(/\r\n|\r|\n/u)) {
        lines.push(quoteLine.length > 0 ? `  > ${quoteLine.trimEnd()}` : '  >');
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

/** One Markdown bullet: kind, optional colour, then the reader's text on one line. */
function bullet(annotation: Annotation): string {
  const color = typeof annotation.color === 'string' && annotation.color.trim().length > 0
    ? ` (${annotation.color.trim()})`
    : '';
  const text = foldText(annotation.text);
  return `- **${annotation.kind}**${color}: ${text}`;
}

// --- Re-anchoring ----------------------------------------------------------

/** What happened to one annotation when the document was parsed again. */
export type ReanchorOutcome = 'kept' | 'moved' | 'orphaned';

/**
 * The result of {@link reanchor}. `annotations` holds one copy per input annotation, in
 * input order; `kept`, `moved` and `orphaned` name their ids so a caller can report the
 * outcome without re-reading every record.
 */
export interface ReanchorResult {
  annotations: Annotation[];
  kept: string[];
  moved: string[];
  orphaned: string[];
}

/**
 * Re-points annotations at a re-parsed document.
 *
 * Matching runs in three passes, strongest evidence first:
 *
 * 1. The block id the annotation already names, when the new document still has that id
 *    and its text still matches the quote. The quote is refreshed and the page follows
 *    the block, so an annotation whose block only moved on the page stays attached to it.
 * 2. The most similar block on the annotation's page, using the word-trigram similarity
 *    of `tm.ts` at {@link REANCHOR_MIN_SIMILARITY}. This is the pass that follows a block
 *    whose positional id changed because a paragraph was inserted above it.
 * 3. A block whose text is an exact match and appears exactly once in the new document.
 *    This rescues an annotation whose page number shifted; a header repeated on every
 *    page is not unique and is deliberately not matched.
 *
 * An annotation with no block anchor is kept while its page still exists. Anything left
 * over is not deleted: it keeps its old anchor and quote, comes back with
 * `orphaned: true`, and is listed in `orphaned` so the reader can review it. A note that
 * was already orphaned gets a fresh chance on every pass. The input is not mutated.
 *
 * A malformed document is read as having no blocks or pages rather than thrown on, and a
 * value in `annotations` that is not an object is skipped; run `validate` from `ir.ts`
 * before re-anchoring a document from an untrusted source.
 */
export function reanchor(
  annotations: readonly Annotation[],
  oldIr: DocumentIR,
  newIr: DocumentIR,
): ReanchorResult {
  if (!Array.isArray(annotations)) {
    throw new AnnotationError('invalid-field', 'reanchor needs an array of annotations.', 'annotations');
  }
  const previous = buildReanchorIndex(oldIr);
  const next = buildReanchorIndex(newIr);

  const reanchored: Annotation[] = [];
  const kept: string[] = [];
  const movedIds: string[] = [];
  const orphaned: string[] = [];

  for (const annotation of annotations) {
    if (typeof annotation !== 'object' || annotation === null) continue;
    const outcome = reanchorOne(annotation, previous, next);
    reanchored.push(outcome.annotation);
    if (outcome.outcome === 'kept') kept.push(outcome.annotation.id);
    else if (outcome.outcome === 'moved') movedIds.push(outcome.annotation.id);
    else orphaned.push(outcome.annotation.id);
  }

  return { annotations: reanchored, kept, moved: movedIds, orphaned };
}

interface ReanchorIndex {
  byId: Map<string, Block>;
  byPage: Map<number, Block[]>;
  byKey: Map<string, Block[]>;
  pages: Set<number>;
}

/** Re-anchors one annotation and reports which pass resolved it. */
function reanchorOne(
  annotation: Annotation,
  previous: ReanchorIndex,
  next: ReanchorIndex,
): { annotation: Annotation; outcome: ReanchorOutcome } {
  const result: Annotation = clone(annotation);
  const page = Number.isInteger(result.page) && result.page >= 1 ? result.page : 1;
  result.page = page;

  const blockId = typeof result.blockId === 'string' && result.blockId.length > 0 ? result.blockId : undefined;
  const pageKnown = next.pages.size === 0 || next.pages.has(page);

  if (blockId === undefined) {
    // A page-only bookmark follows its page; there is no text to look a block up by.
    result.orphaned = !pageKnown;
    return { annotation: result, outcome: pageKnown ? 'kept' : 'orphaned' };
  }

  const oldBlock = previous.byId.get(blockId);
  const reference = referenceText(result, oldBlock);
  const same = next.byId.get(blockId);
  const sameScore = same !== undefined && reference.length > 0 ? scoreSimilarity(reference, blockText(same)) : -1;

  if (same !== undefined && (reference.length === 0 || sameScore >= REANCHOR_MIN_SIMILARITY)) {
    result.page = validPage(same.page, page);
    if (blockText(same).length > 0) result.quote = blockText(same);
    result.orphaned = false;
    return { annotation: result, outcome: 'kept' };
  }

  const candidate = bestTextMatch(next.byPage.get(page), reference) ?? uniqueTextMatch(next, reference);
  if (candidate !== undefined) {
    result.blockId = candidate.id;
    result.page = validPage(candidate.page, page);
    if (blockText(candidate).length > 0) result.quote = blockText(candidate);
    result.orphaned = false;
    return { annotation: result, outcome: 'moved' };
  }

  // The id survived but its text did not, or the block is gone entirely: keep what the
  // annotation knew so the reader can still see what the note was about.
  result.orphaned = true;
  return { annotation: result, outcome: 'orphaned' };
}

/** The best block on `blocks` whose similarity to `reference` clears the threshold. */
function bestTextMatch(blocks: readonly Block[] | undefined, reference: string): Block | undefined {
  if (reference.length === 0) return undefined;
  let best: Block | undefined;
  let bestScore = 0;
  for (const block of blocks ?? []) {
    const raw = blockText(block);
    if (raw.length === 0) continue;
    const score = scoreSimilarity(reference, raw);
    if (score < REANCHOR_MIN_SIMILARITY) continue;
    if (best === undefined || score > bestScore) {
      best = block;
      bestScore = score;
    }
  }
  return best;
}

/** A block whose text matches `reference` exactly, when that text is unique. */
function uniqueTextMatch(index: ReanchorIndex, reference: string): Block | undefined {
  if (reference.length === 0) return undefined;
  const bucket = index.byKey.get(matchKey(reference));
  if (bucket === undefined || bucket.length !== 1) return undefined;
  return bucket[0];
}

/** Reads the quote, or the old block's text when the annotation never had one. */
function referenceText(annotation: Annotation, oldBlock: Block | undefined): string {
  if (typeof annotation.quote === 'string' && annotation.quote.trim().length > 0) return annotation.quote;
  const raw = blockText(oldBlock);
  return raw.trim().length > 0 ? raw : '';
}

function buildReanchorIndex(ir: DocumentIR): ReanchorIndex {
  const byId = new Map<string, Block>();
  const byPage = new Map<number, Block[]>();
  const byKey = new Map<string, Block[]>();
  const pages = new Set<number>();

  for (const page of Array.isArray(ir?.pages) ? ir.pages : []) {
    if (page && Number.isInteger(page.index) && page.index >= 1) pages.add(page.index);
  }

  const blocks = [...blocksOf(ir)].sort(compareBlocks);
  for (const block of blocks) {
    if (typeof block.id === 'string' && block.id.length > 0 && !byId.has(block.id)) byId.set(block.id, block);

    const page = Number.isInteger(block.page) && block.page >= 1 ? block.page : 1;
    const onPage = byPage.get(page);
    if (onPage) onPage.push(block);
    else byPage.set(page, [block]);

    const raw = blockText(block).trim();
    if (raw.length > 0) {
      const key = matchKey(raw);
      const bucket = byKey.get(key);
      if (bucket) bucket.push(block);
      else byKey.set(key, [block]);
    }
  }
  return { byId, byPage, byKey, pages };
}

function compareBlocks(left: Block, right: Block): number {
  return (
    finiteOr(left.readingOrder, 0) - finiteOr(right.readingOrder, 0) ||
    finiteOr(left.page, 1) - finiteOr(right.page, 1) ||
    compareText(left.id ?? '', right.id ?? '')
  );
}

// --- JSON ------------------------------------------------------------------

/** Reads and validates an exported annotation document, returning its raw entries. */
function readAnnotationsDocument(json: string): unknown[] {
  if (typeof json !== 'string') {
    throw new AnnotationError('malformed-json', 'importJson needs the JSON text of an exported annotation document.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'the text could not be parsed';
    throw new AnnotationError('malformed-json', `the text is not valid JSON (${detail}).`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AnnotationError('malformed-export', 'an annotation export must be a JSON object.');
  }
  const document = parsed as Record<string, unknown>;
  if (document.schemaVersion !== ANNOTATIONS_SCHEMA_VERSION) {
    throw new AnnotationError(
      'unsupported-schema-version',
      `schemaVersion ${String(document.schemaVersion)} is not supported; this build reads version ${ANNOTATIONS_SCHEMA_VERSION}.`,
      'schemaVersion',
    );
  }
  if (document.kind !== undefined && document.kind !== EXPORT_KIND) {
    throw new AnnotationError('malformed-export', `kind must be "${EXPORT_KIND}" when present.`, 'kind');
  }
  if (!Array.isArray(document.annotations)) {
    throw new AnnotationError('malformed-export', 'annotations must be an array.', 'annotations');
  }
  return document.annotations;
}

/** Reads one annotation of an import, naming the failing field. */
function readAnnotationRecord(value: unknown, prefix: string): Annotation {
  const at = (field: string): string => (prefix ? `${prefix}.${field}` : field);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AnnotationError('malformed-export', 'an annotation must be a JSON object.', prefix || 'annotation');
  }
  const record = value as Record<string, unknown>;
  const annotation: Annotation = {
    id: requireText(record.id, at('id')),
    documentId: requireText(record.documentId, at('documentId')),
    page: requirePage(record.page, at('page')),
    kind: requireKind(record.kind, at('kind')),
    text: requireText(record.text, at('text')),
    createdAt: requireText(record.createdAt, at('createdAt')),
    updatedAt: requireText(record.updatedAt, at('updatedAt')),
    orphaned: readOrphaned(record.orphaned, at('orphaned')),
  };
  if (record.blockId !== undefined) annotation.blockId = requireText(record.blockId, at('blockId'));
  if (record.rect !== undefined) annotation.rect = readRect(record.rect, at('rect'));
  if (record.color !== undefined) annotation.color = requireText(record.color, at('color'));
  if (record.quote !== undefined) annotation.quote = readQuote(record.quote, at('quote'));
  return annotation;
}

/** Writes one annotation with a fixed key order so exports are byte-stable. */
function serializeAnnotation(annotation: Annotation): Record<string, unknown> {
  const record: Record<string, unknown> = {
    id: annotation.id,
    documentId: annotation.documentId,
    page: annotation.page,
    kind: annotation.kind,
    text: annotation.text,
  };
  if (annotation.blockId !== undefined) record.blockId = annotation.blockId;
  if (annotation.rect !== undefined) {
    record.rect = {
      x: annotation.rect.x,
      y: annotation.rect.y,
      width: annotation.rect.width,
      height: annotation.rect.height,
    };
  }
  if (annotation.color !== undefined) record.color = annotation.color;
  if (annotation.quote !== undefined) record.quote = annotation.quote;
  record.createdAt = annotation.createdAt;
  record.updatedAt = annotation.updatedAt;
  record.orphaned = annotation.orphaned;
  return record;
}

const EXPORT_KIND = 'annotations';

// --- Document plumbing -----------------------------------------------------

interface PageSize {
  width: number;
  height: number;
}

interface AnchorProblem {
  code: Extract<AnnotationErrorCode, 'unknown-page' | 'unknown-block' | 'anchor-page-mismatch' | 'rect-out-of-bounds'>;
  message: string;
  path: string;
}

interface Resolution {
  /** The anchored block's text, when the anchor resolved to a block. */
  quote?: string;
  problem?: AnchorProblem;
}

function resolutionError(problem: AnchorProblem): AnnotationError {
  return new AnnotationError(
    problem.code,
    `${problem.message} Pass { orphanOk: true } to keep the annotation when the anchor cannot be resolved.`,
    problem.path,
  );
}

/** Page sizes of a document, indexed by page number. */
function pageMapOf(ir: DocumentIR): Map<number, PageSize> {
  const pages = new Map<number, PageSize>();
  for (const page of Array.isArray(ir?.pages) ? ir.pages : []) {
    if (!page || !Number.isInteger(page.index) || page.index < 1) continue;
    if (!Number.isFinite(page.width) || !Number.isFinite(page.height)) continue;
    if (page.width <= 0 || page.height <= 0) continue;
    pages.set(page.index, { width: page.width, height: page.height });
  }
  return pages;
}

function blockById(ir: DocumentIR, blockId: string): Block | undefined {
  for (const block of blocksOf(ir)) {
    if (block.id === blockId) return block;
  }
  return undefined;
}

function blocksOf(ir: DocumentIR): readonly Block[] {
  const blocks = Array.isArray(ir?.blocks) ? ir.blocks : [];
  return blocks.filter(block => typeof block === 'object' && block !== null);
}

function blockText(block: Block | undefined): string {
  return block !== undefined && typeof block.raw === 'string' ? block.raw : '';
}

function rectFits(rect: Rect, page: PageSize): boolean {
  const tolerance = POLYGON_BOUNDS_TOLERANCE;
  return (
    rect.x >= -tolerance &&
    rect.y >= -tolerance &&
    rect.x + rect.width <= page.width + tolerance &&
    rect.y + rect.height <= page.height + tolerance
  );
}

// --- Field readers ---------------------------------------------------------

function requireText(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new AnnotationError('invalid-field', `${labelOf(path)} must be a string.`, path);
  }
  const text = value.trim();
  if (text.length === 0) {
    throw new AnnotationError('invalid-field', `${labelOf(path)} must not be blank.`, path);
  }
  return text;
}

function optionalText(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new AnnotationError('invalid-field', `${labelOf(path)} must be a string when present.`, path);
  }
  const text = value.trim();
  if (text.length === 0) {
    throw new AnnotationError('invalid-field', `${labelOf(path)} must not be blank when present.`, path);
  }
  return text;
}

function requirePage(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new AnnotationError('invalid-field', `${labelOf(path)} must be a 1-based integer page number.`, path);
  }
  return value;
}

function requireKind(value: unknown, path: string): AnnotationKind {
  if (typeof value !== 'string' || !(ANNOTATION_KINDS as readonly string[]).includes(value)) {
    throw new AnnotationError('invalid-field', `${labelOf(path)} must be one of ${ANNOTATION_KINDS.join(' | ')}.`, path);
  }
  return value as AnnotationKind;
}

/** Reads a selection rect from a caller or an import. */
function readRect(value: unknown, path: string): Rect {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AnnotationError('invalid-rect', `${labelOf(path)} must be an object with x, y, width and height.`, path);
  }
  const record = value as Record<string, unknown>;
  const x = rectNumber(record.x, `${path}.x`);
  const y = rectNumber(record.y, `${path}.y`);
  const width = rectNumber(record.width, `${path}.width`);
  const height = rectNumber(record.height, `${path}.height`);
  if (width < 0 || height < 0) {
    throw new AnnotationError('invalid-rect', `${labelOf(path)} needs a non-negative width and height.`, path);
  }
  return { x, y, width, height };
}

function rectNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AnnotationError('invalid-rect', `${labelOf(path)} must be a finite number.`, path);
  }
  return value;
}

function readQuote(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new AnnotationError('invalid-field', `${labelOf(path)} must be a string.`, path);
  }
  return value;
}

function readOrphaned(value: unknown, path: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    throw new AnnotationError('invalid-field', `${labelOf(path)} must be a boolean when present.`, path);
  }
  return value;
}

function readKindFilter(value: unknown): Set<AnnotationKind> | undefined {
  if (value === undefined || value === null) return undefined;
  const kinds = new Set<AnnotationKind>();
  if (Array.isArray(value)) {
    for (const entry of value) kinds.add(requireKind(entry, 'kind'));
    return kinds;
  }
  kinds.add(requireKind(value, 'kind'));
  return kinds;
}

function patchObject(patch: unknown): Record<string, unknown> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new AnnotationError('invalid-field', 'update needs a patch object.', 'patch');
  }
  return patch as Record<string, unknown>;
}

// --- Small helpers ---------------------------------------------------------

/** Store-unique order: document, page, rect top, rect left, id. */
function compareAnnotations(left: Annotation, right: Annotation): number {
  return (
    compareText(left.documentId, right.documentId) ||
    finiteOr(left.page, 0) - finiteOr(right.page, 0) ||
    compareEdge(left, right, 'top') ||
    compareEdge(left, right, 'left') ||
    compareText(left.id, right.id)
  );
}

/** Compares the top or left edge; an annotation without a rect sorts last. */
function compareEdge(left: Annotation, right: Annotation, edge: 'top' | 'left'): number {
  const first = edge === 'top' ? finiteRectEdge(left, 'y') : finiteRectEdge(left, 'x');
  const second = edge === 'top' ? finiteRectEdge(right, 'y') : finiteRectEdge(right, 'x');
  if (first === second) return 0;
  return first < second ? -1 : 1;
}

function finiteRectEdge(annotation: Annotation, field: 'x' | 'y'): number {
  const value = annotation.rect?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function validPage(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : fallback;
}

function sameRect(left: Rect | undefined, right: Rect | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

function clone(annotation: Annotation): Annotation {
  return {
    ...annotation,
    ...(annotation.rect === undefined ? {} : { rect: { ...annotation.rect } }),
  };
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

function labelOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? path : path.slice(dot + 1);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Collapses whitespace runs and trims; keeps a Markdown bullet on one line. */
function foldText(text: unknown): string {
  return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
}

const SYSTEM_CLOCK = (): string => new Date().toISOString();
