import type { OutlineEntry, PageTextItem, PdfDocumentLike, SearchMatch } from '../pdf/document';
import { readPageTextItems, searchTextPage } from '../pdf/layout';

export type FitMode = 'width' | 'page' | 'actual';
export type ReaderIntent = 'next-page' | 'prev-page' | 'first-page' | 'last-page' | 'zoom-in' | 'zoom-out' | 'fit-width' | 'fit-page' | 'search' | 'escape' | 'outline' | 'none';
export type { OutlineEntry, PageTextItem, PdfDocumentLike, SearchMatch };

export interface Size { width: number; height: number }
export interface ScrollRow { page: number; top: number; height: number }
export interface OutlineNode { title: string; page?: number; depth?: number; items?: readonly OutlineNode[] }
export interface ReaderState { page: number; fraction: number; zoom: number; fit: FitMode }
export interface SearchOptions { limit?: number; signal?: AbortSignal; fromPage?: number; toPage?: number }
export interface KeyboardEventLike {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
}
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const READING_STATE_KEY = 'mirror.reading-state';
export const readerCopy = {
  outline: 'Mục lục',
  search: 'Tìm trong tài liệu',
  searchPlaceholder: 'Nhập từ cần tìm',
  searchEmpty: 'Không tìm thấy kết quả',
  searchBusy: 'Đang tìm…',
  searchHint: 'Không phân biệt hoa thường và dấu',
  clearSearch: 'Xoá nội dung tìm kiếm',
  thumbnails: 'Hình thu nhỏ',
  progress: 'Tiến độ đọc',
  close: 'Đóng',
  emptyOutline: 'Tài liệu này không có mục lục',
  noText: 'Trang này không có văn bản để tìm',
  page: 'Trang',
} as const;

export function fitScale(mode: FitMode, pageSize: Size, viewport: Size): number {
  if (mode === 'actual') return 1;
  if (![pageSize.width, pageSize.height, viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0)) return 1;
  if (mode === 'width') return viewport.width / pageSize.width;
  return Math.min(viewport.width / pageSize.width, viewport.height / pageSize.height);
}

export function pageForScroll(rows: readonly ScrollRow[], scrollTop: number): number {
  if (!rows.length) return 1;
  const ordered = [...rows].sort((left, right) => left.top - right.top);
  if (!Number.isFinite(scrollTop) || scrollTop <= ordered[0]!.top) return ordered[0]!.page;
  for (const row of ordered) if (scrollTop < row.top + Math.max(0,row.height)) return row.page;
  return ordered[ordered.length - 1]!.page;
}

export function readingFraction(rows: readonly ScrollRow[], scrollTop: number): number {
  if (!rows.length) return 0;
  const page = pageForScroll(rows, scrollTop);
  const row = rows.find(candidate => candidate.page === page);
  if (!row || !Number.isFinite(row.height) || row.height <= 0) return 0;
  const fraction = (scrollTop - row.top) / row.height;
  return Math.max(0,Math.min(1,Number.isFinite(fraction) ? fraction : 0));
}

export function keyboardIntent(event: KeyboardEventLike): ReaderIntent {
  const target = event.target as { tagName?: unknown; isContentEditable?: unknown } | null | undefined;
  const tag = typeof target?.tagName === 'string' ? target.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable === true) return 'none';
  if (event.altKey) return 'none';
  const key = event.key;
  const modified = event.ctrlKey === true || event.metaKey === true;
  if (modified) {
    switch (key.toLowerCase()) {
      case 'f': return 'search';
      case '1': return 'fit-width';
      case '2': return 'fit-page';
      case '+': case '=': return 'zoom-in';
      case '-': case '_': return 'zoom-out';
      default: return 'none';
    }
  }
  if (key === 'Escape') return 'escape';
  if (key === ' ') return event.shiftKey ? 'prev-page' : 'next-page';
  switch (key) {
    case 'PageDown': case 'ArrowDown': case 'j': case 'J': return 'next-page';
    case 'PageUp': case 'ArrowUp': case 'k': case 'K': return 'prev-page';
    case 'Home': return 'first-page';
    case 'End': return 'last-page';
    case '+': case '=': case 'Add': return 'zoom-in';
    case '-': case '_': case 'Subtract': return 'zoom-out';
    case 'w': case 'W': return 'fit-width';
    case 'f': case 'F': return 'fit-page';
    case 'o': case 'O': return 'outline';
    case '/': return 'search';
    default: return 'none';
  }
}

export function flattenOutline(nodes: readonly OutlineNode[], depth = 0): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  for (const node of nodes) {
    const title = String(node.title ?? '').trim();
    const nodeDepth = Number.isInteger(node.depth) ? node.depth! : depth;
    if (title) entries.push({ title, page:Number.isInteger(node.page) && (node.page ?? 0) > 0 ? node.page! : 0, depth:nodeDepth });
    if (node.items?.length) entries.push(...flattenOutline(node.items, nodeDepth + 1));
  }
  return entries;
}

export async function searchAllPages(pdf: PdfDocumentLike, query: string, options: SearchOptions = {}): Promise<SearchMatch[]> {
  if (!query.trim()) return [];
  const limit = Math.max(1,Math.floor(options.limit ?? 50));
  const from = Math.max(1,Math.floor(options.fromPage ?? 1));
  const to = Math.min(pdf.numPages,Math.floor(options.toPage ?? pdf.numPages));
  const matches: SearchMatch[] = [];
  for (let page = from; page <= to && matches.length < limit; page++) {
    throwIfAborted(options.signal);
    const source = await pdf.getPage(page);
    const content = await source.getTextContent();
    const match = searchTextPage(readPageTextItems(content.items),page,query);
    throwIfAborted(options.signal);
    if (match) matches.push(match);
  }
  return matches;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function encodeReadingState(state: ReaderState): string {
  return JSON.stringify({
    version: 1,
    page: Math.max(1,Math.trunc(Number.isFinite(state.page) ? state.page : 1)),
    fraction: round(Math.max(0,Math.min(1,Number.isFinite(state.fraction) ? state.fraction : 0)),4),
    zoom: round(Math.max(.25,Math.min(4,Number.isFinite(state.zoom) ? state.zoom : 1)),3),
    fit: state.fit === 'page' || state.fit === 'actual' ? state.fit : 'width',
  });
}

export function decodeReadingState(raw: string | null | undefined): ReaderState | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if ('version' in candidate && candidate.version !== 1) return null;
    const { page, fraction, zoom, fit } = candidate;
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return null;
    if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
    if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < .25 || zoom > 4) return null;
    if (fit !== 'width' && fit !== 'page' && fit !== 'actual') return null;
    return { page, fraction, zoom, fit };
  } catch { return null; }
}

export function saveReadingState(storage: StorageLike, state: ReaderState, key = READING_STATE_KEY): boolean {
  try { storage.setItem(key,encodeReadingState(state)); return true; } catch { return false; }
}

export function loadReadingState(storage: StorageLike | null | undefined, key = READING_STATE_KEY): ReaderState | null {
  try { return decodeReadingState(storage?.getItem(key) ?? null); } catch { return null; }
}

export function clearReadingState(storage: StorageLike | null | undefined, key = READING_STATE_KEY): void {
  try { storage?.removeItem?.(key); } catch { return; }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Search cancelled');
  error.name = 'AbortError';
  throw error;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
