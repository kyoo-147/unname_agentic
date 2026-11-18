//! 主页: the local library's home — the 新建 / 上传
//! cards (a new document, or 导入为文档 at once: no menus), the 最近访问 and 收藏 lists (list or grid view), 显示设置 for the
//! list columns and the sort dropdown. Dressed as 所有文档: a
//! hairline list with quiet hover fills, white cards and pills, native menus.

use crate::app::{RowMenu, Workspace};
#[path = "home_scrollbar.rs"]
mod scrollbar;
use crate::settings::display_title;
use crate::search::doc_icon;
use crate::store::Entry;
use crate::theme::Theme;
use crate::trash::{empty_state, list_header_text, list_line, menu_label, page_header, row_hover};
use crate::ui::{ROW_RADIUS, TipExt, TitleBarExt, icon, menu_glyph, menu_row, popover, ui_text};
use gpui::{prelude::FluentBuilder, *};
use std::cell::RefCell;
use std::collections::{HashMap};
use std::rc::Rc;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HomeTab {
    #[default]
    Recent,
    Starred,
}

/// The optional list columns (标题 is always shown).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Col {
    Modified,
    Created,
    Visited,
    Starred,
}

impl Col {
    fn label(self) -> &'static str {
        match self {
            Col::Modified => "修改时间",
            Col::Created => "创建时间",
            Col::Visited => "最近访问",
            Col::Starred => "收藏时间",
        }
    }
}

/// 最近访问's columns (no 所有者); 显示设置 toggles them.
const RECENT_COLS: [Col; 3] = [Col::Modified, Col::Created, Col::Visited];
const STARRED_COLS: [Col; 4] = [Col::Modified, Col::Created, Col::Visited, Col::Starred];

/// The library order: last visit, last change, creation, or title.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum HomeSort {
    #[default]
    Visited,
    Modified,
    Created,
    Title,
}

/// Bounded document trees retain formatting without retaining a whole long document.
impl HomeSort {
    fn key(self) -> &'static str { match self { Self::Visited => "visited", Self::Modified => "modified", Self::Created => "created", Self::Title => "title" } }
    fn of(key: &str) -> Self { match key { "modified" => Self::Modified, "created" => Self::Created, "title" => Self::Title, _ => Self::Visited } }
}
impl HomeSort {
    fn label(self) -> &'static str {
        match self {
            Self::Visited => "最近访问时间",
            Self::Modified => "最近修改时间",
            Self::Created => "创建时间（最新优先）",
            Self::Title => "标题（升序）",
        }
    }
}

pub struct Home {
    pub tab: HomeTab,
    pub grid: bool,
    /// The Chat destination: show the greeting instead of the library grid.
    pub chat: bool,
    /// The Recent destination: the same grid, marked separately in the sidebar.
    pub recent_view: bool,
    /// Chat composer mode: 0 ask, 1 document.
    pub chat_mode: u8,
    grid_scroll: UniformListScrollHandle,
    list_scroll: ScrollHandle,
    grid_scrollbar: Rc<scrollbar::Scrollbar>,
    list_scrollbar: Rc<scrollbar::Scrollbar>,
    sort: HomeSort,
    pub sort_menu: bool,
    /// Last-frame bounds of the controls the popovers hang from.
    anchors: Rc<RefCell<HashMap<&'static str, Bounds<Pixels>>>>,
}

impl Default for Home {
    fn default() -> Self {
        Home {
            tab: HomeTab::Recent,
            grid: true,
            chat: false,
            recent_view: false,
            chat_mode: 0,
            grid_scroll: Default::default(),
            list_scroll: Default::default(),
            grid_scrollbar: Default::default(),
            list_scrollbar: Default::default(),
            sort: HomeSort::Visited,
            sort_menu: false,
            anchors: Default::default(),
        }
    }
}

impl Home {
    fn anchor(&self, key: &str) -> Option<Bounds<Pixels>> {
        self.anchors.borrow().get(key).copied()
    }

    /// Records the element's bounds under `key` each frame.
    fn track(&self, key: &'static str) -> impl IntoElement {
        let rec = self.anchors.clone();
        canvas(move |b, _, _| {
            rec.borrow_mut().insert(key, b);
        }, |_, _, _, _| {})
        .absolute()
        .inset_0()
    }

    fn cols(&self) -> Vec<Col> {
        match self.tab {
            HomeTab::Recent => RECENT_COLS.to_vec(),
            HomeTab::Starred => STARRED_COLS.to_vec(),
        }
    }

    fn sort_col(&self) -> Col {
        match self.sort {
            HomeSort::Visited => Col::Visited,
            HomeSort::Modified => Col::Modified,
            HomeSort::Created => Col::Created,
            HomeSort::Title => Col::Visited,
        }
    }
}

fn visited(e: &Entry) -> u64 {
    if e.meta.opened > 0 { e.meta.opened } else { e.meta.modified }
}

