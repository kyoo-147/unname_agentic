/**
 * Passphrase encryption for the library at rest (backlog item M04).
 *
 * The library keeps PDF bytes and their summary rows in the browser; this module is
 * how those records are hidden from anyone who has the profile folder but not the
 * passphrase. It uses only the platform's WebCrypto — PBKDF2-HMAC-SHA256 to stretch
 * the passphrase into an AES-256-GCM key, and AES-GCM to seal a JSON value — so the
 * module runs unchanged in the app, in the extension, and under Node's
 * `crypto.webcrypto` in tests, with no dependency and no custom cryptography.
 *
 * Envelope v1, as stored (all byte fields are standard base64 with padding):
 *
 * ```json
 * {
 *   "v": 1,
 *   "salt": "<16 bytes: the salt the key was derived from>",
 *   "iv": "<12 bytes: fresh for every call>",
 *   "ciphertext": "<AES-GCM output, 16-byte tag included>"
 * }
 * ```
 *
 * Rules:
 * - **The passphrase is never stored.** {@link deriveKey} only stretches it in memory
 *   and returns a non-extractable key; the envelope holds no passphrase and no
 *   plaintext. The passphrase is normalised to Unicode NFC first, so the same
 *   characters typed on macOS (which may compose them differently) unlock the same
 *   library everywhere.
 * - **The salt travels with the envelope.** A salt is 16 random bytes from
 *   {@link newSalt} and is never derived from the passphrase, a document id, or a
 *   count. {@link encryptJson} writes the salt it is given, so pass the one the key
 *   was derived from; a later session holding only the passphrase then calls
 *   `deriveKey(passphrase, envelope.salt)` and lands on the same key.
 * - **The IV is never reused.** {@link encryptJson} draws a fresh 12-byte IV from the
 *   platform CSPRNG on every call and accepts no IV argument, so a stored IV cannot
 *   be fed back in. Reusing an IV under one AES-GCM key leaks the XOR of the two
 *   plaintexts and breaks the tag.
 * - **A version that is not 1 is refused before any field is interpreted.**
 *   {@link decryptJson} checks `v` first and reports the version it found, so a v2
 *   record written by a newer build is never misread as v1.
 * - **A failed tag is reported as {@link WrongPassphrase}.** AES-GCM authenticates the
 *   ciphertext, and a wrong key and an altered ciphertext are indistinguishable by
 *   design: both fail the same tag check. Callers get the same typed error for both;
 *   do not branch on its message.
 *
 * What it does not do: it does not protect a record while the app is unlocked, it
 * cannot make a weak passphrase strong, and it does not defend against code running
 * in the same origin. Those are outside the storage format.
 *
 * Iterations: v1 is defined with exactly {@link DEFAULT_ITERATIONS} stretches, the
 * OWASP 2023 figure for PBKDF2-HMAC-SHA256. The envelope has no field for the count,
 * so a v1 reader always uses the constant; a stronger count belongs to a future
 * envelope version (or to a caller that versions its own records). {@link deriveKey}
 * refuses anything below the constant, so a stored or hand-edited setting cannot
 * silently weaken a record, and accepts a higher count for exactly that
 * caller-versioned case.
 */

/** The only envelope layout this build reads and writes. */
export const ENVELOPE_VERSION = 1;

/**
 * PBKDF2-HMAC-SHA256 stretches used by envelope v1. Cost is linear in this number:
 * 600 000 is roughly 0.1 s on a desktop Node process and a few hundred milliseconds
 * in a browser, once per unlock.
 */
export const DEFAULT_ITERATIONS = 600_000;

/** The floor {@link deriveKey} accepts. It is the v1 constant, so v1 can never be weakened. */
export const MIN_ITERATIONS = DEFAULT_ITERATIONS;
/** Upper bound prevents a corrupted setting from turning unlock into an unbounded DoS. */
export const MAX_ITERATIONS = 2_000_000;

/** Maximum UTF-8 JSON payload accepted by the browser storage envelope. */
export const MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;

