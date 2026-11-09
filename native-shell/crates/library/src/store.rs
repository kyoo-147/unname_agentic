//! The library on disk: records, retained PDFs, thumbnails and the trash.
//!
//! A record is one PDF: its title, the retained original under `sources/`, the
//! rendered first page under `assets/`, and its metadata in `index.json`.

use anyhow::{Context, Result};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::time;

/// Deleted records are purged after this many days.
pub const TRASH_DAYS: u64 = 30;
/// Largest file the export path will read into memory.
pub const EXPORT_FILE_LIMIT: u64 = 32 * 1024 * 1024;
/// Library layout version.
const FORMAT: u64 = 2;

/// One document's metadata.
#[derive(Clone, Debug, Default)]
pub struct Meta {
    pub created: u64,
    pub modified: u64,
    pub opened: u64,
    pub pinned: bool,
    /// Unix seconds when starred; 0 means not starred.
    pub starred: u64,
    pub parent: Option<String>,
    pub sibling_key: String,
    /// The retained original, relative to the library root (`sources/<id>.pdf`).
    pub source_pdf: Option<String>,
    pub pdf_pages: Option<usize>,
    pub pdf_page: u16,
    /// Identity of the imported file, so a repeated import reuses the record.
    pub pdf_import_key: Option<String>,
    pub reading: bool,
}

/// A document as the library lists it.
#[derive(Clone, Debug, Default)]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
    /// Plain text of the document; a PDF record has none.
    pub body: String,
    pub meta: Meta,
}

/// Library-wide settings, kept beside the index.
#[derive(Clone, Debug, Default)]
pub struct Settings {
    pub sidebar_width: Option<f32>,
    pub window_size: Option<[f32; 2]>,
    pub home_list: bool,
    pub home_sort: Option<String>,
}

/// A deleted record waiting in the trash.
#[derive(Clone, Debug, Default)]
pub struct TrashEntry {
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
    pub parent: Option<String>,
    pub source_pdf: Option<String>,
    pub pdf_pages: Option<usize>,
    pub deleted: u64,
}

/// The open library.
pub struct Store {
    root: PathBuf,
    meta: BTreeMap<String, Meta>,
    settings: Settings,
    /// Problems a caller should surface; drained with `take_warnings`.
    pub warnings: Vec<String>,
}

impl Store {
    /// The library root: `PDF_WORKSPACE_HOME`, else the app data directory.
    pub fn root_dir() -> PathBuf {
        if let Some(home) = std::env::var_os("PDF_WORKSPACE_HOME") {
            return PathBuf::from(home).join("documents");
        }
        let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
            .or_else(|| dirs_home().map(|h| h.join("AppData").join("Local")))
            .unwrap_or_else(std::env::temp_dir);
        base.join("PdfWorkspace").join("documents")
    }

    pub fn open() -> Result<Self> { Self::open_at(Self::root_dir()) }

    /// Open a library at an explicit root (tests, the layout preview).
    pub fn open_at(root: PathBuf) -> Result<Self> {
        for dir in ["", "docs", "assets", "sources", "trash"] {
            fs::create_dir_all(root.join(dir)).with_context(|| format!("create {}", root.join(dir).display()))?;
        }
        let mut store = Store { root, meta: BTreeMap::new(), settings: Settings::default(), warnings: Vec::new() };
        store.load_index();
        store.load_settings();
        Ok(store)
    }

    fn path(&self, rel: &str) -> PathBuf { self.root.join(rel) }
    fn index_path(&self) -> PathBuf { self.path("index.json") }
    fn settings_path(&self) -> PathBuf { self.path("settings.json") }
    fn doc_path(&self, id: &str) -> PathBuf { self.path(&format!("docs/{id}.json")) }
    fn legacy_doc_path(&self, id: &str) -> PathBuf { self.path(&format!("docs/{id}.xml")) }
    fn thumb_rel(id: &str) -> String { format!("assets/{id}-pdf.png") }

