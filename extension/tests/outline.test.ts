import { describe, expect, it } from 'vitest';
import {
  buildOutline,
  flattenOutline,
  sectionAt,
  SECTION_ID_PREFIX,
  SYNTHETIC_BLOCK_ID_PREFIX,
  UNTITLED_LEVEL,
  UNTITLED_SECTION_ID,
  type Outline,
  type OutlineBlockInput,
  type Section,
} from '../viewer/src/core/outline';

function heading(id: string, text: string, level: number, page = 1): OutlineBlockInput {
  return { id, page, text, type: 'heading', headingLevel: level };
}

function paragraph(id: string, text = id, page = 1): OutlineBlockInput {
  return { id, page, text, type: 'paragraph' };
}

// A chapter / section / subsection document: two top-level headings, one of them with
// two subsections and one of those with a subsection of its own.
function threeLevelDocument(): OutlineBlockInput[] {
  return [
    heading('p1-r0', '1 Introduction', 1),
    paragraph('p1-r1', 'Opening paragraph.'),
    heading('p1-r2', '1.1 Background', 2),
    paragraph('p1-r3', 'Background paragraph.'),
    heading('p1-r4', '1.1.1 Early work', 3),
    paragraph('p1-r5', 'Early work paragraph.'),
    heading('p1-r6', '1.2 Scope', 2),
    paragraph('p1-r7', 'Scope paragraph.'),
    heading('p2-r0', '2 Methods', 1, 2),
    paragraph('p2-r1', 'Methods paragraph.', 2),
  ];
}

function titles(sections: readonly Section[]): string[] {
  return sections.map(section => section.title);
}

function paths(outline: Outline): string[] {
  return outline.toc.map(entry => entry.path);
}

describe('buildOutline: three-level document', () => {
  it('nests level-1, level-2 and level-3 headings into one tree', () => {
    const outline = buildOutline(threeLevelDocument());

    expect(titles(outline.sections)).toEqual(['1 Introduction', '2 Methods']);
    const [introduction, methods] = outline.sections;
    expect(titles(introduction?.children ?? [])).toEqual(['1.1 Background', '1.2 Scope']);
    expect(titles(introduction?.children[0]?.children ?? [])).toEqual(['1.1.1 Early work']);
    expect(methods?.children).toEqual([]);

    // The applied levels follow the nesting, not the heading text.
    const levels = outline.toc.map(entry => entry.level);
    expect(levels).toEqual([1, 2, 3, 2, 1]);
  });

  it('points every section at the block after its heading, not at the heading', () => {
    const outline = buildOutline(threeLevelDocument());
    expect(outline.toc.map(entry => entry.blockId)).toEqual([
      'p1-r1',
      'p1-r3',
      'p1-r5',
      'p1-r7',
      'p2-r1',
    ]);
    expect(outline.sections[0]?.blockId).toBe('p1-r1');
    expect(outline.sections[1]?.page).toBe(2);
  });

  it('numbers the table of contents 1, 1.1, 1.1.1, 1.2, 2', () => {
    const outline = buildOutline(threeLevelDocument());
    expect(paths(outline)).toEqual(['1', '1.1', '1.1.1', '1.2', '2']);
    // Nothing in this document needed repairing.
    expect(outline.reports).toEqual([]);
  });
});

describe('flattenOutline', () => {
  it('reports depth and path for every node', () => {
    const outline = buildOutline(threeLevelDocument());
    const rows = flattenOutline(outline).map(entry => ({
      title: entry.title,
      depth: entry.depth,
      path: entry.path,
    }));

    expect(rows).toEqual([
      { title: '1 Introduction', depth: 0, path: '1' },
      { title: '1.1 Background', depth: 1, path: '1.1' },
      { title: '1.1.1 Early work', depth: 2, path: '1.1.1' },
      { title: '1.2 Scope', depth: 1, path: '1.2' },
      { title: '2 Methods', depth: 0, path: '2' },
    ]);
  });

  it('keeps depth one below level for heading sections', () => {
    const outline = buildOutline(threeLevelDocument());
    for (const entry of outline.toc) {
      expect(entry.depth).toBe(entry.level - 1);
    }
  });

  it('returns the same rows buildOutline exposed as toc', () => {
    const outline = buildOutline(threeLevelDocument());
    expect(flattenOutline(outline)).toEqual(outline.toc);
  });

  it('flattens nothing for an empty outline', () => {
    expect(flattenOutline({ sections: [], toc: [], reports: [], members: [] })).toEqual([]);
  });
});

