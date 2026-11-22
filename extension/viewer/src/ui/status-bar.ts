/**
 * Status strip view model and renderer.
 *
 * The model is pure data: it normalises what the workspace reports (page, provider,
 * job progress, message) and hands back a snapshot. `renderStatus` then builds plain
 * DOM from that snapshot, so both halves can be tested without a browser.
 */

import { t } from '../i18n';
import type { TranslationKey } from '../i18n';

/** What the reader is doing. `idle` means "no mode to show". */
export type StatusMode = 'idle' | 'visible' | 'full' | 'paused';
export type StatusJobState = 'queued' | 'running' | 'done' | 'failed';
export type StatusMessageKind = 'info' | 'warning' | 'error';

export interface StatusJob {
  state: StatusJobState;
  /** Whole percent, clamped to 0–100. A finished job clears `eta`. */
  progress: number;
  /** Caller-formatted estimate, e.g. "~2 min". `null` means "no estimate". */
  eta: string | null;
}

export interface StatusMessage {
  kind: StatusMessageKind;
  text: string;
}

export interface StatusSnapshot {
  mode: StatusMode;
  /** Display text for the provider; never empty (see {@link UNKNOWN_PROVIDER}). */
  provider: string;
  page: number;
  pageCount: number;
  job: StatusJob | null;
  message: StatusMessage | null;
  /** Derived: a job is in flight. Never settable directly. */
  busy: boolean;
}

/**
 * Every field is optional. A missing field keeps its current value; `job: null` and
 * `message: null` clear that slot. `message` is not a transient notice: once set it
 * stays until it is replaced or cleared, because the strip is the only place the
 * reader can still see why something failed.
 */
export interface StatusUpdate {
  mode?: StatusMode;
  provider?: string;
  page?: number;
  pageCount?: number;
  job?: StatusJob | null;
  message?: StatusMessage | null;
}

export interface StatusModel {
  update(partial: StatusUpdate): void;
  snapshot(): StatusSnapshot;
}

export const UNKNOWN_PROVIDER = '—';

/**
 * Class names are fixed; the strip carries no inline style or colour. The `reader-`
 * prefix keeps it clear of the app-wide `.status-bar` in src/style.css, which is a
 * fixed-position bar pinned to the bottom of the window.
 */
const CLASS = {
  root: 'reader-status-bar',
  page: 'reader-status-bar__page',
  mode: 'reader-status-bar__mode',
  provider: 'reader-status-bar__provider',
  label: 'reader-status-bar__label',
  value: 'reader-status-bar__value',
  job: 'reader-status-bar__job',
  progress: 'reader-status-bar__progress',
  eta: 'reader-status-bar__eta',
  message: 'reader-status-bar__message',
} as const;

const MODE_KEY: Record<Exclude<StatusMode, 'idle'>, TranslationKey> = {
  visible: 'modeVisible',
  full: 'modeFull',
  paused: 'modePaused',
};

const MODES: readonly StatusMode[] = ['idle', 'visible', 'full', 'paused'];
const JOB_STATES: readonly StatusJobState[] = ['queued', 'running', 'done', 'failed'];

/**
 * Minimal element surface `renderStatus` needs. The browser's `HTMLElement` satisfies
 * it, and so does a recording fake, which is what keeps the tests DOM-free.
 */
export interface StatusElement {
  className: string;
  textContent: string | null;
  setAttribute(name: string, value: string): void;
  append(...nodes: unknown[]): void;
}

export interface StatusDocument {
  createElement(tagName: string): StatusElement;
}

/** A model or an already-taken snapshot; the renderer accepts either. */
export type StatusSource = StatusModel | StatusSnapshot;

function has(object: object, key: string): boolean {
  return Object.hasOwn(object, key);
}

function isMode(value: unknown): value is StatusMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

function isJobState(value: unknown): value is StatusJobState {
  return typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value);
}

/** Display text for the provider: trimmed, and never empty. */
function readProvider(value: unknown): string {
  if (typeof value !== 'string') return UNKNOWN_PROVIDER;
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > 0 ? text : UNKNOWN_PROVIDER;
}

function readCount(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.trunc(value);
}

function readProgress(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.round(Math.min(100, Math.max(0, number)));
}

function readEta(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

/** `undefined` means "the caller did not touch the job"; `null` means "cleared". */
function readJob(value: unknown): StatusJob | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const record = value as { state?: unknown; progress?: unknown; eta?: unknown };
  const progress = readProgress(record.progress);
  const state = isJobState(record.state) ? record.state : 'queued';
  // A job that reached 100 percent has no time left, and neither has one that ended.
  const eta = progress >= 100 || state === 'done' || state === 'failed' ? null : readEta(record.eta);
  return { state, progress, eta };
}

/** An empty message is no message; a message the caller never sent keeps the current one. */
function readMessage(value: unknown): StatusMessage | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'object') return undefined;
  const record = value as { kind?: unknown; text?: unknown };
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!text) return null;
  const kind = record.kind === 'warning' || record.kind === 'error' ? record.kind : 'info';
  return { kind, text };
}

function busyOf(job: StatusJob | null): boolean {
  // A job that reached 100 percent is not busy, even if its state has not caught up.
  return job !== null && (job.state === 'queued' || job.state === 'running') && job.progress < 100;
}

/**
 * Creates the status model. `initial` goes through the same rules as `update`, so a
 * snapshot is always normalised.
 */
