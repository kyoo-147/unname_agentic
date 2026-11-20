//! 语音输入 — opt-in dictation into the chat composer.
//!
//! Nothing here starts on its own: the mic button is the only entry point, and
//! pressing it again stops. Recognition is local (`Windows.Media.SpeechRecognition`
//! on Windows; the process keeps the audio and the text, nothing is uploaded),
//! and a recognised sentence goes straight into the composer — it is never sent.
//!
//! The session is a pure state machine ([`VoiceState::reduce`]) so the phases,
//! the failures and the text insertion are unit-tested without a microphone.
//! Only the [`engine`] submodule touches WinRT, on its own thread, and it reports
//! through a channel; `debug_assertions` builds additionally honour
//! `PDF_WORKSPACE_VOICE_STUB` so the UI states can be exercised headlessly.

use crate::app::Workspace;
use crate::i18n::tr3;
use gpui::{Context, Task};

/// The phases of one dictation session.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Phase {
    #[default]
    Idle,
    /// The recogniser is being created; the microphone is not open yet.
    Starting,
    /// The microphone is open and the recogniser is listening.
    Listening,
    /// Stopping: waiting for the sentence in flight, then the session ends.
    Finalising,
    /// The session failed; [`VoiceState::error`] says why.
    Error,
}

impl Phase {
    /// Starting, listening or finishing: the mic button is a stop button.
    pub fn is_active(self) -> bool {
        matches!(self, Self::Starting | Self::Listening | Self::Finalising)
    }
}

/// Why a session could not run, or why it failed while running.
///
/// The variants carry the *kind*; [`VoiceError::message`] turns that into a
/// translated sentence, and the technical detail (an HRESULT and the engine's
/// own text) travels next to it, never as the user-facing label.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VoiceError {
    /// Not Windows, or a Windows build whose speech stack is not registered.
    Unsupported,
    /// The speech class could not be created (no instance, no language pack).
    Unavailable(String),
    /// No capture device.
    NoMicrophone,
    /// Windows privacy settings block desktop apps from the microphone.
    PermissionDenied,
    /// The engine heard something but not words (too quiet, too loud, noisy).
    AudioProblem,
    /// Anything else the engine reported.
    Failed(String),
}

impl VoiceError {
    /// The user-facing sentence, in the interface language.
    pub fn message(&self) -> String {
        let headline = match self {
            Self::Unsupported => tr3(
                "语音输入需要 Windows 10 或更高版本。",
                "Voice input needs Windows 10 or later.",
                "Nhập bằng giọng nói cần Windows 10 trở lên.",
            ),
            Self::Unavailable(_) => tr3(
                "无法启动语音识别。请在 Windows 设置中安装语音语言包。",
                "Speech recognition could not start. Install a speech language in Windows Settings.",
                "Không khởi động được nhận dạng giọng nói. Hãy cài gói ngôn ngữ nói trong Cài đặt Windows.",
            ),
            Self::NoMicrophone => tr3(
                "未找到麦克风。请连接麦克风后重试。",
                "No microphone was found. Connect one and try again.",
                "Không tìm thấy micrô. Hãy kết nối micrô rồi thử lại.",
            ),
            Self::PermissionDenied => tr3(
                "麦克风权限被拒绝。请在 Windows 设置 › 隐私中允许桌面应用使用麦克风。",
                "Microphone access is denied. Allow desktop apps to use the microphone in Windows Settings › Privacy.",
                "Quyền dùng micrô bị từ chối. Hãy cho phép ứng dụng máy tính dùng micrô trong Cài đặt Windows › Quyền riêng tư.",
            ),
            Self::AudioProblem => tr3(
                "听不清。请靠近麦克风、放慢语速后重试。",
                "Could not hear you clearly. Move closer to the microphone and speak more slowly.",
                "Không nghe rõ. Hãy lại gần micrô và nói chậm hơn.",
            ),
            Self::Failed(_) => tr3(
                "语音识别失败。请重试。",
                "Speech recognition failed. Try again.",
                "Nhận dạng giọng nói thất bại. Hãy thử lại.",
            ),
        };
        match self {
            Self::Unavailable(detail) | Self::Failed(detail) if !detail.is_empty() => format!("{headline} ({detail})"),
            _ => headline.to_string(),
        }
    }
}

