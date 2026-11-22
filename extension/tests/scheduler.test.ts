import { describe, expect, it } from 'vitest';
import { ViewportScheduler } from '../viewer/src/core/scheduler';

describe('viewport scheduling', () => {
  it('prioritizes selection before visible and prefetch blocks', async () => {
    const seen: string[] = [];
    const queue = new ViewportScheduler<string>(1);
    queue.pause();
    const prefetch = queue.enqueue('next', 20, async () => { seen.push('next'); return 'next'; });
    const visible = queue.enqueue('visible', 10, async () => { seen.push('visible'); return 'visible'; });
    const selection = queue.enqueue('selection', 0, async () => { seen.push('selection'); return 'selection'; });
    queue.resume();
    await Promise.all([prefetch, visible, selection]);
    expect(seen).toEqual(['selection', 'visible', 'next']);
  });

  it('deduplicates a queued block and upgrades its priority', async () => {
    const queue = new ViewportScheduler<number>(1);
    queue.pause();
    let calls = 0;
    const first = queue.enqueue('a', 20, async () => ++calls);
    const second = queue.enqueue('a', 0, async () => ++calls);
    queue.resume();
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(calls).toBe(1);
  });

  it('aborts one queued handle without starting it or cancelling its sibling', async () => {
    const queue = new ViewportScheduler<string>(1);
    queue.pause();
    const seen: string[] = [];
    const cancelled = queue.enqueue('cancelled', 0, async () => { seen.push('cancelled'); return 'cancelled'; });
    const sibling = queue.enqueue('sibling', 1, async () => { seen.push('sibling'); return 'sibling'; });
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    cancelled.abort();
    queue.resume();
    await rejected;
    await expect(sibling).resolves.toBe('sibling');
    expect(seen).toEqual(['sibling']);
  });

  it('aborts a running handle and signals only that job', async () => {
    const queue = new ViewportScheduler<string>(2);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const bothStarted = new Promise<void>(resolve => { started = resolve; });
    const signals = new Map<string, AbortSignal>();
    const run = (key: string) => (signal: AbortSignal) => new Promise<string>((resolve, reject) => {
      signals.set(key, signal);
      if (signals.size === 2) started();
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      void gate.then(() => resolve(key));
    });
    const cancelled = queue.enqueue('cancelled', 0, run('cancelled'));
    const sibling = queue.enqueue('sibling', 1, run('sibling'));
    await bothStarted;
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    cancelled.abort();
    expect(signals.get('cancelled')?.aborted).toBe(true);
    expect(signals.get('sibling')?.aborted).toBe(false);
    release();
    await rejected;
    await expect(sibling).resolves.toBe('sibling');
  });

  it('invalidates old queued work when document changes', async () => {
    const queue = new ViewportScheduler<number>(1);
    queue.pause();
    const first = queue.enqueue('old', 1, async () => 1);
    const assertion = expect(first).rejects.toThrow(/superseded/i);
    queue.reset();
    queue.resume();
    await assertion;
    expect(await queue.enqueue('new', 1, async () => 2)).toBe(2);
  });
});
