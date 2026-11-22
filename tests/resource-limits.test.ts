import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESOURCE_LIMITS,
  ResourceLimitError,
  assertWithinResourceLimits,
  checkResourceLimits,
  type ResourceUsage,
} from '../src/core/resource-limits';

const SAFE: ResourceUsage = {
  inputBytes: 1024,
  decompressedBytes: 4096,
  pageCount: 2,
  objectCount: 20,
  maxNesting: 3,
  textBytes: 2048,
};

describe('parser resource limits', () => {
  it('passes a bounded usage record and returns no mutable violations', () => {
    const result = checkResourceLimits(SAFE);
    expect(result).toEqual({ ok: true, violations: [] });
    expect(() => assertWithinResourceLimits(SAFE)).not.toThrow();
  });

  it('fails closed when a decompressed payload exceeds its limit', () => {
    const result = checkResourceLimits({
      ...SAFE,
      decompressedBytes: DEFAULT_RESOURCE_LIMITS.maxDecompressedBytes + 1,
    });

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{
      resource: 'decompressedBytes',
      observed: DEFAULT_RESOURCE_LIMITS.maxDecompressedBytes + 1,
      limit: DEFAULT_RESOURCE_LIMITS.maxDecompressedBytes,
    }]);
    expect(() => assertWithinResourceLimits({
      ...SAFE,
      decompressedBytes: DEFAULT_RESOURCE_LIMITS.maxDecompressedBytes + 1,
    })).toThrowError(ResourceLimitError);
  });

  it('rejects malformed usage instead of treating missing measurements as safe', () => {
    expect(() => checkResourceLimits({ ...SAFE, pageCount: Number.NaN })).toThrowError(ResourceLimitError);
    expect(() => checkResourceLimits({ ...SAFE, inputBytes: -1 })).toThrowError(ResourceLimitError);
  });

  it('reports every independent exceeded dimension deterministically', () => {
    const result = checkResourceLimits({
      inputBytes: DEFAULT_RESOURCE_LIMITS.maxInputBytes + 1,
      decompressedBytes: DEFAULT_RESOURCE_LIMITS.maxDecompressedBytes + 1,
      pageCount: DEFAULT_RESOURCE_LIMITS.maxPages + 1,
      objectCount: DEFAULT_RESOURCE_LIMITS.maxObjects + 1,
      maxNesting: DEFAULT_RESOURCE_LIMITS.maxNesting + 1,
      textBytes: DEFAULT_RESOURCE_LIMITS.maxTextBytes + 1,
    });

    expect(result.violations.map(violation => violation.resource)).toEqual([
      'inputBytes',
      'decompressedBytes',
      'pageCount',
      'objectCount',
      'maxNesting',
      'textBytes',
    ]);
  });
});
