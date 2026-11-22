import { describe, expect, it } from 'vitest';
import {
  buildDocument,
  type BlockType,
  type BuildBlockInput,
  type DocumentIR,
} from '../viewer/src/core/ir';
import {
  ANCHOR_PREFIX,
  buildNotes,
  CSV_RECORD_SEPARATOR,
  DEFAULT_MAX_ENTRY_CHARS,
  DEFAULT_MAX_POINTS_PER_SECTION,
  sectionAnchor,
  toAnkiCsv,
  toMarkdown,
  TRUNCATION_MARK,
  UNTITLED_SECTION_TITLE,
} from '../viewer/src/core/notes';

const SOURCE_SHA256 = 'a'.repeat(64);

/** One block at a fixed row, so reading order and therefore ids are predictable. */
function block(page: number, text: string, type: BlockType, y: number): BuildBlockInput {
  return { page, text, type, rect: { x: 0, y, width: 400, height: 14 } };
}

function documentOf(blocks: readonly BuildBlockInput[]): DocumentIR {
  return buildDocument({ blocks, sourceSha256: SOURCE_SHA256, language: 'en' });
}

function idOf(ir: DocumentIR, raw: string): string {
  const found = ir.blocks.find(entry => entry.raw === raw);
  if (!found) throw new Error(`the document has no block reading ${JSON.stringify(raw)}`);
  return found.id;
}

function lengthOf(text: string): number {
  return Array.from(text).length;
}

describe('buildNotes: sections follow the headings', () => {
  it('takes one section per heading, in document order', () => {
    const ir = documentOf([
      block(1, 'Introduction', 'heading', 0),
      block(1, 'Photosynthesis is the process by which plants make food.', 'paragraph', 20),
      block(2, 'Methods', 'heading', 0),
      block(2, 'We ran three trials.', 'paragraph', 20),
    ]);

    const notes = buildNotes(ir);

    expect(notes.sections.map(section => section.title)).toEqual(['Introduction', 'Methods']);
    expect(notes.sections.map(section => section.page)).toEqual([1, 2]);
    expect(notes.sections[0]?.blockId).toBe(
      idOf(ir, 'Photosynthesis is the process by which plants make food.'),
    );
    expect(notes.sections[1]?.blockId).toBe(idOf(ir, 'We ran three trials.'));
    expect(notes.summary.sections).toBe(2);
    expect(notes.summary.points).toBe(2);
  });

  it('keeps preamble content in one untitled section', () => {
    const ir = documentOf([
      block(1, 'The report opens without a heading.', 'paragraph', 0),
      block(1, 'Background', 'heading', 20),
      block(1, 'Background text.', 'paragraph', 40),
    ]);

    const notes = buildNotes(ir);

    expect(notes.sections.map(section => section.title)).toEqual([
      UNTITLED_SECTION_TITLE,
      'Background',
    ]);
    expect(notes.sections[0]?.points.map(point => point.text)).toEqual([
      'The report opens without a heading.',
    ]);
  });

  it('nests sections from explicit heading levels', () => {
    const ir = documentOf([
      block(1, 'Chapter', 'heading', 0),
      block(1, 'Topic', 'heading', 20),
      block(1, 'Topic text.', 'paragraph', 40),
    ]);

    const nested = buildNotes(ir, {
      headingLevels: { [idOf(ir, 'Chapter')]: 1, [idOf(ir, 'Topic')]: 2 },
    });
    expect(nested.sections.map(section => section.title)).toEqual(['Chapter', 'Topic']);
    // A section with no content of its own borrows its first child's jump target.
    expect(nested.sections[0]?.blockId).toBe(idOf(ir, 'Topic text.'));

    // Without the levels both headings are top-level, so Chapter keeps its own block.
    const flat = buildNotes(ir);
    expect(flat.sections.map(section => section.title)).toEqual(['Chapter', 'Topic']);
    expect(flat.sections[0]?.blockId).toBe(idOf(ir, 'Chapter'));
  });

  it('leaves a document with no headings as one untitled section', () => {
    const ir = documentOf([block(1, 'Only a paragraph.', 'paragraph', 0)]);

    const notes = buildNotes(ir);

    expect(notes.sections).toHaveLength(1);
    expect(notes.sections[0]?.title).toBe(UNTITLED_SECTION_TITLE);
  });
});

