import { resolveBlockDirection } from '../core/text-direction';
import type { Rect, TextBlock } from '../core/types';

export interface PdfTextItem { str: string; transform: number[]; width: number; height: number; dir?: string; fontName?: string }
export function groupTextItems(items: PdfTextItem[], viewport: number[], page: number, styles: Record<string, { ascent?: number; descent?: number }> = {}): TextBlock[] {
  const [a=1,b=0,c=0,d=1,e=0,f=0] = viewport;
  const blocks: TextBlock[] = [];
  const pieces = items.filter(item => item.str.trim()).map(item => {
    const [ta=1,tb=0,,,tx=0,ty=0] = item.transform;
    const size = Math.hypot(a * ta + c * tb, b * ta + d * tb);
    const style = styles[item.fontName ?? ''];
    const ascent = style?.ascent ?? 1;
    const descent = style?.descent ?? 0;
    return { item, x:a*tx+c*ty+e, y:b*tx+d*ty+f-size*ascent, size, height:size*(ascent-descent), width:Math.abs(item.width * Math.hypot(a,b)), rotation:Math.atan2(b*ta+d*tb,a*ta+c*tb)*180/Math.PI };
  }).sort((left,right) => Math.abs(left.y-right.y) < 3 ? left.x-right.x : left.y-right.y);
  for (const piece of pieces) {
    const { item, x, y, size, height, width, rotation } = piece;
    if (![x,y,size,width].every(Number.isFinite) || size <= 0 || width <= 0) continue;
    const previous = [...blocks].reverse().find(block => Math.abs(block.fontSize-size)<1 && Math.abs(block.rotation-rotation)<1 && (
      (Math.abs(block.rect.y+block.rect.height-size-y)<size*.35 && x >= block.rect.x && x-(block.rect.x+block.rect.width)<size*1.5) ||
      (Math.abs(block.rect.x-x)<size*.6 && y >= block.rect.y+block.rect.height-size*.2 && y-(block.rect.y+block.rect.height)<size*.65)
    ));
    if (previous) {
      const sameLine = Math.abs(previous.rect.y+previous.rect.height-size-y)<size*.35;
      previous.text += (sameLine ? ' ' : '\n') + item.str;
      previous.rect.width = Math.max(previous.rect.x+previous.rect.width,x+width)-previous.rect.x;
      previous.rect.height = Math.max(previous.rect.y+previous.rect.height,y+height)-previous.rect.y;
    } else blocks.push({ id:`p${page}-r${blocks.length}`, page, text:item.str, rect:{x,y,width,height}, fontSize:size, fontFamily:'sans-serif', color:'#202724', direction:resolveBlockDirection(item.dir,item.str), rotation });
  }
  return blocks;
}

export type PageRotation = 0 | 90 | 180 | 270;
export function normalizeRotation(value: number): PageRotation {
  if (!Number.isFinite(value)) return 0;
  return ((((Math.round(value / 90) * 90) % 360) + 360) % 360) as PageRotation;
}
export function nextRotation(current: number, delta = 90): PageRotation {
  return normalizeRotation(current + delta);
}
export function rotatePageSize(size: { width: number; height: number }, rotation: number): { width: number; height: number } {
  const quarter = normalizeRotation(rotation) % 180 !== 0;
  return quarter ? { width:size.height, height:size.width } : { width:size.width, height:size.height };
}

export function rotateRect(rect: Rect, rotation: number, width: number, height: number): Rect {
  if (!(width > 0) || !(height > 0)) return { ...rect };
  const x = rect.x / width, y = rect.y / height, w = rect.width / width, h = rect.height / height;
  const turned = normalizeRotation(rotation);
  if (turned === 90) return { x: (1 - y - h) * height, y: x * width, width: h * height, height: w * width };
  if (turned === 180) return { x: (1 - x - w) * width, y: (1 - y - h) * height, width: w * width, height: h * height };
  if (turned === 270) return { x: y * height, y: (1 - x - w) * width, width: h * height, height: w * width };
  return { ...rect };
}

export interface PageTextItem extends PdfTextItem { hasEOL?: boolean }
export interface SearchMatch { page: number; snippet: string; index: number }
export function readPageTextItems(items: readonly unknown[]): PageTextItem[] {
  return items.flatMap(item => {
    if (!item || typeof item !== 'object' || !('str' in item)) return [];
    const candidate = item as Record<string, unknown>;
    const str = typeof candidate.str === 'string' ? candidate.str : '';
    const transform = Array.isArray(candidate.transform) && candidate.transform.every(value => typeof value === 'number') ? candidate.transform as number[] : [1,0,0,1,0,0];
    const width = typeof candidate.width === 'number' ? candidate.width : 0;
    const height = typeof candidate.height === 'number' ? candidate.height : 0;
    return [{ str, transform, width, height, dir:typeof candidate.dir === 'string' ? candidate.dir : undefined, fontName:typeof candidate.fontName === 'string' ? candidate.fontName : undefined, hasEOL:candidate.hasEOL === true }];
  });
}
export function searchTextPage(items: readonly { str: string }[], page: number, query: string): SearchMatch | null {
  const needle = foldSearchText(query).text;
  if (!needle) return null;
  const text = items.map(item => item.str).join(' ');
  const folded = foldSearchText(text);
  const at = folded.text.indexOf(needle);
  if (at < 0) return null;
  const start = folded.map[at] ?? 0;
  const end = (folded.map[at + needle.length - 1] ?? start) + 1;
  const from = Math.max(0,start - 64);
  const to = Math.min(text.length,end + 64);
  return { page, snippet:text.slice(from,to).replace(/\s+/g,' ').trim(), index:start };
}
export function foldSearchText(input: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  for (let index = 0; index < input.length; index++) {
    const folded = input[index]!.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').toLowerCase();
    for (const character of folded) { text += character; map.push(index); }
  }
  return { text, map };
}

export interface TextFit { lines: string[]; fontSize: number; lineHeight: number; overflow: boolean }
export function fitText(text: string, width: number, height: number, preferred: number, measure: (text: string, size: number) => number, minimum = 7): TextFit {
  let result: TextFit = { lines:[text], fontSize:preferred, lineHeight:preferred*1.15, overflow:true };
  for (let size = Math.max(minimum,preferred); size >= minimum; size -= .5) {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      const tokens = paragraph.match(/\s+|[^\s\u3000-\u9fff]+|[\u3000-\u9fff]/gu) ?? [''];
      for (const token of tokens) {
        if (measure(line+token,size) <= width) { line += token; continue; }
        if (line) { lines.push(line.trimEnd()); line=''; }
        if (measure(token,size) <= width) line=token.trimStart();
        else for (const character of Array.from(token)) {
          if (line && measure(line+character,size)>width) { lines.push(line); line=''; }
          line += character;
        }
      }
      lines.push(line.trimEnd());
    }
    result={ lines, fontSize:size, lineHeight:size*1.15, overflow:size+Math.max(0,lines.length-1)*size*1.15>height+.5 || lines.some(line=>measure(line,size)>width) };
    if (!result.overflow) break;
  }
  return result;
}
