import { mapRect } from '../core/deskew';
import type { PageModel } from '../core/types';
import type { OcrBbox, OcrEngine, OcrImage, OcrProgress, OcrWord } from './engine';
import { DEFAULT_OCR_LANGUAGES, isImageData } from './engine';
import { blocksToPageModel, mergeWordsToBlocks, type OcrBlock } from './geometry';
import { normalizeForOcr, type DewarpProvenance, type NormalizeReport, type OcrCoordinateTransform, type RgbaImage } from './preprocess';
import type { PreprocessStepKind } from '../core/preprocess';

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
  /**
   * What pixel normalisation did to the capture before the engine saw it:
   * `inverted` means a dark UI was flipped to dark-on-light, `contrastGain` is
   * the percentile stretch that was applied, and `scale` is the integer upscale
   * used for tiny glyphs. Every coordinate in this model is already divided back
   * into original screenshot pixels, so the report is informational.
   */
  normalization: NormalizeReport;
  preprocessingSteps?: readonly PreprocessStepKind[];
  coordinateTransform?: OcrCoordinateTransform;
  dewarp?: DewarpProvenance;
}

export interface OcrPageModel extends PageModel {
  ocr: OcrRunInfo;
  /**
   * Words kept after the confidence filter, in original screenshot pixel
   * coordinates. Readers use these for block confidence so low-confidence words
   * that never became block text do not drag a block's score down.
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
  /** Send the source through untouched (page scanning captures its own pixels). */
  preprocess?: boolean;
  /**
   * Legacy linear contrast multiplier. Normalisation now picks its gain from the
   * capture's own luminance histogram, so this field is only kept so existing
   * callers keep type-checking.
   */
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

function identityReport(): NormalizeReport {
  return { inverted: false, contrastGain: 1, scale: 1 };
}

function unknownDewarp(reason: string): DewarpProvenance {
  return {
    status: 'unknown',
    measuredSkewDeg: 0,
    correctionDeg: 0,
    sourceWidth: 0,
    sourceHeight: 0,
    outputWidth: 0,
    outputHeight: 0,
    mappedBackToSource: false,
    reason,
  };
}

function rgbaFromPixels(pixels: ImageData): RgbaImage {
  return { data: pixels.data, width: pixels.width, height: pixels.height };
}

/**
 * Plain grayscale with a linear contrast multiplier.
 *
 * `runOcr` no longer calls this: normalisation lives in ./preprocess, where
 * inversion, percentile contrast and upscaling are decided together. The helper
 * stays exported for callers that already hold raw pixels.
 */
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

async function decodeToBitmap(source: Blob | string): Promise<ImageBitmap | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined;
  if (typeof source === 'string') {
    const response = await fetch(source);
    if (!response.ok) return undefined;
    return createImageBitmap(await response.blob());
  }
  return createImageBitmap(source);
}

/**
 * Read an image's pixels. ImageData is already pixels; a Blob or URL has to be
 * drawn and read back, which needs OffscreenCanvas. Hosts without it (jsdom,
 * canvas-less workers) get `undefined` and keep the untouched source.
 */
async function readPixels(image: OcrImage): Promise<ImageData | undefined> {
  if (isImageData(image)) return image;
  if (typeof OffscreenCanvas !== 'function') return undefined;
  const bitmap = await decodeToBitmap(image);
  if (!bitmap) return undefined;
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } catch {
    return undefined;
  } finally {
    bitmap.close();
  }
}

interface PreparedImage {
  /** What the engine sees: normalised pixels, or the untouched source. */
  image: OcrImage;
  report: NormalizeReport;
  /** Pixel size of the image the engine is handed; 0 when it could not be read. */
  width: number;
  height: number;
  transform?: OcrCoordinateTransform;
  dewarp?: DewarpProvenance;
  steps: readonly PreprocessStepKind[];
}

/**
 * The one preprocessing step before recognition: measure the capture, then
 * invert, stretch and upscale it through normalizeForOcr. Falls back to the
 * untouched source when pixels cannot be read, so an unusual host skips
 * normalisation instead of failing the capture.
 */
