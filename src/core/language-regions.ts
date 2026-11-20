/**
 * Per-block language detection and language-region segmentation (backlog item E11).
 *
 * `language.ts` names the language of a whole document and `classify.ts` decides
 * whether a page is text or pixels. Neither answers the question the translator
 * actually has: a bilingual contract, or a paper whose body is Vietnamese with an
 * English abstract, must be translated part by part, and a block can only be sent to
 * a sensible target once its *own* source language is known. This module answers it
 * twice:
 *
 * - {@link detectBlockLanguage} judges one block from script ranges, Vietnamese
 *   letters, function-word ("stopword") evidence and a numeric/symbol shortcut.
 * - {@link segmentByLanguage} groups consecutive blocks of one language into regions,
 *   so the pipeline can schedule one job per region instead of one per block, and
 *   {@link summary} reports how much of the document each language carries.
 *
 * Contract:
 * - Pure and deterministic: no globals, no clock, no randomness, no DOM. The same
 *   block always yields the same language, confidence, alternates and reasons.
 * - Nothing is over-claimed. Confidence follows the *margin* between the best and the
 *   next candidate (also scaled by how much evidence there is), so a genuinely mixed
 *   block scores lower than a homogeneous one. A Latin block whose tokens carry no
 *   evidence at all is `und`, not a guess: "ACME Corporation" is a name, not English.
 * - No verdict claims more than 97 %, so a consumer always sees room for doubt.
 * - `reasons` and the `und:*` codes are stable machine identifiers, never user-facing
 *   text; presenting them belongs to the i18n layer.
 *
 * The script ranges below mirror the private `scriptOf` in `./language`. That function
 * is not exported and reports only the dominant script of a text, while per-block
 * detection needs the *counts* (a single kana in a Han block moves the verdict to
 * Japanese, and a 30 % minority script has to depress confidence). `detectLanguage`
 * stays the document-level entry point; this module is the block-level one.
 */

import type { ScriptName } from './language';

/** Language code for "no language can be claimed for this block". */
export const UND_LANGUAGE = 'und';

/** A block with fewer letters than this cannot support a confident verdict. */
export const MIN_CONFIDENT_LETTERS = 3;

/** Longest block `segmentByLanguage` absorbs into a neighbouring region, in characters. */
export const MERGE_MAX_CHARS = 64;

/** Most whitespace-separated tokens a block may have and still count as a name. */
export const NAME_MAX_TOKENS = 6;

/** Confidence is this base plus the span, times margin times evidence strength. */
const CONFIDENCE_BASE = 0.3;
const CONFIDENCE_SPAN = 0.7;

/** No verdict claims more than this. */
const CONFIDENCE_CEILING = 0.97;

/** Confidence ceiling for a block shorter than {@link MIN_CONFIDENT_LETTERS}. */
const SHORT_BLOCK_CONFIDENCE = 0.5;

/** Candidate score at which evidence is considered saturated, per family. */
const STRONG_LATIN = 2.5;
const STRONG_CJK = 1.5;
const STRONG_SCRIPT = 1.5;

/** English is the null hypothesis for Latin script: a small prior, beaten by evidence. */
const EN_PRIOR = 0.5;

/** A minority script must hold this share of the letters to name its language. */
const CROSS_SCRIPT_MIN_SHARE = 0.03;

/** Distinctly Vietnamese tone marks must reach this density of the tokens to score. */
const VI_TONE_DENSITY = 0.25;

/** Weights for one observation. Kept together so the ranking is auditable. */
const WEIGHT = {
  enStopword: 5,
  viStopword: 4,
  viBareStopword: 2,
  frStopword: 4.5,
  viUniqueLetter: 1.1,
  viCircumflex: 0.35,
  viTone: 0.25,
  viSharedAccent: 0.04,
  viToneDensity: 0.8,
  frUniqueLetter: 1.1,
  cjkParticle: 0.25,
} as const;

/** `ă â đ ê ô ơ ư` and the tone marks, as the backlog names them. */
const VI_UNIQUE_LETTER = /[ăđơư]/gu;
const VI_CIRCUMFLEX = /[âêô]/gu;

