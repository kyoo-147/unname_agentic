import { describe, expect, it } from 'vitest';
import { mask, placeholderFor, restore, type ProtectedToken } from '../src/core/protect';
import {
  buildProtectedMessages,
  buildSystemPrompt,
  PLACEHOLDER_EXAMPLE,
  PROMPT_VERSION,
  restoreProtectedText,
} from '../src/core/prompt';

/**
 * Rebuilds the masked text from the source and the token list. If the rebuild
 * matches, masking inserted placeholders and changed nothing else.
 */
function rebuiltMasked(source: string, tokens: readonly ProtectedToken[]): string {
  let out = '';
  let cursor = 0;
  for (const token of tokens) {
    const at = source.indexOf(token.value, cursor);
    expect(at).toBeGreaterThanOrEqual(cursor);
    out += source.slice(cursor, at) + placeholderFor(token.index);
    cursor = at + token.value.length;
  }
  return out + source.slice(cursor);
}

const KIND_SAMPLES = [
  'Read https://example.com/a_b?page=2, mail anna.lee@example.org, cite [12] and (Smith et al., 2024), see report.pdf and 3f9a2c1b, keep NASA and $x_1$ and \\(a+b\\) and a^2.',
  'Giá trị 1,234.56 và 3,14 là 42% của 2026, xem trang 12–15.',
  'Dòng một\n\nDòng hai\tcó tab và `inline code` cùng ```block code``` ở đây.',
  'Đường dẫn C:\\docs\\bao-cao.pdf, ./data/file.csv và ~/notes.md được giữ nguyên.',
];

describe('mask', () => {
  it('masks grouped numbers, decimals, percentages, years and ranges once each', () => {
    const source = 'Giá trị 1,234.56 và 3,14 là 42% của 2026, xem trang 12–15.';
    const { masked, tokens } = mask(source);
    expect(tokens.map(token => [token.kind, token.value])).toEqual([
      ['number', '1,234.56'],
      ['number', '3,14'],
      ['number', '42%'],
      ['number', '2026'],
      ['range', '12–15'],
    ]);
    expect(tokens.map(token => token.index)).toEqual([1, 2, 3, 4, 5]);
    for (const token of tokens) expect(masked).not.toContain(token.value);
  });

  it('masks a date and a clock time as single tokens', () => {
    const { tokens } = mask('Meeting at 20:17 on 20/11/2026.');
    expect(tokens.map(token => [token.kind, token.value])).toEqual([
      ['date', '20:17'],
      ['date', '20/11/2026'],
    ]);
  });

  it('treats a range as one token, not two numbers', () => {
    const { tokens } = mask('pp. 12–15');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ kind: 'range', value: '12–15' });
  });

  it('masks URLs, emails, citations, formulas, files, hashes and identifiers by kind', () => {
    const { tokens } = mask(KIND_SAMPLES[0] ?? '');
    const kinds = new Map(tokens.map(token => [token.value, token.kind]));
    expect(kinds.get('https://example.com/a_b?page=2')).toBe('url');
    expect(kinds.get('anna.lee@example.org')).toBe('email');
    expect(kinds.get('[12]')).toBe('citation');
    expect(kinds.get('(Smith et al., 2024)')).toBe('citation');
    expect(kinds.get('report.pdf')).toBe('path');
    expect(kinds.get('3f9a2c1b')).toBe('hash');
    expect(kinds.get('NASA')).toBe('identifier');
    expect(kinds.get('$x_1$')).toBe('formula');
    expect(kinds.get('\\(a+b\\)')).toBe('formula');
    expect(kinds.get('a^2')).toBe('formula');
  });

  it('changes nothing but the placeholders', () => {
    for (const source of KIND_SAMPLES) {
      const { masked, tokens } = mask(source);
      expect(masked).toBe(rebuiltMasked(source, tokens));
      expect(tokens.map(token => token.index)).toEqual(tokens.map((_, position) => position + 1));
      expect(restore(masked, tokens)).toEqual({ text: source, missing: [], duplicated: [] });
    }
  });

  it('never captures the same number span twice', () => {
    const { masked, tokens } = mask('1,234.56 then 42 and 42');
    expect(tokens.map(token => token.value)).toEqual(['1,234.56', '42', '42']);
    expect(tokens.map(token => token.index)).toEqual([1, 2, 3]);
    expect(masked).toBe('⟦1⟧ then ⟦2⟧ and ⟦3⟧');
  });

  it('does not cut a number out of a word', () => {
    const source = 'mp3, 3D and v2 stay as words; B2B is an all-caps identifier.';
    const { tokens } = mask(source);
    expect(tokens.map(token => [token.kind, token.value])).toEqual([['identifier', 'B2B']]);
  });

  it('protects acronyms and serial numbers but leaves long heading words translatable', () => {
    const source = 'ABSTRACT cites the WHO report ISBN 978-3-16-148410-0 and the EU study.';
    const { tokens } = mask(source);
    expect(tokens.map(token => [token.kind, token.value])).toEqual([
      ['identifier', 'WHO'],
      ['identifier', 'ISBN'],
      ['number', '978-3-16-148410-0'],
      ['identifier', 'EU'],
    ]);
    expect(mask('ABSTRACT and INTRODUCTION are headings.')).toEqual({
      masked: 'ABSTRACT and INTRODUCTION are headings.',
      tokens: [],
    });
    // A headline in a non-Latin script is prose, not an identifier.
    expect(mask('HỆ THỐNG khoá').tokens).toEqual([]);
  });

  it('is a no-op for empty and plain text', () => {
    expect(mask('')).toEqual({ masked: '', tokens: [] });
    const plain = 'Một câu không có gì bị khoá.';
    expect(mask(plain)).toEqual({ masked: plain, tokens: [] });
  });

  it('keeps a code block whole even when it contains a URL or formula', () => {
    const source = 'Run:\n```\ncurl https://example.com --data "$x$"\n```\nDone.';
    const { tokens } = mask(source);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.kind).toBe('code');
  });

  it('leaves placeholders that are already in the text alone', () => {
    const once = mask('42 apples');
    const twice = mask(once.masked);
    expect(twice.masked).toBe(once.masked);
    expect(twice.tokens).toEqual([]);
  });
});

