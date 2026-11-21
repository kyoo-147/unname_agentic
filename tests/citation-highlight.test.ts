import { describe, expect, it, vi } from 'vitest';
import { buildDocument } from '../src/core/ir';
import type { DocumentIR } from '../src/core/ir';
import type { GroundedRegion, Quad } from '../src/core/visual-grounding';
import {
  SVG_NAMESPACE,
  createCitationHighlightController,
  prepareCitations,
  renderCitationOverlay,
  type CitationDocument,
  type CitationElement,
  type CitationEventLike,
  type CitationEventListener,
  type CitationNavigationTarget,
} from '../src/ui/citation-highlight';

/**
 * Lightweight DOM stub matching browser Element/Document surfaces needed for
 * citation chips and SVG polygon overlays without requiring jsdom.
 */
class FakeElement implements CitationElement {
  readonly tagName: string;
  readonly namespaceURI: string | null;
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  textContent: string | null = '';
  parent: FakeElement | null = null;
  ownerDocument: FakeDocument | null = null;
  focusCalls = 0;
  private readonly listeners = new Map<string, CitationEventListener[]>();

  constructor(tagName: string, namespaceURI: string | null = null, ownerDocument: FakeDocument | null = null) {
    this.tagName = tagName.toLowerCase();
    this.namespaceURI = namespaceURI;
    this.ownerDocument = ownerDocument;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      if (!(node instanceof FakeElement)) continue;
      node.parent?.drop(node);
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: unknown[]): void {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
  }

  remove(): void {
    this.parent?.drop(this);
    this.parent = null;
  }

  addEventListener(type: string, listener: CitationEventListener): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }

  removeEventListener(type: string, listener: CitationEventListener): void {
    const existing = this.listeners.get(type);
    if (!existing) return;
    this.listeners.set(type, existing.filter(entry => entry !== listener));
  }

  focus(): void {
    this.focusCalls += 1;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  dispatch(type: string, rawEvent: CitationEventLike = {}, bubbles = true): FakeEvent {
    let propagationStopped = false;
    let defaultPrevented = Boolean(rawEvent.defaultPrevented);
    const event: FakeEvent = {
      ...rawEvent,
      type,
      target: rawEvent.target ?? this,
      currentTarget: this,
      get defaultPrevented() {
        return defaultPrevented;
      },
      preventDefault() {
        defaultPrevented = true;
        rawEvent.preventDefault?.();
      },
      stopPropagation() {
        propagationStopped = true;
        rawEvent.stopPropagation?.();
      },
    };

    let current: FakeElement | null = this;
    while (current) {
      event.currentTarget = current;
      for (const listener of [...(current.listeners.get(type) ?? [])]) {
        listener(event);
      }
      if (!bubbles || propagationStopped) break;
      current = current.parent;
    }
    return event;
  }

  descendants(): FakeElement[] {
    return this.children.flatMap(child => [child, ...child.descendants()]);
  }

  private drop(node: FakeElement): void {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
  }
}

interface FakeEvent extends CitationEventLike {
  readonly defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

class FakeDocument implements CitationDocument {
  activeElement: FakeElement | null = null;

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, null, this);
  }

  createElementNS(namespaceURI: string, qualifiedName: string): FakeElement {
    return new FakeElement(qualifiedName, namespaceURI, this);
  }
}

function makeDocumentIR(): DocumentIR {
  return buildDocument({
    sourceSha256: 'b4'.repeat(32),
    pages: [
      { index: 1, width: 600, height: 800, rotation: 0 },
      { index: 2, width: 500, height: 1000, rotation: 0 },
    ],
    blocks: [
      { page: 1, text: 'Revenue rose 18 percent.', rect: { x: 60, y: 100, width: 300, height: 40 } },
      { page: 1, text: 'Margin stayed flat.', rect: { x: 60, y: 200, width: 240, height: 40 } },
      { page: 2, text: 'Outlook remains positive.', rect: { x: 50, y: 250, width: 250, height: 50 } },
    ],
  });
}

