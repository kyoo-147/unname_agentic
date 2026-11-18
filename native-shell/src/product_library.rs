use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use std::path::PathBuf;

    /// A throwaway library; `Store` paths are relative to it.
    fn temp_store() -> (Store, PathBuf) {
        let root = std::env::temp_dir().join(format!("pdf-workspace-import-{}", uuid::Uuid::new_v4()));
        (Store::open_at(root.clone()).expect("open a temporary library"), root)
    }

    fn cleanup(root: &std::path::Path) { let _ = std::fs::remove_dir_all(root); }

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

    /// 两个不同的 PDF 必须是两条记录，各自保留自己的源文件。
    #[test]
    fn different_pdfs_are_separate_records_with_separate_sources() {
        let (mut store, root) = temp_store();
        let first = b"%PDF-1.7\nfirst document".to_vec();
        let second = b"%PDF-1.7\nsecond document".to_vec();
        let a = store.create_pdf_once("First", &first, b"png", 1, (10, 10), &import_key(None, &first)).unwrap();
        let b = store.create_pdf_once("Second", &second, b"png", 1, (10, 10), &import_key(None, &second)).unwrap();
        assert_ne!(a, b);
        assert_eq!(store.list().len(), 2);
        assert_eq!(std::fs::read(store.pdf_path(&a).unwrap()).unwrap(), first);
        assert_eq!(std::fs::read(store.pdf_path(&b).unwrap()).unwrap(), second);
        assert_eq!(std::fs::read_dir(root.join("sources")).unwrap().count(), 2);
        cleanup(&root);
    }

    /// 同一份字节导入两次仍然只有一条记录、一份源文件（重新打开库也一样）。
    #[test]
    fn same_pdf_imported_twice_reuses_one_record() {
        let (mut store, root) = temp_store();
        let bytes = b"%PDF-1.7\nsame bytes".to_vec();
        let key = import_key(None, &bytes);
        let first = store.create_pdf_once("Same", &bytes, b"png", 1, (10, 10), &key).unwrap();
        let mut reopened = Store::open_at(root.clone()).expect("reopen the temporary library");
        let again = reopened.create_pdf_once("Same", &bytes, b"png", 1, (10, 10), &key).unwrap();
        assert_eq!(first, again);
        assert_eq!(reopened.list().len(), 1);
        assert_eq!(std::fs::read_dir(root.join("sources")).unwrap().count(), 1);
        cleanup(&root);
    }

    /// 普通导入的键必须是内容摘要；空键曾让第一次导入吞掉之后每一次不同的文件。
    #[test]
    fn plain_import_key_is_the_content_digest_not_an_empty_key() {
        let bytes = b"%PDF-1.7\nkeyed by content".to_vec();
        let key = import_key(None, &bytes);
        assert_eq!(key, mirror_pdf_desktop::model::digest(&bytes));
        assert_eq!(key.len(), 64);
        assert!(key.bytes().all(|b| b.is_ascii_hexdigit()));
        // A caller that already has a key (the browser transfer) keeps it.
        assert_eq!(import_key(Some("browser-key"), &bytes), "browser-key");
    }

    /// 超过导入上限一个字节就被拒绝，且提示里打印真正执行的上限（不是另一个字面量）。
    #[test]
    fn files_over_the_import_limit_are_refused_with_the_enforced_number() {
        let limit = crate::store::IMPORT_FILE_LIMIT;
        assert_eq!(limit, 256 * 1024 * 1024);
        assert!(limit > crate::store::EXPORT_FILE_LIMIT, "imports must accept more than exports");
        assert_eq!(import_size_error(limit - 1), None, "a file under the limit passes the size check");
        assert_eq!(import_size_error(limit), None, "a file at the limit passes the size check");
        let message = import_size_error(limit + 1).expect("one byte over the limit is refused");
        assert_eq!(message, import_limit_message());
        let enforced = format!("{} MB", limit / (1024 * 1024));
        assert!(message.contains(&enforced), "the message prints the enforced number {enforced}: {message}");
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

/// The dedupe key for an import: the caller's key when it has one (a browser
/// transfer), otherwise the digest of the exact bytes being retained.
///
/// A plain import used to pass `""`, which made the first plain import the
/// dedupe key for every later one: `create_pdf_once` returned that first record
/// for a different file, so a later launch silently reopened the older document
/// instead of importing the requested one.
fn import_key(key: Option<&str>, original: &[u8]) -> String {
    match key {
        Some(key) => key.to_string(),
        None => mirror_pdf_desktop::model::digest(original),
    }
}

/// The import size gate as one line the toast can show: the number is computed
/// from the limit actually enforced, never a second literal.
fn import_limit_message() -> String {
    format!("Cannot read this PDF (maximum {} MB)", crate::store::IMPORT_FILE_LIMIT / (1024 * 1024))
}

/// Why a PDF of `len` bytes cannot be imported; `None` when it fits.
fn import_size_error(len: u64) -> Option<String> {
    (len > crate::store::IMPORT_FILE_LIMIT).then(import_limit_message)
}

fn import_pdf_checked(path: &Path, digest: Option<&str>, title: Option<&str>, key: Option<&str>) -> Result<String> {
    let len = std::fs::metadata(path).with_context(|| "Cannot read this PDF")?.len();
    if let Some(error) = import_size_error(len) { return Err(anyhow::anyhow!(error)); }
    let original = crate::store::read_bounded(path, crate::store::IMPORT_FILE_LIMIT).with_context(import_limit_message)?;
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
    let key = import_key(key, &original);
    store.create_pdf_once(&title, &original, png.get_ref(), page.page_count as usize, (thumb.width(), thumb.height()), &key)
}
