import './style.css';
import './ui/reader.css';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { defaultSettings, type TextBlock, type TranslationSettings } from './core/types';
import { TranslationService } from './core/translation';
import { TranslationError } from './core/retry';
import { parseGlossary, type GlossaryIssueCode, type GlossaryParseResult } from './core/glossary';
import { detectLanguage, normalizeLanguageCode, SUPPORTED_TARGETS } from './core/language';
import { ViewportScheduler } from './core/scheduler';
import { getOutline, getPageText, openPdf, renderPage, renderThumbnail, type OutlineEntry, type RenderedPage } from './pdf/document';
import { fitText, nextRotation, rotatePageSize, type PageRotation } from './pdf/layout';
import { browserTransport, fetchPdf, relayView, listenForLinkedView, ViewRelayGuard } from './ui/bridge';
import {
  apply, clampPageNumber, documentReadingKey, getLocale, initLocale, languageNativeName, LOCALES, localeLabel,
  setLocale, subscribe, t, type Locale, type TranslationKey,
} from './i18n';
import {
  fitScale, isAbortError, keyboardIntent, loadReadingState, pageForScroll, readingFraction, READING_STATE_KEY,
  saveReadingState, searchAllPages, type FitMode, type SearchMatch,
} from './ui/reader';
import { isCaptureRequest, mountCaptureReader, type CaptureReaderHandle } from './capture/reader';

initLocale();