/**
 * Tone-marked vowels that only Vietnamese uses. The accented vowels shared with
 * French, Portuguese and Spanish (`à á ã è é ì í ò ó õ ù ú ý`) are deliberately absent:
 * they are counted separately with a weight small enough not to make a French word
 * look Vietnamese.
 */
const VI_DISTINCT_TONE = /[ạảấầẩẫậắằẳẵặẹẻẽếềểễệịỉĩọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gu;

/** Accents French, Portuguese and Spanish share with Vietnamese; weak evidence only. */
const SHARED_ACCENT = /[àáãèéìíòóõùúý]/gu;

/** Letters French has and the other Latin-script candidates do not share. */
const FR_UNIQUE_LETTER = /[çœæèîïûÿ]/gu;

/** Chinese function characters; a Han block full of them is Chinese, not kanji-only. */
const ZH_PARTICLE = /[的了是在和有我不这那与及其为]/gu;

/**
 * Japanese particles. Every one of them is kana, so the script already points at
 * Japanese; counting them sharpens a block with only a kana or two.
 */
const JA_PARTICLE = /[のはがをにでともへやかねよなだ]/gu;

/** Korean particles, Hangul like the rest of the block; they confirm the reading. */
const KO_PARTICLE = /[은는이가을를에의와과도로요]/gu;

/** English function words. */
const EN_STOPWORDS = new Set([
  'a', 'about', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any',
  'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'between', 'both',
  'but', 'by', 'can', 'could', 'did', 'do', 'does', 'during', 'each', 'few', 'for',
  'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'his', 'how',
  'if', 'in', 'into', 'is', 'it', 'its', 'may', 'me', 'more', 'most', 'must', 'no',
  'nor', 'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our',
  'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that',
  'the', 'their', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to',
  'too', 'under', 'until', 'up', 'upon', 'us', 'very', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'whose', 'will', 'with', 'would',
  'you', 'your',
]);

/** Vietnamese function words, written with their diacritics. */
const VI_STOPWORDS = new Set([
  'anh', 'ai', 'bà', 'bạn', 'bằng', 'bị', 'bởi', 'các', 'cách', 'cần', 'có', 'còn',
  'của', 'cũng', 'chị', 'cho', 'chưa', 'chúng', 'chẳng', 'đã', 'đang', 'đây', 'để',
  'đến', 'đó', 'được', 'đừng', 'em', 'gì', 'hãy', 'hay', 'họ', 'hoặc', 'ít', 'khi',
  'không', 'là', 'lên', 'làm', 'mà', 'mỗi', 'mọi', 'một', 'muốn', 'mới', 'nào', 'này',
  'nên', 'người', 'nếu', 'nhiều', 'như', 'nhưng', 'những', 'nói', 'ông', 'phải', 'quá',
  'ra', 'rằng', 'rất', 'sao', 'sau', 'sẽ', 'song', 'tại', 'thế', 'thì', 'thấy', 'theo',
  'thời', 'trên', 'trong', 'trước', 'tôi', 'tới', 'từ', 'tuy', 'và', 'vào', 'vẫn',
  'vậy', 'về', 'vì', 'với', 'xuống',
]);

/**
 * Unaccented Vietnamese function words, for PDFs whose diacritics were stripped.
 * Only words with no common English or French reading are listed, and they weigh less
 * than the accented forms because a stripped `de` could be French.
 */
const VI_BARE_STOPWORDS = new Set([
  'cac', 'cua', 'cung', 'den', 'duoc', 'giua', 'khong', 'khi', 'nay', 'nen', 'nguoi',
  'nhu', 'nhung', 'nhieu', 'rang', 'theo', 'thi', 'tren', 'truoc', 'voi',
]);

/** French function words, spelled with their accent where one exists. */
const FR_STOPWORDS = new Set([
  'au', 'aux', 'avec', 'avoir', 'car', 'ce', 'ces', 'cette', 'comme', 'contrat', 'dans',
  'de', 'des', 'doit', 'donc', 'dont', 'du', 'elle', 'elles', 'en', 'entre', 'est',
  'être', 'fait', 'faire', 'il', 'ils', 'la', 'le', 'les', 'leur', 'leurs', 'lors',
  'ma', 'mais', 'mes', 'mon', 'ni', 'notre', 'nous', 'ou', 'où', 'par', 'pas', 'plus',
  'pour', 'peut', 'qui', 'que', 'sa', 'sans', 'se', 'ses', 'sont', 'sous', 'sur', 'tout',
  'tous', 'toute', 'un', 'une', 'votre', 'vous', 'été',
]);

/** Single-script blocks map straight onto one language. */
const SCRIPT_LANGUAGE: Partial<Record<ScriptName, string>> = {
  cyrillic: 'ru',
  arabic: 'ar',
  thai: 'th',
  devanagari: 'hi',
};

/** One block's language verdict. */
export interface BlockLanguage {
  /** Candidate code (`en`, `vi`, `zh`, `ja`, `ko`, `fr`, `ru`, `ar`, `th`, `hi`) or `und`. */
  language: string;
  /**
   * 0..1: grows with the margin over the runner-up and with the amount of evidence.
   * For `und` it is the confidence that no language should be claimed at all.
   */
  confidence: number;
  /** The other candidates, strongest first; empty when nothing else scored. */
  alternates: string[];
  /** Stable machine-readable evidence codes, never user-facing text. */
  reasons: string[];
}

/**
 * A block as the reader or the IR holds it. Only text, page and id are read; a
 * `TextBlock` satisfies this shape, and an IR `Block` does too because its text lives
 * in `raw`.
 */
export interface LanguageBlockInput {
  /** Reader block id (for example `p3-r0`); used only to label regions. */
  id?: string;
  /** 1-based page number; a block without one is treated as page 1. */
  page?: number;
  /** Source text as extracted or recognised. */
  text?: string;
  /** IR `Block.raw`; read when `text` is absent or empty. */
  raw?: string;
}

/** A run of consecutive blocks that share one language. */
export interface LanguageRegion {
  /** Language shared by every block in the region, or `und` when none could be claimed. */
  language: string;
  /** Ids in reading order, as supplied (synthesised only for blocks without an id). */
  blockIds: string[];
  /** Distinct page numbers covered by the region, ascending. */
  pages: number[];
}

/** Per-language totals inside a document. */
export interface LanguageRegionCount {
  language: string;
  regions: number;
  blocks: number;
  /** Distinct pages the language appears on. */
  pages: number;
}

/** What {@link summary} reports about a region list. */
export interface LanguageRegionSummary {
  /** Counts, strongest language first. */
  counts: LanguageRegionCount[];
  /**
   * Language carrying the most blocks, ignoring `und`: a document full of numbers is
   * still a Vietnamese document. `und` only when no block was given a language.
   */
  dominant: string;
  /** Total regions; equals the sum of `counts[].regions`. */
  regions: number;
  /** Total blocks; equals the sum of `counts[].blocks`. */
  blocks: number;
}

interface Scored {
  language: string;
  score: number;
}

interface TextProfile {
  /** NFC-normalised source text. */
  text: string;
  /** Lowercased NFC text, used for letter and function-word evidence. */
  lower: string;
  counts: Record<ScriptName, number>;
  /** Letters (not digits, not punctuation) in the block. */
  letters: number;
  /** Letter runs, lowercased; punctuation and digits are separators. */
  tokens: string[];
  hasDigit: boolean;
}

interface CandidateSet {
  scores: Scored[];
  evidence: string[];
}

interface RegionRun {
  language: string;
  items: RegionItem[];
}

interface RegionItem {
  id: string;
  page: number;
  /** `'number'` or `'name'` when the block may be absorbed into a neighbour. */
  absorb: 'number' | 'name' | null;
}

/**
 * Detects the language of one block.
 *
 * Pipeline, in order:
 * 1. No letters at all: a block of digits is `und` (`und:numeric`), a block of
 *    symbols is `und` (`und:symbols`), an empty block is `und` (`und:empty`).
 *    Numbers and punctuation are language-neutral, so guessing would only add noise.
 * 2. Script ranges decide the family. Latin scores `en`/`vi`/`fr`; Han, kana and
 *    hangul share one CJK ranking (kana is exclusive to Japanese, hangul to Korean,
 *    Han is shared by Chinese and Japanese); Cyrillic, Arabic, Thai and Devanagari
 *    map onto their single language.
 * 3. Vietnamese letters (the exclusive `ă đ ơ ư`, the `â ê ô` shared with French, the
 *    tone marks only Vietnamese uses) and function words rank the Latin candidates;
 *    English is the null hypothesis with a small prior, French leans on its own
 *    letters and its function words. Inside the CJK family the same idea runs on
 *    function characters and particles: `的/了/是` for Chinese, `の/は/を` for
 *    Japanese, `은/는/를` for Korean.
 * 4. Confidence follows the margin between the two best candidates, scaled by how
 *    much evidence there is, and is capped at 0.97 (and at 0.5 for a block shorter
 *    than {@link MIN_CONFIDENT_LETTERS}).
 */
export function detectBlockLanguage(block: LanguageBlockInput): BlockLanguage {
  const profile = profileOf(textOf(block));
  if (profile.letters === 0) return neutralVerdict(profile);

  const script = dominantScript(profile.counts);
  const share = profile.counts[script] / profile.letters;
  const scriptReasons = [`script:dominant=${script}`, `script:share=${script}=${fmt2(share)}`];

  if (script === 'latin') {
    return verdict(latinCandidates(profile), STRONG_LATIN, scriptReasons, profile.letters);
  }
  if (script === 'han' || script === 'kana' || script === 'hangul') {
    return verdict(cjkCandidates(profile), STRONG_CJK, scriptReasons, profile.letters);
  }

  const mapped = SCRIPT_LANGUAGE[script];
  if (mapped) {
    const score = 1.2 + share * 1.5;
    const evidence = [`script:letters=${profile.letters}`, `script:minority=${fmt2(1 - share)}`];
    return verdict({ scores: [{ language: mapped, score }], evidence }, STRONG_SCRIPT, scriptReasons, profile.letters);
  }

  return {
    language: UND_LANGUAGE,
    confidence: 0.3,
    alternates: [],
    reasons: [...scriptReasons, 'und:unsupported-script'],
  };
}

/**
 * Groups blocks into language regions.
 *
 * Blocks are taken in the order supplied, which must already be reading order
 * (`classifyBlocks` and `buildDocument` both produce it); this function never
 * re-sorts, so a caller's reading order is preserved exactly. A block without an id
 * is labelled `@<index>` so the region still names it.
 *
 * The merge rule: a region interrupted by exactly one block of a different language
 * absorbs that block only when it is a **number or a name** — a block of digits or
 * symbols (`und:numeric`, `und:symbols`) or a short name — one to
 * {@link NAME_MAX_TOKENS} tokens, every one starting uppercase, none a function word,
 * and at most {@link MERGE_MAX_CHARS} characters. The reasoning is that neither
 * carries translatable prose: "ACME Corporation" between two Vietnamese paragraphs is
 * that document's own mention of a party, and cutting the region in two there would
 * schedule a pointless English job for it; a Vietnamese name inside an English region
 * is the same case the other way round. Everything else keeps its own region: a full
 * English sentence, however short, is a real language switch.
 *
 * Absorbable blocks at the edges of the document join their single neighbour, so a
 * page number at the top of a page does not open a `und` region of its own. A block
 * surrounded by two *different* languages is never absorbed, and an absorbable run of
 * two or more blocks is left alone because a stretch of several blocks is a real
 * region, not an interruption.
 */
export function segmentByLanguage(blocks: readonly LanguageBlockInput[]): LanguageRegion[] {
  const items = (blocks ?? []).map((block, index) => toRegionItem(block, index));

  // Maximal runs of one language, in the caller's order.
  const runs: RegionRun[] = [];
  for (const item of items) {
    const last = runs[runs.length - 1];
    if (last && last.language === item.detection.language) {
      last.items.push(item.entry);
      continue;
    }
    runs.push({ language: item.detection.language, items: [item.entry] });
  }

  const merged: RegionRun[] = [];
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (!run) continue;
    const previous = merged[merged.length - 1];
    const next = runs[index + 1];
    const only = run.items[0];
    const absorbable = run.items.length === 1 && only !== undefined && only.absorb !== null;

    // An interruption (or a trailing edge) joins the region before it.
    if (absorbable && previous) {
      if (!next || next.language === previous.language) {
        previous.items.push(...run.items);
        if (next && next.language === previous.language) {
          previous.items.push(...next.items);
          index += 1;
        }
        continue;
      }
    }

    // A leading absorbable block opens the region after it instead of its own.
    if (absorbable && !previous && next) {
      merged.push({ language: next.language, items: [...run.items, ...next.items] });
      index += 1;
      continue;
    }

    merged.push({ language: run.language, items: [...run.items] });
  }

  return merged.map(run => {
    const pages = new Set<number>();
    for (const item of run.items) pages.add(item.page);
    return {
      language: run.language,
      blockIds: run.items.map(item => item.id),
      pages: [...pages].sort((left, right) => left - right),
    };
  });
}