describe('buildOutline: level jumps', () => {
  it('clamps a 1 -> 3 jump to the parent plus one and reports it', () => {
    const outline = buildOutline([
      heading('p1-r0', 'Chapter', 1),
      heading('p1-r1', 'Jumped subsection', 3),
      paragraph('p1-r2', 'Body.'),
    ]);

    expect(outline.toc.map(entry => ({ level: entry.level, path: entry.path }))).toEqual([
      { level: 1, path: '1' },
      { level: 2, path: '1.1' },
    ]);
    expect(outline.sections[0]?.children).toHaveLength(1);
    expect(outline.reports).toEqual([
      {
        code: 'level-jump',
        blockId: 'p1-r1',
        page: 1,
        requestedLevel: 3,
        appliedLevel: 2,
      },
    ]);
  });

  it('clamps a first heading to level 1 because its implicit parent is level 0', () => {
    const outline = buildOutline([
      heading('p1-r0', 'Deep first title', 2),
      paragraph('p1-r1', 'Body.'),
    ]);

    expect(outline.sections[0]?.level).toBe(1);
    expect(outline.toc.map(entry => entry.path)).toEqual(['1']);
    expect(outline.reports).toEqual([
      { code: 'level-jump', blockId: 'p1-r0', page: 1, requestedLevel: 2, appliedLevel: 1 },
    ]);
  });

  it('reads a heading without a level as level 1', () => {
    const outline = buildOutline([
      { id: 'p1-r0', page: 1, text: 'Title without a level', type: 'heading' },
      paragraph('p1-r1', 'Body.'),
    ]);
    expect(outline.sections[0]?.level).toBe(1);
    expect(outline.reports).toEqual([]);
  });

  it('does not clamp a heading that only descends one level', () => {
    const outline = buildOutline([
      heading('p1-r0', 'Chapter', 1),
      heading('p1-r1', 'Section', 2),
      heading('p2-r0', 'Subsection', 3, 2),
    ]);
    expect(outline.reports).toEqual([]);
    expect(outline.toc.map(entry => entry.path)).toEqual(['1', '1.1', '1.1.1']);
  });

  it('closes every section at or below the new level', () => {
    const outline = buildOutline([
      heading('p1-r0', 'A', 1),
      heading('p1-r1', 'A.1', 2),
      heading('p1-r2', 'A.1.a', 3),
      heading('p1-r3', 'B', 1),
      heading('p1-r4', 'B.1', 2),
    ]);

    expect(outline.toc.map(entry => entry.path)).toEqual(['1', '1.1', '1.1.1', '2', '2.1']);
    expect(outline.sections).toHaveLength(2);
  });
});

describe('buildOutline: content before the first heading', () => {
  it('puts the preamble in one untitled root section', () => {
    const outline = buildOutline([
      paragraph('p1-r0', 'Abstract paragraph.'),
      heading('p1-r1', 'Chapter', 1),
      paragraph('p1-r2', 'Body.'),
    ]);

    const untitled = outline.sections[0];
    expect(outline.sections).toHaveLength(2);
    expect(untitled?.id).toBe(UNTITLED_SECTION_ID);
    expect(untitled?.title).toBe('');
    expect(untitled?.level).toBe(UNTITLED_LEVEL);
    expect(untitled?.page).toBe(1);
    expect(untitled?.blockId).toBe('p1-r0');
    expect(untitled?.children).toEqual([]);
    expect(outline.sections[1]?.title).toBe('Chapter');

    expect(outline.reports).toEqual([{ code: 'untitled-root', blockId: 'p1-r0', page: 1 }]);
    expect(outline.toc.map(entry => entry.path)).toEqual(['', '1']);
    expect(outline.toc.map(entry => entry.depth)).toEqual([0, 0]);
  });

  it('keeps a run of preamble blocks together on their pages', () => {
    const outline = buildOutline([
      paragraph('p1-r0', 'First.', 1),
      paragraph('p2-r0', 'Second.', 2),
      heading('p2-r1', 'Chapter', 1, 2),
    ]);

    const untitled = outline.sections[0];
    expect(untitled?.blockId).toBe('p1-r0');
    expect(outline.members.filter(member => member.sectionId === UNTITLED_SECTION_ID)).toEqual([
      { blockId: 'p1-r0', page: 1, sectionId: UNTITLED_SECTION_ID },
      { blockId: 'p2-r0', page: 2, sectionId: UNTITLED_SECTION_ID },
    ]);
  });
});

