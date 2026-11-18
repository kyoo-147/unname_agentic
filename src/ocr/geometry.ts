import type { PageModel, Rect, TextBlock } from '../core/types';
import type { OcrBbox, OcrWord } from './engine';

export interface MergeOptions {
  lineGap?: number;
  maxChars?: number;
}

export type OcrBlock = Omit<TextBlock, 'id' | 'page'>;

export const DEFAULT_LINE_GAP = 1;
export const DEFAULT_MAX_CHARS = 1200;

const RTL_CHAR = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u;

interface LineFragment {
  text: string;
  words: OcrWord[];
  bbox: OcrBbox;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : ((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function widthOf(box: OcrBbox): number {
  return box.x1 - box.x0;
}

function heightOf(box: OcrBbox): number {
  return box.y1 - box.y0;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function unionBbox(boxes: OcrBbox[]): OcrBbox {
  return {
    x0: Math.min(...boxes.map(box => box.x0)),
    y0: Math.min(...boxes.map(box => box.y0)),
    x1: Math.max(...boxes.map(box => box.x1)),
    y1: Math.max(...boxes.map(box => box.y1)),
  };
}

export function normalizeBbox(box: OcrBbox, imageWidth?: number, imageHeight?: number): OcrBbox | undefined {
  const values = [box.x0, box.y0, box.x1, box.y1];
  if (!values.every(Number.isFinite)) return undefined;
  let x0 = Math.min(box.x0, box.x1);
  let y0 = Math.min(box.y0, box.y1);
  let x1 = Math.max(box.x0, box.x1);
  let y1 = Math.max(box.y0, box.y1);
  const maxWidth = imageWidth !== undefined && Number.isFinite(imageWidth) && imageWidth > 0 ? imageWidth : undefined;
  const maxHeight = imageHeight !== undefined && Number.isFinite(imageHeight) && imageHeight > 0 ? imageHeight : undefined;
  if (maxWidth !== undefined) {
    x0 = clamp(x0, 0, maxWidth);
    x1 = clamp(x1, 0, maxWidth);
  }
  if (maxHeight !== undefined) {
    y0 = clamp(y0, 0, maxHeight);
    y1 = clamp(y1, 0, maxHeight);
  }
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x0, y0, x1, y1 };
}

export function normalizeRect(rect: Rect, imageWidth?: number, imageHeight?: number): Rect | undefined {
  const box = normalizeBbox(
    { x0: rect.x, y0: rect.y, x1: rect.x + rect.width, y1: rect.y + rect.height },
    imageWidth,
    imageHeight,
  );
  if (!box) return undefined;
  return { x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0 };
}

function groupLines(words: OcrWord[]): LineFragment[] {
  const sorted = [...words].sort((a, b) => {
    const centerA = (a.bbox.y0 + a.bbox.y1) / 2;
    const centerB = (b.bbox.y0 + b.bbox.y1) / 2;
    return centerA - centerB || a.bbox.x0 - b.bbox.x0;
  });
  const lines: OcrWord[][] = [];
  for (const word of sorted) {
    const center = (word.bbox.y0 + word.bbox.y1) / 2;
    const height = heightOf(word.bbox);
    let target: OcrWord[] | undefined;
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!;
      const lineBox = unionBbox(line.map(entry => entry.bbox));
      const lineCenter = (lineBox.y0 + lineBox.y1) / 2;
      const overlap = Math.min(word.bbox.y1, lineBox.y1) - Math.max(word.bbox.y0, lineBox.y0);
      const minHeight = Math.max(1, Math.min(height, heightOf(lineBox)));
      if (overlap / minHeight >= 0.5 && Math.abs(center - lineCenter) <= Math.max(height, heightOf(lineBox)) * 0.6) {
        target = line;
        break;
      }
    }
    if (target) target.push(word);
    else lines.push([word]);
  }

  const fragments: LineFragment[] = [];
  for (const line of lines) {
    const ordered = [...line].sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const lineHeight = median(ordered.map(word => heightOf(word.bbox)));
    const charWidth = median(ordered.map(word => widthOf(word.bbox) / Math.max(1, word.text.length)));
    const gapLimit = Math.max(lineHeight * 1.5, charWidth * 3, 6);
    let current: OcrWord[] = [];
    const flush = () => {
      if (!current.length) return;
      const boxes = current.map(word => word.bbox);
      fragments.push({
        text: normalizeText(current.map(word => word.text).join(' ')),
        words: [...current],
        bbox: unionBbox(boxes),
      });
      current = [];
    };
    for (const word of ordered) {
      const previous = current[current.length - 1];
      if (previous && word.bbox.x0 - previous.bbox.x1 > gapLimit) flush();
      current.push(word);
    }
    flush();
  }
  return fragments;
}

function findColumnGap(fragments: LineFragment[]): number | undefined {
  if (fragments.length < 4) return undefined;
  const minGap = Math.max(8, median(fragments.map(fragment => heightOf(fragment.bbox))) * 2);
  const intervals = fragments
    .map(fragment => [fragment.bbox.x0, fragment.bbox.x1] as const)
    .sort((a, b) => a[0] - b[0]);
  let reach = intervals[0]![1];
  let best: { gap: number; middle: number } | undefined;
  for (const [x0, x1] of intervals.slice(1)) {
    const gap = x0 - reach;
    if (gap >= minGap && (!best || gap > best.gap)) best = { gap, middle: (reach + x0) / 2 };
    reach = Math.max(reach, x1);
  }
  if (!best) return undefined;
  const left = fragments.filter(fragment => fragment.bbox.x1 <= best.middle).length;
  const right = fragments.filter(fragment => fragment.bbox.x0 >= best.middle).length;
  if (!left || !right || left + right !== fragments.length) return undefined;
  return best.middle;
}

function findHorizontalGap(fragments: LineFragment[]): number | undefined {
  if (fragments.length < 2) return undefined;
  const minGap = Math.max(4, median(fragments.map(fragment => heightOf(fragment.bbox))) * 1.2);
  const intervals = fragments
    .map(fragment => [fragment.bbox.y0, fragment.bbox.y1] as const)
    .sort((a, b) => a[0] - b[0]);
  let reach = intervals[0]![1];
  let best: { gap: number; middle: number } | undefined;
  for (const [y0, y1] of intervals.slice(1)) {
    const gap = y0 - reach;
    if (gap >= minGap && (!best || gap > best.gap)) best = { gap, middle: (reach + y0) / 2 };
    reach = Math.max(reach, y1);
  }
  if (!best) return undefined;
  const top = fragments.filter(fragment => fragment.bbox.y1 <= best.middle).length;
  const bottom = fragments.filter(fragment => fragment.bbox.y0 >= best.middle).length;
  if (!top || !bottom || top + bottom !== fragments.length) return undefined;
  return best.middle;
}

function inReadingOrder(fragments: LineFragment[]): LineFragment[] {
  if (fragments.length < 2) return fragments;
  const column = findColumnGap(fragments);
  if (column !== undefined) {
    const left = fragments.filter(fragment => fragment.bbox.x1 <= column);
    const right = fragments.filter(fragment => fragment.bbox.x0 >= column);
    return [...inReadingOrder(left), ...inReadingOrder(right)];
  }
  const row = findHorizontalGap(fragments);
  if (row !== undefined) {
    const top = fragments.filter(fragment => fragment.bbox.y1 <= row);
    const bottom = fragments.filter(fragment => fragment.bbox.y0 >= row);
    return [...inReadingOrder(top), ...inReadingOrder(bottom)];
  }
  return [...fragments].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
}

function horizontalOverlap(a: OcrBbox, b: OcrBbox): number {
  const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  if (overlap <= 0) return 0;
  return overlap / Math.max(1, Math.min(widthOf(a), widthOf(b)));
}

export function mergeWordsToBlocks(words: OcrWord[], options: MergeOptions = {}): OcrBlock[] {
  const lineGap = options.lineGap ?? DEFAULT_LINE_GAP;
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  const cleaned = words.flatMap(word => {
    const text = normalizeText(word.text);
    const bbox = normalizeBbox(word.bbox);
    if (!text || !bbox) return [];
    return [{ ...word, text, bbox }];
  });
  if (!cleaned.length) return [];

  const fragments = inReadingOrder(groupLines(cleaned));
  const medianHeight = median(fragments.map(fragment => heightOf(fragment.bbox)));
  interface WorkingBlock {
    fragments: LineFragment[];
    bbox: OcrBbox;
    chars: number;
  }
  const blocks: WorkingBlock[] = [];
  for (const fragment of fragments) {
    const current = blocks[blocks.length - 1];
    const gap = current ? fragment.bbox.y0 - current.bbox.y1 : Number.POSITIVE_INFINITY;
    const overlap = current ? horizontalOverlap(current.bbox, fragment.bbox) : 0;
    const fits = current
      && gap <= lineGap * medianHeight
      && overlap >= 0.15
      && current.chars + fragment.text.length + 1 <= maxChars;
    if (!current || !fits) {
      blocks.push({ fragments: [fragment], bbox: fragment.bbox, chars: fragment.text.length });
      continue;
    }
    current.fragments.push(fragment);
    current.bbox = unionBbox([current.bbox, fragment.bbox]);
    current.chars += fragment.text.length + 1;
  }

  return blocks.map(block => {
    const text = normalizeText(block.fragments.map(fragment => fragment.text).join(' '));
    const wordHeights = block.fragments.flatMap(fragment => fragment.words.map(word => heightOf(word.bbox)));
    const fontSize = Math.max(1, Math.round(median(wordHeights) * 10) / 10);
    const rtl = RTL_CHAR.test(text);
    return {
      text,
      rect: {
        x: block.bbox.x0,
        y: block.bbox.y0,
        width: block.bbox.x1 - block.bbox.x0,
        height: block.bbox.y1 - block.bbox.y0,
      },
      fontSize,
      fontFamily: 'sans-serif',
      color: '#000000',
      direction: rtl ? 'rtl' : 'ltr',
      rotation: 0,
    } satisfies OcrBlock;
  });
}

export function blocksToPageModel(
  blocks: OcrBlock[],
  imageWidth: number,
  imageHeight: number,
  page: number,
): PageModel {
  const pageNumber = Number.isInteger(page) && page > 0 ? page : 1;
  const maxX = Math.max(0, ...blocks.map(block => block.rect.x + block.rect.width));
  const maxY = Math.max(0, ...blocks.map(block => block.rect.y + block.rect.height));
  const width = Number.isFinite(imageWidth) && imageWidth > 0 ? imageWidth : Math.max(1, maxX);
  const height = Number.isFinite(imageHeight) && imageHeight > 0 ? imageHeight : Math.max(1, maxY);
  const modelBlocks: TextBlock[] = [];
  for (const block of blocks) {
    const text = normalizeText(block.text);
    const rect = normalizeRect(block.rect, width, height);
    if (!text || !rect) continue;
    modelBlocks.push({
      id: `ocr-p${pageNumber}-${modelBlocks.length + 1}`,
      page: pageNumber,
      text,
      rect,
      fontSize: Math.max(1, block.fontSize),
      fontFamily: block.fontFamily,
      color: block.color,
      direction: block.direction,
      rotation: block.rotation,
    });
  }
  return { number: pageNumber, width, height, blocks: modelBlocks };
}
