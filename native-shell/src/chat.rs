use crate::i18n::tr3;
use crate::input::{TextField, TextFieldEvent};
use crate::theme::{self, Theme};
use crate::ui;
use gpui::{prelude::FluentBuilder, *};
use mirror_pdf_desktop::{model, provider};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;
use std::sync::mpsc::{self, TryRecvError};

enum StreamEvent { Delta(String), Done(String), Failed(String) }

/// One source citation an answer carries (I01): a page, a block, or both.
///
/// The markers stay in the message text, so a citation is a pointer read out of
/// the prose rather than something the answer lost on the way here.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatCitation {
    /// 1-based page the marker named, or `None` for a block-only marker whose id
    /// does not encode one (`[#rough-draft]`).
    pub page: Option<u16>,
    /// Block id the marker named. `[p12:r3]` yields `p12-r3`, the id shape the web
    /// reader's document builder assigns, so the reader can match it as written.
    pub block_id: Option<String>,
    /// The marker exactly as the answer wrote it, so a bubble can show what its
    /// link replaced.
    pub raw: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub user: bool,
    pub text: String,
    /// Citations read out of `text`; a question keeps none. Derived data, which is
    /// why it is rebuilt after a load instead of being trusted blindly.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub citations: Vec<ChatCitation>,
}

impl ChatMessage {
    /// Re-reads the markers from `text`. Citations are derived, so an answer stored
    /// before this field existed still comes back with its citations.
    fn refresh_citations(&mut self) {
        self.citations = if self.user { Vec::new() } else { parse_citations(&self.text) };
    }
}

#[derive(Default, Serialize, Deserialize)]
struct StoredChat {
    messages: Vec<ChatMessage>,
}

fn history_path() -> std::path::PathBuf { model::data_directory().join("chat.json") }

fn load_history() -> Vec<ChatMessage> {
    let mut messages: Vec<ChatMessage> = std::fs::read(history_path()).ok()
        .and_then(|bytes| serde_json::from_slice::<StoredChat>(&bytes).ok())
        .map(|stored| stored.messages.into_iter().rev().take(100).rev().collect())
        .unwrap_or_default();
    for message in &mut messages { message.refresh_citations(); }
    messages
}

/// The citations of one message: empty when it has none, when it is a question, or
/// when the index is past the end of the conversation.
fn citations_in(messages: &[ChatMessage], message_index: usize) -> &[ChatCitation] {
    match messages.get(message_index) {
        Some(message) => message.citations.as_slice(),
        None => &[],
    }
}

// --- Citation markers (I01) ------------------------------------------------
//
// The five forms the web reader's `parseCitations` accepts, so an answer parsed
// on either side of the app points at the same place:
//
// - `[p12]` (also `[P12]`) — the page.
// - `[p12:r3]` — the page and the rank of the block on it, i.e. the block id
//   `p12-r3`.
// - `(trang 12)` — the Vietnamese page form.
// - `[#p12-r3]` — an explicit block id; the page is read out of the id when the
//   id encodes one.
// - `[[cite:{"page":12,"blockId":"p12-r3"}]]` — JSON, with quotes around the keys
//   and the block id optional.
//
// Parsing is syntax only: `[p0]` parses as page 0 and is left for a lookup against
// the document to reject, exactly as the web reader does.

/// `[[cite:{"page":12,"blockId":"p12-r3"}]]`; the payload cannot nest braces.
static JSON_FORM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\[cite:\s*(\{[^{}]{0,512}\})\s*\]\]").unwrap());

/// `[p12]` and `[p12:r3]`.
static PAGE_FORM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[pP]([0-9]{1,6})(?::[rR]([0-9]{1,6}))?\]").unwrap());

/// `[#p12-r3]`, a block id restricted to the characters ids are built from.
static BLOCK_FORM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[#([A-Za-z0-9._-]{1,128})\]").unwrap());

/// `(trang 12)`.
static TRANG_FORM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\(\s*trang\s+([0-9]{1,6})\s*\)").unwrap());

/// A block id that encodes its own page, as the web reader writes them.
static BLOCK_ID_PAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^p([0-9]{1,9})-r[0-9]{1,9}$").unwrap());

/// The same two payload fields, read without strict JSON quotes.
static RELAXED_PAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)["']?page["']?\s*:\s*["']?([0-9]{1,6})"#).unwrap());
static RELAXED_BLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)["']?blockId["']?\s*:\s*["']?([A-Za-z0-9._-]{1,128})"#).unwrap());

/// One raw marker found in the answer, before repeats are folded together.
struct Marker {
    start: usize,
    end: usize,
    page: Option<u16>,
    block_id: Option<String>,
}

