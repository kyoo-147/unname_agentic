mod geometry;
mod scrollbar;
mod state;
mod view;

use crate::{input::{TextField, TextFieldEvent}, theme::{self, Theme}, ui};
use gpui::{prelude::FluentBuilder, *};
use mirror_pdf_desktop::{capture, model::{self, CaptureSource, PageFrame, ProviderKind, ProviderSettings, TextBlock}, pdf, provider};
use state::{Epoch, Stamp};
use std::{cell::Cell, path::PathBuf, rc::Rc, sync::Arc, time::{Duration, Instant}};

pub enum PdfReaderEvent { Location(u16), BrowserLocation { page: u16, fraction: f32, zoom: f32 }, Toast(String) }

#[derive(Clone)]
enum Source { Pdf(PathBuf), Capture(CaptureSource) }

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
        if frame.quality.contains("OCR") && block.background.is_none() { return None; }
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

struct ProfileFields {
    endpoint: Entity<TextField>, model: Entity<TextField>, source: Entity<TextField>, target: Entity<TextField>,
    glossary: Entity<TextField>, key: Entity<TextField>,
}

pub struct PdfReader {
    source: Source,
    epoch: Epoch,
    page: u16,
    page_count: u16,
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

impl PdfReader {
    pub fn new(path: PathBuf, initial_page: u16, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(Source::Pdf(path), initial_page, window, cx)
    }
    pub fn from_capture(source: CaptureSource, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(Source::Capture(source), 0, window, cx)
    }
    pub fn open_settings(&mut self, cx: &mut Context<Self>) { self.show_settings = true; cx.notify(); }
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
            endpoint: Self::field("Provider base URL", &profile.endpoint, false, cx),
            model: Self::field("Model", &profile.model, false, cx),
            source: Self::field("auto", &profile.source_language, false, cx),
            target: Self::field("Target language code", &profile.target_language, false, cx),
            glossary: Self::field("term = preferred translation", "", true, cx),
            key: Self::field("Paste API key (hidden; saved only in vault)", "", false, cx),
        };
        fields.key.update(cx, |f, _| f.secret = true);
        let source_text = Self::field("Select a region", "", true, cx);
        let target_text = Self::field("Translation appears here when ready", "", true, cx);
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
            source, epoch: Epoch::default(), page, page_count: 0, prepared: None, loading: false, load_needed: true,
            profile_loading: true, provider_busy: None, failed: false, paused: false, active: true, browser_linked: false, pending_external: None, capture_live: true,
            capture_due: Instant::now(), draft_kind: profile.kind, draft_consent: profile.cloud_consent, profile, fields, selected_request: false, translate_all: false, profile_dirty: false, profile_saving: false, show_settings: false,
            split: true, zoom: 1., split_ratio: 0.5, divider_drag: false, show_paired: false,
            scrolls: [ScrollHandle::new(), ScrollHandle::new()], scrollbars: [Rc::default(), Rc::default()],
            viewport: Rc::new(Cell::new(Bounds::new(point(px(0.), px(0.)), size(px(800.), px(650.))))),
            panes: [geometry::Pane::default(); 2], layout_split: true, reflow_frames: 0, linked_scroll: geometry::LinkedScroll::default(), last_input: Rc::new(Cell::new(1)), native_scroll_input: Rc::new(Cell::new(false)),
            external_position: None, selected: None, source_text, target_text, source_full: String::new(), target_full: String::new(),
            status: "Opening original pixels…".into(), error: None, last_digest: String::new(), tick: None, _subscriptions: subscriptions,
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
        self.status = "Original retained · retry available".into(); self.error = Some(error.clone()); self.failed = true;
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
        let source = self.source.clone(); let page = self.page; let stamp = self.epoch.stamp(); let digest = self.last_digest.clone();
        let task = cx.background_executor().spawn(async move {
            let result: anyhow::Result<Option<PreparedPage>> = (|| {
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
                        reader.status = if reader.failed { "Original refreshed · translation needs Retry" } else if reader.paused { "Translation paused · original refreshed" } else { "Original ready · translating visible regions" }.into();
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
            let status = "Translation is off · choose Language / provider to configure a local engine or enable cloud translation";
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
        self.status = format!("Translating {} visible regions…", blocks.len());
        let task = cx.background_executor().spawn(async move { provider::translate_blocks(&settings, &blocks).map_err(|e| format!("{e:#}")) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |reader, cx| {
                if reader.provider_busy == Some(stamp) { reader.provider_busy = None; }
                if !reader.epoch.accepts(stamp) { return; }
                match result {
                    Ok(values) => {
                        if let Some(prepared) = &mut reader.prepared {
                            if values.len() != indices.len() { reader.fail("Provider returned an incorrect block count".into(), cx); return; }
                            for (index, text) in indices.into_iter().zip(values) { prepared.frame.blocks[index].translated = Some(text); }
                        }
                        reader.status = "Visible regions ready · full paired text below".into(); reader.refresh_selection(cx);
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
        let next = state::page_step(self.page, self.page_count.max(1), step);
        if next == self.page { return; }
        self.native_scroll_input.set(false);
        self.page = next; self.epoch.source(); self.prepared = None; self.last_digest.clear(); self.selected = None;
        self.load_needed = true; self.failed = false; self.error = None; self.external_position = None; self.linked_scroll = geometry::LinkedScroll::default();
        for scroll in &self.scrolls { scroll.set_offset(point(px(0.), px(0.))); }
        self.status = "Opening original pixels…".into(); self.pump(cx); cx.notify();
    }
    fn toggle_pause(&mut self, cx: &mut Context<Self>) {
        self.paused = !self.paused; self.epoch.cancel();
        self.status = if self.paused { "Translation paused · original remains available" } else { "Translation resumed" }.into(); cx.notify();
    }
    fn retry(&mut self, cx: &mut Context<Self>) {
        self.error = None; self.failed = false; self.paused = false;
        if matches!(self.source, Source::Capture(_)) { self.capture_live = true; self.load_needed = true; }
        if self.prepared.as_ref().is_none_or(|p| p.frame.quality.contains("OCR unavailable")) { self.load_needed = true; self.last_digest.clear(); }
        self.epoch.cancel(); self.status = "Retrying…".into(); self.pump(cx); cx.notify();
    }
    fn select(&mut self, index: usize, cx: &mut Context<Self>) {
        self.selected = Some(index); self.refresh_selection(cx); cx.notify();
    }
    fn refresh_selection(&mut self, cx: &mut Context<Self>) {
        let Some(block) = self.selected.and_then(|i| self.prepared.as_ref()?.frame.blocks.get(i)) else { return; };
        self.source_full = block.source.clone();
        self.target_full = block.translated.clone().unwrap_or_else(|| if state::preserve_formula(&block.source) { "Formula preserved in original pixels".into() } else { "Not translated yet. Scroll the region into view or choose Translate selected.".into() });
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
                        reader.fields.key.update(cx, |f, cx| f.set_text("", cx)); reader.status = "Provider saved · credential stays in native vault".into();
                        reader.refresh_selection(cx); cx.emit(PdfReaderEvent::Toast("Provider settings saved".into()));
                    }
                    Err(error) => reader.fail(error, cx),
                }
                cx.notify();
            });
        }).detach(); cx.notify();
    }
}
