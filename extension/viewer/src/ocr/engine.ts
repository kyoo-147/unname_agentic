import Tesseract from 'tesseract.js';

export interface OcrBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: OcrBbox;
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: OcrBbox;
  words: OcrWord[];
}

export interface OcrResult {
  text: string;
  words: OcrWord[];
  lines: OcrLine[];
  width: number;
  height: number;
}

export interface OcrProgress {
  status: string;
  progress: number;
}

export type OcrImage = Blob | string | ImageData;

export interface OcrRecognizeOptions {
  languages?: string[];
  signal?: AbortSignal;
  onProgress?: (progress: OcrProgress) => void;
}

export interface OcrEngine {
  recognize(image: OcrImage, options?: OcrRecognizeOptions): Promise<OcrResult>;
}

export interface OcrAssetOptions {
  workerPath?: string;
  corePath?: string;
  langPath?: string;
  gzip?: boolean;
}

export interface TesseractEngineOptions {
  languages?: string[];
  assets?: OcrAssetOptions;
  onProgress?: (progress: OcrProgress) => void;
}

export const DEFAULT_OCR_LANGUAGES = ['eng', 'vie'] as const;

const DEFAULT_LANGUAGE_LIST = [...DEFAULT_OCR_LANGUAGES];

export class OcrError extends Error {
  readonly code: 'unsupported-image' | 'empty-result' | 'engine-failed' | 'unavailable';

  constructor(code: OcrError['code'], message: string) {
    super(message);
    this.name = 'OcrError';
    this.code = code;
  }
}

export function isImageData(value: unknown): value is ImageData {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ImageData>;
  return candidate.data instanceof Uint8ClampedArray
    && Number.isInteger(candidate.width)
    && Number.isInteger(candidate.height)
    && (candidate.width ?? 0) > 0
    && (candidate.height ?? 0) > 0
    && candidate.data.length === (candidate.width ?? 0) * (candidate.height ?? 0) * 4;
}

function abortError(): Error {
  return typeof DOMException === 'function'
    ? new DOMException('Đã huỷ nhận dạng ảnh.', 'AbortError')
    : Object.assign(new Error('Đã huỷ nhận dạng ảnh.'), { name: 'AbortError' });
}

function assetBaseUrl(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  try {
    return new URL('ocr/', document.baseURI).href;
  } catch {
    return undefined;
  }
}

function resolveAssets(assets: OcrAssetOptions = {}): Required<OcrAssetOptions> & { localWorker: boolean } {
  const base = assetBaseUrl();
  const workerPath = assets.workerPath ?? (base ? `${base}worker.min.js` : '');
  return {
    workerPath,
    corePath: assets.corePath ?? (base ? base : ''),
    langPath: assets.langPath ?? (base ? base.replace(/\/$/, '') : ''),
    gzip: assets.gzip ?? false,
    localWorker: Boolean(workerPath),
  };
}

async function toBlob(image: OcrImage): Promise<Blob | undefined> {
  if (typeof Blob !== 'undefined' && image instanceof Blob) return image;
  if (typeof image !== 'string') return undefined;
  if (typeof fetch !== 'function') return undefined;
  const response = await fetch(image);
  if (!response.ok) return undefined;
  return response.blob();
}

async function measureImage(image: OcrImage): Promise<{ width: number; height: number }> {
  if (isImageData(image)) return { width: image.width, height: image.height };
  try {
    const blob = await toBlob(image);
    if (!blob || typeof createImageBitmap !== 'function') return { width: 0, height: 0 };
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: 0, height: 0 };
  }
}

async function imageForTesseract(image: OcrImage): Promise<string | Blob> {
  if (!isImageData(image)) return image;
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    if (context) {
      context.putImageData(image, 0, 0);
      return canvas.convertToBlob({ type: 'image/png' });
    }
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (context) {
      context.putImageData(image, 0, 0);
      return canvas.toDataURL('image/png');
    }
  }
  throw new OcrError('unsupported-image', 'Trình duyệt này không chuyển được ảnh sang định dạng OCR đọc được.');
}

