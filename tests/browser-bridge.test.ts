import { describe, expect, it } from 'vitest';
import { boundViewState, ViewRelayGuard } from '../src/ui/bridge';

describe('bound viewer navigation', () => {
  const state = { page: 3, fraction: 0.25, zoom: 1.3 };
  it('applies navigation only to its exact extension viewer tab', () => {
    expect(boundViewState({ type: 'mirror:view-state', targetTabId: 90, state }, 90)).toEqual(state);
    expect(boundViewState({ type: 'mirror:view-state', targetTabId: 91, state }, 90)).toBeUndefined();
    expect(boundViewState({ type: 'mirror:view-state', state }, 90)).toBeUndefined();
  });
  it('does not echo programmatic linked scroll even after geometry clamps', () => {
    const guard = new ViewRelayGuard(); expect(guard.canRelay()).toBe(true);
    guard.applyExternal(); expect(guard.canRelay()).toBe(false);
    expect(guard.canRelay()).toBe(false);
    guard.userInput(); expect(guard.canRelay()).toBe(true);
  });
  it('rejects invalid geometry and unexpected message types', () => {
    for (const invalid of [{ ...state, page: 0 }, { ...state, page: 1.5 }, { ...state, fraction: Infinity }, { ...state, fraction: -0.1 }, { ...state, zoom: NaN }]) {
      expect(boundViewState({ type: 'mirror:view-state', targetTabId: 90, state: invalid }, 90)).toBeUndefined();
    }
    expect(boundViewState({ type: 'unrelated', targetTabId: 90, state }, 90)).toBeUndefined();
  });
});
