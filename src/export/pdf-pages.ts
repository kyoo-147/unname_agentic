/**
 * PDF page manipulation and synchronized thumbnail deck state (backlog item H07).
 *
 * Provides real `pdf-lib` document operations (`splitPdf`, `mergePdfs`, `reorderPages`,
 * `rotatePages`, `deletePages`, `extractPages`, `inspectPdfPages`) alongside `PageThumbnailDeck`,
 * a synchronous state manager that keeps thumbnail indices, 1-based page numbers, dimensions,
 * cumulative rotations, selection/active-page pointers, and undo/redo history in strict lockstep
 * with zero stale indices.
 */

import { PDFDocument, degrees, toDegrees } from 'pdf-lib';
import { normalizeRotation, rotatePageSize, type PageRotation } from '../pdf/layout';
import { parsePageRange, type PageRangeInput } from './monolingual-pdf';
import { PdfExportError } from './pdf';

export { PdfExportError };
export type { PageRangeInput, PageRotation };

export interface PdfPageMetadata {
  /** Current 1-based page number in the document (always contiguous 1..pageCount). */
  pageNumber: number;
  /** Current 0-based index in the document (always contiguous 0..pageCount - 1). */
  index: number;
  /** 1-based page number in the originating source PDF. */
  sourcePageNumber: number;
  /** 0-based index of the originating source PDF (0 for single-document operations). */
  sourceDocIndex: number;
  /** Effective viewport width in points after applying page rotation. */
  width: number;
  /** Effective viewport height in points after applying page rotation. */
  height: number;
  /** Unrotated MediaBox width in points. */
  baseWidth: number;
  /** Unrotated MediaBox height in points. */
  baseHeight: number;
  /** Normalized cumulative page rotation in degrees: 0 | 90 | 180 | 270. */
  rotation: PageRotation;
}

export interface PdfPagesResult {
  bytes: Uint8Array;
  pageCount: number;
  pages: PdfPageMetadata[];
}

export interface SplitPdfOptions {
  /** Explicit list of 1-based page ranges/lists; each entry produces one output PDF chunk. */
  ranges?: readonly PageRangeInput[];
  /** Fixed maximum number of pages per output PDF chunk (positive integer). */
  chunkSize?: number;
}

export interface SplitPdfChunk extends PdfPagesResult {
  /** 0-based chunk index in the split output. */
  chunkIndex: number;
  /** 1-based source page numbers included in this chunk, in output order. */
  sourcePages: number[];
}

export interface SplitPdfResult {
  sourcePageCount: number;
  chunks: SplitPdfChunk[];
}

export type MergePdfInput =
  | Uint8Array
  | {
      bytes: Uint8Array;
      /** Optional 1-based page selection from this input PDF; omitted includes all pages. */
      pages?: PageRangeInput;
    };

export interface RotatePagesOptions {
  /** 1-based page selection (`"1-3"`, `[1, 3]`, `{ start, end }`). Omitted rotates all pages. */
  pages?: PageRangeInput;
  /** Rotation angle in degrees (must be a finite multiple of 90). */
  angle: number;
  /**
   * `'relative'` (default) adds `angle` to each target page's current rotation and normalizes
   * modulo 360; `'absolute'` sets each target page's rotation directly to normalized `angle`.
   */
  mode?: 'relative' | 'absolute';
}

export interface PageThumbnailSource {
  id?: string;
  sourcePageNumber?: number;
  sourceDocIndex?: number;
  width: number;
  height: number;
  rotation?: number;
  label?: string;
  thumbnailUrl?: string;
}

export interface PageThumbnail {
  readonly id: string;
  readonly pageNumber: number;
  readonly index: number;
  readonly sourcePageNumber: number;
  readonly sourceDocIndex: number;
  readonly baseWidth: number;
  readonly baseHeight: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: PageRotation;
  readonly label?: string;
  readonly thumbnailUrl?: string;
}

