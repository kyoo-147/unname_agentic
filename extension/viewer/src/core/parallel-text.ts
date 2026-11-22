/**
 * Parallel source/target segments (backlog item G09).
 *
 * A reader that shows a translation next to the original needs more than two strings:
 * it needs to know which source block each target belongs to, in what order, on which
 * page, and whether the pair is plausible at all. This module builds that view and the
 * two interchange formats around it.
 *
 * Contract:
 * - Alignment is by `block.id`, never by array position. A translation is matched to its
 *   block by id, so a translator that returns pairs out of order still aligns. The output
 *   keeps the block order it was given, which is the reader's reading order; it does not
 *   sort by page.
 * - Nothing is silently dropped. A block with no translation, a translation with no
 *   block, a repeated block id and a repeated translation all appear in `unaligned` with
 *   a stable `reason` and an English `detail`.
 * - A ratio is `targetLength / sourceLength` over Unicode code points. The warning band
 *   is 0.4..2.5 inclusive: a pair outside it is usually a truncated or expanded
 *   translation, not a free translation. `ratioWarning` carries that verdict on the
 *   segment and {@link isRatioOutOfBand} exposes the same rule. An empty source with a
 *   non-empty target has an infinite ratio and is warned; two empty strings have ratio 1.
 * - Markdown and TMX output are deterministic: no clock, no randomness, no locale. TMX
 *   text is escaped and characters XML 1.0 cannot carry are removed, so the output stays
 *   well-formed whatever the PDF contained.
 * - `fromTmx` reads plaintext TMX 1.4, refuses anything malformed with a
 *   {@link ParallelTextError} carrying the 1-based source line, and never guesses: a
 *   missing header, a missing `seg` or more than one target language in one `tu` is an
 *   error, not a default.
 */

// --- Public shapes ---------------------------------------------------------

/** One source block, in the order the reader shows it. */
export interface ParallelBlock {
  /** Stable block id, for example `p3-r0`. It is the anchor a target is aligned by. */
  id: string;
  /** 1-based page number, matching `TextBlock.page` in `src/core/types.ts`. */
  page: number;
  /** Source text as extracted or recognised. */
  text: string;
}

/** One translated block. Only the id ties it to a source block; input order is irrelevant. */
export interface ParallelTranslation {
  blockId: string;
  text: string;
}

/** Why a block or a translation could not become a segment. */
export type UnalignedReason =
  | 'missing-translation'
  | 'orphan-translation'
  | 'duplicate-translation'
  | 'duplicate-block'
  | 'invalid-block';

/** A block or translation that is not part of the aligned view, with the reason why. */
export interface UnalignedSegment {
  blockId: string;
  /** Page of the source block; `null` when the id names no block (an orphan translation). */
  page: number | null;
  reason: UnalignedReason;
  /** One English sentence for a log or a review panel. */
  detail: string;
}

/** One source block paired with its translation. */
export interface AlignedSegment {
  blockId: string;
  page: number;
  source: string;
  target: string;
  /** `target` code-point length divided by `source` code-point length. */
  ratio: number;
  /** True when `ratio` is outside {@link RATIO_WARNING_BAND}. */
  ratioWarning: boolean;
}

/** Everything `alignSegments` could and could not align. */
export interface ParallelAlignment {
  segments: AlignedSegment[];
  unaligned: UnalignedSegment[];
}

/** A language pair for TMX. Tags are BCP 47, for example `en` and `vi`. */
export interface TmxLanguages {
  source: string;
  target: string;
}

/** What `fromTmx` read back. */
export interface TmxParseResult {
  segments: AlignedSegment[];
  langs: TmxLanguages;
}

/** Lowest ratio that is not warned about, inclusive. */
export const RATIO_WARNING_MIN = 0.4;

/** Highest ratio that is not warned about, inclusive. */
export const RATIO_WARNING_MAX = 2.5;

/** The documented warning band, as `[min, max]`, both inclusive. */
export const RATIO_WARNING_BAND: readonly [number, number] = [RATIO_WARNING_MIN, RATIO_WARNING_MAX];

export type ParallelTextErrorCode = 'invalid-input' | 'invalid-language' | 'malformed-tmx' | 'unsupported-tmx';

/** A refused input, with the TMX line number when the failure came from parsing. */
export class ParallelTextError extends Error {
  readonly code: ParallelTextErrorCode;
  /** 1-based line in the TMX source, or `null` when the input was not TMX. */
  readonly line: number | null;

