export interface CaptureParams {
  capture: true;
  sourceTab?: number;
}

export interface DecodedImage {
  mimeType: string;
  bytes: Uint8Array;
}

export interface CaptureRuntime {
  id?: string;
  sendMessage(message: unknown): Promise<unknown>;
}

export interface RequestCaptureOptions {
  runtime?: CaptureRuntime;
  timeoutMs?: number;
}

export type CaptureErrorCode = 'no-extension' | 'expired' | 'invalid-response' | 'timeout';

export class CaptureError extends Error {
  readonly code: CaptureErrorCode;

  constructor(code: CaptureErrorCode, message: string) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
  }
}

const NO_EXTENSION = 'Không tìm thấy tiện ích Mirror PDF. Hãy mở trang này từ tiện ích rồi thử lại.';
const EXPIRED = 'Ảnh chụp đã hết hạn. Hãy chụp lại tab nguồn.';
const INVALID = 'Tiện ích trả về ảnh chụp không hợp lệ.';
const TIMEOUT = 'Tiện ích không phản hồi kịp. Hãy thử chụp lại.';

export function readCaptureParams(search: string): CaptureParams | undefined {
  const query = search.includes('?') ? search.slice(search.indexOf('?') + 1) : search;
  const clean = query.split('#')[0]?.replace(/^\?/, '') ?? '';
  if (!clean) return undefined;
  const params = new URLSearchParams(clean);
  const capture = params.get('capture');
  if (capture !== '1' && capture !== 'true') return undefined;
  const rawSourceTab = params.get('sourceTab');
  const sourceTab = rawSourceTab && /^\d+$/.test(rawSourceTab) ? Number(rawSourceTab) : undefined;
  return { capture: true, ...(sourceTab !== undefined ? { sourceTab } : {}) };
}

function runtimeFromGlobal(): CaptureRuntime | undefined {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) return undefined;
  return {
    id: chrome.runtime.id,
    sendMessage: message => chrome.runtime.sendMessage(message),
  };
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) throw new CaptureError('invalid-response', INVALID);
  let binary: string;
  try {
    if (typeof atob !== 'function') throw new Error('atob unavailable');
    binary = atob(normalized);
  } catch {
    throw new CaptureError('invalid-response', INVALID);
  }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (!bytes.length) throw new CaptureError('invalid-response', INVALID);
  return bytes;
}

export function decodeDataUrl(dataUrl: string): DecodedImage {
  if (typeof dataUrl !== 'string') throw new CaptureError('invalid-response', INVALID);
  const match = /^data:(image\/(?:png|jpe?g|webp|bmp));base64,([\s\S]+)$/i.exec(dataUrl.trim());
  if (!match) throw new CaptureError('invalid-response', INVALID);
  return { mimeType: match[1]!.toLowerCase(), bytes: decodeBase64(match[2]!) };
}

function errorCodeFor(message: string): CaptureErrorCode {
  if (/receiving end does not exist|could not establish connection|extension context invalidated|message port closed/i.test(message)) return 'no-extension';
  if (/expired|hết hạn/i.test(message)) return 'expired';
  return 'invalid-response';
}

function messageFor(code: CaptureErrorCode, detail?: string): string {
  if (code === 'no-extension') return NO_EXTENSION;
  if (code === 'expired') return EXPIRED;
  if (code === 'timeout') return TIMEOUT;
  return detail ? `${INVALID} ${detail}`.trim() : INVALID;
}

function asOptions(value: RequestCaptureOptions | CaptureRuntime | undefined): RequestCaptureOptions {
  if (!value) return {};
  if (typeof (value as CaptureRuntime).sendMessage === 'function') return { runtime: value as CaptureRuntime };
  return value as RequestCaptureOptions;
}

export async function requestCaptureImage(options: RequestCaptureOptions | CaptureRuntime = {}): Promise<string> {
  const { runtime: provided, timeoutMs = 15_000 } = asOptions(options);
  const runtime = provided ?? runtimeFromGlobal();
  if (!runtime) throw new CaptureError('no-extension', NO_EXTENSION);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      runtime.sendMessage({ type: 'mirror:get-capture' }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CaptureError('timeout', TIMEOUT)), timeoutMs);
      }),
    ]);
    if (!response || typeof response !== 'object') throw new CaptureError('invalid-response', INVALID);
    const result = response as Record<string, unknown>;
    if (result.ok === false) {
      const detail = typeof result.error === 'string' ? result.error : '';
      const code = errorCodeFor(detail);
      throw new CaptureError(code, messageFor(code, detail));
    }
    if (result.ok !== true || typeof result.image !== 'string') throw new CaptureError('invalid-response', INVALID);
    decodeDataUrl(result.image);
    return result.image;
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    const code = errorCodeFor(detail);
    throw new CaptureError(code, messageFor(code, detail));
  } finally {
    if (timer) clearTimeout(timer);
  }
}
