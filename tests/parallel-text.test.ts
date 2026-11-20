import { describe, expect, it } from 'vitest';
import {
  alignSegments,
  fromTmx,
  isRatioOutOfBand,
  lengthRatio,
  ParallelTextError,
  RATIO_WARNING_MAX,
  RATIO_WARNING_MIN,
  toParallelMarkdown,
  toTmx,
} from '../src/core/parallel-text';
import type { AlignedSegment, ParallelBlock, ParallelTranslation } from '../src/core/parallel-text';

function block(id: string, page: number, text: string): ParallelBlock {
  return { id, page, text };
}

function translation(blockId: string, text: string): ParallelTranslation {
  return { blockId, text };
}

function capture(run: () => unknown): ParallelTextError {
  try {
    run();
  } catch (error) {
    if (error instanceof ParallelTextError) return error;
    throw error;
  }
  throw new Error('expected a ParallelTextError');
}

describe('alignSegments', () => {
  it('keeps the block order and page numbers and aligns by id, not by translation order', () => {
    const blocks = [
      block('p2-r0', 2, 'Beta source'),
      block('p1-r0', 1, 'Alpha source'),
      block('p1-r1', 1, 'Second line'),
    ];
    const translations = [
      translation('p1-r0', 'Alpha target'),
      translation('p2-r0', 'Beta target'),
      translation('p1-r1', 'Dòng hai'),
    ];

    const result = alignSegments(blocks, translations);

    expect(result.segments.map(segment => [segment.blockId, segment.page, segment.source, segment.target])).toEqual([
      ['p2-r0', 2, 'Beta source', 'Beta target'],
      ['p1-r0', 1, 'Alpha source', 'Alpha target'],
      ['p1-r1', 1, 'Second line', 'Dòng hai'],
    ]);
    expect(result.segments.every(segment => segment.ratioWarning === false)).toBe(true);
    expect(result.unaligned).toEqual([]);
  });

  it('reports a block without a translation as unaligned with a reason', () => {
    const result = alignSegments(
      [block('p1-r0', 1, 'One'), block('p1-r1', 1, 'Two')],
      [translation('p1-r0', 'Một')],
    );

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]!.blockId).toBe('p1-r0');
    expect(result.unaligned).toEqual([
      { blockId: 'p1-r1', page: 1, reason: 'missing-translation', detail: expect.any(String) },
    ]);
  });

  it('reports an orphan translation with no page', () => {
    const result = alignSegments(
      [block('p1-r0', 1, 'One')],
      [translation('p1-r0', 'Một'), translation('p9-r0', 'Không')],
    );

    expect(result.segments.map(segment => segment.blockId)).toEqual(['p1-r0']);
    expect(result.unaligned).toEqual([
      { blockId: 'p9-r0', page: null, reason: 'orphan-translation', detail: expect.any(String) },
    ]);
  });

  it('aligns the first translation and reports a repeated one instead of overwriting it', () => {
    const result = alignSegments(
      [block('p1-r0', 1, 'One')],
      [translation('p1-r0', 'Một'), translation('p1-r0', 'Hai')],
    );

    expect(result.segments[0]!.target).toBe('Một');
    expect(result.unaligned).toEqual([
      { blockId: 'p1-r0', page: 1, reason: 'duplicate-translation', detail: expect.any(String) },
    ]);
  });

  it('reports a repeated block id and does not emit the same block twice', () => {
    const result = alignSegments(
      [block('p1-r0', 1, 'One'), block('p1-r0', 1, 'One again')],
      [translation('p1-r0', 'Một')],
    );

    expect(result.segments).toHaveLength(1);
    expect(result.unaligned).toEqual([
      { blockId: 'p1-r0', page: 1, reason: 'duplicate-block', detail: expect.any(String) },
    ]);
  });

  it('reports a block with no usable page instead of pretending it is page 1', () => {
    const result = alignSegments([block('p1-r0', 0, 'One')], [translation('p1-r0', 'Một')]);

    expect(result.segments).toEqual([]);
    expect(result.unaligned).toEqual([
      { blockId: 'p1-r0', page: null, reason: 'invalid-block', detail: expect.any(String) },
    ]);
  });

  it('returns empty lists for empty input', () => {
    expect(alignSegments([], [])).toEqual({ segments: [], unaligned: [] });
  });
});

