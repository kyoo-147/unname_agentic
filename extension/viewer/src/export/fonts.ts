/**
 * Unicode faces for the PDF export, and the WinAnsi folding that remains as its fallback.
 *
 * Why this module exists: pdf-lib draws text with a face it embeds, and it can only embed a custom
 * TrueType face after a font engine is registered (`@pdf-lib/fontkit`). Its built-in faces are
 * WinAnsi-only, so before this module the export had to fold "Tiếng Việt" to "Tieng Viet" — wrong for
 * a Vietnamese-first reader. This module owns the whole font story for `pdf.ts`:
 *
 * - the bundled face (`public/fonts/NotoSans-Regular.ttf`, Noto Sans Regular, SIL OFL 1.1, licence in
 *   `public/fonts/OFL.txt`) is fetched once per URL and embedded once per document;
 * - fontkit is registered lazily, and only when a face is actually going to be embedded;
 * - coverage is answered from the face's own character map, not by hoping a draw call fails;
 * - the fallback order is explicit and total: **Noto Sans -> Helvetica (WinAnsi)**. If the asset
 *   cannot be fetched, decoded or embedded, `registerPdfFonts` resolves to the WinAnsi face with
 *   `unicode: false` and the caller keeps folding. No path throws.
 *
 * `foldToWinAnsi` lives here because folding is a font concern: the fallback face has no glyph for
 * the text, so the text is rewritten for it. `pdf.ts` re-exports it along with `isWinAnsiText` so the
 * public surface does not move.
 *
 * The module is importable in node: nothing at module scope touches `document`, `window` or a font
 * file. The bundled asset is only requested when a caller asks for it.
 */

import { StandardFonts, type PDFDocument, type PDFFont } from 'pdf-lib';

/** Where the bundled face is served from, relative to the document that loads the reader. */
export const BUNDLED_FONT_URL = 'fonts/NotoSans-Regular.ttf';
/** Name reported for the bundled Unicode face. */
export const BUNDLED_FONT_NAME = 'Noto Sans (Unicode)';
/** Name reported when the export had to fall back to the built-in face. */
export const FALLBACK_FACE_NAME = 'Helvetica (WinAnsi)';

/** The font engine's surface, used by type only so the engine stays out of the initial bundle. */
type FontkitApi = typeof import('@pdf-lib/fontkit');
/** A fontkit face, as returned by the engine registered with pdf-lib. */
type Face = ReturnType<FontkitApi['create']>;

/**
 * Loads the font engine on first use. It is about 700 KB of JavaScript that only an export needs, so
 * it sits behind a dynamic import and the reader does not fetch it to show a page. The package ships
 * a default export at runtime while its typings declare named ones, hence the narrow cast.
 */
async function loadFontkit(): Promise<FontkitApi> {
  const loaded = (await import('@pdf-lib/fontkit')) as unknown as { default?: FontkitApi };
  return loaded.default ?? (loaded as unknown as FontkitApi);
}

/** Text rewritten for the face that will draw it. */
export interface PreparedText {
  text: string;
  /** True when at least one character was replaced or removed. */
  changed: boolean;
  /** Characters removed because the face has no glyph for them. */
  dropped: number;
}

export interface PdfFontsOptions {
  /**
   * TrueType bytes of the Unicode face. `undefined` fetches the bundled asset; an explicit `null`
   * disables the face on purpose (the export then folds to WinAnsi), and empty bytes are treated the
   * same way as `null`.
   */
  bytes?: Uint8Array | null;
  /** URL the bundled asset is fetched from. Defaults to `BUNDLED_FONT_URL`. */
  url?: string;
}

/** The face a document draws with, plus the questions `pdf.ts` needs to ask about it. */
export interface PdfFontSet {
  /** Name reported in the build result. */
  readonly name: string;
  /** The embedded face. */
  readonly font: PDFFont;
  /** True when `font` is the bundled Unicode face rather than the built-in WinAnsi face. */
  readonly unicode: boolean;
  /** True when every character of `text` has a glyph in `font` as it stands. */
  canRepresent(text: string): boolean;
  /** Rewrites `text` for `font`, dropping characters the face cannot draw. */
  prepare(text: string): PreparedText;
}

