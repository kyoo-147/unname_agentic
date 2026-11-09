import type { MirrorSession } from './controller';

export const NATIVE_HOST = 'com.pdfworkspace.bridge';
export const NATIVE_CHUNK_BYTES = 192 * 1024;
export const NATIVE_MAX_PDF = 256 * 1024 * 1024;
export const COMPANION_UNAVAILABLE = 'Desktop companion unavailable. Install the native host using scripts/install-native-host.ps1 with this extension ID, then reopen this popup. The browser reader still works independently.';
export interface NativeBinding { session_id: string; source_id: string; request_nonce: string; generation: number }
export interface NativePage { page: number; page_count: number | null; fraction: number; zoom: number }
export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}
export function normalizeNativePage(state?: { page?: number; fraction?: number; zoom?: number }): NativePage {
  return {
    page: Math.max(0, Math.min(65535, Math.trunc(state?.page ?? 1) - 1)),
    page_count: null,
    fraction: Math.max(0, Math.min(1, Number.isFinite(state?.fraction) ? state!.fraction! : 0)),
    zoom: Math.max(0.1, Math.min(10, Number.isFinite(state?.zoom) ? state!.zoom! : 1)),
  };
}
export function sameSession(a: MirrorSession, b: MirrorSession): boolean {
  return a.sourceTabId === b.sourceTabId && a.viewerTabId === b.viewerTabId && a.documentUrl === b.documentUrl && a.pdfUrl === b.pdfUrl;
}
class Connection {
  private pending?: { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  private closed = false;
  constructor(private readonly port: NativePort, private readonly onClose: () => void) {
    port.onMessage.addListener(message => {
      const pending = this.pending;
      if (!pending) { this.close(); return; }
      clearTimeout(pending.timer); this.pending = undefined;
      if (!message || typeof message !== 'object' || (message as Record<string, unknown>).ok !== true) {
        pending.reject(new Error('Desktop companion rejected the transfer. Reopen the PDF and try again.'));
        this.close(); return;
      }
      pending.resolve(message as Record<string, unknown>);
    });
    port.onDisconnect.addListener(() => this.close());
  }
  request(message: unknown, timeout = 30_000): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error(COMPANION_UNAVAILABLE));
    if (this.pending) return Promise.reject(new Error('Desktop companion is busy.'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, timer: setTimeout(() => this.close(), timeout) };
      try { this.port.postMessage(message); } catch { this.close(); }
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error(COMPANION_UNAVAILABLE)); this.pending = undefined; }
    try { this.port.disconnect(); } catch { /* The disconnected Chrome port is already closed. */ }
    this.onClose();
  }
}
export function sameBinding(value: unknown, binding: NativeBinding): boolean {
  const other = value as NativeBinding | undefined;
  return !!other && other.session_id === binding.session_id && other.source_id === binding.source_id && other.request_nonce === binding.request_nonce && other.generation === binding.generation;
}
export function nativeCommand(value: unknown, binding: NativeBinding): { sequence: number; page: NativePage } {
  const command = value as { version?: number; kind?: string; binding?: NativeBinding; sequence?: number; page?: NativePage } | undefined;
  const page = command?.page;
  if (!command || command.version !== 1 || command.kind !== 'view_state' || !sameBinding(command.binding, binding) || !Number.isSafeInteger(command.sequence) || command.sequence! <= 0 || !page || !Number.isInteger(page.page) || page.page < 0 || page.page > 65535 || (page.page_count !== null && (!Number.isInteger(page.page_count) || page.page_count <= page.page || page.page_count > 65535)) || !Number.isFinite(page.fraction) || page.fraction < 0 || page.fraction > 1 || !Number.isFinite(page.zoom) || page.zoom < 0.1 || page.zoom > 10) throw new Error('Invalid desktop navigation command.');
  return { sequence: command.sequence!, page };
}
export class NativeCompanion {
  private connection?: Connection;
  private connecting?: Promise<Connection>;
  private source?: MirrorSession;
  private active?: { session: MirrorSession; binding: NativeBinding; authorize: () => Promise<void>; sequence: number };
  private busy = false;
  private generation = 0;
  private revision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private operation: Promise<void> = Promise.resolve();
  private queuedPage?: NativePage;
  private pageTask?: Promise<void>;
  private echoes: NativePage[] = [];
  constructor(private readonly connect: () => NativePort, private readonly onCommand?: (session: MirrorSession, page: NativePage) => Promise<void>) {}
  get following(): boolean { return !!this.active; }
  get transferring(): boolean { return this.busy; }
  private cancelPoll(): void { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
  private invalidate(): void { this.revision++; this.cancelPoll(); this.active = undefined; this.source = undefined; this.queuedPage = undefined; this.echoes = []; }
  private serialize(task: () => Promise<void>): Promise<void> {
    const connection = this.connection;
    this.operation = this.operation.then(task).catch(() => { connection?.close(); });
    return this.operation;
  }
  private check(revision: number): void { if (revision !== this.revision) throw new Error('Desktop source authorization ended.'); }
  private async connected(): Promise<Connection> {
    if (this.connecting) return this.connecting;
    if (this.connection) return this.connection;
    let connection: Connection;
    try { connection = new Connection(this.connect(), () => { if (this.connection === connection) { this.connection = undefined; this.invalidate(); } }); }
    catch { throw new Error(COMPANION_UNAVAILABLE); }
    this.connection = connection;
    this.connecting = connection.request({ type: 'hello' }).then(hello => {
      if (hello.protocol !== 1 || hello.status !== 'ready') { connection.close(); throw new Error('Desktop companion protocol is incompatible. Reinstall the matching host.'); }
      return connection;
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  async probe(): Promise<boolean> {
    const connection = await this.connected();
    if (!this.busy && !this.following) connection.close();
    return true;
  }
  private schedulePoll(): void {
    this.cancelPoll();
    if (!this.active || !this.connection || this.busy) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.serialize(async () => {
        const active = this.active; const connection = this.connection; const revision = this.revision;
        if (!active || !connection || this.busy) return;
        const reply = await connection.request({ type: 'poll', binding: active.binding, after_sequence: active.sequence }, 1000);
        if (revision !== this.revision) return;
        if (!sameBinding(reply.binding, active.binding) || reply.status !== 'following') throw new Error('Invalid desktop poll response.');
        if (reply.command !== null) {
          const command = nativeCommand(reply.command, active.binding);
          if (command.sequence > active.sequence) {
            await active.authorize(); if (revision !== this.revision) return;
            active.sequence = command.sequence;
            this.echoes = [...this.echoes.slice(-7), command.page];
            await this.onCommand?.(active.session, command.page);
          }
        }
      }).finally(() => this.schedulePoll());
    }, 1000);
  }
  async open(session: MirrorSession, acquire: () => Promise<Uint8Array>, authorize: () => Promise<void>, page: NativePage, title: string): Promise<void> {
    if (this.busy) throw new Error('A desktop transfer is already in progress.');
    this.busy = true; this.invalidate(); this.source = { ...session };
    const revision = this.revision;
    let connection: Connection | undefined;
    const authorized = async () => { this.check(revision); await authorize(); this.check(revision); };
    try {
      await this.operation; this.check(revision);
      connection = await this.connected(); this.check(revision);
      const bytes = await acquire(); this.check(revision);
      if (!bytes.length || bytes.length > NATIVE_MAX_PDF) throw new Error('PDF exceeds the 256 MiB desktop bridge limit or is empty.');
      await authorized();
      this.generation = Math.max(Date.now(), this.generation + 1);
      const digest = async (input: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(input).buffer)), v => v.toString(16).padStart(2, '0')).join('');
      const binding: NativeBinding = { session_id: crypto.randomUUID(), source_id: await digest(new TextEncoder().encode(`${session.sourceTabId}|${session.documentUrl}|${session.pdfUrl}`)), request_nonce: crypto.randomUUID(), generation: this.generation };
      const sha256 = await digest(bytes);
      await authorized();
      const request = async (message: unknown) => {
        this.check(revision); const reply = await connection!.request(message); this.check(revision);
        if (!sameBinding(reply.binding, binding)) throw new Error('Desktop companion acknowledged a different source.');
        return reply;
      };
      await request({ type: 'begin', binding, total_bytes: bytes.length, sha256, page, title: title.slice(0, 200) });
      let index = 0;
      for (let offset = 0; offset < bytes.length; offset += NATIVE_CHUNK_BYTES) {
        await authorized();
        const part = bytes.subarray(offset, offset + NATIVE_CHUNK_BYTES);
        let binary = '';
        for (let start = 0; start < part.length; start += 8192) binary += String.fromCharCode(...part.subarray(start, start + 8192));
        const reply = await request({ type: 'chunk', binding, index, data: btoa(binary) });
        if (reply.next_index !== ++index) throw new Error('Desktop companion acknowledged an unexpected chunk.');
      }
      await authorized();
      const reply = await request({ type: 'commit', binding });
      if (reply.status !== 'complete') throw new Error('Desktop companion did not complete the PDF transfer.');
      this.active = { session: { ...session }, binding, authorize, sequence: 0 };
    } catch (error) { connection?.close(); this.invalidate(); throw error; }
    finally { this.busy = false; this.schedulePoll(); }
  }
  page(session: MirrorSession, page: NativePage): Promise<void> {
    if (!this.active || !sameSession(session, this.active.session) || this.busy) return Promise.resolve();
    if (this.echoes.some(echo => echo.page === page.page && Math.abs(echo.fraction - page.fraction) <= 0.002)) return Promise.resolve();
    this.echoes = []; this.queuedPage = page;
    if (this.pageTask) return this.pageTask;
    this.pageTask = this.serialize(async () => {
      while (this.queuedPage && this.active && this.connection && !this.busy) {
        const active = this.active; const revision = this.revision;
        const next = this.queuedPage; this.queuedPage = undefined;
        await active.authorize(); if (revision !== this.revision || !this.connection) return;
        const reply = await this.connection.request({ type: 'page', binding: active.binding, page: next });
        if (revision !== this.revision) return;
        if (!sameBinding(reply.binding, active.binding)) throw new Error('Invalid desktop page response.');
      }
    }).finally(() => { this.pageTask = undefined; });
    return this.pageTask;
  }
  async stop(): Promise<void> {
    const active = this.active; const connection = this.connection;
    this.invalidate();
    if (this.busy) { connection?.close(); return; }
    await this.operation;
    try { if (active && this.connection === connection) await connection?.request({ type: 'end', binding: active.binding }); }
    finally { connection?.close(); }
  }
  revoke(tabId: number): void {
    if (this.source && (this.source.sourceTabId === tabId || this.source.viewerTabId === tabId)) { this.invalidate(); this.connection?.close(); }
  }
}
