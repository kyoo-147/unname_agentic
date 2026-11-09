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