/// Reads the citation markers out of an answer, leaving its text untouched.
///
/// Markers that name the same page and the same block are one citation, whatever
/// syntax each used: the first spelling is kept as `raw` and the order is order of
/// first appearance. A marker that carries neither a page nor a block is prose, so
/// unknown shapes stay in the answer instead of being deleted from it.
pub fn parse_citations(text: &str) -> Vec<ChatCitation> {
    let mut citations: Vec<ChatCitation> = Vec::new();
    for marker in scan_markers(text) {
        if citations.iter().any(|seen| seen.page == marker.page && seen.block_id == marker.block_id) { continue; }
        let raw = text.get(marker.start..marker.end).unwrap_or_default().to_string();
        citations.push(ChatCitation { page: marker.page, block_id: marker.block_id, raw });
    }
    citations
}

fn scan_markers(text: &str) -> Vec<Marker> {
    let mut found: Vec<Marker> = Vec::new();

    for captures in JSON_FORM.captures_iter(text) {
        let (Some(whole), Some(payload)) = (captures.get(0), captures.get(1)) else { continue; };
        let Some((page, block_id)) = read_cite_payload(payload.as_str()) else { continue; };
        found.push(Marker { start: whole.start(), end: whole.end(), page, block_id });
    }

    for captures in PAGE_FORM.captures_iter(text) {
        let Some(whole) = captures.get(0) else { continue; };
        let Some(page) = captures.get(1).map(|page| page.as_str()).and_then(to_page) else { continue; };
        let block_id = captures.get(2).map(|rank| rank.as_str()).and_then(to_number).map(|rank| format!("p{page}-r{rank}"));
        found.push(Marker { start: whole.start(), end: whole.end(), page: Some(page), block_id });
    }

    for captures in BLOCK_FORM.captures_iter(text) {
        let (Some(whole), Some(block_id)) = (captures.get(0), captures.get(1)) else { continue; };
        let block_id = block_id.as_str();
        found.push(Marker { start: whole.start(), end: whole.end(), page: page_of_block_id(block_id), block_id: Some(block_id.to_string()) });
    }

    for captures in TRANG_FORM.captures_iter(text) {
        let Some(whole) = captures.get(0) else { continue; };
        let Some(page) = captures.get(1).map(|page| page.as_str()).and_then(to_page) else { continue; };
        found.push(Marker { start: whole.start(), end: whole.end(), page: Some(page), block_id: None });
    }

    drop_overlaps(found)
}

/// Keeps one marker where two patterns cover the same characters: the leftmost wins
/// and, at the same start, the longer one does. The forms do not normally overlap,
/// but a hand-written payload inside the JSON form could contain something that
/// looks like one, and the same characters must not count twice.
fn drop_overlaps(mut found: Vec<Marker>) -> Vec<Marker> {
    found.sort_by(|left, right| left.start.cmp(&right.start).then((right.end - right.start).cmp(&(left.end - left.start))));
    let mut kept: Vec<Marker> = Vec::with_capacity(found.len());
    let mut consumed = 0;
    for marker in found {
        if marker.start < consumed { continue; }
        consumed = marker.end;
        kept.push(marker);
    }
    kept
}

/// Reads the payload of `[[cite:...]]`. Strict JSON is tried first; when the keys or
/// the block id went unquoted, the same two fields are read directly. A payload with
/// neither field is not a citation, so the text is left in the answer rather than
/// silently dropped.
fn read_cite_payload(payload: &str) -> Option<(Option<u16>, Option<String>)> {
    if let Ok(Value::Object(fields)) = serde_json::from_str::<Value>(payload) {
        let page = fields.get("page").and_then(json_page);
        let block_id = fields.get("blockId").and_then(json_block);
        if page.is_some() || block_id.is_some() { return Some((page, block_id)); }
    }
    let page = RELAXED_PAGE.captures(payload).and_then(|captures| captures.get(1)).map(|page| page.as_str()).and_then(to_page);
    let block_id = RELAXED_BLOCK.captures(payload).and_then(|captures| captures.get(1)).map(|block| block.as_str().to_string());
    if page.is_none() && block_id.is_none() { None } else { Some((page, block_id)) }
}

fn json_page(value: &Value) -> Option<u16> {
    match value {
        Value::Number(number) => number.as_u64().and_then(|page| u16::try_from(page).ok()),
        Value::String(text) => to_page(text.trim()),
        _ => None,
    }
}

fn json_block(value: &Value) -> Option<String> {
    let block_id = value.as_str()?.trim();
    (!block_id.is_empty()).then(|| block_id.to_string())
}

/// The page a block id encodes (`p12-r3` -> 12), or `None` when it encodes none.
fn page_of_block_id(block_id: &str) -> Option<u16> {
    let captures = BLOCK_ID_PAGE.captures(block_id)?;
    to_page(captures.get(1)?.as_str())
}

