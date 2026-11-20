import { describe, expect, it } from 'vitest';
import { detectFormulas, protectForTranslation, segmentText, toLatex } from '../src/core/formulas';
import { restore } from '../src/core/protect';

function mathOf(text: string): { value: string; latex: string }[] {
  return segmentText(text)
    .filter(segment => segment.kind !== 'text')
    .map(segment => ({ value: segment.value, latex: segment.latex ?? '' }));
}

describe('segmentText', () => {
  it('reads both inline forms', () => {
    expect(segmentText('The value $x^2$ grows.')).toEqual([
      { kind: 'text', value: 'The value ' },
      { kind: 'inline-math', value: '$x^2$', latex: 'x^{2}' },
      { kind: 'text', value: ' grows.' },
    ]);
    expect(mathOf('The angle is \\(\\alpha\\) wide.')).toEqual([
      { value: '\\(\\alpha\\)', latex: '\\alpha' },
    ]);
  });

  it('reads both display forms', () => {
    expect(segmentText('$$E = mc^2$$')).toEqual([
      { kind: 'display-math', value: '$$E = mc^2$$', latex: 'E = mc^{2}' },
    ]);
    expect(segmentText('where \\[ x_1 \\] holds')).toEqual([
      { kind: 'text', value: 'where ' },
      { kind: 'display-math', value: '\\[ x_1 \\]', latex: 'x_{1}' },
      { kind: 'text', value: ' holds' },
    ]);
  });

  it('segments a line with no formula as one text run', () => {
    const line = 'Plain prose, with punctuation.';
    expect(segmentText(line)).toEqual([{ kind: 'text', value: line }]);
    expect(segmentText('')).toEqual([]);
  });

  it('keeps prose that merely contains slashes out of the formulas', () => {
    const line = 'Results improve and/or degrade in 3/4 of the sample.';
    expect(segmentText(line)).toEqual([{ kind: 'text', value: line }]);
  });

  it('keeps currency out of the formulas', () => {
    expect(segmentText('The items cost $5 and $6 each.')).toEqual([
      { kind: 'text', value: 'The items cost $5 and $6 each.' },
    ]);
  });

  it('leaves an unbalanced dollar in the text', () => {
    expect(segmentText('costs $x dollars')).toEqual([{ kind: 'text', value: 'costs $x dollars' }]);
  });

  it('finds a bare formula between prose', () => {
    expect(segmentText('The mass H_2O is 18 g.')).toEqual([
      { kind: 'text', value: 'The mass ' },
      { kind: 'inline-math', value: 'H_2O', latex: 'H_{2}O' },
      { kind: 'text', value: ' is 18 g.' },
    ]);
    expect(mathOf('E = mc^2')).toEqual([{ value: 'E = mc^2', latex: 'E = mc^{2}' }]);
  });

  it('does not read a scientific sentence as one bare formula', () => {
    const line = 'The sample was measured at room temperature and pressure.';
    expect(segmentText(line)).toEqual([{ kind: 'text', value: line }]);
  });

  it('reads an equation whose fraction is a simple a/b', () => {
    expect(mathOf('η = W/Q ≤ 1')).toEqual([
      { value: 'η = W/Q ≤ 1', latex: '\\eta = \\frac{W}{Q} \\le 1' },
    ]);
  });

  it('drops a dangling operator instead of losing the formula before it', () => {
    expect(segmentText('The term x^2 =')).toEqual([
      { kind: 'text', value: 'The term ' },
      { kind: 'inline-math', value: 'x^2', latex: 'x^{2}' },
      { kind: 'text', value: ' =' },
    ]);
  });

  it('does not let an unbalanced dollar swallow the next formula', () => {
    expect(segmentText('cost $x and $y$ today')).toEqual([
      { kind: 'text', value: 'cost $x and ' },
      { kind: 'inline-math', value: '$y$', latex: 'y' },
      { kind: 'text', value: ' today' },
    ]);
  });

  it('reads an equation that starts with a prefix operator', () => {
    expect(mathOf('√(x+1) ≤ 2')).toEqual([
      { value: '√(x+1) ≤ 2', latex: '\\sqrt{x+1} \\le 2' },
    ]);
    expect(mathOf('∑ x_i = 1')).toEqual([{ value: '∑ x_i = 1', latex: '\\sum x_{i} = 1' }]);
  });

  it('rejects a math-shaped run whose symbol density is too low', () => {
    // Seven single-letter tokens and one `=`: density 1/7 = 0.14, below the
    // documented 0.15 threshold, so this letter-spaced prose stays text.
    const line = 'a b c d e = f';
    expect(segmentText(line)).toEqual([{ kind: 'text', value: line }]);
  });

  it('reports both formulas of one block', () => {
    const segments = segmentText('Both $a^2$ and $$b_1$$ appear.');
    expect(segments.filter(segment => segment.kind !== 'text')).toEqual([
      { kind: 'inline-math', value: '$a^2$', latex: 'a^{2}' },
      { kind: 'display-math', value: '$$b_1$$', latex: 'b_{1}' },
    ]);
  });
});

