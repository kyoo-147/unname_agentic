import { describe, expect, it, vi } from 'vitest';
import { ViewportScheduler } from '../src/core/scheduler';
import { createTranslationTransport, TranslationService, type BatchTranslationResult } from '../src/core/translation';
import { TranslationError } from '../src/core/retry';
import { defaultSettings, type TextBlock, type TranslationRequest, type TranslationSettings, type TranslationTransport } from '../src/core/types';

const settings: TranslationSettings = { ...defaultSettings, model: 'test-model', targetLanguage: 'vi' };

const block = (id: string, text: string, page = 1): TextBlock => ({
  id,
  page,
  text,
  rect: { x: 0, y: 0, width: 100, height: 20 },
  fontSize: 12,
  fontFamily: 'serif',
  color: '#000000',
  direction: 'ltr',
  rotation: 0,
});

const okResponse = (content: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

/** Lets queued microtasks and timers of the scheduler and service settle. */
async function flush(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

const aborted = { name: 'AbortError' } as const;

describe('scheduler job cancellation', () => {
  it('never starts a queued translation whose job was aborted', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => okResponse('Xin chào'));
    const service = new TranslationService(createTranslationTransport(fetcher));
    const queue = new ViewportScheduler<string>(1);
    queue.pause();

    const job = queue.enqueue('block-1', 10, signal => service.translate({ text: 'Hello', settings, signal }).then(result => result.text));
    const rejected = expect(job).rejects.toMatchObject(aborted);
    job.abort();
    queue.resume();
    await rejected;
    await flush();

    const requests = fetcher.mock.calls.length;
    console.info(`abort-before-start: requests=${requests}`);
    expect(requests).toBe(0);
    expect(service.characterCount).toBe(0);
    expect(queue.pending).toBe(0);
  });

  it('stops an in-flight translation, rejects with AbortError, and commits nothing', async () => {
    const pending = deferred<Response>();
    let firstCall = true;
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      if (!firstCall) return okResponse('Xin chào');
      firstCall = false;
      return pending.promise;
    });
    const service = new TranslationService(createTranslationTransport(fetcher));
    const queue = new ViewportScheduler<string>(1);

    const job = queue.enqueue('block-1', 10, signal => service.translate({ text: 'Hello', settings, signal }).then(result => result.text));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    const rejected = expect(job).rejects.toMatchObject(aborted);
    job.abort();
    await rejected;

    // The transport cannot see the abort (a fake fetch, like the extension
    // bridge), so it answers late. That answer must be dropped, not retried.
    pending.resolve(okResponse('Stale answer'));
    await flush();
    const afterAbort = fetcher.mock.calls.length;
    console.info(`abort-after-start: requests=${afterAbort} charactersCommitted=${service.characterCount}`);
    expect(afterAbort).toBe(1);
    expect(service.characterCount).toBe(0);

    // Nothing was cached by the cancelled job: the same text goes out again.
    const fresh = await service.translate({ text: 'Hello', settings });
    expect(fresh.cached).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(service.characterCount).toBe(5);
  });

  it('keeps priority ordering while a sibling job is aborted', async () => {
    const queue = new ViewportScheduler<string>(1);
    queue.pause();
    const seen: string[] = [];

    const prefetch = queue.enqueue('prefetch', 20, async () => { seen.push('prefetch'); return 'prefetch'; });
    const selection = queue.enqueue('selection', 0, async () => { seen.push('selection'); return 'selection'; });
    const rejected = expect(prefetch).rejects.toMatchObject(aborted);
    prefetch.abort();
    queue.resume();
    await rejected;

    await expect(selection).resolves.toBe('selection');
    console.info(`priority: ran=${seen.join(',')}`);
    expect(seen).toEqual(['selection']);
    expect(queue.pending).toBe(0);
  });

  it('deduplicates a key onto one handle so abort cancels every waiter', async () => {
    const queue = new ViewportScheduler<number>(1);
    queue.pause();
    let calls = 0;

    const first = queue.enqueue('same', 20, async () => ++calls);
    const second = queue.enqueue('same', 0, async () => ++calls);
    expect(second).toBe(first);
    expect(second.signal).toBe(first.signal);

    const rejected = Promise.all([expect(first).rejects.toMatchObject(aborted), expect(second).rejects.toMatchObject(aborted)]);
    first.abort();
    queue.resume();
    await rejected;

    expect(calls).toBe(0);
    expect(queue.pending).toBe(0);
  });

  it('abortAll clears the queue and rejects every job', async () => {
    const queue = new ViewportScheduler<string>(2);
    queue.pause();
    const jobs = ['a', 'b', 'c'].map(key => queue.enqueue(key, 0, async () => key));
    const rejected = Promise.all(jobs.map(job => expect(job).rejects.toMatchObject(aborted)));
    expect(queue.pending).toBe(3);

    queue.abortAll();
    const pendingAfter = queue.pending;
    console.info(`abortAll: queuedBefore=3 pendingAfter=${pendingAfter}`);
    expect(pendingAfter).toBe(0);
    await rejected;

    queue.resume();
    await expect(queue.enqueue('d', 0, async () => 'd')).resolves.toBe('d');
  });

  it('abortAll fires the signal of an in-flight job and frees its slot when it stops', async () => {
    const queue = new ViewportScheduler<string>(1);
    const signals: AbortSignal[] = [];
    const running = queue.enqueue('running', 0, signal => new Promise<string>((_resolve, reject) => {
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new Error('stopped by abort')), { once: true });
    }));
    await flush();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);

    const rejected = expect(running).rejects.toMatchObject(aborted);
    queue.abortAll();
    expect(signals[0]?.aborted).toBe(true);
    await rejected;
    await flush();

    expect(queue.pending).toBe(0);
    await expect(queue.enqueue('next', 0, async () => 'next')).resolves.toBe('next');
  });
});

