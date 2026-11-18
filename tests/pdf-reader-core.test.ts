import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('pdfjs-dist', () => ({
  getDocument: () => ({ promise:Promise.resolve({}) }),
  GlobalWorkerOptions: { workerSrc:'' },
  OPS: { beginGroup:1, paintFormXObjectBegin:2, setTextRenderingMode:3 },
}));

import { getOutline, getPageText, renderPage, renderThumbnail, searchPdfPage, type PdfDocumentLike } from '../src/pdf/document';
import {
  clearReadingState,
  decodeReadingState,
  encodeReadingState,
  fitScale,
  flattenOutline,
  isAbortError,
  keyboardIntent,
  loadReadingState,
  pageForScroll,
  readingFraction,
  saveReadingState,
  searchAllPages,
  type StorageLike,
} from '../src/ui/reader';

interface RenderCall { canvas?: HTMLCanvasElement | null; viewport: { width: number; height: number } }

function makePage(texts: string[], size = { width:600, height:800 }) {
  const renders: RenderCall[] = [];
  return {
    renders,
    getViewport: ({ scale }: { scale: number }) => ({ width:size.width * scale, height:size.height * scale }),
    getTextContent: async () => ({
      items:texts.map((str,index) => ({
        str,
        transform:[1,0,0,1,0,0],
        width:str.length * 5,
        height:10,
        dir:'ltr',
        fontName:`f${index}`,
        hasEOL:false,
      })),
    }),
    render: (params: { canvas?: HTMLCanvasElement | null; viewport: { width:number; height:number } }) => {
      renders.push(params);
      return { promise:Promise.resolve() };
    },
  };
}

function makePdf(pages: ReturnType<typeof makePage>[], outline?: unknown[]) {
  return {
    numPages:pages.length,
    getPage: async (number: number) => {
      const page = pages[number - 1];
      if (!page) throw new Error(`Missing page ${number}`);
      return page;
    },
    getOutline: outline ? async () => outline : undefined,
  } as unknown as PdfDocumentLike;
}

describe('outline', () => {
  it('flattens nested outline nodes with page numbers and depth', () => {
    const entries = flattenOutline([
      { title:'Chương một', page:1, items:[{ title:'Mục nhỏ', page:2 }] },
      { title:'Phụ lục', page:7 },
      { title:'  ', page:3 },
      { title:'Không có đích' },
    ]);
    expect(entries).toEqual([
      { title:'Chương một', page:1, depth:0 },
      { title:'Mục nhỏ', page:2, depth:1 },
      { title:'Phụ lục', page:7, depth:0 },
      { title:'Không có đích', page:0, depth:0 },
    ]);
    expect(flattenOutline([{ title:'Sẵn phẳng', page:3, depth:2 }])).toEqual([{ title:'Sẵn phẳng', page:3, depth:2 }]);
  });

  it('resolves PDF destinations and page references to one-based pages', async () => {
    const pdf = {
      ...makePdf([makePage(['a']), makePage(['b']), makePage(['c'])]),
      getDestination: async (id: string) => id === 'appendix' ? [2] : null,
      getPageIndex: async (ref: unknown) => (ref as { num:number }).num,
    } as PdfDocumentLike;
    pdf.getOutline = async () => [
      { title:'Chương một', dest:[0], items:[{ title:'Mục nhỏ', dest:{ num:1 } }] },
      { title:'Phụ lục', dest:'appendix' },
      { title:'Không rõ', dest:'missing' },
    ];
    await expect(getOutline(pdf)).resolves.toEqual([
      { title:'Chương một', page:1, depth:0 },
      { title:'Mục nhỏ', page:2, depth:1 },
      { title:'Phụ lục', page:3, depth:0 },
      { title:'Không rõ', page:0, depth:0 },
    ]);
  });
});