describe('buildNotes: points', () => {
  it('keeps the first sentence plus the sentences carrying a number', () => {
    const ir = documentOf([
      block(1, 'Results', 'heading', 0),
      block(
        1,
        'Trials began in March. We ran 12 trials in total. Each trial used 40 samples. Results varied.',
        'paragraph',
        20,
      ),
    ]);

    const notes = buildNotes(ir);

    // 'Results varied.' carries neither a digit nor a cue, so it is not a point.
    expect(notes.sections[0]?.points.map(point => point.text)).toEqual([
      'Trials began in March.',
      'We ran 12 trials in total.',
      'Each trial used 40 samples.',
    ]);
    expect(notes.sections[0]?.points.map(point => point.kind)).toEqual([
      'lead',
      'number',
      'number',
    ]);
  });

  it('caps the points per section and keeps the earliest ones', () => {
    const ir = documentOf([
      block(1, 'Results', 'heading', 0),
      block(
        1,
        'Trials began in March. We ran 12 trials in total. Each trial used 40 samples. Results varied.',
        'paragraph',
        20,
      ),
    ]);

    const notes = buildNotes(ir, { maxPointsPerSection: 2 });

    expect(notes.sections[0]?.points.map(point => point.text)).toEqual([
      'Trials began in March.',
      'We ran 12 trials in total.',
    ]);
    expect(notes.sections[0]?.points).toHaveLength(2);
    expect(DEFAULT_MAX_POINTS_PER_SECTION).toBeGreaterThan(2);
  });

  it('keeps a sentence with a bold-like cue', () => {
    const ir = documentOf([
      block(1, 'Setup', 'heading', 0),
      block(1, 'We began. Note: keep the lid closed. Nothing else.', 'paragraph', 20),
    ]);

    const notes = buildNotes(ir);

    expect(notes.sections[0]?.points.map(point => point.text)).toEqual([
      'We began.',
      'Note: keep the lid closed.',
    ]);
    expect(notes.sections[0]?.points[1]?.kind).toBe('emphasis');
  });

  it('keeps one point per repeated sentence', () => {
    const ir = documentOf([
      block(1, 'Setup', 'heading', 0),
      block(1, 'The sample was sealed. The sample was sealed.', 'paragraph', 20),
      block(1, 'The sample was sealed.', 'paragraph', 40),
    ]);

    const notes = buildNotes(ir);

    expect(notes.sections[0]?.points.map(point => point.text)).toEqual(['The sample was sealed.']);
  });
});

