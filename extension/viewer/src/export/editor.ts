import {
  PDFDocument,
  StandardFonts,
  degrees,
  grayscale,
  rgb,
  type PDFPage,
} from 'pdf-lib';
import type { Block, DocumentIR, Translation } from '../core/ir';
import type { Rect } from '../core/types';
import { fitText } from '../pdf/layout';
import { registerPdfFonts, type PdfFontsOptions, type PreparedText } from './fonts';

export type PageAxis = 'horizontal' | 'vertical';
export type EditorOverlayKind = 'text' | 'callout' | 'rectangle' | 'ellipse' | 'line' | 'image' | 'watermark';
export type EditorTextKind = 'source' | 'translation' | 'annotation';
export type ImageFormat = 'png' | 'jpeg';

export interface EditorPageRef {
  id: string;
  sourceId: string;
  sourceIndex: number;
  crop?: Rect;
  cropFraction?: { axis: PageAxis; from: number; to: number };
}

export interface EditorTextEdit {
  id: string;
  pageId: string;
  blockId?: string;
  kind: EditorTextKind;
  sourceText: string;
  text: string;
  rect: Rect;
  fontSize: number;
  color: string;
  paperColor: string;
  rotation: number;
}

export interface EditorOverlayBase {
  id: string;
  page: number | 'all';
  rect: Rect;
  rotation?: number;
  color?: string;
  borderColor?: string;
  borderWidth?: number;
  opacity?: number;
}

export interface TextOverlay extends EditorOverlayBase {
  kind: 'text' | 'watermark' | 'callout';
  text: string;
  fontSize?: number;
  paperColor?: string;
}

export interface ShapeOverlay extends EditorOverlayBase {
  kind: 'rectangle' | 'ellipse';
  filled?: boolean;
}

export interface LineOverlay extends EditorOverlayBase {
  kind: 'line';
  to: { x: number; y: number };
}

export interface ImageOverlay extends EditorOverlayBase {
  kind: 'image';
  format: ImageFormat;
  bytes: Uint8Array;
}

export type EditorOverlay = TextOverlay | ShapeOverlay | LineOverlay | ImageOverlay;

export interface EditorMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
  language?: string;
}

export interface EditorSnapshot {
  revision: number;
  pages: EditorPageRef[];
  rotations: Record<string, number>;
  edits: EditorTextEdit[];
  overlays: EditorOverlay[];
  metadata?: EditorMetadata;
}

export interface EditorSource {
  id: string;
  bytes: Uint8Array;
}

export interface EditorFromIrOptions {
  fonts?: PdfFontsOptions;
  paperColor?: string;
}

export interface EditorBuildOptions {
  fonts?: PdfFontsOptions;
  producer?: string;
  saveOptions?: Parameters<PDFDocument['save']>[0];
}

export interface EditorBuildResult {
  bytes: Uint8Array;
  pageCount: number;
  sourcePageCount: number;
  overlayCount: number;
  editCount: number;
  translationCount: number;
  preserved: {
    metadata: boolean;
    forms: boolean;
    outlines: boolean;
  };
  limitations: string[];
}

export interface AutosaveStore {
  save(snapshot: EditorSnapshot): Promise<void> | void;
  load(): Promise<EditorSnapshot | null> | EditorSnapshot | null;
}

export class EditorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditorError';
  }
}

const DEFAULT_PAPER = '#ffffff';
const DEFAULT_INK = '#202724';
const DEFAULT_BORDER = '#47674e';
const DEFAULT_FONT_SIZE = 11;
const DEFAULT_LINE_HEIGHT = 1.15;
const DEFAULT_BASELINE_RATIO = 0.8;
const MAX_HISTORY = 100;

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function cloneRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function cloneOverlay(overlay: EditorOverlay): EditorOverlay {
  if (overlay.kind === 'image') return { ...overlay, rect: cloneRect(overlay.rect), bytes: cloneBytes(overlay.bytes) };
  if (overlay.kind === 'line') return { ...overlay, rect: cloneRect(overlay.rect), to: { ...overlay.to } };
  return { ...overlay, rect: cloneRect(overlay.rect) };
}

