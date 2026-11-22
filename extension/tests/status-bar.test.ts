import { beforeAll, describe, expect, it } from 'vitest';
import { setLocale } from '../viewer/src/i18n';
import { UNKNOWN_PROVIDER, createStatusModel, renderStatus } from '../viewer/src/ui/status-bar';
import type { StatusDocument, StatusElement, StatusSource } from '../viewer/src/ui/status-bar';

/**
 * A recording element. The renderer only needs className, textContent, setAttribute
 * and append, so the tests can assert the returned tree without jsdom.
 */
class FakeElement implements StatusElement {
  readonly tagName: string;
  className = '';
  textContent: string | null = '';
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(...nodes: unknown[]): void {
    for (const node of nodes) this.children.push(node as FakeElement);
  }
}

class FakeDocument implements StatusDocument {
  createElement(tagName: string): StatusElement {
    return new FakeElement(tagName);
  }
}

/**
 * Type-level check only (never called): with a real Document the renderer has to return
 * an HTMLElement the app can mount, and Document has to satisfy the factory contract.
 */
function browserRender(model: StatusSource): HTMLElement {
  return renderStatus(model, document);
}

const fakeDocument = new FakeDocument();

function asElement(value: StatusElement): FakeElement {
  return value as unknown as FakeElement;
}

function render(source: StatusSource): FakeElement {
  return asElement(renderStatus(source, fakeDocument));
}

function descendants(element: FakeElement): FakeElement[] {
  const found: FakeElement[] = [];
  for (const candidate of element.children) found.push(candidate, ...descendants(candidate));
  return found;
}

function child(element: FakeElement, className: string): FakeElement | undefined {
  return descendants(element).find(candidate => candidate.className.split(/\s+/).includes(className));
}

/** Structural fingerprint of a rendered tree: tag, class, text and attributes. */
function signature(element: FakeElement): unknown[] {
  return [
    element.tagName,
    element.className,
    element.textContent,
    [...element.attributes.entries()],
    element.children.map(child => signature(child)),
  ];
}

function textOf(element: FakeElement, className: string): string | null {
  return child(element, className)?.textContent ?? '<missing>';
}

beforeAll(() => {
  // The strip takes its labels from src/i18n.ts; English keeps the assertions readable.
  setLocale('en');
});

