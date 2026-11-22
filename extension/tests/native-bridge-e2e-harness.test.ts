import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withCleanProfileBridge, type CleanProfileBridgeAdapter } from './e2e/clean-profile-bridge-harness';

describe('clean-profile native bridge E2E seam', () => {
  it('passes only dist/extension and an isolated external profile to the adapter', async () => {
    const launch = vi.fn(async () => ({ close: vi.fn(async () => {}) }));
    const adapter: CleanProfileBridgeAdapter = { launch };
    await expect(withCleanProfileBridge({
      adapter,
      repositoryRoot: 'D:/repo',
      profilePath: 'D:/tmp/mirror-clean-profile',
      scenario: async () => 'contract-ready',
    })).resolves.toBe('contract-ready');
    expect(launch).toHaveBeenCalledWith({ extensionPath: path.join('D:/repo', 'dist', 'extension'), profilePath: path.resolve('D:/tmp/mirror-clean-profile'), isolated: true });
  });

  it('closes the profile after scenario failure and refuses a profile inside the repository', async () => {
    const close = vi.fn(async () => {});
    const launch = vi.fn(async () => ({ close }));
    const adapter: CleanProfileBridgeAdapter = { launch };
    await expect(withCleanProfileBridge({
      adapter,
      repositoryRoot: 'D:/repo',
      profilePath: 'D:/tmp/mirror-clean-profile',
      scenario: async () => { throw new Error('scenario failure'); },
    })).rejects.toThrow('scenario failure');
    expect(close).toHaveBeenCalledOnce();
    await expect(withCleanProfileBridge({
      adapter,
      repositoryRoot: 'D:/repo',
      profilePath: 'D:/repo/.profile',
      scenario: async () => undefined,
    })).rejects.toThrow(/outside the repository/);
    expect(launch).toHaveBeenCalledOnce();
  });
});
