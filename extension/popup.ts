import { apply, getLocale, initLocale, LOCALES, localeLabel, setLocale, subscribe, t, type Locale } from './viewer/src/i18n';
import { initTargetLanguage } from './target-language';

initLocale();

const toggle = document.querySelector<HTMLButtonElement>('#toggle')!;
const mode = document.querySelector<HTMLElement>('#mode')!;
const status = document.querySelector<HTMLElement>('#status')!;
const desktop = document.querySelector<HTMLButtonElement>('#desktop')!;
const desktopStop = document.querySelector<HTMLButtonElement>('#desktop-stop')!;
const desktopStatus = document.querySelector<HTMLElement>('#desktop-status')!;
const localeSwitch = document.querySelector<HTMLElement>('#locale-switch')!;
const targetLanguage = document.querySelector<HTMLSelectElement>('#target-language')!;
localeSwitch.innerHTML = LOCALES.map(locale => `<button type="button" data-locale="${locale}" aria-pressed="${locale === getLocale()}">${localeLabel(locale)}</button>`).join('');

type DesktopKind = 'checking' | 'ready' | 'following' | 'reconnecting' | 'unavailable' | 'no-source' | 'sending' | 'delivered' | 'stopped' | 'error';
interface DesktopView { kind: DesktopKind; message?: string; progress?: number }
let desktopView: DesktopView = { kind: 'checking' };
let enabled = false;
let desktopRequest = 0;
let statusView: (() => string) | null = null;

function renderMode(): void {
  toggle.textContent = enabled ? t('popupDisable') : t('popupEnable');
  mode.textContent = enabled ? t('popupModeOn') : t('popupModeOff');
}
function desktopMessage(view: DesktopView): string {
  switch (view.kind) {
    case 'checking': return t('popupDesktopChecking');
    case 'ready': return t('desktopReady');
    case 'following': return t('desktopFollowing');
    case 'reconnecting': return t('popupDesktopChecking');
    case 'unavailable': return t('desktopUnavailable');
    case 'no-source': return t('desktopNoSource');
    case 'sending': return view.progress === undefined ? t('desktopSending') : `${t('desktopSending')} ${view.progress}%`;
    case 'delivered': return t('desktopDelivered');
    case 'stopped': return t('desktopStopped');
    case 'error': return view.message ?? t('desktopUnavailable');
  }
}
function renderDesktop(): void { desktopStatus.textContent = desktopMessage(desktopView); }
chrome.runtime.onMessage?.addListener((message: unknown) => {
  if (!message || typeof message !== 'object' || (message as Record<string, unknown>).type !== 'mirror:desktop-progress') return;
  const progress = (message as { progress?: { state?: string; percent?: unknown; detail?: unknown } }).progress;
  if (!progress) return;
  if (progress.state === 'error') desktopView = { kind: 'error', message: typeof progress.detail === 'string' ? progress.detail : undefined };
  else if (progress.state === 'reconnecting') desktopView = { kind: 'reconnecting' };
  else if (progress.state === 'transferring') desktopView = { kind: 'sending', progress: typeof progress.percent === 'number' ? Math.max(0, Math.min(100, Math.round(progress.percent))) : undefined };
  else if (progress.state === 'following') desktopView = { kind: 'following' };
  else if (progress.state === 'stopped') desktopView = { kind: 'stopped' };
  renderDesktop();
});
function renderStatus(): void { if (statusView) status.textContent = statusView(); }
function setStatus(text: () => string): void { statusView = text; renderStatus(); }
function errorMessage(error: unknown): void { setStatus(() => error instanceof Error ? error.message : String(error)); }

async function desktopState(request = desktopRequest): Promise<void> {
  desktopView = { kind: 'checking' };
  renderDesktop();
  const result = await chrome.runtime.sendMessage({ type: 'mirror:desktop-status' });
  if (request !== desktopRequest) return;
  if (!result?.ok) throw new Error(result?.error ?? t('desktopUnavailableFallback'));
  desktop.disabled = !result.available || !result.sourceAvailable || result.transferring;
  desktopStop.disabled = !result.following && !result.transferring;
  desktopView = !result.available ? { kind: 'unavailable' } : !result.sourceAvailable ? { kind: 'no-source' } : result.following ? { kind: 'following' } : { kind: 'ready' };
  renderDesktop();
}
desktop.addEventListener('click', () => {
  const request = ++desktopRequest;
  desktop.disabled = true;
  desktopStop.disabled = false;
  desktopView = { kind: 'sending' };
  renderDesktop();
  void chrome.runtime.sendMessage({ type: 'mirror:desktop-open' }).then(async result => {
    if (request !== desktopRequest) return;
    await desktopState(request);
    if (request !== desktopRequest) return;
    desktopView = result?.ok ? { kind: 'delivered' } : { kind: 'error', message: result?.error ?? t('desktopFailed') };
    renderDesktop();
  }).catch(error => { if (request !== desktopRequest) return; desktopView = { kind: 'error', message: error instanceof Error ? error.message : t('desktopFailed') }; renderDesktop(); desktopStop.disabled = true; });
});
desktopStop.addEventListener('click', () => {
  const request = ++desktopRequest;
  desktopStop.disabled = true;
  void chrome.runtime.sendMessage({ type: 'mirror:desktop-stop' }).then(async result => {
    if (request !== desktopRequest) return;
    await desktopState(request);
    if (request !== desktopRequest) return;
    desktopView = result?.ok ? { kind: 'stopped' } : { kind: 'error', message: result?.error ?? t('desktopStoppedFail') };
    renderDesktop();
  }).catch(error => { if (request !== desktopRequest) return; desktopView = { kind: 'error', message: error instanceof Error ? error.message : t('desktopStoppedFail') }; renderDesktop(); });
});
async function render(): Promise<void> {
  enabled = (await chrome.storage.local.get('mirror:enabled'))['mirror:enabled'] === true;
  renderMode();
}
toggle.addEventListener('click', () => {
  void (async () => {
    const wasEnabled = (await chrome.storage.local.get('mirror:enabled'))['mirror:enabled'] === true;
    await chrome.storage.local.set({ 'mirror:enabled': !wasEnabled, 'mirror:consentVersion': 1 });
    await render();
    if (!wasEnabled) await chrome.runtime.sendMessage({ type: 'mirror:rescan' });
  })().catch(errorMessage);
});
document.querySelector('#reader')!.addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('index.html') }); });
document.querySelector('#capture')!.addEventListener('click', () => {
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !/^(https?|file):/.test(tab.url)) throw new Error(t('selectTabFirst'));
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const result = await chrome.runtime.sendMessage({ type: 'mirror:open-capture', sourceTabId: tab.id, image });
    if (!result?.ok) throw new Error(result?.error ?? t('captureFailed'));
    window.close();
  })().catch(errorMessage);
});
localeSwitch.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-locale]');
  if (button?.dataset.locale) setLocale(button.dataset.locale as Locale);
});
subscribe(() => { apply(document); renderMode(); renderDesktop(); renderStatus(); });
apply(document);
renderMode();
renderDesktop();
void initTargetLanguage(targetLanguage).catch(errorMessage);
void render().catch(errorMessage);
void desktopState().catch(error => { desktopView = { kind: 'error', message: error instanceof Error ? error.message : t('desktopUnavailable') }; renderDesktop(); });
