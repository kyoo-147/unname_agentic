import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DROP_FORMATS,
  DROP_REJECTION_CODES,
  planDrop,
  type DropFile,
  type DropItem,
  type DropPlan,
} from '../viewer/src/core/drop';

/**
 * The drop planner's contract, pinned case by case.
 *
 * Every test below is a decision the module claims to make: which format is taken, what a
 * duplicate is, what happens to a folder, where the two caps stop, and what order the
 * accepted files keep. The tests describe drops as plain data — the module reads no disk —
 * so a failing test names exactly one rule.
 */

const MB = 1024 * 1024;

/** A dropped file, with a path under `/drop` unless the test needs a different one. */
function file(name: string, size = 1024, path = `/drop/${name}`): DropItem {
  return { name, path, kind: 'file', size };
}

/** A dropped folder, with the contents the platform had already listed. */
function folder(name: string, contents: readonly DropFile[] = []): DropItem {
  return { name, path: `/drop/${name}`, kind: 'folder', size: 0, contents };
}

/** One file entry as it appears inside a folder listing. */
function listed(name: string, size = 1024): DropFile {
  return { name, path: `/drop/papers/${name}`, size };
}

/** The names of accepted files, which is what order assertions are about. */
function acceptedNames(plan: DropPlan): string[] {
  return plan.accepted.map(entry => entry.name);
}

const PDF_ONLY = { allowedFormats: ['pdf'] } as const;

describe('planDrop formats', () => {
  it('accepts three PDFs and keeps the drop order', () => {
    const plan = planDrop([file('a.pdf'), file('b.pdf'), file('c.pdf')], [], PDF_ONLY);

    expect(acceptedNames(plan)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(plan.rejected).toEqual([]);
    expect(plan.duplicates).toEqual([]);
    expect(plan.overflow).toEqual({
      requestedFiles: 3,
      acceptedFiles: 3,
      acceptedBytes: 3 * 1024,
      overFiles: 0,
      overBytes: 0,
    });
  });

  it('rejects a DOCX as an unsupported format and names what is taken', () => {
    const plan = planDrop([file('notes.docx', 2048)], [], PDF_ONLY);

    expect(plan.accepted).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]).toMatchObject({ name: 'notes.docx', code: 'unsupported-format' });
    expect(plan.rejected[0]?.reason).toContain('.docx');
    expect(plan.rejected[0]?.reason).toContain('.pdf');
    expect(plan.overflow.requestedFiles).toBe(1);
    expect(plan.overflow.acceptedFiles).toBe(0);
  });

  it('matches the extension case-insensitively, on both sides of the comparison', () => {
    const plan = planDrop([file('REPORT.PDF', 512), file('Scan.Pdf', 512)], [], { allowedFormats: ['PDF'] });

    expect(acceptedNames(plan)).toEqual(['REPORT.PDF', 'Scan.Pdf']);
    expect(plan.rejected).toEqual([]);
  });

  it('reads allowed formats with or without a leading dot', () => {
    const plan = planDrop([file('a.pdf'), file('b.png')], [], { allowedFormats: ['.PDF', 'png'] });

    expect(acceptedNames(plan)).toEqual(['a.pdf', 'b.png']);
  });

  it('rejects a file with no extension', () => {
    const plan = planDrop([file('README', 900)], [], PDF_ONLY);

    expect(plan.accepted).toEqual([]);
    expect(plan.rejected[0]?.code).toBe('unsupported-format');
    expect(plan.rejected[0]?.reason).toContain('no extension');
    expect(plan.rejected[0]?.reason).toContain('.pdf');
  });

  it('takes PDFs when the caller passes no options at all', () => {
    const plan = planDrop([file('paper.pdf'), file('slides.docx')]);

    expect(acceptedNames(plan)).toEqual(['paper.pdf']);
    expect(plan.rejected.map(entry => entry.code)).toEqual(['unsupported-format']);
    expect(DEFAULT_DROP_FORMATS).toEqual(['pdf']);
  });

  it('accepts nothing when the caller allows no format', () => {
    const plan = planDrop([file('paper.pdf')], [], { allowedFormats: [] });

    expect(plan.accepted).toEqual([]);
    expect(plan.rejected[0]?.code).toBe('unsupported-format');
    expect(plan.rejected[0]?.reason).toContain('no file format');
  });
});

