/**
 * H09: Real PDF preservation for metadata, hierarchical `/Outlines` bookmark trees,
 * and interactive `/AcroForm` fields/widgets across `pdf-lib` documents.
 *
 * `src/core/metadata.ts`, `src/core/outline.ts`, and `src/core/export-check.ts`
 * model and validate these structures as plain data; this module writes and copies
 * them into real PDF bytes via `pdf-lib` (high-level Document/Info APIs and low-level
 * `PDFDict` / `PDFArray` / `PDFRef` structures) so the output survives reload in both
 * `pdf-lib` and `pdfjs-dist`.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFPage,
  PDFPageLeaf,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';
import { normaliseDate, normaliseLanguageTag } from '../core/metadata';
import { UNTITLED_SECTION_ID, type Outline, type Section } from '../core/outline';

export interface PdfMetadataInput {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string | readonly string[];
  creator?: string;
  producer?: string;
  creationDate?: Date | string;
  modificationDate?: Date | string;
  lang?: string;
  rawCreationDate?: string;
  rawModificationDate?: string;
}

export interface ExtractedPdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modificationDate?: Date;
  rawCreationDate?: string;
  rawModificationDate?: string;
  lang?: string;
}

export interface PdfOutlineNode {
  title: string;
  /** 1-based target page number, or null/undefined for a section header with no destination. */
  page?: number | null;
  fit?: 'Fit' | 'XYZ';
  top?: number | null;
  left?: number | null;
  zoom?: number | null;
  /** Whether children are initially expanded (defaults to true). */
  open?: boolean;
  bold?: boolean;
  italic?: boolean;
  /** RGB values in [0, 1]. */
  color?: readonly [number, number, number];
  children?: readonly PdfOutlineNode[];
}

export type PageMap =
  | ReadonlyMap<number, number>
  | Readonly<Record<number, number>>
  | ((sourcePage: number) => number | null | undefined);

export interface WriteOutlinesOptions {
  pageMap?: PageMap;
  unmappedStrategy?: 'drop' | 'omit-dest';
  showOutlinesPanel?: boolean;
}

export interface WriteOutlinesResult {
  written: number;
  rootCount: number;
  dropped: number;
  warnings: string[];
}

export interface PreserveAcroFormOptions {
  pageMap?: PageMap;
  /** Removes orphaned `/Subtype /Widget` annotations on mapped target pages when target has no AcroForm yet. Default true. */
  removeOrphanedWidgets?: boolean;
}

export interface PreserveAcroFormResult {
  preserved: boolean;
  fieldCount: number;
  widgetCount: number;
  skippedFields: string[];
  warnings: string[];
}

export interface PreservePdfOptions {
  metadata?: PdfMetadataInput;
  outline?: Outline | readonly Section[] | readonly PdfOutlineNode[];
  pageMap?: PageMap;
  preserveMetadata?: boolean;
  preserveOutlines?: boolean;
  preserveAcroForm?: boolean;
  unmappedStrategy?: 'drop' | 'omit-dest';
  showOutlinesPanel?: boolean;
}

export interface PreservePdfResult {
  metadata: ExtractedPdfMetadata;
  outlines: WriteOutlinesResult;
  acroForm: PreserveAcroFormResult;
  warnings: string[];
}

export interface PreservePdfBytesResult extends PreservePdfResult {
  bytes: Uint8Array;
}

// --- Metadata reading, writing, copying -----------------------------------

async function asPdfDocument(src: PDFDocument | Uint8Array): Promise<PDFDocument> {
  if (src instanceof Uint8Array) {
    return PDFDocument.load(src, { updateMetadata: false, ignoreEncryption: true });
  }
  return src;
}

function readInfoText(infoDict: PDFDict | undefined, key: string): string | undefined {
  if (!infoDict) return undefined;
  const obj = infoDict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString);
  if (!obj) return undefined;
  const text = obj.decodeText().trim();
  return text.length > 0 ? text : undefined;
}

function parsePdfDateObject(
  obj: PDFString | PDFHexString | undefined,
): { date?: Date; raw?: string } {
  if (!obj) return {};
  const raw = obj.decodeText().trim();
  if (!raw) return {};

  try {
    const decoded = obj.decodeDate();
    if (!Number.isNaN(decoded.getTime())) {
      return { date: decoded, raw };
    }
  } catch {
    // Fall back to core metadata parser for partial/non-standard PDF dates.
  }

  const normalized = normaliseDate(raw);
  if (normalized.valid && normalized.iso) {
    const parsed = new Date(normalized.iso);
    if (!Number.isNaN(parsed.getTime())) {
      return { date: parsed, raw };
    }
  }

  return { raw };
}

