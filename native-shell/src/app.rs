//! Workspace window: two panes — the document list on the left
//! (see `sidebar.rs`) and the editor on the right, with the
//! 64px top bar (breadcrumb title + save status) above the page.

use crate::input::{TextField, TextFieldEvent};
use crate::settings::display_title;
use crate::store::Entry;
use crate::shared_store::SharedStore;
use crate::theme::{self, Theme, craft};
use crate::ui::{TipExt, TipSide, TitleBarExt, ToastKind, icon, ui_text};
use gpui::{prelude::FluentBuilder, *};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

/// Autosave waits for this pause in editing, but never longer than
/// SAVE_MAX_DELAY after the oldest change not yet on disk.
const SAVE_DELAY: Duration = Duration::from_millis(500);
const SAVE_MAX_DELAY: Duration = Duration::from_secs(2);

actions!(workspace, [NewDoc, ImportDoc, ToggleSidebar, FocusSearch, FindInDoc, ReplaceInDoc, OpenSettings, OpenAbout, GoHome, CloseWindow, Quit,
    HideApp, HideOthers, ShowAll, Minimize, Zoom, ToggleFullScreen]);

/// The menu bar, in the interface language.
pub fn set_menus(cx: &mut App) {
    use crate::settings::tr;
    cx.set_menus(vec![
        Menu {
            name: "Workspace".into(),
            items: vec![
                MenuItem::action(tr("关于 Workspace", "About Workspace"), OpenAbout),
                MenuItem::separator(),
                MenuItem::action(tr("设置…", "Settings…"), OpenSettings),
                MenuItem::separator(),
                MenuItem::os_submenu(tr("服务", "Services"), SystemMenuType::Services),
                MenuItem::separator(),
                MenuItem::action(tr("隐藏 Workspace", "Hide Workspace"), HideApp),
                MenuItem::action(tr("隐藏其他", "Hide Others"), HideOthers),
                MenuItem::action(tr("全部显示", "Show All"), ShowAll),
                MenuItem::separator(),
                MenuItem::action(tr("退出 Workspace", "Quit Workspace"), Quit),
            ],
        },
        Menu {
            name: tr("文件", "File").into(),
            items: vec![
                MenuItem::action(tr("导入 PDF…", "Import PDF…"), ImportDoc),
                MenuItem::separator(),
                MenuItem::action(tr("关闭窗口", "Close Window"), CloseWindow),
            ],
        },
        // The standard Edit menu: its items act on the focused editor, and
        // macOS adds 听写 and 表情与符号 to it.
        Menu {
            name: tr("编辑", "Edit").into(),
            items: {
                vec![
                    MenuItem::os_action(tr("剪切", "Cut"), crate::input::Cut, OsAction::Cut),
                    MenuItem::os_action(tr("拷贝", "Copy"), crate::input::Copy, OsAction::Copy),
                    MenuItem::os_action(tr("粘贴", "Paste"), crate::input::Paste, OsAction::Paste),
                    MenuItem::os_action(tr("全选", "Select All"), crate::input::SelectAll, OsAction::SelectAll),
                ]
            },
        },
        Menu {
            name: tr("窗口", "Window").into(),
            items: vec![
                MenuItem::action(tr("最小化", "Minimize"), Minimize),
                MenuItem::action(tr("缩放", "Zoom"), Zoom),
                MenuItem::separator(),
                MenuItem::action(tr("进入 / 退出全屏幕", "Enter / Exit Full Screen"), ToggleFullScreen),
            ],
        },
    ]);
}

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("cmd-n", NewDoc, None),
        KeyBinding::new("cmd-,", OpenSettings, None),
        KeyBinding::new("cmd-shift-i", ImportDoc, None),
        KeyBinding::new("cmd-o", ImportDoc, None),
        KeyBinding::new("cmd-alt-home", GoHome, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
        KeyBinding::new("cmd-]", ToggleSidebar, None),
        KeyBinding::new("cmd-\\", ToggleSidebar, None),
        KeyBinding::new("cmd-j", FocusSearch, None),
        KeyBinding::new("cmd-f", FindInDoc, None),
        KeyBinding::new("cmd-shift-h", ReplaceInDoc, None),
        KeyBinding::new("cmd-q", Quit, None),
    ]);
    // macOS app and window keys. ⌥⌘H (隐藏其他) stays with the editor's
    // 应用上次的颜色, the Feishu shortcut; 隐藏其他 is in the menu. On Windows
    // the system handles these (Win+↓, Alt+F4), and F11 is full screen.
    #[cfg(target_os = "macos")]
    cx.bind_keys([
        KeyBinding::new("cmd-h", HideApp, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("ctrl-cmd-f", ToggleFullScreen, None),
    ]);
    // Windows: F11 for full screen, and Ctrl+H for 查找和替换 as in Office
    // and Notepad (written cmd-h: `shortcuts::pc_binding` maps cmd to
    // ctrl and drops a literal ctrl-h, Cocoa's backspace).
    #[cfg(not(target_os = "macos"))]
    cx.bind_keys([KeyBinding::new("f11", ToggleFullScreen, None), KeyBinding::new("cmd-h", ReplaceInDoc, None)]);
    cx.on_action(|_: &HideApp, cx| cx.hide());
    cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
    cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
    cx.on_action(|_: &CloseWindow, cx| {
        if let Some(handle) = cx.active_window().and_then(|w| w.downcast::<Workspace>()) {
            // Key dispatch already borrows this window; close after it returns.
            cx.defer(move |cx| {
                if let Err(e) = handle.update(cx, |ws, window, cx| {
                    crate::persist_window_size(cx);
                    if ws.save_before(cx, |_, window, _| window.remove_window()) { window.remove_window(); }
                }) { eprintln!("无法关闭窗口：{e}"); }
            });
        }
    });
    cx.on_action(|_: &Quit, cx| quit(cx));
    crate::modes::bind_keys(cx);
}

