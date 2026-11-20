import { describe, expect, it } from 'vitest';
import {
  createGuard,
  NetworkBlockedError,
  wrapTransport,
  type FetchLike,
} from '../src/core/network-guard';

const LOOPBACK = 'http://127.0.0.1:11434/v1/chat/completions';
const LOOPBACK_NAMED = 'http://localhost:8080/v1/chat/completions';
const LOOPBACK_IPV6 = 'http://[::1]:1234/v1/chat/completions';
const OTHER_PORT = 'http://127.0.0.1:11435/v1/chat/completions';
const LAN = 'http://192.168.1.10:11434/v1/chat/completions';
const REMOTE = 'https://api.example.invalid/v1/chat/completions';

function inputUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * A stand-in for the provider the guard delegates to. It records the URLs that
 * actually reached it, which is how a test proves a refusal never became a
 * request.
 */
function recorder(response: Response = new Response('{"ok":true}', { status: 200 })) {
  const sent: string[] = [];
  const fetch: FetchLike = async input => {
    sent.push(inputUrl(input));
    return response;
  };
  return { fetch, sent, response };
}

/** A deterministic clock so `at` assertions do not depend on wall time. */
function clock(start = 1_700_000_000_000): () => number {
  let value = start;
  return () => value++;
}

function errorOf(work: () => void): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('the call was expected to throw');
}

async function rejectionOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('the call was expected to reject');
}

