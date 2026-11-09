import type { TextBlock } from '../core/types';

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
    } else blocks.push({ id:`p${page}-r${blocks.length}`, page, text:item.str, rect:{x,y,width,height}, fontSize:size, fontFamily:'sans-serif', color:'#202724', direction:item.dir==='rtl'?'rtl':'ltr', rotation });
  }
  return blocks;
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
