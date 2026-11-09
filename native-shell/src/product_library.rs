use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_is_source_stem_not_generated_note_content() {
        assert_eq!(pdf_title(Path::new("Quarterly report.PDF")), "Quarterly report");
        assert_eq!(pdf_title(Path::new("   .pdf")), "PDF document");
    }

    #[test]
    fn validates_pdf_signature_and_extension_before_rendering() {
        assert!(validate_pdf(Path::new("report.PDF"), b"%PDF-1.7\n").is_ok());
        assert!(validate_pdf(Path::new("report.pdf"), b"not a PDF").is_err());
        assert!(validate_pdf(Path::new("report.txt"), b"%PDF-1.7").is_err());
    }
}

fn pdf_title(path: &Path) -> String {
    path.file_stem().and_then(|s| s.to_str()).map(str::trim).filter(|s| !s.is_empty()).unwrap_or("PDF document").to_string()
}

fn validate_pdf(path: &Path, bytes: &[u8]) -> Result<()> {
    anyhow::ensure!(path.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")), "Choose a PDF file");
    anyhow::ensure!(bytes.iter().take(1024).copied().collect::<Vec<_>>().windows(5).any(|w| w == b"%PDF-"), "This file is not a PDF");
    Ok(())
}

struct Snapshot(PathBuf);
impl Drop for Snapshot {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

/// Runs entirely on the background executor, including PDFium and library writes.
pub fn import_pdf(path: &Path) -> Result<String> { import_pdf_checked(path, None, None, None) }

pub fn import_browser_pdf(path: &Path, digest: &str, title: Option<&str>, key: &str) -> Result<String> { import_pdf_checked(path, Some(digest), title, Some(key)) }

fn import_pdf_checked(path: &Path, digest: Option<&str>, title: Option<&str>, key: Option<&str>) -> Result<String> {
    let original = crate::store::read_bounded(path, crate::store::EXPORT_FILE_LIMIT).context("Cannot read this PDF (maximum 256 MB)")?;
    validate_pdf(path, &original)?;
    if let Some(expected) = digest { anyhow::ensure!(mirror_pdf_desktop::model::digest(&original) == expected, "Browser PDF checksum does not match its completed transfer"); }
    let root = crate::store::Store::root_dir();
    std::fs::create_dir_all(root.join("sources"))?;
    let snapshot = Snapshot(root.join("sources").join(format!(".{}-import.pdf", uuid::Uuid::new_v4())));
    // Render the exact retained bytes even if the external source changes mid-import.
    std::fs::write(&snapshot.0, &original)?;
    let page = mirror_pdf_desktop::pdf::load_page(&snapshot.0, 0, None)?;
    let thumb = image::DynamicImage::ImageRgba8(page.original).thumbnail(600, 800);
    let mut png = std::io::Cursor::new(Vec::new());
    thumb.write_to(&mut png, image::ImageFormat::Png)?;
    let mut store = crate::store::Store::open_at(root)?;
    let title = title.map(str::trim).filter(|title| !title.is_empty() && title.chars().count() <= 200).map(str::to_owned).unwrap_or_else(|| pdf_title(path));
    store.create_pdf_once(&title, &original, png.get_ref(), page.page_count as usize, (thumb.width(), thumb.height()), key.unwrap_or(""))
}