const icon = (name: string) => {
  const paths: Record<string,string> = { book:'<path d="M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H3zM21 4h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h5z"/>', plus:'<path d="M12 5v14M5 12h14"/>', settings:'<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>', arrow:'<path d="m9 5 7 7-7 7"/>', file:'<path d="M14 2H5v20h14V7zM14 2v6h5M8 13h8M8 17h6"/>', upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>', check:'<path d="m5 12 4 4L19 6"/>' };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]??paths.file}</svg>`;
};
const root = document.querySelector<HTMLDivElement>('#app')!;
const targetOptions = (selected?: string) => SUPPORTED_TARGETS.map(target => `<option value="${target.code}"${target.code===selected?' selected':''}>${target.nativeName}</option>`).join('');
const localeSwitcher = () => `<div class="locale-switch" role="group" data-i18n-aria-label="languageSwitcher" aria-label="Language">${LOCALES.map(locale => `<button type="button" data-locale="${locale}" aria-pressed="${locale === getLocale()}">${localeLabel(locale)}</button>`).join('')}</div>`;
let settings: TranslationSettings = { ...defaultSettings, glossary:{} };

root.innerHTML = `<aside class="sidebar"><a class="brand" href="#" data-i18n-aria-label="libraryAria" aria-label="Mirror library">${icon('book')}<span>mirror<span class="brand-dot">.</span></span></a><button class="open-button" data-open>${icon('plus')} <span data-i18n="openPdf">Open PDF</span> <kbd>Ctrl O</kbd></button><div class="nav-label" data-i18n="workspaceLabel">YOUR WORKSPACE</div><button class="nav-item active" id="library-nav">${icon('book')} <span data-i18n="myLibrary">My library</span> <span id="library-count">0</span></button><div class="sidebar-note"><span class="small-orbit"></span><p><span data-i18n="sidebarNoteLead">A different language.</span><br><span data-i18n="sidebarNoteTail">The same perspective.</span></p></div><button class="nav-item settings-button" id="settings-open">${icon('settings')} <span data-i18n="settingsNav">Translation settings</span></button><div class="privacy-note"><span data-i18n="privacyLead">Documents stay in this session.</span><br><span data-i18n="privacyTail">Cloud translation is opt-in.</span></div></aside>
<main><header class="topbar"><div class="breadcrumb"><span data-i18n="workspace">Workspace</span>${icon('arrow')}<strong id="breadcrumb">My library</strong></div>${localeSwitcher()}<span class="local-badge"><i></i> <span data-i18n="localFirst">Local-first reading</span></span></header>
<section id="library" class="library"><div class="library-heading"><div><div class="eyebrow" data-i18n="libraryEyebrow">A LITTLE CLOSER TO UNDERSTANDING</div><h1 data-i18n="libraryTitle">Your reading room.</h1><p data-i18n="libraryLead">Keep the original. Find the meaning beside it.</p></div><button class="primary" data-open>${icon('plus')} <span data-i18n="importDocument">Import document</span></button></div><div class="library-section-heading"><h2><span data-i18n="allDocuments" style="color:inherit;font-size:inherit;margin-left:0">All documents</span> <span id="document-count">0</span></h2><span data-i18n="recentlyOpened">Recently opened</span></div><div id="documents" class="documents"></div><button class="drop-zone" data-open>${icon('upload')}<strong data-i18n="dropTitle">Your next good read belongs here</strong><span data-i18n="dropHint">Drop a PDF, or browse your files</span><small data-i18n="dropMeta">PDF documents · read locally · no account needed</small></button><div class="library-footnote"><span data-i18n="stepOpen">01 — OPEN</span><span data-i18n="stepRead">02 — READ SIDE BY SIDE</span><span data-i18n="stepUnderstand">03 — UNDERSTAND MORE</span></div></section>
<section id="reader" hidden><div class="reader-toolbar"><div class="document-heading"><div class="document-title" id="document-title"></div><span id="detected-language" class="detected-language" aria-live="polite" hidden></span></div><div class="toolbar-group reader-nav"><button id="prev-page" type="button" data-i18n-aria-label="previousPage" aria-label="${t('previousPage')}" disabled>‹</button><input id="page-input" class="page-input" type="number" min="1" value="1" inputmode="numeric" data-i18n-aria-label="pageInputAria" aria-label="${t('pageInputAria')}"><span class="page-total">/ <b id="page-total">0</b></span><button id="next-page" type="button" data-i18n-aria-label="nextPage" aria-label="${t('nextPage')}" disabled>›</button></div><div class="toolbar-group view-actions"><button id="fit-width" type="button" data-i18n="fitWidth">Fit width</button><button id="fit-page" type="button" data-i18n="fitPage">Fit page</button><button id="rotate" type="button" data-i18n="rotatePage">Rotate page</button><button id="outline-toggle" type="button" data-i18n="outlineToggle" aria-controls="reader-panel" aria-expanded="false">Outline</button><button id="search-toggle" type="button" data-i18n="searchToggle" aria-controls="reader-panel" aria-expanded="false">Search</button><button id="thumbnails-toggle" type="button" data-i18n="thumbnailsToggle" aria-controls="thumbnails" aria-expanded="false">Thumbnails</button></div><div class="toolbar-actions"><label class="language-label"><span data-i18n="targetLanguageLabel">To</span> <select id="target-language" data-i18n-aria-label="targetLanguageAria" aria-label="${t('targetLanguageAria')}">${targetOptions(settings.targetLanguage)}</select></label><button id="zoom-out" data-i18n-aria-label="zoomOut" aria-label="${t('zoomOut')}">−</button><output id="zoom-label">100%</output><button id="zoom-in" data-i18n-aria-label="zoomIn" aria-label="${t('zoomIn')}">+</button><button id="pause">Pause</button><button id="full">Translate all</button><button id="retry" data-i18n="retry">Retry</button><a id="original-link" target="_blank" rel="noopener" hidden><span data-i18n="openOriginal">Open original ↗</span></a></div></div><div class="pane-headings"><span><span data-i18n="originalHeading">ORIGINAL</span> <small data-i18n="originalNote">Unchanged source</small></span><span><span data-i18n="translatedHeading">TRANSLATED MIRROR</span> <small id="provider-label" data-i18n="providerInitial">Local · Vietnamese</small></span></div><div class="reader-body"><aside id="reader-panel" class="reader-panel reader-panel--overlay" data-i18n-aria-label="readerPanelAria" aria-label="${t('readerPanelAria')}" hidden></aside><div id="reading-scroll" class="reading-scroll"><div id="pages"></div></div><div id="thumbnails" class="reader-thumbstrip reader-thumbstrip--overlay" data-i18n-aria-label="thumbnailsToggle" aria-label="${t('thumbnailsToggle')}" hidden></div></div><div class="reader-bottom"><span id="page-status" data-i18n="pageInitial">Page 1</span><span><span data-i18n="linkedPages">Linked pages</span> <span class="linked-symbol">↔</span> <span data-i18n="selectRegionHint">Select any text region to compare</span></span><button id="reset-split" data-i18n="resetSplit">Reset split</button></div></section>
<div class="status-bar" id="status" role="status" aria-live="polite" data-i18n="ready">Ready when you are.</div></main>
<input type="file" id="file-input" accept="application/pdf,.pdf" hidden multiple>
<dialog id="settings-dialog"><form id="settings-form"><div class="dialog-heading"><div><span class="eyebrow" data-i18n="settingsEyebrow">MAKE IT YOURS</span><h2 data-i18n="translationSettings">Translation settings</h2></div><button type="button" id="settings-close" data-i18n-aria-label="closeSettings" aria-label="Close settings">${icon('close')}</button></div>${localeSwitcher()}<p class="dialog-description" data-i18n="settingsDescription">Only extracted text is sent to your chosen provider. Your PDF stays here. Credentials are kept in memory, not saved.</p><label><span data-i18n="providerLabel">Provider</span><select name="provider"><option value="local" data-i18n="providerLocal">Local / Ollama (OpenAI-compatible)</option><option value="google" data-i18n="providerGoogle">Google Cloud Translation</option><option value="deepl" data-i18n="providerDeepl">DeepL</option><option value="openai" data-i18n="providerOpenai">OpenAI-compatible API</option></select></label><label><span data-i18n="apiEndpoint">API endpoint</span><input name="endpoint" type="url" placeholder="http://127.0.0.1:11434/v1" required></label><label><span data-i18n="model">Model</span><input name="model" autocomplete="off"></label><div class="form-row"><label><span data-i18n="sourceLanguage">Source language</span><select name="sourceLanguage"><option value="auto" data-i18n="sourceAuto">Detect automatically</option>${targetOptions()}</select></label><label><span data-i18n="targetLanguage">Target language</span><select name="targetLanguage">${targetOptions()}</select></label></div><label><span data-i18n="apiKey">API key</span><input name="apiKey" type="password" autocomplete="off" data-i18n-placeholder="apiKeyPlaceholder" placeholder="Not needed for a local server"></label><label class="glossary-field"><span data-i18n="glossaryLabel">Glossary</span><textarea name="glossary" rows="5" spellcheck="false" data-i18n-placeholder="glossaryPlaceholder" placeholder="transformer = bộ biến đổi"></textarea></label><p class="settings-help" data-i18n="glossaryHelp">One term per line as "source = translation". Up to 200 terms.</p><p class="settings-help" data-i18n="glossaryProviderHint">Google and DeepL do not accept a custom glossary.</p><p id="glossary-status" class="glossary-status" role="status" aria-live="polite"></p><label class="consent"><input name="allowCloud" type="checkbox"><span data-i18n="cloudConsent">I allow extracted document text to be sent to the selected cloud provider. Provider charges may apply.</span></label><p class="settings-help" data-i18n="settingsHelp">Local endpoints must use localhost. If the provider is unavailable, the original stays readable; no substitute translation is invented.</p><button class="primary" type="submit" data-i18n="applySettings">Apply & translate visible pages</button></form></dialog>
<dialog id="selection-dialog"><div class="dialog-heading"><h2 data-i18n="pairedReading">Paired reading view</h2><button id="selection-close" data-i18n-aria-label="closePaired" aria-label="Close paired view">${icon('close')}</button></div><div class="selection-columns"><section><h3 data-i18n="original">Original</h3><p id="selected-source"></p></section><section><h3 data-i18n="translation">Translation</h3><p id="selected-translation"></p></section></div><button id="selection-translate" class="primary" data-i18n="translateRegion">Translate this region</button><p class="settings-help" data-i18n="pairedHelp">Region-level correspondence. Word alignment is not inferred.</p></dialog>`;
apply(document);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const storage = (): Storage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };
const service = new TranslationService(browserTransport());
const translationQueue = new ViewportScheduler<void>(2);
const renderQueue = new ViewportScheduler<void>(2);
let pdf: PDFDocumentProxy | null = null;
let revision = 0, profile = 0, paused = false, full = false, zoom = 1, split = 50;
let rotation: PageRotation = 0;
let fit: FitMode = 'width';
let rotating = false;
let activeTitle = '', activeSource = '', activeDocKey = '', selected: TextBlock | null = null;
let requestController = new AbortController();
let captureReader: CaptureReaderHandle | undefined;
const translations = new Map<string,string>();
const errors = new Map<string,string>();
const rendered = new Map<number,RenderedPage>();
const pageNodes = new Map<number,HTMLElement>();
const visible = new Set<number>();
const imports: { name:string; bytes:Uint8Array; pages:number; opened:Date }[] = [];
let observer: IntersectionObserver | null = null;
let pageNumber = 1, pageTotal = 0;
let pageSize = { width:612, height:792 };
let readingPosition = { page:1, fraction:0 };
let statusView: { text: () => string; error: boolean } = { text: () => t('ready'), error: false };
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let scrollTimer: ReturnType<typeof setTimeout> | undefined;
let panelKind: 'outline' | 'search' | null = null;
let outlineEntries: OutlineEntry[] = [];
let outlineReady = false, outlineLoading = false;
let searchController: AbortController | null = null;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searchInput: HTMLInputElement | null = null;
let searchStatus: HTMLElement | null = null;
let searchList: HTMLElement | null = null;
let lastSearchQuery = '';
let detectedCode = '';
let thumbObserver: IntersectionObserver | null = null;
let glossaryResult: GlossaryParseResult | null = null;
const GLOSSARY_ISSUE_KEY: Record<GlossaryIssueCode, TranslationKey> = {
  'missing-separator':'glossaryIssueMissingSeparator', 'empty-source':'glossaryIssueEmptySource', 'empty-target':'glossaryIssueEmptyTarget',
  'source-too-long':'glossaryIssueSourceTooLong', 'target-too-long':'glossaryIssueTargetTooLong', duplicate:'glossaryIssueDuplicate', 'entry-limit':'glossaryIssueEntryLimit',
};

