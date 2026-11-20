import { describe, expect, it } from 'vitest';
import {
  MERGE_MAX_CHARS,
  NAME_MAX_TOKENS,
  UND_LANGUAGE,
  detectBlockLanguage,
  segmentByLanguage,
  summary,
} from '../src/core/language-regions';
import type { BlockLanguage, LanguageBlockInput, LanguageRegion } from '../src/core/language-regions';

/** A Vietnamese contract sentence: exclusive letters, tone marks and function words. */
const VI_BODY = 'Bên bán cam kết bàn giao hàng hóa đúng thời hạn và chịu trách nhiệm về chất lượng sản phẩm.';

/** A second Vietnamese sentence, so a region can be longer than one block. */
const VI_BODY_2 = 'Bên mua thanh toán đầy đủ theo tiến độ đã thỏa thuận trong hợp đồng này.';

/** English prose with no Vietnamese letters at all. */
const EN_BODY = 'The agreement is made between the parties and shall be governed by the laws of England.';

/** One-line English abstract, the bilingual-paper case the backlog names. */
const EN_ABSTRACT = 'This paper presents a block level language detector for bilingual documents.';

const VI_LETTERS_ONLY = 'Đường phố Hà Nội đẹp quá';
const ZH = '根据合同条款，买方应当在三十日内支付货款。';
const JA = '本契約の内容は日本語で記載されています。';
const KO = '본 계약의 내용은 다음과 같습니다.';
const FR = 'Le contrat est conclu entre les parties et doit être exécuté de bonne foi.';
const RU = 'Настоящий договор заключается между сторонами.';
const AR = 'هذا العقد مبرم بين الطرفين.';
const TH = 'สัญญาฉบับนี้ทำขึ้นระหว่างคู่สัญญา';

/** A name: title-cased, no function words, no sentence punctuation. */
const NAME = 'ACME Corporation';

/** A numeric table body: digits and separators only. */
const NUMBERS = '1\t2\t3\n4\t5\t6';

const SYMBOLS = '— · § ¶';

function block(id: string, page: number, text: string): LanguageBlockInput {
  return { id, page, text };
}

function view(regions: readonly LanguageRegion[]) {
  return regions.map(region => ({ language: region.language, ids: region.blockIds, pages: region.pages }));
}

function languageOf(text: string): BlockLanguage {
  return detectBlockLanguage({ page: 1, text });
}

