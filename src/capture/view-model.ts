import type { TextBlock } from '../core/types';
import type { OcrWord } from '../ocr/engine';

export type CaptureLocale = 'vi' | 'en' | 'zh';

const vi = {
  title: 'Đọc bản chụp',
  eyebrow: 'BẢN CHỤP MÀN HÌNH',
  note: 'Ảnh chụp giữ nguyên điểm ảnh gốc. Đây là cách đọc song song: bản dịch nằm bên cạnh, không phải bản sao khớp từng điểm ảnh.',
  back: 'Quay lại',
  retry: 'Thử lại',
  retryAll: 'Thử lại tất cả',
  retryBlock: 'Dịch lại khối này',
  sourceHeading: 'Ảnh gốc',
  translatedHeading: 'Bản dịch theo khối',
  summary: '{blocks} khối chữ · độ tin cậy trung bình {confidence}',
  sourceLanguage: 'Ngôn ngữ nhận dạng: {language}',
  lowConfidence: '{count} khối dưới ngưỡng {threshold}% cần xem lại',
  allConfidence: 'Không có khối nào dưới ngưỡng {threshold}%',
  confidenceLabel: 'Độ tin cậy',
  droppedWords: 'Đã bỏ {count} từ có độ tin cậy thấp khi đọc ảnh.',
  pending: 'Chờ dịch',
  queued: 'Trong hàng đợi',
  translating: 'Đang dịch…',
  translated: 'Đã dịch',
  failed: 'Dịch lỗi',
  empty: 'Không nhận ra chữ nào trong ảnh này. Hãy chụp lại vùng có chữ rõ hơn.',
  emptyTranslation: 'Chưa có bản dịch.',
  statusCapture: 'Đang nhận ảnh chụp từ tab nguồn…',
  statusOcrProgress: 'Đang đọc chữ trong ảnh… {percent}%',
  statusOcrDone: 'Đã nhận ra {count} khối chữ. Đang dịch…',
  statusTranslationsDone: 'Đã dịch xong {done}/{total} khối.',
  statusTranslationError: 'Một số khối chưa dịch được. Thử lại từng khối hoặc thử lại tất cả.',
  errorTitle: 'Không đọc được ảnh chụp',
  errorNoExtension: 'Không tìm thấy tiện ích Mirror PDF. Hãy mở trang này từ tiện ích rồi thử lại.',
  errorExpired: 'Ảnh chụp đã hết hạn. Hãy quay lại tab nguồn và chụp lại.',
  errorTimeout: 'Tiện ích không phản hồi kịp. Hãy thử lại.',
  errorInvalid: 'Tiện ích trả về ảnh không hợp lệ. Hãy thử lại.',
  errorOcr: 'Không đọc được chữ trong ảnh này. Ảnh có thể mờ, quá nhỏ hoặc không có chữ.',
  errorUnknown: 'Đã xảy ra lỗi khi đọc ảnh chụp.',
  errorEmptyTranslation: 'Nhà cung cấp trả về bản dịch rỗng.',
  captureUnavailable: 'Trang này không phải yêu cầu chụp màn hình.',
  loadingLabel: 'Đang chuẩn bị bản đọc ảnh chụp…',
  imageAlt: 'Ảnh chụp màn hình nguồn',
  regionLabel: 'Khối {number}: {text}',
  langVi: 'Tiếng Việt',
  langEn: 'Tiếng Anh',
  langZh: 'Tiếng Trung',
  langJa: 'Tiếng Nhật',
  langKo: 'Tiếng Hàn',
  langRu: 'Tiếng Nga',
  langAr: 'Tiếng Ả Rập',
  langTh: 'Tiếng Thái',
  langHi: 'Tiếng Hindi',
  langUnknown: 'Chưa xác định',
} as const;

export type CaptureCopyKey = keyof typeof vi;

