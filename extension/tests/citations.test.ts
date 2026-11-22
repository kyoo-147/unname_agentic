import { describe, expect, it } from 'vitest';
import { buildDocument } from '../viewer/src/core/ir';
import type { DocumentIR } from '../viewer/src/core/ir';
import { highlightShape, parseCitations, resolveCitations } from '../viewer/src/core/citations';

/**
 * Two pages and three blocks. `buildDocument` derives the ids, so the fixture pins the
 * same `p{page}-r{rank}` shape a marker has to name: p1-r0 (heading), p1-r1
 * (paragraph), p2-r0 (paragraph on the second page).
 */
function document(): DocumentIR {
  return buildDocument({
    sourceSha256: 'a3'.repeat(32),
    pages: [
      { index: 1, width: 612, height: 792 },
      { index: 2, width: 595, height: 842 },
    ],
    blocks: [
      { page: 1, text: 'First heading', rect: { x: 72, y: 72, width: 300, height: 24 } },
      { page: 1, text: 'Second paragraph', rect: { x: 72, y: 120, width: 468, height: 48 } },
      { page: 2, text: 'Later paragraph', rect: { x: 72, y: 100, width: 451, height: 36 } },
    ],
  });
}

describe('parseCitations', () => {
  it('reads a page-only marker and keeps the sentence end', () => {
    const parsed = parseCitations('Answer [p12].');
    expect(parsed.citations).toEqual([{ page: 12, raw: '[p12]', index: 0, count: 1 }]);
    expect(parsed.citations[0]?.blockId).toBeUndefined();
    expect(parsed.cleaned).toBe('Answer.');
  });

  it('accepts the page letter in either case', () => {
    expect(parseCitations('As in [P7] above.').citations).toEqual([
      { page: 7, raw: '[P7]', index: 0, count: 1 },
    ]);
  });

  it('reads a page and rank marker as the block id the IR assigns', () => {
    const parsed = parseCitations('See [p12:r3] for the figure.');
    expect(parsed.citations).toEqual([{ page: 12, blockId: 'p12-r3', raw: '[p12:r3]', index: 0, count: 1 }]);
    expect(parsed.cleaned).toBe('See for the figure.');
  });

  it('reads the Vietnamese page form', () => {
    const parsed = parseCitations('Số liệu (trang 12) đã nêu.');
    expect(parsed.citations).toEqual([{ page: 12, raw: '(trang 12)', index: 0, count: 1 }]);
    expect(parsed.cleaned).toBe('Số liệu đã nêu.');
    expect(parseCitations('Xem (Trang 7) nhé.').citations).toEqual([
      { page: 7, raw: '(Trang 7)', index: 0, count: 1 },
    ]);
  });

  it('reads a bare block id and takes the page from it when the id encodes one', () => {
    const parsed = parseCitations('Per [#p1-r1] this holds.');
    expect(parsed.citations).toEqual([{ page: 1, blockId: 'p1-r1', raw: '[#p1-r1]', index: 0, count: 1 }]);
    expect(parsed.cleaned).toBe('Per this holds.');
  });

  it('leaves the page unknown for a block id that does not encode one', () => {
    const parsed = parseCitations('Draft [#rough-draft] says so.');
    expect(parsed.citations).toEqual([
      { page: null, blockId: 'rough-draft', raw: '[#rough-draft]', index: 0, count: 1 },
    ]);
    expect(parsed.cleaned).toBe('Draft says so.');
  });

  it('parses the JSON form, quoted and unquoted', () => {
    const quoted = '[[cite:{"page":2,"blockId":"p2-r0"}]]';
    const parsed = parseCitations(`Total ${quoted} grows.`);
    expect(parsed.citations).toEqual([{ page: 2, blockId: 'p2-r0', raw: quoted, index: 0, count: 1 }]);
    expect(parsed.cleaned).toBe('Total grows.');

    expect(parseCitations('Total [[cite:{page: 2, blockId: p2-r0}]] grows.').citations).toEqual([
      { page: 2, blockId: 'p2-r0', raw: '[[cite:{page: 2, blockId: p2-r0}]]', index: 0, count: 1 },
    ]);
    expect(parseCitations('See [[cite:{"page":3}]] too.').citations).toEqual([
      { page: 3, raw: '[[cite:{"page":3}]]', index: 0, count: 1 },
    ]);
  });

  it('leaves a JSON payload with no target in the prose', () => {
    const text = 'Broken [[cite:{"kind":"page"}]] marker.';
    const parsed = parseCitations(text);
    expect(parsed.citations).toEqual([]);
    expect(parsed.cleaned).toBe(text);
  });

  it('collapses duplicates across syntaxes but counts them', () => {
    const parsed = parseCitations('A [p2] B (trang 2) C [#p2-r0] D [p2:r0]');
    expect(parsed.citations).toEqual([
      { page: 2, raw: '[p2]', index: 0, count: 2 },
      { page: 2, blockId: 'p2-r0', raw: '[#p2-r0]', index: 1, count: 2 },
    ]);
    expect(parsed.cleaned).not.toContain('[');
  });

  it('keeps a separating space when markers sit back to back', () => {
    expect(parseCitations('Shown as [p1][p2] above.').cleaned).toBe('Shown as above.');
    expect(parseCitations('word[p1][p2] and').cleaned).toBe('word and');
    expect(parseCitations('[p1] [p2] and').cleaned).toBe('and');
  });

  it('returns an empty list and unchanged text when there is nothing to cite', () => {
    const prose = 'Plain prose, no markers at all.';
    expect(parseCitations(prose)).toEqual({ citations: [], cleaned: prose });
    expect(parseCitations('')).toEqual({ citations: [], cleaned: '' });
  });

  it('does not mistake a markdown link for a citation', () => {
    const text = 'See [the docs](https://example.test/x) for more.';
    expect(parseCitations(text)).toEqual({ citations: [], cleaned: text });
  });
});

