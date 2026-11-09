use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::PathBuf, process::{Command, Stdio}, sync::atomic::{AtomicU64, Ordering}};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Inbox(PathBuf);
impl Inbox {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pdf-native-test-{}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn entries(&self) -> Vec<PathBuf> { fs::read_dir(&self.0).unwrap().map(|v| v.unwrap().path()).collect() }
}
impl Drop for Inbox { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn binding() -> Value { json!({"session_id":"11111111-1111-4111-8111-111111111111","source_id":"a".repeat(64),"request_nonce":"22222222-2222-4222-8222-222222222222","generation":1}) }
fn page() -> Value { json!({"page":2,"page_count":5,"fraction":0.25,"zoom":1.5}) }
fn frame(value: &Value) -> Vec<u8> {
    let body = serde_json::to_vec(value).unwrap();
    let mut bytes = (body.len() as u32).to_le_bytes().to_vec();
    bytes.extend(body); bytes
}
fn begin(bytes: &[u8]) -> Value { json!({"type":"begin","binding":binding(),"total_bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes)),"page":page()}) }
fn chunk(index: u32, bytes: &[u8]) -> Value { json!({"type":"chunk","binding":binding(),"index":index,"data":STANDARD.encode(bytes)}) }
fn run(inbox: &Inbox, bytes: Vec<u8>) -> (Vec<Value>, bool) {
    let mut command = Command::new(env!("CARGO_BIN_EXE_pdf-workspace-host"));
    command.arg("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/").env_clear().env("PDF_WORKSPACE_INBOX", &inbox.0).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || { let _ = stdin.write_all(&bytes); });
    let output = child.wait_with_output().unwrap();
    writer.join().unwrap();
    let mut offset = 0; let mut replies = Vec::new();
    while offset < output.stdout.len() {
        assert!(offset + 4 <= output.stdout.len(), "stdout must contain only native frames");
        let size = u32::from_le_bytes(output.stdout[offset..offset+4].try_into().unwrap()) as usize;
        assert!(size > 0 && size <= 1024*1024);
        offset += 4;
        assert!(offset + size <= output.stdout.len());
        replies.push(serde_json::from_slice(&output.stdout[offset..offset+size]).unwrap());
        offset += size;
    }
    (replies, output.status.success())
}
fn messages(values: &[Value]) -> Vec<u8> { values.iter().flat_map(frame).collect() }

struct LiveHost { child: std::process::Child, input: std::process::ChildStdin, output: std::process::ChildStdout }
impl LiveHost {
    fn new(inbox: &Inbox) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pdf-workspace-host")).arg("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/").env_clear().env("PDF_WORKSPACE_INBOX", &inbox.0).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        Self { input: child.stdin.take().unwrap(), output: child.stdout.take().unwrap(), child }
    }
    fn request(&mut self, request: Value) -> Value {
        self.input.write_all(&frame(&request)).unwrap(); self.input.flush().unwrap();
        let mut length = [0; 4]; self.output.read_exact(&mut length).unwrap();
        let size = u32::from_le_bytes(length) as usize; assert!(size > 0 && size <= 1024 * 1024);
        let mut bytes = vec![0; size]; self.output.read_exact(&mut bytes).unwrap(); serde_json::from_slice(&bytes).unwrap()
    }
    fn upload(&mut self) { let pdf = b"%PDF-1.7\nfixture"; for request in [begin(pdf), chunk(0,pdf), json!({"type":"commit","binding":binding()})] { assert_eq!(self.request(request)["ok"],true); } }
}
impl Drop for LiveHost { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }
fn command(sequence: u64) -> Value { json!({"version":1,"kind":"view_state","binding":binding(),"sequence":sequence,"page":page()}) }
#[test]
fn poll_reads_only_current_fixed_command_and_rejects_replay() {
    let inbox = Inbox::new(); let mut host = LiveHost::new(&inbox); host.upload();
    let directory = inbox.entries().pop().unwrap();
    fs::create_dir(inbox.0.join("ready-unrelated")).unwrap(); fs::write(inbox.0.join("ready-unrelated/desktop-command.json"), serde_json::to_vec(&command(99)).unwrap()).unwrap();
    let poll = |after| json!({"type":"poll","binding":binding(),"after_sequence":after});
    assert!(host.request(poll(0))["command"].is_null());
    let mut value = command(1); value["page"] = json!({"page":999,"page_count":5,"fraction":2.,"zoom":50.});
    fs::write(directory.join("desktop-command.json"), serde_json::to_vec(&value).unwrap()).unwrap();
    let reply = host.request(poll(0)); assert_eq!(reply["ok"], true); assert_eq!(reply["command"]["sequence"], 1);
    assert_eq!(reply["command"]["page"], json!({"page":4,"page_count":5,"fraction":1.,"zoom":10.}));
    assert!(host.request(poll(0))["command"].is_null());
    fs::write(directory.join("desktop-command.json"), serde_json::to_vec(&command(2)).unwrap()).unwrap();
    assert_eq!(host.request(poll(1))["command"]["sequence"], 2);
}
#[test]
fn poll_rejects_old_binding_malformed_oversize_and_extra_path_fields() {
    for case in 0..6 {
        let inbox = Inbox::new(); let mut host = LiveHost::new(&inbox); host.upload(); let directory = inbox.entries().pop().unwrap();
        let mut value = command(1); let mut poll = json!({"type":"poll","binding":binding(),"after_sequence":0});
        match case {
            0 => value["binding"]["request_nonce"] = json!("33333333-3333-4333-8333-333333333333"),
            1 => { fs::write(directory.join("desktop-command.json"), b"not JSON").unwrap(); },
            2 => { fs::write(directory.join("desktop-command.json"), vec![b' '; 4097]).unwrap(); },
            3 => poll["path"] = json!("C:\\private.json"),
            4 => poll["binding"]["generation"] = json!(2),
            _ => value["sequence"] = json!(0),
        }
        if case != 1 && case != 2 { fs::write(directory.join("desktop-command.json"), serde_json::to_vec(&value).unwrap()).unwrap(); }
        assert_eq!(host.request(poll)["ok"], false, "case {case}");
    }
}
#[test]
fn framed_hello_is_available_without_creating_inbox_files() {
    let inbox = Inbox::new();
    let (reply, success) = run(&inbox, frame(&json!({"type":"hello"})));
    assert!(success); assert_eq!(reply[0]["status"], "ready"); assert_eq!(reply[0]["protocol"], 1);
    assert!(inbox.entries().is_empty());
}
#[test]
fn publishes_pdf_and_session_together_then_normalizes_matching_page_event() {
    let inbox = Inbox::new(); let pdf = b"%PDF-1.7\nsynthetic test fixture\n%%EOF";
    let follow = json!({"type":"page","binding":binding(),"page":{"page":999,"page_count":5,"fraction":2.0,"zoom":50.0}});
    let (reply, success) = run(&inbox, messages(&[begin(pdf), chunk(0, &pdf[..10]), chunk(1, &pdf[10..]), json!({"type":"commit","binding":binding()}), follow]));
    assert!(success); assert!(reply.iter().all(|v| v["ok"] == true));
    let dirs = inbox.entries(); assert_eq!(dirs.len(), 1);
    assert!(dirs[0].file_name().unwrap().to_str().unwrap().starts_with("ready-"));
    assert_eq!(fs::read(dirs[0].join("document.pdf")).unwrap(), pdf);
    let event: Value = serde_json::from_slice(&fs::read(dirs[0].join("event.json")).unwrap()).unwrap();
    assert_eq!(event["kind"], "document_ready"); assert_eq!(event["binding"], binding()); assert_eq!(event["pdf_file"], "document.pdf");
    let event: Value = serde_json::from_slice(&fs::read(dirs[0].join("latest.json")).unwrap()).unwrap();
    assert_eq!(reply[4]["page"], json!({"page":4,"page_count":5,"fraction":1.0,"zoom":10.0}));
    assert_eq!(event["kind"], "session_ended"); assert_eq!(event["sequence"], 2); assert_eq!(event["reason"], "disconnected");
}
#[test]
fn rejects_bad_frames_and_json_without_unbounded_allocation() {
    for bytes in [vec![1,0], (1024_u32*1024+1).to_le_bytes().to_vec(), vec![0,0,0,0], vec![8,0,0,0,b'{'], vec![1,0,0,0,255], frame(&json!({"type":"fetch","path":"C:\\private.pdf"})), frame(&json!({"type":"hello","extra":true}))] {
        let inbox = Inbox::new(); let (reply, success) = run(&inbox, bytes);
        assert!(!success, "malformed native input unexpectedly accepted; replies: {reply:?}"); assert_eq!(reply.last().unwrap()["ok"], false); assert!(inbox.entries().is_empty());
    }
}
#[test]
fn rejects_chunk_order_binding_oversize_encoding_and_digest_mismatch() {
    let pdf = b"%PDF-1.7\nfixture";
    let mut other = binding(); other["generation"] = json!(2);
    let cases = vec![
        vec![begin(pdf), chunk(1,pdf)],
        vec![begin(pdf), json!({"type":"chunk","binding":other,"index":0,"data":STANDARD.encode(pdf)})],
        vec![begin(pdf), chunk(0,&vec![0;192*1024+1])],
        vec![begin(pdf), json!({"type":"chunk","binding":binding(),"index":0,"data":"not base64!"})],
        vec![begin(pdf), chunk(0,b"%PDF-1.7\nwrong!!"), json!({"type":"commit","binding":binding()})],
        vec![begin(pdf), json!({"type":"commit","binding":binding()})],
        vec![begin(pdf), chunk(0,pdf), chunk(0,pdf)],
        vec![json!({"type":"begin","binding":binding(),"total_bytes":256_u64*1024*1024+1,"sha256":"a".repeat(64),"page":page()})],
    ];
    for case in cases { let inbox=Inbox::new(); let (reply,success)=run(&inbox,messages(&case)); assert!(!success); assert_eq!(reply.last().unwrap()["ok"], false); assert!(inbox.entries().is_empty()); }
}
#[test]
fn eof_cleans_partial_transfer_and_stale_page_cannot_change_source() {
    let pdf = b"%PDF-1.7\nfixture"; let inbox = Inbox::new();
    let (_,success)=run(&inbox,messages(&[begin(pdf),chunk(0,pdf)])); assert!(success); assert!(inbox.entries().is_empty());
    let mut stale=binding(); stale["source_id"]=json!("b".repeat(64));
    let (reply,success)=run(&inbox,messages(&[begin(pdf),chunk(0,pdf),json!({"type":"commit","binding":binding()}),json!({"type":"page","binding":stale,"page":page()})]));
    assert!(!success); assert_eq!(reply.last().unwrap()["ok"],false);
    let dir=inbox.entries().pop().unwrap(); assert_eq!(fs::read_dir(dir).unwrap().count(),3);
}
#[test]
fn rejects_non_pdf_and_generation_replay() {
    let inbox=Inbox::new(); let pdf=b"not a pdf fixture";
    let (_,success)=run(&inbox,messages(&[begin(pdf),chunk(0,pdf),json!({"type":"commit","binding":binding()})])); assert!(!success); assert!(inbox.entries().is_empty());
    let pdf=b"%PDF-1.7\nfixture";
    let (reply,success)=run(&inbox,messages(&[begin(pdf),chunk(0,pdf),json!({"type":"commit","binding":binding()}),begin(pdf)]));
    assert!(!success); assert_eq!(reply.last().unwrap()["ok"],false); assert_eq!(inbox.entries().len(),1);
}