  constructor(code: ParallelTextErrorCode, message: string, line: number | null = null) {
    super(line === null ? message : `${message} (line ${line})`);
    this.name = 'ParallelTextError';
    this.code = code;
    this.line = line;
  }
}

// --- Alignment -------------------------------------------------------------

/** Number of Unicode code points, so a surrogate pair counts once. */
function codePointLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

/**
 * Length ratio of a pair, over code points.
 *
 * An empty source with an empty target is 1 (there is nothing to compare); an empty
 * source with a non-empty target is `Infinity`, which the warning band reports.
 */
export function lengthRatio(source: string, target: string): number {
  const sourceLength = codePointLength(source);
  const targetLength = codePointLength(target);
  if (sourceLength === 0) return targetLength === 0 ? 1 : Number.POSITIVE_INFINITY;
  return targetLength / sourceLength;
}

/** Whether a ratio is outside the documented 0.4..2.5 band. Non-finite ratios are. */
export function isRatioOutOfBand(ratio: number): boolean {
  return !(Number.isFinite(ratio) && ratio >= RATIO_WARNING_MIN && ratio <= RATIO_WARNING_MAX);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pairs every block with its translation by id.
 *
 * `segments` follows the input block order. `unaligned` is ordered in three groups:
 * block-level findings in block order, repeated translations in translation order, then
 * orphan translations in translation order. When a block id or a translation is repeated,
 * the first occurrence is aligned and the later ones are reported, so no reader ever
 * sees the same block twice. The input arrays are not mutated.
 */
export function alignSegments(
  blocks: readonly ParallelBlock[],
  translations: readonly ParallelTranslation[],
): ParallelAlignment {
  if (!Array.isArray(blocks)) {
    throw new ParallelTextError('invalid-input', 'alignSegments needs an array of blocks.');
  }
  if (!Array.isArray(translations)) {
    throw new ParallelTextError('invalid-input', 'alignSegments needs an array of translations.');
  }

  // First translation per block wins; later ones are reported, not silently preferred.
  const targetByBlock = new Map<string, string>();
  const repeated: Array<{ blockId: string; index: number }> = [];
  for (const [index, translation] of translations.entries()) {
    if (!isRecord(translation) || typeof translation.blockId !== 'string' || typeof translation.text !== 'string') {
      throw new ParallelTextError('invalid-input', `translations[${index}] must be an object with string blockId and text.`);
    }
    if (targetByBlock.has(translation.blockId)) {
      repeated.push({ blockId: translation.blockId, index });
    } else {
      targetByBlock.set(translation.blockId, translation.text);
    }
  }

  const segments: AlignedSegment[] = [];
  const unaligned: UnalignedSegment[] = [];
  const seenBlocks = new Set<string>();
  const usedTranslations = new Set<string>();
  const pageByBlock = new Map<string, number>();

  for (const [index, block] of blocks.entries()) {
    const record: unknown = block;
    if (!isRecord(record) || typeof record.id !== 'string' || typeof record.text !== 'string') {
      throw new ParallelTextError('invalid-input', `blocks[${index}] must be an object with string id and text.`);
    }
    const blockId = record.id;
    const blockText = record.text;
    const rawPage = record.page;
    const page = typeof rawPage === 'number' && Number.isInteger(rawPage) && rawPage > 0 ? rawPage : null;

    if (blockId.length === 0) {
      unaligned.push({
        blockId: '',
        page,
        reason: 'invalid-block',
        detail: `blocks[${index}] has an empty id, so nothing can anchor a translation to it.`,
      });
      continue;
    }

    if (seenBlocks.has(blockId)) {
      unaligned.push({
        blockId,
        page: page ?? pageByBlock.get(blockId) ?? null,
        reason: 'duplicate-block',
        detail: `block ${blockId} appears more than once; only the first block with this id is aligned.`,
      });
      continue;
    }
    seenBlocks.add(blockId);
    if (page !== null) pageByBlock.set(blockId, page);

    const target = targetByBlock.get(blockId);
    if (target === undefined) {
      unaligned.push({
        blockId,
        page,
        reason: 'missing-translation',
        detail: `block ${blockId} has no translation.`,
      });
      continue;
    }
    // The translation belongs to a real block even when the block cannot become a
    // segment, so it must not also be reported as an orphan.
    usedTranslations.add(blockId);

    if (page === null) {
      unaligned.push({
        blockId,
        page: null,
        reason: 'invalid-block',
        detail: `blocks[${index}] has page ${String(rawPage)}; a segment needs a 1-based page number.`,
      });
      continue;
    }

    const ratio = lengthRatio(blockText, target);
    segments.push({
      blockId,
      page,
      source: blockText,
      target,
      ratio,
      ratioWarning: isRatioOutOfBand(ratio),
    });
  }

  for (const duplicate of repeated) {
    // The first translation of an unknown block is already reported as an orphan; a
    // second one would only repeat that fact.
    if (!seenBlocks.has(duplicate.blockId)) continue;
    unaligned.push({
      blockId: duplicate.blockId,
      page: pageByBlock.get(duplicate.blockId) ?? null,
      reason: 'duplicate-translation',
      detail: `translations[${duplicate.index}] repeats block ${duplicate.blockId}; the first translation is aligned and this one is ignored.`,
    });
  }

  for (const blockId of targetByBlock.keys()) {
    if (usedTranslations.has(blockId)) continue;
    unaligned.push({
      blockId,
      page: pageByBlock.get(blockId) ?? null,
      reason: 'orphan-translation',
      detail: `the translation for ${blockId} has no source block.`,
    });
  }

  return { segments, unaligned };
}

// --- Parallel Markdown -----------------------------------------------------

export interface ParallelMarkdownOptions {
  /** Document title; defaults to `Parallel text`. An empty string omits the title. */
  title?: string;
  /** Label above a source block; defaults to `Source`. An empty string omits it. */
  sourceLabel?: string;
  /** Label above a target block; defaults to `Target`. An empty string omits it. */
  targetLabel?: string;
  /** Prefix of a page heading; defaults to `Page `, so page 3 prints `## Page 3`. */
  pageLabel?: string;
}

const DEFAULT_MARKDOWN_TITLE = 'Parallel text';
const DEFAULT_SOURCE_LABEL = 'Source';
const DEFAULT_TARGET_LABEL = 'Target';
const DEFAULT_PAGE_LABEL = 'Page ';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/gu, character => HTML_ESCAPES[character] ?? character);
}

