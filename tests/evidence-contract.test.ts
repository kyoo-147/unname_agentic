import { describe, expect, it } from 'vitest';
import {
  EvidenceContractError,
  evidencePasses,
  validateEvidence,
  type QualityEvidenceRecord,
} from '../src/core/evidence-contract';

const PASSING: QualityEvidenceRecord = {
  id: 'privacy-offline-001',
  kind: 'policy-test',
  status: 'pass',
  command: 'pnpm vitest run tests/offline-mode.test.ts',
  artifact: 'tests/offline-mode.test.ts',
  measured: 14,
  source: 'repository-test',
};

describe('quality evidence contract', () => {
  it('accepts a measured, reproducible pass record', () => {
    expect(validateEvidence(PASSING)).toEqual(PASSING);
    expect(evidencePasses(PASSING)).toBe(true);
  });

  it('rejects a pass without a command, artifact or measurement', () => {
    for (const patch of [
      { command: '' },
      { artifact: '' },
      { measured: 0 },
    ]) {
      expect(() => validateEvidence({ ...PASSING, ...patch })).toThrowError(EvidenceContractError);
    }
  });

  it('does not turn unknown or failed evidence into a pass', () => {
    expect(evidencePasses({ ...PASSING, status: 'unknown' })).toBe(false);
    expect(evidencePasses({ ...PASSING, status: 'fail' })).toBe(false);
  });

  it('requires synthetic fixtures to be explicitly labelled', () => {
    expect(() => validateEvidence({
      ...PASSING,
      id: 'ocr-fixture-001',
      kind: 'golden-fixture',
      source: 'synthetic',
      fixtureLabel: '',
    })).toThrowError(EvidenceContractError);

    expect(validateEvidence({
      ...PASSING,
      id: 'ocr-fixture-001',
      kind: 'golden-fixture',
      source: 'synthetic',
      fixtureLabel: 'synthetic English smoke fixture',
    }).fixtureLabel).toBe('synthetic English smoke fixture');
  });
});
