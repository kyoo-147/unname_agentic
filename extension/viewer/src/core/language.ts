export type ScriptName = 'latin' | 'han' | 'kana' | 'hangul' | 'cyrillic' | 'arabic' | 'devanagari' | 'thai' | 'unknown';

export interface LanguageCandidate {
  code: string;
  confidence: number;
}

export interface LanguageDetection {
  code: string;
  confidence: number;
  candidates: LanguageCandidate[];
}

export interface SupportedTarget {
  code: string;
  nativeName: string;
  name: string;
  rtl?: true;
}

export const SUPPORTED_TARGETS: readonly SupportedTarget[] = [
  { code: 'vi', nativeName: 'Tiếng Việt', name: 'Vietnamese' },
  { code: 'en', nativeName: 'English', name: 'English' },
  { code: 'zh', nativeName: '中文', name: 'Chinese' },
  { code: 'ja', nativeName: '日本語', name: 'Japanese' },
  { code: 'ko', nativeName: '한국어', name: 'Korean' },
  { code: 'fr', nativeName: 'Français', name: 'French' },
  { code: 'de', nativeName: 'Deutsch', name: 'German' },
  { code: 'es', nativeName: 'Español', name: 'Spanish' },
  { code: 'pt', nativeName: 'Português', name: 'Portuguese' },
  { code: 'ru', nativeName: 'Русский', name: 'Russian' },
  { code: 'ar', nativeName: 'العربية', name: 'Arabic', rtl: true },
  { code: 'hi', nativeName: 'हिन्दी', name: 'Hindi' },
  { code: 'th', nativeName: 'ไทย', name: 'Thai' },
  { code: 'id', nativeName: 'Bahasa Indonesia', name: 'Indonesian' },
];

const ALIASES: Record<string, string> = {
  eng: 'en',
  jp: 'ja',
  jpn: 'ja',
  kr: 'ko',
  kor: 'ko',
  vn: 'vi',
  vie: 'vi',
  zho: 'zh',
  chi: 'zh',
  cmn: 'zh',
  deu: 'de',
  ger: 'de',
  fra: 'fr',
  fre: 'fr',
  spa: 'es',
  por: 'pt',
  rus: 'ru',
  ara: 'ar',
  hin: 'hi',
  tha: 'th',
  ind: 'id',
  in: 'id',
  iw: 'he',
  he: 'he',
};

export function normalizeLanguageCode(value: string): string {
  const raw = value.trim().toLowerCase().replace(/_/g, '-');
  if (!raw || raw === 'auto' || raw === 'detect') return 'auto';
  const base = raw.split('-')[0] ?? raw;
  return ALIASES[base] ?? base;
}

const LETTER = /\p{L}/u;

function scriptOf(codePoint: number): ScriptName {
  if (codePoint >= 0x3040 && codePoint <= 0x30ff) return 'kana';
  if (codePoint >= 0x31f0 && codePoint <= 0x31ff) return 'kana';
  if (codePoint >= 0xff66 && codePoint <= 0xff9d) return 'kana';
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) return 'han';
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) return 'han';
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return 'han';
  if (codePoint >= 0x20000 && codePoint <= 0x2fa1f) return 'han';
  if (codePoint >= 0x1100 && codePoint <= 0x11ff) return 'hangul';
  if (codePoint >= 0x3130 && codePoint <= 0x318f) return 'hangul';
  if (codePoint >= 0xa960 && codePoint <= 0xa97f) return 'hangul';
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) return 'hangul';
  if (codePoint >= 0x0400 && codePoint <= 0x052f) return 'cyrillic';
  if (codePoint >= 0x2de0 && codePoint <= 0x2dff) return 'cyrillic';
  if (codePoint >= 0xa640 && codePoint <= 0xa69f) return 'cyrillic';
  if (codePoint >= 0x0600 && codePoint <= 0x06ff) return 'arabic';
  if (codePoint >= 0x0750 && codePoint <= 0x077f) return 'arabic';
  if (codePoint >= 0x08a0 && codePoint <= 0x08ff) return 'arabic';
  if (codePoint >= 0xfb50 && codePoint <= 0xfdff) return 'arabic';
  if (codePoint >= 0xfe70 && codePoint <= 0xfeff) return 'arabic';
  if (codePoint >= 0x0900 && codePoint <= 0x097f) return 'devanagari';
  if (codePoint >= 0xa8e0 && codePoint <= 0xa8ff) return 'devanagari';
  if (codePoint >= 0x0e00 && codePoint <= 0x0e7f) return 'thai';
  if (codePoint >= 0x0041 && codePoint <= 0x005a) return 'latin';
  if (codePoint >= 0x0061 && codePoint <= 0x007a) return 'latin';
  if (codePoint >= 0x00c0 && codePoint <= 0x024f) return 'latin';
  if (codePoint >= 0x1e00 && codePoint <= 0x1eff) return 'latin';
  if (codePoint >= 0x2c60 && codePoint <= 0x2c7f) return 'latin';
  if (codePoint >= 0xa720 && codePoint <= 0xa7ff) return 'latin';
  return 'unknown';
}