/// A page number the citation model can hold: `u16` is enough for a PDF and keeps a
/// typo like `[p123456]` from becoming a page.
fn to_page(raw: &str) -> Option<u16> {
    to_number(raw).and_then(|page| u16::try_from(page).ok())
}

fn to_number(raw: &str) -> Option<u32> {
    if raw.is_empty() || raw.len() > 6 || !raw.bytes().all(|byte| byte.is_ascii_digit()) { return None; }
    raw.parse::<u32>().ok()
}

/// The citation contract sent with a document question: the model has to produce the
/// markers the parser reads. `provider::chat_system` owns the system message, so the
/// contract travels as the request's first turn instead.
fn citation_instruction() -> &'static str {
    tr3(
        "回答文档问题时，用 [p12] 或 [p12:r3] 标注引用：页码，知道块序号时再加上块序号。不要编造引用。",
        "When you answer about the document, cite with [p12] or [p12:r3]: the page, then the block rank when you know it. Never invent a citation.",
        "Khi trả lời về tài liệu, hãy trích dẫn bằng [p12] hoặc [p12:r3]: số trang, kèm thứ tự khối khi bạn biết. Không bịa trích dẫn.",
    )
}

/// The turns handed to the provider: the citation contract first when a document is
/// open, then the conversation unchanged. This is a copy for the request, so the
/// instruction never becomes a message the reader shows or the history stores.
fn request_history(messages: &[ChatMessage], document_open: bool) -> Vec<(bool, String)> {
    let mut history: Vec<(bool, String)> = Vec::with_capacity(messages.len() + 1);
    if document_open { history.push((true, citation_instruction().to_string())); }
    history.extend(messages.iter().map(|message| (message.user, message.text.clone())));
    history
}

pub struct Chat {
    input: Entity<TextField>,
    messages: Vec<ChatMessage>,
    busy: bool,
    error: Option<String>,
    context: Option<(String, String)>,
    model: String,
    endpoint_input: Entity<TextField>,
    model_input: Entity<TextField>,
    show_config: bool,
    config_status: Option<String>,
    _submit: Subscription,
}