/// 退出: the open document is saved first; when that fails its dialog asks
/// (重试 / 放弃修改) and quits afterwards. Call it outside any window update
/// (`cx.defer`): a window on the update stack cannot be asked to save.
pub fn quit(cx: &mut App) {
    let ready = cx
        .windows()
        .into_iter()
        .filter_map(|w| w.downcast::<Workspace>())
        .map(|w| w.update(cx, |ws, _, cx| ws.save_before(cx, |_, _, cx| cx.defer(quit))).unwrap_or(false))
        .fold(true, |ready, saved| ready & saved);
    if ready {
        cx.quit();
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum SaveStatus {
    /// Freshly opened, nothing saved this session: show the modification time.
    Idle,
    Saved,
    Saving,
    Failed(String),
}

/// Right-click / "…" menu on a sidebar row.
#[derive(Clone, Debug)]
pub struct RowMenu {
    pub id: String,
    pub pos: Point<Pixels>,
    /// Which corner of the menu sits at `pos`.
    pub corner: Corner,
    /// 下载 submenu open.
    pub sub: bool,
    /// The 批量操作 menu for the checked rows.
    pub batch: bool,
}

/// What the main pane shows: the open document, 主页 or 回收站.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    Doc,
    Home,
    Trash,
    Settings,
}

/// A confirmation dialog and the pages it is about.
#[derive(Clone, Debug)]
pub enum Confirm {
    /// 删除 (to the 回收站); `batch` for the 批量操作 selection.
    Delete { ids: Vec<String>, batch: bool },
    /// 回收站 → 恢复.
    Restore(String),
    /// 回收站 → 彻底删除.
    Purge(String),
    /// 回收站 → 清空回收站: every trashed page, permanently.
    EmptyTrash,
    /// 隐藏引用列表 (with 不再提示) / 显示引用列表.
    Refs { show: bool, no_ask: bool },
    /// The open document could not be written before it was to be replaced
    /// (another document, 新建, 退出): 重试 / 放弃修改, then carry on.
    SaveFailed,
}

/// What to do once the open document is safely on disk (or its changes given up).
pub type AfterSave = Box<dyn FnOnce(&mut Workspace, &mut Window, &mut Context<Workspace>)>;

/// Inline 重命名 of a sidebar row.
pub struct Rename {
    pub id: String,
    pub field: Entity<TextField>,
    _subs: Vec<Subscription>,
}

pub struct CapturePicker {
    id: uuid::Uuid,
    loading: bool,
    sources: Vec<mirror_pdf_desktop::model::CaptureSource>,
    error: Option<String>,
}

pub struct Workspace {
    pub shortcut_recording: Option<String>,
    pub shortcut_strokes: Vec<String>,
    /// The failed change: (action, message); an empty action is page-wide.
    pub shortcut_error: Option<(String, String)>,
    pub settings_page: crate::settings::Page,
    /// 外观's theme dropdown while open: the theme its preview shows.
    pub theme_menu: Option<String>,
    /// Where the theme dropdown's button was drawn last frame.
    pub theme_anchor: std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    /// 快捷键's filter field.
    pub settings_filter: Entity<TextField>,
    native_sidebar: crate::native_header::NativeSidebar,
    pub store: SharedStore,
    pub entries: Vec<Entry>,
    pub current: Option<String>,
    pub pdf_reader: Option<Entity<crate::pdf_reader::PdfReader>>,
    pub(crate) companion: crate::native_bridge::CompanionState,
    pub(crate) companion_task: Option<Task<()>>,
    pub(crate) companion_error: Option<String>,
    pub pdf_importing: bool,
    pub capture_picker: Option<CapturePicker>,
    pub live_source: Option<String>,
    pub search: Entity<TextField>,
    /// Keyboard highlight inside search results.
    pub search_sel: Option<usize>,
    pub sidebar_open: bool,
    /// Dragged width (300 by default, 268 to min(800, window − 540)).
    pub sidebar_width: f32,
    /// The resize handle is being dragged.
    pub sidebar_drag: bool,
    /// The search dialog (command-center style) is open.
    pub search_open: bool,
    pub status: SaveStatus,
    pub row_menu: Option<RowMenu>,
    pub rename: Option<Rename>,
    /// Last-frame bounds of each row's "…" button, to hang its menu from.
    pub more_bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    /// Header "…" menu and its open submenu.
    /// Last-frame bounds of the open submenu (clicks there keep the menu open).
    pub list_scroll: ScrollHandle,
    pub search_scroll: ScrollHandle,
    /// Last-frame bounds of the row menu's 下载 submenu.
    pub row_sub_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// 批量操作 mode: the checked docs of 我的文档, in check order.
    pub batch: Option<Vec<String>>,
    /// The open confirmation dialog.
    pub confirm: Option<Confirm>,
    pub view: View,
    pub home: crate::home::Home,
    pub settings_scroll: ScrollHandle,
    /// 回收站 rows, refreshed when the page opens or changes.
    pub trash: Vec<crate::store::TrashEntry>,
    /// A 回收站 row's menu: the page and where it opens.
    pub trash_menu: Option<(String, Point<Pixels>, Corner)>,
    /// The toast and when it appeared.
    pub toast: Option<(ToastKind, SharedString, Instant)>,
    toast_task: Option<Task<()>>,
    /// Folded sidebar sections: 置顶, 我的文档.
    pub folded: [bool; 2],
    /// Expanded pages of the 我的文档 tree.
    pub expanded: HashSet<String>,
    pub move_dlg: Option<crate::tree::MoveDialog>,
    /// 编辑 / 阅读 dropdown, and the mode button's last-frame bounds.
    pub mode_btn_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The header "…" button, which the doc menu hangs from.
    pub more_btn_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The 快捷键 drawer, and the help button's menu (open while hovered).
    pub shortcuts: bool,
    pub(crate) focus: FocusHandle,
    save_task: Option<Task<()>>,
    /// When the oldest edit not yet on disk was made: a save waits for a
    /// pause in typing, but never longer than `SAVE_MAX_DELAY` after it.
    dirty_since: Option<Instant>,
    /// The open document has changes not yet on disk (cleared only by a
    /// successful save or by 放弃修改).
    unsaved: bool,
    /// Held back by a failed save: runs after 重试 succeeds or 放弃修改.
    pub(crate) after_save: Option<AfterSave>,
    editor_sub: Option<Subscription>,
    _subs: Vec<Subscription>,
}


/// A macOS notification (only logged when scripted).
fn notify_system(title: &str, body: &str) {
    if crate::devtools::scripted() {
        return eprintln!("notification: {title} / {body}");
    }
    let q = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!("display notification \"{}\" with title \"{}\"", q(body), q(title));
    std::thread::spawn(move || std::process::Command::new("osascript").arg("-e").arg(script).status());
}

impl Workspace {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build_window(None, window, cx)
    }

    /// 在新窗口中打开: a window of its own for `document` (also what the
    /// save-safety harness opens its several windows with).
    pub fn new_document_window(document: Option<String>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build_window(document, window, cx)
    }

    fn build_window(document: Option<String>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::settings::load();
        if !cx.has_global::<SharedStore>() { cx.set_global(SharedStore::open().expect("open document library")); }
        let mut store = cx.global::<SharedStore>().clone();
        let entries = store.list();
        let search = cx.new(|cx| {
            let mut f = TextField::new("搜索", cx);
            f.placeholder_color = Theme::text_disabled();
            f
        });
        let settings_filter = cx.new(|cx| {
            let mut f = TextField::new(crate::settings::tr("搜索快捷键", "Search shortcuts"), cx);
            f.placeholder_color = Theme::text_disabled();
            f
        });
        let subs = vec![
            cx.subscribe(&settings_filter, |_, _, ev: &TextFieldEvent, cx| if matches!(ev, TextFieldEvent::Changed) { cx.notify(); }),
            cx.observe_window_bounds(window, |_, window, cx| crate::remember_window_size(window, cx)),
            // The system switched between light and dark (or the app's own look changed).
            cx.observe_window_appearance(window, |this, _, cx| if crate::settings::sync_dark(cx) { crate::settings::refresh_all(this, cx); }),
            cx.observe_window_activation(window, |this, window, cx| {
                if window.is_window_active() { this.entries = this.store.list(); this.sort(); cx.notify(); }
                else { this.cancel_shortcut_recording(cx); this.flush(cx); }
            }),
            cx.subscribe_in(&search, window, |this, _, ev: &TextFieldEvent, window, cx| {
                match ev {
                    TextFieldEvent::Changed => {
                        this.search_sel = this.default_search_sel(cx);
                        this.search_scroll.set_offset(point(px(0.), px(0.)));
                    }
                    TextFieldEvent::Up => this.move_search_sel(-1, cx),
                    TextFieldEvent::Down => this.move_search_sel(1, cx),
                    TextFieldEvent::Submit => {
                        if let Some(ix) = this.search_sel {
                            this.pick_search(ix, window, cx)
                        }
                    }
                    TextFieldEvent::Cancel => this.close_search(window, cx),
                    _ => {}
                }
                cx.notify();
            }),
            // Last resort (the system logging out): ⌘Q and the close button
            // go through `save_before` and ask when the save fails.
            cx.on_app_quit(|this, cx| {
                crate::persist_window_size(cx);
                this.flush(cx);
                async {}
            }),
        ];
        let this = cx.weak_entity();
        window.on_window_should_close(cx, move |_, cx| {
            crate::persist_window_size(cx);
            this.update(cx, |w, cx| { w.cancel_shortcut_recording(cx); w.save_before(cx, |_, window, _| window.remove_window()) }).unwrap_or(true)
        });
        // One theme watcher is enough; a window opened on a document only reads.
        if document.is_none() { crate::settings::watch_themes(cx); }
        // 日期提醒: post what fell due since the last look (not what was
        // missed while the app was closed).
        cx.spawn(async |this, cx| {
            let mut last = crate::time::now_ms() as i64;
            loop {
                cx.background_executor().timer(Duration::from_secs(15)).await;
                let now = crate::time::now_ms() as i64;
                if this.update(cx, |w, cx| w.check_reminders(last, now, cx)).is_err() {
                    break;
                }
                last = now;
            }
        })
        .detach();
        let sidebar_width = store.settings().sidebar_width.unwrap_or(theme::SIDEBAR_WIDTH);
        let mut ws = Workspace {
            shortcut_recording: None,
            shortcut_strokes: vec![],
            shortcut_error: None,
            settings_page: Default::default(),
            theme_menu: None,
            theme_anchor: Default::default(),
            settings_filter,
            store,
            entries,
            current: None,
            pdf_reader: None, companion: Default::default(), companion_task: None, companion_error: None,
            pdf_importing: false,
            capture_picker: None,
            live_source: None,
            search,
            search_sel: None,
            sidebar_open: document.is_none(),
            sidebar_width,
            sidebar_drag: false,
            search_open: false,
            status: SaveStatus::Idle,
            row_menu: None,
            rename: None,
            more_bounds: Default::default(),
            list_scroll: ScrollHandle::new(),
            search_scroll: ScrollHandle::new(),
            row_sub_bounds: Rc::new(Cell::new(None)),
            batch: None,
            confirm: None,
            view: View::Doc,
            home: Default::default(),
            settings_scroll: ScrollHandle::new(),
            trash: vec![],
            trash_menu: None,
            toast: None,
            toast_task: None,
            mode_btn_bounds: Rc::new(Cell::new(None)),
            more_btn_bounds: Rc::new(Cell::new(None)),
            native_sidebar: Default::default(),
            shortcuts: false,
            folded: [false; 2],
            expanded: HashSet::new(),
            move_dlg: None,
            focus: cx.focus_handle(),
            save_task: None,
            dirty_since: None,
            unsaved: false,
            after_save: None,
            editor_sub: None,
            _subs: subs,
        };
        ws.sort();
        ws.load_home();
        // A fresh window always lands on the library, never the chat greeting.
        ws.home.chat = false;
        ws.home.recent_view = false;
        ws.start_companion(window, cx);
        // An empty library opens on 主页's empty state.
        match document.filter(|_| !crate::layout_preview()) {
            Some(id) => ws.open(&id, window, cx),
            None => ws.view = View::Home,
        }
        // Kept in the top bar (not just a toast): the user should notice.
        let warnings = ws.store.take_warnings();
        if !warnings.is_empty() {
            let msg = warnings.iter().map(|s| crate::settings::diagnostic(s)).collect::<Vec<_>>().join(crate::settings::tr("；", "; "));
            ws.show_toast_kind(ToastKind::Error, &msg, cx);
            ws.status = SaveStatus::Failed(msg);
        }
        ws
    }

    /// Most recently modified first.
    pub(crate) fn sort(&mut self) {
        self.entries.sort_by_key(|e| std::cmp::Reverse(e.meta.modified));
    }

    pub fn query(&self, cx: &App) -> String {
        self.search.read(cx).text.trim().to_lowercase()
    }

    pub fn open(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.try_open(id, window, cx);
    }

    /// Show `id`; false when it could not be opened (or the open document
    /// could not be saved first, see [`Self::save_before`]).
    pub fn try_open(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if crate::layout_preview() {
            self.show_toast("Layout sample only. Import a PDF in the product workspace to read it.", cx);
            return false;
        }
        if self.view != View::Doc {
            self.view = View::Doc;
            cx.notify();
        }
        if self.current.as_deref() == Some(id) {
            if let Some(reader) = &self.pdf_reader { reader.update(cx, |reader, cx| reader.set_active(true, cx)); }
            return true;
        }
        let target = id.to_string();
        if !self.save_before(cx, move |w, window, cx| {
            w.open(&target, window, cx);
        }) {
            return false;
        }
        if let Some(meta) = self.entries.iter().find(|e| e.id == id).map(|e| e.meta.clone()).filter(|m| m.source_pdf.is_some()) {
            let path = match self.store.pdf_path(id) {
                Ok(path) => path,
                Err(error) => { self.show_toast_kind(ToastKind::Error, &format!("Cannot open retained PDF: {error}"), cx); return false; }
            };
            let initial = meta.pdf_page.min((meta.pdf_pages.unwrap_or(1).saturating_sub(1)) as u16);
            let reader = cx.new(|cx| crate::pdf_reader::PdfReader::new(path, initial, window, cx));
            let document = id.to_string();
            self.editor_sub = Some(cx.subscribe(&reader, move |this, _, event: &crate::pdf_reader::PdfReaderEvent, cx| match event {
                crate::pdf_reader::PdfReaderEvent::Location(page) => {
                    if let Err(error) = this.store.update_meta(&document, |m| m.pdf_page = *page) {
                        this.show_toast_kind(ToastKind::Error, &format!("Cannot save reading position: {error}"), cx);
                    } else if let Some(entry) = this.entries.iter_mut().find(|e| e.id == document) { entry.meta.pdf_page = *page; }
                }
                crate::pdf_reader::PdfReaderEvent::BrowserLocation { page, fraction, zoom } => this.send_companion_location(&document, *page, *fraction, *zoom, cx),
                crate::pdf_reader::PdfReaderEvent::Toast(message) => this.show_toast_kind(ToastKind::Info, message, cx),
            }));
            self.pdf_reader = Some(reader);
            self.live_source = None;
                self.current = Some(id.to_string());
            self.view = View::Doc;
            if let Some(meta) = self.store.touch(id) && let Some(entry) = self.entries.iter_mut().find(|e| e.id == id) { entry.meta = meta; }
            self.reveal_in_tree(id);
            self.row_menu = None;
                            self.status = SaveStatus::Idle;
            window.focus(&self.focus);
            cx.notify();
            return true;
        }
        // This workspace holds PDFs; a record without a retained PDF has nothing to read.
        self.show_toast_kind(ToastKind::Error, crate::i18n::tr3("此记录没有可用的 PDF。", "This record has no PDF to open.", "Bản ghi này không có PDF để mở."), cx);
        false
    }

    pub fn new_doc(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_import(window, cx);
    }

    pub fn open_capture_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if crate::layout_preview() { self.show_toast_kind(ToastKind::Info, "Live mirror is available in the product workspace.", cx); return; }
        let id = uuid::Uuid::new_v4();
        self.capture_picker = Some(CapturePicker { id, loading: true, sources: vec![], error: None });
        self.row_menu = None;
        window.focus(&self.focus);
        let task = cx.background_executor().spawn(async { mirror_pdf_desktop::capture::sources().map_err(|e| format!("{e:#}")) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |w, cx| {
                let Some(picker) = w.capture_picker.as_mut().filter(|p| p.id == id) else { return };
                picker.loading = false;
                match result { Ok(sources) => picker.sources = sources, Err(error) => picker.error = Some(error) }
                cx.notify();
            });
        }).detach();
        cx.notify();
    }

    pub fn open_capture(&mut self, source: mirror_pdf_desktop::model::CaptureSource, window: &mut Window, cx: &mut Context<Self>) {
        let again = source.clone();
        if !self.save_before(cx, move |w, window, cx| w.open_capture(again, window, cx)) { return; }
        self.live_source = Some(source.label());
        let reader = cx.new(|cx| crate::pdf_reader::PdfReader::from_capture(source, window, cx));
        self.editor_sub = Some(cx.subscribe(&reader, |w, _, event: &crate::pdf_reader::PdfReaderEvent, cx| {
            if let crate::pdf_reader::PdfReaderEvent::Toast(message) = event { w.show_toast_kind(ToastKind::Info, message, cx); }
        }));
        self.pdf_reader = Some(reader);
        self.current = None;
        self.capture_picker = None;
        self.search_open = false;
        self.view = View::Doc;
        self.status = SaveStatus::Idle;
        window.focus(&self.focus);
        cx.notify();
    }

    fn render_capture_picker(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        use crate::ui::{dialog, scrim, secondary_button};
        let picker = self.capture_picker.as_ref()?;
        let mut list = div().id("capture-source-list").max_h(px(320.)).overflow_y_scroll().flex().flex_col().gap(px(4.));
        if picker.loading {
            list = list.child(div().py(px(28.)).text_center().text_color(Theme::text_caption()).child("Finding open windows and displays…"));
        } else if let Some(error) = &picker.error {
            list = list.child(div().py(px(20.)).text_size(px(13.)).text_color(Theme::danger()).child(error.clone()));
        } else if picker.sources.is_empty() {
            list = list.child(div().py(px(28.)).text_center().text_color(Theme::text_caption()).child("No capture sources found. Open a document window, then refresh."));
        } else {
            for (i, source) in picker.sources.iter().enumerate() {
                let selected = source.clone();
                let (kind, name, detail) = match source {
                    mirror_pdf_desktop::model::CaptureSource::Window { title, app, .. } => ("doc", title.clone(), format!("{} · {app}", crate::i18n::tr3("窗口", "Window", "Cửa sổ"))),
                    mirror_pdf_desktop::model::CaptureSource::Monitor { title, .. } => ("eye", title.clone(), crate::i18n::tr3("整个屏幕 · 可能包含其他可见应用", "Entire display · other visible apps may be included", "Toàn màn hình · có thể gồm các ứng dụng khác đang hiện").into()),
                };
                list = list.child(div().id(SharedString::from(format!("capture-source-{i}"))).px(px(12.)).py(px(10.)).flex().items_center().gap(px(12.))
                    .rounded(px(8.)).cursor_pointer().hover(|s| s.bg(Theme::fill_hover()))
                    .child(icon(kind, 18., Theme::text_caption()))
                    .child(div().flex_1().min_w_0().flex().flex_col().gap(px(3.))
                        .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).overflow_hidden().whitespace_nowrap().text_ellipsis().child(name))
                        .child(div().text_size(px(11.)).text_color(Theme::text_caption()).child(detail)))
                    .child(icon("chevron-right", 12., Theme::text_caption()))
                    .on_click(cx.listener(move |w, _, window, cx| w.open_capture(selected.clone(), window, cx))));
            }
        }
        let modal = dialog("capture-picker").w(px(560.)).max_w_full().p(px(24.)).flex().flex_col().gap(px(16.))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(div().text_size(px(17.)).font_weight(FontWeight::SEMIBOLD).child(crate::i18n::tr3("选择实时来源", "Choose a live source", "Chọn nguồn trực tiếp")))
            .child(div().text_size(px(13.)).line_height(px(20.)).text_color(Theme::text_caption()).child(crate::i18n::tr3("镜像一个文档窗口或整个屏幕。截图仅在本机处理；云端翻译需要在服务商设置中单独授权。", "Mirror a document window or display. Capture stays local; cloud translation requires separate permission in provider settings.", "Gương một cửa sổ tài liệu hoặc màn hình. Ảnh chụp chỉ xử lý trên máy; dịch qua đám mây cần cấp quyền riêng trong phần nhà cung cấp.")))
            .child(list)
            .child(div().flex().justify_end().gap(px(8.))
                .child(secondary_button("capture-refresh", crate::i18n::tr3("刷新", "Refresh", "Làm mới")).on_click(cx.listener(|w, _, window, cx| w.open_capture_picker(window, cx))))
                .child(secondary_button("capture-cancel", crate::i18n::tr3("取消", "Cancel", "Huỷ")).on_click(cx.listener(|w, _, _, cx| { w.capture_picker = None; cx.notify(); }))));
        Some(deferred(div().id("capture-picker-mask").absolute().inset_0().flex().items_center().justify_center().bg(scrim())
            .on_mouse_down(MouseButton::Left, cx.listener(|w, _, _, cx| { w.capture_picker = None; cx.notify(); }))
            .child(modal)).with_priority(4).into_any_element())
    }

    /// Ask before 删除: a confirmation, then the 回收站.
    pub fn ask_delete(&mut self, id: &str, cx: &mut Context<Self>) {
        self.row_menu = None;
        self.confirm = Some(Confirm::Delete { ids: vec![id.to_string()], batch: false });
        cx.notify();
    }

    /// Move documents to the trash; if the open one goes, open the next.
    pub fn delete_docs(&mut self, ids: &[String], window: &mut Window, cx: &mut Context<Self>) {
        // A page goes with its child pages: each topmost page is
        // trashed as one item that carries its subtree.
        let tree = crate::tree::Tree::new(&self.entries);
        let mut all: Vec<(String, Option<String>)> = vec![];
        for id in ids {
            let covered = self.ancestors(id).iter().any(|a| ids.contains(&a.id));
            if covered {
                continue;
            }
            for d in tree.subtree(id) {
                if !all.iter().any(|(x, _)| *x == d) {
                    let root = (d != *id).then(|| id.clone());
                    all.push((d, root));
                }
            }
        }
        let groups = all;
        let all: Vec<String> = groups.iter().map(|(d, _)| d.clone()).collect();
        for handle in cx.windows().into_iter().filter(|w| w.window_id() != window.window_handle().window_id()) {
            if let Some(handle) = handle.downcast::<Workspace>()
                && handle.update(cx, |ws, _, _| ws.current.as_ref().is_some_and(|id| all.contains(id))).unwrap_or(false)
            {
                self.show_toast_kind(ToastKind::Error, crate::settings::text("请先关闭正在编辑这些文档的其他窗口，再删除"), cx);
                return;
            }
        }
        if self.current.as_ref().is_some_and(|c| all.contains(c)) {
            let retry = ids.to_vec();
            if !self.save_before(cx, move |w, window, cx| w.delete_docs(&retry, window, cx)) {
                return;
            }
        }
        let mut deleted = vec![];
        let mut errors = vec![];
        for (id, root) in &groups {
            // Do not split a subtree when its root could not be deleted.
            if root.as_ref().is_some_and(|r| !deleted.contains(r)) { continue; }
            match self.store.delete(id, root.as_deref()) {
                Ok(()) => deleted.push(id.clone()),
                Err(e) => errors.push(crate::localized_format!("删除失败：{}", "Could not delete document: {}", crate::settings::diagnostic(&e.to_string()))),
            }
        }
        if self.current.as_ref().is_some_and(|c| deleted.contains(c)) {
            self.save_task = None;
            self.unsaved = false;
            self.current = None;
                self.pdf_reader = None;
            self.editor_sub = None;
        }
        self.entries.retain(|e| !deleted.contains(&e.id));
        if let Some(b) = self.batch.as_mut() {
            b.retain(|id| !deleted.contains(id));
        }
        self.row_menu = None;
        if self.current.is_none() {
            // Stay on 主页 / 回收站 if that's where the delete came from.
            // The last document gone leaves the library empty (主页's empty
            // state), not a new 未命名 document.
            let view = self.view;
            match self.entries.first().map(|e| e.id.clone()) {
                Some(next) => { self.open(&next, window, cx); self.view = view; }
                None => self.view = if view == View::Doc { View::Home } else { view },
            }
        }
        self.sync_sub_pages(cx);
        if self.view == View::Trash {
            self.trash = self.store.list_trash();
        }
        errors.extend(self.store.take_warnings().iter().map(|s| crate::settings::diagnostic(s)));
        if errors.is_empty() {
            self.show_toast(crate::settings::text("删除成功"), cx);
        } else {
            let msg = errors.join("；");
            self.show_toast_kind(ToastKind::Error, &msg, cx);
            self.status = SaveStatus::Failed(msg);
        }
        cx.notify();
    }

    pub fn toggle_pin(&mut self, id: &str, cx: &mut Context<Self>) {
        let mut on = false;
        if let Some(e) = self.entries.iter_mut().find(|e| e.id == id) {
            e.meta.pinned = !e.meta.pinned;
            on = e.meta.pinned;
            let _ = self.store.set_pinned(id, e.meta.pinned);
        }
        self.sort();
        self.row_menu = None;
        self.show_toast(if on { crate::settings::text("已添加到“置顶”") } else { crate::settings::text("已从“置顶”移除") }, cx);
        cx.notify();
    }

    /// 收藏 / 取消收藏 (listed under 主页 → 收藏).
    pub fn toggle_star(&mut self, id: &str, cx: &mut Context<Self>) {
        let Some(e) = self.entries.iter_mut().find(|e| e.id == id) else { return };
        let on = e.meta.starred == 0;
        if let Ok(t) = self.store.set_starred(id, on) {
            e.meta.starred = t;
        }
        self.row_menu = None;
        self.show_toast(if on { crate::settings::text("已添加到“收藏”") } else { crate::settings::text("已从“收藏”中移除") }, cx);
        cx.notify();
    }

    /// Switch the main pane to 主页 or 回收站 (or back to the document).
    pub fn show_view(&mut self, view: View, cx: &mut Context<Self>) {        self.cancel_shortcut_recording(cx);
        if view == View::Trash {
            self.trash = self.store.list_trash();
        }
        if let Some(reader) = &self.pdf_reader { reader.update(cx, |reader, cx| reader.set_active(view == View::Doc, cx)); }
        self.view = view;
        self.row_menu = None;
        self.trash_menu = None;
        self.theme_menu = None;
        self.home.sort_menu = false;
        cx.notify();
    }

    /// The Favorites destination: the library filtered to starred documents.
    pub fn open_favorites(&mut self, cx: &mut Context<Self>) {
        self.home.chat = false;
        // Leave 最近 as well, or the sidebar would light both rows.
        self.home.recent_view = false;
        self.home.tab = crate::home::HomeTab::Starred;
        self.show_view(View::Home, cx);
    }

    /// A success toast (删除成功, 移动成功 …).
    pub fn show_toast(&mut self, msg: &str, cx: &mut Context<Self>) {
        self.show_toast_kind(ToastKind::Success, msg, cx);
    }

    pub fn show_toast_kind(&mut self, kind: ToastKind, msg: &str, cx: &mut Context<Self>) {
        self.toast = Some((kind, SharedString::from(msg.to_string()), Instant::now()));
        self.toast_task = Some(cx.spawn(async |this, cx| {
            cx.background_executor().timer(Duration::from_millis(2700)).await;
            let _ = this.update(cx, |_, cx| cx.notify());
        }));
        cx.notify();
    }

    fn render_toast(&self, window: &mut Window) -> Option<AnyElement> {
        let (kind, msg, t0) = self.toast.as_ref()?;
        crate::ui::toast_el(*kind, msg, *t0, window)
    }

    /// 重命名: the row's title turns into an input; Enter or clicking away saves, Esc cancels.
    pub fn start_rename(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(title) = self.entries.iter().find(|e| e.id == id).map(|e| e.title.trim().to_string()) else { return };
        let field = cx.new(|cx| {
            let mut f = TextField::new(crate::settings::UNTITLED, cx);
            f.set_text(&title, cx);
            f.select_all_text(cx);
            f
        });
        let focus = field.focus_handle(cx);
        window.focus(&focus);
        let subs = vec![
            cx.subscribe_in(&field, window, |w, _, ev: &TextFieldEvent, window, cx| match ev {
                TextFieldEvent::Submit => w.finish_rename(true, window, cx),
                TextFieldEvent::Cancel => w.finish_rename(false, window, cx),
                _ => {}
            }),
            cx.on_blur(&focus, window, |w, window, cx| w.finish_rename(true, window, cx)),
        ];
        self.rename = Some(Rename { id: id.to_string(), field, _subs: subs });
        // From 主页 the row may be hidden: show it in the sidebar.
        self.sidebar_open = true;
        self.reveal_in_tree(id);
        self.row_menu = None;
        cx.notify();
    }

    fn finish_rename(&mut self, commit: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(r) = self.rename.take() else { return };
        let refocus = r.field.read(cx).is_focused(window);
        let title = r.field.read(cx).text.trim().to_string();
        let old = self.entries.iter().find(|e| e.id == r.id).map(|e| e.title.trim().to_string());
        if commit && old.is_some_and(|o| o != title) {
            match self.store.rename(&r.id, &title) {
                Ok(meta) => {
                    if let Some(e) = self.entries.iter_mut().find(|e| e.id == r.id) {
                        e.title = title;
                        e.meta = meta;
                    }
                    self.sort();
                }
                Err(e) => self.status = SaveStatus::Failed(crate::localized_format!("重命名失败：{}", "Could not rename document: {}", crate::settings::diagnostic(&e.to_string()))),
            }
        }
        self.sync_sub_pages(cx);
        cx.notify();
    }

    fn sync_document(&mut self, _window: &Window, _cx: &mut Context<Self>) {
        // PDF records carry no edited document state; the reader persists its
        // own page position through the store.
    }

    fn schedule_save(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {
        // Nothing to autosave: PDF records are read-only views of their file.
    }

    fn check_reminders(&mut self, _from: i64, _to: i64, _cx: &mut Context<Self>) {
        // A PDF record has no reminders; the ticker stays so the loop keeps one
        // shape across record kinds.
    }

    /// Write the open document to disk if it has unsaved changes. False when
    /// that failed: the changes stay pending (a later save retries them) and
    /// the top bar shows the error.
    pub fn flush(&mut self, _cx: &mut Context<Self>) -> bool {
        self.save_task = None;
        self.unsaved = false;
        self.status = SaveStatus::Idle;
        true
    }

    /// Save the open document before something replaces it. When the save
    /// fails nothing is replaced: the 保存失败 dialog offers 重试 / 放弃修改
    /// and runs `then` after either.
    pub fn save_before(&mut self, _cx: &mut Context<Self>, _then: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>) + 'static) -> bool {
        true
    }

    /// The 保存失败 dialog's choices: `retry` saves again, otherwise the
    /// changes are given up. Either way the held-back action runs once the
    /// document no longer needs saving.
    pub(crate) fn resolve_save_failed(&mut self, _retry: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.confirm = None;
        if let Some(then) = self.after_save.take() {
            then(self, window, cx);
        }
        cx.notify();
    }

    /// The error of the last failed save, for the 保存失败 dialog.
    pub(crate) fn save_error(&self) -> String {
        match &self.status {
            SaveStatus::Failed(e) => e.clone(),
            _ => crate::settings::text("保存失败").to_string(),
        }
    }

    /// The library's titles and links, kept for the PDF surfaces.
    pub(crate) fn sync_links(&mut self, _cx: &mut Context<Self>) {}


    /// A 反向引用 line: open that document.
    fn open_at(&mut self, id: &str, _ordinal: usize, window: &mut Window, cx: &mut Context<Self>) {
        let _ = self.try_open(id, window, cx);
    }

    /// 隐藏引用列表 / 显示引用列表: confirm first (hiding can skip it with 不再提示).


    /// 主页's search box, centred on the pane but never over what sits on
    /// either side of it: the title (and, with the sidebar hidden, the
    /// traffic lights and 展开侧栏) on the left, + on the right. Below a
    /// usable width it is None and the caller shows a search icon instead.
    pub(crate) fn header_search(&self, window: &Window, cx: &mut Context<Self>) -> Option<Stateful<Div>> {
        let main = f32::from(window.viewport_size().width) - if self.sidebar_open { self.sidebar_w(window) } else { 0. };
        let title = crate::settings::label(crate::settings::text("主页"));
        let title_w = f32::from(window.text_system().shape_line(title.clone().into(), px(17.), &[window.text_style().highlight(HighlightStyle { font_weight: Some(FontWeight::SEMIBOLD), ..Default::default() }).to_run(title.len())], None).width);
        // page_header's left inset (26 with the sidebar, else the traffic
        // lights plus the 4 + 28 + 12 of 展开侧栏), then 16 clear of the title.
        let left = if self.sidebar_open { 26. } else { theme::TRAFFIC_LIGHTS_W + 44. + if cfg!(target_os = "windows") { 32. } else { 0. } } + title_w + 16.;
        // + is 32 wide with an 8pt inset; 16 clear of it.
        let right = HEADER_ACTIONS_H + crate::ui::header_right_inset() + 16.;
        let half = (main / 2. - left).min(main / 2. - right);
        let width = (main - 320.).min(2. * half).min(360.);
        if width < 120. { return None }
        Some(div().id("header-search").absolute().left(px((main - width) / 2.)).top(px(8.))
            .w(px(width)).h(px(32.)).no_drag().flex().items_center().gap(px(8.)).px(px(10.))
            .rounded(px(9.)).bg(Theme::fill_hover())
            .cursor_pointer().hover(|s| s.bg(Theme::fill_hover_strong()))
            .child(icon("search", 15., Theme::text_caption()))
            .child(div().flex_1().min_w_0().truncate().text_size(px(13.)).text_color(Theme::text_caption()).child(crate::settings::tr("搜索文档…", "Search documents…")))
            .when(width >= 200., |d| d.child(div().flex_none().text_size(px(11.)).text_color(Theme::text_placeholder()).child(crate::shortcuts::hint("workspace::FocusSearch", "⌘ + J").replace(" + ", " "))))
            .tip(crate::settings::tr("搜索文档", "Search documents"), Some(crate::shortcuts::hint("workspace::FocusSearch", "⌘ + J")))
            .on_click(cx.listener(|w, _, window, cx| w.open_search(window, cx))))
    }

    fn top_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let title = self.current.as_ref().and_then(|id| self.entries.iter().find(|e| &e.id == id)).map(|e| display_title(&e.title))
            .or_else(|| self.live_source.clone())
            .unwrap_or_default();
        let save_error = match &self.status {
            SaveStatus::Failed(error) => Some(error.clone()),
            _ => None,
        };
        // Independent icon controls, with equal top and right insets.
        let seg = crate::ui::header_icon;
        let divider = || div().flex_none().w(px(1.)).h(px(18.)).bg(Theme::line_divider());
        // Breadcrumbs: the parent pages, each linking to itself, with the
        // middle ones folded into "…" when the chain is long.
        let chain: Vec<(String, String, Option<String>)> = self
            .current
            .as_ref()
            .map(|id| self.ancestors(id).iter().map(|e| (e.id.clone(), display_title(&e.title), e.icon.clone())).collect())
            .unwrap_or_default();
        let mut crumbs: Vec<AnyElement> = vec![];
        let sep = || div().mx(px(3.)).flex_none().child(icon("chevron-right", 12., theme::c(craft::N500))).into_any_element();
        for (i, (id, name, em)) in chain.iter().enumerate() {
            if chain.len() > 2 && i > 0 && i < chain.len() - 1 {
                if i == 1 {
                    let hidden: Vec<&str> = chain[1..chain.len() - 1].iter().map(|c| c.1.as_str()).collect();
                    crumbs.push(
                        div()
                            .id("crumb-more")
                            .no_drag()
                            .flex_none()
                            .size(px(20.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(4.))
                            .text_color(Theme::text_caption())
                            .tip(&hidden.join(" / "), None)
                            .child("…")
                            .into_any_element(),
                    );
                    crumbs.push(sep());
                }
                continue;
            }
            let id = id.clone();
            crumbs.push(
                div()
                    .id(SharedString::from(format!("crumb-{id}")))
                    .no_drag()
                    .min_w(px(28.))
                    .max_w(px(200.))
                    .px(px(4.))
                    .flex()
                    .items_center()
                    .rounded(px(4.))
                    .cursor_pointer()
                    .text_color(Theme::text_caption())
                    .hover(|s| s.text_color(Theme::primary_500()))
                    .when_some(em.clone(), |d, em| {
                        d.child(div().size(px(20.)).mr(px(4.)).flex_none().flex().items_center().justify_center().text_size(px(16.)).child(em))
                    })
                    .child(div().min_w_0().overflow_hidden().whitespace_nowrap().text_ellipsis().child(ui_text(name.clone())))
                    .on_click(cx.listener(move |w, _, window, cx| w.open(&id, window, cx)))
                    .into_any_element(),
            );
            crumbs.push(sep());
        }
        let record_more = self.more_btn_bounds.clone();
        div()
            .id("top-bar").relative()
            .h(px(HEADER_H))
            .flex_none()
            .flex()
            .items_center()
            .pr(px(crate::ui::header_right_inset()))
            // Clear of the traffic lights, which sit over the note when the sidebar is closed.
            .pl(if self.sidebar_open { px(18.) } else { px(theme::TRAFFIC_LIGHTS_W) })
            .title_bar()
            .when(!self.sidebar_open, |d| {
                d.child(
                    div()
                        .id("open-sidebar")
                        .no_drag()
                        .flex_none()
                        .ml(px(4.))
                        .size(px(28.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(8.))
                        .cursor_pointer()
                        .hover(|s| s.bg(Theme::fill_hover_strong()))
                        .tip(crate::settings::tr("展开侧栏", "Show sidebar"), Some(crate::shortcuts::hint("workspace::ToggleSidebar", "⌘ + ]")))
                        .child(icon("panel-left-open", 17., Theme::icon()))
                        .on_click(cx.listener(|w, _, _, cx| {
                            w.sidebar_open = true;
                            cx.notify();
                        })),
                )
                .child(
                    div().id("header-home").no_drag().flex_none().ml(px(4.)).size(px(28.))
                        .flex().items_center().justify_center().rounded(px(8.)).cursor_pointer()
                        .hover(|s| s.bg(Theme::fill_hover_strong()))
                        .active(|s| s.bg(Theme::fill_pressed()))
                        .tip(crate::settings::text("返回主页"), None)
                        .child(icon("home", 18., Theme::icon()))
                        .on_click(cx.listener(|w, _, _, cx| w.show_view(View::Home, cx))),
                )
                .child(div().mx(px(12.)).child(divider()))
            })
            .child(
                div()
                    .min_w_0()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(
                        div()
                            .h(px(20.))
                            .min_w_0()
                            .flex()
                            .items_center()
                            .text_size(px(13.))
                            .line_height(px(20.))
                            .children(crumbs)
                            .child(
                                div()
                                    .min_w_0()
                                    .text_size(px(14.))
                                    .line_height(px(20.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(Theme::text())
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .child(ui_text(title)),
                            ),

                    )
                    .when_some(save_error, |d, error| d.child(
                        div().min_w_0().max_w(px(220.)).text_size(px(12.)).line_height(px(18.))
                            .text_color(theme::c(craft::R400)).overflow_hidden().whitespace_nowrap().text_ellipsis().child(error),
                    )),
            )
            .child(div().flex_1().min_w(px(16.)))
            .child(
                div().gap(px(4.))
                    .h(px(HEADER_ACTIONS_H)).flex_none()
                    .flex()
                    .items_center()
                    .when(self.current.is_some(), |d| {
                        d.child(
                            // No tooltip while its dropdown is open; the menu hangs
                            // from this button's right edge.
                            seg("doc-more", "ellipsis")
                                .relative()
                                .tip(crate::settings::tr("更多", "More"), None)
                                .child(canvas(move |b, _, _| record_more.set(Some(b)), |_, _, _, _| {}).absolute().inset_0())
                                .on_click(cx.listener(|w, _, _, cx| {
                                    if let (Some(id), Some(bounds)) = (w.current.clone(), w.more_btn_bounds.get()) {
                                        w.row_menu = Some(RowMenu { id, pos: point(-bounds.left(), bounds.top()), corner: Corner::TopLeft, sub: false, batch: false });
                                    }
                                    cx.notify();
                                })), 
                        )
                    })
                    .child(
                        seg("doc-search", "search")
                            .tip_label(crate::shortcuts::keys(crate::settings::text("搜索(⌘ + J)")).into(), TipSide::Below)
                            .on_click(cx.listener(|_, _, window, cx| window.dispatch_action(Box::new(FocusSearch), cx))),
                    )
                    .child(
                        // Straight to a new document: no 新建 menu, as 导入 is rare.
                        seg("doc-new", "plus").tip(crate::settings::tr("导入 PDF", "Import PDF"), None).on_click(cx.listener(|w, _, window, cx| w.new_doc(window, cx))),
                    ).into_any_element()
            )
    }
}

/// Header and action group share an 8px top/right inset.
pub const HEADER_H: f32 = 48.;
pub(crate) const HEADER_ACTIONS_H: f32 = 32.;

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Clicks no longer take focus from the editor (see the root's mouse
        // down), so leaving the document hands it back to the window's keys.
        self.native_sidebar.sync(if self.sidebar_open { self.sidebar_w(window) } else { 0. }, window);
        let sidebar = if self.sidebar_open { Some(if matches!(self.view, View::Settings | View::Trash) { self.render_settings_sidebar(window, cx) } else { self.render_sidebar(window, cx) }) } else { None };
        let row_menu = self.render_row_menu(window, cx);
        let resize = self.sidebar_open.then(|| self.render_resize_handle(window, cx));
        let resize_overlay = self.render_resize_overlay(cx);
        let search = self.render_search(window, cx);
        let confirm = self.render_confirm(cx);
        let capture_picker = self.render_capture_picker(cx);
        let trash_menu = self.render_trash_menu(cx);
        let home_menus = self.render_home_menus(cx);
        let theme_menu = self.render_theme_menu(cx);
        let toast = self.render_toast(window);
        let main = match self.view {
            View::Doc => div()
                .flex_1()
                .min_w_0()
                .h_full()
                .flex()
                .flex_col()
                .child(self.top_bar(cx))
                .child(
                    div()
                        .flex_1()
                        .min_h_0()
                        .flex()
                        .child(
                            div()
                                .relative()
                                .flex_1()
                                .min_w_0()
                                .h_full()
                                                    .children(self.pdf_reader.clone()),
                        )
                        .children(self.render_shortcuts(cx)),
                )
                .into_any_element(),
            View::Home => self.render_home(window, cx),
            View::Trash => self.render_trash(cx),
            View::Settings => self.render_settings(cx),
        };
        let move_dlg = self.render_move_dialog(cx);
        // Only the note stands out: a white plane flush with the window's top,
        // right and bottom edges. The sidebar sits sunken on the window
        // surface beside it; the change of value is the only line between
        // them (no gutter, radius, border or shadow).
        // A document sits on its theme's page colour.
        let page = Theme::bg_body();
        let note = div().id("note").relative().flex_1().min_w_0().h_full().flex().bg(page).child(main);
        div()
            .id("workspace")
            .key_context("Workspace")
            .track_focus(&self.focus)
            .on_drop(cx.listener(|w, paths: &ExternalPaths, window, cx| w.import_pdf_paths(paths.paths(), window, cx)))
            // A click on what takes no input (title bar, page margins, the
            .relative()
            .size_full()
            .flex()
            .bg(Theme::window())
            .font_family(theme::UI_FONT)
            .text_color(Theme::text())
            // Window keys act on the window they were pressed in, not on
            // whichever window macOS considers active.
            .on_action(cx.listener(|w, _: &CloseWindow, window, cx| {
                crate::persist_window_size(cx);
                if w.save_before(cx, |_, window, _| window.remove_window()) { window.remove_window(); }
            }))
            .on_action(|_: &Minimize, window, _| window.minimize_window())
            .on_action(|_: &Zoom, window, _| window.zoom_window())
            .on_action(|_: &ToggleFullScreen, window, _| window.toggle_fullscreen())
            .on_action(cx.listener(|w, _: &OpenSettings, _, cx| w.show_view(View::Settings, cx)))
            .on_action(cx.listener(|w, _: &OpenAbout, _, cx| w.open_settings(crate::settings::Page::About, cx)))
            .on_action(cx.listener(|w, _: &GoHome, _, cx| w.show_view(View::Home, cx)))
            .on_action(cx.listener(|w, _: &NewDoc, window, cx| w.new_doc(window, cx)))
            .on_action(cx.listener(|w, _: &ImportDoc, window, cx| w.open_import(window, cx)))
            .on_action(cx.listener(|w, _: &ToggleSidebar, _, cx| {
                w.sidebar_open = !w.sidebar_open;
                cx.notify();
            }))
            .on_action(cx.listener(|w, _: &FindInDoc, window, cx| w.open_search(window, cx)))
            .on_action(cx.listener(|w, _: &ReplaceInDoc, window, cx| w.open_search(window, cx)))
            .on_key_down(cx.listener(|w, ev: &KeyDownEvent, window, cx| {
                // The theme dropdown: ↑ ↓ preview, ↩ applies, Esc closes it (not 设置).
                if w.theme_menu.is_some() && w.theme_menu_key(&ev.keystroke.key, cx) {
                    cx.stop_propagation();
                    return;
                }
                // Esc leaves 设置 (unless its filter field has the caret).
                if ev.keystroke.key == "escape" && w.view == View::Settings && !w.settings_filter.read(cx).is_focused(window) {
                    w.close_settings(cx);
                    cx.stop_propagation();
                    return;
                }
                if ev.keystroke.key == "escape" && w.row_menu.is_some() {
                    w.row_menu = None;
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
            // Esc leaves 批量操作 (closing its menu or confirmation first), even from the editor.
            .capture_key_down(cx.listener(|w, ev: &KeyDownEvent, _, cx| {
                if w.record_shortcut(ev, cx) { return; }
                if ev.keystroke.key == "escape" && w.capture_picker.is_some() {
                    w.capture_picker = None;
                    cx.stop_propagation();
                    cx.notify();
                    return;
                }
                // Esc cancels a confirmation dialog.
                if ev.keystroke.key == "escape" && (w.confirm.is_some()) {
                    w.confirm = None;
                    w.after_save = None;
                    cx.stop_propagation();
                    cx.notify();
                    return;
                }
                if ev.keystroke.key != "escape" || w.batch.is_none() || w.search_open || w.rename.is_some() {
                    return;
                }
                if w.row_menu.is_some() {
                    w.row_menu = None;
                } else {
                    w.batch = None;
                }
                cx.stop_propagation();
                cx.notify();
            }))
            .on_action(cx.listener(|w, _: &FocusSearch, window, cx| {
                if w.search_open { w.close_search(window, cx); } else { w.open_search(window, cx); }
                cx.stop_propagation();
            }))
            .children(sidebar)
            .child(note)
            .children(resize)
            .children(crate::ui::window_controls(window))
            .children(row_menu)
            .children(trash_menu)
            .children(home_menus)
            .children(theme_menu)
            .children(confirm)
            .children(move_dlg)
            .children(search)
            .children(capture_picker)
            .children(resize_overlay)
            .children(toast)
    }
}