/**
 * Characters that never draw a glyph of their own. They are removed from drawn text instead of
 * counting as a coverage gap, and line/tab controls are deliberately not in this set because the
 * layout code still needs them. The BOM, soft hyphen and zero-width/bidi marks all belong here: a
 * missing glyph for them is not an error, but handing them to the writer would produce a .notdef.
 */
function isSilentCodePoint(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  if (code < 0x20) return true;
  if (code >= 0x7f && code <= 0x9f) return true;
  return code === 0x00ad || code === 0x061c || code === 0x200b || code === 0x200c || code === 0x200d
    || code === 0x200e || code === 0x200f || code === 0x2060 || code === 0xfeff;
}

/**
 * Characters that WinAnsi cannot encode but whose intent is unambiguous. Applied before
 * decomposition, so typographic quotes and arrows degrade to the ASCII the reader expects.
 */
const FOLD_MAP: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"',
  '\u2013': '-', '\u2014': '-', '\u2012': '-', '\u2212': '-',
  '\u2026': '...', '\u2022': '*', '\u00b7': '.', '\u2032': "'", '\u2033': '"',
  '\u2192': '->', '\u2190': '<-', '\u2194': '<->', '\u21d2': '=>',
  '\u2264': '<=', '\u2265': '>=', '\u2260': '!=', '\u00d7': 'x', '\u00f7': '/',
  '\u0110': 'D', '\u0111': 'd', '\u01a0': 'O', '\u01a1': 'o', '\u01af': 'U', '\u01b0': 'u',
  '\u00a0': ' ', '\u2007': ' ', '\u202f': ' ', '\u2009': ' ', '\u200a': ' ', '\u200b': '', '\ufeff': '',
  '\u00ad': '', '\u2010': '-', '\u2011': '-',
};

/** Code points Windows-1252 actually maps: ASCII, the 0xA0-0xFF range and the 0x80-0x9F specials. */
function isWinAnsiCodePoint(code: number): boolean {
  if (code > 0x1f && code < 0x7f) return true;
  if (code >= 0xa0 && code <= 0xff) return true;
  return code === 0x80 || (code >= 0x82 && code <= 0x8c) || code === 0x8e
    || (code >= 0x91 && code <= 0x9c) || (code >= 0x9e && code <= 0x9f);
}

/** Same shape as `PreparedText`; kept as a name so callers can talk about WinAnsi folding alone. */
export type FoldResult = PreparedText;

/**
 * Rewrites text into the WinAnsi repertoire: decomposes accented letters and drops the marks, keeps
 * every character WinAnsi already has (so "café" stays "café"), and removes whatever is left. ASCII
 * digits are never touched — that is what "numbers must not be altered" means here.
 */
export function foldToWinAnsi(input: string): FoldResult {
  const source = typeof input === 'string' ? input : '';
  let text = '';
  let changed = false;
  let dropped = 0;
  for (const character of source) {
    const code = character.codePointAt(0) ?? 0;
    if (isWinAnsiCodePoint(code)) { text += character; continue; }
    const mapped = FOLD_MAP[character];
    if (mapped !== undefined) { text += mapped; changed = true; continue; }
    const decomposed = character.normalize('NFD');
    let kept = '';
    for (const part of decomposed) {
      const partCode = part.codePointAt(0) ?? 0;
      if (isWinAnsiCodePoint(partCode)) kept += part;
      // Combining marks and anything still unencodable are removed; `dropped` below records a
      // character that left nothing behind at all.
    }
    if (kept) { text += kept; changed = true; continue; }
    changed = true;
    dropped++;
  }
  return { text, changed, dropped };
}

/** True when every code point of `text` can be written with WinAnsi as it stands. */
export function isWinAnsiText(text: string): boolean {
  for (const character of text) if (!isWinAnsiCodePoint(character.codePointAt(0) ?? 0)) return false;
  return true;
}

/**
 * Font bytes are fetched at most once per resolved URL per process: two exports in one session share
 * the same 570 KB download instead of paying for it twice. A failed fetch is cached too, so an
 * offline browser does not retry the asset on every export.
 */
const assetCache = new Map<string, Promise<Uint8Array | null>>();

/** One font set per document: two pages drawn through the same document share one embedded face. */
const documentFonts = new WeakMap<PDFDocument, Promise<PdfFontSet>>();

/**
 * Resolves the asset URL against the document base, so a build served from a sub-path (`base: './'`)
 * and the Chrome extension both find `fonts/…` beside their own entry document. Without a DOM the
 * URL is left as given, which is where node callers inject their own bytes instead.
 */
