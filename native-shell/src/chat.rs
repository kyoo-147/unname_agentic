use crate::i18n::tr3;
use crate::input::{TextField, TextFieldEvent};
use crate::theme::{self, Theme};
use crate::ui;
use gpui::{prelude::FluentBuilder, *};
use mirror_pdf_desktop::{model, provider};
use serde::{Deserialize, Serialize};
use std::sync::mpsc::{self, TryRecvError};

enum StreamEvent { Delta(String), Done(String), Failed(String) }

#[derive(Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub user: bool,
    pub text: String,
}

#[derive(Default, Serialize, Deserialize)]
struct StoredChat {
    messages: Vec<ChatMessage>,
}

fn history_path() -> std::path::PathBuf { model::data_directory().join("chat.json") }

fn load_history() -> Vec<ChatMessage> {
    std::fs::read(history_path()).ok()
        .and_then(|bytes| serde_json::from_slice::<StoredChat>(&bytes).ok())
        .map(|stored| stored.messages.into_iter().rev().take(100).rev().collect())
        .unwrap_or_default()
}

pub struct Chat {
    input: Entity<TextField>,
    messages: Vec<ChatMessage>,
    busy: bool,
    error: Option<String>,
    context: Option<(String, String)>,
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
        Self { input, messages: load_history(), busy: false, error: None, context: None, _submit: submit }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.input.read(cx).focus_handle(cx));
    }

    fn persist(&self) {
        let stored = StoredChat { messages: self.messages.iter().rev().take(100).rev().cloned().collect() };
        if let Some(directory) = history_path().parent() { let _ = std::fs::create_dir_all(directory); }
        if let Ok(json) = serde_json::to_vec_pretty(&stored) { let _ = std::fs::write(history_path(), json); }
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

    pub fn ask(&mut self, prompt: String, cx: &mut Context<Self>) {
        self.input.update(cx, |field, cx| field.set_text(&prompt, cx));
        self.send(cx);
    }

    fn send(&mut self, cx: &mut Context<Self>) {
        let question = self.input.read(cx).text.trim().to_string();
        if question.is_empty() || self.busy { return; }
        self.messages.push(ChatMessage { user: true, text: question });
        self.persist();
        self.input.update(cx, |field, cx| field.set_text("", cx));
        self.busy = true;
        self.error = None;
        cx.notify();

        let history: Vec<(bool, String)> = self.messages.iter().map(|message| (message.user, message.text.clone())).collect();
        self.messages.push(ChatMessage { user: false, text: String::new() });
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
                            if let Some(message) = chat.messages.last_mut() { message.text = full.clone(); }
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
            .into_any_element()
    }
}

impl Render for Chat {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let messages = self.messages.iter().map(|message| self.message_bubble(message)).collect::<Vec<_>>();
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
                .when_some(self.context.as_ref().map(|(title, _)| title.clone()), |element, title| element.child(
                    div().mt(px(8.)).flex().items_center().gap(px(6.)).text_size(px(12.)).text_color(Theme::text_caption())
                        .child(format!("{} {title}", tr3("Đang hỏi về:", "Asking about:", "Đang hỏi về:")))
                        .child(div().id("chat-clear-context").size(px(18.)).flex().items_center().justify_center().rounded(px(4.)).cursor_pointer().hover(|s| s.bg(Theme::fill_hover())).child("×")
                            .on_click(cx.listener(|chat, _, _, cx| chat.set_context(None, cx))))))
            .child(div().id("chat-messages").flex_1().min_h_0().overflow_y_scroll().px(px(24.)).py(px(20.))
                .flex().flex_col().gap(px(10.))
                .when(messages.is_empty(), |element| element.child(div().flex().flex_col().gap(px(10.)).child(div().text_color(Theme::text_caption()).text_size(px(13.)).child(tr3(
                    "Hỏi về cách dùng, hoặc mở một PDF để đọc song song.",
                    "Ask how to use the workspace, or open a PDF to read side by side.",
                    "Hỏi về cách dùng, hoặc mở một PDF để đọc song song.",
                ))).children(self.suggestions(cx))))
                .children(messages)
                .when(self.busy, |element| element.child(div().text_color(Theme::text_caption()).text_size(px(12.)).child(tr3("Đang trả lời…", "Answering…", "Đang trả lời…"))))
                .when_some(self.error.clone(), |element, error| element.child(div().text_color(Theme::danger()).text_size(px(12.)).child(error))))
            .child(div().flex_none().border_t_1().border_color(Theme::line_border()).px(px(24.)).py(px(14.))
                .child(div().max_w(px(760.)).w_full().flex().items_center().gap(px(8.)).p(px(6.)).rounded(px(10.)).border_1().border_color(Theme::line_border()).bg(Theme::bg_overlay())
                    .child(div().flex_1().min_w_0().child(self.input.clone()))
                    .child(ui::primary_button("chat-send", tr3("Gửi", "Send", "Gửi")).on_click(cx.listener(|chat, _, _, cx| chat.send(cx))))))
    }
}