/**
 * Counts what a region list carries: regions, blocks and pages per language, the
 * totals, and the dominant language. `counts` is ordered by blocks, then regions,
 * then language code, so equal-sized languages compare deterministically; `dominant`
 * is the first count that is not `und`, because an undecidable block must never
 * displace a language the document actually wrote in.
 */
export function summary(regions: readonly LanguageRegion[]): LanguageRegionSummary {
  const byLanguage = new Map<string, { regions: number; blocks: number; pages: Set<number> }>();
  let totalRegions = 0;
  let totalBlocks = 0;

  for (const region of regions ?? []) {
    if (!region || !Array.isArray(region.blockIds)) continue;
    const language = typeof region.language === 'string' && region.language.length > 0 ? region.language : UND_LANGUAGE;
    const entry = byLanguage.get(language) ?? { regions: 0, blocks: 0, pages: new Set<number>() };
    entry.regions += 1;
    entry.blocks += region.blockIds.length;
    for (const page of region.pages ?? []) {
      if (Number.isFinite(page)) entry.pages.add(page);
    }
    byLanguage.set(language, entry);
    totalRegions += 1;
    totalBlocks += region.blockIds.length;
  }

  const counts: LanguageRegionCount[] = [...byLanguage.entries()]
    .map(([language, entry]) => ({ language, regions: entry.regions, blocks: entry.blocks, pages: entry.pages.size }))
    .sort(compareCounts);

  const dominant = counts.find(count => count.language !== UND_LANGUAGE)?.language ?? UND_LANGUAGE;
  return { counts, dominant, regions: totalRegions, blocks: totalBlocks };
}