describe('resolveCitations', () => {
  it('resolves a block citation to its polygon and page size', () => {
    const ir = document();
    const block = ir.blocks.find(entry => entry.id === 'p1-r1');
    if (!block) throw new Error('fixture is missing block p1-r1');

    const { resolved, unresolved } = resolveCitations(parseCitations('[p1:r1]').citations, ir);
    expect(unresolved).toEqual([]);
    expect(resolved).toEqual([
      {
        index: 0,
        page: 1,
        width: 612,
        height: 792,
        rotation: 0,
        blockId: 'p1-r1',
        polygon: block.polygon,
        rect: { x: 72, y: 120, width: 468, height: 48 },
        raw: '[p1:r1]',
        count: 1,
      },
    ]);
  });

  it('resolves a page-only citation to the page with no block', () => {
    const { resolved, unresolved } = resolveCitations(parseCitations('[p2]').citations, document());
    expect(unresolved).toEqual([]);
    expect(resolved).toEqual([
      {
        index: 0,
        page: 2,
        width: 595,
        height: 842,
        rotation: 0,
        blockId: null,
        polygon: null,
        rect: null,
        raw: '[p2]',
        count: 1,
      },
    ]);
  });

  it('keeps the input order and the duplicate count', () => {
    const { resolved } = resolveCitations(parseCitations('[p2] and [p1:r0] and [p2]').citations, document());
    expect(resolved.map(entry => entry.page)).toEqual([2, 1]);
    expect(resolved.map(entry => entry.count)).toEqual([2, 1]);
    expect(resolved.map(entry => entry.blockId)).toEqual([null, 'p1-r0']);
  });

  it('reports a page the document does not have', () => {
    const { resolved, unresolved } = resolveCitations(parseCitations('[p9]').citations, document());
    expect(resolved).toEqual([]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.reason).toBe('page-out-of-range');
    expect(unresolved[0]?.citation.raw).toBe('[p9]');
  });

  it('treats page 0 as out of range instead of a parse failure', () => {
    const parsed = parseCitations('Page [p0] is not a page.');
    expect(parsed.citations).toEqual([{ page: 0, raw: '[p0]', index: 0, count: 1 }]);
    expect(resolveCitations(parsed.citations, document()).unresolved[0]?.reason).toBe('page-out-of-range');
  });

  it('reports a block the document does not have', () => {
    const { resolved, unresolved } = resolveCitations(parseCitations('See [p1:r9] and [#ghost].').citations, document());
    expect(resolved).toEqual([]);
    expect(unresolved.map(entry => entry.reason)).toEqual(['unknown-block', 'unknown-block']);
    expect(unresolved.map(entry => entry.citation.raw)).toEqual(['[p1:r9]', '[#ghost]']);
  });

  it('reports a marker whose page and block disagree', () => {
    const { resolved, unresolved } = resolveCitations(
      [{ page: 2, blockId: 'p1-r0', raw: '[p2:wrong]', index: 0, count: 1 }],
      document(),
    );
    expect(resolved).toEqual([]);
    expect(unresolved[0]?.reason).toBe('page-mismatch');
  });

  it('reports a marker that names neither a page nor a block', () => {
    const { unresolved } = resolveCitations([{ page: null, raw: '[?]', index: 0, count: 1 }], document());
    expect(unresolved[0]?.reason).toBe('no-page');
  });
});

