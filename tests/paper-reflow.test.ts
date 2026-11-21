import { describe, expect, it } from 'vitest';
import { buildDocument, type BuildBlockInput, type DocumentIR } from '../src/core/ir';
import type { Rect } from '../src/core/types';
import {
  reflowPaper,
  resolveReflowId,
  resolveSourceLocation,
  toReflowHtml,
  toReflowMarkdown,
  type ReflowBlock,
  type ReflowPaperDocument,
} from '../src/core/paper-reflow';

const SOURCE_SHA256 = 'a'.repeat(64);
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LEFT_X = 56;
const RIGHT_X = 320;
const COL_WIDTH = 236;
const FULL_WIDTH = 500;

function box(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

function buildPaperIr(blocks: readonly BuildBlockInput[], pageCount = 2): DocumentIR {
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    index: index + 1,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    rotation: 0 as const,
  }));
  return buildDocument({
    sourceSha256: SOURCE_SHA256,
    documentId: 'paper-j08',
    language: 'en',
    pages,
    blocks,
  });
}

function makeAcademicPaperIr(): DocumentIR {
  return buildPaperIr(
    [
      // Page 1: repeated header/footer, spanning title + abstract, then two columns
      {
        id: 'p1-hdr',
        page: 1,
        type: 'other',
        rect: box(LEFT_X, 24, FULL_WIDTH, 14),
        text: 'Proceedings of Academic Reflow · Vol. 7',
      },
      {
        id: 'p1-title',
        page: 1,
        type: 'heading',
        rect: box(LEFT_X, 64, FULL_WIDTH, 28),
        text: 'Clean Single-Column Reflow for Scientific Papers',
      },
      {
        id: 'p1-abs-h',
        page: 1,
        type: 'heading',
        rect: box(LEFT_X, 104, FULL_WIDTH, 16),
        text: 'Abstract',
      },
      {
        id: 'p1-abs-p',
        page: 1,
        type: 'paragraph',
        rect: box(LEFT_X, 126, FULL_WIDTH, 48),
        text: 'We study multi-column reflow preserving $E = mc^2$ and citations (Smith, 2024).',
      },
      // Left column
      {
        id: 'p1-h1',
        page: 1,
        type: 'heading',
        rect: box(LEFT_X, 196, COL_WIDTH, 18),
        text: '1 Introduction',
      },
      {
        id: 'p1-intro-p1',
        page: 1,
        type: 'paragraph',
        rect: box(LEFT_X, 224, COL_WIDTH, 110),
        text: 'Prior layouts [1] split equations and cost $50 to typeset manually.1 The concentration H_2O varies with \\(\\alpha\\).',
      },
      {
        id: 'p1-h1-1',
        page: 1,
        type: 'heading',
        rect: box(LEFT_X, 350, COL_WIDTH, 16),
        text: '1.1 Motivation',
      },
      {
        id: 'p1-mot-p',
        page: 1,
        type: 'paragraph',
        rect: box(LEFT_X, 376, COL_WIDTH, 100),
        text: 'As shown by Smith et al. (2024), reading order matters across columns [1, 2].',
      },
      // Right column (interleaved vertically with left column!)
      {
        id: 'p1-h2',
        page: 1,
        type: 'heading',
        rect: box(RIGHT_X, 196, COL_WIDTH, 18),
        text: '2 Method',
      },
      {
        id: 'p1-method-p',
        page: 1,
        type: 'paragraph',
        rect: box(RIGHT_X, 224, COL_WIDTH, 70),
        text: 'We optimize the objective below:',
      },
      {
        id: 'p1-eq1',
        page: 1,
        type: 'formula',
        rect: box(RIGHT_X, 306, COL_WIDTH, 32),
        text: '$$\\mathcal{L}(\\theta) = \\sum_{i=1}^N x_i^2$$ (1)',
      },
      {
        id: 'p1-fig1',
        page: 1,
        type: 'figure',
        rect: box(RIGHT_X, 354, COL_WIDTH, 140),
        text: 'Pipeline diagram',
      },
      {
        id: 'p1-cap1',
        page: 1,
        type: 'other',
        rect: box(RIGHT_X, 502, COL_WIDTH, 28),
        text: 'Figure 1. Two-column reflow architecture.',
      },
      // Footnote in bottom band of page 1
      {
        id: 'p1-fn1',
        page: 1,
        type: 'footnote',
        rect: box(LEFT_X, 704, FULL_WIDTH, 24),
        text: '1 Supported by Research Grant 2024-01 with $\\beta > 0$.',
      },
      {
        id: 'p1-ftr',
        page: 1,
        type: 'other',
        rect: box(LEFT_X, 756, FULL_WIDTH, 14),
        text: 'Page 1 of 2',
      },

      // Page 2: repeated header/footer + 2 columns
      {
        id: 'p2-hdr',
        page: 2,
        type: 'other',
        rect: box(LEFT_X, 24, FULL_WIDTH, 14),
        text: 'Proceedings of Academic Reflow · Vol. 7',
      },
      {
        id: 'p2-h2-1',
        page: 2,
        type: 'heading',
        rect: box(LEFT_X, 84, COL_WIDTH, 16),
        text: '2.1 Experimental Setup',
      },
      {
        id: 'p2-cap-tbl1',
        page: 2,
        type: 'other',
        rect: box(LEFT_X, 114, COL_WIDTH, 24),
        text: 'Table 1. Benchmark F1 across layouts.',
      },
      {
        id: 'p2-tbl1',
        page: 2,
        type: 'table',
        rect: box(LEFT_X, 144, COL_WIDTH, 88),
        text: 'Model     F1\nReflow    95.4\nBaseline  88.1',
      },
      {
        id: 'p2-setup-p',
        page: 2,
        type: 'paragraph',
        rect: box(LEFT_X, 248, COL_WIDTH, 90),
        text: 'Equation (1) converges in 10 steps; see Figure 1 and Table 1.',
      },
      // Page 2 right column
      {
        id: 'p2-h3',
        page: 2,
        type: 'heading',
        rect: box(RIGHT_X, 84, COL_WIDTH, 18),
        text: '3 Conclusion',
      },
      {
        id: 'p2-concl-p',
        page: 2,
        type: 'paragraph',
        rect: box(RIGHT_X, 114, COL_WIDTH, 80),
        text: 'Clean reflow preserves all math and citations (Smith, 2024).',
      },
      {
        id: 'p2-refs-h',
        page: 2,
        type: 'heading',
        rect: box(RIGHT_X, 212, COL_WIDTH, 18),
        text: 'References',
      },
      {
        id: 'p2-ref1',
        page: 2,
        type: 'paragraph',
        rect: box(RIGHT_X, 240, COL_WIDTH, 36),
        text: '[1] Vaswani et al. Attention Is All You Need. NeurIPS, 2017.',
      },
      {
        id: 'p2-ref2',
        page: 2,
        type: 'paragraph',
        rect: box(RIGHT_X, 286, COL_WIDTH, 36),
        text: '[2] Smith, A. Clean Reflow Systems. ACL, 2024.',
      },
      {
        id: 'p2-ftr',
        page: 2,
        type: 'other',
        rect: box(LEFT_X, 756, FULL_WIDTH, 14),
        text: 'Page 2 of 2',
      },
    ],
    2,
  );
}