/** Escapes the inline markdown that would otherwise change how a source line renders. */
function escapeMarkdownLine(line: string): string {
  let escaped = line.replace(/[\\`*_[\]<>&|~]/gu, character => `\\${character}`);
  if (/^#{1,6}(?:\s|$)/u.test(escaped) || /^[-+](?:\s|$)/u.test(escaped)) {
    escaped = `\\${escaped}`;
  } else if (/^\d{1,9}[.)](?:\s|$)/u.test(escaped)) {
    // A backslash before a digit is literal, so the dot or parenthesis is escaped.
    escaped = escaped.replace(/^(\d{1,9})([.)])/u, '$1\\$2');
  } else if (/^(?:-{3,}|={3,})\s*$/u.test(escaped)) {
    escaped = `\\${escaped}`;
  }
  return escaped;
}

/** Renders one cell as a blockquote, one `> ` line per source line. */
function quoteMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines
    .map(line => {
      const escaped = escapeMarkdownLine(line);
      return escaped.length === 0 ? '>' : `> ${escaped}`;
    })
    .join('\n');
}

function comparePages(left: number, right: number): number {
  const leftKnown = Number.isInteger(left) && left > 0;
  const rightKnown = Number.isInteger(right) && right > 0;
  if (leftKnown && rightKnown) return left - right;
  if (leftKnown) return -1;
  if (rightKnown) return 1;
  return left - right;
}

/**
 * Writes the aligned view as Markdown: a page heading, then each block as an HTML
 * anchor (`<a id="p1-r0"></a>`) followed by its source and target. Pages are printed in
 * ascending page order; blocks inside a page keep the segment order they were given.
 * Text is blockquoted and markdown metacharacters are escaped, so a PDF line cannot turn
 * into a heading, a list or raw HTML in the output. Empty input produces an empty string.
 */
export function toParallelMarkdown(
  segments: readonly AlignedSegment[],
  options: ParallelMarkdownOptions = {},
): string {
  if (!Array.isArray(segments)) {
    throw new ParallelTextError('invalid-input', 'toParallelMarkdown needs an array of aligned segments.');
  }
  if (segments.length === 0) return '';

  const title = options.title ?? DEFAULT_MARKDOWN_TITLE;
  const sourceLabel = options.sourceLabel ?? DEFAULT_SOURCE_LABEL;
  const targetLabel = options.targetLabel ?? DEFAULT_TARGET_LABEL;
  const pageLabel = options.pageLabel ?? DEFAULT_PAGE_LABEL;

  const pages = new Map<number, AlignedSegment[]>();
  for (const segment of segments) {
    assertAlignedSegment(segment, 'toParallelMarkdown');
    const group = pages.get(segment.page);
    if (group) group.push(segment);
    else pages.set(segment.page, [segment]);
  }

  const chunks: string[] = [];
  if (title.length > 0) chunks.push(`# ${title}`);

  const orderedPages = [...pages.keys()].sort(comparePages);
  for (const page of orderedPages) {
    const blocks = pages.get(page) ?? [];
    const heading = page > 0 ? `${pageLabel}${page}` : `${pageLabel}?`;
    const blockChunks = blocks.map(segment => {
      const parts = [`<a id="${escapeHtmlAttribute(segment.blockId)}"></a>`];
      if (sourceLabel.length > 0) parts.push(`**${sourceLabel}**`);
      parts.push(quoteMarkdown(segment.source));
      if (targetLabel.length > 0) parts.push(`**${targetLabel}**`);
      parts.push(quoteMarkdown(segment.target));
      return parts.join('\n\n');
    });
    chunks.push([`## ${heading}`, ...blockChunks].join('\n\n'));
  }

  return `${chunks.join('\n\n')}\n`;
}

// --- TMX -------------------------------------------------------------------

const TMX_TOOL = 'mirror-pdf';
const TMX_TOOL_VERSION = '0.1.0';
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

function requireLanguage(value: unknown, path: string): string {
  if (typeof value !== 'string' || !LANGUAGE_TAG.test(value)) {
    throw new ParallelTextError('invalid-language', `${path} must be a BCP 47 language tag such as "en" or "vi".`);
  }
  return value;
}

function assertAlignedSegment(value: unknown, caller: string): asserts value is AlignedSegment {
  if (!isRecord(value)) {
    throw new ParallelTextError('invalid-input', `${caller} needs aligned segments.`);
  }
  if (typeof value.blockId !== 'string' || value.blockId.length === 0) {
    throw new ParallelTextError('invalid-input', `${caller} needs every segment to have a non-empty blockId.`);
  }
  if (typeof value.source !== 'string' || typeof value.target !== 'string') {
    throw new ParallelTextError('invalid-input', `${caller} needs every segment to have string source and target.`);
  }
  if (typeof value.page !== 'number' || !Number.isFinite(value.page)) {
    throw new ParallelTextError('invalid-input', `${caller} needs every segment to have a finite page.`);
  }
}

function isXmlChar(codePoint: number): boolean {
  return (
    codePoint === 0x9 ||
    codePoint === 0xa ||
    codePoint === 0xd ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

/**
 * Escapes text for XML. Characters XML 1.0 cannot carry (NUL, most C0 controls, lone
 * surrogates) are dropped; CR is written as a numeric reference so it survives the
 * parser's newline normalisation, and attribute whitespace is preserved the same way.
 */
function escapeXml(value: string, attribute: boolean): string {
  let out = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !isXmlChar(codePoint)) continue;
    switch (character) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += attribute ? '&quot;' : '"';
        break;
      case "'":
        out += attribute ? '&apos;' : "'";
        break;
      case '\r':
        out += '&#13;';
        break;
      case '\n':
        out += attribute ? '&#10;' : '\n';
        break;
      case '\t':
        out += attribute ? '&#9;' : '\t';
        break;
      default:
        out += character;
    }
  }
  return out;
}

function escapeXmlText(value: string): string {
  return escapeXml(value, false);
}

function escapeXmlAttribute(value: string): string {
  return escapeXml(value, true);
}

/**
 * Writes a minimal valid TMX 1.4 document for the segments.
 *
 * Each `tu` carries the block id as `tuid`, the page as a `<prop type="page">` and two
 * `tuv` variants with one plaintext `<seg>` each. `tu` order is segment order and
 * repeated block ids are refused, so a round trip cannot silently merge two blocks.
 * Since TMX has no place for a page that is not a positive integer, such a page is
 * omitted and reads back as 0 (unknown).
 */
export function toTmx(segments: readonly AlignedSegment[], langs: TmxLanguages): string {
  if (!Array.isArray(segments)) {
    throw new ParallelTextError('invalid-input', 'toTmx needs an array of aligned segments.');
  }
  if (!isRecord(langs)) {
    throw new ParallelTextError('invalid-input', 'toTmx needs a source and a target language.');
  }
  const source = requireLanguage(langs.source, 'langs.source');
  const target = requireLanguage(langs.target, 'langs.target');
  if (source.toLowerCase() === target.toLowerCase()) {
    throw new ParallelTextError('invalid-language', 'langs.source and langs.target must be different.');
  }

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tmx version="1.4">',
    `  <header creationtool="${TMX_TOOL}" creationtoolversion="${TMX_TOOL_VERSION}" segtype="block" o-tmf="${TMX_TOOL}" adminlang="en" srclang="${escapeXmlAttribute(source)}" datatype="plaintext" o-encoding="UTF-8"/>`,
    '  <body>',
  ];

  const seen = new Set<string>();
  for (const segment of segments) {
    assertAlignedSegment(segment, 'toTmx');
    if (seen.has(segment.blockId)) {
      throw new ParallelTextError('invalid-input', `toTmx received block ${segment.blockId} more than once.`);
    }
    seen.add(segment.blockId);

    lines.push(`    <tu tuid="${escapeXmlAttribute(segment.blockId)}">`);
    if (Number.isInteger(segment.page) && segment.page > 0) {
      lines.push(`      <prop type="page">${segment.page}</prop>`);
    }
    lines.push(`      <tuv xml:lang="${escapeXmlAttribute(source)}">`);
    lines.push(`        <seg>${escapeXmlText(segment.source)}</seg>`);
    lines.push('      </tuv>');
    lines.push(`      <tuv xml:lang="${escapeXmlAttribute(target)}">`);
    lines.push(`        <seg>${escapeXmlText(segment.target)}</seg>`);
    lines.push('      </tuv>');
    lines.push('    </tu>');
  }

  lines.push('  </body>', '</tmx>');
  return `${lines.join('\n')}\n`;
}

