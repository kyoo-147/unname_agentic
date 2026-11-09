import { describe, expect, it } from 'vitest';
import { groupTextItems, fitText } from '../src/pdf/layout';

describe('PDF geometry', () => {
  it('keeps columns separate and joins adjacent lines', () => {
    const items = [
      { str: 'Left one', transform: [12,0,0,12,20,180], width: 70, height: 12 },
      { str: 'Right one', transform: [12,0,0,12,250,180], width: 75, height: 12 },
      { str: 'Left two', transform: [12,0,0,12,20,164], width: 70, height: 12 },
    ];
    const blocks = groupTextItems(items, [1,0,0,-1,0,200], 1);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.text).toBe('Left one\nLeft two');
    expect(blocks[0]?.rect).toEqual({ x:20, y:8, width:70, height:28 });
  });
  it('uses font ascent/descent around the baseline, including descenders', () => {
    const blocks = groupTextItems([{ str:'gyp', transform:[20,0,0,20,30,150], width:40, height:20, fontName:'f1' }], [1,0,0,-1,0,200], 1, { f1:{ascent:.75,descent:-.25} });
    expect(blocks[0]?.rect).toEqual({ x:30, y:35, width:40, height:20 });
  });
  it('fits one line without adding a fictitious trailing line gap', () => {
    const fit = fitText('hello', 100, 12, 12, text => text.length * 5);
    expect(fit.fontSize).toBe(12);
    expect(fit.overflow).toBe(false);
  });
  it('never silently drops overflow or long unbroken words', () => {
    const result = fitText('a'.repeat(300), 30, 15, 12, text => text.length * 6);
    expect(result.overflow).toBe(true);
    expect(result.lines.join('')).toBe('a'.repeat(300));
  });
  it('wraps CJK without requiring spaces', () => {
    const result = fitText('中文測試中文測試', 30, 100, 12, text => text.length * 10);
    expect(result.overflow).toBe(false);
    expect(result.lines.join('')).toBe('中文測試中文測試');
  });
});
