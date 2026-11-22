/**
 * Fail-closed parser/resource limits.
 *
 * A parser must account for both the bytes it received and the bytes it would create while
 * expanding the input. This pure contract keeps the limits explicit and testable before a
 * parser or decompressor is invoked. It does not parse files, allocate the claimed sizes,
 * or measure wall-clock time.
 */

export interface ResourceLimits {
  readonly maxInputBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxPages: number;
  readonly maxObjects: number;
  readonly maxNesting: number;
  readonly maxTextBytes: number;
}

export interface ResourceUsage {
  readonly inputBytes: number;
  readonly decompressedBytes: number;
  readonly pageCount: number;
  readonly objectCount: number;
  readonly maxNesting: number;
  readonly textBytes: number;
}

export type ResourceName =
  | 'inputBytes'
  | 'decompressedBytes'
  | 'pageCount'
  | 'objectCount'
  | 'maxNesting'
  | 'textBytes';

export interface ResourceViolation {
  readonly resource: ResourceName;
  readonly observed: number;
  readonly limit: number;
}

export interface ResourceCheck {
  readonly ok: boolean;
  readonly violations: readonly ResourceViolation[];
}

export type ResourceLimitErrorCode = 'invalid-limits' | 'invalid-usage' | 'limit-exceeded';

export class ResourceLimitError extends Error {
  readonly code: ResourceLimitErrorCode;
  readonly violations: readonly ResourceViolation[];

  constructor(code: ResourceLimitErrorCode, message: string, violations: readonly ResourceViolation[] = []) {
    super(message);
    this.name = 'ResourceLimitError';
    this.code = code;
    this.violations = violations;
  }
}

/** Conservative defaults for local document parsing. Callers may lower them, never omit them. */
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = Object.freeze({
  maxInputBytes: 256 * 1024 * 1024,
  maxDecompressedBytes: 1024 * 1024 * 1024,
  maxPages: 10_000,
  maxObjects: 2_000_000,
  maxNesting: 128,
  maxTextBytes: 512 * 1024 * 1024,
});

const FIELDS: readonly [ResourceName, keyof ResourceLimits, keyof ResourceUsage][] = [
  ['inputBytes', 'maxInputBytes', 'inputBytes'],
  ['decompressedBytes', 'maxDecompressedBytes', 'decompressedBytes'],
  ['pageCount', 'maxPages', 'pageCount'],
  ['objectCount', 'maxObjects', 'objectCount'],
  ['maxNesting', 'maxNesting', 'maxNesting'],
  ['textBytes', 'maxTextBytes', 'textBytes'],
];

/** Checks every dimension in fixed order; invalid numbers throw instead of becoming a pass. */
export function checkResourceLimits(
  usage: ResourceUsage,
  limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
): ResourceCheck {
  validateLimits(limits);
  validateUsage(usage);
  const violations: ResourceViolation[] = [];
  for (const [resource, limitKey, usageKey] of FIELDS) {
    const observed = usage[usageKey];
    const limit = limits[limitKey];
    if (observed > limit) violations.push({ resource, observed, limit });
  }
  return { ok: violations.length === 0, violations };
}

/** Throws before a parser is allowed to consume an over-limit input. */
export function assertWithinResourceLimits(
  usage: ResourceUsage,
  limits: ResourceLimits = DEFAULT_RESOURCE_LIMITS,
): void {
  const result = checkResourceLimits(usage, limits);
  if (!result.ok) {
    throw new ResourceLimitError(
      'limit-exceeded',
      `Resource limits exceeded for ${result.violations.map(violation => violation.resource).join(', ')}.`,
      result.violations,
    );
  }
}

function validateLimits(limits: ResourceLimits): void {
  if (typeof limits !== 'object' || limits === null) {
    throw new ResourceLimitError('invalid-limits', 'Resource limits must be an object.');
  }
  for (const [, limitKey] of FIELDS) {
    const value = limits[limitKey];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ResourceLimitError('invalid-limits', `Resource limit ${limitKey} must be a non-negative safe integer.`);
    }
  }
}

function validateUsage(usage: ResourceUsage): void {
  if (typeof usage !== 'object' || usage === null) {
    throw new ResourceLimitError('invalid-usage', 'Resource usage must be an object with every measurement.');
  }
  for (const [resource, , usageKey] of FIELDS) {
    const value = usage[usageKey];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ResourceLimitError('invalid-usage', `Resource usage ${resource} must be a non-negative safe integer.`);
    }
  }
}
