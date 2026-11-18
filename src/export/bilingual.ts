export interface ExportedBlock {
  source: string;
  target: string;
  direction?: 'ltr' | 'rtl' | null;
}

export interface ExportedPage {
  pageNumber: number;
  blocks: ExportedBlock[];
}

export interface BilingualTextOptions {
  header?: string;
  includeSourceOnly?: boolean;
  pageLabel?: (pageNumber: number) => string;
}

export interface BilingualHtmlOptions {
  title: string;
  lang?: string;
  pageLabel?: (pageNumber: number) => string;
}

export const BILINGUAL_BLOCK_SEPARATOR = '\n\n';
export const BILINGUAL_PAIR_SEPARATOR = '\n---\n';
export const BILINGUAL_DEFAULT_LANG = 'vi';

const cleanText = (value: string): string => value.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => HTML_ENTITIES[character] ?? character);
}

const formatPageNumber = (value: number): string => (Number.isFinite(value) ? String(Math.trunc(value)) : '');

function blockLines(block: ExportedBlock, includeSourceOnly: boolean): string[] {
  const source = cleanText(block.source);
  const target = cleanText(block.target);
  if (!source && !target) return [];
  if (!target) return includeSourceOnly ? [source] : [];
  if (!source) return [target];
  return [source, target];
}

export function toBilingualText(pages: readonly ExportedPage[], opts: BilingualTextOptions = {}): string {
  const includeSourceOnly = opts.includeSourceOnly ?? false;
  const sections: string[] = [];
  const header = cleanText(opts.header ?? '');
  if (header) sections.push(header);

  for (const page of pages) {
    const blocks = page.blocks
      .map(block => blockLines(block, includeSourceOnly).join(BILINGUAL_PAIR_SEPARATOR))
      .filter(block => block.length > 0);
    if (blocks.length === 0) continue;
    const label = opts.pageLabel ? cleanText(opts.pageLabel(page.pageNumber) ?? '') : '';
    const body = blocks.join(BILINGUAL_BLOCK_SEPARATOR);
    sections.push(label ? `${label}${BILINGUAL_BLOCK_SEPARATOR}${body}` : body);
  }

  return sections.length > 0 ? `${sections.join(BILINGUAL_BLOCK_SEPARATOR)}\n` : '';
}

const PRINT_STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  max-width: 46rem;
  padding: 2.5rem 1.25rem 4rem;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans SC", "Noto Sans JP", sans-serif;
  font-size: 12pt;
  line-height: 1.65;
  color: #1f2328;
  background: #ffffff;
}
.doc { margin: 0 0 2.5rem; }
.doc__title { margin: 0; font-size: 1.55rem; line-height: 1.3; }
.page { margin: 0; }
.page-label {
  margin: 0 0 1rem;
  font-size: 0.85rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #5b6470;
}
.block {
  margin: 0 0 1.25rem;
  padding: 0 0 1.25rem;
  border-bottom: 1px solid #e6e8eb;
}
.block:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: 0; }
.block__source,
.block__target {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  unicode-bidi: isolate;
}
.block__source { color: #4a5360; }
.block__target { margin-top: 0.45rem; color: #101418; }
.block[dir="rtl"] { text-align: right; }
@media print {
  @page { margin: 16mm; }
  body { max-width: none; padding: 0; font-size: 11pt; }
  .doc { margin-bottom: 1.5rem; }
  .page:not(:last-child) { break-after: page; page-break-after: always; }
  .block { break-inside: avoid; page-break-inside: avoid; }
  .block__source { color: #000000; }
}
`.trim();

function renderBlock(block: ExportedBlock): string {
  const source = cleanText(block.source);
  const target = cleanText(block.target);
  if (!source && !target) return '';
  const direction = block.direction === 'rtl' ? ' dir="rtl"' : '';
  const lines = [`  <article class="block"${direction}>`];
  if (source) lines.push(`    <p class="block__source">${escapeHtml(source)}</p>`);
  if (target) lines.push(`    <p class="block__target">${escapeHtml(target)}</p>`);
  lines.push('  </article>');
  return lines.join('\n');
}

function renderPage(page: ExportedPage, index: number, label?: (pageNumber: number) => string): string {
  const blocks = page.blocks.map(renderBlock).filter(markup => markup.length > 0);
  if (blocks.length === 0) return '';
  const heading = label ? cleanText(label(page.pageNumber) ?? '') : formatPageNumber(page.pageNumber);
  const lines = [`<section class="page" id="page-${index + 1}">`];
  if (heading) lines.push(`  <h2 class="page-label">${escapeHtml(heading)}</h2>`);
  lines.push(...blocks, '</section>');
  return lines.join('\n');
}

export function toBilingualHtml(pages: readonly ExportedPage[], opts: BilingualHtmlOptions): string {
  const lang = cleanText(opts.lang ?? '') || BILINGUAL_DEFAULT_LANG;
  const title = cleanText(opts.title ?? '');
  const body: string[] = [];
  if (title) body.push('<header class="doc">', `  <h1 class="doc__title">${escapeHtml(title)}</h1>`, '</header>');
  for (const [index, page] of pages.entries()) {
    const section = renderPage(page, index, opts.pageLabel);
    if (section) body.push(section);
  }

  const lines = [
    '<!DOCTYPE html>',
    `<html lang="${escapeHtml(lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    PRINT_STYLES,
    '</style>',
    '</head>',
    '<body>',
    ...body,
    '</body>',
    '</html>',
  ];
  return `${lines.join('\n')}\n`;
}
