import { describe, expect, it, vi } from 'vitest';
import { countCharacters, createTranslationTransport, TranslationService } from '../src/core/translation';
import { TranslationError } from '../src/core/retry';
import { mask, placeholderFor } from '../src/core/protect';
import { defaultSettings } from '../src/core/types';

const settings = { ...defaultSettings, model: 'test', targetLanguage: 'vi' };

describe('translation service', () => {
  it('reuses results for unchanged text but isolates target languages', async () => {
    const translate = vi.fn(async () => 'Xin chào');
    const service = new TranslationService({ translate });
    expect((await service.translate({ text: 'Hello', settings })).text).toBe('Xin chào');
    expect((await service.translate({ text: 'Hello', settings })).cached).toBe(true);
    await service.translate({ text: 'Hello', settings: { ...settings, targetLanguage: 'fr' } });
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent requests', async () => {
    const translate = vi.fn(async () => 'Bản dịch');
    const service = new TranslationService({ translate });
    await Promise.all(Array.from({ length: 4 }, () => service.translate({ text: 'Original', settings })));
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh request when a previous identical request was aborted', async () => {
    let calls = 0;
    const firstController = new AbortController();
    const service = new TranslationService({ translate: async ({ signal }) => {
      calls++;
      if (calls === 1) return new Promise<string>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      return 'Mới';
    } });
    const previous = service.translate({ text: 'Hello', settings, signal: firstController.signal });
    const rejected = expect(previous).rejects.toThrow();
    firstController.abort();
    const fresh = service.translate({ text: 'Hello', settings });
    await rejected;
    expect((await fresh).text).toBe('Mới');
    expect(calls).toBe(2);
  });

  it('rejects empty provider output rather than showing a false success', async () => {
    const service = new TranslationService({ translate: async () => '  ' });
    await expect(service.translate({ text: 'Hello', settings })).rejects.toThrow();
  });

  it('requires consent before sending text to cloud', async () => {
    const fetcher = vi.fn();
    const transport = createTranslationTransport(fetcher);
    await expect(transport.translate({ text: 'Private', settings: { ...settings, provider: 'google', apiKey: 'key' } })).rejects.toThrow(/cloud/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends Google Cloud Translation a legitimate authenticated API request', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ data: { translations: [{ translatedText: 'Xin chào' }] } }), { status: 200 }));
    const transport = createTranslationTransport(fetcher);
    const text = await transport.translate({ text: 'Hello', settings: { ...settings, provider: 'google', apiKey: 'secret', allowCloud: true } });
    expect(text).toBe('Xin chào');
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('translation.googleapis.com');
  });

  it('never sends a DeepL key to a lookalike hostname', async () => {
    const fetcher = vi.fn();
    await expect(createTranslationTransport(fetcher).translate({ text: 'Private', settings: { ...settings, provider: 'deepl', endpoint: 'https://api.deepl.com.evil.example/v2/translate', apiKey: 'secret', allowCloud: true } })).rejects.toThrow(/DeepL endpoint/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses remote endpoints disguised as local mode', async () => {
    const fetcher = vi.fn();
    await expect(createTranslationTransport(fetcher).translate({ text: 'Private', settings: { ...settings, endpoint: 'https://inference.example/v1' } })).rejects.toThrow(/loopback/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('passes an abort signal and sends masked context to the provider', async () => {
    // G06: the provider must echo every placeholder back, so the stub answers with
    // the placeholders and the transport restores the locked tokens afterwards.
    const protectedText = mask('<script>text</script>');
    const echo = ['Bonjour', ...protectedText.tokens.map((token) => placeholderFor(token.index))].join(' ');
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: echo } }] }), { status: 200 }));
    const signal = new AbortController().signal;
    const text = await createTranslationTransport(fetcher).translate({ text: '<script>text</script>', settings, signal });
    expect(text).toBe('Bonjour /script');
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBe(signal);
    expect(JSON.parse(String(init.body)).messages[1].content).toBe(protectedText.masked);
  });
});