impl Chat {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            let mut field = TextField::new(tr3("Hỏi bất cứ điều gì…", "Ask anything…", "Hỏi bất cứ điều gì…"), cx);
            field.multiline = false;
            field
        });
        let submit = cx.subscribe(&input, |this, _, event: &TextFieldEvent, cx| {
            if matches!(event, TextFieldEvent::Submit) { this.send(cx); }
        });
        let settings = model::load_settings();
        let model = settings.provider.model.clone();
        let endpoint_input = cx.new(|cx| { let mut field = TextField::new("http://127.0.0.1:11434/v1", cx); field.set_text(&settings.provider.endpoint, cx); field });
        let model_input = cx.new(|cx| { let mut field = TextField::new("gpt-4.1-mini", cx); field.set_text(&model, cx); field });
        let show_config = !model::data_directory().join("settings.json").exists();
        Self { input, messages: load_history(), busy: false, error: None, context: None, model, endpoint_input, model_input, show_config, config_status: None, _submit: submit }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.input.read(cx).focus_handle(cx));
    }

    fn save_config(&mut self, cx: &mut Context<Self>) {
        let endpoint = self.endpoint_input.read(cx).text.trim().to_string();
        let model_name = self.model_input.read(cx).text.trim().to_string();
        if endpoint.is_empty() || model_name.is_empty() { self.config_status = Some(tr3("Endpoint và model không được để trống.", "Endpoint and model are required.", "Endpoint và model không được để trống.").to_string()); cx.notify(); return; }
        let mut settings = model::load_settings();
        let previous = (settings.provider.endpoint.clone(), settings.provider.model.clone());
        settings.provider.endpoint = endpoint.clone();
        settings.provider.model = model_name.clone();
        settings.provider.api_key = match provider::load_key(settings.provider.kind) {
            Ok(key) => key,
            Err(error) => { self.config_status = Some(format!("{error:#}")); cx.notify(); return; }
        };
        let problems = provider::validate_settings(&settings.provider);
        let result = if problems.is_empty() {
            model::save_settings(&settings)
        } else {
            Err(anyhow::anyhow!("{}: {:?}", tr3("配置不完整", "Provider configuration is incomplete", "Cấu hình nhà cung cấp chưa đủ"), problems))
        };
        match result {
            Ok(()) => { self.model = model_name; self.config_status = Some(tr3("Đã lưu cấu hình nhà cung cấp.", "Provider settings saved.", "Đã lưu cấu hình nhà cung cấp.").to_string()); }
            Err(error) => { settings.provider.endpoint = previous.0; settings.provider.model = previous.1; self.config_status = Some(format!("{error:#}")); }
        }
        cx.notify();
    }
    pub fn open_config(&mut self, cx: &mut Context<Self>) {
        self.show_config = true;
        cx.notify();
    }
    fn choose_model(&mut self, kind: model::ProviderKind, endpoint: String, model_name: String, cx: &mut Context<Self>) {
        let mut settings = model::load_settings();
        settings.provider.kind = kind;
        settings.provider.endpoint = endpoint.clone();
        settings.provider.model = model_name.clone();
        settings.provider.api_key = match provider::load_key(kind) {
            Ok(key) => key,
            Err(error) => { self.config_status = Some(format!("{error:#}")); cx.notify(); return; }
        };
        match model::save_settings(&settings) {
            Ok(()) => {
                self.endpoint_input.update(cx, |field, cx| field.set_text(&endpoint, cx));
                self.model_input.update(cx, |field, cx| field.set_text(&model_name, cx));
                self.model = model_name;
                self.config_status = Some(tr3("已选择模型；发送前仍会检查权限和凭据。", "Model selected; permissions and credentials are still checked before sending.", "Đã chọn mô hình; quyền và thông tin đăng nhập vẫn được kiểm tra trước khi gửi.").to_string());
            }
            Err(error) => self.config_status = Some(format!("{error:#}")),
        }
        cx.notify();
    }

    fn persist(&self) {
        let stored = StoredChat { messages: self.messages.iter().rev().take(100).rev().cloned().collect() };
        if let Some(directory) = history_path().parent() { let _ = std::fs::create_dir_all(directory); }
        if let Ok(json) = serde_json::to_vec_pretty(&stored) { let _ = std::fs::write(history_path(), json); }
    }

    /// The citations an answer carries (I01): the markers it wrote, read out of the
    /// text and folded to one entry per target, in order of first appearance. Empty
    /// for a question, for an answer that cited nothing, and past the last message.
    ///
    /// The bubbles draw a link per citation; the text keeps its markers, so what the
    /// model wrote is never rewritten by the display.
    #[allow(dead_code)]
    pub fn citations(&self, message_index: usize) -> &[ChatCitation] {
        citations_in(&self.messages, message_index)
    }

    pub fn set_context(&mut self, context: Option<(String, String)>, cx: &mut Context<Self>) {
        if self.context != context {
            self.messages.clear();
            self.error = None;
            self.context = context;
            self.persist();
            cx.notify();
        }
    }

    pub fn reset(&mut self, cx: &mut Context<Self>) {
        self.messages.clear();
        self.context = None;
        self.error = None;
        self.busy = false;
        self.persist();
        cx.notify();
    }

    pub fn ask(&mut self, prompt: String, cx: &mut Context<Self>) {
        self.input.update(cx, |field, cx| field.set_text(&prompt, cx));
        self.send(cx);
    }

    /// 语音输入 (C19): put recognised words in the composer without sending
    /// them. Dictation appends, so several sentences land in one prompt.
    pub fn append_composer(&mut self, text: &str, cx: &mut Context<Self>) {
        let text = text.trim();
        if text.is_empty() { return; }
        let current = self.input.read(cx).text.trim_end().to_string();
        let joined = if current.is_empty() { text.to_string() } else { format!("{current} {text}") };
        self.input.update(cx, |field, cx| field.set_text(&joined, cx));
        cx.notify();
    }

    fn send(&mut self, cx: &mut Context<Self>) {
        let question = self.input.read(cx).text.trim().to_string();
        if question.is_empty() || self.busy { return; }
        self.messages.push(ChatMessage { user: true, text: question, citations: Vec::new() });
        self.persist();
        self.input.update(cx, |field, cx| field.set_text("", cx));
        self.busy = true;
        self.error = None;
        cx.notify();

        let history = request_history(&self.messages, self.context.is_some());
        self.messages.push(ChatMessage { user: false, text: String::new(), citations: Vec::new() });
        let context = self.context.clone();
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut settings = model::load_settings();
            settings.provider.api_key = provider::load_key(settings.provider.kind).unwrap_or_default();
            let context = context.as_ref().map(|(title, text)| (title.as_str(), text.as_str()));
            let result = provider::chat_stream(&settings.provider, &history, context, |delta| { let _ = sender.send(StreamEvent::Delta(delta.to_string())); });
            let _ = match result {
                Ok(full) => sender.send(StreamEvent::Done(full)),
                Err(error) => sender.send(StreamEvent::Failed(format!("{error:#}"))),
            };
        });
        cx.spawn(async move |this, cx| {
            loop {
                match receiver.try_recv() {
                    Ok(StreamEvent::Delta(delta)) => {
                        let _ = this.update(cx, |chat, cx| {
                            if let Some(message) = chat.messages.last_mut() { if !message.user { message.text.push_str(&delta); } }
                            cx.notify();
                        });
                    }
                    Ok(StreamEvent::Done(full)) => {
                        let _ = this.update(cx, |chat, cx| {
                            if let Some(message) = chat.messages.last_mut() {
                                message.text = full.clone();
                                message.refresh_citations();
                            }
                            chat.busy = false;
                            chat.persist();
                            cx.notify();
                        });
                        break;
                    }
                    Ok(StreamEvent::Failed(error)) => {
                        let _ = this.update(cx, |chat, cx| {
                            if chat.messages.last().is_some_and(|message| !message.user) { chat.messages.pop(); }
                            chat.busy = false;
                            chat.error = Some(error.clone());
                            chat.persist();
                            cx.notify();
                        });
                        break;
                    }
                    Err(TryRecvError::Empty) => cx.background_executor().timer(std::time::Duration::from_millis(35)).await,
                    Err(TryRecvError::Disconnected) => {
                        let _ = this.update(cx, |chat, cx| {
                            if chat.messages.last().is_some_and(|message| !message.user) { chat.messages.pop(); }
                            chat.busy = false;
                            chat.error = Some(tr3("Luồng trả lời bị ngắt.", "The answer stream ended unexpectedly.", "Luồng trả lời bị ngắt.").to_string());
                            cx.notify();
                        });
                        break;
                    }
                }
            }
        }).detach();
    }

    fn suggestions(&self, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let prompts = if self.context.is_some() {
            [tr3("Tóm tắt trang này", "Summarize this page", "Tóm tắt trang này"), tr3("Liệt kê số liệu", "List the numbers", "Liệt kê số liệu"), tr3("Giải thích thuật ngữ", "Explain the terms", "Giải thích thuật ngữ")]
        } else {
            [tr3("Workspace này dùng thế nào?", "How do I use this workspace?", "Workspace này dùng thế nào?"), tr3("Dịch một PDF thế nào?", "How do I translate a PDF?", "Dịch một PDF thế nào?"), tr3("Dữ liệu ở đâu?", "Where is my data stored?", "Dữ liệu ở đâu?")]
        };
        prompts.into_iter().enumerate().map(|(index, prompt)| {
            div().id(("chat-suggestion", index)).px(px(10.)).h(px(28.)).rounded(px(8.)).border_1().border_color(Theme::line_border()).flex().items_center().cursor_pointer()
                .text_size(px(12.)).text_color(Theme::text_caption()).hover(|s| s.bg(Theme::fill_hover()))
                .child(prompt)
                .on_click(cx.listener(move |chat, _, _, cx| chat.ask(prompt.to_string(), cx)))
                .into_any_element()
        }).collect()
    }

    fn message_bubble(&self, message: &ChatMessage) -> AnyElement {
        let (background, text_color) = if message.user {
            (Theme::fill_hover_strong(), Theme::text())
        } else {
            (Theme::bg_overlay(), Theme::text())
        };
        div()
            .max_w(px(760.))
            .p(px(12.))
            .rounded(px(10.))
            .bg(background)
            .text_color(text_color)
            .text_size(px(14.))
            .line_height(px(21.))
            .child(message.text.clone())
            .when(!message.citations.is_empty(), |element| element.child(
                div().mt(px(8.)).flex().flex_wrap().gap(px(5.)).children(message.citations.iter().enumerate().map(|(index, citation)| {
                    div().id(("chat-citation", index)).px(px(6.)).py(px(2.)).rounded(px(5.)).bg(Theme::primary_fill_1()).text_size(px(11.)).text_color(Theme::primary()).child(citation.raw.clone())
                }).collect::<Vec<_>>())
            ))
            .into_any_element()
    }
}