/** Maximum sealed payload, including the 16-byte AES-GCM authentication tag. */
export const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + 16;

/** Bytes of salt {@link newSalt} produces, and the minimum {@link deriveKey} accepts. */
export const SALT_BYTES = 16;

/** Salt bytes accepted from a caller that manages its own; longer than 16 is allowed. */
const MAX_SALT_BYTES = 64;

/** Bytes of AES-GCM IV. 96 bits is the GCM-recommended size and the only one v1 accepts. */
export const IV_BYTES = 12;

/** AES-GCM authentication tag length in bits. */
export const TAG_BITS = 128;

/** AES key length in bits. */
export const KEY_BITS = 256;

/** Stable identifiers for everything that can go wrong here. Safe to switch on. */
export type CryptoErrorCode =
  | 'unavailable'
  | 'invalid-passphrase'
  | 'invalid-salt'
  | 'invalid-iterations'
  | 'iterations-too-low'
  | 'iterations-too-high'
  | 'payload-too-large'
  | 'invalid-key'
  | 'not-serializable'
  | 'encryption-failed'
  | 'unsupported-version'
  | 'malformed-envelope'
  | 'wrong-passphrase'
  | 'unreadable-payload';

/** A failure in this module. {@link WrongPassphrase} is the one callers usually catch. */
export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CryptoError';
    this.code = code;
  }
}

/**
 * The key does not open this record, or the record was altered. The two cases cannot be
 * told apart under AES-GCM, which is the point: reporting a distinct error for tampering
 * would tell an attacker whether their guess at the key was right.
 */
export class WrongPassphrase extends CryptoError {
  constructor(options: { cause?: unknown } = {}) {
    super(
      'wrong-passphrase',
      'The passphrase does not unlock this record, or the record was altered.',
      options,
    );
    this.name = 'WrongPassphrase';
  }
}

/** A salt as a caller holds it: base64 text, as the envelope stores it, or raw bytes. */
export type SaltInput = string | Uint8Array;

