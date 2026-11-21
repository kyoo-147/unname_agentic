mod export;
mod geometry;
mod rotate;
mod scrollbar;
mod state;
mod view;

use crate::{i18n::{tr3, tr3_fill}, input::{TextField, TextFieldEvent}, theme::{self, Theme}, ui};
use gpui::{prelude::FluentBuilder, *};
use mirror_pdf_desktop::{capture, model::{self, CaptureSource, PageFrame, ProviderKind, ProviderSettings, TextBlock}, ocr_fallback, pdf, provider};
use state::{Epoch, Stamp};
use std::{cell::Cell, path::PathBuf, rc::Rc, sync::Arc, time::{Duration, Instant}};

pub enum PdfReaderEvent { Location(u16), BrowserLocation { page: u16, fraction: f32, zoom: f32 }, Toast(String) }

#[derive(Clone)]
enum Source { Pdf(PathBuf), Capture(CaptureSource) }

impl Source {
    /// One log token: no whitespace and no `=`, so `key=value` parsing survives a
    /// capture title such as `Quarterly report · Acrobat`.
    fn log_label(&self) -> String {
        let raw = match self {
            Self::Pdf(path) => path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string()),
            Self::Capture(source) => source.label(),
        };
        let mut label = String::new();
        for ch in raw.chars().take(80) { label.push(if ch.is_whitespace() || ch == '=' { '_' } else { ch }); }
        if label.is_empty() { label.push_str("unknown"); }
        label
    }
}

struct CleanPatch { image: Arc<RenderImage>, rect: model::BlockRect, text_color: Hsla }

struct PreparedPage {
    frame: PageFrame,
    original: Arc<RenderImage>,
    patches: Vec<Option<CleanPatch>>,
    raw_digest: String,
}

fn render_image(mut pixels: image::RgbaImage) -> Arc<RenderImage> {
    for pixel in pixels.chunks_exact_mut(4) { pixel.swap(0, 2); }
    Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
}

fn prepare(frame: PageFrame) -> PreparedPage {
    let original = render_image(frame.original.clone());
    let patches = frame.blocks.iter().map(|block| {
        if state::preserve_formula(&block.source) { return None; }
        if frame.quality.contains("OCR") && block.background.is_none() {
            // A scan has no text layer to erase, so the only honest way to show a
            // translation over it is to cover the source with its own paper colour.
            // That is safe on a flat region and wrong on a photo, so measure first
            // and leave busy regions to the paired list.
            let width = frame.original.width(); let height = frame.original.height();
            let (x, y, right, bottom) = state::patch_bounds([block.rect.x, block.rect.y, block.rect.width, block.rect.height], width, height);
            if right <= x || bottom <= y { return None; }
            let crop = image::imageops::crop_imm(&frame.original, x, y, right - x, bottom - y).to_image();
            let (fill, share) = dominant_fill(&crop)?;
            if share < 0.55 { return None; }
            let rect = model::BlockRect { x: x as f32 / width as f32, y: y as f32 / height as f32, width: (right - x) as f32 / width as f32, height: (bottom - y) as f32 / height as f32 };
            let (r, g, b) = (fill[0], fill[1], fill[2]);
            let luminance = u32::from(r) * 2126 + u32::from(g) * 7152 + u32::from(b) * 722;
            let image = image::RgbaImage::from_pixel(right - x, bottom - y, image::Rgba([r, g, b, 255]));
            return Some(CleanPatch { image: render_image(image), rect, text_color: if luminance < 1_275_000 { white() } else { black() } });
        }
        let width = frame.clean.width(); let height = frame.clean.height();
        let (x, y, right, bottom) = state::patch_bounds([block.rect.x, block.rect.y, block.rect.width, block.rect.height], width, height);
        if right <= x || bottom <= y { return None; }
        let rect = model::BlockRect { x: x as f32 / width as f32, y: y as f32 / height as f32, width: (right - x) as f32 / width as f32, height: (bottom - y) as f32 / height as f32 };
        let pixels = image::imageops::crop_imm(&frame.clean, x, y, right - x, bottom - y).to_image();
        let total: u64 = pixels.pixels().map(|p| u64::from(p[0]) * 2126 + u64::from(p[1]) * 7152 + u64::from(p[2]) * 722).sum();
        let dark = total / (u64::from(pixels.width()) * u64::from(pixels.height())).max(1) < 1_275_000;
        Some(CleanPatch { image: render_image(pixels), rect, text_color: if dark { white() } else { black() } })
    }).collect();
    PreparedPage { raw_digest: frame.document_digest.clone(), frame, original, patches }
}

/// OCUL: one INFO line per prepared page frame, the measurement the desktop
/// harness under `artifacts/desktop-test/measure` parses. Keep the prefix and
/// the field names stable:
/// `ocr page=<1-based> pages=<n> scanned=<0|1> ran=<0|1> ms=<n> regions=<n>
/// confidence=<f|na> source=<token> doc=<digest> engine=<windows|tesseract|none>`.
/// Keep it on one line. `engine` (C20) names the OCR engine that produced the
/// regions, read out of the frame's quality note; `none` means no engine ran.
///
/// `ms` is the call that prepared the frame: PDFium raster plus Windows OCR for
/// a scanned PDF, screen grab plus Windows OCR for a capture. Windows OCR
/// reports no per-word confidence, so `confidence=na` says that instead of
/// inventing a number the engine never produced. `scanned=1` marks a page whose
/// text layer was empty, and `ran=0` with `scanned=1` is a failed OCR. Nothing
/// here changes behaviour: the frame is already built when this runs.
///
/// `source` is the name the reader opened, which for a library document is the
/// uuid-named retained copy under `sources/`; `doc` is the first 16 hex of the
/// document digest, so a line still identifies its PDF when that name does not.
fn log_prepared_page(page: u16, label: &str, pdf: bool, elapsed: Duration, frame: &PageFrame) {
    let quality = frame.quality.as_str();
    let failed = quality.contains("OCR unavailable");
    // C20: the note names the engine that produced the page (unit-tested there).
    let engine = ocr_fallback::engine_token(quality);
    let ran = engine != "none" && !failed;
    let scanned = pdf && (quality.starts_with("Scanned PDF") || failed);
    log::info!(
        target: "pdf_workspace",
        "ocr page={} pages={} scanned={} ran={} ms={} regions={} confidence=na source={} doc={} engine={}",
        u32::from(page) + 1,
        frame.page_count,
        u8::from(scanned),
        u8::from(ran),
        elapsed.as_millis(),
        frame.blocks.len(),
        label,
        frame.document_digest.get(..16).unwrap_or(frame.document_digest.as_str()),
        engine
    );
}