export function cloneEditorSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  return {
    revision: snapshot.revision,
    pages: snapshot.pages.map(page => ({ ...page, ...(page.crop ? { crop: cloneRect(page.crop) } : {}) })),
    rotations: { ...snapshot.rotations },
    edits: snapshot.edits.map(edit => ({ ...edit, rect: cloneRect(edit.rect) })),
    overlays: snapshot.overlays.map(cloneOverlay),
    ...(snapshot.metadata ? { metadata: { ...snapshot.metadata, ...(snapshot.metadata.keywords ? { keywords: [...snapshot.metadata.keywords] } : {}) } } : {}),
  };
}

function assertRect(rect: Rect, label: string): Rect {
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    throw new EditorError(`${label} must be a finite positive rectangle.`);
  }
  return cloneRect(rect);
}

function assertPage(page: number, count: number, label = 'page'): number {
  if (!Number.isInteger(page) || page < 1 || page > count) throw new EditorError(`${label} must be between 1 and ${count}.`);
  return page;
}

function normalizeRotation(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value / 90) * 90;
  return ((rounded % 360) + 360) % 360;
}

function hexColor(value: string | undefined, fallback: string): { r: number; g: number; b: number } {
  const raw = typeof value === 'string' ? value.trim().replace(/^#/, '') : '';
  const expanded = /^[0-9a-f]{3}$/iu.test(raw) ? raw.split('').map(char => `${char}${char}`).join('') : raw;
  if (!/^[0-9a-f]{6}$/iu.test(expanded)) return hexColor(fallback, fallback);
  const numeric = Number.parseInt(expanded, 16);
  return { r: ((numeric >> 16) & 0xff) / 255, g: ((numeric >> 8) & 0xff) / 255, b: (numeric & 0xff) / 255 };
}

function pageHeight(page: PDFPage): number {
  return page.getHeight();
}

function toPdfRect(rect: Rect, height: number): Rect {
  return { x: rect.x, y: height - rect.y - rect.height, width: rect.width, height: rect.height };
}

function pageRefId(sourceId: string, index: number, sequence: number): string {
  return `${sourceId}:p${index + 1}:${sequence}`;
}

function blockRect(block: Block, page: { width: number; height: number }): Rect {
  const points = Array.isArray(block.polygon) ? block.polygon : [];
  const xs = points.map(point => point.x).filter(Number.isFinite);
  const ys = points.map(point => point.y).filter(Number.isFinite);
  if (xs.length === 0 || ys.length === 0) return { x: 0, y: 0, width: page.width, height: Math.min(page.height, 16) };
  const left = Math.max(0, Math.min(...xs));
  const top = Math.max(0, Math.min(...ys));
  const right = Math.min(page.width, Math.max(...xs));
  const bottom = Math.min(page.height, Math.max(...ys));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function sourcePages(source: EditorSource): Promise<PDFDocument> {
  return PDFDocument.load(cloneBytes(source.bytes), { updateMetadata: false });
}


function fieldNames(document: PDFDocument): string[] {
  try {
    return document.getForm().getFields().map(field => field.getName()).sort();
  } catch {
    return [];
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function applyMetadata(document: PDFDocument, metadata: EditorMetadata | undefined): void {
  if (!metadata) return;
  if (metadata.title !== undefined) document.setTitle(metadata.title);
  if (metadata.author !== undefined) document.setAuthor(metadata.author);
  if (metadata.subject !== undefined) document.setSubject(metadata.subject);
  if (metadata.keywords !== undefined) document.setKeywords(metadata.keywords);
  if (metadata.creator !== undefined) document.setCreator(metadata.creator);
  if (metadata.producer !== undefined) document.setProducer(metadata.producer);
  if (metadata.language !== undefined) document.setLanguage(metadata.language);
}

function drawTextInRect(
  page: PDFPage,
  font: Awaited<ReturnType<typeof registerPdfFonts>>,
  text: string,
  rect: Rect,
  options: { fontSize?: number; color?: string; rotation?: number; paperColor?: string },
): { truncated: boolean; folded: boolean } {
  const frame = assertRect(rect, 'text rect');
  const prepared: PreparedText = font.prepare(typeof text === 'string' ? text : '');
  const measure = (value: string, size: number): number => {
    try {
      return font.font.widthOfTextAtSize(value, size);
    } catch {
      return value.length * size * 0.5;
    }
  };
  const preferred = Math.max(1, Number.isFinite(options.fontSize) ? options.fontSize! : Math.min(frame.height, DEFAULT_FONT_SIZE));
  const fit = fitText(prepared.text, frame.width, frame.height, preferred, measure, 1);
  const ink = hexColor(options.color, DEFAULT_INK);
  const pdf = toPdfRect(frame, pageHeight(page));
  if (options.paperColor !== undefined) {
    const paper = hexColor(options.paperColor, DEFAULT_PAPER);
    page.drawRectangle({ x: pdf.x, y: pdf.y, width: pdf.width, height: pdf.height, color: rgb(paper.r, paper.g, paper.b) });
  }
  const rotation = normalizeRotation(options.rotation ?? 0);
  fit.lines.forEach((line, index) => {
    if (!line.trim()) return;
    const y = pdf.y + pdf.height - fit.fontSize * DEFAULT_BASELINE_RATIO - index * fit.lineHeight;
    page.drawText(line, {
      x: pdf.x,
      y,
      size: fit.fontSize,
      font: font.font,
      color: rgb(ink.r, ink.g, ink.b),
      ...(rotation ? { rotate: degrees(-rotation) } : {}),
    });
  });
  return { truncated: fit.overflow, folded: prepared.changed };
}

function drawOverlay(page: PDFPage, overlay: EditorOverlay, fonts: Awaited<ReturnType<typeof registerPdfFonts>>, embeddedImages: Map<string, Awaited<ReturnType<PDFDocument['embedPng']>> | Awaited<ReturnType<PDFDocument['embedJpg']>>>): void {
  const rect = assertRect(overlay.rect, `overlay ${overlay.id}`);
  const pdf = toPdfRect(rect, pageHeight(page));
  const fillColor = hexColor(overlay.color, DEFAULT_BORDER);
  const borderColor = hexColor(overlay.borderColor, DEFAULT_BORDER);
  const opacity = Math.max(0, Math.min(1, Number.isFinite(overlay.opacity) ? overlay.opacity! : 1));
  const rotation = normalizeRotation(overlay.rotation ?? 0);
  const rotate = rotation ? degrees(-rotation) : degrees(0);
  if (overlay.kind === 'image') {
    const image = embeddedImages.get(overlay.id);
    if (!image) return;
    page.drawImage(image, { x: pdf.x, y: pdf.y, width: pdf.width, height: pdf.height, rotate, opacity });
    return;
  }
  if (overlay.kind === 'line') {
    page.drawLine({ start: { x: pdf.x, y: pdf.y + pdf.height }, end: { x: overlay.to.x, y: pageHeight(page) - overlay.to.y }, thickness: Math.max(0.5, overlay.borderWidth ?? 1), color: rgb(borderColor.r, borderColor.g, borderColor.b), opacity });
    return;
  }
  if (overlay.kind === 'ellipse') {
    page.drawEllipse({ x: pdf.x + pdf.width / 2, y: pdf.y + pdf.height / 2, xScale: pdf.width / 2, yScale: pdf.height / 2, rotate, color: overlay.filled === false ? undefined : rgb(fillColor.r, fillColor.g, fillColor.b), borderColor: rgb(borderColor.r, borderColor.g, borderColor.b), borderWidth: overlay.borderWidth ?? 1, opacity, borderOpacity: opacity });
    return;
  }
  if (overlay.kind === 'rectangle') {
    page.drawRectangle({ x: pdf.x, y: pdf.y, width: pdf.width, height: pdf.height, rotate, color: overlay.filled === false ? undefined : rgb(fillColor.r, fillColor.g, fillColor.b), borderColor: rgb(borderColor.r, borderColor.g, borderColor.b), borderWidth: overlay.borderWidth ?? 1, opacity, borderOpacity: opacity });
    return;
  }
  const textOverlay = overlay as TextOverlay;
  drawTextInRect(page, fonts, textOverlay.text, rect, { fontSize: textOverlay.fontSize, color: overlay.color, rotation: overlay.rotation, paperColor: textOverlay.kind === 'callout' ? textOverlay.paperColor ?? '#fff8dc' : undefined });
  if (textOverlay.kind === 'callout') {
    page.drawRectangle({ x: pdf.x, y: pdf.y, width: pdf.width, height: pdf.height, borderColor: rgb(borderColor.r, borderColor.g, borderColor.b), borderWidth: overlay.borderWidth ?? 1, rotate, opacity, borderOpacity: opacity });
  }
}

export class EditorSession {
  private currentSnapshot: EditorSnapshot;
  private readonly past: EditorSnapshot[] = [];
  private readonly future: EditorSnapshot[] = [];
  private autosaveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(initial: EditorSnapshot, private readonly autosave?: AutosaveStore, private readonly autosaveDelayMs = 400) {
    this.currentSnapshot = cloneEditorSnapshot(initial);
  }

  get snapshot(): EditorSnapshot {
    return cloneEditorSnapshot(this.currentSnapshot);
  }

  apply(mutator: (snapshot: EditorSnapshot) => EditorSnapshot): EditorSnapshot {
    const next = cloneEditorSnapshot(mutator(this.snapshot));
    next.revision = this.currentSnapshot.revision + 1;
    this.past.push(cloneEditorSnapshot(this.currentSnapshot));
    if (this.past.length > MAX_HISTORY) this.past.shift();
    this.future.length = 0;
    this.currentSnapshot = next;
    this.scheduleAutosave();
    return this.snapshot;
  }

  undo(): EditorSnapshot | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(cloneEditorSnapshot(this.currentSnapshot));
    this.currentSnapshot = cloneEditorSnapshot(previous);
    this.scheduleAutosave();
    return this.snapshot;
  }

  redo(): EditorSnapshot | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(cloneEditorSnapshot(this.currentSnapshot));
    this.currentSnapshot = cloneEditorSnapshot(next);
    this.scheduleAutosave();
    return this.snapshot;
  }

  async flushAutosave(): Promise<void> {
    if (this.autosaveTimer !== undefined) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = undefined;
    if (this.autosave) await this.autosave.save(this.snapshot);
  }

  private scheduleAutosave(): void {
    if (!this.autosave) return;
    if (this.autosaveTimer !== undefined) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = undefined;
      void this.autosave!.save(this.snapshot);
    }, Math.max(0, this.autosaveDelayMs));
  }
}

