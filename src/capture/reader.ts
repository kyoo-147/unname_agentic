import './capture.css';
import type { TextBlock } from '../core/types';
import { CaptureError, decodeDataUrl, readCaptureParams, requestCaptureImage } from '../ui/capture';
import type { OcrEngine } from '../ocr/engine';
import type { OcrPageModel } from '../ocr/pipeline';
import {
  blockConfidences,
  blockRectPosition,
  captureString,
  DEFAULT_CONFIDENCE_THRESHOLD,
  filterLowConfidence,
  formatConfidence,
  numberBlocks,
  resolveCaptureLocale,
  selectTranslationQueue,
  sourceLanguageLabel,
  summarizeConfidence,
  translationStatusKey,
  type CaptureCopyKey,
  type CaptureLocale,
  type TranslationView,
} from './view-model';

export type CaptureTranslate = (text: string, block: TextBlock) => Promise<string>;

export interface CaptureReaderOptions {
  root: HTMLElement;
  translate: CaptureTranslate;
  t?: (key: string, vars?: Record<string, string | number>) => string;
  engine?: OcrEngine;
  languages?: string[];
  signal?: AbortSignal;
  onStatus?: (message: string, error?: boolean) => void;
  onBack?: () => void;
  title?: string;
}

export interface CaptureReaderHandle {
  destroy(): void;
  retry(): Promise<void>;
}

interface Failure {
  key: CaptureCopyKey;
  detail?: string;
  retry: boolean;
}

interface CardView {
  root: HTMLLIElement;
  number: number;
  status: HTMLSpanElement;
  translation: HTMLDivElement;
  retry: HTMLButtonElement;
}

const DEFAULT_LANGUAGES = ['eng', 'vie'];