impl Render for Chat {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let messages = self.messages.iter().map(|message| self.message_bubble(message)).collect::<Vec<_>>();
        let model_choices = model::ModelCatalogue::default().models.into_iter().filter(|descriptor| descriptor.capabilities.chat).enumerate().map(|(index, descriptor)| {
            let kind = descriptor.provider;
            let endpoint = descriptor.endpoint.clone();
            let model_name = descriptor.id.clone();
            div().id(("chat-model-choice", index)).px(px(7.)).py(px(4.)).rounded(px(6.)).border_1().border_color(Theme::line_border()).cursor_pointer()
                .text_size(px(11.)).text_color(Theme::text_caption()).hover(|s| s.bg(Theme::fill_hover()))
                .child(descriptor.label)
                .on_click(cx.listener(move |chat, _, _, cx| chat.choose_model(kind, endpoint.clone(), model_name.clone(), cx)))
                .into_any_element()
        }).collect::<Vec<_>>();
        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(Theme::bg_body())
            .font_family(theme::UI_FONT)
            .child(div().flex_none().px(px(24.)).py(px(18.)).border_b_1().border_color(Theme::line_border())
                .child(div().text_size(px(20.)).line_height(px(28.)).font_weight(FontWeight::SEMIBOLD).child(tr3("Trò chuyện", "Chat", "Trò chuyện")))
                .child(div().mt(px(2.)).text_size(px(12.)).text_color(Theme::text_caption()).child(tr3(
                    "Trợ lý dùng nhà cung cấp đã cấu hình trong trình đọc. Chưa cấu hình thì sẽ báo lỗi rõ ràng.",
                    "The assistant uses the provider configured in the reader. Without one it reports a clear error.",
                    "Trợ lý dùng nhà cung cấp đã cấu hình trong trình đọc. Chưa cấu hình thì sẽ báo lỗi rõ ràng.",
                ))))
                .child(div().mt(px(8.)).flex().items_center().justify_between()
                    .child(div().id("chat-model").px(px(4.)).h(px(22.)).rounded(px(6.)).flex().items_center().cursor_pointer().text_size(px(11.)).text_color(Theme::text_disabled()).hover(|s| s.bg(Theme::fill_hover())).child(format!("{} · {}", tr3("Mô hình", "Model", "Mô hình"), self.model))
                        .on_click(cx.listener(|chat, _, _, cx| { chat.show_config = !chat.show_config; cx.notify(); })))
                    .child(div().id("chat-new").px(px(8.)).h(px(22.)).rounded(px(6.)).flex().items_center().cursor_pointer().text_size(px(11.)).text_color(Theme::text_caption()).hover(|s| s.bg(Theme::fill_hover())).child(tr3("Cuộc trò chuyện mới", "New conversation", "Cuộc trò chuyện mới"))
                        .on_click(cx.listener(|chat, _, _, cx| chat.reset(cx)))))
                .when_some(self.context.as_ref().map(|(title, _)| title.clone()), |element, title| element.child(
                    div().mt(px(8.)).flex().items_center().gap(px(6.)).text_size(px(12.)).text_color(Theme::text_caption())
                        .child(format!("{} {title}", tr3("Đang hỏi về:", "Asking about:", "Đang hỏi về:")))
                        .child(div().id("chat-clear-context").size(px(18.)).flex().items_center().justify_center().rounded(px(4.)).cursor_pointer().hover(|s| s.bg(Theme::fill_hover())).child("×")
                            .on_click(cx.listener(|chat, _, _, cx| chat.set_context(None, cx))))))
            .when(self.show_config, |element| element.child(div().flex_none().px(px(24.)).py(px(10.)).border_b_1().border_color(Theme::line_border()).flex().flex_col().gap(px(6.))
                .child(div().text_size(px(11.)).text_color(Theme::text_caption()).child(tr3("模型目录 · 仅本地元数据，不会探测网络", "Model catalogue · local metadata only; no network probe", "Danh mục mô hình · chỉ siêu dữ liệu cục bộ; không dò mạng")))
                .child(div().flex().flex_wrap().gap(px(5.)).children(model_choices))
                .child(div().flex().items_center().gap(px(8.)).child(div().w(px(70.)).text_size(px(12.)).text_color(Theme::text_caption()).child("Endpoint")).child(div().flex_1().min_w_0().child(self.endpoint_input.clone())))
                .child(div().flex().items_center().gap(px(8.)).child(div().w(px(70.)).text_size(px(12.)).text_color(Theme::text_caption()).child(tr3("Mô hình", "Model", "Mô hình"))).child(div().flex_1().min_w_0().child(self.model_input.clone())))
                .child(div().flex().items_center().gap(px(8.)).child(ui::primary_button("chat-save-config", tr3("Lưu", "Save", "Lưu")).on_click(cx.listener(|chat, _, _, cx| chat.save_config(cx)))).when_some(self.config_status.clone(), |row, status| row.child(div().text_size(px(12.)).text_color(Theme::text_caption()).child(status))))))
            .child(div().id("chat-messages").flex_1().min_h_0().overflow_y_scroll().px(px(24.)).py(px(20.))
                .flex().flex_col().gap(px(10.))
                .when(messages.is_empty(), |element| element.child(div().flex().flex_col().gap(px(10.)).child(div().text_color(Theme::text_caption()).text_size(px(13.)).child(tr3(
                    "Hỏi về cách dùng, hoặc mở một PDF để đọc song song.",
                    "Ask how to use the workspace, or open a PDF to read side by side.",
                    "Hỏi về cách dùng, hoặc mở một PDF để đọc song song.",
                ))).child(div().flex().flex_wrap().gap(px(8.)).children(self.suggestions(cx)))))
                .children(messages)
                .when(self.busy, |element| element.child(div().text_color(Theme::text_caption()).text_size(px(12.)).child(tr3("Đang trả lời…", "Answering…", "Đang trả lời…"))))
                .when_some(self.error.clone(), |element, error| element.child(div().text_color(Theme::danger()).text_size(px(12.)).child(error))))
            .child(div().flex_none().border_t_1().border_color(Theme::line_border()).px(px(24.)).py(px(14.))
                .child(div().max_w(px(760.)).w_full().flex().items_center().gap(px(8.)).p(px(6.)).rounded(px(10.)).border_1().border_color(Theme::line_border()).bg(Theme::bg_overlay())
                    .child(div().flex_1().min_w_0().child(self.input.clone()))
                    .child(ui::primary_button("chat-send", tr3("Gửi", "Send", "Gửi")).on_click(cx.listener(|chat, _, _, cx| chat.send(cx))))))
    }
}