function renderStatus() { const element=$('status'); element.textContent=statusView.text(); element.classList.toggle('is-error',statusView.error); }
function setStatusText(text: () => string, error = false) { statusView={ text, error }; renderStatus(); }
function status(key: TranslationKey, error = false, vars?: Record<string,string|number>) { setStatusText(() => t(key, vars), error); }
function statusText(message: string, error = false) { setStatusText(() => message, error); }
function errorMessage(error: unknown) { return error instanceof Error?error.message:String(error); }
function userMessage(error: unknown) { return error instanceof TranslationError ? error.userMessage : errorMessage(error); }
function canTranslate() { return settings.provider==='local' || settings.allowCloud; }
function providerName() { return settings.provider==='local'?t('providerLocalShort'):settings.provider==='deepl'?'DeepL':settings.provider==='google'?'Google':'OpenAI'; }
function updateProvider() { $('provider-label').textContent=`${providerName()} · ${languageNativeName(settings.targetLanguage)}`; }
function refreshTransportLabels() { $('pause').textContent=t(paused?'resume':'pause'); $('full').textContent=t(full?'stopFull':'translateAll'); }
function refreshBreadcrumb() { $('breadcrumb').textContent=$('library').hidden?activeTitle:t('myLibrary'); }
function updatePageControls() {
  const has=Boolean(pdf&&pageTotal);
  $<HTMLButtonElement>('prev-page').disabled=!has||pageNumber<=1;
  $<HTMLButtonElement>('next-page').disabled=!has||pageNumber>=pageTotal;
  const input=$<HTMLInputElement>('page-input'); input.max=String(Math.max(1,pageTotal)); if(document.activeElement!==input) input.value=String(pageNumber);
  $('page-total').textContent=String(pageTotal);
  updateCurrentMarkers();
}
function refreshPageStatus() { $('page-status').textContent=pageTotal?t('pageStatus',{page:pageNumber,total:pageTotal}):t('pageInitial'); updatePageControls(); }
function renderSelectedTranslation() { if(selected) $('selected-translation').textContent=translations.get(selected.id)??errors.get(selected.id)??t('translationPending'); }
function refreshPageLoaders() { root.querySelectorAll<HTMLElement>('.page-loading').forEach(element=>{ if(element.dataset.loading==='page') element.textContent=t('pageLoading',{page:Number(element.dataset.page)}); else if(element.dataset.loading==='follow') element.textContent=t('translationFollows'); else if(element.dataset.loading==='scroll') element.textContent=t('scrollToRender'); }); }
function refreshRegionLabels() { root.querySelectorAll<HTMLElement>('.region').forEach(element=>{ if(element.classList.contains('callout-region')) { element.title=t('calloutTitle'); element.setAttribute('aria-label',t('calloutAria')); } else element.setAttribute('aria-label',t('compareRegion',{text:(element.dataset.text??'').slice(0,90)})); }); }
function refreshLibraryLabels() { root.querySelectorAll<HTMLElement>('[data-pages]').forEach(element=>{ element.textContent=t('pagesOpened',{pages:Number(element.dataset.pages)}); }); }