struct ProfileFields {
    endpoint: Entity<TextField>, model: Entity<TextField>, source: Entity<TextField>, target: Entity<TextField>,
    glossary: Entity<TextField>, key: Entity<TextField>,
}

pub struct PdfReader {
    source: Source,
    epoch: Epoch,
    page: u16,
    page_count: u16,
    rotation: u16,
    prepared: Option<PreparedPage>,
    loading: bool,
    load_needed: bool,
    profile_loading: bool,
    provider_busy: Option<Stamp>,
    failed: bool,
    paused: bool,
    active: bool,
    browser_linked: bool,
    pending_external: Option<(u16, f32)>,
    capture_live: bool,
    capture_due: Instant,
    profile: ProviderSettings,
    draft_kind: ProviderKind,
    draft_consent: bool,
    selected_request: bool,
    translate_all: bool,
    fields: ProfileFields,
    /// 页码跳转: an in-place page field created on demand, so the pill stays a label
    /// until the reader actually wants to type a page number.
    page_entry: Option<Entity<TextField>>,
    page_entry_sub: Option<Subscription>,
    profile_dirty: bool,
    profile_saving: bool,
    show_settings: bool,
    split: bool,
    zoom: f32,
    split_ratio: f32,
    divider_drag: bool,
    show_paired: bool,
    scrolls: [ScrollHandle; 2],
    scrollbars: [Rc<scrollbar::Scrollbar>; 2],
    viewport: Rc<Cell<Bounds<Pixels>>>,
    panes: [geometry::Pane; 2],
    layout_split: bool,
    reflow_frames: u8,
    linked_scroll: geometry::LinkedScroll,
    last_input: Rc<Cell<usize>>,
    native_scroll_input: Rc<Cell<bool>>,
    external_position: Option<f32>,
    selected: Option<usize>,
    source_text: Entity<TextField>,
    target_text: Entity<TextField>,
    source_full: String,
    target_full: String,
    status: String,
    error: Option<String>,
    last_digest: String,
    tick: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<PdfReaderEvent> for PdfReader {}

/// One rendered block with both language sides: the pair the pane draws, the id
/// a chat citation names, and the two texts an export writes.
#[derive(Clone, Debug, PartialEq)]
pub struct ReaderBlock {
    /// Page-scoped id, `p<page>-r<rank>` with the same 1-based page and reading
    /// rank a chat citation uses.
    pub id: String,
    /// The text the document prints.
    pub source: String,
    /// The translation, absent until the provider has answered for this block.
    pub translation: Option<String>,
}

/// One page of the document with the blocks the reader holds for it.
#[derive(Clone, Debug, PartialEq)]
pub struct ReaderPage {
    /// 0-based position, as every page number inside the reader.
    pub page: usize,
    /// Reading order.
    pub blocks: Vec<ReaderBlock>,
}

/// The pane's blocks of `page` (0-based) with both languages, each numbered
/// `p<page+1>-r<rank>` so an exporter can name a block the chat already names.
fn reader_page(page: usize, blocks: &[TextBlock]) -> ReaderPage {
    let page_number = page + 1;
    let blocks = blocks
        .iter()
        .enumerate()
        .map(|(index, block)| ReaderBlock { id: format!("p{page_number}-r{}", index + 1), source: block.source.clone(), translation: block.translated.clone() })
        .collect();
    ReaderPage { page, blocks }
}

impl PdfReader {
    /// The current page's source text, bounded for a chat prompt.
    pub fn document_context(&self) -> Option<(String, String)> {
        let prepared_text = self.prepared.as_ref().map(|page| page.frame.blocks.iter().map(|block| block.source.trim()).filter(|text| !text.is_empty()).collect::<Vec<_>>().join("\n")).unwrap_or_default();
        let text = if prepared_text.trim().is_empty() { self.source_full.clone() } else { prepared_text };
        let text = text.trim();
        if text.is_empty() { return None; }
        let title = self.prepared.as_ref().map(|page| page.frame.title.clone()).filter(|title| !title.trim().is_empty())
            .or_else(|| match &self.source { Source::Pdf(path) => path.file_stem().and_then(|stem| stem.to_str()).map(str::to_string), Source::Capture(_) => None })
            .unwrap_or_else(|| "PDF".to_string());
        Some((title, text.chars().take(6000).collect()))
    }

    /// The blocks of one 0-based page with both languages, or `None` when the
    /// reader is not holding that page. Read-only: the pane and an export see
    /// the same sources and translations.
    pub fn page_blocks(&self, page: usize) -> Option<ReaderPage> {
        self.held_pages().into_iter().find(|held| held.page == page)
    }

