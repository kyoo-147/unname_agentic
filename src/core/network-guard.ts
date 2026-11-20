import { classifyEndpoint } from './privacy';
import { TranslationError } from './retry';

/**
 * A network guard that can prove nothing left the machine.
 *
 * The guard is a drop-in `fetch` that records every attempt and refuses the
 * ones the current policy forbids. Tests use it as the transport's fetcher and
 * assert on the log afterwards; a runtime offline session uses it so the same
 * code path that a test exercises is the one that runs in the app:
 *
 * ```ts
 * // A privacy test: the guard refuses, and the log proves the attempt.
 * const guard = createGuard({ policy: 'loopback' });
 * const transport = createTranslationTransport(guard.fetch, {}, { privacyMode: 'offline' });
 * await expect(transport.translate(request)).rejects.toBeTruthy();
 * guard.assertNoCalls();          // nothing was allowed through
 * guard.assertOnlyLoopback();     // and nothing remote was even attempted
 *
 * // A runtime offline session: same guard, real global fetch behind it.
 * const offline = createGuard({ policy: 'loopback' });
 * ```
 *
 * A refused attempt is recorded *and* throws {@link NetworkBlockedError}: the
 * log is the evidence, the error is what the caller sees.
 */

/** Any function shaped like the global `fetch`. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * A request a {@link NetworkBlockedError} refused. It is a
 * {@link TranslationError} of kind `invalid` and is never retried, because a
 * policy decision does not change between two attempts — it changes when the
 * caller changes the policy.
 */
export class NetworkBlockedError extends TranslationError {
  /** The URL that was refused, exactly as the caller passed it in. */
  readonly url: string;

  constructor(url: string) {
    super('invalid', `The network guard blocked ${url}`, {
      retryable: false,
      userMessage: 'The network guard blocked this request before it left the machine.',
    });
    this.name = 'NetworkBlockedError';
    this.url = url;
  }
}

/** What the guard lets through. */
export type NetworkPolicy =
  | { readonly kind: 'none' }
  | { readonly kind: 'loopback' }
  | { readonly kind: 'origins'; readonly origins: readonly string[] };

/**
 * The same policies in their constructor spelling: a bare `'none'` or
 * `'loopback'`, or a list of exact origins, which is what {@link NetworkGuard.allow}
 * takes too.
 */
export type NetworkPolicyInput = 'none' | 'loopback' | readonly string[];

/** One recorded request attempt. */
export interface NetworkCall {
  /** The URL the caller asked for. A refused URL is still recorded verbatim. */
  readonly url: string;
  /** The HTTP method, upper-cased, from `init.method`, the `Request`, or `GET`. */
  readonly method: string;
  /** When the attempt happened, from the guard's clock (epoch milliseconds). */
  readonly at: number;
  /**
   * True when the policy allowed the attempt, so it went on to the real
   * fetcher. A refused attempt stays in the log with `allowed: false`: it never
   * became a request, which is exactly what {@link NetworkGuard.assertNoCalls}
   * checks.
   */
  readonly allowed: boolean;
}

export interface NetworkGuard {
  /**
   * The guarded `fetch`. Every call is recorded first; a forbidden URL throws
   * {@link NetworkBlockedError} without ever reaching the delegate.
   */
  readonly fetch: typeof fetch;
  /** Every attempt so far, oldest first, refused ones included. */
  readonly calls: readonly NetworkCall[];
  /** The policy currently in force. */
  readonly policy: NetworkPolicy;
  /**
   * Passes when no attempt was allowed through — refused attempts do not count,
   * because they never left the machine. Throws with the allowed URLs otherwise.
   */
  assertNoCalls(): void;
  /**
   * Passes when every recorded attempt targeted loopback.
   *
   * This is stricter than {@link NetworkGuard.assertNoCalls} on purpose: a
   * refused attempt still shows that the code under test *tried* to reach a
   * non-local host, which a loopback-only test should never do.
   */
  assertOnlyLoopback(): void;
  /**
   * Replaces the policy with an exact-origin allow list. Entries may be origins
   * (`http://127.0.0.1:11434`) or full URLs; only their origin is kept, so a
   * path on the entry does not widen the list. An entry without an origin
   * throws a `TypeError`; the previous policy then stays in force.
   */
  allow(origins: readonly string[]): void;
  /**
   * Clears the call log. The policy is left untouched, so a test can reuse one
   * guard across scenarios after calling `allow` again.
   */
  reset(): void;
}