describe('translation cancellation', () => {
  it('does not reach the provider or the cache for an already aborted translation', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => okResponse('Xin chào'));
    const service = new TranslationService(createTranslationTransport(fetcher));
    const controller = new AbortController();
    controller.abort();

    await expect(service.translate({ text: 'Hello', settings, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
    const requests = fetcher.mock.calls.length;
    console.info(`pre-aborted-translation: requests=${requests}`);
    expect(requests).toBe(0);

    const fresh = await service.translate({ text: 'Hello', settings });
    expect(fresh.cached).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('raises AbortError through the transport for an in-flight abort', async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => pending.promise);
    const transport = createTranslationTransport(fetcher);
    const controller = new AbortController();

    const translation = transport.translate({ text: 'Hello', settings, signal: controller.signal });
    const rejected = expect(translation).rejects.toMatchObject({ kind: 'aborted' });
    await flush(2);
    controller.abort();
    pending.resolve(okResponse('Stale answer'));
    await rejected;

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not commit a batch answer that arrives after the abort', async () => {
    const controller = new AbortController();
    let passes = 0;
    const transport = {
      async translate(_request: TranslationRequest) { return 'unused'; },
      async translateBatch(blocks: readonly TextBlock[]): Promise<BatchTranslationResult> {
        passes += 1;
        controller.abort();
        return {
          translations: blocks.map(entry => ({ id: entry.id, page: entry.page, text: `vi:${entry.text}`, characterCount: 3 })),
          requests: 1,
          characterCount: blocks.length * 3,
          aborted: false,
        };
      },
    };
    const service = new TranslationService(transport);
    const blocks = [block('b1', 'One'), block('b2', 'Two')];

    const result = await service.translateBatch(blocks, settings, controller.signal);

    console.info(`aborted-batch: requests=${result.requests} translations=${result.translations.length} charactersCommitted=${service.characterCount}`);
    expect(result.aborted).toBe(true);
    expect(result.translations).toEqual([]);
    expect(result.requests).toBe(1);
    expect(service.characterCount).toBe(0);

    // The aborted pass wrote nothing, so a second pass must ask again.
    const retried = await service.translateBatch(blocks, settings);
    expect(passes).toBe(2);
    expect(retried.translations.map(entry => entry.id)).toEqual(['b1', 'b2']);
  });

  it('stops the per-block fallback on abort and keeps only finished blocks', async () => {
    const controller = new AbortController();
    let requests = 0;
    const transport: TranslationTransport = {
      async translate({ text }: TranslationRequest) {
        requests += 1;
        if (requests === 2) {
          controller.abort();
          throw new TranslationError('aborted');
        }
        return `vi:${text}`;
      },
    };
    const service = new TranslationService(transport);

    const result = await service.translateBatch([block('b1', 'One'), block('b2', 'Two'), block('b3', 'Three')], settings, controller.signal);

    console.info(`fallback-abort: requests=${requests} aborted=${result.aborted}`);
    expect(requests).toBe(2);
    expect(result.aborted).toBe(true);
    expect(result.translations.map(entry => entry.id)).toEqual(['b1']);
    expect(result.characterCount).toBe(3);
    expect(service.characterCount).toBe(3);
  });
});