describe('highlightShape', () => {
  it('normalises against the page it is given, including a quarter-turned page', () => {
    // A 90 degree page reports its displayed size, so x is divided by 792, not by 612.
    const rotated = { index: 1, width: 792, height: 612, rotation: 90 as const };
    const shape = highlightShape({ x: 100, y: 50, width: 200, height: 100 }, rotated);

    expect(shape.rect).toEqual({ x: 100, y: 50, width: 200, height: 100 });
    expect(shape.unit.x).toBeCloseTo(100 / 792, 5);
    expect(shape.unit.y).toBeCloseTo(50 / 612, 5);
    expect(shape.unit.width).toBeCloseTo(200 / 792, 5);
    expect(shape.unit.height).toBeCloseTo(100 / 612, 5);
    expect(shape.unit.width * rotated.width).toBeCloseTo(200, 2);
    expect(shape.polygon).toEqual([
      { x: 100, y: 50 },
      { x: 300, y: 50 },
      { x: 300, y: 150 },
      { x: 100, y: 150 },
    ]);
    expect(shape.unitPolygon[2].x).toBeCloseTo(300 / 792, 5);
    expect(shape.unitPolygon[0]).toEqual({ x: shape.unit.x, y: shape.unit.y });
  });

  it('clamps a rect that overhangs its page', () => {
    const shape = highlightShape({ x: -20, y: 700, width: 900, height: 400 }, { width: 612, height: 792 });
    expect(shape.rect).toEqual({ x: 0, y: 700, width: 612, height: 92 });
    expect(shape.unit.x).toBe(0);
    expect(shape.unit.width).toBe(1);
    expect(shape.unit.y).toBeCloseTo(700 / 792, 5);
    expect(shape.unit.height).toBeCloseTo(92 / 792, 5);
  });

  it('collapses to zero on a page with no size instead of dividing by zero', () => {
    const shape = highlightShape({ x: 10, y: 10, width: 10, height: 10 }, { width: 0, height: 0 });
    expect(shape.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(shape.unit).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('takes a resolved citation straight through', () => {
    const { resolved } = resolveCitations(parseCitations('[p1:r1]').citations, document());
    const citation = resolved[0];
    if (!citation || !citation.rect) throw new Error('expected a resolved block with a rect');

    const shape = highlightShape(citation.rect, citation);
    expect(shape.unit.x).toBeCloseTo(72 / 612, 5);
    expect(shape.unit.y).toBeCloseTo(120 / 792, 5);
    expect(shape.unit.width).toBeCloseTo(468 / 612, 5);
    expect(shape.unit.height).toBeCloseTo(48 / 792, 5);
  });
});