describe('detectBlockLanguage', () => {
  it('reads Vietnamese with diacritics and names English as the alternate', () => {
    const vi = languageOf(VI_BODY);
    expect(vi.language).toBe('vi');
    expect(vi.confidence).toBeGreaterThan(0.6);
    expect(vi.alternates).toContain('en');
    expect(vi.alternates).not.toContain('vi');
    expect(vi.reasons).toContain('script:dominant=latin');
    expect(vi.reasons.some(reason => reason.startsWith('latin:vi-letters='))).toBe(true);
  });

  it('reads English prose and never offers Vietnamese for it', () => {
    const en = languageOf(EN_BODY);
    expect(en.language).toBe('en');
    expect(en.confidence).toBeGreaterThan(0.7);
    expect(en.alternates).not.toContain('vi');
    expect(en.reasons.some(reason => reason.startsWith('latin:en-stopwords='))).toBe(true);
  });

  it('reads Vietnamese from its own letters, not from the document', () => {
    expect(languageOf(VI_LETTERS_ONLY).language).toBe('vi');
    expect(languageOf(VI_LETTERS_ONLY).confidence).toBeGreaterThan(0.5);
  });

  it('reads a French sentence from its function words', () => {
    const fr = languageOf(FR);
    expect(fr.language).toBe('fr');
    expect(fr.alternates).toContain('en');
  });

  it('separates Chinese from Japanese by kana presence', () => {
    const zh = languageOf(ZH);
    const ja = languageOf(JA);
    expect(zh.language).toBe('zh');
    expect(zh.alternates).toContain('ja');
    expect(ja.language).toBe('ja');
    expect(ja.alternates).toContain('zh');
    // Without kana the Han block is Chinese but not certain: kanji-only Japanese exists,
    // so the margin over that candidate, and with it the confidence, stays smaller.
    expect(zh.confidence).toBeLessThan(ja.confidence);
    expect(zh.reasons).toContain('cjk:kana=0');
    expect(ja.reasons.some(reason => /^cjk:kana=[1-9]/u.test(reason))).toBe(true);
  });

  it('reads Korean from Hangul', () => {
    const ko = languageOf(KO);
    expect(ko.language).toBe('ko');
    expect(ko.alternates).not.toContain('ko');
    expect(ko.confidence).toBeGreaterThan(0.8);
  });

  it('sharpens a Han block with Chinese function characters', () => {
    const bare = languageOf('合同条款规定买方支付货款');
    const particles = languageOf('我们的合同是在双方同意的基础上签订的');
    expect(bare.language).toBe('zh');
    expect(particles.language).toBe('zh');
    expect(particles.confidence).toBeGreaterThan(bare.confidence);
  });

  it('maps single-script blocks onto Russian, Arabic and Thai', () => {
    expect(languageOf(RU).language).toBe('ru');
    expect(languageOf(AR).language).toBe('ar');
    expect(languageOf(TH).language).toBe('th');
    expect(languageOf(RU).reasons).toContain('script:dominant=cyrillic');
  });

  it('classifies a numeric table block as und', () => {
    const numeric = languageOf(NUMBERS);
    expect(numeric.language).toBe(UND_LANGUAGE);
    expect(numeric.confidence).toBeGreaterThan(0.9);
    expect(numeric.reasons).toContain('und:numeric');
    expect(numeric.alternates).toEqual([]);
  });

  it('classifies a symbol-only block and an empty block as und', () => {
    expect(languageOf(SYMBOLS).reasons).toContain('und:symbols');
    expect(languageOf(SYMBOLS).language).toBe(UND_LANGUAGE);
    const empty = languageOf('   ');
    expect(empty.language).toBe(UND_LANGUAGE);
    expect(empty.confidence).toBe(0);
    expect(empty.reasons).toContain('und:empty');
  });

  it('refuses to guess a language for a name with no evidence', () => {
    const name = languageOf(NAME);
    expect(name.language).toBe(UND_LANGUAGE);
    expect(name.reasons).toContain('und:no-language-evidence');
    expect(name.alternates).toEqual([]);
  });

  it('caps confidence for a block too short to decide', () => {
    expect(languageOf('Đ').confidence).toBeLessThanOrEqual(0.5);
  });

  it('accepts an IR block, whose text lives in raw', () => {
    expect(detectBlockLanguage({ id: 'p1-r0', page: 1, raw: VI_BODY }).language).toBe('vi');
  });

  it('keeps confidence in range and alternates free of the winner', () => {
    for (const text of [VI_BODY, EN_BODY, VI_LETTERS_ONLY, ZH, JA, KO, FR, RU, AR, TH, NUMBERS, NAME, '']) {
      const result = languageOf(text);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(0.97);
      expect(result.alternates).not.toContain(result.language);
      expect(new Set(result.alternates).size).toBe(result.alternates.length);
      for (const alternate of result.alternates) expect(alternate).not.toBe(UND_LANGUAGE);
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    for (const text of [VI_BODY, EN_ABSTRACT, ZH, JA, KO, NAME, NUMBERS, '']) {
      expect(JSON.stringify(languageOf(text))).toBe(JSON.stringify(languageOf(text)));
    }
  });
});

describe('segmentByLanguage', () => {
  it('gives a one-line English abstract its own region inside a Vietnamese document', () => {
    const regions = segmentByLanguage([
      block('p1-r0', 1, VI_BODY),
      block('p1-r1', 1, VI_BODY_2),
      block('p2-r0', 2, EN_ABSTRACT),
      block('p2-r1', 2, VI_BODY),
    ]);

    expect(view(regions)).toEqual([
      { language: 'vi', ids: ['p1-r0', 'p1-r1'], pages: [1] },
      { language: 'en', ids: ['p2-r0'], pages: [2] },
      { language: 'vi', ids: ['p2-r1'], pages: [2] },
    ]);
  });

  it('merges a region interrupted by a single name but not by a sentence', () => {
    const merged = segmentByLanguage([
      block('p1-r0', 1, VI_BODY),
      block('p1-r1', 1, VI_BODY_2),
      block('p1-r2', 1, NAME),
      block('p2-r0', 2, VI_BODY),
    ]);
    expect(view(merged)).toEqual([
      { language: 'vi', ids: ['p1-r0', 'p1-r1', 'p1-r2', 'p2-r0'], pages: [1, 2] },
    ]);

    const interrupted = segmentByLanguage([
      block('p1-r0', 1, VI_BODY),
      block('p1-r1', 1, VI_BODY_2),
      block('p1-r2', 1, EN_BODY),
      block('p2-r0', 2, VI_BODY),
    ]);
    expect(interrupted.map(region => region.language)).toEqual(['vi', 'en', 'vi']);
  });

  it('merges a single numeric block into the region it interrupts', () => {
    const regions = segmentByLanguage([
      block('p1-r0', 1, VI_BODY),
      block('p1-r1', 1, NUMBERS),
      block('p1-r2', 1, VI_BODY_2),
    ]);
    expect(view(regions)).toEqual([
      { language: 'vi', ids: ['p1-r0', 'p1-r1', 'p1-r2'], pages: [1] },
    ]);
  });

  it('joins an absorbable block at the edge of the document to its only neighbour', () => {
    const regions = segmentByLanguage([
      block('p1-r0', 1, '12'),
      block('p1-r1', 1, VI_BODY),
      block('p1-r2', 1, VI_BODY_2),
    ]);
    expect(view(regions)).toEqual([
      { language: 'vi', ids: ['p1-r0', 'p1-r1', 'p1-r2'], pages: [1] },
    ]);
  });

  it('leaves two absorbable blocks in a row as their own region', () => {
    const regions = segmentByLanguage([
      block('p1-r0', 1, VI_BODY),
      block('p1-r1', 1, NUMBERS),
      block('p1-r2', 1, '7 8 9'),
      block('p2-r0', 2, VI_BODY_2),
    ]);
    expect(regions.map(region => region.language)).toEqual(['vi', 'und', 'vi']);
  });

  it('never merges between two different surrounding languages', () => {
    const regions = segmentByLanguage([
      block('p1-r0', 1, EN_BODY),
      block('p1-r1', 1, NAME),
      block('p1-r2', 1, VI_BODY),
    ]);
    expect(view(regions)).toEqual([
      { language: 'en', ids: ['p1-r0'], pages: [1] },
      { language: 'und', ids: ['p1-r1'], pages: [1] },
      { language: 'vi', ids: ['p1-r2'], pages: [1] },
    ]);
  });

  it('keeps one region per run and reports its pages once, ascending', () => {
    const regions = segmentByLanguage([block('p1-r0', 1, VI_BODY), block('p3-r0', 3, VI_BODY_2)]);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.pages).toEqual([1, 3]);
  });

  it('labels a block without an id instead of dropping it', () => {
    const regions = segmentByLanguage([{ page: 2, text: VI_BODY }]);
    expect(regions[0]?.blockIds).toEqual(['@0']);
    expect(regions[0]?.pages).toEqual([2]);
  });

  it('returns no regions for no blocks and does not mutate its input', () => {
    expect(segmentByLanguage([])).toEqual([]);

    const input = [
      block('p1-r0', 1, VI_BODY),
      block('p1-r1', 1, NAME),
      block('p2-r0', 2, VI_BODY_2),
    ];
    const snapshot = JSON.stringify(input);
    segmentByLanguage(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('summary', () => {
  it('counts regions, blocks and pages per language and names the dominant one', () => {
    const regions = segmentByLanguage([
      block('p1-r0', 1, VI_BODY),
      block('p1-r1', 1, VI_BODY_2),
      block('p2-r0', 2, EN_ABSTRACT),
      block('p2-r1', 2, VI_BODY),
    ]);
    const report = summary(regions);

    expect(report.regions).toBe(3);
    expect(report.blocks).toBe(4);
    expect(report.dominant).toBe('vi');
    expect(report.counts).toEqual([
      { language: 'vi', regions: 2, blocks: 3, pages: 2 },
      { language: 'en', regions: 1, blocks: 1, pages: 1 },
    ]);
    expect(report.counts.reduce((total, count) => total + count.blocks, 0)).toBe(report.blocks);
    expect(report.counts.reduce((total, count) => total + count.regions, 0)).toBe(report.regions);
  });

  it('keeps und in the counts but never lets it be dominant', () => {
    const report = summary([
      { language: UND_LANGUAGE, blockIds: ['a', 'b', 'c'], pages: [1, 1, 2] },
      { language: 'vi', blockIds: ['d', 'e'], pages: [1] },
    ]);
    expect(report.counts[0]).toEqual({ language: UND_LANGUAGE, regions: 1, blocks: 3, pages: 2 });
    expect(report.dominant).toBe('vi');
    expect(report.regions).toBe(2);
    expect(report.blocks).toBe(5);
  });

  it('reports und and zero totals for an empty region list', () => {
    expect(summary([])).toEqual({ counts: [], dominant: UND_LANGUAGE, regions: 0, blocks: 0 });
  });
});

describe('documented limits', () => {
  it('merges a name of NAME_MAX_TOKENS tokens but not one token longer', () => {
    const atLimit = Array.from({ length: NAME_MAX_TOKENS }, (_, index) => `Firm${index}`).join(' ');
    const pastLimit = `${atLimit} Extra`;

    expect(segmentByLanguage([block('a', 1, VI_BODY), block('b', 1, atLimit), block('c', 1, VI_BODY_2)])
      .map(region => region.language)).toEqual(['vi']);
    expect(segmentByLanguage([block('a', 1, VI_BODY), block('b', 1, pastLimit), block('c', 1, VI_BODY_2)])
      .map(region => region.language)).toEqual(['vi', 'und', 'vi']);
  });

  it('leaves a numeric block longer than MERGE_MAX_CHARS as its own region', () => {
    const longNumbers = '1 '.repeat(MERGE_MAX_CHARS);
    expect(longNumbers.trim().length).toBeGreaterThan(MERGE_MAX_CHARS);
    expect(segmentByLanguage([block('a', 1, VI_BODY), block('b', 1, longNumbers), block('c', 1, VI_BODY_2)])
      .map(region => region.language)).toEqual(['vi', 'und', 'vi']);
  });
});