// --- Latin ranking --------------------------------------------------------

function latinCandidates(profile: TextProfile): CandidateSet {
  const tokens = profile.tokens;
  const total = Math.max(1, tokens.length);
  const enHits = countTokens(tokens, EN_STOPWORDS);
  const viHits = countTokens(tokens, VI_STOPWORDS);
  const viBareHits = countTokens(tokens, VI_BARE_STOPWORDS);
  const frHits = countTokens(tokens, FR_STOPWORDS);
  const viUnique = countMatches(profile.lower, VI_UNIQUE_LETTER);
  const viCircumflex = countMatches(profile.lower, VI_CIRCUMFLEX);
  const viTone = countMatches(profile.lower, VI_DISTINCT_TONE);
  const frUnique = countMatches(profile.lower, FR_UNIQUE_LETTER);
  const sharedAccent = countMatches(profile.lower, SHARED_ACCENT);

  const evidence = [
    `latin:tokens=${tokens.length}`,
    `latin:en-stopwords=${enHits}/${tokens.length}`,
    `latin:vi-stopwords=${viHits}/${tokens.length}`,
    `latin:vi-bare-stopwords=${viBareHits}/${tokens.length}`,
    `latin:fr-stopwords=${frHits}/${tokens.length}`,
    `latin:vi-letters=${viUnique + viCircumflex + viTone}`,
    `latin:fr-letters=${frUnique}`,
  ];

  const hasEvidence =
    enHits + viHits + viBareHits + frHits > 0 || viUnique + viCircumflex + viTone + frUnique > 0;
  if (!hasEvidence) return { scores: [], evidence };

  const scores: Scored[] = [
    { language: 'en', score: EN_PRIOR + WEIGHT.enStopword * (enHits / total) },
    {
      language: 'vi',
      score:
        WEIGHT.viUniqueLetter * viUnique +
        WEIGHT.viCircumflex * viCircumflex +
        WEIGHT.viTone * viTone +
        WEIGHT.viSharedAccent * sharedAccent +
        (viTone / total >= VI_TONE_DENSITY ? WEIGHT.viToneDensity : 0) +
        WEIGHT.viStopword * (viHits / total) +
        WEIGHT.viBareStopword * (viBareHits / total),
    },
    { language: 'fr', score: WEIGHT.frUniqueLetter * frUnique + WEIGHT.frStopword * (frHits / total) },
  ];

  // A minority non-Latin script is not a second language, but it does make the block
  // less confidently Latin, and naming it explains the drop.
  pushCrossScript(scores, profile);
  return { scores, evidence };
}