describe('reflowPaper: multi-column ordering, headers/footers, and section hierarchy', () => {
  it('converts multi-column DocumentIR pages into a single-column reading-order stream', () => {
    const ir = makeAcademicPaperIr();
    const doc: ReflowPaperDocument = reflowPaper(ir);

    expect(doc.documentId).toBe('paper-j08');
    expect(doc.title).toBe('Clean Single-Column Reflow for Scientific Papers');

    // Left column of page 1 must completely precede right column of page 1,
    // and page 1 must precede page 2. Bound captions sit on their figure/table, not standalone.
    const texts = doc.blocks.map((b: ReflowBlock) => b.text);
    const introIdx = texts.findIndex(t => t.includes('1 Introduction'));
    const motIdx = texts.findIndex(t => t.includes('1.1 Motivation'));
    const methodIdx = texts.findIndex(t => t.includes('2 Method'));
    const eqIdx = texts.findIndex(t => t.includes('\\mathcal{L}'));
    const setupIdx = texts.findIndex(t => t.includes('2.1 Experimental Setup'));
    const conclIdx = texts.findIndex(t => t.includes('3 Conclusion'));

    expect(introIdx).toBeGreaterThan(-1);
    expect(motIdx).toBeGreaterThan(introIdx);
    expect(methodIdx).toBeGreaterThan(motIdx);
    expect(eqIdx).toBeGreaterThan(methodIdx);
    expect(setupIdx).toBeGreaterThan(eqIdx);
    expect(conclIdx).toBeGreaterThan(setupIdx);
  });

  it('strips repeated headers and footers cleanly without dropping footnotes or section headings', () => {
    const ir = makeAcademicPaperIr();
    const doc = reflowPaper(ir);

    expect(doc.strippedFurniture.map(item => item.kind)).toEqual([
      'header',
      'footer',
      'header',
      'footer',
    ]);
    const joined = doc.blocks.map(b => b.text).join('\n');
    expect(joined).not.toContain('Proceedings of Academic Reflow');
    expect(joined).not.toContain('Page 1 of 2');
    expect(joined).not.toContain('Page 2 of 2');
    expect(doc.html).not.toContain('Proceedings of Academic Reflow');
    expect(doc.markdown).not.toContain('Page 1 of 2');
    expect(doc.footnotes).toHaveLength(1);
  });

  it('preserves section hierarchy levels and nested outline tree', () => {
    const ir = makeAcademicPaperIr();
    const doc = reflowPaper(ir);

    const headings = doc.blocks.filter(b => b.kind === 'heading');
    expect(headings.map(h => ({ text: h.text, level: h.headingLevel }))).toEqual([
      { text: 'Clean Single-Column Reflow for Scientific Papers', level: 1 },
      { text: 'Abstract', level: 1 },
      { text: '1 Introduction', level: 1 },
      { text: '1.1 Motivation', level: 2 },
      { text: '2 Method', level: 1 },
      { text: '2.1 Experimental Setup', level: 2 },
      { text: '3 Conclusion', level: 1 },
      { text: 'References', level: 1 },
    ]);

    const intro = doc.sections.find(s => s.title === '1 Introduction');
    expect(intro).toBeDefined();
    expect(intro?.children.map(c => c.title)).toEqual(['1.1 Motivation']);
    const method = doc.sections.find(s => s.title === '2 Method');
    expect(method?.children.map(c => c.title)).toEqual(['2.1 Experimental Setup']);
  });
});