describe('buildOutline: empty and heading-less documents', () => {
  it('returns an empty outline for an empty document', () => {
    const outline = buildOutline([]);
    expect(outline).toEqual({ sections: [], toc: [], reports: [], members: [] });
    expect(flattenOutline(outline)).toEqual([]);
    expect(sectionAt(outline, 1, 'p1-r0')).toBeNull();
  });

  it('produces exactly one untitled section when nothing is a heading', () => {
    const outline = buildOutline([
      paragraph('p1-r0', 'First paragraph.'),
      { id: 'p1-r1', page: 1, text: 'Second paragraph.', type: 'paragraph', headingLevel: 2 },
      paragraph('p1-r2', 'Third paragraph.'),
    ]);

    expect(outline.sections).toHaveLength(1);
    expect(outline.toc).toHaveLength(1);
    expect(outline.sections[0]?.id).toBe(UNTITLED_SECTION_ID);
    // Everything belongs to it, and a headingLevel on a non-heading block is ignored.
    expect(outline.sections[0]?.blockId).toBe('p1-r0');
    expect(outline.members.map(member => member.sectionId)).toEqual([
      UNTITLED_SECTION_ID,
      UNTITLED_SECTION_ID,
      UNTITLED_SECTION_ID,
    ]);
    expect(outline.toc[0]?.path).toBe('');
    expect(outline.toc[0]?.depth).toBe(0);
  });
});

describe('buildOutline: numbering', () => {
  it('numbers each branch from one', () => {
    const outline = buildOutline([
      heading('p1-r0', 'A', 1),
      heading('p1-r1', 'B', 1),
      heading('p1-r2', 'B.1', 2),
      heading('p1-r3', 'B.2', 2),
      heading('p1-r4', 'B.2.a', 3),
      heading('p1-r5', 'C', 1),
    ]);
    expect(paths(outline)).toEqual(['1', '2', '2.1', '2.2', '2.2.1', '3']);
  });

  it('gives each section a stable id in heading order', () => {
    const outline = buildOutline(threeLevelDocument());
    expect(outline.toc.map(entry => entry.id)).toEqual([
      `${SECTION_ID_PREFIX}1`,
      `${SECTION_ID_PREFIX}2`,
      `${SECTION_ID_PREFIX}3`,
      `${SECTION_ID_PREFIX}4`,
      `${SECTION_ID_PREFIX}5`,
    ]);
  });

  it('folds heading whitespace into the title', () => {
    const outline = buildOutline([heading('p1-r0', '  A   title\nthat wraps  ', 1)]);
    expect(outline.sections[0]?.title).toBe('A title that wraps');
  });
});

