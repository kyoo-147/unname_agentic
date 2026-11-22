/**
 * Pre-send payload preview for cloud consent (backlog M07).
 *
 * Text must not leave this machine before the reader has seen what would leave. This
 * module builds that view: one entry per block carrying the text that would be sent, the
 * character and UTF-8 byte totals for the whole body, and the list of blocks that carry
 * any text at all. It never sends, never reads the clock and never touches the network,
 * so a settings dialog can rebuild it on every keystroke.
 *
 * Contract:
 * - Pure and deterministic. The only global it touches is a `TextEncoder` for byte
 *   counting; there is no clock, no randomness, no DOM, no I/O.
 * - `characters` is the length, in UTF-16 code units (the unit `String.prototype.length`
 *   reports), of the text that would leave for that block, *after* `protect.mask` ran when
 *   `options.protect` is set. It is never derived from `preview`: a preview is a sample,
 *   and a payload estimate must not shrink because the sample was cut short.
 * - `bytes` is the UTF-8 length of the body estimate, which is every block's sent text
 *   concatenated in reading order. A real request adds a JSON envelope, field names and
 *   headers, so this figure is a lower bound on the request, not the request.
 * - `preview` is truncated at {@link PREVIEW_MAX_CHARACTERS} code units and then ends with
 *   {@link PREVIEW_TRUNCATION_MARKER}. A surrogate pair is never split, so the cut may land
 *   one unit earlier. `options.maxPreviewCharacters` moves the cut and
 *   `Number.POSITIVE_INFINITY` shows every block in full.
 * - `redacted` means the visible text is not the source text: `protect.mask` replaced a
 *   locked token with a placeholder, or {@link applyRedaction} replaced a span. It is a
 *   statement about the preview only; `characters` and `bytes` still describe the payload.
 * - `wouldSend` names the blocks whose sent text is non-empty, in reading order. An empty
 *   list means nothing leaves, which is what an empty document has to report.
 * - 1-based page numbers, matching `TextBlock.page` in `src/core/types.ts` and `Page.index`
 *   in `src/core/ir.ts`; a block that carries no page is reported on page 1.
 *
 * ## Where the endpoint comes from
 *
 * `endpointScope` is `privacy.effectiveEndpoint(settings)` run through
 * `privacy.classifyEndpoint`, not `settings.endpoint` directly: Google and DeepL ignore the
 * configured endpoint and call their own host, so reading the field would promise a
 * loopback request the transport never makes. The scope is therefore `remote` for every
 * cloud provider that talks to its own API, whatever the settings field says.
 *
 * ## Redaction works on the sample, not on the document
 *
 * {@link applyRedaction} can only work on what this module returned: the visible preview.
 * This module deliberately keeps no second copy of the full text, so redacting the sample
 * cannot rewrite the payload and `totals` stay exactly as {@link previewPayload} computed
 * them. The `redaction` summary counts what the user can see being removed from the
 * sample; a caller that wants the payload itself redacted has to redact the source blocks
 * (`redact.ts` plans those spans) and preview them again.
 *
 * ## Cost
 *
 * {@link estimateCost} reuses `pricing.ts`: a model id is resolved against the published
 * table, and a caller-supplied `ModelPricing` row is used as given. The unit is USD from
 * list prices quoted per million tokens, and the token count uses `pricing.ts`'s
 * {@link CHARACTERS_PER_TOKEN} rule of four characters per token. It is a planning figure,
 * not a quote: providers change prices and add discounts the table cannot see.
 */

import {
  estimateCost as estimateFromTable,
  estimateTokens,
  findModelPricing,
  type CostDirection,
  type ModelPricing,
} from './pricing';
import { classifyEndpoint, effectiveEndpoint, type EndpointScope, type PrivacySettings } from './privacy';
import { mask } from './protect';
import {
  DEFAULT_MASK,
  DEFAULT_MIN_CONFIDENCE,
  SENSITIVE_KINDS,
  applyRedaction as replaceSpans,
  detectSensitive,
  planRedaction,
  type RedactionMask,
  type SensitiveKind,
} from './redact';
import type { ProviderKind } from './types';

// --- Constants --------------------------------------------------------------

/**
 * Code units of source text a preview shows before it is cut, including the one a
 * surrogate pair would leave dangling. 280 is about four lines of body text on a phone:
 * long enough that a reader recognises the paragraph, short enough that a hundred blocks
 * still fit in one consent dialog.
 */
export const PREVIEW_MAX_CHARACTERS = 280;

/**
 * What a cut preview ends with. An ellipsis in brackets, so it reads as a truncation and
 * not as text the document contained; `characters - PREVIEW_MAX_CHARACTERS` is how much
 * the caller is not showing.
 */
