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
                .child(ui::secondary_button("pdf-previous", tr3("上一页", "Previous", "Trước")).on_click(cx.listener(|reader, _, _, cx| reader.navigate_user(-1, cx))))
                .child(div().text_color(Theme::text_caption()).child(format!("{} / {}", self.page + 1, self.page_count.max(1))))
                .child(ui::secondary_button("pdf-next", tr3("下一页", "Next", "Sau")).on_click(cx.listener(|reader, _, _, cx| reader.navigate_user(1, cx)))))
            .when(capture_mode, |el| el.child(ui::secondary_button("pdf-source-live", if self.capture_live { tr3("冻结来源", "Freeze source", "Đóng băng nguồn") } else { tr3("恢复来源", "Resume source", "Tiếp tục nguồn") })
                .on_click(cx.listener(|reader, _, _, cx| {
                    reader.capture_live = !reader.capture_live; reader.epoch.source();
                    if reader.capture_live { reader.failed = false; reader.error = None; reader.load_needed = true; }
                    cx.notify();
                }))))
            .child(ui::secondary_button("pdf-zoom-out", "−").on_click(cx.listener(|reader, _, _, cx| { reader.zoom = (reader.zoom - 0.15).max(0.55); cx.notify(); })))
            .child(div().text_color(Theme::text_caption()).child(format!("{:.0}%", self.zoom * 100.)))
            .child(ui::secondary_button("pdf-zoom-in", "+").on_click(cx.listener(|reader, _, _, cx| { reader.zoom = (reader.zoom + 0.15).min(3.); cx.notify(); })))
            .child(ui::secondary_button("pdf-split", if self.split { tr3("仅译文", "Translation only", "Chỉ bản dịch") } else { tr3("分栏视图", "Split view", "Chia đôi") }).on_click(cx.listener(|reader, _, _, cx| { reader.split = !reader.split; cx.notify(); })))
            .child(ui::secondary_button("pdf-target", tr3("语言 / 提供方", "Language / provider", "Ngôn ngữ / nhà cung cấp")).on_click(cx.listener(|reader, _, _, cx| { reader.show_settings = !reader.show_settings; cx.notify(); })))
            .child(div().text_color(Theme::text_caption()).child(format!("→ {}", self.profile.target_language)))
            .child(ui::secondary_button("pdf-pause", if self.paused { tr3("继续", "Resume", "Tiếp tục") } else { tr3("暂停", "Pause", "Tạm dừng") }).on_click(cx.listener(|reader, _, _, cx| reader.toggle_pause(cx))))
            .child(ui::secondary_button("pdf-retry", tr3("重试", "Retry", "Thử lại")).on_click(cx.listener(|reader, _, _, cx| reader.retry(cx))))
            .when(self.browser_linked, |el| el.child(ui::secondary_button("pdf-browser-detach", tr3("断开 Chrome", "Detach Chrome", "Ngắt liên kết Chrome")).on_click(cx.listener(|reader, _, _, cx| reader.set_browser_linked(false, cx)))))
    }
    fn settings_panel(&self, cx: &mut Context<Self>) -> Div {
        let mut kinds = div().flex().flex_wrap().gap(px(6.));
        for (index, label, kind) in [(0_usize, "OpenAI", ProviderKind::OpenAi), (1, "Google", ProviderKind::Google), (2, "DeepL", ProviderKind::DeepL), (3, tr3("本地", "Local", "Cục bộ"), ProviderKind::Local)] {
            kinds = kinds.child(div().id(("pdf-provider", index)).px(px(12.)).py(px(6.)).rounded(px(6.)).cursor_pointer()
                .bg(if self.draft_kind == kind { Theme::fill_hover() } else { Theme::bg_body() })
                .border_1().border_color(if self.draft_kind == kind { Theme::primary() } else { Theme::line_border() })
                .child(label).on_click(cx.listener(move |reader, _, _, cx| reader.switch_kind(kind, cx))));
        }
        div().flex().flex_col().gap(px(10.)).p(px(16.)).border_b_1().border_color(Theme::line_border())
            .child(kinds)
            .child(div().flex().gap(px(12.)).child(div().flex_1().min_w_0().child(input_row(tr3("端点 · 基础 URL（HTTPS 或本机回环 HTTP）", "Endpoint · base URL (HTTPS, or loopback HTTP)", "Điểm cuối · URL gốc (HTTPS hoặc HTTP vòng lặp cục bộ)"), &self.fields.endpoint)))
                .child(div().w(px(190.)).child(input_row(tr3("模型 · OpenAI 兼容提供方", "Model · OpenAI-compatible providers", "Mô hình · nhà cung cấp tương thích OpenAI"), &self.fields.model))))
            .child(div().flex().gap(px(12.)).child(div().flex_1().min_w_0().child(input_row(tr3("源语言", "Source language", "Ngôn ngữ nguồn"), &self.fields.source)))
                .child(div().flex_1().min_w_0().child(input_row(tr3("目标语言代码", "Target language code", "Mã ngôn ngữ đích"), &self.fields.target))))
            .child(input_row(tr3("术语表 · 仅 OpenAI / 本地", "Glossary · OpenAI / local only", "Bảng thuật ngữ · chỉ OpenAI / cục bộ"), &self.fields.glossary))
            .child(input_row(tr3("API 密钥 · 输入时隐藏；除非替换，现有密钥保留", "API key · hidden while typing; existing key remains unless replaced", "Khoá API · ẩn khi nhập; khoá hiện có vẫn giữ trừ khi thay thế"), &self.fields.key))
            .child(div().id("pdf-cloud-consent").flex().gap(px(8.)).items_center().cursor_pointer()
                .child(div().size(px(16.)).rounded(px(3.)).border_1().border_color(Theme::line_border()).text_size(px(12.)).child(if self.draft_consent { "✓" } else { "" }))
                .child(tr3("允许将文档文本发送到云端进行翻译", "Allow document text to leave this computer for cloud translation", "Cho phép gửi văn bản tài liệu lên đám mây để dịch"))
                .on_click(cx.listener(|reader, _, _, cx| { reader.draft_consent = !reader.draft_consent; reader.profile_dirty = true; cx.notify(); })))
            .child(div().text_size(px(11.)).text_color(Theme::text_caption()).child(tr3("OCR 在本地运行。回环提供方无需云端同意即可使用。凭据保存在本机凭据库，不会写入文档库。翻译缓存保存在本地。", "OCR stays local. Loopback providers work without cloud consent. Credentials are stored in the native vault, never in the library. Translation cache is local.", "OCR chạy cục bộ. Nhà cung cấp vòng lặp cục bộ hoạt động mà không cần đồng ý đám mây. Thông tin đăng nhập được lưu trong kho bảo mật trên máy, không bao giờ trong thư viện. Bộ nhớ đệm bản dịch là cục bộ.")))
            .child(div().flex().items_center().gap(px(8.))
                .child(ui::primary_button("pdf-save-provider", if self.profile_saving { tr3("正在保存…", "Saving…", "Đang lưu…") } else { tr3("保存设置", "Save settings", "Lưu cài đặt") }).on_click(cx.listener(|reader, _, _, cx| reader.save_profile(false, cx))))
                .child(ui::secondary_button("pdf-forget-key", tr3("忘记密钥", "Forget key", "Quên khoá")).on_click(cx.listener(|reader, _, _, cx| reader.save_profile(true, cx))))
                .child(ui::secondary_button("pdf-close-settings", tr3("关闭", "Close", "Đóng")).on_click(cx.listener(|reader, _, _, cx| { reader.show_settings = false; cx.notify(); })))
                .when(self.profile_dirty, |el| el.child(div().text_color(Theme::text_caption()).child(tr3("未保存的更改", "Unsaved changes", "Thay đổi chưa lưu")))))
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
                .child(if index == 1 { format!("{} · {} · {}", tr3("翻译", "TRANSLATION", "BẢN DỊCH"), self.profile.target_language, tr3("联动选择", "linked selection", "vùng chọn liên kết")) } else { tr3("原文 · 联动区域选择", "ORIGINAL · linked region selection", "BẢN GỐC · chọn vùng liên kết").into() }))
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
            .child(div().flex().gap(px(8.)).items_center().child(div().flex_1().child(tr3_fill("已选区域 {} · 可选全文", "Selected region {} · selectable full text", "Vùng đã chọn {} · văn bản đầy đủ có thể chọn", self.selected.unwrap_or(0) + 1)))
                .child(ui::secondary_button("pdf-translate-selected", tr3("翻译所选区域", "Translate selected", "Dịch vùng đã chọn")).on_click(cx.listener(|reader, _, _, cx| {
                    reader.selected_request = true; reader.failed = false; reader.error = None; reader.paused = false; reader.pump(cx); cx.notify();
                })))
                .child(ui::secondary_button("pdf-copy-source", tr3("复制原文", "Copy source", "Sao chép bản gốc")).on_click(cx.listener(|reader, _, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(reader.source_full.clone())))))
                .child(ui::secondary_button("pdf-copy-target", tr3("复制译文", "Copy translation", "Sao chép bản dịch")).on_click(cx.listener(|reader, _, _, cx| {
                    if let Some(text) = reader.selected.and_then(|i| reader.prepared.as_ref()?.frame.blocks.get(i)?.translated.as_ref()) { cx.write_to_clipboard(ClipboardItem::new_string(text.clone())); }
                }))))
            .child(div().flex().gap(px(16.)).child(div().flex_1().min_w_0().child(self.source_text.clone()))
                .child(div().flex_1().min_w_0().child(self.target_text.clone())))
    }
    fn paired_text(&self, cx: &mut Context<Self>) -> Div {
        let mut text = div().flex().flex_col().gap(px(12.)).w_full()
            .child(div().flex().items_center().gap(px(8.)).child(div().flex_1().child(tr3("完整对照阅读 · 上方原始版面和溢出内容保持不变", "Full paired reading · original artwork and overflow remain intact above", "Đọc song song đầy đủ · bản gốc và phần tràn vẫn nguyên vẹn ở trên")))
                .child(ui::secondary_button("pdf-translate-page", tr3("翻译整页", "Translate full page", "Dịch toàn trang")).on_click(cx.listener(|reader, _, _, cx| {
                    reader.translate_all = true; reader.failed = false; reader.error = None; reader.paused = false; reader.pump(cx); cx.notify();
                }))));
        if let Some(prepared) = &self.prepared {
            for (index, block) in prepared.frame.blocks.iter().enumerate() {
                let target = block.translated.clone().unwrap_or_else(|| if state::preserve_formula(&block.source) { tr3("公式保留在原始像素中", "Formula retained in original pixels", "Công thức được giữ trong ảnh gốc").into() } else { tr3("未翻译 · 将页面区域滚动到可视范围，或翻译整页", "Not translated · scroll the page region into view, or translate full page", "Chưa dịch · cuộn vùng trang vào tầm nhìn, hoặc dịch toàn trang").into() });
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
            pages = pages.child(div().p(px(24.)).text_color(Theme::text_caption()).child(if self.loading { tr3("正在打开文档 · PDFium 和本地 OCR 在后台运行", "Opening document · PDFium and local OCR run in the background", "Đang mở tài liệu · PDFium và OCR cục bộ chạy nền") } else { tr3("原文不可用。请检查错误并重试。", "Original is unavailable. Check the error and Retry.", "Bản gốc không khả dụng. Kiểm tra lỗi và thử lại.") }));
        }
        let source_label = match &self.source { Source::Pdf(_) => tr3_fill("本地 PDF · {} 页 · 原文件保留在你的文档库中", "Local PDF · {} pages · original retained in your library", "PDF cục bộ · {} trang · bản gốc được giữ trong thư viện", self.page_count.max(1)), Source::Capture(source) => format!("{} · {}", if self.capture_live { tr3("实时来源", "Live source", "Nguồn trực tiếp") } else { tr3("来源已冻结", "Source frozen", "Nguồn đã đóng băng") }, source.label()) };
        let quality = self.prepared.as_ref().map(|p| p.frame.quality.clone()).unwrap_or_default();
        div().relative().size_full().min_w_0().min_h_0().flex().flex_col().bg(Theme::bg_body()).text_color(Theme::text()).font_family(theme::UI_FONT).text_size(px(12.)).line_height(px(18.))
            .child(self.toolbar(cx))
            .when(self.show_settings, |el| el.child(div().id("pdf-settings-scroll").max_h(px(460.)).overflow_y_scroll().child(self.settings_panel(cx))))
            .child(div().px(px(16.)).py(px(6.)).text_size(px(11.)).text_color(Theme::text_caption()).child(source_label))
            .when_some(self.error.clone(), |el, error| el.child(div().px(px(16.)).py(px(8.)).text_color(Theme::danger()).child(error)))
            .child(pages)
            .when(self.prepared.is_some(), |el| el.child(div().flex_none().px(px(16.)).py(px(6.)).border_t_1().border_color(Theme::line_border())
                .child(ui::secondary_button("pdf-paired-toggle", if self.show_paired { tr3("隐藏完整对照阅读", "Hide full paired reading", "Ẩn đọc song song đầy đủ") } else { tr3("完整对照阅读", "Full paired reading", "Đọc song song đầy đủ") })
                    .on_click(cx.listener(|reader, _, _, cx| { reader.show_paired = !reader.show_paired; cx.notify(); })))))
            .when(self.show_paired && self.prepared.is_some(), |el| el.child(div().id("pdf-paired-scroll").max_h(px(200.)).flex_none().overflow_y_scroll().px(px(16.)).py(px(8.)).child(self.paired_text(cx))))
            .when(self.selected.is_some(), |el| el.child(div().id("pdf-selected-scroll").max_h(px(240.)).flex_none().overflow_y_scroll().px(px(16.)).py(px(8.)).child(self.selected_panel(cx))))
            .child(div().px(px(16.)).py(px(8.)).border_t_1().border_color(Theme::line_border()).text_size(px(11.)).text_color(Theme::text_caption())
                .child(format!("{}{}{}", self.status, if quality.is_empty() { "" } else { " · " }, quality)))
            .when_some(self.divider_overlay(cx), |el, overlay| el.child(overlay))
    }
}
