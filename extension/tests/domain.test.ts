import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOMAIN_LANGUAGE,
  DOMAINS,
  DOMAIN_LANGUAGES,
  DOMAIN_REASONS,
  HINT_MAX_PAIRS,
  HINT_MIN_PAIRS,
  MAX_CONFIDENCE,
  SCORED_DOMAINS,
  detectDomain,
  glossaryHints,
  isDocumentDomain,
  promptGuidance,
  type DocumentDomain,
} from '../viewer/src/core/domain';
import { glossaryToPrompt, parseGlossary } from '../viewer/src/core/glossary';

/** A contract paragraph: recital boilerplate, defined terms and clause references. */
const LEGAL_EN =
  'WHEREAS the Supplier wishes to supply goods and the Buyer wishes to purchase them, this Supply Agreement is made between the parties on the Effective Date. ' +
  'HEREINAFTER, "Confidential Information" means any information disclosed by either party. ' +
  'The Supplier shall deliver the Goods in accordance with Clause 4.2, and any breach of this Clause entitles the Buyer to terminate this Agreement.';

/** The same genre in Vietnamese, written with the diacritics a real contract carries. */
const LEGAL_VI =
  'BÊN A đồng ý cung cấp dịch vụ theo các điều khoản của hợp đồng này. ' +
  'Bên B có nghĩa vụ thanh toán trong vòng ba mươi ngày kể từ ngày nhận hoá đơn. ' +
  'Trường hợp Bên B vi phạm nghĩa vụ thanh toán, Bên A có quyền tạm ngừng cung cấp dịch vụ và yêu cầu bồi thường thiệt hại.';

/** `LEGAL_VI` as a user or a bad extractor might type it: no tone marks, `đ` spelled `d`. */
function withoutDiacritics(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[đĐ]/gu, 'd');
}

/** A discharge-summary paragraph: doses, a diagnosis, and one clinical trial. */
const MEDICAL_EN =
  'Mr. Nguyen, a 64-year-old patient, was admitted with worsening shortness of breath. ' +
  'The diagnosis was acute decompensated heart failure, and treatment began with furosemide at a dosage of 40 mg intravenously. ' +
  'The patient tolerated the dose without any adverse event, and the clinical trial coordinator recorded the outcome. ' +
  'No side effect required stopping therapy.';

/** An earnings paragraph: the vocabulary a quarterly release is made of. */
const FINANCIAL_EN =
  'Revenue for the fiscal year rose to $48.2 million, while net profit reached $6.1 million. ' +
  'EBITDA was $9.4 million, and cash flow from operations improved. ' +
  'The balance sheet reports total assets of $61 million and liabilities of $22 million. ' +
  'The board declared a dividend of $0.12 per share, payable next quarter.';

/** A Chinese earnings paragraph: no spaces, so terms are matched as substrings. */
const FINANCIAL_ZH =
  '本财年收入达到四点八二亿元，净利润为六千一百万元。经营活动现金流明显改善，资产负债表显示总资产六点一亿元、负债二点二亿元。' +
  '董事会宣布每股股息零点一二元，并计划在下一季度回购股票。';

/** The same financial genre in Vietnamese, used beside the contract in the mixed document. */
const FINANCIAL_VI =
  'Doanh thu quý này đạt 48 tỷ đồng, lợi nhuận sau thuế là 6 tỷ đồng. ' +
  'Dòng tiền từ hoạt động kinh doanh cải thiện rõ rệt, và bảng cân đối kế toán cho thấy tổng tài sản 61 tỷ đồng.';

/** A migration-guide paragraph: endpoints, modules and one timeout. */
const TECHNICAL_EN =
  'The client calls the /v2/search endpoint with a query string and receives a paginated response. ' +
  'The function that builds the request lives in the search module, and it depends on the HTTP client\'s configuration. ' +
  'If the API returns a timeout, the module retries once before surfacing the error.';

/** A paper paragraph: an abstract, a method, a citation and a p-value. */
const ACADEMIC_EN =
  'Abstract: we test whether retrieval-augmented generation improves answer accuracy. ' +
  'Our methodology follows the protocol of Smith et al. (2021), and the hypothesis is that grounding reduces hallucination. ' +
  'With a sample size of 240 passages, the treatment effect reached significance (p-value = 0.003). ' +
  'The literature review and peer review sections discuss reproducibility.';

