/**
 * Rough token-cost estimates for named OpenAI-compatible chat models.
 *
 * Nothing here makes a network call and nothing here is a quote: the table
 * below is a snapshot of published list prices in USD per million tokens, and
 * the token count is a character-based approximation. Providers change prices,
 * apply cached-input and batch discounts, and add local taxes, so treat the
 * result as a planning figure. Show the provider's own dashboard for a bill.
 *
 * An unknown model returns `null`, never a number. That includes local models
 * running on your own machine: there is no per-token price to invent for them.
 */

export type CostDirection = 'input' | 'output' | 'both';

export interface ModelPricing {
  /** Canonical model id used by the provider's API. */
  model: string;
  /** USD per million input tokens. */
  inputUsdPerMillion: number;
  /** USD per million output tokens. */
  outputUsdPerMillion: number;
}

export const MODEL_PRICING: readonly ModelPricing[] = [
  { model: 'gpt-4o-mini', inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 },
  { model: 'gpt-4o', inputUsdPerMillion: 2.5, outputUsdPerMillion: 10 },
  { model: 'gpt-4.1-mini', inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 },
  { model: 'gpt-4.1', inputUsdPerMillion: 2, outputUsdPerMillion: 8 },
];

const PRICING_BY_MODEL = new Map(MODEL_PRICING.map(entry => [entry.model.toLowerCase(), entry]));

/**
 * OpenAI's documented rule of thumb: roughly four characters per token for
 * English prose. It is deliberately rough: Vietnamese accented text and CJK
 * run closer to two characters per token, so the estimate can be off by two or
 * three times. It is a planning figure, not a measurement.
 */
export const CHARACTERS_PER_TOKEN = 4;

export interface CostEstimateInput {
  /** Number of source characters, for example `countCharacters(text)`. */
  characters: number;
  /** Model id, matched case-insensitively against {@link MODEL_PRICING}. */
  model: string;
  /** Which side of the request the characters describe. */
  direction: CostDirection;
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export function estimateTokens(characters: number): number {
  if (!Number.isFinite(characters) || characters < 0) throw new RangeError('characters must be a finite non-negative number.');
  return Math.ceil(characters / CHARACTERS_PER_TOKEN);
}

export function findModelPricing(model: string): ModelPricing | undefined {
  return PRICING_BY_MODEL.get(model.trim().toLowerCase());
}

/**
 * Estimates one request's tokens and cost.
 *
 * `direction` says what the character count represents:
 * - `input`: text sent to the model (prompt + source text);
 * - `output`: text produced by the model (the translation);
 * - `both`: a translation of that text, so the same count is used on both
 *   sides. Target languages usually run longer or shorter than the source, so
 *   this is an approximation, not a measurement.
 *
 * Returns `null` when the model has no published price in the table.
 */
export function estimateCost({ characters, model, direction }: CostEstimateInput): CostEstimate | null {
  const pricing = findModelPricing(model);
  if (!pricing) return null;
  const tokens = estimateTokens(characters);
  const inputTokens = direction === 'output' ? 0 : tokens;
  const outputTokens = direction === 'input' ? 0 : tokens;
  const usd = (inputTokens * pricing.inputUsdPerMillion + outputTokens * pricing.outputUsdPerMillion) / 1_000_000;
  return { inputTokens, outputTokens, usd };
}

/**
 * Formats an estimate for display. `null` means "no published price", which is
 * shown as an em dash rather than as a free or zero-cost claim.
 */
export function formatUsd(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd) || usd < 0) return '—';
  if (usd === 0) return '$0.00';
  if (usd < 0.000001) return '<$0.000001';
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(2)}`;
}