export interface ThumbnailDeckSnapshot {
  readonly thumbnails: readonly PageThumbnail[];
  readonly pageCount: number;
  readonly activePage: number;
  readonly selectedPages: number[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoCount: number;
  readonly redoCount: number;
}

export type ThumbnailDeckListener = (snapshot: ThumbnailDeckSnapshot) => void;

interface PlannedOutputPage {
  docIndex: number;
  pageNumber: number;
  rotation?: PageRotation;
}

interface DeckItem {
  readonly id: string;
  readonly sourcePageNumber: number;
  readonly sourceDocIndex: number;
  readonly baseWidth: number;
  readonly baseHeight: number;
  readonly rotation: PageRotation;
  readonly label?: string;
  readonly thumbnailUrl?: string;
}

interface DeckSnapshotState {
  readonly items: readonly DeckItem[];
  readonly activeId: string;
  readonly selectedIds: readonly string[];
}

/**
 * Validates that `angle` is a finite multiple of 90 degrees and normalizes it into
 * `{ 0, 90, 180, 270 }`. Rejects non-90 angles and non-finite inputs with `PdfExportError`.
 */
export function normalizePageRotation(angle: number): PageRotation {
  if (typeof angle !== 'number' || !Number.isFinite(angle) || angle % 90 !== 0) {
    throw new PdfExportError(`Invalid page rotation ${String(angle)}: expected a finite multiple of 90 degrees.`);
  }
  const normalized = normalizeRotation(angle);
  return normalized === 0 ? 0 : normalized;
}

function validatePositiveDimension(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new PdfExportError(`Page ${label} must be a positive finite number.`);
  }
  return value;
}

async function loadPdfDocument(bytes: Uint8Array, label = 'PDF'): Promise<PDFDocument> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new PdfExportError(`${label} input must be a non-empty Uint8Array.`);
  }
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PdfExportError(`Failed to parse ${label}: ${reason}`);
  }
  if (doc.getPageCount() < 1) {
    throw new PdfExportError(`${label} contains zero pages.`);
  }
  return doc;
}

function buildPageMetadata(
  index: number,
  sourcePageNumber: number,
  sourceDocIndex: number,
  baseWidth: number,
  baseHeight: number,
  rotation: PageRotation,
): PdfPageMetadata {
  const effective = rotatePageSize({ width: baseWidth, height: baseHeight }, rotation);
  return {
    pageNumber: index + 1,
    index,
    sourcePageNumber,
    sourceDocIndex,
    width: effective.width,
    height: effective.height,
    baseWidth,
    baseHeight,
    rotation,
  };
}

function readLoadedPageMetadata(
  doc: PDFDocument,
  zeroBasedIndex: number,
  outIndex: number,
  sourcePageNumber: number,
  sourceDocIndex: number,
): PdfPageMetadata {
  const page = doc.getPage(zeroBasedIndex);
  const size = page.getSize();
  const rotation = normalizeRotation(toDegrees(page.getRotation()));
  return buildPageMetadata(outIndex, sourcePageNumber, sourceDocIndex, size.width, size.height, rotation);
}

function resolvePageSelection(range: PageRangeInput, totalPages: number, action: string): number[] {
  const selected = parsePageRange(range, totalPages);
  if (selected.size === 0) {
    throw new PdfExportError(`Cannot ${action}: page selection is empty.`);
  }
  const pages: number[] = [];
  for (const pageNumber of selected) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > totalPages) {
      throw new PdfExportError(`Page ${pageNumber} is out of bounds for ${totalPages}-page document.`);
    }
    pages.push(pageNumber);
  }
  return pages;
}

function validateReorderPermutation(order: readonly number[], totalPages: number): number[] {
  if (!Array.isArray(order) || order.length === 0) {
    throw new PdfExportError('Cannot reorder pages: order array must not be empty.');
  }
  const seen = new Set<number>();
  const validated: number[] = [];
  for (const pageNumber of order) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > totalPages) {
      throw new PdfExportError(`Invalid page number ${String(pageNumber)} in reorder (valid: 1..${totalPages}).`);
    }
    if (seen.has(pageNumber)) {
      throw new PdfExportError(`Duplicate page number ${pageNumber} in reorder.`);
    }
    seen.add(pageNumber);
    validated.push(pageNumber);
  }
  if (validated.length !== totalPages) {
    throw new PdfExportError(
      `Reorder must include all ${totalPages} pages exactly once (received ${validated.length}).`,
    );
  }
  return validated;
}

