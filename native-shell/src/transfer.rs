//! Import and export of PDFs: pick files, keep the original in the library,
//! and write a copy of the retained original where the user asks.

use crate::app::Workspace;
use crate::theme::Theme;
use crate::trash::scrim;
use crate::ui::ToastKind;
use gpui::{prelude::FluentBuilder, *};
use std::path::PathBuf;

fn downloads() -> PathBuf {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Downloads")).unwrap_or_default()
}

/// Where to save `name`: the system save panel (Downloads first), or a
/// scripted answer.
fn save_path(name: &str, cx: &mut App) -> impl std::future::Future<Output = Option<PathBuf>> + use<> {
    let picked = crate::devtools::take_pick().and_then(|p| p.into_iter().next());
    let prompt = picked.is_none().then(|| cx.prompt_for_new_path(&downloads(), Some(name)));
    async move {
        match prompt {
            Some(p) => p.await.ok().and_then(Result::ok).flatten(),
            None => picked,
        }
    }
}

/// PDF files to import: the system open panel, or a scripted answer.
fn open_paths(cx: &mut App) -> impl std::future::Future<Output = Option<Vec<PathBuf>>> + use<> {
    let picked = crate::devtools::take_pick();
    let extensions = Some(vec![SharedString::from("pdf")]);
    let prompt = picked.is_none().then(|| cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: true, prompt: Some(crate::settings::text("导入").into()), extensions }));
    async move {
        match prompt {
            Some(p) => p.await.ok().and_then(Result::ok).flatten(),
            None => picked,
        }
    }
}

/// The modal mask (the window dimmed) and its dialog.
#[allow(dead_code)]
fn mask(id: &'static str, dialog: impl IntoElement, close: impl Fn(&mut Workspace, &mut Context<Workspace>) + 'static, cx: &mut Context<Workspace>) -> AnyElement {
    deferred(
        div()
            .id(id)
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .bg(scrim())
            .on_mouse_down(MouseButton::Left, cx.listener(move |w, _, _, cx| close(w, cx)))
            .child(dialog),
    )
    .with_priority(3)
    .into_any_element()
}

/// 16px radio: the accent with a dot when checked, else a disc with the rim.
#[allow(dead_code)]
pub(crate) fn radio(on: bool) -> Div {
    div()
        .size(px(16.))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .when(on, |d| d.bg(Theme::primary()).child(div().size(px(6.)).rounded_full().bg(crate::theme::raised(Theme::bg_body()))))
        .when(!on, |d| d.border_1().border_color(Theme::todo_box()).bg(crate::theme::raised(Theme::bg_body())))
}

impl Workspace {
    fn close_menus(&mut self) {
        self.row_menu = None;
    }

    /// 上传 / 导入: pick PDF files, each becoming a record.
    pub fn open_import(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if crate::layout_preview() {
            self.show_toast("Import is available in the product workspace, not the isolated layout preview.", cx);
            return;
        }
        self.close_menus();
        cx.notify();
        let paths = open_paths(cx);
        cx.spawn_in(window, async move |this, cx| {
            let Some(paths) = paths.await else { return };
            let _ = this.update_in(cx, |w, window, cx| w.import_pdf_paths(&paths, window, cx));
        })
        .detach();
    }

    pub fn import_pdf_paths(&mut self, paths: &[PathBuf], window: &mut Window, cx: &mut Context<Self>) {
        if crate::layout_preview() || paths.is_empty() { return; }
        if self.pdf_importing { self.show_toast_kind(ToastKind::Info, "PDF import is already running.", cx); return; }
        self.pdf_importing = true;
        self.show_toast_kind(ToastKind::Info, "Importing PDF and rendering its preview…", cx);
        let paths = paths.to_vec();
        let task = cx.background_executor().spawn(async move {
            paths.into_iter().map(|path| {
                let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
                crate::product_library::import_pdf(&path).map_err(|error| format!("{name}: {error:#}"))
            }).collect::<Vec<_>>()
        });
        cx.spawn_in(window, async move |this, cx| {
            let results = task.await;
            let _ = this.update_in(cx, |w, window, cx| {
                w.pdf_importing = false;
                w.entries = w.store.list();
                w.sort();
                let mut last = None;
                let mut errors = Vec::new();
                for result in results { match result { Ok(id) => last = Some(id), Err(error) => errors.push(error) } }
                if let Some(id) = last {
                    w.search_open = false;
                    w.home.sort_menu = false;
                    w.open(&id, window, cx);
                }
                if errors.is_empty() { w.show_toast("PDF imported. Original file retained in your local library.", cx); }
                else { w.show_toast_kind(ToastKind::Error, &errors.join("\n"), cx); }
                cx.notify();
            });
        }).detach();
    }

    /// Write a copy of the retained original wherever the user asks.
    pub fn save_original_pdf(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.close_menus();
        let source = match self.store.pdf_path(id) {
            Ok(path) => path,
            Err(error) => { self.show_toast_kind(ToastKind::Error, &format!("Cannot find the retained original: {error}"), cx); return; }
        };
        let title = self.entries.iter().find(|e| e.id == id).map(|e| e.title.replace(['/', ':', '\\'], "_")).unwrap_or_else(|| "Document".into());
        let path = save_path(&format!("{title}.pdf"), cx);
        cx.spawn_in(window, async move |this, cx| {
            let Some(path) = path.await else { return };
            let task = cx.background_executor().spawn(async move {
                anyhow::ensure!(path.canonicalize().ok().as_ref() != Some(&source), "Choose a different destination; this is the retained original");
                std::fs::copy(&source, &path)?;
                Ok::<_, anyhow::Error>(())
            });
            let result = task.await;
            let _ = this.update(cx, |w, cx| match result {
                Ok(()) => w.show_toast("Original PDF saved without modification.", cx),
                Err(error) => w.show_toast_kind(ToastKind::Error, &format!("Could not save original PDF: {error}"), cx),
            });
        }).detach();
        cx.notify();
    }
}