/** One encrypted JSON value, ready for `JSON.stringify`. Every field is base64. */
export interface EncryptedEnvelope {
  v: typeof ENVELOPE_VERSION;
  /** The derivation salt of the key, base64; 16 bytes from {@link newSalt} by default. */
  salt: string;
  /** The AES-GCM IV, base64; a fresh one on every {@link encryptJson} call. */
  iv: string;
  /** The sealed JSON, base64, with the 16-byte GCM tag appended. */
  ciphertext: string;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** `String.fromCharCode` takes a rest argument; large inputs are fed in pieces. */
const BASE64_CHUNK = 0x8000;

const UTF8 = new TextEncoder();
const UTF8_TEXT = new TextDecoder();

/**
 * A fresh 16-byte salt, base64, for {@link deriveKey}.
 *
 * Random per call from the platform CSPRNG: two installations of the same app with the
 * same passphrase must not share a derived key, and the salt is what prevents that.
 * Store the result in the envelope, never the passphrase.
 */
export function newSalt(): string {
  return encodeBase64(randomBytes(SALT_BYTES));
}

/**
 * Stretches a passphrase into a non-extractable AES-256-GCM key.
 *
 * PBKDF2-HMAC-SHA256 with the given salt and iteration count. The key can encrypt and
 * decrypt and cannot be exported, so the derived material never leaves the process.
 * `iterations` defaults to {@link DEFAULT_ITERATIONS}; anything below it is refused,
 * and anything above it must be versioned by the caller because v1 does not record the
 * count.
 */
export async function deriveKey(
  passphrase: string,
  salt: SaltInput,
  iterations: number = DEFAULT_ITERATIONS,
): Promise<CryptoKey> {
  const secret = UTF8.encode(normalizePassphrase(passphrase));
  const pepper = saltBytes(salt);
  const rounds = readIterations(iterations);
  const subtle = requireSubtle();

  let material: CryptoKey;
  try {
    material = await subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveKey']);
  } catch (error) {
    throw new CryptoError('unavailable', 'PBKDF2 could not import the passphrase.', { cause: error });
  }

  try {
    return await subtle.deriveKey(
      { name: 'PBKDF2', salt: pepper, iterations: rounds, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: KEY_BITS },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch (error) {
    throw new CryptoError('unavailable', 'PBKDF2 key derivation failed.', { cause: error });
  }
}

/**
 * Seals a JSON value under an AES-GCM key.
 *
 * A fresh IV is drawn on every call, so encrypting the same value twice with the same
 * key produces two different ciphertexts that both decrypt back to it. `salt` is the
 * salt the key was derived from and is written into the envelope: pass it for every
 * record that must be openable later from the passphrase alone, which is the library
 * path. Called without it the record is still well formed, but the salt it carries is
 * a fresh one that describes no derivation, so only a caller keeping its own salt
 * beside the record should omit it.
 *
 * The value must have a JSON form; `undefined`, a function, a symbol, a cycle, or a
 * `BigInt` is refused rather than silently sealed as an empty record.
 */
export async function encryptJson(
  key: CryptoKey,
  value: unknown,
  salt?: SaltInput,
): Promise<EncryptedEnvelope> {
  const encryptionKey = requireKey(key, 'encrypt');
  const recordedSalt = salt === undefined ? newSalt() : encodeBase64(saltBytes(salt));
  const plaintext = UTF8.encode(serialize(value));
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new CryptoError(
      'payload-too-large',
      `The JSON payload is ${plaintext.byteLength} bytes; at most ${MAX_PLAINTEXT_BYTES} are accepted.`,
    );
  }
  const iv = randomBytes(IV_BYTES);

  let sealed: ArrayBuffer;
  try {
    sealed = await requireSubtle().encrypt(
      { name: 'AES-GCM', iv, tagLength: TAG_BITS },
      encryptionKey,
      plaintext,
    );
  } catch (error) {
    throw new CryptoError('encryption-failed', 'AES-GCM encryption failed.', { cause: error });
  }

  return {
    v: ENVELOPE_VERSION,
    salt: recordedSalt,
    iv: encodeBase64(iv),
    ciphertext: encodeBase64(new Uint8Array(sealed)),
  };
}

/**
 * Opens an envelope with the key it was sealed under.
 *
 * The envelope is `unknown` on purpose: it normally comes back from IndexedDB as an
 * unvalidated value, so the version and every field are checked here before use. A
 * wrong key, a tampered ciphertext, or a swapped tag all fail the AES-GCM check and are
 * reported as {@link WrongPassphrase}. The salt is validated but not used — the key is
 * already in hand; a holder of the passphrase re-derives with
 * `deriveKey(passphrase, envelope.salt)` first.
 */
export async function decryptJson<T = unknown>(key: CryptoKey, envelope: unknown): Promise<T> {
  const decryptionKey = requireKey(key, 'decrypt');
  const { iv, ciphertext } = readEnvelope(envelope);

  let opened: ArrayBuffer;
  try {
    opened = await requireSubtle().decrypt(
      { name: 'AES-GCM', iv, tagLength: TAG_BITS },
      decryptionKey,
      ciphertext,
    );
  } catch (error) {
    throw new WrongPassphrase({ cause: error });
  }

  const text = UTF8_TEXT.decode(opened);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new CryptoError('unreadable-payload', 'The decrypted record is not JSON.', {
      cause: error,
    });
  }
}

/**
 * Bytes the envelope occupies as compact JSON, for size reporting in the UI.
 *
 * This is the number a storage row shows: base64 expansion (4 characters per 3 bytes),
 * field names, and the 16-byte GCM tag and 12-byte IV are all included, so a record is
 * about 1.4 times its plaintext. A value that cannot be serialised reports 0 rather
 * than throwing — a size label is not worth an error path.
 */
export function envelopeBytes(envelope: unknown): number {
  let json: string | undefined;
  try {
    json = JSON.stringify(envelope);
  } catch {
    return 0;
  }
  return json === undefined ? 0 : UTF8.encode(json).byteLength;
}

// --- Passphrase and key handling -------------------------------------------

/**
 * NFC, so the same characters typed through different input methods derive one key.
 * Trimming is deliberately not done: a leading or trailing space is part of what the
 * user typed, and silently ignoring it would make some passphrases weaker than they look.
 */
function normalizePassphrase(passphrase: unknown): string {
  if (typeof passphrase !== 'string') {
    throw new CryptoError('invalid-passphrase', 'The passphrase must be a string.');
  }
  const normalized = passphrase.normalize('NFC');
  if (normalized.length === 0) {
    throw new CryptoError('invalid-passphrase', 'The passphrase must not be empty.');
  }
  return normalized;
}

/**
 * The iteration count, refused before any stretching happens when it is below the v1
 * floor. Non-integers are refused separately: `600000.5` rounds in some engines and
 * truncates in others, and two readers must not disagree about a record.
 */
function readIterations(iterations: unknown): number {
  if (typeof iterations !== 'number' || !Number.isInteger(iterations)) {
    throw new CryptoError('invalid-iterations', 'The iteration count must be an integer.');
  }
  if (iterations < MIN_ITERATIONS) {
    throw new CryptoError(
      'iterations-too-low',
      `The iteration count is ${iterations}; envelope v1 requires at least ${MIN_ITERATIONS}.`,
    );
  }
  if (iterations > MAX_ITERATIONS) {
    throw new CryptoError(
      'iterations-too-high',
      `The iteration count is ${iterations}; at most ${MAX_ITERATIONS} are accepted.`,
    );
  }
  return iterations;
}

/** Salt bytes from either form, with the length rules v1 depends on. */
function saltBytes(salt: SaltInput): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer> | null;
  if (typeof salt === 'string') {
    bytes = decodeBase64(salt);
    if (bytes === null) {
      throw new CryptoError('invalid-salt', 'The salt is not base64.');
    }
  } else {
    bytes = copyBytes(salt);
    if (bytes === null) {
      throw new CryptoError('invalid-salt', 'The salt must be base64 text or a Uint8Array.');
    }
  }
  if (bytes.length < SALT_BYTES) {
    throw new CryptoError(
      'invalid-salt',
      `The salt is ${bytes.length} bytes; at least ${SALT_BYTES} are required. newSalt() makes one.`,
    );
  }
  if (bytes.length > MAX_SALT_BYTES) {
    throw new CryptoError(
      'invalid-salt',
      `The salt is ${bytes.length} bytes; at most ${MAX_SALT_BYTES} are accepted.`,
    );
  }
  return bytes;
}

