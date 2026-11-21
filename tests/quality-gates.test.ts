import { describe, expect, it } from 'vitest';
import {
  confirmPurge,
  planPurge,
  RetentionError,
} from '../src/core/capabilities';
import { AuditLog } from '../src/core/audit';
import {
  PrivacyError,
  privacyPolicy,
  recordConsentDecision,
  assertCanSend,
} from '../src/core/privacy';
import {
  CryptoError,
  DEFAULT_ITERATIONS,
  MAX_ITERATIONS,
  MAX_PLAINTEXT_BYTES,
  deriveKey,
  encryptJson,
  newSalt,
} from '../src/core/crypto';

describe('retention and purge gates', () => {
  const now = '2026-11-21T00:00:00.000Z';

  it('plans only expired records and requires explicit confirmation', () => {
    const plan = planPurge([
      { documentId: 'doc-old', lastAccessedAt: '2026-10-01T00:00:00.000Z' },
      { documentId: 'doc-new', lastAccessedAt: '2026-11-20T00:00:00.000Z' },
    ], now);
    expect(plan.candidates).toEqual(['doc-old']);
    expect(() => confirmPurge(plan, false)).toThrowError(RetentionError);
    expect(confirmPurge(plan, true)).toEqual(['doc-old']);
  });

  it('rejects invalid retention inputs instead of guessing', () => {
    expect(() => planPurge([], now, { maxAgeDays: 3651, requireConfirmation: true })).toThrowError(RetentionError);
    expect(() => planPurge([{ documentId: 'doc', lastAccessedAt: 'not-a-date' }], now)).toThrowError(RetentionError);
  });
});

describe('consent and route audit', () => {
  it('records scope and consent without endpoint or payload text', () => {
    const log = new AuditLog({ now: () => '2026-11-21T00:00:00.000Z' });
    recordConsentDecision(log, {
      documentId: 'doc-a',
      provider: 'google',
      mode: 'cloud',
      endpoint: 'ignored',
      allowCloud: true,
      allowed: true,
    });
    const persisted = log.persist();
    expect(persisted).toContain('remote');
    expect(persisted).not.toContain('translation.googleapis.com');
    expect(persisted).not.toContain('ignored');
  });

  it('refuses malformed endpoints before transport', () => {
    expect(() => assertCanSend(privacyPolicy('cloud', 'https://example.test'), {
      provider: 'local', endpoint: 'not a url', allowCloud: true,
    })).toThrowError(PrivacyError);
  });
});

describe('crypto resource limits', () => {
  it('keeps PBKDF2 work bounded', async () => {
    await expect(deriveKey('passphrase', newSalt(), MAX_ITERATIONS + 1)).rejects.toMatchObject({
      code: 'iterations-too-high',
    });
    await expect(deriveKey('passphrase', newSalt(), DEFAULT_ITERATIONS)).resolves.toBeInstanceOf(CryptoKey);
  });

  it('refuses oversized JSON before encryption', async () => {
    const key = await deriveKey('passphrase', newSalt());
    await expect(encryptJson(key, 'x'.repeat(MAX_PLAINTEXT_BYTES + 1))).rejects.toMatchObject({
      code: 'payload-too-large',
    } satisfies Partial<CryptoError>);
  });
});
