/**
 * Reproducible quality-evidence contract.
 *
 * A green label without a command, artifact and non-zero measurement is not evidence. This
 * small pure validator gives scripts and reports one shape for recording what ran. It does
 * not invent a result and it treats `unknown` and `fail` as non-passing states.
 */

export type EvidenceStatus = 'pass' | 'fail' | 'unknown';
export type EvidenceKind = 'policy-test' | 'golden-fixture' | 'benchmark' | 'release-check';
export type EvidenceSource = 'repository-test' | 'synthetic' | 'licensed' | 'consented';

export interface QualityEvidenceRecord {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly status: EvidenceStatus;
  readonly command: string;
  readonly artifact: string;
  readonly measured: number;
  readonly source: EvidenceSource;
  /** Required for golden fixtures, so synthetic data cannot be mistaken for production data. */
  readonly fixtureLabel?: string;
}

export class EvidenceContractError extends Error {
  readonly code = 'invalid-evidence' as const;

  constructor(message: string) {
    super(message);
    this.name = 'EvidenceContractError';
  }
}

/** Validates and returns a shallowly immutable copy of a quality-evidence record. */
export function validateEvidence(record: QualityEvidenceRecord): QualityEvidenceRecord {
  if (typeof record !== 'object' || record === null) throw new EvidenceContractError('Evidence must be an object.');
  if (!nonBlank(record.id)) throw new EvidenceContractError('Evidence needs a non-empty id.');
  if (!['policy-test', 'golden-fixture', 'benchmark', 'release-check'].includes(record.kind)) {
    throw new EvidenceContractError('Evidence kind is unknown.');
  }
  if (!['pass', 'fail', 'unknown'].includes(record.status)) {
    throw new EvidenceContractError('Evidence status is unknown.');
  }
  if (!nonBlank(record.command)) throw new EvidenceContractError('Evidence needs the exact command that ran.');
  if (!nonBlank(record.artifact)) throw new EvidenceContractError('Evidence needs an artifact or test path.');
  if (!Number.isSafeInteger(record.measured) || record.measured < 0) {
    throw new EvidenceContractError('Evidence measured count must be a non-negative safe integer.');
  }
  if (record.status === 'pass' && record.measured === 0) {
    throw new EvidenceContractError('Passing evidence needs at least one measured result.');
  }
  if (!['repository-test', 'synthetic', 'licensed', 'consented'].includes(record.source)) {
    throw new EvidenceContractError('Evidence source is unknown.');
  }
  if (record.kind === 'golden-fixture' && !nonBlank(record.fixtureLabel)) {
    throw new EvidenceContractError('Golden fixture evidence needs an explicit fixture label.');
  }
  return Object.freeze({ ...record });
}

/** True only for a validated, measured pass with a reproducible source. */
export function evidencePasses(record: QualityEvidenceRecord): boolean {
  try {
    const valid = validateEvidence(record);
    return valid.status === 'pass' && valid.measured > 0;
  } catch {
    return false;
  }
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