/** The AES-GCM key this module makes, checked by algorithm and usage before use. */
function requireKey(key: unknown, usage: 'encrypt' | 'decrypt'): CryptoKey {
  if (typeof key !== 'object' || key === null) {
    throw new CryptoError('invalid-key', 'An AES-GCM CryptoKey is required; derive one with deriveKey().');
  }
  const candidate = key as Partial<CryptoKey>;
  if (candidate.algorithm?.name !== 'AES-GCM') {
    throw new CryptoError('invalid-key', 'The key is not an AES-GCM key; derive one with deriveKey().');
  }
  if (!Array.isArray(candidate.usages) || !candidate.usages.includes(usage)) {
    throw new CryptoError('invalid-key', `The key cannot be used to ${usage}; derive it with both usages.`);
  }
  return key as CryptoKey;
}

/** WebCrypto, or a typed refusal where it is missing (an insecure browser context). */
function requireSubtle(): SubtleCrypto {
  const subtle = runtimeCrypto().subtle;
  if (!subtle || typeof subtle.importKey !== 'function' || typeof subtle.encrypt !== 'function') {
    throw new CryptoError('unavailable', 'WebCrypto is not available in this environment.');
  }
  return subtle;
}

function runtimeCrypto(): Crypto {
  const runtime = (globalThis as { crypto?: Crypto }).crypto;
  if (!runtime || typeof runtime.getRandomValues !== 'function') {
    throw new CryptoError('unavailable', 'WebCrypto is not available in this environment.');
  }
  return runtime;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  runtimeCrypto().getRandomValues(bytes);
  return bytes;
}