/// The phases, the sentences recognised this session, and the live hypothesis.
///
/// Everything the UI needs to draw the listening indicator or the failure is
/// reachable through the accessors; nothing here knows about GPUI or WinRT.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VoiceState {
    phase: Phase,
    /// Sentences the engine finalised this session, joined in order.
    transcript: String,
    /// The interim hypothesis: shown while listening, never inserted.
    interim: String,
    error: Option<VoiceError>,
}

/// What moved the state machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VoiceEvent {
    /// The mic button: start, or stop a running session.
    Toggle,
    /// Dismiss the failure and go back to idle.
    Dismiss,
    /// The recogniser exists and the microphone is open.
    Ready,
    /// An interim hypothesis (shown, not inserted).
    Partial(String),
    /// A final sentence: inserted into the composer.
    Final(String),
    /// The engine thread ended; `Some` says how it failed.
    Ended(Option<VoiceError>),
}

/// What the caller must do after a transition — the only side effects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VoiceEffect {
    /// Create the recogniser and open the microphone.
    StartEngine,
    /// Close the microphone.
    StopEngine,
    /// Append this sentence to the chat composer (never send it).
    Insert(String),
}

impl VoiceState {
    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn error(&self) -> Option<&VoiceError> {
        self.error.as_ref()
    }
    pub fn interim(&self) -> &str {
        &self.interim
    }
    /// The sentences recognised so far, without the live hypothesis.
    pub fn transcript(&self) -> &str {
        &self.transcript
    }
    /// The one-line state label, translated.
    pub fn label(&self) -> &'static str {
        match self.phase {
            Phase::Idle => tr3("语音输入", "Voice input", "Nhập bằng giọng nói"),
            Phase::Starting => tr3("正在打开麦克风…", "Opening the microphone…", "Đang mở micrô…"),
            Phase::Listening => tr3("正在聆听… 请说话", "Listening… speak now", "Đang nghe… hãy nói"),
            Phase::Finalising => tr3("正在结束…", "Finishing…", "Đang kết thúc…"),
            Phase::Error => tr3("语音输入不可用", "Voice input is unavailable", "Không dùng được nhập bằng giọng nói"),
        }
    }
    /// The hint next to the indicator while the microphone is open.
    pub fn hint(&self) -> &'static str {
        match self.phase {
            Phase::Starting => tr3("请稍候…", "One moment…", "Vui lòng đợi…"),
            Phase::Listening => tr3("再次点击麦克风即可停止", "Click the microphone again to stop", "Nhấn micrô lần nữa để dừng"),
            Phase::Finalising => tr3("正在收尾…", "Wrapping up…", "Đang hoàn tất…"),
            Phase::Idle | Phase::Error => "",
        }
    }

    /// The transition function: state + event -> state + the side effects to run.
    ///
    /// Transitions that do not apply to the current phase are ignored, so a late
    /// `Ready` from a stopped session, or a sentence arriving after the user
    /// dismissed the failure, cannot corrupt the next session.
    pub fn reduce(&mut self, event: VoiceEvent) -> Vec<VoiceEffect> {
        match event {
            VoiceEvent::Toggle => match self.phase {
                Phase::Idle | Phase::Error => {
                    self.error = None;
                    self.transcript.clear();
                    self.interim.clear();
                    self.phase = Phase::Starting;
                    vec![VoiceEffect::StartEngine]
                }
                Phase::Starting | Phase::Listening => {
                    self.interim.clear();
                    self.phase = Phase::Finalising;
                    vec![VoiceEffect::StopEngine]
                }
                // Already stopping: the engine reports the end once.
                Phase::Finalising => Vec::new(),
            },
            VoiceEvent::Dismiss => {
                if self.phase == Phase::Error {
                    self.error = None;
                    self.phase = Phase::Idle;
                }
                Vec::new()
            }
            VoiceEvent::Ready => {
                if self.phase == Phase::Starting {
                    self.phase = Phase::Listening;
                }
                Vec::new()
            }
            VoiceEvent::Partial(text) => {
                if matches!(self.phase, Phase::Starting | Phase::Listening) {
                    self.phase = Phase::Listening;
                    self.interim = text;
                }
                Vec::new()
            }
            VoiceEvent::Final(text) => {
                let text = text.trim().to_string();
                if text.is_empty() || !matches!(self.phase, Phase::Starting | Phase::Listening | Phase::Finalising) {
                    return Vec::new();
                }
                if !self.transcript.is_empty() {
                    self.transcript.push(' ');
                }
                self.transcript.push_str(&text);
                self.interim.clear();
                vec![VoiceEffect::Insert(text)]
            }
            VoiceEvent::Ended(error) => {
                self.interim.clear();
                match error {
                    Some(error) => {
                        self.phase = Phase::Error;
                        self.error = Some(error);
                    }
                    None => {
                        self.phase = Phase::Idle;
                    }
                }
                Vec::new()
            }
        }
    }
}

