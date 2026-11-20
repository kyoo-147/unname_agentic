import { describe, expect, it } from 'vitest';
import type { SemanticBlockType } from '../src/core/blocks';
import {
  extractLinks,
  linkReference,
  renumberLinks,
  toMarkdownLinks,
  type ExtractLinksResult,
  type Link,
  type LinkInputBlock,
  type UnresolvedLink,
} from '../src/core/links';
import { buildDocument } from '../src/core/ir';
import { buildOutline } from '../src/core/outline';
import type { Rect } from '../src/core/types';

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

/** A fixture block with its fields all present, so it fits `buildOutline` too. */
interface TestBlock extends LinkInputBlock {
  id: string;
  type: SemanticBlockType;
  page: number;
  text: string;
}

function block(
  id: string,
  type: SemanticBlockType,
  page: number,
  text: string,
  headingLevel?: number,
): TestBlock {
  const row: TestBlock = { id, type, page, text };
  if (headingLevel !== undefined) row.headingLevel = headingLevel;
  return row;
}

function onlyLink(result: ExtractLinksResult): Link {
  expect(result.links).toHaveLength(1);
  const [link] = result.links;
  if (link === undefined) throw new Error('expected exactly one link');
  return link;
}

function onlyUnresolved(result: ExtractLinksResult): UnresolvedLink {
  expect(result.unresolved).toHaveLength(1);
  const [row] = result.unresolved;
  if (row === undefined) throw new Error('expected exactly one unresolved reference');
  return row;
}