function saveReadingNow() {
  if(!activeDocKey||!pdf) return;
  const store=storage(); if(store) saveReadingState(store, {page:pageNumber,fraction:readingPosition.fraction,zoom,fit}, activeDocKey);
}
function scheduleSave() {
  if(!activeDocKey) return;
  clearTimeout(saveTimer);
  saveTimer=setTimeout(saveReadingNow,300);
}
function updateRowRatios() {
  const size=rotatePageSize(pageSize,rotation);
  const ratio=size.width/Math.max(1,size.height);
  for(const row of pageNodes.values()) row.style.setProperty('--page-ratio',String(ratio));
}
function updateCurrentMarkers() {
  root.querySelectorAll<HTMLElement>('.reader-thumb').forEach(element=>{ if(Number(element.dataset.page)===pageNumber) element.setAttribute('aria-current','page'); else element.removeAttribute('aria-current'); });
  root.querySelectorAll<HTMLElement>('.reader-outline__item[data-page]').forEach(element=>{ if(Number(element.dataset.page)===pageNumber) element.setAttribute('aria-current','page'); else element.removeAttribute('aria-current'); });
}
function resetWork() {
  revision++; profile++; requestController.abort(); requestController=new AbortController();
  translationQueue.reset(); renderQueue.reset(); rendered.clear(); translations.clear(); errors.clear(); visible.clear();
  observer?.disconnect(); observer=null; full=false; paused=false; translationQueue.resume(); refreshTransportLabels();
  rotation=0; fit='width'; zoom=1; rotating=false; pageNumber=1; pageTotal=0; readingPosition={page:1,fraction:0}; activeDocKey='';
  outlineEntries=[]; outlineReady=false; outlineLoading=false;
  panelKind=null; $('reader-panel').hidden=true; $('outline-toggle').setAttribute('aria-expanded','false'); $('search-toggle').setAttribute('aria-expanded','false');
  searchController?.abort(); searchController=null; clearTimeout(searchTimer); lastSearchQuery=''; searchInput=null; searchStatus=null; searchList=null;
  toggleThumbnails(false);
  const hint=$('detected-language'); hint.hidden=true; hint.textContent=''; detectedCode='';
}

async function load(bytes: Uint8Array,name: string,source = '') {
  resetWork(); const generation=revision;
  status('statusOpening');
  try {
    const previous=pdf; pdf=null; if (previous) void previous.destroy();
    const loaded = await openPdf(bytes.slice());
    if (generation!==revision) { void loaded.destroy(); return; }
    pdf=loaded; activeTitle=name; activeSource=source; activeDocKey=documentReadingKey(name,bytes.length,READING_STATE_KEY);
    if (!imports.some(item=>item.name===name && item.bytes.length===bytes.length)) imports.unshift({name,bytes:bytes.slice(),pages:loaded.numPages,opened:new Date()});
    updateLibrary(); $('library').hidden=true; $('reader').hidden=false;
    pageNumber=1; pageTotal=loaded.numPages; refreshBreadcrumb(); refreshPageStatus(); $('document-title').textContent=name;
    const link=$<HTMLAnchorElement>('original-link'); link.hidden=!source; if(source) link.href=source;
    const first=await loaded.getPage(1); const view=first.getViewport({scale:1});
    pageSize={width:view.width,height:view.height};
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
    const saved=loadReadingState(storage(),activeDocKey);
    if(saved) { zoom=saved.zoom; fit=saved.fit; pageNumber=clampPageNumber(saved.page,loaded.numPages); readingPosition={page:pageNumber,fraction:saved.fraction}; }
    updateProvider(); applyScale(); updatePageControls(); await ensurePage(1,0);
    if(saved) scrollToPage(saved.page,saved.fraction);
    void showDetectedLanguage(loaded,generation);
    if(!canTranslate()) status('statusOriginalCloud');
    else status('statusOriginalTranslating');
  } catch(error) { if(generation===revision) status('statusOpenError',true,{message:errorMessage(error)}); }
}

async function showDetectedLanguage(document: PDFDocumentProxy,generation: number) {
  try {
    const text=(await getPageText(document,1)).map(item=>item.str).join(' ');
    if(generation!==revision) return;
    const detection=detectLanguage(text);
    detectedCode=detection.code==='unknown'||detection.confidence<=0?'':detection.code;
    renderDetectedLanguage();
  } catch { return; }
}
function renderDetectedLanguage() {
  const hint=$('detected-language');
  if(!detectedCode) { hint.hidden=true; hint.textContent=''; return; }
  hint.textContent=t('detectedLanguageHint',{language:languageNativeName(detectedCode)});
  hint.hidden=false;
}