/// The dictation session owned by the workspace: state machine plus the channel
/// to the recogniser thread. `None` engine means no microphone is open.
pub struct Voice {
    state: VoiceState,
    engine: Option<engine::Engine>,
    /// Kept alive for the life of the session; dropping it stops the pump.
    _pump: Option<Task<()>>,
}

impl Default for Voice {
    fn default() -> Self {
        Self { state: VoiceState::default(), engine: None, _pump: None }
    }
}

impl Voice {
    pub fn state(&self) -> &VoiceState {
        &self.state
    }
}

/// The recogniser thread. Only WinRT lives here; everything it learns arrives as
/// [`VoiceEvent`]s, so the UI never blocks on the microphone.
mod engine {
    use super::{VoiceError, VoiceEvent};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
    use std::thread::JoinHandle;

    pub(super) type Body = Box<dyn FnOnce(Sender<VoiceEvent>, Arc<AtomicBool>) + Send>;

    /// A started recogniser thread and the events it has produced.
    pub struct Engine {
        events: Receiver<VoiceEvent>,
        stop: Arc<AtomicBool>,
        finished: bool,
        _thread: Option<JoinHandle<()>>,
    }

    impl Engine {
        /// Everything the thread has said since the last poll.
        pub fn poll(&mut self) -> Vec<VoiceEvent> {
            let mut events = Vec::new();
            loop {
                match self.events.try_recv() {
                    Ok(event) => events.push(event),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        self.finished = true;
                        break;
                    }
                }
            }
            events
        }
        pub fn stop(&self) {
            self.stop.store(true, Ordering::Relaxed);
        }
        /// True once the thread ended and its last event has been returned.
        pub fn finished(&self) -> bool {
            self.finished
        }
    }

    impl Drop for Engine {
        fn drop(&mut self) {
            self.stop();
        }
    }

    /// Runs `body` on a named thread. A thread that cannot start still reports
    /// through the same channel, so the caller has exactly one failure path.
    pub(super) fn spawn(body: Body) -> Engine {
        let (events, receiver) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let events = events.clone();
            let stop = stop.clone();
            std::thread::Builder::new().name("voice-recognizer".into()).spawn(move || body(events, stop))
        };
        match thread {
            Ok(thread) => Engine { events: receiver, stop, finished: false, _thread: Some(thread) },
            Err(error) => {
                events.send(VoiceEvent::Ended(Some(VoiceError::Failed(format!("recogniser thread: {error}"))))).ok();
                Engine { events: receiver, stop, finished: false, _thread: None }
            }
        }
    }

    /// Starts recognition from the default microphone. Opt-in only: this runs
    /// because the user pressed the mic button, never on its own.
    pub fn start() -> Engine {
        #[cfg(debug_assertions)]
        if let Some(script) = std::env::var_os("PDF_WORKSPACE_VOICE_STUB") {
            return spawn(stub::script(&script.to_string_lossy()));
        }
        spawn(Box::new(platform))
    }

    #[cfg(windows)]
    fn platform(events: Sender<VoiceEvent>, stop: Arc<AtomicBool>) {
        let outcome = listen(&events, &stop);
        events.send(VoiceEvent::Ended(outcome.err())).ok();
    }

    #[cfg(not(windows))]
    fn platform(events: Sender<VoiceEvent>, _stop: Arc<AtomicBool>) {
        events.send(VoiceEvent::Ended(Some(VoiceError::Unsupported))).ok();
    }

    /// The one-shot recognition loop: each sentence is one `RecognizeAsync`, and
    /// the loop repeats until the user stops. One-shot keeps the session free of
    /// UI-thread event pumping, which a plain desktop process does not have.
    #[cfg(windows)]
    fn listen(events: &Sender<VoiceEvent>, stop: &AtomicBool) -> Result<(), VoiceError> {
        use windows::Media::SpeechRecognition::{SpeechRecognitionResultStatus, SpeechRecognizer};
        let recognizer = SpeechRecognizer::new().map_err(|error| classify(&error))?;
        // Free dictation: no constraints, so the system's dictation grammar is
        // compiled once for the whole session.
        let compiled = recognizer.CompileConstraintsAsync().map_err(|error| classify(&error))?.join().map_err(|error| classify(&error))?;
        match compiled.Status().map_err(|error| classify(&error))? {
            SpeechRecognitionResultStatus::Success => {}
            status => return Err(VoiceError::Unavailable(format!("grammar {status:?}"))),
        }
        events.send(VoiceEvent::Ready).ok();
        while !stop.load(Ordering::Relaxed) {
            let result = recognizer.RecognizeAsync().map_err(|error| classify(&error))?.join().map_err(|error| classify(&error))?;
            match result.Status().map_err(|error| classify(&error))? {
                SpeechRecognitionResultStatus::Success => {
                    let text = result.Text().map(|text| text.to_string()).unwrap_or_default();
                    if !text.trim().is_empty() {
                        events.send(VoiceEvent::Final(text)).ok();
                    }
                }
                // Silence, a pause, or the first-silence timeout: keep listening.
                SpeechRecognitionResultStatus::TimeoutExceeded | SpeechRecognitionResultStatus::PauseLimitExceeded => {}
                SpeechRecognitionResultStatus::UserCanceled => break,
                SpeechRecognitionResultStatus::AudioQualityFailure => return Err(VoiceError::AudioProblem),
                SpeechRecognitionResultStatus::MicrophoneUnavailable => return Err(VoiceError::NoMicrophone),
                status @ (SpeechRecognitionResultStatus::TopicLanguageNotSupported | SpeechRecognitionResultStatus::GrammarLanguageMismatch) => {
                    return Err(VoiceError::Unavailable(format!("language {status:?}")));
                }
                status => return Err(VoiceError::Failed(format!("result {status:?}"))),
            }
        }
        recognizer.Close().ok();
        Ok(())
    }

    /// The kind of failure matters for the message; the raw HRESULT is kept as
    /// detail for the log and for support. `E_ACCESSDENIED` is the privacy
    /// switch, `0x80045513` is the speech stack's own access-denied, and
    /// `REGDB_E_CLASSNOTREG` means this Windows build has no speech class.
    #[cfg(windows)]
    fn classify(error: &windows::core::Error) -> VoiceError {
        let detail = format!("0x{:08X}", error.code().0 as u32);
        let message = error.message().to_lowercase();
        if detail == "0x80040154" || message.contains("class not registered") {
            return VoiceError::Unsupported;
        }
        if detail == "0x80070005" || detail == "0x80045513" || message.contains("access is denied") || message.contains("denied") {
            return VoiceError::PermissionDenied;
        }
        if message.contains("microphone") || message.contains("audio") || message.contains("capture device") || message.contains("no device") {
            return VoiceError::NoMicrophone;
        }
        VoiceError::Unavailable(detail)
    }

    #[cfg(debug_assertions)]
    pub mod stub {
        //! `PDF_WORKSPACE_VOICE_STUB` drives the same event stream as WinRT, so
        //! the listening and failure states can be photographed (and tested)
        //! without a microphone. Debug builds only.
        use super::*;
        use std::sync::atomic::Ordering;
        use std::time::Duration;

        fn text() -> String {
            std::env::var("PDF_WORKSPACE_VOICE_STUB_TEXT").unwrap_or_else(|_| "Tóm tắt trang này giúp tôi.".to_string())
        }

        pub fn script(value: &str) -> Body {
            let mode = value.trim().to_lowercase();
            Box::new(move |events: Sender<VoiceEvent>, stop: Arc<AtomicBool>| match mode.as_str() {
                "error" => {
                    std::thread::sleep(Duration::from_millis(250));
                    events.send(VoiceEvent::Ended(Some(VoiceError::NoMicrophone))).ok();
                }
                "final" => {
                    events.send(VoiceEvent::Ready).ok();
                    std::thread::sleep(Duration::from_millis(400));
                    events.send(VoiceEvent::Final(text())).ok();
                    while !stop.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(60));
                    }
                    events.send(VoiceEvent::Ended(None)).ok();
                }
                // "listening" and anything else: a live hypothesis that keeps
                // changing, so the indicator is visible in a still frame.
                _ => {
                    events.send(VoiceEvent::Ready).ok();
                    let phrase = text();
                    let words: Vec<&str> = phrase.split_whitespace().collect();
                    let mut tick = 0;
                    while !stop.load(Ordering::Relaxed) {
                        let take = (1 + tick % words.len().max(1)).min(words.len().max(1));
                        events.send(VoiceEvent::Partial(words[..take].join(" "))).ok();
                        tick += 1;
                        for _ in 0..6 {
                            if stop.load(Ordering::Relaxed) {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(50));
                        }
                    }
                    events.send(VoiceEvent::Ended(None)).ok();
                }
            })
        }
    }
}