    /// Every page the reader holds, in page order: the document-level list an
    /// export walks. The reader prepares one page at a time, so today this is the
    /// page on screen; its blocks are the structures the pane renders.
    pub fn document_pages(&self) -> Vec<ReaderPage> {
        let mut pages = self.held_pages();
        pages.sort_by_key(|page| page.page);
        pages
    }

    fn held_pages(&self) -> Vec<ReaderPage> {
        match &self.prepared {
            Some(prepared) => vec![reader_page(usize::from(self.page), &prepared.frame.blocks)],
            None => Vec::new(),
        }
    }

    pub fn new(path: PathBuf, initial_page: u16, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(Source::Pdf(path), initial_page, window, cx)
    }
    pub fn from_capture(source: CaptureSource, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(Source::Capture(source), 0, window, cx)
    }
    pub fn open_settings(&mut self, cx: &mut Context<Self>) { self.show_settings = true; cx.notify(); }
    fn rotate_page(&mut self, cx: &mut Context<Self>) {
        self.rotation = (self.rotation + 90) % 360;
        self.load_needed = true;
        cx.notify();
    }
    fn export_page(&mut self, cx: &mut Context<Self>) {
        let Source::Pdf(path) = self.source.clone() else {
            cx.emit(PdfReaderEvent::Toast(tr3("只有本地 PDF 可以导出", "Only a local PDF can be exported", "Chỉ PDF cục bộ mới xuất được").into()));
            return;
        };
        let (markdown, output) = {
            let Some(prepared) = &self.prepared else { return; };
            let title = path.file_stem().and_then(|name| name.to_str()).unwrap_or("document");
            (export::page_markdown(title, self.page, self.page_count, &prepared.frame.blocks), export::output_path(&path, self.page, self.page_count))
        };
        match std::fs::write(&output, markdown) {
            Ok(()) => {
                let message = format!("{} {}", tr3("已导出", "Exported", "Đã xuất"), output.display());
                self.status = message.clone();
                cx.emit(PdfReaderEvent::Toast(message));
            }
            Err(error) => {
                self.error = Some(format!("{}: {error}", tr3("导出失败", "Export failed", "Xuất thất bại")));
            }
        }
        cx.notify();
    }
    pub fn set_browser_linked(&mut self, linked: bool, cx: &mut Context<Self>) { self.browser_linked = linked; if !linked { self.pending_external = None; } cx.notify(); }
    pub fn follow_external_location(&mut self, page: u16, progress: f32, cx: &mut Context<Self>) {
        if !self.browser_linked || !matches!(self.source, Source::Pdf(_)) || !progress.is_finite() { return; }
        if self.page_count == 0 { self.pending_external = Some((page, progress.clamp(0., 1.))); return; }
        self.native_scroll_input.set(false);
        let page = page.min(self.page_count.saturating_sub(1));
        self.navigate(i32::from(page) - i32::from(self.page), cx);
        self.external_position = Some(progress.clamp(0., 1.)); cx.notify();
    }
    #[cfg(feature = "devtools")]
    pub fn viewport_snapshot(&self) -> serde_json::Value {
        let bounds = self.viewport.get(); let rects = self.visible_page_rects();
        serde_json::json!({ "page": self.page, "browser_linked": self.browser_linked, "split": self.split, "ratio": self.split_ratio, "zoom": self.zoom,
            "position": self.linked_scroll.position, "dragging": self.divider_drag,
            "bounds": [f32::from(bounds.left()), f32::from(bounds.top()), f32::from(bounds.size.width), f32::from(bounds.size.height)],
            "panes": (0..2).map(|i| { let p = self.scrolls[i].offset(); serde_json::json!({ "page": self.panes[i].page,
                "offset": [-f32::from(p.x), -f32::from(p.y)], "viewport": self.panes[i].viewport, "actual_viewport": [f32::from(self.scrolls[i].bounds().size.width), f32::from(self.scrolls[i].bounds().size.height)], "max_offset": [f32::from(self.scrolls[i].max_offset().width), f32::from(self.scrolls[i].max_offset().height)],
                "visible": rects[i].map(|r| [r.left, r.top, r.right, r.bottom]) }) }).collect::<Vec<_>>() })
    }
    #[cfg(feature = "devtools")]
    pub fn is_active(&self) -> bool { self.active }
    pub fn set_active(&mut self, active: bool, cx: &mut Context<Self>) {
        if self.active == active { return; }
        self.active = active; self.epoch.source();
        if active { self.capture_due = Instant::now(); if self.prepared.is_none() { self.load_needed = true; } }
        cx.notify();
    }
    fn field(placeholder: &'static str, value: &str, multiline: bool, cx: &mut Context<Self>) -> Entity<TextField> {
        cx.new(|cx| { let mut f = TextField::new(placeholder, cx); f.multiline = multiline; f.wrap = multiline; f.set_text(value, cx); f })
    }
    fn build(source: Source, page: u16, _: &mut Window, cx: &mut Context<Self>) -> Self {
        let profile = ProviderSettings::default();
        let fields = ProfileFields {
            endpoint: Self::field(tr3("提供方基础 URL", "Provider base URL", "URL gốc nhà cung cấp"), &profile.endpoint, false, cx),
            model: Self::field(tr3("模型", "Model", "Mô hình"), &profile.model, false, cx),
            source: Self::field(tr3("自动", "auto", "tự động"), &profile.source_language, false, cx),
            target: Self::field(tr3("目标语言代码", "Target language code", "Mã ngôn ngữ đích"), &profile.target_language, false, cx),
            glossary: Self::field(tr3("术语 = 首选译法", "term = preferred translation", "thuật ngữ = bản dịch ưu tiên"), "", true, cx),
            key: Self::field(tr3("粘贴 API 密钥（隐藏；仅保存在凭据库）", "Paste API key (hidden; saved only in vault)", "Dán khoá API (ẩn; chỉ lưu trong kho bảo mật trên máy)"), "", false, cx),
        };
        fields.key.update(cx, |f, _| f.secret = true);
        let source_text = Self::field(tr3("选择区域", "Select a region", "Chọn một vùng"), "", true, cx);
        let target_text = Self::field(tr3("翻译就绪后显示在这里", "Translation appears here when ready", "Bản dịch sẽ hiện ở đây khi sẵn sàng"), "", true, cx);
        let mut subscriptions = Vec::new();
        for field in [&fields.endpoint, &fields.model, &fields.source, &fields.target, &fields.glossary, &fields.key] {
            subscriptions.push(cx.subscribe(field, |this, _, event, cx| {
                if matches!(event, TextFieldEvent::Changed) { this.profile_dirty = true; cx.notify(); }
            }));
        }
        subscriptions.push(cx.subscribe(&source_text, |this, field, event, cx| {
            if matches!(event, TextFieldEvent::Changed) { field.update(cx, |f, cx| f.set_text(&this.source_full, cx)); }
        }));
        subscriptions.push(cx.subscribe(&target_text, |this, field, event, cx| {
            if matches!(event, TextFieldEvent::Changed) { field.update(cx, |f, cx| f.set_text(&this.target_full, cx)); }
        }));
        let mut reader = Self {
            source, epoch: Epoch::default(), page, page_count: 0, rotation: 0, prepared: None, loading: false, load_needed: true,
            profile_loading: true, provider_busy: None, failed: false, paused: false, active: true, browser_linked: false, pending_external: None, capture_live: true,
            capture_due: Instant::now(), draft_kind: profile.kind, draft_consent: profile.cloud_consent, profile, fields, page_entry: None, page_entry_sub: None, selected_request: false, translate_all: false, profile_dirty: false, profile_saving: false, show_settings: false,
            split: true, zoom: 1., split_ratio: 0.5, divider_drag: false, show_paired: false,
            scrolls: [ScrollHandle::new(), ScrollHandle::new()], scrollbars: [Rc::default(), Rc::default()],
            viewport: Rc::new(Cell::new(Bounds::new(point(px(0.), px(0.)), size(px(800.), px(650.))))),
            panes: [geometry::Pane::default(); 2], layout_split: true, reflow_frames: 0, linked_scroll: geometry::LinkedScroll::default(), last_input: Rc::new(Cell::new(1)), native_scroll_input: Rc::new(Cell::new(false)),
            external_position: None, selected: None, source_text, target_text, source_full: String::new(), target_full: String::new(),
            status: tr3("正在打开原始像素…", "Opening original pixels…", "Đang mở ảnh gốc…").into(), error: None, last_digest: String::new(), tick: None, _subscriptions: subscriptions,
        };
        let task = cx.background_executor().spawn(async {
            let mut settings = model::load_settings();
            settings.provider.api_key = provider::load_key(settings.provider.kind).unwrap_or_default();
            settings.provider
        });
        cx.spawn(async move |this, cx| {
            let profile = task.await;
            let _ = this.update(cx, |reader, cx| {
                if !reader.profile_dirty { reader.profile = profile; reader.fill_profile(cx); }
                reader.profile_loading = false; cx.notify();
            });
        }).detach();
        reader.start_load(cx);
        reader.tick = Some(cx.spawn(async |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(300)).await;
            if this.update(cx, |reader, cx| reader.pump(cx)).is_err() { break; }
        }));
        reader
    }
    fn fill_profile(&mut self, cx: &mut Context<Self>) {
        self.draft_kind = self.profile.kind; self.draft_consent = self.profile.cloud_consent;
        for (field, value) in [(&self.fields.endpoint, &self.profile.endpoint), (&self.fields.model, &self.profile.model), (&self.fields.source, &self.profile.source_language), (&self.fields.target, &self.profile.target_language), (&self.fields.glossary, &self.profile.glossary)] {
            field.update(cx, |f, cx| f.set_text(value, cx));
        }
    }
    fn fail(&mut self, error: String, cx: &mut Context<Self>) {
        self.status = tr3("已保留原始文件 · 可重试", "Original retained · retry available", "Đã giữ bản gốc · có thể thử lại").into(); self.error = Some(error.clone()); self.failed = true;
        cx.emit(PdfReaderEvent::Toast(error)); cx.notify();
    }
    fn pump(&mut self, cx: &mut Context<Self>) {
        if !self.active { return; }
        if self.page_count > 0 && let Some((page, progress)) = self.pending_external.take() { self.follow_external_location(page, progress, cx); }
        if self.sync_scroll(cx) { cx.notify(); }
        if self.selected_request && self.selected.and_then(|i| self.prepared.as_ref()?.frame.blocks.get(i)?.translated.as_ref()).is_some() { self.selected_request = false; }
        let capture_due = matches!(self.source, Source::Capture(_)) && self.capture_live && self.capture_due <= Instant::now();
        if (self.load_needed || capture_due) && !self.loading { self.start_load(cx); }
        if !self.loading && !self.load_needed && !self.profile_loading && !self.profile_saving && !self.show_settings && !self.paused && !self.failed && self.provider_busy.is_none() { self.translate_visible(cx); }
    }
    fn start_load(&mut self, cx: &mut Context<Self>) {
        if self.loading { return; }
        self.loading = true; self.load_needed = false;
        let source = self.source.clone(); let page = self.page; let rotation = self.rotation; let stamp = self.epoch.stamp(); let digest = self.last_digest.clone();
        let task = cx.background_executor().spawn(async move {
            let result: anyhow::Result<Option<PreparedPage>> = (|| {
                let pdf = matches!(source, Source::Pdf(_));
                let label = source.log_label();
                let frame_started = Instant::now();
                let (frame, raw_digest) = match source {
                    Source::Pdf(path) => { let frame = pdf::load_page(&path, page, None)?; let digest = frame.document_digest.clone(); (frame, digest) },
                    Source::Capture(source) => {
                        if matches!(source, CaptureSource::Monitor { .. }) { capture::exclude_own_windows()?; }
                        let image = capture::grab(&source)?;
                        let raw_digest = model::digest(image.as_raw());
                        if raw_digest == digest { return Ok(None); }
                        let frame = capture::recognize_frame(image, source.label(), true)?;
                        (frame, raw_digest)
                    }
                };
                let frame_ms = frame_started.elapsed();
                let frame = rotate::rotate_frame(frame, rotation);
                log_prepared_page(page, &label, pdf, frame_ms, &frame);
                let mut prepared = prepare(frame); prepared.raw_digest = raw_digest;
                Ok(Some(prepared))
            })();
            result.map_err(|e| format!("{e:#}"))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |reader, cx| {
                reader.loading = false; reader.capture_due = Instant::now() + Duration::from_millis(1500);
                if !reader.epoch.same_source(stamp) { return; }
                match result {
                    Ok(Some(prepared)) => {
                        reader.page_count = prepared.frame.page_count;
                        reader.last_digest = prepared.raw_digest.clone();
                        if matches!(reader.source, Source::Capture(_)) && reader.prepared.as_ref().is_some_and(|old| old.frame.document_digest == prepared.frame.document_digest) { return; }
                        let ocr_error = prepared.frame.quality.contains("OCR unavailable").then(|| prepared.frame.quality.clone());
                        reader.epoch.source(); reader.prepared = Some(prepared); reader.selected = None; reader.translate_all = false; reader.selected_request = false;
                        reader.source_full.clear(); reader.target_full.clear();
                        reader.source_text.update(cx, |f, cx| f.set_text("", cx)); reader.target_text.update(cx, |f, cx| f.set_text("", cx));
                        reader.status = if reader.failed { tr3("原始文件已刷新 · 翻译需要重试", "Original refreshed · translation needs Retry", "Đã làm mới bản gốc · bản dịch cần thử lại") } else if reader.paused { tr3("翻译已暂停 · 原始文件已刷新", "Translation paused · original refreshed", "Đã tạm dừng dịch · bản gốc đã làm mới") } else { tr3("原始文件已就绪 · 正在翻译可见区域", "Original ready · translating visible regions", "Bản gốc đã sẵn sàng · đang dịch các vùng hiển thị") }.into();
                        if !reader.failed { reader.error = None; }
                        if let Some(error) = ocr_error { if matches!(reader.source, Source::Capture(_)) { reader.capture_live = false; } reader.fail(error, cx); }
                        cx.emit(PdfReaderEvent::Location(reader.page));
                    }
                    Ok(None) => {},
                    Err(error) => { if matches!(reader.source, Source::Capture(_)) { reader.capture_live = false; } reader.fail(error, cx); }
                }
                cx.notify();
            });
        }).detach();
    }
    fn sync_scroll(&mut self, cx: &mut Context<Self>) -> bool {
        let bounds = self.viewport.get(); let width = f32::from(bounds.size.width).max(1.);
        let usable = (width - geometry::DIVIDER).max(1.);
        let widths = if self.split { [usable * self.split_ratio, usable * (1. - self.split_ratio)] } else { [width, width] };
        let height = (f32::from(bounds.size.height) - 32.).max(1.);
        let aspect = self.prepared.as_ref().map(|p| p.frame.original.height() as f32 / p.frame.original.width().max(1) as f32).unwrap_or(1.414);
        let panes = widths.map(|w| geometry::Pane::new([w, height], self.zoom, aspect));
        let changed = panes != self.panes || self.layout_split != self.split;
        let offsets = std::array::from_fn(|i| { let p = self.scrolls[i].offset(); [-f32::from(p.x), -f32::from(p.y)] });
        let user_input = self.native_scroll_input.replace(false);
        if user_input { self.external_position = None; self.pending_external = None; }
        let external = if self.prepared.is_some() { self.external_position } else { None };
        if let Some(position) = external { self.linked_scroll.position = [0., position]; }
        if changed { self.reflow_frames = 3; }
        let reflowing = self.reflow_frames > 0;
        self.reflow_frames = self.reflow_frames.saturating_sub(1);
        // GPUI clamps offsets against the previous frame's extent before the new
        // page dimensions are laid out; that clamp is not a user scroll.
        let mapped = self.linked_scroll.sync(offsets, panes, self.split, (reflowing && !user_input) || external.is_some(), self.last_input.get());
        let mut moved = false;
        for i in 0..2 {
            if (0..2).any(|axis| (offsets[i][axis] - mapped[i][axis]).abs() > 0.01) {
                self.scrolls[i].set_offset(point(px(-mapped[i][0]), px(-mapped[i][1]))); moved = true;
            }
        }
        self.panes = panes; self.layout_split = self.split;
        self.emit_browser_location(user_input, cx);
        changed || moved || self.reflow_frames > 0
    }
    fn visible_page_rects(&self) -> [Option<geometry::Viewport>; 2] {
        std::array::from_fn(|i| {
            if i == 0 && !self.split { return None; }
            let scroll = &self.scrolls[i]; let bounds = scroll.bounds();
            if bounds.size.width <= px(0.) || bounds.size.height <= px(0.) { return None; }
            let pane = geometry::Pane { page: self.panes[i].page, viewport: [f32::from(bounds.size.width), f32::from(bounds.size.height)] };
            let p = scroll.offset(); pane.visible([-f32::from(p.x), -f32::from(p.y)])
        })
    }
    fn translate_visible(&mut self, cx: &mut Context<Self>) {
        if self.profile.kind != ProviderKind::Local && (!self.profile.cloud_consent || self.profile.api_key.trim().is_empty()) {
            let status = tr3("翻译已关闭 · 选择“语言 / 提供方”以配置本地引擎或启用云端翻译", "Translation is off · choose Language / provider to configure a local engine or enable cloud translation", "Dịch đang tắt · chọn “Ngôn ngữ / nhà cung cấp” để cấu hình công cụ cục bộ hoặc bật dịch đám mây");
            if self.status != status { self.status = status.into(); cx.notify(); }
            return;
        }
        let Some(prepared) = &self.prepared else { return; };
        let viewports = self.visible_page_rects();
        let indices: Vec<usize> = prepared.frame.blocks.iter().enumerate().filter(|(index, b)| {
            let visible = viewports.iter().flatten().any(|v| v.intersects([b.rect.x, b.rect.y, b.rect.width, b.rect.height]));
            b.translated.is_none() && !state::preserve_formula(&b.source) && (self.translate_all || (self.selected_request && self.selected == Some(*index)) || visible)
        }).take(16).map(|(i, _)| i).collect();
        if indices.is_empty() { return; }
        let blocks: Vec<TextBlock> = indices.iter().map(|i| prepared.frame.blocks[*i].clone()).collect();
        let settings = self.profile.clone(); let stamp = self.epoch.stamp(); self.provider_busy = Some(stamp);
        self.status = tr3_fill("正在翻译 {} 个可见区域…", "Translating {} visible regions…", "Đang dịch {} vùng hiển thị…", blocks.len());
        let task = cx.background_executor().spawn(async move { provider::translate_blocks(&settings, &blocks).map_err(|e| format!("{e:#}")) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |reader, cx| {
                if reader.provider_busy == Some(stamp) { reader.provider_busy = None; }
                if !reader.epoch.accepts(stamp) { return; }
                match result {
                    Ok(values) => {
                        if let Some(prepared) = &mut reader.prepared {
                            if values.len() != indices.len() { reader.fail(tr3("提供方返回的块数不正确", "Provider returned an incorrect block count", "Nhà cung cấp trả về sai số khối").into(), cx); return; }
                            for (index, text) in indices.into_iter().zip(values) { prepared.frame.blocks[index].translated = Some(text); }
                        }
                        reader.status = tr3("可见区域已就绪 · 完整对照文本见下方", "Visible regions ready · full paired text below", "Các vùng hiển thị đã sẵn sàng · văn bản song song đầy đủ ở bên dưới").into(); reader.refresh_selection(cx);
                    }
                    Err(error) => reader.fail(error, cx),
                }
                cx.notify();
            });
        }).detach();
        cx.notify();
    }
    fn emit_browser_location(&self, user_input: bool, cx: &mut Context<Self>) {
        if !matches!(self.source, Source::Pdf(_)) { return; }
        if let Some((page, fraction, zoom)) = state::browser_gesture(self.browser_linked, self.active, user_input, self.page, self.linked_scroll.position[1], self.zoom) {
            cx.emit(PdfReaderEvent::BrowserLocation { page, fraction, zoom });
        }
    }
    fn navigate_user(&mut self, step: i32, cx: &mut Context<Self>) {
        let previous = self.page; self.pending_external = None;
        self.navigate(step, cx);
        self.emit_browser_location(previous != self.page, cx);
    }
    fn navigate(&mut self, step: i32, cx: &mut Context<Self>) {
        if !matches!(self.source, Source::Pdf(_)) { return; }
        self.goto_page(state::page_step(self.page, self.page_count.max(1), step), cx);
    }
    /// Show `page` (0-based) and reset everything that belongs to the old page.
    fn goto_page(&mut self, page: u16, cx: &mut Context<Self>) {
        if !matches!(self.source, Source::Pdf(_)) || self.page_count == 0 { return; }
        let next = page.min(self.page_count - 1);
        if next == self.page { return; }
        self.page_entry = None; self.page_entry_sub = None;
        self.native_scroll_input.set(false);
        self.page = next; self.epoch.source(); self.prepared = None; self.last_digest.clear(); self.selected = None;
        self.load_needed = true; self.failed = false; self.error = None; self.external_position = None; self.linked_scroll = geometry::LinkedScroll::default();
        for scroll in &self.scrolls { scroll.set_offset(point(px(0.), px(0.))); }
        self.status = tr3("正在打开原始像素…", "Opening original pixels…", "Đang mở ảnh gốc…").into(); self.pump(cx); cx.notify();
    }
    /// 页码跳转: turn the page pill into an editable field with the current page selected.
    fn begin_page_entry(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.page_entry.is_some() || !matches!(self.source, Source::Pdf(_)) || self.page_count == 0 { return; }
        let field = Self::field(tr3("页码", "Page", "Trang"), &(self.page + 1).to_string(), false, cx);
        field.update(cx, |field, cx| field.select_all_text(cx));
        let handle = field.read(cx).focus_handle(cx);
        window.focus(&handle);
        let subscription = cx.subscribe(&field, |this, _, event: &TextFieldEvent, cx| match event {
            TextFieldEvent::Submit => this.submit_page_entry(cx),
            TextFieldEvent::Cancel => { this.page_entry = None; this.page_entry_sub = None; cx.notify(); }
            _ => {}
        });
        self.page_entry_sub = Some(subscription);
        self.page_entry = Some(field);
        cx.notify();
    }
    /// Commit the typed page: clamp it, jump, and put the pill back.
    fn submit_page_entry(&mut self, cx: &mut Context<Self>) {
        let Some(field) = self.page_entry.take() else { return };
        self.page_entry_sub = None;
        let text = field.read(cx).text.clone();
        if let Some(page) = parse_page_input(&text, self.page_count) { self.goto_page(page - 1, cx); }
        cx.notify();
    }
    fn toggle_pause(&mut self, cx: &mut Context<Self>) {
        self.paused = !self.paused; self.epoch.cancel();
        self.status = if self.paused { tr3("翻译已暂停 · 仍可查看原文", "Translation paused · original remains available", "Đã tạm dừng dịch · bản gốc vẫn có sẵn") } else { tr3("翻译已继续", "Translation resumed", "Đã tiếp tục dịch") }.into(); cx.notify();
    }
    fn retry(&mut self, cx: &mut Context<Self>) {
        self.error = None; self.failed = false; self.paused = false;
        if matches!(self.source, Source::Capture(_)) { self.capture_live = true; self.load_needed = true; }
        if self.prepared.as_ref().is_none_or(|p| p.frame.quality.contains("OCR unavailable")) { self.load_needed = true; self.last_digest.clear(); }
        self.epoch.cancel(); self.status = tr3("正在重试…", "Retrying…", "Đang thử lại…").into(); self.pump(cx); cx.notify();
    }
    fn select(&mut self, index: usize, cx: &mut Context<Self>) {
        self.selected = Some(index); self.refresh_selection(cx); cx.notify();
    }
    fn refresh_selection(&mut self, cx: &mut Context<Self>) {
        let Some(block) = self.selected.and_then(|i| self.prepared.as_ref()?.frame.blocks.get(i)) else { return; };
        self.source_full = block.source.clone();
        self.target_full = block.translated.clone().unwrap_or_else(|| if state::preserve_formula(&block.source) { tr3("公式保留在原始像素中", "Formula preserved in original pixels", "Công thức được giữ trong ảnh gốc").into() } else { tr3("尚未翻译。将区域滚动到可视范围，或选择“翻译所选区域”。", "Not translated yet. Scroll the region into view or choose Translate selected.", "Chưa dịch. Cuộn vùng vào tầm nhìn hoặc chọn “Dịch vùng đã chọn”.").into() });
        self.source_text.update(cx, |f, cx| f.set_text(&self.source_full, cx));
        self.target_text.update(cx, |f, cx| f.set_text(&self.target_full, cx));
    }
    fn switch_kind(&mut self, kind: ProviderKind, cx: &mut Context<Self>) {
        self.draft_kind = kind; self.profile_dirty = true;
        let (endpoint, model) = match kind {
            ProviderKind::OpenAi => ("https://api.openai.com/v1", "gpt-4.1-mini"),
            ProviderKind::Google => ("https://translation.googleapis.com", ""),
            ProviderKind::DeepL => ("https://api-free.deepl.com", ""),
            ProviderKind::Local => ("http://127.0.0.1:1234/v1", "local-model"),
        };
        self.fields.endpoint.update(cx, |f, cx| f.set_text(endpoint, cx)); self.fields.model.update(cx, |f, cx| f.set_text(model, cx));
        self.fields.key.update(cx, |f, cx| f.set_text("", cx)); cx.notify();
    }
    fn save_profile(&mut self, forget: bool, cx: &mut Context<Self>) {
        if self.profile_saving { return; }
        let mut profile = self.profile.clone(); profile.kind = self.draft_kind; profile.cloud_consent = self.draft_consent;
        profile.endpoint = self.fields.endpoint.read(cx).text.trim().into(); profile.model = self.fields.model.read(cx).text.trim().into();
        profile.source_language = self.fields.source.read(cx).text.trim().into(); profile.target_language = self.fields.target.read(cx).text.trim().into();
        profile.glossary = self.fields.glossary.read(cx).text.clone(); let key = self.fields.key.read(cx).text.clone();
        profile.api_key.clear(); self.profile_saving = true; self.epoch.profile();
        if let Some(prepared) = &mut self.prepared { for block in &mut prepared.frame.blocks { block.translated = None; } }
        let task = cx.background_executor().spawn(async move {
            let result: anyhow::Result<ProviderSettings> = (|| {
                if forget { provider::save_key(profile.kind, "")?; }
                else if !key.is_empty() { provider::save_key(profile.kind, &key)?; }
                profile.api_key = provider::load_key(profile.kind).unwrap_or_default();
                let mut settings = model::load_settings(); settings.provider = profile.clone(); model::save_settings(&settings)?;
                Ok(profile)
            })(); result.map_err(|e| format!("{e:#}"))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |reader, cx| {
                reader.profile_saving = false;
                match result {
                    Ok(profile) => {
                        reader.profile = profile; reader.profile_dirty = false; reader.failed = false; reader.error = None;
                        reader.fields.key.update(cx, |f, cx| f.set_text("", cx)); reader.status = tr3("提供方已保存 · 凭据保存在本机凭据库", "Provider saved · credential stays in native vault", "Đã lưu nhà cung cấp · thông tin đăng nhập ở trong kho bảo mật trên máy").into();
                        reader.refresh_selection(cx); cx.emit(PdfReaderEvent::Toast(tr3("提供方设置已保存", "Provider settings saved", "Đã lưu cài đặt nhà cung cấp").into()));
                    }
                    Err(error) => reader.fail(error, cx),
                }
                cx.notify();
            });
        }).detach(); cx.notify();
    }
}

