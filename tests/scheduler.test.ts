import { describe, expect, it } from 'vitest';
import { ViewportScheduler } from '../src/core/scheduler';

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
