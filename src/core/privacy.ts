import { TranslationError } from './retry';
import type { AuditLog } from './audit';
import type { ProviderKind } from './types';

/**
 * Network posture of the whole app.
 *
 * - `offline` never lets text leave this machine: only a loopback endpoint is
 *   usable, and every other endpoint is refused before a request is built.
 * - `ask` lets a model on the user's own network run without a prompt, but a
 *   cloud provider needs the stored `allowCloud` flag first.
 * - `cloud` is the explicit opt-in: picking it records the user's consent to
 *   remote providers. The stored `allowCloud` flag is still required by the
 *   transport, so an old settings object can never send on its own.
 */
export type PrivacyMode = 'offline' | 'ask' | 'cloud';

/** How far an endpoint is from the machine that runs the app. */
export type EndpointScope = 'loopback' | 'private-network' | 'remote' | 'invalid';

/** Endpoint scopes that stay inside the user's own network. */
export type LocalScope = 'loopback' | 'private-network';

/** The settings fields a privacy decision depends on. */
export interface PrivacySettings {
  readonly provider: ProviderKind;
  readonly endpoint: string;
  readonly allowCloud: boolean;
}

/**
 * The decision for one mode and endpoint, ready to be shown in the UI and to be
 * enforced by {@link assertCanSend}.
 */
export interface PrivacyPolicy {
  /** The mode this decision belongs to, echoed for the caller. */
  readonly mode: PrivacyMode;
  /** The endpoint this decision describes, exactly as it was passed in. */
  readonly endpoint: string;
  /** Where that endpoint lives: this machine, the local network, or a remote host. */
  readonly scope: EndpointScope;
  /**
   * True when text may be sent beyond this machine at all. Always false in
   * `offline`, even though a loopback endpoint still works there: a loopback
   * request never leaves the machine and is not network access.
   */
  readonly allowsNetwork: boolean;
  /** One sentence the UI can show next to the provider choice. */
  readonly reason: string;
  /**
   * True when a cloud provider must also carry the stored `allowCloud` flag.
   * It is true in `ask` and `cloud` — only `offline` never needs it, because
   * cloud providers are refused there outright.
   */
  readonly requiresConsent: boolean;
  /**
   * Local scopes this mode may contact. It never contains `remote`: a remote
   * host is governed by {@link PrivacyPolicy.allowsNetwork} and
   * {@link PrivacyPolicy.requiresConsent} instead.
   */
  readonly allowlist: readonly LocalScope[];
}

/** Why a request was refused. Stable identifiers, safe to switch on. */
export type PrivacyErrorCode = 'offline' | 'consent' | 'invalid-endpoint';

/**
 * Refusal messages are part of the contract: the UI shows them verbatim, so
 * they only change together with the tests that pin them.
 */
const REFUSALS: Record<PrivacyErrorCode, string> = {
  offline: 'Offline mode is on, so text can only go to a model on this machine.',
  consent: 'Cloud translation requires the stored cloud consent. Enable it in settings.',
  'invalid-endpoint': 'The provider endpoint is invalid, so no text was sent.',
};

/** Non-sensitive evidence for one provider-routing decision. */
export interface ConsentAuditInput {
  readonly documentId: string;
  readonly provider: ProviderKind;
  readonly mode: PrivacyMode;
  readonly endpoint: string;
  readonly allowCloud: boolean;
  readonly allowed: boolean;
}

/** Records route/consent evidence without persisting the endpoint or payload. */
export function recordConsentDecision(log: AuditLog, input: ConsentAuditInput): void {
  const endpoint = effectiveEndpoint({
    provider: input.provider,
    endpoint: input.endpoint,
    allowCloud: input.allowCloud,
  });
  const policy = privacyPolicy(input.mode, endpoint);
  log.append({
    kind: 'translate',
    documentId: input.documentId,
    actor: 'app',
    details: {
      provider: input.provider,
      mode: input.mode,
      endpointScope: policy.scope,
      cloudConsent: input.allowCloud,
      allowed: input.allowed,
    },
  });
}

/**
 * A request the privacy policy refused. It is a {@link TranslationError} with
 * kind `invalid`, so existing error handling shows it to the user and never
 * retries it — a policy decision only changes when the user changes settings.
 */
export class PrivacyError extends TranslationError {
  readonly code: PrivacyErrorCode;

  constructor(code: PrivacyErrorCode, options: { cause?: unknown } = {}) {
    super('invalid', REFUSALS[code], { cause: options.cause, retryable: false });
    this.name = 'PrivacyError';
    this.code = code;
  }
}

const CLOUD_ENDPOINTS: Record<'google' | 'deepl', string> = {
  google: 'https://translation.googleapis.com/language/translate/v2',
  deepl: 'https://api.deepl.com/v2/translate',
};

/**
 * The host a settings object will really contact. Google and DeepL ignore the
 * configured endpoint (the transport builds their own URL), so they are
 * reported as their canonical cloud host; everything else is the configured
 * endpoint as written.
 */
export function effectiveEndpoint(settings: PrivacySettings): string {
  if (settings.provider === 'google') return CLOUD_ENDPOINTS.google;
  if (settings.provider === 'deepl') return CLOUD_ENDPOINTS.deepl;
  return settings.endpoint;
}

