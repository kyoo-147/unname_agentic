import { describe, expect, it, vi } from 'vitest';
import { TranslationService, countCharacters, type BatchTranslationResult } from '../src/core/translation';
import { defaultSettings, type TextBlock, type TranslationRequest, type TranslationSettings, type TranslationTransport } from '../src/core/types';

const settings: TranslationSettings = { ...defaultSettings, provider: 'openai', apiKey: 'secret', allowCloud: true, model: 'gpt-4o-mini', endpoint: 'https://api.openai.com/v1' };

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

function batchTransport(answer: (blocks: readonly TextBlock[]) => BatchTranslationResult) {
  const calls: TextBlock[][] = [];
  const translateCalls: string[] = [];
  const transport = {
    async translate(request: TranslationRequest) { translateCalls.push(request.text); return `vi:${request.text}`; },
    async translateBatch(blocks: readonly TextBlock[]) {
      calls.push([...blocks]);
      return answer(blocks);
    },
  } satisfies TranslationTransport & { translateBatch(blocks: readonly TextBlock[]): Promise<BatchTranslationResult> };
  return { transport, calls, translateCalls };
}

function echoResult(blocks: readonly TextBlock[], aborted = false): BatchTranslationResult {
  return {
    translations: blocks.map(item => ({ id: item.id, page: item.page, text: `vi:${item.text}`, characterCount: countCharacters(item.text) })),
    requests: 1,
    characterCount: blocks.reduce((sum, item) => sum + countCharacters(item.text), 0),
    aborted,
  };
}

describe('TranslationService.translateBatch', () => {
  it('sends only the blocks that are not cached yet', async () => {
    const { transport, calls, translateCalls } = batchTransport(blocks => echoResult(blocks));
    const service = new TranslationService(transport);

    await service.translate({ text: 'Already known', settings });
    expect(translateCalls).toHaveLength(1);
    expect(calls).toHaveLength(0);

    const result = await service.translateBatch([
      block('b1', 'Fresh one'),
      block('b2', 'Already known'),
      block('b3', 'Fresh two'),
    ], settings);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.map(item => item.id)).toEqual(['b1', 'b3']);
    expect(result.translations.map(item => item.id)).toEqual(['b1', 'b2', 'b3']);
    expect(result.translations.find(item => item.id === 'b2')!.characterCount).toBe(0);
  });

  it('counts characters only for the blocks that actually left the machine', async () => {
    const { transport } = batchTransport(blocks => echoResult(blocks));
    const service = new TranslationService(transport);
    await service.translate({ text: 'Cached sentence', settings });
    const before = service.characterCount;

    const result = await service.translateBatch([block('b1', 'Cached sentence'), block('b2', 'New sentence')], settings);

    expect(result.characterCount).toBe(countCharacters('New sentence'));
    expect(service.characterCount).toBe(before + countCharacters('New sentence'));
  });

  it('remembers batch answers so a second pass sends nothing', async () => {
    const { transport, calls } = batchTransport(blocks => echoResult(blocks));
    const service = new TranslationService(transport);
    const blocks = [block('b1', 'One'), block('b2', 'Two')];

    await service.translateBatch(blocks, settings);
    const second = await service.translateBatch(blocks, settings);

    expect(calls).toHaveLength(1);
    expect(second.requests).toBe(0);
    expect(second.characterCount).toBe(0);
    expect(second.translations.map(item => item.text)).toEqual(['vi:One', 'vi:Two']);
  });

  it('stops before sending anything when the signal is already aborted', async () => {
    const { transport, calls } = batchTransport(blocks => echoResult(blocks));
    const service = new TranslationService(transport);
    const controller = new AbortController();
    controller.abort();

    const result = await service.translateBatch([block('b1', 'Text')], settings, controller.signal);

    expect(result.aborted).toBe(true);
    expect(result.translations).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('reports a partial batch as aborted without inventing translations', async () => {
    const { transport } = batchTransport(blocks => ({ ...echoResult(blocks.slice(0, 1)), aborted: true }));
    const service = new TranslationService(transport);

    const result = await service.translateBatch([block('b1', 'One'), block('b2', 'Two')], settings);

    expect(result.aborted).toBe(true);
    expect(result.translations.map(item => item.id)).toEqual(['b1']);
    expect(result.characterCount).toBe(countCharacters('One'));
  });

  it('falls back to the per-block transport when it cannot batch', async () => {
    let perBlockCalls = 0;
    const transport: TranslationTransport = {
      async translate() { perBlockCalls += 1; return 'translated'; },
    };
    const service = new TranslationService(transport);

    const result = await service.translateBatch([block('b1', 'One'), block('b2', 'Two')], settings);

    expect(perBlockCalls).toBe(2);
    expect(result.translations.map(item => item.text)).toEqual(['translated', 'translated']);
    expect(result.characterCount).toBe(countCharacters('One') + countCharacters('Two'));
  });

  it('keeps the cache separate per target language', async () => {
    const { transport, calls } = batchTransport(blocks => echoResult(blocks));
    const service = new TranslationService(transport);
    const blocks = [block('b1', 'Same text')];

    await service.translateBatch(blocks, settings);
    await service.translateBatch(blocks, { ...settings, targetLanguage: 'en' });

    expect(calls).toHaveLength(2);
  });

  it('never leaks the api key into the cache key', async () => {
    const { transport, calls } = batchTransport(blocks => echoResult(blocks));
    const service = new TranslationService(transport);
    const blocks = [block('b1', 'Text')];

    await service.translateBatch(blocks, settings);
    const second = await service.translateBatch(blocks, { ...settings, apiKey: 'another-secret' });

    expect(calls).toHaveLength(1);
    expect(second.requests).toBe(0);
  });
});