function computeSplitPageLists(totalPages: number, options: SplitPdfOptions): number[][] {
  if (!options || typeof options !== 'object') {
    throw new PdfExportError('splitPdf requires split options with either `ranges` or `chunkSize`.');
  }
  const hasRanges = options.ranges !== undefined;
  const hasChunkSize = options.chunkSize !== undefined;
  if (hasRanges === hasChunkSize) {
    throw new PdfExportError('splitPdf requires exactly one of `ranges` or `chunkSize`.');
  }

  if (hasRanges) {
    const ranges = options.ranges;
    if (!Array.isArray(ranges) || ranges.length === 0) {
      throw new PdfExportError('splitPdf `ranges` must be a non-empty array of page ranges.');
    }
    return ranges.map(range => resolvePageSelection(range, totalPages, 'split'));
  }

  const chunkSize = options.chunkSize;
  if (typeof chunkSize !== 'number' || !Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new PdfExportError(`splitPdf \`chunkSize\` must be a positive integer (received ${String(chunkSize)}).`);
  }
  const chunks: number[][] = [];
  for (let start = 1; start <= totalPages; start += chunkSize) {
    const end = Math.min(totalPages, start + chunkSize - 1);
    const list: number[] = [];
    for (let page = start; page <= end; page++) list.push(page);
    chunks.push(list);
  }
  return chunks;
}

async function materializePdfPlan(
  sourceDocs: readonly PDFDocument[],
  plan: readonly PlannedOutputPage[],
): Promise<PdfPagesResult> {
  if (plan.length === 0) {
    throw new PdfExportError('Resulting PDF must contain at least one page.');
  }

  const outDoc = await PDFDocument.create();

  // Group indices by source document so pdf-lib copies shared fonts/resources once per source PDF.
  const indicesByDoc = new Map<number, number[]>();
  const slotsByEntry: { docIndex: number; slotIndex: number }[] = [];

  for (const entry of plan) {
    const srcDoc = sourceDocs[entry.docIndex];
    if (!srcDoc) {
      throw new PdfExportError(`Missing source PDF at index ${entry.docIndex}.`);
    }
    const pageCount = srcDoc.getPageCount();
    if (!Number.isInteger(entry.pageNumber) || entry.pageNumber < 1 || entry.pageNumber > pageCount) {
      throw new PdfExportError(
        `Page ${entry.pageNumber} is out of bounds for source PDF ${entry.docIndex} (${pageCount} pages).`,
      );
    }
    let indices = indicesByDoc.get(entry.docIndex);
    if (!indices) {
      indices = [];
      indicesByDoc.set(entry.docIndex, indices);
    }
    const slotIndex = indices.length;
    indices.push(entry.pageNumber - 1);
    slotsByEntry.push({ docIndex: entry.docIndex, slotIndex });
  }

  const copiedByDoc = new Map<number, ReturnType<typeof outDoc.getPages>>();
  for (const [docIndex, zeroBasedIndices] of indicesByDoc.entries()) {
    const srcDoc = sourceDocs[docIndex];
    if (!srcDoc) continue;
    const copiedPages = await outDoc.copyPages(srcDoc, zeroBasedIndices);
    copiedByDoc.set(docIndex, copiedPages);
  }

  const pages: PdfPageMetadata[] = [];
  for (let outIndex = 0; outIndex < plan.length; outIndex++) {
    const entry = plan[outIndex];
    const slot = slotsByEntry[outIndex];
    if (!entry || !slot) continue;
    const copiedList = copiedByDoc.get(slot.docIndex);
    const copiedPage = copiedList?.[slot.slotIndex];
    if (!copiedPage) {
      throw new PdfExportError(`Failed to materialize page ${entry.pageNumber} from source PDF ${slot.docIndex}.`);
    }
    outDoc.addPage(copiedPage);
    if (entry.rotation !== undefined) {
      copiedPage.setRotation(degrees(entry.rotation));
    }
    pages.push(readLoadedPageMetadata(outDoc, outIndex, outIndex, entry.pageNumber, entry.docIndex));
  }

  const bytes = await outDoc.save();
  return {
    bytes,
    pageCount: outDoc.getPageCount(),
    pages,
  };
}

/**
 * Reads page dimensions and normalized rotations from an existing PDF `Uint8Array`.
 */
