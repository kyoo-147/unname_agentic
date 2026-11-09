import { describe, expect, it, vi } from 'vitest';
import { textPaintGate, pageFrameWidth } from '../src/pdf/suppression';

describe('text paint suppression', () => {
  it('executes every PDF operator, suppresses text and path glyphs, but keeps artwork', () => {
    const target = { fillText: vi.fn(), strokeText: vi.fn(), fill: vi.fn(), stroke: vi.fn(), translate: vi.fn(), font: '' };
    const gate = textPaintGate(target as unknown as CanvasRenderingContext2D, index => index === 1);
    expect(gate.operationsFilter(0)).toBe(true);
    gate.context.fill();
    expect(gate.operationsFilter(1)).toBe(true);
    gate.context.translate(12, 0);
    gate.context.fillText('text', 0, 0);
    gate.context.strokeText('text', 0, 0);
    gate.context.fill();
    gate.context.stroke();
    expect(gate.operationsFilter(2)).toBe(true);
    gate.context.stroke();
    gate.context.font = '12px sans-serif';
    expect(target.fill).toHaveBeenCalledTimes(1);
    expect(target.stroke).toHaveBeenCalledTimes(1);
    expect(target.fillText).not.toHaveBeenCalled();
    expect(target.strokeText).not.toHaveBeenCalled();
    expect(target.translate).toHaveBeenCalledWith(12, 0);
    expect(target.font).toBe('12px sans-serif');
    expect(gate.diagnostics).toEqual({ textOperators: 1, suppressedTextPaints: 4 });
  });
  it('gives both page frames the same width even when panes resize asymmetrically', () => {
    expect(pageFrameWidth(1000, 50)).toBe(491);
    expect(pageFrameWidth(1000, 25)).toBe(241);
    expect(pageFrameWidth(1000, 75)).toBe(241);
    expect(pageFrameWidth(600, 52)).toBe(279);
  });
});