describe('reflowPaper: formulas, footnotes, captions, and citations', () => {
  it('preserves inline math, display LaTeX, bare formulas, and numbered equations while ignoring currency', () => {
    const ir = makeAcademicPaperIr();
    const doc = reflowPaper(ir);

    const abs = doc.blocks.find(b => b.text.includes('multi-column reflow'));
    expect(abs?.segments.some(s => s.kind === 'inline-math' && s.latex === 'E = mc^{2}')).toBe(true);

    const introP = doc.blocks.find(b => b.text.includes('Prior layouts'));
    expect(introP?.text).toContain('$50');
    expect(introP?.segments.some(s => s.kind === 'inline-math' && s.latex === 'H_{2}O')).toBe(true);
    expect(introP?.segments.some(s => s.kind === 'inline-math' && s.latex === '\\alpha')).toBe(true);
    expect(introP?.segments.some(s => s.kind === 'inline-math' && s.value.includes('$50'))).toBe(false);

    const eqBlock = doc.blocks.find(b => b.kind === 'formula');
    expect(eqBlock?.formula).toMatchObject({
      display: true,
      latex: '\\mathcal{L}(\\theta) = \\sum_{i=1}^{N} x_{i}^{2}',
      equationNumber: '1',
    });
    expect(doc.equations).toHaveLength(1);
    expect(doc.equations[0]?.equationNumber).toBe('1');
  });

  it('preserves footnote definitions and in-text anchor links without interrupting flow', () => {
    const ir = makeAcademicPaperIr();
    const doc = reflowPaper(ir);

    expect(doc.footnotes).toHaveLength(1);
    const fn = doc.footnotes[0];
    expect(fn).toBeDefined();
    expect(fn?.label).toBe('1');
    expect(fn?.text).toBe('Supported by Research Grant 2024-01 with $\\beta > 0$.');
    expect(fn?.segments.some(s => s.kind === 'inline-math' && s.latex === '\\beta > 0')).toBe(true);

    const introP = doc.blocks.find(b => b.text.includes('Prior layouts'));
    const fnSeg = introP?.segments.find(s => s.kind === 'footnote-ref');
    expect(fnSeg).toMatchObject({
      kind: 'footnote-ref',
      label: '1',
      targetReflowId: fn?.reflowId,
    });
    expect(fn?.referencedBy).toEqual([introP?.reflowId]);
  });

  it('keeps figure and table captions bound directly to their figures and tables', () => {
    const ir = makeAcademicPaperIr();
    const doc = reflowPaper(ir);

    // Bound captions must not remain floating as standalone blocks.
    expect(doc.blocks.some(b => b.kind === 'paragraph' && b.text.startsWith('Figure 1.'))).toBe(false);
    expect(doc.blocks.some(b => b.kind === 'paragraph' && b.text.startsWith('Table 1.'))).toBe(false);

    const figBlock = doc.blocks.find(b => b.kind === 'figure');
    expect(figBlock?.caption?.kind).toBe('figure');
    expect(figBlock?.caption?.number).toBe(1);
    expect(figBlock?.caption?.text).toBe('Figure 1. Two-column reflow architecture.');

    const tblBlock = doc.blocks.find(b => b.kind === 'table');
    expect(tblBlock?.caption?.kind).toBe('table');
    expect(tblBlock?.caption?.number).toBe(1);
    expect(tblBlock?.caption?.text).toBe('Table 1. Benchmark F1 across layouts.');
    expect(tblBlock?.table).toEqual({
      headers: ['Model', 'F1'],
      rows: [
        ['Reflow', '95.4'],
        ['Baseline', '88.1'],
      ],
    });
  });

  it('preserves numeric and author-year citation markers cleanly', () => {
    const ir = makeAcademicPaperIr();
    const doc = reflowPaper(ir);

    expect(doc.citations.some(c => c.marker === '[1]' && c.style === 'numeric' && c.keys.includes('1'))).toBe(true);
    expect(doc.citations.some(c => c.marker === '[1, 2]' && c.style === 'numeric' && c.keys.join(',') === '1,2')).toBe(true);
    expect(doc.citations.some(c => c.marker === '(Smith, 2024)' && c.style === 'author-year')).toBe(true);
    expect(doc.citations.some(c => c.marker === 'Smith et al. (2024)' && c.style === 'author-year')).toBe(true);
  });
});