describe('page text and search', () => {
  it('returns typed text items and skips marked content', async () => {
    const page = makePage(['Xin chào', 'thế giới']);
    const content = await page.getTextContent();
    const withMark = { ...content, items:[...content.items, { type:'beginMarkedContent' }] };
    const pdf = { numPages:1, getPage:async () => ({ ...page, getTextContent:async () => withMark }) } as unknown as PdfDocumentLike;
    const items = await getPageText(pdf,1);
    expect(items.map(item => item.str)).toEqual(['Xin chào','thế giới']);
    expect(items[0]?.transform).toEqual([1,0,0,1,0,0]);
  });

  it('matches Latin text without case or Vietnamese diacritics', async () => {
    const pdf = makePdf([makePage(['Tiếng Việt trên đường phố'])]);
    const match = await searchPdfPage(pdf,1,'tieng viet');
    expect(match?.page).toBe(1);
    expect(match?.snippet).toContain('Tiếng Việt trên đường phố');
    expect(match?.index).toBe(0);
    await expect(searchPdfPage(pdf,1,'DUONG PHO')).resolves.not.toBeNull();
    await expect(searchPdfPage(pdf,1,'khong co')).resolves.toBeNull();
    await expect(searchPdfPage(pdf,1,'   ')).resolves.toBeNull();
  });

  it('returns a snippet around a later match with its original index', async () => {
    const prefix = 'a'.repeat(90);
    const pdf = makePdf([makePage([`${prefix} Đường`])]);
    const match = await searchPdfPage(pdf,1,'duong');
    expect(match?.index).toBe(91);
    expect(match?.snippet.startsWith('a'.repeat(20))).toBe(true);
    expect(match?.snippet).not.toHaveLength(150);
  });

  it('stops at the requested result limit and reports cancellation', async () => {
    const pdf = makePdf([makePage(['một']), makePage(['hai']), makePage(['ba'])]);
    await expect(searchAllPages(pdf,'', { limit:2 })).resolves.toEqual([]);
    await expect(searchAllPages(pdf,'a', { limit:2 })).resolves.toHaveLength(2);
    await expect(searchAllPages(pdf,'a', { limit:1 })).resolves.toHaveLength(1);
    const matches = await searchAllPages(makePdf([makePage(['từ khóa']), makePage(['từ khóa'])]),'tu khoa',{ limit:1 });
    expect(matches).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    try {
      await searchAllPages(pdf,'một',{ signal:controller.signal });
      throw new Error('expected cancellation');
    } catch (error) {
      expect(isAbortError(error)).toBe(true);
    }
  });
});

describe('fit and scroll position', () => {
  it('calculates width, page and actual fit scales', () => {
    const pageSize = { width:600, height:800 };
    expect(fitScale('width',pageSize,{ width:300, height:400 })).toBe(.5);
    expect(fitScale('page',pageSize,{ width:300, height:300 })).toBe(.375);
    expect(fitScale('page',pageSize,{ width:1200, height:400 })).toBe(.5);
    expect(fitScale('actual',pageSize,{ width:300, height:300 })).toBe(1);
    expect(fitScale('width',{ width:0, height:800 },{ width:300, height:300 })).toBe(1);
  });

  it('maps scroll offsets to pages and fractions without leaving the document', () => {
    const rows = [
      { page:2, top:100, height:100 },
      { page:1, top:0, height:100 },
    ];
    expect(pageForScroll([],500)).toBe(1);
    expect(pageForScroll(rows,-20)).toBe(1);
    expect(pageForScroll(rows,0)).toBe(1);
    expect(pageForScroll(rows,100)).toBe(2);
    expect(pageForScroll(rows,250)).toBe(2);
    expect(readingFraction(rows,50)).toBe(.5);
    expect(readingFraction(rows,150)).toBe(.5);
    expect(readingFraction(rows,250)).toBe(1);
    expect(readingFraction([],50)).toBe(0);
    expect(readingFraction([{ page:1, top:0, height:0 }],10)).toBe(0);
  });
});

