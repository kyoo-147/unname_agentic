import type { PageModel } from '../core/types';
import type { OcrEngine, OcrImage, OcrProgress, OcrWord } from './engine';
import { DEFAULT_OCR_LANGUAGES, isImageData } from './engine';
import { blocksToPageModel, mergeWordsToBlocks } from './geometry';

export type OcrScript = 'latin' | 'han' | 'kana' | 'hangul' | 'cyrillic' | 'arabic' | 'thai' | 'devanagari' | 'unknown';

export interface OcrLanguageSuggestion {
  code: string;
  script: OcrScript;
  confidence: number;
}

export interface OcrRunInfo {
  languages: string[];
  sourceLanguage: OcrLanguageSuggestion;
  meanConfidence: number;
  droppedWords: number;
  warnings: string[];
  warningCount: number;
}

export interface OcrPageModel extends PageModel {
  ocr: OcrRunInfo;
  /**
   * Words kept after the confidence filter, in source-image pixel coordinates.
   * Readers use these for block confidence so low-confidence words that never
   * became block text do not drag a block's score down.
   */
  words: OcrWord[];
}

export interface OcrRequest {
  image: OcrImage;
  languages?: string[];
  engine: OcrEngine;
  signal?: AbortSignal;
  minConfidence?: number;
  lineGap?: number;
  maxChars?: number;
  page?: number;
  preprocess?: boolean;
  contrast?: number;
  onProgress?: (progress: OcrProgress) => void;
}

