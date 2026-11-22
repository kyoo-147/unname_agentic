import { describe, expect, it } from 'vitest';
import {
  BILINGUAL_BLOCK_SEPARATOR,
  BILINGUAL_DEFAULT_LANG,
  BILINGUAL_PAIR_SEPARATOR,
  toBilingualHtml,
  toBilingualText,
  type ExportedBlock,
  type ExportedPage,
} from '../viewer/src/export/bilingual';

const block = (source: string, target: string, direction: 'ltr' | 'rtl' | null = null): ExportedBlock => ({ source, target, direction });
const page = (pageNumber: number, blocks: ExportedBlock[]): ExportedPage => ({ pageNumber, blocks });
const pageLabel = (pageNumber: number): string => `[Trang ${pageNumber}]`;

describe('toBilingualText', () => {
  it('pairs source and target with the stable separator, blank line between blocks, injected page labels', () => {
    const text = toBilingualText([page(1, [block('Xin chào', 'Hello')]), page(2, [block('Tạm biệt', 'Goodbye')])], { pageLabel });
    expect(text).toBe(
      ['[Trang 1]', '', 'Xin chào', '---', 'Hello', '', '[Trang 2]', '', 'Tạm biệt', '---', 'Goodbye', ''].join('\n'),
    );
    expect(text.split('---')).toHaveLength(3);
  });

  it('defaults to no header and no page marker because no label is injected', () => {
    const text = toBilingualText([page(3, [block('A', 'B')])]);
    expect(text).toBe(`A${BILINGUAL_PAIR_SEPARATOR}B\n`);
    expect(text).not.toContain('[');
    expect(text).not.toContain('Trang');
  });

  it('prints an injected header once before the first page', () => {
    const text = toBilingualText([page(1, [block('A', 'B')]), page(2, [block('C', 'D')])], { header: 'Bản song ngữ' });
    expect(text).toBe(`Bản song ngữ${BILINGUAL_BLOCK_SEPARATOR}A${BILINGUAL_PAIR_SEPARATOR}B${BILINGUAL_BLOCK_SEPARATOR}C${BILINGUAL_PAIR_SEPARATOR}D\n`);
    expect(text.indexOf('Bản song ngữ')).toBe(0);
    expect(text.split('Bản song ngữ')).toHaveLength(2);
  });

  it('skips empty blocks and source-only blocks by default', () => {
    const text = toBilingualText([
      page(1, [block('', ''), block('   ', '\n'), block('Only source', ''), block('Src', 'Tgt')]),
    ]);
    expect(text).toBe(`Src${BILINGUAL_PAIR_SEPARATOR}Tgt\n`);
  });

  it('keeps source-only blocks when includeSourceOnly is true', () => {
    const text = toBilingualText([page(1, [block('Only source', ''), block('Src', 'Tgt')])], { includeSourceOnly: true });
    expect(text).toBe(`Only source${BILINGUAL_BLOCK_SEPARATOR}Src${BILINGUAL_PAIR_SEPARATOR}Tgt\n`);
    expect(text).not.toContain('---\n\n');
  });

  it('drops pages that contribute no blocks and keeps a header on its own', () => {
    expect(toBilingualText([page(1, []), page(2, [block('', '')])])).toBe('');
    expect(toBilingualText([], { header: 'Chỉ tiêu đề' })).toBe('Chỉ tiêu đề\n');
  });

  it('returns an empty string for an empty page list', () => {
    expect(toBilingualText([])).toBe('');
    expect(toBilingualText([], { includeSourceOnly: true, pageLabel })).toBe('');
  });

  it('preserves the original order of 500 blocks on one page', () => {
    const blocks = Array.from({ length: 500 }, (_, index) => block(`source-${index}`, `target-${index}`));
    const text = toBilingualText([page(1, blocks)]);
    const sources = [...text.matchAll(/source-(\d+)/g)].map(match => Number(match[1]));
    const targets = [...text.matchAll(/target-(\d+)/g)].map(match => Number(match[1]));
    const expected = Array.from({ length: 500 }, (_, index) => index);
    expect(sources).toEqual(expected);
    expect(targets).toEqual(expected);
    expect([...text.matchAll(new RegExp(BILINGUAL_PAIR_SEPARATOR, 'g'))]).toHaveLength(500);
    expect(text.endsWith('target-499\n')).toBe(true);
  });

  it('keeps CJK and Vietnamese diacritics intact', () => {
    const source = 'Điều 3: quyền tự do — 日本語のテキストと中文内容';
    const target = 'Điều khoản ba — 日本語訳と中文翻译';
    const text = toBilingualText([page(1, [block(source, target)])]);
    expect(text).toContain(source);
    expect(text).toContain(target);
    expect(text).not.toContain('\uFFFD');
  });

  it('normalizes CRLF and lone CR without touching the text itself', () => {
    const text = toBilingualText([page(1, [block('dòng một\r\ndòng hai', 'line one\rline two')])]);
    expect(text).toBe(`dòng một\ndòng hai${BILINGUAL_PAIR_SEPARATOR}line one\nline two\n`);
  });
});

