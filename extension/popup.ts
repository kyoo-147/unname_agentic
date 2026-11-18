export {};

const toggle = document.querySelector<HTMLButtonElement>('#toggle')!;
const mode = document.querySelector<HTMLElement>('#mode')!;
const status = document.querySelector<HTMLElement>('#status')!;
const desktop = document.querySelector<HTMLButtonElement>('#desktop')!;
const desktopStop = document.querySelector<HTMLButtonElement>('#desktop-stop')!;
const desktopStatus = document.querySelector<HTMLElement>('#desktop-status')!;
async function desktopState(): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: 'mirror:desktop-status' });
  if (!result?.ok) throw new Error(result?.error ?? 'Desktop companion status unavailable. The browser reader still works.');
  desktop.disabled = !result.available || !result.sourceAvailable || result.transferring;
  desktopStop.disabled = !result.following && !result.transferring;
  desktopStatus.textContent = result.status;
}
desktop.addEventListener('click', () => {
  desktop.disabled = true;
  desktopStop.disabled = false;
  desktopStatus.textContent = 'Sending the authorized PDF to your local desktop inbox…';
  void chrome.runtime.sendMessage({ type: 'mirror:desktop-open' }).then(async result => {
    await desktopState();
    desktopStatus.textContent = result?.ok ? result.status : result?.error ?? 'Desktop transfer failed.';
  }).catch(error => { desktopStatus.textContent = error instanceof Error ? error.message : 'Desktop transfer failed.'; desktopStop.disabled = true; });
});
desktopStop.addEventListener('click', () => {
  desktopStop.disabled = true;
  void chrome.runtime.sendMessage({ type: 'mirror:desktop-stop' }).then(async result => {
    await desktopState();
    desktopStatus.textContent = result?.ok ? result.status : result?.error ?? 'Could not stop desktop following.';
  }).catch(error => { desktopStatus.textContent = error instanceof Error ? error.message : 'Could not stop desktop following.'; });
});
async function render(): Promise<void> {
  const enabled = (await chrome.storage.local.get('mirror:enabled'))['mirror:enabled'] === true;
  toggle.textContent = enabled ? 'Disable automatic mirrors' : 'Enable automatic mirrors';
  mode.textContent = enabled ? 'Automatic mirroring is on.' : 'Automatic mirroring is off.';
}
function errorMessage(error: unknown): void { status.textContent = error instanceof Error ? error.message : String(error); }
toggle.addEventListener('click', () => {
  void (async () => {
    const enabled = (await chrome.storage.local.get('mirror:enabled'))['mirror:enabled'] === true;
    await chrome.storage.local.set({ 'mirror:enabled': !enabled, 'mirror:consentVersion': 1 });
    await render();
    if (!enabled) await chrome.runtime.sendMessage({ type: 'mirror:rescan' });
  })().catch(errorMessage);
});
document.querySelector('#reader')!.addEventListener('click', () => { void chrome.tabs.create({ url: chrome.runtime.getURL('index.html') }); });
document.querySelector('#capture')!.addEventListener('click', () => {
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !/^(https?|file):/.test(tab.url)) throw new Error('Select a normal web document tab first.');
    const image = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const result = await chrome.runtime.sendMessage({ type: 'mirror:open-capture', sourceTabId: tab.id, image });
    if (!result?.ok) throw new Error(result?.error ?? 'Capture failed.');
    window.close();
  })().catch(errorMessage);
});
void render().catch(errorMessage);
void desktopState().catch(error => { desktopStatus.textContent = error instanceof Error ? error.message : 'Desktop companion unavailable. The browser reader still works.'; });