describe('buildNotes: definitions', () => {
  it('reads a definition in English and one in Vietnamese', () => {
    const ir = documentOf([
      block(1, 'Terms', 'heading', 0),
      block(1, 'Photogrammetry is the science of measuring from photographs.', 'paragraph', 20),
      block(2, 'Thuật ngữ', 'heading', 0),
      block(2, 'Quang hợp là quá trình tổng hợp chất hữu cơ từ ánh sáng.', 'paragraph', 20),
    ]);

    const notes = buildNotes(ir);

    expect(notes.definitions.map(definition => definition.term)).toEqual([
      'Photogrammetry',
      'Quang hợp',
    ]);
    expect(notes.definitions[0]?.text).toBe('the science of measuring from photographs');
    expect(notes.definitions[1]?.text).toBe('quá trình tổng hợp chất hữu cơ từ ánh sáng');
    expect(notes.definitions[0]?.page).toBe(1);
    expect(notes.definitions[1]?.page).toBe(2);
    expect(notes.summary.definitions).toBe(2);
  });

  it('reads the explicit forms in both languages', () => {
    const ir = documentOf([
      block(1, 'Terms', 'heading', 0),
      block(1, 'Entropy refers to the number of arrangements of a system.', 'paragraph', 20),
      block(1, 'Mật độ được định nghĩa là khối lượng trên một đơn vị thể tích.', 'paragraph', 40),
    ]);

    const notes = buildNotes(ir);

    expect(notes.definitions.map(definition => definition.term)).toEqual(['Entropy', 'Mật độ']);
    expect(notes.definitions[0]?.text).toBe('the number of arrangements of a system');
    expect(notes.definitions[1]?.text).toBe('khối lượng trên một đơn vị thể tích');
  });

  it('does not turn a pronoun or a short description into a definition', () => {
    const ir = documentOf([
      block(1, 'Terms', 'heading', 0),
      block(1, 'This is a useful example. Mercury is a metal.', 'paragraph', 20),
    ]);

    const notes = buildNotes(ir);

    expect(notes.definitions).toEqual([]);
  });

  it('keeps one definition per term', () => {
    const ir = documentOf([
      block(1, 'Terms', 'heading', 0),
      block(1, 'Density is the mass of a body per unit volume.', 'paragraph', 20),
      block(1, 'Density is the amount of matter in a given space.', 'paragraph', 40),
    ]);

    const notes = buildNotes(ir);

    expect(notes.definitions).toHaveLength(1);
    expect(notes.definitions[0]?.text).toBe('the mass of a body per unit volume');
  });
});

describe('buildNotes: formulas', () => {
  it('captures a formula with its LaTeX', () => {
    const source = 'The mass-energy relation E = mc^2 holds for rest mass.';
    const ir = documentOf([
      block(3, 'Physics', 'heading', 0),
      block(3, source, 'paragraph', 20),
    ]);

    const notes = buildNotes(ir);

    expect(notes.formulas).toHaveLength(1);
    expect(notes.formulas[0]?.latex).toBe('E = mc^{2}');
    expect(notes.formulas[0]?.page).toBe(3);
    expect(notes.formulas[0]?.blockId).toBe(idOf(ir, source));
    expect(notes.summary.formulas).toBe(1);
  });

  it('captures every distinct formula in reading order', () => {
    const first = 'The rest energy is E = m c^2 for the first model.';
    const second = 'The momentum is p = m v for the second model.';
    const ir = documentOf([
      block(1, 'Physics', 'heading', 0),
      block(1, first, 'paragraph', 20),
      block(2, 'Momentum', 'heading', 0),
      block(2, second, 'paragraph', 20),
    ]);

    const notes = buildNotes(ir);

    expect(notes.formulas.map(formula => formula.latex)).toEqual(['E = m c^{2}', 'p = m v']);
    expect(notes.formulas.map(formula => formula.page)).toEqual([1, 2]);
    expect(notes.formulas.map(formula => formula.blockId)).toEqual([
      idOf(ir, first),
      idOf(ir, second),
    ]);
  });

  it('drops an over-long formula instead of clipping its LaTeX', () => {
    const ir = documentOf([
      block(1, 'Physics', 'heading', 0),
      block(1, 'The rest energy is E = m c^2 for the model.', 'paragraph', 20),
    ]);

    const notes = buildNotes(ir, { maxEntryChars: 6 });

    expect(notes.formulas).toEqual([]);
  });
});

