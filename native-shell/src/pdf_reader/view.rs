use super::*;

fn input_row(label: &'static str, field: &Entity<TextField>) -> Div {
    div().flex().flex_col().gap(px(4.)).w_full().child(div().text_size(px(11.)).text_color(Theme::text_caption()).child(label))
        .child(div().w_full().min_h(px(30.)).px(px(8.)).py(px(5.)).rounded(px(6.)).border_1().border_color(Theme::line_border()).child(field.clone()))
}

fn fit_text(text: &str, width: f32, height: f32, ideal_size: f32, bold: bool, color: Hsla, window: &Window) -> Option<(f32, Vec<WrappedLine>)> {
    if width < 8. || height < 8. { return None; }
    let mut face = font(theme::UI_FONT); if bold { face.weight = FontWeight::BOLD; }
    let run = TextRun { len: text.len(), font: face, color, background_color: None, underline: None, strikethrough: None };
    for scale in [1., 0.95, 0.9, 0.85, 0.8, 0.75, 0.7] {
        let size = ideal_size.clamp(8., 48.) * scale;
        let lines = window.text_system().shape_text(text.to_string().into(), px(size), std::slice::from_ref(&run), Some(px(width - 2.)), None).ok()?;
        let total: f32 = lines.iter().map(|line| f32::from(line.size(px(size * 1.14)).height)).sum();
        if total <= height - 2. { return Some((size, lines.into_iter().collect())); }
    }
    None
}