// --- A small, strict XML reader -------------------------------------------

interface XmlElement {
  kind: 'element';
  name: string;
  attributes: Map<string, string>;
  children: XmlNode[];
  line: number;
}

interface XmlText {
  kind: 'text';
  text: string;
  line: number;
}

type XmlNode = XmlElement | XmlText;

const NAME_START = /[A-Za-z_:]/u;
const NAME_PART = /[-A-Za-z0-9_:.]/u;

/** A recursive-descent reader for the XML subset TMX needs. It refuses what it cannot read. */
class XmlParser {
  private readonly source: string;
  private index = 0;
  private line = 1;

  constructor(source: string) {
    this.source = source;
  }

  parse(): XmlElement {
    if (this.source.startsWith('\ufeff')) this.advance(1);
    this.skipMisc();
    if (this.eof()) this.failAt(1, 'the TMX document is empty.');
    if (this.peek() !== '<') this.fail('the TMX document must start with a root element.');
    const root = this.parseElement();
    this.skipMisc();
    if (!this.eof()) this.fail('only one root element is allowed.');
    return root;
  }

  private parseElement(): XmlElement {
    const line = this.line;
    this.expect('<');
    if (this.peek() === '/') this.fail('unexpected closing tag.');
    const name = this.readName();

    const attributes = new Map<string, string>();
    for (;;) {
      this.skipWhitespace();
      if (this.eof()) this.fail(`element <${name}> is not closed.`);
      if (this.startsWith('/>')) {
        this.advance(2);
        return { kind: 'element', name, attributes, children: [], line };
      }
      if (this.peek() === '>') {
        this.advance(1);
        break;
      }
      const attributeLine = this.line;
      const attributeName = this.readName();
      this.skipWhitespace();
      this.expect('=');
      this.skipWhitespace();
      const quote = this.peek();
      if (quote !== '"' && quote !== "'") this.fail(`attribute ${attributeName} must be quoted.`);
      this.advance(1);
      const raw = this.readQuoted(quote, `attribute ${attributeName} is not closed.`);
      if (attributes.has(attributeName)) this.fail(`attribute ${attributeName} appears more than once.`);
      attributes.set(attributeName, decodeEntities(raw, attributeLine, (at, message) => this.failAt(at, message)));
    }

    const children: XmlNode[] = [];
    for (;;) {
      if (this.eof()) this.fail(`element <${name}> is not closed.`);
      if (this.startsWith('</')) {
        this.advance(2);
        const closing = this.readName();
        if (closing !== name) this.fail(`closing tag </${closing}> does not match <${name}>.`);
        this.skipWhitespace();
        this.expect('>');
        return { kind: 'element', name, attributes, children, line };
      }
      if (this.startsWith('<!--')) {
        this.skipComment();
        continue;
      }
      if (this.startsWith('<?')) {
        this.skipProcessingInstruction();
        continue;
      }
      if (this.startsWith('<![CDATA[')) this.fail('CDATA sections are not supported in TMX.');
      if (this.peek() === '<') {
        children.push(this.parseElement());
        continue;
      }
      const textLine = this.line;
      let raw = '';
      while (!this.eof() && this.peek() !== '<') {
        raw += this.peek();
        this.advance(1);
      }
      const text = decodeEntities(raw, textLine, (at, message) => this.failAt(at, message));
      if (text.length > 0) children.push({ kind: 'text', text, line: textLine });
    }
  }