fn cell_text(e: &Entry, c: Col) -> String {
    match c {
        Col::Modified => crate::ui::format_visit(e.meta.modified),
        Col::Created => crate::ui::format_visit(e.meta.created),
        Col::Visited => crate::ui::format_visit(visited(e)),
        Col::Starred => crate::ui::format_visit(e.meta.starred),
    }
}

/// The title column grows three times as fast as the others.
fn weight3(mut d: Div) -> Div {
    d.style().flex_grow = Some(3.);
    d
}

/// A document's icon: its emoji, or the monochrome page glyph.
fn entry_icon(e: &Entry) -> AnyElement {
    match &e.icon {
        Some(em) => div().size(px(24.)).mr(px(12.)).flex_none().flex().items_center().justify_center().text_size(px(18.)).child(em.clone()).into_any_element(),
        None => doc_icon().mr(px(12.)).into_any_element(),
    }
}

/// A quiet action chip on the home greeting.
fn greeting_chip(id: &'static str, glyph: &'static str, label: &'static str) -> Stateful<Div> {
    div().id(id).flex_none().h(px(28.)).px(px(10.)).flex().items_center().gap(px(6.)).rounded(px(9.))
        .bg(Theme::fill_hover()).cursor_pointer().hover(|s| s.bg(Theme::fill_hover_strong())).active(|s| s.bg(Theme::fill_pressed()))
        .text_size(px(13.)).line_height(px(20.)).text_color(Theme::text())
        .child(icon(glyph, 14., Theme::text_caption())).child(label)
}

impl Workspace {
    /// In 批量管理 a click checks or unchecks; otherwise it opens.
    fn home_click(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.batch.is_none() { return self.open(id, window, cx) }
        if !self.toggle_check(id) {
            self.show_toast_kind(crate::ui::ToastKind::Error, &crate::localized_format!("一次最多选择 {} 项", "Select up to {} items at a time", crate::sidebar::BATCH_LIMIT), cx);
        }
        cx.notify();
    }

    /// The row's / card's checkbox while 批量管理 is on.
    fn home_check(&self, e: &Entry) -> Option<Div> {
        use crate::sidebar::{BATCH_LIMIT, Check, checkbox};
        let sel = self.batch.as_ref()?;
        let on = sel.contains(&e.id);
        Some(checkbox(if on { Check::On } else { Check::Off }, !on && sel.len() >= BATCH_LIMIT, "home-card"))
    }

    fn home_entries(&self) -> Vec<Entry> {
        let mut v: Vec<Entry> = match self.home.tab {
            HomeTab::Recent => self.entries.clone(),
            HomeTab::Starred => self.entries.iter().filter(|e| e.meta.starred > 0).cloned().collect(),
        };
        v.sort_by(|a, b| {
            let order = match self.home.sort {
                HomeSort::Visited => visited(b).cmp(&visited(a)),
                HomeSort::Modified => b.meta.modified.cmp(&a.meta.modified),
                HomeSort::Created => b.meta.created.cmp(&a.meta.created),
                HomeSort::Title => a.title.cmp(&b.title),
            };
            order.then_with(|| a.id.cmp(&b.id))
        });
        v
    }

    fn open_row_menu(&mut self, id: &str, key: &str, cx: &mut Context<Self>) {
        let b = self.more_bounds.borrow().get(key).copied();
        let Some(b) = b else { return };
        self.row_menu = Some(RowMenu { id: id.to_string(), pos: point(b.right(), b.bottom() + px(2.)), corner: Corner::TopRight, sub: false, batch: false });
        cx.notify();
    }

