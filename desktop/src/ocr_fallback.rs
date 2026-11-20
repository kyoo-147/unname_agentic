//! OCR fallback (C20): Windows.Media.Ocr first, an external `tesseract` only
//! when Windows OCR returns nothing or throws.
//!
//! Windows OCR is fast and needs no install, but it degrades on some inputs
//! (dense CJK, unusual raster sizes, a missing language pack). This adapter is
//! the second opinion — never the default: [`decide`] sends a page to Tesseract
//! only when the Windows pass produced no blocks or failed, and the caller can
//! tell which engine answered ([`Engine`]), so the page's quality note always
//! names the engine that really ran (and the `ocr page=… engine=…` log line with
//! it).
//!
//! Tesseract is looked up on `PATH`, or at the path in `PDF_WORKSPACE_TESSERACT`
//! (a `.cmd`/`.bat` wrapper is run through `cmd /c`, which is how Windows
//! distributions ship it). Languages come from
//! `PDF_WORKSPACE_TESSERACT_LANGS` (`eng` by default; add `+vie`/`+chi_sim` for
//! those corpora). The page raster is written to a temp PNG, `tesseract <img>
//! stdout -l <langs> tsv` is run, and the TSV is parsed into the same block shape
//! Windows OCR produces. No crate dependencies: plain `std::process::Command`,
//! and the temp file is removed before returning.

use crate::model::{BlockRect, TextBlock};
use anyhow::{Context, Result, anyhow, bail};
use image::RgbaImage;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

/// Where the binary is overridden, and which languages to request.
pub const BINARY_VAR: &str = "PDF_WORKSPACE_TESSERACT";
pub const LANGS_VAR: &str = "PDF_WORKSPACE_TESSERACT_LANGS";

/// Which engine produced a page's blocks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    Windows,
    Tesseract,
}

impl Engine {
    /// The name the page's quality note uses ("Windows OCR" / "Tesseract OCR").
    pub fn title(self) -> &'static str {
        match self {
            Self::Windows => "Windows",
            Self::Tesseract => "Tesseract",
        }
    }
}

/// The `engine=` token for a page's quality note, as `pdf.rs` and `capture.rs`
/// write it. Pure, so the `ocr page=… engine=…` log line's attribution is
/// unit-tested against the note format instead of being re-derived by eye.
pub fn engine_token(quality: &str) -> &'static str {
    if quality.contains("Tesseract OCR") {
        "tesseract"
    } else if quality.contains("Windows OCR") || quality.contains("local OCR") {
        "windows"
    } else {
        "none"
    }
}

/// The blocks for one page, plus the engine that produced them.
pub struct Recognized {
    pub engine: Engine,
    pub blocks: Vec<TextBlock>,
}

/// The Windows result, or the reason to try the fallback.
enum Decision {
    Windows(Vec<TextBlock>),
    Fallback(String),
}

/// The choice, as a pure function so it can be tested without an engine: an empty
/// Windows result and a Windows failure both fall back; anything else does not.
fn decide(windows: Result<Vec<TextBlock>, String>) -> Decision {
    match windows {
        Ok(blocks) if !blocks.is_empty() => Decision::Windows(blocks),
        Ok(_) => Decision::Fallback("Windows OCR returned no text".to_string()),
        Err(error) => Decision::Fallback(format!("Windows OCR failed: {error}")),
    }
}

/// Windows OCR first; Tesseract only on an empty result or a failure. When both
/// fail the error names both, so a page is never silently blank.
pub fn recognize(image: &RgbaImage) -> Result<Recognized> {
    let windows = crate::capture::recognize(image).map_err(|error| format!("{error:#}"));
    match decide(windows) {
        Decision::Windows(blocks) => Ok(Recognized { engine: Engine::Windows, blocks }),
        Decision::Fallback(reason) => match tesseract(image) {
            Ok(blocks) => Ok(Recognized { engine: Engine::Tesseract, blocks }),
            Err(error) => Err(anyhow!("{reason}; the Tesseract fallback also failed: {error:#}")),
        },
    }
}

