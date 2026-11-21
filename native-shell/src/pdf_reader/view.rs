use super::*;
use crate::ui::TipExt;

/// The status line's quality text: what to show, and the original English
/// sentence to keep one hover away when the label no longer reads as it.
///
/// `mirror_pdf_desktop` writes `PageFrame::quality` as an English sentence
/// (`pdf::load_page`, `capture::recognize_frame`), and the footer used to print
/// it straight through — an English sentence in a Vietnamese or Chinese window.
/// Every sentence those two functions can produce is mapped below; anything
/// else gets a short translated label instead, so raw English never reaches the
/// status line. Either way the unrecognised original stays reachable through
/// the tooltip.
fn quality_label(quality: &str) -> (String, Option<String>) {
    if quality.trim().is_empty() { return (String::new(), None); }
    let label = match quality {
        "PDF text removed; artwork retained. Inspect complex clipping and raster text." => tr3(
            "PDF 文本已移除；保留图像。请检查复杂裁剪和光栅文本。",
            "PDF text removed; artwork retained. Inspect complex clipping and raster text.",
            "Đã xoá chữ gốc; giữ nguyên hình ảnh. Kiểm tra kỹ vùng cắt và chữ dạng raster.",
        ).to_string(),
        "No extractable text. Local OCR required." => tr3(
            "无可提取文本。需要本地 OCR。",
            "No extractable text. Local OCR required.",
            "Không có chữ để trích xuất. Cần OCR cục bộ.",
        ).to_string(),
        "Scanned PDF · local OCR · paired text preserves original raster artwork" => tr3(
            "扫描版 PDF · 本地 OCR · 对照文本保留原始光栅图像",
            "Scanned PDF · local OCR · paired text preserves original raster artwork",
            "PDF quét · OCR cục bộ · văn bản song song giữ nguyên ảnh gốc",
        ).to_string(),
        other => quality_variant(other).unwrap_or_else(|| tr3(
            "页面质量信息",
            "Page quality",
            "Chất lượng trang",
        ).to_string()),
    };
    // The English original is worth a tooltip exactly when the label stopped
    // saying it: a translation, a dropped diagnostic, or text we do not know.
    let detail = (label != quality).then(|| quality.to_string());
    (label, detail)
}

