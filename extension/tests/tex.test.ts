import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASE_SIZE,
  FRACTION_SIDE_SCALE,
  FormulaFitError,
  MIN_FIT_HEIGHT,
  MIN_FIT_WIDTH,
  SCRIPT_LOWER_RATIO,
  SCRIPT_RAISE_RATIO,
  SCRIPT_SCALE,
  drawFormula,
  fitFormula,
  planFormula,
  plainText,
  toSvg,
  type FormulaLayout,
  type Op,
  type OpKind,
} from '../viewer/src/export/tex';

/** The one drawn run with this text; fails the test rather than returning undefined. */
function run(layout: FormulaLayout, text: string): Op {
  const found = layout.ops.find(op => op.kind === 'text' && op.text === text);
  if (!found) throw new Error(`no text run "${text}" in ${layout.ops.map(op => op.text ?? op.kind).join(' | ')}`);
  return found;
}

/** The single op of this kind; a plan that draws the wrong number of rules or lines fails here. */
function only(layout: FormulaLayout, kind: OpKind): Op {
  const found = layout.ops.filter(op => op.kind === kind);
  expect(found).toHaveLength(1);
  const first = found[0];
  if (!first) throw new Error(`no ${kind} op`);
  return first;
}

describe('planFormula: scripts', () => {
  it('raises and shrinks a superscript', () => {
    const plan = planFormula('x^{2}');
    const base = run(plan, 'x');
    const sup = run(plan, '2');

    expect(sup.y).toBeGreaterThan(base.y);
    expect(sup.size).toBeLessThan(base.size);
    expect(sup.size).toBeCloseTo(DEFAULT_BASE_SIZE * SCRIPT_SCALE, 3);
    expect(sup.y).toBeCloseTo(base.y + SCRIPT_RAISE_RATIO * DEFAULT_BASE_SIZE, 3);
    // The run sits to the right of its base and stays in the plan's ink box.
    expect(sup.x).toBeCloseTo(base.x + base.size * 0.5, 3);
    expect(plan.height).toBeGreaterThan(sup.y);
    expect(plan.baseline).toBeGreaterThan(0);
    expect(plan.warnings).toEqual([]);
  });

  it('lowers and shrinks a subscript without moving the main baseline', () => {
    const plan = planFormula('H_{2}O');
    const hydrogen = run(plan, 'H');
    const subscript = run(plan, '2');
    const oxygen = run(plan, 'O');

    expect(subscript.y).toBeLessThan(hydrogen.y);
    expect(subscript.y).toBeCloseTo(hydrogen.y - SCRIPT_LOWER_RATIO * DEFAULT_BASE_SIZE, 3);
    expect(subscript.size).toBeCloseTo(DEFAULT_BASE_SIZE * SCRIPT_SCALE, 3);
    expect(oxygen.y).toBeCloseTo(hydrogen.y, 6);
    expect(subscript.x).toBeGreaterThan(hydrogen.x);
    expect(oxygen.x).toBeGreaterThan(subscript.x);
  });

  it('takes both scripts of one base', () => {
    const plan = planFormula('x_{a}^{b}');
    expect(run(plan, 'a').y).toBeLessThan(run(plan, 'x').y);
    expect(run(plan, 'b').y).toBeGreaterThan(run(plan, 'x').y);
  });
});

describe('planFormula: fractions', () => {
  it('draws a fraction as a rule between two runs at the same x', () => {
    const plan = planFormula('\\frac{a}{b}');
    const bar = only(plan, 'rule');
    const numerator = run(plan, 'a');
    const denominator = run(plan, 'b');

    expect(bar.y).toBeGreaterThan(denominator.y);
    expect(bar.y).toBeLessThan(numerator.y);
    expect(numerator.x).toBeCloseTo(denominator.x, 6);
    expect(numerator.size).toBeCloseTo(DEFAULT_BASE_SIZE * FRACTION_SIDE_SCALE, 3);
    expect(bar.thickness).toBeGreaterThan(0);
    expect(bar.thickness ?? 0).toBeLessThan(numerator.size);
    // The bar spans both sides: it starts left of them and reaches past their left edge.
    expect(bar.x).toBeLessThan(numerator.x);
    expect((bar.x ?? 0) + bar.size).toBeGreaterThan(numerator.x);
    expect(plan.ops.filter(op => op.kind === 'text')).toHaveLength(2);
  });
});