impl PdfReader {
    fn toolbar(&self, cx: &mut Context<Self>) -> Div {
        let capture_mode = matches!(self.source, Source::Capture(_));
        div().flex().items_center().flex_wrap().gap(px(6.)).px(px(16.)).py(px(10.)).border_b_1().border_color(Theme::line_border())
            .when(!capture_mode, |el| el
                .child(ui::secondary_button("pdf-previous", "Previous").on_click(cx.listener(|reader, _, _, cx| reader.navigate_user(-1, cx))))
                .child(div().text_color(Theme::text_caption()).child(format!("{} / {}", self.page + 1, self.page_count.max(1))))
                .child(ui::secondary_button("pdf-next", "Next").on_click(cx.listener(|reader, _, _, cx| reader.navigate_user(1, cx)))))
            .when(capture_mode, |el| el.child(ui::secondary_button("pdf-source-live", if self.capture_live { "Freeze source" } else { "Resume source" })
                .on_click(cx.listener(|reader, _, _, cx| {
                    reader.capture_live = !reader.capture_live; reader.epoch.source();
                    if reader.capture_live { reader.failed = false; reader.error = None; reader.load_needed = true; }
                    cx.notify();
                }))))
            .child(ui::secondary_button("pdf-zoom-out", "−").on_click(cx.listener(|reader, _, _, cx| { reader.zoom = (reader.zoom - 0.15).max(0.55); cx.notify(); })))
            .child(div().text_color(Theme::text_caption()).child(format!("{:.0}%", self.zoom * 100.)))
            .child(ui::secondary_button("pdf-zoom-in", "+").on_click(cx.listener(|reader, _, _, cx| { reader.zoom = (reader.zoom + 0.15).min(3.); cx.notify(); })))
            .child(ui::secondary_button("pdf-split", if self.split { "Translation only" } else { "Split view" }).on_click(cx.listener(|reader, _, _, cx| { reader.split = !reader.split; cx.notify(); })))
            .child(ui::secondary_button("pdf-target", "Language / provider").on_click(cx.listener(|reader, _, _, cx| { reader.show_settings = !reader.show_settings; cx.notify(); })))
            .child(div().text_color(Theme::text_caption()).child(format!("→ {}", self.profile.target_language)))
            .child(ui::secondary_button("pdf-pause", if self.paused { "Resume" } else { "Pause" }).on_click(cx.listener(|reader, _, _, cx| reader.toggle_pause(cx))))
            .child(ui::secondary_button("pdf-retry", "Retry").on_click(cx.listener(|reader, _, _, cx| reader.retry(cx))))
            .when(self.browser_linked, |el| el.child(ui::secondary_button("pdf-browser-detach", "Detach Chrome").on_click(cx.listener(|reader, _, _, cx| reader.set_browser_linked(false, cx)))))
    }
    fn settings_panel(&self, cx: &mut Context<Self>) -> Div {
        let mut kinds = div().flex().flex_wrap().gap(px(6.));
        for (index, label, kind) in [(0_usize, "OpenAI", ProviderKind::OpenAi), (1, "Google", ProviderKind::Google), (2, "DeepL", ProviderKind::DeepL), (3, "Local", ProviderKind::Local)] {
            kinds = kinds.child(div().id(("pdf-provider", index)).px(px(12.)).py(px(6.)).rounded(px(6.)).cursor_pointer()
                .bg(if self.draft_kind == kind { Theme::fill_hover() } else { Theme::bg_body() })
                .border_1().border_color(if self.draft_kind == kind { Theme::primary() } else { Theme::line_border() })
                .child(label).on_click(cx.listener(move |reader, _, _, cx| reader.switch_kind(kind, cx))));
        }
        div().flex().flex_col().gap(px(10.)).p(px(16.)).border_b_1().border_color(Theme::line_border())
            .child(kinds)
            .child(div().flex().gap(px(12.)).child(div().flex_1().min_w_0().child(input_row("Endpoint · base URL (HTTPS, or loopback HTTP)", &self.fields.endpoint)))
                .child(div().w(px(190.)).child(input_row("Model · OpenAI-compatible providers", &self.fields.model))))
            .child(div().flex().gap(px(12.)).child(div().flex_1().min_w_0().child(input_row("Source language", &self.fields.source)))
                .child(div().flex_1().min_w_0().child(input_row("Target language code", &self.fields.target))))
            .child(input_row("Glossary · OpenAI / local only", &self.fields.glossary))
            .child(input_row("API key · hidden while typing; existing key remains unless replaced", &self.fields.key))
            .child(div().id("pdf-cloud-consent").flex().gap(px(8.)).items_center().cursor_pointer()
                .child(div().size(px(16.)).rounded(px(3.)).border_1().border_color(Theme::line_border()).text_size(px(12.)).child(if self.draft_consent { "✓" } else { "" }))
                .child("Allow document text to leave this computer for cloud translation")
                .on_click(cx.listener(|reader, _, _, cx| { reader.draft_consent = !reader.draft_consent; reader.profile_dirty = true; cx.notify(); })))
            .child(div().text_size(px(11.)).text_color(Theme::text_caption()).child("OCR stays local. Loopback providers work without cloud consent. Credentials are stored in the native vault, never in the library. Translation cache is local."))
            .child(div().flex().items_center().gap(px(8.))
                .child(ui::primary_button("pdf-save-provider", if self.profile_saving { "Saving…" } else { "Save settings" }).on_click(cx.listener(|reader, _, _, cx| reader.save_profile(false, cx))))
                .child(ui::secondary_button("pdf-forget-key", "Forget key").on_click(cx.listener(|reader, _, _, cx| reader.save_profile(true, cx))))
                .child(ui::secondary_button("pdf-close-settings", "Close").on_click(cx.listener(|reader, _, _, cx| { reader.show_settings = false; cx.notify(); })))
                .when(self.profile_dirty, |el| el.child(div().text_color(Theme::text_caption()).child("Unsaved changes"))))
    }
    fn page_pane(&self, translated: bool, width: f32, height: f32, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let Some(prepared) = &self.prepared else { return div().into_any_element(); };
        let mut paper = div().relative().flex_none().w(px(width)).h(px(height)).overflow_hidden()
            .child(img(prepared.original.clone()).absolute().inset_0().w(px(width)).h(px(height)).object_fit(ObjectFit::Fill));
        for (index, block) in prepared.frame.blocks.iter().enumerate() {
            let [x, y, w, h] = block.rect.at_size(width, height);
            if translated && let (Some(text), Some(patch)) = (&block.translated, &prepared.patches[index])
                && let Some((size, lines)) = fit_text(text, w, h + 2., block.font_size * height, block.bold, patch.text_color, window) {
                let line_height = px(size * 1.14);
                let [patch_x, patch_y, patch_w, patch_h] = patch.rect.at_size(width, height);
                paper = paper.child(div().absolute().left(px(patch_x)).top(px(patch_y)).w(px(patch_w)).h(px(patch_h)).overflow_hidden()
                    .child(img(patch.image.clone()).absolute().inset_0().w(px(patch_w)).h(px(patch_h)).object_fit(ObjectFit::Fill)));
                paper = paper.child(div().absolute().left(px(x)).top(px(y)).w(px(w)).h(px(h)).overflow_hidden()
                    .child(canvas(move |_, _, _| lines, move |bounds, lines, window, cx| {
                        let mut origin = bounds.origin + point(px(1.), px(1.));
                        for line in lines {
                            let _ = line.paint(origin, line_height, TextAlign::Left, Some(bounds), window, cx);
                            origin.y += line.size(line_height).height;
                        }
                    }).absolute().inset_0()));
            }
            let selected = self.selected == Some(index);
            paper = paper.child(div().id((if translated { "pdf-target-region" } else { "pdf-source-region" }, index)).absolute().left(px(x)).top(px(y)).w(px(w.max(5.))).h(px(h.max(5.)))
                .cursor_pointer().border_1().border_color(if selected { Theme::primary() } else { transparent_black() })
                .hover(|s| s.border_color(Theme::primary()))
                .on_click(cx.listener(move |reader, _, _, cx| reader.select(index, cx))));
        }
        paper.into_any_element()
    }
    fn scroll_pane(&self, index: usize, window: &Window, cx: &mut Context<Self>) -> Div {
        let pane = self.panes[index]; let content = pane.content(geometry::limits(self.panes, self.split));
        let last_input = self.last_input.clone(); let native_input = self.native_scroll_input.clone();
        div().flex().flex_col().flex_none().w(px(pane.viewport[0])).h_full().min_h_0().overflow_hidden()
            .child(div().h(px(32.)).flex_none().px(px(16.)).flex().items_center().text_size(px(11.)).text_color(Theme::text_caption()).overflow_hidden()
                .child(if index == 1 { format!("TRANSLATION · {} · linked selection", self.profile.target_language) } else { "ORIGINAL · linked region selection".into() }))
            .child(div().relative().flex_1().min_h_0()
                .child(div().id(if index == 0 { "pdf-source-scroll" } else { "pdf-target-scroll" }).absolute().inset_0().overflow_scroll().track_scroll(&self.scrolls[index])
                    .on_scroll_wheel(move |_, _, _| { last_input.set(index); native_input.set(true); })
                    .child(div().relative().flex_none().w(px(content[0])).h(px(content[1]))
                        .child(div().absolute().left(px(geometry::INSET)).top(px(geometry::INSET))
                            .child(self.page_pane(index == 1, pane.page[0], pane.page[1], window, cx)))))
                .child(self.scrollbars[index].render(&self.scrolls[index], index, self.last_input.clone(), self.native_scroll_input.clone(), cx.entity_id())))
    }
    fn divider_overlay(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.divider_drag { return None; }
        Some(deferred(div().id("pdf-divider-overlay").absolute().inset_0().occlude().cursor(CursorStyle::ResizeLeftRight)
            .on_mouse_move(cx.listener(|reader, ev: &MouseMoveEvent, _, cx| {
                if ev.pressed_button != Some(MouseButton::Left) { reader.divider_drag = false; cx.notify(); return; }
                let bounds = reader.viewport.get();
                reader.split_ratio = geometry::divider_ratio(f32::from(ev.position.x), f32::from(bounds.left()), f32::from(bounds.size.width));
                cx.stop_propagation(); cx.notify();
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|reader, _, _, cx| { reader.divider_drag = false; cx.stop_propagation(); cx.notify(); }))
            .on_mouse_up_out(MouseButton::Left, cx.listener(|reader, _, _, cx| { reader.divider_drag = false; cx.notify(); })))
            .with_priority(4).into_any_element())
    }
    fn selected_panel(&self, cx: &mut Context<Self>) -> Div {
        div().flex().flex_col().gap(px(10.)).p(px(12.)).border_1().border_color(Theme::line_border()).rounded(px(8.))
            .child(div().flex().gap(px(8.)).items_center().child(div().flex_1().child(format!("Selected region {} · selectable full text", self.selected.unwrap_or(0) + 1)))
                .child(ui::secondary_button("pdf-translate-selected", "Translate selected").on_click(cx.listener(|reader, _, _, cx| {
                    reader.selected_request = true; reader.failed = false; reader.error = None; reader.paused = false; reader.pump(cx); cx.notify();
                })))
                .child(ui::secondary_button("pdf-copy-source", "Copy source").on_click(cx.listener(|reader, _, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(reader.source_full.clone())))))
                .child(ui::secondary_button("pdf-copy-target", "Copy translation").on_click(cx.listener(|reader, _, _, cx| {
                    if let Some(text) = reader.selected.and_then(|i| reader.prepared.as_ref()?.frame.blocks.get(i)?.translated.as_ref()) { cx.write_to_clipboard(ClipboardItem::new_string(text.clone())); }
                }))))
            .child(div().flex().gap(px(16.)).child(div().flex_1().min_w_0().child(self.source_text.clone()))
                .child(div().flex_1().min_w_0().child(self.target_text.clone())))
    }
    fn paired_text(&self, cx: &mut Context<Self>) -> Div {
        let mut text = div().flex().flex_col().gap(px(12.)).w_full()
            .child(div().flex().items_center().gap(px(8.)).child(div().flex_1().child("Full paired reading · original artwork and overflow remain intact above"))
                .child(ui::secondary_button("pdf-translate-page", "Translate full page").on_click(cx.listener(|reader, _, _, cx| {
                    reader.translate_all = true; reader.failed = false; reader.error = None; reader.paused = false; reader.pump(cx); cx.notify();
                }))));
        if let Some(prepared) = &self.prepared {
            for (index, block) in prepared.frame.blocks.iter().enumerate() {
                let target = block.translated.clone().unwrap_or_else(|| if state::preserve_formula(&block.source) { "Formula retained in original pixels".into() } else { "Not translated · scroll the page region into view, or translate full page".into() });
                text = text.child(div().id(("pdf-paired", index)).flex().gap(px(16.)).p(px(10.)).rounded(px(6.)).border_1()
                    .border_color(if self.selected == Some(index) { Theme::primary() } else { Theme::line_border() }).cursor_pointer()
                    .child(div().w(px(24.)).flex_none().text_color(Theme::text_caption()).child(format!("{}", index + 1)))
                    .child(div().flex_1().min_w_0().child(block.source.clone()))
                    .child(div().flex_1().min_w_0().text_color(if block.translated.is_some() { Theme::text() } else { Theme::text_caption() }).child(target))
                    .on_click(cx.listener(move |reader, _, _, cx| reader.select(index, cx))));
            }
        }
        text
    }
}

