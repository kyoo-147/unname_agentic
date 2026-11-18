import { describe, expect, it } from 'vitest';
import { keyboardIntent } from '../src/ui/reader';

function press(key: string, extra: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; tagName?: string } = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: extra.ctrlKey ?? false,
    metaKey: extra.metaKey ?? false,
    altKey: extra.altKey ?? false,
    shiftKey: extra.shiftKey ?? false,
    target: extra.tagName ? { tagName: extra.tagName } : null,
  } as unknown as KeyboardEvent;
}

describe('reader keyboard intents', () => {
  it('jumps to the first and last page with Home and End', () => {
    expect(keyboardIntent(press('Home'))).toBe('first-page');
    expect(keyboardIntent(press('End'))).toBe('last-page');
  });

  it('keeps the documented navigation, zoom and panel keys', () => {
    expect(keyboardIntent(press('j'))).toBe('next-page');
    expect(keyboardIntent(press('J'))).toBe('next-page');
    expect(keyboardIntent(press('k'))).toBe('prev-page');
    expect(keyboardIntent(press('ArrowDown'))).toBe('next-page');
    expect(keyboardIntent(press('PageUp'))).toBe('prev-page');
    expect(keyboardIntent(press('+'))).toBe('zoom-in');
    expect(keyboardIntent(press('='))).toBe('zoom-in');
    expect(keyboardIntent(press('-'))).toBe('zoom-out');
    expect(keyboardIntent(press('w'))).toBe('fit-width');
    expect(keyboardIntent(press('f'))).toBe('fit-page');
    expect(keyboardIntent(press('o'))).toBe('outline');
    expect(keyboardIntent(press('/'))).toBe('search');
    expect(keyboardIntent(press('Escape'))).toBe('escape');
  });

  it('leaves Home and End to the browser when a modifier is held', () => {
    expect(keyboardIntent(press('Home', { ctrlKey: true }))).toBe('none');
    expect(keyboardIntent(press('End', { metaKey: true }))).toBe('none');
    expect(keyboardIntent(press('End', { altKey: true }))).toBe('none');
  });

  it('never hijacks a key typed into a form field', () => {
    expect(keyboardIntent(press('End', { tagName: 'INPUT' }))).toBe('none');
    expect(keyboardIntent(press('Home', { tagName: 'TEXTAREA' }))).toBe('none');
    expect(keyboardIntent(press('j', { tagName: 'INPUT' }))).toBe('none');
  });
});