describe('toLatex', () => {
  it('braces superscripts', () => {
    expect(toLatex('x^2')).toBe('x^{2}');
    expect(toLatex('a^{n+1}')).toBe('a^{n+1}');
    expect(toLatex('x^-1')).toBe('x^{-1}');
  });

  it('braces subscripts', () => {
    expect(toLatex('x_1')).toBe('x_{1}');
    expect(toLatex('H_2O')).toBe('H_{2}O');
  });

  it('turns a simple fraction into \\frac', () => {
    expect(toLatex('a/b')).toBe('\\frac{a}{b}');
    expect(toLatex('x/2')).toBe('\\frac{x}{2}');
    // A math run for `3/4` is a fraction; the prose sentence holding `3/4` never
    // becomes a run in the first place (see segmentText above).
    expect(toLatex('3/4')).toBe('\\frac{3}{4}');
    expect(toLatex('and/or')).toBe('and/or');
    expect(toLatex('P(B|A)/P(B)')).toBe('P(B|A)/P(B)');
  });

  it('converts Greek letters by character and by name', () => {
    expect(toLatex('α + β ≤ 1')).toBe('\\alpha + \\beta \\le 1');
    expect(toLatex('omega + Omega')).toBe('\\omega + \\Omega');
    expect(toLatex('Δ x')).toBe('\\Delta x');
    expect(toLatex('Chi')).toBe('X');
  });

  it('converts the common operators', () => {
    expect(toLatex('a × b')).toBe('a \\times b');
    expect(toLatex('a ≤ b')).toBe('a \\le b');
    expect(toLatex('a ≥ b')).toBe('a \\ge b');
    expect(toLatex('a ≠ b')).toBe('a \\ne b');
    expect(toLatex('a ± b')).toBe('a \\pm b');
    expect(toLatex('∑ x_i')).toBe('\\sum x_{i}');
    expect(toLatex('∫ f dx')).toBe('\\int f dx');
  });

  it('wraps the argument of a square root', () => {
    expect(toLatex('√{x+1}')).toBe('\\sqrt{x+1}');
    expect(toLatex('√2')).toBe('\\sqrt{2}');
    expect(toLatex('√(a+b)')).toBe('\\sqrt{a+b}');
  });

  it('escapes a percent sign exactly once', () => {
    expect(toLatex('0.5%')).toBe('0.5\\%');
    expect(toLatex('0.5\\%')).toBe('0.5\\%');
  });

  it('passes existing LaTeX through', () => {
    expect(toLatex('\\frac{a}{b}')).toBe('\\frac{a}{b}');
    expect(toLatex('\\alpha + \\beta')).toBe('\\alpha + \\beta');
    expect(toLatex('\\sum_{i=1}^{n} x_i^2')).toBe('\\sum_{i=1}^{n} x_{i}^{2}');
  });

  it('converts one real-looking equation', () => {
    const line =
      '\\[ \\sigma^2 = \\frac{1}{N} \\sum_{i=1}^{N} (x_i − \\mu)^2 \\]';
    expect(mathOf(line)).toEqual([
      {
        value: line,
        latex: '\\sigma^{2} = \\frac{1}{N} \\sum_{i=1}^{N} (x_{i} - \\mu)^{2}',
      },
    ]);
  });
});

