use crate::i18n::tr3;
use mirror_pdf_desktop::model::TextBlock;
use std::path::{Path, PathBuf};

pub fn page_markdown(title: &str, page: u16, page_count: u16, blocks: &[TextBlock]) -> String {
    let translated = blocks.iter().filter(|block| block.translated.as_deref().is_some_and(|text| !text.trim().is_empty())).count();
    let mut out = format!("# {title}\n\n");
    out.push_str(&format!(
        "{} {}/{}\n\n",
        tr3("第", "Page", "Trang"),
        page.saturating_add(1),
        page_count.max(1)
    ));
    out.push_str(&format!(
        "{}: {}/{}\n",
        tr3("已翻译", "Translated", "Đã dịch"),
        translated,
        blocks.len()
    ));
    for (index, block) in blocks.iter().enumerate() {
        out.push_str(&format!("\n## {}\n\n", index + 1));
        out.push_str(&format!("> {}\n\n", block.source.trim()));
        match block.translated.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
            Some(text) => out.push_str(text),
            None => out.push_str(tr3("（尚未翻译）", "(not translated yet)", "(chưa dịch)")),
        }
        out.push('\n');
    }
    out
}

pub fn write_page_as(path: &Path, content: &str) -> anyhow::Result<PathBuf> {
    crate::export_native::write_export_path(path, content, false)
}

pub fn output_path(source: &Path, page: u16, page_count: u16) -> PathBuf {
    let stem = source.file_stem().and_then(|name| name.to_str()).unwrap_or("document");
    let suffix = if page_count > 1 { format!("-page-{}.bilingual.md", page.saturating_add(1)) } else { ".bilingual.md".into() };
    source.with_file_name(format!("{stem}{suffix}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mirror_pdf_desktop::model::BlockRect;

    fn block(source: &str, translated: Option<&str>) -> TextBlock {
        TextBlock {
            id: 1,
            source: source.into(),
            translated: translated.map(str::to_string),
            rect: BlockRect { x: 0., y: 0., width: 1., height: 1. },
            background: None,
            font_size: 12.,
            bold: false,
        }
    }

    #[test]
    fn page_markdown_pairs_source_and_translation_in_order() {
        let text = page_markdown("notes", 0, 2, &[block("First", Some("Một")), block("Second", None)]);
        assert!(text.starts_with("# notes"));
        assert!(text.contains("> First"));
        assert!(text.contains("Một"));
        assert!(text.contains("> Second"));
        assert!(text.contains("Đã dịch: 1/2"));
    }

    #[test]
    fn page_save_as_refuses_to_replace_an_existing_file() {
        let dir = std::env::temp_dir().join(format!("mirror-page-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("chosen.md");
        std::fs::write(&path, "keep me").unwrap();

        assert!(write_page_as(&path, "replacement").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "keep me");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn output_path_is_beside_the_source_and_page_scoped() {
        assert_eq!(output_path(Path::new("C:/docs/notes.pdf"), 0, 2), Path::new("C:/docs/notes-page-1.bilingual.md"));
        assert_eq!(output_path(Path::new("C:/docs/notes.pdf"), 0, 1), Path::new("C:/docs/notes.bilingual.md"));
    }
}