export class MemoryAutosaveStore implements AutosaveStore {
  private saved: EditorSnapshot | null = null;

  save(snapshot: EditorSnapshot): void {
    this.saved = cloneEditorSnapshot(snapshot);
  }

  load(): EditorSnapshot | null {
    return this.saved ? cloneEditorSnapshot(this.saved) : null;
  }
}

export class LocalStorageAutosaveStore implements AutosaveStore {
  constructor(private readonly storage: Storage, private readonly key: string) {}

  save(snapshot: EditorSnapshot): void {
    this.storage.setItem(this.key, JSON.stringify(snapshot, (_key, value) => value instanceof Uint8Array ? Array.from(value) : value));
  }

  load(): EditorSnapshot | null {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as EditorSnapshot;
      return cloneEditorSnapshot(parsed);
    } catch {
      return null;
    }
  }
}

export class PdfEditor {
  readonly source: EditorSource;
  readonly sources: EditorSource[];
  readonly ir?: DocumentIR;
  readonly blocks = new Map<string, { pageId: string; rect: Rect; text: string; fontSize: number }>();
  readonly session: EditorSession;

  private constructor(source: EditorSource, snapshot: EditorSnapshot, ir?: DocumentIR, sources: EditorSource[] = [source], autosave?: AutosaveStore) {
    this.source = source;
    this.sources = sources;
    this.ir = ir;
    this.session = new EditorSession(snapshot, autosave);
    if (ir) this.indexBlocks(ir, snapshot.pages);
  }