    fn home_more(&self, e: &Entry, key: String, cx: &mut Context<Self>) -> Stateful<Div> {
        let id = e.id.clone();
        let (rec, k2) = (self.more_bounds.clone(), key.clone());
        let open = self.row_menu.as_ref().is_some_and(|m| m.id == e.id && m.pos.x > px(0.) && m.corner == Corner::TopRight);
        div()
            .id(SharedString::from(key.clone()))
            .relative()
            .size(px(24.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .cursor_pointer()
            .hover(|s| s.bg(Theme::fill_hover_strong()))
            .when(open, |d| d.bg(Theme::fill_hover_strong()))
            .child(icon("ellipsis", 16., Theme::text_caption()))
            .child(canvas(move |b, _, _| {
                rec.borrow_mut().insert(key.clone(), b);
            }, |_, _, _, _| {}).absolute().inset_0())
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(cx.listener(move |w, _, _, cx| {
                cx.stop_propagation();
                w.open_row_menu(&id, &k2, cx);
            }))
    }

    /// 主页's view and sort order are remembered (`settings.json`).
    pub(crate) fn load_home(&mut self) {
        let s = self.store.settings();
        self.home.grid = !s.home_list;
        self.home.sort = s.home_sort.as_deref().map(HomeSort::of).unwrap_or(HomeSort::Visited);
    }

    fn save_home(&mut self) {
        let mut s = self.store.settings();
        (s.home_list, s.home_sort) = (!self.home.grid, Some(self.home.sort.key().to_string()));
        if let Err(e) = self.store.save_settings(&s) { eprintln!("无法保存主页视图：{e}"); }
    }

    pub(crate) fn render_home(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        // Too narrow for the search box: a search icon beside +, in the same style.
        let search = self.header_search(window, cx);
        let narrow = search.is_none();
        let header = page_header(self, if self.home.chat { crate::i18n::tr3("新对话", "New chat", "Trò chuyện mới") } else { crate::settings::text("主页") }, 26., cx).relative().children(search)
            .when(crate::layout_preview(), |d| d.child(div().no_drag().mr(px(12.)).text_size(px(11.)).line_height(px(16.)).text_color(Theme::text_caption()).child("Layout preview")))
            .when(narrow, |d| d.child(crate::ui::header_icon("home-search", "search").mr(px(4.))
                .tip(crate::settings::tr("搜索文档", "Search documents"), Some(crate::shortcuts::hint("workspace::FocusSearch", "⌘ + J")))
                .on_click(cx.listener(|w, _, window, cx| w.open_search(window, cx)))))
            .child(
            crate::ui::header_icon("home-new", "plus")
                .tip(crate::settings::tr("导入 PDF", "Import PDF"), None)
                .on_click(cx.listener(|w, _, window, cx| w.open_import(window, cx))).into_any_element()
        );
        // Tabs as segmented items: the current one on a quiet fill, no accent.
        let tab = |id: &'static str, label: &'static str, t: HomeTab| {
            let on = self.home.tab == t;
            div()
                .id(id)
                .mr(px(8.))
                .h(px(28.))
                .px(px(10.))
                .flex()
                .items_center()
                .rounded(px(9.))
                .cursor_pointer()
                .text_size(px(13.))
                .line_height(px(20.))
                .when(on, |d| d.bg(Theme::fill_hover_strong()).text_color(Theme::text()))
                .when(!on, |d| d.text_color(Theme::text_caption()).hover(|s| s.bg(Theme::fill_hover())))
                .child(crate::settings::label(label))
                .on_click(cx.listener(move |w, _, _, cx| {
                    w.home.tab = t;
                    // The tab bar belongs to 主页: picking a tab leaves the
                    // 最近 destination, so the sidebar keeps one lit row.
                    w.home.recent_view = false;
                    w.home.sort_menu = false;
                    cx.notify();
                }))
        };
        let toggle = |id: &'static str, ic: &'static str, on: bool, tip: &'static str, grid: bool| {
            div()
                .id(id)
                .w(px(30.))
                .h(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(7.))
                .cursor_pointer()
                .when(on, |d| d.bg(Theme::fill_hover_strong()))
                .when(!on, |d| d.tip(tip, None).hover(|s| s.bg(Theme::fill_hover())))
                .child(icon(ic, 14., if on { Theme::text_code() } else { Theme::text_caption() }))
                .on_click(cx.listener(move |w, _, _, cx| {
                    w.home.grid = grid;
                    w.save_home();
                    w.home.sort_menu = false;
                    cx.notify();
                }))
        };
        // 批量管理: the sidebar's 批量操作 selection, entered and shown here
        // too, with a toolbar of its own.
        let text_btn = |id: &'static str, ic: &'static str, label: &'static str, enabled: bool| {
            div().id(id).flex_none().h(px(28.)).px(px(10.)).flex().items_center().gap(px(6.)).rounded(px(9.))
                .text_size(px(13.)).line_height(px(20.))
                .text_color(if enabled { Theme::text() } else { Theme::text_disabled() })
                .when(enabled, |d| d.cursor_pointer().hover(|s| s.bg(Theme::fill_hover())))
                .child(icon(ic, 14., if enabled { Theme::text_code() } else { Theme::text_disabled() }))
                .child(label)
        };
        let toolbar = div()
            .mt(px(12.))
            .h(px(28.))
            .flex_none()
            .pl(px(24.))
            .pr(px(24.))
            .flex()
            .items_center();
        let toolbar = if let Some(sel) = &self.batch {
            let ids: Vec<String> = self.home_entries().into_iter().take(crate::sidebar::BATCH_LIMIT).map(|e| e.id).collect();
            let n = sel.len();
            let all = n > 0 && ids.iter().all(|id| sel.contains(id));
            use crate::sidebar::{Check, checkbox};
            toolbar
                .child(div().id("home-batch-all").flex_none().ml(px(10.)).size(px(14.)).cursor_pointer().group("home-batch-all")
                    .child(checkbox(if all { Check::On } else if n > 0 { Check::Partial } else { Check::Off }, false, "home-batch-all"))
                    .tip(crate::settings::text("全选"), None)
                    .on_click(cx.listener(move |w, _, _, cx| { w.batch = Some(if all { vec![] } else { ids.clone() }); cx.notify(); })))
                .child(div().ml(px(10.)).text_size(px(13.)).line_height(px(20.)).text_color(Theme::text()).child(crate::localized_format!("已选 {n} 项", "Selected: {n}")))
                .child(div().flex_1())
                // The sidebar's 批量操作 actions: 创建副本 | 移动到 | 删除.
                .when(crate::layout_preview(), |d| d
                    .child(text_btn("home-batch-copy", "copy", crate::settings::text("创建副本"), n > 0)
                        .when(n > 0, |d| d.on_click(cx.listener(|w, _, _, cx| w.batch_copy(cx)))))
                    .child(text_btn("home-batch-move", "folder-input", crate::settings::text("移动到"), n > 0).ml(px(4.))
                        .when(n > 0, |d| d.on_click(cx.listener(|w, _, window, cx| w.batch_move(window, cx))))))
                .child(text_btn("home-batch-delete", "bin", crate::settings::text("删除"), n > 0).ml(px(4.))
                    .when(n > 0, |d| d.on_click(cx.listener(|w, _, _, cx| w.ask_batch_delete(cx)))))
                .child(text_btn("home-batch-exit", "x", crate::settings::text("退出"), true).ml(px(8.))
                    .tip(crate::settings::text("退出批量操作"), None)
                    .on_click(cx.listener(|w, _, _, cx| { w.batch = None; w.row_menu = None; cx.notify(); })))
        } else { toolbar
            .child(tab("home-tab-recent", if crate::layout_preview() { "Layout samples" } else { crate::settings::text("我的文档") }, HomeTab::Recent))
            .child(tab("home-tab-star", crate::settings::text("收藏"), HomeTab::Starred))
            .child(div().flex_1())
            .child(text_btn("home-batch", "batch", crate::settings::text("批量管理"), true).mr(px(8.))
                .on_click(cx.listener(|w, _, _, cx| { w.batch = Some(vec![]); w.row_menu = None; w.home.sort_menu = false; cx.notify(); })))
            .child(
                div().id("home-sort").relative().h(px(28.)).px(px(10.)).flex().items_center().gap(px(6.))
                    .rounded(px(9.)).text_size(px(13.)).text_color(Theme::text_caption()).cursor_pointer()
                    .hover(|s| s.bg(Theme::fill_hover())).when(self.home.sort_menu, |d| d.bg(Theme::fill_hover_strong()))
                    .child(icon("sort-down", 14., Theme::text_caption())).child(crate::settings::label(self.home.sort.label()))
                    .child(self.home.track("home-sort"))
                    .on_click(cx.listener(|w, _, _, cx| { w.home.sort_menu = !w.home.sort_menu; cx.notify(); })),
            )
            .child(
                // The view switcher: one white pill, the current view on a quiet fill.
                crate::ui::pill()
                    .ml(px(16.))
                    .p(px(1.))
                    .flex()
                    .gap(px(2.))
                    .rounded(px(9.))
                    .child(toggle("home-grid", "view-grid", self.home.grid, crate::settings::text("切换为宫格视图"), true))
                    .child(toggle("home-list", "view-list", !self.home.grid, crate::settings::text("切换为列表视图"), false)),
            ) };

        let entries = self.home_entries();
        let body = if (self.home.chat || self.entries.is_empty()) && !self.search_open {
            self.render_home_greeting(cx)
        } else if entries.is_empty() && (self.home.grid || self.home.tab == HomeTab::Recent) {
            empty_state("illus/empty-list.svg", crate::settings::tr("暂无 PDF 文档", "No PDF documents yet")).into_any_element()
        } else if self.home.grid {
            self.render_home_grid(&entries, window, cx)
        } else {
            self.render_home_list(&entries, cx)
        };
        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .child(header)
            .child(toolbar)
            .child(body)
            .into_any_element()
    }