  private readName(): string {
    const start = this.index;
    if (!NAME_START.test(this.peek())) this.fail('expected an element or attribute name.');
    this.advance(1);
    while (!this.eof() && NAME_PART.test(this.peek())) this.advance(1);
    return this.source.slice(start, this.index);
  }

  private readQuoted(quote: string, message: string): string {
    const start = this.index;
    while (!this.eof()) {
      const character = this.peek();
      if (character === quote) {
        const value = this.source.slice(start, this.index);
        this.advance(1);
        return value;
      }
      if (character === '<') this.fail('"<" is not allowed in an attribute value.');
      this.advance(1);
    }
    return this.fail(message);
  }

  private skipMisc(): void {
    for (;;) {
      this.skipWhitespace();
      if (this.startsWith('<!--')) {
        this.skipComment();
        continue;
      }
      if (this.startsWith('<?')) {
        this.skipProcessingInstruction();
        continue;
      }
      if (this.startsWith('<!')) this.fail('DOCTYPE and other declarations are not supported in TMX.');
      return;
    }
  }

  private skipComment(): void {
    const start = this.line;
    this.advance(4);
    const end = this.source.indexOf('-->', this.index);
    if (end < 0) this.failAt(start, 'a comment is not closed with "-->".');
    this.advance(end + 3 - this.index);
  }