function pushCrossScript(scores: Scored[], profile: TextProfile): void {
  const { counts, letters } = profile;
  if (letters === 0) return;
  const minority: Array<{ language: string; count: number }> = [
    { language: 'zh', count: counts.han },
    { language: 'ja', count: counts.kana },
    { language: 'ko', count: counts.hangul },
    { language: 'ru', count: counts.cyrillic },
    { language: 'ar', count: counts.arabic },
    { language: 'th', count: counts.thai },
  ];
  for (const entry of minority) {
    if (entry.count === 0) continue;
    const share = entry.count / letters;
    if (share < CROSS_SCRIPT_MIN_SHARE) continue;
    scores.push({ language: entry.language, score: Math.min(1.2, 2.5 * share) });
  }
}

// --- CJK ranking ----------------------------------------------------------

/**
 * Ranks Chinese, Japanese and Korean over the same block.
 *
 * Korean is tried first because Hangul is exclusive to it and may sit next to Hanja;
 * kana then moves the verdict to Japanese, since Chinese never writes kana; Han with
 * neither is Chinese, but only provisionally — kanji-only Japanese exists, so the
 * Japanese candidate keeps a real score and the margin, and with it the confidence,
 * stays modest. Function characters and particles add to their language's score, so a
 * Han block dense with `的`/`是` reads as Chinese with more confidence than a bare
 * list of nouns does.
 */