  static async open(bytes: Uint8Array, options: { documentId?: string; autosave?: AutosaveStore } = {}): Promise<PdfEditor> {
    const source: EditorSource = { id: options.documentId ?? 'source', bytes: cloneBytes(bytes) };
    const document = await sourcePages(source);
    const pages = document.getPages().map((_, index) => ({ id: pageRefId(source.id, index, 0), sourceId: source.id, sourceIndex: index }));
    const rotations = Object.fromEntries(document.getPages().map((page, index) => [pages[index]!.id, page.getRotation().angle]));
    return new PdfEditor(source, { revision: 0, pages, rotations, edits: [], overlays: [] }, undefined, [source], options.autosave);
  }

  static fromIr(sourceBytes: Uint8Array, ir: DocumentIR, options: EditorFromIrOptions = {}, autosave?: AutosaveStore): PdfEditor {
    const source: EditorSource = { id: ir.documentId || 'source', bytes: cloneBytes(sourceBytes) };
    const pages = ir.pages.map((page, index) => ({ id: pageRefId(source.id, index, 0), sourceId: source.id, sourceIndex: index }));
    const editor = new PdfEditor(source, { revision: 0, pages, rotations: {}, edits: [], overlays: [], metadata: { title: undefined } }, ir, [source], autosave);
    editor.indexBlocks(ir, pages);
    for (const translation of ir.translations) editor.setTranslation(translation, options);
    return editor;
  }