#[cfg(test)]
mod tests {
    // Explicit imports: `use super::*` would bring in `gpui::test` through the parent
    // module's glob import and shadow the built-in `#[test]` attribute.
    use super::{ChatCitation, ChatMessage, StoredChat, citation_instruction, citations_in, parse_citations, request_history};

    /// `(page, block id, raw)` per citation, so an assertion reads like the answer.
    fn summary<'a>(citations: &'a [ChatCitation]) -> Vec<(Option<u16>, Option<&'a str>, &'a str)> {
        citations.iter().map(|citation| (citation.page, citation.block_id.as_deref(), citation.raw.as_str())).collect()
    }

    fn answer(user: bool, text: &str) -> ChatMessage {
        ChatMessage { user, text: text.to_string(), citations: Vec::new() }
    }

    #[test]
    fn page_markers_parse() {
        assert_eq!(summary(&parse_citations("See [p12] and [P7].")), vec![(Some(12), None, "[p12]"), (Some(7), None, "[P7]")]);
    }

    #[test]
    fn page_and_rank_markers_parse_to_a_block_id() {
        assert_eq!(
            summary(&parse_citations("See [p12:r3] for the figure, and [p4:R0] too.")),
            vec![(Some(12), Some("p12-r3"), "[p12:r3]"), (Some(4), Some("p4-r0"), "[p4:R0]")],
        );
    }

    #[test]
    fn trang_markers_parse() {
        assert_eq!(summary(&parse_citations("Số liệu (trang 12) đã nêu.")), vec![(Some(12), None, "(trang 12)")]);
        assert_eq!(
            summary(&parse_citations("Xem (Trang 7), rồi ( trang 3 ).")),
            vec![(Some(7), None, "(Trang 7)"), (Some(3), None, "( trang 3 )")],
        );
    }

    #[test]
    fn block_markers_parse() {
        assert_eq!(summary(&parse_citations("Per [#p1-r1] this holds.")), vec![(Some(1), Some("p1-r1"), "[#p1-r1]")]);
        // An id that encodes no page is a block citation with an unknown page.
        assert_eq!(summary(&parse_citations("Draft [#rough-draft] says so.")), vec![(None, Some("rough-draft"), "[#rough-draft]")]);
    }

    #[test]
    fn json_markers_parse() {
        assert_eq!(
            summary(&parse_citations(r#"Total [[cite:{"page":2,"blockId":"p2-r0"}]] grows."#)),
            vec![(Some(2), Some("p2-r0"), r#"[[cite:{"page":2,"blockId":"p2-r0"}]]"#)],
        );
        // Quotes are optional, which is how a model usually writes it.
        assert_eq!(
            summary(&parse_citations("Total [[cite:{page: 2, blockId: p2-r0}]] grows.")),
            vec![(Some(2), Some("p2-r0"), "[[cite:{page: 2, blockId: p2-r0}]]")],
        );
        assert_eq!(summary(&parse_citations(r#"See [[cite:{"page":3}]] too."#)), vec![(Some(3), None, r#"[[cite:{"page":3}]]"#)]);
        assert_eq!(
            summary(&parse_citations(r#"Block only [[cite:{"blockId":"p9-r9"}]] here."#)),
            vec![(None, Some("p9-r9"), r#"[[cite:{"blockId":"p9-r9"}]]"#)],
        );
    }

    #[test]
    fn unknown_syntax_stays_prose() {
        for text in [
            r#"Broken [[cite:{"kind":"page"}]] marker."#,
            "[[cite:]]",
            "[p]",
            "[p12:]",
            "[p12:3]",
            "[p1234567]",
            "[#]",
            "[#a b]",
            "[#a/b]",
            "(trang)",
            "(page 12)",
            "cite [12] and [x12].",
        ] {
            assert!(parse_citations(text).is_empty(), "{text:?} should not parse as a citation");
        }
    }

    #[test]
    fn page_zero_parses_and_is_left_for_the_document() {
        // The web reader parses `[p0]` and lets resolution reject it; so does this.
        assert_eq!(summary(&parse_citations("Page [p0] is not a page.")), vec![(Some(0), None, "[p0]")]);
        // A page that does not fit the citation model is not a citation at all.
        assert!(parse_citations("Page [p70000] is not a page.").is_empty());
    }

    #[test]
    fn duplicates_collapse_in_first_appearance_order() {
        let text = "A [p2] B (trang 2) C [#p2-r0] D [p2:r0] E [P2]";
        assert_eq!(
            summary(&parse_citations(text)),
            vec![(Some(2), None, "[p2]"), (Some(2), Some("p2-r0"), "[#p2-r0]")],
        );
    }

    #[test]
    fn a_message_without_citations_has_an_empty_slice() {
        let messages = vec![answer(true, "What is on page two?"), answer(false, "Nothing to point at.")];
        assert!(citations_in(&messages, 0).is_empty());
        assert!(citations_in(&messages, 1).is_empty());
        assert!(citations_in(&messages, 9).is_empty());
    }

    #[test]
    fn an_answer_reads_its_citations_from_the_text() {
        let mut message = answer(false, "See [p4:r1] and (trang 4).");
        message.refresh_citations();
        assert_eq!(summary(&message.citations), vec![(Some(4), Some("p4-r1"), "[p4:r1]"), (Some(4), None, "(trang 4)")]);
        assert_eq!(message.text, "See [p4:r1] and (trang 4).", "the markers stay in the answer");

        let messages = vec![message];
        assert_eq!(citations_in(&messages, 0)[0].page, Some(4));
        assert_eq!(citations_in(&messages, 0)[0].block_id.as_deref(), Some("p4-r1"));
    }

    #[test]
    fn a_question_keeps_no_citations() {
        let mut message = answer(true, "Does [p3] hold?");
        message.refresh_citations();
        assert!(message.citations.is_empty());
        assert_eq!(message.text, "Does [p3] hold?");
    }

    #[test]
    fn citations_survive_the_stored_history() {
        let question = answer(true, "What is on page 2?");
        let mut reply = answer(false, "As shown [p2:r0] and (trang 4).");
        reply.refresh_citations();
        let stored = StoredChat { messages: vec![question, reply.clone()] };

        let json = serde_json::to_vec_pretty(&stored).unwrap();
        let loaded: StoredChat = serde_json::from_slice(&json).unwrap();
        assert_eq!(loaded.messages[1].text, reply.text);
        assert_eq!(loaded.messages[1].citations, reply.citations);
        assert!(loaded.messages[0].citations.is_empty(), "a question is not serialised with citations");

        // Reloading re-derives the same list, so a load cannot drift from the text.
        let mut reloaded = loaded.messages[1].clone();
        reloaded.refresh_citations();
        assert_eq!(reloaded.citations, reply.citations);
    }

    #[test]
    fn a_history_written_before_citations_still_reads() {
        let json = br#"{"messages":[{"user":false,"text":"See [p4]."}]}"#;
        let loaded: StoredChat = serde_json::from_slice(json).unwrap();
        assert!(loaded.messages[0].citations.is_empty(), "the field is absent in an old file");
        let mut message = loaded.messages[0].clone();
        message.refresh_citations();
        assert_eq!(summary(&message.citations), vec![(Some(4), None, "[p4]")]);
    }

    #[test]
    fn a_document_question_carries_the_citation_contract() {
        let messages = vec![answer(true, "Summarize this page")];
        let history = request_history(&messages, true);
        assert_eq!(history.len(), 2);
        assert!(history[0].0, "the contract travels as a user turn");
        assert!(history[0].1.contains("[p12]"));
        assert!(history[0].1.contains("[p12:r3]"));
        assert_eq!(history[1].1, "Summarize this page");
        assert_eq!(messages.len(), 1, "the contract never becomes a stored message");

        assert_eq!(request_history(&messages, false).len(), 1, "no document, no contract");
    }

    #[test]
    fn the_instruction_examples_are_what_the_parser_reads() {
        // Whatever the interface language, the contract names both forms, and they
        // parse to the two citations the reader can draw a link for.
        assert_eq!(
            summary(&parse_citations(citation_instruction())),
            vec![(Some(12), None, "[p12]"), (Some(12), Some("p12-r3"), "[p12:r3]")],
        );
    }
}