function asFake(element: CitationElement | null | undefined): FakeElement {
  if (!(element instanceof FakeElement)) throw new Error('Expected FakeElement');
  return element;
}

describe('I01 citation extraction and grounding resolution', () => {
  it('extracts clickable citation chips via citations.ts and strips markers from cleaned answer', () => {
    const ir = makeDocumentIR();
    const model = prepareCitations('Revenue grew [p1:r0], and outlook holds [p2:r0] [p1:r0].', ir);

    expect(model.cleanedAnswer).toBe('Revenue grew, and outlook holds.');
    expect(model.unresolved).toEqual([]);
    expect(model.chips).toHaveLength(2);

    expect(model.chips[0]).toMatchObject({
      chipIndex: 0,
      citationIndex: 0,
      page: 1,
      blockId: 'p1-r0',
      raw: '[p1:r0]',
      count: 2,
    });
    expect(model.chips[0]?.highlight?.rect).toEqual({ x: 60, y: 100, width: 300, height: 40 });
    expect(model.chips[0]?.highlight?.unit).toEqual({ x: 0.1, y: 0.125, width: 0.5, height: 0.05 });
    expect(model.chips[0]?.highlight?.svgViewBox).toBe('0 0 600 800');
    expect(model.chips[0]?.highlight?.svgPoints).toBe('60,100 360,100 360,140 60,140');

    expect(model.chips[1]).toMatchObject({
      chipIndex: 1,
      citationIndex: 1,
      page: 2,
      blockId: 'p2-r0',
      raw: '[p2:r0]',
      count: 1,
    });
    expect(model.chips[1]?.highlight?.rect).toEqual({ x: 50, y: 250, width: 250, height: 50 });
    expect(model.chips[1]?.highlight?.svgViewBox).toBe('0 0 500 1000');
    expect(model.chips[1]?.highlight?.svgPoints).toBe('50,250 300,250 300,300 50,300');
  });

  it('resolves optional quad polygons from visual-grounding.ts into page-space SVG points and DOM box bounds', () => {
    const ir = makeDocumentIR();
    const rotatedQuad: Quad = [
      { x: 100, y: 120 },
      { x: 500, y: 100 },
      { x: 520, y: 220 },
      { x: 120, y: 240 },
    ];
    const region: GroundedRegion = {
      bbox: [100, 100, 520, 240],
      quad: rotatedQuad,
      pageIndex: 1,
      confidence: 0.96,
    };

    const model = prepareCitations('Grounded figure [p1:r1].', ir, {
      grounding: { byBlockId: { 'p1-r1': region } },
    });

    const highlight = model.chips[0]?.highlight;
    expect(highlight).not.toBeNull();
    // Page 1 is 600 x 800, normalized coords are 0..1000.
    // (100/1000*600=60, 120/1000*800=96), (500/1000*600=300, 100/1000*800=80), ...
    expect(highlight?.polygon).toEqual([
      { x: 60, y: 96 },
      { x: 300, y: 80 },
      { x: 312, y: 176 },
      { x: 72, y: 192 },
    ]);
    expect(highlight?.svgPoints).toBe('60,96 300,80 312,176 72,192');
    expect(highlight?.rect).toEqual({ x: 60, y: 80, width: 252, height: 112 });
    expect(highlight?.unit).toEqual({ x: 0.1, y: 0.1, width: 0.42, height: 0.14 });
    expect(highlight?.quad).toEqual(rotatedQuad);
  });
});