describe('planDrop duplicates', () => {
  it('rejects a duplicate by name and size and names the existing entry', () => {
    // The extra id proves a library summary can be passed as-is: only name and size are read.
    const existing = [{ id: 'doc-1', name: 'Paper.pdf', size: 2048 }];

    const plan = planDrop([file('Paper.pdf', 2048)], existing, PDF_ONLY);

    expect(plan.accepted).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.code).toBe('duplicate');
    expect(plan.rejected[0]?.reason).toContain('Paper.pdf');
    expect(plan.duplicates).toEqual([
      {
        name: 'Paper.pdf',
        path: '/drop/Paper.pdf',
        match: 'library',
        existing: { name: 'Paper.pdf', size: 2048 },
      },
    ]);
  });

  it('compares the duplicate name case-insensitively', () => {
    const plan = planDrop([file('paper.PDF', 2048)], [{ name: 'Paper.pdf', size: 2048 }], PDF_ONLY);

    expect(plan.rejected[0]?.code).toBe('duplicate');
    expect(plan.duplicates[0]?.existing.name).toBe('Paper.pdf');
  });

  it('treats the same name at a different size as a different document', () => {
    const plan = planDrop([file('Paper.pdf', 4096)], [{ name: 'Paper.pdf', size: 2048 }], PDF_ONLY);

    expect(acceptedNames(plan)).toEqual(['Paper.pdf']);
    expect(plan.duplicates).toEqual([]);
  });

  it('catches the same file twice in one drop', () => {
    const plan = planDrop(
      [file('Paper.pdf', 2048), file('Paper.pdf', 2048, '/elsewhere/Paper.pdf')],
      [],
      PDF_ONLY,
    );

    expect(acceptedNames(plan)).toEqual(['Paper.pdf']);
    expect(plan.rejected[0]?.code).toBe('duplicate');
    expect(plan.duplicates[0]).toMatchObject({
      match: 'drop',
      path: '/elsewhere/Paper.pdf',
      existing: { name: 'Paper.pdf', size: 2048 },
    });
  });
});

describe('planDrop folders', () => {
  it('reports a folder for scanning instead of planning it', () => {
    const plan = planDrop([folder('papers')], [], PDF_ONLY);

    expect(plan.accepted).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]).toMatchObject({ name: 'papers', code: 'folder-needs-scan' });
    expect(plan.rejected[0]?.reason).toContain('never reads the disk');
    expect(plan.overflow.requestedFiles).toBe(0);
  });

  it("sorts a folder's listed contents by name inside the folder's slot", () => {
    const plan = planDrop(
      [file('first.pdf'), folder('papers', [listed('b.pdf'), listed('a.pdf')]), file('last.pdf')],
      [],
      PDF_ONLY,
    );

    expect(acceptedNames(plan)).toEqual(['first.pdf', 'a.pdf', 'b.pdf', 'last.pdf']);
    expect(plan.rejected.map(entry => entry.code)).toEqual(['folder-needs-scan']);
    expect(plan.rejected[0]?.reason).toContain('2 files');
    expect(plan.overflow.requestedFiles).toBe(4);
  });

  it('never claims a folder is complete when its contents were listed', () => {
    const plan = planDrop([folder('papers', [listed('a.pdf')])], [], PDF_ONLY);

    expect(acceptedNames(plan)).toEqual(['a.pdf']);
    expect(plan.rejected.map(entry => entry.code)).toEqual(['folder-needs-scan']);
  });
});