/// The quality lines that embed a value — an OCR error returned by `anyhow`, or
/// the region count `capture::recognize_frame` puts in the middle of its line.
fn quality_variant(quality: &str) -> Option<String> {
    for (prefix, zh, en, vi) in [
        ("Original page retained. OCR unavailable: ",
            "已保留原始页面 · OCR 不可用",
            "Original page retained · OCR unavailable",
            "Đã giữ nguyên trang gốc · OCR không khả dụng"),
        ("Original capture retained. OCR unavailable: ",
            "已保留原始截图 · OCR 不可用",
            "Original capture retained · OCR unavailable",
            "Đã giữ nguyên ảnh chụp gốc · OCR không khả dụng"),
    ] {
        // The tail is an English OS diagnostic from another crate; it belongs in
        // the tooltip, not in a Vietnamese or Chinese status line.
        if quality.starts_with(prefix) { return Some(tr3(zh, en, vi).to_string()); }
    }
    const TAIL: &str = " regions use paired text to preserve raster artwork";
    for (head, zh, en, vi) in [
        ("Document region detected · Windows OCR · ",
            "已检测到文档区域 · Windows OCR · {} 个区域使用对照文本以保留光栅图像",
            "Document region detected · Windows OCR · {} regions use paired text to preserve raster artwork",
            "Đã nhận diện vùng tài liệu · Windows OCR · {} vùng dùng văn bản song song để giữ nguyên ảnh gốc"),
        ("Full source · no confident page boundary · Windows OCR · ",
            "完整来源 · 未找到可信的页面边界 · Windows OCR · {} 个区域使用对照文本以保留光栅图像",
            "Full source · no confident page boundary · Windows OCR · {} regions use paired text to preserve raster artwork",
            "Toàn bộ nguồn · không tìm thấy ranh giới trang rõ ràng · Windows OCR · {} vùng dùng văn bản song song để giữ nguyên ảnh gốc"),
    ] {
        if let Some(count) = quality.strip_prefix(head).and_then(|rest| rest.strip_suffix(TAIL)) {
            return Some(tr3_fill(zh, en, vi, count));
        }
    }
    None
}

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
    /// True when the current page already carries at least one translation, which
    /// decides whether the target pane advertises its language or asks for one.
    fn has_translations(&self) -> bool {
        self.prepared.as_ref().is_some_and(|prepared| prepared.frame.blocks.iter().any(|block| block.translated.is_some()))
    }
    fn toolbar(&self, cx: &mut Context<Self>) -> Div {
        let capture_mode = matches!(self.source, Source::Capture(_));
        // Groups are separated by a hairline and the page controls read as one
        // control, so the row has a shape instead of eleven equal buttons.
        let divider = || div().w(px(1.)).h(px(18.)).flex_none().bg(Theme::line_border());
        // 页码跳转: the pill is a button until the reader clicks it, then it becomes a
        // field pre-filled with the current page so a long document is reachable.
        let page_pill: AnyElement = if let Some(field) = &self.page_entry {
            div().w(px(72.)).h(px(28.)).child(div().w_full().min_h(px(28.)).px(px(6.)).rounded(px(6.))
                .border_1().border_color(Theme::primary()).child(field.clone())).into_any_element()
        } else {
            div().id("pdf-page-pill").h(px(28.)).px(px(10.)).flex().items_center().justify_center().rounded(px(6.))
                .bg(Theme::fill_hover()).text_color(Theme::text()).cursor_pointer()
                .child(format!("{} / {}", self.page + 1, self.page_count.max(1)))
                .on_click(cx.listener(|reader, _, window, cx| reader.begin_page_entry(window, cx)))
            .into_any_element()
        };
        let zoom_label = div().w(px(52.)).flex().items_center().justify_center().text_color(Theme::text()).child(format!("{:.0}%", self.zoom * 100.));
        let target_chip = div().h(px(28.)).px(px(10.)).flex().items_center().gap(px(6.)).rounded(px(6.))
            .bg(Theme::fill_hover()).text_color(Theme::text())
            .child(format!("→ {}", self.profile.target_language));
        div().flex().items_center().flex_wrap().gap(px(10.)).px(px(16.)).py(px(8.))
            .border_b_1().border_color(Theme::line_border()).bg(theme::raised(Theme::bg_body()))
            .when(!capture_mode, |el| el
                .child(div().flex().items_center().gap(px(2.))
                    .child(ui::secondary_button("pdf-previous", tr3("上一页", "Previous", "Trước")).on_click(cx.listener(|reader, _, _, cx| reader.navigate_user(-1, cx))))
                    .child(page_pill)
                    .child(ui::secondary_button("pdf-next", tr3("下一页", "Next", "Sau")).on_click(cx.listener(|reader, _, _, cx| reader.navigate_user(1, cx)))))
                .child(divider()))
            .when(capture_mode, |el| el.child(ui::secondary_button("pdf-source-live", if self.capture_live { tr3("冻结来源", "Freeze source", "Đóng băng nguồn") } else { tr3("恢复来源", "Resume source", "Tiếp tục nguồn") })
                .on_click(cx.listener(|reader, _, _, cx| {
                    reader.capture_live = !reader.capture_live; reader.epoch.source();
                    if reader.capture_live { reader.failed = false; reader.error = None; reader.load_needed = true; }
                    cx.notify();
                }))))
            .child(div().flex().items_center().gap(px(2.))
                .child(ui::secondary_button("pdf-zoom-out", "−").on_click(cx.listener(|reader, _, _, cx| { reader.zoom = (reader.zoom - 0.15).max(0.55); cx.notify(); })))
                .child(zoom_label)
                .child(ui::secondary_button("pdf-zoom-in", "+").on_click(cx.listener(|reader, _, _, cx| { reader.zoom = (reader.zoom + 0.15).min(3.); cx.notify(); }))))
            .child(divider())
            .child(div().flex().items_center().gap(px(2.))
                .child(ui::secondary_button("pdf-split", if self.split { tr3("仅译文", "Translation only", "Chỉ bản dịch") } else { tr3("分栏视图", "Split view", "Chia đôi") }).on_click(cx.listener(|reader, _, _, cx| { reader.split = !reader.split; cx.notify(); })))
                .child(ui::secondary_button("pdf-rotate", tr3("旋转页面", "Rotate page", "Xoay trang")).on_click(cx.listener(|reader, _, _, cx| reader.rotate_page(cx)))))
            .child(divider())
            .child(div().flex().items_center().gap(px(2.))
                .child(ui::secondary_button("pdf-target", tr3("语言", "Language", "Ngôn ngữ")).on_click(cx.listener(|reader, _, _, cx| { reader.show_settings = !reader.show_settings; cx.notify(); })))
                .child(target_chip))
            .child(div().flex_1())
            .child(div().flex().items_center().gap(px(2.))
                .child(ui::secondary_button("pdf-pause", if self.paused { tr3("继续", "Resume", "Tiếp tục") } else { tr3("暂停", "Pause", "Tạm dừng") }).on_click(cx.listener(|reader, _, _, cx| reader.toggle_pause(cx))))
                .child(ui::secondary_button("pdf-retry", tr3("重试", "Retry", "Thử lại")).on_click(cx.listener(|reader, _, _, cx| reader.retry(cx))))
                .child(ui::secondary_button("pdf-export", tr3("导出", "Export", "Xuất")).on_click(cx.listener(|reader, _, _, cx| reader.export_page(cx)))))
            .when(self.browser_linked, |el| el.child(ui::secondary_button("pdf-browser-detach", tr3("断开 Chrome", "Detach Chrome", "Ngắt liên kết Chrome")).on_click(cx.listener(|reader, _, _, cx| reader.set_browser_linked(false, cx)))))
    }
    fn settings_panel(&self, cx: &mut Context<Self>) -> Div {
        let health = model::ModelCatalogue::default().health(&self.profile);
        let health_label = match health.status {
            model::ModelHealthStatus::Ready => tr3("已配置", "Configured", "Đã cấu hình"),
            model::ModelHealthStatus::Configured => tr3("本地已配置", "Local configured", "Cục bộ đã cấu hình"),
            model::ModelHealthStatus::NeedsConsent => tr3("需要云端同意", "Cloud consent required", "Cần đồng ý với đám mây"),
            model::ModelHealthStatus::MissingConfiguration => tr3("配置不完整", "Configuration incomplete", "Cấu hình chưa đủ"),
            model::ModelHealthStatus::OfflineOnly => tr3("仅离线模式", "Offline only", "Chỉ ngoại tuyến"),
        };
        let mut kinds = div().flex().flex_wrap().gap(px(6.));
        for (index, label, kind) in [(0_usize, "OpenAI", ProviderKind::OpenAi), (1, "Google", ProviderKind::Google), (2, "DeepL", ProviderKind::DeepL), (3, tr3("本地", "Local", "Cục bộ"), ProviderKind::Local)] {
            kinds = kinds.child(div().id(("pdf-provider", index)).px(px(12.)).py(px(6.)).rounded(px(6.)).cursor_pointer()
                .bg(if self.draft_kind == kind { Theme::fill_hover() } else { Theme::bg_body() })
                .border_1().border_color(if self.draft_kind == kind { Theme::primary() } else { Theme::line_border() })
                .child(label).on_click(cx.listener(move |reader, _, _, cx| reader.switch_kind(kind, cx))));
        }
        div().flex().flex_col().gap(px(10.)).p(px(16.)).border_b_1().border_color(Theme::line_border())
            .child(kinds)
            .child(div().text_size(px(11.)).text_color(Theme::text_caption()).child(format!("{} · {}", tr3("模型健康", "Model health", "Sức khỏe mô hình"), health_label)))
            .child(div().text_size(px(11.)).text_color(Theme::text_caption()).child(tr3("仅检查本地配置；不会下载模型或访问网络。", "Checks local configuration only; it does not download models or access the network.", "Chỉ kiểm tra cấu hình cục bộ; không tải mô hình hoặc truy cập mạng.")))
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
            .rounded(px(3.)).border_1().border_color(Theme::line_border()).shadow(theme::shadow_card())
            // Until the first translation lands, the target pane would otherwise show
            // a second copy of the source page and look like a duplicate view.
            .when(translated && !self.has_translations(), |el| el.opacity(0.4))
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
            .child(div().h(px(34.)).flex_none().px(px(16.)).flex().items_center().gap(px(8.))
                .border_b_1().border_color(Theme::line_border())
                .child(div().text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).text_color(Theme::text())
                    .child(if index == 1 { tr3("译文", "TRANSLATION", "BẢN DỊCH").to_string() } else { tr3("原文", "ORIGINAL", "BẢN GỐC").to_string() }))
                .child(div().text_size(px(11.)).text_color(Theme::text_caption()).overflow_hidden()
                    .child(if index == 1 { if self.has_translations() { tr3_fill("· {} · 由原文翻译", "· {} · translated from the original", "· {} · dịch từ bản gốc", self.profile.target_language.clone()) } else { tr3("· 还没有译文 — 选择「语言」并保存", "· no translation yet — open Language and save", "· chưa có bản dịch — mở Ngôn ngữ rồi lưu").to_string() } } else { tr3("· 点选区块即可对照", "· click a region to read it side by side", "· nhấn vào một vùng để đọc song song").to_string() })))
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
            .bg(theme::raised(Theme::bg_overlay()))
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
        let (quality_text, quality_tip) = quality_label(&quality);
        let (translation_done, translation_total) = self.translation_progress();
        let progress_text = (translation_total > 0).then(|| format!("{} {}/{}", tr3("翻译进度", "Translation", "Tiến độ dịch"), translation_done.min(translation_total), translation_total));
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
            .child(div().flex_none().px(px(16.)).py(px(7.)).border_t_1().border_color(Theme::line_border()).flex().items_center().gap(px(8.))
                .child(div().size(px(6.)).flex_none().rounded(px(3.)).bg(if self.error.is_some() { Theme::danger() } else if self.paused { Theme::text_caption() } else { Theme::primary() }))
                .child(div().id("pdf-quality-status").flex_1().min_w_0().overflow_hidden().text_size(px(11.)).text_color(Theme::text_caption())
                    .child(format!("{}{}{}", self.status, if quality.is_empty() { "" } else { " · " }, quality_text))
                    .when_some(quality_tip, |el, detail| el.tip_label(detail, ui::TipSide::Above))
                    .when_some(progress_text, |el, progress| el.child(div().ml(px(8.)).text_color(Theme::text()).child(progress)))))
            .when_some(self.divider_overlay(cx), |el, overlay| el.child(overlay))
    }
}