describe('detectDomain per genre', () => {
  it('reads an English contract as legal', () => {
    const detection = detectDomain(LEGAL_EN);
    expect(detection.domain).toBe('legal');
    expect(detection.scores).toEqual({ legal: 19, medical: 0, financial: 0, technical: 0, academic: 0 });
    expect(detection.confidence).toBe(MAX_CONFIDENCE);
    expect(detection.reasons).toEqual([DOMAIN_REASONS.single]);
  });

  it('reads a Vietnamese contract as legal', () => {
    const detection = detectDomain(LEGAL_VI);
    expect(detection.domain).toBe('legal');
    // Bên A twice, Bên B twice, hợp đồng, điều, khoản, nghĩa vụ twice, vi phạm, bồi thường.
    expect(detection.scores.legal).toBe(22);
    expect(detection.confidence).toBe(MAX_CONFIDENCE);
    expect(detection.reasons).toEqual([DOMAIN_REASONS.single]);
  });

  it('scores accented and unaccented Vietnamese the same', () => {
    const accented = detectDomain(LEGAL_VI);
    const plain = detectDomain(withoutDiacritics(LEGAL_VI));
    expect(plain.domain).toBe('legal');
    expect(plain.scores).toEqual(accented.scores);
  });

  it('reads a discharge summary as medical', () => {
    const detection = detectDomain(MEDICAL_EN);
    expect(detection.domain).toBe('medical');
    expect(detection.scores).toEqual({ legal: 0, medical: 19, financial: 0, technical: 0, academic: 0 });
    expect(detection.reasons).toEqual([DOMAIN_REASONS.single]);
  });

  it('reads an earnings release as financial', () => {
    const detection = detectDomain(FINANCIAL_EN);
    expect(detection.domain).toBe('financial');
    expect(detection.scores).toEqual({ legal: 0, medical: 0, financial: 21, technical: 0, academic: 0 });
    expect(detection.reasons).toEqual([DOMAIN_REASONS.single]);
  });

  it('reads a Chinese earnings release as financial', () => {
    const detection = detectDomain(FINANCIAL_ZH);
    // 收入, 利润, 股票 (strong), 现金流 once each; 资产 and 负债 twice, inside
    // 资产负债表 and again beside the totals.
    expect(detection.domain).toBe('financial');
    expect(detection.scores.financial).toBe(17);
    expect(detection.scores.legal).toBe(0);
  });

  it('reads a migration guide as technical', () => {
    const detection = detectDomain(TECHNICAL_EN);
    expect(detection.domain).toBe('technical');
    expect(detection.scores).toEqual({ legal: 0, medical: 0, financial: 0, technical: 18, academic: 0 });
    expect(detection.reasons).toEqual([DOMAIN_REASONS.single]);
  });

  it('reads a paper paragraph as academic, even though it mentions a treatment', () => {
    const detection = detectDomain(ACADEMIC_EN);
    expect(detection.domain).toBe('academic');
    expect(detection.scores.academic).toBe(23);
    // `treatment` is medical vocabulary, but two points is not a second genre.
    expect(detection.scores.medical).toBe(2);
    expect(detection.reasons).toEqual([DOMAIN_REASONS.single]);
  });
});