describe('length ratio', () => {
  it('flags a pair outside the documented warning band', () => {
    const source = 'a'.repeat(100);
    const target = 'b'.repeat(20);
    const result = alignSegments([block('p1-r0', 1, source)], [translation('p1-r0', target)]);
    const segment = result.segments[0]!;

    expect(segment.ratio).toBeCloseTo(0.2, 10);
    expect(segment.ratioWarning).toBe(true);
    expect(isRatioOutOfBand(segment.ratio)).toBe(true);
  });

  it('keeps the band inclusive and warns about non-finite ratios', () => {
    expect(isRatioOutOfBand(RATIO_WARNING_MIN)).toBe(false);
    expect(isRatioOutOfBand(RATIO_WARNING_MAX)).toBe(false);
    expect(isRatioOutOfBand(0.399)).toBe(true);
    expect(isRatioOutOfBand(2.501)).toBe(true);
    expect(isRatioOutOfBand(Number.NaN)).toBe(true);
    expect(isRatioOutOfBand(Number.POSITIVE_INFINITY)).toBe(true);
  });

  it('defines the ratio for empty sides without dividing by zero silently', () => {
    expect(lengthRatio('', '')).toBe(1);
    expect(lengthRatio('', 'target')).toBe(Number.POSITIVE_INFINITY);

    const result = alignSegments([block('p1-r0', 1, '')], [translation('p1-r0', 'target')]);
    expect(result.segments[0]!.ratioWarning).toBe(true);
  });
});