function resolveAssetUrl(url: string): string {
  if (typeof document === 'undefined' || typeof document.baseURI !== 'string') return url;
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return url;
  }
}

/**
 * Fetches the bundled face's bytes, or resolves to `null` when they cannot be read. Never throws:
 * a missing asset is the documented reason to fold to WinAnsi, not an export failure.
 */
export function loadBundledFontBytes(url: string = BUNDLED_FONT_URL): Promise<Uint8Array | null> {
  const resolved = resolveAssetUrl(url);
  const cached = assetCache.get(resolved);
  if (cached) return cached;
  const pending = fetchFontBytes(resolved);
  assetCache.set(resolved, pending);
  return pending;
}

async function fetchFontBytes(url: string): Promise<Uint8Array | null> {
  try {
    if (typeof fetch !== 'function') return null;
    const response = await fetch(url);
    if (!response || response.ok !== true) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

const winAnsiFace = (font: PDFFont): PdfFontSet => ({
  name: FALLBACK_FACE_NAME,
  font,
  unicode: false,
  // The built-in face can only draw what WinAnsi maps, so that is exactly its coverage.
  canRepresent: text => isWinAnsiText(typeof text === 'string' ? text : ''),
  prepare: foldToWinAnsi,
});

const unicodeFace = (font: PDFFont, face: Face): PdfFontSet => {
  const hasGlyph = (code: number): boolean => {
    try {
      return face.hasGlyphForCodePoint(code);
    } catch {
      return false;
    }
  };
  return {
    name: BUNDLED_FONT_NAME,
    font,
    unicode: true,
    canRepresent(text) {
      for (const character of text) {
        const code = character.codePointAt(0) ?? 0;
        if (isSilentCodePoint(code)) continue;
        if (!hasGlyph(code)) return false;
      }
      return true;
    },
    prepare(text) {
      const source = typeof text === 'string' ? text : '';
      let prepared = '';
      let changed = false;
      let dropped = 0;
      for (const character of source) {
        const code = character.codePointAt(0) ?? 0;
        if (isSilentCodePoint(code)) { changed = true; continue; }
        if (hasGlyph(code)) { prepared += character; continue; }
        // The face has no glyph: leaving the character out is honest, drawing it would be tofu.
        changed = true;
        dropped++;
      }
      return { text: prepared, changed, dropped };
    },
  };
};

async function createFontSet(pdfDoc: PDFDocument, options: PdfFontsOptions): Promise<PdfFontSet> {
  const bytes = await resolveFontBytes(options);
  if (bytes) {
    try {
      const fontkit = await loadFontkit();
      // Registered lazily and only here: a document that never embeds a custom face never pays for
      // the engine. pdf-lib keeps the registration on the document, so this runs once per document.
      pdfDoc.registerFontkit(fontkit);
      const face = fontkit.create(bytes);
      // Subsetting keeps the export small; the same embedder serves every page of the document.
      const font = await pdfDoc.embedFont(bytes, { subset: true });
      if (face && typeof face.hasGlyphForCodePoint === 'function') return unicodeFace(font, face);
    } catch {
      // A broken or unsupported asset must not break the export: fall through to WinAnsi.
    }
  }
  return winAnsiFace(await pdfDoc.embedFont(StandardFonts.Helvetica));
}

async function resolveFontBytes(options: PdfFontsOptions): Promise<Uint8Array | null> {
  if (options.bytes === null) return null;
  if (options.bytes !== undefined) return options.bytes.length > 0 ? options.bytes : null;
  return loadBundledFontBytes(options.url ?? BUNDLED_FONT_URL);
}

/**
 * Registers fontkit and embeds the Unicode face for `pdfDoc`, lazily and once per document.
 *
 * Calling it twice for the same document returns the same promise, so two pages never embed two
 * copies of the face. The first call's options decide the face for that document; the promise
 * resolves to a WinAnsi set instead of rejecting when the face is unavailable, so a caller can
 * always draw.
 */
export function registerPdfFonts(pdfDoc: PDFDocument, options: PdfFontsOptions = {}): Promise<PdfFontSet> {
  const cached = documentFonts.get(pdfDoc);
  if (cached) return cached;
  const pending = createFontSet(pdfDoc, options);
  documentFonts.set(pdfDoc, pending);
  return pending;
}
