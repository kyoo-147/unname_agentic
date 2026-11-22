import { describe, expect, it } from 'vitest';
import {
  confirmPurge,
  planPurge,
  RetentionError,
} from '../viewer/src/core/capabilities';
import { AuditLog } from '../viewer/src/core/audit';
import {
  PrivacyError,
  assertCanSendAndRecord,
  privacyPolicy,
  recordConsentDecision,
  assertCanSend,
} from '../viewer/src/core/privacy';
import {
  CryptoError,
  DEFAULT_ITERATIONS,
  MAX_ITERATIONS,
  MAX_PLAINTEXT_BYTES,
  deriveKey,
  encryptJson,
  newSalt,
} from '../viewer/src/core/crypto';

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

  it('enforces and records both denied and allowed provider routes', () => {
    const log = new AuditLog({ now: () => '2026-11-21T00:00:00.000Z' });
    expect(() => assertCanSendAndRecord({
      log,
      documentId: 'doc-denied',
      provider: 'openai',
      mode: 'ask',
      endpoint: 'https://api.example.test/v1',
      allowCloud: false,
    })).toThrowError(PrivacyError);
    assertCanSendAndRecord({
      log,
      documentId: 'doc-allowed',
      provider: 'local',
      mode: 'offline',
      endpoint: 'http://127.0.0.1:11434/v1',
      allowCloud: false,
    });

    expect(log.entries().map(event => event.details.allowed)).toEqual([false, true]);
    expect(log.persist()).not.toContain('api.example.test');
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