type Counts = Record<ScriptName, number>;

function countScripts(text: string): { counts: Counts; total: number } {
  const counts: Counts = { latin: 0, han: 0, kana: 0, hangul: 0, cyrillic: 0, arabic: 0, devanagari: 0, thai: 0, unknown: 0 };
  let total = 0;
  for (const char of text.normalize('NFC')) {
    if (!LETTER.test(char)) continue;
    total++;
    counts[scriptOf(char.codePointAt(0) ?? 0)]++;
  }
  return { counts, total };
}

function dominant(counts: Counts): ScriptName {
  let winner: ScriptName = 'unknown';
  let best = 0;
  for (const script of Object.keys(counts) as ScriptName[]) {
    if (counts[script] > best) {
      best = counts[script];
      winner = script;
    }
  }
  return winner;
}

export function detectScript(text: string): ScriptName {
  return dominant(countScripts(text).counts);
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function latinCandidates(text: string): LanguageCandidate[] {
  const value = text.normalize('NFC').toLowerCase();
  const viStrong = countMatches(value, /[ăđơư]/g);
  const viTone = countMatches(value, /[àạảấầẩẫậắằẳẵặẹẻẽếềểễệịỉĩọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/g);
  const frSpecific = countMatches(value, /[çœæèêëîïûÿ]/g);
  const deMarks = countMatches(value, /[äöüß]/g);
  const esStrong = countMatches(value, /[ñ¿¡]/g);
  const esAccent = countMatches(value, /[áíóú]/g);
  const ptTilde = countMatches(value, /[ãõ]/g);
  const ptPattern = countMatches(value, /ão|õe|ções/g);
  const ptCedilla = countMatches(value, /ç/g);

  const scores: Record<string, number> = {
    vi: viStrong * 3 + (viTone >= 2 ? 2 : viTone === 1 ? 0.9 : 0) + (viStrong > 0 ? 1 : 0),
    en: 0.45,
    fr: frSpecific * 1.6 + countMatches(value, /[àâéôù]/g) * 0.25 + (frSpecific > 0 ? 0.5 : 0),
    de: deMarks * 1.8 + (deMarks > 0 ? 0.6 : 0),
    es: esStrong * 2.2 + esAccent * 0.35,
    pt: ptTilde * 1.4 + ptPattern * 1.5 + ptCedilla * 0.4 + countMatches(value, /[áâêóô]/g) * 0.2,
  };
  const total = Object.values(scores).reduce((sum, score) => sum + score, 0);
  if (total <= 0) return [{ code: 'en', confidence: 0.98 }];
  return Object.entries(scores)
    .filter(([, score]) => score > 0)
    .map(([code, score]) => ({ code, confidence: Math.min(0.98, Math.round((score / total) * 1000) / 1000) }))
    .sort((a, b) => b.confidence - a.confidence || a.code.localeCompare(b.code))
    .slice(0, 3);
}

export function detectLanguage(text: string): LanguageDetection {
  const { counts, total } = countScripts(text);
  if (total === 0) return { code: 'unknown', confidence: 0, candidates: [] };
  const script = dominant(counts);
  if (script === 'latin') {
    const share = counts.latin / total;
    const candidates = latinCandidates(text).map(candidate => ({ ...candidate, confidence: Math.round(candidate.confidence * share * 1000) / 1000 }));
    const top = candidates[0];
    return top ? { code: top.code, confidence: top.confidence, candidates } : { code: 'unknown', confidence: 0, candidates: [] };
  }
  if (script === 'han' || script === 'kana') {
    const cjk = counts.han + counts.kana;
    const candidates: LanguageCandidate[] = [];
    if (counts.kana > 0) candidates.push({ code: 'ja', confidence: Math.round((cjk / total) * 1000) / 1000 });
    if (counts.han > 0) candidates.push({ code: 'zh', confidence: Math.round((counts.han / total) * 1000) / 1000 });
    candidates.sort((a, b) => b.confidence - a.confidence || a.code.localeCompare(b.code));
    const code = counts.kana > 0 ? 'ja' : 'zh';
    return { code, confidence: Math.round(((code === 'ja' ? cjk : counts.han) / total) * 1000) / 1000, candidates };
  }
  const mapping: Partial<Record<ScriptName, string>> = { hangul: 'ko', cyrillic: 'ru', arabic: 'ar', devanagari: 'hi', thai: 'th' };
  const code = mapping[script];
  if (!code) return { code: 'unknown', confidence: 0, candidates: [] };
  const confidence = Math.round((counts[script] / total) * 1000) / 1000;
  return { code, confidence, candidates: [{ code, confidence }] };
}