describe('status model', () => {
  it('starts idle, with no document, no job and an explicit unknown provider', () => {
    const model = createStatusModel();
    expect(model.snapshot()).toEqual({
      mode: 'idle',
      provider: UNKNOWN_PROVIDER,
      page: 0,
      pageCount: 0,
      job: null,
      message: null,
      busy: false,
    });
    expect(model.snapshot().provider).not.toBe('');
  });

  it('updates page, page count and provider', () => {
    const model = createStatusModel();
    model.update({ page: 4, pageCount: 12, provider: 'DeepL' });
    expect(model.snapshot()).toMatchObject({ page: 4, pageCount: 12, provider: 'DeepL' });
    expect(textOf(render(model), 'reader-status-bar__page')).toBe('Page 4 of 12');
    expect(textOf(render(model), 'reader-status-bar__value')).toBe('DeepL');
  });

  it('clamps the page into a known page count', () => {
    const model = createStatusModel();
    model.update({ page: 9 });
    expect(model.snapshot().page).toBe(9);
    model.update({ pageCount: 5 });
    expect(model.snapshot().page).toBe(5);
    model.update({ page: 0 });
    expect(model.snapshot().page).toBe(1);
  });

  it('shows a running job with its progress and estimate', () => {
    const model = createStatusModel();
    model.update({ job: { state: 'running', progress: 42, eta: '~2 min' } });
    expect(model.snapshot().job).toEqual({ state: 'running', progress: 42, eta: '~2 min' });
    expect(model.snapshot().busy).toBe(true);

    const job = child(render(model), 'reader-status-bar__job');
    expect(job?.tagName).toBe('span');
    expect(job?.attributes.get('role')).toBe('progressbar');
    expect(job?.attributes.get('aria-valuemin')).toBe('0');
    expect(job?.attributes.get('aria-valuemax')).toBe('100');
    expect(job?.attributes.get('aria-valuenow')).toBe('42');
    expect(textOf(job!, 'reader-status-bar__progress')).toBe('42%');
    expect(textOf(job!, 'reader-status-bar__eta')).toBe('~2 min');
  });

  it('clears the estimate once the job reaches 100 percent', () => {
    const model = createStatusModel();
    model.update({ job: { state: 'running', progress: 100, eta: '~2 min' } });
    expect(model.snapshot().job).toEqual({ state: 'running', progress: 100, eta: null });
    expect(model.snapshot().busy).toBe(false);

    const job = child(render(model), 'reader-status-bar__job');
    expect(job?.attributes.get('aria-valuenow')).toBe('100');
    expect(child(job!, 'reader-status-bar__eta')).toBeUndefined();
  });

  it('clamps and rounds progress at both ends', () => {
    const model = createStatusModel();
    model.update({ job: { state: 'running', progress: -20, eta: '~1 min' } });
    expect(model.snapshot().job).toEqual({ state: 'running', progress: 0, eta: '~1 min' });
    expect(model.snapshot().busy).toBe(true);

    model.update({ job: { state: 'running', progress: 140, eta: '~1 min' } });
    expect(model.snapshot().job).toEqual({ state: 'running', progress: 100, eta: null });
    expect(model.snapshot().busy).toBe(false);

    model.update({ job: { state: 'running', progress: 41.6, eta: '   ' } });
    expect(model.snapshot().job).toEqual({ state: 'running', progress: 42, eta: null });

    model.update({ job: { state: 'running', progress: Number.NaN, eta: '~3 min' } });
    expect(model.snapshot().job).toEqual({ state: 'running', progress: 0, eta: '~3 min' });
  });

  it('keeps a message until it is replaced or explicitly cleared', () => {
    const model = createStatusModel();
    model.update({ message: { kind: 'error', text: 'Cannot open this document.' } });
    model.update({ page: 3 });
    model.update({ job: { state: 'running', progress: 10, eta: '~1 min' } });
    expect(model.snapshot().message).toEqual({ kind: 'error', text: 'Cannot open this document.' });

    const message = child(render(model), 'reader-status-bar__message');
    expect(message?.tagName).toBe('span');
    expect(message?.textContent).toBe('Cannot open this document.');
    expect(message?.attributes.get('data-kind')).toBe('error');
    expect(message?.className.split(/\s+/)).toContain('reader-status-bar__message--error');

    model.update({ message: null });
    expect(model.snapshot().message).toBeNull();
    expect(child(render(model), 'reader-status-bar__message')).toBeUndefined();
  });

  it('clears the job and the busy flag when the job is set to null', () => {
    const model = createStatusModel();
    model.update({ job: { state: 'running', progress: 30, eta: '~3 min' } });
    expect(render(model).attributes.get('data-busy')).toBe('true');
    model.update({ job: null });
    expect(model.snapshot().job).toBeNull();
    expect(model.snapshot().busy).toBe(false);
    expect(child(render(model), 'reader-status-bar__job')).toBeUndefined();
  });

  it('does not estimate a job whose state already ended', () => {
    const model = createStatusModel();
    model.update({ job: { state: 'done', progress: 80, eta: '~1 min' } });
    expect(model.snapshot().job).toEqual({ state: 'done', progress: 80, eta: null });
    expect(model.snapshot().busy).toBe(false);
  });

  it('replaces a message and keeps the new kind', () => {
    const model = createStatusModel();
    model.update({ message: { kind: 'info', text: 'Working.' } });
    model.update({ message: { kind: 'error', text: 'Failed.' } });
    expect(model.snapshot().message).toEqual({ kind: 'error', text: 'Failed.' });
    expect(child(render(model), 'reader-status-bar__message')?.attributes.get('data-kind')).toBe('error');
  });

  it('drops a message whose text is empty instead of rendering a blank line', () => {
    const model = createStatusModel();
    model.update({ message: { kind: 'info', text: '   ' } });
    expect(model.snapshot().message).toBeNull();
    expect(child(render(model), 'reader-status-bar__message')).toBeUndefined();
  });

  it('hands out copies so a caller cannot mutate the model through a snapshot', () => {
    const model = createStatusModel();
    model.update({ page: 2, job: { state: 'running', progress: 50, eta: '~4 min' } });
    const snapshot = model.snapshot();
    snapshot.page = 99;
    if (snapshot.job) snapshot.job.progress = 1;
    expect(model.snapshot().page).toBe(2);
    expect(model.snapshot().job?.progress).toBe(50);
  });
});

