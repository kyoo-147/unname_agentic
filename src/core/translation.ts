import { assertCanSend, effectiveEndpoint, privacyPolicy, type PrivacyMode } from './privacy';
import { buildMessages, buildProtectedMessages, buildSystemPrompt, restoreProtectedText, type ChatMessage, type PromptOptions } from './prompt';
import { normalizeLanguageCode } from './language';
import { TranslationError, abortError, isAbortError, withRetry, type RetryOptions } from './retry';
import type { ProviderKind, TextBlock, TranslationRequest, TranslationResult, TranslationSettings, TranslationTransport } from './types';

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

function promptOptions(settings: TranslationSettings): PromptOptions {
  return {
    source: normalizeLanguageCode(settings.sourceLanguage),
    target: normalizeLanguageCode(settings.targetLanguage),
    glossary: Object.entries(settings.glossary).map(([source, target]) => ({ source, target })),
    promptVersion: settings.promptVersion,
  };
}

interface ProviderRequest {
  url: URL;
  headers: Record<string, string>;
  payload: string;
}

/**
 * Builds a provider request for one prompt. `translate` passes a single
 * document text; `translateBatch` passes the JSON batch envelope together with
 * the batch messages. Only the OpenAI-compatible branch reads `messages`, so a
 * batch can reuse the very same branch for `openai` and `local`; Google and
 * DeepL build their body from `text` and are never batched (see
 * {@link supportsBatch}). Keeping the four branches here means the consent
 * gate, endpoint validation, headers, and bodies exist once.
 */
function providerRequest(settings: TranslationSettings, text: string, messages: readonly ChatMessage[]): ProviderRequest {
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
    body = { model: settings.model, temperature: 0, messages };
  }
  return { url, headers, payload: JSON.stringify(body) };
}

interface ProviderResponse {
  data?: { translations?: { translatedText?: string }[] };
  translations?: { text?: string }[];
  choices?: { message?: { content?: string } }[];
}

function providerText(settings: TranslationSettings, data: unknown): string | undefined {
  const result = data as ProviderResponse;
  const translated = settings.provider === 'google'
    ? result.data?.translations?.[0]?.translatedText
    : settings.provider === 'deepl'
      ? result.translations?.[0]?.text
      : result.choices?.[0]?.message?.content;
  return typeof translated === 'string' ? translated : undefined;
}

function translatedText(settings: TranslationSettings, data: unknown): string {
  const text = providerText(settings, data);
  if (typeof text !== 'string') throw new TranslationError('invalid', 'The translation service response did not contain translated text.');
  return text;
}

async function send(fetcher: Fetcher, retryOptions: RetryOptions, request: ProviderRequest, signal?: AbortSignal): Promise<Response> {
  return withRetry(async () => {
    let result: Response;
    try {
      result = await fetcher(request.url, { method: 'POST', headers: request.headers, body: request.payload, signal });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw abortError(error);
      throw new TranslationError('network', 'The translation service could not be reached.', { cause: error });
    }
    if (!result.ok) throw httpError(result.status);
    return result;
  }, { ...retryOptions, signal });
}

/**
 * Waits for `promise`, or rejects with an abort error as soon as `signal`
 * fires. The shared provider call keeps running for the callers that still wait
 * on it, so one caller's cancellation never turns another caller's request into
 * a failure — the aborted caller simply stops waiting.
 */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal.reason));
    // Attach to `promise` first: an abort that fired while the provider call
    // was being issued must not leave that call's rejection unobserved.
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** True when `error` is this signal's own abort or an abort a transport raised. */
function abortedBy(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || isAbortError(error) || (error instanceof TranslationError && error.kind === 'aborted');
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new TranslationError('invalid', 'The translation service returned an unreadable response.', { cause: error, status: response.status });
  }
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

/** One translated block, still carrying its source id and page. */
export interface BatchTranslationEntry {
  id: string;
  page: number;
  text: string;
  characterCount: number;
}

export interface BatchTranslationResult {
  /** Translated blocks in the same order they were passed in. */
  translations: BatchTranslationEntry[];
  /** Provider calls attempted, not chunks attempted: a per-block provider spends one per block. */
  requests: number;
  /** Source characters actually translated, so an aborted batch never over-reports quota use. */
  characterCount: number;
  /** True when the signal stopped the batch; `translations` then holds the finished chunks. */
  aborted: boolean;
}

