import { getDocument, GlobalWorkerOptions, OPS, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PageModel } from '../core/types';
import { groupTextItems, normalizeRotation, readPageTextItems, rotatePageSize, rotateRect, searchTextPage, type PageRotation, type PageTextItem, type PdfTextItem, type SearchMatch } from './layout';
GlobalWorkerOptions.workerSrc = workerUrl;

export interface RenderedPage { page: PDFPageProxy; model: PageModel; original: HTMLCanvasElement; background: HTMLCanvasElement | null; warning: string; rotation: PageRotation }
export interface RenderPageOptions { rotation?: number }
export interface OutlineEntry { title: string; page: number; depth: number }
export type { PageTextItem, SearchMatch };
export interface PdfPageLike {
  getViewport(params: { scale: number; rotation?: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: unknown[] }>;
  render(params: { canvas?: HTMLCanvasElement | null; viewport: unknown }): { promise: Promise<void> };
}
export interface PdfDocumentLike {
  numPages: number;
  getPage(number: number): Promise<PdfPageLike>;
  getOutline?(): Promise<OutlineLike[] | null>;
  getDestination?(id: string): Promise<unknown[] | null>;
  getPageIndex?(ref: unknown): Promise<number>;
}
export interface OutlineLike { title: string; dest?: unknown; items?: OutlineLike[] }
export interface ThumbnailOptions { createCanvas?: (width: number, height: number) => HTMLCanvasElement; format?: string; quality?: number }
export interface Thumbnail { canvas: HTMLCanvasElement; dataUrl: string; width: number; height: number; page: number }

export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({ data:bytes }).promise;
}

export function suppressTextContext(context: CanvasRenderingContext2D): CanvasRenderingContext2D {
  return new Proxy(context, {
    get(target, key) {
      if (key === 'fillText' || key === 'strokeText') return () => undefined;
      const value: unknown = Reflect.get(target,key,target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target,key,value) { return Reflect.set(target,key,value,target); },
  });
}

export async function renderPage(document: PDFDocumentProxy, number: number, options: RenderPageOptions = {}): Promise<RenderedPage> {
  const page = await document.getPage(number);
  const rotation = normalizeRotation(options.rotation ?? 0);
  const viewport = page.getViewport(rotation ? {scale:1, rotation:page.rotate + rotation} : {scale:1});
  const content = await page.getTextContent();
  const textItems = content.items.filter((item): item is typeof item & PdfTextItem => 'str' in item);
  const baseViewport = rotation === 0 ? viewport : page.getViewport({scale:1});
  const baseModel: PageModel = { number, width:baseViewport.width, height:baseViewport.height, blocks:groupTextItems(textItems,baseViewport.transform,number,content.styles) };
  const model: PageModel = rotation === 0 ? baseModel : (() => {
    const size = rotatePageSize({width:baseViewport.width,height:baseViewport.height}, rotation);
    return { number, width:size.width, height:size.height, blocks:baseModel.blocks.map(block => ({...block, baseRect:block.rect, rect:rotateRect(block.rect,rotation,baseViewport.width,baseViewport.height), rotation:normalizeRotation(block.rotation + rotation)})) };
  })();
  const scale = Math.min(window.devicePixelRatio || 1,2) * 1.25;
  const rasterViewport = page.getViewport(rotation ? {scale, rotation:page.rotate + rotation} : {scale});
  const original = documentCanvas(rasterViewport.width,rasterViewport.height);
  await page.render({ canvas:original, viewport:rasterViewport }).promise;
  const operators = await page.getOperatorList();
  const unsafe = operators.fnArray.some((op,index) => op === OPS.beginGroup || op === OPS.paintFormXObjectBegin || (op === OPS.setTextRenderingMode && Number(operators.argsArray[index]?.[0]) >= 4));
  let type3 = false;
  for (const item of content.items) {
    if (!('fontName' in item)) continue;
    try { if (page.commonObjs.get(item.fontName)?.isType3Font) type3=true; } catch { type3=true; }
  }
  let background: HTMLCanvasElement | null = null;
  let warning = '';
  const rotatedGlyphs = rotation === 0 && model.blocks.some(block => Math.abs(block.rotation) > .5);
  if (unsafe || type3 || rotatedGlyphs) warning='Complex text, clipping, or rotated glyphs: translations open in a paired reading view; source pixels are preserved.';
  else {
    background = documentCanvas(rasterViewport.width,rasterViewport.height);
    const context = background.getContext('2d')!;
    await page.render({ canvas:null, canvasContext:suppressTextContext(context), viewport:rasterViewport }).promise;
  }
  if (!model.blocks.length) warning='No embedded text found. This scanned or outlined page needs OCR; the original remains available.';
  return { page,model,original,background,warning,rotation };
}

export async function getOutline(pdf: PdfDocumentLike): Promise<OutlineEntry[]> {
  if (!pdf.getOutline) return [];
  const nodes = await pdf.getOutline();
  if (!nodes?.length) return [];
  const entries: OutlineEntry[] = [];
  const visit = async (items: OutlineLike[], depth: number): Promise<void> => {
    for (const item of items) {
      const title = String(item.title ?? '').trim();
      if (title) entries.push({ title, page: await resolveOutlinePage(pdf,item.dest), depth });
      if (item.items?.length) await visit(item.items, depth + 1);
    }
  };
  await visit(nodes, 0);
  return entries;
}

export async function getPageText(pdf: PdfDocumentLike, number: number): Promise<PageTextItem[]> {
  const page = await pdf.getPage(number);
  const content = await page.getTextContent();
  return readPageTextItems(content.items);
}

export async function searchPdfPage(pdf: PdfDocumentLike, page: number, query: string): Promise<SearchMatch | null> {
  return searchTextPage(await getPageText(pdf,page),page,query);
}

export async function renderThumbnail(pdf: PdfDocumentLike, number: number, maxWidth: number, options: ThumbnailOptions = {}): Promise<Thumbnail> {
  const page = await pdf.getPage(number);
  const base = page.getViewport({ scale:1 });
  const target = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : 160;
  const scale = Math.min(1,target / Math.max(1,base.width));
  const viewport = page.getViewport({ scale });
  const width = Math.max(1,Math.ceil(viewport.width));
  const height = Math.max(1,Math.ceil(viewport.height));
  const canvas = options.createCanvas ? options.createCanvas(width,height) : document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  await page.render({ canvas, viewport }).promise;
  return { canvas, dataUrl:canvas.toDataURL(options.format ?? 'image/jpeg',options.quality ?? 0.72), width, height, page:number };
}


async function resolveOutlinePage(pdf: PdfDocumentLike, dest: unknown): Promise<number> {
  let value = dest;
  if (typeof value === 'string' && pdf.getDestination) {
    try { value = await pdf.getDestination(value); } catch { return 0; }
  }
  if (!Array.isArray(value) || !value.length) {
    if (value && typeof value === 'object' && pdf.getPageIndex) {
      try { return Math.max(0,(await pdf.getPageIndex(value)) + 1); } catch { return 0; }
    }
    return 0;
  }
  const first = value[0];
  if (typeof first === 'number') return Math.max(0,Math.trunc(first) + 1);
  if (first && typeof first === 'object' && pdf.getPageIndex) {
    try { return Math.max(0,(await pdf.getPageIndex(first)) + 1); } catch { return 0; }
  }
  return 0;
}

function documentCanvas(width: number,height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width=Math.ceil(width); canvas.height=Math.ceil(height);
  return canvas;
}