function toValidDate(value: Date | string | undefined): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (/^D:/iu.test(trimmed)) {
    const normalized = normaliseDate(trimmed);
    if (normalized.valid && normalized.iso) {
      const parsed = new Date(normalized.iso);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
    return undefined;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function infoDictOf(doc: PDFDocument): PDFDict {
  const existing = doc.context.lookupMaybe(doc.context.trailerInfo.Info, PDFDict);
  if (existing) return existing;
  const created = doc.context.obj({});
  doc.context.trailerInfo.Info = doc.context.register(created);
  return created;
}

/**
 * Extracts document metadata (`/Info` dictionary entries and catalog `/Lang`) from a
 * `PDFDocument` or raw PDF bytes without mutating `Producer` or `ModDate`.
 */
export async function extractPdfMetadata(
  src: PDFDocument | Uint8Array,
): Promise<ExtractedPdfMetadata> {
  const doc = await asPdfDocument(src);
  const infoDict = doc.context.lookupMaybe(doc.context.trailerInfo.Info, PDFDict);

  const title = readInfoText(infoDict, 'Title');
  const author = readInfoText(infoDict, 'Author');
  const subject = readInfoText(infoDict, 'Subject');
  const keywords = readInfoText(infoDict, 'Keywords');
  const creator = readInfoText(infoDict, 'Creator');
  const producer = readInfoText(infoDict, 'Producer');

  const creation = parsePdfDateObject(
    infoDict?.lookupMaybe(PDFName.of('CreationDate'), PDFString, PDFHexString),
  );
  const modification = parsePdfDateObject(
    infoDict?.lookupMaybe(PDFName.of('ModDate'), PDFString, PDFHexString),
  );

  const langObj = doc.catalog.lookupMaybe(PDFName.of('Lang'), PDFString, PDFHexString);
  const langRaw = langObj?.decodeText().trim();
  const lang = langRaw && langRaw.length > 0 ? langRaw : undefined;

  return {
    ...(title !== undefined ? { title } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(keywords !== undefined ? { keywords } : {}),
    ...(creator !== undefined ? { creator } : {}),
    ...(producer !== undefined ? { producer } : {}),
    ...(creation.date !== undefined ? { creationDate: creation.date } : {}),
    ...(modification.date !== undefined ? { modificationDate: modification.date } : {}),
    ...(creation.raw !== undefined ? { rawCreationDate: creation.raw } : {}),
    ...(modification.raw !== undefined ? { rawModificationDate: modification.raw } : {}),
    ...(lang !== undefined ? { lang } : {}),
  };
}

/**
 * Writes PDF metadata (`Title`, `Author`, `Subject`, `Keywords`, `Creator`, `Producer`,
 * `CreationDate`, `ModDate`, and catalog `/Lang`) onto `doc`.
 */
export function applyPdfMetadata(
  doc: PDFDocument,
  metadata: PdfMetadataInput,
): ExtractedPdfMetadata {
  if (typeof metadata.title === 'string' && metadata.title.trim().length > 0) {
    doc.setTitle(metadata.title.trim());
  }
  if (typeof metadata.author === 'string' && metadata.author.trim().length > 0) {
    doc.setAuthor(metadata.author.trim());
  }
  if (typeof metadata.subject === 'string' && metadata.subject.trim().length > 0) {
    doc.setSubject(metadata.subject.trim());
  }

  if (Array.isArray(metadata.keywords)) {
    const cleaned = metadata.keywords.map(entry => entry.trim()).filter(entry => entry.length > 0);
    if (cleaned.length > 0) doc.setKeywords(cleaned);
  } else if (typeof metadata.keywords === 'string' && metadata.keywords.trim().length > 0) {
    doc.setKeywords([metadata.keywords.trim()]);
  }

  if (typeof metadata.creator === 'string' && metadata.creator.trim().length > 0) {
    doc.setCreator(metadata.creator.trim());
  }
  if (typeof metadata.producer === 'string' && metadata.producer.trim().length > 0) {
    doc.setProducer(metadata.producer.trim());
  }

  const creationDate = toValidDate(metadata.creationDate);
  if (creationDate) {
    doc.setCreationDate(creationDate);
  } else if (typeof metadata.rawCreationDate === 'string' && metadata.rawCreationDate.trim().length > 0) {
    infoDictOf(doc).set(PDFName.of('CreationDate'), PDFString.of(metadata.rawCreationDate.trim()));
  }

  const modificationDate = toValidDate(metadata.modificationDate);
  if (modificationDate) {
    doc.setModificationDate(modificationDate);
  } else if (
    typeof metadata.rawModificationDate === 'string'
    && metadata.rawModificationDate.trim().length > 0
  ) {
    infoDictOf(doc).set(PDFName.of('ModDate'), PDFString.of(metadata.rawModificationDate.trim()));
  }

  if (typeof metadata.lang === 'string' && metadata.lang.trim().length > 0) {
    const normalized = normaliseLanguageTag(metadata.lang);
    doc.setLanguage(normalized ?? metadata.lang.trim());
  }

  const infoDict = doc.context.lookupMaybe(doc.context.trailerInfo.Info, PDFDict);
  const creation = parsePdfDateObject(
    infoDict?.lookupMaybe(PDFName.of('CreationDate'), PDFString, PDFHexString),
  );
  const modification = parsePdfDateObject(
    infoDict?.lookupMaybe(PDFName.of('ModDate'), PDFString, PDFHexString),
  );
  const langObj = doc.catalog.lookupMaybe(PDFName.of('Lang'), PDFString, PDFHexString);
  const lang = langObj?.decodeText().trim();

  const title = readInfoText(infoDict, 'Title');
  const author = readInfoText(infoDict, 'Author');
  const subject = readInfoText(infoDict, 'Subject');
  const keywords = readInfoText(infoDict, 'Keywords');
  const creator = readInfoText(infoDict, 'Creator');
  const producer = readInfoText(infoDict, 'Producer');

  return {
    ...(title !== undefined ? { title } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(keywords !== undefined ? { keywords } : {}),
    ...(creator !== undefined ? { creator } : {}),
    ...(producer !== undefined ? { producer } : {}),
    ...(creation.date !== undefined ? { creationDate: creation.date } : {}),
    ...(modification.date !== undefined ? { modificationDate: modification.date } : {}),
    ...(creation.raw !== undefined ? { rawCreationDate: creation.raw } : {}),
    ...(modification.raw !== undefined ? { rawModificationDate: modification.raw } : {}),
    ...(lang && lang.length > 0 ? { lang } : {}),
  };
}

/**
 * Copies metadata from a source PDF (`PDFDocument` or bytes) to `target`, applying any
 * explicit `overrides` on top.
 */
export async function copyPdfMetadata(
  src: PDFDocument | Uint8Array,
  target: PDFDocument,
  overrides: PdfMetadataInput = {},
): Promise<ExtractedPdfMetadata> {
  const source = await extractPdfMetadata(src);
  const merged: PdfMetadataInput = {
    ...source,
    ...stripUndefined(overrides),
  };
  return applyPdfMetadata(target, merged);
}

// --- Hierarchical /Outlines bookmark tree ---------------------------------

function resolveTargetPage(
  sourcePage: number | null | undefined,
  targetPageCount: number,
  pageMap?: PageMap,
): number | null {
  if (sourcePage === null || sourcePage === undefined || !Number.isInteger(sourcePage) || sourcePage < 1) {
    return null;
  }

  let mapped: number | null | undefined;
  if (typeof pageMap === 'function') {
    mapped = pageMap(sourcePage);
  } else if (pageMap instanceof Map) {
    mapped = pageMap.get(sourcePage);
  } else if (pageMap && typeof pageMap === 'object') {
    mapped = (pageMap as Readonly<Record<number, number>>)[sourcePage];
  } else {
    mapped = sourcePage;
  }

  if (typeof mapped !== 'number' || !Number.isInteger(mapped)) return null;
  if (mapped < 1 || mapped > targetPageCount) return null;
  return mapped;
}

function isOutlineObject(value: unknown): value is Outline {
  return typeof value === 'object' && value !== null && Array.isArray((value as Outline).sections);
}

/**
 * Converts `src/core/outline.ts` sections or an `Outline` into `PdfOutlineNode[]`.
 * Empty untitled roots are skipped (lifting any child sections if present).
 */
export function outlineFromSections(input: Outline | readonly Section[]): PdfOutlineNode[] {
  const sections = isOutlineObject(input) ? input.sections : input;
  if (!Array.isArray(sections)) return [];

  const convert = (items: readonly Section[]): PdfOutlineNode[] => {
    const nodes: PdfOutlineNode[] = [];
    for (const section of items) {
      if (!section || typeof section !== 'object') continue;
      const children = Array.isArray(section.children) ? convert(section.children) : [];
      const title = typeof section.title === 'string' ? section.title.trim() : '';

      if (section.id === UNTITLED_SECTION_ID && title.length === 0) {
        nodes.push(...children);
        continue;
      }
      if (title.length === 0) {
        nodes.push(...children);
        continue;
      }

      nodes.push({
        title,
        page: Number.isInteger(section.page) && section.page >= 1 ? section.page : null,
        ...(children.length > 0 ? { children } : {}),
      });
    }
    return nodes;
  };

  return convert(sections);
}

function collectNamedDestinations(doc: PDFDocument): Map<string, PDFArray> {
  const map = new Map<string, PDFArray>();

  const registerDest = (name: string, value: PDFObject | undefined) => {
    const resolved = doc.context.lookup(value);
    if (resolved instanceof PDFArray) {
      map.set(name, resolved);
    } else if (resolved instanceof PDFDict) {
      const inner = resolved.lookupMaybe(PDFName.of('D'), PDFArray);
      if (inner) map.set(name, inner);
    }
  };

  const destsDict = doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
  if (destsDict) {
    for (const key of destsDict.keys()) {
      registerDest(key.decodeText(), destsDict.get(key));
    }
  }

  const namesDict = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const destsTree = namesDict?.lookupMaybe(PDFName.of('Dests'), PDFDict);
  if (destsTree) {
    const visited = new Set<PDFDict>();
    const walkNameTree = (node: PDFDict) => {
      if (visited.has(node)) return;
      visited.add(node);
      const namesArr = node.lookupMaybe(PDFName.of('Names'), PDFArray);
      if (namesArr) {
        for (let idx = 0; idx + 1 < namesArr.size(); idx += 2) {
          const keyObj = namesArr.lookup(idx);
          const key =
            keyObj instanceof PDFString || keyObj instanceof PDFHexString
              ? keyObj.decodeText()
              : keyObj instanceof PDFName
                ? keyObj.decodeText()
                : undefined;
          if (key !== undefined) registerDest(key, namesArr.get(idx + 1));
        }
      }
      const kidsArr = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
      if (kidsArr) {
        for (let idx = 0; idx < kidsArr.size(); idx += 1) {
          const kid = kidsArr.lookupMaybe(idx, PDFDict);
          if (kid) walkNameTree(kid);
        }
      }
    };
    walkNameTree(destsTree);
  }

  return map;
}

function parseDestArray(
  destArray: PDFArray,
  pageRefToNumber: ReadonlyMap<PDFRef, number>,
): { page: number | null; fit?: 'Fit' | 'XYZ'; left?: number | null; top?: number | null; zoom?: number | null } {
  const first = destArray.get(0);
  let page: number | null = null;
  if (first instanceof PDFRef) {
    page = pageRefToNumber.get(first) ?? null;
  } else if (first instanceof PDFNumber) {
    const oneBased = Math.trunc(first.asNumber()) + 1;
    if (oneBased >= 1) page = oneBased;
  }

  const mode = destArray.lookupMaybe(1, PDFName);
  if (mode === PDFName.of('XYZ')) {
    const numOrNull = (index: number): number | null => {
      const val = destArray.lookup(index);
      return val instanceof PDFNumber ? val.asNumber() : null;
    };
    return {
      page,
      fit: 'XYZ',
      left: numOrNull(2),
      top: numOrNull(3),
      zoom: numOrNull(4),
    };
  }

  return { page, fit: 'Fit' };
}

/**
 * Reads the hierarchical `/Outlines` bookmark tree from `srcDoc` into `PdfOutlineNode[]`.
 */
export function extractPdfOutlines(srcDoc: PDFDocument): PdfOutlineNode[] {
  const outlinesDict = srcDoc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  if (!outlinesDict) return [];

  const pageRefToNumber = new Map<PDFRef, number>();
  srcDoc.getPages().forEach((page, index) => {
    pageRefToNumber.set(page.ref, index + 1);
  });
  const namedDests = collectNamedDestinations(srcDoc);
  const visitedRefs = new Set<PDFRef>();

  const resolveDest = (itemDict: PDFDict): ReturnType<typeof parseDestArray> => {
    let destRaw = itemDict.get(PDFName.of('Dest'));
    if (!destRaw) {
      const action = itemDict.lookupMaybe(PDFName.of('A'), PDFDict);
      if (action && action.lookupMaybe(PDFName.of('S'), PDFName) === PDFName.of('GoTo')) {
        destRaw = action.get(PDFName.of('D'));
      }
    }

    const resolved = srcDoc.context.lookup(destRaw);
    if (resolved instanceof PDFArray) {
      return parseDestArray(resolved, pageRefToNumber);
    }
    if (resolved instanceof PDFString || resolved instanceof PDFHexString || resolved instanceof PDFName) {
      const arr = namedDests.get(resolved.decodeText());
      if (arr) return parseDestArray(arr, pageRefToNumber);
    }
    return { page: null };
  };

  const readSiblings = (firstRefObj: PDFObject | undefined): PdfOutlineNode[] => {
    const result: PdfOutlineNode[] = [];
    let cursor = firstRefObj;

    while (cursor instanceof PDFRef) {
      if (visitedRefs.has(cursor)) break;
      visitedRefs.add(cursor);

      const itemDict = srcDoc.context.lookupMaybe(cursor, PDFDict);
      if (!itemDict) break;

      const titleObj = itemDict.lookupMaybe(PDFName.of('Title'), PDFString, PDFHexString);
      const title = titleObj ? titleObj.decodeText() : '';
      const dest = resolveDest(itemDict);
      const countObj = itemDict.lookupMaybe(PDFName.of('Count'), PDFNumber);
      const open = countObj ? countObj.asNumber() >= 0 : true;

      const flagsObj = itemDict.lookupMaybe(PDFName.of('F'), PDFNumber);
      const flags = flagsObj ? Math.trunc(flagsObj.asNumber()) : 0;
      const italic = (flags & 1) !== 0;
      const bold = (flags & 2) !== 0;

      let color: [number, number, number] | undefined;
      const colorArr = itemDict.lookupMaybe(PDFName.of('C'), PDFArray);
      if (colorArr && colorArr.size() >= 3) {
        const r = colorArr.lookupMaybe(0, PDFNumber)?.asNumber();
        const g = colorArr.lookupMaybe(1, PDFNumber)?.asNumber();
        const b = colorArr.lookupMaybe(2, PDFNumber)?.asNumber();
        if (r !== undefined && g !== undefined && b !== undefined) {
          color = [r, g, b];
        }
      }

      const children = readSiblings(itemDict.get(PDFName.of('First')));
      if (title.length > 0 || children.length > 0) {
        result.push({
          title,
          page: dest.page,
          ...(dest.fit ? { fit: dest.fit } : {}),
          ...(dest.left !== undefined ? { left: dest.left } : {}),
          ...(dest.top !== undefined ? { top: dest.top } : {}),
          ...(dest.zoom !== undefined ? { zoom: dest.zoom } : {}),
          ...(!open ? { open: false } : {}),
          ...(bold ? { bold: true } : {}),
          ...(italic ? { italic: true } : {}),
          ...(color ? { color } : {}),
          ...(children.length > 0 ? { children } : {}),
        });
      }

      cursor = itemDict.get(PDFName.of('Next'));
    }

    return result;
  };

  return readSiblings(outlinesDict.get(PDFName.of('First')));
}

interface NormalizedOutlineNode {
  title: string;
  page: number | null;
  fit: 'Fit' | 'XYZ';
  left: number | null;
  top: number | null;
  zoom: number | null;
  open: boolean;
  bold: boolean;
  italic: boolean;
  color?: [number, number, number];
  children: NormalizedOutlineNode[];
}

function clampColor(color: readonly [number, number, number] | undefined): [number, number, number] | undefined {
  if (!color || color.length < 3) return undefined;
  const clampChannel = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
  return [clampChannel(color[0]), clampChannel(color[1]), clampChannel(color[2])];
}

function normalizeOutlineTree(
  nodes: readonly PdfOutlineNode[],
  targetPageCount: number,
  options: WriteOutlinesOptions,
): { items: NormalizedOutlineNode[]; dropped: number; warnings: string[] } {
  const unmappedStrategy = options.unmappedStrategy ?? 'drop';
  const warnings: string[] = [];
  let dropped = 0;

  const visit = (list: readonly PdfOutlineNode[]): NormalizedOutlineNode[] => {
    const out: NormalizedOutlineNode[] = [];
    for (const node of list) {
      if (!node || typeof node !== 'object') continue;
      const children = Array.isArray(node.children) ? visit(node.children) : [];
      const title = typeof node.title === 'string' ? node.title.trim() : '';
      if (title.length === 0) {
        out.push(...children);
        continue;
      }

      const hasExplicitPage = node.page !== null && node.page !== undefined;
      const mappedPage = resolveTargetPage(node.page, targetPageCount, options.pageMap);

      if (hasExplicitPage && mappedPage === null) {
        if (unmappedStrategy === 'drop') {
          dropped += 1;
          warnings.push(`Dropped outline item "${title}" pointing to unmapped page ${String(node.page)}.`);
          out.push(...children);
          continue;
        }
        warnings.push(`Omitted destination for outline item "${title}" (source page ${String(node.page)} not in target).`);
      }

      out.push({
        title,
        page: mappedPage,
        fit: node.fit === 'XYZ' ? 'XYZ' : 'Fit',
        left: typeof node.left === 'number' && Number.isFinite(node.left) ? node.left : null,
        top: typeof node.top === 'number' && Number.isFinite(node.top) ? node.top : null,
        zoom: typeof node.zoom === 'number' && Number.isFinite(node.zoom) ? node.zoom : null,
        open: node.open !== false,
        bold: node.bold === true,
        italic: node.italic === true,
        color: clampColor(node.color),
        children,
      });
    }
    return out;
  };

  return { items: visit(nodes), dropped, warnings };
}

/**
 * Rebuilds a hierarchical `/Outlines` bookmark tree inside `doc` via `pdf-lib`
 * low-level `PDFDict` / `PDFArray` objects pointing to `doc`'s pages.
 */
export function writePdfOutlines(
  doc: PDFDocument,
  nodes: readonly PdfOutlineNode[],
  options: WriteOutlinesOptions = {},
): WriteOutlinesResult {
  const pages = doc.getPages();
  const normalized = normalizeOutlineTree(nodes, pages.length, options);

  if (normalized.items.length === 0) {
    doc.catalog.delete(PDFName.of('Outlines'));
    return {
      written: 0,
      rootCount: 0,
      dropped: normalized.dropped,
      warnings: normalized.warnings,
    };
  }

  const outlinesRef = doc.context.nextRef();
  let written = 0;

  const buildLevel = (
    items: readonly NormalizedOutlineNode[],
    parentRef: PDFRef,
  ): { first: PDFRef; last: PDFRef; visibleCount: number } => {
    const refs = items.map(() => doc.context.nextRef());
    let visibleCount = 0;

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const itemRef = refs[index]!;
      written += 1;

      const childSummary =
        item.children.length > 0 ? buildLevel(item.children, itemRef) : null;

      // PDF 32000-1 12.3.3 Table 153: Count is positive when open (sum of visible
      // descendants), negative when closed (negated count of descendants visible if opened).
      const descendantCount = childSummary ? childSummary.visibleCount : 0;
      visibleCount += 1 + (item.open ? descendantCount : 0);

      const dictEntries: Record<string, PDFObject> = {
        Title: PDFHexString.fromText(item.title),
        Parent: parentRef,
      };

      if (index > 0) dictEntries.Prev = refs[index - 1]!;
      if (index < items.length - 1) dictEntries.Next = refs[index + 1]!;

      if (childSummary) {
        dictEntries.First = childSummary.first;
        dictEntries.Last = childSummary.last;
        dictEntries.Count = PDFNumber.of(item.open ? descendantCount : -descendantCount);
      }

      if (item.page !== null) {
        const pageRef = pages[item.page - 1]!.ref;
        const dest =
          item.fit === 'XYZ'
            ? doc.context.obj([
                pageRef,
                PDFName.of('XYZ'),
                item.left ?? PDFNull,
                item.top ?? PDFNull,
                item.zoom ?? PDFNull,
              ])
            : doc.context.obj([pageRef, PDFName.of('Fit')]);
        dictEntries.Dest = dest;
      }

      const flags = (item.italic ? 1 : 0) | (item.bold ? 2 : 0);
      if (flags !== 0) {
        dictEntries.F = PDFNumber.of(flags);
      }

      if (item.color) {
        dictEntries.C = doc.context.obj([...item.color]);
      }

      doc.context.assign(itemRef, doc.context.obj(dictEntries));
    }

    return {
      first: refs[0]!,
      last: refs[refs.length - 1]!,
      visibleCount,
    };
  };

  const rootSummary = buildLevel(normalized.items, outlinesRef);
  doc.context.assign(
    outlinesRef,
    doc.context.obj({
      Type: PDFName.of('Outlines'),
      First: rootSummary.first,
      Last: rootSummary.last,
      Count: PDFNumber.of(rootSummary.visibleCount),
    }),
  );
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);

  if (options.showOutlinesPanel) {
    doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  }

  return {
    written,
    rootCount: normalized.items.length,
    dropped: normalized.dropped,
    warnings: normalized.warnings,
  };
}

/**
 * Extracts outlines from `srcDoc` and rebuilds them on `targetDoc` using `options.pageMap`.
 */
export function copyPdfOutlines(
  srcDoc: PDFDocument,
  targetDoc: PDFDocument,
  options: WriteOutlinesOptions = {},
): WriteOutlinesResult {
  const extracted = extractPdfOutlines(srcDoc);
  return writePdfOutlines(targetDoc, extracted, options);
}

// --- AcroForm preservation ------------------------------------------------

class PdfValueCopier {
  private readonly refMap = new Map<PDFRef, PDFRef>();
  private readonly seen = new Map<PDFObject, PDFObject>();

  constructor(
    private readonly src: PDFDocument,
    private readonly dest: PDFDocument,
    pageRefMap: ReadonlyMap<PDFRef, PDFRef>,
  ) {
    for (const [srcPageRef, targetPageRef] of pageRefMap.entries()) {
      this.refMap.set(srcPageRef, targetPageRef);
    }
  }

  mapRef(srcRef: PDFRef, destRef: PDFRef): void {
    this.refMap.set(srcRef, destRef);
  }

  mappedRef(srcRef: PDFRef): PDFRef | undefined {
    return this.refMap.get(srcRef);
  }

  copy(object: PDFObject): PDFObject {
    if (object instanceof PDFRef) {
      const existing = this.refMap.get(object);
      if (existing) return existing;

      const deref = this.src.context.lookup(object);
      if (deref instanceof PDFPageLeaf) {
        return PDFNull;
      }

      const newRef = this.dest.context.nextRef();
      this.refMap.set(object, newRef);
      if (deref) {
        this.dest.context.assign(newRef, this.copy(deref));
      }
      return newRef;
    }

    if (object instanceof PDFPageLeaf) {
      return PDFNull;
    }

    if (object instanceof PDFStream) {
      const cached = this.seen.get(object);
      if (cached) return cached;
      const clonedStream = object.clone(this.dest.context);
      this.seen.set(object, clonedStream);
      for (const [key, value] of object.dict.entries()) {
        clonedStream.dict.set(key, this.copy(value));
      }
      return clonedStream;
    }

    if (object instanceof PDFDict) {
      const cached = this.seen.get(object);
      if (cached) return cached;
      const clonedDict = PDFDict.withContext(this.dest.context);
      this.seen.set(object, clonedDict);
      for (const [key, value] of object.entries()) {
        clonedDict.set(key, this.copy(value));
      }
      return clonedDict;
    }

    if (object instanceof PDFArray) {
      const cached = this.seen.get(object);
      if (cached) return cached;
      const clonedArray = PDFArray.withContext(this.dest.context);
      this.seen.set(object, clonedArray);
      for (let index = 0; index < object.size(); index += 1) {
        clonedArray.push(this.copy(object.get(index)));
      }
      return clonedArray;
    }

    return object.clone(this.dest.context);
  }

  copyDictWithoutKeys(dict: PDFDict, excludedKeys: ReadonlySet<PDFName>): PDFDict {
    const cloned = PDFDict.withContext(this.dest.context);
    for (const [key, value] of dict.entries()) {
      if (excludedKeys.has(key)) continue;
      const copied = this.copy(value);
      if (copied !== PDFNull) {
        cloned.set(key, copied);
      }
    }
    return cloned;
  }
}

function isNonTerminalField(srcDoc: PDFDocument, dict: PDFDict): boolean {
  const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (!kids) return false;
  for (let index = 0; index < kids.size(); index += 1) {
    const kid = srcDoc.context.lookup(kids.get(index));
    if (kid instanceof PDFDict && kid.has(PDFName.of('T'))) {
      return true;
    }
  }
  return false;
}

function removeWidgetAnnotsFromPage(page: PDFPage): void {
  const annots = page.node.Annots();
  if (!annots) return;
  for (let index = annots.size() - 1; index >= 0; index -= 1) {
    const entry = annots.lookupMaybe(index, PDFDict);
    if (entry?.get(PDFName.of('Subtype')) === PDFName.of('Widget')) {
      annots.remove(index);
    }
  }
  if (annots.size() === 0) {
    page.node.delete(PDFName.of('Annots'));
  }
}

const EXCLUDED_FIELD_KEYS = new Set<PDFName>([
  PDFName.of('Kids'),
  PDFName.of('Parent'),
  PDFName.of('P'),
]);

const EXCLUDED_WIDGET_KEYS = new Set<PDFName>([
  PDFName.of('Parent'),
  PDFName.of('P'),
]);

/**
 * Preserves interactive `/AcroForm` fields, values, resources (`/DR`), appearance streams
 * (`/AP`), and widget annotations from `srcDoc` onto `targetDoc`, remapping widget page
 * links via `options.pageMap` without duplicating widgets on `copyPages()` pages.
 */
export function preserveAcroForm(
  srcDoc: PDFDocument,
  targetDoc: PDFDocument,
  options: PreserveAcroFormOptions = {},
): PreserveAcroFormResult {
  const srcAcroDict = srcDoc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (!srcAcroDict) {
    return { preserved: false, fieldCount: 0, widgetCount: 0, skippedFields: [], warnings: [] };
  }

  const warnings: string[] = [];
  const skippedFields: string[] = [];

  if (srcAcroDict.has(PDFName.of('XFA'))) {
    warnings.push('Source AcroForm contains XFA data, which is unsupported and was omitted.');
  }

  const srcPages = srcDoc.getPages();
  const targetPages = targetDoc.getPages();

  const srcPageRefToNum = new Map<PDFRef, number>();
  const widgetRefToSrcPageNum = new Map<PDFRef, number>();
  srcPages.forEach((page, pageIndex) => {
    const pageNumber = pageIndex + 1;
    srcPageRefToNum.set(page.ref, pageNumber);
    const annots = page.node.Annots();
    if (!annots) return;
    for (let idx = 0; idx < annots.size(); idx += 1) {
      const ref = annots.get(idx);
      if (ref instanceof PDFRef) {
        widgetRefToSrcPageNum.set(ref, pageNumber);
      }
    }
  });

  const srcPageRefToTargetPage = new Map<PDFRef, PDFPage>();
  const pageRefMap = new Map<PDFRef, PDFRef>();
  const mappedTargetPages = new Set<PDFPage>();

  for (const [srcPageRef, srcPageNumber] of srcPageRefToNum.entries()) {
    const targetPageNumber = resolveTargetPage(srcPageNumber, targetPages.length, options.pageMap);
    if (targetPageNumber !== null) {
      const targetPage = targetPages[targetPageNumber - 1]!;
      srcPageRefToTargetPage.set(srcPageRef, targetPage);
      pageRefMap.set(srcPageRef, targetPage.ref);
      mappedTargetPages.add(targetPage);
    }
  }

  const targetHadAcroForm = targetDoc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict) !== undefined;
  if (!targetHadAcroForm && options.removeOrphanedWidgets !== false) {
    for (const targetPage of mappedTargetPages) {
      removeWidgetAnnotsFromPage(targetPage);
    }
  }

  const copier = new PdfValueCopier(srcDoc, targetDoc, pageRefMap);
  let fieldCount = 0;
  let widgetCount = 0;

  const findTargetPageForWidget = (widgetRef: PDFRef | undefined, widgetDict: PDFDict): PDFPage | undefined => {
    const pRef = widgetDict.get(PDFName.of('P'));
    if (pRef instanceof PDFRef) {
      const mapped = srcPageRefToTargetPage.get(pRef);
      if (mapped) return mapped;
    }
    if (widgetRef) {
      const srcPageNum = widgetRefToSrcPageNum.get(widgetRef);
      if (srcPageNum !== undefined) {
        const targetPageNum = resolveTargetPage(srcPageNum, targetPages.length, options.pageMap);
        if (targetPageNum !== null) return targetPages[targetPageNum - 1];
      }
    }
    return undefined;
  };

  const copyFieldNode = (
    srcRef: PDFRef | undefined,
    srcDict: PDFDict,
    parentTargetRef: PDFRef | undefined,
    parentNamePrefix: string,
  ): PDFRef | undefined => {
    const partialObj = srcDict.lookupMaybe(PDFName.of('T'), PDFString, PDFHexString);
    const partialName = partialObj?.decodeText();
    const fullName = partialName
      ? parentNamePrefix
        ? `${parentNamePrefix}.${partialName}`
        : partialName
      : parentNamePrefix || '<unnamed>';

    if (isNonTerminalField(srcDoc, srcDict)) {
      const kidsArr = srcDict.lookupMaybe(PDFName.of('Kids'), PDFArray);
      if (!kidsArr) return undefined;

      const nodeRef = targetDoc.context.nextRef();
      if (srcRef) copier.mapRef(srcRef, nodeRef);

      const copiedKidRefs: PDFRef[] = [];
      for (let idx = 0; idx < kidsArr.size(); idx += 1) {
        const kidObj = kidsArr.get(idx);
        const kidRef = kidObj instanceof PDFRef ? kidObj : undefined;
        const kidDict = srcDoc.context.lookupMaybe(kidObj, PDFDict);
        if (!kidDict) continue;
        const copiedKid = copyFieldNode(kidRef, kidDict, nodeRef, fullName);
        if (copiedKid) copiedKidRefs.push(copiedKid);
      }

      if (copiedKidRefs.length === 0) return undefined;

      const clonedDict = copier.copyDictWithoutKeys(srcDict, EXCLUDED_FIELD_KEYS);
      clonedDict.set(PDFName.of('Kids'), targetDoc.context.obj(copiedKidRefs));
      if (parentTargetRef) clonedDict.set(PDFName.of('Parent'), parentTargetRef);
      targetDoc.context.assign(nodeRef, clonedDict);
      return nodeRef;
    }

    const kidsArr = srcDict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kidsArr && kidsArr.size() > 0) {
      const fieldRef = targetDoc.context.nextRef();
      if (srcRef) copier.mapRef(srcRef, fieldRef);

      const survivingWidgets: { ref: PDFRef; page: PDFPage }[] = [];
      for (let idx = 0; idx < kidsArr.size(); idx += 1) {
        const kidObj = kidsArr.get(idx);
        const kidRef = kidObj instanceof PDFRef ? kidObj : undefined;
        const kidDict = srcDoc.context.lookupMaybe(kidObj, PDFDict);
        if (!kidDict) continue;

        const targetPage = findTargetPageForWidget(kidRef, kidDict);
        if (!targetPage) continue;

        const widgetRef = targetDoc.context.nextRef();
        if (kidRef) copier.mapRef(kidRef, widgetRef);

        const clonedWidget = copier.copyDictWithoutKeys(kidDict, EXCLUDED_WIDGET_KEYS);
        clonedWidget.set(PDFName.of('Parent'), fieldRef);
        clonedWidget.set(PDFName.of('P'), targetPage.ref);
        targetDoc.context.assign(widgetRef, clonedWidget);
        survivingWidgets.push({ ref: widgetRef, page: targetPage });
      }

      if (survivingWidgets.length === 0) {
        skippedFields.push(fullName);
        return undefined;
      }

      const clonedField = copier.copyDictWithoutKeys(srcDict, EXCLUDED_FIELD_KEYS);
      clonedField.set(
        PDFName.of('Kids'),
        targetDoc.context.obj(survivingWidgets.map(entry => entry.ref)),
      );
      if (parentTargetRef) clonedField.set(PDFName.of('Parent'), parentTargetRef);
      targetDoc.context.assign(fieldRef, clonedField);

      for (const widget of survivingWidgets) {
        widget.page.node.addAnnot(widget.ref);
        widgetCount += 1;
      }
      fieldCount += 1;
      if (srcDict.lookupMaybe(PDFName.of('FT'), PDFName) === PDFName.of('Sig') && srcDict.has(PDFName.of('V'))) {
        warnings.push(
          `Signature field "${fullName}" was preserved, but modifying or rebuilding the PDF invalidates any prior cryptographic signature.`,
        );
      }
      return fieldRef;
    }

    // Merged field + widget dictionary
    const targetPage = findTargetPageForWidget(srcRef, srcDict);
    if (!targetPage) {
      skippedFields.push(fullName);
      return undefined;
    }

    const fieldRef = targetDoc.context.nextRef();
    if (srcRef) copier.mapRef(srcRef, fieldRef);

    const clonedMerged = copier.copyDictWithoutKeys(srcDict, EXCLUDED_FIELD_KEYS);
    if (parentTargetRef) clonedMerged.set(PDFName.of('Parent'), parentTargetRef);
    clonedMerged.set(PDFName.of('P'), targetPage.ref);
    targetDoc.context.assign(fieldRef, clonedMerged);
    targetPage.node.addAnnot(fieldRef);

    fieldCount += 1;
    widgetCount += 1;
    if (srcDict.lookupMaybe(PDFName.of('FT'), PDFName) === PDFName.of('Sig') && srcDict.has(PDFName.of('V'))) {
      warnings.push(
        `Signature field "${fullName}" was preserved, but modifying or rebuilding the PDF invalidates any prior cryptographic signature.`,
      );
    }
    return fieldRef;
  };

  const srcFields = srcAcroDict.lookupMaybe(PDFName.of('Fields'), PDFArray);
  const rootFieldRefs: PDFRef[] = [];
  if (srcFields) {
    for (let idx = 0; idx < srcFields.size(); idx += 1) {
      const entryObj = srcFields.get(idx);
      const entryRef = entryObj instanceof PDFRef ? entryObj : undefined;
      const entryDict = srcDoc.context.lookupMaybe(entryObj, PDFDict);
      if (!entryDict) continue;
      const copiedRef = copyFieldNode(entryRef, entryDict, undefined, '');
      if (copiedRef) rootFieldRefs.push(copiedRef);
    }
  }

  if (fieldCount === 0) {
    return {
      preserved: false,
      fieldCount: 0,
      widgetCount: 0,
      skippedFields,
      warnings,
    };
  }

  const targetAcroForm = targetDoc.catalog.getOrCreateAcroForm();
  const targetAcroDict = targetAcroForm.dict;
  targetAcroDict.set(PDFName.of('Fields'), targetDoc.context.obj(rootFieldRefs));

  for (const keyName of ['DR', 'DA', 'Q', 'NeedAppearances', 'SigFlags'] as const) {
    const key = PDFName.of(keyName);
    const value = srcAcroDict.get(key);
    if (value !== undefined) {
      const copied = copier.copy(value);
      if (copied !== PDFNull) {
        targetAcroDict.set(key, copied);
      }
    }
  }

  const coArr = srcAcroDict.lookupMaybe(PDFName.of('CO'), PDFArray);
  if (coArr) {
    const copiedCo: PDFRef[] = [];
    for (let idx = 0; idx < coArr.size(); idx += 1) {
      const entry = coArr.get(idx);
      if (entry instanceof PDFRef) {
        const mapped = copier.mappedRef(entry);
        if (mapped) copiedCo.push(mapped);
      }
    }
    if (copiedCo.length > 0) {
      targetAcroDict.set(PDFName.of('CO'), targetDoc.context.obj(copiedCo));
    }
  }

  return {
    preserved: true,
    fieldCount,
    widgetCount,
    skippedFields,
    warnings,
  };
}