  private indexBlocks(ir: DocumentIR, pages: readonly EditorPageRef[]): void {
    this.blocks.clear();
    for (const block of ir.blocks) {
      const page = pages.find(entry => entry.sourceIndex === block.page - 1 && entry.sourceId === this.source.id);
      if (!page) continue;
      const pageModel = ir.pages.find(entry => entry.index === block.page);
      if (!pageModel) continue;
      this.blocks.set(block.id, { pageId: page.id, rect: blockRect(block, pageModel), text: block.raw, fontSize: Math.max(1, Math.min(36, blockRect(block, pageModel).height)) });
    }
  }

  get snapshot(): EditorSnapshot {
    return this.session.snapshot;
  }

  addText(page: number, text: string, rect: Rect, options: { id?: string; fontSize?: number; color?: string; paperColor?: string; kind?: EditorOverlayKind } = {}): void {
    const snapshot = this.snapshot;
    assertPage(page, snapshot.pages.length);
    const overlay: TextOverlay = {
      id: options.id ?? `overlay-${snapshot.revision + snapshot.overlays.length + 1}`,
      page,
      rect: assertRect(rect, 'text rect'),
      kind: options.kind === 'watermark' ? 'watermark' : options.kind === 'callout' ? 'callout' : 'text',
      text,
      fontSize: options.fontSize,
      color: options.color,
      paperColor: options.paperColor,
    };
    this.session.apply(state => ({ ...state, overlays: [...state.overlays, overlay] }));
  }

  addWatermark(text: string, options: { page?: number | 'all'; rect?: Rect; fontSize?: number; color?: string; rotation?: number; id?: string } = {}): void {
    const snapshot = this.snapshot;
    const rect = options.rect ?? { x: 72, y: 72, width: 300, height: 36 };
    const overlay: TextOverlay = { id: options.id ?? `watermark-${snapshot.revision + 1}`, page: options.page ?? 'all', kind: 'watermark', text, rect: assertRect(rect, 'watermark rect'), fontSize: options.fontSize ?? 24, color: options.color ?? '#9aa39d', rotation: normalizeRotation(options.rotation ?? 0) };
    this.session.apply(state => ({ ...state, overlays: [...state.overlays, overlay] }));
  }

  addRectangle(page: number, rect: Rect, options: Omit<ShapeOverlay, 'id' | 'page' | 'rect' | 'kind'> & { id?: string } = {}): void {
    const snapshot = this.snapshot;
    assertPage(page, snapshot.pages.length);
    const { id: requestedId, ...shape } = options;
    const overlay: ShapeOverlay = { ...shape, id: requestedId ?? `shape-${snapshot.revision + snapshot.overlays.length + 1}`, page, kind: 'rectangle', rect: assertRect(rect, 'rectangle') };
    this.session.apply(state => ({ ...state, overlays: [...state.overlays, overlay] }));
  }

