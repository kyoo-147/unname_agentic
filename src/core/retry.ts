export type TranslationErrorKind = 'auth' | 'quota' | 'network' | 'invalid' | 'empty' | 'aborted' | 'unknown';

const DEFAULT_RETRYABLE: Record<TranslationErrorKind, boolean> = {
  auth: false,
  quota: true,
  network: true,
  invalid: false,
  empty: false,
  aborted: false,
  unknown: true,
};

const DEFAULT_MESSAGE: Record<TranslationErrorKind, string> = {
  auth: 'Translation credentials were rejected.',
  quota: 'Translation quota or rate limit was exceeded.',
  network: 'The translation service could not be reached.',
  invalid: 'The translation service rejected the request.',
  empty: 'The translation service returned no translated text.',
  aborted: 'Translation was aborted.',
  unknown: 'Translation failed.',
};

const USER_MESSAGE: Record<TranslationErrorKind, string> = {
  auth: 'API key không hợp lệ hoặc chưa được cấp quyền. Kiểm tra lại khoá trong phần cài đặt dịch.',
  quota: 'Đã hết hạn mức hoặc bị giới hạn tốc độ. Thử lại sau ít phút hoặc kiểm tra hạn mức nhà cung cấp.',
  network: 'Không kết nối được tới dịch vụ dịch. Kiểm tra mạng rồi thử lại.',
  invalid: 'Yêu cầu dịch không hợp lệ. Kiểm tra lại ngôn ngữ và địa chỉ máy chủ đã chọn.',
  empty: 'Dịch vụ trả về bản dịch rỗng. Thử lại hoặc đổi nhà cung cấp.',
  aborted: 'Đã huỷ bản dịch.',
  unknown: 'Dịch không thành công. Thử lại sau.',
};

export interface TranslationErrorOptions {
  cause?: unknown;
  status?: number;
  retryable?: boolean;
  userMessage?: string;
}

export class TranslationError extends Error {
  readonly kind: TranslationErrorKind;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly status?: number;

  constructor(kind: TranslationErrorKind, message: string = DEFAULT_MESSAGE[kind], options: TranslationErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TranslationError';
    this.kind = kind;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[kind];
    this.userMessage = options.userMessage ?? USER_MESSAGE[kind];
    if (options.status !== undefined) this.status = options.status;
  }
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export function abortError(cause?: unknown): TranslationError {
  return new TranslationError('aborted', DEFAULT_MESSAGE.aborted, { cause });
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onRetry?: (error: TranslationError, attempt: number, delayMs: number) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal.reason);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizedFailure(error: unknown): TranslationError {
  if (error instanceof TranslationError) return error;
  if (isAbortError(error)) return abortError(error);
  return new TranslationError('unknown', error instanceof Error ? error.message : DEFAULT_MESSAGE.unknown, { cause: error });
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TranslationError('invalid', 'maxAttempts must be a positive integer.');
  }
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 500);
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? 30_000);
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    throwIfAborted(options.signal);
    try {
      return await fn();
    } catch (error) {
      const failure = normalizedFailure(error);
      if (options.signal?.aborted || failure.kind === 'aborted') throw abortError(error);
      if (attempt >= maxAttempts || !failure.retryable) throw failure;
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const half = exponential / 2;
      const jitter = Math.min(1, Math.max(0, random()));
      const delayMs = Math.round(half + jitter * half);
      options.onRetry?.(failure, attempt, delayMs);
      if (options.sleep) {
        await options.sleep(delayMs);
        throwIfAborted(options.signal);
      } else {
        await wait(delayMs, options.signal);
      }
    }
  }
}