describe('toBilingualHtml', () => {
  it('builds a single self-contained printable document with lang, UTF-8 and print page breaks', () => {
    const html = toBilingualHtml([page(1, [block('Xin chào', 'Hello')])], { title: 'Bản song ngữ' });
    expect(html.startsWith('<!DOCTYPE html>\n<html lang="vi">\n')).toBe(true);
    expect(html.endsWith('</body>\n</html>\n')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>Bản song ngữ</title>');
    expect(html).toContain('<h1 class="doc__title">Bản song ngữ</h1>');
    expect(html).toContain('@media print');
    expect(html).toContain('break-after: page');
    expect(html).toContain('<p class="block__source">Xin chào</p>');
    expect(html).toContain('<p class="block__target">Hello</p>');
    expect(html).not.toMatch(/<script|<link|<iframe|<img|@import|url\(/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('escapes <, >, &, double and single quotes in every user string', () => {
    const title = `Tom & Jerry's <guide>`;
    const source = `1 < 2 && 3 > 2 "quote" 'single'`;
    const target = `</p><script>alert(1)</script><img src=x onerror="alert(1)">`;
    const html = toBilingualHtml([page(1, [block(source, target)])], { title });
    expect(html).toContain('<title>Tom &amp; Jerry&#39;s &lt;guide&gt;</title>');
    expect(html).toContain('1 &lt; 2 &amp;&amp; 3 &gt; 2 &quot;quote&quot; &#39;single&#39;');
    expect(html).toContain('&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('</p><script');
  });

  it('neutralizes markup injected through the page label and the lang attribute', () => {
    const html = toBilingualHtml([page(3, [block('A', 'B')])], {
      title: 'T',
      lang: 'vi" onload="x',
      pageLabel: () => '<b onclick="x">Trang</b>',
    });
    expect(html).toContain('<h2 class="page-label">&lt;b onclick=&quot;x&quot;&gt;Trang&lt;/b&gt;</h2>');
    expect(html).toContain('<html lang="vi&quot; onload=&quot;x">');
    expect(html).not.toContain('<b onclick');
    expect(html).not.toContain('onload="x"');
  });

  it('sets dir="rtl" on right-to-left blocks only', () => {
    const html = toBilingualHtml(
      [
        page(4, [
          block('مرحبا', 'Xin chào', 'rtl'),
          block('Hi', 'Chào', 'ltr'),
          block('Neutral', 'Trung tính'),
        ]),
      ],
      { title: 'T' },
    );
    expect(html).toContain('<article class="block" dir="rtl">');
    expect(html.match(/<article[^>]*dir="rtl"/g)).toHaveLength(1);
    expect(html).not.toContain('dir="ltr"');
    expect(html.match(/<article class="block"/g)).toHaveLength(3);
    expect(html).toContain('مرحبا');
  });

  it('renders an empty page list as a valid document without sections', () => {
    const html = toBilingualHtml([], { title: 'T' });
    expect(html).toContain('<html lang="vi">');
    expect(html).toContain('</body>\n</html>');
    expect(html).not.toContain('<section');
    expect(html).not.toContain('<h2 class="page-label"');
  });

  it('renders a page with only source text without a target paragraph', () => {
    const html = toBilingualHtml([page(2, [block('Chỉ có bản gốc', ''), block('', '')])], { title: 'T' });
    expect(html).toContain('<p class="block__source">Chỉ có bản gốc</p>');
    expect(html).not.toContain('class="block__target"');
    expect(html.match(/<article class="block"/g)).toHaveLength(1);
    expect(html).toContain('<h2 class="page-label">2</h2>');
  });

  it('uses the injected page label and falls back to the page number', () => {
    const labelled = toBilingualHtml([page(3, [block('A', 'B')])], { title: 'T', pageLabel: number => `Trang ${number}` });
    expect(labelled).toContain('<h2 class="page-label">Trang 3</h2>');
    const plain = toBilingualHtml([page(7, [block('A', 'B')])], { title: 'T' });
    expect(plain).toContain('<h2 class="page-label">7</h2>');
  });

  it('honours title and lang options and defaults the language to the product locale', () => {
    expect(BILINGUAL_DEFAULT_LANG).toBe('vi');
    expect(toBilingualHtml([page(1, [block('A', 'B')])], { title: 'T' })).toContain('<html lang="vi">');
    const arabic = toBilingualHtml([page(1, [block('A', 'B')])], { title: 'T', lang: 'ar' });
    expect(arabic).toContain('<html lang="ar">');
    expect(arabic).not.toContain('<html lang="vi">');
  });

  it('omits the document header when the title is blank', () => {
    const html = toBilingualHtml([page(1, [block('A', 'B')])], { title: '  ' });
    expect(html).not.toContain('<header class="doc">');
    expect(html).not.toContain('<h1 class="doc__title">');
    expect(html).toContain('<title></title>');
  });

  it('keeps CJK and Vietnamese diacritics intact and preserves page order', () => {
    const html = toBilingualHtml(
      [
        page(1, [block('Điều một', '第一章'), block('日本語', '日本語のテキスト')]),
        page(2, [block('Điều hai', '第二章')]),
      ],
      { title: 'Bản song ngữ' },
    );
    expect(html).toContain('Điều một');
    expect(html).toContain('第一章');
    expect(html).toContain('日本語のテキスト');
    expect(html.indexOf('page-1')).toBeLessThan(html.indexOf('page-2'));
    expect(html).not.toContain('\uFFFD');
  });
});