describe('createGuard', () => {
  it('records a blocked attempt and throws with the refused url', async () => {
    const provider = recorder();
    const guard = createGuard({ fetch: provider.fetch, now: clock(500) });

    const error = await rejectionOf(() => guard.fetch(REMOTE, { method: 'POST' }));

    expect(error).toBeInstanceOf(NetworkBlockedError);
    expect((error as NetworkBlockedError).url).toBe(REMOTE);
    expect((error as Error).message).toContain(REMOTE);
    expect(provider.sent).toEqual([]);
    expect(guard.calls).toEqual([{ url: REMOTE, method: 'POST', at: 500, allowed: false }]);
  });

  it('defaults to refusing everything and reads the method from the request', async () => {
    const chain = recorder();
    const guard = createGuard({ fetch: chain.fetch });

    await rejectionOf(() => guard.fetch(REMOTE));
    await rejectionOf(() => guard.fetch(new Request(REMOTE, { method: 'put' })));
    await rejectionOf(() => guard.fetch(new URL(REMOTE)));

    expect(chain.sent).toEqual([]);
    expect(guard.calls.map(call => call.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(guard.policy).toEqual({ kind: 'none' });
  });

  it('records an allowed loopback call and resolves with the delegate response', async () => {
    const provider = recorder();
    const guard = createGuard({ policy: 'loopback', fetch: provider.fetch, now: clock(7) });

    const response = await guard.fetch(LOOPBACK, { method: 'POST', body: '{}' });

    expect(response).toBe(provider.response);
    expect(provider.sent).toEqual([LOOPBACK]);
    expect(guard.calls).toEqual([{ url: LOOPBACK, method: 'POST', at: 7, allowed: true }]);
  });

  it('treats every loopback spelling as local and every other host as remote', async () => {
    const provider = recorder();
    const guard = createGuard({ policy: 'loopback', fetch: provider.fetch });

    expect(await guard.fetch(LOOPBACK_NAMED)).toBe(provider.response);
    expect(await guard.fetch(LOOPBACK_IPV6)).toBe(provider.response);
    expect(await guard.fetch('http://127.5.5.5:9000/v1')).toBe(provider.response);
    await expect(guard.fetch(LAN)).rejects.toBeInstanceOf(NetworkBlockedError);

    expect(provider.sent).toEqual([LOOPBACK_NAMED, LOOPBACK_IPV6, 'http://127.5.5.5:9000/v1']);
    expect(guard.calls.map(call => call.allowed)).toEqual([true, true, true, false]);
  });

  it('lets an allow-listed origin through and refuses another origin', async () => {
    const provider = recorder();
    const guard = createGuard({ fetch: provider.fetch });
    guard.allow(['http://127.0.0.1:11434']);
    expect(guard.policy).toEqual({ kind: 'origins', origins: ['http://127.0.0.1:11434'] });

    expect(await guard.fetch(LOOPBACK)).toBe(provider.response);
    await expect(guard.fetch(OTHER_PORT)).rejects.toBeInstanceOf(NetworkBlockedError);
    await expect(guard.fetch(REMOTE)).rejects.toBeInstanceOf(NetworkBlockedError);

    expect(provider.sent).toEqual([LOOPBACK]);
    expect(guard.calls.map(call => call.allowed)).toEqual([true, false, false]);
  });

  it('keeps only the origin of an allow-list entry', async () => {
    const provider = recorder();
    const guard = createGuard({ fetch: provider.fetch });
    guard.allow([LOOPBACK, 'https://api.example.invalid/some/path']);

    expect(await guard.fetch(LOOPBACK)).toBe(provider.response);
    expect(await guard.fetch(REMOTE)).toBe(provider.response);
    expect(guard.policy).toEqual({
      kind: 'origins',
      origins: ['http://127.0.0.1:11434', 'https://api.example.invalid'],
    });
  });

  it('refuses to install an origin list with an entry that has no origin', () => {
    const guard = createGuard({ policy: 'loopback' });

    expect(() => guard.allow(['not a url'])).toThrow(TypeError);
    // A rejected list leaves the previous policy in force, so a typo can never
    // widen what the guard lets through.
    expect(guard.policy).toEqual({ kind: 'loopback' });
  });

  it('assertNoCalls passes after a blocked attempt and fails after an allowed one', async () => {
    const guard = createGuard({ policy: 'loopback', fetch: recorder().fetch });

    await rejectionOf(() => guard.fetch(REMOTE));
    expect(() => guard.assertNoCalls()).not.toThrow();

    await guard.fetch(LOOPBACK);
    const error = errorOf(() => guard.assertNoCalls());
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(LOOPBACK);
    expect(guard.calls).toHaveLength(2);
  });

  it('reset clears the log and leaves the policy in force', async () => {
    const guard = createGuard({ policy: 'loopback', fetch: recorder().fetch });
    await guard.fetch(LOOPBACK);
    await rejectionOf(() => guard.fetch(REMOTE));
    expect(guard.calls).toHaveLength(2);

    guard.reset();

    expect(guard.calls).toEqual([]);
    expect(() => guard.assertNoCalls()).not.toThrow();
    expect(() => guard.assertOnlyLoopback()).not.toThrow();
    // The policy survived, so the next loopback call is still allowed.
    await guard.fetch(LOOPBACK);
    expect(guard.calls).toHaveLength(1);
  });

  it('assertOnlyLoopback rejects a remote call even when it was allow-listed', async () => {
    const provider = recorder();
    const guard = createGuard({ fetch: provider.fetch });
    guard.allow([REMOTE]);

    expect(await guard.fetch(REMOTE)).toBe(provider.response);
    // This call did leave the machine, so both helpers report it.
    expect(() => guard.assertNoCalls()).toThrow(REMOTE);
    const error = errorOf(() => guard.assertOnlyLoopback());
    expect((error as Error).message).toContain(REMOTE);
  });

  it('assertOnlyLoopback rejects a remote attempt even when it was refused', async () => {
    const guard = createGuard({ policy: 'loopback', fetch: recorder().fetch });

    await guard.fetch(LOOPBACK);
    expect(() => guard.assertOnlyLoopback()).not.toThrow();

    await rejectionOf(() => guard.fetch(REMOTE));
    const error = errorOf(() => guard.assertOnlyLoopback());
    expect((error as Error).message).toContain(REMOTE);
  });
});

describe('wrapTransport', () => {
  it('wraps a transport so the guard refuses before any provider request', async () => {
    const provider = recorder();
    const guard = createGuard({ policy: 'loopback', fetch: provider.fetch, now: clock(11) });
    let translated = 0;
    const transport = wrapTransport(guard, {
      fetcher: provider.fetch,
      translate: async (): Promise<string> => {
        translated++;
        return 'ok';
      },
    });

    // The copy carries the guard, not the unguarded fetcher it came with.
    expect(transport.fetcher).toBe(guard.fetch);
    expect(transport.translate).toBeTypeOf('function');

    const error = await rejectionOf(() => transport.fetcher(REMOTE, { method: 'POST' }));

    expect(error).toBeInstanceOf(NetworkBlockedError);
    expect((error as NetworkBlockedError).url).toBe(REMOTE);
    expect(provider.sent).toEqual([]);
    expect(translated).toBe(0);
    expect(guard.calls).toEqual([{ url: REMOTE, method: 'POST', at: 11, allowed: false }]);
  });

  it('passes an allowed call through the wrapped transport untouched', async () => {
    const provider = recorder();
    const guard = createGuard({ policy: 'loopback', fetch: provider.fetch });
    const transport = wrapTransport(guard, { fetcher: provider.fetch });

    const response = await transport.fetcher(LOOPBACK);

    expect(response).toBe(provider.response);
    expect(provider.sent).toEqual([LOOPBACK]);
    expect(guard.calls).toEqual([{ url: LOOPBACK, method: 'GET', at: expect.any(Number), allowed: true }]);
  });

  it('never changes the response object of an allowed call', async () => {
    const response = new Response('body', { status: 201, statusText: 'Created' });
    const guard = createGuard({ policy: 'loopback', fetch: async () => response });

    const result = await guard.fetch(LOOPBACK);

    expect(result).toBe(response);
    expect(result.status).toBe(201);
    expect(result.statusText).toBe('Created');
  });
});
