import { apply, getLocale, initLocale, LOCALES, localeLabel, setLocale, subscribe, t, type Locale } from '../src/i18n';
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

type DesktopKind = 'checking' | 'ready' | 'following' | 'unavailable' | 'no-source' | 'sending' | 'delivered' | 'stopped' | 'error';
interface DesktopView { kind: DesktopKind; message?: string }
let desktopView: DesktopView = { kind: 'checking' };
let enabled = false;
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
    case 'unavailable': return t('desktopUnavailable');
    case 'no-source': return t('desktopNoSource');
    case 'sending': return t('desktopSending');
    case 'delivered': return t('desktopDelivered');
    case 'stopped': return t('desktopStopped');
    case 'error': return view.message ?? t('desktopUnavailable');
  }
}
function renderDesktop(): void { desktopStatus.textContent = desktopMessage(desktopView); }
function renderStatus(): void { if (statusView) status.textContent = statusView(); }
function setStatus(text: () => string): void { statusView = text; renderStatus(); }
function errorMessage(error: unknown): void { setStatus(() => error instanceof Error ? error.message : String(error)); }

async function desktopState(): Promise<void> {
  desktopView = { kind: 'checking' };
  renderDesktop();
  const result = await chrome.runtime.sendMessage({ type: 'mirror:desktop-status' });
  if (!result?.ok) throw new Error(result?.error ?? t('desktopUnavailableFallback'));
  desktop.disabled = !result.available || !result.sourceAvailable || result.transferring;
  desktopStop.disabled = !result.following && !result.transferring;
  desktopView = !result.available ? { kind: 'unavailable' } : !result.sourceAvailable ? { kind: 'no-source' } : result.following ? { kind: 'following' } : { kind: 'ready' };
  renderDesktop();
}
desktop.addEventListener('click', () => {
  desktop.disabled = true;
  desktopStop.disabled = false;
  desktopView = { kind: 'sending' };
  renderDesktop();
  void chrome.runtime.sendMessage({ type: 'mirror:desktop-open' }).then(async result => {
    await desktopState();
    desktopView = result?.ok ? { kind: 'delivered' } : { kind: 'error', message: result?.error ?? t('desktopFailed') };
    renderDesktop();
  }).catch(error => { desktopView = { kind: 'error', message: error instanceof Error ? error.message : t('desktopFailed') }; renderDesktop(); desktopStop.disabled = true; });
});
desktopStop.addEventListener('click', () => {
  desktopStop.disabled = true;
  void chrome.runtime.sendMessage({ type: 'mirror:desktop-stop' }).then(async result => {
    await desktopState();
    desktopView = result?.ok ? { kind: 'stopped' } : { kind: 'error', message: result?.error ?? t('desktopStoppedFail') };
    renderDesktop();
  }).catch(error => { desktopView = { kind: 'error', message: error instanceof Error ? error.message : t('desktopStoppedFail') }; renderDesktop(); });
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