    /// The empty library's first-run screen: a quiet question, one line of
    /// guidance, an input-like card with the three actions, and the
    /// import card that used to be the whole empty state.
    fn render_home_greeting(&self, cx: &mut Context<Self>) -> AnyElement {
        let ask = div()
            .id("home-greeting-ask")
            .w_full()
            .h(px(30.))
            .flex()
            .items_center()
            .gap(px(11.))            .cursor_pointer()
            .on_click(cx.listener(|w, _, window, cx| w.open_search(window, cx)))
            .child(icon("search", 16., Theme::text_caption()))
            .child(div().flex_1().min_w_0().truncate().text_size(px(15.)).line_height(px(22.)).text_color(Theme::text_placeholder()).child(if self.home.chat_mode == 0 {
                crate::i18n::tr3("询问文档，或打开一份 PDF…", "Ask about your documents, or open a PDF…", "Hỏi về tài liệu, hoặc mở một PDF…")
            } else {
                crate::i18n::tr3("针对当前文档提问…", "Ask about the open document…", "Hỏi về tài liệu đang mở…")
            }))
            .child(div().flex_none().size(px(26.)).rounded_full().bg(Theme::fill_hover()).flex().items_center().justify_center().child(icon("chevron-right", 14., Theme::text_caption())));
        let mode = |index: u8, zh: &'static str, en: &'static str, vi: &'static str| {
            div().id(("chat-mode", index as usize)).px(px(10.)).h(px(24.)).rounded(px(6.)).flex().items_center().cursor_pointer()
                .when(self.home.chat_mode == index, |d| d.bg(Theme::bg_body()).text_color(Theme::text()))
                .when(self.home.chat_mode != index, |d| d.text_color(Theme::text_caption()).hover(|s| s.bg(Theme::fill_hover())))
                .child(div().text_size(px(12.)).line_height(px(18.)).child(crate::i18n::tr3(zh, en, vi)))
                .on_click(cx.listener(move |w, _, _, cx| { w.home.chat_mode = index; cx.notify(); }))
        };
        let top = div().flex().items_center().gap(px(6.))
            .child(div().flex().items_center().gap(px(2.)).p(px(2.)).rounded(px(8.)).bg(Theme::fill_hover())
                .child(mode(0, "问答", "Ask", "Hỏi đáp"))
                .child(mode(1, "文档", "Document", "Tài liệu")));
        let tools = div().mt(px(12.)).flex().items_center().gap(px(8.))
            .child(div().id("chat-attach").size(px(26.)).rounded(px(6.)).flex().items_center().justify_center().cursor_pointer().hover(|s| s.bg(Theme::fill_hover()))
                .child(icon("plus", 15., Theme::text_caption()))
                .on_click(cx.listener(|w, _, window, cx| w.open_import(window, cx))))
            .child(div().id("chat-skills").px(px(8.)).h(px(26.)).rounded(px(6.)).border_1().border_color(Theme::line_border()).flex().items_center().gap(px(5.)).cursor_pointer()
                .hover(|s| s.bg(Theme::fill_hover()))
                .child(icon("braces", 13., Theme::text_caption()))
                .child(div().text_size(px(11.)).text_color(Theme::text_caption()).child("/"))
                .on_click(cx.listener(|w, _, _, cx| w.show_toast_kind(crate::ui::ToastKind::Info, crate::i18n::tr3("技能面板即将加入。", "Skill panel is coming next.", "Bảng kỹ năng sẽ sớm có."), cx))))
            .child(div().w(px(1.)).h(px(18.)).bg(Theme::line_divider()))
            .child(top)
            .child(div().flex_1())
            .child(div().flex().items_center().gap(px(5.))
                .child(div().size(px(6.)).rounded_full().bg(Theme::primary()))
                .child(div().text_size(px(12.)).text_color(Theme::text_caption()).child(crate::i18n::tr3("模型 · 自动", "Model · Auto", "Mô hình · Tự động")))
                .child(icon("chevron-down", 13., Theme::text_caption())))
            .child(div().w(px(1.)).h(px(18.)).bg(Theme::line_divider()))
            .child(div().id("chat-mic").size(px(26.)).rounded(px(6.)).flex().items_center().justify_center().cursor_pointer().hover(|s| s.bg(Theme::fill_hover()))
                .child(icon("mic", 15., Theme::text_caption()))
                .on_click(cx.listener(|w, _, _, cx| w.show_toast_kind(crate::ui::ToastKind::Info, crate::i18n::tr3("语音输入即将加入。", "Voice input is coming next.", "Nhập bằng giọng nói sẽ sớm có."), cx))))
            .child(div().id("chat-voice").size(px(26.)).rounded(px(6.)).flex().items_center().justify_center().cursor_pointer().hover(|s| s.bg(Theme::fill_hover()))
                .child(icon("audio-lines", 15., Theme::text_caption()))
                .on_click(cx.listener(|w, _, _, cx| w.show_toast_kind(crate::ui::ToastKind::Info, crate::i18n::tr3("语音模式即将加入。", "Voice mode is coming next.", "Chế độ giọng nói sẽ sớm có."), cx))));
        let card = crate::ui::pill()
            .mt(px(32.))
            .w_full()
            .max_w(px(640.))
            .p(px(16.))
            .flex()
            .flex_col()
            .child(ask)
            .child(tools);
        let suggestions = div().mt(px(14.)).w_full().max_w(px(640.)).flex().flex_wrap().gap(px(8.))
            .child(greeting_chip("home-greeting-open", "file-text", crate::i18n::tr3("打开 PDF", "Open PDF", "Mở PDF"))
                .on_click(cx.listener(|w, _, window, cx| w.open_import(window, cx))))
            .child(greeting_chip("home-greeting-summary", "list", crate::i18n::tr3("摘要", "Summarise", "Tóm tắt"))
                .on_click(cx.listener(|w, _, _, cx| w.show_toast_kind(crate::ui::ToastKind::Info, crate::i18n::tr3("打开一份 PDF 即可摘要。", "Open a PDF to summarise it.", "Mở một PDF để tóm tắt."), cx))))
            .child(greeting_chip("home-greeting-translate", "translate", crate::i18n::tr3("翻译", "Translate", "Chuyển ngữ"))
                .on_click(cx.listener(|w, _, _, cx| w.show_toast_kind(crate::ui::ToastKind::Info, crate::i18n::tr3("打开一份 PDF 即可使用翻译。", "Open a PDF to use translation.", "Mở một PDF để dùng tính năng chuyển ngữ."), cx))))
            .child(greeting_chip("home-greeting-find", "search", crate::i18n::tr3("在文档中查找", "Find in documents", "Tìm trong tài liệu"))
                .on_click(cx.listener(|w, _, window, cx| w.open_search(window, cx))))
            .child(greeting_chip("home-greeting-live", "eye", crate::i18n::tr3("实时镜像", "Live mirror", "Live mirror"))
                .on_click(cx.listener(|w, _, window, cx| w.open_capture_picker(window, cx))));
        let import = div()
            .id("home-greeting-import")
            .mt(px(24.))
            .w_full()
            .max_w(px(640.))
            .p(px(12.))
            .flex()
            .items_center()
            .gap(px(12.))
            .rounded(px(12.))
            .border_1()
            .border_color(Theme::line_border())
            .bg(Theme::bg_overlay())
            .cursor_pointer()
            .hover(|s| s.border_color(Theme::text_disabled()))
            .active(|s| s.bg(Theme::fill_pressed()))
            .on_click(cx.listener(|w, _, window, cx| w.open_import(window, cx)))
            .child(img("illus/empty-list.svg").size(px(44.)).flex_none())
            .child(
                div().flex_1().min_w_0().flex().flex_col()
                    .child(div().text_size(px(13.)).line_height(px(20.)).font_weight(FontWeight::MEDIUM).text_color(Theme::text()).child(crate::i18n::tr3("还没有 PDF 文档", "No PDF documents yet", "Chưa có tài liệu PDF nào")))
                    .child(div().mt(px(2.)).text_size(px(12.)).line_height(px(16.)).text_color(Theme::text_caption()).child(crate::i18n::tr3("从电脑导入一份 PDF 即可开始。", "Import a PDF from your computer to get started.", "Nhập một PDF có sẵn trên máy để bắt đầu."))),
            )
            .child(icon("plus", 16., Theme::text_caption()));
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .px(px(24.))
            .py(px(32.))
            .child(div().text_size(px(28.)).line_height(px(34.)).font_weight(FontWeight::SEMIBOLD).text_color(Theme::text()).text_center().child(crate::i18n::tr3("今天似乎还有文件要处理，开始吧？", "Looks like there is still paperwork to handle today. Shall we start?", "Có vẻ giấy tờ hôm nay vẫn cần phải xử lý, hãy bắt đầu thôi nào?")))
            .child(div().mt(px(8.)).max_w(px(560.)).text_size(px(14.)).line_height(px(20.)).text_color(Theme::text_caption()).text_center().child(crate::i18n::tr3("打开一份 PDF 开始，或者随时询问你的资料库。", "Open a PDF to get started, or ask anything about your library.", "Mở một PDF để bắt đầu, hoặc hỏi bất cứ điều gì về thư viện của bạn.")))
            .child(card)
            .child(suggestions)
            .child(import)
            .into_any_element()
    }

    fn render_home_list(&self, entries: &[Entry], cx: &mut Context<Self>) -> AnyElement {
        let cols = self.home.cols();
        let sort = self.home.sort_col();
        // The title is sized at about three times a column.
        let title_cell = || div().flex_grow().flex_shrink().flex_basis(relative(0.)).min_w(px(200.));
        let col_cell = || div().flex_grow().flex_shrink().flex_basis(relative(0.)).max_w(px(240.)).min_w(px(120.));
        // The list: 13pt tertiary headers over a hairline; the
        // sorted column in the text colour, semibold, with its arrow.
        let mut header = div()
            .h(px(33.))
            .mt(px(10.))
            .flex_none()
            .flex()
            .items_center()
            .border_b_1()
            .border_color(list_line())
            .child(
                weight3(title_cell()).pl(px(20.)).child(
                    div().id("home-col-title").px(px(4.)).text_size(px(13.)).line_height(px(24.)).text_color(list_header_text()).child(crate::settings::text("标题")),
                ),
            );
        for c in &cols {
            let sorted = self.home.sort != HomeSort::Title && *c == sort;
            header = header.child(
                col_cell().pl(px(20.)).child(
                    div()
                        .id(SharedString::from(format!("home-col-{}", c.label())))
                        .relative()
                        .px(px(4.))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .rounded(px(ROW_RADIUS))
                        .text_size(px(13.))
                        .line_height(px(24.))
                        .text_color(if sorted { Theme::text() } else { list_header_text() })
                        .when(sorted, |d| d.font_weight(FontWeight::SEMIBOLD))
                        .hover(|s| s.bg(Theme::fill_hover()))
                        .when(sorted && self.home.sort_menu, |d| d.bg(Theme::fill_hover_strong()))
                        .child(crate::settings::label(c.label()))
                        .when(sorted, |d| {
                            d.child(icon("sort-down", 12., Theme::text()))
                                .cursor_pointer()
                                .on_click(cx.listener(|w, _, _, cx| {
                                    w.home.sort_menu = !w.home.sort_menu;
                                    cx.notify();
                                }))
                        }),
                ),
            );
        }
        header = header.child(div().w(px(60.)).flex_none());
        let mut rows = div().id("home-rows").flex_1().min_h_0().overflow_y_scroll().track_scroll(&self.home.list_scroll).px(px(24.)).pb(px(24.));
        if entries.is_empty() {
            rows = rows.child(div().pt(px(72.)).child(empty_state("illus/empty-list.svg", crate::settings::text("当前列表暂无内容"))));
        }
        for (i, e) in entries.iter().enumerate() {
            let (id, id2) = (e.id.clone(), e.id.clone());
            let menu_on = self.row_menu.as_ref().is_some_and(|m| m.id == e.id);
            let check = self.home_check(e);
            let mut row = div()
                .id(SharedString::from(format!("home-row-{}", e.id)))
                .h(px(56.))
                .flex()
                .items_center()
                .when(i > 0, |d| d.border_t_1().border_color(list_line()))
                .cursor_pointer()
                .hover(row_hover)
                .when(menu_on, |d| d.bg(Theme::fill_hover()).border_color(transparent_black()).rounded(px(ROW_RADIUS)))
                .on_click(cx.listener(move |w, _, window, cx| w.home_click(&id, window, cx)))
                .when(check.is_none(), |d| d.on_mouse_down(
                    MouseButton::Right,
                    cx.listener(move |w, ev: &MouseDownEvent, _, cx| {
                        w.row_menu = Some(RowMenu { id: id2.clone(), pos: ev.position, corner: Corner::TopLeft, sub: false, batch: false });
                        cx.notify();
                    }),
                ))
                .child(
                    weight3(title_cell())
                        .pl(px(24.))
                        .pr(px(16.))
                        .flex()
                        .items_center()
                        .when_some(check, |d, c| d.child(c.mr(px(12.))))
                        .child(entry_icon(e))
                        .child(div().min_w_0().text_size(px(15.)).line_height(px(22.)).overflow_hidden().whitespace_nowrap().text_ellipsis().child(ui_text(display_title(&e.title))))
                        .when(e.meta.pinned, |d| d.child(icon("pin-filled", 14., Theme::pinned()).ml(px(6.)))),
                );
            for c in &cols {
                row = row.child(col_cell().pl(px(24.)).text_size(px(13.)).text_color(Theme::text_caption()).whitespace_nowrap().overflow_hidden().child(cell_text(e, *c)));
            }
            row = row.child(div().w(px(60.)).flex_none().flex().justify_end().pr(px(12.)).when(self.batch.is_none(), |d| d.child(self.home_more(e, format!("home-more-{}", e.id), cx))));
            rows = rows.child(row);
        }
        div().flex_1().min_h_0().flex().flex_col().child(header.mx(px(24.)))
            .child(div().relative().flex_1().min_h_0().flex().flex_col().child(rows).child(self.home.list_scrollbar.render(&self.home.list_scroll))).into_any_element()
    }

    fn render_home_grid(&self, entries: &[Entry], window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let main_w = f32::from(window.viewport_size().width) - if self.sidebar_open { self.sidebar_w(window) } else { 0. };
        let avail = (main_w - 48.).max(1.);
        let wide_cols = (((avail + 16.) / (200. + 16.)).floor() as usize).max(1);
        let n = if wide_cols >= 4 { wide_cols } else { (((avail + 16.) / (160. + 16.)).floor() as usize).clamp(1, 3) };
        let card_h = ((avail - 16. * (n - 1) as f32) / n as f32) * (264. / 236.);
        let entries = entries.to_vec();
        let rows = entries.len().div_ceil(n);
        let grid = uniform_list("home-grid-area", rows, cx.processor(move |workspace, range: std::ops::Range<usize>, _, cx| {
            range.map(|row| {
                let start = row * n;
                let end = (start + n).min(entries.len());
                div().w_full().h(px(card_h + 16.)).px(px(24.)).pb(px(16.))
                    .grid().grid_cols(n as u16).gap(px(16.))
                    .children(entries[start..end].iter().map(|e| workspace.render_home_card(e, card_h, cx)))
            }).collect()
        }))
        // The last row's own 16 plus 16 more: 32 below the cards, like the
        // list view's 24 and clear of the window's rounded corner.
        .flex_1().min_h_0().pb(px(16.)).track_scroll(self.home.grid_scroll.clone());
        let scroll = self.home.grid_scroll.0.borrow().base_handle.clone();
        div().relative().flex_1().min_h_0().mt(px(10.)).flex().flex_col()
            .child(grid).child(self.home.grid_scrollbar.render(&scroll)).into_any_element()
    }

    fn render_home_card(&self, e: &Entry, card_h: f32, cx: &mut Context<Self>) -> AnyElement {
            let id = e.id.clone();
            let id2 = e.id.clone();
            // A card is its PDF first page; nothing is parsed from the document.
            let page = match crate::store::image_path(&format!("assets/{}-pdf.png", e.id)) {
                Some(path) => div().size_full().p(px(18.)).overflow_hidden().flex().flex_col()
                    .child(div().flex_none().flex().items_start().gap(px(6.)).mb(px(8.))
                        .when_some(e.icon.as_ref(), |d, emoji| d.child(div().flex_none().text_size(px(14.)).line_height(px(20.)).child(emoji.clone())))
                        .child(div().min_w_0().text_size(px(14.)).line_height(px(20.)).font_weight(FontWeight::BOLD).child(e.title.clone())))
                    .child(div().flex_1().min_h_0().w_full().overflow_hidden().child(img(path).size_full().object_fit(ObjectFit::Contain))),
                None => div()
                    .size_full()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .child(img("illus/blank-doc.svg").size(px(64.)))
                    .child(div().mt(px(4.)).text_size(px(14.)).line_height(px(22.)).text_color(Theme::text_placeholder()).child(crate::settings::text("空白文档"))),
            };
            let cover: Option<std::path::PathBuf> = None;
            let frame = 4.;
            let menu_on = self.row_menu.as_ref().is_some_and(|m| m.id == e.id);
            let check = self.home_check(e);
                div()
                    .id(SharedString::from(format!("home-card-{}", e.id)))
                    .w_full().min_w_0().h(px(card_h)).relative().group("home-card")
                    .flex_none()
                    .bg(Theme::bg_overlay()).p(px(frame))
                    .overflow_hidden()
                    .cursor_pointer()
                    .hover(|s| s.bg(Theme::fill_hover_strong()))
                    .when(menu_on, |d| d.bg(Theme::fill_hover_strong()))
                    .on_click(cx.listener(move |w, _, window, cx| w.home_click(&id, window, cx)))
                    .when(check.is_none(), |d| d.on_mouse_down(
                        MouseButton::Right,
                        cx.listener(move |w, ev: &MouseDownEvent, _, cx| {
                            w.row_menu = Some(RowMenu { id: id2.clone(), pos: ev.position, corner: Corner::TopLeft, sub: false, batch: false });
                            cx.notify();
                        }),
                    ))
                    .when_some(cover, |d, path| d.child(img(path).absolute().inset_0().size_full().object_fit(ObjectFit::Fill)))
                    .child(crate::ui::continuous_page(20. - frame).size_full().overflow_hidden().child(page.relative()))
                    .child(crate::ui::continuous_corner_mask(20., Theme::bg_body()))
                    .when_some(e.meta.pdf_pages, |d, pages| d.child(div().absolute().bottom(px(12.)).right(px(12.)).px(px(7.)).py(px(3.)).rounded(px(6.))
                        .bg(gpui::white()).text_color(gpui::black()).border_1().border_color(crate::theme::rgbaf(0, 0, 0, 0.22))
                        .text_size(px(10.)).child(format!("PDF · {pages} pages"))))
                    .when_some(check, |d, c| d.child(div().absolute().top(px(12.)).left(px(12.)).child(c)))
                    .when(self.batch.is_none(), |d| d.child(
                        div().absolute().top(px(8.)).right(px(8.))
                            .when(!menu_on, |d| d.opacity(0.).group_hover("home-card", |s| s.opacity(1.)))
                            .child(self.home_more(e, format!("home-gmore-{}", e.id), cx).rounded_full().bg(Theme::bg_overlay())),
                    ))
            .into_any_element()
    }

    /// 显示设置 and the sort dropdown: the menu panel; the sort item is a
    /// native menu row.
    pub(crate) fn render_home_menus(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let mut out = vec![];
        if self.view != crate::app::View::Home {
            return out;
        }
        let place = |pos: Point<Pixels>, corner: Corner, menu: Stateful<Div>| {
            deferred(anchored().anchor(corner).position(pos).snap_to_window_with_margin(px(8.)).child(menu)).with_priority(2).into_any_element()
        };
        if self.home.sort_menu
            && let Some(b) = self.home.anchor("home-sort") {
                let mut menu = popover().id("sort-menu").occlude().w(px(200.)).py(px(crate::ui::MENU_PAD_Y))
                    .on_mouse_down_out(cx.listener(|w, _, _, cx| { w.home.sort_menu = false; cx.notify(); }));
                for (index, order) in [HomeSort::Visited, HomeSort::Modified, HomeSort::Created, HomeSort::Title].into_iter().enumerate() {
                    let g = SharedString::from(format!("home-order-{index}"));
                    menu = menu.child(menu_row(g.clone(), g.clone())
                        .child(menu_label(order.label(), g.clone(), gpui::white()).flex_1())
                        .when(self.home.sort == order, |d| d.child(menu_glyph("check", 14., g)))
                        .on_click(cx.listener(move |w, _, _, cx| {
                            w.home.sort = order;
                            w.save_home();
                            w.home.sort_menu = false;
                            w.home.grid_scroll.scroll_to_item(0, ScrollStrategy::Top);
                            w.home.list_scroll.set_offset(point(px(0.), px(0.)));
                            cx.notify();
                        })));
                }
                out.push(place(point(b.right(), b.bottom() + px(4.)), Corner::TopRight, menu));
            }
        out
    }
}
