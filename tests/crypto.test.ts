import { beforeAll, describe, expect, it } from 'vitest';
import {
  CryptoError,
  DEFAULT_ITERATIONS,
  ENVELOPE_VERSION,
  IV_BYTES,
  KEY_BITS,
  MIN_ITERATIONS,
  SALT_BYTES,
  TAG_BITS,
  decryptJson,
  deriveKey,
  encryptJson,
  envelopeBytes,
  newSalt,
  WrongPassphrase,
  type EncryptedEnvelope,
} from '../src/core/crypto';

/**
 * Node provides WebCrypto as `crypto.webcrypto` (and as the `crypto` global), so the
 * module is exercised against the real PBKDF2 and AES-GCM implementations, not a fake.
 */

const PASSPHRASE = 'mật-khẩu thư viện 2026';
const WRONG_PASSPHRASE = 'mật-khẩu thư viện 2025';
const SALT = newSalt();

let key: CryptoKey;
let wrongKey: CryptoKey;

beforeAll(async () => {
  key = await deriveKey(PASSPHRASE, SALT);
  wrongKey = await deriveKey(WRONG_PASSPHRASE, SALT);
});

function byteLength(base64: string): number {
  return atob(base64).length;
}

/** Flips one bit in the first byte of a base64 payload. */
function tamper(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  const first = bytes[0];
  if (first === undefined) throw new Error('cannot tamper with an empty payload');
  bytes[0] = first ^ 0x01;
  return btoa(String.fromCharCode(...Array.from(bytes)));
}

async function failure(promise: Promise<unknown>): Promise<CryptoError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CryptoError);
  return error as CryptoError;
}

describe('deriveKey', () => {
  it('returns a non-extractable AES-256-GCM key usable for both directions', () => {
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: KEY_BITS });
    expect(key.extractable).toBe(false);
    expect([...key.usages].sort()).toEqual(['decrypt', 'encrypt']);
    expect(key.type).toBe('secret');
  });

  it('refuses an iteration count below the documented minimum', async () => {
    expect(MIN_ITERATIONS).toBeGreaterThanOrEqual(210_000);
    expect(DEFAULT_ITERATIONS).toBeGreaterThanOrEqual(MIN_ITERATIONS);

    for (const iterations of [0, 1_000, 209_999, MIN_ITERATIONS - 1]) {
      const error = await failure(deriveKey(PASSPHRASE, SALT, iterations));
      expect(error.code).toBe('iterations-too-low');
      expect(error.message).toContain(String(MIN_ITERATIONS));
    }
  });

  it('refuses an iteration count that is not an integer', async () => {
    for (const iterations of [Number.NaN, Number.POSITIVE_INFINITY, DEFAULT_ITERATIONS + 0.5]) {
      const error = await failure(deriveKey(PASSPHRASE, SALT, iterations));
      expect(error.code).toBe('invalid-iterations');
    }
  });

  it('accepts the documented count and a stronger one', async () => {
    const documented = await deriveKey(PASSPHRASE, SALT, DEFAULT_ITERATIONS);
    expect(documented.algorithm).toMatchObject({ name: 'AES-GCM', length: KEY_BITS });
    // A stronger count is allowed for a caller that versions its own records.
    const stronger = await deriveKey(PASSPHRASE, SALT, MIN_ITERATIONS + 10_000);
    expect(await decryptJson(stronger, await encryptJson(stronger, { ok: true }, SALT))).toEqual({ ok: true });
  });

  it('refuses an empty or non-string passphrase and a salt that is too short or not base64', async () => {
    expect((await failure(deriveKey('', SALT))).code).toBe('invalid-passphrase');
    expect((await failure(deriveKey(undefined as unknown as string, SALT))).code).toBe(
      'invalid-passphrase',
    );
    expect((await failure(deriveKey(PASSPHRASE, new Uint8Array(SALT_BYTES - 1)))).code).toBe('invalid-salt');
    expect((await failure(deriveKey(PASSPHRASE, 'not base64!'))).code).toBe('invalid-salt');
  });

  it('derives the same key from an NFC and an NFD passphrase', async () => {
    const composed = 'mật khẩu mở khoá';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);

    const fromComposed = await deriveKey(composed, SALT);
    const fromDecomposed = await deriveKey(decomposed, SALT);
    const envelope = await encryptJson(fromComposed, { mở: 'được' }, SALT);
    expect(await decryptJson(fromDecomposed, envelope)).toEqual({ mở: 'được' });
  });

  it('derives different keys for different salts and different passphrases', async () => {
    const otherSalt = newSalt();
    expect(otherSalt).not.toBe(SALT);
    expect(byteLength(otherSalt)).toBe(SALT_BYTES);

    const envelope = await encryptJson(key, { page: 3 }, SALT);
    const wrongSaltKey = await deriveKey(PASSPHRASE, otherSalt);
    expect(await failure(decryptJson(wrongSaltKey, envelope))).toBeInstanceOf(WrongPassphrase);
    expect(await failure(decryptJson(wrongKey, envelope))).toBeInstanceOf(WrongPassphrase);
  });
});