export function isCaptureRequest(search: string): boolean {
  return readCaptureParams(search) !== undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function failureFor(error: unknown): Failure {
  if (error instanceof CaptureError) {
    switch (error.code) {
      case 'no-extension': return { key: 'errorNoExtension', retry: false };
      case 'expired': return { key: 'errorExpired', retry: true };
      case 'timeout': return { key: 'errorTimeout', retry: true };
      case 'invalid-response': return { key: 'errorInvalid', retry: true };
    }
  }
  return { key: 'errorUnknown', detail: errorMessage(error), retry: true };
}

export async function mountCaptureReader(options: CaptureReaderOptions): Promise<CaptureReaderHandle> {
  const doc = options.root.ownerDocument;
  const view = doc.defaultView;
  const locale: CaptureLocale = resolveCaptureLocale(doc.documentElement.lang);
  const lifecycle = new AbortController();
  const listenerOptions = { signal: lifecycle.signal };
  const languages = options.languages?.length ? [...options.languages] : [...DEFAULT_LANGUAGES];

  function tr(key: CaptureCopyKey, vars?: Record<string, string | number>): string {
    if (options.t) {
      try {
        const external = options.t(key, vars);
        if (external && external !== key) return external;
      } catch {
        return captureString(locale, key, vars);
      }
    }
    return captureString(locale, key, vars);
  }

  function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const section = element('section', 'capture-reader');
  section.setAttribute('aria-labelledby', 'capture-title');
  section.innerHTML = `<header class="capture-header">
  <div class="capture-header__heading">
    <p class="capture-eyebrow" id="capture-eyebrow"></p>
    <h1 class="capture-title" id="capture-title"></h1>
  </div>
  <div class="capture-header__actions">
    <button type="button" class="capture-button capture-button--ghost" id="capture-back"></button>
    <button type="button" class="capture-button" id="capture-retry-all" disabled></button>
  </div>
</header>
<p class="capture-note" id="capture-note"></p>
<div class="capture-progress" id="capture-progress" role="status" aria-live="polite">
  <span class="capture-spinner" aria-hidden="true"></span>
  <p class="capture-progress__text" id="capture-progress-text"></p>
</div>
<div class="capture-error" id="capture-error" role="alert" hidden>
  <h2 class="capture-error__title" id="capture-error-title"></h2>
  <p class="capture-error__message" id="capture-error-message"></p>
  <p class="capture-error__detail" id="capture-error-detail" hidden></p>
  <div class="capture-error__actions">
    <button type="button" class="capture-button" id="capture-error-retry"></button>
    <button type="button" class="capture-button capture-button--ghost" id="capture-error-back"></button>
  </div>
</div>
<div class="capture-panes" id="capture-panes" hidden>
  <div class="capture-summary" id="capture-summary" aria-live="polite"></div>
  <section class="capture-pane capture-pane--source" aria-labelledby="capture-source-heading">
    <h2 class="capture-pane__heading" id="capture-source-heading"></h2>
    <div class="capture-frame" id="capture-frame">
      <img class="capture-image" id="capture-image" decoding="async">
      <div class="capture-overlays" id="capture-overlays"></div>
    </div>
  </section>
  <section class="capture-pane capture-pane--cards" aria-labelledby="capture-translated-heading">
    <h2 class="capture-pane__heading" id="capture-translated-heading"></h2>
    <ol class="capture-cards" id="capture-cards"></ol>
  </section>
</div>`;

  function byId<T extends HTMLElement>(id: string): T {
    const node = section.querySelector<T>(`#${id}`);
    if (!node) throw new Error(`Missing capture reader element: ${id}`);
    return node;
  }

  const title = byId<HTMLHeadingElement>('capture-title');
  const retryAllButton = byId<HTMLButtonElement>('capture-retry-all');
  const backButton = byId<HTMLButtonElement>('capture-back');
  const progress = byId<HTMLDivElement>('capture-progress');
  const progressText = byId<HTMLParagraphElement>('capture-progress-text');
  const errorPanel = byId<HTMLDivElement>('capture-error');
  const errorTitle = byId<HTMLHeadingElement>('capture-error-title');
  const errorMessageEl = byId<HTMLParagraphElement>('capture-error-message');
  const errorDetailEl = byId<HTMLParagraphElement>('capture-error-detail');
  const errorRetry = byId<HTMLButtonElement>('capture-error-retry');
  const errorBack = byId<HTMLButtonElement>('capture-error-back');
  const panes = byId<HTMLDivElement>('capture-panes');
  const summary = byId<HTMLDivElement>('capture-summary');
  const frame = byId<HTMLDivElement>('capture-frame');
  const image = byId<HTMLImageElement>('capture-image');
  const overlays = byId<HTMLDivElement>('capture-overlays');
  const cards = byId<HTMLOListElement>('capture-cards');

  byId<HTMLParagraphElement>('capture-eyebrow').textContent = tr('eyebrow');
  title.textContent = options.title || tr('title');
  byId<HTMLParagraphElement>('capture-note').textContent = tr('note');
  byId<HTMLHeadingElement>('capture-source-heading').textContent = tr('sourceHeading');
  byId<HTMLHeadingElement>('capture-translated-heading').textContent = tr('translatedHeading');
  backButton.textContent = tr('back');
  retryAllButton.textContent = tr('retryAll');
  errorTitle.textContent = tr('errorTitle');
  errorRetry.textContent = tr('retry');
  errorBack.textContent = tr('back');
  image.alt = tr('imageAlt');

  const translations = new Map<string, TranslationView>();
  const blockIndex = new Map<string, TextBlock>();
  const regionViews = new Map<string, HTMLButtonElement>();
  const cardViews = new Map<string, CardView>();
  const confidences = new Map<string, number>();
  const idleWaiters: Array<() => void> = [];

  let page: OcrPageModel | undefined;
  let imageUrl: string | undefined;
  let captureImage: string | undefined;
  let destroyed = false;
  let loadGeneration = 0;
  let translationGeneration = 0;
  let loadAbort: AbortController | undefined;
  let active = 0;
  let queue: string[] = [];

  const abortFromOutside = () => lifecycle.abort();
  if (options.signal) {
    if (options.signal.aborted) lifecycle.abort();
    else options.signal.addEventListener('abort', abortFromOutside, { once: true });
  }

  function setStatus(message: string, error = false): void {
    options.onStatus?.(message, error);
  }

  function back(): void {
    if (options.onBack) {
      options.onBack();
      return;
    }
    if (!view) return;
    if (view.history.length > 1) view.history.back();
    else view.location.assign(view.location.pathname);
  }

  function prefersReducedMotion(): boolean {
    try {
      return view?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false;
    } catch {
      return false;
    }
  }

  function releaseImage(): void {
    if (!imageUrl) return;
    try {
      URL.revokeObjectURL(imageUrl);
    } catch {
      imageUrl = undefined;
    }
    imageUrl = undefined;
  }

  function resolveIdleWaiters(): void {
    const waiters = idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function setState(id: string, next: TranslationView): void {
    translations.set(id, next);
    const block = blockIndex.get(id);
    if (block) updateCard(block);
    updateOverlay(id);
  }

  function showProgress(message: string): void {
    progress.hidden = false;
    panes.hidden = true;
    errorPanel.hidden = true;
    retryAllButton.disabled = true;
    progressText.textContent = message;
    setStatus(message);
  }

  function showFailure(failure: Failure): void {
    progress.hidden = true;
    panes.hidden = true;
    errorPanel.hidden = false;
    retryAllButton.disabled = true;
    const message = tr(failure.key);
    errorMessageEl.textContent = message;
    errorDetailEl.textContent = failure.detail ?? '';
    errorDetailEl.hidden = !failure.detail;
    errorRetry.hidden = !failure.retry;
    errorBack.hidden = false;
    setStatus(message, true);
  }

  function updateOverlay(id: string): void {
    const region = regionViews.get(id);
    const state = translations.get(id);
    if (!region || !state) return;
    region.dataset.state = state.status;
    region.setAttribute('aria-busy', String(state.status === 'loading' || state.status === 'queued'));
  }

  function updateCard(block: TextBlock): void {
    const card = cardViews.get(block.id);
    const state = translations.get(block.id);
    if (!card || !state) return;
    card.root.dataset.state = state.status;
    card.status.textContent = `${formatConfidence(confidences.get(block.id))} · ${tr(translationStatusKey(state.status))}`;
    card.retry.hidden = state.status !== 'error';
    card.retry.setAttribute('aria-label', `${tr('retryBlock')} ${card.number}`);
    card.translation.classList.toggle('is-error', state.status === 'error');
    card.translation.classList.toggle('is-loading', state.status === 'loading' || state.status === 'queued');
    if (state.status === 'done') card.translation.textContent = state.text ?? '';
    else if (state.status === 'error') card.translation.textContent = state.error || tr('failed');
    else if (state.status === 'loading' || state.status === 'queued') card.translation.textContent = tr(translationStatusKey(state.status));
    else card.translation.textContent = tr('emptyTranslation');
  }

  function focusCard(id: string): void {
    const card = cardViews.get(id);
    if (!card) return;
    card.root.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    card.root.focus({ preventScroll: true });
  }

  function buildRegion(block: TextBlock, number: number): HTMLButtonElement {
    const position = blockRectPosition(block, page?.width ?? 1, page?.height ?? 1);
    const region = element('button', 'capture-region');
    region.type = 'button';
    region.dataset.captureBlock = block.id;
    region.dataset.state = 'idle';
    region.style.left = `${position.left}%`;
    region.style.top = `${position.top}%`;
    region.style.width = `${position.width}%`;
    region.style.height = `${position.height}%`;
    region.setAttribute('aria-label', tr('regionLabel', { number, text: block.text.slice(0, 80) }));
    region.title = `${tr('confidenceLabel')}: ${formatConfidence(confidences.get(block.id))}`;
    region.append(
      element('span', 'capture-region__number', String(number)),
      element('span', 'capture-region__confidence', formatConfidence(confidences.get(block.id))),
    );
    region.addEventListener('click', () => focusCard(block.id), listenerOptions);
    return region;
  }

  function buildCard(block: TextBlock, number: number): HTMLLIElement {
    const root = element('li', 'capture-card');
    root.id = `capture-card-${block.id}`;
    root.dataset.captureBlock = block.id;
    root.tabIndex = -1;

    const head = element('div', 'capture-card__head');
    const badge = element('span', 'capture-card__number', String(number));
    const status = element('span', 'capture-card__meta');
    const retry = element('button', 'capture-card__retry', tr('retry'));
    retry.type = 'button';
    retry.hidden = true;
    retry.addEventListener('click', () => retryBlock(block.id), listenerOptions);
    head.append(badge, status, retry);

    const source = element('p', 'capture-card__source', block.text);
    const translation = element('div', 'capture-card__translation');
    translation.setAttribute('role', 'status');
    root.append(head, source, translation);

    cardViews.set(block.id, { root, number, status, translation, retry });
    updateCard(block);
    return root;
  }

  function renderSummary(model: OcrPageModel): void {
    summary.replaceChildren();
    const scores = [...confidences.values()];
    const stats = summarizeConfidence(scores, DEFAULT_CONFIDENCE_THRESHOLD);
    const lowBlocks = filterLowConfidence(model.blocks, confidences, DEFAULT_CONFIDENCE_THRESHOLD);
    const mean = model.ocr.meanConfidence > 0 ? model.ocr.meanConfidence : stats.mean;
    const add = (text: string, warn = false) => {
      const item = element('span', 'capture-summary__item', text);
      if (warn) item.classList.add('capture-summary__item--warn');
      summary.append(item);
    };
    add(tr('summary', { blocks: model.blocks.length, confidence: formatConfidence(mean) }));
    add(tr('sourceLanguage', { language: sourceLanguageLabel(model.ocr.sourceLanguage.code, locale) }));
    if (lowBlocks.length > 0) add(tr('lowConfidence', { count: lowBlocks.length, threshold: stats.threshold }), true);
    else if (model.blocks.length) add(tr('allConfidence', { threshold: stats.threshold }));
    if (model.ocr.droppedWords > 0) add(tr('droppedWords', { count: model.ocr.droppedWords }), true);
  }

  function renderPage(model: OcrPageModel): void {
    blockIndex.clear();
    regionViews.clear();
    cardViews.clear();
    translations.clear();
    const numbered = numberBlocks(model.blocks);
    for (const entry of numbered) {
      blockIndex.set(entry.block.id, entry.block);
      translations.set(entry.block.id, { status: 'idle' });
    }

    renderSummary(model);
    if (imageUrl) image.src = imageUrl;
    else image.removeAttribute('src');
    image.alt = tr('imageAlt');
    if (model.width > 0 && model.height > 0) frame.style.aspectRatio = `${model.width} / ${model.height}`;
    else frame.style.removeProperty('aspect-ratio');

    overlays.replaceChildren();
    for (const entry of numbered) {
      const region = buildRegion(entry.block, entry.number);
      regionViews.set(entry.block.id, region);
      overlays.append(region);
    }

    cards.replaceChildren();
    if (!numbered.length) cards.append(element('li', 'capture-empty', tr('empty')));
    for (const entry of numbered) cards.append(buildCard(entry.block, entry.number));

    progress.hidden = true;
    errorPanel.hidden = true;
    panes.hidden = false;
    retryAllButton.disabled = false;
    if (!numbered.length) {
      setStatus(tr('empty'), true);
      return;
    }
    setStatus(tr('statusOcrDone', { count: model.blocks.length }));
    enqueue(selectTranslationQueue(model.blocks, translations));
    settleStatus();
  }

  function pump(): void {
    if (destroyed) return;
    while (active < 2 && queue.length) {
      const id = queue.shift()!;
      const block = blockIndex.get(id);
      const state = translations.get(id);
      if (!block || !state || state.status !== 'queued') continue;
      setState(id, { status: 'loading' });
      active++;
      const generation = translationGeneration;
      Promise.resolve()
        .then(() => options.translate(block.text, block))
        .then(text => {
          if (destroyed || generation !== translationGeneration) return;
          if (!text || !text.trim()) {
            setState(id, { status: 'error', error: tr('errorEmptyTranslation') });
            return;
          }
          setState(id, { status: 'done', text });
        }, error => {
          if (destroyed || generation !== translationGeneration) return;
          setState(id, { status: 'error', error: errorMessage(error) });
        })
        .finally(() => {
          active = Math.max(0, active - 1);
          if (destroyed) return;
          pump();
          settleStatus();
        });
    }
  }

  function settleStatus(): void {
    if (active > 0 || queue.length > 0) return;
    const states = [...translations.values()];
    if (!states.length) {
      resolveIdleWaiters();
      return;
    }
    const total = states.length;
    const done = states.filter(state => state.status === 'done').length;
    const failed = states.filter(state => state.status === 'error').length;
    if (failed > 0) setStatus(tr('statusTranslationError'), true);
    else if (done === total) setStatus(tr('statusTranslationsDone', { done, total }));
    resolveIdleWaiters();
  }

  function enqueue(blocks: readonly TextBlock[]): void {
    if (destroyed) return;
    for (const block of blocks) {
      const state = translations.get(block.id);
      if (!state) continue;
      if (state.status === 'done' || state.status === 'loading' || state.status === 'queued') continue;
      setState(block.id, { status: 'queued' });
      queue.push(block.id);
    }
    pump();
  }

  function retryBlock(id: string): void {
    if (destroyed) return;
    const block = blockIndex.get(id);
    const state = translations.get(id);
    if (!block || !state || state.status === 'loading' || state.status === 'queued') return;
    setState(id, { status: 'idle' });
    enqueue([block]);
  }

  function retryAll(): void {
    if (destroyed) return;
    if (!page || !page.blocks.length) {
      void load();
      return;
    }
    enqueue(selectTranslationQueue(page.blocks, translations, { includeErrors: true }));
    settleStatus();
  }

  function waitForIdle(): Promise<void> {
    if (active === 0 && queue.length === 0) return Promise.resolve();
    return new Promise(resolve => { idleWaiters.push(resolve); });
  }

  async function load(): Promise<void> {
    if (destroyed || lifecycle.signal.aborted) return;
    const generation = ++loadGeneration;
    translationGeneration++;
    queue = [];
    translations.clear();
    blockIndex.clear();
    regionViews.clear();
    cardViews.clear();
    confidences.clear();
    page = undefined;
    resolveIdleWaiters();
    showProgress(tr('statusCapture'));

    let dataUrl: string;
    try {
      // The extension hands a capture out once, so a retry re-reads the screenshot
      // this reader already received instead of asking the background again.
      dataUrl = captureImage ?? await requestCaptureImage();
    } catch (error) {
      if (generation !== loadGeneration || destroyed || isAbortError(error)) return;
      showFailure(failureFor(error));
      return;
    }
    if (generation !== loadGeneration || destroyed) return;

    let decoded: ReturnType<typeof decodeDataUrl>;
    try {
      decoded = decodeDataUrl(dataUrl);
    } catch (error) {
      captureImage = undefined;
      if (generation !== loadGeneration || destroyed) return;
      showFailure(failureFor(error));
      return;
    }
    captureImage = dataUrl;

    let imageForOcr: Blob | string = dataUrl;
    let nextImageUrl: string | undefined;
    try {
      const blob = new Blob([new Uint8Array(decoded.bytes)], { type: decoded.mimeType });
      imageForOcr = blob;
      nextImageUrl = URL.createObjectURL(blob);
    } catch {
      imageForOcr = dataUrl;
    }
    if (generation !== loadGeneration || destroyed) {
      if (nextImageUrl) URL.revokeObjectURL(nextImageUrl);
      return;
    }

    loadAbort?.abort();
    const controller = new AbortController();
    loadAbort = controller;
    const onLifecycleAbort = () => controller.abort();
    lifecycle.signal.addEventListener('abort', onLifecycleAbort, { once: true });
    if (lifecycle.signal.aborted) controller.abort();

    try {
      const [{ runOcr }, { createTesseractEngine }] = await Promise.all([
        import('../ocr/pipeline'),
        import('../ocr/engine'),
      ]);
      if (generation !== loadGeneration || destroyed || controller.signal.aborted) return;
      const engine: OcrEngine = options.engine ?? createTesseractEngine({ languages });
      const model = await runOcr({
        image: imageForOcr,
        engine,
        languages,
        signal: controller.signal,
        page: 1,
        onProgress: progress => {
          if (generation !== loadGeneration || destroyed || controller.signal.aborted) return;
          const percent = Math.round(Math.max(0, Math.min(1, progress.progress)) * 100);
          const message = tr('statusOcrProgress', { percent });
          progressText.textContent = message;
          setStatus(message);
        },
      });
      if (generation !== loadGeneration || destroyed || controller.signal.aborted) return;
      releaseImage();
      imageUrl = nextImageUrl;
      nextImageUrl = undefined;
      page = model;
      confidences.clear();
      for (const [id, value] of blockConfidences(model.blocks, model.words)) confidences.set(id, value);
      renderPage(model);
    } catch (error) {
      if (generation !== loadGeneration || destroyed || controller.signal.aborted || isAbortError(error)) return;
      showFailure({ key: 'errorOcr', detail: errorMessage(error), retry: true });
    } finally {
      lifecycle.signal.removeEventListener('abort', onLifecycleAbort);
      if (nextImageUrl) URL.revokeObjectURL(nextImageUrl);
      if (loadAbort === controller) loadAbort = undefined;
    }
  }

  function retry(): Promise<void> {
    if (destroyed) return Promise.resolve();
    if (!page || !page.blocks.length) return load();
    enqueue(selectTranslationQueue(page.blocks, translations, { includeErrors: true }));
    settleStatus();
    return waitForIdle();
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    loadGeneration++;
    translationGeneration++;
    queue = [];
    resolveIdleWaiters();
    options.signal?.removeEventListener('abort', abortFromOutside);
    lifecycle.abort();
    releaseImage();
    captureImage = undefined;
    section.remove();
  }

  lifecycle.signal.addEventListener('abort', () => {
    if (destroyed) return;
    loadGeneration++;
    loadAbort?.abort();
    translationGeneration++;
    queue = [];
    for (const [id, state] of translations) {
      if (state.status !== 'queued' && state.status !== 'loading') continue;
      const block = blockIndex.get(id);
      translations.set(id, { status: 'idle' });
      if (block) {
        updateCard(block);
        updateOverlay(id);
      }
    }
    resolveIdleWaiters();
  }, { once: true });

  retryAllButton.addEventListener('click', retryAll, listenerOptions);
  backButton.addEventListener('click', back, listenerOptions);
  errorRetry.addEventListener('click', () => { void load(); }, listenerOptions);
  errorBack.addEventListener('click', back, listenerOptions);

  options.root.replaceChildren(section);

  const handle: CaptureReaderHandle = { destroy, retry };
  if (lifecycle.signal.aborted) {
    progress.hidden = true;
    return handle;
  }
  const search = view?.location.search ?? '';
  if (!isCaptureRequest(search)) {
    showFailure({ key: 'captureUnavailable', retry: false });
    return handle;
  }

  void load().catch(error => {
    if (destroyed) return;
    showFailure(failureFor(error));
  });
  return handle;
}
