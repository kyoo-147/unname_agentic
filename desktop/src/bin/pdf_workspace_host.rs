use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs::{self, File, OpenOptions}, io::{self, Read, Write}, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

const MAX_FRAME: usize = 1024 * 1024;
const MAX_PDF: u64 = 256 * 1024 * 1024;
const MAX_CHUNK: usize = 192 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    session_id: String,
    source_id: String,
    request_nonce: String,
    generation: u64,
}
impl Binding {
    fn validate(&self) -> Result<(), String> {
        let token = |s: &str| (16..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
        if !token(&self.session_id) || !token(&self.request_nonce) || !is_digest(&self.source_id) || self.generation == 0 || self.generation > 9_007_199_254_740_991 {
            return Err("Invalid session binding.".into());
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PageState {
    page: u32,
    page_count: Option<u32>,
    fraction: f32,
    zoom: f32,
}
impl PageState {
    fn normalized(mut self) -> Result<Self, String> {
        if !self.fraction.is_finite() || !self.zoom.is_finite() || self.page_count == Some(0) || self.page_count.is_some_and(|n| n > 65535) {
            return Err("Invalid page state.".into());
        }
        self.page = self.page.min(self.page_count.unwrap_or(65536) - 1).min(65535);
        self.fraction = self.fraction.clamp(0.0, 1.0);
        self.zoom = self.zoom.clamp(0.1, 10.0);
        Ok(self)
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Hello {},
    Begin { binding: Binding, total_bytes: u64, sha256: String, page: PageState, title: Option<String> },
    Chunk { binding: Binding, index: u32, data: String },
    Commit { binding: Binding },
    Page { binding: Binding, page: PageState },
    Poll { binding: Binding, after_sequence: u64 },
    End { binding: Binding },
}
struct Upload {
    binding: Binding,
    size: u64,
    expected_digest: String,
    page: PageState,
    title: String,
    staging: PathBuf,
    destination: PathBuf,
    file: Option<File>,
    received: u64,
    next_index: u32,
    digest: Sha256,
    prefix: Vec<u8>,
}
impl Drop for Upload {
    fn drop(&mut self) {
        self.file.take();
        let _ = fs::remove_dir_all(&self.staging);
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DesktopCommand { version: u32, kind: String, binding: Binding, sequence: u64, page: PageState }
struct Following { binding: Binding, directory: PathBuf, sequence: u64, command_sequence: u64 }
fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; metadata.file_attributes() & 0x400 != 0 }
    #[cfg(not(windows))] { metadata.file_type().is_symlink() }
}
fn read_command(directory: &Path) -> Result<Option<DesktopCommand>, String> {
    let metadata = fs::symlink_metadata(directory).map_err(|_| "Desktop command directory unavailable.")?;
    if !metadata.is_dir() || is_link(&metadata) { return Err("Invalid desktop command directory.".into()); }
    let path = directory.join("desktop-command.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Desktop command unavailable.".into()),
    };
    if !metadata.is_file() || is_link(&metadata) || metadata.len() > 4096 { return Err("Invalid desktop command file.".into()); }
    let mut bytes = Vec::new(); File::open(&path).map_err(|_| "Desktop command unavailable.")?.take(4097).read_to_end(&mut bytes).map_err(|_| "Desktop command unavailable.")?;
    if bytes.len() > 4096 { return Err("Desktop command exceeds limit.".into()); }
    serde_json::from_slice(&bytes).map(Some).map_err(|_| "Invalid desktop command.".into())
}
struct Host { inbox: PathBuf, upload: Option<Upload>, following: Option<Following>, last_generation: u64, token_counter: u64 }
fn is_digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn io_error(_: io::Error) -> String { "Could not write the dedicated desktop inbox.".into() }
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path).map_err(io_error)?;
    file.write_all(bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)
}
impl Host {
    fn end(&mut self, reason: &str) -> Result<(), String> {
        if let Some(following) = self.following.as_ref() {
            let sequence = following.sequence.checked_add(1).ok_or("Session event limit reached.")?;
            let event = json!({"version":1,"kind":"session_ended","binding":following.binding,"sequence":sequence,"reason":reason});
            Self::event(&following.directory, sequence, &event)?;
        }
        self.following = None;
        Ok(())
    }
    fn event(directory: &Path, sequence: u64, value: &Value) -> Result<(), String> {
        let temporary = directory.join(format!(".latest-{sequence}.tmp"));
        write_new(&temporary, &serde_json::to_vec(value).map_err(|_| "Invalid event.")?)?;
        fs::rename(&temporary, directory.join("latest.json")).map_err(io_error)
    }
    fn handle(&mut self, request: Request) -> Result<Value, String> {
        match request {
            Request::Hello {} => Ok(json!({"ok":true,"protocol":1,"status":"ready","max_frame":MAX_FRAME,"max_pdf":MAX_PDF,"chunk_bytes":MAX_CHUNK})),
            Request::Begin { binding, total_bytes, sha256, page, title } => {
                binding.validate()?;
                let page = page.normalized()?;
                if total_bytes == 0 || total_bytes > MAX_PDF || !is_digest(&sha256) { return Err("Invalid PDF size or digest.".into()); }
                if self.upload.is_some() || binding.generation <= self.last_generation { return Err("Upload already active or stale generation.".into()); }
                fs::create_dir_all(&self.inbox).map_err(io_error)?;
                if fs::symlink_metadata(&self.inbox).map_err(io_error)?.file_type().is_symlink() { return Err("Inbox cannot be a symbolic link.".into()); }
                self.token_counter += 1;
                let token = format!("{}-{}-{}", SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "Invalid clock.")?.as_nanos(), std::process::id(), self.token_counter);
                let staging = self.inbox.join(format!(".pending-{token}"));
                let destination = self.inbox.join(format!("ready-{token}"));
                fs::create_dir(&staging).map_err(io_error)?;
                let title = title.unwrap_or_else(|| "Browser PDF".into()).chars().filter(|c| !c.is_control()).take(200).collect::<String>();
                let mut upload = Upload { binding: binding.clone(), size: total_bytes, expected_digest: sha256, page, title, staging, destination, file: None, received: 0, next_index: 0, digest: Sha256::new(), prefix: Vec::new() };
                upload.file = Some(OpenOptions::new().write(true).create_new(true).open(upload.staging.join("document.pdf")).map_err(io_error)?);
                self.last_generation = binding.generation;
                self.upload = Some(upload);
                Ok(json!({"ok":true,"status":"receiving","binding":binding,"next_index":0}))
            }
            Request::Chunk { binding, index, data } => {
                let upload = self.upload.as_mut().ok_or("No upload active.")?;
                if binding != upload.binding || index != upload.next_index || data.is_empty() || data.len() > MAX_CHUNK.div_ceil(3) * 4 { return Err("Invalid chunk binding, index or size.".into()); }
                let bytes = STANDARD.decode(data).map_err(|_| "Invalid base64 chunk.")?;
                if bytes.is_empty() || bytes.len() > MAX_CHUNK || upload.received + bytes.len() as u64 > upload.size { return Err("PDF chunk exceeds declared size.".into()); }
                upload.file.as_mut().ok_or("Upload closed.")?.write_all(&bytes).map_err(io_error)?;
                upload.digest.update(&bytes);
                let prefix = bytes.len().min(1024 - upload.prefix.len());
                upload.prefix.extend_from_slice(&bytes[..prefix]);
                upload.received += bytes.len() as u64;
                upload.next_index += 1;
                Ok(json!({"ok":true,"status":"receiving","binding":binding,"next_index":upload.next_index}))
            }
            Request::Commit { binding } => {
                let mut upload = self.upload.take().ok_or("No upload active.")?;
                if binding != upload.binding || upload.received != upload.size || format!("{:x}", upload.digest.clone().finalize()) != upload.expected_digest || !upload.prefix.windows(5).any(|w| w == b"%PDF-") { return Err("Incomplete PDF, binding or digest mismatch.".into()); }
                upload.file.take().ok_or("Upload closed.")?.sync_all().map_err(io_error)?;
                let event = json!({"version":1,"kind":"document_ready","binding":binding,"sequence":0,"sha256":upload.expected_digest,"total_bytes":upload.size,"pdf_file":"document.pdf","title":upload.title,"page":upload.page});
                write_new(&upload.staging.join("event.json"), &serde_json::to_vec(&event).map_err(|_| "Invalid event.")?)?;
                fs::rename(&upload.staging, &upload.destination).map_err(io_error)?;
                self.end("source_changed")?;
                self.following = Some(Following { binding: binding.clone(), directory: upload.destination.clone(), sequence: 0, command_sequence: 0 });
                Ok(json!({"ok":true,"status":"complete","binding":binding}))
            }
            Request::Page { binding, page } => {
                let page = page.normalized()?;
                let following = self.following.as_mut().ok_or("No completed session to follow.")?;
                if binding != following.binding { return Err("Stale page binding.".into()); }
                let sequence = following.sequence.checked_add(1).ok_or("Session event limit reached.")?;
                Self::event(&following.directory, sequence, &json!({"version":1,"kind":"page_changed","binding":binding,"sequence":sequence,"page":page}))?;
                following.sequence = sequence;
                Ok(json!({"ok":true,"status":"following","binding":binding,"sequence":sequence,"page":page}))
            }
            Request::Poll { binding, after_sequence } => {
                let following = self.following.as_mut().ok_or("No completed session to follow.")?;
                if self.upload.is_some() || binding != following.binding || after_sequence > following.command_sequence { return Err("Stale poll binding or sequence.".into()); }
                let mut command = read_command(&following.directory)?;
                if let Some(value) = command.as_mut() {
                    if value.version != 1 || value.kind != "view_state" || value.binding != binding || value.sequence == 0 || value.sequence > 9_007_199_254_740_991 { return Err("Invalid desktop command binding or sequence.".into()); }
                    value.page = value.page.normalized()?;
                    if value.sequence <= following.command_sequence || value.sequence <= after_sequence { command = None; }
                    else { following.command_sequence = value.sequence; }
                }
                Ok(json!({"ok":true,"status":"following","binding":binding,"command":command}))
            }
            Request::End { binding } => {
                if self.following.as_ref().is_none_or(|s| s.binding != binding) { return Err("Stale end binding.".into()); }
                self.end("user_stopped")?;
                Ok(json!({"ok":true,"status":"ended","binding":binding}))
            }
        }
    }
}
fn read_frame(input: &mut impl Read) -> Result<Option<Request>, String> {
    let mut length = [0; 4];
    match input.read(&mut length[..1]) { Ok(0) => return Ok(None), Ok(_) => (), Err(_) => return Err("Could not read native message.".into()) }
    input.read_exact(&mut length[1..]).map_err(|_| "Truncated native message length.")?;
    let size = u32::from_le_bytes(length) as usize;
    if size == 0 || size > MAX_FRAME { return Err("Native message exceeds 1 MiB or is empty.".into()); }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes).map_err(|_| "Truncated native message body.")?;
    serde_json::from_slice(&bytes).map(Some).map_err(|_| "Invalid native JSON message.".into())
}
fn write_frame(output: &mut impl Write, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME { return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid output frame size")); }
    output.write_all(&(bytes.len() as u32).to_le_bytes())?;
    output.write_all(&bytes)?;
    output.flush()
}
fn run() -> Result<(), String> {
    let origin = std::env::args().nth(1).ok_or("Chrome extension origin is required.")?;
    let id = origin.strip_prefix("chrome-extension://").and_then(|v| v.strip_suffix('/')).ok_or("Invalid Chrome extension origin.")?;
    if id.len() != 32 || !id.bytes().all(|b| (b'a'..=b'p').contains(&b)) { return Err("Invalid Chrome extension origin.".into()); }
    let inbox = if let Some(path) = std::env::var_os("PDF_WORKSPACE_INBOX") { PathBuf::from(path) } else {
        PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA or PDF_WORKSPACE_INBOX is required.")?).join("PdfWorkspace").join("inbox")
    };
    if !inbox.is_absolute() { return Err("Desktop inbox must be an absolute path.".into()); }
    let mut host = Host { inbox, upload: None, following: None, last_generation: 0, token_counter: 0 };
    let mut input = io::stdin().lock(); let mut output = io::stdout().lock();
    let result = loop {
        let reply = match read_frame(&mut input) {
            Ok(Some(request)) => host.handle(request),
            Ok(None) => break Ok(()),
            Err(error) => Err(error),
        };
        match reply {
            Ok(reply) => if write_frame(&mut output, &reply).is_err() { break Err("Chrome native port disconnected.".into()); },
            Err(error) => { let _ = write_frame(&mut output, &json!({"ok":false,"error":error})); break Err(error); }
        }
    };
    let ended = host.end("disconnected");
    result.and(ended)
}
fn main() { if let Err(error) = run() { eprintln!("PDF Workspace host: {error}"); std::process::exit(1); } }