  private skipProcessingInstruction(): void {
    const start = this.line;
    this.advance(2);
    const end = this.source.indexOf('?>', this.index);
    if (end < 0) this.failAt(start, 'a processing instruction is not closed with "?>".');
    this.advance(end + 2 - this.index);
  }

  private skipWhitespace(): void {
    while (!this.eof()) {
      const character = this.peek();
      if (character !== ' ' && character !== '\t' && character !== '\r' && character !== '\n') return;
      this.advance(1);
    }
  }

  private expect(text: string): void {
    if (!this.startsWith(text)) this.fail(`expected "${text}".`);
    this.advance(text.length);
  }

  private startsWith(text: string): boolean {
    return this.source.startsWith(text, this.index);
  }

  private peek(offset = 0): string {
    return this.source[this.index + offset] ?? '';
  }

  private eof(): boolean {
    return this.index >= this.source.length;
  }

  private advance(count: number): void {
    for (let step = 0; step < count && this.index < this.source.length; step += 1) {
      if (this.source[this.index] === '\n') this.line += 1;
      this.index += 1;
    }
  }

  private fail(message: string): never {
    return this.failAt(this.line, message);
  }

  private failAt(line: number, message: string): never {
    throw new ParallelTextError('malformed-tmx', message, line);
  }
}

function decodeEntity(
  entity: string,
  line: number,
  fail: (line: number, message: string) => never,
): string {
  switch (entity) {
    case 'amp':
      return '&';
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
    default:
      break;
  }

  const hexadecimal = entity.startsWith('#x') || entity.startsWith('#X');
  if (entity.startsWith('#')) {
    const digits = hexadecimal ? entity.slice(2) : entity.slice(1);
    if (!(hexadecimal ? /^[0-9A-Fa-f]+$/u : /^[0-9]+$/u).test(digits)) {
      fail(line, `"&${entity};" is not a valid character reference.`);
    }
    const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
    if (!Number.isFinite(codePoint) || !isXmlChar(codePoint)) {
      fail(line, `"&${entity};" is not a character XML can carry.`);
    }
    return String.fromCodePoint(codePoint);
  }
  return fail(line, `unknown entity "&${entity};".`);
}

