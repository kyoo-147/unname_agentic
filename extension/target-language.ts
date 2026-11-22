import { SUPPORTED_TARGETS } from './viewer/src/core/language';

export const TARGET_LANGUAGE_KEY = 'mirror:targetLanguage';
export const DEFAULT_TARGET_LANGUAGE = 'vi';

export interface TargetLanguageOption {
  code: string;
  label: string;
}

/** The popup offers exactly the reader's target list, labelled by each language's own name. */
export function targetLanguageOptions(): TargetLanguageOption[] {
  return SUPPORTED_TARGETS.map(target => ({ code: target.code, label: target.nativeName }));
}

/** Unknown, non-string, or empty stored values fall back to Vietnamese, the product default. */
export function normalizeTargetLanguage(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_TARGET_LANGUAGE;
  const code = value.trim().toLowerCase();
  return SUPPORTED_TARGETS.some(target => target.code === code) ? code : DEFAULT_TARGET_LANGUAGE;
}

export async function readTargetLanguage(): Promise<string> {
  try {
    const values = await chrome.storage.local.get(TARGET_LANGUAGE_KEY);
    return normalizeTargetLanguage(values[TARGET_LANGUAGE_KEY]);
  } catch {
    return DEFAULT_TARGET_LANGUAGE;
  }
}

export async function saveTargetLanguage(value: unknown): Promise<string> {
  const code = normalizeTargetLanguage(value);
  try {
    await chrome.storage.local.set({ [TARGET_LANGUAGE_KEY]: code });
  } catch {
    // A storage failure must not block the popup; the reader keeps its own default.
  }
  return code;
}

/** Fills the select from SUPPORTED_TARGETS and selects `selected`, returning the applied code. */
export function fillTargetLanguage(select: HTMLSelectElement, selected: unknown = DEFAULT_TARGET_LANGUAGE): string {
  const code = normalizeTargetLanguage(selected);
  select.replaceChildren(...targetLanguageOptions().map(option => {
    const element = select.ownerDocument.createElement('option');
    element.value = option.code;
    element.textContent = option.label;
    element.selected = option.code === code;
    return element;
  }));
  select.value = code;
  return code;
}

export async function initTargetLanguage(select: HTMLSelectElement): Promise<string> {
  const stored = await readTargetLanguage();
  fillTargetLanguage(select, stored);
  select.addEventListener('change', () => { void saveTargetLanguage(select.value); });
  return stored;
}
