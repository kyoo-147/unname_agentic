export interface MirrorSession {
  sourceTabId: number;
  documentUrl: string;
  pdfUrl: string;
  viewerTabId: number;
}

export interface Sender { tabId?: number; url?: string }
interface Dependencies {
  enabled(): Promise<boolean>;
  load(id: number): Promise<MirrorSession | undefined>;
  save(id: number, value: MirrorSession | undefined): Promise<void>;
  open(url: string, sourceTabId: number): Promise<number>;
  viewerUrl: string;
  fetcher: typeof fetch;
}

export function sourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'file:'].includes(url.protocol) || url.username || url.password) return;
    url.hash = '';
    return url.href;
  } catch { return; }
}

export class MirrorController {
  private pending = new Map<number, Promise<void>>();
  constructor(private readonly deps: Dependencies) {}

  async detect(tabId: number, documentUrl: string, candidate: string): Promise<void> {
    const previous = this.pending.get(tabId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const pdfUrl = sourceUrl(candidate);
      if (tabId < 0 || !pdfUrl || !sourceUrl(documentUrl) || !await this.deps.enabled()) return;
      const current = await this.deps.load(tabId);
      if (current && current.documentUrl === sourceUrl(documentUrl) && current.pdfUrl === pdfUrl) return;
      const viewer = `${this.deps.viewerUrl}?file=${encodeURIComponent(pdfUrl)}&sourceTab=${tabId}`;
      const viewerTabId = await this.deps.open(viewer, tabId);
      await this.deps.save(tabId, { sourceTabId: tabId, documentUrl: sourceUrl(documentUrl)!, pdfUrl, viewerTabId });
    });
    this.pending.set(tabId, next);
    try { await next; } finally { if (this.pending.get(tabId) === next) this.pending.delete(tabId); }
  }

  async navigate(tabId: number, url: string): Promise<void> {
    await this.pending.get(tabId)?.catch(() => {});
    const session = await this.deps.load(tabId);
    if (session && session.documentUrl !== sourceUrl(url)) await this.deps.save(tabId, undefined);
  }

  async authorize(sender: Sender): Promise<MirrorSession> {
    if (!sender.url || sender.tabId === undefined) throw new Error('An extension reader tab is required.');
    const url = new URL(sender.url);
    if (`${url.protocol}//${url.host}${url.pathname}` !== this.deps.viewerUrl) throw new Error('Only the extension reader can access this operation.');
    const source = url.searchParams.get('sourceTab');
    if (!source || !/^\d+$/.test(source)) throw new Error('Missing source tab.');
    const session = await this.deps.load(Number(source));
    if (!session || session.viewerTabId !== sender.tabId) throw new Error('This reader is not bound to an active source.');
    return session;
  }

  async fetchPdf(sender: Sender, url: string): Promise<Uint8Array> {
    const session = await this.authorize(sender);
    if (sourceUrl(url) !== session.pdfUrl) throw new Error('URL is not the detected source.');
    let response: Response;
    try {
      response = await this.deps.fetcher(session.pdfUrl, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new Error('Chrome could not fetch this PDF. Sign in in the original tab. For local files, enable Allow access to file URLs in the extension details. Protected, blob, and redirected sources may require an explicit visible-tab capture.');
    }
    if (!response.ok) throw new Error(`PDF source returned HTTP ${response.status}. Sign in in the original tab first.`);
    if (Number(response.headers.get('Content-Length')) > 100 * 1024 * 1024) throw new Error('PDF exceeds the 100 MiB extension limit.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('PDF response is empty.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 100 * 1024 * 1024) { await reader.cancel(); throw new Error('PDF exceeds the 100 MiB extension limit.'); }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('The source did not return a PDF. It may require sign-in or disallow access. Use the original tab or an explicit visible-tab capture.');
    return bytes;
  }
}