describe('planFormula: square roots', () => {
  it('draws a radical as a line plus a small tick', () => {
    const plan = planFormula('\\sqrt{x}');
    const strokes = plan.ops.filter(op => op.kind === 'line');
    expect(strokes).toHaveLength(2);
    // The overbar is horizontal; the tick is the one that rises into it.
    const overbar = strokes.find(op => (op.y2 ?? 0) === op.y);
    const tick = strokes.find(op => (op.y2 ?? 0) !== op.y);
    expect(overbar).toBeDefined();
    expect(tick).toBeDefined();
    if (!overbar || !tick) return;

    const radicand = run(plan, 'x');
    expect(overbar.y).toBeGreaterThan(radicand.y);
    expect(overbar.size).toBeGreaterThan(0);
    expect(plan.ops.filter(op => op.kind === 'rule')).toHaveLength(0);

    // The tick starts at the radical's left edge and meets the overbar's left end.
    expect(tick.x).toBe(0);
    expect(tick.x2).toBeCloseTo(overbar.x, 6);
    expect(tick.y2).toBeCloseTo(overbar.y, 6);
    expect(tick.y).toBeLessThan(overbar.y);
    const tickRun = (tick.x2 ?? 0) - tick.x;
    expect(tickRun).toBeLessThan(overbar.size);
    expect(tick.size).toBeGreaterThan(tickRun);
    expect(tick.thickness).toBeGreaterThan(0);
  });

  it('keeps a fraction under the same overbar', () => {
    const plan = planFormula('\\sqrt{\\frac{a}{b}}');
    const bar = only(plan, 'rule');
    const overbars = plan.ops.filter(op => op.kind === 'line' && (op.y2 ?? 0) === op.y);
    expect(overbars).toHaveLength(1);
    const overbar = overbars[0];
    expect(overbar).toBeDefined();
    expect(overbar?.y).toBeGreaterThan(bar.y);
    expect(overbar?.size).toBeGreaterThan(bar.size);
  });
});

describe('planFormula: Greek and operators', () => {
  it('maps Greek commands to their Unicode letters', () => {
    const plan = planFormula('\\alpha + \\Gamma = \\Omega');
    expect(run(plan, 'α').kind).toBe('text');
    expect(run(plan, 'Γ').kind).toBe('text');
    expect(run(plan, 'Ω').kind).toBe('text');
    expect(plainText('\\alpha + \\beta')).toBe('α + β');
    expect(plainText('\\pi \\le 2\\pi')).toBe('π ≤ 2π');
  });

  it('maps operator commands to their signs', () => {
    expect(plainText('a \\times b \\div c')).toBe('a × b ÷ c');
    expect(plainText('x \\to \\infty')).toBe('x → ∞');
    expect(plainText('\\sum_{i}^{n}')).toBe('∑_i^n');
  });

  it('draws escaped characters literally', () => {
    const plan = planFormula('100\\% \\& x\\_1');
    const texts = plan.ops.filter(op => op.kind === 'text').map(op => op.text ?? '');
    expect(texts.join('')).toContain('%');
    expect(texts.join('')).toContain('&');
    expect(plainText('x\\_1')).toBe('x_1');
  });
});

describe('planFormula: sizing and invariants', () => {
  it('takes its base size from the reference box', () => {
    const plan = planFormula('x^{2}', { width: 200, height: 40 });
    expect(run(plan, 'x').size).toBeCloseTo(20, 3);
    expect(run(plan, '2').size).toBeCloseTo(20 * SCRIPT_SCALE, 3);
    expect(plan.width).toBeLessThan(200);
  });

  it('honours an explicit size as given', () => {
    const plan = planFormula('x^{2}', undefined, { size: 30 });
    expect(run(plan, 'x').size).toBeCloseTo(30, 6);
    expect(run(plan, '2').size).toBeCloseTo(30 * SCRIPT_SCALE, 6);
  });

  it('keeps every op inside the planned box', () => {
    const formulas = ['x^{2}', 'H_{2}O', '\\frac{a}{b}', '\\sqrt{x + 1}', '\\frac{\\alpha^{2}}{2}', '\\sqrt{\\frac{1}{2}}'];
    for (const latex of formulas) {
      const plan = planFormula(latex);
      expect(plan.width).toBeGreaterThan(0);
      expect(plan.height).toBeGreaterThan(0);
      expect(plan.baseline).toBeLessThanOrEqual(plan.height);
      for (const op of plan.ops) {
        expect(op.x).toBeGreaterThanOrEqual(-0.001);
        expect(op.x).toBeLessThanOrEqual(plan.width + 0.001);
        expect(op.y).toBeGreaterThanOrEqual(-0.001);
        expect(op.y).toBeLessThanOrEqual(plan.height + 0.001);
        expect(op.size).toBeGreaterThan(0);
      }
    }
  });

  it('plans an empty formula as an empty layout', () => {
    const plan = planFormula('');
    expect(plan.ops).toEqual([]);
    expect(plan.width).toBe(0);
    expect(plan.height).toBe(0);
    expect(plan.warnings).toEqual([]);
  });
});