const VIETNAMESE_CHARS = /[ăâđêôơưĂÂĐÊÔƠƯ]|[àáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/u;
const SCRIPT_CHECKS: Array<{ script: OcrScript; test: RegExp }> = [
  { script: 'kana', test: /[\u3040-\u30ff]/u },
  { script: 'hangul', test: /[\uac00-\ud7af\u1100-\u11ff]/u },
  { script: 'han', test: /[\u3400-\u9fff\uf900-\ufaff]/u },
  { script: 'cyrillic', test: /\p{Script=Cyrillic}/u },
  { script: 'arabic', test: /\p{Script=Arabic}/u },
  { script: 'thai', test: /\p{Script=Thai}/u },
  { script: 'devanagari', test: /\p{Script=Devanagari}/u },
  { script: 'latin', test: /\p{Script=Latin}/u },
];

const LANGUAGE_BY_SCRIPT: Record<Exclude<OcrScript, 'latin' | 'unknown'>, string> = {
  kana: 'ja',
  hangul: 'ko',
  han: 'zh',
  cyrillic: 'ru',
  arabic: 'ar',
  thai: 'th',
  devanagari: 'hi',
};

export function detectDominantScript(text: string): OcrLanguageSuggestion {
  const letters = Array.from(text).filter(character => /\p{L}/u.test(character));
  if (!letters.length) return { code: '', script: 'unknown', confidence: 0 };
  const counts = new Map<OcrScript, number>();
  for (const character of letters) {
    const match = SCRIPT_CHECKS.find(entry => entry.test.test(character));
    if (!match || match.script === 'unknown') continue;
    counts.set(match.script, (counts.get(match.script) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const dominant = ranked[0];
  if (!dominant) return { code: '', script: 'unknown', confidence: 0 };
  const [script, count] = dominant;
  if (script === 'latin') {
    const vietnamese = letters.filter(character => VIETNAMESE_CHARS.test(character)).length;
    return {
      code: vietnamese > 0 ? 'vi' : 'en',
      script,
      confidence: count / letters.length,
    };
  }
  if (script === 'unknown') return { code: '', script, confidence: 0 };
  return { code: LANGUAGE_BY_SCRIPT[script], script, confidence: count / letters.length };
}

function createImageData(data: Uint8ClampedArray, width: number, height: number): ImageData {
  if (typeof ImageData === 'function') return new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height);
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

export function grayscaleContrast(image: ImageData, contrast = 1.15): ImageData {
  const output = new Uint8ClampedArray(image.data.length);
  const factor = Number.isFinite(contrast) && contrast > 0 ? contrast : 1;
  for (let index = 0; index < image.data.length; index += 4) {
    const red = image.data[index] ?? 0;
    const green = image.data[index + 1] ?? 0;
    const blue = image.data[index + 2] ?? 0;
    const grey = 0.299 * red + 0.587 * green + 0.114 * blue;
    const adjusted = Math.max(0, Math.min(255, (grey - 128) * factor + 128));
    output[index] = adjusted;
    output[index + 1] = adjusted;
    output[index + 2] = adjusted;
    output[index + 3] = image.data[index + 3] ?? 255;
  }
  return createImageData(output, image.width, image.height);
}

async function decodeToBitmap(image: OcrImage): Promise<ImageBitmap | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined;
  if (isImageData(image)) {
    if (typeof OffscreenCanvas !== 'function') return undefined;
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.putImageData(image, 0, 0);
    return createImageBitmap(canvas);
  }
  if (typeof image === 'string') {
    const response = await fetch(image);
    if (!response.ok) return undefined;
    return createImageBitmap(await response.blob());
  }
  return createImageBitmap(image);
}

export async function preprocessImage(image: OcrImage, options: { contrast?: number } = {}): Promise<OcrImage> {
  if (isImageData(image)) return grayscaleContrast(image, options.contrast);
  if (typeof OffscreenCanvas !== 'function') return image;
  try {
    const bitmap = await decodeToBitmap(image);
    if (!bitmap) return image;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) return image;
    context.drawImage(bitmap, 0, 0);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    const pixels = context.getImageData(0, 0, size.width, size.height);
    context.putImageData(grayscaleContrast(pixels, options.contrast), 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  } catch {
    return image;
  }
}

function keptWords(words: OcrWord[], minConfidence: number): { words: OcrWord[]; dropped: number } {
  let dropped = 0;
  const kept = words.filter(word => {
    if (!word.text.trim()) return false;
    if (!Number.isFinite(word.confidence) || word.confidence < minConfidence) {
      dropped++;
      return false;
    }
    return true;
  });
  return { words: kept, dropped };
}

function meanConfidence(words: OcrWord[]): number {
  if (!words.length) return 0;
  const total = words.reduce((sum, word) => sum + word.confidence, 0);
  return Math.round((total / words.length) * 10) / 10;
}

export async function runOcr(request: OcrRequest): Promise<OcrPageModel> {
  const signal = request.signal;
  signal?.throwIfAborted();
  const languages = request.languages?.length ? request.languages : [...DEFAULT_OCR_LANGUAGES];
  const minConfidence = Number.isFinite(request.minConfidence) ? request.minConfidence! : 35;
  const image = request.preprocess === false ? request.image : await preprocessImage(request.image, { contrast: request.contrast });
  signal?.throwIfAborted();
  const result = await request.engine.recognize(image, {
    languages,
    signal,
    onProgress: request.onProgress,
  });
  signal?.throwIfAborted();

  const { words, dropped } = keptWords(result.words, minConfidence);
  const blocks = mergeWordsToBlocks(words, { lineGap: request.lineGap, maxChars: request.maxChars });
  const maxX = Math.max(0, ...words.map(word => word.bbox.x1));
  const maxY = Math.max(0, ...words.map(word => word.bbox.y1));
  const width = result.width > 0 ? result.width : Math.max(1, maxX);
  const height = result.height > 0 ? result.height : Math.max(1, maxY);
  const page = blocksToPageModel(blocks, width, height, request.page ?? 1);
  const sourceLanguage = detectDominantScript(result.text || words.map(word => word.text).join(' '));
  const warnings: string[] = [];
  if (dropped > 0) warnings.push(`Đã bỏ ${dropped} từ có độ tin cậy thấp hơn ${minConfidence}%.`);
  if (!page.blocks.length) warnings.push('Không nhận ra chữ nào trong ảnh chụp.');
  return {
    ...page,
    words,
    ocr: {
      languages,
      sourceLanguage,
      meanConfidence: meanConfidence(words),
      droppedWords: dropped,
      warnings,
      warningCount: warnings.length,
    },
  };
}