describe('planDrop caps', () => {
  it('enforces the file cap and reports the overflow count', () => {
    const plan = planDrop(
      [file('a.pdf'), file('b.pdf'), file('c.pdf')],
      [],
      { allowedFormats: ['pdf'], maxFiles: 2 },
    );

    expect(acceptedNames(plan)).toEqual(['a.pdf', 'b.pdf']);
    expect(plan.rejected.map(entry => [entry.name, entry.code])).toEqual([['c.pdf', 'over-max-files']]);
    expect(plan.rejected[0]?.reason).toContain('2 files');
    expect(plan.overflow).toEqual({
      requestedFiles: 3,
      acceptedFiles: 2,
      acceptedBytes: 2 * 1024,
      overFiles: 1,
      overBytes: 0,
    });
  });

  it('enforces the byte cap and still takes a later file that fits', () => {
    const plan = planDrop(
      [file('big-one.pdf', 2 * MB), file('big-two.pdf', 2 * MB), file('small.pdf', 1 * MB)],
      [],
      { allowedFormats: ['pdf'], maxBytes: 3 * MB },
    );

    expect(acceptedNames(plan)).toEqual(['big-one.pdf', 'small.pdf']);
    expect(plan.rejected.map(entry => [entry.name, entry.code])).toEqual([['big-two.pdf', 'over-max-bytes']]);
    expect(plan.rejected[0]?.reason).toContain('3.0 MB');
    expect(plan.overflow).toEqual({
      requestedFiles: 3,
      acceptedFiles: 2,
      acceptedBytes: 3 * MB,
      overFiles: 0,
      overBytes: 1,
    });
  });

  it('refuses a file larger than the whole budget as too large', () => {
    const plan = planDrop([file('huge.pdf', 40 * MB)], [], { allowedFormats: ['pdf'], maxBytes: 20 * MB });

    expect(plan.rejected[0]?.code).toBe('too-large');
    expect(plan.rejected[0]?.reason).toContain('40.0 MB');
    expect(plan.overflow.overBytes).toBe(0);
  });

  it('counts a folder as a deferral, not as a file against the cap', () => {
    const plan = planDrop([folder('papers'), file('a.pdf')], [], { allowedFormats: ['pdf'], maxFiles: 1 });

    expect(acceptedNames(plan)).toEqual(['a.pdf']);
    expect(plan.rejected.map(entry => entry.code)).toEqual(['folder-needs-scan']);
    expect(plan.overflow.acceptedFiles).toBe(1);
  });
});

describe('planDrop order and refusals', () => {
  it('keeps drop order across a mixed drop', () => {
    const plan = planDrop([file('first.pdf'), folder('papers'), file('last.pdf')], [], PDF_ONLY);

    expect(acceptedNames(plan)).toEqual(['first.pdf', 'last.pdf']);
    expect(plan.rejected.map(entry => [entry.name, entry.code])).toEqual([['papers', 'folder-needs-scan']]);
  });

  it('reports an empty drop', () => {
    const plan = planDrop([], [], PDF_ONLY);

    expect(plan.accepted).toEqual([]);
    expect(plan.duplicates).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.code).toBe('empty-drop');
    expect(plan.rejected[0]?.reason).toContain('Nothing was dropped');
    expect(plan.overflow).toEqual({
      requestedFiles: 0,
      acceptedFiles: 0,
      acceptedBytes: 0,
      overFiles: 0,
      overBytes: 0,
    });
  });

  it('keeps one bad file from failing the rest of the drop', () => {
    const plan = planDrop(
      [file('notes.docx'), file('good.pdf'), file('README')],
      [],
      PDF_ONLY,
    );

    expect(acceptedNames(plan)).toEqual(['good.pdf']);
    expect(plan.rejected.map(entry => entry.code)).toEqual(['unsupported-format', 'unsupported-format']);
  });

  it('skips an entry with no name instead of inventing one', () => {
    const plan = planDrop([{ name: '', path: '', kind: 'file', size: 10 }], [], PDF_ONLY);

    expect(plan.accepted).toEqual([]);
    expect(plan.rejected.map(entry => entry.code)).toEqual(['empty-drop']);
  });
});

describe('planDrop determinism', () => {
  it('leaves its inputs untouched and repeats itself exactly', () => {
    const items = [folder('papers', [listed('b.pdf'), listed('a.pdf')])];
    const existing = [{ name: 'held.pdf', size: 7 }];
    const snapshot = JSON.stringify(items);

    const first = planDrop(items, existing, { allowedFormats: ['pdf'], maxFiles: 2 });
    const second = planDrop(items, existing, { allowedFormats: ['pdf'], maxFiles: 2 });

    expect(JSON.stringify(items)).toBe(snapshot);
    expect(second).toEqual(first);
    expect(acceptedNames(first)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('emits only codes the documented list carries', () => {
    const plan = planDrop(
      [file('notes.docx'), folder('papers'), file('big.pdf', 40 * MB), file('a.pdf'), file('a.pdf')],
      [],
      { allowedFormats: ['pdf'], maxBytes: 20 * MB },
    );

    expect(new Set(DROP_REJECTION_CODES).size).toBe(DROP_REJECTION_CODES.length);
    for (const entry of plan.rejected) expect(DROP_REJECTION_CODES).toContain(entry.code);
  });
});