describe('newSalt', () => {
  it('makes a fresh 16-byte base64 salt every time', () => {
    const salts = new Set([newSalt(), newSalt(), newSalt(), newSalt()]);
    expect(salts.size).toBe(4);
    for (const salt of salts) expect(byteLength(salt)).toBe(SALT_BYTES);
  });
});

describe('encryptJson and decryptJson', () => {
  it('round-trips a document record through the v1 envelope', async () => {
    const record = {
      id: 'doc-1',
      name: 'Báo cáo quốc gia.pdf',
      pages: 12,
      addedAt: 1_763_000_000_000,
      blocks: ['p1-r0', 'p1-r1'],
      nested: { done: true, tags: ['khoa học', 'giáo dục'], ratio: 0.75 },
    };

    const envelope = await encryptJson(key, record, SALT);
    expect(envelope.v).toBe(ENVELOPE_VERSION);
    expect(Object.keys(envelope).sort()).toEqual(['ciphertext', 'iv', 'salt', 'v']);
    expect(byteLength(envelope.iv)).toBe(IV_BYTES);
    expect(envelope.salt).toBe(SALT);
    expect(byteLength(envelope.ciphertext)).toBeGreaterThan(TAG_BITS / 8);

    expect(await decryptJson(key, envelope)).toEqual(record);
  });

  it('round-trips a Vietnamese string unchanged', async () => {
    const text = 'Tài liệu tiếng Việt: “Báo cáo” — dấu ba chấm… Ổn định, không lỗi 📄.';
    const envelope = await encryptJson(key, text, SALT);
    const opened = await decryptJson<string>(key, envelope);
    expect(opened).toBe(text);
    expect(opened.normalize('NFC')).toBe(text);
  });

  it('writes the envelope only, never the passphrase or the plaintext', async () => {
    const secret = 'nội dung mật';
    const envelope = await encryptJson(key, { secret }, SALT);
    const stored = JSON.stringify(envelope);

    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(PASSPHRASE);
    expect(stored).not.toMatch(/nội dung/u);
    expect(Object.keys(JSON.parse(stored) as object)).toHaveLength(4);
  });

  it('reports a wrong passphrase with the typed error', async () => {
    const envelope = await encryptJson(key, { secret: 'giá trị' }, SALT);
    const error = await failure(decryptJson(wrongKey, envelope));

    expect(error).toBeInstanceOf(WrongPassphrase);
    expect(error).toBeInstanceOf(CryptoError);
    expect(error.code).toBe('wrong-passphrase');
    expect(error.message).toMatch(/passphrase/u);
  });

  it('seals the same value differently each time but opens both to the same value', async () => {
    const value = { id: 'doc-2', text: 'Báo cáo năm 2026' };
    const first = await encryptJson(key, value, SALT);
    const second = await encryptJson(key, value, SALT);

    // The same salt and key: only the IV differs, which is the property under test.
    expect(first.salt).toBe(second.salt);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);

    expect(await decryptJson(key, first)).toEqual(value);
    expect(await decryptJson(key, second)).toEqual(value);
  });

  it('draws a fresh salt when the caller does not pass one', async () => {
    const first = await encryptJson(key, { page: 1 });
    const second = await encryptJson(key, { page: 1 });
    expect(first.salt).not.toBe(second.salt);
    expect(byteLength(first.salt)).toBe(SALT_BYTES);
    expect(first.iv).not.toBe(second.iv);
    expect(await decryptJson(key, first)).toEqual({ page: 1 });
  });

  it('re-derives the key from the salt carried in the envelope', async () => {
    const salt = newSalt();
    const derived = await deriveKey(PASSPHRASE, salt);
    const envelope = await encryptJson(derived, { id: 'doc-9', page: 4 }, salt);
    expect(envelope.salt).toBe(salt);

    // A later session holds only the passphrase and the stored record.
    const reopened = await deriveKey(PASSPHRASE, envelope.salt);
    expect(await decryptJson(reopened, envelope)).toEqual({ id: 'doc-9', page: 4 });
  });

  it('accepts a raw byte salt and records it base64', async () => {
    const salt = new Uint8Array(SALT_BYTES).fill(7);
    const envelope = await encryptJson(await deriveKey(PASSPHRASE, salt), { a: 1 }, salt);

    expect(envelope.salt).toBe(btoa(String.fromCharCode(...Array.from(salt))));
    expect(await decryptJson(await deriveKey(PASSPHRASE, envelope.salt), envelope)).toEqual({ a: 1 });
  });

  it('fails with WrongPassphrase when the ciphertext was tampered with', async () => {
    const envelope = await encryptJson(key, { approval: 'ky' }, SALT);
    const altered: EncryptedEnvelope = { ...envelope, ciphertext: tamper(envelope.ciphertext) };

    expect(altered.ciphertext).not.toBe(envelope.ciphertext);
    expect(await failure(decryptJson(key, altered))).toBeInstanceOf(WrongPassphrase);
  });

  it('fails with WrongPassphrase when only the tag was altered', async () => {
    const envelope = await encryptJson(key, { approval: 'ky' }, SALT);
    const bytes = Uint8Array.from(atob(envelope.ciphertext), char => char.charCodeAt(0));
    const last = bytes.length - 1;
    const tagByte = bytes[last];
    if (tagByte === undefined) throw new Error('missing tag');
    bytes[last] = tagByte ^ 0xff;
    const altered: EncryptedEnvelope = {
      ...envelope,
      ciphertext: btoa(String.fromCharCode(...Array.from(bytes))),
    };

    expect(await failure(decryptJson(key, altered))).toBeInstanceOf(WrongPassphrase);
  });

  it('refuses an envelope from a newer version instead of misreading it', async () => {
    const envelope = await encryptJson(key, { page: 7 }, SALT);

    for (const v of [2, 3, 99]) {
      const newer = { ...envelope, v } as unknown as EncryptedEnvelope;
      const error = await failure(decryptJson(key, newer));
      expect(error.code).toBe('unsupported-version');
      expect(error.message).toContain(`version ${v}`);
      expect(error.message).toContain('version 1 only');
    }

    const missing = await failure(decryptJson(key, { salt: envelope.salt, iv: envelope.iv }));
    expect(missing.code).toBe('unsupported-version');
    expect(missing.message).toContain('no envelope version');

    const quoted = await failure(decryptJson(key, { ...envelope, v: '1' }));
    expect(quoted.code).toBe('unsupported-version');
    expect(quoted.message).toContain('"1"');
  });

  it('refuses a malformed envelope with a typed error, not a decryption attempt', async () => {
    const envelope = await encryptJson(key, { page: 7 }, SALT);
    const cases: unknown[] = [
      null,
      'envelope',
      [],
      { ...envelope, salt: 'not base64!' },
      { ...envelope, salt: newSalt().slice(0, 16) },
      { ...envelope, iv: btoa('short') },
      { ...envelope, iv: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      { ...envelope, ciphertext: btoa('tiny') },
      { ...envelope, ciphertext: 42 },
    ];

    for (const bad of cases) {
      const error = await failure(decryptJson(key, bad));
      expect(error.code).toBe('malformed-envelope');
    }
  });

  it('refuses a value with no JSON form and a key that is not AES-GCM', async () => {
    expect((await failure(encryptJson(key, undefined, SALT))).code).toBe('not-serializable');
    expect((await failure(encryptJson(key, () => 'x', SALT))).code).toBe('not-serializable');
    expect((await failure(encryptJson(null as unknown as CryptoKey, { a: 1 }, SALT))).code).toBe('invalid-key');
    expect((await failure(decryptJson({} as CryptoKey, await encryptJson(key, { a: 1 }, SALT)))).code).toBe(
      'invalid-key',
    );
  });

  it('round-trips a payload of more than 1 MB', async () => {
    const big = {
      page: 1,
      text: 'a'.repeat(1024 * 1024),
      note: 'Tiếng Việt được giữ nguyên',
    };

    const envelope = await encryptJson(key, big, SALT);
    expect(envelopeBytes(envelope)).toBeGreaterThan(1024 * 1024);
    expect(envelopeBytes(envelope)).toBeLessThan(2 * 1024 * 1024);

    const opened = await decryptJson<typeof big>(key, envelope);
    expect(opened).toEqual(big);
  });

  it('reports the stored size of a 1 KB document', async () => {
    const document = { id: 'doc-1kb', text: 'a'.repeat(1024) };
    const size = envelopeBytes(await encryptJson(key, document, SALT));

    // Plaintext (about 1 KB) plus the 16-byte tag, then base64 and the envelope fields.
    expect(size).toBeGreaterThan(1024);
    expect(size).toBeLessThan(2048);
    console.log(`v1 envelope for a 1 KB document: ${size} bytes`);
  });
});

describe('envelopeBytes', () => {
  it('counts the compact JSON form and tolerates values it cannot serialise', async () => {
    const envelope = await encryptJson(key, { a: 1 }, SALT);
    expect(envelopeBytes(envelope)).toBe(new TextEncoder().encode(JSON.stringify(envelope)).byteLength);
    expect(envelopeBytes(undefined)).toBe(0);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(envelopeBytes(cyclic)).toBe(0);
  });
});