describe('keyboard intents', () => {
  it('maps reader keys and ignores editable targets', () => {
    expect(keyboardIntent({ key:'j' })).toBe('next-page');
    expect(keyboardIntent({ key:'PageDown' })).toBe('next-page');
    expect(keyboardIntent({ key:' ' })).toBe('next-page');
    expect(keyboardIntent({ key:' ', shiftKey:true })).toBe('prev-page');
    expect(keyboardIntent({ key:'k' })).toBe('prev-page');
    expect(keyboardIntent({ key:'+' })).toBe('zoom-in');
    expect(keyboardIntent({ key:'-' })).toBe('zoom-out');
    expect(keyboardIntent({ key:'w' })).toBe('fit-width');
    expect(keyboardIntent({ key:'f' })).toBe('fit-page');
    expect(keyboardIntent({ key:'o' })).toBe('outline');
    expect(keyboardIntent({ key:'/' })).toBe('search');
    expect(keyboardIntent({ key:'Escape' })).toBe('escape');
    expect(keyboardIntent({ key:'z' })).toBe('none');
    expect(keyboardIntent({ key:'j', target:{ tagName:'input' } })).toBe('none');
    expect(keyboardIntent({ key:'j', target:{ tagName:'TEXTAREA' } })).toBe('none');
    expect(keyboardIntent({ key:'j', target:{ tagName:'DIV', isContentEditable:true } })).toBe('none');
  });

  it('honours ctrl and meta shortcuts without hijacking unrelated commands', () => {
    expect(keyboardIntent({ key:'f', ctrlKey:true })).toBe('search');
    expect(keyboardIntent({ key:'f', metaKey:true })).toBe('search');
    expect(keyboardIntent({ key:'1', ctrlKey:true })).toBe('fit-width');
    expect(keyboardIntent({ key:'2', metaKey:true })).toBe('fit-page');
    expect(keyboardIntent({ key:'+', ctrlKey:true })).toBe('zoom-in');
    expect(keyboardIntent({ key:'-', metaKey:true })).toBe('zoom-out');
    expect(keyboardIntent({ key:'o', ctrlKey:true })).toBe('none');
    expect(keyboardIntent({ key:'j', altKey:true })).toBe('none');
    expect(keyboardIntent({ key:'f', ctrlKey:true, target:{ tagName:'INPUT' } })).toBe('none');
  });
});

describe('reading state persistence', () => {
  const state = { page:12, fraction:.375, zoom:1.25, fit:'page' } as const;

  it('round-trips a valid state', () => {
    expect(decodeReadingState(encodeReadingState(state))).toEqual(state);
  });

  it('rejects malformed or out-of-range state', () => {
    expect(decodeReadingState(null)).toBeNull();
    expect(decodeReadingState('not json')).toBeNull();
    expect(decodeReadingState('null')).toBeNull();
    expect(decodeReadingState(JSON.stringify({ ...state, page:0 }))).toBeNull();
    expect(decodeReadingState(JSON.stringify({ ...state, page:1.5 }))).toBeNull();
    expect(decodeReadingState(JSON.stringify({ ...state, fraction:1.5 }))).toBeNull();
    expect(decodeReadingState(JSON.stringify({ ...state, zoom:.1 }))).toBeNull();
    expect(decodeReadingState(JSON.stringify({ ...state, fit:'cover' }))).toBeNull();
    expect(decodeReadingState(JSON.stringify({ ...state, version:2 }))).toBeNull();
  });

  it('saves and loads through a Storage-like object and survives failures', () => {
    const data = new Map<string,string>();
    const storage: StorageLike = {
      getItem:(key) => data.get(key) ?? null,
      setItem:(key,value) => { data.set(key,value); },
      removeItem:(key) => { data.delete(key); },
    };
    expect(saveReadingState(storage,state)).toBe(true);
    expect(loadReadingState(storage)).toEqual(state);
    data.set('mirror.reading-state','broken');
    expect(loadReadingState(storage)).toBeNull();
    clearReadingState(storage);
    expect(loadReadingState(storage)).toBeNull();
    const throwing: StorageLike = {
      getItem:() => { throw new Error('blocked'); },
      setItem:() => { throw new Error('quota'); },
      removeItem:() => { throw new Error('blocked'); },
    };
    expect(saveReadingState(throwing,state)).toBe(false);
    expect(loadReadingState(throwing)).toBeNull();
    expect(() => clearReadingState(throwing)).not.toThrow();
    expect(loadReadingState(null)).toBeNull();
  });
});