const en: Record<CaptureCopyKey, string> = {
  title: 'Screenshot reading',
  eyebrow: 'SCREEN CAPTURE',
  note: 'The screenshot keeps its original pixels. This is paired reading: the translation sits beside it, not a pixel-perfect mirror.',
  back: 'Back',
  retry: 'Try again',
  retryAll: 'Retry all',
  retryBlock: 'Translate this block again',
  sourceHeading: 'Original screenshot',
  translatedHeading: 'Translations by block',
  summary: '{blocks} text blocks · average confidence {confidence}',
  sourceLanguage: 'Detected language: {language}',
  lowConfidence: '{count} blocks below {threshold}% need a check',
  allConfidence: 'No block is below {threshold}%',
  confidenceLabel: 'Confidence',
  droppedWords: 'Dropped {count} low-confidence words while reading the image.',
  pending: 'Waiting to translate',
  queued: 'Queued',
  translating: 'Translating…',
  translated: 'Translated',
  failed: 'Translation failed',
  empty: 'No text was found in this screenshot. Capture an area with clearer text.',
  emptyTranslation: 'No translation yet.',
  statusCapture: 'Receiving the screenshot from the source tab…',
  statusOcrProgress: 'Reading text in the image… {percent}%',
  statusOcrDone: 'Found {count} text blocks. Translating…',
  statusTranslationsDone: 'Translated {done}/{total} blocks.',
  statusTranslationError: 'Some blocks could not be translated. Retry a block or retry all.',
  errorTitle: 'This screenshot could not be read',
  errorNoExtension: 'The Mirror PDF extension was not found. Open this page from the extension and try again.',
  errorExpired: 'The screenshot has expired. Return to the source tab and capture it again.',
  errorTimeout: 'The extension did not respond in time. Try again.',
  errorInvalid: 'The extension returned an invalid image. Try again.',
  errorOcr: 'No text could be read from this image. It may be blurry, too small, or contain no text.',
  errorUnknown: 'Something went wrong while reading the screenshot.',
  errorEmptyTranslation: 'The provider returned an empty translation.',
  captureUnavailable: 'This page is not a screenshot request.',
  loadingLabel: 'Preparing the screenshot reader…',
  imageAlt: 'Source screenshot',
  regionLabel: 'Block {number}: {text}',
  langVi: 'Vietnamese',
  langEn: 'English',
  langZh: 'Chinese',
  langJa: 'Japanese',
  langKo: 'Korean',
  langRu: 'Russian',
  langAr: 'Arabic',
  langTh: 'Thai',
  langHi: 'Hindi',
  langUnknown: 'Not detected',
};

const zh: Record<CaptureCopyKey, string> = {
  title: '截图阅读',
  eyebrow: '屏幕截图',
  note: '截图保留原始像素。这里是并排阅读：译文在旁，不是逐像素镜像。',
  back: '返回',
  retry: '重试',
  retryAll: '全部重试',
  retryBlock: '重新翻译此块',
  sourceHeading: '原始截图',
  translatedHeading: '按块翻译',
  summary: '{blocks} 个文字块 · 平均置信度 {confidence}',
  sourceLanguage: '识别语言：{language}',
  lowConfidence: '有 {count} 个块的置信度低于 {threshold}%，建议核对',
  allConfidence: '所有块都不低于 {threshold}%',
  confidenceLabel: '置信度',
  droppedWords: '识别时丢弃了 {count} 个低置信度词语。',
  pending: '等待翻译',
  queued: '排队中',
  translating: '正在翻译…',
  translated: '已翻译',
  failed: '翻译失败',
  empty: '这张截图里没有识别到文字。请重新截取文字更清晰的区域。',
  emptyTranslation: '暂无译文。',
  statusCapture: '正在从来源标签页接收截图…',
  statusOcrProgress: '正在识别图片中的文字… {percent}%',
  statusOcrDone: '识别到 {count} 个文字块，正在翻译…',
  statusTranslationsDone: '已翻译 {done}/{total} 个块。',
  statusTranslationError: '有些块未能翻译。请重试单个块或全部重试。',
  errorTitle: '无法读取这张截图',
  errorNoExtension: '未找到 Mirror PDF 扩展。请从扩展打开此页面后重试。',
  errorExpired: '截图已过期。请回到来源标签页重新截图。',
  errorTimeout: '扩展未及时响应。请重试。',
  errorInvalid: '扩展返回的图片无效。请重试。',
  errorOcr: '无法从这张图片中读取文字。图片可能模糊、过小或没有文字。',
  errorUnknown: '读取截图时出错。',
  errorEmptyTranslation: '提供商返回了空译文。',
  captureUnavailable: '此页面不是截图请求。',
  loadingLabel: '正在准备截图阅读…',
  imageAlt: '来源截图',
  regionLabel: '第 {number} 块：{text}',
  langVi: '越南语',
  langEn: '英语',
  langZh: '中文',
  langJa: '日语',
  langKo: '韩语',
  langRu: '俄语',
  langAr: '阿拉伯语',
  langTh: '泰语',
  langHi: '印地语',
  langUnknown: '未确定',
};

export const captureCopy: Record<CaptureLocale, Record<CaptureCopyKey, string>> = { vi, en, zh };

export const CAPTURE_COPY_KEYS = Object.keys(vi) as CaptureCopyKey[];

export function resolveCaptureLocale(language: string | undefined): CaptureLocale {
  const primary = (language ?? '').toLowerCase().split('-')[0];
  if (primary === 'en') return 'en';
  if (primary === 'zh') return 'zh';
  return 'vi';
}

export function captureString(locale: CaptureLocale, key: CaptureCopyKey, vars?: Record<string, string | number>): string {
  const template = captureCopy[locale][key] ?? captureCopy.vi[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(vars, name) ? String(vars[name]) : match);
}

export interface NumberedBlock {
  block: TextBlock;
  number: number;
}