export function createStatusModel(initial: StatusUpdate = {}): StatusModel {
  let state: StatusSnapshot = {
    mode: 'idle',
    provider: UNKNOWN_PROVIDER,
    page: 0,
    pageCount: 0,
    job: null,
    message: null,
    busy: false,
  };

  function apply(partial: StatusUpdate | null | undefined): void {
    if (!partial || typeof partial !== 'object') return;
    if (isMode(partial.mode)) state.mode = partial.mode;
    if (partial.provider !== undefined) state.provider = readProvider(partial.provider);
    if (partial.page !== undefined) state.page = readCount(partial.page, state.page);
    if (partial.pageCount !== undefined) state.pageCount = readCount(partial.pageCount, state.pageCount);

    if (has(partial, 'job')) {
      const job = readJob(partial.job);
      if (job !== undefined) state.job = job;
    }
    if (has(partial, 'message')) {
      const message = readMessage(partial.message);
      if (message !== undefined) state.message = message;
    }

    state.pageCount = Math.max(0, state.pageCount);
    state.page = state.pageCount > 0
      ? Math.min(state.pageCount, Math.max(1, state.page))
      : Math.max(0, state.page);
    state.busy = busyOf(state.job);
  }

  apply(initial);

  return {
    update: apply,
    snapshot(): StatusSnapshot {
      return {
        mode: state.mode,
        provider: state.provider,
        page: state.page,
        pageCount: state.pageCount,
        job: state.job ? { ...state.job } : null,
        message: state.message ? { ...state.message } : null,
        busy: state.busy,
      };
    },
  };
}

function readSnapshot(source: StatusSource): StatusSnapshot {
  return typeof (source as StatusModel).snapshot === 'function'
    ? (source as StatusModel).snapshot()
    : (source as StatusSnapshot);
}

function resolveDocument(documentLike?: StatusDocument): StatusDocument {
  if (documentLike) return documentLike;
  const globalDocument = (globalThis as { document?: StatusDocument }).document;
  if (!globalDocument) throw new Error('renderStatus needs a document');
  return globalDocument;
}

function span(documentLike: StatusDocument, className: string): StatusElement {
  const element = documentLike.createElement('span');
  element.className = className;
  return element;
}

function pageText(status: StatusSnapshot): string {
  return status.pageCount > 0
    ? t('pageStatus', { page: status.page, total: status.pageCount })
    : t('pageInitial');
}

function modeNode(documentLike: StatusDocument, mode: Exclude<StatusMode, 'idle'>): StatusElement {
  const key = MODE_KEY[mode];
  const element = span(documentLike, CLASS.mode);
  element.setAttribute('data-i18n', key);
  element.textContent = t(key);
  return element;
}

function providerNode(documentLike: StatusDocument, status: StatusSnapshot): StatusElement {
  const element = span(documentLike, CLASS.provider);
  const label = span(documentLike, CLASS.label);
  label.setAttribute('data-i18n', 'providerLabel');
  label.textContent = t('providerLabel');
  const value = span(documentLike, CLASS.value);
  value.textContent = status.provider;
  if (status.provider === UNKNOWN_PROVIDER) value.setAttribute('data-unknown', 'true');
  element.append(label, value);
  return element;
}

function jobNode(documentLike: StatusDocument, job: StatusJob): StatusElement {
  const element = span(documentLike, CLASS.job);
  element.setAttribute('role', 'progressbar');
  element.setAttribute('aria-valuemin', '0');
  element.setAttribute('aria-valuemax', '100');
  element.setAttribute('aria-valuenow', String(job.progress));
  // No aria-label: src/i18n.ts has no key for a job label, and an English literal here
  // would bypass the translation layer. The value is still exposed as aria-valuenow.
  const progress = span(documentLike, CLASS.progress);
  progress.textContent = `${job.progress}%`;
  element.append(progress);
  if (job.eta) {
    const eta = span(documentLike, CLASS.eta);
    eta.textContent = job.eta;
    element.append(eta);
  }
  return element;
}

function messageNode(documentLike: StatusDocument, message: StatusMessage): StatusElement {
  const element = span(documentLike, `${CLASS.message} ${CLASS.message}--${message.kind}`);
  // The message is the only live region in the strip: the rest changes too often.
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.setAttribute('data-kind', message.kind);
  element.textContent = message.text;
  return element;
}

/**
 * Builds the strip as fresh DOM: page, mode (when there is one), provider, job and the
 * live message. No inline styles, no colours, no listeners; the caller owns mounting
 * and re-rendering. `document` falls back to the global document, and throwing is
 * better than returning a detached tree that silently never appears.
 */
export function renderStatus(source: StatusSource, document: Document): HTMLElement;
export function renderStatus(source: StatusSource, documentLike?: StatusDocument): StatusElement;
export function renderStatus(source: StatusSource, documentLike?: StatusDocument): StatusElement {
  const status = readSnapshot(source);
  const document = resolveDocument(documentLike);
  const root = document.createElement('div');
  root.className = CLASS.root;
  root.setAttribute('data-busy', String(status.busy));

  const page = span(document, CLASS.page);
  page.textContent = pageText(status);
  root.append(page);

  if (status.mode !== 'idle') root.append(modeNode(document, status.mode));
  root.append(providerNode(document, status));
  if (status.job) root.append(jobNode(document, status.job));
  if (status.message) root.append(messageNode(document, status.message));
  return root;
}
