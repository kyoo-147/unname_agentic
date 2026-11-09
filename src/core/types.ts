export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextBlock {
  id: string;
  page: number;
  text: string;
  rect: Rect;
  fontSize: number;
  fontFamily: string;
  color: string;
  direction: 'ltr' | 'rtl';
  rotation: number;
}

export interface PageModel {
  number: number;
  width: number;
  height: number;
  blocks: TextBlock[];
}

export type ProviderKind = 'google' | 'deepl' | 'openai' | 'local';

export interface TranslationSettings {
  provider: ProviderKind;
  endpoint: string;
  apiKey: string;
  model: string;
  sourceLanguage: string;
  targetLanguage: string;
  glossary: Record<string, string>;
  promptVersion: string;
  allowCloud: boolean;
}

export interface TranslationRequest {
  text: string;
  settings: TranslationSettings;
  signal?: AbortSignal;
}

export interface TranslationResult {
  text: string;
  provider: ProviderKind;
  cached: boolean;
}

export interface ViewportAnchor {
  page: number;
  fraction: number;
}

export interface MirrorSource {
  id: string;
  url: string;
  title: string;
  kind: 'pdf' | 'html' | 'capture';
  tabId?: number;
}

export interface TranslationTransport {
  translate(request: TranslationRequest): Promise<string>;
}

export const defaultSettings: TranslationSettings = {
  provider: 'local',
  endpoint: 'http://127.0.0.1:11434/v1',
  apiKey: '',
  model: 'qwen3:4b',
  sourceLanguage: 'auto',
  targetLanguage: 'vi',
  glossary: {},
  promptVersion: 'mirror-v1',
  allowCloud: false,
};