describe('detectDomain mixed and ambiguous text', () => {
  it('names the dominant genre of a mixed document and lowers its confidence', () => {
    const legalOnly = detectDomain(LEGAL_VI);
    const mixed = detectDomain(`${LEGAL_VI} ${FINANCIAL_VI}`);

    expect(mixed.domain).toBe('legal');
    expect(mixed.scores.legal).toBe(22);
    expect(mixed.scores.financial).toBe(11);
    expect(mixed.confidence).toBe(0.667);
    expect(mixed.confidence).toBeLessThan(legalOnly.confidence);
    expect(mixed.reasons).toEqual([DOMAIN_REASONS.mixed]);
  });

  it('breaks a tie by the documented domain order', () => {
    const detection = detectDomain(
      'The first party will review the revenue figures, and the second party will confirm the revenue totals before the meeting ends next week.',
    );
    expect(detection.scores.legal).toBe(4);
    expect(detection.scores.financial).toBe(4);
    // legal precedes financial in SCORED_DOMAINS, so an ambiguous document is legal.
    expect(SCORED_DOMAINS.indexOf('legal')).toBeLessThan(SCORED_DOMAINS.indexOf('financial'));
    expect(detection.domain).toBe('legal');
    expect(detection.confidence).toBe(0.25);
    expect(detection.reasons).toEqual([DOMAIN_REASONS.tie, DOMAIN_REASONS.mixed]);
  });

  it('refuses to name a genre from a heading', () => {
    const detection = detectDomain('Hợp đồng thuê nhà');
    expect(detection.domain).toBe('general');
    expect(detection.confidence).toBe(0);
    expect(detection.reasons).toEqual([DOMAIN_REASONS.thin]);
    // The evidence is still reported: a contract heading is legal evidence, not a document.
    expect(detection.scores.legal).toBe(3);
  });

  it('refuses a long text whose only signal is one ambiguous syllable', () => {
    const detection = detectDomain(
      'Điều kiện thời tiết hôm nay khá thuận lợi cho việc tổ chức sự kiện ngoài trời. ' +
        'Ban tổ chức đã kiểm tra điều kiện âm thanh và ánh sáng trước khi chương trình bắt đầu. ' +
        'Nếu điều kiện cho phép, buổi biểu diễn sẽ kéo dài đến tối muộn.',
    );
    expect(detection.scores.legal).toBe(3);
    expect(detection.domain).toBe('general');
    expect(detection.confidence).toBe(0);
    expect(detection.reasons).toEqual([DOMAIN_REASONS.weak]);
  });

  it('returns general with no-keywords for a long text without genre vocabulary', () => {
    const detection = detectDomain(
      'The meeting started late because the train was delayed, and the team spent the rest of the morning rearranging the schedule for next month.',
    );
    expect(detection.domain).toBe('general');
    expect(detection.scores).toEqual({ legal: 0, medical: 0, financial: 0, technical: 0, academic: 0 });
    expect(detection.reasons).toEqual([DOMAIN_REASONS.none]);
  });

  it('treats empty and whitespace-only text as thin', () => {
    for (const text of ['', '   \n\t ', '\u00a0']) {
      const detection = detectDomain(text);
      expect(detection.domain).toBe('general');
      expect(detection.confidence).toBe(0);
      expect(detection.reasons).toEqual([DOMAIN_REASONS.thin]);
    }
  });

  it('caps how much one repeated keyword can contribute', () => {
    const detection = detectDomain(
      'Revenue grew again this spring. Revenue grew again this summer. Revenue grew again this autumn. ' +
        'Revenue grew again this winter. Revenue grew again in the final report, and the team read the whole file before the meeting closed.',
    );
    // Five occurrences, three counted: 3 * 2, not 5 * 2.
    expect(detection.scores.financial).toBe(6);
    expect(detection.domain).toBe('financial');
  });
});

describe('detectDomain contract', () => {
  it('reports one score per scored domain and never a general score', () => {
    const detection = detectDomain(LEGAL_EN);
    // Keys keep the documented order, so a caller can render the scores as they are.
    expect(Object.keys(detection.scores)).toEqual([...SCORED_DOMAINS]);
  });

  it('keeps domain, confidence and reasons in their documented ranges', () => {
    for (const text of [LEGAL_EN, MEDICAL_EN, FINANCIAL_EN, TECHNICAL_EN, ACADEMIC_EN, 'short heading']) {
      const detection = detectDomain(text);
      expect(isDocumentDomain(detection.domain)).toBe(true);
      expect(detection.confidence).toBeGreaterThanOrEqual(0);
      expect(detection.confidence).toBeLessThanOrEqual(MAX_CONFIDENCE);
      expect(detection.reasons.length).toBeGreaterThan(0);
      for (const score of Object.values(detection.scores)) expect(Number.isInteger(score)).toBe(true);
    }
  });

  it('is deterministic and ignores a non-string at runtime', () => {
    expect(detectDomain(LEGAL_EN)).toEqual(detectDomain(LEGAL_EN));
    const broken = detectDomain(42 as unknown as string);
    expect(broken.domain).toBe('general');
    expect(broken.reasons).toEqual([DOMAIN_REASONS.thin]);
  });

  it('recognises every documented domain, and nothing else', () => {
    for (const domain of DOMAINS) expect(isDocumentDomain(domain)).toBe(true);
    expect(DOMAINS).toContain('general');
    for (const value of ['poetry', '', 'General', null, undefined, 1, {}]) {
      expect(isDocumentDomain(value)).toBe(false);
    }
  });
});

