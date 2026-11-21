use image::RgbaImage;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::VecDeque, path::PathBuf};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct BlockRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl BlockRect {
    pub fn at_size(self, width: f32, height: f32) -> [f32; 4] {
        [self.x * width, self.y * height, self.width * width, self.height * height]
    }
    pub fn is_valid(self) -> bool {
        [self.x, self.y, self.width, self.height].iter().all(|n| n.is_finite()) && self.width > 0.0 && self.height > 0.0 && self.x >= -0.01 && self.y >= -0.01 && self.x + self.width <= 1.02 && self.y + self.height <= 1.02
    }
}

#[derive(Clone, Debug)]
pub struct TextBlock {
    pub id: u64,
    pub source: String,
    pub translated: Option<String>,
    pub rect: BlockRect,
    pub background: Option<[u8; 3]>,
    pub font_size: f32,
    pub bold: bool,
}

#[derive(Clone)]
pub struct PageFrame {
    pub original: RgbaImage,
    pub clean: RgbaImage,
    pub blocks: Vec<TextBlock>,
    pub title: String,
    pub page_index: u16,
    pub page_count: u16,
    pub quality: String,
    pub document_digest: String,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct GenerationGuard(u64);
impl GenerationGuard {
    pub fn current(self) -> u64 { self.0 }
    pub fn invalidate(&mut self) -> u64 { self.0 = self.0.wrapping_add(1); self.0 }
    pub fn accepts(self, generation: u64) -> bool { self.0 == generation }
}

#[derive(Clone, Debug, PartialEq)]
pub enum CaptureSource {
    Window { id: u32, title: String, app: String },
    Monitor { id: u32, title: String },
}
impl CaptureSource {
    pub fn label(&self) -> String {
        match self {
            Self::Window { title, app, .. } => format!("{title} · {app}"),
            Self::Monitor { title, .. } => format!("Entire display · {title}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ProviderKind { #[default] OpenAi, Google, DeepL, Local }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct ProviderSettings {
    pub kind: ProviderKind,
    pub endpoint: String,
    pub model: String,
    pub source_language: String,
    pub target_language: String,
    pub glossary: String,
    pub cloud_consent: bool,
    #[serde(skip)]
    pub api_key: String,
}
impl Default for ProviderSettings {
    fn default() -> Self {
        Self { kind: ProviderKind::OpenAi, endpoint: "https://api.openai.com/v1".into(), model: "gpt-4.1-mini".into(), source_language: "auto".into(), target_language: "vi".into(), glossary: String::new(), cloud_consent: false, api_key: String::new() }
    }
}
impl ProviderSettings {
    pub fn cache_key(&self, text: &str) -> String {
        digest(format!("v1|{:?}|{}|{}|{}|{}|{}|{}", self.kind, self.endpoint.trim_end_matches('/'), self.model, self.source_language, self.target_language, self.glossary, text).as_bytes())
    }
}

/// Runtime class for a catalogue entry. `Local` is the only offline-capable class.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModelRuntime { Local, Cloud }

/// Capabilities are descriptive metadata, not permission to invoke a model.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCapabilities {
    pub translation: bool,
    pub chat: bool,
    pub vision: bool,
    pub streaming: bool,
    pub offline: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelDescriptor {
    pub id: String,
    pub label: String,
    pub provider: ProviderKind,
    pub runtime: ModelRuntime,
    pub context_tokens: u32,
    pub capabilities: ModelCapabilities,
    pub endpoint: String,
    pub requires_consent: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModelHealthStatus { Ready, Configured, NeedsConsent, MissingConfiguration, OfflineOnly }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelHealth {
    pub model_id: String,
    pub status: ModelHealthStatus,
    pub detail: String,
    pub network_checked: bool,
}

/// A static, metadata-only catalogue. It never downloads a model or performs a
/// network health check. Callers can render this before asking for explicit use.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCatalogue { pub models: Vec<ModelDescriptor>, pub offline: bool }

impl Default for ModelCatalogue {
    fn default() -> Self { Self::new(false) }
}

impl ModelCatalogue {
    pub fn new(offline: bool) -> Self {
        let models = vec![
            ModelDescriptor { id: "gpt-4.1-mini".into(), label: "OpenAI GPT-4.1 mini".into(), provider: ProviderKind::OpenAi, runtime: ModelRuntime::Cloud, context_tokens: 128_000, capabilities: ModelCapabilities { translation: true, chat: true, vision: true, streaming: true, offline: false }, endpoint: "https://api.openai.com/v1".into(), requires_consent: true },
            ModelDescriptor { id: "google-translate".into(), label: "Google Translate".into(), provider: ProviderKind::Google, runtime: ModelRuntime::Cloud, context_tokens: 30_000, capabilities: ModelCapabilities { translation: true, chat: false, vision: false, streaming: false, offline: false }, endpoint: "https://translation.googleapis.com".into(), requires_consent: true },
            ModelDescriptor { id: "deepl".into(), label: "DeepL".into(), provider: ProviderKind::DeepL, runtime: ModelRuntime::Cloud, context_tokens: 128_000, capabilities: ModelCapabilities { translation: true, chat: false, vision: false, streaming: false, offline: false }, endpoint: "https://api-free.deepl.com".into(), requires_consent: true },
            ModelDescriptor { id: "local-openai-compatible".into(), label: "Local OpenAI-compatible model".into(), provider: ProviderKind::Local, runtime: ModelRuntime::Local, context_tokens: 32_000, capabilities: ModelCapabilities { translation: true, chat: true, vision: true, streaming: true, offline: true }, endpoint: "http://127.0.0.1:1234/v1".into(), requires_consent: false },
        ];
        Self { models: if offline { models.into_iter().filter(|model| model.capabilities.offline).collect() } else { models }, offline }
    }

    pub fn find(&self, id: &str) -> Option<&ModelDescriptor> { self.models.iter().find(|model| model.id == id) }

    /// Local configuration health only. `network_checked` is always false by
    /// design, so the UI cannot mistake catalogue discovery for a live probe.
    pub fn health(&self, settings: &ProviderSettings) -> ModelHealth {
        let id = settings.model.trim().to_string();
        let descriptor = self.find(&id).or_else(|| self.models.iter().find(|model| model.provider == settings.kind));
        let Some(model) = descriptor else { return ModelHealth { model_id: id, status: ModelHealthStatus::MissingConfiguration, detail: "Model is not in the local catalogue.".into(), network_checked: false }; };
        if self.offline && !model.capabilities.offline { return ModelHealth { model_id: model.id.clone(), status: ModelHealthStatus::OfflineOnly, detail: "Offline mode hides cloud models; no request was made.".into(), network_checked: false }; }
        if model.requires_consent && !settings.cloud_consent { return ModelHealth { model_id: model.id.clone(), status: ModelHealthStatus::NeedsConsent, detail: "Cloud consent is required before a request can leave this computer.".into(), network_checked: false }; }
        if settings.endpoint.trim().is_empty() || settings.model.trim().is_empty() { return ModelHealth { model_id: model.id.clone(), status: ModelHealthStatus::MissingConfiguration, detail: "Provider endpoint and model are required.".into(), network_checked: false }; }
        let status = if model.runtime == ModelRuntime::Local { ModelHealthStatus::Configured } else { ModelHealthStatus::Ready };
        ModelHealth { model_id: model.id.clone(), status, detail: "Configuration is present; live health was not probed.".into(), network_checked: false }
    }
}

#[cfg(test)]
mod catalogue_tests {
    use super::*;

    #[test]
    fn offline_catalogue_contains_only_offline_models_without_downloading() {
        let catalogue = ModelCatalogue::new(true);
        assert!(!catalogue.models.is_empty());
        assert!(catalogue.models.iter().all(|model| model.capabilities.offline));
    }

    #[test]
    fn health_is_metadata_only_and_respects_cloud_consent() {
        let catalogue = ModelCatalogue::default();
        let mut settings = ProviderSettings::default();
        assert_eq!(catalogue.health(&settings).status, ModelHealthStatus::NeedsConsent);
        settings.cloud_consent = true;
        let health = catalogue.health(&settings);
        assert!(!health.network_checked);
        assert_eq!(health.status, ModelHealthStatus::Ready);
    }

    #[test]
    fn local_model_is_available_without_cloud_consent() {
        let catalogue = ModelCatalogue::default();
        let mut settings = ProviderSettings::default();
        settings.kind = ProviderKind::Local;
        settings.model = "local-openai-compatible".into();
        settings.endpoint = "http://127.0.0.1:1234/v1".into();
        assert_eq!(catalogue.health(&settings).status, ModelHealthStatus::Configured);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LibraryEntry { pub path: PathBuf, pub title: String, pub last_page: u16, #[serde(default)] pub favorite: bool }
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub provider: ProviderSettings,
    pub library: Vec<LibraryEntry>,
    pub auto_detect: bool,
}

pub fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
pub fn data_directory() -> PathBuf {
    if let Some(path) = std::env::var_os("PDF_WORKSPACE_DATA") { return PathBuf::from(path); }
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("PdfWorkspace").join("services")
}
pub fn load_settings() -> Settings {
    std::fs::read(data_directory().join("settings.json")).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_else(|| Settings { auto_detect: true, ..Settings::default() })
}
pub fn save_settings(settings: &Settings) -> anyhow::Result<()> {
    std::fs::create_dir_all(data_directory())?;
    let temporary = data_directory().join("settings.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(settings)?)?;
    std::fs::rename(temporary, data_directory().join("settings.json"))?;
    Ok(())
}

#[derive(Clone, Copy, Debug)]
pub struct PixelCrop { pub x: u32, pub y: u32, pub width: u32, pub height: u32 }

pub fn detect_document_region(image: &RgbaImage) -> Option<PixelCrop> {
    let step = 4_u32;
    let width = image.width() / step;
    let height = image.height() / step;
    if width < 20 || height < 20 { return None; }
    let mut visited = vec![false; (width * height) as usize];
    let bright = |x: u32, y: u32| {
        let p = image.get_pixel(x * step, y * step).0;
        p[..3].iter().copied().min().unwrap_or(0) > 205 && p[..3].iter().copied().max().unwrap_or(255) - p[..3].iter().copied().min().unwrap_or(0) < 40
    };
    let mut best = None;
    let mut best_area = 0;
    for sy in 0..height { for sx in 0..width {
        let index = (sy * width + sx) as usize;
        if visited[index] || !bright(sx, sy) { continue; }
        let mut queue = VecDeque::from([(sx, sy)]);
        visited[index] = true;
        let (mut left, mut top, mut right, mut bottom, mut count) = (sx, sy, sx, sy, 0_u32);
        while let Some((x, y)) = queue.pop_front() {
            left = left.min(x); top = top.min(y); right = right.max(x); bottom = bottom.max(y); count += 1;
            for (nx, ny) in [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)] {
                if nx >= width || ny >= height { continue; }
                let next = (ny * width + nx) as usize;
                if !visited[next] && bright(nx, ny) { visited[next] = true; queue.push_back((nx, ny)); }
            }
        }
        let rw = right - left + 1;
        let rh = bottom - top + 1;
        let area = rw * rh;
        let ratio = rw as f32 / rh as f32;
        if area > width * height / 10 && ratio > 0.38 && ratio < 2.0 && count as f32 / area as f32 > 0.65 && area > best_area {
            best_area = area;
            best = Some(PixelCrop { x: left * step, y: top * step, width: rw * step, height: rh * step });
        }
    } }
    best
}

pub fn group_lines(mut blocks: Vec<TextBlock>) -> Vec<TextBlock> {
    blocks.sort_by(|a, b| a.rect.y.total_cmp(&b.rect.y).then(a.rect.x.total_cmp(&b.rect.x)));
    let mut grouped: Vec<TextBlock> = Vec::new();
    for block in blocks {
        let candidate = grouped.iter_mut().rev().find(|previous| {
            let gap = block.rect.y - previous.rect.y - previous.rect.height;
            previous.bold == block.bold && (previous.font_size - block.font_size).abs() < 0.002 && (previous.rect.x - block.rect.x).abs() < 0.012 && gap >= -0.002 && gap < 0.012 && (previous.rect.width - block.rect.width).abs() < 0.12 && previous.source.len() < 1400
        });
        if let Some(previous) = candidate {
            previous.source.push(' ');
            previous.source.push_str(&block.source);
            let right = (previous.rect.x + previous.rect.width).max(block.rect.x + block.rect.width);
            previous.rect.x = previous.rect.x.min(block.rect.x);
            previous.rect.width = right - previous.rect.x;
            previous.rect.height = (block.rect.y + block.rect.height).max(previous.rect.y + previous.rect.height) - previous.rect.y;
        } else { grouped.push(block); }
    }
    for (index, block) in grouped.iter_mut().enumerate() { block.id = index as u64; }
    grouped
}

pub fn suppress_flat_text(image: &RgbaImage, blocks: &mut [TextBlock]) -> RgbaImage {
    // OCR boxes do not distinguish glyph ink from artwork inside the box.
    // Until a glyph mask is verified, preserve raster pixels and use paired text.
    for block in blocks { block.background = None; }
    image.clone()
}