export const PREVIEW_TRUNCATION_MARKER = ' […truncated]';

// --- Inputs -----------------------------------------------------------------

/**
 * One block as the reader holds it. A `TextBlock` satisfies this shape directly; a
 * canonical `ir.ts` `Block` carries its text on `raw`, which is accepted as a fallback so
 * a caller does not have to copy the document before previewing it.
 */
export interface PayloadBlockInput {
  /** Reader block id, for example `p3-r0`. A missing id is labelled `p{page}-r{index}`. */
  readonly id?: string;
  /** 1-based page number; anything that is not a positive integer counts as page 1. */
  readonly page?: number;
  /** Source text. Preferred over `raw` when both are present. */
  readonly text?: string;
  /** `ir.ts` block text, used only when `text` is absent. */
  readonly raw?: string;
}

/** Knobs that change what the preview shows, never what the payload is. */
export interface PreviewOptions {
  /**
   * Mask locked tokens with `protect.mask` before previewing, so the reader sees the
   * placeholders a machine translator would see. Numbers become `⟦1⟧`, `⟦2⟧`, and the same
   * placeholder is used in the bytes and character totals, because that is what leaves.
   * Defaults to false: the first thing a reader wants to see is their own text.
   */
  readonly protect?: boolean;
  /**
   * Code units of a block's text to show before the marker. Defaults to
   * {@link PREVIEW_MAX_CHARACTERS}; `Number.POSITIVE_INFINITY` disables truncation, and a
   * value below 1 is raised to 1 so a preview is never just the marker.
   */
  readonly maxPreviewCharacters?: number;
}

// --- Result shapes ----------------------------------------------------------

/** What one block would send, and how much of it the reader is being shown. */
export interface PreviewBlock {
  readonly blockId: string;
  /** 1-based page of the block. */
  readonly page: number;
  /** The sent text, truncated to the preview length and followed by the marker if cut. */
  readonly preview: string;
  /** Code units of the whole sent text, not of `preview`. */
  readonly characters: number;
  /** True when `preview` no longer matches the source text. */
  readonly redacted: boolean;
}

/** The payload as a whole. */
export interface PayloadTotals {
  /** Blocks in the preview, including blocks whose text is empty. */
  readonly blocks: number;
  /** Sum of every block's `characters`. */
  readonly characters: number;
  /** UTF-8 length of the concatenated sent text, before any request framing. */
  readonly bytes: number;
}

/** Everything a consent dialog needs before the payload is handed to a transport. */
export interface PayloadPreview {
  readonly provider: ProviderKind;
  /** Where that provider's endpoint lives, from `privacy.classifyEndpoint`. */
  readonly endpointScope: EndpointScope;
  readonly blocks: PreviewBlock[];
  readonly totals: PayloadTotals;
  /** Block ids with non-empty text, in reading order. */
  readonly wouldSend: string[];
}

/** How to replace a redacted span. */
export interface ApplyRedactionOptions {
  /**
   * Replacement written for every span. A plain string replaces all of them;
   * a per-kind table replaces the kinds it names and falls back to `redact.ts`'s
   * {@link DEFAULT_MASK} for the rest. `''` deletes the spans instead of masking them.
   */
  readonly mask?: RedactionMask;
  /** Confidence floor handed to `redact.planRedaction`; defaults to its own default. */
  readonly minConfidence?: number;
}

/** What a redaction pass removed from the visible sample. */
export interface PreviewRedaction {
  /** Blocks whose preview changed. */
  readonly blocks: number;
  /** Spans replaced, summed over every preview. */
  readonly spans: number;
  /** Characters the replaced spans covered. */
  readonly characters: number;
  /** Spans per kind; every kind is present, `0` when absent. */
  readonly counts: Record<SensitiveKind, number>;
}

/** A preview with the requested kinds removed from what it shows, plus the counts. */
export interface RedactedPayloadPreview extends PayloadPreview {
  readonly redaction: PreviewRedaction;
}

/** A model id, or a rate row the caller already holds. */
export type PricingInput = string | ModelPricing | null | undefined;

/** A cost estimate tied to one payload, in USD from published list prices. */
export interface PayloadCostEstimate {
  /** Model id the rates belong to, or the caller's row id. */
  readonly model: string;
  /** Which side of the request `characters` was priced as. */
  readonly direction: CostDirection;
  /** Characters the estimate was computed from: the payload's character total. */
  readonly characters: number;
  /** Estimated tokens on both sides together. */
  readonly tokens: number;
  /** Estimated list cost. A planning figure, not a quote, and never a bill. */
  readonly usd: number;
  /** The unit a UI must print next to `usd`. */
  readonly unit: 'USD';
}

const UTF8 = new TextEncoder();

// --- Preview ----------------------------------------------------------------