#[cfg(test)]
mod tests {
    use super::quality_label;
    use crate::i18n::{Lang, lang, set_lang};

    // The interface language is process-wide, so these tests take turns and put
    // it back — the same shape `crate::i18n`'s own tests use.
    static TURN: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_lang<T>(language: Lang, f: impl FnOnce() -> T) -> T {
        let _turn = TURN.lock().unwrap_or_else(|error| error.into_inner());
        let previous = lang();
        set_lang(language);
        let out = f();
        set_lang(previous);
        out
    }

    /// Every sentence `mirror_pdf_desktop` can put in `PageFrame::quality`,
    /// including the two shapes that embed a value (an OCR diagnostic and a
    /// region count).
    const KNOWN: [&str; 7] = [
        "PDF text removed; artwork retained. Inspect complex clipping and raster text.",
        "No extractable text. Local OCR required.",
        "Scanned PDF · local OCR · paired text preserves original raster artwork",
        "Original page retained. OCR unavailable: Windows OCR is unavailable. Install an OCR language",
        "Original capture retained. OCR unavailable: Source is minimized",
        "Document region detected · Windows OCR · 12 regions use paired text to preserve raster artwork",
        "Full source · no confident page boundary · Windows OCR · 3 regions use paired text to preserve raster artwork",
    ];

