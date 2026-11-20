import { describe, expect, it } from 'vitest';
import {
  auditStructure,
  checkContrast,
  contrastRatio,
  focusOrder,
  relativeLuminance,
  requiredContrast,
  suggestDarken,
  suggestLighten,
  WCAG_AA_LARGE_TEXT,
  WCAG_AA_NORMAL_TEXT,
  type ContrastLevel,
  type FocusElement,
  type StructureDescription,
} from '../src/core/a11y';

describe('contrastRatio', () => {
  it('gives black on white the maximum ratio of 21', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
  });

  it('is symmetric, because the lighter and darker colour are chosen internally', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBe(21);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#777777'), 12);
  });

  it('measures a known failing grey-on-white pair at about 4.48:1', () => {
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.478, 3);
  });

  it('accepts short hex and an omitted leading hash', () => {
    expect(contrastRatio('#000', '#fff')).toBe(21);
    expect(contrastRatio('000000', 'ffffff')).toBe(21);
  });

  it('rejects a value that is not a hex colour instead of guessing', () => {
    expect(() => contrastRatio('#12', '#ffffff')).toThrow(TypeError);
    expect(() => contrastRatio('red', '#ffffff')).toThrow(TypeError);
  });

  it('maps relative luminance from 0 for black to 1 for white', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBe(1);
    expect(relativeLuminance('#777777')).toBeCloseTo(0.1845, 3);
  });
});

describe('checkContrast', () => {
  it('passes black on white for normal text', () => {
    expect(checkContrast([{ foreground: '#000000', background: '#ffffff' }], 'normal')).toEqual([]);
  });

  it('reports a failing pair with its ratio and the normal-text requirement', () => {
    const failures = checkContrast(
      [{ foreground: '#777777', background: '#ffffff', label: 'Muted label' }],
      'normal',
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      code: 'contrast-below-minimum',
      label: 'Muted label',
      foreground: '#777777',
      background: '#ffffff',
      required: 4.5,
    });
    expect(failures[0]?.ratio).toBeCloseTo(4.478, 3);
    expect(WCAG_AA_NORMAL_TEXT).toBe(4.5);
  });

  it('generates a label when the pair has none and canonicalises the colours', () => {
    const failures = checkContrast([{ foreground: '#777', background: '#fff' }]);

    expect(failures[0]?.label).toBe('#777777 on #ffffff');
    expect(failures[0]?.foreground).toBe('#777777');
    expect(failures[0]?.background).toBe('#ffffff');
  });

  it('accepts the same failing pair as large text against the lower threshold', () => {
    const failures = checkContrast(
      [{ foreground: '#777777', background: '#ffffff' }],
      'large',
    );

    expect(failures).toEqual([]);
    expect(WCAG_AA_LARGE_TEXT).toBe(3);
  });

  it('fails a pale pair that misses even the large-text threshold', () => {
    const failures = checkContrast(
      [{ foreground: '#aaaaaa', background: '#ffffff' }],
      'large',
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]?.ratio).toBeCloseTo(2.323, 3);
    expect(failures[0]?.required).toBe(3);
  });

  it('rejects an unknown level rather than treating it as normal', () => {
    expect(() => requiredContrast('aaa' as ContrastLevel)).toThrow(RangeError);
  });
});