function cjkCandidates(profile: TextProfile): CandidateSet {
  const { han, kana, hangul } = profile.counts;
  const cjk = han + kana + hangul;
  const hanShare = cjk > 0 ? han / cjk : 0;
  const kanaShare = cjk > 0 ? kana / cjk : 0;
  const scores: Scored[] = [];
  const evidence = [`cjk:han=${han}`, `cjk:kana=${kana}`, `cjk:hangul=${hangul}`];

  if (hangul > 0 && hangul >= han) {
    scores.push({
      language: 'ko',
      score: 1.5 + 1.5 * Math.min(1, hangul / 6) + WEIGHT.cjkParticle * particleCount(profile.text, KO_PARTICLE),
    });
    if (han > 0) scores.push({ language: 'zh', score: 0.4 + 1.2 * hanShare });
  } else if (kana > 0) {
    scores.push({
      language: 'ja',
      score: 1.5 + 1.5 * Math.min(1, kana / 4) + kanaShare + WEIGHT.cjkParticle * particleCount(profile.text, JA_PARTICLE),
    });
    scores.push({ language: 'zh', score: 0.5 + 0.8 * hanShare });
  } else {
    scores.push({
      language: 'zh',
      score: 1.2 + WEIGHT.cjkParticle * particleCount(profile.text, ZH_PARTICLE),
    });
    scores.push({ language: 'ja', score: 0.65 });
  }

  // Latin terms inside a CJK block lower the confidence instead of being ignored.
  const latin = profile.counts.latin;
  if (latin > 0 && cjk > 0) {
    const share = latin / profile.letters;
    if (share >= CROSS_SCRIPT_MIN_SHARE) scores.push({ language: 'en', score: Math.min(1.2, 2.5 * share) });
  }
  return { scores, evidence };
}

// --- Verdict --------------------------------------------------------------