function finiteConfidence(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function collectResult(data: Tesseract.Page, size: { width: number; height: number }): OcrResult {
  const words: OcrWord[] = [];
  const lines: OcrLine[] = [];
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const lineWords: OcrWord[] = [];
        for (const word of line.words ?? []) {
          const text = word.text?.trim() ?? '';
          if (!text) continue;
          const entry: OcrWord = {
            text,
            confidence: finiteConfidence(word.confidence),
            bbox: { x0: word.bbox.x0, y0: word.bbox.y0, x1: word.bbox.x1, y1: word.bbox.y1 },
          };
          lineWords.push(entry);
          words.push(entry);
        }
        if (!lineWords.length) continue;
        lines.push({
          text: line.text?.trim() || lineWords.map(word => word.text).join(' '),
          confidence: finiteConfidence(line.confidence),
          bbox: { x0: line.bbox.x0, y0: line.bbox.y0, x1: line.bbox.x1, y1: line.bbox.y1 },
          words: lineWords,
        });
      }
    }
  }
  return { text: data.text ?? '', words, lines, width: size.width, height: size.height };
}

export function createTesseractEngine(options: TesseractEngineOptions = {}): OcrEngine {
  const engineLanguages = options.languages?.length ? [...options.languages] : DEFAULT_LANGUAGE_LIST;
  return {
    async recognize(image, recognizeOptions = {}) {
      const signal = recognizeOptions.signal;
      signal?.throwIfAborted();
      const languages = recognizeOptions.languages?.length ? recognizeOptions.languages : engineLanguages;
      const assets = resolveAssets(options.assets);
      const report = (message: { status?: string; progress?: number }) => {
        const progress = {
          status: message.status ?? 'recognizing text',
          progress: Number.isFinite(message.progress) ? Math.max(0, Math.min(1, message.progress ?? 0)) : 0,
        };
        options.onProgress?.(progress);
        recognizeOptions.onProgress?.(progress);
      };
      let worker: Awaited<ReturnType<typeof Tesseract.createWorker>> | undefined;
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        void worker?.terminate().catch(() => {});
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        try {
          worker = await Tesseract.createWorker(languages.join('+'), Tesseract.OEM.LSTM_ONLY, {
            ...(assets.workerPath ? { workerPath: assets.workerPath } : {}),
            ...(assets.corePath ? { corePath: assets.corePath } : {}),
            ...(assets.langPath ? { langPath: assets.langPath } : {}),
            ...(assets.localWorker ? { workerBlobURL: false } : {}),
            gzip: assets.gzip,
            cacheMethod: 'write',
            logger: report,
            errorHandler: error => console.warn('Mirror OCR', error),
          });
        } catch (error) {
          if (aborted || signal?.aborted) throw abortError();
          throw new OcrError(
            'unavailable',
            `Local Tesseract OCR is unavailable for ${languages.join('+')}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (aborted) throw abortError();
        signal?.throwIfAborted();
        const [tesseractImage, size] = await Promise.all([imageForTesseract(image), measureImage(image)]);
        signal?.throwIfAborted();
        const result = await worker.recognize(tesseractImage, {}, { text: true, blocks: true });
        if (aborted) throw abortError();
        return collectResult(result.data, size);
      } catch (error) {
        if (aborted || signal?.aborted) throw abortError();
        throw error;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        await worker?.terminate().catch(() => {});
      }
    },
  };
}

export interface FakeEngineCall {
  image: OcrImage;
  languages: string[];
}

export interface FakeEngineOptions {
  delayMs?: number;
  failWith?: Error;
}

type FakeResult = OcrResult | ((image: OcrImage, options: OcrRecognizeOptions) => OcrResult | Promise<OcrResult>);

const EMPTY_RESULT: OcrResult = { text: '', words: [], lines: [], width: 0, height: 0 };

export class FakeEngine implements OcrEngine {
  readonly calls: FakeEngineCall[] = [];

  constructor(private readonly result: FakeResult = EMPTY_RESULT, private readonly options: FakeEngineOptions = {}) {}

  async recognize(image: OcrImage, options: OcrRecognizeOptions = {}): Promise<OcrResult> {
    options.signal?.throwIfAborted();
    const languages = options.languages?.length ? options.languages : DEFAULT_LANGUAGE_LIST;
    this.calls.push({ image, languages });
    options.onProgress?.({ status: 'recognizing text', progress: 0.5 });
    await this.wait(options.signal);
    options.signal?.throwIfAborted();
    if (this.options.failWith) throw this.options.failWith;
    const result = typeof this.result === 'function' ? await this.result(image, options) : this.result;
    options.onProgress?.({ status: 'recognizing text', progress: 1 });
    return result;
  }

  private wait(signal?: AbortSignal): Promise<void> {
    const delay = this.options.delayMs ?? 0;
    if (delay <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