/// 页码跳转: read a typed page number.
///
/// One-based in, one-based out and clamped to the document, because the field
/// shows the page the way the pill does. Anything that is not a positive integer
/// returns None so a stray keypress leaves the reader on its page instead of
/// jumping to the first one.
pub(crate) fn parse_page_input(text: &str, page_count: u16) -> Option<u16> {
    let trimmed = text.trim();
    if trimmed.is_empty() { return None; }
    let value: u32 = trimmed.parse().ok()?;
    if value == 0 { return None; }
    Some(value.min(u32::from(page_count.max(1))) as u16)
}

#[cfg(test)]
mod page_input_tests {
    use super::parse_page_input;

    #[test]
    fn accepts_a_plain_number() { assert_eq!(parse_page_input("3", 10), Some(3)); }

    #[test]
    fn ignores_surrounding_whitespace() { assert_eq!(parse_page_input("  7 ", 10), Some(7)); }

    #[test]
    fn rejects_zero_empty_and_letters() {
        assert_eq!(parse_page_input("0", 10), None);
        assert_eq!(parse_page_input("", 10), None);
        assert_eq!(parse_page_input("abc", 10), None);
        assert_eq!(parse_page_input("-2", 10), None);
    }

    #[test]
    fn clamps_to_the_document() {
        assert_eq!(parse_page_input("999", 4), Some(4));
        assert_eq!(parse_page_input("1", 4), Some(1));
    }
}