// --- Unified preservation pipeline ----------------------------------------

function isOutlineNodeArray(
  outline: Outline | readonly Section[] | readonly PdfOutlineNode[],
): outline is readonly PdfOutlineNode[] {
  if (!Array.isArray(outline)) return false;
  if (outline.length === 0) return true;
  const first = outline[0] as Record<string, unknown>;
  return typeof first === 'object' && first !== null && !('blockId' in first);
}

/**
 * Preserves metadata, `/Outlines` bookmark hierarchy, and `/AcroForm` fields from `srcDoc`
 * onto `targetDoc` (or applies caller-supplied `outline` / `metadata` overrides).
 */
export async function preservePdfDocument(
  srcDoc: PDFDocument,
  targetDoc: PDFDocument,
  options: PreservePdfOptions = {},
): Promise<PreservePdfResult> {
  const warnings: string[] = [];

  const metadata =
    options.preserveMetadata === false
      ? options.metadata
        ? applyPdfMetadata(targetDoc, options.metadata)
        : await extractPdfMetadata(targetDoc)
      : await copyPdfMetadata(srcDoc, targetDoc, options.metadata);

  let outlines: WriteOutlinesResult = { written: 0, rootCount: 0, dropped: 0, warnings: [] };
  if (options.outline !== undefined) {
    const nodes = isOutlineNodeArray(options.outline)
      ? options.outline
      : outlineFromSections(options.outline);
    outlines = writePdfOutlines(targetDoc, nodes, {
      pageMap: options.pageMap,
      unmappedStrategy: options.unmappedStrategy,
      showOutlinesPanel: options.showOutlinesPanel,
    });
  } else if (options.preserveOutlines !== false) {
    outlines = copyPdfOutlines(srcDoc, targetDoc, {
      pageMap: options.pageMap,
      unmappedStrategy: options.unmappedStrategy,
      showOutlinesPanel: options.showOutlinesPanel,
    });
  }
  warnings.push(...outlines.warnings);

  const acroForm =
    options.preserveAcroForm === false
      ? { preserved: false, fieldCount: 0, widgetCount: 0, skippedFields: [], warnings: [] }
      : preserveAcroForm(srcDoc, targetDoc, { pageMap: options.pageMap });
  warnings.push(...acroForm.warnings);

  return { metadata, outlines, acroForm, warnings };
}

/**
 * Byte-level convenience wrapper for {@link preservePdfDocument}: loads both PDF buffers
 * with `{ updateMetadata: false }`, preserves metadata/outlines/AcroForm, and returns
 * the serialized PDF bytes alongside the preservation report.
 */
export async function preservePdfBytes(
  srcBytes: Uint8Array,
  targetBytes: Uint8Array,
  options: PreservePdfOptions = {},
): Promise<PreservePdfBytesResult> {
  const srcDoc = await PDFDocument.load(srcBytes, { updateMetadata: false, ignoreEncryption: true });
  const targetDoc = await PDFDocument.load(targetBytes, { updateMetadata: false, ignoreEncryption: true });

  const result = await preservePdfDocument(srcDoc, targetDoc, options);
  const bytes = await targetDoc.save({ updateFieldAppearances: false });
  return { bytes, ...result };
}

function stripUndefined<T extends object>(record: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}