describe('promptGuidance', () => {
  it('returns instruction lines for every domain in every language', () => {
    for (const domain of DOMAINS) {
      for (const language of DOMAIN_LANGUAGES) {
        const lines = promptGuidance(domain, language);
        expect(lines.length, `${domain}/${language}`).toBeGreaterThan(0);
        expect(new Set(lines).size, `${domain}/${language} duplicates`).toBe(lines.length);
        for (const line of lines) {
          expect(typeof line).toBe('string');
          expect(line.trim()).toBe(line);
          expect(line.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('carries the genre convention rather than generic filler', () => {
    expect(promptGuidance('legal', 'en').join('\n')).toContain('defined term');
    expect(promptGuidance('legal', 'vi').join('\n')).toContain('điều, khoản');
    expect(promptGuidance('legal', 'zh').join('\n')).toContain('条款');
    expect(promptGuidance('medical', 'en').join('\n')).toContain('dosage');
    expect(promptGuidance('medical', 'vi').join('\n')).toContain('liều lượng');
    expect(promptGuidance('medical', 'zh').join('\n')).toContain('剂量');
    expect(promptGuidance('financial', 'en').join('\n')).toContain('currency');
    expect(promptGuidance('technical', 'en').join('\n')).toContain('identifiers');
    expect(promptGuidance('academic', 'en').join('\n')).toContain('citation');
  });

  it('writes each language separately', () => {
    const legal = DOMAIN_LANGUAGES.map(language => promptGuidance('legal', language).join('\n'));
    expect(new Set(legal).size).toBe(DOMAIN_LANGUAGES.length);
  });

  it('returns a copy the caller may edit', () => {
    const lines = promptGuidance('legal', 'en');
    const length = lines.length;
    lines.push('an extra line');
    expect(promptGuidance('legal', 'en')).toHaveLength(length);
  });

  it('falls back to the default language for an unknown one', () => {
    const fallback = promptGuidance('legal', 'fr' as unknown as typeof DEFAULT_DOMAIN_LANGUAGE);
    expect(fallback).toEqual(promptGuidance('legal', DEFAULT_DOMAIN_LANGUAGE));
  });

  it('refuses an unknown domain', () => {
    expect(() => promptGuidance('poetry' as unknown as DocumentDomain)).toThrow(RangeError);
    expect(() => promptGuidance('poetry' as unknown as DocumentDomain)).toThrow(/promptGuidance: unknown domain/);
  });
});

describe('glossaryHints', () => {
  it('offers 10 to 20 distinct pairs for every domain and language', () => {
    for (const domain of DOMAINS) {
      for (const language of DOMAIN_LANGUAGES) {
        const hints = glossaryHints(domain, language);
        expect(hints.length, `${domain}/${language}`).toBeGreaterThanOrEqual(HINT_MIN_PAIRS);
        expect(hints.length, `${domain}/${language}`).toBeLessThanOrEqual(HINT_MAX_PAIRS);

        const sources = new Set(hints.map(hint => hint.source));
        const pairs = new Set(hints.map(hint => `${hint.source}\u0000${hint.target}`));
        expect(sources.size, `${domain}/${language} sources`).toBe(hints.length);
        expect(pairs.size, `${domain}/${language} pairs`).toBe(hints.length);
        for (const hint of hints) {
          expect(hint.source.trim()).toBe(hint.source);
          expect(hint.target.trim()).toBe(hint.target);
          expect(hint.source.length).toBeGreaterThan(0);
          expect(hint.target.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('points each pair the way the reader would type it', () => {
    expect(glossaryHints('legal', 'vi')).toContainEqual({ source: 'contract', target: 'hợp đồng' });
    expect(glossaryHints('legal', 'zh')).toContainEqual({ source: 'contract', target: '合同' });
    expect(glossaryHints('legal', 'en')).toContainEqual({ source: 'hợp đồng', target: 'contract' });
    expect(glossaryHints('medical', 'vi')).toContainEqual({ source: 'patient', target: 'bệnh nhân' });
  });

  it('produces pairs the glossary parser accepts, one line each', () => {
    for (const domain of ['legal', 'medical', 'financial', 'technical', 'academic'] as const) {
      const hints = glossaryHints(domain, 'vi');
      const parsed = parseGlossary(glossaryToPrompt(hints));
      expect(parsed.issues, domain).toEqual([]);
      expect(parsed.entries, domain).toHaveLength(hints.length);
    }
  });

  it('returns fresh objects the caller may edit', () => {
    const first = glossaryHints('legal', 'vi')[0]!;
    first.target = 'changed by the caller';
    expect(glossaryHints('legal', 'vi')[0]?.target).toBe('hợp đồng');
  });

  it('refuses an unknown domain', () => {
    expect(() => glossaryHints('poetry' as unknown as DocumentDomain)).toThrow(RangeError);
    expect(() => glossaryHints('poetry' as unknown as DocumentDomain)).toThrow(/glossaryHints: unknown domain/);
  });
});