#[cfg(test)]
mod reader_block_tests {
    use super::{ReaderBlock, reader_page};
    use mirror_pdf_desktop::model::{BlockRect, TextBlock};

    fn block(id: u64, source: &str, translated: Option<&str>) -> TextBlock {
        TextBlock { id, source: source.into(), translated: translated.map(str::to_string), rect: BlockRect { x: 0., y: 0., width: 1., height: 1. }, background: None, font_size: 12., bold: false }
    }

    /// 翻译对: the accessor hands an export the same pair the pane draws, each
    /// block named the way a chat citation names it.
    #[test]
    fn a_page_pairs_each_block_with_its_translation_and_a_page_scoped_id() {
        let page = reader_page(2, &[block(4, "Revenue", Some("Doanh thu")), block(5, "Costs", None)]);
        assert_eq!(page.page, 2);
        assert_eq!(
            page.blocks,
            vec![
                ReaderBlock { id: "p3-r1".into(), source: "Revenue".into(), translation: Some("Doanh thu".into()) },
                ReaderBlock { id: "p3-r2".into(), source: "Costs".into(), translation: None },
            ]
        );
    }
}
/// 扫描页遮罩: the colour a block sits on, and how much of the region it covers.
///
/// Quantises to 16 levels per channel so anti-aliasing does not split one paper
/// colour into many buckets. Returns None only for an empty crop; the caller
/// decides what share is flat enough to paint over.
fn dominant_fill(pixels: &image::RgbaImage) -> Option<([u8; 3], f32)> {
    if pixels.width() == 0 || pixels.height() == 0 { return None; }
    let mut buckets: std::collections::HashMap<(u8, u8, u8), (u64, u64, u64, u32)> = std::collections::HashMap::new();
    for pixel in pixels.pixels() {
        if pixel[3] < 8 { continue; }
        let key = (pixel[0] & 0xF0, pixel[1] & 0xF0, pixel[2] & 0xF0);
        let slot = buckets.entry(key).or_insert((0, 0, 0, 0));
        slot.0 += u64::from(pixel[0]);
        slot.1 += u64::from(pixel[1]);
        slot.2 += u64::from(pixel[2]);
        slot.3 += 1;
    }
    let total: u32 = buckets.values().map(|slot| slot.3).sum();
    if total == 0 { return None; }
    let (_, (sum_r, sum_g, sum_b, count)) = buckets.into_iter().max_by_key(|(_, slot)| slot.3)?;
    // the bucket's own mean, so a white page fills white instead of a greyed band
    let mean = |sum: u64| (sum / u64::from(count.max(1))).min(255) as u8;
    Some(([mean(sum_r), mean(sum_g), mean(sum_b)], count as f32 / total as f32))
}
#[cfg(test)]
mod scan_overlay_tests {
    use super::dominant_fill;

