import './style.css';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { defaultSettings, type TextBlock, type TranslationSettings } from './core/types';
import { TranslationService } from './core/translation';
import { ViewportScheduler } from './core/scheduler';
import { openPdf, renderPage, type RenderedPage } from './pdf/document';
import { fitText } from './pdf/layout';
import { browserTransport, fetchPdf, relayView, hasExtension, listenForLinkedView, ViewRelayGuard } from './ui/bridge';

const icon = (name: string) => {
  const paths: Record<string,string> = { book:'<path d="M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H3zM21 4h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h5z"/>', plus:'<path d="M12 5v14M5 12h14"/>', settings:'<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>', arrow:'<path d="m9 5 7 7-7 7"/>', file:'<path d="M14 2H5v20h14V7zM14 2v6h5M8 13h8M8 17h6"/>', upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>', close:'<path d="m6 6 12 12M6 18 18 6"/>', check:'<path d="m5 12 4 4L19 6"/>' };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]??paths.file}</svg>`;
};
const root = document.querySelector<HTMLDivElement>('#app')!;
root.innerHTML = `<aside class="sidebar"><a class="brand" href="#" aria-label="Mirror library">${icon('book')}<span>mirror<span class="brand-dot">.</span></span></a><button class="open-button" data-open>${icon('plus')} Open PDF <kbd>Ctrl O</kbd></button><div class="nav-label">YOUR WORKSPACE</div><button class="nav-item active" id="library-nav">${icon('book')} My library <span id="library-count">0</span></button><div class="sidebar-note"><span class="small-orbit"></span><p>A different language.<br>The same perspective.</p></div><button class="nav-item settings-button" id="settings-open">${icon('settings')} Translation settings</button><div class="privacy-note">Documents stay in this session.<br>Cloud translation is opt-in.</div></aside>
<main><header class="topbar"><div class="breadcrumb"><span>Workspace</span>${icon('arrow')}<strong id="breadcrumb">My library</strong></div><span class="local-badge"><i></i> Local-first reading</span></header>
<section id="library" class="library"><div class="library-heading"><div><div class="eyebrow">A LITTLE CLOSER TO UNDERSTANDING</div><h1>Your reading room.</h1><p>Keep the original. Find the meaning beside it.</p></div><button class="primary" data-open>${icon('plus')} Import document</button></div><div class="library-section-heading"><h2>All documents <span id="document-count">0</span></h2><span>Recently opened</span></div><div id="documents" class="documents"></div><button class="drop-zone" data-open>${icon('upload')}<strong>Your next good read belongs here</strong><span>Drop a PDF, or browse your files</span><small>PDF documents · read locally · no account needed</small></button><div class="library-footnote"><span>01 — OPEN</span><span>02 — READ SIDE BY SIDE</span><span>03 — UNDERSTAND MORE</span></div></section>
<section id="reader" hidden><div class="reader-toolbar"><div class="document-title" id="document-title"></div><div class="toolbar-actions"><label class="language-label">To <input id="target-language" value="vi" aria-label="Target language code" maxlength="12"></label><button id="zoom-out" aria-label="Zoom out">−</button><output id="zoom-label">100%</output><button id="zoom-in" aria-label="Zoom in">+</button><button id="pause">Pause</button><button id="full">Translate all</button><button id="retry">Retry</button><a id="original-link" target="_blank" rel="noopener" hidden>Open original ↗</a></div></div><div class="pane-headings"><span>ORIGINAL <small>Unchanged source</small></span><span>TRANSLATED MIRROR <small id="provider-label">Local · Vietnamese</small></span></div><div id="reading-scroll" class="reading-scroll"><div id="pages"></div></div><div class="reader-bottom"><span id="page-status">Page 1</span><span>Linked pages <span class="linked-symbol">↔</span> Select any text region to compare</span><button id="reset-split">Reset split</button></div></section>
<div class="status-bar" id="status" role="status" aria-live="polite">Ready when you are.</div></main>
<input type="file" id="file-input" accept="application/pdf,.pdf" hidden multiple>
<dialog id="settings-dialog"><form id="settings-form"><div class="dialog-heading"><div><span class="eyebrow">MAKE IT YOURS</span><h2>Translation settings</h2></div><button type="button" id="settings-close" aria-label="Close settings">${icon('close')}</button></div><p class="dialog-description">Only extracted text is sent to your chosen provider. Your PDF stays here. Credentials are kept in memory, not saved.</p><label>Provider<select name="provider"><option value="local">Local / Ollama (OpenAI-compatible)</option><option value="google">Google Cloud Translation</option><option value="deepl">DeepL</option><option value="openai">OpenAI-compatible API</option></select></label><label>API endpoint<input name="endpoint" type="url" placeholder="http://127.0.0.1:11434/v1" required></label><div class="form-row"><label>Model<input name="model" autocomplete="off"></label><label>Target language<input name="targetLanguage" placeholder="vi" required></label></div><label>API key<input name="apiKey" type="password" autocomplete="off" placeholder="Not needed for a local server"></label><label class="consent"><input name="allowCloud" type="checkbox"><span>I allow extracted document text to be sent to the selected cloud provider. Provider charges may apply.</span></label><p class="settings-help">Local endpoints must use localhost. If the provider is unavailable, the original stays readable; no substitute translation is invented.</p><button class="primary" type="submit">Apply & translate visible pages</button></form></dialog>
<dialog id="selection-dialog"><div class="dialog-heading"><h2>Paired reading view</h2><button id="selection-close" aria-label="Close paired view">${icon('close')}</button></div><div class="selection-columns"><section><h3>Original</h3><p id="selected-source"></p></section><section><h3>Translation</h3><p id="selected-translation"></p></section></div><button id="selection-translate" class="primary">Translate this region</button><p class="settings-help">Region-level correspondence. Word alignment is not inferred.</p></dialog>`;
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
function status(message: string, error = false) { $('status').textContent=message; $('status').classList.toggle('is-error',error); }
function errorMessage(error: unknown) { return error instanceof Error?error.message:String(error); }
function canTranslate() { return settings.provider==='local' || settings.allowCloud; }
function updateProvider() { $('provider-label').textContent=`${settings.provider==='local'?'Local':settings.provider} · ${settings.targetLanguage.toUpperCase()}`; }
function resetWork() { revision++; profile++; requestController.abort(); requestController=new AbortController(); translationQueue.reset(); renderQueue.reset(); rendered.clear(); translations.clear(); errors.clear(); visible.clear(); observer?.disconnect(); full=false; paused=false; translationQueue.resume(); $('pause').textContent='Pause'; $('full').textContent='Translate all'; }

async function load(bytes: Uint8Array,name: string,source = '') {
  resetWork(); const generation=revision;
  status('Opening PDF and extracting page geometry…');
  try {
    const previous=pdf; pdf=null; if (previous) void previous.destroy();
    const loaded = await openPdf(bytes.slice());
    if (generation!==revision) { void loaded.destroy(); return; }
    pdf=loaded; activeTitle=name; activeSource=source;
    if (!imports.some(item=>item.name===name && item.bytes.length===bytes.length)) imports.unshift({name,bytes:bytes.slice(),pages:loaded.numPages,opened:new Date()});
    updateLibrary(); $('library').hidden=true; $('reader').hidden=false;
    $('breadcrumb').textContent=name; $('document-title').textContent=name;
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
      row.innerHTML=`<div class="page-slot original-slot"><span class="page-loading">${number} · Loading page</span></div><div class="splitter" role="separator" tabindex="0" aria-label="Resize original and translated panes" aria-orientation="vertical" aria-valuemin="25" aria-valuemax="75" aria-valuenow="50"></div><div class="page-slot translated-slot"><span class="page-loading">Translation follows the original</span></div><span class="page-number">${number}</span>`;
      $('pages').append(row); pageNodes.set(number,row); observer.observe(row);
    }
    updateProvider(); applyScale(); await ensurePage(1,0);
    if(!canTranslate()) status('Original ready. Enable cloud consent in Translation settings to begin.');
    else status('Original ready. Translating visible pages first…');
  } catch(error) { if(generation===revision) status(`Cannot open this document: ${errorMessage(error)} Choose a local PDF to try again.`,true); }
}
async function ensurePage(number: number,priority: number): Promise<void> {
  if(!pdf || number<1 || number>pdf.numPages) return;
  const generation=revision, current=pdf;
  if(rendered.has(number)) { schedulePage(number,priority); return; }
  try { await renderQueue.enqueue(String(number),priority,async()=>{
    const result=await renderPage(current,number);
    if(generation!==revision) return;
    rendered.set(number,result); mountPage(result); schedulePage(number,priority);
    if(result.warning) status(result.warning);
    evictPages(number);
  }); } catch(error) { if(generation===revision) status(`Page ${number}: ${errorMessage(error)}`,true); }
}
function evictPages(keep: number) {
  if(rendered.size<=10) return;
  const candidates=[...rendered.keys()].filter(number=>!visible.has(number)&&number!==keep).sort((a,b)=>Math.abs(b-keep)-Math.abs(a-keep));
  while(rendered.size>8 && candidates.length) {
    const number=candidates.shift()!; rendered.delete(number);
    const row=pageNodes.get(number)!;
    row.querySelector('.original-slot')!.innerHTML='<span class="page-loading">Scroll here to render</span>';
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
    element.tabIndex=0; element.role='button'; element.setAttribute('aria-label',`Compare region: ${block.text.slice(0,90)}`); element.textContent=translated?'':block.text;
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
    } else if(text) { element.classList.add('callout-region'); element.title='Translation is complete. Open paired reading view to read without clipping.'; element.setAttribute('aria-label','Read complete translation in paired reading view'); }
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
      if(selected?.id===block.id) $('selected-translation').textContent=result.text;
      status(`${translations.size} regions translated · ${paused?'Paused':full?'Full document':'Visible pages first'} · ${settings.provider}`);
    } catch(error) {
      if(generation!==revision||currentProfile!==profile||signal.aborted) return;
      const message=errorMessage(error); errors.set(block.id,message); status(message,true);
      const page=rendered.get(block.page);if(page) paintMirror(page);
      if(selected?.id===block.id) $('selected-translation').textContent=message;
    }
  }).catch(()=>undefined);
}
function highlight(id: string) { document.querySelectorAll<HTMLElement>('[data-region]').forEach(element=>element.classList.toggle('paired-highlight',element.dataset.region===id)); }
function selectBlock(block: TextBlock) {
  selected=block; highlight(block.id); $('selected-source').textContent=block.text;
  $('selected-translation').textContent=translations.get(block.id)??errors.get(block.id)??'Translation pending. Select “Translate this region” to prioritize it.';
  $<HTMLDialogElement>('selection-dialog').showModal();
  scheduleBlock(block,-10);
}
function applyScale() { $('pages').style.setProperty('--zoom',String(zoom)); $('pages').style.setProperty('--split',`${split}%`); $('zoom-label').textContent=`${Math.round(zoom*100)}%`; }
function updateLibrary() {
  $('library-count').textContent=String(imports.length); $('document-count').textContent=String(imports.length); $('documents').replaceChildren();
  for(const item of imports) {
    const card=document.createElement('button'); card.className='document-card';
    card.innerHTML=`<div class="document-preview">${icon('file')}<div class="preview-lines"><i></i><i></i><i></i><i></i><i></i></div><span>PDF</span></div><div class="document-card-content"><strong></strong><span>${item.pages} pages <b>·</b> Opened this session</span></div>`;
    card.querySelector('strong')!.textContent=item.name; card.addEventListener('click',()=>void load(item.bytes,item.name)); $('documents').append(card);
  }
}
const input=$<HTMLInputElement>('file-input');
document.querySelectorAll('[data-open]').forEach(button=>button.addEventListener('click',()=>input.click()));
input.addEventListener('change',async()=>{const files=[...(input.files??[])];for(const file of files) await load(new Uint8Array(await file.arrayBuffer()),file.name);input.value='';});
$('library-nav').addEventListener('click',()=>{ $('reader').hidden=true;$('library').hidden=false;$('breadcrumb').textContent='My library'; });
root.querySelector('.brand')!.addEventListener('click',event=>{event.preventDefault();$('library-nav').click();});
window.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='o'){event.preventDefault();input.click();}});
window.addEventListener('dragover',event=>{event.preventDefault();root.classList.add('dragging');});
window.addEventListener('dragleave',event=>{if(!event.relatedTarget)root.classList.remove('dragging');});
window.addEventListener('drop',async event=>{event.preventDefault();root.classList.remove('dragging');const file=event.dataTransfer?.files[0];if(file)await load(new Uint8Array(await file.arrayBuffer()),file.name);});
$('zoom-in').addEventListener('click',()=>{zoom=Math.min(3,zoom+.1);applyScale();});
$('zoom-out').addEventListener('click',()=>{zoom=Math.max(.55,zoom-.1);applyScale();});
$('pause').addEventListener('click',()=>{paused=!paused;if(paused)translationQueue.pause();else translationQueue.resume();$('pause').textContent=paused?'Resume':'Pause';status(paused?'Paused. In-flight requests may finish; no new translations will start.':'Translation resumed.');});
$('retry').addEventListener('click',()=>{errors.clear();for(const number of visible)schedulePage(number,0);status('Retrying visible regions…');});
$('full').addEventListener('click',async()=>{full=!full;$('full').textContent=full?'Stop full translation':'Translate all';if(!full){translationQueue.reset();for(const number of visible)schedulePage(number,0);return;}const generation=revision;for(let number=1;pdf&&number<=pdf.numPages&&full&&generation===revision;number++)await ensurePage(number,5);});
function changeProfile() {profile++; requestController.abort();requestController=new AbortController();translationQueue.reset();translations.clear();errors.clear();for(const page of rendered.values())paintMirror(page);for(const number of visible)schedulePage(number,0);updateProvider();status(canTranslate()?'Settings applied. Translating visible pages…':'Cloud translation needs your explicit consent in settings.');}
$('target-language').addEventListener('change',()=>{const value=$<HTMLInputElement>('target-language').value.trim();if(value){settings.targetLanguage=value;changeProfile();}});
const dialog=$<HTMLDialogElement>('settings-dialog');const form=$<HTMLFormElement>('settings-form');
$('settings-open').addEventListener('click',()=>{for(const [key,value]of Object.entries(settings)){const field=form.elements.namedItem(key);if(field instanceof HTMLInputElement){if(field.type==='checkbox')field.checked=Boolean(value);else field.value=String(value);}else if(field instanceof HTMLSelectElement)field.value=String(value);}dialog.showModal();});
$('settings-close').addEventListener('click',()=>dialog.close());
form.addEventListener('submit',event=>{event.preventDefault();const data=new FormData(form);settings={...settings,provider:data.get('provider') as TranslationSettings['provider'],endpoint:String(data.get('endpoint')),model:String(data.get('model')),apiKey:String(data.get('apiKey')),targetLanguage:String(data.get('targetLanguage')),allowCloud:data.has('allowCloud')};$<HTMLInputElement>('target-language').value=settings.targetLanguage;dialog.close();changeProfile();});
$('selection-close').addEventListener('click',()=>{$<HTMLDialogElement>('selection-dialog').close();selected=null;highlight('');});
$('selection-translate').addEventListener('click',()=>{if(selected){errors.delete(selected.id);if(!canTranslate()){status('Enable cloud consent in Translation settings first.',true);return;}scheduleBlock(selected,-100);}});
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
$('reading-scroll').addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>{const bounds=$('reading-scroll').getBoundingClientRect();const row=[...pageNodes.values()].find(element=>element.getBoundingClientRect().bottom>bounds.top+30);if(row){const number=Number(row.dataset.page);const rect=row.getBoundingClientRect();const fraction=Math.max(0,Math.min(1,(bounds.top-rect.top)/rect.height));$('page-status').textContent=`Page ${number} of ${pdf?.numPages??0}`;if(viewRelay.canRelay()) relayView(number,fraction,zoom);}},120);});
listenForLinkedView(state => {
  const row = pageNodes.get(state.page);
  if (!row) return;
  viewRelay.applyExternal();
  zoom = Math.max(.55, Math.min(3, state.zoom)); applyScale();
  $('reading-scroll').scrollTop = row.offsetTop + row.offsetHeight * state.fraction;
});
window.addEventListener('beforeunload',()=>{requestController.abort();translationQueue.reset();renderQueue.reset();});
const fileUrl=new URLSearchParams(location.search).get('file');
if(fileUrl) {
  status('Acquiring PDF from the source tab…');
  void fetchPdf(fileUrl).then(bytes=>{let name='Source document.pdf';try{name=decodeURIComponent(new URL(fileUrl).pathname.split('/').pop()||name);}catch{}return load(bytes,name,fileUrl);}).catch(error=>status(`Source disconnected or unavailable: ${errorMessage(error)} Use Open PDF to import a saved copy.`,true));
}
