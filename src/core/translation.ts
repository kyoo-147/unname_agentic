import type { TextBlock, TranslationRequest, TranslationResult, TranslationTransport } from './types';
import { buildMessages } from './prompt';
import { normalizeLanguageCode } from './language';
import { TranslationError, abortError, isAbortError, withRetry, type RetryOptions } from './retry';

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function countCharacters(text: string): number {
  return Array.from(text).length;
}

function invalid(message: string, cause?: unknown): TranslationError {
  return new TranslationError('invalid', message, { cause });
}

function endpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw invalid('Translation endpoint is not a valid URL.', error);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw invalid('Only HTTP translation endpoints are supported.');
  return url;
}

function isLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function httpError(status: number): TranslationError {
  if (status === 401 || status === 403) return new TranslationError('auth', `Translation credentials were rejected (HTTP ${status}). Check your API key.`, { status });
  if (status === 402 || status === 456) return new TranslationError('quota', `Translation quota is exhausted (HTTP ${status}).`, { status, retryable: false });
  if (status === 429) return new TranslationError('quota', `Translation rate limit was exceeded (HTTP ${status}).`, { status });
  if (status === 408 || status === 425 || status >= 500) return new TranslationError('network', `The translation service could not be reached (HTTP ${status}).`, { status });
  return new TranslationError('invalid', `The translation service rejected the request (HTTP ${status}).`, { status });
}

function googleBody(text: string, sourceLanguage: string, targetLanguage: string): unknown {
  return { q: text, target: targetLanguage, format: 'text', ...(sourceLanguage !== 'auto' ? { source: sourceLanguage } : {}) };
}

function deeplBody(text: string, sourceLanguage: string, targetLanguage: string): unknown {
  return { text: [text], target_lang: targetLanguage.toUpperCase(), ...(sourceLanguage !== 'auto' ? { source_lang: sourceLanguage.toUpperCase() } : {}) };
}

export function chunkBlocks(blocks: readonly TextBlock[], maxChars = 3500): TextBlock[][] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw invalid('maxChars must be a positive integer.');
  const chunks: TextBlock[][] = [];
  let current: TextBlock[] = [];
  let size = 0;
  for (const block of blocks) {
    const length = countCharacters(block.text);
    if (current.length > 0 && size + length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(block);
    size += length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function createTranslationTransport(fetcher: Fetcher = fetch, retryOptions: RetryOptions = {}): TranslationTransport {
  return {
    async translate({ text, settings, signal }: TranslationRequest): Promise<string> {
      const local = settings.provider === 'local';
      if (!local && !settings.allowCloud) {
        throw new TranslationError('auth', 'Cloud translation is disabled. Enable cloud consent in settings.', {
          userMessage: 'Bạn chưa cho phép gửi văn bản lên đám mây. Bật quyền này trong phần cài đặt dịch.',
        });
      }
      const sourceLanguage = normalizeLanguageCode(settings.sourceLanguage);
      const targetLanguage = normalizeLanguageCode(settings.targetLanguage);
      let url: URL;
      let body: unknown;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (settings.provider === 'google') {
        if (!settings.apiKey) throw new TranslationError('auth', 'Google Cloud Translation requires an API key.');
        url = endpoint('https://translation.googleapis.com/language/translate/v2');
        headers['X-Goog-Api-Key'] = settings.apiKey;
        body = googleBody(text, sourceLanguage, targetLanguage);
      } else if (settings.provider === 'deepl') {
        if (!settings.apiKey) throw new TranslationError('auth', 'DeepL requires an API key.');
        url = endpoint(settings.endpoint && settings.endpoint.includes('deepl.com') ? settings.endpoint : 'https://api-free.deepl.com/v2/translate');
        if (!['api.deepl.com', 'api-free.deepl.com'].includes(url.hostname) || url.protocol !== 'https:' || url.pathname !== '/v2/translate' || url.username || url.password) {
          throw invalid('DeepL endpoint must be https://api.deepl.com/v2/translate or https://api-free.deepl.com/v2/translate.');
        }
        headers.Authorization = `DeepL-Auth-Key ${settings.apiKey}`;
        body = deeplBody(text, sourceLanguage, targetLanguage);
      } else {
        url = endpoint(`${settings.endpoint.replace(/\/$/, '')}/chat/completions`);
        if (local && !isLoopback(url)) throw invalid('Local provider must use a loopback endpoint. Choose OpenAI-compatible for remote servers.');
        if (!local && !settings.apiKey) throw new TranslationError('auth', 'OpenAI-compatible translation requires an API key.');
        if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
        const glossary = Object.entries(settings.glossary).map(([source, target]) => ({ source, target }));
        body = {
          model: settings.model,
          temperature: 0,
          messages: buildMessages(text, { source: sourceLanguage, target: targetLanguage, glossary, promptVersion: settings.promptVersion }),
        };
      }
      const payload = JSON.stringify(body);
      const response = await withRetry(async () => {
        let result: Response;
        try {
          result = await fetcher(url, { method: 'POST', headers, body: payload, signal });
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) throw abortError(error);
          throw new TranslationError('network', 'The translation service could not be reached.', { cause: error });
        }
        if (!result.ok) throw httpError(result.status);
        return result;
      }, { ...retryOptions, signal });
      let data: unknown;
      try {
        data = await response.json();
      } catch (error) {
        throw new TranslationError('invalid', 'The translation service returned an unreadable response.', { cause: error, status: response.status });
      }
      const result = data as { data?: { translations?: { translatedText?: string }[] }; translations?: { text?: string }[]; choices?: { message?: { content?: string } }[] };
      const translated = settings.provider === 'google'
        ? result.data?.translations?.[0]?.translatedText
        : settings.provider === 'deepl'
          ? result.translations?.[0]?.text
          : result.choices?.[0]?.message?.content;
      if (typeof translated !== 'string') throw new TranslationError('invalid', 'The translation service response did not contain translated text.');
      const trimmed = translated.trim();
      if (!trimmed) throw new TranslationError('empty', 'Translation service returned no translated text.');
      return trimmed;
    },
  };
}

export class TranslationService {
  private readonly cache = new Map<string, string>();
  private readonly pending = new Map<string, { promise: Promise<string>; signal?: AbortSignal }>();
  private characters = 0;

  constructor(private readonly transport: TranslationTransport, private readonly maxEntries = 3000) {}

  get characterCount(): number {
    return this.characters;
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    if (request.signal?.aborted) throw abortError(request.signal.reason);
    const { apiKey: _key, ...identity } = request.settings;
    const key = JSON.stringify([request.text, identity]);
    const cached = this.cache.get(key);
    if (cached !== undefined) return { text: cached, provider: request.settings.provider, cached: true, characterCount: countCharacters(request.text) };
    const existing = this.pending.get(key);
    let promise = existing?.signal?.aborted ? undefined : existing?.promise;
    if (!promise) {
      promise = this.transport.translate(request).then(text => {
        if (!text.trim()) throw new TranslationError('empty', 'Translation service returned no translated text.');
        this.characters += countCharacters(request.text);
        this.cache.set(key, text);
        if (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
        return text;
      }).finally(() => { if (this.pending.get(key)?.promise === promise) this.pending.delete(key); });
      this.pending.set(key, { promise, signal: request.signal });
    }
    const text = await promise;
    if (request.signal?.aborted) throw abortError(request.signal.reason);
    return { text, provider: request.settings.provider, cached: false, characterCount: countCharacters(request.text) };
  }

  clear(): void { this.cache.clear(); }
}
