import { describe, expect, it, vi } from 'vitest';
import {
  assertCanSend,
  classifyEndpoint,
  effectiveEndpoint,
  isLoopback,
  privacyPolicy,
  PrivacyError,
  type PrivacyMode,
} from '../src/core/privacy';
import { createTranslationTransport } from '../src/core/translation';
import { TranslationError } from '../src/core/retry';
import { defaultSettings, type TextBlock, type TranslationSettings } from '../src/core/types';

const loopbackSettings: TranslationSettings = { ...defaultSettings, model: 'test-model', targetLanguage: 'vi' };

/** A remote provider: consent is stored so only the privacy mode can refuse it. */
const cloudSettings = (provider: 'google' | 'deepl' | 'openai'): TranslationSettings => ({
  ...defaultSettings,
  provider,
  apiKey: 'secret',
  model: 'gpt-4o-mini',
  allowCloud: true,
  endpoint: provider === 'openai' ? 'https://api.example.invalid/v1' : defaultSettings.endpoint,
});

const lanSettings: TranslationSettings = {
  ...defaultSettings,
  provider: 'openai',
  apiKey: 'secret',
  model: 'gpt-4o-mini',
  allowCloud: true,
  endpoint: 'http://192.168.1.10:11434/v1',
};

const block = (id: string, text: string): TextBlock => ({
  id,
  page: 1,
  text,
  rect: { x: 0, y: 0, width: 100, height: 20 },
  fontSize: 12,
  fontFamily: 'serif',
  color: '#000000',
  direction: 'ltr',
  rotation: 0,
});

function okResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

/** Google answers with its own envelope, which the transport reads separately. */
function googleResponse(): Response {
  return new Response(JSON.stringify({ data: { translations: [{ translatedText: 'Xin chào' }] } }), { status: 200 });
}

/**
 * A transport whose fetcher records every request it receives, so a test can
 * prove that a refused provider was never contacted at all.
 */
function harness(mode: PrivacyMode | (() => PrivacyMode), respond: () => Response = () => okResponse('Xin chào')) {
  const sent: string[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    sent.push(String(input));
    return respond();
  });
  const transport = createTranslationTransport(fetcher, { sleep: async () => {} }, { privacyMode: mode });
  return { fetcher, sent, transport };
}