export async function inspectPdfPages(bytes: Uint8Array): Promise<PdfPageMetadata[]> {
  const doc = await loadPdfDocument(bytes);
  const total = doc.getPageCount();
  const pages: PdfPageMetadata[] = [];
  for (let index = 0; index < total; index++) {
    pages.push(readLoadedPageMetadata(doc, index, index, index + 1, 0));
  }
  return pages;
}

/**
 * Splits a PDF into multiple documents by explicit 1-based page ranges or fixed `chunkSize`.
 */
export async function splitPdf(bytes: Uint8Array, options: SplitPdfOptions): Promise<SplitPdfResult> {
  const doc = await loadPdfDocument(bytes);
  const totalPages = doc.getPageCount();
  const chunkLists = computeSplitPageLists(totalPages, options);

  const chunks: SplitPdfChunk[] = [];
  for (let chunkIndex = 0; chunkIndex < chunkLists.length; chunkIndex++) {
    const sourcePages = chunkLists[chunkIndex];
    if (!sourcePages) continue;
    const materialized = await materializePdfPlan(
      [doc],
      sourcePages.map(pageNumber => ({ docIndex: 0, pageNumber })),
    );
    chunks.push({
      chunkIndex,
      sourcePages: [...sourcePages],
      ...materialized,
    });
  }

  return {
    sourcePageCount: totalPages,
    chunks,
  };
}

/**
 * Merges 2 or more PDFs in input order while preserving each page's geometry and rotation.
 */
export async function mergePdfs(inputs: readonly MergePdfInput[]): Promise<PdfPagesResult> {
  if (!Array.isArray(inputs) || inputs.length < 2) {
    throw new PdfExportError('mergePdfs requires at least 2 PDF documents.');
  }

  const docs: PDFDocument[] = [];
  const plan: PlannedOutputPage[] = [];

  for (let docIndex = 0; docIndex < inputs.length; docIndex++) {
    const item = inputs[docIndex];
    if (!item) {
      throw new PdfExportError(`mergePdfs received an invalid entry at index ${docIndex}.`);
    }
    const bytes = item instanceof Uint8Array ? item : item.bytes;
    const range = item instanceof Uint8Array ? undefined : item.pages;
    const doc = await loadPdfDocument(bytes, `PDF[${docIndex}]`);
    docs.push(doc);

    const total = doc.getPageCount();
    const pageNumbers =
      range === undefined
        ? Array.from({ length: total }, (_, idx) => idx + 1)
        : resolvePageSelection(range, total, `merge PDF[${docIndex}]`);

    for (const pageNumber of pageNumbers) {
      plan.push({ docIndex, pageNumber });
    }
  }

  return materializePdfPlan(docs, plan);
}

/**
 * Reorders all pages of a PDF according to a complete 1-based permutation.
 */
export async function reorderPages(bytes: Uint8Array, order: readonly number[]): Promise<PdfPagesResult> {
  const doc = await loadPdfDocument(bytes);
  const totalPages = doc.getPageCount();
  const validated = validateReorderPermutation(order, totalPages);
  return materializePdfPlan(
    [doc],
    validated.map(pageNumber => ({ docIndex: 0, pageNumber })),
  );
}

/**
 * Rotates target pages by a multiple of 90 degrees with cumulative modulo-360 normalization.
 */
export async function rotatePages(bytes: Uint8Array, options: RotatePagesOptions): Promise<PdfPagesResult> {
  if (!options || typeof options !== 'object') {
    throw new PdfExportError('rotatePages requires an options object with `angle`.');
  }
  const delta = normalizePageRotation(options.angle);
  const mode = options.mode ?? 'relative';
  if (mode !== 'relative' && mode !== 'absolute') {
    throw new PdfExportError(`Unsupported rotation mode "${String(mode)}".`);
  }

  const doc = await loadPdfDocument(bytes);
  const totalPages = doc.getPageCount();
  const targetPages = new Set(
    options.pages === undefined
      ? Array.from({ length: totalPages }, (_, idx) => idx + 1)
      : resolvePageSelection(options.pages, totalPages, 'rotate'),
  );

  const pages: PdfPageMetadata[] = [];
  for (let index = 0; index < totalPages; index++) {
    const pageNumber = index + 1;
    const page = doc.getPage(index);
    const current = normalizeRotation(toDegrees(page.getRotation()));
    const next = targetPages.has(pageNumber)
      ? (mode === 'absolute' ? delta : normalizePageRotation(current + delta))
      : current;
    if (targetPages.has(pageNumber)) {
      page.setRotation(degrees(next));
    }
    pages.push(readLoadedPageMetadata(doc, index, index, pageNumber, 0));
  }

  const saved = await doc.save();
  return {
    bytes: saved,
    pageCount: totalPages,
    pages,
  };
}