/// The binary to run: `PDF_WORKSPACE_TESSERACT` when set (it must exist), else
/// `tesseract` from `PATH`. A missing binary is an error with a usable sentence,
/// never an empty page.
fn locate() -> Result<std::ffi::OsString> {
    if let Some(path) = std::env::var_os(BINARY_VAR) {
        let path = PathBuf::from(&path);
        let resolvable = if path.components().count() > 1 { path.is_file() } else { probe(path.as_os_str()) };
        return if resolvable { Ok(path.into_os_string()) } else { bail!("{BINARY_VAR} points at {}, which is not an executable file", path.display()) };
    }
    let command = std::ffi::OsString::from("tesseract");
    if probe(&command) { Ok(command) } else { bail!("tesseract is not installed: {command:?} is not on PATH and {BINARY_VAR} is unset") }
}

/// `--version` is the cheapest proof the command exists and starts.
fn probe(command: &OsStr) -> bool {
    command_for(command).arg("--version").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok()
}

/// A `Command` for the binary, routing `.cmd`/`.bat` wrappers through the command
/// interpreter (CreateProcess cannot start a batch file by itself).
fn command_for(command: &OsStr) -> Command {
    let path = Path::new(command);
    let batch = path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| matches!(extension.to_ascii_lowercase().as_str(), "cmd" | "bat"));
    if batch {
        let mut process = Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| std::ffi::OsString::from("cmd.exe")));
        process.arg("/c").arg(path);
        process
    } else {
        Command::new(command)
    }
}

/// Runs Tesseract over the raster and parses its TSV. The temp PNG is always
/// removed, including on the error paths.
fn tesseract(image: &RgbaImage) -> Result<Vec<TextBlock>> {
    anyhow::ensure!(image.width() > 0 && image.height() > 0, "the page raster is empty");
    let command = locate()?;
    let path = temp_png(image)?;
    let languages = std::env::var(LANGS_VAR).unwrap_or_else(|_| "eng".to_string());
    let output = command_for(&command)
        .arg(&path)
        .arg("stdout")
        .arg("-l")
        .arg(&languages)
        .arg("tsv")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    // The raster is a temp file; never leave it behind, even when the run fails.
    std::fs::remove_file(&path).ok();
    let output = output.with_context(|| format!("cannot run {command:?}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("tesseract exited with {}: {}", output.status, stderr.trim().lines().next().unwrap_or("no message"));
    }
    let blocks = parse_tsv(&String::from_utf8_lossy(&output.stdout), image.width(), image.height());
    anyhow::ensure!(!blocks.is_empty(), "tesseract recognised no text");
    Ok(crate::model::group_lines(blocks))
}

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// One PNG per page in the system temp directory, named so two renders in the
/// same process never collide.
fn temp_png(image: &RgbaImage) -> Result<PathBuf> {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("pdf-workspace-ocr-{}-{sequence}.png", std::process::id()));
    image.save(&path).with_context(|| format!("cannot write the OCR raster to {}", path.display()))?;
    Ok(path)
}

/// Tesseract's TSV, one block per recognised line.
///
/// The columns are `level page_num block_num par_num line_num word_num left top
/// width height conf text`; level 5 is a word row and the header row is skipped
/// because its `level` is not a number. Words are grouped by (block, paragraph,
/// line) in reading order and joined with spaces, and boxes are normalised to
/// the raster's 0..1 space — the same shape `capture::recognize` produces.
pub fn parse_tsv(tsv: &str, width: u32, height: u32) -> Vec<TextBlock> {
    if width == 0 || height == 0 {
        return Vec::new();
    }
    let mut lines: BTreeMap<(u32, u32, u32), LineBox> = BTreeMap::new();
    for row in tsv.lines() {
        let mut columns = row.splitn(12, '\t');
        let level = columns.next().and_then(|value| value.trim().parse::<u32>().ok());
        if level != Some(5) {
            continue;
        }
        // page_num, then the (block, paragraph, line) key, then word_num.
        let _page = columns.next();
        let (Some(block), Some(paragraph), Some(line)) = (
            columns.next().and_then(|value| value.trim().parse::<u32>().ok()),
            columns.next().and_then(|value| value.trim().parse::<u32>().ok()),
            columns.next().and_then(|value| value.trim().parse::<u32>().ok()),
        ) else {
            continue;
        };
        let _word = columns.next();
        let number = |columns: &mut std::str::SplitN<'_, char>| columns.next().and_then(|value| value.trim().parse::<f32>().ok());
        let (Some(left), Some(top), Some(w), Some(h)) = (number(&mut columns), number(&mut columns), number(&mut columns), number(&mut columns)) else {
            continue;
        };
        let _confidence = columns.next();
        let text = columns.next().unwrap_or_default().trim();
        if text.is_empty() {
            continue;
        }
        let entry = lines.entry((block, paragraph, line)).or_insert_with(LineBox::default);
        entry.left = entry.left.min(left);
        entry.top = entry.top.min(top);
        entry.right = entry.right.max(left + w);
        entry.bottom = entry.bottom.max(top + h);
        if !entry.words.is_empty() {
            entry.words.push(' ');
        }
        entry.words.push_str(text);
    }
    let mut blocks = Vec::new();
    for line in lines.into_values() {
        let rect = BlockRect {
            x: line.left / width as f32,
            y: line.top / height as f32,
            width: (line.right - line.left) / width as f32,
            height: (line.bottom - line.top) / height as f32,
        };
        if !rect.is_valid() {
            continue;
        }
        blocks.push(TextBlock { id: blocks.len() as u64, source: line.words, translated: None, rect, background: None, font_size: rect.height * 0.8, bold: false });
    }
    blocks
}