async function ensurePage(number: number,priority: number): Promise<void> {
  if(!pdf || rotating || number<1 || number>pdf.numPages) return;
  const generation=revision, current=pdf;
  if(rendered.has(number)) { schedulePage(number,priority); return; }
  try { await renderQueue.enqueue(String(number),priority,async()=>{
    const result=await renderPage(current,number,{rotation});
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
      setStatusText(() => t('statusTranslated', {count:translations.size, chars:service.characterCount, mode:t(paused?'modePaused':full?'modeFull':'modeVisible'), provider:providerName()}));
    } catch(error) {
      if(generation!==revision||currentProfile!==profile||signal.aborted) return;
      const message=userMessage(error); errors.set(block.id,message); statusText(message,true);
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
function applyScale() {
  $('pages').style.setProperty('--zoom',String(zoom)); $('pages').style.setProperty('--split',`${split}%`); $('zoom-label').textContent=`${Math.round(zoom*100)}%`;
  $('fit-width').setAttribute('aria-pressed',String(fit==='width')); $('fit-page').setAttribute('aria-pressed',String(fit==='page'));
  scheduleSave();
}
function applyFit(mode: 'width'|'page') {
  fit=mode;
  const scroll=$('reading-scroll');
  const contentWidth=Math.max(240,scroll.clientWidth-44);
  const paneWidth=Math.max(120,contentWidth*split/100-9);
  const paneHeight=Math.max(160,scroll.clientHeight-80);
  const rotated=rotatePageSize(pageSize,rotation);
  const naturalHeight=paneWidth*rotated.height/Math.max(1,rotated.width);
  zoom=Math.max(.55,Math.min(3,fitScale(mode,{width:paneWidth,height:naturalHeight},{width:paneWidth,height:paneHeight})));
  applyScale();
}
function scrollToPage(number: number,fraction = 0) {
  if(!pdf) return;
  const target=clampPageNumber(number,pdf.numPages);
  const row=pageNodes.get(target); if(!row) return;
  const scroll=$('reading-scroll');
  scroll.scrollTop=row.offsetTop+Math.max(0,row.offsetHeight*Math.max(0,Math.min(1,fraction)));
  pageNumber=target; readingPosition={page:target,fraction:Math.max(0,Math.min(1,fraction))};
  refreshPageStatus(); scheduleSave(); void ensurePage(target,0);
  if(viewRelay.canRelay()) relayView(target,readingPosition.fraction,zoom);
}
function flashPage(number: number) {
  const row=pageNodes.get(number); if(!row) return;
  row.classList.add('is-search-hit'); setTimeout(()=>row.classList.remove('is-search-hit'),1600);
}

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
window.addEventListener('dragover',event=>{event.preventDefault();root.classList.add('dragging');});
window.addEventListener('dragleave',event=>{if(!event.relatedTarget)root.classList.remove('dragging');});
window.addEventListener('drop',async event=>{event.preventDefault();root.classList.remove('dragging');const file=event.dataTransfer?.files[0];if(file)await load(new Uint8Array(await file.arrayBuffer()),file.name);});
$('prev-page').addEventListener('click',()=>scrollToPage(pageNumber-1));
$('next-page').addEventListener('click',()=>scrollToPage(pageNumber+1));
$<HTMLInputElement>('page-input').addEventListener('change',()=>{ if(!pdf) return; scrollToPage(clampPageNumber(Number($<HTMLInputElement>('page-input').value),pdf.numPages)); });
$<HTMLInputElement>('page-input').addEventListener('keydown',event=>{ if(event.key==='Enter'){ event.preventDefault(); $<HTMLInputElement>('page-input').blur(); } });
$('fit-width').addEventListener('click',()=>applyFit('width'));
$('fit-page').addEventListener('click',()=>applyFit('page'));
$('outline-toggle').addEventListener('click',()=>{ panelKind==='outline'?closePanel():openPanel('outline'); });
$('search-toggle').addEventListener('click',()=>{ panelKind==='search'?(searchInput?.focus()):openPanel('search'); });
$('thumbnails-toggle').addEventListener('click',()=>toggleThumbnails());
$('rotate').addEventListener('click',()=>void rotateView());
$('zoom-in').addEventListener('click',()=>{fit='actual';zoom=Math.min(3,zoom+.1);applyScale();});
$('zoom-out').addEventListener('click',()=>{fit='actual';zoom=Math.max(.55,zoom-.1);applyScale();});
$('pause').addEventListener('click',()=>{paused=!paused;if(paused)translationQueue.pause();else translationQueue.resume();refreshTransportLabels();status(paused?'statusPaused':'statusResumed');});
$('retry').addEventListener('click',()=>{errors.clear();for(const number of visible)schedulePage(number,0);status('statusRetrying');});
$('full').addEventListener('click',async()=>{full=!full;refreshTransportLabels();if(!full){translationQueue.reset();for(const number of visible)schedulePage(number,0);return;}const generation=revision;for(let number=1;pdf&&number<=pdf.numPages&&full&&generation===revision;number++)await ensurePage(number,5);});
$<HTMLSelectElement>('target-language').addEventListener('change',()=>{const value=normalizeLanguageCode($<HTMLSelectElement>('target-language').value);if(value&&value!=='auto'){settings.targetLanguage=value;changeProfile();}});
function changeProfile() {profile++; requestController.abort();requestController=new AbortController();translationQueue.reset();translations.clear();errors.clear();for(const page of rendered.values())paintMirror(page);for(const number of visible)schedulePage(number,0);updateProvider();status(canTranslate()?'statusSettingsApplied':'statusCloudNeeded');}

function renderPanel() {
  const panel=$('reader-panel'); panel.replaceChildren();
  if(!panelKind) { panel.hidden=true; $('outline-toggle').setAttribute('aria-expanded','false'); $('search-toggle').setAttribute('aria-expanded','false'); return; }
  panel.hidden=false;
  const header=document.createElement('div'); header.className='reader-panel__header';
  const title=document.createElement('h2'); title.className='reader-panel__title'; title.textContent=t(panelKind==='outline'?'outlineToggle':'searchToggle');
  const close=document.createElement('button'); close.type='button'; close.className='reader-panel__close'; close.textContent='×'; close.setAttribute('aria-label',t('closePanel')); close.addEventListener('click',()=>closePanel());
  header.append(title,close); panel.append(header);
  if(panelKind==='outline') renderOutline(panel); else renderSearch(panel);
  $('outline-toggle').setAttribute('aria-expanded',String(panelKind==='outline'));
  $('search-toggle').setAttribute('aria-expanded',String(panelKind==='search'));
}
function openPanel(kind: 'outline'|'search') {
  panelKind=kind; renderPanel();
  if(kind==='search') { searchInput?.focus(); if(lastSearchQuery.trim()) void runSearch(lastSearchQuery); }
  else if(outlineReady) { const first=panelButtons()[0]; if(first) first.focus(); else $('outline-toggle').focus(); }
  else $('outline-toggle').focus();
  if(kind==='outline'&&!outlineReady&&!outlineLoading) void prepareOutline();
}
function closePanel() {
  if(!panelKind) { toggleThumbnails(false); return; }
  const trigger=panelKind==='search'?$('search-toggle'):$('outline-toggle');
  panelKind=null; searchController?.abort(); searchController=null; clearTimeout(searchTimer); renderPanel(); trigger.focus();
}
function panelButtons() { return [...$('reader-panel').querySelectorAll<HTMLButtonElement>('.reader-outline__item:not([disabled])')]; }
async function prepareOutline() {
  if(!pdf||outlineLoading) return;
  const doc=pdf, generation=revision; outlineLoading=true;
  try { const entries=await getOutline(doc); if(generation!==revision||pdf!==doc) return; outlineEntries=entries; outlineReady=true; if(panelKind==='outline') focusOutline(); }
  catch { if(generation===revision){ outlineEntries=[]; outlineReady=true; if(panelKind==='outline') focusOutline(); } }
  finally { if(generation===revision) outlineLoading=false; }
}
function focusOutline() {
  renderPanel(); const first=panelButtons()[0]; if(first) first.focus();
}
function renderOutline(panel: HTMLElement) {
  if(!outlineReady) { const loading=document.createElement('p'); loading.className='reader-panel__empty'; loading.textContent=t('outlineLoading'); panel.append(loading); return; }
  if(!outlineEntries.length) { const empty=document.createElement('p'); empty.className='reader-panel__empty'; empty.textContent=t('outlineEmpty'); panel.append(empty); return; }
  const list=document.createElement('ul'); list.className='reader-outline';
  for(const entry of outlineEntries) {
    const item=document.createElement('li');
    if(entry.page>0) {
      const button=document.createElement('button'); button.type='button'; button.className='reader-outline__item'; button.dataset.page=String(entry.page); button.style.setProperty('--outline-depth',String(entry.depth));
      const label=document.createElement('span'); label.className='reader-outline__label'; label.textContent=entry.title;
      const page=document.createElement('span'); page.className='reader-outline__page'; page.textContent=String(entry.page);
      button.append(label,page); button.addEventListener('click',()=>{ scrollToPage(entry.page); flashPage(entry.page); });
      if(entry.page===pageNumber) button.setAttribute('aria-current','page');
      item.append(button);
    } else {
      const label=document.createElement('div'); label.className='reader-outline__item'; label.style.setProperty('--outline-depth',String(entry.depth));
      const text=document.createElement('span'); text.className='reader-outline__label'; text.textContent=entry.title; label.append(text); item.append(label);
    }
    list.append(item);
  }
  panel.append(list);
}
function renderSearch(panel: HTMLElement) {
  const wrapper=document.createElement('div'); wrapper.className='reader-search';
  const field=document.createElement('div'); field.className='reader-search__field';
  const fieldInput=document.createElement('input'); fieldInput.type='search'; fieldInput.value=lastSearchQuery;
  fieldInput.placeholder=t('searchPlaceholder'); fieldInput.setAttribute('aria-label',t('searchPlaceholder'));
  fieldInput.addEventListener('input',scheduleSearch); field.append(fieldInput);
  const hint=document.createElement('p'); hint.className='reader-search__hint'; hint.textContent=t('searchHint');
  const statusLine=document.createElement('p'); statusLine.className='reader-search__status'; statusLine.setAttribute('role','status'); statusLine.setAttribute('aria-live','polite');
  const list=document.createElement('ul'); list.className='reader-search__results';
  wrapper.append(field,hint,statusLine,list); panel.append(wrapper);
  searchInput=fieldInput; searchStatus=statusLine; searchList=list;
  if(!lastSearchQuery.trim()) statusLine.textContent=t('searchHint');
}
function scheduleSearch() {
  lastSearchQuery=searchInput?.value??''; clearTimeout(searchTimer);
  if(searchStatus) searchStatus.textContent=lastSearchQuery.trim()?t('searchLoading'):t('searchHint');
  if(searchList) searchList.replaceChildren();
  if(!lastSearchQuery.trim()) { searchController?.abort(); searchController=null; return; }
  searchTimer=setTimeout(()=>void runSearch(lastSearchQuery),250);
}
async function runSearch(query: string) {
  const doc=pdf; if(!doc||!query.trim()) return;
  searchController?.abort(); const controller=new AbortController(); searchController=controller;
  const generation=revision;
  try {
    const matches=await searchAllPages(doc,query,{limit:50,signal:controller.signal});
    if(generation!==revision||pdf!==doc||controller.signal.aborted||query!==lastSearchQuery) return;
    if(searchStatus) searchStatus.textContent=matches.length?t('searchResults',{count:matches.length}):t('searchEmpty');
    renderSearchResults(matches);
  } catch(error) {
    if(isAbortError(error)||controller.signal.aborted) return;
    if(searchStatus) searchStatus.textContent=t('searchEmpty');
    statusText(userMessage(error),true);
  }
}
function renderSearchResults(matches: readonly SearchMatch[]) {
  if(!searchList) return;
  searchList.replaceChildren();
  for(const match of matches) {
    const item=document.createElement('li');
    const button=document.createElement('button'); button.type='button'; button.className='reader-search__result';
    const meta=document.createElement('span'); meta.className='reader-search__meta'; meta.textContent=t('searchResultPage',{page:match.page});
    const snippet=document.createElement('span'); snippet.textContent=match.snippet;
    button.append(meta,snippet); button.addEventListener('click',()=>{ scrollToPage(match.page); flashPage(match.page); });
    item.append(button); searchList.append(item);
  }
}
function buildThumbnails() {
  const strip=$('thumbnails'); strip.replaceChildren(); thumbObserver?.disconnect(); thumbObserver=null;
  if(!pdf) return;
  const doc=pdf;
  thumbObserver=new IntersectionObserver(entries=>{
    for(const entry of entries) {
      if(!entry.isIntersecting) continue;
      const button=entry.target as HTMLElement; thumbObserver?.unobserve(button); void loadThumbnail(doc,Number(button.dataset.page),button);
    }
  },{root:strip,rootMargin:'240px'});
  for(let number=1;number<=doc.numPages;number++) {
    const button=document.createElement('button'); button.type='button'; button.className='reader-thumb'; button.dataset.page=String(number); button.setAttribute('aria-label',t('searchResultPage',{page:number}));
    const skeleton=document.createElement('div'); skeleton.className='reader-thumb__skeleton';
    const label=document.createElement('span'); label.textContent=String(number);
    button.append(skeleton,label);
    button.addEventListener('click',()=>{ scrollToPage(number); flashPage(number); });
    strip.append(button); thumbObserver.observe(button);
  }
  updateCurrentMarkers();
}
async function loadThumbnail(doc: PDFDocumentProxy,number: number,button: HTMLElement) {
  try {
    const thumb=await renderThumbnail(doc,number,160);
    if(pdf!==doc||!button.isConnected) return;
    thumb.canvas.className='reader-thumb__canvas'; button.querySelector('.reader-thumb__skeleton')?.remove(); button.prepend(thumb.canvas);
  } catch { return; }
}
function toggleThumbnails(force?: boolean) {
  const strip=$('thumbnails'); const show=force??strip.hidden;
  strip.hidden=!show; $('thumbnails-toggle').setAttribute('aria-expanded',String(show));
  if(show) { buildThumbnails(); }
  else if(force===false) { thumbObserver?.disconnect(); thumbObserver=null; strip.replaceChildren(); }
  else { thumbObserver?.disconnect(); thumbObserver=null; }
}
async function rotateView() {
  if(!pdf||rotating) return;
  const current=pdf; revision++; const generation=revision;
  rotating=true; profile++; requestController.abort(); requestController=new AbortController(); translationQueue.reset(); renderQueue.reset();
  rotation=nextRotation(rotation,90); const previous=new Map(rendered); rendered.clear(); updateRowRatios();
  try {
    for(const [number,result] of previous) {
      if(generation!==revision||pdf!==current) return;
      const texts=new Map<string,string>(), failures=new Map<string,string>();
      for(const block of result.model.blocks) { const text=translations.get(block.id); if(text) texts.set(block.text,text); const failure=errors.get(block.id); if(failure) failures.set(block.text,failure); }
      for(const id of [...translations.keys()]) if(id.startsWith(`p${number}-r`)) translations.delete(id);
      for(const id of [...errors.keys()]) if(id.startsWith(`p${number}-r`)) errors.delete(id);
      let fresh: RenderedPage;
      try { fresh=await renderPage(current,number,{rotation}); } catch { continue; }
      for(const block of fresh.model.blocks) { const text=texts.get(block.text); if(text) translations.set(block.id,text); const failure=failures.get(block.text); if(failure) errors.set(block.id,failure); }
      rendered.set(number,fresh); mountPage(fresh);
    }
  } finally {
    rotating=false;
    if(generation===revision&&pdf===current) {
      if(fit==='width'||fit==='page') applyFit(fit); else applyScale();
      for(const number of visible) void ensurePage(number,0);
      status('statusRotated',false,{degrees:rotation});
      scheduleSave();
      if(!$('thumbnails').hidden) buildThumbnails();
    }
  }
}

const dialog=$<HTMLDialogElement>('settings-dialog');const form=$<HTMLFormElement>('settings-form');
function setFormValue(name: string,value: string) { const field=form.elements.namedItem(name); if(field instanceof HTMLInputElement||field instanceof HTMLSelectElement||field instanceof HTMLTextAreaElement) field.value=value; }
function syncToolbarTarget() { const select=$<HTMLSelectElement>('target-language'); if([...select.options].some(option=>option.value===settings.targetLanguage)) select.value=settings.targetLanguage; }
function renderGlossaryStatus() {
  const element=$('glossary-status');
  if(!glossaryResult) { element.textContent=''; return; }
  const first=glossaryResult.issues[0];
  element.textContent=first
    ? t('glossaryAcceptedIssue',{count:glossaryResult.entries.length,line:first.line,message:t(GLOSSARY_ISSUE_KEY[first.code])})
    : t('glossaryAccepted',{count:glossaryResult.entries.length});
}
function fillSettingsForm() {
  setFormValue('provider',settings.provider); setFormValue('endpoint',settings.endpoint); setFormValue('model',settings.model);
  setFormValue('apiKey',settings.apiKey); setFormValue('sourceLanguage',normalizeLanguageCode(settings.sourceLanguage)); setFormValue('targetLanguage',settings.targetLanguage);
  setFormValue('glossary',Object.entries(settings.glossary).map(([source,target])=>`${source} = ${target}`).join('\n'));
  const cloud=form.elements.namedItem('allowCloud'); if(cloud instanceof HTMLInputElement) cloud.checked=settings.allowCloud;
  glossaryResult={entries:Object.entries(settings.glossary).map(([source,target])=>({source,target})),issues:[]}; renderGlossaryStatus();
}
$('settings-open').addEventListener('click',()=>{fillSettingsForm();dialog.showModal();});
$('settings-close').addEventListener('click',()=>dialog.close());
form.addEventListener('submit',event=>{
  event.preventDefault(); const data=new FormData(form);
  const parsed=parseGlossary(String(data.get('glossary')??'')); glossaryResult=parsed; renderGlossaryStatus();
  const glossary=Object.fromEntries(parsed.entries.map(entry=>[entry.source,entry.target]));
  if(parsed.issues.length) { settings={...settings,glossary}; return; }
  settings={...settings,provider:data.get('provider') as TranslationSettings['provider'],endpoint:String(data.get('endpoint')),model:String(data.get('model')),apiKey:String(data.get('apiKey')),sourceLanguage:normalizeLanguageCode(String(data.get('sourceLanguage')??'auto')),targetLanguage:normalizeLanguageCode(String(data.get('targetLanguage')??'vi')),glossary,allowCloud:data.has('allowCloud')};
  syncToolbarTarget(); updateProvider(); dialog.close(); changeProfile();
  if(parsed.entries.length&&canTranslate()) status('statusGlossaryApplied',false,{count:parsed.entries.length});
});
syncToolbarTarget();
$('selection-close').addEventListener('click',()=>{$<HTMLDialogElement>('selection-dialog').close();selected=null;highlight('');});
$('selection-translate').addEventListener('click',()=>{if(selected){errors.delete(selected.id);if(!canTranslate()){status('statusCloudFirst',true);return;}scheduleBlock(selected,-100);}});
$('reset-split').addEventListener('click',()=>{split=50;applyScale();});
let drag=false;
$('pages').addEventListener('pointerdown',event=>{if((event.target as HTMLElement).classList.contains('splitter')){drag=true;(event.target as HTMLElement).setPointerCapture(event.pointerId);event.preventDefault();}});
$('pages').addEventListener('pointermove',event=>{if(drag){const rect=$('pages').getBoundingClientRect();split=Math.max(25,Math.min(75,(event.clientX-rect.left)/rect.width*100));applyScale();}});
$('pages').addEventListener('pointerup',()=>{if(drag&&(fit==='width'||fit==='page'))applyFit(fit);drag=false;});
$('pages').addEventListener('keydown',event=>{if((event.target as HTMLElement).classList.contains('splitter')&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();split=Math.max(25,Math.min(75,split+(event.key==='ArrowLeft'?-2:2)));applyScale();(event.target as HTMLElement).setAttribute('aria-valuenow',String(split));}});
const viewRelay = new ViewRelayGuard();
for (const event of ['wheel', 'pointerdown', 'touchstart']) $('reading-scroll').addEventListener(event, () => viewRelay.userInput(), { capture: true, passive: true });
window.addEventListener('keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key) && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName)) viewRelay.userInput(); });
$('reading-scroll').addEventListener('scroll',()=>{
  clearTimeout(scrollTimer);
  scrollTimer=setTimeout(()=>{
    if(!pdf) return;
    const scroll=$('reading-scroll');
    const rows=[...pageNodes.entries()].map(([page,element])=>({page,top:element.offsetTop,height:element.offsetHeight}));
    pageNumber=pageForScroll(rows,scroll.scrollTop);
    const fraction=readingFraction(rows,scroll.scrollTop);
    readingPosition={page:pageNumber,fraction}; refreshPageStatus(); scheduleSave();
    if(viewRelay.canRelay()) relayView(pageNumber,fraction,zoom);
  },120);
});
listenForLinkedView(state => {
  const row = pageNodes.get(state.page);
  if (!row) return;
  viewRelay.applyExternal();
  zoom = Math.max(.55, Math.min(3, state.zoom)); applyScale();
  $('reading-scroll').scrollTop = row.offsetTop + row.offsetHeight * state.fraction;
});
function handleIntent(event: KeyboardEvent) {
  if(document.querySelector('dialog[open]')) return;
  if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='o') { event.preventDefault(); input.click(); return; }
  if($('reader').hidden) return;
  if(event.key==='Escape'&&panelKind) { event.preventDefault(); closePanel(); return; }
  const intent=keyboardIntent(event);
  if(intent==='none') return;
  event.preventDefault();
  switch(intent) {
    case 'next-page': scrollToPage(pageNumber+1); break;
    case 'prev-page': scrollToPage(pageNumber-1); break;
    case 'zoom-in': fit='actual'; zoom=Math.min(3,zoom+.1); applyScale(); break;
    case 'zoom-out': fit='actual'; zoom=Math.max(.55,zoom-.1); applyScale(); break;
    case 'fit-width': applyFit('width'); break;
    case 'fit-page': applyFit('page'); break;
    case 'search': if(panelKind==='search') searchInput?.focus(); else openPanel('search'); break;
    case 'outline': if(panelKind==='outline') panelButtons()[0]?.focus(); else openPanel('outline'); break;
    case 'escape': if(panelKind) closePanel(); else toggleThumbnails(false); break;
    default: break;
  }
}
window.addEventListener('keydown',handleIntent);
window.addEventListener('beforeunload',()=>{captureReader?.destroy();saveReadingNow();requestController.abort();translationQueue.reset();renderQueue.reset();});
applyScale();
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
  renderGlossaryStatus();
  renderDetectedLanguage();
  renderStatus();
  updateProvider();
  if(panelKind) renderPanel();
  if(panelKind==='search'&&lastSearchQuery.trim()) void runSearch(lastSearchQuery);
  if(!$('thumbnails').hidden) updateCurrentMarkers();
});
document.addEventListener('click', event => {
  const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-locale]');
  if(button?.dataset.locale) setLocale(button.dataset.locale as Locale);
});
if (isCaptureRequest(location.search)) {
  const host=document.createElement('div'); host.id='capture-root'; document.body.append(host);
  root.setAttribute('hidden','');
  void mountCaptureReader({
    root: host,
    signal: requestController.signal,
    translate: async text => (await service.translate({ text, settings: { ...settings }, signal: requestController.signal })).text,
    onBack: () => window.location.assign(window.location.pathname),
  }).then(handle => { captureReader = handle; });
}

const fileUrl=new URLSearchParams(location.search).get('file');
if(fileUrl) {
  status('statusAcquiring');
  void fetchPdf(fileUrl).then(bytes=>{let name='Source document.pdf';try{name=decodeURIComponent(new URL(fileUrl).pathname.split('/').pop()||name);}catch{}return load(bytes,name,fileUrl);}).catch(error=>status('statusSourceError',true,{message:errorMessage(error)}));
}