/** Decodes the five XML entities and numeric character references in one text run. */
function decodeEntities(
  raw: string,
  startLine: number,
  fail: (line: number, message: string) => never,
): string {
  let out = '';
  let index = 0;
  let line = startLine;
  while (index < raw.length) {
    const character = raw[index] ?? '';
    if (character === '\n') {
      line += 1;
      out += character;
      index += 1;
      continue;
    }
    if (character !== '&') {
      out += character;
      index += 1;
      continue;
    }
    const end = raw.indexOf(';', index + 1);
    if (end < 0) fail(line, 'an entity reference is not closed with ";".');
    out += decodeEntity(raw.slice(index + 1, end), line, fail);
    index = end + 1;
  }
  return out;
}

// --- TMX tree helpers ------------------------------------------------------

function elementChildren(element: XmlElement): XmlElement[] {
  return element.children.filter((child): child is XmlElement => child.kind === 'element');
}

function findSingleChild(parent: XmlElement, name: string, owner: string): XmlElement {
  const matches = elementChildren(parent).filter(child => child.name === name);
  if (matches.length === 0) {
    throw new ParallelTextError('malformed-tmx', `<${owner}> needs a <${name}> child.`, parent.line);
  }
  if (matches.length > 1) {
    throw new ParallelTextError('malformed-tmx', `<${owner}> has more than one <${name}> child.`, matches[1]!.line);
  }
  return matches[0]!;
}

interface TmxVariant {
  lang: string;
  text: string;
  line: number;
}

function readSegmentText(segment: XmlElement): string {
  let text = '';
  for (const child of segment.children) {
    if (child.kind === 'element') {
      throw new ParallelTextError(
        'unsupported-tmx',
        `<seg> cannot contain <${child.name}>; only plain text is supported.`,
        child.line,
      );
    }
    text += child.text;
  }
  return text;
}

function readVariant(tuv: XmlElement): TmxVariant {
  const lang = tuv.attributes.get('xml:lang');
  if (lang === undefined || lang.length === 0) {
    throw new ParallelTextError('malformed-tmx', '<tuv> needs an xml:lang attribute.', tuv.line);
  }

  let segment: XmlElement | null = null;
  for (const child of elementChildren(tuv)) {
    if (child.name === 'seg') {
      if (segment !== null) {
        throw new ParallelTextError('malformed-tmx', '<tuv> has more than one <seg> child.', child.line);
      }
      segment = child;
    } else if (child.name !== 'prop' && child.name !== 'note') {
      throw new ParallelTextError('malformed-tmx', `<tuv> cannot contain <${child.name}>.`, child.line);
    }
  }
  if (segment === null) {
    throw new ParallelTextError('malformed-tmx', '<tuv> needs a <seg> child.', tuv.line);
  }
  return { lang, text: readSegmentText(segment), line: tuv.line };
}

function readTuPage(tu: XmlElement): number {
  for (const child of elementChildren(tu)) {
    if (child.name !== 'prop' || child.attributes.get('type') !== 'page') continue;
    const text = child.children
      .filter((node): node is XmlText => node.kind === 'text')
      .map(node => node.text)
      .join('')
      .trim();
    if (/^[1-9][0-9]*$/u.test(text)) {
      const page = Number(text);
      if (Number.isSafeInteger(page)) return page;
    }
  }
  return 0;
}

/**
 * Reads a plaintext TMX 1.4 document back into segments.
 *
 * The source variant is the `tuv` whose `xml:lang` matches the header `srclang`; the
 * target is the only other language in that `tu`. A page is read from
 * `<prop type="page">` when present and reads back as 0 (unknown) otherwise. Entity
 * references are decoded, inline markup inside `seg` is refused, and every refusal is a
 * {@link ParallelTextError} with the line the fault starts on. A document with an empty
 * body has no `tu` to name a target language, so `langs.target` is `''` in that case.
 */