/**
 * Deletes the selected 1-based pages from a PDF while guaranteeing at least one page remains.
 */
export async function deletePages(bytes: Uint8Array, pages: PageRangeInput): Promise<PdfPagesResult> {
  const doc = await loadPdfDocument(bytes);
  const totalPages = doc.getPageCount();
  const toDelete = new Set(resolvePageSelection(pages, totalPages, 'delete'));

  const surviving: number[] = [];
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    if (!toDelete.has(pageNumber)) surviving.push(pageNumber);
  }
  if (surviving.length === 0) {
    throw new PdfExportError('Cannot delete all pages; resulting PDF must contain at least one page.');
  }

  return materializePdfPlan(
    [doc],
    surviving.map(pageNumber => ({ docIndex: 0, pageNumber })),
  );
}

/**
 * Extracts the selected 1-based pages into a new PDF in the order requested.
 */
export async function extractPages(bytes: Uint8Array, pages: PageRangeInput): Promise<PdfPagesResult> {
  const doc = await loadPdfDocument(bytes);
  const totalPages = doc.getPageCount();
  const selected = resolvePageSelection(pages, totalPages, 'extract');

  return materializePdfPlan(
    [doc],
    selected.map(pageNumber => ({ docIndex: 0, pageNumber })),
  );
}

/**
 * Synchronized thumbnail state manager for interactive page edits (`reorder`, `movePage`,
 * `rotate`, `delete`, `extract`, `merge`, `split`) with immediate index/dimension re-sync,
 * non-stale selection/active-page tracking, subscriber notifications, and undo/redo history.
 */
export class PageThumbnailDeck {
  private items: DeckItem[];
  private activeId: string;
  private selectedIds: Set<string>;
  private readonly undoStack: DeckSnapshotState[] = [];
  private readonly redoStack: DeckSnapshotState[] = [];
  private readonly listeners = new Set<ThumbnailDeckListener>();
  private nextSeq: number;

  private constructor(items: DeckItem[], nextSeq: number) {
    const first = items[0];
    if (!first) {
      throw new PdfExportError('PageThumbnailDeck requires at least one page.');
    }
    this.items = items;
    this.activeId = first.id;
    this.selectedIds = new Set<string>();
    this.nextSeq = nextSeq;
  }