describe('buildNotes: every entry carries its page and block', () => {
  it('gives sections, points, definitions and formulas a page and a known block id', () => {
    const ir = documentOf([
      block(1, 'Overview', 'heading', 0),
      block(1, 'We measured 25 samples.', 'paragraph', 20),
      block(2, 'Revision', 'heading', 0),
      block(2, 'Density is the amount of mass per unit volume.', 'paragraph', 20),
      block(3, 'Formulas', 'heading', 0),
      block(3, 'Light travels at c = 3 * 10^8 m/s.', 'paragraph', 20),
    ]);

    const notes = buildNotes(ir);
    const known = new Set(ir.blocks.map(entry => entry.id));
    const entries = [
      ...notes.sections.map(section => ({ page: section.page, blockId: section.blockId })),
      ...notes.sections.flatMap(section => section.points),
      ...notes.definitions,
      ...notes.formulas,
    ];

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(Number.isInteger(entry.page)).toBe(true);
      expect(entry.page).toBeGreaterThanOrEqual(1);
      expect(entry.blockId.length).toBeGreaterThan(0);
      expect(known.has(entry.blockId)).toBe(true);
    }

    expect(notes.sections.map(section => section.page)).toEqual([1, 2, 3]);
    expect(notes.definitions[0]?.page).toBe(2);
    expect(notes.definitions[0]?.blockId).toBe(
      idOf(ir, 'Density is the amount of mass per unit volume.'),
    );
    expect(notes.formulas[0]?.page).toBe(3);
    expect(notes.formulas[0]?.blockId).toBe(idOf(ir, 'Light travels at c = 3 * 10^8 m/s.'));
  });
});

