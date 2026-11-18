import { describe, expect, it } from 'vitest';
import {
  CaptureError,
  decodeDataUrl,
  readCaptureParams,
  requestCaptureImage,
  type CaptureRuntime,
} from '../src/ui/capture';

const PNG = `data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString('base64')}`;

describe('capture params', () => {
  it('reads the capture flag and source tab from a query or URL', () => {
    expect(readCaptureParams('?capture=1&sourceTab=42')).toEqual({ capture: true, sourceTab: 42 });
    expect(readCaptureParams('https://example.test/index.html?capture=1&sourceTab=7#top')).toEqual({ capture: true, sourceTab: 7 });
    expect(readCaptureParams('?capture=true')).toEqual({ capture: true });
  });

  it('ignores pages that are not captures', () => {
    expect(readCaptureParams('')).toBeUndefined();
    expect(readCaptureParams('?other=1')).toBeUndefined();
    expect(readCaptureParams('?capture=0&sourceTab=4')).toBeUndefined();
  });

  it('drops an invalid source tab instead of guessing', () => {
    expect(readCaptureParams('?capture=1&sourceTab=abc')).toEqual({ capture: true });
    expect(readCaptureParams('?capture=1&sourceTab=-3')).toEqual({ capture: true });
  });
});

describe('decodeDataUrl', () => {
  it('decodes a base64 image and keeps the mime type', () => {
    const decoded = decodeDataUrl(PNG);
    expect(decoded.mimeType).toBe('image/png');
    expect([...decoded.bytes]).toEqual([137, 80, 78, 71]);
  });

  it('rejects non-image and malformed data URLs', () => {
    expect(() => decodeDataUrl('data:text/plain;base64,aGVsbG8=')).toThrow(CaptureError);
    expect(() => decodeDataUrl('data:image/png;base64,')).toThrow(CaptureError);
    expect(() => decodeDataUrl('not a data url')).toThrow(CaptureError);
  });
});

describe('requestCaptureImage', () => {
  it('messages the extension background and returns a validated data URL', async () => {
    const messages: unknown[] = [];
    const runtime: CaptureRuntime = {
      id: 'extension-id',
      async sendMessage(message) {
        messages.push(message);
        return { ok: true, image: PNG, sourceTabId: 9 };
      },
    };
    await expect(requestCaptureImage(runtime)).resolves.toBe(PNG);
    expect(messages).toEqual([{ type: 'mirror:get-capture' }]);
  });

  it('accepts an options object with a fake runtime', async () => {
    const runtime: CaptureRuntime = { async sendMessage() { return { ok: true, image: PNG }; } };
    await expect(requestCaptureImage({ runtime })).resolves.toBe(PNG);
  });

  it('reports no-extension when there is no runtime', async () => {
    await expect(requestCaptureImage({})).rejects.toMatchObject({ name: 'CaptureError', code: 'no-extension' });
    const runtime: CaptureRuntime = { async sendMessage() { throw new Error('Could not establish connection. Receiving end does not exist.'); } };
    await expect(requestCaptureImage(runtime)).rejects.toMatchObject({ code: 'no-extension' });
  });

  it('reports an expired capture with a typed error', async () => {
    const runtime: CaptureRuntime = { async sendMessage() { return { ok: false, error: 'Capture expired. Capture the visible source tab again.' }; } };
    await expect(requestCaptureImage(runtime)).rejects.toMatchObject({ name: 'CaptureError', code: 'expired' });
  });

  it('rejects a reply that is not an image data URL', async () => {
    const runtime: CaptureRuntime = { async sendMessage() { return { ok: true, image: 'https://example.test/a.png' }; } };
    await expect(requestCaptureImage(runtime)).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('times out instead of waiting on a silent background page', async () => {
    const runtime: CaptureRuntime = { async sendMessage() { return new Promise(() => {}); } };
    await expect(requestCaptureImage({ runtime, timeoutMs: 5 })).rejects.toMatchObject({ code: 'timeout' });
  });
});