describe('thumbnails', () => {
  it('renders a fake PDF page at the requested width and returns its data URL', async () => {
    const page = makePage(['trang một']);
    const pdf = makePdf([page]);
    const calls: { width:number; height:number }[] = [];
    const canvas = {
      width:0,
      height:0,
      toDataURL:(format?: string, quality?: number) => `data:${format};quality=${quality}`,
    } as unknown as HTMLCanvasElement;
    const thumbnail = await renderThumbnail(pdf,1,300,{
      format:'image/webp',
      quality:.5,
      createCanvas:(width,height) => { calls.push({ width,height }); return canvas; },
    });
    expect(calls).toEqual([{ width:300, height:400 }]);
    expect(page.renders).toHaveLength(1);
    expect(page.renders[0]?.viewport).toEqual({ width:300, height:400 });
    expect(thumbnail).toMatchObject({ width:300, height:400, page:1, dataUrl:'data:image/webp;quality=0.5' });
    expect(thumbnail.canvas).toBe(canvas);
  });

  it('never upscales past the page and falls back to a 160px width', async () => {
    const wide = makePage(['a'],{ width:600, height:800 });
    const pdf = makePdf([wide]);
    const make = () => ({ width:0, height:0, toDataURL:() => 'data:image/jpeg;base64,x' }) as unknown as HTMLCanvasElement;
    await expect(renderThumbnail(pdf,1,1200,{ createCanvas:make })).resolves.toMatchObject({ width:600, height:800 });
    await expect(renderThumbnail(pdf,1,0,{ createCanvas:make })).resolves.toMatchObject({ width:160, height:Math.ceil(800 * 160 / 600) });
  });
});

describe('renderPage rotation', () => {
  afterEach(() => vi.unstubAllGlobals());

  function harness(items: unknown[] = []) {
    const viewportCalls: Record<string, number>[] = [];
    const page = {
      rotate:0,
      getViewport: (params: { scale:number; rotation?:number }) => {
        viewportCalls.push(params);
        return { width:600 * params.scale, height:800 * params.scale, transform:[1,0,0,1,0,0] };
      },
      getTextContent: async () => ({ items, styles:{} }),
      getOperatorList: async () => ({ fnArray:[], argsArray:[] }),
      render: () => ({ promise:Promise.resolve() }),
      commonObjs: { get:() => ({}) },
    };
    vi.stubGlobal('window',{ devicePixelRatio:1 });
    vi.stubGlobal('document',{
      createElement:() => ({
        width:0,
        height:0,
        getContext:() => ({}),
      }),
    });
    return { viewportCalls, pdf:{ getPage:async () => page } as unknown as Parameters<typeof renderPage>[0] };
  }

  it('keeps the default viewport calls unchanged at zero rotation', async () => {
    const { viewportCalls, pdf } = harness();
    await renderPage(pdf,1);
    expect(viewportCalls).toEqual([{ scale:1 },{ scale:1.25 }]);
    await renderPage(pdf,1,{ rotation:0 });
    expect(viewportCalls).toEqual([{ scale:1 },{ scale:1.25 },{ scale:1 },{ scale:1.25 }]);
  });

  it('adds requested rotation to the page rotation for both viewports', async () => {
    const { viewportCalls, pdf } = harness();
    await renderPage(pdf,1,{ rotation:90 });
    expect(viewportCalls).toEqual([{ scale:1, rotation:90 },{ scale:1.25, rotation:90 }]);
  });
});