describe('extractLinks: footnotes', () => {
  it('resolves a bracketed marker to its footnote', () => {
    const result = extractLinks([
      block('p1-r0', 'paragraph', 1, 'The cells were counted twice.[1]'),
      block('p1-r1', 'footnote', 1, '1 Counted by two independent observers.'),
    ]);

    expect(result.unresolved).toEqual([]);
    expect(onlyLink(result)).toEqual({
      fromBlockId: 'p1-r0',
      kind: 'footnote',
      targetBlockId: 'p1-r1',
      label: '[1]',
      page: 1,
    });
  });

  it('resolves a superscript that lost its baseline at the end of a sentence', () => {
    const result = extractLinks([
      block('p1-r0', 'paragraph', 1, 'The cells were counted twice.3'),
      block('p1-r1', 'footnote', 1, '3 Two independent observers.'),
    ]);

    expect(result.unresolved).toEqual([]);
    const link = onlyLink(result);
    expect(link.targetBlockId).toBe('p1-r1');
    expect(link.label).toBe('3');
  });

  it('resolves a marker that survived extraction as a block of its own', () => {
    const result = extractLinks([
      block('p1-r0', 'paragraph', 1, 'The cells were counted twice.'),
      block('p1-r1', 'other', 1, '4'),
      block('p1-r2', 'footnote', 1, '4 Two independent observers.'),
    ]);

    expect(result.unresolved).toEqual([]);
    expect(onlyLink(result)).toEqual({
      fromBlockId: 'p1-r1',
      kind: 'footnote',
      targetBlockId: 'p1-r2',
      label: '4',
      page: 1,
    });
  });

  it('leaves a dangling marker unresolved with its reason and reference', () => {
    const result = extractLinks([
      block('p1-r0', 'paragraph', 1, 'The cells were counted twice.[7]'),
      block('p1-r1', 'footnote', 1, '1 Counted by two independent observers.'),
    ]);

    expect(result.links).toEqual([]);
    expect(onlyUnresolved(result)).toEqual({
      fromBlockId: 'p1-r0',
      kind: 'footnote',
      label: '[7]',
      page: 1,
      reason: 'no-footnote',
      reference: 'footnote:7',
      candidateIds: [],
    });
  });

  it('reports a tie instead of guessing when two footnotes share a number and a page', () => {
    const result = extractLinks([
      block('p1-r0', 'paragraph', 1, 'The cells were counted twice.[1]'),
      block('p1-r1', 'footnote', 1, '1 First reading.'),
      block('p1-r2', 'footnote', 1, '[1] Second reading.'),
    ]);

    expect(result.links).toEqual([]);
    const unresolved = onlyUnresolved(result);
    expect(unresolved.reason).toBe('ambiguous-footnote');
    expect(unresolved.candidateIds).toEqual(['p1-r1', 'p1-r2']);
  });

  it('follows the marker to its own page when the number repeats', () => {
    const result = extractLinks([
      block('p2-r0', 'paragraph', 2, 'As noted earlier.[1]'),
      block('p1-r0', 'footnote', 1, '1 From the previous page.'),
      block('p2-r1', 'footnote', 2, '1 From this page.'),
    ]);

    expect(result.unresolved).toEqual([]);
    expect(onlyLink(result).targetBlockId).toBe('p2-r1');
  });

  it('reports a footnote that only exists beyond the page reach', () => {
    const result = extractLinks([
      block('p1-r0', 'paragraph', 1, 'As noted earlier.[1]'),
      block('p3-r0', 'footnote', 3, '1 Three pages further on.'),
    ]);

    expect(result.links).toEqual([]);
    const unresolved = onlyUnresolved(result);
    expect(unresolved.reason).toBe('footnote-out-of-reach');
    expect(unresolved.candidateIds).toEqual(['p3-r0']);
  });

  it('does not read a figure reference as a footnote marker', () => {
    const result = extractLinks([
      block('p1-r0', 'paragraph', 1, 'The cells are shown in Figure 3'),
      block('p1-r1', 'caption', 1, 'Figure 3. Cells under load.'),
    ]);

    expect(result.unresolved).toEqual([]);
    const link = onlyLink(result);
    expect(link.kind).toBe('figure');
    expect(link.targetBlockId).toBe('p1-r1');
  });

  it('does not read a trailing decimal as a footnote marker', () => {
    const result = extractLinks([
      block('p1-r0', 'paragraph', 1, 'The ratio was 3.5'),
      block('p1-r1', 'footnote', 1, '5 A five, not a marker.'),
    ]);

    expect(result.links).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});

describe('extractLinks: figure and table references', () => {
  it('resolves Figure 3 to the caption that carries number 3 on another page', () => {
    const result = extractLinks([
      block('p5-r0', 'paragraph', 5, 'Cells under load are shown in Figure 3.'),
      block('p2-r4', 'caption', 2, 'Figure 3. Cells under load.'),
    ]);

    expect(result.unresolved).toEqual([]);
    expect(onlyLink(result)).toEqual({
      fromBlockId: 'p5-r0',
      kind: 'figure',
      targetBlockId: 'p2-r4',
      label: 'Figure 3',
      page: 5,
    });
  });

  it('resolves a Vietnamese table reference to its caption', () => {
    const result = extractLinks([
      block('p1-r0', 'paragraph', 1, 'Kết quả được tóm tắt trong Bảng 2.'),
      block('p1-r1', 'caption', 1, 'Bảng 2. Kết quả đo.'),
    ]);

    expect(result.unresolved).toEqual([]);
    const link = onlyLink(result);
    expect(link.kind).toBe('table');
    expect(link.targetBlockId).toBe('p1-r1');
    expect(link.label).toBe('Bảng 2');
  });

  it('reports a figure no caption carries', () => {
    const result = extractLinks([
      block('p1-r0', 'paragraph', 1, 'See Figure 9 for the setup.'),
      block('p1-r1', 'caption', 1, 'Figure 3. Cells under load.'),
    ]);

    expect(result.links).toEqual([]);
    expect(onlyUnresolved(result)).toEqual({
      fromBlockId: 'p1-r0',
      kind: 'figure',
      label: 'Figure 9',
      page: 1,
      reason: 'no-caption',
      reference: 'figure:9',
      candidateIds: [],
    });
  });

  it('reports a tie between two captions that carry the same number on one page', () => {
    const result = extractLinks([
      block('p2-r0', 'paragraph', 2, 'Cells are shown in Figure 3.'),
      block('p2-r1', 'caption', 2, 'Figure 3. Cells under load.'),
      block('p2-r2', 'caption', 2, 'Figure 3. Cells under load, second reading.'),
    ]);

    expect(result.links).toEqual([]);
    const unresolved = onlyUnresolved(result);
    expect(unresolved.reason).toBe('ambiguous-caption');
    expect(unresolved.candidateIds).toEqual(['p2-r1', 'p2-r2']);
  });

  it('never lets a caption refer to itself', () => {
    const result = extractLinks([
      block('cap', 'caption', 1, 'Figure 3. Cells under load.'),
      block('fig', 'figure', 1, 'Figure 3. Cells under load.'),
    ]);

    expect(result.links).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });
});

describe('extractLinks: section references', () => {
  const sectioned = [
    block('h-intro', 'heading', 1, 'Introduction', 1),
    block('p1', 'paragraph', 1, 'The method is described in section 2.1 in detail.'),
    block('h-method', 'heading', 2, 'Method', 1),
    block('h-sampling', 'heading', 2, 'Sampling', 2),
    block('p2', 'paragraph', 2, 'Samples were drawn every hour.'),
  ];

  it('resolves section 2.1 through the number path the outline assigns', () => {
    const result = extractLinks(sectioned);

    expect(result.unresolved).toEqual([]);
    expect(onlyLink(result)).toEqual({
      fromBlockId: 'p1',
      kind: 'section',
      targetSectionId: 'outline-h3',
      targetBlockId: 'p2',
      label: 'section 2.1',
      page: 1,
    });
  });

  it('reports a section the outline does not have', () => {
    const result = extractLinks([
      block('h1', 'heading', 1, 'Introduction', 1),
      block('p1', 'paragraph', 1, 'See section 9.2 for the details.'),
    ]);

    expect(result.links).toEqual([]);
    expect(onlyUnresolved(result)).toEqual({
      fromBlockId: 'p1',
      kind: 'section',
      label: 'section 9.2',
      page: 1,
      reason: 'no-section',
      reference: 'section:9.2',
      candidateIds: [],
    });
  });

  it('uses a supplied outline because IR blocks carry no heading levels', () => {
    const ir = buildDocument({
      sourceSha256: 'a'.repeat(64),
      pages: [{ index: 1, width: 612, height: 792 }],
      blocks: [
        { page: 1, type: 'heading', text: 'Introduction', rect: rect(60, 80, 400, 20) },
        {
          page: 1,
          type: 'paragraph',
          text: 'The method is described in section 2.1 in detail.',
          rect: rect(60, 120, 400, 20),
        },
      ],
    });
    const outline = buildOutline([
      block('h-intro', 'heading', 1, 'Introduction', 1),
      block('p1', 'paragraph', 1, 'Background.'),
      block('h-method', 'heading', 2, 'Method', 1),
      block('h-sampling', 'heading', 2, 'Sampling', 2),
      block('p2', 'paragraph', 2, 'Samples were drawn every hour.'),
    ]);

    const supplied = extractLinks(ir.blocks, { outline });
    expect(supplied.unresolved).toEqual([]);
    expect(onlyLink(supplied)).toEqual({
      fromBlockId: 'p1-r1',
      kind: 'section',
      targetSectionId: 'outline-h3',
      targetBlockId: 'p2',
      label: 'section 2.1',
      page: 1,
    });

    // Without the levels only flat paths `1`, `2`, ... exist, so a dotted path cannot
    // be honoured: the reference is reported instead of being snapped onto section 2.
    const fallback = extractLinks(ir.blocks);
    expect(fallback.links).toEqual([]);
    expect(onlyUnresolved(fallback).reason).toBe('no-section');
  });
});

describe('renumberLinks', () => {
  const fixture = [
    block('ref', 'paragraph', 1, 'Cells are shown in Figure 3 and counted twice.[1]'),
    block('fig', 'figure', 1, 'Figure 3. Cells under load.'),
    block('fn', 'footnote', 1, '1 Counted twice.'),
  ];

  it('remaps block ids and the printed reference', () => {
    const links = extractLinks(fixture).links;
    const renumbered = renumberLinks(links, {
      blocks: { ref: 'p5-r0', fig: 'p7-r3', fn: 'p7-r4' },
      references: { 'figure:3': 'figure:5', 'footnote:1': 'footnote:6' },
    });

    expect(renumbered).toEqual([
      { fromBlockId: 'p5-r0', kind: 'figure', targetBlockId: 'p7-r3', label: 'Figure 5', page: 1 },
      { fromBlockId: 'p5-r0', kind: 'footnote', targetBlockId: 'p7-r4', label: '[6]', page: 1 },
    ]);
  });

  it('remaps the section a reference points at', () => {
    const links = extractLinks([
      block('h-intro', 'heading', 1, 'Introduction', 1),
      block('p1', 'paragraph', 1, 'The method is described in section 2.1 in detail.'),
      block('h-method', 'heading', 2, 'Method', 1),
      block('h-sampling', 'heading', 2, 'Sampling', 2),
      block('p2', 'paragraph', 2, 'Samples were drawn every hour.'),
    ]).links;

    const renumbered = renumberLinks(links, {
      blocks: { p1: 'p9-r0', p2: 'p9-r1' },
      sections: { 'outline-h3': 'outline-h7' },
      references: { 'section:2.1': 'section:3.4' },
    });

    expect(renumbered).toEqual([
      {
        fromBlockId: 'p9-r0',
        kind: 'section',
        targetSectionId: 'outline-h7',
        targetBlockId: 'p9-r1',
        label: 'section 3.4',
        page: 1,
      },
    ]);
  });

  it('leaves ids the map does not name alone and does not mutate the input', () => {
    const links = extractLinks(fixture).links;
    const before = JSON.parse(JSON.stringify(links)) as Link[];

    const renumbered = renumberLinks(links, { blocks: { fig: 'p9-r0' } });

    expect(JSON.parse(JSON.stringify(links))).toEqual(before);
    expect(renumbered[0]).not.toBe(links[0]);
    expect(renumbered[0]?.targetBlockId).toBe('p9-r0');
    expect(renumbered[0]?.fromBlockId).toBe('ref');
    expect(renumbered[1]?.targetBlockId).toBe('fn');
  });

  it('ignores a reference remap that changes the kind', () => {
    const links = extractLinks(fixture).links;
    const renumbered = renumberLinks(links, { references: { 'figure:3': 'table:5' } });

    expect(renumbered[0]?.label).toBe('Figure 3');
  });

  it('names a reference in the normalised form a renaming map is keyed by', () => {
    const links = extractLinks(fixture).links;
    const [figure, note] = links;
    if (figure === undefined || note === undefined) throw new Error('expected two links');

    expect(linkReference(figure)).toBe('figure:3');
    expect(linkReference(note)).toBe('footnote:1');
    expect(linkReference({ fromBlockId: 'p1', kind: 'section', label: 'section 2.1', page: 1 })).toBe(
      'section:2.1',
    );
    expect(linkReference({ fromBlockId: 'p1', kind: 'figure', label: 'no number here', page: 1 })).toBe('');
  });
});

describe('toMarkdownLinks', () => {
  const ir = buildDocument({
    sourceSha256: 'b'.repeat(64),
    pages: [{ index: 1, width: 612, height: 792 }],
    blocks: [
      {
        page: 1,
        type: 'paragraph',
        text: 'Cells under load are shown in Figure 3.',
        rect: rect(60, 100, 400, 20),
      },
      { page: 1, type: 'figure', text: 'Figure 3. Cells under load.', rect: rect(60, 200, 400, 120) },
      { page: 1, type: 'paragraph', text: 'The cells were counted twice.[1]', rect: rect(60, 340, 400, 20) },
      { page: 1, type: 'footnote', text: '1 Counted by two observers.', rect: rect(60, 700, 400, 12) },
    ],
  });

  it('writes one bullet per link with the target block id as the anchor', () => {
    const links = extractLinks(ir.blocks).links;
    expect(links).toHaveLength(2);

    const markdown = toMarkdownLinks(links, ir);
    expect(markdown).toBe('- [Figure 3](#p1-r1)\n- [\\[1\\]](#p1-r3)');
  });

  it('orders the fragment by the source block reading order', () => {
    const links = extractLinks(ir.blocks).links;
    expect(toMarkdownLinks([...links].reverse(), ir)).toBe(toMarkdownLinks(links, ir));
  });

  it('returns an empty string when there is nothing to write', () => {
    expect(toMarkdownLinks([], ir)).toBe('');
  });

  it('skips a link that has no block target to anchor to', () => {
    const sectionOnly: Link = {
      fromBlockId: 'p1-r0',
      kind: 'section',
      targetSectionId: 'outline-h2',
      label: 'section 2',
      page: 1,
    };

    expect(toMarkdownLinks([sectionOnly], ir)).toBe('');
  });
});
