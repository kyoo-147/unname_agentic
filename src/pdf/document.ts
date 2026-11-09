import { getDocument, GlobalWorkerOptions, OPS, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PageModel } from '../core/types';
import { groupTextItems, type PdfTextItem } from './layout';
GlobalWorkerOptions.workerSrc = workerUrl;

export interface RenderedPage { page: PDFPageProxy; model: PageModel; original: HTMLCanvasElement; background: HTMLCanvasElement | null; warning: string }
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

export async function renderPage(document: PDFDocumentProxy, number: number): Promise<RenderedPage> {
  const page = await document.getPage(number);
  const viewport = page.getViewport({scale:1});
  const content = await page.getTextContent();
  const model: PageModel = { number, width:viewport.width, height:viewport.height, blocks:groupTextItems(content.items.filter((item): item is typeof item & PdfTextItem => 'str' in item),viewport.transform,number,content.styles) };
  const scale = Math.min(window.devicePixelRatio || 1,2) * 1.25;
  const rasterViewport = page.getViewport({scale});
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
  if (unsafe || type3 || model.blocks.some(block=>Math.abs(block.rotation)>.5)) warning='Complex text, clipping, or rotated glyphs: translations open in a paired reading view; source pixels are preserved.';
  else {
    background = documentCanvas(rasterViewport.width,rasterViewport.height);
    const context = background.getContext('2d')!;
    await page.render({ canvas:null, canvasContext:suppressTextContext(context), viewport:rasterViewport }).promise;
  }
  if (!model.blocks.length) warning='No embedded text found. This scanned or outlined page needs OCR; the original remains available.';
  return { page,model,original,background,warning };
}
function documentCanvas(width: number,height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width=Math.ceil(width); canvas.height=Math.ceil(height);
  return canvas;
}
