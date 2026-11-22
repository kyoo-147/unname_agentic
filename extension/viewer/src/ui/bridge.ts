import { createTranslationTransport } from '../core/translation';
import type { TranslationRequest, TranslationTransport } from '../core/types';
function byteArray(value: unknown): value is number[] { return Array.isArray(value) && value.every(item => Number.isInteger(item) && item >= 0 && item <= 255); }
async function verifySha256(bytes: Uint8Array, expected: unknown): Promise<void> {
  if (expected === undefined) return;
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid PDF transfer checksum.');
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const actual = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new Error('PDF transfer checksum mismatch. Reload the reader and try again.');
}
export function hasExtension(): boolean { return typeof chrome !== 'undefined' && !!chrome.runtime?.id; }
async function message(payload: unknown): Promise<Record<string, unknown>> {
  const response: unknown = await chrome.runtime.sendMessage(payload);
  if (!response || typeof response !== 'object') throw new Error('The extension background did not respond. Reopen the mirror.');
  const result = response as Record<string,unknown>;
  if (!result.ok) throw new Error(typeof result.error==='string'?result.error:'Extension request failed.');
  return result;
}
export function browserTransport(): TranslationTransport {
  const direct = createTranslationTransport();
  return { async translate(request: TranslationRequest) {
    if (!hasExtension()) return direct.translate(request);
    request.signal?.throwIfAborted();
    const response = await message({type:'mirror:translate',request:{text:request.text,settings:request.settings}});
    request.signal?.throwIfAborted();
    if (typeof response.text !== 'string') throw new Error('Invalid translation reply.');
    return response.text;
  }};
}
export async function fetchPdf(url: string): Promise<Uint8Array> {
  if (hasExtension()) {
    const result = await message({ type: 'mirror:fetch-pdf', url });
    if (Array.isArray(result.data)) {
      if (!byteArray(result.data)) throw new Error('Invalid PDF transfer reply.');
      const bytes = new Uint8Array(result.data);
      if (result.size !== undefined && (result.size as number) !== bytes.length) throw new Error('PDF transfer size mismatch. Reload the reader and try again.');
      await verifySha256(bytes, result.sha256);
      return bytes;
    }
    if (typeof result.transferId === 'string' && Number.isSafeInteger(result.size) && (result.size as number) > 0 && Number.isSafeInteger(result.chunkSize) && (result.chunkSize as number) > 0) {
      const size = result.size as number;
      const chunkSize = result.chunkSize as number;
      if (typeof result.sha256 !== 'string') throw new Error('Invalid PDF transfer checksum.');
      const bytes = new Uint8Array(size);
      let offset = 0;
      let completed = false;
      while (offset < bytes.length) {
        const chunk = await message({ type: 'mirror:fetch-pdf-chunk', transferId: result.transferId, offset });
        if (!byteArray(chunk.data) || chunk.data.length === 0 || chunk.data.length > chunkSize || chunk.data.length > bytes.length - offset) throw new Error('PDF transfer chunk is invalid or out of order.');
        const end = offset + chunk.data.length;
        const expectedDone = end === bytes.length;
        if (chunk.done !== expectedDone) throw new Error('PDF transfer completion state is invalid.');
        bytes.set(chunk.data, offset);
        offset = end;
        completed = expectedDone;
      }
      if (!completed) throw new Error('PDF transfer ended unexpectedly.');
      await verifySha256(bytes, result.sha256);
      return bytes;
    }
    throw new Error('Invalid PDF transfer reply.');
  }
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Choose a local PDF with Open PDF instead.');
  const response = await fetch(parsed);
  if (!response.ok) throw new Error(`Cannot open PDF (HTTP ${response.status}). Save it locally and choose Open PDF.`);
  return new Uint8Array(await response.arrayBuffer());
}
export class ViewRelayGuard {
  private externalApplied = false;
  applyExternal(): void { this.externalApplied = true; }
  userInput(): void { this.externalApplied = false; }
  canRelay(): boolean { return !this.externalApplied; }
}
export interface LinkedViewState { page: number; fraction: number; zoom: number }
export function boundViewState(message: unknown, viewerTabId: number): LinkedViewState | undefined {
  if (!message || typeof message !== 'object') return;
  const value = message as Record<string, unknown>;
  if (value.type !== 'mirror:view-state' || value.targetTabId !== viewerTabId || !value.state || typeof value.state !== 'object') return;
  const state = value.state as Record<string, unknown>;
  if (typeof state.page !== 'number' || !Number.isInteger(state.page) || state.page < 1 || state.page > 65535 || typeof state.fraction !== 'number' || !Number.isFinite(state.fraction) || state.fraction < 0 || state.fraction > 1) return;
  const zoom = state.zoom === undefined ? 1 : state.zoom;
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom <= 0 || zoom > 10) return;
  return { page: state.page, fraction: state.fraction, zoom };
}
export function listenForLinkedView(apply: (state: LinkedViewState) => void): void {
  if (!hasExtension()) return;
  void chrome.tabs.getCurrent().then(tab => {
    if (tab?.id === undefined) return;
    const viewerTabId = tab.id;
    chrome.runtime.onMessage.addListener((message: unknown, sender) => {
      if (sender.id !== chrome.runtime.id) return;
      const state = boundViewState(message, viewerTabId);
      if (state) apply(state);
    });
  }).catch(() => undefined);
}
export function relayView(page: number,fraction: number,zoom: number): void {
  if (hasExtension()) void chrome.runtime.sendMessage({type:'mirror:view-state',state:{page,fraction,zoom}}).catch(()=>undefined);
}