struct LineBox {
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
    words: String,
}

impl Default for LineBox {
    fn default() -> Self {
        Self { left: f32::MAX, top: f32::MAX, right: f32::MIN, bottom: f32::MIN, words: String::new() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};
    use std::sync::Mutex;

    /// The env vars these tests set are process-wide; one test at a time.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    const HEADER: &str = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext";
    const TSV: &str = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
5\t1\t1\t1\t1\t1\t100\t100\t80\t30\t96\tXin\n\
5\t1\t1\t1\t1\t2\t190\t100\t60\t30\t95\tchào\n\
5\t1\t1\t1\t2\t1\t100\t300\t120\t30\t93\tViệt\n\
5\t1\t1\t1\t2\t2\t230\t300\t60\t30\t92\tNam\n";

    fn page() -> RgbaImage {
        RgbaImage::from_pixel(1000, 1000, Rgba([250, 250, 250, 255]))
    }

    fn stub_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pdf-workspace-ocr-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A `.cmd` wrapper that prints the fixture, the way a Windows tesseract
    /// distribution is invoked (through `cmd /c`).
    fn stub_binary(dir: &Path, body: &str) -> PathBuf {
        let script = dir.join("tesseract.cmd");
        std::fs::write(&script, body).unwrap();
        script
    }

    #[test]
    fn the_tsv_parser_builds_one_block_per_line() {
        let blocks = parse_tsv(TSV, 1000, 1000);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].source, "Xin chào");
        assert_eq!(blocks[1].source, "Việt Nam");
        assert!((blocks[0].rect.x - 0.1).abs() < 1e-6, "left 100 of 1000");
        assert!((blocks[0].rect.y - 0.1).abs() < 1e-6, "top 100 of 1000");
        assert!((blocks[0].rect.width - 0.15).abs() < 1e-6, "words span 100..250");
        assert!((blocks[0].rect.height - 0.03).abs() < 1e-6);
        assert_eq!(blocks[0].translated, None);
        assert_eq!(blocks[0].background, None);
        assert!(!blocks[0].bold);
    }

    #[test]
    fn the_tsv_parser_skips_the_header_and_blank_rows() {
        assert!(parse_tsv(HEADER, 100, 100).is_empty(), "the header is not a word row");
        let blank = format!("{HEADER}\n5\t1\t1\t1\t1\t1\t10\t10\t5\t5\t90\t\n");
        assert!(parse_tsv(&blank, 100, 100).is_empty(), "a word row with no text is not a block");
    }

    #[test]
    fn the_tsv_parser_drops_boxes_outside_the_raster() {
        let out_of_bounds = format!("{HEADER}\n5\t1\t1\t1\t1\t1\t900\t10\t200\t20\t90\twide\n");
        assert!(parse_tsv(&out_of_bounds, 1000, 1000).is_empty(), "x+width > 1.02 is not a valid rect");
    }

    #[test]
    fn the_tsv_parser_needs_a_raster_size() {
        assert!(parse_tsv(TSV, 0, 1000).is_empty());
        assert!(parse_tsv(TSV, 1000, 0).is_empty());
    }

    fn block(text: &str) -> TextBlock {
        TextBlock { id: 0, source: text.to_string(), translated: None, rect: BlockRect { x: 0.1, y: 0.1, width: 0.2, height: 0.03 }, background: None, font_size: 0.024, bold: false }
    }

    #[test]
    fn windows_ocr_is_preferred_whenever_it_produces_text() {
        assert!(matches!(decide(Ok(vec![block("windows")])), Decision::Windows(_)));
        assert!(matches!(decide(Ok(Vec::new())), Decision::Fallback(_)));
        assert!(matches!(decide(Err("no engine".to_string())), Decision::Fallback(_)));
        match decide(Err("no engine".to_string())) {
            Decision::Fallback(reason) => assert!(reason.contains("Windows OCR failed"), "{reason}"),
            Decision::Windows(_) => panic!("a failed Windows pass must fall back"),
        }
    }

    #[test]
    fn the_log_token_follows_the_quality_note() {
        // The exact notes pdf.rs and capture.rs write, so the `engine=` field of
        // the `ocr page=…` INFO line can never disagree with the page.
        let windows_pdf = "Scanned PDF · local OCR · paired text preserves original raster artwork";
        let tesseract_pdf = "Scanned PDF · local OCR (Tesseract OCR fallback) · paired text preserves original raster artwork";
        let windows_capture = "Document region detected · Windows OCR · 3 regions use paired text to preserve raster artwork";
        let tesseract_capture = "Document region detected · Tesseract OCR · 3 regions use paired text to preserve raster artwork";
        let unavailable = "Original page retained. OCR unavailable: tesseract is not installed";
        assert_eq!(engine_token(windows_pdf), "windows");
        assert_eq!(engine_token(tesseract_pdf), "tesseract");
        assert_eq!(engine_token(windows_capture), "windows");
        assert_eq!(engine_token(tesseract_capture), "tesseract");
        assert_eq!(engine_token(unavailable), "none");
        assert_eq!(engine_token("No extractable text. Local OCR required."), "none");
    }

    #[test]
    fn a_missing_binary_is_an_error_not_an_empty_page() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let missing = std::env::temp_dir().join("pdf-workspace-no-such-tesseract.exe");
        unsafe { std::env::set_var(BINARY_VAR, &missing) };
        let error = tesseract(&page()).unwrap_err().to_string();
        unsafe { std::env::remove_var(BINARY_VAR) };
        assert!(error.contains(BINARY_VAR), "the message names the override: {error}");
        assert!(error.contains("not an executable file"), "the message says what is wrong: {error}");
    }

    #[test]
    fn a_stub_binary_yields_the_same_block_shape() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = stub_dir("tsv");
        let fixture = dir.join("page.tsv");
        std::fs::write(&fixture, TSV).unwrap();
        let script = stub_binary(&dir, &format!("@echo off\r\ntype \"{}\"\r\n", fixture.display()));
        unsafe { std::env::set_var(BINARY_VAR, &script) };
        let recognized = tesseract(&page());
        unsafe { std::env::remove_var(BINARY_VAR) };
        let blocks = recognized.expect("the stub binary answers like tesseract");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].source, "Xin chào");
        assert_eq!(blocks[1].source, "Việt Nam");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_failing_stub_binary_reports_its_exit_code() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = stub_dir("fail");
        let script = stub_binary(&dir, "@echo off\r\necho the tessdata directory was not found 1>&2\r\nexit /b 3\r\n");
        unsafe { std::env::set_var(BINARY_VAR, &script) };
        let error = tesseract(&page()).unwrap_err().to_string();
        unsafe { std::env::remove_var(BINARY_VAR) };
        assert!(error.contains("exited with"), "{error}");
        assert!(error.contains("tessdata"), "stderr travels with the error: {error}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_stub_that_speaks_no_words_is_an_error() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = stub_dir("empty");
        let fixture = dir.join("page.tsv");
        std::fs::write(&fixture, HEADER).unwrap();
        let script = stub_binary(&dir, &format!("@echo off\r\ntype \"{}\"\r\n", fixture.display()));
        unsafe { std::env::set_var(BINARY_VAR, &script) };
        let error = tesseract(&page()).unwrap_err().to_string();
        unsafe { std::env::remove_var(BINARY_VAR) };
        assert!(error.contains("recognised no text"), "{error}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