export interface TranslationTransportWithBatch extends TranslationTransport {
  /**
   * Translates a document's blocks in chunks.
   *
   * - OpenAI-compatible and local prompt providers get one request per chunk
   *   of {@link chunkBlocks}; the model receives a JSON array of `{id, text}`
   *   and returns the same ids, so answers are mapped back by id rather than
   *   by position. Order is always the input order.
   * - Google v2 and DeepL get one request per block, because this client
   *   sends them a single text field per request and has no envelope to carry
   *   block ids (see {@link supportsBatch}).
   * - An abort stops before the next request and resolves with the blocks
   *   already translated plus `aborted: true`; nothing is invented for the
   *   remaining blocks.
   * - A batch response that cannot be mapped to every requested id throws
   *   instead of returning a partial success. The caller keeps the previous
   *   translations and can retry.
   */
  translateBatch(blocks: readonly TextBlock[], settings: TranslationSettings, signal?: AbortSignal): Promise<BatchTranslationResult>;
}

/**
 * Batching is a prompt-level capability here: only the providers that accept a
 * chat prompt can take several blocks at once. Google v2 and DeepL are called
 * with one text field per request, so they stay on the per-block path.
 */
export function supportsBatch(provider: ProviderKind): boolean {
  return provider === 'openai' || provider === 'local';
}

const BATCH_RULES = [
  'Batch input: the user message is a JSON array of objects with "id" and "text" keys.',
  'Translate every "text" value and keep every "id" unchanged.',
  'Return only a JSON array of objects with the same ids in the same order: [{"id": "...", "text": "..."}].',
  'Do not add code fences, commentary, or any other keys. These rules replace the single-text return rule for this request.',
].join('\n');

function batchMessages(blocks: readonly TextBlock[], options: PromptOptions): ChatMessage[] {
  return [
    { role: 'system', content: `${buildSystemPrompt(options)}\n\n${BATCH_RULES}` },
    { role: 'user', content: JSON.stringify(blocks.map(block => ({ id: block.id, text: block.text }))) },
  ];
}

interface BatchEntry {
  id: string;
  text: string;
}

function parseBatchContent(content: string): BatchEntry[] | undefined {
  const unfenced = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data: unknown;
  try {
    data = JSON.parse(unfenced);
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  const entries: BatchEntry[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) return undefined;
    const entry = item as { id?: unknown; text?: unknown };
    if (typeof entry.id !== 'string' || typeof entry.text !== 'string') return undefined;
    entries.push({ id: entry.id, text: entry.text });
  }
  return entries;
}

function matchBatch(chunk: readonly TextBlock[], entries: readonly BatchEntry[]): Map<string, string> {
  const answers = new Map<string, string>();
  for (const entry of entries) if (!answers.has(entry.id)) answers.set(entry.id, entry.text);
  const matched = new Map<string, string>();
  const missing: string[] = [];
  for (const block of chunk) {
    const answer = answers.get(block.id);
    if (answer === undefined) missing.push(block.id);
    else matched.set(block.id, answer);
  }
  if (missing.length > 0) throw invalid(`The batch translation response did not include ${missing.length} of ${chunk.length} requested blocks.`);
  return matched;
}

export interface TransportPrivacyOptions { privacyMode?: PrivacyMode | (() => PrivacyMode); }

