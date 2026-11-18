import { describe, expect, it } from 'vitest';
import { groupTextItems } from '../src/pdf/layout';
import { mapOcrBlocksToPage } from '../src/ocr/scan';

// Block ids are the key the reader stores translations under. If an id changes
// between two extractions of the same page, the translation silently detaches
// from its block, so the scheme itself has to be pinned here.
const viewport = [1, 0, 0, -1, 0, 800];

const items = [
  { str: 'Title', transform: [18, 0, 0, 18, 40, 760], width: 60, height: 18 },
  { str: 'Body line', transform: [10, 0, 0, 10, 40, 730], width: 90, height: 10 },
  { str: 'Footer', transform: [8, 0, 0, 8, 40, 700], width: 45, height: 8 },
];

describe('stable block ids', () => {
  it('names every PDF block with page and reading order', () => {
    const blocks = groupTextItems(items, viewport, 3);
    expect(blocks.map(block => block.id)).toEqual(['p3-r0', 'p3-r1', 'p3-r2']);
    expect(blocks.map(block => block.text)).toEqual(['Title', 'Body line', 'Footer']);
  });

  it('produces the same ids for the same page twice', () => {
    const first = groupTextItems(items, viewport, 2).map(block => block.id);
    const second = groupTextItems([...items], viewport, 2).map(block => block.id);
    expect(second).toEqual(first);
  });

  it('keeps ids unique and page-scoped across pages', () => {
    const page1 = groupTextItems(items, viewport, 1).map(block => block.id);
    const page2 = groupTextItems(items, viewport, 2).map(block => block.id);
    const all = [...page1, ...page2];
    expect(new Set(all).size).toBe(all.length);
    expect(page1.every(id => id.startsWith('p1-'))).toBe(true);
    expect(page2.every(id => id.startsWith('p2-'))).toBe(true);
  });

  it('names OCR blocks deterministically without colliding with PDF blocks', () => {
    const rects = [{ text: 'Scanned line one', rect: { x: 10, y: 10, width: 100, height: 20 } }, { text: 'Scanned line two', rect: { x: 10, y: 40, width: 100, height: 20 } }];
    const blocks = mapOcrBlocksToPage(rects, 200, 200, 600, 600, 4);
    expect(blocks.map(block => block.id)).toEqual(['ocr-p4-1', 'ocr-p4-2']);
    const again = mapOcrBlocksToPage(rects, 200, 200, 600, 600, 4);
    expect(again.map(block => block.id)).toEqual(blocks.map(block => block.id));
    // An OCR id must never look like a PDF id, or a rescanned page would overwrite
    // translations that belong to a different block.
    expect(blocks.every(block => !/^p\d+-r\d+$/.test(block.id))).toBe(true);
  });

  it('scales OCR boxes from image pixels to page points', () => {
    const blocks = mapOcrBlocksToPage([{ text: 'Line', rect: { x: 10, y: 20, width: 50, height: 10 } }], 100, 100, 600, 300, 1);
    expect(blocks[0]?.rect).toEqual({ x: 60, y: 60, width: 300, height: 30 });
  });
});