  addEllipse(page: number, rect: Rect, options: Omit<ShapeOverlay, 'id' | 'page' | 'rect' | 'kind'> & { id?: string } = {}): void {
    const snapshot = this.snapshot;
    assertPage(page, snapshot.pages.length);
    const { id: requestedId, ...shape } = options;
    const overlay: ShapeOverlay = { ...shape, id: requestedId ?? `ellipse-${snapshot.revision + snapshot.overlays.length + 1}`, page, kind: 'ellipse', rect: assertRect(rect, 'ellipse') };
    this.session.apply(state => ({ ...state, overlays: [...state.overlays, overlay] }));
  }

  addImage(page: number, bytes: Uint8Array, format: ImageFormat, rect: Rect, options: { id?: string; rotation?: number; opacity?: number } = {}): void {
    const snapshot = this.snapshot;
    assertPage(page, snapshot.pages.length);
    if (bytes.length === 0) throw new EditorError('Image overlay needs non-empty bytes.');
    const overlay: ImageOverlay = { id: options.id ?? `image-${snapshot.revision + snapshot.overlays.length + 1}`, page, kind: 'image', rect: assertRect(rect, 'image rect'), format, bytes: cloneBytes(bytes), rotation: options.rotation, opacity: options.opacity };
    this.session.apply(state => ({ ...state, overlays: [...state.overlays, overlay] }));
  }

  editText(blockId: string, text: string, options: { kind?: EditorTextKind; color?: string; paperColor?: string; fontSize?: number; id?: string } = {}): void {
    const block = this.blocks.get(blockId);
    if (!block) throw new EditorError(`Unknown IR block: ${blockId}.`);
    const existing = this.snapshot.edits.find(edit => edit.blockId === blockId && (options.kind ?? 'source') === edit.kind);
    const edit: EditorTextEdit = { id: options.id ?? existing?.id ?? `edit-${blockId}-${options.kind ?? 'source'}`, pageId: block.pageId, blockId, kind: options.kind ?? 'source', sourceText: block.text, text, rect: cloneRect(block.rect), fontSize: options.fontSize ?? block.fontSize, color: options.color ?? DEFAULT_INK, paperColor: options.paperColor ?? DEFAULT_PAPER, rotation: 0 };
    this.session.apply(state => ({ ...state, edits: [...state.edits.filter(item => item.id !== edit.id), edit] }));
  }

  setTranslation(translation: Translation, options: EditorFromIrOptions = {}): void {
    const block = this.blocks.get(translation.blockId);
    if (!block) return;
    this.editText(translation.blockId, translation.text, { kind: 'translation', paperColor: options.paperColor ?? DEFAULT_PAPER, fontSize: block.fontSize });
  }

  rotatePage(page: number, angle: number): void {
    const snapshot = this.snapshot;
    assertPage(page, snapshot.pages.length);
    const pageId = snapshot.pages[page - 1]!.id;
    this.session.apply(state => ({ ...state, rotations: { ...state.rotations, [pageId]: normalizeRotation((state.rotations[pageId] ?? 0) + angle) } }));
  }

  reorderPages(order: readonly number[]): void {
    const snapshot = this.snapshot;
    if (order.length !== snapshot.pages.length || new Set(order).size !== order.length || order.some(index => !Number.isInteger(index) || index < 0 || index >= snapshot.pages.length)) {
      throw new EditorError('Page order must be a complete permutation of the current pages.');
    }
    this.session.apply(state => ({ ...state, pages: order.map(index => state.pages[index]!) }));
  }

  deletePages(pages: readonly number[]): void {
    const snapshot = this.snapshot;
    const remove = new Set(pages.map(page => assertPage(page, snapshot.pages.length) - 1));
    if (remove.size >= snapshot.pages.length) throw new EditorError('Deleting every page would create an invalid PDF.');
    this.session.apply(state => ({ ...state, pages: state.pages.filter((_, index) => !remove.has(index)) }));
  }