describe('contrast suggestions', () => {
  it('darkens the nearest grey that passes 4.5:1 on white', () => {
    const suggested = suggestDarken('#777777', '#ffffff', 'normal');

    expect(suggested).toBe('#767676');
    expect(contrastRatio(suggested!, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('lightens the nearest grey that passes on black', () => {
    const suggested = suggestLighten('#555555', '#000000', 'normal');

    expect(suggested).toBe('#757575');
    expect(contrastRatio(suggested!, '#000000')).toBeGreaterThanOrEqual(4.5);
  });

  it('respects the large-text threshold when asked for it', () => {
    const suggested = suggestDarken('#aaaaaa', '#ffffff', 'large');

    expect(suggested).not.toBeNull();
    expect(contrastRatio(suggested!, '#ffffff')).toBeGreaterThanOrEqual(3);
  });

  it('returns an already-passing colour unchanged', () => {
    expect(suggestDarken('#000000', '#ffffff')).toBe('#000000');
    expect(suggestLighten('#ffffff', '#000000')).toBe('#ffffff');
  });

  it('returns null when that direction cannot reach the threshold', () => {
    // Black on black is 1:1; darkening a mid-grey cannot help it.
    expect(suggestDarken('#555555', '#000000')).toBeNull();
    // White on white is 1:1; lightening a mid-grey cannot help it either.
    expect(suggestLighten('#777777', '#ffffff')).toBeNull();
  });
});

/** A description with nothing to report: unique ids, in-order headings, labelled controls. */
const CLEAN: StructureDescription = {
  landmarks: [
    { id: 'top', role: 'banner' },
    { id: 'nav', role: 'navigation', label: 'Main' },
    { id: 'content', role: 'main' },
  ],
  headings: [
    { level: 1, text: 'Reader', id: 'title' },
    { level: 2, text: 'Translation', id: 'translation' },
    { level: 3, text: 'Settings' },
  ],
  interactive: [
    { id: 'open', role: 'button', label: 'Open document', landmarkId: 'top' },
    { id: 'next', role: 'button', label: 'Next page', landmarkId: 'content' },
  ],
  images: [
    { id: 'cover', alt: 'Document cover' },
    { id: 'rule', alt: '' },
    { id: 'spacer', decorative: true },
  ],
};

describe('auditStructure', () => {
  it('reports nothing for a clean description', () => {
    expect(auditStructure(CLEAN)).toEqual([]);
  });

  it('reports a missing main landmark', () => {
    const issues = auditStructure({ landmarks: [{ id: 'nav', role: 'navigation' }] });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'missing-main-landmark', element: 'main' });
  });

  it('treats an empty description as a page with no main landmark', () => {
    expect(auditStructure({}).map((issue) => issue.code)).toEqual(['missing-main-landmark']);
  });

  it('reports a heading level skip and names the heading', () => {
    const issues = auditStructure({
      landmarks: [{ role: 'main' }],
      headings: [
        { level: 1, text: 'Reader' },
        { level: 3, text: 'Settings' },
      ],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'heading-level-skip', element: 'Settings' });
    expect(issues[0]?.message).toContain('from level 1 to 3');
  });

  it('does not call a first heading a skip, nor a step back up the outline', () => {
    const startsDeep = auditStructure({
      landmarks: [{ role: 'main' }],
      headings: [{ level: 3, text: 'Settings' }],
    });
    const stepsBack = auditStructure({
      landmarks: [{ role: 'main' }],
      headings: [
        { level: 1, text: 'Reader' },
        { level: 2, text: 'Translation' },
        { level: 3, text: 'Settings' },
        { level: 2, text: 'Translation options' },
      ],
    });

    expect(startsDeep).toEqual([]);
    expect(stepsBack).toEqual([]);
  });

  it('reports controls without a label, including whitespace-only labels', () => {
    const issues = auditStructure({
      landmarks: [{ id: 'main', role: 'main' }],
      interactive: [
        { id: 'save', label: 'Save', landmarkId: 'main' },
        { id: 'print', landmarkId: 'main' },
        { id: 'share', label: '   ', landmarkId: 'main' },
      ],
    });

    expect(issues.map((issue) => issue.code)).toEqual([
      'interactive-without-label',
      'interactive-without-label',
    ]);
    expect(issues.map((issue) => issue.element)).toEqual(['print', 'share']);
  });

  it('reports an image without alt text but accepts empty alt and decorative images', () => {
    const issues = auditStructure({
      landmarks: [{ role: 'main' }],
      images: [
        { id: 'hero' },
        { id: 'divider', alt: '' },
        { id: 'spacer', decorative: true },
        { id: 'chart', alt: 'Sales by quarter' },
      ],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'image-without-alt', element: 'hero' });
  });

  it('reports a focusable element that is outside every landmark', () => {
    const issues = auditStructure({
      landmarks: [{ id: 'main', role: 'main' }],
      interactive: [
        { id: 'inside', label: 'Next', landmarkId: 'main' },
        { id: 'outside', label: 'Close' },
        { id: 'orphan', label: 'Back', landmarkId: 'missing' },
        { id: 'disabled-outside', label: 'Later', disabled: true },
      ],
    });

    expect(issues.map((issue) => issue.element)).toEqual(['outside', 'orphan']);
    expect(issues.every((issue) => issue.code === 'focusable-outside-landmark')).toBe(true);
  });

  it('reports a duplicated id once and counts every use', () => {
    const issues = auditStructure({
      landmarks: [
        { id: 'toolbar', role: 'main' },
        { id: 'toolbar', role: 'navigation' },
      ],
      images: [{ id: 'toolbar', alt: 'Logo' }],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'duplicate-id', element: 'toolbar' });
    expect(issues[0]?.message).toContain('3 times');
  });

  it('finds every documented issue code in one broken description, in a stable order', () => {
    const issues = auditStructure({
      landmarks: [
        { id: 'nav', role: 'navigation' },
        { id: 'nav', role: 'banner' },
      ],
      headings: [
        { level: 1, text: 'Reader' },
        { level: 3, text: 'Settings' },
      ],
      interactive: [
        { id: 'unlabelled', role: 'button', landmarkId: 'nav' },
        { id: 'lost', role: 'link' },
      ],
      images: [{ id: 'hero' }],
    });

    expect(issues.map((issue) => issue.code)).toEqual([
      'missing-main-landmark',
      'heading-level-skip',
      'interactive-without-label',
      'interactive-without-label',
      'image-without-alt',
      'focusable-outside-landmark',
      'duplicate-id',
    ]);
    for (const issue of issues) {
      expect(issue.element.length).toBeGreaterThan(0);
      expect(issue.message.length).toBeGreaterThan(0);
    }
  });

  it('rejects a section that is present but not an array', () => {
    expect(() =>
      auditStructure({ landmarks: 'main' } as unknown as StructureDescription),
    ).toThrow(TypeError);
  });
});

describe('focusOrder', () => {
  it('puts positive tabIndex values first, then zeros in document order, and drops negatives', () => {
    const elements: FocusElement[] = [
      { id: 'negative', tabIndex: -1 },
      { id: 'second-zero', tabIndex: 0, order: 2 },
      { id: 'first-zero', tabIndex: 0, order: 1 },
      { id: 'late-positive', tabIndex: 2, order: 0 },
      { id: 'early-positive', tabIndex: 1, order: 5 },
      { id: 'disabled-zero', tabIndex: 0, order: 0, disabled: true },
    ];

    expect(focusOrder(elements).ids).toEqual([
      'early-positive',
      'late-positive',
      'first-zero',
      'second-zero',
    ]);
  });

  it('defaults a missing tabIndex to 0 and a missing order to the input position', () => {
    const result = focusOrder([
      { id: 'a' },
      { id: 'b', tabIndex: 0 },
      { id: 'c', tabIndex: Number.NaN },
    ]);

    expect(result.ids).toEqual(['a', 'b', 'c']);
    expect(result.warnings).toEqual([]);
  });

  it('breaks ties between equal positive tabIndex values by document order', () => {
    const result = focusOrder([
      { id: 'positive-late', tabIndex: 1, order: 2 },
      { id: 'positive-early', tabIndex: 1, order: 1 },
      { id: 'zero-late', order: 2 },
      { id: 'zero-early', order: 1 },
    ]);

    expect(result.ids).toEqual(['positive-early', 'positive-late', 'zero-early', 'zero-late']);
  });

  it('warns about each positive tabIndex, in input order, without changing the order', () => {
    const result = focusOrder([
      { id: 'late-positive', tabIndex: 2, order: 0 },
      { id: 'early-positive', tabIndex: 1, order: 5 },
      { id: 'zero', order: 1 },
      { id: 'negative', tabIndex: -1 },
    ]);

    expect(result.warnings.map((warning) => warning.element)).toEqual([
      'late-positive',
      'early-positive',
    ]);
    expect(result.warnings[0]).toMatchObject({
      code: 'positive-tabindex',
      element: 'late-positive',
      tabIndex: 2,
    });
    expect(result.warnings[0]?.message).toContain('positive tabIndex');
    expect(result.ids).toEqual(['early-positive', 'late-positive', 'zero']);
  });

  it('does not warn about a disabled positive tabIndex, because it is not focusable', () => {
    const result = focusOrder([
      { id: 'disabled-positive', tabIndex: 2, disabled: true },
      { id: 'visible' },
    ]);

    expect(result.ids).toEqual(['visible']);
    expect(result.warnings).toEqual([]);
  });
});