/**
 * Builds the preview for `blocks` against `settings`.
 *
 * Blocks keep the order they were passed in, which is the reading order a caller already
 * had; nothing here re-sorts the document. An empty list is not an error: it reports zero
 * totals and an empty `wouldSend`, because a consent dialog for nothing is a closed dialog.
 */
export function previewPayload(
  blocks: readonly PayloadBlockInput[],
  settings: PrivacySettings,
  options: PreviewOptions = {},
): PayloadPreview {
  if (!Array.isArray(blocks)) throw new TypeError('previewPayload needs the array of blocks that would be sent.');
  if (settings === null || typeof settings !== 'object') {
    throw new TypeError('previewPayload needs the translation settings that decide the endpoint.');
  }
  const limit = previewLimit(options?.maxPreviewCharacters);
  const protect = options?.protect === true;

  const previews: PreviewBlock[] = [];
  const wouldSend: string[] = [];
  let characters = 0;
  let bytes = 0;

  blocks.forEach((block, index) => {
    const page = pageOf(block?.page);
    const blockId = blockIdOf(block, page, index);
    const source = textOf(block);

    let sent = source;
    let redacted = false;
    if (protect) {
      const protectedText = mask(source);
      sent = protectedText.masked;
      redacted = protectedText.tokens.length > 0;
    }

    const count = sent.length;
    if (count > 0) wouldSend.push(blockId);
    characters += count;
    bytes += utf8Length(sent);
    previews.push({ blockId, page, preview: clipPreview(sent, limit), characters: count, redacted });
  });

  return {
    provider: settings.provider,
    endpointScope: classifyEndpoint(effectiveEndpoint(settings)),
    blocks: previews,
    totals: { blocks: previews.length, characters, bytes },
    wouldSend,
  };
}

// --- Redaction on the visible sample ---------------------------------------

/**
 * Removes the requested kinds of identifier from each block's preview.
 *
 * Only the shown text is planned: `detectSensitive` runs on `block.preview`, the surviving
 * matches are planned with `planRedaction`, and `redact.applyRedaction` writes the mask, so
 * the same rules and the same overlap resolution the document-level flow uses apply here.
 * Kinds are filtered before planning, which is what keeps a request for emails from hiding
 * a phone number that happens to sit inside the same merged span.
 *
 * `totals` are copied unchanged: the preview is a sample, and the full text that the totals
 * describe is not kept here. `characters` therefore still answers "how much would this
 * cost", while `redaction` answers "what did the reader just watch disappear".
 */
export function applyRedaction(
  preview: PayloadPreview,
  kinds: readonly SensitiveKind[],
  options: ApplyRedactionOptions = {},
): RedactedPayloadPreview {
  if (preview === null || typeof preview !== 'object') {
    throw new TypeError('applyRedaction needs the preview previewPayload returned.');
  }
  const requested = new Set(readKinds(kinds));
  const replacement = options?.mask ?? DEFAULT_MASK;
  const floor = readFloor(options?.minConfidence);
  const counts = emptyCounts();

  let changedBlocks = 0;
  let spans = 0;
  let characters = 0;

  const blocks = (Array.isArray(preview.blocks) ? preview.blocks : []).map(block => {
    if (requested.size === 0) return { ...block };
    const text = typeof block.preview === 'string' ? block.preview : '';
    if (text.length === 0) return { ...block };

    const matches = detectSensitive(text).filter(match => requested.has(match.kind));
    if (matches.length === 0) return { ...block };

    const plan = planRedaction(matches, { text, minConfidence: floor });
    const applied = replaceSpans(text, plan.spans, replacement);
    if (applied.replaced === 0) return { ...block };

    // `replaceSpans` refuses only spans it considers unusable, and a plan never produces
    // one, so the first `replaced` spans are exactly the ones that landed.
    for (const span of plan.spans.slice(0, applied.replaced)) {
      spans += 1;
      characters += span.end - span.start;
      counts[span.kind] += 1;
    }
    changedBlocks += 1;
    return { ...block, preview: applied.text, redacted: true };
  });

  return {
    ...preview,
    blocks,
    redaction: { blocks: changedBlocks, spans, characters, counts },
  };
}

// --- Cost -------------------------------------------------------------------

/**
 * Prices a payload with the model's published rates.
 *
 * A string is resolved through `pricing.findModelPricing` and, when it matches, priced by
 * `pricing.estimateCost` itself — there is one implementation of the arithmetic in that
 * case. A `ModelPricing` row is used as given so a caller can price a provider the snapshot
 * table does not carry; the formula is the table's, with `pricing.estimateTokens` doing the
 * character-to-token conversion.
 *
 * `direction` says what the character count represents: `input` (the default, because a
 * payload preview is about sending) counts tokens sent, `output` counts tokens produced,
 * and `both` prices a translation of that text on both sides. The returned `unit` is USD
 * from list prices quoted per million tokens, and `null` means "no published price" — never
 * a free or zero-cost claim, which matters for a local model that has no per-token price at
 * all.
 */