  splitPage(page: number, axis: PageAxis, at: number): void {
    const snapshot = this.snapshot;
    assertPage(page, snapshot.pages.length);
    if (!Number.isFinite(at) || at <= 0 || at >= 1) throw new EditorError('Split position must be a fraction strictly between 0 and 1.');
    const target = snapshot.pages[page - 1]!;
    const first: EditorPageRef = { ...target, id: `${target.id}:a`, crop: undefined, cropFraction: { axis, from: 0, to: at } };
    const second: EditorPageRef = { ...target, id: `${target.id}:b`, crop: undefined, cropFraction: { axis, from: at, to: 1 } };
    this.session.apply(state => ({ ...state, pages: [...state.pages.slice(0, page - 1), first, second, ...state.pages.slice(page)] }));
  }

  async appendDocument(bytes: Uint8Array, id = `merged-${this.snapshot.revision + 1}`): Promise<void> {
    if (bytes.length === 0) throw new EditorError('Merged PDF needs non-empty bytes.');
    const source: EditorSource = { id, bytes: cloneBytes(bytes) };
    this.sources.push(source);
    const document = await sourcePages(source);
    const additions = document.getPages().map((_, index) => ({ id: pageRefId(source.id, index, this.snapshot.revision + 1), sourceId: source.id, sourceIndex: index }));
    this.session.apply(state => ({ ...state, pages: [...state.pages, ...additions] }));
  }

  setMetadata(metadata: EditorMetadata): void {
    this.session.apply(state => ({ ...state, metadata: { ...(state.metadata ?? {}), ...metadata } }));
  }