export function createTranslationTransport(fetcher: Fetcher = fetch, retryOptions: RetryOptions = {}, privacy: TransportPrivacyOptions = {}): TranslationTransportWithBatch {
  // Default 'ask' keeps every historical caller behaving exactly as before.
  const modeNow = (): PrivacyMode => (typeof privacy.privacyMode === 'function' ? privacy.privacyMode() : privacy.privacyMode) ?? 'ask';
  const guard = (settings: TranslationSettings): void => {
    const policy = privacyPolicy(modeNow(), effectiveEndpoint(settings));
    assertCanSend(policy, settings);
  };
  const translate = async ({ text, settings, signal }: TranslationRequest): Promise<string> => {
    // An aborted translation never reaches the provider, not even to build a
    // body: the signal is the caller's statement that the answer is not wanted.
    if (signal?.aborted) throw abortError(signal.reason);
    // Privacy first: a refusal here means no request is even built, so no
    // provider, key or body can leak past an offline policy.
    guard(settings);
    // Protect numbers, URLs, citations and formulas before the text leaves the
    // app: a translator must not be able to rewrite them.
    const protectedText = buildProtectedMessages(text, promptOptions(settings));
    const request = providerRequest(settings, text, protectedText.messages);
    const response = await send(fetcher, retryOptions, request, signal);
    // A fetch implementation that ignores its signal can still answer after the
    // abort; the single-text path has no partial-result contract, so a result
    // nobody waits for is reported as the abort it is. Batches keep their
    // finished chunks instead, see `translateBatch`.
    if (signal?.aborted) throw abortError(signal.reason);
    const data = await readJson(response);
    const raw = translatedText(settings, data).trim();
    if (!raw) throw new TranslationError('empty', 'Translation service returned no translated text.');
    const restored = restoreProtectedText(raw, protectedText.tokens);
    if (restored.missing.length > 0 || restored.duplicated.length > 0) {
      throw new TranslationError('invalid', `The translator changed ${restored.missing.length + restored.duplicated.length} protected placeholder(s).`);
    }
    const trimmed = restored.text.trim();
    if (!trimmed) throw new TranslationError('empty', 'Translation service returned no translated text.');
    return trimmed;
  };

  const translateBatch = async (blocks: readonly TextBlock[], settings: TranslationSettings, signal?: AbortSignal): Promise<BatchTranslationResult> => {
    const result: BatchTranslationResult = { translations: [], requests: 0, characterCount: 0, aborted: false };
    if (signal?.aborted) return { ...result, aborted: true };
    if (blocks.length === 0) return result;
    // The batch path is refused on the same policy before its first chunk is built.
    guard(settings);

    if (!supportsBatch(settings.provider)) {
      for (const block of blocks) {
        if (signal?.aborted) return { ...result, aborted: true };
        result.requests += 1;
        let text: string;
        try {
          text = await translate({ text: block.text, settings, signal });
        } catch (error) {
          if (error instanceof TranslationError && error.kind === 'aborted') return { ...result, aborted: true };
          throw error;
        }
        result.translations.push({ id: block.id, page: block.page, text, characterCount: countCharacters(block.text) });
        result.characterCount += countCharacters(block.text);
      }
      return result;
    }

    const options = promptOptions(settings);
    for (const chunk of chunkBlocks(blocks)) {
      if (signal?.aborted) return { ...result, aborted: true };
      const messages = batchMessages(chunk, options);
      const request = providerRequest(settings, messages[1]?.content ?? '', messages);
      result.requests += 1;
      try {
        const response = await send(fetcher, retryOptions, request, signal);
        const data = await readJson(response);
        const entries = parseBatchContent(translatedText(settings, data));
        if (!entries) throw invalid('The batch translation response was not a JSON array of {"id","text"} entries.');
        const matched = matchBatch(chunk, entries);
        for (const block of chunk) {
          const text = matched.get(block.id)!.trim();
          if (!text) throw new TranslationError('empty', 'Translation service returned no translated text.');
          result.translations.push({ id: block.id, page: block.page, text, characterCount: countCharacters(block.text) });
        }
        for (const block of chunk) result.characterCount += countCharacters(block.text);
      } catch (error) {
        if (error instanceof TranslationError && error.kind === 'aborted') return { ...result, aborted: true };
        throw error;
      }
    }
    return result;
  };

  return { translate, translateBatch };
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
    const signal = request.signal;
    if (signal?.aborted) throw abortError(signal.reason);
    const key = this.keyFor(request.text, request.settings);
    const cached = this.cache.get(key);
    if (cached !== undefined) return { text: cached, provider: request.settings.provider, cached: true, characterCount: countCharacters(request.text) };
    const existing = this.pending.get(key);
    let promise = existing?.signal?.aborted ? undefined : existing?.promise;
    if (!promise) {
      promise = this.transport.translate(request).then(text => {
        if (!text.trim()) throw new TranslationError('empty', 'Translation service returned no translated text.');
        // A cancelled request must not teach the cache: the caller stopped
        // waiting, so a late provider answer is stale by definition.
        if (signal?.aborted) throw abortError(signal.reason);
        this.characters += countCharacters(request.text);
        this.cache.set(key, text);
        if (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
        return text;
      }).finally(() => { if (this.pending.get(key)?.promise === promise) this.pending.delete(key); });
      this.pending.set(key, { promise, signal });
    }
    // The caller stops waiting the moment its signal fires, even when the
    // transport cannot cancel an in-flight provider request itself.
    const text = await withAbort(promise, signal);
    if (signal?.aborted) throw abortError(signal.reason);
    return { text, provider: request.settings.provider, cached: false, characterCount: countCharacters(request.text) };
  }

  clear(): void { this.cache.clear(); }

  private keyFor(text: string, settings: TranslationSettings): string {
    const { apiKey: _key, ...identity } = settings;
    return JSON.stringify([text, identity]);
  }

  private remember(text: string, settings: TranslationSettings, translation: string): void {
    this.cache.set(this.keyFor(text, settings), translation);
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
  }

  /**
   * Translates a page worth of blocks with as few provider calls as the provider
   * allows, sharing the cache and the character counter with {@link translate}.
   *
   * Cached blocks are resolved locally and never sent again, so the returned
   * `characterCount` counts only characters that actually left the machine —
   * which is what the status bar and the cost estimate must report. A transport
   * without batching still works: the blocks go out one at a time, through the
   * same cache.
   */
  async translateBatch(blocks: readonly TextBlock[], settings: TranslationSettings, signal?: AbortSignal): Promise<BatchTranslationResult> {
    const result: BatchTranslationResult = { translations: [], requests: 0, characterCount: 0, aborted: false };
    if (signal?.aborted) { result.aborted = true; return result; }
    const collected = new Map<string, BatchTranslationEntry>();
    const missing: TextBlock[] = [];
    for (const block of blocks) {
      const cached = this.cache.get(this.keyFor(block.text, settings));
      if (cached !== undefined) collected.set(block.id, { id: block.id, page: block.page, text: cached, characterCount: 0 });
      else missing.push(block);
    }
    const finish = (): BatchTranslationResult => ({ ...result, translations: blocks.flatMap(block => { const entry = collected.get(block.id); return entry ? [entry] : []; }) });
    if (!missing.length) return finish();
    const transport = this.transport as TranslationTransport & Partial<TranslationTransportWithBatch>;
    if (typeof transport.translateBatch !== 'function') {
      for (const block of missing) {
        if (signal?.aborted) { result.aborted = true; break; }
        // A transport that cannot cancel may still reject with the abort; that
        // is a cancellation, not a provider failure the caller should see.
        const translated = await this.translate({ text: block.text, settings, signal }).catch(error => {
          if (abortedBy(error, signal)) return undefined;
          throw error;
        });
        if (!translated) { result.aborted = true; break; }
        const sent = translated.cached ? 0 : countCharacters(block.text);
        if (!translated.cached) result.requests += 1;
        result.characterCount += sent;
        collected.set(block.id, { id: block.id, page: block.page, text: translated.text, characterCount: sent });
      }
      return finish();
    }
    const batch = await transport.translateBatch(missing, settings, signal).catch(error => {
      if (abortedBy(error, signal)) return undefined;
      throw error;
    });
    result.requests = batch?.requests ?? 0;
    // Anything the provider finished after the abort is stale: the caller has
    // already stopped waiting, so it must neither enter the cache nor be
    // reported as a translation. Blocks resolved from the cache before the
    // abort stay, because they were never in flight.
    if (!batch || signal?.aborted) { result.aborted = true; return finish(); }
    const sourceById = new Map(missing.map(block => [block.id, block.text]));
    for (const entry of batch.translations) {
      const source = sourceById.get(entry.id);
      if (source === undefined) continue;
      const sent = countCharacters(source);
      this.characters += sent;
      this.remember(source, settings, entry.text);
      result.characterCount += sent;
      collected.set(entry.id, { id: entry.id, page: entry.page, text: entry.text, characterCount: sent });
    }
    result.aborted = batch.aborted;
    return finish();
  }
}
