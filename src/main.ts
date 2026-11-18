import './style.css';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { defaultSettings, type TextBlock, type TranslationSettings } from './core/types';
import { TranslationService } from './core/translation';
import { ViewportScheduler } from './core/scheduler';
import { openPdf, renderPage, type RenderedPage } from './pdf/document';
import { fitText } from './pdf/layout';
import { browserTransport, fetchPdf, relayView, hasExtension, listenForLinkedView, ViewRelayGuard } from './ui/bridge';
import { apply, getLocale, initLocale, LOCALES, localeLabel, setLocale, subscribe, t, type Locale, type TranslationKey } from './i18n';

initLocale();

const icon = (name: string) => {
  const paths: Record<string,string> = { book:'<path d="M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H3zM21 4h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h5z"/>', plus:'<path d="M12 5v14M5 12h14"/>', settings:'<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>', arrow:'<path d="m9 5 7 7-7 7"/>', file:'<path d="M14 2H5v20h14V7zM14 2v6h5M8 13h8M8 17h6"/>', upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>', check:'<path d="m5 12 4 4L19 6"/>' };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]??paths.file}</svg>`;
};
const root = document.querySelector<HTMLDivElement>('#app')!;
const localeSwitcher = () => `<div class="locale-switch" role="group" data-i18n-aria-label="languageSwitcher" aria-label="Language">${LOCALES.map(locale => `<button type="button" data-locale="${locale}" aria-pressed="${locale === getLocale()}">${localeLabel(locale)}</button>`).join('')}</div>`;
root.innerHTML = `<aside class="sidebar"><a class="brand" href="#" data-i18n-aria-label="libraryAria" aria-label="Mirror library">${icon('book')}<span>mirror<span class="brand-dot">.</span></span></a><button class="open-button" data-open>${icon('plus')} <span data-i18n="openPdf">Open PDF</span> <kbd>Ctrl O</kbd></button><div class="nav-label" data-i18n="workspaceLabel">YOUR WORKSPACE</div><button class="nav-item active" id="library-nav">${icon('book')} <span data-i18n="myLibrary">My library</span> <span id="library-count">0</span></button><div class="sidebar-note"><span class="small-orbit"></span><p><span data-i18n="sidebarNoteLead">A different language.</span><br><span data-i18n="sidebarNoteTail">The same perspective.</span></p></div><button class="nav-item settings-button" id="settings-open">${icon('settings')} <span data-i18n="settingsNav">Translation settings</span></button><div class="privacy-note"><span data-i18n="privacyLead">Documents stay in this session.</span><br><span data-i18n="privacyTail">Cloud translation is opt-in.</span></div></aside>
<main><header class="topbar"><div class="breadcrumb"><span data-i18n="workspace">Workspace</span>${icon('arrow')}<strong id="breadcrumb">My library</strong></div>${localeSwitcher()}<span class="local-badge"><i></i> <span data-i18n="localFirst">Local-first reading</span></span></header>
<section id="library" class="library"><div class="library-heading"><div><div class="eyebrow" data-i18n="libraryEyebrow">A LITTLE CLOSER TO UNDERSTANDING</div><h1 data-i18n="libraryTitle">Your reading room.</h1><p data-i18n="libraryLead">Keep the original. Find the meaning beside it.</p></div><button class="primary" data-open>${icon('plus')} <span data-i18n="importDocument">Import document</span></button></div><div class="library-section-heading"><h2><span data-i18n="allDocuments" style="color:inherit;font-size:inherit;margin-left:0">All documents</span> <span id="document-count">0</span></h2><span data-i18n="recentlyOpened">Recently opened</span></div><div id="documents" class="documents"></div><button class="drop-zone" data-open>${icon('upload')}<strong data-i18n="dropTitle">Your next good read belongs here</strong><span data-i18n="dropHint">Drop a PDF, or browse your files</span><small data-i18n="dropMeta">PDF documents · read locally · no account needed</small></button><div class="library-footnote"><span data-i18n="stepOpen">01 — OPEN</span><span data-i18n="stepRead">02 — READ SIDE BY SIDE</span><span data-i18n="stepUnderstand">03 — UNDERSTAND MORE</span></div></section>
<section id="reader" hidden><div class="reader-toolbar"><div class="document-title" id="document-title"></div><div class="toolbar-actions"><label class="language-label"><span data-i18n="targetLanguageLabel">To</span> <input id="target-language" value="vi" data-i18n-aria-label="targetLanguageAria" aria-label="Target language code" maxlength="12"></label><button id="zoom-out" data-i18n-aria-label="zoomOut" aria-label="Zoom out">−</button><output id="zoom-label">100%</output><button id="zoom-in" data-i18n-aria-label="zoomIn" aria-label="Zoom in">+</button><button id="pause">Pause</button><button id="full">Translate all</button><button id="retry" data-i18n="retry">Retry</button><a id="original-link" target="_blank" rel="noopener" hidden><span data-i18n="openOriginal">Open original ↗</span></a></div></div><div class="pane-headings"><span><span data-i18n="originalHeading">ORIGINAL</span> <small data-i18n="originalNote">Unchanged source</small></span><span><span data-i18n="translatedHeading">TRANSLATED MIRROR</span> <small id="provider-label" data-i18n="providerInitial">Local · Vietnamese</small></span></div><div id="reading-scroll" class="reading-scroll"><div id="pages"></div></div><div class="reader-bottom"><span id="page-status" data-i18n="pageInitial">Page 1</span><span><span data-i18n="linkedPages">Linked pages</span> <span class="linked-symbol">↔</span> <span data-i18n="selectRegionHint">Select any text region to compare</span></span><button id="reset-split" data-i18n="resetSplit">Reset split</button></div></section>
<div class="status-bar" id="status" role="status" aria-live="polite" data-i18n="ready">Ready when you are.</div></main>
<input type="file" id="file-input" accept="application/pdf,.pdf" hidden multiple>
<dialog id="settings-dialog"><form id="settings-form"><div class="dialog-heading"><div><span class="eyebrow" data-i18n="settingsEyebrow">MAKE IT YOURS</span><h2 data-i18n="translationSettings">Translation settings</h2></div><button type="button" id="settings-close" data-i18n-aria-label="closeSettings" aria-label="Close settings">${icon('close')}</button></div>${localeSwitcher()}<p class="dialog-description" data-i18n="settingsDescription">Only extracted text is sent to your chosen provider. Your PDF stays here. Credentials are kept in memory, not saved.</p><label><span data-i18n="providerLabel">Provider</span><select name="provider"><option value="local" data-i18n="providerLocal">Local / Ollama (OpenAI-compatible)</option><option value="google" data-i18n="providerGoogle">Google Cloud Translation</option><option value="deepl" data-i18n="providerDeepl">DeepL</option><option value="openai" data-i18n="providerOpenai">OpenAI-compatible API</option></select></label><label><span data-i18n="apiEndpoint">API endpoint</span><input name="endpoint" type="url" placeholder="http://127.0.0.1:11434/v1" required></label><div class="form-row"><label><span data-i18n="model">Model</span><input name="model" autocomplete="off"></label><label><span data-i18n="targetLanguage">Target language</span><input name="targetLanguage" placeholder="vi" required></label></div><label><span data-i18n="apiKey">API key</span><input name="apiKey" type="password" autocomplete="off" data-i18n-placeholder="apiKeyPlaceholder" placeholder="Not needed for a local server"></label><label class="consent"><input name="allowCloud" type="checkbox"><span data-i18n="cloudConsent">I allow extracted document text to be sent to the selected cloud provider. Provider charges may apply.</span></label><p class="settings-help" data-i18n="settingsHelp">Local endpoints must use localhost. If the provider is unavailable, the original stays readable; no substitute translation is invented.</p><button class="primary" type="submit" data-i18n="applySettings">Apply & translate visible pages</button></form></dialog>
<dialog id="selection-dialog"><div class="dialog-heading"><h2 data-i18n="pairedReading">Paired reading view</h2><button id="selection-close" data-i18n-aria-label="closePaired" aria-label="Close paired view">${icon('close')}</button></div><div class="selection-columns"><section><h3 data-i18n="original">Original</h3><p id="selected-source"></p></section><section><h3 data-i18n="translation">Translation</h3><p id="selected-translation"></p></section></div><button id="selection-translate" class="primary" data-i18n="translateRegion">Translate this region</button><p class="settings-help" data-i18n="pairedHelp">Region-level correspondence. Word alignment is not inferred.</p></dialog>`;
apply(document);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let settings: TranslationSettings = { ...defaultSettings, glossary:{} };
const service = new TranslationService(browserTransport());
const translationQueue = new ViewportScheduler<void>(2);
const renderQueue = new ViewportScheduler<void>(2);
let pdf: PDFDocumentProxy | null = null;
let revision = 0, profile = 0, paused = false, full = false, zoom = 1, split = 50;
let activeTitle = '', activeSource = '', selected: TextBlock | null = null;
let requestController = new AbortController();
const translations = new Map<string,string>();
const errors = new Map<string,string>();
const rendered = new Map<number,RenderedPage>();
const pageNodes = new Map<number,HTMLElement>();
const visible = new Set<number>();
const imports: { name:string; bytes:Uint8Array; pages:number; opened:Date }[] = [];
let observer: IntersectionObserver | null = null;
let pageNumber = 1, pageTotal = 0;
let statusView: { text: () => string; error: boolean } = { text: () => t('ready'), error: false };
function renderStatus() { const element=$('status'); element.textContent=statusView.text(); element.classList.toggle('is-error',statusView.error); }
function setStatusText(text: () => string, error = false) { statusView={ text, error }; renderStatus(); }
function status(key: TranslationKey, error = false, vars?: Record<string,string|number>) { setStatusText(() => t(key, vars), error); }
function statusText(message: string, error = false) { setStatusText(() => message, error); }
function errorMessage(error: unknown) { return error instanceof Error?error.message:String(error); }
function canTranslate() { return settings.provider==='local' || settings.allowCloud; }
function providerName() { return settings.provider==='local'?t('providerLocalShort'):settings.provider==='deepl'?'DeepL':settings.provider==='google'?'Google':'OpenAI'; }
function updateProvider() { $('provider-label').textContent=`${providerName()} · ${settings.targetLanguage.toUpperCase()}`; }
function refreshTransportLabels() { $('pause').textContent=t(paused?'resume':'pause'); $('full').textContent=t(full?'stopFull':'translateAll'); }
function refreshBreadcrumb() { $('breadcrumb').textContent=$('library').hidden?activeTitle:t('myLibrary'); }
function refreshPageStatus() { $('page-status').textContent=pageTotal?t('pageStatus',{page:pageNumber,total:pageTotal}):t('pageInitial'); }
function renderSelectedTranslation() { if(selected) $('selected-translation').textContent=translations.get(selected.id)??errors.get(selected.id)??t('translationPending'); }
function refreshPageLoaders() { root.querySelectorAll<HTMLElement>('.page-loading').forEach(element=>{ if(element.dataset.loading==='page') element.textContent=t('pageLoading',{page:Number(element.dataset.page)}); else if(element.dataset.loading==='follow') element.textContent=t('translationFollows'); else if(element.dataset.loading==='scroll') element.textContent=t('scrollToRender'); }); }
function refreshRegionLabels() { root.querySelectorAll<HTMLElement>('.region').forEach(element=>{ if(element.classList.contains('callout-region')) { element.title=t('calloutTitle'); element.setAttribute('aria-label',t('calloutAria')); } else element.setAttribute('aria-label',t('compareRegion',{text:(element.dataset.text??'').slice(0,90)})); }); }
function refreshLibraryLabels() { root.querySelectorAll<HTMLElement>('[data-pages]').forEach(element=>{ element.textContent=t('pagesOpened',{pages:Number(element.dataset.pages)}); }); }
function resetWork() { revision++; profile++; requestController.abort(); requestController=new AbortController(); translationQueue.reset(); renderQueue.reset(); rendered.clear(); translations.clear(); errors.clear(); visible.clear(); observer?.disconnect(); full=false; paused=false; translationQueue.resume(); refreshTransportLabels(); }

async function load(bytes: Uint8Array,name: string,source = '') {
  resetWork(); const generation=revision;
  status('statusOpening');
  try {
    const previous=pdf; pdf=null; if (previous) void previous.destroy();
    const loaded = await openPdf(bytes.slice());
    if (generation!==revision) { void loaded.destroy(); return; }
    pdf=loaded; activeTitle=name; activeSource=source;
    if (!imports.some(item=>item.name===name && item.bytes.length===bytes.length)) imports.unshift({name,bytes:bytes.slice(),pages:loaded.numPages,opened:new Date()});
    updateLibrary(); $('library').hidden=true; $('reader').hidden=false;
    pageNumber=1; pageTotal=loaded.numPages;
    refreshBreadcrumb(); refreshPageStatus(); $('document-title').textContent=name;
    const link=$<HTMLAnchorElement>('original-link'); link.hidden=!source; if(source) link.href=source;
    const first=await loaded.getPage(1); const view=first.getViewport({scale:1});
    $('pages').replaceChildren(); pageNodes.clear();
    observer=new IntersectionObserver(entries=>{
      for (const entry of entries) {
        const number=Number((entry.target as HTMLElement).dataset.page);
        if(entry.isIntersecting) { visible.add(number); void ensurePage(number,0); if(number<loaded.numPages) void ensurePage(number+1,2); }
        else visible.delete(number);
      }
    },{root:$('reading-scroll'),rootMargin:'500px 0px'});
    for(let number=1;number<=loaded.numPages;number++) {
      const row=document.createElement('article'); row.className='page-pair'; row.dataset.page=String(number); row.style.setProperty('--page-ratio',String(view.width/view.height));
      row.innerHTML=`<div class="page-slot original-slot"><span class="page-loading" data-loading="page" data-page="${number}">${t('pageLoading',{page:number})}</span></div><div class="splitter" role="separator" tabindex="0" data-i18n-aria-label="resizePanes" aria-label="${t('resizePanes')}" aria-orientation="vertical" aria-valuemin="25" aria-valuemax="75" aria-valuenow="50"></div><div class="page-slot translated-slot"><span class="page-loading" data-loading="follow">${t('translationFollows')}</span></div><span class="page-number">${number}</span>`;
      apply(row);
      $('pages').append(row); pageNodes.set(number,row); observer.observe(row);
    }
    updateProvider(); applyScale(); await ensurePage(1,0);
    if(!canTranslate()) status('statusOriginalCloud');
    else status('statusOriginalTranslating');
  } catch(error) { if(generation===revision) status('statusOpenError',true,{message:errorMessage(error)}); }
}
async function ensurePage(number: number,priority: number): Promise<void> {
  if(!pdf || number<1 || number>pdf.numPages) return;
  const generation=revision, current=pdf;
  if(rendered.has(number)) { schedulePage(number,priority); return; }
  try { await renderQueue.enqueue(String(number),priority,async()=>{
    const result=await renderPage(current,number);
    if(generation!==revision) return;
    rendered.set(number,result); mountPage(result); schedulePage(number,priority);
    if(result.warning) statusText(result.warning);
    evictPages(number);
  }); } catch(error) { if(generation===revision) status('statusPageError',true,{page:number,message:errorMessage(error)}); }
}
function evictPages(keep: number) {
  if(rendered.size<=10) return;
  const candidates=[...rendered.keys()].filter(number=>!visible.has(number)&&number!==keep).sort((a,b)=>Math.abs(b-keep)-Math.abs(a-keep));
  while(rendered.size>8 && candidates.length) {
    const number=candidates.shift()!; rendered.delete(number);
    const row=pageNodes.get(number)!;
    row.querySelector('.original-slot')!.innerHTML=`<span class="page-loading" data-loading="scroll">${t('scrollToRender')}</span>`;
    row.querySelector('.translated-slot')!.replaceChildren();
  }
}
function mountPage(result: RenderedPage) {
  const row=pageNodes.get(result.model.number)!;
  row.style.setProperty('--page-ratio',String(result.model.width/result.model.height));
  const original=row.querySelector<HTMLElement>('.original-slot')!;
  original.replaceChildren(result.original); result.original.className='page-canvas';
  addRegions(original,result,false); paintMirror(result);
}
function addRegions(slot: HTMLElement,result: RenderedPage,translated: boolean) {
  for(const block of result.model.blocks) {
    const element=document.createElement('div'); element.className=`region ${translated?'mirror-region':'source-region'}`; element.dataset.region=block.id;
    element.style.left=`${block.rect.x/result.model.width*100}%`; element.style.top=`${block.rect.y/result.model.height*100}%`; element.style.width=`${block.rect.width/result.model.width*100}%`; element.style.height=`${block.rect.height/result.model.height*100}%`;
    element.tabIndex=0; element.role='button'; element.dataset.text=block.text; element.setAttribute('aria-label',t('compareRegion',{text:block.text.slice(0,90)})); element.textContent=translated?'':block.text;
    element.addEventListener('pointerenter',()=>highlight(block.id)); element.addEventListener('pointerleave',()=>highlight(selected?.id??''));
    element.addEventListener('focus',()=>highlight(block.id)); element.addEventListener('click',()=>selectBlock(block));
    element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ') {event.preventDefault();selectBlock(block);}});
    slot.append(element);
  }
}
function paintMirror(result: RenderedPage) {
  const slot=pageNodes.get(result.model.number)!.querySelector<HTMLElement>('.translated-slot')!;
  const canvas=document.createElement('canvas'); canvas.width=result.original.width; canvas.height=result.original.height; canvas.className='page-canvas';
  const context=canvas.getContext('2d')!; context.drawImage(result.original,0,0);
  const scale=canvas.width/result.model.width;
  const overlays: {block:TextBlock;text:string;size:number;lineHeight:number}[]=[];
  for(const block of result.model.blocks) {
    const text=translations.get(block.id); if(!text) continue;
    const fit=fitText(text,block.rect.width,block.rect.height,block.fontSize,(line,size)=>{context.font=`${size}px sans-serif`;return context.measureText(line).width;});
    const overlaps=result.model.blocks.some(other=>other.id!==block.id && other.rect.x<block.rect.x+block.rect.width && other.rect.x+other.rect.width>block.rect.x && other.rect.y<block.rect.y+block.rect.height && other.rect.y+other.rect.height>block.rect.y);
    if(!result.background || fit.overflow || overlaps) continue;
    const {x,y,width,height}=block.rect;
    context.drawImage(result.background,x*scale,y*scale,width*scale,height*scale,x*scale,y*scale,width*scale,height*scale);
    overlays.push({block,text:fit.lines.join('\n'),size:fit.fontSize,lineHeight:fit.lineHeight});
  }
  slot.replaceChildren(canvas); addRegions(slot,result,true);
  for(const block of result.model.blocks) {
    const element=slot.querySelector<HTMLElement>(`[data-region="${block.id}"]`)!;
    const overlay=overlays.find(item=>item.block.id===block.id);
    const text=translations.get(block.id);
    if(overlay) {
      element.classList.add('painted-region'); element.textContent=overlay.text;
      element.style.fontSize=`${overlay.size/result.model.width*100}cqw`; element.style.lineHeight=String(overlay.lineHeight/overlay.size); element.dir=block.direction;
    } else if(text) { element.classList.add('callout-region'); element.title=t('calloutTitle'); element.setAttribute('aria-label',t('calloutAria')); }
    else if(errors.has(block.id)) {element.classList.add('failed-region');element.title=errors.get(block.id)!;}
  }
  highlight(selected?.id??'');
}
function schedulePage(number: number,priority: number) {
  const result=rendered.get(number); if(!result || !canTranslate()) return;
  for(const block of result.model.blocks) scheduleBlock(block,priority);
}
function scheduleBlock(block: TextBlock,priority: number) {
  if(translations.has(block.id)||errors.has(block.id)||!canTranslate()) return;
  const generation=revision, currentProfile=profile, snapshot={...settings}, signal=requestController.signal;
  void translationQueue.enqueue(`${profile}:${block.id}`,priority,async()=>{
    try {
      const result=await service.translate({text:block.text,settings:snapshot,signal});
      if(generation!==revision||currentProfile!==profile) return;
      translations.set(block.id,result.text); errors.delete(block.id);
      const page=rendered.get(block.page); if(page) paintMirror(page);
      if(selected?.id===block.id) renderSelectedTranslation();
      setStatusText(() => t('statusTranslated', {count:translations.size, mode:t(paused?'modePaused':full?'modeFull':'modeVisible'), provider:providerName()}));
    } catch(error) {
      if(generation!==revision||currentProfile!==profile||signal.aborted) return;
      const message=errorMessage(error); errors.set(block.id,message); statusText(message,true);
      const page=rendered.get(block.page);if(page) paintMirror(page);
      if(selected?.id===block.id) renderSelectedTranslation();
    }
  }).catch(()=>undefined);
}
function highlight(id: string) { document.querySelectorAll<HTMLElement>('[data-region]').forEach(element=>element.classList.toggle('paired-highlight',element.dataset.region===id)); }
function selectBlock(block: TextBlock) {
  selected=block; highlight(block.id); $('selected-source').textContent=block.text;
  renderSelectedTranslation();
  $<HTMLDialogElement>('selection-dialog').showModal();
  scheduleBlock(block,-10);
}
function applyScale() { $('pages').style.setProperty('--zoom',String(zoom)); $('pages').style.setProperty('--split',`${split}%`); $('zoom-label').textContent=`${Math.round(zoom*100)}%`; }
function updateLibrary() {
  $('library-count').textContent=String(imports.length); $('document-count').textContent=String(imports.length); $('documents').replaceChildren();
  for(const item of imports) {
    const card=document.createElement('button'); card.className='document-card';
    card.innerHTML=`<div class="document-preview">${icon('file')}<div class="preview-lines"><i></i><i></i><i></i><i></i><i></i></div><span>PDF</span></div><div class="document-card-content"><strong></strong><span data-pages="${item.pages}">${t('pagesOpened',{pages:item.pages})}</span></div>`;
    card.querySelector('strong')!.textContent=item.name; card.addEventListener('click',()=>void load(item.bytes,item.name)); $('documents').append(card);
  }
}
const input=$<HTMLInputElement>('file-input');
document.querySelectorAll('[data-open]').forEach(button=>button.addEventListener('click',()=>input.click()));
input.addEventListener('change',async()=>{const files=[...(input.files??[])];for(const file of files) await load(new Uint8Array(await file.arrayBuffer()),file.name);input.value='';});
$('library-nav').addEventListener('click',()=>{ $('reader').hidden=true;$('library').hidden=false;refreshBreadcrumb(); });
root.querySelector('.brand')!.addEventListener('click',event=>{event.preventDefault();$('library-nav').click();});
window.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='o'){event.preventDefault();input.click();}});
window.addEventListener('dragover',event=>{event.preventDefault();root.classList.add('dragging');});
window.addEventListener('dragleave',event=>{if(!event.relatedTarget)root.classList.remove('dragging');});
window.addEventListener('drop',async event=>{event.preventDefault();root.classList.remove('dragging');const file=event.dataTransfer?.files[0];if(file)await load(new Uint8Array(await file.arrayBuffer()),file.name);});
$('zoom-in').addEventListener('click',()=>{zoom=Math.min(3,zoom+.1);applyScale();});
$('zoom-out').addEventListener('click',()=>{zoom=Math.max(.55,zoom-.1);applyScale();});
$('pause').addEventListener('click',()=>{paused=!paused;if(paused)translationQueue.pause();else translationQueue.resume();refreshTransportLabels();status(paused?'statusPaused':'statusResumed');});
$('retry').addEventListener('click',()=>{errors.clear();for(const number of visible)schedulePage(number,0);status('statusRetrying');});
$('full').addEventListener('click',async()=>{full=!full;refreshTransportLabels();if(!full){translationQueue.reset();for(const number of visible)schedulePage(number,0);return;}const generation=revision;for(let number=1;pdf&&number<=pdf.numPages&&full&&generation===revision;number++)await ensurePage(number,5);});
function changeProfile() {profile++; requestController.abort();requestController=new AbortController();translationQueue.reset();translations.clear();errors.clear();for(const page of rendered.values())paintMirror(page);for(const number of visible)schedulePage(number,0);updateProvider();status(canTranslate()?'statusSettingsApplied':'statusCloudNeeded');}
$('target-language').addEventListener('change',()=>{const value=$<HTMLInputElement>('target-language').value.trim();if(value){settings.targetLanguage=value;changeProfile();}});
const dialog=$<HTMLDialogElement>('settings-dialog');const form=$<HTMLFormElement>('settings-form');
$('settings-open').addEventListener('click',()=>{for(const [key,value]of Object.entries(settings)){const field=form.elements.namedItem(key);if(field instanceof HTMLInputElement){if(field.type==='checkbox')field.checked=Boolean(value);else field.value=String(value);}else if(field instanceof HTMLSelectElement)field.value=String(value);}dialog.showModal();});
$('settings-close').addEventListener('click',()=>dialog.close());
form.addEventListener('submit',event=>{event.preventDefault();const data=new FormData(form);settings={...settings,provider:data.get('provider') as TranslationSettings['provider'],endpoint:String(data.get('endpoint')),model:String(data.get('model')),apiKey:String(data.get('apiKey')),targetLanguage:String(data.get('targetLanguage')),allowCloud:data.has('allowCloud')};$<HTMLInputElement>('target-language').value=settings.targetLanguage;dialog.close();changeProfile();});
$('selection-close').addEventListener('click',()=>{$<HTMLDialogElement>('selection-dialog').close();selected=null;highlight('');});
$('selection-translate').addEventListener('click',()=>{if(selected){errors.delete(selected.id);if(!canTranslate()){status('statusCloudFirst',true);return;}scheduleBlock(selected,-100);}});
$('reset-split').addEventListener('click',()=>{split=50;applyScale();});
let drag=false;
$('pages').addEventListener('pointerdown',event=>{if((event.target as HTMLElement).classList.contains('splitter')){drag=true;(event.target as HTMLElement).setPointerCapture(event.pointerId);event.preventDefault();}});
$('pages').addEventListener('pointermove',event=>{if(drag){const rect=$('pages').getBoundingClientRect();split=Math.max(25,Math.min(75,(event.clientX-rect.left)/rect.width*100));applyScale();}});
$('pages').addEventListener('pointerup',()=>{drag=false;});
$('pages').addEventListener('keydown',event=>{if((event.target as HTMLElement).classList.contains('splitter')&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();split=Math.max(25,Math.min(75,split+(event.key==='ArrowLeft'?-2:2)));applyScale();(event.target as HTMLElement).setAttribute('aria-valuenow',String(split));}});
const viewRelay = new ViewRelayGuard();
for (const event of ['wheel', 'pointerdown', 'touchstart']) $('reading-scroll').addEventListener(event, () => viewRelay.userInput(), { capture: true, passive: true });
window.addEventListener('keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName)) viewRelay.userInput(); });
let scrollTimer: ReturnType<typeof setTimeout> | undefined;
$('reading-scroll').addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>{const bounds=$('reading-scroll').getBoundingClientRect();const row=[...pageNodes.values()].find(element=>element.getBoundingClientRect().bottom>bounds.top+30);if(row){const number=Number(row.dataset.page);const rect=row.getBoundingClientRect();const fraction=Math.max(0,Math.min(1,(bounds.top-rect.top)/rect.height));pageNumber=number;pageTotal=pdf?.numPages??0;refreshPageStatus();if(viewRelay.canRelay()) relayView(number,fraction,zoom);}},120);});
listenForLinkedView(state => {
  const row = pageNodes.get(state.page);
  if (!row) return;
  viewRelay.applyExternal();
  zoom = Math.max(.55, Math.min(3, state.zoom)); applyScale();
  $('reading-scroll').scrollTop = row.offsetTop + row.offsetHeight * state.fraction;
});
window.addEventListener('beforeunload',()=>{requestController.abort();translationQueue.reset();renderQueue.reset();});
refreshBreadcrumb(); refreshPageStatus(); refreshTransportLabels(); updateProvider();
subscribe(() => {
  apply(root);
  refreshTransportLabels();
  refreshBreadcrumb();
  refreshPageStatus();
  refreshLibraryLabels();
  refreshPageLoaders();
  refreshRegionLabels();
  renderSelectedTranslation();
  renderStatus();
  updateProvider();
});
document.addEventListener('click', event => {
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-locale]');
  if(button?.dataset.locale) setLocale(button.dataset.locale as Locale);
});
const fileUrl=new URLSearchParams(location.search).get('file');
if(fileUrl) {
  status('statusAcquiring');
  void fetchPdf(fileUrl).then(bytes=>{let name='Source document.pdf';try{name=decodeURIComponent(new URL(fileUrl).pathname.split('/').pop()||name);}catch{}return load(bytes,name,fileUrl);}).catch(error=>status('statusSourceError',true,{message:errorMessage(error)}));
}