    fn label(quality: &str) -> String { quality_label(quality).0 }

    #[test]
    fn known_quality_strings_are_translated_in_every_language() {
        for quality in KNOWN {
            let vi = with_lang(Lang::Vi, || label(quality));
            let en = with_lang(Lang::En, || label(quality));
            let zh = with_lang(Lang::Zh, || label(quality));
            assert!(!vi.is_empty(), "empty Vietnamese label for {quality}");
            assert_ne!(vi, quality, "Vietnamese label is still the raw English: {quality}");
            assert_ne!(vi, en, "Vietnamese label is the English sentence: {quality}");
            assert_ne!(vi, zh, "Vietnamese and Chinese labels match: {quality}");
            assert_ne!(en, zh, "English and Chinese labels match: {quality}");
        }
    }

    #[test]
    fn vietnamese_quality_labels_use_the_vietnamese_sentences() {
        for (quality, expected) in [
            (KNOWN[0], "Đã xoá chữ gốc; giữ nguyên hình ảnh. Kiểm tra kỹ vùng cắt và chữ dạng raster."),
            (KNOWN[1], "Không có chữ để trích xuất. Cần OCR cục bộ."),
            (KNOWN[2], "PDF quét · OCR cục bộ · văn bản song song giữ nguyên ảnh gốc"),
            (KNOWN[3], "Đã giữ nguyên trang gốc · OCR không khả dụng"),
            (KNOWN[4], "Đã giữ nguyên ảnh chụp gốc · OCR không khả dụng"),
            (KNOWN[5], "Đã nhận diện vùng tài liệu · Windows OCR · 12 vùng dùng văn bản song song để giữ nguyên ảnh gốc"),
            (KNOWN[6], "Toàn bộ nguồn · không tìm thấy ranh giới trang rõ ràng · Windows OCR · 3 vùng dùng văn bản song song để giữ nguyên ảnh gốc"),
        ] {
            assert_eq!(with_lang(Lang::Vi, || label(quality)), expected, "for {quality}");
        }
    }

