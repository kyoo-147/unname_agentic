import { describe, expect, it, vi } from 'vitest';
import { chunkBlocks, countCharacters, createTranslationTransport, supportsBatch } from '../src/core/translation';
import { CHARACTERS_PER_TOKEN, estimateCost, formatUsd, MODEL_PRICING } from '../src/core/pricing';
import { defaultSettings, type TextBlock, type TranslationSettings } from '../src/core/types';

const settings: TranslationSettings = { ...defaultSettings, model: 'test-model', targetLanguage: 'vi' };

const block = (id: string, text: string, page = 1): TextBlock => ({
  id,
  page,
  text,
  rect: { x: 0, y: 0, width: 100, height: 20 },
  fontSize: 12,
  fontFamily: 'serif',
  color: '#000000',
  direction: 'ltr',
  rotation: 0,
});

const cloudSettings = (provider: 'google' | 'deepl' | 'openai'): TranslationSettings => ({
  ...defaultSettings,
  provider,
  apiKey: 'secret',
  allowCloud: true,
  model: 'gpt-4o-mini',
  endpoint: provider === 'openai' ? 'https://api.openai.com/v1' : defaultSettings.endpoint,
});

const okResponse = (content: string): Response => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

function sentEntries(init: RequestInit | undefined): { id: string; text: string }[] {
  const body = JSON.parse(String(init?.body)) as { messages?: { content?: string }[] };
  return JSON.parse(body.messages?.[1]?.content ?? '[]') as { id: string; text: string }[];
}

function echoBatch(init: RequestInit | undefined, translated: (entry: { id: string; text: string }) => string): string {
  return JSON.stringify(sentEntries(init).map(entry => ({ id: entry.id, text: translated(entry) })));
}

const batchFetcher = () => vi.fn(async (_input: string | URL | Request, init?: RequestInit) => okResponse(echoBatch(init, entry => `vi:${entry.id}`)));