impl Render for PdfReader {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_scroll(cx);
        let viewport = self.viewport.clone(); let entity = cx.entity_id();
        let mut pages = div().id("pdf-document-panes").relative().flex().flex_1().min_h_0().min_w_0().overflow_hidden()
            .child(canvas(move |bounds, _, cx| {
                if viewport.get() != bounds { viewport.set(bounds); cx.notify(entity); }
            }, |_, _, _, _| {}).absolute().inset_0());
        if self.prepared.is_some() {
            if self.split {
                pages = pages.child(self.scroll_pane(0, window, cx))
                    .child(div().id("pdf-divider").flex_none().w(px(geometry::DIVIDER)).h_full().flex().items_center().justify_center()
                        .cursor(CursorStyle::ResizeLeftRight).bg(Theme::bg_body()).hover(|s| s.bg(Theme::fill_hover()))
                        .child(div().w(px(4.)).h(px(48.)).rounded(px(2.)).bg(if self.divider_drag { Theme::primary() } else { Theme::line_border() }))
                        .on_mouse_down(MouseButton::Left, cx.listener(|reader, ev: &MouseDownEvent, _, cx| {
                            if ev.click_count == 2 { reader.split_ratio = 0.5; } else { reader.divider_drag = true; }
                            cx.stop_propagation(); cx.notify();
                        })));
            }
            pages = pages.child(self.scroll_pane(1, window, cx));
        } else {
            pages = pages.child(div().p(px(24.)).text_color(Theme::text_caption()).child(if self.loading { "Opening document · PDFium and local OCR run in the background" } else { "Original is unavailable. Check the error and Retry." }));
        }
        let source_label = match &self.source { Source::Pdf(_) => format!("Local PDF · {} pages · original retained in your library", self.page_count.max(1)), Source::Capture(source) => format!("{} · {}", if self.capture_live { "Live source" } else { "Source frozen" }, source.label()) };
        let quality = self.prepared.as_ref().map(|p| p.frame.quality.clone()).unwrap_or_default();
        div().relative().size_full().min_w_0().min_h_0().flex().flex_col().bg(Theme::bg_body()).text_color(Theme::text()).font_family(theme::UI_FONT).text_size(px(12.)).line_height(px(18.))
            .child(self.toolbar(cx))
            .when(self.show_settings, |el| el.child(div().id("pdf-settings-scroll").max_h(px(460.)).overflow_y_scroll().child(self.settings_panel(cx))))
            .child(div().px(px(16.)).py(px(6.)).text_size(px(11.)).text_color(Theme::text_caption()).child(source_label))
            .when_some(self.error.clone(), |el, error| el.child(div().px(px(16.)).py(px(8.)).text_color(Theme::danger()).child(error)))
            .child(pages)
            .when(self.prepared.is_some(), |el| el.child(div().flex_none().px(px(16.)).py(px(6.)).border_t_1().border_color(Theme::line_border())
                .child(ui::secondary_button("pdf-paired-toggle", if self.show_paired { "Hide full paired reading" } else { "Full paired reading" })
                    .on_click(cx.listener(|reader, _, _, cx| { reader.show_paired = !reader.show_paired; cx.notify(); })))))
            .when(self.show_paired && self.prepared.is_some(), |el| el.child(div().id("pdf-paired-scroll").max_h(px(200.)).flex_none().overflow_y_scroll().px(px(16.)).py(px(8.)).child(self.paired_text(cx))))
            .when(self.selected.is_some(), |el| el.child(div().id("pdf-selected-scroll").max_h(px(240.)).flex_none().overflow_y_scroll().px(px(16.)).py(px(8.)).child(self.selected_panel(cx))))
            .child(div().px(px(16.)).py(px(8.)).border_t_1().border_color(Theme::line_border()).text_size(px(11.)).text_color(Theme::text_caption())
                .child(format!("{}{}{}", self.status, if quality.is_empty() { "" } else { " · " }, quality)))
            .when_some(self.divider_overlay(cx), |el, overlay| el.child(overlay))
    }
}