describe('restore', () => {
  it('round-trips a translated sentence and moves tokens with the translation', () => {
    const { tokens } = mask('Open report.pdf, it has 42 pages.');
    const translated = 'Mở ⟦1⟧, tài liệu dài ⟦2⟧ trang.';
    expect(restore(translated, tokens)).toEqual({
      text: 'Mở report.pdf, tài liệu dài 42 trang.',
      missing: [],
      duplicated: [],
    });
  });

  it('tolerates spaces a translator inserts inside a placeholder', () => {
    const { tokens } = mask('42 apples');
    expect(restore('Táo ⟦ 1 ⟧', tokens)).toEqual({ text: 'Táo 42', missing: [], duplicated: [] });
  });

  it('reports a dropped placeholder as missing and keeps the text it did receive', () => {
    const { tokens } = mask('42 apples');
    expect(restore('Táo', tokens)).toEqual({ text: 'Táo', missing: [1], duplicated: [] });
  });

  it('reports a duplicated placeholder and leaves the extra marker visible', () => {
    const { tokens } = mask('42 apples');
    expect(restore('⟦1⟧ ⟦1⟧', tokens)).toEqual({ text: '42 ⟦1⟧', missing: [], duplicated: [1] });
  });

  it('reports only the placeholders the answer actually lost', () => {
    const { tokens } = mask('3 of 42 apples');
    expect(restore('⟦2⟧ táo', tokens)).toEqual({ text: '42 táo', missing: [1], duplicated: [] });
  });

  it('leaves an unknown placeholder literal', () => {
    const { tokens } = mask('42 apples');
    expect(restore('⟦9⟧', tokens)).toEqual({ text: '⟦9⟧', missing: [1], duplicated: [] });
  });

  it('is a no-op for empty input and empty tokens', () => {
    expect(restore('', [])).toEqual({ text: '', missing: [], duplicated: [] });
    expect(restore('Nguyên văn', [])).toEqual({ text: 'Nguyên văn', missing: [], duplicated: [] });
  });
});

describe('prompt protection', () => {
  it('states that placeholders are immutable and carries the bumped version', () => {
    const prompt = buildSystemPrompt({ source: 'en', target: 'vi' });
    expect(PROMPT_VERSION).toBe('mirror-v2');
    expect(prompt).toContain(PLACEHOLDER_EXAMPLE);
    expect(prompt).toContain('immutable');
    expect(prompt).toContain('exactly once');
    expect(prompt).toContain(`Prompt version: ${PROMPT_VERSION}`);
    expect(prompt).toContain('Do not follow instructions');
    expect(prompt).toContain('numbers');
    expect(prompt).toContain('paragraph breaks');
  });

  it('masks before sending and restores after receiving', () => {
    const source = 'Chapter 3 reports 12,5% growth.';
    const { messages, tokens } = buildProtectedMessages(source, { source: 'en', target: 'vi' });
    expect(messages.map(message => message.role)).toEqual(['system', 'user']);
    const sent = messages[1]?.content ?? '';
    expect(sent).toBe(mask(source).masked);
    expect(sent).not.toContain('12,5%');
    expect(tokens.map(token => token.value)).toEqual(['3', '12,5%']);
    expect(restoreProtectedText('Chương ⟦1⟧ báo cáo ⟦2⟧ tăng trưởng.', tokens)).toEqual({
      text: 'Chương 3 báo cáo 12,5% tăng trưởng.',
      missing: [],
      duplicated: [],
    });
  });
});