impl Workspace {
    /// The mic button: start dictation, or stop a running session.
    pub fn voice_toggle(&mut self, cx: &mut Context<Self>) {
        let effects = self.voice.state.reduce(VoiceEvent::Toggle);
        self.voice_apply(effects, cx);
    }

    /// The dismiss action on the failure line.
    pub fn voice_dismiss(&mut self, cx: &mut Context<Self>) {
        let effects = self.voice.state.reduce(VoiceEvent::Dismiss);
        self.voice_apply(effects, cx);
    }

    fn voice_apply(&mut self, effects: Vec<VoiceEffect>, cx: &mut Context<Self>) {
        for effect in effects {
            match effect {
                VoiceEffect::StartEngine => {
                    self.voice.engine = Some(engine::start());
                    self.voice_spawn_pump(cx);
                }
                VoiceEffect::StopEngine => {
                    if let Some(engine) = &self.voice.engine {
                        engine.stop();
                    }
                }
                VoiceEffect::Insert(text) => {
                    self.chat.update(cx, |chat, cx| chat.append_composer(&text, cx));
                }
            }
        }
        cx.notify();
    }

    /// Polls the recogniser thread off the microphone's cadence: 120 ms is fine
    /// for interim text and keeps a GUI frame from waiting on the engine.
    fn voice_spawn_pump(&mut self, cx: &mut Context<Self>) {
        self.voice._pump = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(std::time::Duration::from_millis(120)).await;
                let Ok(done) = this.update(cx, |workspace, cx| workspace.voice_pump(cx)) else {
                    break;
                };
                if done {
                    break;
                }
            }
        }));
    }

    /// Drains the engine into the state machine; true when the session is over.
    fn voice_pump(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(engine) = self.voice.engine.as_mut() else {
            return true;
        };
        let events = engine.poll();
        let finished = engine.finished();
        if events.is_empty() && !finished {
            return false;
        }
        let was_active = self.voice.state.phase().is_active();
        let mut ended = false;
        for event in events {
            ended |= matches!(event, VoiceEvent::Ended(_));
            let effects = self.voice.state.reduce(event);
            self.voice_apply(effects, cx);
        }
        // A thread that died without reporting still ends the session, but never
        // overwrites a failure it did report.
        if finished {
            if !ended {
                let effects = self.voice.state.reduce(VoiceEvent::Ended(None));
                self.voice_apply(effects, cx);
            }
            self.voice.engine = None;
        }
        let phase = self.voice.state.phase();
        let characters = self.voice.state.transcript().chars().count();
        if was_active && !phase.is_active() && phase != Phase::Error && characters > 0 {
            // The words are in the composer; show them rather than leaving them
            // on a page that has no text field.
            self.show_chat(cx);
            self.show_toast_kind(crate::ui::ToastKind::Success, &inserted_message(characters), cx);
        }
        finished
    }
}