describe('buildOutline: jump targets', () => {
  it('falls back to the heading itself when a section holds nothing', () => {
    const outline = buildOutline([
      heading('p1-r0', 'Alpha', 1),
      heading('p1-r1', 'Beta', 1),
      paragraph('p1-r2', 'Body.'),
    ]);
    expect(outline.sections[0]?.blockId).toBe('p1-r0');
    expect(outline.sections[1]?.blockId).toBe('p1-r2');
  });

  it('lends a child target to a parent that has no content of its own', () => {
    const outline = buildOutline([
      heading('p1-r0', 'Chapter', 1),
      heading('p1-r1', 'Section', 2),
      paragraph('p1-r2', 'Body.'),
    ]);
    expect(outline.sections[0]?.blockId).toBe('p1-r2');
    expect(outline.sections[0]?.children[0]?.blockId).toBe('p1-r2');
  });

  it('invents a block id for a block that has none', () => {
    const outline = buildOutline([
      { page: 1, text: 'Title', type: 'heading', headingLevel: 1 },
      { page: 1, text: 'Body', type: 'paragraph' },
    ]);
    expect(outline.sections[0]?.blockId).toBe(`${SYNTHETIC_BLOCK_ID_PREFIX}1`);
    expect(outline.members.map(member => member.blockId)).toEqual([
      `${SYNTHETIC_BLOCK_ID_PREFIX}0`,
      `${SYNTHETIC_BLOCK_ID_PREFIX}1`,
    ]);
  });

  it('leaves the input array and its blocks untouched', () => {
    const document = threeLevelDocument();
    const snapshot = JSON.parse(JSON.stringify(document)) as OutlineBlockInput[];
    buildOutline(document);
    expect(document).toEqual(snapshot);
  });

  it('is deterministic: two builds of the same blocks are equal', () => {
    expect(buildOutline(threeLevelDocument())).toEqual(buildOutline(threeLevelDocument()));
  });
});

describe('sectionAt', () => {
  it('finds the section of a block inside a nested section', () => {
    const outline = buildOutline(threeLevelDocument());
    const section = sectionAt(outline, 1, 'p1-r5');
    expect(section?.title).toBe('1.1.1 Early work');
    expect(section?.id).toBe(`${SECTION_ID_PREFIX}3`);
    // And the entry the reader would scroll to is that section's jump target.
    expect(section?.blockId).toBe('p1-r5');
  });

  it('returns the section a heading itself belongs to', () => {
    const outline = buildOutline(threeLevelDocument());
    expect(sectionAt(outline, 1, 'p1-r4')?.title).toBe('1.1.1 Early work');
    expect(sectionAt(outline, 1, 'p1-r2')?.title).toBe('1.1 Background');
  });

  it('places the preamble before the first heading in the untitled root', () => {
    const outline = buildOutline([
      paragraph('p1-r0', 'Preamble.'),
      heading('p1-r1', 'Chapter', 1),
      paragraph('p1-r2', 'Body.'),
    ]);
    expect(sectionAt(outline, 1, 'p1-r0')?.id).toBe(UNTITLED_SECTION_ID);
    expect(sectionAt(outline, 1, 'p1-r2')?.title).toBe('Chapter');
  });

  it('falls back to the page for a block the outline never saw', () => {
    const outline = buildOutline(threeLevelDocument());
    // Page 2 opens the second chapter; page 1 content resolves to the last section
    // that starts there, which is the documented page fallback.
    expect(sectionAt(outline, 2, 'unknown-block')?.title).toBe('2 Methods');
    expect(sectionAt(outline, 1, 'unknown-block')?.title).toBe('1.2 Scope');
  });

  it('returns the first section for a page before the document', () => {
    const outline = buildOutline(threeLevelDocument());
    expect(sectionAt(outline, 0, 'unknown-block')?.title).toBe('1 Introduction');
    expect(sectionAt(outline, -3, 'unknown-block')?.title).toBe('1 Introduction');
  });

  it('reads a non-finite page as page 1', () => {
    const outline = buildOutline(threeLevelDocument());
    expect(sectionAt(outline, Number.NaN, 'unknown-block')?.title).toBe('1.2 Scope');
    expect(sectionAt(outline, Number.POSITIVE_INFINITY, 'unknown-block')?.title).toBe('1.2 Scope');
  });

  it('maps every member back to its own section', () => {
    const outline = buildOutline(threeLevelDocument());
    for (const member of outline.members) {
      expect(sectionAt(outline, member.page, member.blockId)?.id).toBe(member.sectionId);
    }
  });
});
