#![recursion_limit = "512"]
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

pub(crate) const APP_ID: &str = "local.pdfworkspace.preview";
pub(crate) const UI_PREVIEW: bool = true;
pub(crate) fn layout_preview() -> bool { std::env::var_os("PDF_WORKSPACE_LAYOUT_PREVIEW").is_some_and(|v| v == "1") }

mod app;
mod pdf_reader;
mod product_library;
mod native_bridge;
mod shared_store;
mod assets;
mod clipboard;
#[cfg(feature = "devtools")]
mod devtools;
/// Without the `devtools` feature (release builds) nothing reads FDL_SCRIPT.
#[cfg(not(feature = "devtools"))]
mod devtools {
    pub static RENDER_NS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    pub fn scripted() -> bool { false }
    pub fn start(_: &mut gpui::Window, _: &mut gpui::App) {}
    pub fn take_pick() -> Option<Vec<std::path::PathBuf>> { None }
}
mod home;
mod i18n;
mod input;
mod text_field_element;
mod logging;
mod modes;
#[cfg(target_os = "macos")]
mod native_header;
#[cfg(not(target_os = "macos"))]
#[path = "native_header_fallback.rs"]
mod native_header;
mod search;
mod sidebar;
mod settings;
mod themes;
mod shortcuts;
#[allow(dead_code, unused_imports)]
mod feishu_theme;
#[allow(dead_code, unused_imports)]
#[allow(dead_code, unused_imports)]
mod theme;
mod transfer;
mod trash;
mod tree;
mod ui;

pub(crate) use pdf_library::{store, time};
mod palette;

use gpui::*;

/// The main window, centred at the remembered size.
fn open_main_window(scripted: bool, cx: &mut App) {
    let bounds = Bounds::centered(None, main_window_size(cx), cx);
    // Scripted dev runs must not steal keyboard focus from whatever the
    // user is typing into.
    cx.open_window(window_options(bounds, scripted), |window, cx| {
        devtools::start(window, cx);
        let workspace = cx.new(|cx| app::Workspace::new(window, cx));
        if !layout_preview() {
            let paths: Vec<std::path::PathBuf> = std::env::args_os().skip(1).map(std::path::PathBuf::from).filter(|path| path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))).collect();
            if !paths.is_empty() { workspace.update(cx, |state, cx| state.import_pdf_paths(&paths, window, cx)); }
        }
        workspace
    })
    .expect("open window");
}

/// The window chrome every window shares.
fn window_options(bounds: Bounds<Pixels>, scripted: bool) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        window_background: crate::theme::window_background(),
        app_id: Some(crate::APP_ID.into()),
        window_decorations: if cfg!(target_os = "linux") { Some(WindowDecorations::Client) } else { None },
        titlebar: Some(TitlebarOptions {
            title: Some("Documents".into()),
            appears_transparent: cfg!(any(target_os = "macos", target_os = "windows")),
            traffic_light_position: Some(point(px(20.), px(app::HEADER_H / 2. - 7.))),
        }),
        window_min_size: Some(size(px(980.), px(620.))),
        focus: !scripted,
        ..Default::default()
    }
}

/// 在新窗口中打开: another window on the same library, showing `document`.
pub(crate) fn open_document_window(document: Option<String>, cx: &mut App) {
    let bounds = Bounds::centered(None, main_window_size(cx), cx);
    match cx.open_window(window_options(bounds, false), |window, cx| {
        cx.new(|cx| app::Workspace::new_document_window(document, window, cx))
    }) {
        Ok(_) => cx.activate(true),
        Err(e) => eprintln!("无法打开窗口：{e}"),
    }
}

/// The main window's size: last used, or a wide reading window. A PDF reader
/// wants landscape width, so the fallback is 1663 × 941 rather than a square.
fn main_window_size(cx: &App) -> Size<Pixels> {
    let s = cx.global::<shared_store::SharedStore>().settings().window_size.unwrap_or([1663., 941.]);
    size(px(s[0].max(980.)), px(s[1].max(620.)))
}

/// Window sizes seen this session, saved when the window closes.
#[derive(Clone, Copy, Default)]
struct Sizes { main: Option<[f32; 2]> }
impl Global for Sizes {}

/// Remember the window's size for `persist_window_size`.
pub(crate) fn remember_window_size(window: &Window, cx: &mut App) {
    if let WindowBounds::Windowed(bounds) = window.window_bounds() {
        let s = [f32::from(bounds.size.width), f32::from(bounds.size.height)];
        let mut sizes = cx.try_global::<Sizes>().copied().unwrap_or_default();
        sizes.main = Some(s);
        cx.set_global(sizes);
    }
}

/// Save the remembered window size; runs when a window closes and when the app quits.
pub(crate) fn persist_window_size(cx: &mut App) {
    let (Some(sizes), Some(store)) = (cx.try_global::<Sizes>().copied(), cx.try_global::<shared_store::SharedStore>()) else { return };
    let Some(main) = sizes.main else { return };
    let mut settings = store.settings();
    settings.window_size = Some(main);
    if let Err(e) = store.save_settings(&settings) { eprintln!("无法保存窗口尺寸：{e}"); }
}

fn main() {
    #[cfg(all(feature = "devtools", target_os = "windows"))]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).is_some_and(|arg| arg == "--dev-capture-window") {
            let capture = || -> anyhow::Result<()> {
                let id = args.get(2).ok_or_else(|| anyhow::anyhow!("Missing HWND"))?.parse::<u32>()?;
                let path = args.get(3).ok_or_else(|| anyhow::anyhow!("Missing output path"))?;
                let source = mirror_pdf_desktop::model::CaptureSource::Window { id, title: "Native verification".into(), app: "pdf_workspace".into() };
                mirror_pdf_desktop::capture::grab(&source)?.save(path)?;
                Ok(())
            };
            if let Err(error) = capture() { eprintln!("Native capture helper: {error:#}"); std::process::exit(1); }
            return;
        }
    }
    logging::init();
    let scripted = devtools::scripted();
    let root = store::Store::root_dir();
    logging::write(&format!("workspace {}", root.display()));
    let app = Application::new().with_assets(assets::Assets);
    // macOS keeps running after ⌘W closes the last window; clicking the Dock
    // icon then brings the main window back.
    app.on_reopen(|cx| if cx.windows().is_empty() { open_main_window(false, cx); });
    app.run(move |cx: &mut App| {
        input::bind_keys(cx);
        app::bind_keys(cx);
        settings::load(); // preferences first: they fix the interface language (i18n), theme base and palette
        settings::apply_appearance(&settings::prefs().appearance);
        settings::sync_dark(cx);
        themes::load(&settings::prefs().theme_id(), false, || cx.text_system().all_font_names());
        shortcuts::init(cx);
        match shared_store::SharedStore::open() {
            Ok(s) => cx.set_global(s),
            Err(err) => logging::fatal("无法打开文档库 / Could not open the library", &err),
        }
        app::set_menus(cx);
        open_main_window(scripted, cx);
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        if !scripted {
            cx.activate(true);
        }
    });
}