  /**
   * Creates a thumbnail deck synchronously from page geometry descriptors.
   */
  static fromPages(pages: readonly PageThumbnailSource[]): PageThumbnailDeck {
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new PdfExportError('PageThumbnailDeck requires at least one page.');
    }
    const { items, nextSeq } = buildDeckItems(pages, 0, new Set<string>(), 1);
    return new PageThumbnailDeck(items, nextSeq);
  }

  /**
   * Creates a thumbnail deck directly from a PDF `Uint8Array` via `pdf-lib`.
   */
  static async fromPdf(bytes: Uint8Array, sourceDocIndex = 0): Promise<PageThumbnailDeck> {
    if (!Number.isInteger(sourceDocIndex) || sourceDocIndex < 0) {
      throw new PdfExportError(`Invalid sourceDocIndex ${String(sourceDocIndex)}.`);
    }
    const metadata = await inspectPdfPages(bytes);
    return PageThumbnailDeck.fromPages(
      metadata.map(page => ({
        sourcePageNumber: page.sourcePageNumber,
        sourceDocIndex,
        width: page.baseWidth,
        height: page.baseHeight,
        rotation: page.rotation,
      })),
    );
  }

  get pageCount(): number {
    return this.items.length;
  }

  get activePage(): number {
    const idx = this.items.findIndex(item => item.id === this.activeId);
    return idx >= 0 ? idx + 1 : 1;
  }

  get selectedPages(): number[] {
    const pages: number[] = [];
    for (let index = 0; index < this.items.length; index++) {
      const item = this.items[index];
      if (item && this.selectedIds.has(item.id)) {
        pages.push(index + 1);
      }
    }
    return pages;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  get redoCount(): number {
    return this.redoStack.length;
  }

  getThumbnails(): readonly PageThumbnail[] {
    return this.items.map((item, index) => toThumbnail(item, index));
  }

  getThumbnail(pageNumber: number): PageThumbnail {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.items.length) {
      throw new PdfExportError(`Page ${String(pageNumber)} is out of bounds (1..${this.items.length}).`);
    }
    const item = this.items[pageNumber - 1];
    if (!item) {
      throw new PdfExportError(`Page ${pageNumber} is missing.`);
    }
    return toThumbnail(item, pageNumber - 1);
  }

  getSnapshot(): ThumbnailDeckSnapshot {
    return {
      thumbnails: this.getThumbnails(),
      pageCount: this.items.length,
      activePage: this.activePage,
      selectedPages: this.selectedPages,
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      undoCount: this.undoCount,
      redoCount: this.redoCount,
    };
  }

  subscribe(listener: ThumbnailDeckListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setActivePage(pageNumber: number): void {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.items.length) {
      throw new PdfExportError(`Cannot activate page ${String(pageNumber)}: out of bounds (1..${this.items.length}).`);
    }
    const item = this.items[pageNumber - 1];
    if (!item) return;
    if (this.activeId === item.id) return;
    this.activeId = item.id;
    this.notify();
  }

  selectPages(pages: PageRangeInput): void {
    const chosen = resolvePageSelection(pages, this.items.length, 'select');
    const nextSelected = new Set<string>();
    for (const pageNumber of chosen) {
      const item = this.items[pageNumber - 1];
      if (item) nextSelected.add(item.id);
    }
    this.selectedIds = nextSelected;
    this.notify();
  }

  clearSelection(): void {
    if (this.selectedIds.size === 0) return;
    this.selectedIds = new Set<string>();
    this.notify();
  }

  reorder(order: readonly number[]): readonly PageThumbnail[] {
    const validated = validateReorderPermutation(order, this.items.length);
    const nextItems: DeckItem[] = [];
    for (const pageNumber of validated) {
      const item = this.items[pageNumber - 1];
      if (item) nextItems.push(item);
    }
    this.commitEdit(nextItems);
    return this.getThumbnails();
  }

  movePage(fromPage: number, toPage: number): readonly PageThumbnail[] {
    if (!Number.isInteger(fromPage) || fromPage < 1 || fromPage > this.items.length) {
      throw new PdfExportError(`Invalid source page ${String(fromPage)} in movePage (1..${this.items.length}).`);
    }
    if (!Number.isInteger(toPage) || toPage < 1 || toPage > this.items.length) {
      throw new PdfExportError(`Invalid target page ${String(toPage)} in movePage (1..${this.items.length}).`);
    }
    if (fromPage === toPage) {
      return this.getThumbnails();
    }
    const nextItems = [...this.items];
    const [moved] = nextItems.splice(fromPage - 1, 1);
    if (!moved) {
      throw new PdfExportError(`Failed to move page ${fromPage}.`);
    }
    nextItems.splice(toPage - 1, 0, moved);
    this.commitEdit(nextItems);
    return this.getThumbnails();
  }

  rotate(
    pages: PageRangeInput | undefined,
    angle: number,
    mode: 'relative' | 'absolute' = 'relative',
  ): readonly PageThumbnail[] {
    const delta = normalizePageRotation(angle);
    if (mode !== 'relative' && mode !== 'absolute') {
      throw new PdfExportError(`Unsupported rotation mode "${String(mode)}".`);
    }
    const targets = new Set(
      pages === undefined
        ? Array.from({ length: this.items.length }, (_, idx) => idx + 1)
        : resolvePageSelection(pages, this.items.length, 'rotate'),
    );
    const nextItems = this.items.map((item, idx) => {
      if (!targets.has(idx + 1)) return item;
      const rotation = mode === 'absolute' ? delta : normalizePageRotation(item.rotation + delta);
      return { ...item, rotation };
    });
    this.commitEdit(nextItems);
    return this.getThumbnails();
  }

  delete(pages: PageRangeInput): readonly PageThumbnail[] {
    const toDelete = new Set(resolvePageSelection(pages, this.items.length, 'delete'));
    const nextItems = this.items.filter((_, idx) => !toDelete.has(idx + 1));
    if (nextItems.length === 0) {
      throw new PdfExportError('Cannot delete all pages; at least one page must remain.');
    }
    this.commitEdit(nextItems);
    return this.getThumbnails();
  }

  extract(pages: PageRangeInput): readonly PageThumbnail[] {
    const selected = resolvePageSelection(pages, this.items.length, 'extract');
    const nextItems: DeckItem[] = [];
    for (const pageNumber of selected) {
      const item = this.items[pageNumber - 1];
      if (item) nextItems.push(item);
    }
    this.commitEdit(nextItems);
    return this.getThumbnails();
  }

  merge(input: PageThumbnailDeck | readonly PageThumbnailSource[]): readonly PageThumbnail[] {
    const nextDocIndex = this.items.reduce((max, item) => Math.max(max, item.sourceDocIndex), -1) + 1;
    const usedIds = new Set(this.items.map(item => item.id));
    let incoming: DeckItem[];

    if (input instanceof PageThumbnailDeck) {
      const minIncomingDocIndex = input.items.reduce(
        (min, item) => Math.min(min, item.sourceDocIndex),
        Number.POSITIVE_INFINITY,
      );
      const docShift = Number.isFinite(minIncomingDocIndex) ? nextDocIndex - minIncomingDocIndex : nextDocIndex;
      incoming = input.items.map(item => {
        const sourceDocIndex = item.sourceDocIndex + docShift;
        let id = item.id;
        while (usedIds.has(id)) {
          id = `doc${sourceDocIndex}-p${item.sourcePageNumber}-${this.nextSeq++}`;
        }
        usedIds.add(id);
        return {
          ...item,
          id,
          sourceDocIndex,
        };
      });
    } else {
      if (!Array.isArray(input) || input.length === 0) {
        throw new PdfExportError('Cannot merge an empty page list.');
      }
      const built = buildDeckItems(input, nextDocIndex, usedIds, this.nextSeq);
      incoming = built.items;
      this.nextSeq = built.nextSeq;
    }

    this.commitEdit([...this.items, ...incoming]);
    return this.getThumbnails();
  }

  /**
   * Computes independent chunk decks matching `splitPdf` rules without mutating this deck.
   */
  split(options: SplitPdfOptions): PageThumbnailDeck[] {
    const chunkLists = computeSplitPageLists(this.items.length, options);
    return chunkLists.map(pageNumbers => {
      const chunkItems: DeckItem[] = [];
      for (const pageNumber of pageNumbers) {
        const item = this.items[pageNumber - 1];
        if (item) chunkItems.push({ ...item });
      }
      return new PageThumbnailDeck(chunkItems, this.nextSeq);
    });
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.redoStack.push(this.captureState());
    this.restoreState(previous);
    this.notify();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.captureState());
    this.restoreState(next);
    this.notify();
    return true;
  }

  /**
   * Materializes the current edited thumbnail deck into a real PDF `Uint8Array` via `pdf-lib`.
   */
  async exportPdf(sources: Uint8Array | readonly Uint8Array[]): Promise<PdfPagesResult> {
    const sourceList = sources instanceof Uint8Array ? [sources] : sources;
    if (!Array.isArray(sourceList) || sourceList.length === 0) {
      throw new PdfExportError('exportPdf requires at least one source PDF Uint8Array.');
    }
    const maxNeededDoc = this.items.reduce((max, item) => Math.max(max, item.sourceDocIndex), 0);
    if (maxNeededDoc >= sourceList.length) {
      throw new PdfExportError(
        `Missing source PDF at index ${maxNeededDoc} (only ${sourceList.length} provided).`,
      );
    }

    const docs: PDFDocument[] = [];
    for (let docIndex = 0; docIndex < sourceList.length; docIndex++) {
      const bytes = sourceList[docIndex];
      if (!(bytes instanceof Uint8Array)) {
        throw new PdfExportError(`Source PDF at index ${docIndex} must be a Uint8Array.`);
      }
      docs.push(await loadPdfDocument(bytes, `SourcePDF[${docIndex}]`));
    }

    return materializePdfPlan(
      docs,
      this.items.map(item => ({
        docIndex: item.sourceDocIndex,
        pageNumber: item.sourcePageNumber,
        rotation: item.rotation,
      })),
    );
  }

  private captureState(): DeckSnapshotState {
    return {
      items: this.items.map(item => ({ ...item })),
      activeId: this.activeId,
      selectedIds: [...this.selectedIds],
    };
  }

  private restoreState(state: DeckSnapshotState): void {
    this.items = state.items.map(item => ({ ...item }));
    this.activeId = state.activeId;
    this.selectedIds = new Set(state.selectedIds);
  }

  private commitEdit(nextItems: DeckItem[]): void {
    const first = nextItems[0];
    if (!first) {
      throw new PdfExportError('PageThumbnailDeck cannot become empty.');
    }

    const previousIndex = Math.max(
      0,
      this.items.findIndex(item => item.id === this.activeId),
    );
    this.undoStack.push(this.captureState());
    this.redoStack.length = 0;
    this.items = nextItems;

    const survivingIds = new Set(nextItems.map(item => item.id));
    this.selectedIds = new Set([...this.selectedIds].filter(id => survivingIds.has(id)));
    if (!survivingIds.has(this.activeId)) {
      const fallback = nextItems[Math.min(previousIndex, nextItems.length - 1)] ?? first;
      this.activeId = fallback.id;
    }

    this.notify();
  }

  private notify(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

function buildDeckItems(
  sources: readonly PageThumbnailSource[],
  defaultDocIndex: number,
  usedIds: Set<string>,
  startSeq: number,
): { items: DeckItem[]; nextSeq: number } {
  let seq = startSeq;
  const items: DeckItem[] = sources.map((source, index) => {
    const baseWidth = validatePositiveDimension(source.width, 'width');
    const baseHeight = validatePositiveDimension(source.height, 'height');
    const rotation = normalizePageRotation(source.rotation ?? 0);
    const sourceDocIndex = source.sourceDocIndex ?? defaultDocIndex;
    if (!Number.isInteger(sourceDocIndex) || sourceDocIndex < 0) {
      throw new PdfExportError(`Invalid sourceDocIndex ${String(sourceDocIndex)}.`);
    }
    const sourcePageNumber = source.sourcePageNumber ?? index + 1;
    if (!Number.isInteger(sourcePageNumber) || sourcePageNumber < 1) {
      throw new PdfExportError(`Invalid sourcePageNumber ${String(sourcePageNumber)}.`);
    }
    let id = typeof source.id === 'string' && source.id.trim().length > 0
      ? source.id.trim()
      : `doc${sourceDocIndex}-p${sourcePageNumber}-${seq++}`;
    while (usedIds.has(id)) {
      id = `doc${sourceDocIndex}-p${sourcePageNumber}-${seq++}`;
    }
    usedIds.add(id);
    return {
      id,
      sourcePageNumber,
      sourceDocIndex,
      baseWidth,
      baseHeight,
      rotation,
      ...(source.label !== undefined ? { label: source.label } : {}),
      ...(source.thumbnailUrl !== undefined ? { thumbnailUrl: source.thumbnailUrl } : {}),
    };
  });
  return { items, nextSeq: seq };
}

function toThumbnail(item: DeckItem, index: number): PageThumbnail {
  const effective = rotatePageSize({ width: item.baseWidth, height: item.baseHeight }, item.rotation);
  return {
    id: item.id,
    pageNumber: index + 1,
    index,
    sourcePageNumber: item.sourcePageNumber,
    sourceDocIndex: item.sourceDocIndex,
    baseWidth: item.baseWidth,
    baseHeight: item.baseHeight,
    width: effective.width,
    height: effective.height,
    rotation: item.rotation,
    ...(item.label !== undefined ? { label: item.label } : {}),
    ...(item.thumbnailUrl !== undefined ? { thumbnailUrl: item.thumbnailUrl } : {}),
  };
}