describe('status strip rendering', () => {
  it('builds a plain root element with fixed class names and no style', () => {
    const model = createStatusModel();
    const root = render(model);
    expect(root.tagName).toBe('div');
    expect(root.className).toBe('reader-status-bar');
    expect(root.attributes.get('data-busy')).toBe('false');
    expect(root.attributes.has('style')).toBe(false);

    model.update({ job: { state: 'running', progress: 5, eta: '~1 min' } });
    expect(render(model).attributes.get('data-busy')).toBe('true');
  });

  it('shows the page as the initial page until a document reports its length', () => {
    const model = createStatusModel();
    expect(textOf(render(model), 'reader-status-bar__page')).toBe('Page 1');

    model.update({ page: 1, pageCount: 8 });
    expect(textOf(render(model), 'reader-status-bar__page')).toBe('Page 1 of 8');
  });

  it('omits the mode segment when idle and translates it when set', () => {
    const model = createStatusModel();
    expect(child(render(model), 'reader-status-bar__mode')).toBeUndefined();

    model.update({ mode: 'visible' });
    const mode = child(render(model), 'reader-status-bar__mode');
    expect(mode?.textContent).toBe('Visible pages first');
    expect(mode?.attributes.get('data-i18n')).toBe('modeVisible');

    model.update({ mode: 'paused' });
    expect(child(render(model), 'reader-status-bar__mode')?.textContent).toBe('Paused');

    model.update({ mode: 'idle' });
    expect(child(render(model), 'reader-status-bar__mode')).toBeUndefined();
  });

  it('gives the message a polite live region', () => {
    const model = createStatusModel();
    model.update({ message: { kind: 'warning', text: 'Provider unavailable.' } });
    const message = child(render(model), 'reader-status-bar__message');
    expect(message?.attributes.get('role')).toBe('status');
    expect(message?.attributes.get('aria-live')).toBe('polite');
  });

  it('marks an unknown provider as unknown instead of rendering an empty value', () => {
    const model = createStatusModel();
    const fallback = child(render(model), 'reader-status-bar__value');
    expect(fallback?.textContent).toBe(UNKNOWN_PROVIDER);
    expect(fallback?.textContent).not.toBe('');
    expect(fallback?.attributes.get('data-unknown')).toBe('true');

    model.update({ provider: '   ' });
    expect(child(render(model), 'reader-status-bar__value')?.textContent).toBe(UNKNOWN_PROVIDER);

    model.update({ provider: '  Local  provider ' });
    const known = child(render(model), 'reader-status-bar__value');
    expect(known?.textContent).toBe('Local provider');
    expect(known?.attributes.has('data-unknown')).toBe(false);
  });

  it('renders from a snapshot as well as from a model', () => {
    const model = createStatusModel();
    model.update({ mode: 'full', page: 2, pageCount: 3, provider: 'OpenAI', job: { state: 'running', progress: 7, eta: '~5 min' } });
    const fromModel = render(model);
    const fromSnapshot = render(model.snapshot());
    expect(signature(fromSnapshot)).toEqual(signature(fromModel));
    expect(textOf(fromSnapshot, 'reader-status-bar__page')).toBe('Page 2 of 3');
    expect(textOf(fromSnapshot, 'reader-status-bar__mode')).toBe('Full document');
  });

  it('refuses to guess a document when neither argument nor global exists', () => {
    const model = createStatusModel();
    expect(() => renderStatus(model)).toThrow(/document/);
  });
});