const okResponse = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe('translation transports', () => {
  it('sends Google only the fields its v2 API supports', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ data: { translations: [{ translatedText: 'Xin chào' }] } }), { status: 200 }));
    const transport = createTranslationTransport(fetcher);
    await transport.translate({
      text: 'Hello',
      settings: { ...settings, provider: 'google', apiKey: 'secret', allowCloud: true, sourceLanguage: 'en', glossary: { Hello: 'Xin chào' } },
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://translation.googleapis.com/language/translate/v2');
    expect((init!.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('secret');
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({ q: 'Hello', target: 'vi', source: 'en', format: 'text' });
    expect(body.glossary).toBeUndefined();
    expect(body.glossaryId).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('sends DeepL its documented payload without a fake glossary field', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ translations: [{ text: 'Xin chào' }] }), { status: 200 }));
    const transport = createTranslationTransport(fetcher);
    await transport.translate({
      text: 'Hello',
      settings: { ...settings, provider: 'deepl', apiKey: 'secret', allowCloud: true, sourceLanguage: 'en', glossary: { Hello: 'Xin chào' } },
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api-free.deepl.com/v2/translate');
    expect((init!.headers as Record<string, string>).Authorization).toBe('DeepL-Auth-Key secret');
    const body = JSON.parse(String(init!.body));
    expect(body).toEqual({ text: ['Hello'], target_lang: 'VI', source_lang: 'EN' });
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('builds an OpenAI-compatible payload with the versioned prompt and glossary', async () => {
    const protectedText = mask('<b>Hello</b>');
    const echo = ['Bonjour', ...protectedText.tokens.map((token) => placeholderFor(token.index))].join(' ');
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => okResponse(echo));
    const transport = createTranslationTransport(fetcher);
    await transport.translate({
      text: '<b>Hello</b>',
      settings: {
        ...settings,
        provider: 'openai',
        endpoint: 'https://api.openai.com/v1',
        apiKey: 'secret',
        allowCloud: true,
        model: 'gpt-test',
        sourceLanguage: 'en',
        glossary: { prompt: 'câu lệnh' },
        promptVersion: 'mirror-test',
      },
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe('gpt-test');
    expect(body.temperature).toBe(0);
    expect(body.messages[1]).toEqual({ role: 'user', content: mask('<b>Hello</b>').masked });
    expect(body.messages[1].content).not.toBe('<b>Hello</b>');
    expect(body.messages[0].content).toContain('prompt = câu lệnh');
    expect(body.messages[0].content).toContain('Prompt version: mirror-test');
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  it('includes the same prompt builder for local endpoints without a key header', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => okResponse('Mô hình'));
    const transport = createTranslationTransport(fetcher);
    await transport.translate({ text: 'model', settings: { ...settings, glossary: { model: 'mô hình' } } });
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(String(init.body)).messages[0].content).toContain('model = mô hình');
  });

  it('retries rate limits and transient network failures', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okResponse('Bonjour'));
    const transport = createTranslationTransport(fetcher, { baseDelayMs: 10, sleep: async () => {}, random: () => 0 });
    await expect(transport.translate({ text: 'Hello', settings })).resolves.toBe('Bonjour');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('classifies HTTP failures and never retries auth or invalid requests', async () => {
    const unauthorized = createTranslationTransport(vi.fn(async () => new Response('{}', { status: 401 })), { sleep: async () => {} });
    await expect(unauthorized.translate({ text: 'Hello', settings })).rejects.toMatchObject({ kind: 'auth', retryable: false, status: 401 });

    const fetcher = vi.fn(async () => new Response('{}', { status: 400 }));
    const badRequest = createTranslationTransport(fetcher, { sleep: async () => {} });
    await expect(badRequest.translate({ text: 'Hello', settings })).rejects.toMatchObject({ kind: 'invalid', retryable: false, status: 400 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('exhausts maxAttempts for server errors', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 503 }));
    const transport = createTranslationTransport(fetcher, { maxAttempts: 2, baseDelayMs: 10, sleep: async () => {}, random: () => 0 });
    await expect(transport.translate({ text: 'Hello', settings })).rejects.toMatchObject({ kind: 'network', status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('classifies empty and malformed responses', async () => {
    const empty = createTranslationTransport(vi.fn(async () => okResponse('   ')), { sleep: async () => {} });
    await expect(empty.translate({ text: 'Hello', settings })).rejects.toMatchObject({ kind: 'empty', retryable: false });

    const malformedFetch = vi.fn(async () => new Response('not json', { status: 200 }));
    const malformed = createTranslationTransport(malformedFetch, { sleep: async () => {} });
    await expect(malformed.translate({ text: 'Hello', settings })).rejects.toMatchObject({ kind: 'invalid' });
    expect(malformedFetch).toHaveBeenCalledTimes(1);
  });

  it('honours a pre-aborted signal without contacting the provider', async () => {
    const fetcher = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const transport = createTranslationTransport(fetcher);
    await expect(transport.translate({ text: 'Hello', settings, signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not leak the API key through error metadata', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 403 }));
    const transport = createTranslationTransport(fetcher, { sleep: async () => {} });
    const error = await transport.translate({ text: 'Hello', settings: { ...settings, provider: 'google', apiKey: 'super-secret-key', allowCloud: true } }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(TranslationError);
    const failure = error as TranslationError;
    expect(JSON.stringify({ message: failure.message, kind: failure.kind, userMessage: failure.userMessage })).not.toContain('super-secret-key');
  });

  it('reports source character counts per result and in total', async () => {
    const service = new TranslationService({ translate: async () => 'Xin chào' });
    const result = await service.translate({ text: 'Hello 😀', settings });
    expect(countCharacters('Hello 😀')).toBe(7);
    expect(result.characterCount).toBe(7);
    expect(service.characterCount).toBe(7);
    expect((await service.translate({ text: 'Hello 😀', settings })).cached).toBe(true);
    expect(service.characterCount).toBe(7);
  });

  it('classifies empty output from a custom transport', async () => {
    const service = new TranslationService({ translate: async () => '  ' });
    await expect(service.translate({ text: 'Hello', settings })).rejects.toMatchObject({ kind: 'empty' });
  });
});
