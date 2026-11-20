import { describe, expect, it } from 'vitest';
import {
  PREVIEW_MAX_CHARACTERS,
  PREVIEW_TRUNCATION_MARKER,
  applyRedaction,
  estimateCost,
  previewPayload,
  type PayloadBlockInput,
  type PayloadPreview,
  type PayloadTotals,
} from '../src/core/payload-preview';
import { estimateCost as pricingEstimate, type ModelPricing } from '../src/core/pricing';
import { PLACEHOLDER_OPEN, placeholderFor } from '../src/core/protect';
import type { PrivacySettings } from '../src/core/privacy';

const LOCAL_SETTINGS: PrivacySettings = {
  provider: 'local',
  endpoint: 'http://127.0.0.1:11434/v1',
  allowCloud: false,
};

const CLOUD_SETTINGS: PrivacySettings = {
  provider: 'openai',
  endpoint: 'https://api.openai.com/v1',
  allowCloud: true,
};

function block(id: string, text: string, page = 1): PayloadBlockInput {
  return { id, page, text };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('previewPayload', () => {
  it('reports one entry per block with counts and the UTF-8 byte estimate', () => {
    const preview = previewPayload(
      [block('p1-r0', 'Hello world.'), block('p2-r0', 'Second block.', 2)],
      CLOUD_SETTINGS,
    );

    expect(preview.provider).toBe('openai');
    expect(preview.blocks).toEqual([
      { blockId: 'p1-r0', page: 1, preview: 'Hello world.', characters: 12, redacted: false },
      { blockId: 'p2-r0', page: 2, preview: 'Second block.', characters: 13, redacted: false },
    ]);
    // Neither block is long enough to be cut, so the shown text is the sent text.
    expect(preview.totals).toEqual({ blocks: 2, characters: 25, bytes: 25 });
    expect(preview.wouldSend).toEqual(['p1-r0', 'p2-r0']);
  });

  it('counts characters in code units and bytes in UTF-8', () => {
    const preview = previewPayload([block('p1-r0', '日本語'), block('p1-r1', '😀')], LOCAL_SETTINGS);

    // '日本語' is 3 code units and 9 UTF-8 bytes; '😀' is one character in 2 code units and 4 bytes.
    expect(preview.blocks.map(entry => entry.characters)).toEqual([3, 2]);
    expect(preview.totals).toEqual({ blocks: 2, characters: 5, bytes: 13 });
  });

  it('masks a locked number behind the placeholder when protection is on', () => {
    const source = 'Revenue was 1,234 units.';
    const protectedPreview = previewPayload([block('p1-r0', source)], CLOUD_SETTINGS, { protect: true });
    const entry = protectedPreview.blocks[0];

    expect(entry).toBeDefined();
    expect(entry?.preview).toBe(`Revenue was ${placeholderFor(1)} units.`);
    expect(entry?.preview).toContain(PLACEHOLDER_OPEN);
    expect(entry?.redacted).toBe(true);
    // The payload is the masked text, so its length is the masked length, not the source's.
    expect(entry?.characters).toBe(entry?.preview.length);
    expect(entry?.characters).toBeLessThan(source.length);

    const plainPreview = previewPayload([block('p1-r0', source)], CLOUD_SETTINGS);
    expect(plainPreview.blocks[0]?.preview).toBe(source);
    expect(plainPreview.blocks[0]?.redacted).toBe(false);
  });

  it('truncates a long preview at the documented length with the marker', () => {
    const source = 'a'.repeat(PREVIEW_MAX_CHARACTERS + 20);
    const entry = previewPayload([block('p1-r0', source)], LOCAL_SETTINGS).blocks[0];

    expect(entry?.preview).toBe('a'.repeat(PREVIEW_MAX_CHARACTERS) + PREVIEW_TRUNCATION_MARKER);
    expect(entry?.preview.startsWith('a'.repeat(PREVIEW_MAX_CHARACTERS))).toBe(true);
    expect(entry?.preview.endsWith(PREVIEW_TRUNCATION_MARKER)).toBe(true);
    // The count describes the payload, not the sample: truncation must not lower it.
    expect(entry?.characters).toBe(source.length);
  });

  it('never splits a surrogate pair at the cut', () => {
    const source = 'a'.repeat(PREVIEW_MAX_CHARACTERS - 1) + '😀' + 'b'.repeat(10);
    const entry = previewPayload([block('p1-r0', source)], LOCAL_SETTINGS).blocks[0];

    // A naive cut at 280 would end on the emoji's high surrogate; the preview backs off one unit.
    expect(entry?.preview).toBe('a'.repeat(PREVIEW_MAX_CHARACTERS - 1) + PREVIEW_TRUNCATION_MARKER);
    expect(entry?.characters).toBe(PREVIEW_MAX_CHARACTERS + 11);
  });

  it('honours a caller-chosen preview length, a floor of one unit, and Infinity', () => {
    const source = 'abcdefghij';
    const shown = (maxPreviewCharacters: number): string | undefined =>
      previewPayload([block('p1-r0', source)], LOCAL_SETTINGS, { maxPreviewCharacters }).blocks[0]?.preview;

    expect(shown(4)).toBe('abcd' + PREVIEW_TRUNCATION_MARKER);
    expect(shown(0)).toBe('a' + PREVIEW_TRUNCATION_MARKER);
    expect(shown(Number.POSITIVE_INFINITY)).toBe(source);
    expect(shown(source.length)).toBe(source);
  });

  it('reports a remote scope for a cloud provider and a loopback scope for a local model', () => {
    const one = [block('p1-r0', 'text')];

    expect(previewPayload(one, CLOUD_SETTINGS).endpointScope).toBe('remote');
    expect(previewPayload(one, LOCAL_SETTINGS).endpointScope).toBe('loopback');

    // Google ignores the configured endpoint and calls its own host, so the field cannot
    // decide the scope: a loopback URL must still be reported as remote.
    const google = previewPayload(one, {
      provider: 'google',
      endpoint: 'http://127.0.0.1:11434/v1',
      allowCloud: true,
    });
    expect(google.provider).toBe('google');
    expect(google.endpointScope).toBe('remote');
  });

  it('reports zero totals and nothing to send for an empty block list', () => {
    const preview = previewPayload([], CLOUD_SETTINGS);

    expect(preview.blocks).toEqual([]);
    expect(preview.wouldSend).toEqual([]);
    expect(preview.totals).toEqual({ blocks: 0, characters: 0, bytes: 0 });
    expect(preview.endpointScope).toBe('remote');
  });

  it('keeps a block with no text out of wouldSend', () => {
    const preview = previewPayload([block('p1-r0', '')], CLOUD_SETTINGS);

    expect(preview.totals).toEqual({ blocks: 1, characters: 0, bytes: 0 });
    expect(preview.wouldSend).toEqual([]);
  });

  it('reports totals as the sum of the blocks, even when a preview was cut', () => {
    const long = 'x'.repeat(PREVIEW_MAX_CHARACTERS + 40);
    const preview = previewPayload(
      [block('p1-r0', 'Tiếng Việt có dấu, 42 đơn vị.'), block('p2-r0', long), block('p3-r0', '😀 café')],
      CLOUD_SETTINGS,
      { protect: true },
    );

    // The sent text, which is what the totals describe and what the marker truncates.
    const sent = [`Tiếng Việt có dấu, ${placeholderFor(1)} đơn vị.`, long, '😀 café'];
    expect(preview.totals.blocks).toBe(preview.blocks.length);
    expect(preview.totals.characters).toBe(preview.blocks.reduce((sum, entry) => sum + entry.characters, 0));
    expect(preview.totals.characters).toBe(sent.reduce((sum, text) => sum + text.length, 0));
    expect(preview.totals.bytes).toBe(sent.reduce((sum, text) => sum + encode(text).byteLength, 0));
    expect(preview.blocks[1]?.preview).toBe('x'.repeat(PREVIEW_MAX_CHARACTERS) + PREVIEW_TRUNCATION_MARKER);
    expect(preview.blocks[1]?.characters).toBe(long.length);
  });

  it('refuses input that is not a block list or not settings', () => {
    expect(() => previewPayload(null as unknown as readonly PayloadBlockInput[], LOCAL_SETTINGS)).toThrow(TypeError);
    expect(() =>
      previewPayload([block('p1-r0', 'text')], null as unknown as PrivacySettings),
    ).toThrow(TypeError);
  });
});

describe('applyRedaction', () => {
  it('masks a requested email and phone in the preview and counts them', () => {
    const source = 'Write to alice@example.com or call 0912345678 today.';
    const before = previewPayload([block('p1-r0', source)], CLOUD_SETTINGS);
    const after = applyRedaction(before, ['email', 'phone']);

    expect(after.blocks[0]?.preview).toBe('Write to [REDACTED] or call [REDACTED] today.');
    expect(after.blocks[0]?.redacted).toBe(true);
    expect(after.redaction.blocks).toBe(1);
    expect(after.redaction.spans).toBe(2);
    // 'alice@example.com' is 17 code units and '0912345678' is 10.
    expect(after.redaction.characters).toBe(27);
    expect(after.redaction.counts.email).toBe(1);
    expect(after.redaction.counts.phone).toBe(1);
    // The sample changed; the payload estimate this module owns did not.
    expect(after.totals).toEqual(before.totals);
  });

  it('can drop a span instead of masking it', () => {
    const before = previewPayload([block('p1-r0', 'Call 0912345678 now.')], CLOUD_SETTINGS);
    const after = applyRedaction(before, ['phone'], { mask: '' });

    expect(after.blocks[0]?.preview).toBe('Call  now.');
    expect(after.redaction.spans).toBe(1);
    expect(after.redaction.characters).toBe(10);
  });

  it('leaves kinds the caller did not request in place', () => {
    const source = 'Mail alice@example.com or call 0912345678.';
    const after = applyRedaction(previewPayload([block('p1-r0', source)], CLOUD_SETTINGS), ['email']);

    expect(after.blocks[0]?.preview).toBe('Mail [REDACTED] or call 0912345678.');
    expect(after.redaction.spans).toBe(1);
    expect(after.redaction.counts.email).toBe(1);
    expect(after.redaction.counts.phone).toBe(0);
  });

  it('is a no-op when no kind is requested', () => {
    const before = previewPayload([block('p1-r0', 'Mail alice@example.com.')], CLOUD_SETTINGS);
    const after = applyRedaction(before, []);

    expect(after.blocks).toEqual(before.blocks);
    expect(after.redaction.spans).toBe(0);
    expect(after.redaction.blocks).toBe(0);
    expect(after.totals).toEqual(before.totals);
  });

  it('refuses a value that is not a preview', () => {
    expect(() => applyRedaction(null as unknown as PayloadPreview, ['email'])).toThrow(TypeError);
  });
});

describe('estimateCost', () => {
  const TOTALS: PayloadTotals = { blocks: 2, characters: 4000, bytes: 4000 };

  it('prices a published model with the same arithmetic as pricing.ts', () => {
    const published = pricingEstimate({ characters: 4000, model: 'gpt-4o-mini', direction: 'input' });
    expect(published).not.toBeNull();

    const estimate = estimateCost(TOTALS, 'gpt-4o-mini');
    expect(estimate).toEqual({
      model: 'gpt-4o-mini',
      direction: 'input',
      characters: 4000,
      tokens: 1000,
      usd: published?.usd,
      unit: 'USD',
    });
    // 1000 input tokens at $0.15 per million.
    expect(estimate?.usd).toBeCloseTo(0.00015, 12);
  });

  it('splits the estimate by direction', () => {
    expect(estimateCost(TOTALS, 'gpt-4o-mini', 'input')?.usd).toBeCloseTo(0.00015, 12);
    expect(estimateCost(TOTALS, 'gpt-4o-mini', 'output')?.usd).toBeCloseTo(0.0006, 12);
    expect(estimateCost(TOTALS, 'gpt-4o-mini', 'both')?.usd).toBeCloseTo(0.00075, 12);
    // `tokens` is both sides together: 1000 in and 1000 out.
    expect(estimateCost(TOTALS, 'gpt-4o-mini', 'both')?.tokens).toBe(2000);
    expect(estimateCost(TOTALS, 'gpt-4o-mini', 'input')?.tokens).toBe(1000);
  });

  it('returns null when there is no published price to use', () => {
    expect(estimateCost(TOTALS, 'qwen3:4b')).toBeNull();
    expect(estimateCost(TOTALS, 'not-a-model')).toBeNull();
    expect(estimateCost(TOTALS, null)).toBeNull();
    expect(estimateCost(TOTALS, undefined)).toBeNull();
  });

  it('honours a caller-supplied rate row without inventing a table entry', () => {
    const row: ModelPricing = { model: 'house-model', inputUsdPerMillion: 2.5, outputUsdPerMillion: 10 };
    const estimate = estimateCost(TOTALS, row);
    const reference = pricingEstimate({ characters: 4000, model: 'gpt-4o', direction: 'input' });

    // Same rates as gpt-4o's published row, so the same arithmetic has to agree.
    expect(estimate?.model).toBe('house-model');
    expect(estimate?.tokens).toBe(1000);
    expect(estimate?.usd).toBe(reference?.usd);
    expect(estimateCost(TOTALS, { ...row, inputUsdPerMillion: -1 })).toBeNull();
    expect(estimateCost(TOTALS, { ...row, model: '' })).toBeNull();
  });

  it('costs nothing for an empty payload and prices characters, not bytes', () => {
    expect(estimateCost({ blocks: 0, characters: 0, bytes: 0 }, 'gpt-4o-mini')).toEqual({
      model: 'gpt-4o-mini',
      direction: 'input',
      characters: 0,
      tokens: 0,
      usd: 0,
      unit: 'USD',
    });
    // Four characters are one token whatever the byte count is; a NaN total cannot throw.
    expect(estimateCost({ blocks: 1, characters: 4, bytes: 400 }, 'gpt-4o-mini')?.tokens).toBe(1);
    expect(estimateCost({ blocks: 1, characters: Number.NaN, bytes: 0 }, 'gpt-4o-mini')?.characters).toBe(0);
  });
});