function verdict(
  candidates: CandidateSet,
  strongScore: number,
  scriptReasons: readonly string[],
  letters: number,
): BlockLanguage {
  const ranked = rankCandidates(candidates.scores);
  const top = ranked[0];
  if (!top) {
    return {
      language: UND_LANGUAGE,
      confidence: 0.4,
      alternates: [],
      reasons: [...scriptReasons, ...candidates.evidence, 'und:no-language-evidence'],
    };
  }

  const runnerUp = ranked[1];
  const margin = runnerUp ? (top.score - runnerUp.score) / top.score : 1;
  const strength = clamp01(top.score / strongScore);
  let confidence = CONFIDENCE_BASE + CONFIDENCE_SPAN * margin * strength;
  if (letters < MIN_CONFIDENT_LETTERS) confidence = Math.min(confidence, SHORT_BLOCK_CONFIDENCE);

  const reasons = [...scriptReasons, ...candidates.evidence, `score:${top.language}=${fmt2(top.score)}`];
  if (runnerUp) reasons.push(`score:${runnerUp.language}=${fmt2(runnerUp.score)}`);
  reasons.push(`margin=${fmt2(margin)}`);

  return {
    language: top.language,
    confidence: round3(Math.min(CONFIDENCE_CEILING, Math.max(0, confidence))),
    alternates: ranked.slice(1).map(candidate => candidate.language),
    reasons,
  };
}

/** Highest score per language, strongest first; ties fall back to the code. */
function rankCandidates(scores: readonly Scored[]): Scored[] {
  const best = new Map<string, number>();
  for (const candidate of scores) {
    if (!candidate || typeof candidate.language !== 'string' || candidate.language.length === 0) continue;
    if (!Number.isFinite(candidate.score) || candidate.score <= 0) continue;
    const previous = best.get(candidate.language);
    if (previous === undefined || candidate.score > previous) best.set(candidate.language, candidate.score);
  }
  return [...best.entries()]
    .map(([language, score]) => ({ language, score }))
    .sort((left, right) => right.score - left.score || left.language.localeCompare(right.language));
}

function neutralVerdict(profile: TextProfile): BlockLanguage {
  const text = profile.text.trim();
  if (text.length === 0) {
    return { language: UND_LANGUAGE, confidence: 0, alternates: [], reasons: ['und:empty'] };
  }
  if (profile.hasDigit) {
    return { language: UND_LANGUAGE, confidence: 0.95, alternates: [], reasons: ['und:numeric'] };
  }
  return { language: UND_LANGUAGE, confidence: 0.9, alternates: [], reasons: ['und:symbols'] };
}

// --- Segmentation ---------------------------------------------------------

function toRegionItem(
  block: LanguageBlockInput | undefined,
  index: number,
): { detection: BlockLanguage; entry: RegionItem } {
  const text = textOf(block);
  const detection = detectBlockLanguage(block ?? {});
  return {
    detection,
    entry: {
      id: blockIdOf(block, index),
      page: pageOf(block),
      absorb: absorbKindOf(text, detection),
    },
  };
}

/** `'number'`/`'name'` when the block is short enough and carries no prose. */
function absorbKindOf(text: string, detection: BlockLanguage): 'number' | 'name' | null {
  const compact = collapsed(text);
  if (compact.length === 0 || compact.length > MERGE_MAX_CHARS) return null;
  if (
    detection.language === UND_LANGUAGE &&
    (detection.reasons.includes('und:numeric') || detection.reasons.includes('und:symbols'))
  ) {
    return 'number';
  }
  return isNameLike(compact) ? 'name' : null;
}

/**
 * A name is short, title-cased, and made of no function words: one to
 * {@link NAME_MAX_TOKENS} tokens, every one starting uppercase, none in the English,
 * Vietnamese or French function-word lists, and no sentence punctuation beyond an
 * initial's dot ("J. Smith"). "ACME Corporation" and "Nguyễn Văn An" pass; "This is
 * not a name." and "acme corporation" do not.
 */