/// The toast that follows a session which put words in the composer.
fn inserted_message(characters: usize) -> String {
    crate::i18n::tr3_fill("已将 {} 个字符加入输入框", "{} characters added to the composer", "Đã thêm {} ký tự vào ô soạn", characters)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn started() -> VoiceState {
        let mut state = VoiceState::default();
        assert_eq!(state.reduce(VoiceEvent::Toggle), vec![VoiceEffect::StartEngine]);
        state
    }

    fn wait(engine: &mut engine::Engine, wanted: impl Fn(&VoiceEvent) -> bool) -> Vec<VoiceEvent> {
        let mut seen = Vec::new();
        for _ in 0..200 {
            for event in engine.poll() {
                let hit = wanted(&event);
                seen.push(event);
                if hit {
                    return seen;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        panic!("the stubbed engine never produced the expected event; saw {seen:?}");
    }

    #[test]
    fn toggle_starts_only_after_a_press() {
        let mut state = VoiceState::default();
        assert_eq!(state.phase(), Phase::Idle);
        assert_eq!(state.reduce(VoiceEvent::Toggle), vec![VoiceEffect::StartEngine]);
        assert_eq!(state.phase(), Phase::Starting);
        assert_eq!(state.reduce(VoiceEvent::Ready), vec![]);
        assert_eq!(state.phase(), Phase::Listening);
    }

    #[test]
    fn a_second_press_stops_and_ends_idle() {
        let mut state = started();
        state.reduce(VoiceEvent::Ready);
        assert_eq!(state.reduce(VoiceEvent::Toggle), vec![VoiceEffect::StopEngine]);
        assert_eq!(state.phase(), Phase::Finalising);
        state.reduce(VoiceEvent::Ended(None));
        assert_eq!(state.phase(), Phase::Idle);
        assert!(state.error().is_none());
    }

    #[test]
    fn interim_text_is_shown_but_never_inserted() {
        let mut state = started();
        state.reduce(VoiceEvent::Ready);
        assert_eq!(state.reduce(VoiceEvent::Partial("xin chào".into())), vec![]);
        assert_eq!(state.interim(), "xin chào");
        assert_eq!(state.transcript(), "");
    }

    #[test]
    fn final_sentences_are_inserted_in_order() {
        let mut state = started();
        state.reduce(VoiceEvent::Ready);
        state.reduce(VoiceEvent::Partial("tóm tắt".into()));
        assert_eq!(state.reduce(VoiceEvent::Final("Tóm tắt trang này.".into())), vec![VoiceEffect::Insert("Tóm tắt trang này.".into())]);
        assert_eq!(state.reduce(VoiceEvent::Final("  Giúp tôi.  ".into())), vec![VoiceEffect::Insert("Giúp tôi.".into())]);
        assert_eq!(state.transcript(), "Tóm tắt trang này. Giúp tôi.");
        assert_eq!(state.interim(), "");
        assert_eq!(state.phase(), Phase::Listening);
    }

    #[test]
    fn blank_results_are_dropped() {
        let mut state = started();
        state.reduce(VoiceEvent::Ready);
        assert!(state.reduce(VoiceEvent::Final("   ".into())).is_empty());
        assert_eq!(state.transcript(), "");
    }

    #[test]
    fn a_failure_is_visible_and_retryable() {
        let mut state = started();
        state.reduce(VoiceEvent::Ended(Some(VoiceError::NoMicrophone)));
        assert_eq!(state.phase(), Phase::Error);
        assert_eq!(state.error(), Some(&VoiceError::NoMicrophone));
        assert!(!state.label().is_empty());
        // Nothing produced after the failure can leak into the retry.
        assert!(state.reduce(VoiceEvent::Final("late".into())).is_empty());
        assert_eq!(state.transcript(), "");
        assert_eq!(state.reduce(VoiceEvent::Toggle), vec![VoiceEffect::StartEngine]);
        assert_eq!(state.phase(), Phase::Starting);
        assert!(state.error().is_none());
    }

    #[test]
    fn dismiss_clears_the_failure() {
        let mut state = started();
        state.reduce(VoiceEvent::Ended(Some(VoiceError::PermissionDenied)));
        state.reduce(VoiceEvent::Dismiss);
        assert_eq!(state.phase(), Phase::Idle);
        assert!(state.error().is_none());
    }

    #[test]
    fn a_late_ready_does_not_resurrect_a_stopped_session() {
        let mut state = started();
        state.reduce(VoiceEvent::Toggle); // stop before the engine was ready
        assert_eq!(state.phase(), Phase::Finalising);
        state.reduce(VoiceEvent::Ready);
        assert_eq!(state.phase(), Phase::Finalising);
    }

    #[test]
    fn every_failure_has_a_message_in_every_language() {
        let errors = [VoiceError::Unsupported, VoiceError::NoMicrophone, VoiceError::PermissionDenied, VoiceError::AudioProblem, VoiceError::Unavailable("0x80040154".into()), VoiceError::Failed("boom".into())];
        for error in errors {
            assert!(!error.message().is_empty());
        }
        // The detail rides next to the translated sentence, not inside it.
        assert!(VoiceError::Unavailable("0x80040154".into()).message().contains("0x80040154"));
    }

    #[test]
    fn the_stub_reports_a_microphone_failure() {
        let mut engine = engine::spawn(engine::stub::script("error"));
        let events = wait(&mut engine, |event| matches!(event, VoiceEvent::Ended(_)));
        assert_eq!(events, vec![VoiceEvent::Ended(Some(VoiceError::NoMicrophone))]);
        for _ in 0..80 {
            engine.poll();
            if engine.finished() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(engine.finished(), "the failure ends the session so the pump can stop");
    }

    #[test]
    fn the_stub_speaks_then_stops_on_request() {
        let mut engine = engine::spawn(engine::stub::script("final"));
        let events = wait(&mut engine, |event| matches!(event, VoiceEvent::Final(_)));
        assert!(events.contains(&VoiceEvent::Ready), "the stub announces a live microphone: {events:?}");
        assert!(events.iter().any(|event| matches!(event, VoiceEvent::Final(text) if !text.is_empty())));
        engine.stop();
        let ended = wait(&mut engine, |event| matches!(event, VoiceEvent::Ended(_)));
        assert!(ended.iter().any(|event| matches!(event, VoiceEvent::Ended(None))));
    }

    #[test]
    fn the_stub_listens_until_it_is_told_to_stop() {
        let mut engine = engine::spawn(engine::stub::script("listening"));
        let events = wait(&mut engine, |event| matches!(event, VoiceEvent::Partial(text) if !text.is_empty()));
        assert!(events.contains(&VoiceEvent::Ready));
        engine.stop();
        let ended = wait(&mut engine, |event| matches!(event, VoiceEvent::Ended(_)));
        assert!(ended.iter().any(|event| matches!(event, VoiceEvent::Ended(None))));
    }

    /// Not part of the gate: asks this machine's Windows speech stack whether the
    /// recogniser can be created and its grammar compiled from a plain desktop
    /// process. It deliberately does **not** open the microphone — a real capture
    /// needs a human in front of the device.
    #[test]
    #[ignore = "needs the Windows speech stack; run with --ignored to probe this machine"]
    #[cfg(windows)]
    fn probe_the_windows_speech_stack() {
        use windows::Media::SpeechRecognition::SpeechRecognizer;
        match SpeechRecognizer::new() {
            Ok(recognizer) => {
                let compiled = recognizer.CompileConstraintsAsync().map(|operation| operation.join());
                match compiled {
                    Ok(Ok(result)) => println!("SpeechRecognizer::new ok; grammar compile: {:?}", result.Status()),
                    Ok(Err(error)) => println!("SpeechRecognizer::new ok; compile failed: 0x{:08X} {}", error.code().0 as u32, error.message()),
                    Err(error) => println!("SpeechRecognizer::new ok; CompileConstraintsAsync refused: 0x{:08X} {}", error.code().0 as u32, error.message()),
                }
                recognizer.Close().ok();
            }
            Err(error) => println!("SpeechRecognizer::new failed: 0x{:08X} {}", error.code().0 as u32, error.message()),
        }
    }
}