export function numberBlocks(blocks: readonly TextBlock[]): NumberedBlock[] {
  return blocks.map((block, index) => ({ block, number: index + 1 }));
}

export interface PercentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function positiveSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function blockRectPosition(block: TextBlock, pageWidth: number, pageHeight: number): PercentRect {
  const width = positiveSize(pageWidth);
  const height = positiveSize(pageHeight);
  const left = clamp((block.rect.x / width) * 100, 0, 100);
  const top = clamp((block.rect.y / height) * 100, 0, 100);
  const right = clamp(((block.rect.x + block.rect.width) / width) * 100, 0, 100);
  const bottom = clamp(((block.rect.y + block.rect.height) / height) * 100, 0, 100);
  return {
    left: round(left, 3),
    top: round(top, 3),
    width: round(Math.max(0, right - left), 3),
    height: round(Math.max(0, bottom - top), 3),
  };
}

function overlapsRect(word: OcrWord, block: TextBlock): boolean {
  return word.bbox.x0 < block.rect.x + block.rect.width
    && word.bbox.x1 > block.rect.x
    && word.bbox.y0 < block.rect.y + block.rect.height
    && word.bbox.y1 > block.rect.y;
}

export function confidenceForBlock(block: TextBlock, words: readonly OcrWord[]): number {
  const matched = words.filter(word => overlapsRect(word, block) && Number.isFinite(word.confidence));
  if (!matched.length) return 0;
  const mean = matched.reduce((total, word) => total + clamp(word.confidence, 0, 100), 0) / matched.length;
  return round(mean, 1);
}

export function blockConfidences(blocks: readonly TextBlock[], words: readonly OcrWord[]): Map<string, number> {
  return new Map(blocks.map(block => [block.id, confidenceForBlock(block, words)]));
}

export interface ConfidenceSummary {
  mean: number;
  total: number;
  lowCount: number;
  threshold: number;
}

export const DEFAULT_CONFIDENCE_THRESHOLD = 60;

export function summarizeConfidence(values: readonly number[], threshold = DEFAULT_CONFIDENCE_THRESHOLD): ConfidenceSummary {
  const scores = values.map(value => Number.isFinite(value) ? clamp(value, 0, 100) : 0);
  const mean = scores.length ? round(scores.reduce((total, value) => total + value, 0) / scores.length, 1) : 0;
  return {
    mean,
    total: scores.length,
    lowCount: scores.filter(value => value < threshold).length,
    threshold,
  };
}

export function filterLowConfidence(
  blocks: readonly TextBlock[],
  confidences: ReadonlyMap<string, number>,
  threshold = DEFAULT_CONFIDENCE_THRESHOLD,
): NumberedBlock[] {
  return numberBlocks(blocks).filter(({ block }) => (confidences.get(block.id) ?? 0) < threshold);
}

export function formatConfidence(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Math.round(clamp(value, 0, 100) * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

const LANGUAGE_KEYS: Record<string, CaptureCopyKey> = {
  vi: 'langVi',
  en: 'langEn',
  zh: 'langZh',
  ja: 'langJa',
  ko: 'langKo',
  ru: 'langRu',
  ar: 'langAr',
  th: 'langTh',
  hi: 'langHi',
};

export function sourceLanguageLabel(code: string | undefined, locale: CaptureLocale = 'vi'): string {
  const primary = (code ?? '').toLowerCase().split('-')[0];
  if (!primary || primary === 'unknown' || primary === 'auto') return captureString(locale, 'langUnknown');
  const key = LANGUAGE_KEYS[primary];
  return key ? captureString(locale, key) : primary.toUpperCase();
}

export type TranslationStatus = 'idle' | 'queued' | 'loading' | 'done' | 'error';

export interface TranslationView {
  status: TranslationStatus;
  text?: string;
  error?: string;
}

const STATUS_KEYS: Record<TranslationStatus, CaptureCopyKey> = {
  idle: 'pending',
  queued: 'queued',
  loading: 'translating',
  done: 'translated',
  error: 'failed',
};

export function translationStatusKey(status: TranslationStatus): CaptureCopyKey {
  return STATUS_KEYS[status];
}

export function translationStatusText(status: TranslationStatus, locale: CaptureLocale = 'vi'): string {
  return captureString(locale, STATUS_KEYS[status]);
}

export interface TranslationQueueOptions {
  includeErrors?: boolean;
  limit?: number;
}

export function selectTranslationQueue(
  blocks: readonly TextBlock[],
  states: ReadonlyMap<string, TranslationView>,
  options: TranslationQueueOptions = {},
): TextBlock[] {
  const accepted = new Set<TranslationStatus>(['idle']);
  if (options.includeErrors) accepted.add('error');
  const selected = blocks.filter(block => accepted.has(states.get(block.id)?.status ?? 'idle'));
  const limit = options.limit;
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return selected;
  return selected.slice(0, Math.floor(limit));
}
