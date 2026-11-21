import { sourceSha256 } from '../core/document-runtime';
import { sniffFormat, type ImportFormat } from '../core/import-formats';

export interface ImmutableSource {
  readonly name: string;
  readonly format: ImportFormat;
  readonly sha256: string;
  readonly byteLength: number;
  /** A frozen byte snapshot. Call {@link sourceBytes} to obtain a mutable working copy. */
  readonly bytes: readonly number[];
}

export function captureSource(bytes: Uint8Array, name = ''): ImmutableSource {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('captureSource expects Uint8Array bytes.');
  const snapshot = Array.from(bytes);
  const source: ImmutableSource = {
    name: name.trim(),
    format: sniffFormat(bytes, name).format,
    sha256: sourceSha256(bytes),
    byteLength: bytes.byteLength,
    bytes: snapshot,
  };
  return deepFreeze(source);
}

export function sourceBytes(source: ImmutableSource): Uint8Array {
  if (!source || !Array.isArray(source.bytes)) throw new TypeError('sourceBytes expects an immutable source.');
  return new Uint8Array(source.bytes);
}

export function toUint8Array(value: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (value instanceof Uint8Array) return Promise.resolve(new Uint8Array(value));
  if (value instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(value.slice(0)));
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return value.arrayBuffer().then(buffer => new Uint8Array(buffer));
  }
  return Promise.reject(new TypeError('Document input must be Uint8Array, ArrayBuffer, or Blob.'));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Reflect.ownKeys(value as object).forEach(key => {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  });
  return Object.freeze(value);
}