/**
 * True for every provider that may reach a remote host. Only `local` is
 * required to use a loopback endpoint, so only `local` is trusted without the
 * cloud consent flag.
 */
export function isCloudProvider(provider: ProviderKind): boolean {
  return provider !== 'local';
}

function hostnameOf(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  // WHATWG keeps IPv6 hostnames in brackets; drop them so both spellings of
  // `::1` are classified the same way.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host || undefined;
}

function ipv4Bytes(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes.push(value);
  }
  return bytes;
}

function ipv4Scope(host: string): EndpointScope | undefined {
  const bytes = ipv4Bytes(host);
  if (!bytes) return undefined;
  const first = bytes[0]!;
  const second = bytes[1]!;
  if (first === 127) return 'loopback';
  if (first === 10) return 'private-network';
  if (first === 192 && second === 168) return 'private-network';
  if (first === 172 && second >= 16 && second <= 31) return 'private-network';
  // Every other numeric host is a public address, including 172.32+.0.1.
  return 'remote';
}

function mappedIpv4(host: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (dotted) return dotted[1];
  // WHATWG normalizes `::ffff:127.0.0.1` to `::ffff:7f00:1`; accept both
  // spellings so a mapped loopback address is not refused as remote.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function ipv6Scope(host: string): EndpointScope | undefined {
  if (!host.includes(':')) return undefined;
  if (host === '::1') return 'loopback';
  const mapped = mappedIpv4(host);
  if (mapped) return ipv4Scope(mapped);
  // IPv6 unique-local addresses are deliberately treated as remote: refusing
  // them is the safe default, and no supported provider requires them.
  return 'remote';
}

/**
 * Classifies an endpoint by where it lives. Only a literal loopback host is
 * `loopback`; a DNS name is `remote` even when it happens to resolve to this
 * machine, because the transport cannot prove that before sending.
 */
export function classifyEndpoint(endpoint: string): EndpointScope {
  const host = hostnameOf(endpoint);
  if (host === undefined) return 'invalid';
  if (host === 'localhost') return 'loopback';
  return ipv4Scope(host) ?? ipv6Scope(host) ?? 'remote';
}

export interface IsLoopbackOptions {
  /**
   * Count the RFC 1918 ranges (10/8, 172.16/12, 192.168/16) as local, for a
   * model running on another machine of the user's own network. Defaults to
   * false: a loopback address is the only host that never leaves the machine.
   */
  allowPrivateNetwork?: boolean;
}

/**
 * True when a provider endpoint runs on the user's own machine. Private LAN
 * ranges count only when `allowPrivateNetwork` is set, which is what the policy
 * does in the modes that allow a local-network model.
 */
export function isLoopback(endpoint: string, options: IsLoopbackOptions = {}): boolean {
  const scope = classifyEndpoint(endpoint);
  return scope === 'loopback' || (scope === 'private-network' && options.allowPrivateNetwork === true);
}

function policyReason(mode: PrivacyMode, scope: EndpointScope, allowsNetwork: boolean): string {
  if (scope === 'invalid') return 'This endpoint is not a valid URL, so nothing can be sent to it.';
  if (!allowsNetwork) {
    return scope === 'loopback'
      ? 'Offline mode is on. This model runs on this machine, so nothing leaves it.'
      : 'Offline mode is on, so text may only go to a model on this machine.';
  }
  if (scope === 'remote') {
    return mode === 'cloud'
      ? 'Cloud mode allows this remote provider; the stored cloud consent still applies.'
      : 'This provider is remote, so it needs the stored cloud consent before anything is sent.';
  }
  return 'This endpoint stays on your own network, so no cloud consent is needed.';
}

/**
 * Describes what a mode lets this endpoint do. Pure and cheap: the UI can call
 * it on every settings change, and the transport calls it before each request.
 */
export function privacyPolicy(mode: PrivacyMode, endpoint: string): PrivacyPolicy {
  const scope = classifyEndpoint(endpoint);
  // Offline is this machine only: a model on the LAN is still a request that
  // leaves the machine, so private ranges are not local there.
  const allowsNetwork = mode !== 'offline';
  const allowlist: LocalScope[] = ['loopback'];
  if (allowsNetwork) allowlist.push('private-network');
  return {
    mode,
    endpoint,
    scope,
    allowsNetwork,
    reason: policyReason(mode, scope, allowsNetwork),
    requiresConsent: allowsNetwork,
    allowlist,
  };
}

/**
 * Throws a {@link PrivacyError} when `settings` may not be sent.
 *
 * The endpoint is re-derived from `settings` rather than read from `policy`: a
 * policy built for a loopback endpoint must never authorize a provider that
 * would contact a cloud host. A loopback endpoint is allowed in every mode; a
 * private-LAN endpoint is allowed outside offline mode; a cloud provider then
 * needs the stored `allowCloud` flag. Malformed endpoints are left to the
 * transport's own URL validation, which never sends without a valid URL.
 */
export function assertCanSend(policy: PrivacyPolicy, settings: PrivacySettings): void {
  const scope = classifyEndpoint(effectiveEndpoint(settings));
  if (scope === 'invalid') throw new PrivacyError('invalid-endpoint');
  if (scope === 'loopback') return;
  if (!policy.allowsNetwork) throw new PrivacyError('offline');
  if (policy.requiresConsent && isCloudProvider(settings.provider) && !settings.allowCloud) throw new PrivacyError('consent');
}
