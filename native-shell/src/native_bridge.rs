use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::Duration};
use gpui::*;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Binding { pub session_id: String, pub source_id: String, pub request_nonce: String, pub generation: u64 }
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Page { pub page: u16, pub page_count: Option<u32>, pub fraction: f32, pub zoom: f32 }
#[derive(Clone, Debug, Deserialize)]
struct Event {
    version: u32, kind: String, binding: Binding, sequence: u64,
    #[serde(default)] page: Option<Page>,
    #[serde(default)] sha256: Option<String>,
    #[serde(default)] pdf_file: Option<String>,
    #[serde(default)] total_bytes: Option<u64>,
    #[serde(default)] title: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Acknowledgment { document_id: String }
pub struct Update { directory: String, document_id: String, event: Event }
#[derive(Default)]
pub struct CompanionState { seen: HashMap<String, u64>, active: Option<(String, Binding)>, generations: HashMap<String, u64>, selected_generation: u64, command_sequence: u64, command_lock: Arc<Mutex<()>> }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DesktopCommand { version: u32, kind: String, binding: Binding, sequence: u64, page: Page }
fn write_command_at(root: &Path, name: &str, command: &DesktopCommand) -> Result<()> {
    anyhow::ensure!(name.starts_with("ready-") && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'), "Invalid browser transfer directory");
    let root = root.canonicalize()?; let path = root.join(name).canonicalize()?;
    anyhow::ensure!(path.parent() == Some(root.as_path()) && path.is_dir(), "Browser command escapes its transfer");
    let ready = read_event(&path.join("event.json"))?;
    anyhow::ensure!(ready.kind == "document_ready" && ready.binding == command.binding, "Browser command source changed");
    if path.join("latest.json").exists() { let latest = read_event(&path.join("latest.json"))?; anyhow::ensure!(latest.binding == command.binding && latest.kind != "session_ended", "Browser synchronization ended"); }
    let target = path.join("desktop-command.json");
    if target.exists() {
        anyhow::ensure!(!std::fs::symlink_metadata(&target)?.file_type().is_symlink(), "Invalid browser command file");
        let previous: DesktopCommand = serde_json::from_slice(&crate::store::read_bounded(&target, 4096)?)?;
        anyhow::ensure!(previous.binding == command.binding, "Browser command binding changed");
        if previous.sequence >= command.sequence { return Ok(()); }
    }
    let temporary = path.join(format!(".desktop-command-{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, serde_json::to_vec(command)?)?;
    if let Err(error) = std::fs::rename(&temporary, target) { let _ = std::fs::remove_file(temporary); return Err(error.into()); }
    Ok(())
}

fn directory() -> PathBuf {
    std::env::var_os("PDF_WORKSPACE_INBOX").map(PathBuf::from).unwrap_or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("PdfWorkspace").join("inbox"))
}
fn read_event(path: &Path) -> Result<Event> {
    let bytes = crate::store::read_bounded(path, 1024 * 1024)?;
    let event: Event = serde_json::from_slice(&bytes)?;
    anyhow::ensure!(event.version == 1 && matches!(event.kind.as_str(), "document_ready" | "page_changed" | "session_ended"), "Unsupported browser companion event");
    anyhow::ensure!([&event.binding.session_id, &event.binding.source_id, &event.binding.request_nonce].iter().all(|value| !value.is_empty() && value.len() <= 200), "Invalid browser session binding");
    if let Some(page) = &event.page {
        anyhow::ensure!(page.fraction.is_finite() && (0.0..=1.0).contains(&page.fraction) && page.zoom.is_finite() && page.zoom > 0. && page.zoom <= 10., "Invalid browser page geometry");
        anyhow::ensure!(page.page_count.is_none_or(|count| count > u32::from(page.page) && count <= 65535), "Invalid browser page count");
    }
    Ok(event)
}
fn acknowledge(path: &Path, document_id: &str) -> Result<()> {
    let temporary = path.join(format!(".{}-ack.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, serde_json::to_vec(&Acknowledgment { document_id: document_id.into() })?)?;
    std::fs::rename(temporary, path.join("acknowledged.json"))?;
    Ok(())
}

fn scan_inbox() -> Result<Vec<Update>> { scan_inbox_at(&directory()) }

fn scan_inbox_at(root: &Path) -> Result<Vec<Update>> {
    if !root.is_dir() { return Ok(Vec::new()); }
    let root = root.canonicalize()?;
    let mut updates = Vec::new();
    let mut candidates: Vec<_> = std::fs::read_dir(&root)?.filter_map(|entry| entry.ok()).filter(|entry| entry.file_name().to_string_lossy().starts_with("ready-") && !entry.path().join("consumer-error.txt").exists()).collect();
    candidates.sort_by(|a, b| {
        let acknowledged = |entry: &std::fs::DirEntry| entry.path().join("acknowledged.json").is_file();
        let modified = |entry: &std::fs::DirEntry| entry.metadata().and_then(|meta| meta.modified()).ok();
        acknowledged(a).cmp(&acknowledged(b)).then_with(|| if acknowledged(a) { modified(b).cmp(&modified(a)) } else { modified(a).cmp(&modified(b)) })
    });
    for entry in candidates.into_iter().take(64) {
        let result = (|| -> Result<Option<Update>> {
        let path = entry.path().canonicalize()?;
        anyhow::ensure!(path.parent() == Some(root.as_path()) && path.is_dir(), "Browser inbox entry escapes its directory");
        let ready = read_event(&path.join("event.json"))?;
        anyhow::ensure!(ready.kind == "document_ready" && ready.sequence == 0 && ready.pdf_file.as_deref() == Some("document.pdf"), "Incomplete browser PDF transfer");
        let acknowledgment = path.join("acknowledged.json");
        let document_id = if acknowledgment.is_file() {
            let ack: Acknowledgment = serde_json::from_slice(&crate::store::read_bounded(&acknowledgment, 4096)?)?;
            anyhow::ensure!(uuid::Uuid::parse_str(&ack.document_id).is_ok(), "Invalid browser library acknowledgment");
            ack.document_id
        } else {
            let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(path.join(".consumer.lock"))?;
            if lock.try_lock().is_err() { return Ok(None); }
            if acknowledgment.is_file() { return Ok(None); }
            let pdf = path.join("document.pdf").canonicalize()?;
            anyhow::ensure!(pdf.parent() == Some(path.as_path()) && pdf.is_file(), "Browser PDF escapes its published transfer");
            let hash = ready.sha256.as_deref().context("Browser PDF has no checksum")?;
            anyhow::ensure!(hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) && ready.total_bytes.is_some_and(|size| size > 0 && size <= crate::store::EXPORT_FILE_LIMIT), "Invalid browser PDF size or checksum");
            let key = mirror_pdf_desktop::model::digest(format!("{}|{}|{}|{}|{hash}", ready.binding.session_id, ready.binding.source_id, ready.binding.request_nonce, ready.binding.generation).as_bytes());
            let id = crate::product_library::import_browser_pdf(&pdf, hash, ready.title.as_deref(), &key)?;
            acknowledge(&path, &id)?;
            // The retained, verified library copy now owns the bytes; the inbox copy is no longer needed.
            std::fs::remove_file(&pdf)?;
            id
        };
        let latest = if path.join("latest.json").is_file() { read_event(&path.join("latest.json"))? } else { ready.clone() };
        anyhow::ensure!(latest.binding == ready.binding && latest.sequence >= ready.sequence, "Browser page event is not bound to this PDF");
        Ok(Some(Update { directory: entry.file_name().to_string_lossy().into_owned(), document_id, event: latest }))
        })();
        match result {
            Ok(Some(update)) => updates.push(update),
            Ok(None) => {},
            Err(error) => {
                let path = entry.path();
                if path.parent() == Some(root.as_path()) && path.is_dir() {
                    let message = format!("{error:#}"); let marker = path.join("consumer-error.txt");
                    if std::fs::read_to_string(&marker).ok().as_deref() != Some(&message) { crate::logging::write(&format!("Browser transfer rejected: {message}")); let _ = std::fs::write(marker, message); }
                }
            }
        }
    }
    Ok(updates)
}

impl CompanionState {
    fn can_select(&self, binding: &Binding) -> bool { binding.generation > self.selected_generation }
    fn accept(&mut self, update: &Update) -> bool {
        if self.seen.get(&update.directory).is_some_and(|sequence| *sequence >= update.event.sequence) { return false; }
        self.seen.insert(update.directory.clone(), update.event.sequence);
        let previous = self.generations.get(&update.event.binding.source_id).copied().unwrap_or(0);
        if update.event.binding.generation < previous { return false; }
        self.generations.insert(update.event.binding.source_id.clone(), update.event.binding.generation);
        true
    }
}

impl crate::app::Workspace {
    pub(crate) fn send_companion_location(&mut self, document: &str, page: u16, fraction: f32, zoom: f32, cx: &mut gpui::Context<Self>) {
        if self.view != crate::app::View::Doc || self.current.as_deref() != Some(document) || !fraction.is_finite() || !zoom.is_finite() { return; }
        let Some((name, binding)) = self.companion.active.clone() else { return; };
        let Some(sequence) = self.companion.command_sequence.checked_add(1).filter(|seq| *seq <= 9_007_199_254_740_991) else { return; };
        self.companion.command_sequence = sequence;
        let command = DesktopCommand { version: 1, kind: "view_state".into(), binding, sequence, page: Page { page, page_count: None, fraction: fraction.clamp(0., 1.), zoom: zoom.clamp(0.1, 10.) } };
        let lock = self.companion.command_lock.clone();
        cx.background_executor().spawn(async move {
            let result = (|| -> Result<()> { let _guard = lock.lock().map_err(|_| anyhow::anyhow!("Browser command writer unavailable"))?; write_command_at(&directory(), &name, &command) })();
            if let Err(error) = result { crate::logging::write(&format!("Browser command rejected: {error:#}")); }
        }).detach();
    }
    pub(crate) fn start_companion(&mut self, window: &mut Window, cx: &mut gpui::Context<Self>) {
        if crate::layout_preview() { return; }
        self.companion_task = Some(cx.spawn_in(window, async |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(900)).await;
            let task = cx.background_executor().spawn(async { scan_inbox().map_err(|error| format!("{error:#}")) });
            let result = task.await;
            if this.update_in(cx, |workspace, window, cx| {
                match result {
                    Ok(updates) => for update in updates { workspace.receive_companion(update, window, cx); },
                    Err(error) => { if workspace.companion_error.as_deref() != Some(&error) { crate::logging::write(&format!("Browser companion inbox: {error}")); workspace.companion_error = Some(error); } }
                }
            }).is_err() { break; }
        }));
    }
    fn receive_companion(&mut self, update: Update, window: &mut Window, cx: &mut gpui::Context<Self>) {
        if !self.companion.accept(&update) { return; }
        if update.event.kind == "session_ended" {
            if !self.entries.iter().any(|entry| entry.id == update.document_id) {
                self.entries = self.store.list(); self.sort(); self.load_home();
                cx.notify();
            }
            if self.companion.active.as_ref().is_some_and(|(directory, _)| directory == &update.directory) {
                self.companion.active = None;
                if let Some(reader) = &self.pdf_reader { reader.update(cx, |reader, cx| reader.set_browser_linked(false, cx)); }
                self.show_toast("Browser synchronization stopped · the retained PDF remains available", cx);
            }
            return;
        }
        let new_session = self.companion.active.as_ref().is_none_or(|(directory, binding)| directory != &update.directory || binding != &update.event.binding);
        if new_session {
            self.entries = self.store.list(); self.sort(); self.load_home();
            if !self.companion.can_select(&update.event.binding) { cx.notify(); return; }
            if !self.entries.iter().any(|entry| entry.id == update.document_id) { return; }
            if !self.try_open(&update.document_id, window, cx) { self.companion.seen.remove(&update.directory); return; }
            self.companion.selected_generation = update.event.binding.generation;
            self.companion.active = Some((update.directory, update.event.binding));
            if let Some(reader) = &self.pdf_reader { reader.update(cx, |reader, cx| reader.set_browser_linked(true, cx)); }
            self.show_toast("PDF received from Chrome · browser navigation is linked", cx);
        }
        if self.current.as_deref() == Some(update.document_id.as_str()) && self.view == crate::app::View::Doc && let Some(reader) = &self.pdf_reader {
            reader.update(cx, |reader, cx| {
                if let Some(page) = update.event.page { reader.follow_external_location(page.page, page.fraction, cx); }
            });
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::{Binding, CompanionState, Event, Update};
    fn update(directory: &str, generation: u64, sequence: u64) -> Update {
        Update { directory: directory.into(), document_id: uuid::Uuid::nil().to_string(), event: Event { version: 1, kind: "page_changed".into(), binding: Binding { session_id: "session".into(), source_id: "source".into(), request_nonce: "nonce".into(), generation }, sequence, page: None, sha256: None, pdf_file: None, total_bytes: None, title: None } }
    }
    #[test] fn desktop_commands_are_bound_atomic_and_monotonic() {
        let root = std::env::temp_dir().join(format!("browser-command-{}", uuid::Uuid::new_v4()));
        let path = root.join("ready-test"); std::fs::create_dir_all(&path).unwrap();
        let binding = update("ready-test", 5, 0).event.binding;
        let ready = serde_json::json!({ "version":1,"kind":"document_ready","sequence":0,"binding":binding,"pdf_file":"document.pdf" });
        std::fs::write(path.join("event.json"), serde_json::to_vec(&ready).unwrap()).unwrap();
        let command = |sequence| super::DesktopCommand { version: 1, kind: "view_state".into(), binding: binding.clone(), sequence, page: super::Page { page: 2, page_count: None, fraction: 0.25, zoom: 1.5 } };
        super::write_command_at(&root, "ready-test", &command(2)).unwrap();
        super::write_command_at(&root, "ready-test", &command(1)).unwrap();
        let stored: super::DesktopCommand = serde_json::from_slice(&std::fs::read(path.join("desktop-command.json")).unwrap()).unwrap();
        assert_eq!(stored.sequence, 2); assert_eq!(stored.binding, binding);
        let mut changed = command(3); changed.binding.request_nonce = "different-nonce".into();
        assert!(super::write_command_at(&root, "ready-test", &changed).is_err());
        assert!(super::write_command_at(&root, "ready-test/../ready-test", &command(3)).is_err());
        let ended = serde_json::json!({ "version":1,"kind":"session_ended","sequence":1,"binding":binding });
        std::fs::write(path.join("latest.json"), serde_json::to_vec(&ended).unwrap()).unwrap();
        assert!(super::write_command_at(&root, "ready-test", &command(3)).is_err());
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 3);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn old_source_page_cannot_replace_newer_explicit_session() {
        let mut state = CompanionState::default();
        let a = update("ready-a", 1, 0); let mut b = update("ready-b", 2, 0); b.event.binding.source_id = "other-source".into();
        assert!(state.can_select(&a.event.binding)); state.selected_generation = 1;
        assert!(state.can_select(&b.event.binding)); state.selected_generation = 2;
        assert!(!state.can_select(&a.event.binding));
    }
    #[test] fn malformed_transfer_does_not_poison_valid_inbox_updates() {
        let root = std::env::temp_dir().join(format!("browser-inbox-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("ready-bad")).unwrap();
        std::fs::write(root.join("ready-bad/event.json"), b"not JSON").unwrap();
        let path = root.join("ready-good"); std::fs::create_dir_all(&path).unwrap();
        let event = serde_json::json!({ "version":1,"kind":"document_ready","sequence":0,"binding":{"session_id":"s","source_id":"source","request_nonce":"n","generation":1},"pdf_file":"document.pdf","page":{"page":0,"page_count":4,"fraction":0.,"zoom":1.} });
        std::fs::write(path.join("event.json"), serde_json::to_vec(&event).unwrap()).unwrap();
        std::fs::write(path.join("acknowledged.json"), serde_json::to_vec(&super::Acknowledgment { document_id:uuid::Uuid::new_v4().to_string() }).unwrap()).unwrap();
        let updates = super::scan_inbox_at(&root).unwrap();
        assert_eq!(updates.len(), 1); assert_eq!(updates[0].directory, "ready-good");
        assert!(root.join("ready-bad/consumer-error.txt").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn old_pages_and_old_source_generations_do_not_reopen_documents() {
        let mut state = CompanionState::default();
        assert!(state.accept(&update("ready-new", 5, 2)));
        assert!(!state.accept(&update("ready-new", 5, 1)));
        assert!(!state.accept(&update("ready-old", 4, 10)));
        assert!(state.accept(&update("ready-new", 5, 3)));
    }
}
