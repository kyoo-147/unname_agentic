import { describe, expect, it, vi } from 'vitest';
import { createTranslationTransport, TranslationService } from '../src/core/translation';
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

  it('passes an abort signal and sends context as plain text', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: 'Bonjour' } }] }), { status: 200 }));
    const signal = new AbortController().signal;
    const text = await createTranslationTransport(fetcher).translate({ text: '<script>text</script>', settings, signal });
    expect(text).toBe('Bonjour');
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBe(signal);
    expect(JSON.parse(String(init.body)).messages[1].content).toBe('<script>text</script>');
  });
});
