use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const STATE_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModuleId {
    RagCitations,
    ResearchWorkspace,
    OcrMarkup,
    TranslatedPdf,
}

impl ModuleId {
    pub const ALL: [Self; 4] = [
        Self::RagCitations,
        Self::ResearchWorkspace,
        Self::OcrMarkup,
        Self::TranslatedPdf,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Self::RagCitations => "intelligence-rag-citations",
            Self::ResearchWorkspace => "intelligence-research-workspace",
            Self::OcrMarkup => "intelligence-ocr-markup",
            Self::TranslatedPdf => "intelligence-translated-pdf",
        }
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::RagCitations => "RAG and citations",
            Self::ResearchWorkspace => "Research workspace",
            Self::OcrMarkup => "OCR and markup",
            Self::TranslatedPdf => "Translated PDF",
        }
    }

    pub fn status(self) -> ModuleStatus {
        match self {
            Self::RagCitations => ModuleStatus::Available(
                "Local lexical retrieval, citation verification, and reader navigation are connected.",
            ),
            Self::ResearchWorkspace => ModuleStatus::Available(
                "Local research cards, collections, proposals, and RIS round-trips are connected.",
            ),
            Self::OcrMarkup => ModuleStatus::Partial(
                "Local OCR is available in the PDF reader. Persistent markup integration is not connected.",
            ),
            Self::TranslatedPdf => ModuleStatus::Partial(
                "Translated PDF writing is connected as a new text-only artifact; source artwork and embedded fonts are not preserved.",
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModuleStatus {
    Available(&'static str),
    Partial(&'static str),
    Unavailable(&'static str),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct PersistedState {
    version: u32,
    selected: ModuleId,
    last_document: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Command {
    Select(ModuleId),
    RememberDocument(String),
    BeginOperation(String),
    CancelOperation(String),
    CompleteOperation(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandOutcome {
    Applied,
    Cancelled,
    Stale,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IntegrationState {
    selected: ModuleId,
    last_document: Option<String>,
    active_operation: Option<String>,
}

impl Default for IntegrationState {
    fn default() -> Self {
        Self {
            selected: ModuleId::RagCitations,
            last_document: None,
            active_operation: None,
        }
    }
}

impl IntegrationState {
    pub fn load(path: &Path) -> Self {
        let Ok(bytes) = std::fs::read(path) else {
            return Self::default();
        };
        let Ok(stored) = serde_json::from_slice::<PersistedState>(&bytes) else {
            return Self::default();
        };
        if stored.version != STATE_VERSION {
            return Self::default();
        }
        Self {
            selected: stored.selected,
            last_document: stored.last_document,
            active_operation: None,
        }
    }

    pub fn selected(&self) -> ModuleId {
        self.selected
    }
    pub fn last_document(&self) -> Option<&str> {
        self.last_document.as_deref()
    }
    pub fn active_operation(&self) -> Option<&str> {
        self.active_operation.as_deref()
    }

    pub fn dispatch(&mut self, command: Command) -> CommandOutcome {
        match command {
            Command::Select(module) => {
                self.selected = module;
                CommandOutcome::Applied
            }
            Command::RememberDocument(id) if !id.trim().is_empty() => {
                self.last_document = Some(id);
                CommandOutcome::Applied
            }
            Command::RememberDocument(_) => CommandOutcome::Stale,
            Command::BeginOperation(id) if !id.trim().is_empty() => {
                self.active_operation = Some(id);
                CommandOutcome::Applied
            }
            Command::BeginOperation(_) => CommandOutcome::Stale,
            Command::CancelOperation(id)
                if self.active_operation.as_deref() == Some(id.as_str()) =>
            {
                self.active_operation = None;
                CommandOutcome::Cancelled
            }
            Command::CompleteOperation(id)
                if self.active_operation.as_deref() == Some(id.as_str()) =>
            {
                self.active_operation = None;
                CommandOutcome::Applied
            }
            Command::CancelOperation(_) | Command::CompleteOperation(_) => CommandOutcome::Stale,
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temporary = temp_path(path);
        let bytes = serde_json::to_vec(&PersistedState {
            version: STATE_VERSION,
            selected: self.selected,
            last_document: self.last_document.clone(),
        })
        .map_err(std::io::Error::other)?;
        let result = (|| {
            use std::io::Write;
            let mut file = std::fs::File::create(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            std::fs::rename(&temporary, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}

fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state.json");
    path.with_file_name(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "pdf-workspace-intelligence-{}-{name}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn commands_select_routes_and_reject_stale_cancellation() {
        let mut state = IntegrationState::default();
        assert_eq!(
            state.dispatch(Command::Select(ModuleId::ResearchWorkspace)),
            CommandOutcome::Applied
        );
        assert_eq!(state.selected(), ModuleId::ResearchWorkspace);
        assert_eq!(
            state.dispatch(Command::BeginOperation("op-2".into())),
            CommandOutcome::Applied
        );
        assert_eq!(
            state.dispatch(Command::CancelOperation("op-1".into())),
            CommandOutcome::Stale
        );
        assert_eq!(state.active_operation(), Some("op-2"));
        assert_eq!(
            state.dispatch(Command::CancelOperation("op-2".into())),
            CommandOutcome::Cancelled
        );
        assert_eq!(state.active_operation(), None);
    }

    #[test]
    fn selected_module_and_document_survive_reload_but_running_work_does_not() {
        let file = path("state.json");
        let mut state = IntegrationState::default();
        state.dispatch(Command::Select(ModuleId::OcrMarkup));
        state.dispatch(Command::RememberDocument("local-doc-42".into()));
        state.dispatch(Command::BeginOperation("interrupted".into()));
        state.save(&file).unwrap();
        state.dispatch(Command::Select(ModuleId::TranslatedPdf));
        state.save(&file).unwrap();
        let restored = IntegrationState::load(&file);
        assert_eq!(restored.selected(), ModuleId::TranslatedPdf);
        assert_eq!(restored.last_document(), Some("local-doc-42"));
        assert_eq!(
            restored.active_operation(),
            None,
            "work is not resumed after a crash/restart"
        );
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn capability_status_is_explicit_for_each_native_module() {
        assert!(matches!(ModuleId::RagCitations.status(), ModuleStatus::Available(_)));
        assert!(matches!(ModuleId::ResearchWorkspace.status(), ModuleStatus::Available(_)));
        assert!(matches!(ModuleId::TranslatedPdf.status(), ModuleStatus::Partial(_)));
        assert!(matches!(
            ModuleId::OcrMarkup.status(),
            ModuleStatus::Partial(_)
        ));
    }

    #[test]
    fn bridge_handoff_remembers_only_the_verified_local_document_id() {
        let mut state = IntegrationState::default();
        assert_eq!(
            state.dispatch(Command::RememberDocument("verified-library-id".into())),
            CommandOutcome::Applied
        );
        assert_eq!(state.last_document(), Some("verified-library-id"));
        assert_eq!(
            state.dispatch(Command::RememberDocument("  ".into())),
            CommandOutcome::Stale
        );
        assert_eq!(state.last_document(), Some("verified-library-id"));
    }

    #[test]
    fn view_contract_is_stable_and_status_matches_each_module() {
        assert_eq!(
            ModuleId::ALL.map(ModuleId::title),
            [
                "RAG and citations",
                "Research workspace",
                "OCR and markup",
                "Translated PDF"
            ]
        );
        assert!(
            ModuleId::ALL
                .iter()
                .all(|module| !module.status().message().is_empty())
        );
    }

    impl ModuleStatus {
        fn message(self) -> &'static str {
            match self {
                Self::Available(message) | Self::Partial(message) | Self::Unavailable(message) => message,
            }
        }
    }
}
