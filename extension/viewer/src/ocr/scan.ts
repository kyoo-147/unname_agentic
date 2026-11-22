import type { PageModel, Rect, TextBlock } from '../core/types';
import { createTesseractEngine } from './engine';
import { runOcr } from './pipeline';

export interface ScanOcrResult {
  blocks: TextBlock[];
  confidence: number;
  droppedWords: number;
}

const DEFAULT_LANGUAGES = ['eng', 'vie'] as const;
const LANGUAGE_MAP: Record<string, readonly string[]> = {
  vi: ['vie', 'eng'],
  en: ['eng'],
  zh: ['chi_sim', 'eng'],
  ja: ['jpn', 'eng'],
  ko: ['kor', 'eng'],
};

export function scanLanguages(sourceLanguage: string | undefined): string[] {
  const code = (sourceLanguage ?? 'auto').toLowerCase().split('-')[0] ?? 'auto';
  return [...(LANGUAGE_MAP[code] ?? DEFAULT_LANGUAGES)];
}

export function mapOcrBlocksToPage(blocks: readonly { text: string; rect: Rect }[], imageWidth: number, imageHeight: number, pageWidth: number, pageHeight: number, page: number): TextBlock[] {
  if (!(imageWidth > 0) || !(imageHeight > 0)) return [];
  const sx = pageWidth / imageWidth;
  const sy = pageHeight / imageHeight;
  return blocks.flatMap((block, index) => {
    const text = block.text.replace(/\s+/g, ' ').trim();
    if (!text) return [];
    const rect: Rect = { x: block.rect.x * sx, y: block.rect.y * sy, width: block.rect.width * sx, height: block.rect.height * sy };
    if (!(rect.width > 0) || !(rect.height > 0)) return [];
    return [{
      id: `ocr-p${page}-${index + 1}`,
      page,
      text,
      rect,
      fontSize: Math.max(8, rect.height * 0.72),
      fontFamily: 'sans-serif',
      color: '#202724',
      direction: /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/.test(text) ? 'rtl' : 'ltr',
      rotation: 0,
    }];
  });
}

export async function recognizeScan(canvas: HTMLCanvasElement, page: number, pageWidth: number, pageHeight: number, sourceLanguage?: string): Promise<ScanOcrResult> {
  const image = canvas.toDataURL('image/png');
  const languages = scanLanguages(sourceLanguage);
  const engine = createTesseractEngine({ languages });
  const model: PageModel & { ocr?: { meanConfidence?: number; droppedWords?: number } } = await runOcr({ image, engine, languages, page, preprocess: false });
  return {
    blocks: mapOcrBlocksToPage(model.blocks, model.width, model.height, pageWidth, pageHeight, page),
    confidence: model.ocr?.meanConfidence ?? 0,
    droppedWords: model.ocr?.droppedWords ?? 0,
  };
}