  async build(options: EditorBuildOptions = {}): Promise<EditorBuildResult> {
    const snapshot = this.snapshot;
    const sourceDocuments = new Map<string, PDFDocument>();
    for (const source of this.sources) sourceDocuments.set(source.id, await sourcePages(source));
    const base = sourceDocuments.get(this.source.id);
    if (!base) throw new EditorError('The source PDF could not be loaded.');
    const originalPageCount = base.getPageCount();
    const originalForms = fieldNames(base);
    const needsRebuild = snapshot.pages.some(page => page.sourceId !== this.source.id || page.crop !== undefined || page.cropFraction !== undefined);
    const samePageTree = snapshot.pages.length === originalPageCount && snapshot.pages.every((page, index) => page.sourceId === this.source.id && page.sourceIndex === index);
    let document: PDFDocument;
    const outputPageIds: string[] = [];
    const limitations: string[] = [];
    if (snapshot.edits.length > 0) limitations.push('Text replacement is a searchable overlay over immutable source content; the original glyphs remain in the source content stream. Use redactPdfWithSanitizedRasters for irreversible removal.');
    if (!needsRebuild) {
      document = base;
      const originalPages = document.getPages().slice();
      for (let index = originalPages.length - 1; index >= 0; index -= 1) document.removePage(index);
      snapshot.pages.forEach((pageRef, index) => {
        const page = originalPages[pageRef.sourceIndex];
        if (!page) throw new EditorError(`Page ${pageRef.sourceIndex + 1} is not present in the source PDF.`);
        document.insertPage(index, page);
        outputPageIds.push(pageRef.id);
      });
    } else {
      document = await PDFDocument.create();
      limitations.push('Page split, merge, extraction or cross-document composition rebuilds the page tree. Existing AcroForm widgets and outline destinations are not copied across rebuilt pages.');
      for (const pageRef of snapshot.pages) {
        const sourceDocument = sourceDocuments.get(pageRef.sourceId);
        if (!sourceDocument) throw new EditorError(`Missing source document ${pageRef.sourceId}.`);
        const copied = await document.copyPages(sourceDocument, [pageRef.sourceIndex]);
        const page = copied[0];
        if (!page) throw new EditorError(`Missing source page ${pageRef.sourceIndex + 1}.`);
        document.addPage(page);
        if (pageRef.crop || pageRef.cropFraction) {
          const original = sourceDocument.getPages()[pageRef.sourceIndex];
          if (original) {
            const crop = pageRef.crop ?? (() => {
              const fraction = pageRef.cropFraction!;
              return fraction.axis === 'vertical'
                ? { x: original.getWidth() * fraction.from, y: 0, width: original.getWidth() * (fraction.to - fraction.from), height: original.getHeight() }
                : { x: 0, y: original.getHeight() * fraction.from, width: original.getWidth(), height: original.getHeight() * (fraction.to - fraction.from) };
            })();
            page.setCropBox(crop.x, original.getHeight() - crop.y - crop.height, crop.width, crop.height);
          }
        }
        outputPageIds.push(pageRef.id);
      }
    }
    const fonts = await registerPdfFonts(document, options.fonts);
    const embeddedImages = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>> | Awaited<ReturnType<PDFDocument['embedJpg']>>>();
    for (const overlay of snapshot.overlays) {
      if (overlay.kind !== 'image') continue;
      embeddedImages.set(overlay.id, overlay.format === 'png' ? await document.embedPng(overlay.bytes) : await document.embedJpg(overlay.bytes));
    }
    const editsByPage = new Map<string, EditorTextEdit[]>();
    for (const edit of snapshot.edits) {
      const list = editsByPage.get(edit.pageId) ?? [];
      list.push(edit);
      editsByPage.set(edit.pageId, list);
    }
    let translationCount = 0;
    for (let index = 0; index < document.getPages().length; index += 1) {
      const page = document.getPages()[index]!;
      const pageId = outputPageIds[index]!;
      const rotation = snapshot.rotations[pageId] ?? 0;
      if (rotation) page.setRotation(degrees(rotation));
      const edits = editsByPage.get(pageId) ?? [];
      for (const edit of edits) {
        const result = drawTextInRect(page, fonts, edit.text, edit.rect, { fontSize: edit.fontSize, color: edit.color, paperColor: edit.paperColor, rotation: edit.rotation });
        if (result.truncated) limitations.push(`Edit ${edit.id} overflowed its source rectangle and was marked with the reflow fit result.`);
        if (result.folded) limitations.push(`Edit ${edit.id} required font coverage preparation; unsupported glyphs may be folded or dropped.`);
        if (edit.kind === 'translation') translationCount += 1;
      }
      for (const overlay of snapshot.overlays) {
        if (overlay.page !== 'all' && overlay.page !== index + 1) continue;
        drawOverlay(page, overlay, fonts, embeddedImages);
      }
    }
    applyMetadata(document, snapshot.metadata);
    if (options.producer) document.setProducer(options.producer);
    const bytes = await document.save(options.saveOptions);
    const outputForms = fieldNames(document);
    const formsPreserved = sameStrings(originalForms, outputForms);
    return {
      bytes,
      pageCount: document.getPageCount(),
      sourcePageCount: originalPageCount,
      overlayCount: snapshot.overlays.length,
      editCount: snapshot.edits.length,
      translationCount,
      preserved: { metadata: true, forms: formsPreserved, outlines: samePageTree },
      limitations,
    };
  }
}

export function editorSnapshotFromIr(ir: DocumentIR): EditorSnapshot {
  return {
    revision: 0,
    pages: ir.pages.map((page, index) => ({ id: pageRefId(ir.documentId || 'source', index, 0), sourceId: ir.documentId || 'source', sourceIndex: index })),
    rotations: Object.fromEntries(ir.pages.map((page, index) => [pageRefId(ir.documentId || 'source', index, 0), page.rotation])),
    edits: [],
    overlays: [],
  };
}

export function translationArtifacts(ir: DocumentIR, lang?: string): Translation[] {
  return ir.translations.filter(translation => lang === undefined || translation.lang === lang);
}

export function blockPageRect(ir: DocumentIR, blockId: string): Rect | null {
  const block = ir.blocks.find(entry => entry.id === blockId);
  if (!block) return null;
  const page = ir.pages.find(entry => entry.index === block.page);
  return page ? blockRect(block, page) : null;
}

export const EDITOR_DEFAULTS = {
  paperColor: DEFAULT_PAPER,
  inkColor: DEFAULT_INK,
  borderColor: DEFAULT_BORDER,
  fontSize: DEFAULT_FONT_SIZE,
  lineHeight: DEFAULT_LINE_HEIGHT,
  baselineRatio: DEFAULT_BASELINE_RATIO,
  fallbackFont: StandardFonts.Helvetica,
  grayscale,
};