describe('offline mode', () => {
  it('refuses every cloud provider with zero requests', async () => {
    for (const provider of ['google', 'deepl', 'openai'] as const) {
      const { fetcher, sent, transport } = harness('offline');
      const error = await transport
        .translate({ text: 'Private', settings: cloudSettings(provider) })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(PrivacyError);
      expect((error as PrivacyError).code).toBe('offline');
      expect(sent).toHaveLength(0);
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it('refuses a model on the local network, which is a request off this machine', async () => {
    const { sent, transport } = harness('offline');
    const error = await transport.translate({ text: 'Private', settings: lanSettings }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PrivacyError);
    expect((error as PrivacyError).code).toBe('offline');
    expect(sent).toHaveLength(0);
  });

  it('refuses the batched path as well', async () => {
    const { fetcher, sent, transport } = harness('offline');
    const error = await transport
      .translateBatch([block('b1', 'One'), block('b2', 'Two')], cloudSettings('openai'))
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PrivacyError);
    expect(sent).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('allows a loopback model and sends exactly one request', async () => {
    const { sent, transport } = harness('offline');
    const text = await transport.translate({ text: 'Hello', settings: loopbackSettings });
    expect(text).toBe('Xin chào');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('127.0.0.1');
  });
});

describe('mode boundaries', () => {
  it('keeps a loopback model working in every mode', async () => {
    const sent: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      sent.push(String(input));
      return okResponse('Xin chào');
    });
    for (const mode of ['offline', 'ask', 'cloud'] as const) {
      const transport = createTranslationTransport(fetcher, { sleep: async () => {} }, { privacyMode: mode });
      await expect(transport.translate({ text: 'Hello', settings: loopbackSettings })).resolves.toBe('Xin chào');
    }
    expect(sent).toHaveLength(3);
  });

  it('refuses a cloud provider in ask mode until consent is stored', async () => {
    const { fetcher, sent, transport } = harness('ask');
    const error = await transport
      .translate({ text: 'Private', settings: { ...cloudSettings('openai'), allowCloud: false } })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PrivacyError);
    expect((error as PrivacyError).code).toBe('consent');
    expect((error as PrivacyError).message).toMatch(/cloud/i);
    expect(sent).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends in ask mode once consent is stored', async () => {
    const { sent, transport } = harness('ask');
    await expect(transport.translate({ text: 'Hello', settings: cloudSettings('openai') })).resolves.toBe('Xin chào');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('api.example.invalid');
  });

  it('sends in cloud mode with the stored flag', async () => {
    const { sent, transport } = harness('cloud', googleResponse);
    await expect(transport.translate({ text: 'Hello', settings: cloudSettings('google') })).resolves.toBe('Xin chào');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('translation.googleapis.com');
  });

  it('still requires the stored consent flag in cloud mode', async () => {
    const { fetcher, sent, transport } = harness('cloud');
    const error = await transport
      .translate({ text: 'Private', settings: { ...cloudSettings('openai'), allowCloud: false } })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PrivacyError);
    expect((error as PrivacyError).code).toBe('consent');
    expect(sent).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('lets a local-network model through outside offline mode', async () => {
    const { sent, transport } = harness('ask');
    await expect(transport.translate({ text: 'Hello', settings: lanSettings })).resolves.toBe('Xin chào');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('192.168.1.10');
  });

  it('reads a live mode change before each request', async () => {
    let mode: PrivacyMode = 'cloud';
    const { sent, transport } = harness(() => mode);
    await expect(transport.translate({ text: 'A', settings: cloudSettings('openai') })).resolves.toBe('Xin chào');
    mode = 'offline';
    await expect(transport.translate({ text: 'B', settings: cloudSettings('openai') })).rejects.toBeInstanceOf(PrivacyError);
    expect(sent).toHaveLength(1);
  });
});

describe('isLoopback', () => {
  const table: ReadonlyArray<readonly [string, boolean]> = [
    ['http://127.0.0.1:11434/v1', true],
    ['http://127.0.0.2:1234', true],
    ['http://localhost:11434/v1', true],
    ['http://[::1]:8080/v1', true],
    ['http://[::ffff:127.0.0.1]:8080/v1', true],
    // Private LAN ranges are not loopback unless the caller opts in.
    ['http://192.168.1.10:11434/v1', false],
    ['http://10.1.2.3:11434/v1', false],
    ['http://172.16.0.9:11434/v1', false],
    // 172.32 is outside 172.16/12.
    ['http://172.32.0.1:11434/v1', false],
    ['https://8.8.8.8/v1', false],
    // A DNS name may resolve anywhere, so it is never treated as local.
    ['https://inference.example.invalid/v1', false],
    ['http://localhost.evil.example/v1', false],
    ['http://127.0.0.1.evil.example/v1', false],
    ['http://127.0.0.1@evil.example/v1', false],
    ['http://evil.example/v1#127.0.0.1', false],
    ['not a url', false],
  ];

  it('classifies addresses', () => {
    for (const [endpoint, expected] of table) {
      expect(isLoopback(endpoint), endpoint).toBe(expected);
      expect(classifyEndpoint(endpoint) === 'loopback', endpoint).toBe(expected);
    }
  });

  it('counts RFC 1918 ranges only when the policy allows a local-network model', () => {
    expect(isLoopback('http://192.168.1.10:11434/v1', { allowPrivateNetwork: true })).toBe(true);
    expect(isLoopback('http://10.1.2.3:11434/v1', { allowPrivateNetwork: true })).toBe(true);
    expect(isLoopback('http://172.16.0.9:11434/v1', { allowPrivateNetwork: true })).toBe(true);
    expect(isLoopback('http://172.31.255.254:11434/v1', { allowPrivateNetwork: true })).toBe(true);
    expect(isLoopback('http://172.32.0.1:11434/v1', { allowPrivateNetwork: true })).toBe(false);
    expect(isLoopback('https://8.8.8.8/v1', { allowPrivateNetwork: true })).toBe(false);
    expect(isLoopback('https://inference.example.invalid/v1', { allowPrivateNetwork: true })).toBe(false);
  });
});

describe('privacyPolicy', () => {
  it('never allows network access in offline mode', () => {
    const remote = privacyPolicy('offline', 'https://api.example.invalid/v1');
    expect(remote.allowsNetwork).toBe(false);
    expect(remote.scope).toBe('remote');
    expect(remote.requiresConsent).toBe(false);
    expect(remote.allowlist).toEqual(['loopback']);
    expect(remote.reason).toMatch(/Offline mode/);

    const local = privacyPolicy('offline', 'http://127.0.0.1:11434/v1');
    expect(local.allowsNetwork).toBe(false);
    expect(local.allowlist).toEqual(['loopback']);
    expect(local.reason).toMatch(/this machine/);
  });

  it('allows the local network but requires consent for remote hosts outside offline mode', () => {
    const ask = privacyPolicy('ask', 'https://api.example.invalid/v1');
    expect(ask.allowsNetwork).toBe(true);
    expect(ask.requiresConsent).toBe(true);
    expect(ask.allowlist).toEqual(['loopback', 'private-network']);
    expect(ask.reason).toMatch(/consent/);

    const cloud = privacyPolicy('cloud', 'https://api.example.invalid/v1');
    expect(cloud.allowsNetwork).toBe(true);
    expect(cloud.requiresConsent).toBe(true);
    expect(cloud.reason).toMatch(/Cloud mode/);
  });

  it('classifies private ranges as private, not loopback', () => {
    expect(privacyPolicy('offline', 'http://192.168.1.10:11434/v1').scope).toBe('private-network');
    expect(privacyPolicy('offline', 'not a url').scope).toBe('invalid');
    expect(privacyPolicy('offline', 'not a url').reason).toMatch(/not a valid URL/);
  });

  it('reports the endpoint a cloud provider really contacts', () => {
    expect(effectiveEndpoint(cloudSettings('google'))).toContain('translation.googleapis.com');
    expect(effectiveEndpoint(cloudSettings('deepl'))).toContain('api.deepl.com');
    expect(effectiveEndpoint(loopbackSettings)).toBe(defaultSettings.endpoint);
  });
});

describe('assertCanSend', () => {
  it('throws a stable typed error the UI can show', () => {
    const policy = privacyPolicy('offline', 'https://api.example.invalid/v1');
    const error = (() => {
      try {
        assertCanSend(policy, cloudSettings('openai'));
        return undefined;
      } catch (reason) {
        return reason;
      }
    })();
    expect(error).toBeInstanceOf(PrivacyError);
    expect(error).toBeInstanceOf(TranslationError);
    const refusal = error as PrivacyError;
    expect(refusal.code).toBe('offline');
    expect(refusal.name).toBe('PrivacyError');
    expect(refusal.kind).toBe('invalid');
    expect(refusal.retryable).toBe(false);
    expect(refusal.message).toBe('Offline mode is on, so text can only go to a model on this machine.');
  });

  it('does not trust the endpoint embedded in the policy', () => {
    // A policy built for loopback must not authorize a cloud provider.
    const loopbackPolicy = privacyPolicy('offline', 'http://127.0.0.1:11434/v1');
    expect(() => assertCanSend(loopbackPolicy, cloudSettings('google'))).toThrow(PrivacyError);
    expect(() => assertCanSend(loopbackPolicy, loopbackSettings)).not.toThrow();
  });

  it('refuses a malformed endpoint before transport builds a request', async () => {
    const { fetcher, transport } = harness('ask');
    const error = await transport
      .translate({ text: 'Hello', settings: { ...cloudSettings('openai'), endpoint: 'not a url' } })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TranslationError);
    expect(error).toBeInstanceOf(PrivacyError);
    expect((error as PrivacyError).code).toBe('invalid-endpoint');
    expect((error as TranslationError).kind).toBe('invalid');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