export function fromTmx(xml: string): TmxParseResult {
  if (typeof xml !== 'string') {
    throw new ParallelTextError('invalid-input', 'fromTmx needs the text of a TMX document.');
  }
  const root = new XmlParser(xml).parse();
  if (root.name !== 'tmx') {
    throw new ParallelTextError('malformed-tmx', `the root element must be <tmx>, found <${root.name}>.`, root.line);
  }
  const version = root.attributes.get('version');
  if (version === undefined) {
    throw new ParallelTextError('malformed-tmx', 'the <tmx> element needs a version attribute.', root.line);
  }
  if (!version.startsWith('1.4')) {
    throw new ParallelTextError(
      'unsupported-tmx',
      `TMX version "${version}" is not supported; this reader reads 1.4.`,
      root.line,
    );
  }
  for (const child of elementChildren(root)) {
    if (child.name !== 'header' && child.name !== 'body') {
      throw new ParallelTextError('malformed-tmx', `<tmx> cannot contain <${child.name}>.`, child.line);
    }
  }

  const header = findSingleChild(root, 'header', 'tmx');
  const sourceLanguage = header.attributes.get('srclang');
  if (sourceLanguage === undefined || !LANGUAGE_TAG.test(sourceLanguage)) {
    throw new ParallelTextError('malformed-tmx', '<header> needs a BCP 47 srclang attribute.', header.line);
  }
  const datatype = header.attributes.get('datatype');
  if (datatype !== undefined && datatype !== 'plaintext') {
    throw new ParallelTextError(
      'unsupported-tmx',
      `datatype "${datatype}" is not supported; this reader reads plaintext.`,
      header.line,
    );
  }

  const body = findSingleChild(root, 'body', 'tmx');
  const segments: AlignedSegment[] = [];
  const seen = new Set<string>();
  let sourceLang = sourceLanguage;
  let targetLang = '';

  for (const [index, tu] of elementChildren(body).entries()) {
    if (tu.name !== 'tu') {
      throw new ParallelTextError('malformed-tmx', `<body> may only contain <tu> elements, found <${tu.name}>.`, tu.line);
    }
    const tuid = tu.attributes.get('tuid');
    const blockId = tuid !== undefined && tuid.length > 0 ? tuid : `tu-${index + 1}`;
    if (seen.has(blockId)) {
      throw new ParallelTextError('malformed-tmx', `tuid "${blockId}" appears more than once.`, tu.line);
    }
    seen.add(blockId);

    const variants: TmxVariant[] = [];
    const seenLanguages = new Set<string>();
    for (const child of elementChildren(tu)) {
      if (child.name === 'tuv') {
        const variant = readVariant(child);
        const key = variant.lang.toLowerCase();
        if (seenLanguages.has(key)) {
          throw new ParallelTextError(
            'unsupported-tmx',
            `<tu tuid="${blockId}"> has more than one <tuv xml:lang="${variant.lang}"> variant.`,
            variant.line,
          );
        }
        seenLanguages.add(key);
        variants.push(variant);
      } else if (child.name !== 'prop' && child.name !== 'note') {
        throw new ParallelTextError('malformed-tmx', `<tu> cannot contain <${child.name}>.`, child.line);
      }
    }

    const sourceVariant = variants.find(variant => variant.lang.toLowerCase() === sourceLanguage.toLowerCase());
    if (sourceVariant === undefined) {
      throw new ParallelTextError(
        'malformed-tmx',
        `<tu tuid="${blockId}"> has no <tuv xml:lang="${sourceLanguage}"> matching the header srclang.`,
        tu.line,
      );
    }
    const targetVariants = variants.filter(variant => variant.lang.toLowerCase() !== sourceLanguage.toLowerCase());
    const targetLanguages = new Set(targetVariants.map(variant => variant.lang.toLowerCase()));
    if (targetLanguages.size === 0) {
      throw new ParallelTextError('malformed-tmx', `<tu tuid="${blockId}"> has no target-language <tuv>.`, tu.line);
    }
    if (targetLanguages.size > 1) {
      throw new ParallelTextError(
        'unsupported-tmx',
        `<tu tuid="${blockId}"> has more than one target language; this reader needs exactly one.`,
        tu.line,
      );
    }
    const targetVariant = targetVariants[0]!;
    if (segments.length === 0) {
      sourceLang = sourceVariant.lang;
      targetLang = targetVariant.lang;
    } else if (targetVariant.lang.toLowerCase() !== targetLang.toLowerCase()) {
      throw new ParallelTextError(
        'unsupported-tmx',
        `<tu tuid="${blockId}"> targets "${targetVariant.lang}", but earlier segments target "${targetLang}"; one reader needs one target language.`,
        targetVariant.line,
      );
    }

    const ratio = lengthRatio(sourceVariant.text, targetVariant.text);
    segments.push({
      blockId,
      page: readTuPage(tu),
      source: sourceVariant.text,
      target: targetVariant.text,
      ratio,
      ratioWarning: isRatioOutOfBand(ratio),
    });
  }

  return { segments, langs: { source: sourceLang, target: targetLang } };
}