describe('buildNotes: length limit', () => {
  it('clips every long entry at a word boundary under the documented limit', () => {
    const long =
      'This deliberately long opening sentence keeps going well past the documented limit so that the clipping has to happen.';
    const definition =
      'Density is the amount of mass in a given volume, measured in grams of matter per cubic centimetre.';
    const ir = documentOf([
      block(1, 'Limits', 'heading', 0),
      block(1, long, 'paragraph', 20),
      block(1, definition, 'paragraph', 40),
      block(1, 'Short.', 'paragraph', 60),
    ]);

    const notes = buildNotes(ir, { maxEntryChars: 60 });

    const point = notes.sections[0]?.points[0];
    expect(point?.text.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(lengthOf(point?.text ?? '')).toBeLessThanOrEqual(60);
    // The clipped text is a prefix of the sentence, cut at a word boundary.
    expect(long.startsWith((point?.text ?? '').slice(0, -1))).toBe(true);

    const entry = notes.definitions[0];
    expect(entry?.term).toBe('Density');
    expect(entry?.text.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(lengthOf(entry?.text ?? '')).toBeLessThanOrEqual(60);

    // A short entry is left exactly as it was written.
    expect(notes.sections[0]?.points.some(item => item.text === 'Short.')).toBe(true);
    expect(DEFAULT_MAX_ENTRY_CHARS).toBeGreaterThan(60);
  });

  it('leaves entries alone when the default limit already covers them', () => {
    const ir = documentOf([block(1, 'Short paragraph.', 'paragraph', 0)]);

    const notes = buildNotes(ir);

    expect(notes.sections[0]?.points[0]?.text).toBe('Short paragraph.');
    expect(notes.summary.points).toBe(1);
  });
});

describe('toMarkdown', () => {
  it('writes a table of contents whose links hit the section anchors', () => {
    const ir = documentOf([
      block(1, 'Introduction', 'heading', 0),
      block(1, 'Trials began in March. We ran 12 trials.', 'paragraph', 20),
      block(2, 'Methods', 'heading', 0),
      block(2, 'Each trial used 40 samples.', 'paragraph', 20),
    ]);

    const markdown = toMarkdown(buildNotes(ir));

    expect(markdown.startsWith('# Study notes')).toBe(true);
    expect(markdown).toContain('## Contents');
    expect(markdown).toContain(`- [Introduction](#${ANCHOR_PREFIX}1)`);
    expect(markdown).toContain(`- [Methods](#${ANCHOR_PREFIX}2)`);
    expect(markdown).toContain(`<a id="${ANCHOR_PREFIX}1"></a>`);
    expect(markdown).toContain(`<a id="${ANCHOR_PREFIX}2"></a>`);
    expect(sectionAnchor(0)).toBe(`${ANCHOR_PREFIX}1`);

    const targets = [...markdown.matchAll(/\(#([A-Za-z0-9._-]+)\)/gu)].map(
      match => match[1] ?? '',
    );
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(markdown).toContain(`<a id="${target}"></a>`);
  });

  it('names the page and the block of every line', () => {
    const paragraph = 'Trials began in March. We ran 12 trials.';
    const definition = 'Density is the amount of mass per unit volume.';
    const ir = documentOf([
      block(1, 'Introduction', 'heading', 0),
      block(1, paragraph, 'paragraph', 20),
      block(2, 'Formulas', 'heading', 0),
      block(2, definition, 'paragraph', 20),
      block(2, 'The relation E = mc^2 holds.', 'paragraph', 40),
    ]);

    const notes = buildNotes(ir);
    const markdown = toMarkdown(notes);

    expect(markdown).toContain(`p.1 · ${idOf(ir, paragraph)}`);
    expect(markdown).toContain(`**Density** — the amount of mass per unit volume`);
    expect(markdown).toContain(`p.2 · ${idOf(ir, definition)}`);
    expect(markdown).toContain(`p.2 · ${idOf(ir, 'The relation E = mc^2 holds.')}`);
    expect(markdown).toContain('`E = mc^{2}`');
    expect(markdown).toContain('## Definitions');
    expect(markdown).toContain('## Formulas');
    expect(markdown.endsWith('\n')).toBe(false);
  });

  it('escapes Markdown control characters in entry text', () => {
    const ir = documentOf([
      block(1, 'Cues', 'heading', 0),
      block(1, 'Use * and _ and [brackets] carefully.', 'paragraph', 20),
    ]);

    const markdown = toMarkdown(buildNotes(ir));

    expect(markdown).toContain('Use \\* and \\_ and \\[brackets\\] carefully.');
  });
});

describe('toAnkiCsv', () => {
  it('quotes and doubles so a comma and a quote stay inside one field', () => {
    const ir = documentOf([
      block(1, 'Density', 'heading', 0),
      block(1, 'Density is the "core" idea, measured twice.', 'paragraph', 20),
    ]);

    const csv = toAnkiCsv(buildNotes(ir));

    expect(csv).toBe('"What is Density?","the ""core"" idea, measured twice"');
  });

  it('writes one question and answer row per definition and formula, separated by CRLF', () => {
    const ir = documentOf([
      block(1, 'Notes', 'heading', 0),
      block(1, 'Density is the amount of mass per unit volume.', 'paragraph', 20),
      block(2, 'Physics', 'heading', 0),
      block(2, 'The relation E = mc^2 holds.', 'paragraph', 20),
    ]);

    const csv = toAnkiCsv(buildNotes(ir));
    const rows = csv.split(CSV_RECORD_SEPARATOR);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe('"What is Density?","the amount of mass per unit volume"');
    expect(rows[1]).toBe(
      `"Write the formula on page 2 (${idOf(ir, 'The relation E = mc^2 holds.')}).","\\(E = mc^{2}\\)"`,
    );
  });

  it('writes nothing when there is nothing to ask', () => {
    const ir = documentOf([
      block(1, 'Notes', 'heading', 0),
      block(1, 'We ran 12 trials.', 'paragraph', 20),
    ]);

    expect(toAnkiCsv(buildNotes(ir))).toBe('');
  });
});

describe('buildNotes: empty document', () => {
  it('produces empty notes and empty exports', () => {
    const notes = buildNotes(documentOf([]));

    expect(notes).toEqual({
      sections: [],
      definitions: [],
      formulas: [],
      summary: { sections: 0, points: 0, definitions: 0, formulas: 0 },
    });
    expect(toMarkdown(notes)).toBe('');
    expect(toAnkiCsv(notes)).toBe('');
  });
});