describe('I01 click selection and SVG/DOM highlight rendering', () => {
  it('triggers scroll/focus callback and renders DOM bbox + SVG polygon on chip click', () => {
    const dom = new FakeDocument();
    const navigated: CitationNavigationTarget[] = [];
    const controller = createCitationHighlightController({
      answer: 'Claim one [p1:r0] and claim two [p2:r0].',
      ir: makeDocumentIR(),
      dom,
      onNavigate: target => navigated.push(target),
    });

    expect(controller.chipElements).toHaveLength(2);
    expect(asFake(controller.overlay).children).toEqual([]);

    const firstChip = asFake(controller.chipElements[0]);
    const secondChip = asFake(controller.chipElements[1]);
    expect(firstChip.getAttribute('aria-pressed')).toBe('false');
    expect(secondChip.getAttribute('aria-pressed')).toBe('false');

    firstChip.dispatch('click');

    expect(navigated).toHaveLength(1);
    expect(navigated[0]?.page).toBe(1);
    expect(navigated[0]?.blockId).toBe('p1-r0');
    expect(navigated[0]?.highlight?.rect).toEqual({ x: 60, y: 100, width: 300, height: 40 });

    expect(firstChip.getAttribute('aria-pressed')).toBe('true');
    expect(secondChip.getAttribute('aria-pressed')).toBe('false');
    expect(controller.snapshot().activeIndex).toBe(0);

    const overlayRoot = asFake(controller.overlay);
    expect(overlayRoot.children).toHaveLength(1);
    const activeOverlay = overlayRoot.children[0]!;
    expect(activeOverlay.getAttribute('data-page')).toBe('1');
    expect(activeOverlay.getAttribute('data-block-id')).toBe('p1-r0');

    const domBox = activeOverlay.descendants().find(el => el.getAttribute('class') === 'citation-highlight-box');
    expect(domBox?.style.left).toBe('10%');
    expect(domBox?.style.top).toBe('12.5%');
    expect(domBox?.style.width).toBe('50%');
    expect(domBox?.style.height).toBe('5%');

    const svg = activeOverlay.descendants().find(el => el.tagName === 'svg');
    expect(svg?.namespaceURI).toBe(SVG_NAMESPACE);
    expect(svg?.getAttribute('viewBox')).toBe('0 0 600 800');

    const polygon = svg?.descendants().find(el => el.tagName === 'polygon');
    expect(polygon?.namespaceURI).toBe(SVG_NAMESPACE);
    expect(polygon?.getAttribute('points')).toBe('60,100 360,100 360,140 60,140');
  });
});

describe('I01 keyboard navigation', () => {
  it('navigates chips with ArrowRight / ArrowLeft, activates with Enter, and clears with Escape', () => {
    const dom = new FakeDocument();
    const navigated: CitationNavigationTarget[] = [];
    const onClear = vi.fn();
    const controller = createCitationHighlightController({
      answer: 'First [p1:r0], second [p1:r1], third [p2:r0].',
      ir: makeDocumentIR(),
      dom,
      onNavigate: target => navigated.push(target),
      onClear,
    });

    const chip0 = asFake(controller.chipElements[0]);
    const chip1 = asFake(controller.chipElements[1]);
    const chip2 = asFake(controller.chipElements[2]);

    chip0.focus();
    chip0.dispatch('focus');

    const right1 = chip0.dispatch('keydown', { key: 'ArrowRight' });
    expect(right1.defaultPrevented).toBe(true);
    expect(dom.activeElement).toBe(chip1);
    expect(controller.snapshot().focusedIndex).toBe(1);
    expect(controller.snapshot().activeIndex).toBeNull();
    expect(navigated).toHaveLength(0);

    chip1.dispatch('keydown', { key: 'ArrowRight' });
    expect(dom.activeElement).toBe(chip2);

    // Wraps backwards from 0 -> 2 and forwards 2 -> 0
    chip2.dispatch('keydown', { key: 'ArrowRight' });
    expect(dom.activeElement).toBe(chip0);
    chip0.dispatch('keydown', { key: 'ArrowLeft' });
    expect(dom.activeElement).toBe(chip2);

    const enter = chip2.dispatch('keydown', { key: 'Enter' });
    expect(enter.defaultPrevented).toBe(true);
    expect(controller.snapshot().activeIndex).toBe(2);
    expect(navigated.map(item => item.blockId)).toEqual(['p2-r0']);
    expect(chip2.getAttribute('aria-pressed')).toBe('true');
    expect(asFake(controller.overlay).children).toHaveLength(1);

    const escape = chip2.dispatch('keydown', { key: 'Escape' });
    expect(escape.defaultPrevented).toBe(true);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().activeIndex).toBeNull();
    expect(chip2.getAttribute('aria-pressed')).toBe('false');
    expect(asFake(controller.overlay).children).toHaveLength(0);
  });
});