export interface GuardOptions {
  /** Policy to start with. Defaults to `'none'`: every request is refused. */
  readonly policy?: NetworkPolicyInput;
  /** Fetcher used for allowed calls. Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Clock for {@link NetworkCall.at}. Defaults to `Date.now`. */
  readonly now?: () => number;
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function methodOf(input: string | URL | Request, init?: RequestInit): string {
  if (init?.method !== undefined) return init.method.toUpperCase();
  if (typeof input !== 'string' && !(input instanceof URL)) return input.method.toUpperCase();
  return 'GET';
}

/** The origin of an absolute URL, or undefined for a relative or opaque one. */
function originOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

function normalizeOrigins(origins: readonly string[]): readonly string[] {
  const unique = new Set<string>();
  for (const entry of origins) {
    const origin = originOf(entry);
    if (origin === undefined) throw new TypeError(`Not an absolute URL with an origin: ${entry}`);
    unique.add(origin);
  }
  return [...unique];
}

function normalizePolicy(input: NetworkPolicyInput | undefined): NetworkPolicy {
  if (input === undefined || input === 'none') return { kind: 'none' };
  if (input === 'loopback') return { kind: 'loopback' };
  // The only remaining spelling is the origin list; it is validated eagerly so
  // a typo in a test fails at the policy change instead of silently denying.
  return { kind: 'origins', origins: normalizeOrigins(input) };
}

function allows(policy: NetworkPolicy, url: string): boolean {
  if (policy.kind === 'none') return false;
  if (policy.kind === 'loopback') return classifyEndpoint(url) === 'loopback';
  const origin = originOf(url);
  return origin !== undefined && policy.origins.includes(origin);
}

function describe(calls: readonly NetworkCall[]): string {
  return calls.map(call => `${call.method} ${call.url}`).join(', ');
}

export function createGuard(options: GuardOptions = {}): NetworkGuard {
  const delegate: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  const calls: NetworkCall[] = [];
  let policy = normalizePolicy(options.policy);

  const guardedFetch: typeof fetch = async (input, init) => {
    const url = urlOf(input);
    const method = methodOf(input, init);
    const allowed = allows(policy, url);
    // Record before deciding: a refused attempt is the evidence a privacy test
    // is after, and it still never becomes a request.
    calls.push({ url, method, at: now(), allowed });
    if (!allowed) throw new NetworkBlockedError(url);
    // The delegate's response is returned as-is: a guard must be transparent
    // for allowed traffic, never re-wrap or clone it.
    return delegate(input, init);
  };

  return {
    fetch: guardedFetch,
    get calls(): readonly NetworkCall[] {
      return [...calls];
    },
    get policy(): NetworkPolicy {
      return policy;
    },
    assertNoCalls(): void {
      const sent = calls.filter(call => call.allowed);
      if (sent.length === 0) return;
      throw new Error(`The network guard allowed ${sent.length} request(s): ${describe(sent)}`);
    },
    assertOnlyLoopback(): void {
      const offenders = calls.filter(call => classifyEndpoint(call.url) !== 'loopback');
      if (offenders.length === 0) return;
      throw new Error(`The network guard saw ${offenders.length} non-loopback call(s): ${describe(offenders)}`);
    },
    allow(origins: readonly string[]): void {
      policy = { kind: 'origins', origins: normalizeOrigins(origins) };
    },
    reset(): void {
      calls.length = 0;
    },
  };
}

/** A transport that performs its requests through {@link FetcherTransport.fetcher}. */
export interface FetcherTransport {
  readonly fetcher: FetchLike;
}

/**
 * Returns a copy of `transport` whose `fetcher` is the guard, so a privacy test
 * can drive the whole transport and then assert on the guard's log.
 *
 * The copy keeps every own property of `transport` and adds or replaces
 * `fetcher`. It does not reach into methods that captured a different fetcher
 * in their closure: the transport must build its requests from its `fetcher`
 * property for the guard to see them.
 */
export function wrapTransport<T extends object>(guard: NetworkGuard, transport: T): T & FetcherTransport {
  return { ...transport, fetcher: guard.fetch };
}
