import { describe, expect, it } from 'vitest';
import {
  CAPTION_HALF_PAGE_DISTANCE,
  linkCaptions,
  type CaptionInputBlock,
  type CaptionLink,
  type CaptionLinkResult,
  type CaptionOrphan,
} from '../viewer/src/core/captions';
import type { SemanticBlockType } from '../viewer/src/core/blocks';
import type { Rect } from '../viewer/src/core/types';

// A US Letter page in points. Every fixture sits on it at a plausible position, so the
// half-page reach is exercised the way a real page would exercise it.
const PAGE_HEIGHT = 792;

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

function block(
  id: string,
  type: SemanticBlockType,
  box: Rect,
  text = '',
  page = 1,
): CaptionInputBlock {
  return { id, type, text, rect: box, page, pageHeight: PAGE_HEIGHT };
}

function onlyLink(result: CaptionLinkResult): CaptionLink {
  expect(result.links).toHaveLength(1);
  const link = result.links[0];
  if (!link) throw new Error('expected exactly one link');
  return link;
}

function onlyOrphan(result: CaptionLinkResult): CaptionOrphan {
  expect(result.orphans).toHaveLength(1);
  const orphan = result.orphans[0];
  if (!orphan) throw new Error('expected exactly one orphan');
  return orphan;
}

describe('linkCaptions: the conventional placements', () => {
  it('links a caption sitting below its figure', () => {
    const result = linkCaptions([
      block('fig-1', 'figure', rect(60, 120, 400, 180)),
      block('cap-1', 'caption', rect(60, 312, 400, 14), 'Figure 1. Cells under load across the panel.'),
    ]);

    expect(result.orphans).toEqual([]);
    const link = onlyLink(result);
    expect(link.captionId).toBe('cap-1');
    expect(link.targetId).toBe('fig-1');
    expect(link.kind).toBe('figure');
    expect(link.alternativeId).toBeUndefined();
    // 12 pt below the figure, on the preferred side, with the figure's ordinal matching.
    expect(link.confidence).toBeGreaterThan(0.9);
    expect(link.reason).toContain('direction=below');
    expect(link.reason).toContain('number-match');
  });

  it('links a caption sitting above its table', () => {
    const result = linkCaptions([
      block('tbl-1', 'table', rect(60, 300, 400, 160)),
      block('cap-2', 'caption', rect(60, 274, 400, 14), 'Table 1. Measured values.'),
    ]);

    expect(result.orphans).toEqual([]);
    const link = onlyLink(result);
    expect(link.targetId).toBe('tbl-1');
    expect(link.kind).toBe('table');
    expect(link.confidence).toBeGreaterThan(0.9);
    expect(link.reason).toContain('direction=above');
    expect(link.reason).toContain('number-match');
  });

  it('still links a caption on the unconventional side, but ranks it lower', () => {
    const below = onlyLink(
      linkCaptions([
        block('fig-below', 'figure', rect(60, 300, 400, 180)),
        block('cap-below', 'caption', rect(60, 492, 400, 14), 'Figure 1. Cells under load.'),
      ]),
    );
    const above = onlyLink(
      linkCaptions([
        block('cap-above', 'caption', rect(60, 274, 400, 14), 'Figure 1. Cells under load.'),
        block('fig-above', 'figure', rect(60, 300, 400, 180)),
      ]),
    );

    // Same distance on both sides, so only the direction convention separates them.
    expect(above.reason).toContain('direction=above');
    expect(above.confidence).toBeLessThan(below.confidence);
  });
});

describe('linkCaptions: choosing between candidates', () => {
  it('prefers the figure whose number matches, not the nearer one', () => {
    const result = linkCaptions([
      // This one is 80 pt above the caption but names itself Figure 4 in its own label.
      block('fig-numbered', 'figure', rect(300, 230, 260, 150), 'Figure 4. The fourth panel.'),
      // The unnumbered figure is only 10 pt from the caption and takes ordinal 2.
      block('fig-near', 'figure', rect(60, 300, 200, 150)),
      // Wide enough to overlap both figures.
      block('cap-num', 'caption', rect(60, 460, 500, 14), 'Figure 4. Panel four.'),
    ]);

    expect(result.orphans).toEqual([]);
    const link = onlyLink(result);
    expect(link.targetId).toBe('fig-numbered');
    expect(link.reason).toContain('number=4');
    expect(link.reason).toContain('number-match');
  });

  it('picks the right figure when two share one caption line by number', () => {
    const result = linkCaptions([
      block('fig-left', 'figure', rect(60, 100, 220, 150)),
      block('fig-right', 'figure', rect(332, 100, 220, 150)),
      // Wide enough to overlap both figures: only the number can decide.
      block('cap-3', 'caption', rect(60, 262, 492, 14), 'Figure 1. Left cell under load.'),
    ]);

    expect(result.orphans).toEqual([]);
    const link = onlyLink(result);
    expect(link.targetId).toBe('fig-left');
    expect(link.reason).toContain('number-match');
  });

  it('keeps the winner but lowers confidence and names the alternative on a tie', () => {
    const result = linkCaptions([
      block('fig-a', 'figure', rect(60, 120, 220, 150)),
      block('fig-b', 'figure', rect(332, 120, 220, 150)),
      // A caption the reader typed as `caption` without a label: no number can break the tie.
      block('cap-tie', 'caption', rect(60, 282, 492, 14), 'Cells under load across two panels.'),
    ]);

    expect(result.orphans).toEqual([]);
    const link = onlyLink(result);
    expect(link.targetId).toBe('fig-a');
    expect(link.alternativeId).toBe('fig-b');
    expect(link.reason).toContain('tie=fig-b');
    // The two candidates are equidistant, so the reported confidence is discounted.
    expect(link.confidence).toBeLessThan(0.75);
    expect(link.confidence).toBeGreaterThan(0);
  });
});