    fn image(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 4]) -> image::RgbaImage {
        image::RgbaImage::from_fn(width, height, |x, y| image::Rgba([pixel(x, y)[0], pixel(x, y)[1], pixel(x, y)[2], pixel(x, y)[3]]))
    }

    #[test]
    fn a_blank_region_is_one_flat_colour() {
        let page = image(20, 10, |_, _| [255, 255, 255, 255]);
        let (fill, share) = dominant_fill(&page).expect("paper colour");
        assert_eq!(fill, [255, 255, 255]);
        assert!(share > 0.99);
    }

    #[test]
    fn a_half_covered_region_is_not_flat_enough() {
        let page = image(20, 10, |x, _| if x < 10 { [255, 255, 255, 255] } else { [0, 0, 0, 255] });
        let (_, share) = dominant_fill(&page).expect("some colour");
        assert!((share - 0.5).abs() < 0.01, "half and half must not look like paper, got {share}");
    }

    #[test]
    fn a_photo_is_not_flat_enough() {
        let page = image(16, 16, |x, y| [(x * 16) as u8, (y * 16) as u8, ((x + y) * 8) as u8, 255]);
        let (_, share) = dominant_fill(&page).expect("some colour");
        assert!(share < 0.55, "a gradient must stay unpainted, got {share}");
    }

    #[test]
    fn text_on_paper_still_reads_as_paper() {
        // 90% white with a few dark glyph pixels: the paper colour must win.
        let page = image(40, 20, |x, y| if (x % 10 == 0) && (y % 7 == 0) { [20, 20, 20, 255] } else { [249, 248, 244, 255] });
        let (fill, share) = dominant_fill(&page).expect("paper colour");
        assert!(share > 0.9, "glyph pixels must not change the fill, got {share}");
        assert!(fill[0] > 200 && fill[1] > 200 && fill[2] > 200, "fill stays light, got {fill:?}");
    }
}