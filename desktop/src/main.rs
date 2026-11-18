#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use eframe::egui::{self, Color32, Pos2, Rect, Vec2};
use mirror_pdf_desktop::{capture, model::*, pdf, provider};
use std::{collections::{HashMap, HashSet}, path::PathBuf, sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc::{self, Receiver, Sender}}, time::{Duration, Instant}};

enum Event {
    Page(u64, Result<PageFrame, String>),
    Ocr(u64, Result<PageFrame, String>),
    Translated(u64, Vec<u64>, Result<Vec<String>, String>),
    Cover(PathBuf, Result<image::RgbaImage, String>),
}
struct CaptureFeed { stop: Arc<AtomicBool>, rx: Receiver<Result<image::RgbaImage, String>>, source: CaptureSource }
impl Drop for CaptureFeed { fn drop(&mut self) { self.stop.store(true, Ordering::Relaxed); } }
struct MirrorApp {
    settings: Settings, frame: Option<PageFrame>, textures: Option<(egui::TextureHandle, egui::TextureHandle)>,
    path: Option<PathBuf>, guard: GenerationGuard, tx: Sender<Event>, rx: Receiver<Event>,
    capture: Option<CaptureFeed>, sources: Vec<CaptureSource>, pending_ocr: Option<(u64, image::RgbaImage, String)>,
    ocr_busy: bool, translation_busy: bool, loading: bool, paused: bool, capture_digest: String,
    status: String, error: Option<String>, settings_open: bool, picker_open: bool, zoom: f32,
    selected: Option<u64>, visible: HashSet<u64>, auto_translate: bool, last_view_change: Instant,
    exclusion_ready: bool, exclusion_attempted: bool, password: String,
    home: bool, search: String, favorites_only: bool, list_view: bool, sort_name: bool,
    covers: HashMap<PathBuf, egui::TextureHandle>, cover_requested: HashSet<PathBuf>,
}
impl MirrorApp {
    fn new(cc: &eframe::CreationContext<'_>, initial: Option<PathBuf>) -> Self {
        let mut visuals = egui::Visuals::light();
        visuals.panel_fill = Color32::from_rgb(246, 245, 241);
        visuals.window_fill = Color32::from_rgb(253, 252, 249);
        visuals.selection.bg_fill = Color32::from_rgb(207, 223, 209);
        cc.egui_ctx.set_visuals(visuals);
        let mut style = (*cc.egui_ctx.style()).clone();
        style.spacing.item_spacing = Vec2::new(10.0, 9.0);
        cc.egui_ctx.set_style(style);
        let mut settings = load_settings();
        settings.provider.api_key = provider::load_key(settings.provider.kind).unwrap_or_default();
        let (tx, rx) = mpsc::channel();
        let mut app = Self { settings, frame: None, textures: None, path: None, guard: GenerationGuard::default(), tx, rx, capture: None, sources: vec![], pending_ocr: None, ocr_busy: false, translation_busy: false, loading: false, paused: false, capture_digest: String::new(), status: "Open a PDF or choose a window to begin.".into(), error: None, settings_open: false, picker_open: false, zoom: 1.0, selected: None, visible: HashSet::new(), auto_translate: false, last_view_change: Instant::now(), exclusion_ready: false, exclusion_attempted: false, password: String::new(), home: true, search: String::new(), favorites_only: false, list_view: false, sort_name: false, covers: HashMap::new(), cover_requested: HashSet::new() };
        if let Some(path) = initial { app.open_pdf(path, 0); }
        app
    }
    fn invalidate(&mut self) -> u64 { self.selected = None; self.error = None; self.guard.invalidate() }
    fn open_pdf(&mut self, path: PathBuf, page: u16) {
        self.home = false; self.capture = None; self.pending_ocr = None; self.paused = false;
        let generation = self.invalidate(); self.loading = true; self.textures = None; self.frame = None;
        self.path = Some(path.clone()); self.status = "Rendering local PDF…".into();
        if let Some(entry) = self.settings.library.iter_mut().find(|entry| entry.path == path) { entry.last_page = page; }
        else { self.settings.library.insert(0, LibraryEntry { title: path.file_name().unwrap_or_default().to_string_lossy().into(), path: path.clone(), last_page: page, favorite: false }); }
        self.settings.library.truncate(30);
        let _ = save_settings(&self.settings);
        let tx = self.tx.clone(); let password = self.password.clone();
        std::thread::spawn(move || { let _ = tx.send(Event::Page(generation, pdf::load_page(&path, page, if password.is_empty() { None } else { Some(&password) }).map_err(|error| format!("{error:#}")))); });
    }
    fn set_frame(&mut self, frame: PageFrame, ctx: &egui::Context) {
        let texture = |name, image: &image::RgbaImage| ctx.load_texture(name, egui::ColorImage::from_rgba_unmultiplied([image.width() as usize, image.height() as usize], image.as_raw()), egui::TextureOptions::LINEAR);
        self.textures = Some((texture("source", &frame.original), texture("text-free artwork", &frame.clean)));
        self.status = format!("{} text regions · {}", frame.blocks.len(), frame.quality);
        self.frame = Some(frame); self.loading = false; self.last_view_change = Instant::now();
    }
    fn translate(&mut self, selection: bool) {
        if self.translation_busy || self.paused { return; }
        let Some(frame) = &self.frame else { return; };
        let blocks: Vec<_> = frame.blocks.iter().filter(|block| if selection { self.selected == Some(block.id) } else { self.visible.contains(&block.id) && block.translated.is_none() }).cloned().collect();
        if blocks.is_empty() { self.status = "No untranslated visible regions. Select a text region for comparison.".into(); return; }
        let ids = blocks.iter().map(|block| block.id).collect();
        let settings = self.settings.provider.clone(); let generation = self.guard.current(); let tx = self.tx.clone();
        self.translation_busy = true; self.error = None; self.status = format!("Translating {} visible regions…", blocks.len());
        std::thread::spawn(move || { let result = provider::translate_blocks(&settings, &blocks).map_err(|error| format!("{error:#}")); let _ = tx.send(Event::Translated(generation, ids, result)); });
    }
    fn start_capture(&mut self, source: CaptureSource) {
        if matches!(source, CaptureSource::Monitor { .. }) { self.exclusion_ready = capture::exclude_own_windows().is_ok(); }
        if matches!(source, CaptureSource::Monitor { .. }) && !self.exclusion_ready { self.error = Some("Display capture is disabled because Windows could not exclude this app from capture. Choose another application's window to prevent recursion.".into()); return; }
        self.home = false; self.invalidate(); self.path = None; self.frame = None; self.textures = None; self.pending_ocr = None; self.capture_digest.clear(); self.paused = false;
        let (tx, rx) = mpsc::sync_channel(1); let stop = Arc::new(AtomicBool::new(false)); let worker_stop = stop.clone(); let worker_source = source.clone();
        std::thread::spawn(move || {
            while !worker_stop.load(Ordering::Relaxed) {
                let result = capture::grab(&worker_source).map_err(|error| format!("{error:#}"));
                let _ = tx.try_send(result);
                std::thread::sleep(Duration::from_millis(1000));
            }
        });
        self.status = "Watching selected source · automatic document detection enabled".into();
        self.capture = Some(CaptureFeed { stop, rx, source }); self.picker_open = false;
    }
    fn poll(&mut self, ctx: &egui::Context) {
        while let Ok(event) = self.rx.try_recv() {
            match event {
                Event::Cover(path, result) => {
                    if let Ok(image) = result { let texture = ctx.load_texture(format!("cover:{}",path.display()), egui::ColorImage::from_rgba_unmultiplied([image.width() as usize,image.height() as usize],image.as_raw()),egui::TextureOptions::LINEAR); self.covers.insert(path,texture); }
                }
                Event::Page(generation, result) | Event::Ocr(generation, result) => {
                    if matches!(self.path, None) { self.ocr_busy = false; }
                    if self.guard.accepts(generation) { match result { Ok(frame) => self.set_frame(frame, ctx), Err(error) => { self.loading = false; self.error = Some(error); } } }
                }
                Event::Translated(generation, ids, result) => {
                    self.translation_busy = false;
                    if self.guard.accepts(generation) { match result {
                        Ok(values) => { if let Some(frame) = &mut self.frame { for (id, value) in ids.into_iter().zip(values) { if let Some(block) = frame.blocks.iter_mut().find(|block| block.id == id) { block.translated = Some(value); } } } self.status = "Translation ready · select either pane to compare full text".into(); },
                        Err(error) => { self.error = Some(error); self.auto_translate = false; }
                    } }
                }
            }
        }
        if !self.paused {
            let incoming = self.capture.as_ref().and_then(|feed| feed.rx.try_recv().ok().map(|pixels| (pixels, feed.source.label())));
            if let Some((pixels, title)) = incoming { match pixels {
                Ok(image) => {
                    let digest = digest(image.as_raw());
                    if digest != self.capture_digest {
                        self.capture_digest = digest; let generation = self.invalidate();
                        self.frame = None; self.textures = None;
                        self.pending_ocr = Some((generation, image, title)); self.status = "Source changed · detecting document and recognizing locally…".into();
                    }
                }
                Err(error) => { self.invalidate(); self.frame = None; self.textures = None; self.pending_ocr = None; self.error = Some(format!("Source disconnected: {error}")); }
            } }
        }
        if !self.ocr_busy && !self.paused { if let Some((generation, image, title)) = self.pending_ocr.take() {
            self.ocr_busy = true; let tx = self.tx.clone(); let detect = self.settings.auto_detect;
            std::thread::spawn(move || { let result = capture::recognize_frame(image, title, detect).map_err(|error| format!("{error:#}")); let _ = tx.send(Event::Ocr(generation, result)); });
        } }
    }
    fn settings_ui(&mut self, ctx: &egui::Context) {
        let mut open = self.settings_open;
        egui::Window::new("Translation settings").open(&mut open).default_width(480.0).show(ctx, |ui| {
            let before = self.settings.provider.cache_key("");
            let previous_kind = self.settings.provider.kind;
            ui.label("Provider");
            egui::ComboBox::from_id_salt("provider").selected_text(format!("{:?}", previous_kind)).show_ui(ui, |ui| {
                for (kind, label) in [(ProviderKind::OpenAi, "OpenAI compatible"), (ProviderKind::Google, "Google Cloud Translation"), (ProviderKind::DeepL, "DeepL"), (ProviderKind::Local, "Local OpenAI-compatible endpoint")] { ui.selectable_value(&mut self.settings.provider.kind, kind, label); }
            });
            if previous_kind != self.settings.provider.kind {
                self.settings.provider.endpoint = match self.settings.provider.kind { ProviderKind::Google => "https://translation.googleapis.com", ProviderKind::DeepL => "https://api-free.deepl.com", ProviderKind::OpenAi => "https://api.openai.com/v1", ProviderKind::Local => "http://127.0.0.1:11434/v1" }.into();
                self.settings.provider.api_key = provider::load_key(self.settings.provider.kind).unwrap_or_default();
            }
            ui.label("API base URL"); ui.text_edit_singleline(&mut self.settings.provider.endpoint);
            ui.label("Model (OpenAI / local)"); ui.text_edit_singleline(&mut self.settings.provider.model);
            ui.label("API key · stored in Windows Credential Manager"); ui.add(egui::TextEdit::singleline(&mut self.settings.provider.api_key).password(true));
            ui.horizontal(|ui| { ui.label("From"); ui.text_edit_singleline(&mut self.settings.provider.source_language); ui.label("To"); ui.text_edit_singleline(&mut self.settings.provider.target_language); });
            ui.label("Glossary / terminology (OpenAI / local)"); ui.text_edit_multiline(&mut self.settings.provider.glossary);
            ui.checkbox(&mut self.settings.provider.cloud_consent, "Allow recognized / extracted text to leave this computer");
            ui.small("Capture permission is separate from cloud transfer. Images stay local; only text is sent. Local endpoints must be running; none is bundled.");
            if before != self.settings.provider.cache_key("") { self.invalidate(); self.auto_translate = false; if let Some(frame) = &mut self.frame { for block in &mut frame.blocks { block.translated = None; } } }
            if ui.button("Save settings").clicked() {
                match provider::save_key(self.settings.provider.kind, &self.settings.provider.api_key).and_then(|_| save_settings(&self.settings)) { Ok(()) => self.status = "Settings saved".into(), Err(error) => self.error = Some(format!("Cannot save settings: {error:#}")) }
            }
        }); self.settings_open = open;
    }
    fn picker_ui(&mut self, ctx: &egui::Context) {
        let mut open = self.picker_open; let mut chosen = None;
        egui::Window::new("Choose capture source").open(&mut open).default_width(560.0).show(ctx, |ui| {
            ui.label("Automatic PDF / document-region detection runs within this source. Your choice grants capture, not cloud upload.");
            if ui.button("Refresh windows and displays").clicked() { match capture::sources() { Ok(sources) => self.sources = sources, Err(error) => self.error = Some(error.to_string()) } }
            ui.checkbox(&mut self.settings.auto_detect, "Automatically detect document boundaries and changed text");
            egui::ScrollArea::vertical().max_height(420.0).show(ui, |ui| { for source in &self.sources { if ui.button(source.label()).clicked() { chosen = Some(source.clone()); } } });
        }); self.picker_open = open; if let Some(source) = chosen { self.start_capture(source); }
    }
    fn library_ui(&mut self, ui: &mut egui::Ui) {
        let query = self.search.to_lowercase();
        let mut entries: Vec<_> = self.settings.library.iter().filter(|entry| (!self.favorites_only || entry.favorite) && entry.title.to_lowercase().contains(&query)).cloned().collect();
        if self.sort_name { entries.sort_by_key(|entry| entry.title.to_lowercase()); }
        ui.add_space(20.0);
        ui.horizontal(|ui| {
            ui.selectable_value(&mut self.favorites_only,false,"My documents");
            ui.selectable_value(&mut self.favorites_only,true,"Favorites");
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center),|ui| {
                ui.selectable_value(&mut self.list_view,true,"List"); ui.selectable_value(&mut self.list_view,false,"Grid");
                if ui.button(if self.sort_name { "Name A–Z" } else { "Recent first" }).clicked() { self.sort_name = !self.sort_name; }
            });
        }); ui.add_space(10.0); ui.separator(); ui.add_space(18.0);
        if entries.is_empty() {
            ui.add_space(100.0); ui.vertical_centered(|ui| {
                ui.heading(if query.is_empty() { "A home for your documents" } else { "No matching documents" });
                ui.add_space(10.0); ui.label("Import a PDF to read the original and translated pages side by side.");
                ui.add_space(14.0); if ui.button("Import PDF").clicked() { if let Some(path) = rfd::FileDialog::new().add_filter("PDF", &["pdf"]).pick_file() { self.open_pdf(path,0); } }
            }); return;
        }
        for entry in entries.iter().take(12) {
            if self.cover_requested.insert(entry.path.clone()) {
                let tx = self.tx.clone(); let path = entry.path.clone();
                std::thread::spawn(move || { let result = pdf::load_page(&path,0,None).map(|frame| image::imageops::thumbnail(&frame.original,320,420)).map_err(|error| error.to_string()); let _ = tx.send(Event::Cover(path,result)); });
            }
        }
        let mut open = None; let mut toggle = None;
        egui::ScrollArea::vertical().show(ui,|ui| {
            if self.list_view {
                for entry in &entries { ui.horizontal(|ui| {
                    if ui.selectable_label(false,&entry.title).clicked() { open = Some((entry.path.clone(),entry.last_page)); }
                    ui.small(format!("PDF · page {}",entry.last_page+1));
                    if ui.small_button(if entry.favorite { "Unfavorite" } else { "Favorite" }).clicked() { toggle = Some(entry.path.clone()); }
                }); ui.separator(); }
            } else {
                let columns = (ui.available_width()/230.0).floor().max(1.0) as usize;
                for row in entries.chunks(columns) {
                    ui.horizontal_top(|ui| { for entry in row {
                        ui.allocate_ui(Vec2::new(210.0,300.0),|ui| {
                            let (rect,response) = ui.allocate_exact_size(Vec2::new(200.0,238.0),egui::Sense::click());
                            ui.painter().rect_filled(rect,4.0,Color32::from_rgb(242,243,244));
                            if let Some(cover) = self.covers.get(&entry.path) {
                                let scale = (180.0/cover.size_vec2().x).min(218.0/cover.size_vec2().y);
                                let page = Rect::from_center_size(rect.center(),cover.size_vec2()*scale);
                                ui.painter().rect_filled(page.expand(1.0),0.0,Color32::from_gray(210));
                                ui.painter().image(cover.id(),page,Rect::from_min_max(Pos2::ZERO,Pos2::new(1.0,1.0)),Color32::WHITE);
                            } else { ui.painter().text(rect.center(),egui::Align2::CENTER_CENTER,"PDF",egui::FontId::proportional(28.0),Color32::from_gray(140)); }
                            if response.clicked() { open = Some((entry.path.clone(),entry.last_page)); }
                            ui.add_space(8.0); if ui.add(egui::Label::new(egui::RichText::new(&entry.title).strong()).truncate().sense(egui::Sense::click())).on_hover_text(&entry.title).clicked() { open = Some((entry.path.clone(),entry.last_page)); }
                            ui.horizontal(|ui| { ui.small("PDF document"); if ui.small_button(if entry.favorite { "Unfavorite" } else { "Favorite" }).clicked() { toggle = Some(entry.path.clone()); } });
                        });
                    } }); ui.add_space(16.0);
                }
            }
        });
        if let Some(path) = toggle { if let Some(entry) = self.settings.library.iter_mut().find(|entry| entry.path == path) { entry.favorite = !entry.favorite; } let _ = save_settings(&self.settings); }
        if let Some((path,page)) = open { self.open_pdf(path,page); }
    }
    fn reader(&mut self, ui: &mut egui::Ui) {
        let Some(frame) = &self.frame else {
            ui.add_space(100.0); ui.vertical_centered(|ui| { ui.heading(if self.loading || self.ocr_busy { "Preparing your document…" } else { "Your documents, side by side." }); ui.add_space(12.0); ui.label("Open a local PDF for structured text, or follow a window with local OCR."); ui.label("Original artwork stays in place. Translation begins with what you can see."); }); return;
        };
        let Some((original, clean)) = &self.textures else { return; };
        let width = ((ui.available_width() - 32.0) / 2.0).max(100.0) * self.zoom;
        let size = Vec2::new(width, width * frame.original.height() as f32 / frame.original.width() as f32);
        let mut selected = self.selected; let mut visible = HashSet::new();
        egui::ScrollArea::both().id_salt(("paired-reader", self.path.clone(), frame.page_index)).show(ui, |ui| {
            ui.horizontal(|ui| { ui.allocate_ui(Vec2::new(size.x, 24.0), |ui| { ui.strong("ORIGINAL"); }); ui.strong(format!("TRANSLATED · {}", self.settings.provider.target_language.to_uppercase())); });
            ui.horizontal_top(|ui| {
                for translated in [false, true] {
                    let (rect, _) = ui.allocate_exact_size(size, egui::Sense::hover());
                    ui.painter().image(original.id(), rect, Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)), Color32::WHITE);
                    for block in &frame.blocks {
                        let [x,y,w,h] = block.rect.at_size(size.x,size.y);
                        let region = Rect::from_min_size(rect.min + Vec2::new(x,y), Vec2::new(w,h));
                        if region.intersects(ui.clip_rect()) { visible.insert(block.id); }
                        let response = ui.interact(region, ui.id().with((translated, block.id)), egui::Sense::click());
                        if response.clicked() { selected = Some(block.id); }
                        if translated { if let Some(text) = &block.translated {
                            let can_replace = self.capture.is_none() && !frame.quality.starts_with("Scanned") || block.background.is_some();
                            if can_replace {
                                let erase = region.expand(1.0).intersect(rect);
                                let uv = Rect::from_min_max(Pos2::new((erase.min.x - rect.min.x)/size.x, (erase.min.y - rect.min.y)/size.y), Pos2::new((erase.max.x - rect.min.x)/size.x, (erase.max.y - rect.min.y)/size.y));
                                ui.painter().image(clean.id(), erase, uv, Color32::WHITE);
                                let mut font = (h * 0.75).min(22.0).max(8.0);
                                let galley = loop { let galley = ui.painter().layout(text.clone(), egui::FontId::proportional(font), Color32::from_rgb(28,31,28), w); if galley.size().y <= h || font <= 8.0 { break galley; } font -= 0.5; };
                                if galley.size().y <= h && galley.size().x <= w + 1.0 { ui.painter().with_clip_rect(region.intersect(ui.clip_rect())).galley(region.min, galley, Color32::BLACK); }
                                else { ui.painter().rect_filled(region, 0.0, Color32::from_rgb(241,235,214)); ui.painter().text(region.center(), egui::Align2::CENTER_CENTER, "Read full translation below", egui::FontId::proportional(9.0), Color32::BLACK); }
                            } else { ui.painter().rect_stroke(region, 0.0, (1.5, Color32::from_rgb(170,120,45)), egui::StrokeKind::Inside); }
                        } }
                        if selected == Some(block.id) || response.hovered() { ui.painter().rect_stroke(region.expand(2.0), 1.0, (1.5, Color32::from_rgb(77,123,89)), egui::StrokeKind::Outside); }
                        response.on_hover_text(if translated { block.translated.as_deref().unwrap_or("Not translated yet · click to select") } else { &block.source });
                    }
                }
            });
        });
        self.selected = selected; self.visible = visible;
    }
}
impl eframe::App for MirrorApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if !self.exclusion_attempted { self.exclusion_attempted = true; }
        self.poll(ctx); ctx.request_repaint_after(Duration::from_millis(100));
        let dropped = ctx.input(|input| input.raw.dropped_files.iter().find_map(|file| file.path.clone()));
        if let Some(path) = dropped { self.open_pdf(path, 0); }
        egui::SidePanel::left("library").exact_width(265.0).frame(egui::Frame::new().fill(Color32::from_rgb(225,235,245)).inner_margin(20.0)).show(ctx, |ui| {
            ui.add_space(15.0); ui.strong("Workspace"); ui.add_space(28.0);
            if ui.add_sized([220.0,34.0],egui::Button::selectable(self.home,"Home")).clicked() { self.home = true; }
            ui.add_space(24.0); ui.strong("My documents"); ui.add_space(12.0);
            let mut chosen = None;
            for entry in &self.settings.library { if ui.selectable_label(!self.home && self.path.as_ref() == Some(&entry.path),format!("    {}",entry.title)).on_hover_text(entry.path.display().to_string()).clicked() { chosen = Some((entry.path.clone(), entry.last_page)); } }
            if let Some((path,page)) = chosen { self.open_pdf(path,page); }
            ui.with_layout(egui::Layout::bottom_up(egui::Align::LEFT),|ui| {
                if ui.button("Settings").clicked() { self.settings_open = true; }
                if ui.button("Follow window / display").clicked() { self.picker_open = true; match capture::sources() { Ok(sources) => self.sources = sources, Err(error) => self.error = Some(error.to_string()) } }
                if ui.button("Import PDF").clicked() { if let Some(path) = rfd::FileDialog::new().add_filter("PDF", &["pdf"]).pick_file() { self.open_pdf(path,0); } }
            });
        });
        if self.home {
            egui::TopBottomPanel::top("home-header").frame(egui::Frame::new().fill(Color32::WHITE).inner_margin(24.0)).show(ctx,|ui| { ui.horizontal(|ui| {
                ui.heading("Home"); ui.add_space(55.0);
                ui.add_sized([ui.available_width()-100.0,34.0],egui::TextEdit::singleline(&mut self.search).hint_text("Search documents…"));
                if ui.add_sized([36.0,34.0],egui::Button::new("+")).on_hover_text("Import PDF").clicked() { if let Some(path) = rfd::FileDialog::new().add_filter("PDF", &["pdf"]).pick_file() { self.open_pdf(path,0); } }
            }); });
        } else { egui::TopBottomPanel::top("toolbar").show(ctx, |ui| { ui.horizontal(|ui| {
            ui.strong(self.frame.as_ref().map(|frame| frame.title.as_str()).unwrap_or("Library"));
            if let Some(frame) = &self.frame { if self.path.is_some() {
                let page = frame.page_index; let count = frame.page_count; let path = self.path.clone().unwrap();
                if ui.add_enabled(page > 0, egui::Button::new("Previous")).clicked() { self.open_pdf(path.clone(),page-1); }
                ui.label(format!("{} / {}",page+1,count));
                if ui.add_enabled(page+1 < count, egui::Button::new("Next")).clicked() { self.open_pdf(path,page+1); }
            } }
            ui.add(egui::Slider::new(&mut self.zoom,0.5..=2.5).text("Zoom"));
            if ui.add_enabled(!self.translation_busy && self.frame.is_some(),egui::Button::new("Translate viewport")).clicked() { self.translate(false); }
            ui.checkbox(&mut self.auto_translate,"Auto translate");
            if ui.button(if self.paused { "Resume" } else { "Pause" }).clicked() { self.paused = !self.paused; self.invalidate(); self.pending_ocr = None; self.capture_digest.clear(); }
        }); }); }
        egui::TopBottomPanel::bottom("status").show(ctx, |ui| {
            if let Some(error) = &self.error { ui.colored_label(Color32::from_rgb(161,48,35),error); }
            ui.horizontal(|ui| { if self.loading || self.translation_busy || self.ocr_busy { ui.spinner(); } ui.label(if self.paused { "Paused · in-flight results invalidated" } else { &self.status }); });
            if self.error.is_some() && ui.button("Retry").clicked() { self.error = None; if let Some(path) = self.path.clone() { let page = self.frame.as_ref().map(|frame| frame.page_index).unwrap_or(0); self.open_pdf(path,page); } else { self.capture_digest.clear(); } }
            if let Some(block) = self.frame.as_ref().and_then(|frame| frame.blocks.iter().find(|block| Some(block.id) == self.selected)).cloned() {
                ui.separator(); ui.horizontal(|ui| { ui.strong("Selection comparison"); if ui.button("Translate selection").clicked() { self.translate(true); } if ui.button("Close comparison").clicked() { self.selected = None; } });
                egui::ScrollArea::vertical().id_salt("comparison").max_height(170.0).show(ui, |ui| { ui.columns(2,|columns| { columns[0].add(egui::Label::new(&block.source).selectable(true)); columns[1].add(egui::Label::new(block.translated.as_deref().unwrap_or("Not translated. Choose Translate selection.")).selectable(true)); }); });
            }
        });
        egui::CentralPanel::default().frame(egui::Frame::new().fill(Color32::WHITE).inner_margin(28.0)).show(ctx, |ui| { if self.home { self.library_ui(ui); } else { self.reader(ui); } });
        if self.auto_translate && self.error.is_none() && !self.loading && self.last_view_change.elapsed() > Duration::from_millis(450) && self.frame.as_ref().is_some_and(|frame| frame.blocks.iter().any(|block| self.visible.contains(&block.id) && block.translated.is_none())) { self.translate(false); }
        if self.settings_open { self.settings_ui(ctx); } if self.picker_open { self.picker_ui(ctx); }
    }
}
fn main() -> eframe::Result {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--smoke-pdf") { return smoke(&args).map_err(|error| eframe::Error::AppCreation(error.into())); }
    let initial = args.get(1).map(PathBuf::from);
    eframe::run_native("Documents", eframe::NativeOptions { viewport: egui::ViewportBuilder::default().with_inner_size([1380.0,900.0]).with_min_inner_size([900.0,600.0]), ..Default::default() }, Box::new(move |cc| Ok(Box::new(MirrorApp::new(cc,initial)))))
}
fn smoke(args: &[String]) -> anyhow::Result<()> {
    let path = PathBuf::from(args.get(2).ok_or_else(|| anyhow::anyhow!("--smoke-pdf requires a PDF path"))?);
    let output = PathBuf::from(args.get(3).map(String::as_str).unwrap_or("desktop/proof")); std::fs::create_dir_all(&output)?;
    let frame = pdf::load_page(&path,0,None)?;
    anyhow::ensure!(!frame.blocks.is_empty(),"Fixture has no extracted text");
    frame.original.save(output.join("native-original.png"))?; frame.clean.save(output.join("native-clean.png"))?;
    let changed = frame.original.pixels().zip(frame.clean.pixels()).filter(|(a,b)| a != b).count();
    anyhow::ensure!(changed > 0,"Text suppression did not change any pixels");
    let report = serde_json::json!({"pdf":path,"pages":frame.page_count,"blocks":frame.blocks.len(),"width":frame.original.width(),"height":frame.original.height(),"changed_pixels":changed,"quality":frame.quality,"source_text":frame.blocks.iter().map(|block| &block.source).collect::<Vec<_>>()});
    std::fs::write(output.join("native-smoke.json"),serde_json::to_vec_pretty(&report)?)?; println!("{report}"); Ok(())
}