export function estimateCost(
  totals: PayloadTotals,
  pricing: PricingInput,
  direction: CostDirection = 'input',
): PayloadCostEstimate | null {
  const characters = characterCountOf(totals);

  if (typeof pricing === 'string') {
    const estimate = estimateFromTable({ characters, model: pricing, direction });
    if (estimate === null) return null;
    const row = findModelPricing(pricing);
    return {
      model: row?.model ?? pricing.trim(),
      direction,
      characters,
      tokens: estimate.inputTokens + estimate.outputTokens,
      usd: estimate.usd,
      unit: 'USD',
    };
  }

  const row = readPricingRow(pricing);
  if (row === undefined) return null;
  const tokens = estimateTokens(characters);
  const inputTokens = direction === 'output' ? 0 : tokens;
  const outputTokens = direction === 'input' ? 0 : tokens;
  const usd = (inputTokens * row.inputUsdPerMillion + outputTokens * row.outputUsdPerMillion) / 1_000_000;
  return { model: row.model, direction, characters, tokens: inputTokens + outputTokens, usd, unit: 'USD' };
}

// --- Helpers ----------------------------------------------------------------

/** One block's sent text: `text`, then `raw`, then nothing. */
function textOf(block: PayloadBlockInput | null | undefined): string {
  if (typeof block?.text === 'string') return block.text;
  if (typeof block?.raw === 'string') return block.raw;
  return '';
}

/** The label a block is reported under, generated only when the reader has no id. */
function blockIdOf(block: PayloadBlockInput | null | undefined, page: number, index: number): string {
  const id = block?.id;
  return typeof id === 'string' && id.length > 0 ? id : `p${page}-r${index}`;
}

/** A positive integer page, or 1 for anything else, so a preview never reports page 0. */
function pageOf(page: unknown): number {
  return typeof page === 'number' && Number.isInteger(page) && page > 0 ? page : 1;
}

/** The preview cap in code units, or `Infinity` when the caller asked for everything. */
function previewLimit(value: unknown): number {
  if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (typeof value !== 'number' || !Number.isFinite(value)) return PREVIEW_MAX_CHARACTERS;
  return Math.max(1, Math.floor(value));
}

/**
 * Cuts `text` at `limit` code units and appends the marker.
 *
 * The cut backs off one unit when it would split a surrogate pair: a dangling high
 * surrogate has no character of its own, so keeping it would put a replacement glyph in the
 * preview that the payload does not contain.
 */
function clipPreview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let cut = limit;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut) + PREVIEW_TRUNCATION_MARKER;
}

function utf8Length(text: string): number {
  return UTF8.encode(text).byteLength;
}

/** The requested kinds, deduplicated and in the canonical order `redact.ts` reports. */
function readKinds(kinds: readonly SensitiveKind[] | null | undefined): SensitiveKind[] {
  if (!Array.isArray(kinds)) return [];
  const wanted = new Set<SensitiveKind>();
  for (const kind of kinds) if (SENSITIVE_KINDS.includes(kind)) wanted.add(kind);
  return SENSITIVE_KINDS.filter(kind => wanted.has(kind));
}

/** The confidence floor, defaulting to `redact.ts`'s own when it is missing or unusable. */
function readFloor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MIN_CONFIDENCE;
  return Math.min(1, Math.max(0, value));
}

function emptyCounts(): Record<SensitiveKind, number> {
  return {
    email: 0,
    phone: 0,
    'national-id': 0,
    'bank-account': 0,
    'tax-code': 0,
    card: 0,
    address: 0,
    'person-name': 0,
  };
}

/** The payload's character total, floored to a whole non-negative count. */
function characterCountOf(totals: PayloadTotals | null | undefined): number {
  const characters = totals?.characters;
  if (typeof characters !== 'number' || !Number.isFinite(characters) || characters <= 0) return 0;
  return Math.floor(characters);
}

/** A usable rate row, or `undefined` when the caller's object cannot be priced. */
function readPricingRow(pricing: PricingInput): ModelPricing | undefined {
  if (pricing === null || pricing === undefined || typeof pricing !== 'object') return undefined;
  const { model, inputUsdPerMillion, outputUsdPerMillion } = pricing;
  if (typeof model !== 'string' || model.trim().length === 0) return undefined;
  if (!isRate(inputUsdPerMillion) || !isRate(outputUsdPerMillion)) return undefined;
  return { model, inputUsdPerMillion, outputUsdPerMillion };
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