    fn load_index(&mut self) {
        let format = self.path("format.json");
        if !format.exists() {
            let _ = write_json(&format, &json!({ "format": FORMAT }));
        }
        let Ok(text) = fs::read_to_string(self.index_path()) else { return };
        let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&text) else {
            self.warnings.push("index.json is unreadable; the library looks empty".into());
            return;
        };
        for (id, value) in map {
            self.meta.insert(id, meta_from(&value));
        }
    }

    fn load_settings(&mut self) {
        let Ok(text) = fs::read_to_string(self.settings_path()) else { return };
        let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&text) else { return };
        self.settings = Settings {
            sidebar_width: map.get("sidebar_width").and_then(Value::as_f64).map(|v| v as f32),
            window_size: map.get("window_size").and_then(|v| v.as_array()).and_then(|a| {
                Some([a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32])
            }),
            home_list: map.get("home_list").and_then(Value::as_bool).unwrap_or(false),
            home_sort: map.get("home_sort").and_then(Value::as_str).map(str::to_string),
        };
    }

    fn save_index(&self) -> Result<()> {
        let mut map = Map::new();
        for (id, meta) in &self.meta {
            map.insert(id.clone(), meta_to(meta));
        }
        write_json(&self.index_path(), &Value::Object(map))
    }

    fn save_settings_file(&self) -> Result<()> {
        let settings = &self.settings;
        let mut map = Map::new();
        if let Some(w) = settings.sidebar_width { map.insert("sidebar_width".into(), json!(w)); }
        if let Some([w, h]) = settings.window_size { map.insert("window_size".into(), json!([w, h])); }
        map.insert("home_list".into(), json!(settings.home_list));
        if let Some(sort) = &settings.home_sort { map.insert("home_sort".into(), json!(sort)); }
        write_json(&self.settings_path(), &Value::Object(map))
    }

    /// The record's title: our JSON record first, then a legacy `.xml` title.
    fn read_title(&mut self, id: &str) -> (String, Option<String>) {
        if let Ok(text) = fs::read_to_string(self.doc_path(id))
            && let Ok(value) = serde_json::from_str::<Value>(&text) {
                let title = value.get("title").and_then(Value::as_str).unwrap_or_default().to_string();
                let icon = value.get("icon").and_then(Value::as_str).map(str::to_string);
                return (title, icon);
            }
        // Libraries written before this store kept the title in a small XML note.
        if let Ok(text) = fs::read_to_string(self.legacy_doc_path(id))
            && let Some(start) = text.find("<title>")
            && let Some(end) = text[start..].find("</title>") {
                let raw = &text[start + "<title>".len()..start + end];
                let title = unescape(raw).trim().to_string();
                if !title.is_empty() {
                    // Move to the current record format on first read.
                    let _ = self.write_doc(id, &title, None);
                    let _ = fs::remove_file(self.legacy_doc_path(id));
                }
                return (title, None);
            }
        (String::new(), None)
    }

    fn write_doc(&self, id: &str, title: &str, icon: Option<&str>) -> Result<()> {
        write_json(&self.doc_path(id), &json!({ "title": title, "icon": icon }))
    }

    /// Every record, in the order the Home view sorts them.
    pub fn list(&mut self) -> Vec<Entry> {
        let ids: Vec<String> = self.meta.keys().cloned().collect();
        let mut entries = Vec::with_capacity(ids.len());
        for id in ids {
            let meta = self.meta.get(&id).cloned().unwrap_or_default();
            let (title, icon) = self.read_title(&id);
            entries.push(Entry { id, title, icon, body: String::new(), meta });
        }
        entries
    }

    pub fn list_trash(&mut self) -> Vec<TrashEntry> {
        let dir = self.path("trash");
        let Ok(read) = fs::read_dir(&dir) else { return Vec::new() };
        let mut out = Vec::new();
        for entry in read.flatten() {
            let path = entry.path();
            let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else { continue };
            let text = fs::read_to_string(path.join("record.json")).unwrap_or_default();
            let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
            let meta = meta_from(value.get("meta").unwrap_or(&Value::Null));
            out.push(TrashEntry {
                id,
                title: value.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
                icon: None,
                parent: meta.parent.clone(),
                source_pdf: meta.source_pdf,
                pdf_pages: meta.pdf_pages,
                deleted: value.get("deleted").and_then(Value::as_u64).unwrap_or_default(),
            });
        }
        out.sort_by(|a, b| b.deleted.cmp(&a.deleted));
        out
    }

    pub fn settings(&self) -> Settings { self.settings.clone() }

    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        let mut this = Settings { ..settings.clone() };
        if this.window_size.is_none() { this.window_size = self.settings.window_size; }
        let store = Store { root: self.root.clone(), meta: self.meta.clone(), settings: this, warnings: Vec::new() };
        store.save_settings_file()
    }

    pub fn take_warnings(&mut self) -> Vec<String> { std::mem::take(&mut self.warnings) }

    pub fn rename(&mut self, id: &str, title: &str) -> Result<Meta> {
        let title = title.trim().to_string();
        self.write_doc(id, &title, None)?;
        self.touch_modified(id)
    }

    pub fn touch(&mut self, id: &str) -> Option<Meta> {
        let meta = self.meta.get_mut(id)?;
        meta.opened = time::now();
        let out = meta.clone();
        let _ = self.save_index();
        Some(out)
    }

    pub fn update_meta(&mut self, id: &str, f: impl FnOnce(&mut Meta)) -> Result<()> {
        let Some(meta) = self.meta.get_mut(id) else { anyhow::bail!("no such document: {id}") };
        f(meta);
        meta.modified = time::now();
        self.save_index()
    }

    fn touch_modified(&mut self, id: &str) -> Result<Meta> {
        let Some(meta) = self.meta.get_mut(id) else { anyhow::bail!("no such document: {id}") };
        meta.modified = time::now();
        let out = meta.clone();
        self.save_index()?;
        Ok(out)
    }

    pub fn set_pinned(&mut self, id: &str, pinned: bool) -> Result<()> { self.update_meta(id, |m| m.pinned = pinned) }

    pub fn set_starred(&mut self, id: &str, on: bool) -> Result<u64> {
        let now = if on { time::now() } else { 0 };
        self.update_meta(id, |m| m.starred = now)?;
        Ok(now)
    }

    pub fn set_parent(&mut self, id: &str, parent: Option<&str>) -> Result<Meta> {
        self.update_meta(id, |m| m.parent = parent.map(str::to_string))?;
        self.meta.get(id).cloned().ok_or_else(|| anyhow::anyhow!("no such document: {id}"))
    }

    /// The retained original's path.
    pub fn pdf_path(&self, id: &str) -> Result<PathBuf> {
        let meta = self.meta.get(id).ok_or_else(|| anyhow::anyhow!("no such document: {id}"))?;
        let rel = meta.source_pdf.clone().ok_or_else(|| anyhow::anyhow!("this record has no retained PDF"))?;
        let path = self.path(&rel);
        if !path.is_file() { anyhow::bail!("the retained PDF is missing: {}", path.display()) }
        Ok(path)
    }

    /// Move a record to the trash. Its files travel with it.
    pub fn delete(&mut self, id: &str, _root: Option<&str>) -> Result<()> {
        let Some(meta) = self.meta.remove(id) else { anyhow::bail!("no such document: {id}") };
        let (title, _) = self.read_title(id);
        let dir = self.path(&format!("trash/{id}"));
        fs::create_dir_all(&dir)?;
        write_json(&dir.join("record.json"), &json!({ "title": title, "deleted": time::now(), "meta": meta_to(&meta) }))?;
        let pairs = [
            (self.doc_path(id), dir.join("doc.json")),
            (self.path(&Self::thumb_rel(id)), dir.join("thumb.png")),
        ];
        for (from, to) in pairs {
            if from.is_file() { let _ = fs::rename(&from, &to); }
        }
        if let Some(rel) = &meta.source_pdf {
            let from = self.path(rel);
            if from.is_file() { let _ = fs::rename(&from, dir.join("source.pdf")); }
        }
        let _ = fs::remove_file(self.legacy_doc_path(id));
        self.save_index()
    }

    /// Bring a trashed record back.
    pub fn restore(&mut self, id: &str) -> Result<bool> {
        let dir = self.path(&format!("trash/{id}"));
        if !dir.is_dir() { return Ok(false) }
        let text = fs::read_to_string(dir.join("record.json"))?;
        let value: Value = serde_json::from_str(&text)?;
        let mut meta = meta_from(value.get("meta").unwrap_or(&Value::Null));
        let title = value.get("title").and_then(Value::as_str).unwrap_or_default().to_string();
        if let Some(rel) = &meta.source_pdf
            && dir.join("source.pdf").is_file() {
                fs::create_dir_all(self.path("sources"))?;
                fs::rename(dir.join("source.pdf"), self.path(rel))?;
            }
        if dir.join("thumb.png").is_file() {
            fs::create_dir_all(self.path("assets"))?;
            fs::rename(dir.join("thumb.png"), self.path(&Self::thumb_rel(id)))?;
        }
        self.write_doc(id, &title, None)?;
        meta.modified = time::now();
        self.meta.insert(id.to_string(), meta);
        self.save_index()?;
        let _ = fs::remove_dir_all(&dir);
        Ok(true)
    }

    /// Delete a trashed record for good.
    pub fn purge(&mut self, id: &str) -> Result<()> {
        let dir = self.path(&format!("trash/{id}"));
        if dir.is_dir() { fs::remove_dir_all(&dir)?; }
        Ok(())
    }

    /// Import a PDF once: `key` identifies the file, so a repeated import of the
    /// same bytes reuses the record instead of storing a second copy.
    pub fn create_pdf_once(&mut self, title: &str, original: &[u8], png: &[u8], pages: usize, thumb: (u32, u32), key: &str) -> Result<String> {
        if let Some((id, _)) = self.meta.iter().find(|(_, m)| m.pdf_import_key.as_deref() == Some(key)) {
            return Ok(id.clone());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let source_rel = format!("sources/{id}.pdf");
        fs::write(self.path(&source_rel), original).with_context(|| "write the retained PDF")?;
        fs::write(self.path(&Self::thumb_rel(&id)), png).with_context(|| "write the first page")?;
        let now = time::now();
        let meta = Meta {
            created: now,
            modified: now,
            opened: now,
            pinned: false,
            starred: 0,
            parent: None,
            sibling_key: String::new(),
            source_pdf: Some(source_rel),
            pdf_pages: Some(pages),
            pdf_page: 0,
            pdf_import_key: Some(key.to_string()),
            reading: false,
        };
        let _ = thumb;
        self.write_doc(&id, title, None)?;
        self.meta.insert(id.clone(), meta);
        self.save_index()?;
        Ok(id)
    }

    /// Where `assets/<name>` lives, if it exists.
    pub fn asset_path(&self, rel: &str) -> Option<PathBuf> {
        let path = self.path(rel);
        path.is_file().then_some(path)
    }
}