function isNameLike(text: string): boolean {
  const compact = collapsed(text);
  if (compact.length === 0 || compact.length > MERGE_MAX_CHARS) return false;

  const tokens = compact.split(/\s+/u);
  if (tokens.length === 0 || tokens.length > NAME_MAX_TOKENS) return false;

  // Initials are the one legitimate dot inside a name; remove them, then any leftover
  // clause punctuation means this is a sentence, not a name.
  const withoutInitials = compact.replace(/(^|\s)(\p{Lu})\./gu, '$1');
  if (/[!?;:,.]/u.test(withoutInitials)) return false;

  let words = 0;
  let capitalised = 0;
  let longEnough = false;
  for (const token of tokens) {
    const word = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    if (word.length === 0) return false;
    if (!/\p{Lu}/u.test(word.slice(0, 1))) return false;
    if (isFunctionWord(word.toLowerCase())) return false;
    words += 1;
    capitalised += 1;
    if (word.length >= 2) longEnough = true;
  }
  return words > 0 && capitalised === words && longEnough;
}

function isFunctionWord(word: string): boolean {
  return EN_STOPWORDS.has(word) || VI_STOPWORDS.has(word) || VI_BARE_STOPWORDS.has(word) || FR_STOPWORDS.has(word);
}

function compareCounts(left: LanguageRegionCount, right: LanguageRegionCount): number {
  if (left.blocks !== right.blocks) return right.blocks - left.blocks;
  if (left.regions !== right.regions) return right.regions - left.regions;
  return left.language.localeCompare(right.language);
}

// --- Profile --------------------------------------------------------------

const LETTER = /\p{L}/u;
const DIGIT = /\p{N}/u;

function profileOf(text: string): TextProfile {
  const normalized = text.normalize('NFC');
  const counts: Record<ScriptName, number> = {
    latin: 0,
    han: 0,
    kana: 0,
    hangul: 0,
    cyrillic: 0,
    arabic: 0,
    devanagari: 0,
    thai: 0,
    unknown: 0,
  };
  let letters = 0;
  for (const char of normalized) {
    if (!LETTER.test(char)) continue;
    letters += 1;
    counts[scriptOf(char.codePointAt(0) ?? 0)] += 1;
  }
  const lower = normalized.toLowerCase();
  return {
    text: normalized,
    lower,
    counts,
    letters,
    tokens: lower.split(/[^\p{L}]+/u).filter(token => token.length > 0),
    hasDigit: DIGIT.test(normalized),
  };
}

/**
 * Script of one code point. Same ranges as the private `scriptOf` in `./language`:
 * kana before Han (the CJK compatibility and halfwidth blocks stay with kana), the
 * Hangul syllables before the Cyrillic supplement, and the Latin extensions together.
 */
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

const SCRIPT_ORDER: readonly ScriptName[] = [
  'latin',
  'han',
  'kana',
  'hangul',
  'cyrillic',
  'arabic',
  'devanagari',
  'thai',
  'unknown',
];

function dominantScript(counts: Record<ScriptName, number>): ScriptName {
  let winner: ScriptName = 'unknown';
  let best = 0;
  for (const script of SCRIPT_ORDER) {
    if (counts[script] > best) {
      best = counts[script];
      winner = script;
    }
  }
  return winner;
}

// --- Inputs and small helpers --------------------------------------------

function textOf(block: LanguageBlockInput | undefined): string {
  if (!block) return '';
  const text = typeof block.text === 'string' ? block.text : '';
  if (text.length > 0) return text;
  return typeof block.raw === 'string' ? block.raw : '';
}

function blockIdOf(block: LanguageBlockInput | undefined, index: number): string {
  const id = block?.id;
  return typeof id === 'string' && id.length > 0 ? id : `@${index}`;
}

function pageOf(block: LanguageBlockInput | undefined): number {
  const page = block?.page;
  return typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : 1;
}

function countTokens(tokens: readonly string[], stopwords: ReadonlySet<string>): number {
  let hits = 0;
  for (const token of tokens) if (stopwords.has(token)) hits += 1;
  return hits;
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** Function characters observed, capped: six of them is already saturated evidence. */
function particleCount(text: string, pattern: RegExp): number {
  return Math.min(6, countMatches(text, pattern));
}

function collapsed(text: string): string {
  return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Two decimals, locale-independent, so reason strings are stable across machines. */
function fmt2(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}