// --- Envelope reading ------------------------------------------------------

/**
 * Validates a v1 envelope and returns the two fields decryption needs.
 *
 * Order matters: the version is read first, so a newer record is refused with a
 * message about the version instead of a complaint about a field it never had.
 */
function readEnvelope(envelope: unknown): {
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
} {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new CryptoError('malformed-envelope', 'The encrypted record is not an envelope object.');
  }
  const record = envelope as Partial<Record<keyof EncryptedEnvelope, unknown>>;
  const allowed = new Set(['v', 'salt', 'iv', 'ciphertext']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new CryptoError('malformed-envelope', `The envelope contains an unknown field "${key}".`);
    }
  }
  if (record.v !== ENVELOPE_VERSION) {
    throw new CryptoError('unsupported-version', versionRefusal(record.v));
  }

  const salt = requireBase64(record.salt, 'salt');
  if (salt.length < SALT_BYTES || salt.length > MAX_SALT_BYTES) {
    throw new CryptoError(
      'malformed-envelope',
      `The envelope salt is ${salt.length} bytes; v1 stores ${SALT_BYTES} to ${MAX_SALT_BYTES}.`,
    );
  }

  const iv = requireBase64(record.iv, 'iv');
  if (iv.length !== IV_BYTES) {
    throw new CryptoError(
      'malformed-envelope',
      `The envelope IV is ${iv.length} bytes; v1 uses ${IV_BYTES}.`,
    );
  }

  const ciphertext = requireBase64(record.ciphertext, 'ciphertext');
  const tagBytes = TAG_BITS / 8;
  if (ciphertext.length < tagBytes) {
    throw new CryptoError(
      'malformed-envelope',
      `The envelope ciphertext is ${ciphertext.length} bytes; it cannot hold the ${tagBytes}-byte tag.`,
    );
  }
  if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    throw new CryptoError(
      'payload-too-large',
      `The encrypted payload is ${ciphertext.length} bytes; at most ${MAX_CIPHERTEXT_BYTES} are accepted.`,
    );
  }
  return { iv, ciphertext };
}

function requireBase64(value: unknown, field: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string') {
    throw new CryptoError('malformed-envelope', `The envelope "${field}" must be base64 text.`);
  }
  const bytes = decodeBase64(value);
  if (bytes === null) {
    throw new CryptoError('malformed-envelope', `The envelope "${field}" is not base64.`);
  }
  return bytes;
}

/**
 * The message for a record this build cannot read. A numeric version above v1 is a
 * record from a newer build and says so; anything else is reported as it was found.
 */
function versionRefusal(version: unknown): string {
  if (version === undefined) {
    return 'The encrypted record has no envelope version; this build reads version 1 only.';
  }
  if (typeof version === 'number' && version > ENVELOPE_VERSION) {
    return (
      `The encrypted record is envelope version ${version}, written by a newer build; ` +
      'this build reads version 1 only. Open it with the build that wrote it.'
    );
  }
  return `Envelope version ${label(version)} is not supported; this build reads version 1 only.`;
}

function label(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  return typeof value;
}

// --- JSON and bytes --------------------------------------------------------

function serialize(value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new CryptoError('not-serializable', 'The value cannot be serialised as JSON.', { cause: error });
  }
  if (json === undefined) {
    throw new CryptoError(
      'not-serializable',
      'The value has no JSON form (undefined, a function, or a symbol).',
    );
  }
  return json;
}

/** Base64 with padding; chunks keep `fromCharCode` under its argument limit. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(offset, offset + BASE64_CHUNK)));
  }
  return btoa(binary);
}

/** Strict base64: the whole string must be the alphabet with correct padding, or null. */
function decodeBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length === 0 || text.length % 4 !== 0 || !BASE64.test(text)) return null;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** A private copy in an `ArrayBuffer`-backed view, whatever the caller's buffer was. */
function copyBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (!(value instanceof Uint8Array)) return null;
  return new Uint8Array(value);
}