/// `assets/<name>` under the library, when it exists. The Home grid and the
/// reader ask for pictures by their library-relative name.
pub fn image_path(rel: &str) -> Option<PathBuf> {
    let path = Store::root_dir().join(rel);
    path.is_file().then_some(path)
}

/// `dirs`-free home directory lookup.
fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

fn meta_from(value: &Value) -> Meta {
    let get = |key: &str| value.get(key);
    Meta {
        created: get("created").and_then(Value::as_u64).unwrap_or_default(),
        modified: get("modified").and_then(Value::as_u64).unwrap_or_default(),
        opened: get("opened").and_then(Value::as_u64).unwrap_or_default(),
        pinned: get("pinned").and_then(Value::as_bool).unwrap_or(false),
        starred: get("starred").and_then(Value::as_u64).unwrap_or_default(),
        parent: get("parent").and_then(Value::as_str).map(str::to_string),
        sibling_key: get("sibling_key").and_then(Value::as_str).unwrap_or_default().to_string(),
        source_pdf: get("source_pdf").and_then(Value::as_str).map(str::to_string),
        pdf_pages: get("pdf_pages").and_then(Value::as_u64).map(|v| v as usize),
        pdf_page: get("pdf_page").and_then(Value::as_u64).unwrap_or_default() as u16,
        pdf_import_key: get("pdf_import_key").and_then(Value::as_str).map(str::to_string),
        reading: get("reading").and_then(Value::as_bool).unwrap_or(false),
    }
}