    #[test]
    fn unknown_quality_text_never_leaks_english_into_the_label() {
        let unknown = "Unexpected OCR pipeline condition: the page kept its raster artwork and the checker found no boundary";
        for language in Lang::ALL {
            let (text, detail) = with_lang(language, || quality_label(unknown));
            assert!(!text.is_empty(), "empty label in {language:?}");
            assert!(!text.contains("raster artwork"), "{language:?} label leaked the English sentence: {text}");
            assert!(text.chars().count() <= 32, "{language:?} label is not a short generic: {text}");
            assert_eq!(detail.as_deref(), Some(unknown), "{language:?} lost the original English");
        }
        let (vi, _) = with_lang(Lang::Vi, || quality_label(unknown));
        let (en, _) = with_lang(Lang::En, || quality_label(unknown));
        let (zh, _) = with_lang(Lang::Zh, || quality_label(unknown));
        assert_ne!(vi, en); assert_ne!(vi, zh); assert_ne!(en, zh);
    }

    #[test]
    fn empty_quality_adds_nothing_to_the_status_line() {
        for language in Lang::ALL {
            let (text, detail) = with_lang(language, || quality_label(""));
            assert!(text.is_empty(), "{language:?} invented a label for an empty quality");
            assert!(detail.is_none(), "{language:?} invented a tooltip for an empty quality");
        }
    }

    #[test]
    fn quality_tooltip_carries_the_english_exactly_when_the_label_drops_it() {
        for quality in KNOWN {
            // Neither translated label shows English, so the original keeps a
            // hover to stay discoverable.
            for language in [Lang::Vi, Lang::Zh] {
                let (_, detail) = with_lang(language, || quality_label(quality));
                assert_eq!(detail.as_deref(), Some(quality), "{language:?} lost the English original");
            }
            // English already reads as the sentence, unless the label drops the
            // OS diagnostic appended to the two OCR-failure lines.
            let (text, detail) = with_lang(Lang::En, || quality_label(quality));
            let drops_diagnostic = quality.contains("OCR unavailable: ");
            assert_eq!(detail.as_deref(), drops_diagnostic.then_some(quality), "for {quality}");
            assert!(drops_diagnostic || text == quality, "English label changed: {quality} -> {text}");
        }
    }
}