describe('I01 unresolved and invalid citation safe handling', () => {
  it('excludes unresolved citations from clickable chips without throwing or emitting highlights', () => {
    const dom = new FakeDocument();
    const navigated: CitationNavigationTarget[] = [];
    const controller = createCitationHighlightController({
      answer: 'Valid [p1:r0], missing page [p99], unknown block [#ghost], invalid page [p0].',
      ir: makeDocumentIR(),
      dom,
      onNavigate: target => navigated.push(target),
    });

    expect(controller.chips).toHaveLength(1);
    expect(controller.chipElements).toHaveLength(1);
    expect(controller.unresolved.map(entry => entry.reason)).toEqual([
      'page-out-of-range',
      'unknown-block',
      'page-out-of-range',
    ]);

    expect(controller.select(-1)).toBe(false);
    expect(controller.select(1)).toBe(false);
    expect(navigated).toHaveLength(0);
    expect(asFake(controller.overlay).children).toEqual([]);
  });

  it('handles page-only citations safely by navigating without rendering a block box', () => {
    const dom = new FakeDocument();
    const navigated: CitationNavigationTarget[] = [];
    const controller = createCitationHighlightController({
      answer: 'Block [p1:r0] then page [p2].',
      ir: makeDocumentIR(),
      dom,
      onNavigate: target => navigated.push(target),
    });

    asFake(controller.chipElements[0]).dispatch('click');
    expect(asFake(controller.overlay).children).toHaveLength(1);

    asFake(controller.chipElements[1]).dispatch('click');
    expect(navigated[1]).toMatchObject({ page: 2, blockId: null, highlight: null });
    expect(asFake(controller.overlay).children).toHaveLength(0);
    expect(asFake(controller.chipElements[1]).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('I01 minimal accessible HTML and ARIA output', () => {
  it('renders clean role="group", role="button", aria-pressed, and zero decorative bloat', () => {
    const dom = new FakeDocument();
    const controller = createCitationHighlightController({
      answer: 'See [p1:r0] and [p2].',
      ir: makeDocumentIR(),
      dom,
      ariaLabel: 'Answer sources',
    });

    const bar = asFake(controller.chipBar);
    expect(bar.tagName).toBe('div');
    expect(bar.getAttribute('role')).toBe('group');
    expect(bar.getAttribute('aria-label')).toBe('Answer sources');
    expect(bar.getAttribute('style')).toBeNull();
    expect(bar.children).toHaveLength(2);

    const first = bar.children[0]!;
    expect(first.tagName).toBe('button');
    expect(first.getAttribute('type')).toBe('button');
    expect(first.getAttribute('role')).toBe('button');
    expect(first.getAttribute('aria-pressed')).toBe('false');
    expect(first.getAttribute('aria-label')).toBeTruthy();
    expect(first.children).toHaveLength(0);
    expect(first.textContent).toBe('p.1 · p1-r0');

    const second = bar.children[1]!;
    expect(second.textContent).toBe('p.2');
    expect(second.getAttribute('data-block-id')).toBeNull();

    const overlayNode = asFake(renderCitationOverlay(controller.chips[0]!, dom));
    expect(overlayNode.getAttribute('aria-hidden')).toBe('true');
    // Exactly 1 DOM box + 1 SVG containing 1 polygon — no decorative clutter
    expect(overlayNode.children.map(node => node.tagName)).toEqual(['div', 'svg']);
    expect(overlayNode.children[1]?.children.map(node => node.tagName)).toEqual(['polygon']);
  });
});