describe('batched translation', () => {
  it('maps a batch answer back by id and keeps the input order', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const entries = sentEntries(init).map(entry => ({ id: entry.id, text: `vi:${entry.id}` }));
      return okResponse(JSON.stringify([...entries].reverse()));
    });
    const blocks = ['b1', 'b2', 'b3'].map((id, index) => block(id, `Paragraph ${index}`));
    const result = await createTranslationTransport(fetcher).translateBatch(blocks, settings);

    expect(result.translations.map(entry => entry.id)).toEqual(['b1', 'b2', 'b3']);
    expect(result.translations.map(entry => entry.text)).toEqual(['vi:b1', 'vi:b2', 'vi:b3']);
    expect(result.requests).toBe(1);
    expect(result.aborted).toBe(false);

    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(settings.model);
    expect(body.temperature).toBe(0);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('Batch input:');
    expect(body.messages[1].role).toBe('user');
    expect(sentEntries(init)).toEqual([
      { id: 'b1', text: 'Paragraph 0' },
      { id: 'b2', text: 'Paragraph 1' },
      { id: 'b3', text: 'Paragraph 2' },
    ]);
  });

  it('splits a 300-block document into several batch requests', async () => {
    const fetcher = batchFetcher();
    const blocks = Array.from({ length: 300 }, (_, index) => block(`p${index}`, 'word '.repeat(6), Math.floor(index / 60) + 1));
    expect(chunkBlocks(blocks)).toHaveLength(3);

    const result = await createTranslationTransport(fetcher).translateBatch(blocks, settings);

    expect(result.requests).toBe(3);
    expect(result.requests).toBeGreaterThan(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.translations).toHaveLength(300);
    expect(result.translations.map(entry => entry.id)).toEqual(blocks.map(item => item.id));
    expect(result.translations.map(entry => entry.page)).toEqual(blocks.map(item => item.page));
    expect(result.characterCount).toBe(300 * 30);
  });

  it('stops a batch on abort and keeps the chunks that already finished', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      controller.abort();
      return okResponse(echoBatch(init, entry => `vi:${entry.id}`));
    });
    const blocks = Array.from({ length: 6 }, (_, index) => block(`a${index}`, 'x'.repeat(1200)));
    expect(chunkBlocks(blocks)).toHaveLength(3);

    const result = await createTranslationTransport(fetcher).translateBatch(blocks, settings, controller.signal);

    expect(result.aborted).toBe(true);
    expect(result.requests).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.translations.map(entry => entry.id)).toEqual(['a0', 'a1']);
    expect(result.characterCount).toBe(2400);
  });

  it('treats an in-flight abort as an abort, not as a provider failure', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      expect(init?.signal).toBe(controller.signal);
      controller.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      controller.abort();
    }));

    const result = await createTranslationTransport(fetcher).translateBatch([block('x1', 'Hello')], settings, controller.signal);

    expect(result).toEqual({ translations: [], requests: 1, characterCount: 0, aborted: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('honours a pre-aborted signal without contacting the provider', async () => {
    const fetcher = vi.fn();
    const controller = new AbortController();
    controller.abort();

    const result = await createTranslationTransport(fetcher).translateBatch([block('p1', 'Hello')], settings, controller.signal);

    expect(result).toEqual({ translations: [], requests: 0, characterCount: 0, aborted: true });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns an empty result for an empty document', async () => {
    const fetcher = vi.fn();
    const result = await createTranslationTransport(fetcher).translateBatch([], settings);
    expect(result).toEqual({ translations: [], requests: 0, characterCount: 0, aborted: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('counts source characters across chunks, not UTF-16 units', async () => {
    const fetcher = batchFetcher();
    const blocks = [block('c1', 'Xin chào 😀'), block('c2', '你好世界'), block('c3', 'x'.repeat(4000))];

    const result = await createTranslationTransport(fetcher).translateBatch(blocks, settings);

    expect(countCharacters('😀')).toBe(1);
    expect(result.characterCount).toBe(blocks.reduce((sum, item) => sum + countCharacters(item.text), 0));
    expect(result.translations.map(entry => entry.characterCount)).toEqual(blocks.map(item => countCharacters(item.text)));
    expect(result.translations.reduce((sum, entry) => sum + entry.characterCount, 0)).toBe(result.characterCount);
    expect(result.requests).toBe(2);
  });

  it('refuses a batch answer that drops a block instead of shifting text', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const [first] = sentEntries(init);
      return okResponse(JSON.stringify(first ? [{ id: first.id, text: 'Dịch' }] : []));
    });

    await expect(createTranslationTransport(fetcher).translateBatch([block('d1', 'One'), block('d2', 'Two')], settings)).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('refuses a model that answers with prose instead of the batch envelope', async () => {
    const fetcher = vi.fn(async () => okResponse('Đây là bản dịch.'));
    await expect(createTranslationTransport(fetcher).translateBatch([block('e1', 'One')], settings)).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('reuses the cloud consent gate for batches', async () => {
    const fetcher = vi.fn();
    await expect(createTranslationTransport(fetcher).translateBatch([block('c1', 'Hello')], { ...cloudSettings('openai'), allowCloud: false })).rejects.toThrow(/cloud/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('batch provider coverage', () => {
  it('only batches providers that accept a prompt', () => {
    expect(supportsBatch('openai')).toBe(true);
    expect(supportsBatch('local')).toBe(true);
    expect(supportsBatch('google')).toBe(false);
    expect(supportsBatch('deepl')).toBe(false);
  });

  it('sends Google v2 and DeepL one request per block and batches the prompt providers', async () => {
    const blocks = [block('g1', 'Hello'), block('g2', 'World'), block('g3', 'Again')];

    const googleFetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ data: { translations: [{ translatedText: 'Xin chào' }] } }), { status: 200 }));
    const google = await createTranslationTransport(googleFetcher).translateBatch(blocks, cloudSettings('google'));
    expect(google.requests).toBe(3);
    expect(googleFetcher).toHaveBeenCalledTimes(3);
    expect(google.translations.map(entry => entry.id)).toEqual(['g1', 'g2', 'g3']);
    expect(google.translations.map(entry => entry.text)).toEqual(['Xin chào', 'Xin chào', 'Xin chào']);
    const googleBody = JSON.parse(String((googleFetcher.mock.calls[0]?.[1] as RequestInit).body));
    expect(googleBody.q).toBe('Hello');
    expect(googleBody.messages).toBeUndefined();

    const deeplFetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ translations: [{ text: 'Xin chào' }] }), { status: 200 }));
    const deepl = await createTranslationTransport(deeplFetcher).translateBatch(blocks, cloudSettings('deepl'));
    expect(deepl.requests).toBe(3);
    expect(deeplFetcher).toHaveBeenCalledTimes(3);
    const deeplBody = JSON.parse(String((deeplFetcher.mock.calls[0]?.[1] as RequestInit).body));
    expect(deeplBody.text).toEqual(['Hello']);
    expect(deeplBody.messages).toBeUndefined();

    const openaiFetcher = batchFetcher();
    const openai = await createTranslationTransport(openaiFetcher).translateBatch(blocks, cloudSettings('openai'));
    expect(openai.requests).toBe(1);
    expect(openai.translations.map(entry => entry.text)).toEqual(['vi:g1', 'vi:g2', 'vi:g3']);
  });
});

describe('pricing', () => {
  it('estimates tokens and cost for a known character count', () => {
    const both = estimateCost({ characters: 4000, model: 'gpt-4.1-mini', direction: 'both' });
    expect(both).not.toBeNull();
    expect(both!.inputTokens).toBe(1000);
    expect(both!.outputTokens).toBe(1000);
    expect(both!.usd).toBeCloseTo(0.002, 12);

    const input = estimateCost({ characters: 4000, model: 'gpt-4o-mini', direction: 'input' });
    expect(input!.inputTokens).toBe(1000);
    expect(input!.outputTokens).toBe(0);
    expect(input!.usd).toBeCloseTo(0.00015, 12);

    const output = estimateCost({ characters: 4000, model: 'gpt-4o-mini', direction: 'output' });
    expect(output!.inputTokens).toBe(0);
    expect(output!.outputTokens).toBe(1000);
    expect(output!.usd).toBeCloseTo(0.0006, 12);
  });

  it('documents the characters-per-token approximation and rounds up', () => {
    expect(CHARACTERS_PER_TOKEN).toBe(4);
    expect(estimateCost({ characters: 1, model: 'gpt-4o-mini', direction: 'input' })!.inputTokens).toBe(1);
    expect(estimateCost({ characters: 4001, model: 'gpt-4o-mini', direction: 'input' })!.inputTokens).toBe(1001);
    expect(estimateCost({ characters: 0, model: 'gpt-4o-mini', direction: 'both' })!.usd).toBe(0);
    expect(() => estimateCost({ characters: -1, model: 'gpt-4o-mini', direction: 'input' })).toThrow(RangeError);
  });

  it('returns null for a model without a published price', () => {
    expect(estimateCost({ characters: 10_000, model: 'qwen3:4b', direction: 'both' })).toBeNull();
    expect(estimateCost({ characters: 10_000, model: 'gpt-5-imaginary', direction: 'both' })).toBeNull();
    expect(estimateCost({ characters: 10_000, model: '  ', direction: 'both' })).toBeNull();
    expect(MODEL_PRICING.every(entry => entry.inputUsdPerMillion > 0 && entry.outputUsdPerMillion >= entry.inputUsdPerMillion)).toBe(true);
    expect(new Set(MODEL_PRICING.map(entry => entry.model)).size).toBe(MODEL_PRICING.length);
  });

  it('matches known model ids case-insensitively', () => {
    const upper = estimateCost({ characters: 4000, model: ' GPT-4O-MINI ', direction: 'both' });
    expect(upper!.inputTokens).toBe(1000);
    expect(upper!.usd).toBeCloseTo(0.00075, 12);
  });

  it('formats small and ordinary amounts without inventing precision', () => {
    expect(formatUsd(0.00015)).toBe('$0.000150');
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0000001)).toBe('<$0.000001');
    expect(formatUsd(null)).toBe('—');
  });
});