describe('reflowPaper: HTML + Markdown rendering and bidirectional lookup', () => {
  it('emits clean HTML and Markdown views preserving formulas, footnotes, captions, and citations', () => {
    const ir = makeAcademicPaperIr();
    const doc = reflowPaper(ir);

    // Markdown checks
    expect(doc.markdown).toContain('# Clean Single-Column Reflow for Scientific Papers');
    expect(doc.markdown).toContain('## 1 Introduction');
    expect(doc.markdown).toContain('### 1.1 Motivation');
    expect(doc.markdown).toContain('$E = mc^{2}$');
    expect(doc.markdown).toContain('$$\\mathcal{L}(\\theta) = \\sum_{i=1}^{N} x_{i}^{2}$$ (1)');
    expect(doc.markdown).toContain('[1]');
    expect(doc.markdown).toContain('(Smith, 2024)');
    expect(doc.markdown).toContain('[^1]');
    expect(doc.markdown).toContain('[^1]: Supported by Research Grant 2024-01 with $\\beta > 0$.');
    expect(doc.markdown).toContain('Figure 1. Two-column reflow architecture.');
    expect(doc.markdown).toContain('| Model | F1 |');

    // HTML checks
    expect(doc.html).toContain('<!DOCTYPE html>');
    expect(doc.html).toContain('<h1');
    expect(doc.html).toContain('>1 Introduction</h2>');
    expect(doc.html).toContain('<figure');
    expect(doc.html).toContain('<figcaption');
    expect(doc.html).toContain('<table>');
    expect(doc.html).toContain('<section class="footnotes"');
    expect(doc.html).toContain('href="#fn-1"');
    expect(doc.html).toContain('id="fn-1"');
    expect(doc.html).toContain('<cite class="reflow-citation"');
    expect(doc.html).toContain('$$\\mathcal{L}(\\theta) = \\sum_{i=1}^{N} x_{i}^{2}$$');
    expect(doc.html).toContain('&gt; 0'); // properly HTML-escaped inside math/text

    // Standalone renderer helpers match doc output
    expect(toReflowHtml(doc)).toBe(doc.html);
    expect(toReflowMarkdown(doc)).toBe(doc.markdown);
  });

  it('maintains deterministic bidirectional lookup (reflowId <-> { page, blockId, rect })', () => {
    const ir = makeAcademicPaperIr();
    const doc = reflowPaper(ir);

    // Every kept block, bound caption, and footnote round-trips bijectively
    expect(doc.lookup.entries.length).toBeGreaterThan(0);
    for (const entry of doc.lookup.entries) {
      const resolvedSource = resolveSourceLocation(doc, entry.reflowId);
      expect(resolvedSource).toEqual({
        page: entry.page,
        blockId: entry.blockId,
        rect: entry.rect,
      });

      const byBlock = resolveReflowId(doc, entry.blockId);
      expect(byBlock).toBe(entry.reflowId);

      const byCoord = resolveReflowId(doc, { page: entry.page, rect: entry.rect });
      expect(byCoord).toBe(entry.reflowId);

      const centerX = entry.rect.x + entry.rect.width / 2;
      const centerY = entry.rect.y + entry.rect.height / 2;
      const byPoint = resolveReflowId(doc, { page: entry.page, x: centerX, y: centerY });
      expect(byPoint).toBe(entry.reflowId);
    }

    // Bound caption block and footnote block resolve back to original IR pages/rects
    const figBlock = doc.blocks.find(b => b.kind === 'figure');
    expect(figBlock?.caption).toBeDefined();
    if (figBlock?.caption) {
      expect(resolveSourceLocation(doc, figBlock.caption.reflowId)).toEqual({
        page: 1,
        blockId: figBlock.caption.source.blockId,
        rect: box(RIGHT_X, 502, COL_WIDTH, 28),
      });
    }

    const fn = doc.footnotes[0];
    expect(fn).toBeDefined();
    if (fn) {
      expect(resolveSourceLocation(doc, fn.reflowId)).toEqual({
        page: 1,
        blockId: fn.source.blockId,
        rect: box(LEFT_X, 704, FULL_WIDTH, 24),
      });
    }

    // Stripped header has no reflowId in the lookup
    const headerIrBlock = ir.blocks.find(b => b.raw.includes('Proceedings of Academic Reflow'));
    expect(headerIrBlock).toBeDefined();
    if (headerIrBlock) {
      expect(resolveReflowId(doc, headerIrBlock.id)).toBeNull();
    }

    // Shuffled input blocks produce identical output and identical lookup IDs
    const shuffledIr: DocumentIR = {
      ...ir,
      pages: [...ir.pages].reverse(),
      blocks: [...ir.blocks].reverse(),
    };
    const docFromShuffled = reflowPaper(shuffledIr);
    expect(docFromShuffled).toEqual(doc);
  });
});
