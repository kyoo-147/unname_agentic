//! The Chrome companion bridge.
//!
//! The companion host publishes plain JSON message files into a local inbox and
//! the desktop answers with one atomically replaced command file. One typed
//! decoder serves both directions, so a duplicate delivery, a corrupt payload, a
//! write that never completes, and a malformed message each fail with their own
//! error instead of an opaque string, and none of them parse a body first.
//!
//! Limits are the ones the host documents: 1 MiB per message and 4 KiB for the
//! small command and acknowledgment objects. Duplicate memory keeps at most
//! [`SEEN_SESSIONS`] sessions and pending command writes at most
//! [`PENDING_WRITES`]; both caps and their eviction rules are documented on
//! [`Seen`] and [`Pending`].
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::Read, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::{Duration, Instant}};
use gpui::*;

/// The largest message the companion host documents (1 MiB). A message file that
/// announces or carries more is rejected before anything parses its body.
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
/// Commands and acknowledgments are one small JSON object each.
const MAX_CONTROL_BYTES: usize = 4096;
/// Sessions whose last delivered sequence is remembered for duplicate
/// suppression. One scan inspects at most 64 sessions, so 4096 is far beyond any
/// live set. See [`Seen`] for the eviction rule.
const SEEN_SESSIONS: usize = 4096;
/// Outbound command writes that may be in flight together. Writes are serialized
/// by `command_lock`, so a few entries cover a stalled writer plus a burst of
/// navigation events. See [`Pending`].
const PENDING_WRITES: usize = 64;
/// A command write that has not completed within this window is reported once as
/// a timeout and removed, so a stuck transport cannot leak a pending entry. The
/// extension gives each native request 30 seconds (`docs/native-bridge.md`); the
/// desktop uses the same window for its side of the channel.
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

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
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DesktopCommand { version: u32, kind: String, binding: Binding, sequence: u64, page: Page }