fn meta_to(meta: &Meta) -> Value {
    json!({
        "created": meta.created,
        "modified": meta.modified,
        "opened": meta.opened,
        "pinned": meta.pinned,
        "starred": meta.starred,
        "parent": meta.parent,
        "sibling_key": meta.sibling_key,
        "source_pdf": meta.source_pdf,
        "pdf_pages": meta.pdf_pages,
        "pdf_page": meta.pdf_page,
        "pdf_import_key": meta.pdf_import_key,
        "reading": meta.reading,
    })
}

/// Write JSON without leaving a half-written file behind.
fn write_json(path: &Path, value: &Value) -> Result<()> {
    if let Some(dir) = path.parent() { fs::create_dir_all(dir)?; }
    let tmp = path.with_extension("tmp");
    let mut file = fs::File::create(&tmp)?;
    file.write_all(serde_json::to_string_pretty(value)?.as_bytes())?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)?;
    Ok(())
}

/// The five XML entities a legacy title may contain.
fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

/// Read at most `limit` bytes.
pub fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let meta = fs::metadata(path)?;
    if meta.len() > limit { anyhow::bail!("file is larger than the limit") }
    Ok(fs::read(path)?)
}

/// Resolve a library-relative path, refusing anything that escapes the library.
pub fn export_path(root: &Path, rel: &str) -> Option<PathBuf> {
    let candidate = root.join(rel);
    let canonical = candidate.canonicalize().ok()?;
    canonical.starts_with(root.canonicalize().ok()?).then_some(canonical)
}