describe('detectFormulas', () => {
  it('returns only the blocks with formulas, keeping their index', () => {
    const blocks = [
      { text: 'Plain prose about the method.', id: 'p1-r0' },
      { text: 'Area: $A = \\pi r^2$ here.', id: 'p1-r1' },
      { text: 'Another paragraph without any math.', id: 'p1-r2' },
    ];
    const hits = detectFormulas(blocks);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.index).toBe(1);
    expect(hits[0]?.id).toBe('p1-r1');
    expect(hits[0]?.formulas.map(formula => formula.latex)).toEqual(['A = \\pi r^{2}']);
  });

  it('returns both formulas of a block', () => {
    const hits = detectFormulas([{ text: 'From $a^2$ and H_2O follows $$b_1$$.' }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.formulas.map(formula => formula.value)).toEqual(['$a^2$', 'H_2O', '$$b_1$$']);
    expect(hits[0]?.formulas.map(formula => formula.kind)).toEqual([
      'inline-math',
      'inline-math',
      'display-math',
    ]);
  });

  it('reads a Document IR block from its raw text', () => {
    const hits = detectFormulas([{ raw: 'Mass $m$ is fixed.' }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.formulas).toHaveLength(1);
  });

  it('returns nothing for a page without formulas', () => {
    expect(detectFormulas([{ text: 'Only words here.' }, { text: '' }])).toEqual([]);
  });
});

describe('protectForTranslation', () => {
  it('locks a whole formula run and restores it verbatim', () => {
    const text = 'The mass $m$ of H_2O is 18 g.';
    const masked = protectForTranslation({ text });

    expect(masked.tokens.map(token => token.kind)).toEqual(['formula', 'formula', 'number']);
    expect(masked.masked).not.toContain('$m$');
    expect(masked.masked).not.toContain('H_2O');
    expect(masked.masked).not.toContain('18');

    const restored = restore(masked.masked, masked.tokens);
    expect(restored.text).toBe(text);
    expect(restored.missing).toEqual([]);
    expect(restored.duplicated).toEqual([]);
  });

  it('keeps translations of the prose from touching the formula', () => {
    const masked = protectForTranslation({ text: 'The area is $A = \\pi r^2$ exactly.' });
    // A translator returns the placeholders and different prose.
    const translated = masked.masked.replace('The area is ', 'L’aire est ');
    expect(restore(translated, masked.tokens).text).toBe('L’aire est $A = \\pi r^2$ exactly.');
  });

  it('locks a display equation as one token', () => {
    const text = 'Then $$\\int_0^1 x^2 dx = 1/3$$ follows.';
    const masked = protectForTranslation({ text });
    expect(masked.tokens).toHaveLength(1);
    expect(masked.tokens[0]?.kind).toBe('formula');
    expect(restore(masked.masked, masked.tokens).text).toBe(text);
  });

  it('keeps line breaks and numbers of a multi-line block', () => {
    const text = 'First $x$ line.\nSecond 42 line.';
    const masked = protectForTranslation({ text });
    expect(masked.masked.split('\n')).toHaveLength(2);
    expect(masked.tokens.map(token => token.kind)).toEqual(['formula', 'number']);
    expect(restore(masked.masked, masked.tokens).text).toBe(text);
  });

  it('is a no-op for a block without formulas or numbers', () => {
    const masked = protectForTranslation({ text: 'Only words here.' });
    expect(masked).toEqual({ masked: 'Only words here.', tokens: [] });
    expect(protectForTranslation({ text: '' })).toEqual({ masked: '', tokens: [] });
  });

  it('reads a Document IR block from its raw text', () => {
    const masked = protectForTranslation({ raw: 'Mass $m$ is fixed.' });
    expect(masked.tokens.map(token => token.value)).toEqual(['$m$']);
  });
});