/// One typed bridge failure.
///
/// Every failure mode the companion can present has its own variant, so callers
/// tell a duplicate delivery, a corrupt transfer, a stuck write, and a malformed
/// message apart without matching message text.
#[derive(Clone, Debug, Eq, PartialEq)]
enum BridgeError {
    /// The message file has no bytes.
    EmptyMessage { kind: &'static str },
    /// A frame announced an empty body.
    EmptyFrame { kind: &'static str },
    /// A frame header was cut short: fewer than four length bytes arrived.
    TruncatedHeader { available: usize },
    /// A frame header announced a body larger than the documented cap.
    FrameTooLarge { announced: usize, limit: usize },
    /// A frame body was cut short of its announced length.
    TruncatedBody { announced: usize, available: usize },
    /// A frame carried bytes after its announced body.
    TrailingBytes { announced: usize, extra: usize },
    /// A bare message file is larger than the documented cap.
    TooLarge { kind: &'static str, size: u64, limit: usize },
    /// The message body is not UTF-8.
    NotUtf8 { kind: &'static str },
    /// The body is not the JSON object the protocol requires.
    Malformed { kind: &'static str, detail: String },
    /// The message file could not be read.
    Io { kind: &'static str, detail: String },
    /// A well-formed message violates the companion protocol.
    Invalid(&'static str),
    /// The payload does not hash to the digest the host published.
    Checksum { expected: String, actual: String },
    /// The payload file disagrees with the size the host published.
    Size { expected: u64, actual: u64 },
    /// An outbound write never completed.
    Timeout { what: &'static str, id: u64, waited: Duration },
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyMessage { kind } => write!(f, "Empty browser {kind} message"),
            Self::EmptyFrame { kind } => write!(f, "Empty browser {kind} frame"),
            Self::TruncatedHeader { available } => write!(f, "Truncated browser frame header ({available} of 4 bytes)"),
            Self::FrameTooLarge { announced, limit } => write!(f, "Browser frame announces {announced} bytes (limit {limit})"),
            Self::TruncatedBody { announced, available } => write!(f, "Truncated browser frame body ({available} of {announced} bytes)"),
            Self::TrailingBytes { announced, extra } => write!(f, "Browser frame carries {extra} bytes after its {announced}-byte body"),
            Self::TooLarge { kind, size, limit } => write!(f, "Browser {kind} file is {size} bytes (limit {limit})"),
            Self::NotUtf8 { kind } => write!(f, "Browser {kind} message is not UTF-8"),
            Self::Malformed { kind, detail } => write!(f, "Invalid browser {kind} message: {detail}"),
            Self::Io { kind, detail } => write!(f, "Cannot read browser {kind} message: {detail}"),
            Self::Invalid(message) => f.write_str(message),
            Self::Checksum { .. } => f.write_str("Browser PDF checksum does not match its completed transfer"),
            Self::Size { expected, actual } => write!(f, "Browser PDF size does not match its completed transfer (expected {expected}, got {actual})"),
            Self::Timeout { what, id, waited } => write!(f, "Browser {what} {id} timed out after {} ms", waited.as_millis()),
        }
    }
}
impl std::error::Error for BridgeError {}

/// Keeps a schema error short enough for `consumer-error.txt` and the log.
fn bounded_detail(detail: &str) -> String { detail.chars().take(160).collect() }

/// Whether the first byte can start a JSON text (object, array, whitespace, or
/// a byte-order mark). Used only to tell a cut-short header from cut-short JSON.
fn starts_json(bytes: &[u8]) -> bool { bytes.first().is_some_and(|byte| matches!(*byte, b'{' | b'[' | b' ' | b'\t' | b'\r' | b'\n' | 0xEF)) }

/// Decodes one bridge message from the bytes of a single inbox file.
///
/// A message is either the bare UTF-8 JSON object the host writes today or one
/// length-prefixed frame (an unsigned 32-bit little-endian body length followed
/// by exactly that many bytes). The fourth byte distinguishes them without a
/// guess: every frame body within [`MAX_MESSAGE_BYTES`] fits 24 bits, so a frame
/// header's most-significant length byte is zero, while a JSON text never
/// contains a raw NUL. Empty input, a short header, an oversized announcement, a
/// short body, trailing bytes, and non-UTF-8 bodies each return their own typed
/// error before any JSON is parsed.
fn decode_message<'a>(bytes: &'a [u8], kind: &'static str, limit: usize) -> Result<&'a [u8], BridgeError> {
    if bytes.is_empty() { return Err(BridgeError::EmptyMessage { kind }); }
    if bytes.len() < 4 {
        if !starts_json(bytes) { return Err(BridgeError::TruncatedHeader { available: bytes.len() }); }
        return decode_body(bytes, kind);
    }
    if bytes[3] == 0 {
        let announced = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        let available = bytes.len() - 4;
        if announced == 0 { return Err(BridgeError::EmptyFrame { kind }); }
        if announced > limit { return Err(BridgeError::FrameTooLarge { announced, limit }); }
        if available < announced { return Err(BridgeError::TruncatedBody { announced, available }); }
        if available > announced { return Err(BridgeError::TrailingBytes { announced, extra: available - announced }); }
        return decode_body(&bytes[4..], kind);
    }
    if bytes.len() > limit { return Err(BridgeError::TooLarge { kind, size: bytes.len() as u64, limit }); }
    decode_body(bytes, kind)
}

/// Rejects a body that is not UTF-8. [`serde_json`] would also reject it, but
/// only after trying to read it as JSON text; the bridge reports the encoding
/// failure as its own typed error first.
fn decode_body<'a>(bytes: &'a [u8], kind: &'static str) -> Result<&'a [u8], BridgeError> {
    if std::str::from_utf8(bytes).is_err() { return Err(BridgeError::NotUtf8 { kind }); }
    Ok(bytes)
}

/// Reads one message file, bounded by `limit` plus the four frame-header bytes.
///
/// The size gate runs on the metadata before any bytes are allocated, so an
/// oversized file cannot force a large allocation only to be rejected.
fn read_message_bytes(path: &Path, kind: &'static str, limit: usize) -> Result<Vec<u8>, BridgeError> {
    let metadata = std::fs::metadata(path).map_err(|error| BridgeError::Io { kind, detail: error.to_string() })?;
    if metadata.len() > (limit + 4) as u64 { return Err(BridgeError::TooLarge { kind, size: metadata.len(), limit }); }
    std::fs::read(path).map_err(|error| BridgeError::Io { kind, detail: error.to_string() })
}

/// Reads, decodes, and parses one message file. The decode runs before the parse.
fn read_json<T: serde::de::DeserializeOwned>(path: &Path, kind: &'static str, limit: usize) -> Result<T, BridgeError> {
    let bytes = read_message_bytes(path, kind, limit)?;
    let body = decode_message(&bytes, kind, limit)?;
    serde_json::from_slice(body).map_err(|error| BridgeError::Malformed { kind, detail: bounded_detail(&error.to_string()) })
}

fn read_event(path: &Path) -> Result<Event, BridgeError> {
    let event: Event = read_json(path, "event", MAX_MESSAGE_BYTES)?;
    if event.version != 1 || !matches!(event.kind.as_str(), "document_ready" | "page_changed" | "session_ended") { return Err(BridgeError::Invalid("Unsupported browser companion event")); }
    if ![&event.binding.session_id, &event.binding.source_id, &event.binding.request_nonce].iter().all(|value| !value.is_empty() && value.len() <= 200) { return Err(BridgeError::Invalid("Invalid browser session binding")); }
    if let Some(page) = &event.page {
        if !(page.fraction.is_finite() && (0.0..=1.0).contains(&page.fraction) && page.zoom.is_finite() && page.zoom > 0. && page.zoom <= 10.) { return Err(BridgeError::Invalid("Invalid browser page geometry")); }
        if page.page_count.is_some_and(|count| count <= u32::from(page.page) || count > 65535) { return Err(BridgeError::Invalid("Invalid browser page count")); }
    }
    Ok(event)
}

fn read_command(path: &Path) -> Result<DesktopCommand, BridgeError> { read_json(path, "command", MAX_CONTROL_BYTES) }

fn read_acknowledgment(path: &Path) -> Result<Acknowledgment, BridgeError> {
    let acknowledgment: Acknowledgment = read_json(path, "acknowledgment", MAX_CONTROL_BYTES)?;
    if uuid::Uuid::parse_str(&acknowledgment.document_id).is_err() { return Err(BridgeError::Invalid("Invalid browser library acknowledgment")); }
    Ok(acknowledgment)
}

/// One delivered browser payload whose digest has already matched.
///
/// [`Payload::read`] is the only constructor, and it checks the declared size and
/// the published sha256 before the bytes become available, so a handler reached
/// through [`Payload::dispatch`] cannot observe bytes the host did not sign. A
/// transfer whose body is valid JSON but whose digest is wrong is therefore
/// rejected before any consumer parses that body.
struct Payload { body: Vec<u8> }

impl Payload {
    /// Reads at most `declared` bytes and rejects a digest mismatch.
    ///
    /// The file size is compared to the published `declared` size first: a
    /// transfer whose file and event disagree is rejected without reading it.
    fn read(path: &Path, sha256: &str, declared: u64) -> Result<Self, BridgeError> {
        if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) { return Err(BridgeError::Invalid("Invalid browser PDF checksum")); }
        let size = std::fs::metadata(path).map_err(|error| BridgeError::Io { kind: "PDF", detail: error.to_string() })?.len();
        if size != declared { return Err(BridgeError::Size { expected: declared, actual: size }); }
        let mut body = Vec::new();
        std::fs::File::open(path).map_err(|error| BridgeError::Io { kind: "PDF", detail: error.to_string() })?.take(declared + 1).read_to_end(&mut body).map_err(|error| BridgeError::Io { kind: "PDF", detail: error.to_string() })?;
        if body.len() as u64 != declared { return Err(BridgeError::Size { expected: declared, actual: body.len() as u64 }); }
        let actual = mirror_pdf_desktop::model::digest(&body);
        if actual != sha256 { return Err(BridgeError::Checksum { expected: sha256.to_owned(), actual }); }
        Ok(Self { body })
    }
    /// Hands the verified bytes to `handler`; nothing else can reach them.
    fn dispatch<T>(self, handler: impl FnOnce(&[u8]) -> T) -> T { handler(&self.body) }
}

fn browser_import_key(sha256: &str) -> String { sha256.to_owned() }

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
        let previous = read_command(&target)?;
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
            read_acknowledgment(&acknowledgment)?.document_id
        } else {
            let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(path.join(".consumer.lock"))?;
            if lock.try_lock().is_err() { return Ok(None); }
            if acknowledgment.is_file() { return Ok(None); }
            let pdf = path.join("document.pdf").canonicalize()?;
            anyhow::ensure!(pdf.parent() == Some(path.as_path()) && pdf.is_file(), "Browser PDF escapes its published transfer");
            let hash = ready.sha256.as_deref().ok_or(BridgeError::Invalid("Browser PDF has no checksum"))?;
            let declared = ready.total_bytes.filter(|size| *size > 0 && *size <= crate::store::EXPORT_FILE_LIMIT).ok_or(BridgeError::Invalid("Invalid browser PDF size or checksum"))?;
            let key = browser_import_key(hash);
            // The digest is checked here, before the library reads or parses the
            // PDF, so a corrupted transfer never reaches a PDF parser. The library
            // re-reads this path and re-verifies its own copy when it imports.
            let payload = Payload::read(&pdf, hash, declared)?;
            let id = payload.dispatch(|_| crate::product_library::import_browser_pdf(&pdf, hash, ready.title.as_deref(), &key))?;
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

/// Duplicate memory for delivered sessions, keyed by the inbox directory the
/// host published.
///
/// Cap: [`SEEN_SESSIONS`] sessions. Eviction is by least recent write: delivering
/// or refreshing a session makes it the most recent, and inserting a new session
/// while the cap is full drops the session that was written least recently. A
/// session evicted this way counts as new if it is delivered again; the
/// generation guard in [`CompanionState::accept`] still rejects a session that
/// went backwards. A delivery that cannot be completed calls
/// [`Seen::forget`] so the next scan retries it instead of reporting a duplicate.
#[derive(Debug)]
struct Seen { sessions: HashMap<String, (u64, u64)>, clock: u64, cap: usize }

impl Default for Seen { fn default() -> Self { Self::new(SEEN_SESSIONS) } }

impl Seen {
    fn new(cap: usize) -> Self { Self { sessions: HashMap::new(), clock: 0, cap } }
    fn len(&self) -> usize { self.sessions.len() }
    /// Records `sequence` for `id`. `false` means this id already delivered the
    /// same or a newer sequence, which is a duplicate delivery.
    fn accepted(&mut self, id: &str, sequence: u64) -> bool {
        self.clock += 1;
        if let Some((delivered, touched)) = self.sessions.get_mut(id) {
            if *delivered >= sequence { return false; }
            *delivered = sequence; *touched = self.clock; return true;
        }
        if self.len() >= self.cap {
            let mut oldest: Option<(String, u64)> = None;
            for (id, (_, touched)) in &self.sessions {
                if oldest.as_ref().is_none_or(|(_, best)| touched < best) { oldest = Some((id.clone(), *touched)); }
            }
            if let Some((id, _)) = oldest { self.sessions.remove(&id); }
        }
        self.sessions.insert(id.to_owned(), (sequence, self.clock));
        true
    }
    /// Forgets an id whose delivery did not complete, so the next scan retries it.
    fn forget(&mut self, id: &str) { self.sessions.remove(id); }
}

/// The result of one inbox delivery.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Delivery {
    /// A new session, or a newer sequence for the active one, was applied.
    Accepted,
    /// This session already delivered the same or a newer sequence.
    Duplicate,
    /// The session's generation is older than one already applied.
    Stale,
}

/// What the desktop remembers between inbox scans: the active session, the
/// highest generation per source, and bounded duplicate and write bookkeeping.
#[derive(Default)]
pub struct CompanionState { seen: Seen, active: Option<(String, Binding)>, generations: HashMap<String, u64>, selected_generation: u64, command_sequence: u64, command_lock: Arc<Mutex<()>>, writes: Arc<Mutex<Pending>> }

impl CompanionState {
    fn can_select(&self, binding: &Binding) -> bool { binding.generation > self.selected_generation }
    fn accept(&mut self, update: &Update) -> Delivery {
        if !self.seen.accepted(&update.directory, update.event.sequence) { return Delivery::Duplicate; }
        let previous = self.generations.get(&update.event.binding.source_id).copied().unwrap_or(0);
        if update.event.binding.generation < previous { return Delivery::Stale; }
        self.generations.insert(update.event.binding.source_id.clone(), update.event.binding.generation);
        Delivery::Accepted
    }
}

/// Outbound command writes whose completion has not been observed yet.
///
/// Each booked entry is one command write; its completion is the response. Cap:
/// [`PENDING_WRITES`] entries. Inserting past the cap drops the write that has
/// been waiting longest and reports it as a timeout. A write that has not
/// completed within [`WRITE_TIMEOUT`] is likewise reported once and removed by
/// the next sweep, so a stuck transport cannot leak a pending entry or grow this
/// map without bound.
#[derive(Debug)]
struct Pending { writes: HashMap<u64, Instant>, timeout: Duration, cap: usize }

impl Default for Pending { fn default() -> Self { Self::new(PENDING_WRITES, WRITE_TIMEOUT) } }

impl Pending {
    fn new(cap: usize, timeout: Duration) -> Self { Self { writes: HashMap::new(), timeout, cap } }
    fn len(&self) -> usize { self.writes.len() }
    /// Books `id` from `now` and returns the writes that just timed out, including
    /// any dropped to stay within the cap.
    fn begin(&mut self, id: u64, now: Instant) -> Vec<BridgeError> {
        let mut expired = self.sweep(now);
        while self.len() >= self.cap {
            let oldest = self.writes.iter().max_by_key(|(_, started)| now.saturating_duration_since(**started)).map(|(id, started)| (*id, now.saturating_duration_since(*started)));
            let Some((oldest, waited)) = oldest else { break; };
            self.writes.remove(&oldest);
            expired.push(BridgeError::Timeout { what: "command", id: oldest, waited });
        }
        self.writes.insert(id, now);
        expired
    }
    /// Records that the response arrived. `false` when it was already removed.
    fn resolve(&mut self, id: u64) -> bool { self.writes.remove(&id).is_some() }
    /// Removes and reports every write that missed its deadline.
    fn sweep(&mut self, now: Instant) -> Vec<BridgeError> {
        let timeout = self.timeout;
        let mut expired = Vec::new();
        self.writes.retain(|id, started| {
            let waited = now.saturating_duration_since(*started);
            if waited >= timeout { expired.push(BridgeError::Timeout { what: "command", id: *id, waited }); false } else { true }
        });
        expired
    }
}

/// Books one outbound command write for as long as the attempt runs.
///
/// The booking is removed on drop, including on the error paths, so a write that
/// completes never leaves a pending entry behind.
struct WriteGuard { writes: Arc<Mutex<Pending>>, id: u64 }

impl Drop for WriteGuard {
    fn drop(&mut self) { if let Ok(mut writes) = self.writes.lock() { writes.resolve(self.id); } }
}

/// Books a command write and logs the writes that expired while waiting.
fn begin_write(writes: &Arc<Mutex<Pending>>, id: u64) -> WriteGuard {
    if let Ok(mut pending) = writes.lock() {
        for error in pending.begin(id, Instant::now()) { crate::logging::write(&format!("Browser command: {error}")); }
    }
    WriteGuard { writes: writes.clone(), id }
}

/// Reports every booked command write that missed its deadline.
fn sweep_writes(writes: &Arc<Mutex<Pending>>) {
    if let Ok(mut pending) = writes.lock() {
        for error in pending.sweep(Instant::now()) { crate::logging::write(&format!("Browser command: {error}")); }
    }
}

impl crate::app::Workspace {
    pub(crate) fn send_companion_location(&mut self, document: &str, page: u16, fraction: f32, zoom: f32, cx: &mut gpui::Context<Self>) {
        if self.view != crate::app::View::Doc || self.current.as_deref() != Some(document) || !fraction.is_finite() || !zoom.is_finite() { return; }
        let Some((name, binding)) = self.companion.active.clone() else { return; };
        let Some(sequence) = self.companion.command_sequence.checked_add(1).filter(|seq| *seq <= 9_007_199_254_740_991) else { return; };
        self.companion.command_sequence = sequence;
        sweep_writes(&self.companion.writes);
        let command = DesktopCommand { version: 1, kind: "view_state".into(), binding, sequence, page: Page { page, page_count: None, fraction: fraction.clamp(0., 1.), zoom: zoom.clamp(0.1, 10.) } };
        let lock = self.companion.command_lock.clone();
        let writes = self.companion.writes.clone();
        cx.background_executor().spawn(async move {
            let result = (|| -> Result<()> {
                let _guard = lock.lock().map_err(|_| anyhow::anyhow!("Browser command writer unavailable"))?;
                let _write = begin_write(&writes, sequence);
                write_command_at(&directory(), &name, &command)
            })();
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
        match self.companion.accept(&update) {
            Delivery::Accepted => {},
            Delivery::Duplicate | Delivery::Stale => return,
        }
        if update.event.kind == "session_ended" {
            if !self.entries.iter().any(|entry| entry.id == update.document_id) {
                self.store.reload();
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
            self.store.reload();
            self.entries = self.store.list(); self.sort(); self.load_home();
            if !self.companion.can_select(&update.event.binding) { cx.notify(); return; }
            if !self.entries.iter().any(|entry| entry.id == update.document_id) { return; }
            if !self.try_open(&update.document_id, window, cx) { self.companion.seen.forget(&update.directory); return; }
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
    use super::{Binding, BridgeError, CompanionState, Delivery, Event, MAX_MESSAGE_BYTES, Payload, Pending, Seen, Update};
    use std::time::{Duration, Instant};

    fn update(directory: &str, generation: u64, sequence: u64) -> Update {
        Update { directory: directory.into(), document_id: uuid::Uuid::nil().to_string(), event: Event { version: 1, kind: "page_changed".into(), binding: Binding { session_id: "session".into(), source_id: "source".into(), request_nonce: "nonce".into(), generation }, sequence, page: None, sha256: None, pdf_file: None, total_bytes: None, title: None } }
    }
    fn scratch(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("browser-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
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
        assert_eq!(state.accept(&update("ready-new", 5, 2)), Delivery::Accepted);
        assert_eq!(state.accept(&update("ready-new", 5, 1)), Delivery::Duplicate);
        assert_eq!(state.accept(&update("ready-old", 4, 10)), Delivery::Stale);
        assert_eq!(state.accept(&update("ready-new", 5, 3)), Delivery::Accepted);
    }
    #[test] fn redelivered_message_id_is_ignored_and_reported_as_duplicate() {
        let mut state = CompanionState::default();
        let message = update("ready-duplicate", 3, 7);
        assert_eq!(state.accept(&message), Delivery::Accepted);
        assert_eq!(state.accept(&message), Delivery::Duplicate);
        assert_eq!(state.seen.len(), 1, "a duplicate must not add a second entry");
    }
    #[test] fn duplicate_memory_still_recognizes_an_id_after_a_thousand_others() {
        let mut state = CompanionState::default();
        assert_eq!(state.accept(&update("ready-first", 1, 1)), Delivery::Accepted);
        for index in 0..1000u64 { assert_eq!(state.accept(&update(&format!("ready-{index}"), 1, index + 2)), Delivery::Accepted); }
        assert_eq!(state.accept(&update("ready-first", 1, 1)), Delivery::Duplicate);
        assert_eq!(state.seen.len(), 1001);
    }
    #[test] fn two_message_ids_with_identical_payloads_are_both_processed() {
        let mut state = CompanionState::default();
        let first = update("ready-a", 2, 5); let second = update("ready-b", 2, 5);
        assert_eq!(first.event.binding, second.event.binding);
        assert_eq!(first.event.sequence, second.event.sequence);
        assert_eq!(state.accept(&first), Delivery::Accepted);
        assert_eq!(state.accept(&second), Delivery::Accepted);
        assert_eq!(state.seen.len(), 2);
    }
    #[test] fn duplicate_memory_is_bounded_and_evicts_the_least_recently_written_id() {
        let mut seen = Seen::new(2);
        assert!(seen.accepted("ready-a", 1));
        assert!(seen.accepted("ready-b", 1));
        assert!(seen.accepted("ready-a", 2));
        assert!(seen.accepted("ready-c", 1), "a new id past the cap evicts the least recent write");
        assert_eq!(seen.len(), 2);
        assert!(!seen.accepted("ready-a", 2));
        assert!(!seen.accepted("ready-c", 1));
        assert!(seen.accepted("ready-b", 1), "an evicted id counts as new again");
    }
    #[test] fn browser_import_key_deduplicates_identical_pdf_bytes_across_sessions() {
        let digest = mirror_pdf_desktop::model::digest(b"same verified PDF");
        assert_eq!(super::browser_import_key(&digest), digest);
        assert_eq!(super::browser_import_key(&digest), digest);
    }
    #[test] fn payload_digest_is_verified_before_the_handler_runs() {
        let root = scratch("payload-ok");
        let body = br#"{"kind":"document_ready","sequence":0}"#.to_vec();
        let path = root.join("document.pdf");
        std::fs::write(&path, &body).unwrap();
        let expected = mirror_pdf_desktop::model::digest(&body);
        let payload = Payload::read(&path, &expected, body.len() as u64).unwrap();
        let mut observed = Vec::new();
        payload.dispatch(|bytes| observed.extend_from_slice(bytes));
        assert_eq!(observed, body);
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test] fn corrupted_digest_never_reaches_the_handler() {
        let root = scratch("payload-bad");
        let body = br#"{"kind":"document_ready","sequence":0}"#.to_vec();
        let path = root.join("document.pdf");
        std::fs::write(&path, &body).unwrap();
        let actual = mirror_pdf_desktop::model::digest(&body);
        let mut corrupted = actual.clone();
        corrupted.replace_range(..1, if actual.starts_with('0') { "1" } else { "0" });
        let mut handled = false;
        let result = Payload::read(&path, &corrupted, body.len() as u64).map(|payload| payload.dispatch(|_| { handled = true; }));
        match result {
            Err(BridgeError::Checksum { expected, actual: computed }) => { assert_eq!(expected, corrupted); assert_eq!(computed, actual); }
            other => panic!("expected a checksum error, got {other:?}"),
        }
        assert!(!handled, "a valid JSON body with a wrong digest must not reach the handler");
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test] fn wrong_checksum_quarantines_the_transfer_before_import() {
        let root = scratch("inbox-checksum");
        let path = root.join("ready-corrupt"); std::fs::create_dir_all(&path).unwrap();
        let body = b"%PDF-1.4\ncorrupted transfer\n";
        std::fs::write(path.join("document.pdf"), body).unwrap();
        let event = serde_json::json!({ "version":1,"kind":"document_ready","sequence":0,"binding":{"session_id":"session","source_id":"source","request_nonce":"nonce","generation":3},"sha256":mirror_pdf_desktop::model::digest(b"different bytes"),"total_bytes":body.len(),"pdf_file":"document.pdf","page":{"page":0,"page_count":2,"fraction":0.,"zoom":1.} });
        std::fs::write(path.join("event.json"), serde_json::to_vec(&event).unwrap()).unwrap();
        assert!(super::scan_inbox_at(&root).unwrap().is_empty());
        assert!(!path.join("acknowledged.json").exists(), "a corrupt transfer must not reach the importer");
        let marker = std::fs::read_to_string(path.join("consumer-error.txt")).unwrap();
        assert!(marker.contains("checksum"), "unexpected marker: {marker}");
        std::fs::remove_dir_all(&root).unwrap();
    }
    #[test] fn unanswered_write_times_out_without_leaking_a_pending_entry() {
        let start = Instant::now();
        let timeout = Duration::from_millis(40);
        let mut pending = Pending::new(8, timeout);
        let before = pending.len();
        assert!(pending.begin(1, start).is_empty());
        assert_eq!(pending.len(), 1);
        assert!(pending.sweep(start + Duration::from_millis(39)).is_empty(), "a write still inside its window must not time out");
        assert_eq!(pending.len(), 1);
        let expired = pending.sweep(start + timeout + Duration::from_millis(1));
        assert_eq!(expired.len(), 1);
        assert!(matches!(&expired[0], BridgeError::Timeout { id: 1, .. }));
        assert_eq!(pending.len(), before, "a timed-out write must not leak its pending entry");
        assert!(pending.sweep(start + Duration::from_secs(60)).is_empty());
        assert!(pending.begin(2, start).is_empty());
        assert!(pending.resolve(2), "a completed write is removed");
        assert!(pending.sweep(start + Duration::from_secs(60)).is_empty());
        assert_eq!(pending.len(), before);
    }
    #[test] fn malformed_messages_are_typed_errors_and_never_panic() {
        let root = scratch("malformed");
        let write = |name: &str, bytes: &[u8]| { let path = root.join(name); std::fs::write(&path, bytes).unwrap(); path };
        let empty = write("empty.json", b"");
        assert_eq!(super::read_event(&empty).unwrap_err(), BridgeError::EmptyMessage { kind: "event" });
        let truncated_header = write("truncated-header.json", &[0x28, 0x00]);
        assert_eq!(super::read_event(&truncated_header).unwrap_err(), BridgeError::TruncatedHeader { available: 2 });
        let oversized = write("oversized.json", &(MAX_MESSAGE_BYTES as u32 + 1).to_le_bytes());
        assert_eq!(super::read_event(&oversized).unwrap_err(), BridgeError::FrameTooLarge { announced: MAX_MESSAGE_BYTES + 1, limit: MAX_MESSAGE_BYTES });
        let mut non_utf8 = 4u32.to_le_bytes().to_vec(); non_utf8.extend_from_slice(&[0xff, 0xfe, 0xfd, 0xfc]);
        assert_eq!(super::read_event(&write("non-utf8.json", &non_utf8)).unwrap_err(), BridgeError::NotUtf8 { kind: "event" });
        let mut truncated_body = 40u32.to_le_bytes().to_vec(); truncated_body.extend_from_slice(b"{\"ve");
        assert_eq!(super::read_event(&write("truncated-body.json", &truncated_body)).unwrap_err(), BridgeError::TruncatedBody { announced: 40, available: 4 });
        std::fs::remove_dir_all(&root).unwrap();
    }
}
