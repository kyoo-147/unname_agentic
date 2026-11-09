use crate::model::{BlockRect, PageFrame, TextBlock};
use anyhow::{Context, Result};
use pdfium_render::prelude::*;
use std::path::{Path, PathBuf};

pub fn runtime_path() -> Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let beside_executable = executable.parent().context("Executable directory missing")?.join("pdfium.dll");
    if beside_executable.is_file() { return Ok(beside_executable); }
    let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("runtime/bin/pdfium.dll");
    anyhow::ensure!(bundled.is_file(), "PDFium is not installed. Run desktop/scripts/fetch-pdfium.ps1, then retry.");
    Ok(bundled)
}

pub fn load_page(path: &Path, page_index: u16, password: Option<&str>) -> Result<PageFrame> {
    static PDFIUM: std::sync::Mutex<Option<Pdfium>> = std::sync::Mutex::new(None);
    let mut runtime = PDFIUM.lock().map_err(|_| anyhow::anyhow!("PDF renderer lock failed"))?;
    if runtime.is_none() {
        let dll = runtime_path()?;
        *runtime = Some(Pdfium::new(Pdfium::bind_to_library(dll).context("Cannot load the packaged PDFium runtime")?));
    }
    let pdfium = runtime.as_ref().unwrap();
    let document = pdfium.load_pdf_from_file(path, password).context("Cannot open PDF. The file may require a password or be damaged.")?;
    let count = document.pages().len();
    anyhow::ensure!(i32::from(page_index) < count, "Page is outside the document");
    let mut page = document.pages().get(i32::from(page_index))?;
    let width = page.width().value;
    let height = page.height().value;
    let config = PdfRenderConfig::new().set_target_width(1500).set_maximum_height(2400);
    let original = page.render_with_config(&config)?.as_image()?.to_rgba8();
    let mut blocks = Vec::new();
    {
        let text = page.text()?;
        for (index, segment) in text.segments().iter().enumerate() {
            let content = segment.text().trim().replace('\r', "");
            if content.is_empty() { continue; }
            let bounds = segment.bounds();
            let rect = BlockRect {
                x: bounds.left().value / width,
                y: (height - bounds.top().value) / height,
                width: bounds.width().value / width,
                height: bounds.height().value / height,
            };
            if !rect.is_valid() { continue; }
            let (font_size, bold) = segment.chars().ok().and_then(|chars| chars.iter().next().map(|ch| (ch.scaled_font_size().value / height, ch.font_name().to_lowercase().contains("bold") || ch.font_is_bold_reenforced()))).unwrap_or((rect.height, false));
            blocks.push(TextBlock { id: index as u64, source: content, translated: None, rect, background: None, font_size, bold });
        }
    }
    let mut hidden = 0;
    for mut object in page.objects().iter() {
        hidden += hide_text(&mut object)?;
    }
    let clean = if hidden > 0 {
        page.regenerate_content()?;
        page.render_with_config(&config)?.as_image()?.to_rgba8()
    } else { original.clone() };
    let mut frame = PageFrame {
        original,
        clean,
        blocks: crate::model::group_lines(blocks),
        title: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
        page_index,
        page_count: u16::try_from(count).context("PDF exceeds 65535 supported pages")?,
        quality: if hidden > 0 { "PDF text removed; artwork retained. Inspect complex clipping and raster text.".into() } else { "No extractable text. Local OCR required.".into() },
        document_digest: crate::model::digest(&std::fs::read(path)?),
    };
    if frame.blocks.is_empty() {
        match crate::capture::recognize(&frame.original) {
            Ok(blocks) => {
                frame.blocks = blocks;
                frame.clean = crate::model::suppress_flat_text(&frame.original, &mut frame.blocks);
                frame.quality = "Scanned PDF · local OCR · paired text preserves original raster artwork".into();
            }
            Err(error) => {
                frame.clean = frame.original.clone();
                frame.quality = format!("Original page retained. OCR unavailable: {error:#}");
            }
        }
    }
    Ok(frame)
}

fn hide_text(object: &mut PdfPageObject<'_>) -> Result<usize> {
    if let Some(text) = object.as_text_object_mut() {
        if text.is_visible() {
            text.set_render_mode(PdfPageTextRenderMode::Invisible)?;
            return Ok(1);
        }
    }
    let mut count = 0;
    if let Some(container) = object.as_x_object_form_object_mut() {
        for mut child in container.iter() { count += hide_text(&mut child)?; }
    }
    Ok(count)
}