describe('toParallelMarkdown', () => {
  const blocks = [
    block('p2-r0', 2, 'Second page'),
    block('p1-r0', 1, 'Hello'),
    block('p1-r1', 1, 'World'),
  ];
  const translations = [
    translation('p2-r0', 'Trang hai'),
    translation('p1-r0', 'Xin chào'),
    translation('p1-r1', 'Thế giới'),
  ];

  it('groups by page in ascending order and anchors every block id', () => {
    const result = alignSegments(blocks, translations);
    const markdown = toParallelMarkdown(result.segments);

    expect(markdown.startsWith('# Parallel text\n\n## Page 1')).toBe(true);
    expect(markdown).toContain('<a id="p1-r0"></a>');
    expect(markdown).toContain('<a id="p1-r1"></a>');
    expect(markdown).toContain('<a id="p2-r0"></a>');
    expect(markdown.indexOf('## Page 1')).toBeLessThan(markdown.indexOf('## Page 2'));
    expect(markdown.indexOf('## Page 1')).toBeLessThan(markdown.indexOf('<a id="p2-r0"></a>'));
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('interleaves the source before its target for each block', () => {
    const result = alignSegments(blocks, translations);
    const markdown = toParallelMarkdown(result.segments);

    expect(markdown).toContain('**Source**');
    expect(markdown).toContain('**Target**');
    expect(markdown.indexOf('> Hello')).toBeLessThan(markdown.indexOf('> Xin chào'));
    expect(markdown.indexOf('> Xin chào')).toBeLessThan(markdown.indexOf('> World'));
    expect(markdown.indexOf('> World')).toBeLessThan(markdown.indexOf('> Thế giới'));
  });

  it('honours custom labels and title', () => {
    const result = alignSegments(blocks, translations);
    const markdown = toParallelMarkdown(result.segments, {
      title: 'Bilingual export',
      sourceLabel: 'Original',
      targetLabel: 'Translation',
      pageLabel: 'Sheet ',
    });

    expect(markdown.startsWith('# Bilingual export')).toBe(true);
    expect(markdown).toContain('## Sheet 1');
    expect(markdown).toContain('**Original**');
    expect(markdown).toContain('**Translation**');
  });

  it('escapes markdown metacharacters so source text cannot become structure', () => {
    const result = alignSegments(
      [block('p1-r0', 1, '# <b> & *not bold*')],
      [translation('p1-r0', 'safe')],
    );
    const markdown = toParallelMarkdown(result.segments);

    expect(markdown).toContain('> \\# \\<b\\> \\& \\*not bold\\*');
    expect(markdown).not.toContain('> # <b>');
  });

  it('returns an empty string for empty input', () => {
    expect(toParallelMarkdown([])).toBe('');
  });
});

describe('TMX', () => {
  const segments: AlignedSegment[] = alignSegments(
    [block('p1-r0', 1, 'Hello'), block('p1-r1', 1, 'Second line')],
    [translation('p1-r0', 'Xin chào'), translation('p1-r1', 'Dòng hai')],
  ).segments;

  it('writes a valid TMX 1.4 document and reads it back unchanged', () => {
    const xml = toTmx(segments, { source: 'en', target: 'vi' });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<tmx version="1.4">');
    expect(xml).toContain('srclang="en"');
    expect(xml).toContain('<tu tuid="p1-r0">');
    expect(xml).toContain('<prop type="page">1</prop>');
    expect(xml).toContain('<tuv xml:lang="vi">');

    const parsed = fromTmx(xml);
    expect(parsed.langs).toEqual({ source: 'en', target: 'vi' });
    expect(parsed.segments).toEqual(segments);
  });

  it('escapes angle brackets and ampersands in both directions', () => {
    const tricky = alignSegments(
      [block('p1-r0', 1, 'A & B < C > D')],
      [translation('p1-r0', 'X &amp; Y <Z>')],
    ).segments;
    const xml = toTmx(tricky, { source: 'en', target: 'vi' });

    expect(xml).toContain('<seg>A &amp; B &lt; C &gt; D</seg>');
    expect(xml).toContain('<seg>X &amp;amp; Y &lt;Z&gt;</seg>');
    expect(fromTmx(xml).segments).toEqual(tricky);

    const oddIds = alignSegments([block('p&1<2', 1, 'source')], [translation('p&1<2', 'target')]).segments;
    const idXml = toTmx(oddIds, { source: 'en', target: 'vi' });
    expect(idXml).toContain('tuid="p&amp;1&lt;2"');
    expect(fromTmx(idXml).segments).toEqual(oddIds);
  });

  it('keeps a page prop and the block id through the round trip', () => {
    const xml = toTmx(
      [
        { blockId: 'p7-r3', page: 7, source: 'source', target: 'target', ratio: 1, ratioWarning: false },
      ],
      { source: 'en', target: 'vi' },
    );
    const parsed = fromTmx(xml);

    expect(parsed.segments[0]!.blockId).toBe('p7-r3');
    expect(parsed.segments[0]!.page).toBe(7);
  });

  it('refuses a malformed document with the line the fault starts on', () => {
    const broken = [
      '<?xml version="1.0" encoding="UTF-8"?>', // 1
      '<tmx version="1.4">', // 2
      '  <header srclang="en" datatype="plaintext"/>', // 3
      '  <body>', // 4
      '    <tu tuid="p1-r0">', // 5
      '      <tuv xml:lang="en"><seg>Hello</seg></tuv>', // 6
      '      <tuv xml:lang="vi"><seg>Xin chào</seg></tuv>', // 7
      '  </body>', // 8
      '</tmx>', // 9
    ].join('\n');

    const error = capture(() => fromTmx(broken));

    expect(error.code).toBe('malformed-tmx');
    expect(error.line).toBe(8);
    expect(error.message).toContain('line 8');
  });

  it('refuses a document without a header', () => {
    const error = capture(() => fromTmx('<tmx version="1.4"><body></body></tmx>'));

    expect(error.code).toBe('malformed-tmx');
    expect(error.line).toBe(1);
  });

  it('refuses two target languages in one document instead of guessing one', () => {
    const mixed = [
      '<tmx version="1.4">',
      '  <header srclang="en" datatype="plaintext"/>',
      '  <body>',
      '    <tu tuid="p1-r0"><tuv xml:lang="en"><seg>a</seg></tuv><tuv xml:lang="vi"><seg>b</seg></tuv></tu>',
      '    <tu tuid="p1-r1"><tuv xml:lang="en"><seg>c</seg></tuv><tuv xml:lang="fr"><seg>d</seg></tuv></tu>',
      '  </body>',
      '</tmx>',
    ].join('\n');
    const error = capture(() => fromTmx(mixed));

    expect(error.code).toBe('unsupported-tmx');
    expect(error.line).toBe(5);
  });

  it('refuses a TMX datatype it cannot read', () => {
    const xml = toTmx([], { source: 'en', target: 'vi' }).replace('datatype="plaintext"', 'datatype="html"');
    const error = capture(() => fromTmx(xml));

    expect(error.code).toBe('unsupported-tmx');
    expect(error.line).toBe(3);
  });

  it('refuses a target that is not a BCP 47 tag or equals the source', () => {
    expect(capture(() => toTmx([], { source: 'en', target: 'not a tag!' })).code).toBe('invalid-language');
    expect(capture(() => toTmx([], { source: 'en', target: 'EN' })).code).toBe('invalid-language');
  });

  it('handles empty input as an empty but well-formed TMX document', () => {
    const xml = toTmx([], { source: 'en', target: 'vi' });
    const parsed = fromTmx(xml);

    expect(parsed.segments).toEqual([]);
    expect(parsed.langs.source).toBe('en');
  });
});
