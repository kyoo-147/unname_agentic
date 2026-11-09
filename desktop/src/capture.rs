use crate::model::{BlockRect, CaptureSource, PageFrame, TextBlock};
use anyhow::{Context, Result};
use image::RgbaImage;

#[cfg(windows)]
pub fn sources() -> Result<Vec<CaptureSource>> {
    let mut output = Vec::new();
    for window in xcap::Window::all()? {
        if window.pid().unwrap_or(0) == std::process::id() || window.is_minimized().unwrap_or(true) { continue; }
        let title = window.title().unwrap_or_default();
        if title.trim().is_empty() || window.width().unwrap_or(0) < 160 || window.height().unwrap_or(0) < 100 { continue; }
        output.push(CaptureSource::Window { id: window.id()?, title, app: window.app_name().unwrap_or_default() });
    }
    for monitor in xcap::Monitor::all()? {
        output.push(CaptureSource::Monitor { id: monitor.id()?, title: monitor.friendly_name().unwrap_or_else(|_| "Display".into()) });
    }
    Ok(output)
}

#[cfg(windows)]
pub fn grab(source: &CaptureSource) -> Result<RgbaImage> {
    let image = match source {
        CaptureSource::Window { id, .. } => {
            let window = xcap::Window::all()?.into_iter().find(|window| window.id().ok() == Some(*id)).context("Source window closed")?;
            anyhow::ensure!(!window.is_minimized()?, "Source is minimized. Restore it to resume capture.");
            window.capture_image()?
        }
        CaptureSource::Monitor { id, .. } => {
            xcap::Monitor::all()?.into_iter().find(|monitor| monitor.id().ok() == Some(*id)).context("Display disconnected")?.capture_image()?
        }
    };
    anyhow::ensure!(image.width() > 0 && image.height() > 0, "Capture returned no pixels");
    Ok(image)
}

pub fn recognize_frame(image: RgbaImage, title: String, auto_detect: bool) -> Result<PageFrame> {
    let crop = if auto_detect { crate::model::detect_document_region(&image) } else { None };
    let original = if let Some(crop) = crop { image::imageops::crop_imm(&image, crop.x, crop.y, crop.width, crop.height).to_image() } else { image };
    let mut blocks = match recognize(&original) {
        Ok(blocks) => blocks,
        Err(error) => {
            let document_digest = crate::model::digest(original.as_raw());
            return Ok(PageFrame { clean: original.clone(), original, blocks: Vec::new(), title, page_index: 0, page_count: 1, quality: format!("Original capture retained. OCR unavailable: {error:#}"), document_digest });
        }
    };
    let clean = crate::model::suppress_flat_text(&original, &mut blocks);
    let document_digest = crate::model::digest(original.as_raw());
    let detected = if crop.is_some() { "Document region detected" } else { "Full source · no confident page boundary" };
    let uncertain = blocks.iter().filter(|block| block.background.is_none()).count();
    Ok(PageFrame { original, clean, blocks, title, page_index: 0, page_count: 1, quality: format!("{detected} · Windows OCR · {uncertain} regions use paired text to preserve raster artwork"), document_digest })
}

#[cfg(windows)]
pub fn recognize(image: &RgbaImage) -> Result<Vec<TextBlock>> {
    use windows::{core::HSTRING, Globalization::Language, Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap}, Media::Ocr::OcrEngine, Storage::Streams::DataWriter};
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().or_else(|_| OcrEngine::TryCreateFromLanguage(&Language::CreateLanguage(&HSTRING::from("en"))?)).context("Windows OCR is unavailable. Install an OCR language under Windows Settings > Language > Language options.")?;
    let max = OcrEngine::MaxImageDimension()?;
    let resized;
    let input = if image.width() > max || image.height() > max {
        let scale = max as f64 / image.width().max(image.height()) as f64;
        resized = image::imageops::resize(image, (image.width() as f64 * scale).round().max(1.0) as u32, (image.height() as f64 * scale).round().max(1.0) as u32, image::imageops::FilterType::Lanczos3);
        &resized
    } else { image };
    let writer = DataWriter::new()?;
    writer.WriteBytes(input.as_raw())?;
    let buffer = writer.DetachBuffer()?;
    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(&buffer, BitmapPixelFormat::Rgba8, input.width() as i32, input.height() as i32, BitmapAlphaMode::Ignore)?;
    let result = engine.RecognizeAsync(&bitmap)?.join()?;
    let mut blocks = Vec::new();
    for line in result.Lines()? {
        let source = line.Text()?.to_string();
        if source.trim().is_empty() { continue; }
        let mut left = f32::MAX;
        let mut top = f32::MAX;
        let mut right = 0.0_f32;
        let mut bottom = 0.0_f32;
        for word in line.Words()? {
            let bounds = word.BoundingRect()?;
            left = left.min(bounds.X);
            top = top.min(bounds.Y);
            right = right.max(bounds.X + bounds.Width);
            bottom = bottom.max(bounds.Y + bounds.Height);
        }
        let rect = BlockRect { x: left / input.width() as f32, y: top / input.height() as f32, width: (right - left) / input.width() as f32, height: (bottom - top) / input.height() as f32 };
        if rect.is_valid() { blocks.push(TextBlock { id: blocks.len() as u64, source, translated: None, rect, background: None, font_size: rect.height * 0.8, bold: false }); }
    }
    Ok(crate::model::group_lines(blocks))
}

#[cfg(windows)]
pub fn exclude_own_windows() -> Result<()> {
    use windows::Win32::{Foundation::{HWND, LPARAM}, UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE}};
    unsafe extern "system" fn exclude(hwnd: HWND, state: LPARAM) -> windows::core::BOOL {
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)); }
        if pid == std::process::id() {
            if unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) }.is_ok() { unsafe { *(state.0 as *mut bool) = true; } }
        }
        windows::core::BOOL(1)
    }
    let mut excluded = false;
    unsafe { EnumWindows(Some(exclude), LPARAM(&mut excluded as *mut bool as isize))?; }
    anyhow::ensure!(excluded, "Cannot exclude native output from display capture");
    Ok(())
}
#[cfg(not(windows))]
pub fn exclude_own_windows() -> Result<()> { anyhow::bail!("Windows required") }

#[cfg(not(windows))]
pub fn sources() -> Result<Vec<CaptureSource>> { anyhow::bail!("This build supports native capture on Windows only") }
#[cfg(not(windows))]
pub fn grab(_: &CaptureSource) -> Result<RgbaImage> { anyhow::bail!("Windows capture required") }
#[cfg(not(windows))]
pub fn recognize(_: &RgbaImage) -> Result<Vec<TextBlock>> { anyhow::bail!("Windows OCR required") }