describe('fitFormula', () => {
  it('scales a plan proportionally into a box', () => {
    const plan = planFormula('\\frac{x}{2}');
    const box = { width: 120, height: 120 };
    const expected = Math.min(box.width / plan.width, box.height / plan.height);
    const fit = fitFormula(plan, box);

    expect(fit.scale).toBeCloseTo(expected, 6);
    expect(fit.width).toBeCloseTo(plan.width * expected, 3);
    expect(fit.height).toBeCloseTo(plan.height * expected, 3);
    expect(fit.width / fit.height).toBeCloseTo(plan.width / plan.height, 3);
    expect(fit.baseline).toBeCloseTo(plan.baseline * expected, 3);

    // Every op keeps its place relative to the others and to the baseline.
    const before = plan.ops.find(op => op.kind === 'rule');
    const after = fit.ops.find(op => op.kind === 'rule');
    expect(before && after).toBeTruthy();
    expect(after?.x).toBeCloseTo((before?.x ?? 0) * expected, 3);
    expect(after?.y).toBeCloseTo((before?.y ?? 0) * expected, 3);
    expect(after?.thickness).toBeCloseTo((before?.thickness ?? 0) * expected, 3);
    const bar = only(fit, 'rule');
    expect(bar.y).toBeGreaterThan(run(fit, '2').y);
    expect(bar.y).toBeLessThan(run(fit, 'x').y);
  });

  it('refuses a box smaller than the documented minimum', () => {
    const plan = planFormula('x^{2}');
    expect(() => fitFormula(plan, { width: MIN_FIT_WIDTH - 0.5, height: 100 })).toThrow(FormulaFitError);
    expect(() => fitFormula(plan, { width: 100, height: MIN_FIT_HEIGHT - 0.5 })).toThrow(FormulaFitError);
    expect(() => fitFormula(plan, { width: 0, height: 0 })).toThrow(FormulaFitError);
    expect(() => fitFormula(plan, { width: Number.NaN, height: 100 })).toThrow(FormulaFitError);

    let refusal: unknown;
    try {
      fitFormula(plan, { width: 1, height: 1 });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(FormulaFitError);
    expect((refusal as Error).name).toBe('FormulaFitError');
    expect((refusal as Error).message).toContain('formula box');
  });

  it('fits an empty plan without dividing by zero', () => {
    const fit = fitFormula(planFormula(''), { width: 20, height: 20 });
    expect(fit).toEqual({ ops: [], scale: 1, width: 0, height: 0, baseline: 0 });
  });
});

describe('toSvg', () => {
  it('escapes angle brackets and ampersands', () => {
    const svg = toSvg(planFormula('a<b \\& c'));

    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&amp;');
    expect(svg).not.toContain('a<b');
    expect(svg).not.toContain('& c');
    expect(svg).toContain('viewBox=');
  });

  it('asks for no external font by name', () => {
    const svg = toSvg(planFormula('\\sqrt{x}'));
    expect(svg).toContain('font-family="serif"');
    expect(svg).not.toMatch(/font-family="[^"]*,/);
    expect(svg).not.toContain('@font-face');
    expect(svg).not.toContain('.ttf');
    expect(svg).not.toContain('.woff');
  });

  it('flips plan space into SVG space', () => {
    const plan = planFormula('x^{2}');
    const svg = toSvg(plan);
    const runs = [...svg.matchAll(/<text x="[^"]*" y="([^"]*)"[^>]*>([^<]*)<\/text>/g)].map(match => ({
      y: Number(match[1]),
      text: match[2] ?? '',
    }));
    const base = runs.find(entry => entry.text === 'x');
    const sup = runs.find(entry => entry.text === '2');
    expect(base).toBeDefined();
    expect(sup).toBeDefined();
    if (!base || !sup) return;
    expect(base.y).toBeCloseTo(plan.height - run(plan, 'x').y, 2);
    expect(sup.y).toBeLessThan(base.y);
  });
});

describe('plainText', () => {
  it('keeps both sides of a fraction', () => {
    expect(plainText('\\frac{a}{b}')).toBe('a/b');
    const text = plainText('\\frac{\\alpha + 1}{2}');
    expect(text).toContain('α');
    expect(text).toContain('2');
    expect(text).toBe('(α + 1)/2');
  });

  it('linearises scripts and radicals', () => {
    expect(plainText('x^{2}')).toBe('x^2');
    expect(plainText('H_{2}O')).toBe('H_2O');
    expect(plainText('x_{a}^{b}')).toBe('x_a^b');
    expect(plainText('\\sqrt{x + 1}')).toBe('√(x + 1)');
    expect(plainText('x = 2')).toBe('x = 2');
  });
});

describe('warnings', () => {
  it('reports an unsupported macro instead of failing', () => {
    const plan = planFormula('\\unknown{x}');
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(plan.warnings.join(' ')).toContain('\\unknown');
    expect(plan.ops.length).toBeGreaterThan(0);
    expect(plan.ops.some(op => (op.text ?? '').includes('\\unknown'))).toBe(true);
  });

  it('reports one warning per problem', () => {
    const plan = planFormula('\\unknown + \\unknown');
    expect(plan.warnings.filter(warning => warning.includes('\\unknown'))).toHaveLength(1);
  });

  it('keeps drawing when a group is never closed', () => {
    const plan = planFormula('x^{2');
    expect(plan.warnings.join(' ')).toContain('{');
    expect(run(plan, '2').y).toBeGreaterThan(run(plan, 'x').y);
    expect(run(plan, '2').size).toBeLessThan(run(plan, 'x').size);
  });

  it('skips a stray closing brace without losing what follows it', () => {
    const plan = planFormula('a}b');
    expect(plan.warnings.join(' ')).toContain('}');
    expect(plan.ops.filter(op => op.kind === 'text').map(op => op.text ?? '').join('')).toBe('ab');
  });

  it('does not fail on a dangling script marker', () => {
    const plan = planFormula('x^');
    expect(plan.warnings.join(' ')).toContain('superscript');
    expect(run(plan, 'x').size).toBe(DEFAULT_BASE_SIZE);
  });

  it('keeps the side of a half-written fraction', () => {
    const plan = planFormula('\\frac{a}');
    expect(plan.warnings.join(' ')).toContain('\\frac');
    expect(plan.ops.some(op => (op.text ?? '').includes('a'))).toBe(true);
  });
});

describe('drawFormula', () => {
  interface Call {
    kind: 'text' | 'rule' | 'line';
    x: number;
    y: number;
    text?: string;
    width?: number;
    height?: number;
  }

  function recordingPage(calls: Call[]): PDFPage {
    const page = {
      drawText: (text: string, options: { x: number; y: number }) => {
        calls.push({ kind: 'text', text, x: options.x, y: options.y });
      },
      drawRectangle: (options: { x: number; y: number; width: number; height: number }) => {
        calls.push({ kind: 'rule', x: options.x, y: options.y, width: options.width, height: options.height });
      },
      drawLine: (options: { start: { x: number; y: number }; end: { x: number; y: number } }) => {
        calls.push({ kind: 'line', x: options.start.x, y: options.start.y });
      },
    };
    return page as unknown as PDFPage;
  }

  it('places every op relative to the requested baseline', () => {
    const calls: Call[] = [];
    const plan = planFormula('\\frac{a}{b}');
    const result = drawFormula(recordingPage(calls), plan, { x: 30, y: 200, font: {} as PDFFont });

    expect(result).toEqual({ drawn: plan.ops.length, skipped: 0 });
    expect(calls).toHaveLength(plan.ops.length);
    const call = (text: string): Call => {
      const found = calls.find(entry => entry.text === text);
      if (!found) throw new Error(`no drawn call for "${text}"`);
      return found;
    };
    const numerator = run(plan, 'a');
    const denominator = run(plan, 'b');
    expect(call('a').y).toBeCloseTo(200 + numerator.y - plan.baseline, 3);
    expect(call('b').y).toBeCloseTo(200 + denominator.y - plan.baseline, 3);
    expect(call('a').x).toBeCloseTo(30 + numerator.x, 3);
    const bar = calls.find(entry => entry.kind === 'rule');
    expect(bar).toBeDefined();
    expect(bar?.y).toBeGreaterThan(call('b').y);
    expect(bar?.y).toBeLessThan(call('a').y);
    expect(bar?.width).toBeCloseTo(only(plan, 'rule').size, 3);
  });

  it('draws through a real face and saves a page', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([200, 200]);
    const plan = planFormula('\\frac{x}{2}');
    expect(drawFormula(page, plan, { x: 20, y: 120, font })).toEqual({ drawn: plan.ops.length, skipped: 0 });
    const radical = planFormula('\\sqrt{y}');
    expect(drawFormula(page, radical, { x: 20, y: 60, font })).toEqual({ drawn: radical.ops.length, skipped: 0 });
    const bytes = await doc.save();
    expect(doc.getPageCount()).toBe(1);
    expect(bytes.length).toBeGreaterThan(300);
  });

  it('counts text a face cannot draw instead of throwing', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([200, 200]);
    const plan = planFormula('x^{2}');
    const result = drawFormula(page, plan, { x: 10, y: 100, font, prepare: () => '' });
    expect(result).toEqual({ drawn: 0, skipped: 2 });
  });
});
