use crate::i18n::tr3;
use crate::input::{TextField, TextFieldEvent};
use crate::theme::{self, Theme};
use crate::ui;
use gpui::{prelude::FluentBuilder, *};
use mirror_pdf_desktop::{model, provider};

#[derive(Clone)]
pub struct ChatMessage {
    pub user: bool,
    pub text: String,
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
        Self { input, messages: Vec::new(), busy: false, error: None, context: None, _submit: submit }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.input.read(cx).focus_handle(cx));
    }

    pub fn set_context(&mut self, context: Option<(String, String)>, cx: &mut Context<Self>) {
        if self.context != context {
            self.messages.clear();
            self.error = None;
            self.context = context;
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
        self.input.update(cx, |field, cx| field.set_text("", cx));
        self.busy = true;
        self.error = None;
        cx.notify();

        let history: Vec<(bool, String)> = self.messages.iter().map(|message| (message.user, message.text.clone())).collect();
        let context = self.context.clone();
        let task = cx.background_executor().spawn(async move {
            let mut settings = model::load_settings();
            settings.provider.api_key = provider::load_key(settings.provider.kind).unwrap_or_default();
            let context = context.as_ref().map(|(title, text)| (title.as_str(), text.as_str()));
            provider::chat(&settings.provider, &history, context).map_err(|error| format!("{error:#}"))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |chat, cx| {
                chat.busy = false;
                match result {
                    Ok(answer) => chat.messages.push(ChatMessage { user: false, text: answer }),
                    Err(error) => chat.error = Some(error),
                }
                cx.notify();
            });
        }).detach();
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
                .when(messages.is_empty(), |element| element.child(div().text_color(Theme::text_caption()).text_size(px(13.)).child(tr3(
                    "Hỏi về cách dùng, hoặc mở một PDF để đọc song song.",
                    "Ask how to use the workspace, or open a PDF to read side by side.",
                    "Hỏi về cách dùng, hoặc mở một PDF để đọc song song.",
                ))))
                .children(messages)
                .when(self.busy, |element| element.child(div().text_color(Theme::text_caption()).text_size(px(12.)).child(tr3("Đang trả lời…", "Answering…", "Đang trả lời…"))))
                .when_some(self.error.clone(), |element, error| element.child(div().text_color(Theme::danger()).text_size(px(12.)).child(error))))
            .child(div().flex_none().border_t_1().border_color(Theme::line_border()).px(px(24.)).py(px(14.))
                .child(div().max_w(px(760.)).w_full().flex().items_center().gap(px(8.)).p(px(6.)).rounded(px(10.)).border_1().border_color(Theme::line_border()).bg(Theme::bg_overlay())
                    .child(div().flex_1().min_w_0().child(self.input.clone()))
                    .child(ui::primary_button("chat-send", tr3("Gửi", "Send", "Gửi")).on_click(cx.listener(|chat, _, _, cx| chat.send(cx))))))
    }
}