export async function prepareImageForOcr(image: OcrImage): Promise<PreparedImage> {
  let pixels: ImageData | undefined;
  try {
    pixels = await readPixels(image);
  } catch {
    pixels = undefined;
  }
  if (!pixels || !isImageData(pixels)) {
    return { image, report: identityReport(), width: 0, height: 0, dewarp: unknownDewarp('source pixels are unavailable'), steps: [] };
  }
  const normalized = normalizeForOcr(rgbaFromPixels(pixels));
  if (!(normalized.image.width > 0) || !(normalized.image.height > 0)) {
    return { image, report: identityReport(), width: 0, height: 0, dewarp: unknownDewarp('source pixels are malformed'), steps: [] };
  }
  return {
    image: createImageData(normalized.image.data, normalized.image.width, normalized.image.height),
    report: normalized.report,
    width: normalized.image.width,
    height: normalized.image.height,
    transform: normalized.transform,
    dewarp: normalized.dewarp,
    steps: normalized.steps ?? [],
  };
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

/**
 * Factor that maps engine coordinates back to the original screenshot.
 *
 * The engine numbers its boxes in the canvas it was handed, which is the
 * normalised (possibly upscaled) image. Dividing by the upscale factor returns
 * original pixels, so the overlay drawn over the untouched screenshot lines up.
 * The mapping is only applied when the engine reports the same canvas size we
 * passed: a test double or a provider that resamples on its own numbers its
 * boxes in some other space, and scaling those would be a guess.
 */
function coordinateTransform(prepared: PreparedImage, width: number, height: number): OcrCoordinateTransform | undefined {
  if (!prepared.transform || prepared.width <= 0 || prepared.height <= 0) return undefined;
  const measured = width > 0 && height > 0;
  if (measured && (width !== prepared.width || height !== prepared.height)) return undefined;
  return prepared.transform;
}

function mapBox(bbox: OcrBbox, transform: OcrCoordinateTransform | undefined): OcrBbox {
  if (!transform) return bbox;
  const mapped = mapRect({ x: bbox.x0, y: bbox.y0, width: bbox.x1 - bbox.x0, height: bbox.y1 - bbox.y0 }, transform.outputToSource);
  return { x0: mapped.x, y0: mapped.y, x1: mapped.x + mapped.width, y1: mapped.y + mapped.height };
}

function mapWord(word: OcrWord, transform: OcrCoordinateTransform | undefined): OcrWord {
  return { text: word.text, confidence: word.confidence, bbox: mapBox(word.bbox, transform) };
}

function mapBlock(block: OcrBlock, transform: OcrCoordinateTransform | undefined): OcrBlock {
  if (!transform) return block;
  const scale = Math.sqrt(Math.abs(transform.sourceToOutput.a * transform.sourceToOutput.d - transform.sourceToOutput.b * transform.sourceToOutput.c));
  return {
    ...block,
    rect: mapRect(block.rect, transform.outputToSource),
    fontSize: Math.max(1, block.fontSize / Math.max(1, scale)),
  };
}

export async function runOcr(request: OcrRequest): Promise<OcrPageModel> {
  const signal = request.signal;
  signal?.throwIfAborted();
  const languages = request.languages?.length ? request.languages : [...DEFAULT_OCR_LANGUAGES];
  const minConfidence = Number.isFinite(request.minConfidence) ? request.minConfidence! : 35;
  const prepared: PreparedImage = request.preprocess === false
    ? { image: request.image, report: identityReport(), width: 0, height: 0, steps: [] }
    : await prepareImageForOcr(request.image);
  signal?.throwIfAborted();
  const result = await request.engine.recognize(prepared.image, {
    languages,
    signal,
    onProgress: request.onProgress,
  });
  signal?.throwIfAborted();

  const { words, dropped } = keptWords(result.words, minConfidence);
  const blocks = mergeWordsToBlocks(words, { lineGap: request.lineGap, maxChars: request.maxChars });
  const transform = coordinateTransform(prepared, result.width, result.height);
  const maxX = Math.max(0, ...words.map(word => word.bbox.x1));
  const maxY = Math.max(0, ...words.map(word => word.bbox.y1));
  const engineWidth = result.width > 0 ? result.width : prepared.width > 0 ? prepared.width : Math.max(1, maxX);
  const engineHeight = result.height > 0 ? result.height : prepared.height > 0 ? prepared.height : Math.max(1, maxY);
  const mapped = Boolean(transform);
  const width = mapped ? transform!.sourceWidth : engineWidth;
  const height = mapped ? transform!.sourceHeight : engineHeight;
  const page = blocksToPageModel(
    mapped ? blocks.map(block => mapBlock(block, transform)) : blocks,
    width,
    height,
    request.page ?? 1,
  );
  const mappedWords = mapped ? words.map(word => mapWord(word, transform)) : words;
  const sourceLanguage = detectDominantScript(result.text || words.map(word => word.text).join(' '));
  const warnings: string[] = [];
  if (dropped > 0) warnings.push(`Đã bỏ ${dropped} từ có độ tin cậy thấp hơn ${minConfidence}%.`);
  if (!page.blocks.length) warnings.push('Không nhận ra chữ nào trong ảnh chụp.');
  return {
    ...page,
    words: mappedWords,
    ocr: {
      languages,
      sourceLanguage,
      meanConfidence: meanConfidence(words),
      droppedWords: dropped,
      warnings,
      warningCount: warnings.length,
      normalization: prepared.report,
      preprocessingSteps: prepared.steps,
      coordinateTransform: prepared.transform,
      dewarp: prepared.dewarp,
    },
  };
}