describe('linkCaptions: the column rule', () => {
  it('never links a caption across a column boundary', () => {
    const result = linkCaptions([
      block('fig-right', 'figure', rect(332, 120, 220, 150)),
      // Left column: 12 pt below the figure but sharing no horizontal band with it.
      block('cap-left', 'caption', rect(60, 282, 240, 14), 'Figure 1. Left column note.'),
    ]);

    expect(result.links).toEqual([]);
    const orphan = onlyOrphan(result);
    expect(orphan.captionId).toBe('cap-left');
    expect(orphan.reason).toBe('no-overlap');
    expect(orphan.candidateId).toBe('fig-right');
  });

  it('treats a sliver of horizontal overlap as no overlap', () => {
    const result = linkCaptions([
      block('fig-right', 'figure', rect(332, 120, 220, 150)),
      // Only 8 pt of the caption's 100 pt width touches the figure.
      block('cap-clip', 'caption', rect(240, 282, 100, 14), 'Figure 1. Left column note.'),
    ]);

    expect(result.links).toEqual([]);
    expect(onlyOrphan(result).reason).toBe('no-overlap');
  });
});

describe('linkCaptions: orphans', () => {
  it('orphans a caption more than half a page away from every candidate', () => {
    const result = linkCaptions([
      block('fig-far', 'figure', rect(60, 60, 400, 200)),
      // 440 pt of gap on a 792 pt page: past the half-page reach.
      block('cap-far', 'caption', rect(60, 700, 400, 14), 'Figure 1. A panel far below.'),
    ]);

    expect(result.links).toEqual([]);
    const orphan = onlyOrphan(result);
    expect(orphan.reason).toBe('too-distant');
    expect(orphan.distance).toBeGreaterThan(CAPTION_HALF_PAGE_DISTANCE);
    expect(orphan.candidateId).toBe('fig-far');
  });

  it('orphans a caption when the page holds no figure or table', () => {
    const result = linkCaptions([
      block('cap-5', 'caption', rect(60, 300, 400, 14), 'Figure 2. Results.'),
      block('p-5', 'paragraph', rect(60, 400, 400, 40), 'Measurements follow in the next section.'),
    ]);

    expect(result.links).toEqual([]);
    const orphan = onlyOrphan(result);
    expect(orphan.reason).toBe('no-candidate');
    expect(orphan.distance).toBe(0);
    expect(orphan.candidateId).toBeUndefined();
  });

  it('orphans a caption rather than reaching onto the next page', () => {
    const result = linkCaptions([
      block('cap-p1', 'caption', rect(60, 300, 400, 14), 'Figure 1. See the next page.'),
      block('fig-p2', 'figure', rect(60, 300, 400, 180), '', 2),
    ]);

    expect(result.links).toEqual([]);
    expect(onlyOrphan(result).reason).toBe('no-candidate');
  });

  it('orphans a winner that is too weak to be worth showing', () => {
    const result = linkCaptions([
      block('tbl-1', 'table', rect(60, 120, 400, 200)),
      // 317 pt away, a `Figure` label on a table, and the unconventional side: 0.09.
      block('cap-weak', 'caption', rect(60, 637, 400, 14), 'Figure 9. Panel nine.'),
    ]);

    expect(result.links).toEqual([]);
    const orphan = onlyOrphan(result);
    expect(orphan.reason).toBe('weak-evidence');
    expect(orphan.candidateId).toBe('tbl-1');
    expect(orphan.distance).toBeGreaterThan(0.35);
    expect(orphan.distance).toBeLessThan(0.45);
  });
});

describe('linkCaptions: document shape and determinism', () => {
  it('returns no links and no orphans when the document has no captions', () => {
    const result = linkCaptions([
      // Its text starts with a figure label, but a figure block is a target, never a caption.
      block('fig-6', 'figure', rect(60, 120, 400, 180), 'Figure 3. A target, never a caption.'),
      block('p-6', 'paragraph', rect(60, 340, 400, 40), 'The values are listed below.'),
    ]);

    expect(result).toEqual({ links: [], orphans: [] });
  });

  it('derives ids and results independently of the input order', () => {
    const figure: CaptionInputBlock = {
      type: 'figure',
      text: '',
      rect: rect(60, 120, 400, 180),
      page: 1,
      pageHeight: PAGE_HEIGHT,
    };
    const caption: CaptionInputBlock = {
      type: 'caption',
      text: 'Figure 1. Cells under load.',
      rect: rect(60, 312, 400, 14),
      page: 1,
      pageHeight: PAGE_HEIGHT,
    };
    const paragraph: CaptionInputBlock = {
      type: 'paragraph',
      text: 'Body text.',
      rect: rect(60, 340, 400, 40),
      page: 1,
      pageHeight: PAGE_HEIGHT,
    };

    const straight = linkCaptions([figure, caption, paragraph]);
    const shuffled = linkCaptions([paragraph, caption, figure]);

    expect(shuffled).toEqual(straight);
    const link = onlyLink(straight);
    // Ids fall out of reading order: the figure is the first block on page 1.
    expect(link.targetId).toBe('p1-r0');
    expect(link.captionId).toBe('p1-r1');
  });
});
